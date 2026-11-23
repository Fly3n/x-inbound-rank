// 别人回我：日常增量读取、重叠即停与免补历史直启。
import { kvGet, keys, getSettings } from '../db.js';
import { DAY_MS, KEEP_DAYS } from '../rank.js';
import { record } from '../diagnostics.js';
import { queueBridgePush } from '../bridge.js';
import { idGt } from '../x/parser.js';
import {
  PACE, EMPTY_SYNC_ID, INC_ALARM, alarmFor,
  enabledAccount, now, rand, sleep, humanIncDelay, inActiveHours, inAutoSlot, nextActiveAt, nextAutoSlot,
  serviceWait, tryAcquireBusy, releaseBusy, updateCursor,
  flushSnapshot, setAlert, scheduleNextInc, completeIncRound, armInc,
} from './runtime.js';
import { retryAlarm } from './alarms.js';
import { hasVisiblePage } from './accounts.js';
import { mentionsApi, pull } from './transport.js';

/** 自动任务未到期返回 null，手动任务受阻时返回具体原因。 */
async function incDue(account, manual) {
  const blocked = (error) => manual ? { error } : null;
  if (!await enabledAccount(account)) return blocked('请先为此账号开启插件。');
  const settings = await getSettings(account);
  const cur = await kvGet(keys.cursor(account), {});
  if (!manual && !cur.incResume && cur.incLimitReached) return null;
  const job = await kvGet(keys.job(account));
  if (job && ['running', 'waiting_tab'].includes(job.status)) return blocked('「别人回我」正在补历史，请等它结束。');
  if (job?.status === 'paused' && job.auto) return blocked(job.message || '补历史正在退避，稍后自动继续。');
  const t = now();
  if (!inActiveHours(t)) return blocked('读取只在每天 08:00–24:00 进行，夜间不自动发请求。');
  const until = Math.max(cur.rateUntil || 0, cur.serviceRetries ? cur.nextIncAt || 0 : 0);
  if (until > t) return blocked(`接口正在退避，请在 ${new Date(until).toLocaleTimeString()} 后再试。`);
  if (t < (cur.nextIncAt || 0)) {
    if (cur.incResume) return blocked('上一轮还有数据等待续读，插件会自动继续。');
    if (!manual) return null;
  }
  const resumeManual = !!cur.incResume?.manual;
  if (!manual && !resumeManual && !settings.fetchEnabled) return null;
  if (!manual && !resumeManual && !inAutoSlot(t)) return null;
  if (!manual && !cur.incResume && !cur.serviceRetries && t - (cur.lastAttemptAt || 0) < PACE.incRetryGapMs) return null;
  if (!manual && !(await hasVisiblePage(account))) return null;
  return { account, cur, settings };
}

