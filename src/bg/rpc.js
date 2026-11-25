// 后台数据清理与消息路由表（内容脚本 xir:* 与弹窗 RPC）。
import { getEvents, clearEvents, pruneEvents, kvGet, kvSet, kvRemove, keys, getSettings, OUT } from '../db.js';
import { replyPlaces, repliesOf, cleanRules, DAY_MS, WINDOWS, INIT_WINDOWS, KEEP_DAYS } from '../rank.js';
import { record } from '../diagnostics.js';
import { queueBridgePush } from '../bridge.js';
import { mentionsEvidence } from '../x/mentions-diagnostics.js';
import {
  PACE, JOB_ALARM, INC_ALARM, OUT_ALARM, alarmFor,
  now, inActiveHours, accountForUser, tryAcquireBusy, releaseBusy,
  serial, updateCursor, board, refreshSnapshot, clearSnapDirty,
} from './runtime.js';
import { clearAccountAlarms, recoverAlarms } from './alarms.js';
import { senderAccount, activePage, pingPages, hasVisiblePage, setAccountEnabled, refreshActiveStaleTab } from './accounts.js';
import { mentionsApi } from './transport.js';
import { startBackfill, pauseJob, resumeJob } from './backfill.js';
import { maybeIncremental, handleInboundTap } from './incremental.js';
import { handleOutboundTap, handleRepliesTap, syncOut, syncOutNow } from './outbound.js';
import { handleScheduledTap, handlePostEvent } from './scheduled.js';

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
    const template = kind === 'mentions' ? keys.tplMentions : keys.tpl;
    await kvSet(template(account), { url, at: now() });
    if (template === keys.tpl) {
      const out = (await kvGet(keys.cursor(account), {})).out;
      if (out?.manualTask && out.status === 'need_tpl' && !out.limitReached) {
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: now() + 3000 });
      }
    } else if (template === keys.tplMentions) {
      const cur = await kvGet(keys.cursor(account), {});
      if (!cur.circuitBroken) {
        const alert = await kvGet(keys.alert(account));
        if (alert?.message?.includes('通知')) await kvRemove(keys.alert(account));
        const job = await kvGet(keys.job(account));
        if (job?.needTpl && job.status === 'error') {
          await kvSet(keys.job(account), { ...job, status: 'running', needTpl: false, message: '' });
          await chrome.alarms.create(alarmFor(JOB_ALARM, account), { when: now() + 3000 });
        }
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
      queueBridgePush();
    }
    return {};
  },
  'xir:inbound:tap': handleInboundTap,
  'xir:replies:tap': handleRepliesTap,
  'xir:outbound:tap': handleOutboundTap,
  async 'xir:active'(msg, sender) {
    const account = await senderAccount(msg, sender);
    if (!account) return {};
    return { ok: true };
  },
  'xir:scheduled:tap': handleScheduledTap,
  'xir:postEvent': handlePostEvent,
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

  // 弹窗：别人回我手动补读（≤24 小时走轻量节奏，>24 小时走慢速回填节奏；半开试探仅在请求成功后解除熔断）
  async manualFetchIn({ account, hours }) {
    const h = Math.round(Number(hours));
    if (!Number.isInteger(h) || h < 1 || h > 15 * 24) return { error: '补读时长仅支持 1–24 小时或 1–15 天。' };
    if (h <= 24) return handlers.updateNowWithReceipt({ account, hours: h });
    if (!(await hasVisiblePage(account))) return { error: '请切到该账号的 X 页面后再补读。' };
    return startBackfill(account, { hours: h });
  },
  // 弹窗：我回别人手动补读（支持自定义小时/天 + 智能早停；半开试探仅在请求成功后解除熔断）
  async manualFetchOut({ account, hours }) {
    const h = Math.round(Number(hours));
    if (!Number.isInteger(h) || h < 1 || h > 15 * 24) return { error: '补读时长仅支持 1–24 小时或 1–15 天。' };
    if (!(await hasVisiblePage(account))) return { error: '请切到该账号的 X 页面后再补读。' };
    return syncOutNow({ account, hours: h });
  },

  // 弹窗：别人回我独立立即更新
  async updateNowWithReceipt({ account, hours }) {
    const startedAt = now();
    if (!account) return { error: '请先选择已登录的 X 账号。' };
    if (!inActiveHours()) return { error: '读取只在每天 08:00–24:00 进行，夜间不运行。' };
    if (!(await hasVisiblePage(account))) return { error: '请切到该账号的 X 页面后再更新。' };
    const beforeManual = await kvGet(keys.cursor(account), {});
    const wait = PACE.manualCooldownMs - (now() - (beforeManual.lastManualAt || 0));
    if (wait > 0) return { error: `刚刚更新过，请 ${Math.ceil(wait / 60_000)} 分钟后再试。` };
    const result = await maybeIncremental(account, true, hours ? { hours } : {});
    if (result === false) return { error: '读取暂不可用，请确认已有登录的 X 页面并稍后再试。' };
    if (!result?.ok && !result?.deferred) return result;
    if (result?.deferred) return { message: result.message };
    const { inLastReadAt } = await kvGet(keys.cursor(account), {});
    if (inLastReadAt >= startedAt) return { ok: true, readAt: { inbound: inLastReadAt } };
    return { message: '别人回我暂未读取，请查看数据状态。' };
  },
  // 弹窗：我回别人独立立即更新
  async updateOutNowWithReceipt({ account }) {
    const startedAt = now();
    if (!account) return { error: '请先选择已登录的 X 账号。' };
    if (!inActiveHours()) return { error: '读取只在每天 08:00–24:00 进行，夜间不运行。' };
    if (!(await hasVisiblePage(account))) return { error: '请切到该账号的 X 页面后再更新。' };
    const beforeManual = await kvGet(keys.cursor(account), {});
    const wait = PACE.manualCooldownMs - (now() - (beforeManual.out?.lastManualAt || 0));
    if (wait > 0) return { error: `刚刚更新过，请 ${Math.ceil(wait / 60_000)} 分钟后再试。` };
    const blockedUntil = Math.max(beforeManual.rateUntil || 0, beforeManual.out?.retryAt || 0);
    if (blockedUntil > now()) {
      return { error: `接口正在退避，请在 ${new Date(blockedUntil).toLocaleTimeString()} 后再试。` };
    }
    await syncOut(account, true);
    const after = (await kvGet(keys.cursor(account), {})).out;
    if (after?.status === 'need_tpl') return { message: after.message };
    if (after?.message) return { message: after.message };
    if (after?.resume) return { message: '我回别人已读取本批，剩余数据等待续读。' };
    if (after?.lastReadAt >= startedAt) return { ok: true, readAt: { outbound: after.lastReadAt } };
    return { message: '正在进行另一项读取或暂未读取，请稍后再试。' };
  },
  setAccountEnabled,
  async getState() {
    const registry = await kvGet(keys.accounts, {});
    const accounts = Object.fromEntries(Object.entries(registry).filter(([, a]) => a.enabled));
    const [page, pages] = await Promise.all([activePage(), pingPages()]);
    const activeKey = accountForUser(accounts, page?.userId);
    const active = page?.userId ? { userId: page.userId, handle: page.handle, account: activeKey } : null;
    const online = [...new Set(pages.map((p) => accountForUser(accounts, p.userId)).filter(Boolean))];
    if (!active || !online.length) refreshActiveStaleTab().catch(() => {});
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
  syncOutNow: ({ account }) => syncOutNow({ account }),
  pauseJob: async ({ account }) => (await pauseJob(account), { ok: true }),
  resumeJob: ({ account }) => resumeJob(account),
  async setSettings({ account, patch }) {
    if ('windowDays' in patch && !WINDOWS.includes(patch.windowDays)) return { error: '榜单范围只能是 7 天、15 天、30 天、2 个月或 3 个月' };
    if ('initDays' in patch && !INIT_WINDOWS.includes(patch.initDays)) return { error: '补历史范围只能是 7 天或 15 天' };
    const merged = { ...(await getSettings(account)), ...patch };
    const next = cleanRules(merged); // 其余越界的值夹回范围
    await kvSet(keys.settings(account), next);
    await refreshSnapshot(account); // 口径或颜色变了，标签立刻跟着变
    queueBridgePush();
    return { ok: true };
  },
  clearData: ({ account }) => clearData(account),
};
