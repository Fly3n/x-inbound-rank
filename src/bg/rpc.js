// 后台数据清理与消息路由表（内容脚本 xir:* 与弹窗 RPC）。
import { getEvents, clearEvents, pruneEvents, kvGet, kvSet, kvRemove, keys, getSettings, OUT } from '../db.js';
import { replyPlaces, repliesOf, cleanRules, DAY_MS, WINDOWS, INIT_WINDOWS, KEEP_DAYS } from '../rank.js';
import { record, readDiagnostics } from '../diagnostics.js';
import { queueBridgePush } from '../bridge.js';
import { mentionsEvidence } from '../x/mentions-diagnostics.js';
import {
  PACE, INC_ALARM, OUT_ALARM, alarmFor,
  now, inActiveHours, accountForUser, tryAcquireBusy, releaseBusy,
  serial, updateCursor, board, refreshSnapshot, clearSnapDirty,
} from './runtime.js';
import { clearAccountAlarms, recoverAlarms } from './alarms.js';
import { senderAccount, activePage, pingPages, hasVisiblePage, setAccountEnabled } from './accounts.js';
import { mentionsApi } from './transport.js';
import { startBackfill, pauseJob, resumeJob } from './backfill.js';
import { maybeIncremental, diagnoseMentions } from './incremental.js';
import { syncOut, syncOutNow } from './outbound.js';
import { handleScheduledTap, handlePostEvent, handleScheduledSync } from './scheduled.js';

export async function maybePrune(account) {
  const cur = await kvGet(keys.cursor(account), {});
  if (now() - (cur.lastPruneAt || 0) < DAY_MS) return; // 一天最多清一次
  const removed = (await pruneEvents(account, now() - KEEP_DAYS * DAY_MS)) + (await pruneEvents(account, now() - KEEP_DAYS * DAY_MS, OUT));
  await updateCursor(account, (c) => {
    c.lastPruneAt = now();
    if (removed) c.prunedAt = now(); // 清掉过到期的数据：之后弹窗不再挂红字提示，改成一行小字
  });
  if (removed) queueBridgePush();
}

export async function clearData(account) {
  if (!tryAcquireBusy()) return { error: '正在读取数据，请等这次读取结束再清空。' };
  try {
    await clearAccountAlarms(account);
    await clearEvents(account);
    clearSnapDirty(account);
    await serial(() => kvRemove([keys.cursor(account), keys.job(account), keys.snap(account), keys.alert(account), keys.scheduled(account), keys.lastPostAt(account)])); // 和改 cursor 的排同一个队
    queueBridgePush();
    return { ok: true };
  } finally {
    releaseBusy();
  }
}