export async function maybeIncremental(account, manual = false) {
  const inProgress = { error: '已有读取任务正在运行，请等这次完成。' };
  const eligibility = await incDue(account, manual);
  if (!eligibility || eligibility.error) return eligibility || false;
  if (!tryAcquireBusy()) return manual ? inProgress : retryAlarm(INC_ALARM, account);
  try {
    const due = await incDue(account, manual); // 占住之后再确认一遍：上面查的工夫里刚跑完一轮的话，时间已经往后推了
    if (!due || due.error) return due || false;
    const { cur } = due;

    // 每次从最新一页往回读：已有接续点时一发现与上次位置重叠即停（再往前都已读过）；
    // 从未补过历史的账号直接从启用时刻建立起点（单轮最多读 2 页）。
    // 每个后台事件最多读 6 页；没接上则休息 3–5 分钟续读，单轮最多 10 段（60 页）。
    const stopAt = cur.syncedId || null;
    const resume = (cur.incResume?.stopAt || null) === stopAt ? cur.incResume : null;
    const taskManual = manual || !!resume?.manual;
    const run = now();
    const floorTs = run - KEEP_DAYS * DAY_MS;
    const me = (await kvGet(keys.accounts, {}))[account];
    const startFloor = me?.activation || run;
    const api = resume?.api || (await mentionsApi(account)); // 接着上一轮读的，游标是哪个接口的就用哪个
    const canRequest = api !== 'gql' || !!(await kvGet(keys.tplMentions(account)));
    const maxPages = stopAt ? PACE.incPagesPerEvent : Math.min(PACE.incPagesPerEvent, 2);
    let cursor = resume?.cursor || null;
    let topId = resume?.topId || null;
    let caughtUp = false;
    let manualMarked = false;
    let pagesRead = 0;
    const roundStartedAt = resume?.startedAt || run;
    const batch = { read: 0, added: 0 };
    const saveResume = (c, nextAt) => {
      if (cursor && (c.syncedId || null) === stopAt) {
        c.incResume = {
          cursor,
          topId,
          stopAt,
          api,
          manual: taskManual,
          startedAt: roundStartedAt,
          rounds: resume?.rounds || 0,
          pages: (resume?.pages || 0) + pagesRead,
        };
      }
      c.nextIncAt = nextAt;
    };
    for (let page = 0; page < maxPages; page++) {
      if (page) await sleep(humanIncDelay());
      const trace = { account, mode: taskManual ? 'inbound_manual' : 'inbound_auto', run, page: page + 1 };
      const res = await pull(account, cursor, api, batch, trace);
      if (manual && canRequest && !manualMarked && !['no_tab', 'outside_window'].includes(res.kind)) {
        manualMarked = true;
        await updateCursor(account, (c) => { c.lastManualAt = now(); });
      }
      if (!await enabledAccount(account)) return false;
      if (res.kind === 'no_tab') {
        const when = nextActiveAt(now() + (cursor ? 60_000 : PACE.incRetryGapMs));
        await updateCursor(account, (c) => saveResume(c, when));
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        return false; // 没有本账号的 X 页面，等它重新连上
      }
      if (res.kind === 'outside_window') {
        const when = nextActiveAt(now());
        await updateCursor(account, (c) => saveResume(c, when));
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        return { message: '已到夜间休息时间，明天 08:00 后继续。' };
      }
      if (res.kind === 'backoff') {
        const when = Math.max(res.retryAt || 0, nextActiveAt(now() + PACE.incRetryGapMs));
        await updateCursor(account, (c) => saveResume(c, when));
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        return { message: '账号正在限流退避，本轮没有继续发请求。' };
      }
      if (res.kind === 'tpl_bad') {
        // 新接口的模板失效：休息三到五分钟后用旧接口从最新一页重读这一段
        const when = nextActiveAt(now() + rand(PACE.restMs));
        await updateCursor(account, (c) => {
          delete c.incResume;
          c.nextIncAt = when;
        });
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        return { message: '新版读取方式失效，已安排用旧接口重试。' };
      }
      await updateCursor(account, (c) => {
        c.lastAttemptAt = now();
      });
      if (res.kind === 'unavailable') {
        const wait = serviceWait(cur.serviceRetries);
        const when = nextActiveAt(now() + wait);
        await updateCursor(account, (c) => {
          c.nextIncAt = when;
          c.serviceRetries = (c.serviceRetries || 0) + 1;
        });
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        await setAlert(account, `X 暂时不可用（HTTP ${res.status}），稍后重试`);
        await record('retry_scheduled', { ...trace, source: 'incremental', status: res.status, waitMs: wait });
        return { message: `别人回我读取失败（HTTP ${res.status}），已安排重试。` };
      }
      if (res.kind === 'rate') {
        await armInc(account, await updateCursor(account, (c) => {
          const next = scheduleNextInc(c, now());
          c.rateUntil = Math.max(c.rateUntil || 0, next, res.resetAt ? nextActiveAt(res.resetAt) : 0);
          c.nextIncAt = c.rateUntil;
          return c.nextIncAt;
        }));
        await setAlert(account, '增量更新被 X 限流（429），本轮已放弃，下个周期再试');
        return { message: '别人回我遇到限流，已退避。' };
      }
      if (res.kind === 'error') {
        await setAlert(account, res.message);
        return { error: res.message };
      }
      const p = res.parsed;
      pagesRead += 1;
      if (page === 0 && !resume) topId = p.newestId;
      const repeatedCursor = !!cursor && p.bottomCursor === cursor;
      if (repeatedCursor) {
        const when = nextAutoSlot(nextActiveAt(now() + rand(PACE.restMs)));
        await record('pagination_stop', { ...trace, source: 'mentions', reason: 'repeated_cursor', checkpoint: stopAt });
        await updateCursor(account, (c) => {
          delete c.incResume;
          c.nextIncAt = when;
        });
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        await setAlert(account, 'X 的提及列表返回了重复的翻页位置，本轮已停止；接续点没有前移。');
        return { error: '别人回我翻页异常，已停止本轮。' };
      }
      if (!stopAt) {
        const totalInitialPages = (resume?.pages || 0) + pagesRead;
        if (!p.entryIds.length || !p.bottomCursor || (p.oldestTs != null && p.oldestTs <= startFloor) || totalInitialPages >= 2) {
          await record('pagination_stop', { ...trace, source: 'mentions', reason: 'initial_anchor', checkpoint: null });
          caughtUp = true;
          break;
        }
        cursor = p.bottomCursor;
        continue;
      }
      const overlapped = stopAt !== EMPTY_SYNC_ID && !!(p.oldestId && !idGt(p.oldestId, stopAt));
      const stopReason = overlapped ? 'reached_overlap'
        : !p.entryIds.length ? 'empty_page'
        : !p.bottomCursor ? 'no_next_page'
        : (p.oldestTs != null && p.oldestTs < floorTs) ? 'retention_boundary'
        : null;
      const endedBeforeCheckpoint = stopAt !== EMPTY_SYNC_ID && !overlapped &&
        (stopReason === 'empty_page' || stopReason === 'no_next_page');
      if (endedBeforeCheckpoint) {
        const when = nextAutoSlot(now() + rand(PACE.restMs));
        await record('pagination_stop', { ...trace, source: 'mentions', reason: 'ended_before_checkpoint', checkpoint: stopAt });
        await updateCursor(account, (c) => {
          delete c.incResume;
          c.nextIncAt = when;
        });
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        await setAlert(account, 'X 的提及列表在接上上次位置前提前结束，本轮已停止；接续点没有前移。');
        return { error: '别人回我列表提前结束，已停止本轮。' };
      }
      if (stopReason) {
        await record('pagination_stop', { ...trace, source: 'mentions', reason: stopReason, checkpoint: stopAt });
        caughtUp = true;
        break;
      }
      cursor = p.bottomCursor;
    }
    if (!caughtUp) {
      const rounds = (resume?.rounds || 0) + 1;
      if (rounds >= PACE.incMaxRounds) {
        const when = nextAutoSlot(now());
        await updateCursor(account, (c) => {
          delete c.incResume;
          c.incLimitReached = true;
          c.nextIncAt = when;
        });
        await chrome.alarms.clear(alarmFor(INC_ALARM, account));
        await setAlert(account, '本轮新增回复较多，已达到安全页数上限（60 页），请稍后手动更新或补读历史');
        await record('inc_limit_reached', { account, mode: taskManual ? 'inbound_manual' : 'inbound_auto', run, rounds, read: batch.read, added: batch.added });
        return { error: '别人回我本轮达到安全页数上限，已停止。' };
      }
      const when = nextActiveAt(now() + rand(PACE.restMs));
      await updateCursor(account, (c) => {
        if ((c.syncedId || null) !== stopAt) return; // 读的过程中被补历史或清空改掉了
        c.incResume = { cursor, topId, stopAt, api, manual: taskManual, startedAt: roundStartedAt, rounds, pages: (resume?.pages || 0) + pagesRead };
        c.nextIncAt = when;
      });
      await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
      return { message: '别人回我已读完一批，等待续读。', deferred: true };
    }
    let nextSyncedId = stopAt;
    const next = await updateCursor(account, (c) => {
      if (!c.syncedId) c.syncedId = topId || EMPTY_SYNC_ID;
      else if (topId && idGt(topId, c.syncedId)) c.syncedId = topId;
      nextSyncedId = c.syncedId;
      delete c.incResume;
      delete c.serviceRetries;
      delete c.incLimitReached;
      // 手动更新已经拿到最新数据，下一次自动更新顺延到下一个上午或晚间时段，避免当天再扫一遍。
      return completeIncRound(c, roundStartedAt);
    });
    await record('inc_round_end', {
      account,
      mode: taskManual ? 'inbound_manual' : 'inbound_auto',
      run,
      pages: (resume?.pages || 0) + pagesRead,
      read: batch.read,
      added: batch.added,
      syncedId: nextSyncedId,
    });
    if ((await getSettings(account)).fetchEnabled) await armInc(account, next);
    return { ok: true };
  } finally {
    if (account) await flushSnapshot(account, true).catch(() => {});
    queueBridgePush();
    releaseBusy();
  }
}
