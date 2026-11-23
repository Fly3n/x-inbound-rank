// 别人回我：日常增量读取、1 小时延迟补漏与手动按时间回查诊断。
import { getEvents, kvGet, keys, getSettings } from '../db.js';
import { DAY_MS, KEEP_DAYS } from '../rank.js';
import { record } from '../diagnostics.js';
import { queueBridgePush } from '../bridge.js';
import { idGt } from '../x/parser.js';
import {
  PACE, EMPTY_SYNC_ID, INC_ALARM, alarmFor,
  enabledAccount, now, rand, sleep, inActiveHours, inAutoSlot, nextActiveAt, nextAutoSlot,
  serviceWait, isBusy, tryAcquireBusy, releaseBusy, updateCursor,
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
  if (!cur.syncedId) return blocked('请先完成「别人回我」初始化。');
  const job = await kvGet(keys.job(account));
  if (job && ['running', 'waiting_tab'].includes(job.status)) return blocked('「别人回我」正在初始化，请等它结束。');
  if (job?.status === 'paused' && job.auto) return blocked(job.message || '初始化正在退避，稍后自动继续。');
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

    // 每次从最新一页往回读，先接到上次成功读取的位置，再以那一轮读取时间为基准向更早补 1 小时：接住 X 短时晚放的回复。
    // 每个后台事件最多读 6 页；没读完就记下位置，休息 3–5 分钟后继续，
    // 直到接上、或者读到保存期限（90 天前，更早的反正要清掉）。
    // 接上之前接续点不动；出错中断时下次重读这一段，靠主键去重。
    const stopAt = cur.syncedId;
    const resume = cur.incResume?.stopAt === stopAt ? cur.incResume : null;
    const taskManual = manual || !!resume?.manual;
    const floorTs = now() - KEEP_DAYS * DAY_MS;
    const overlapCutoff = Math.min(cur.lastIncrementalAt || now(), now()) - PACE.incOverlapMs;
    const api = resume?.api || (await mentionsApi(account)); // 接着上一轮读的，游标是哪个接口的就用哪个
    const canRequest = api !== 'gql' || !!(await kvGet(keys.tplMentions(account)));
    const gap = PACE.incPageGapMs;
    const maxPages = PACE.incPagesPerEvent;
    let cursor = resume?.cursor || null;
    let topId = resume?.topId || null;
    let caughtUp = false;
    let manualMarked = false;
    const run = now();
    const roundStartedAt = resume?.startedAt || run;
    const batch = { read: 0, added: 0 };
    for (let page = 0; page < maxPages; page++) {
      if (page) await sleep(rand(gap));
      const trace = { account, mode: taskManual ? 'inbound_manual' : 'inbound_auto', run, page: page + 1 };
      const res = await pull(account, cursor, api, batch, trace);
      if (manual && canRequest && !manualMarked && !['no_tab', 'outside_window'].includes(res.kind)) {
        manualMarked = true;
        await updateCursor(account, (c) => { c.lastManualAt = now(); });
      }
      if (!await enabledAccount(account)) return false;
      if (res.kind === 'no_tab') {
        const when = nextActiveAt(now() + (cursor ? 60_000 : PACE.incRetryGapMs));
        await updateCursor(account, (c) => {
          if (cursor && c.syncedId === stopAt) c.incResume = { cursor, topId, stopAt, api, manual: taskManual, startedAt: roundStartedAt };
          c.nextIncAt = when;
        });
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        return false; // 没有本账号的 X 页面，等它重新连上
      }
      if (res.kind === 'outside_window') {
        const when = nextActiveAt(now());
        await updateCursor(account, (c) => {
          if (cursor && c.syncedId === stopAt) c.incResume = { cursor, topId, stopAt, api, manual: taskManual, startedAt: roundStartedAt };
          c.nextIncAt = when;
        });
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        return { message: '已到夜间休息时间，明天 08:00 后继续。' };
      }
      if (res.kind === 'backoff') {
        const when = Math.max(res.retryAt || 0, nextActiveAt(now() + PACE.incRetryGapMs));
        await updateCursor(account, (c) => {
          if (cursor && c.syncedId === stopAt) c.incResume = { cursor, topId, stopAt, api, manual: taskManual, startedAt: roundStartedAt };
          c.nextIncAt = when;
        });
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
      if (page === 0 && !resume) topId = p.newestId;
      const crossedCheckpoint = !stopAt || !!(p.newestId && !idGt(p.newestId, stopAt));
      const pastOverlap = p.newestTs != null && p.newestTs < overlapCutoff;
      const repeatedCursor = !!cursor && p.bottomCursor === cursor;
      const stopReason = !p.entryIds.length ? 'empty_page'
        : !p.bottomCursor ? 'no_next_page'
        : p.newestTs != null && p.newestTs < floorTs ? 'retention_boundary'
        : p.newestTs != null ? (pastOverlap && crossedCheckpoint ? 'reached_overlap' : null)
        : crossedCheckpoint ? 'reached_checkpoint' : null;
      if (repeatedCursor) {
        const when = nextActiveAt(now() + rand(PACE.restMs));
        await record('pagination_stop', { ...trace, source: 'mentions', reason: 'repeated_cursor', checkpoint: stopAt });
        await updateCursor(account, (c) => {
          delete c.incResume;
          c.nextIncAt = nextAutoSlot(when);
        });
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when: nextAutoSlot(when) });
        await setAlert(account, 'X 的提及列表返回了重复的翻页位置，本轮已停止；接续点没有前移。');
        return { error: '别人回我翻页异常，已停止本轮。' };
      }
      const endedBeforeCheckpoint = !!stopAt && stopAt !== EMPTY_SYNC_ID && !crossedCheckpoint &&
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
      const when = nextActiveAt(now() + rand(PACE.restMs));
      await updateCursor(account, (c) => {
        if (!c.syncedId) return; // 读的过程中被清空了
        c.incResume = { cursor, topId, stopAt, api, manual: taskManual, startedAt: roundStartedAt };
        c.nextIncAt = when;
      });
      await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
      return { message: '别人回我已读完一批，等待续读。', deferred: true };
    }
    const next = await updateCursor(account, (c) => {
      // 读的过程中被清空了（没有 syncedId）就不补：清空后要重新初始化才自动抓
      if (topId && c.syncedId && idGt(topId, c.syncedId)) c.syncedId = topId;
      delete c.incResume;
      delete c.serviceRetries;
      // 手动更新已经拿到最新数据，下一次自动更新顺延到下一个上午或晚间时段，避免当天再扫一遍。
      return completeIncRound(c, roundStartedAt);
    });
    if ((await getSettings(account)).fetchEnabled) await armInc(account, next);
    return { ok: true };
  } finally {
    if (account) await flushSnapshot(account, true).catch(() => {});
    queueBridgePush();
    releaseBusy();
  }
}