export const handlers = {
  // 内容脚本
  async 'xir:hello'(msg, sender) {
    const account = await senderAccount(msg, sender);
    if (!account) return { account: null };
    if (/^[A-Za-z0-9_]{1,15}$/.test(msg.handle || '')) {
      await serial(async () => {
        const accounts = await kvGet(keys.accounts, {});
        if (accounts[account]?.enabled && accounts[account].handle !== msg.handle) {
          accounts[account].handle = msg.handle;
          await kvSet(keys.accounts, accounts);
        }
      });
    }
    await refreshSnapshot(account);
    queueBridgePush();
    await recoverAlarms(account);
    return { account };
  },
  async 'xir:tpl'(msg, sender) {
    const account = await senderAccount(msg, sender);
    const { url, kind } = msg;
    if (!account || typeof url !== 'string' || url.length > 30000) return {};
    const template = kind === 'mentions' ? keys.tplMentions : kind === 'scheduled' ? keys.tplScheduled : keys.tpl;
    await kvSet(template(account), { url, at: now() });
    if (template === keys.tpl) {
      const out = (await kvGet(keys.cursor(account), {})).out;
      if (out?.status === 'need_tpl' && !out.limitReached) {
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: now() + 3000 });
      }
    }
    return {};
  },
  async 'xir:mentions:evidence'(msg, sender) {
    const { url, status, metadata, text } = msg;
    const account = await senderAccount(msg, sender);
    if (!account || typeof text !== 'string' || text.length > 8_000_000) return {};
    let body;
    try { body = JSON.parse(text); } catch { /* 保留请求与 HTTP 信息 */ }
    const evidence = await mentionsEvidence(url, body, metadata).catch(() => null);
    if (evidence?.request.timeline === 'Mentions') {
      await record('web_mentions_response', {
        account, source: 'mentions-graphql', tabId: sender.tab.id,
        status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0, evidence,
      });
    }
    return {};
  },
  'xir:scheduled:tap': handleScheduledTap,
  'xir:postEvent': handlePostEvent,
  'xir:scheduled:sync': handleScheduledSync,
  // 通知列表里的回复是在谁的帖子下：页面数据看不出来的，内容脚本拿帖子 ID 来问本机数据
  async 'xir:where'(msg, sender) {
    const { ids } = msg;
    const account = await senderAccount(msg, sender);
    if (!account || !Array.isArray(ids)) return { places: {} };
    return { places: replyPlaces(await getEvents(account), await getEvents(account, OUT), ids.slice(0, 200).map(String)) };
  },
  async 'xir:dom'(msg, sender) {
    const account = await senderAccount(msg, sender);
    if (!account) return {};
    if (msg.broken) await kvSet(keys.domWarning(account), { at: now() });
    else await kvRemove(keys.domWarning(account));
    return {};
  },

  // 弹窗
  getDiagnostics: async ({ account }) => (await readDiagnostics()).filter((event) => event.account === account).map(({ account: _, ...event }) => event),
  diagnoseMentions,
  async updateNowWithReceipt({ account }) {
    const startedAt = now();
    if (!account) return { error: '请先选择已登录的 X 账号。' };
    if (!inActiveHours()) return { error: '读取只在每天 08:00–24:00 进行，夜间不运行。' };
    if (!(await hasVisiblePage(account))) return { error: '请切到该账号的 X 页面后再更新。' };
    const beforeManual = await kvGet(keys.cursor(account), {});
    const wait = PACE.manualCooldownMs - (now() - (beforeManual.lastManualAt || 0));
    if (wait > 0) return { error: `刚刚更新过，请 ${Math.ceil(wait / 60_000)} 分钟后再试。` };
    const result = await maybeIncremental(account, true);
    if (result === false) return { error: '读取暂不可用，请确认已有登录的 X 页面并稍后再试。' };
    if (!result?.ok && !result?.deferred) return result;
    const inboundMessage = result?.deferred ? result.message : '';

    const before = (await kvGet(keys.cursor(account), {})).out;
    if (!before?.lastAt && !before?.syncedId) {
      return { message: `${inboundMessage ? `${inboundMessage}；` : ''}请先初始化「我回别人」。` };
    }
    await syncOut(account, true);
    const after = (await kvGet(keys.cursor(account), {})).out;
    if (after?.message) return { message: `${inboundMessage ? `${inboundMessage}；` : ''}我回别人：${after.message}` };
    if (after?.resume) return { message: `${inboundMessage ? `${inboundMessage}；` : ''}我回别人还有数据等待续读。` };
    if (inboundMessage) return { message: `${inboundMessage}我回别人已更新。` };
    if (after?.lastReadAt >= startedAt) {
      const { inLastReadAt } = await kvGet(keys.cursor(account), {});
      if (inLastReadAt >= startedAt) return { ok: true, readAt: { inbound: inLastReadAt, outbound: after.lastReadAt } };
    }
    return { message: `${inboundMessage ? `${inboundMessage}；` : ''}我回别人暂未读取，请查看数据状态。` };
  },
  setAccountEnabled,
  async getState() {
    const registry = await kvGet(keys.accounts, {});
    const accounts = Object.fromEntries(Object.entries(registry).filter(([, a]) => a.enabled));
    const [page, pages] = await Promise.all([activePage(), pingPages()]);
    const activeKey = accountForUser(accounts, page?.userId);
    const active = page?.userId ? { userId: page.userId, handle: page.handle, account: activeKey } : null;
    const online = [...new Set(pages.map((p) => accountForUser(accounts, p.userId)).filter(Boolean))];
    return { accounts, active, online };
  },
  async getAccountState({ account }) {
    // 本机两份数据各有多少条、从哪天到哪天
    const span = (rows) => rows.reduce((d, e) => ({ count: d.count + 1, from: Math.min(d.from ?? e.created_at, e.created_at), to: Math.max(d.to ?? e.created_at, e.created_at) }), { count: 0, from: null, to: null });
    const db = { in: span(await getEvents(account)), out: span((await getEvents(account, OUT)).filter((o) => !o.own)) }; // own：我在自己帖子下的回复，只用来认对话，不算这份数据
    return {
      settings: await getSettings(account),
      cursor: await kvGet(keys.cursor(account), {}),
      job: await kvGet(keys.job(account)),
      alert: await kvGet(keys.alert(account)),
      db,
      domWarning: await kvGet(keys.domWarning(account)),
      tplAt: (await kvGet(keys.tpl(account)))?.at || null, // 什么时候看到过 X 读「回复」列表的请求；没看到过就读不了「我回别人」
      mentionsApi: await mentionsApi(account), // 别人回我现在用哪个接口：'gql' 新 / 'rest' 旧
    };
  },
  async getBoard({ account }) {
    return board(account); // { rows, people, replies }
  },
  exportAll: async ({ account }) => ({ inbound: await getEvents(account), out: await getEvents(account, OUT) }),
  getReplies: async ({ account, actorId }) => repliesOf(await getEvents(account), actorId, await getSettings(account), now(), 50, await getEvents(account, OUT)),
  startBackfill: ({ account }) => startBackfill(account),
  syncOutNow,
  pauseJob: async ({ account }) => (await pauseJob(account), { ok: true }),
  resumeJob: ({ account }) => resumeJob(account),
  async setSettings({ account, patch }) {
    if ('windowDays' in patch && !WINDOWS.includes(patch.windowDays)) return { error: '榜单范围只能是 7 天、15 天、30 天、2 个月或 3 个月' };
    if ('initDays' in patch && !INIT_WINDOWS.includes(patch.initDays)) return { error: '初始化范围只能是 7 天、15 天或 30 天' };
    const merged = { ...(await getSettings(account)), ...patch };
    const next = { fetchEnabled: merged.fetchEnabled !== false, ...cleanRules(merged) }; // 其余越界的值夹回范围
    await kvSet(keys.settings(account), next);
    if (!next.fetchEnabled) {
      // 开关只停日常自动读取；正在跑的手动初始化和立即更新仍可续完。
      const cur = await kvGet(keys.cursor(account), {});
      if (!cur.incResume?.manual) await chrome.alarms.clear(alarmFor(INC_ALARM, account));
      const out = cur.out;
      const outPending = !!out?.resume || ['need_tpl', 'queued', 'waiting_tab', 'reading'].includes(out?.status);
      if (!outPending) await chrome.alarms.clear(alarmFor(OUT_ALARM, account));
    }
    else if ('fetchEnabled' in patch) await recoverAlarms(account);
    await refreshSnapshot(account); // 口径或颜色变了，标签立刻跟着变
    queueBridgePush();
    return { ok: true };
  },
  clearData: ({ account }) => clearData(account),
};
