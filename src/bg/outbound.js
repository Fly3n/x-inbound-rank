// 我回别人：日常浏览器发帖实时旁听入库，以及按需补历史 / 低频自动兜底同步。
import { putEvents, kvGet, kvSet, kvRemove, keys, getSettings, OUT } from '../db.js';
import { DAY_MS, OUT_SCHEMA } from '../rank.js';
import { record } from '../diagnostics.js';
import { queueBridgePush } from '../bridge.js';
import { parseCreatedReply, parseMyReplies, ParseError, idGt } from '../x/parser.js';
import {
  PACE, EMPTY_SYNC_ID, OUT_ALARM, alarmFor,
  enabledAccount, now, rand, sleep, humanIncDelay, inActiveHours, inAutoSlot, nextActiveAt, nextAutoSlot, nextOutAutoSlot,
  temporaryUnavailable, serviceWait, tryAcquireBusy, releaseBusy, updateCursor, refreshSnapshot,
} from './runtime.js';
import { retryAlarm } from './alarms.js';
import { hasVisiblePage, hasActivePage, senderAccount } from './accounts.js';
import { fetchViaTab } from './transport.js';

export const saveOut = (account, patch) =>
  updateCursor(account, (cur) => {
    cur.out = { ...cur.out, ...patch };
  });

/** 旁听浏览器发回复响应，实时写入 OUT（不推 syncedId / lastAt，避免遮蔽手机端回复）。 */
export async function handleOutboundTap(msg, sender) {
  const account = await senderAccount(msg, sender);
  const { text } = msg;
  if (!account || typeof text !== 'string' || text.length > 8_000_000) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    await record('outbound_tap_unmatched', { account, reason: 'invalid_json' });
    return {};
  }
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me?.enabled) return {};
  const parsed = parseCreatedReply(body, me);
  if (!parsed.ok) {
    await record('outbound_tap_unmatched', { account, reason: parsed.reason });
    return {};
  }
  if (!parsed.event) {
    // 原创/引用主帖（非回复）才刷新刚发帖缓冲，避免回复别人误顺延发帖排期
    if (parsed.reason === 'not_reply') await kvSet(keys.lastPostAt(account), now());
    return {};
  }
  const added = await putEvents(account, [parsed.event], OUT);
  await record('outbound_tap', {
    account,
    postId: parsed.event.id,
    own: !!parsed.event.own,
    direct: parsed.event.reply_to_id === parsed.event.conversation_id,
    added,
  });
  if (added > 0) {
    await refreshSnapshot(account).catch(() => {});
    queueBridgePush();
  }
  return { ok: true, added };
}