export async function diagnoseMentions({ account, from, to, postId, source }) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > DAY_MS ||
      (postId && !/^\d{1,24}$/.test(postId))) {
    return { error: '请选择一个不超过 24 小时的时间窗，帖子编号只填数字。' };
  }
  if (!await enabledAccount(account)) return { error: '请先为此账号开启插件。' };
  if (!inActiveHours()) return { error: '读取只在每天 08:00–24:00 进行，夜间不运行。' };
  const state = await kvGet(keys.cursor(account), {});
  const job = await kvGet(keys.job(account));
  if (isBusy() || (state.rateUntil || 0) > now() || state.serviceRetries && state.nextIncAt > now() ||
      job?.status === 'running' || job?.status === 'paused' && job.auto) {
    return { error: '正在读取或处于退避期，请稍后回查。' };
  }
  if (!tryAcquireBusy()) return { error: '正在读取或处于退避期，请稍后回查。' };
  const run = now();
  try {
    const api = source === 'rest' ? 'rest' : await mentionsApi(account);
    await record('diagnostic_start', { account, source: 'mentions', run, api, from, to, postId: postId || null });
    let cursor = null;
    let pages = 0;
    let matches = 0;
    let reason = 'page_limit';
    let target = null;
    for (let page = 1; page <= PACE.diagnosePages; page++) {
      if (page > 1) await sleep(rand(PACE.incPageGapMs));
      if (!await enabledAccount(account)) { reason = 'account_disabled'; break; }
      pages = page;
      const result = await pull(account, cursor, api, undefined, { account, mode: 'inbound_diagnostic', run, page }, true);
      if (result.kind !== 'ok') {
        reason = result.kind === 'unavailable' || result.kind === 'rate' ? String(result.status || 429) : result.kind;
        if (result.kind === 'rate' || result.kind === 'unavailable') {
          await updateCursor(account, (c) => {
            c.rateUntil = Math.max(c.rateUntil || 0, result.resetAt || 0, now() + PACE.backoffStartMs);
          });
        }
        break;
      }
      const { parsed, decisions } = result;
      matches += parsed.events.filter((event) => event.created_at >= from && event.created_at <= to).length;
      target = postId ? decisions.find((item) => item.postId === postId) : null;
      if (target) { reason = 'post_found'; break; }
      // 提及列表可能混排，旧帖出现在第一页不能证明后续页没有目标。
      if (!parsed.bottomCursor) { reason = 'end_of_feed'; break; }
      if (parsed.bottomCursor === cursor) { reason = 'repeated_cursor'; break; }
      cursor = parsed.bottomCursor;
    }
    const stored = postId ? (await getEvents(account)).some((event) => event.id === postId) : null;
    await record('diagnostic_end', { account, source: 'mentions', run, pages, matches, reason, target, stored });
    return { pages, matches, reason, target, stored };
  } finally {
    releaseBusy();
  }
}
