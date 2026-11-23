// 发帖排期同步与旁听事件处理：只在打开排期弹窗时按需只读同步，共用账号级退避与并发锁。
import { kvGet, kvSet, kvRemove, keys } from '../db.js';
import { record } from '../diagnostics.js';
import { parseScheduledTweets, ParseError } from '../x/parser.js';
import { PACE, now, serviceWait, isBusy, tryAcquireBusy, releaseBusy, updateCursor } from './runtime.js';
import { senderAccount } from './accounts.js';
import { fetchViaTab } from './transport.js';

export async function handleScheduledTap(msg, sender) {
  const { text } = msg;
  const account = await senderAccount(msg, sender);
  if (!account || typeof text !== 'string') return {};
  try {
    const items = parseScheduledTweets(JSON.parse(text));
    const syncedAt = now();
    await kvSet(keys.scheduled(account), { items, syncedAt, error: null });
    await record('scheduled_sync', { account, source: 'scheduled', mode: 'tap', outcome: 'ok', count: items.length, scheduledTimes: items.map(({ executeAt }) => executeAt) });
    return { ok: true, items, syncedAt };
  } catch (e) {
    await record('parse_failed', { account, source: 'scheduled', mode: 'tap', category: e instanceof ParseError ? 'unexpected_payload' : 'parser_exception' });
    return {};
  }
}

export async function handlePostEvent(msg, sender) {
  const { op, at } = msg;
  const account = await senderAccount(msg, sender);
  if (!account) return {};
  const ts = Number.isFinite(at) ? at : now();
  if (op === 'CreateScheduledTweet' || op === 'DeleteScheduledTweet') {
    const cached = await kvGet(keys.scheduled(account));
    if (cached) await kvSet(keys.scheduled(account), { ...cached, syncedAt: 0 }); // 下次打开排期弹窗立刻拉最新
  }
  return {};
}

export async function handleScheduledSync(msg, sender) {
  const { force } = msg;
  const account = await senderAccount(msg, sender);
  if (!account) return { items: [], syncedAt: 0, lastPostAt: 0, status: 'error', message: '未识别到当前 X 账号' };
  const cached = (await kvGet(keys.scheduled(account))) || { items: [], syncedAt: 0, error: null };
  const lastPostAt = (await kvGet(keys.lastPostAt(account))) || 0;
  const cachedReply = (message) => ({
    items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message,
  });
  if (isBusy()) return cachedReply('正在读取其他数据，已显示上次排期缓存');
  const cursor = await kvGet(keys.cursor(account), {});
  if (cursor.circuitBroken) return cachedReply('账号异常已熔断，已显示上次排期缓存');
  const pausedUntil = Math.max(cursor.rateUntil || 0, cursor.out?.retryAt || 0);
  if (pausedUntil > now()) return cachedReply('接口正在退避，已显示上次排期缓存');
  const tpl = await kvGet(keys.tplScheduled(account));
  if (!tpl) {
    await record('scheduled_sync', { account, source: 'scheduled', mode: force ? 'manual' : 'auto', outcome: 'need_tpl' });
    return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'need_tpl', message: '点一下下方「已排期帖子」完成首次同步' };
  }
  // 30 秒防抖：连续开关排期弹窗不重复发请求
  if (!force && cached.syncedAt && now() - cached.syncedAt < 30_000) {
    return { items: cached.items || [], syncedAt: cached.syncedAt, lastPostAt, status: 'ok' };
  }
  if ((cached.retryAt || 0) > now()) {
    return cachedReply(`接口正在退避，将在 ${new Date(cached.retryAt).toLocaleTimeString()} 后重试；已显示上次排期缓存`);
  }
  if (!tryAcquireBusy()) return cachedReply('正在读取其他数据，已显示上次排期缓存');
  let r;
  try {
    r = await fetchViaTab(account, { kind: 'scheduled', tpl: tpl.url }, { account, mode: force ? 'scheduled_manual' : 'scheduled_auto', run: now(), page: 1 });
  } finally {
    releaseBusy();
  }
  if (r.error === 'circuit_broken') return cachedReply('账号异常已熔断，已显示上次排期缓存');
  if (r.error === 'no_tab') return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: '未连接到 X 页面，已显示上次缓存' };
  if (r.error === 'outside_window') return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: '读取只在每天 08:00–24:00 进行，已显示上次缓存' };
  if (r.error === 'backoff') {
    return cachedReply(`接口正在退避，将在 ${new Date(r.rateResetAt || 0).toLocaleTimeString()} 后重试；已显示上次排期缓存`);
  }
  if (r.error === 'bad_tpl' || r.status === 400 || r.status === 404) {
    await kvRemove(keys.tplScheduled(account));
    await record('scheduled_sync', { account, source: 'scheduled', mode: force ? 'manual' : 'auto', outcome: 'tpl_expired', status: r.status || 0 });
    return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'need_tpl', message: '接口参数已更新，请点一下「已排期帖子」重新连接' };
  }
  if (r.status === 429) {
    const retryAt = r.backoffUntil || r.rateResetAt || now() + PACE.backoffStartMs;
    await updateCursor(account, (c) => {
      c.rateUntil = Math.max(c.rateUntil || 0, retryAt);
    });
    await kvSet(keys.scheduled(account), { ...cached, retryAt });
    return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: '暂时被 X 限流（429），已显示上次缓存' };
  }
  if (!r.ok) {
    const retryAt = now() + serviceWait(cached.errorCount || 0);
    await kvSet(keys.scheduled(account), { ...cached, retryAt, errorCount: (cached.errorCount || 0) + 1 });
    return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: `同步排期失败（${r.error || 'HTTP ' + r.status}），已显示缓存` };
  }
  try {
    const items = parseScheduledTweets(r.body);
    const syncedAt = now();
    await kvSet(keys.scheduled(account), { items, syncedAt, retryAt: null, errorCount: 0, error: null });
    await record('scheduled_sync', { account, source: 'scheduled', mode: force ? 'manual' : 'auto', outcome: 'ok', count: items.length, scheduledTimes: items.map(({ executeAt }) => executeAt) });
    return { items, syncedAt, lastPostAt, status: 'ok' };
  } catch (e) {
    await record('parse_failed', { account, source: 'scheduled', mode: force ? 'manual' : 'auto', category: e instanceof ParseError ? 'unexpected_payload' : 'parser_exception' });
    const why = e instanceof ParseError ? e.message : String(e);
    return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: `排期解析失败：${why}` };
  }
}
