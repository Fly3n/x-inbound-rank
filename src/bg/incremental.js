// 别人回我：日常通知页/提及页零请求旁听收集，以及按需手动「立即更新」增量拉取（无后台定时抓取）。
import { putEvents, kvGet, keys, getSettings } from '../db.js';
import { DAY_MS, KEEP_DAYS } from '../rank.js';
import { record } from '../diagnostics.js';
import { queueBridgePush } from '../bridge.js';
import { mentionsEvidence } from '../x/mentions-diagnostics.js';
import { parseNotificationsTap, ParseError, idGt } from '../x/parser.js';
import {
  PACE, EMPTY_SYNC_ID, INC_ALARM, alarmFor,
  enabledAccount, now, sleep, humanIncDelay, humanRestDelay, inActiveHours, nextActiveAt,
  serviceWait, tryAcquireBusy, releaseBusy, updateCursor,
  refreshSnapshot, flushSnapshot, setAlert, completeIncRound,
} from './runtime.js';
import { retryAlarm } from './alarms.js';
import { hasVisiblePage, senderAccount } from './accounts.js';
import { pull } from './transport.js';

/** 旁听浏览器通知页 / 提及页响应，零请求写入入站库并记录完整诊断（不推 syncedId，不遮蔽未翻到的漏项）。 */
export async function handleInboundTap(msg, sender) {
  const account = await senderAccount(msg, sender);
  const { url, status, metadata, text } = msg;
  if (!account || typeof text !== 'string' || text.length > 8_000_000) return {};
  const settings = await getSettings(account);
  if (!settings.tapInEnabled) return { skipped: 'tap_disabled' };
  const tabId = sender?.tab?.id ?? null;
  const validStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  let body = null;
  let jsonOk = true;
  try {
    body = JSON.parse(text);
  } catch {
    jsonOk = false;
  }
  const evidence = await mentionsEvidence(url, body, metadata).catch(() => null);
  const timeline = evidence?.request?.timeline || 'unknown';
  const hasCursor = evidence?.request?.hasCursor ?? null;
  if (evidence?.request?.timeline === 'Mentions') {
    await record('web_mentions_response', {
      account, source: 'mentions-graphql', tabId, status: validStatus, evidence,
    });
  }
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me?.enabled) return {};
  if (validStatus && (validStatus < 200 || validStatus >= 300)) {
    await record('inbound_tap_skipped', {
      account, source: 'notifications_tap', tabId, timeline, hasCursor, status: validStatus, reason: 'http_status',
    });
    queueBridgePush();
    return { ok: false, skipped: true };
  }
  if (!jsonOk) {
    await record('inbound_tap_failed', {
      account, source: 'notifications_tap', tabId, timeline, hasCursor, status: validStatus, category: 'invalid_json',
    });
    queueBridgePush();
    return { ok: false };
  }
  const decisions = [];
  let parsed;
  try {
    parsed = parseNotificationsTap(body, me, {
      timeline,
      inspect: (id, reason) => {
        decisions.push({ postId: typeof id === 'string' && /^\d{1,24}$/.test(id) ? id : null, reason });
      },
    });
  } catch (e) {
    await record('inbound_tap_failed', {
      account, source: 'notifications_tap', tabId, timeline, hasCursor, status: validStatus,
      category: e instanceof ParseError ? 'unexpected_payload' : 'parser_exception',
      reason: String(e?.message || e).slice(0, 200),
      decisions,
      shapes: evidence?.response?.timelineShapes || [],
      postCount: evidence?.response?.postCount ?? null,
    });
    queueBridgePush();
    return { ok: false };
  }
  let added;
  try {
    added = await putEvents(account, parsed.events);
  } catch {
    await record('save_failed', { account, mode: 'inbound_tap', source: 'notifications_tap', tabId, timeline, decisions });
    queueBridgePush();
    return { ok: false };
  }
  const tapAt = now();
  await updateCursor(account, (cur) => {
    cur.inLastTapAt = tapAt;
    cur.inLastTapCounts = { read: parsed.events.length, added, timeline };
    if (parsed.newestId && (!cur.newestId || idGt(parsed.newestId, cur.newestId))) cur.newestId = parsed.newestId;
    if (parsed.oldestTs && (!cur.earliestTs || parsed.oldestTs < cur.earliestTs)) cur.earliestTs = parsed.oldestTs;
  });
  await record('inbound_tap', {
    account, source: 'notifications_tap', tabId, timeline, hasCursor,
    entries: parsed.entryIds.length,
    nonTweetEntries: parsed.nonTweetEntries,
    nonTweetKinds: parsed.nonTweetKinds,
    parsed: parsed.events.length,
    added,
    deduped: parsed.events.length - added,
    newestAt: parsed.newestTs,
    oldestAt: parsed.oldestTs,
    more: !!parsed.bottomCursor,
    decisions,
    shapes: evidence?.response?.timelineShapes || [],
  });
  if (added > 0) await refreshSnapshot(account).catch(() => {});
  queueBridgePush();
  return { ok: true, added, parsed: parsed.events.length, timeline };
}

