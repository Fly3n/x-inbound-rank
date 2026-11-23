// 别人回我：历史回填任务状态机（启动、逐页推进、暂停、恢复与唤醒）。
import { kvGet, kvSet, keys, getSettings } from '../db.js';
import { DAY_MS } from '../rank.js';
import { record } from '../diagnostics.js';
import { queueBridgePush } from '../bridge.js';
import { idGt } from '../x/parser.js';
import {
  PACE, EMPTY_SYNC_ID, JOB_ALARM, alarmFor,
  enabledAccount, now, rand, inActiveHours, nextActiveAt, serviceWait,
  isBusy, tryAcquireBusy, releaseBusy, serial, updateCursor,
  refreshSnapshot, flushSnapshot, setAlert, completeBackfillRound, armInc,
} from './runtime.js';
import { retryAlarm } from './alarms.js';
import { mentionsApi, pull } from './transport.js';

export async function saveJob(account, job) {
  await kvSet(keys.job(account), job);
}

export async function scheduleJob(account, job, delayMs) {
  job.nextAt = now() + delayMs;
  await chrome.alarms.create(alarmFor(JOB_ALARM, account), { when: job.nextAt });
}

export async function startBackfill(account) {
  if (!await enabledAccount(account)) return { error: '请先为此账号开启插件。' };
  const settings = await getSettings(account);
  if (!inActiveHours()) return { error: '读取只在每天 08:00–24:00 进行，夜间不运行。' };
  const cur = await kvGet(keys.cursor(account), {});
  if ((cur.rateUntil || 0) > now()) {
    return { error: `接口正在退避，请在 ${new Date(cur.rateUntil).toLocaleTimeString()} 后再试。` };
  }
  const rangeDays = settings.initDays; // 往回读多远看初始化范围，和榜单范围分开
  const job = {
    status: 'running',
    api: await mentionsApi(account), // 这次翻页用哪个接口，中途不换（游标不通用）
    rangeDays,
    targetTs: now() - rangeDays * DAY_MS,
    cursor: null,
    pages: 0,
    added: 0,
    batchPages: 0,
    oldestTs: null,
    startedAt: now(),
    backoffMs: PACE.backoffStartMs,
  };
  const accepted = await serial(async () => {
    const existing = await kvGet(keys.job(account));
    if (existing?.status === 'running' || existing?.status === 'waiting_tab' || existing?.auto && existing.status === 'paused') return;
    await saveJob(account, job);
    return true;
  });
  if (accepted) stepBackfill(account); // 不等待，界面立刻返回
  return { ok: true };
}

async function finishJob(account, job, { reachedEnd }) {
  job.status = 'done';
  job.reachedEnd = reachedEnd; // true = X 的列表到底了，没翻到用户选的范围
  job.finishedAt = now();
  job.nextAt = null;
  await saveJob(account, job);
  const next = await updateCursor(account, (cur) => {
    cur.lastBackfill = { rangeDays: job.rangeDays, finishedAt: job.finishedAt, oldestTs: job.oldestTs, reachedEnd };
    // syncedId：从它往后（更早）到回填终点是连续完整的；增量每次从最新读到它之后，再回看一段
    if (job.topId && (!cur.syncedId || idGt(job.topId, cur.syncedId))) cur.syncedId = job.topId;
    else if (reachedEnd && !job.oldestTs && !cur.syncedId) cur.syncedId = EMPTY_SYNC_ID;
    return completeBackfillRound(cur, now()); // 回填期间新来的回复留给下一次增量
  });
  if ((await getSettings(account)).fetchEnabled) await armInc(account, next);
  await refreshSnapshot(account);
  queueBridgePush();
}

/** 当前有没有该往下走的回填任务。 */
async function runningJob(account) {
  if (!await enabledAccount(account)) return null;
  const job = account && (await kvGet(keys.job(account)));
  return job?.status === 'running' ? job : null;
}