/** 读取已排队的补历史，或更新已经同步过的账号。 */
export async function syncOut(account, manual = false) {
  if (!await enabledAccount(account)) return;
  const settings = await getSettings(account);
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me?.enabled) return;
  if (!tryAcquireBusy()) return retryAlarm(OUT_ALARM, account);
  let started = false;
  try {
    const cur = await kvGet(keys.cursor(account), {});

    const prev = cur.out || {};
    const pending = !!prev.resume || !!prev.retryAt || ['need_tpl', 'queued', 'waiting_tab', 'reading'].includes(prev.status);
    // 手动读取一旦开始，就允许跨分段续完；自动读取仅在同时打开自动更新与低频同步开关时才启动。
    const taskManual = manual || (!!prev.manualTask && pending);
    if (!taskManual && (!settings.fetchEnabled || !settings.outAutoSync)) return;
    if (!taskManual && !pending && !inAutoSlot()) return;
    if (!inActiveHours()) {
      if (!manual) {
        const when = nextActiveAt();
        await saveOut(account, {
          nextAutoAt: when,
          ...(prev.resume ? { resume: { ...prev.resume, nextAt: when } } : {}),
          ...(prev.retryAt ? { retryAt: when } : {}),
        });
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when });
      }
      return;
    }
    // 自动读取只在上午/晚间窗口启动；窗口内没接完的续读也留到下一个窗口，
    // 避免 11:30 或 22:30 后因等待页面而临时补跑。手动初始化和立即更新不受这条限制。
    if (!taskManual && !inAutoSlot()) {
      const when = nextAutoSlot();
      const patch = { nextAutoAt: when };
      if (prev.resume) patch.resume = { ...prev.resume, nextAt: when };
      if (prev.retryAt) patch.retryAt = when;
      if (prev.status === 'reading') {
        patch.status = 'queued';
        patch.message = '已到自动读取窗口外，下一个时段继续。';
      }
      await saveOut(account, patch);
      await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when });
      return;
    }
    // 达到单次上限后已经明确报错停下：自动闹钟不要继续烧额度，等用户手动点补历史或立即更新再试
    if (!manual && prev.status === 'error' && prev.limitReached) return;
    const autoDue = prev.nextAutoAt ?? (prev.lastAt ? nextOutAutoSlot(prev.lastAt) : 0);
    const recovering = pending || prev.status === 'need_tpl';
    const nextAt = Math.max(prev.resume?.nextAt || 0, prev.retryAt || 0, !manual && !recovering ? autoDue : 0);
    if (nextAt > now()) {
      await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: nextAt });
      return;
    }
    if (!manual && !(await (taskManual ? hasVisiblePage(account) : hasActivePage(account)))) return;
    const initDays = prev.initDays ?? settings.initDays;
    const targetTs = prev.targetTs ?? now() - initDays * DAY_MS;
    // 完整读：手动补历史（fullFor 被清成 0）、或旧版本已同步数据的结构升级——读到补历史范围的起点。
    // 首次免补历史建起点（bootstrap）：从未同步过且非补历史时，只读启用时刻前后（最多 2 页）建立接续点。
    const full = prev.fullFor === 0 || (!!(prev.lastAt || prev.syncedId) && (prev.schema || 1) < OUT_SCHEMA);
    const bootstrap = !full && !prev.syncedId;
    const startFloor = me?.enabledAt || now();
    // 上一轮被页数上限截断、留了续读位置：同一种读法就接着读；读法变了（比如范围调大了）就从头来
    const resume = prev.resume && (prev.resume.full ?? true) === full ? prev.resume : null;
    const stopAt = full || bootstrap ? null : resume?.stopAt || prev.syncedId;
    // 这个接口一轮最多读五页；首次建起点最多读 2 页，与入站免补历史口径一致。
    const maxPages = bootstrap ? Math.min(PACE.outPages, 2) : PACE.outPages;

    // running：正在读，读到第几页。弹窗据此显示进度；不管怎么结束，finally 里都会清掉
    started = true;
    await saveOut(account, { status: 'reading', retryAt: null, message: null, limitReached: null, attemptCoverTs: null, manualTask: taskManual, running: { at: now(), pages: 0 } });
    const tpl = await kvGet(keys.tpl(account));
    if (!tpl) {
      await saveOut(account, { status: 'need_tpl', message: '打开 X 的「回复」栏一次，插件会自动继续。' });
      if (await kvGet(keys.tpl(account))) {
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: now() + 3000 });
      }
      return;
    }
    let cursor = resume?.cursor || null;
    let topId = resume?.topId || null;
    let reachedTs = null;
    let complete = false; // 读到了该停的位置（不是被页数上限截断）
    let reachedEnd = false; // 本次完整读是因为列表到底才停下
    let pages = 0;
    const run = now();
    const batch = { read: 0, added: 0 };
    for (; pages < maxPages; pages++) {
      if (pages) await sleep(humanIncDelay());
      if (!await enabledAccount(account)) return;
      const curSettings = await getSettings(account);
      if (!taskManual && (!curSettings.fetchEnabled || !curSettings.outAutoSync)) return saveOut(account, { status: 'error', message: '自动更新已关闭，读取已暂停。' });
      const trace = { account, mode: full ? 'outbound_backfill' : manual ? 'outbound_manual' : 'outbound_auto', run, page: pages + 1 };
      const r = await fetchViaTab(account, { kind: 'out', tpl: tpl.url, cursor }, trace);
      // 没有 X 标签页、或登录的不是这个账号：自动读的时候悄悄等下一轮，手动点的要说清楚为什么没读
      if (r.error === 'circuit_broken') return;
      if (r.error === 'no_tab') return saveOut(account, { status: 'waiting_tab', resume: { cursor, topId, rounds: resume?.rounds || 0, full, stopAt }, message: '打开此账号的 X 页面后自动继续。' });
      if (r.error === 'outside_window') {
        const when = nextActiveAt();
        await saveOut(account, { status: 'ok', message: '已到夜间休息时间，明天再继续。', ...(cursor ? { resume: { cursor, topId, rounds: resume?.rounds || 0, full, stopAt, nextAt: when } } : { nextAutoAt: when }) });
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when });
        return;
      }
      if (temporaryUnavailable(r.status)) {
        const wait = serviceWait(prev.serviceRetries);
        const retryAt = now() + wait;
        await saveOut(account, { status: 'queued', retryAt, resume: { cursor, topId, rounds: resume?.rounds || 0, full, stopAt }, serviceRetries: (prev.serviceRetries || 0) + 1,
          message: `X 暂时不可用（HTTP ${r.status}），稍后继续读取。` });
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: retryAt });
        await record('retry_scheduled', { ...trace, source: 'replies', status: r.status, waitMs: wait });
        return;
      }
      if (r.error === 'backoff' || r.status === 429) {
        const retryAt = r.backoffUntil || r.rateResetAt || now() + PACE.backoffStartMs;
        const attempts = r.rate429Count || prev.rate429Count || 1;
        await saveOut(account, { status: 'queued', retryAt,
          resume: { cursor, topId, rounds: resume?.rounds || 0, full, stopAt },
          rate429Count: attempts,
          message: `账号正在限流退避，将在 ${new Date(retryAt).toLocaleTimeString()} 后续读。` });
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: retryAt });
        await record('retry_scheduled', { ...trace, source: 'replies', status: r.status || 0, attempts, waitMs: retryAt - now() });
        return;
      }
      if (r.error === 'bad_tpl' || r.status === 400 || r.status === 404) {
        await kvRemove(keys.tpl(account)); // 模板过期了（X 发版换了参数）：过一会儿的下一轮会自己重新取
        return saveOut(account, { status: 'need_tpl', resume: null, message: 'X 的读取方式已更新。打开「回复」页后自动继续。' });
      }
      if (!r.ok) return saveOut(account, { status: 'error', message: `读我的回复列表失败（${r.error || 'HTTP ' + r.status}）` });

      let p;
      try {
        p = parseMyReplies(r.body, me);
      } catch (e) {
        await record('parse_failed', { ...trace, source: 'replies', category: e instanceof ParseError ? 'unexpected_payload' : 'parser_exception' });
        return saveOut(account, { status: 'error', message: `我的回复列表解析失败：${e instanceof ParseError ? e.message : String(e)}` });
      }
      const readAt = now();
      const added = await putEvents(account, p.events, OUT);
      batch.read += p.events.length;
      batch.added += added;
      await record('page_saved', { ...trace, source: 'replies', posts: p.events.map(({ id, own, created_at }) => ({ postId: id, own: !!own, createdAt: created_at })), newestAt: p.newestTs, oldestAt: p.oldestTs, cursorRepeated: !!cursor && cursor === p.bottomCursor, parsed: p.events.length, added, more: !!p.bottomCursor });
      await saveOut(account, { lastReadAt: readAt, lastReadCounts: { ...batch }, ...(manual && !full ? { lastManualAt: run } : {}), rate429Count: 0, running: { at: now(), pages: pages + 1 } });
      if (!topId) topId = p.newestId;
      if (p.oldestTs) reachedTs = p.oldestTs;
      if (cursor && p.bottomCursor === cursor) {
        await record('pagination_stop', { ...trace, source: 'replies', reason: 'repeated_cursor', checkpoint: stopAt });
        const message = 'X 返回了重复的翻页位置，本轮已停止；接续点和覆盖范围没有前移。';
        await saveOut(account, {
          status: 'error', retryAt: null, running: null, resume: null, pages,
          message, limitReached: false,
          ...(full ? {
            attemptCoverTs: reachedTs || prev.attemptCoverTs || null,
            reachedEnd: false,
            fullFor: initDays,
            initDays: null,
            targetTs: null,
          } : {}),
        });
        return;
      }
      const ended = !p.oldestId || !p.bottomCursor; // 列表到底了
      const reachedTarget = p.newestTs != null && p.newestTs < targetTs;
      const bootstrapReached = bootstrap && (ended || (p.oldestTs != null && p.oldestTs <= startFloor) || pages + 1 >= maxPages);
      const crossedCheckpoint = !stopAt || !!(p.oldestId && !idGt(p.oldestId, stopAt));
      const stoppedByTime = full ? reachedTarget : bootstrap ? bootstrapReached : crossedCheckpoint;
      const endedBeforeCheckpoint = ended && !full && !bootstrap && !!stopAt && stopAt !== EMPTY_SYNC_ID && !crossedCheckpoint;
      if (endedBeforeCheckpoint) {
        await record('pagination_stop', { ...trace, source: 'replies', reason: 'ended_before_checkpoint', checkpoint: stopAt });
        await saveOut(account, {
          status: 'error', retryAt: null, running: null, resume: null, pages,
          message: 'X 的回复列表在接上上次位置前提前结束，本轮已停止；接续点没有前移。',
          limitReached: false, manualTask: false, nextAutoAt: nextOutAutoSlot(now()),
        });
        return;
      }
      if (ended || stoppedByTime) {
        complete = true;
        reachedEnd = ended && !reachedTarget && !(bootstrap && p.oldestTs != null && p.oldestTs <= startFloor);
        pages++;
        break;
      }
      cursor = p.bottomCursor;
    }
    const rounds = (resume?.rounds || 0) + 1;
    if (!complete && rounds >= PACE.outMaxRounds) {
      const message = full
        ? '本次初始化达到单次页数上限，仍未读到所选范围。可重新初始化或缩小范围。'
        : '本次读取达到单次页数上限，仍未接上上次进度。稍后可再点「立即更新」。';
      await saveOut(account, {
        status: 'error', retryAt: null, running: null, resume: null, pages,
        message, limitReached: true, attemptCoverTs: reachedTs || prev.attemptCoverTs || null,
        ...(full ? {
          reachedEnd: false,
          fullFor: initDays, // 本次完整读没有完成，下次自动运行只做增量，等用户再点初始化
          initDays: null,
          targetTs: null,
        } : {}),
      });
      return;
    }
    if (!complete && rounds < PACE.outMaxRounds) {
      // 一轮没读完：记下位置，休息一批的间隔后在新的闹钟事件里接着读。读完之前接续点不动
      const nextAt = now() + rand(PACE.outRestMs);
      await saveOut(account, { status: 'ok', serviceRetries: 0, message: null, pages, limitReached: null, ...(full ? { attemptCoverTs: reachedTs } : {}), resume: { cursor, topId, rounds, full, stopAt, nextAt } });
      await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: nextAt });
      return;
    }
    // 读完了（读到该停的位置、列表到底，或续读轮数用完到此为止）
    const syncedId = topId && (!prev.syncedId || idGt(topId, prev.syncedId))
      ? topId
      : prev.syncedId || topId || ((full || bootstrap) && !reachedTs ? EMPTY_SYNC_ID : null);
    const nextAutoAt = nextOutAutoSlot(now());
    const done = { status: 'ok', serviceRetries: 0, rate429Count: 0, message: null, pages, syncedId, schema: OUT_SCHEMA, resume: null, lastAt: now(), nextAutoAt, manualTask: false };
    await saveOut(account, full ? {
      ...done,
      coverTs: reachedTs && prev.coverTs ? Math.min(prev.coverTs, reachedTs) : reachedTs || prev.coverTs || null,
      attemptCoverTs: reachedTs || prev.attemptCoverTs || null,
      reachedEnd,
      limitReached: null,
      fullFor: initDays,
      schema: OUT_SCHEMA,
      lastFullAt: now(),
      lastFullDays: initDays,
      initDays: null,
      targetTs: null,
    } : done);
    const latestSettings = await getSettings(account);
    if (latestSettings.fetchEnabled && latestSettings.outAutoSync) {
      await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: nextAutoAt });
    }
  } catch (e) {
    // 没料到的错误也要落到状态里，不然手动点了之后界面上什么都看不到
    await saveOut(account, { status: 'error', message: `读取时出错：${String(e?.message || e)}` });
  } finally {
    if (started) {
      await saveOut(account, { running: null }).catch(() => {});
      await refreshSnapshot(account).catch(() => {}); // 标签里的「我回他几次」跟着更新
      queueBridgePush();
    }
    releaseBusy();
  }
}

export async function syncOutNow({ account }) {
  if (!await enabledAccount(account)) return { error: '请先为此账号开启插件。' };
  if (!inActiveHours()) return { error: '读取只在每天 08:00–24:00 进行，夜间不运行。' };
  const cur = await kvGet(keys.cursor(account), {});
  const blockedUntil = Math.max(cur.rateUntil || 0, cur.out?.retryAt || 0);
  if (blockedUntil > now()) {
    return { error: `接口正在退避，请在 ${new Date(blockedUntil).toLocaleTimeString()} 后再试。` };
  }
  const { initDays } = await getSettings(account);
  const queued = await updateCursor(account, (cur) => {
    const out = cur.out || {};
    if (out.running && now() - out.running.at < 120_000) return;
    if (['queued', 'waiting_tab'].includes(out.status) || out.resume && out.status !== 'error') return;
    cur.out = { ...out, status: 'queued', message: null, manualTask: true, fullFor: 0, resume: null, initDays, targetTs: now() - initDays * DAY_MS };
    return true;
  });
  if (!queued) return { ok: true };
  syncOut(account, true).catch((e) => saveOut(account, { status: 'error', message: `读取时出错：${String(e?.message || e)}` }));
  return { ok: true };
}