/** 仅允许手动触发或续完进行中的手动增量；无后台定时自动抓取。 */
async function incDue(account, manual) {
  const blocked = (error) => manual ? { error } : null;
  if (!await enabledAccount(account)) return blocked('请先为此账号开启插件。');
  const settings = await getSettings(account);
  const cur = await kvGet(keys.cursor(account), {});
  const resumeManual = !!cur.incResume?.manual;
  if (!manual && !resumeManual) return null;
  if (!manual && cur.incLimitReached) return null;
  const job = await kvGet(keys.job(account));
  if (job && ['running', 'waiting_tab'].includes(job.status)) return blocked('「别人回我」正在补历史，请等它结束。');
  if (job?.status === 'paused' && job.auto) return blocked(job.message || '补历史正在退避，稍后自动继续。');
  const t = now();
  if (!inActiveHours(t)) return blocked('读取只在每天 08:00–24:00 进行，夜间不发请求。');
  const until = Math.max(cur.rateUntil || 0, cur.serviceRetries ? cur.nextIncAt || 0 : 0);
  if (until > t) return blocked(`接口正在退避，请在 ${new Date(until).toLocaleTimeString()} 后再试。`);
  if (t < (cur.nextIncAt || 0)) {
    if (cur.incResume) return blocked('上一轮还有数据等待续读，插件会自动继续。');
    if (!manual) return null;
  }
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
    // 每个后台事件最多读 6 页；没接上则休息 3–5 分钟续读，单轮最多 8 段（48 页）。
    const stopAt = cur.syncedId || null;
    const resume = (cur.incResume?.stopAt || null) === stopAt ? cur.incResume : null;
    const taskManual = manual || !!resume?.manual;
    const run = now();
    const floorTs = run - KEEP_DAYS * DAY_MS;
    const me = (await kvGet(keys.accounts, {}))[account];
    const startFloor = me?.activation || run;
    const api = 'gql';
    const canRequest = !!(await kvGet(keys.tplMentions(account)));
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
      if (manual && canRequest && !manualMarked && !['no_tab', 'outside_window', 'tpl_bad'].includes(res.kind)) {
        manualMarked = true;
        await updateCursor(account, (c) => { c.lastManualAt = now(); });
      }
      if (!await enabledAccount(account)) return false;
      if (res.kind === 'no_tab') {
        if (cursor) {
          const when = nextActiveAt(now() + 60_000);
          await updateCursor(account, (c) => saveResume(c, when));
          await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        }
        return false; // 没有本账号的 X 页面，等它重新连上
      }
      if (res.kind === 'outside_window') {
        if (cursor) {
          const when = nextActiveAt(now());
          await updateCursor(account, (c) => saveResume(c, when));
          await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        }
        return { message: '已到夜间休息时间，明天 08:00 后继续。' };
      }
      if (res.kind === 'backoff') {
        if (cursor) {
          const when = Math.max(res.retryAt || 0, nextActiveAt(now() + PACE.incRetryGapMs));
          await updateCursor(account, (c) => saveResume(c, when));
          await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        }
        return { message: '账号正在限流退避，本轮没有继续发请求。' };
      }
      if (res.kind === 'tpl_bad') {
        // 通知模板缺失或已过期：不再降级打废弃旧 REST，等待用户自行打开一次 X 通知页后重试
        await updateCursor(account, (c) => {
          delete c.incResume;
        });
        await chrome.alarms.clear(alarmFor(INC_ALARM, account));
        await setAlert(account, 'X 通知读取方式尚未就绪或已更新，请打开一次 X 的「通知」页后再点立即更新。');
        return { message: '请打开一次 X 的「通知」页，再点立即更新。' };
      }
      await updateCursor(account, (c) => {
        c.lastAttemptAt = now();
      });
      if (res.kind === 'unavailable') {
        const wait = serviceWait(cur.serviceRetries);
        const when = nextActiveAt(now() + wait);
        await updateCursor(account, (c) => {
          if (cursor) saveResume(c, when);
          else c.nextIncAt = when;
          c.serviceRetries = (c.serviceRetries || 0) + 1;
        });
        if (cursor) await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        await setAlert(account, `X 暂时不可用（HTTP ${res.status}），请稍后重试`);
        await record('retry_scheduled', { ...trace, source: 'incremental', status: res.status, waitMs: wait });
        return { message: `别人回我读取失败（HTTP ${res.status}），请稍后重试。` };
      }
      if (res.kind === 'rate') {
        await updateCursor(account, (c) => {
          delete c.incResume;
          c.rateUntil = Math.max(c.rateUntil || 0, res.resetAt ? nextActiveAt(res.resetAt) : now() + PACE.backoffStartMs);
          c.nextIncAt = c.rateUntil;
        });
        await chrome.alarms.clear(alarmFor(INC_ALARM, account));
        await setAlert(account, '手动更新被 X 限流（429），本轮已停止，请退避结束后再试');
        return { message: '别人回我遇到限流，已退避。' };
      }
      if (res.kind === 'circuit_broken') return { error: res.message };
      if (res.kind === 'error') {
        await updateCursor(account, (c) => { delete c.incResume; });
        await chrome.alarms.clear(alarmFor(INC_ALARM, account));
        await setAlert(account, res.message);
        return { error: res.message };
      }
      const p = res.parsed;
      pagesRead += 1;
      if (page === 0 && !resume) topId = p.newestId;
      const repeatedCursor = !!cursor && p.bottomCursor === cursor;
      if (repeatedCursor) {
        await record('pagination_stop', { ...trace, source: 'mentions', reason: 'repeated_cursor', checkpoint: stopAt });
        await updateCursor(account, (c) => {
          delete c.incResume;
        });
        await chrome.alarms.clear(alarmFor(INC_ALARM, account));
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
        await record('pagination_stop', { ...trace, source: 'mentions', reason: 'ended_before_checkpoint', checkpoint: stopAt });
        await updateCursor(account, (c) => {
          delete c.incResume;
        });
        await chrome.alarms.clear(alarmFor(INC_ALARM, account));
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
        await updateCursor(account, (c) => {
          delete c.incResume;
          c.incLimitReached = true;
        });
        await chrome.alarms.clear(alarmFor(INC_ALARM, account));
        await setAlert(account, `本轮新增回复较多，已达到安全页数上限（${PACE.incMaxRounds * PACE.incPagesPerEvent} 页），请稍后手动更新或补读历史`);
        await record('inc_limit_reached', { account, mode: 'inbound_manual', run, rounds, read: batch.read, added: batch.added });
        return { error: '别人回我本轮达到安全页数上限，已停止。' };
      }
      const when = nextActiveAt(now() + humanRestDelay(PACE.restMs));
      await updateCursor(account, (c) => {
        if ((c.syncedId || null) !== stopAt) return; // 读的过程中被补历史或清空改掉了
        c.incResume = { cursor, topId, stopAt, api, manual: true, startedAt: roundStartedAt, rounds, pages: (resume?.pages || 0) + pagesRead };
        c.nextIncAt = when;
      });
      await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
      return { message: '别人回我已读完一批，等待续读。', deferred: true };
    }
    let nextSyncedId = stopAt;
    await updateCursor(account, (c) => {
      if (!c.syncedId) c.syncedId = topId || EMPTY_SYNC_ID;
      else if (topId && idGt(topId, c.syncedId)) c.syncedId = topId;
      nextSyncedId = c.syncedId;
      delete c.incResume;
      delete c.serviceRetries;
      delete c.incLimitReached;
      completeIncRound(c, roundStartedAt);
    });
    await chrome.alarms.clear(alarmFor(INC_ALARM, account));
    await record('inc_round_end', {
      account,
      mode: 'inbound_manual',
      run,
      pages: (resume?.pages || 0) + pagesRead,
      read: batch.read,
      added: batch.added,
      syncedId: nextSyncedId,
    });
    return { ok: true };
  } finally {
    if (account) await flushSnapshot(account, true).catch(() => {});
    queueBridgePush();
    releaseBusy();
  }
}