export async function stepBackfill(account) {
  if (isBusy()) return retryAlarm(JOB_ALARM, account);
  if (!(await runningJob(account))) return;
  if (!tryAcquireBusy()) return retryAlarm(JOB_ALARM, account);
  try {
    const job = await runningJob(account); // 占住之后重读：上一步可能刚存了新进度
    if (!job) return;
    if (!inActiveHours()) {
      job.status = 'paused';
      job.auto = true;
      job.message = '已到夜间休息时间，明天 08:00 后自动继续';
      await saveJob(account, job);
      await scheduleJob(account, job, nextActiveAt() - now());
      return;
    }

    const trace = { account, mode: 'inbound_backfill', run: job.startedAt, page: job.pages + 1 };
    const res = await pull(account, job.cursor, job.api || 'rest', undefined, trace);
    // 请求的这一两秒里，用户可能点了暂停、重新初始化或清空：那就以存储里的为准，这一步的结果不再写回
    const latest = await kvGet(keys.job(account));
    if (!await enabledAccount(account) || !latest || latest.startedAt !== job.startedAt || latest.status !== 'running') return;

    if (res.kind === 'tpl_bad') {
      // 新接口的模板失效：换旧接口从最新一页重来，已入库的靠主键去重
      job.api = 'rest';
      job.cursor = null;
      job.topId = null;
      job.restarted = (job.restarted || 0) + 1;
      if (job.restarted > 3) {
        job.status = 'error';
        job.message = '读取方式反复失效，已停止';
      } else await scheduleJob(account, job, rand(PACE.pageGapMs));
    } else if (res.kind === 'no_tab') {
      job.status = 'waiting_tab';
      job.message = '打开此账号的 X 页面后自动继续';
    } else if (res.kind === 'outside_window') {
      job.status = 'paused';
      job.auto = true;
      job.message = '已到夜间休息时间，明天 08:00 后自动继续';
      await scheduleJob(account, job, nextActiveAt() - now());
    } else if (res.kind === 'backoff') {
      job.status = 'paused';
      job.auto = true;
      job.message = '账号正在限流退避，到时间自动继续';
      await scheduleJob(account, job, Math.max(PACE.backoffStartMs, (res.retryAt || 0) - now()));
    } else if (res.kind === 'unavailable') {
      job.status = 'paused';
      job.auto = true;
      job.message = `X 暂时不可用（HTTP ${res.status}），稍后从当前页重试`;
      const wait = serviceWait(job.serviceRetries);
      job.serviceRetries = (job.serviceRetries || 0) + 1;
      await scheduleJob(account, job, wait);
      await record('retry_scheduled', { ...trace, source: 'backfill', status: res.status, waitMs: wait });
    } else if (res.kind === 'rate') {
      job.status = 'paused';
      job.auto = true;
      const wait = Math.max(job.backoffMs, (res.resetAt || 0) - now());
      job.backoffMs = Math.min(job.backoffMs * 2, PACE.backoffMaxMs);
      job.message = '被 X 限流（429），已暂停，到时间自动继续';
      await scheduleJob(account, job, wait);
    } else if (res.kind === 'error') {
      job.status = 'error';
      job.message = res.message;
      await setAlert(account, res.message);
    } else {
      const p = res.parsed;
      if (!job.topId) job.topId = p.newestId; // 本次回填的起点，完成后作为增量的接续点
      job.pages++;
      job.batchPages++;
      job.added += res.added;
      job.message = null;
      job.backoffMs = PACE.backoffStartMs;
      job.serviceRetries = 0;
      if (p.oldestTs) job.oldestTs = p.oldestTs;

      if (p.newestTs && p.newestTs < job.targetTs) {
        await finishJob(account, job, { reachedEnd: false });
        return;
      }
      if (!p.bottomCursor || !p.entryIds.length) {
        await finishJob(account, job, { reachedEnd: true });
        return;
      }
      if (p.bottomCursor === job.cursor) {
        job.status = 'error';
        job.auto = false;
        job.message = 'X 返回了重复的翻页位置，初始化已暂停；接续点没有前移。请稍后点「继续」重试。';
        await saveJob(account, job);
        await setAlert(account, job.message);
        return;
      }
      job.cursor = p.bottomCursor;
      if (job.pages % PACE.maxPagesPerRun === 0) {
        job.status = 'paused';
        job.auto = false;
        job.message = `已连续翻 ${job.pages} 页，为安全起见先停下。确认账号没有异常后可点「继续」`;
      } else if (job.batchPages >= PACE.batchPages) {
        job.batchPages = 0;
        queueBridgePush(); // 每批结束把本机数据推给开发桥，长回填期间也能看到进度
        await scheduleJob(account, job, rand(PACE.batchRestMs));
      } else {
        await scheduleJob(account, job, rand(PACE.pageGapMs));
      }
    }
    await saveJob(account, job);
  } finally {
    // 任务停下来（暂停、出错、等标签页）时，把节流期间没跟上的数据补进快照
    if (account) {
      const status = (await kvGet(keys.job(account)))?.status;
      await flushSnapshot(account, status !== 'running').catch(() => {});
      if (status !== 'running') queueBridgePush();
    }
    releaseBusy();
  }
}

export async function pauseJob(account, message = '已手动暂停') {
  const job = await kvGet(keys.job(account));
  if (!job || !['running', 'waiting_tab', 'paused'].includes(job.status)) return;
  job.status = 'paused';
  job.auto = false;
  job.nextAt = null;
  job.message = message;
  await saveJob(account, job);
  await chrome.alarms.clear(alarmFor(JOB_ALARM, account));
}

export async function resumeJob(account) {
  const job = await kvGet(keys.job(account));
  if (!job || !['paused', 'error', 'waiting_tab'].includes(job.status)) return { error: '没有可继续的任务' };
  job.status = 'running';
  job.auto = false;
  job.message = null;
  await saveJob(account, job);
  stepBackfill(account);
  return { ok: true };
}

/** 闹钟到点、或有 X 标签页上线时调用：把该继续的任务接上。 */
export async function wakeJob(account, tabOnline) {
  if (!await enabledAccount(account)) return;
  const job = await kvGet(keys.job(account));
  if (!job) return;
  const due = !job.nextAt || job.nextAt <= now();
  if (job.status === 'running') {
    // 已经在跑的不写回：这一步可能正在请求中，写回会把它刚存的进度盖掉
    if (!due) return;
  } else {
    if (job.status === 'paused' && job.auto && due) job.status = 'running';
    else if (job.status === 'waiting_tab' && tabOnline) job.status = 'running';
    else return;
    job.auto = false;
    await saveJob(account, job);
  }
  await stepBackfill(account);
}
