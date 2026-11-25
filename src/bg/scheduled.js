// 发帖排期纯旁听与本地增量维护：零主动请求；通过旁听 FetchScheduledTweets 全量校准、
// CreateScheduledTweet / DeleteScheduledTweet 增量维护，并保留最近 24 小时已到点发出的排期作为上一条参考。
import { kvGet, kvSet, keys } from '../db.js';
import { record } from '../diagnostics.js';
import { queueBridgePush } from '../bridge.js';
import { parseScheduledTweets, parseScheduledCreate, parseScheduledDelete, ParseError } from '../x/parser.js';
import { now, serial } from './runtime.js';
import { senderAccount } from './accounts.js';

const RECENT_SENT_WINDOW_MS = 24 * 3_600_000;

function validEntry(x) {
  return x && typeof x === 'object' && Number.isFinite(x.executeAt) && x.executeAt > 0;
}

function dedupeSort(list) {
  const byKey = new Map();
  for (const item of list) {
    if (!validEntry(item)) continue;
    const id = String(item.id ?? item.executeAt);
    const prev = byKey.get(id);
    if (!prev || (!prev.text && item.text)) {
      byKey.set(id, { id, executeAt: item.executeAt, text: item.text || '' });
    }
  }
  return [...byKey.values()].sort((a, b) => a.executeAt - b.executeAt);
}

/**
 * 归档已到点的旧排期并清理 24 小时以外的历史。
 * - full = true（来自 FetchScheduledTweets 全量校准）：用 nextItems 替换未来待发列表，
 *   但旧列表里已经到点（executeAt <= nowTs）的条目保留进 recentSent，不被覆盖抹除；
 * - full = false（仅做时间流转整理）：把 items 里已到点的条目移入 recentSent。
 */
export function reconcileScheduled(prev, nextItems, nowTs, { full = false } = {}) {
  const prevItems = Array.isArray(prev?.items) ? prev.items.filter(validEntry) : [];
  const prevSent = Array.isArray(prev?.recentSent) ? prev.recentSent.filter(validEntry) : [];
  const cutoff = nowTs - RECENT_SENT_WINDOW_MS;

  const sentPool = prevSent.filter((x) => x.executeAt <= nowTs && x.executeAt >= cutoff);
  for (const x of prevItems) {
    if (x.executeAt <= nowTs && x.executeAt >= cutoff) sentPool.push(x);
  }

  const futurePool = [];
  const source = full ? (Array.isArray(nextItems) ? nextItems : []) : prevItems;
  for (const x of source) {
    if (!validEntry(x)) continue;
    if (x.executeAt <= nowTs) {
      if (x.executeAt >= cutoff) sentPool.push(x);
    } else {
      futurePool.push(x);
    }
  }

  return {
    items: dedupeSort(futurePool),
    recentSent: dedupeSort(sentPool),
  };
}

export async function handleScheduledTap(msg, sender) {
  const { text } = msg;
  const account = await senderAccount(msg, sender);
  if (!account || typeof text !== 'string') return {};
  let parsed;
  try {
    parsed = parseScheduledTweets(JSON.parse(text));
  } catch (e) {
    await record('parse_failed', {
      account,
      source: 'scheduled',
      mode: 'tap',
      category: e instanceof ParseError ? 'unexpected_payload' : 'parser_exception',
    });
    queueBridgePush();
    return {};
  }
  const ts = now();
  const next = await serial(async () => {
    const prev = await kvGet(keys.scheduled(account), {});
    const reconciled = reconcileScheduled(prev, parsed, ts, { full: true });
    const value = { ...reconciled, syncedAt: ts };
    await kvSet(keys.scheduled(account), value);
    return value;
  });
  await record('scheduled_sync', {
    account,
    source: 'scheduled',
    mode: 'tap',
    outcome: 'ok',
    count: next.items.length,
    recentSentCount: next.recentSent.length,
    scheduledTimes: next.items.map(({ executeAt }) => executeAt),
  });
  queueBridgePush();
  return { ok: true, items: next.items, recentSent: next.recentSent, syncedAt: ts };
}

export async function handlePostEvent(msg, sender) {
  const { op, req, res } = msg;
  const account = await senderAccount(msg, sender);
  if (!account || (op !== 'CreateScheduledTweet' && op !== 'DeleteScheduledTweet')) return {};
  const ts = now();

  if (op === 'CreateScheduledTweet') {
    const parsed = parseScheduledCreate(req, res);
    if (!parsed.item) {
      await record('scheduled_event', {
        account,
        source: 'scheduled',
        op,
        outcome: 'unmatched',
        reason: parsed.reason,
        reqKeys: parsed.diag.reqKeys,
        resKeys: parsed.diag.resKeys,
      });
      queueBridgePush();
      return { ok: false, reason: parsed.reason };
    }
    const next = await serial(async () => {
      const prev = await kvGet(keys.scheduled(account), {});
      const base = reconcileScheduled(prev, null, ts, { full: false });
      const items = dedupeSort([...base.items, parsed.item]).filter((x) => x.executeAt > ts);
      const recentSent = parsed.item.executeAt <= ts
        ? dedupeSort([...base.recentSent, parsed.item])
        : base.recentSent;
      const value = { items, recentSent, syncedAt: ts };
      await kvSet(keys.scheduled(account), value);
      return value;
    });
    await record('scheduled_event', {
      account,
      source: 'scheduled',
      op,
      outcome: 'ok',
      executeAt: parsed.item.executeAt,
      count: next.items.length,
      reqKeys: parsed.diag.reqKeys,
      resKeys: parsed.diag.resKeys,
    });
    queueBridgePush();
    return { ok: true, item: parsed.item, count: next.items.length };
  }

  const parsed = parseScheduledDelete(req, res);
  if (!parsed.id) {
    await record('scheduled_event', {
      account,
      source: 'scheduled',
      op,
      outcome: 'unmatched',
      reason: parsed.reason,
      reqKeys: parsed.diag.reqKeys,
      resKeys: parsed.diag.resKeys,
    });
    queueBridgePush();
    return { ok: false, reason: parsed.reason };
  }
  const result = await serial(async () => {
    const prev = await kvGet(keys.scheduled(account), {});
    const base = reconcileScheduled(prev, null, ts, { full: false });
    const items = base.items.filter((x) => x.id !== parsed.id);
    const recentSent = base.recentSent.filter((x) => x.id !== parsed.id);
    const removed = (base.items.length - items.length) + (base.recentSent.length - recentSent.length);
    const value = { items, recentSent, syncedAt: prev?.syncedAt || ts };
    await kvSet(keys.scheduled(account), value);
    return { value, removed };
  });
  await record('scheduled_event', {
    account,
    source: 'scheduled',
    op,
    outcome: 'ok',
    removed: result.removed,
    count: result.value.items.length,
    reqKeys: parsed.diag.reqKeys,
    resKeys: parsed.diag.resKeys,
  });
  queueBridgePush();
  return { ok: true, removed: result.removed, count: result.value.items.length };
}
