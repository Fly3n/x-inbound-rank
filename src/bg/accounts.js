// 账号管理、升级迁移、页面会话校验与扩展更新后的旧内容脚本刷新。
import { kvGet, kvSet, kvRemove, keys } from '../db.js';
import { record } from '../diagnostics.js';
import { queueBridgePush } from '../bridge.js';
import {
  PACE, serial, now, inActiveHours, nextActiveAt, accountForUser, refreshSnapshot,
  STALE_TABS_ALARM, JOB_ALARM, INC_ALARM, OUT_ALARM, X_TABS, STALE_TABS_RETRY,
} from './runtime.js';
import { clearAccountAlarms, recoverAlarms } from './alarms.js';

let migration;
export function migrateAccounts() {
  return migration ??= serial(async () => {
    if (await kvGet('accountIsolationV1')) return;
    const accounts = await kvGet(keys.accounts, {});
    const data = await chrome.storage.local.get(null);
    const frequencies = new Map();
    for (const { userId } of Object.values(accounts)) {
      if (userId) frequencies.set(userId, (frequencies.get(userId) || 0) + 1);
    }
    const next = {};
    for (const [key, account] of Object.entries(accounts)) {
      const verified = /^\d+$/.test(account.userId || '') && frequencies.get(account.userId) === 1;
      const cur = data[keys.cursor(key)];
      const enabled = verified && !!(cur?.syncedId || cur?.lastBackfill || cur?.out?.lastAt || cur?.out?.syncedId ||
        cur?.out?.fullFor === 0 || data[keys.job(key)]?.startedAt);
      next[key] = { ...account, enabled, activation: enabled ? now() : null };
      if (enabled) {
        // 旧回复模板只提供接口参数，实际用户 ID 在发请求时会替换。旧档期缓存无法确认来源，重新同步。
        if (data.current === key && data['tpl:replies'] && !data[keys.tpl(key)]) {
          await kvSet(keys.tpl(key), data['tpl:replies']);
        }
      }
      await kvRemove([keys.scheduled(key), keys.lastPostAt(key)]);
    }
    await chrome.storage.local.set({ [keys.accounts]: next, accountIsolationV1: true });
    await kvRemove(['current', 'pendingUserId', 'activeJobAccount', 'tpl:replies', 'tpl:mentions', 'tpl:scheduled', 'domWarning']);
    await Promise.all([JOB_ALARM, INC_ALARM, OUT_ALARM].map((kind) => chrome.alarms.clear(kind)));
  }).catch((e) => {
    migration = null;
    throw e;
  });
}

export async function probeTab(tab) {
  try {
    const page = await chrome.tabs.sendMessage(tab.id, { type: 'xir:ping' });
    if (page?.ok) return page;
  } catch {
    // 页面关闭、休眠或还没加载这版插件。
  }
  return null;
}

export const pingTab = async (tab) => {
  const page = await probeTab(tab);
  return page?.version === chrome.runtime.getManifest().version ? page : null;
};

/**
 * 扩展重载/更新后，已打开页面里的旧内容脚本不会自己换新。
 * 只刷新当前前台、连不上或版本对不上的 X 常规页面；正常页面、后台页和通知页都不主动刷新。
 */
const isXTabUrl = (url) => /^https:\/\/(?:x|twitter)\.com\//.test(url || '');
const isRefreshableXTabUrl = (url) =>
  isXTabUrl(url) && !/^https:\/\/(?:x|twitter)\.com\/(?:i\/)?notifications(?:[/?#]|$)/.test(url);

export async function reloadStaleXirTabs() {
  if (!chrome.tabs?.query || !chrome.tabs?.get || !chrome.tabs?.reload) return { reloaded: 0, pending: 0 };
  if (!inActiveHours()) {
    await chrome.alarms.create(STALE_TABS_ALARM, { when: nextActiveAt() });
    return { reloaded: 0, pending: 0 };
  }
  // 处理各窗口正在前台的 X 页面（覆盖多窗口并排开 X 且跨窗口点击切换的场景）；
  // 后台标签页不强刷（切过去时由 tabs.onActivated 补上），通知页绝不自动刷新，避免代改未读状态。
  const tabs = await chrome.tabs.query({ ...X_TABS, active: true }).catch(() => []);
  let reloaded = 0;
  let pending = 0;
  for (const tab of tabs) {
    if (!tab?.id || tab.discarded) continue;
    if (!isRefreshableXTabUrl(tab.url)) continue;
    if (tab.status === 'loading') {
      pending++;
      continue;
    }
    const page = await probeTab(tab);
    if (page?.visible === false) continue;
    if (page?.version === chrome.runtime.getManifest().version) continue;
    // 失败可能刚好碰上页面开始导航。刷新前再查一次，避免打断已经换到新文档的页面。
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current || current.discarded || !isRefreshableXTabUrl(current.url)) continue;
    if (current.status === 'loading') {
      pending++;
      continue;
    }
    const currentPage = await probeTab(current);
    if (currentPage?.visible === false) continue;
    if (currentPage?.version === chrome.runtime.getManifest().version) continue;
    try {
      await chrome.tabs.reload(tab.id);
      reloaded++;
    } catch {
      pending++; // 标签页可能刚关闭或暂时拒绝刷新；留下一次补查。
    }
  }
  const queried = tabs.length;
  if (reloaded || pending) {
    await record('stale_tab_refresh', { queried, reloaded, pending });
    queueBridgePush();
  }
  return { reloaded, pending };
}

let tabRefresh = null;
let tabRefreshQueued = false;
let tabRefreshRetry = false;
export function refreshStaleTabs({ retry = false } = {}) {
  if (tabRefresh) {
    tabRefreshQueued = true;
    tabRefreshRetry = tabRefreshRetry || retry;
    return tabRefresh;
  }
  tabRefresh = reloadStaleXirTabs()
    .then(async (result) => {
      if (!result.pending) {
        await chrome.storage.session?.remove?.(STALE_TABS_RETRY);
      } else if (retry) {
        const saved = await chrome.storage.session?.get?.(STALE_TABS_RETRY);
        const attempts = Number(saved?.[STALE_TABS_RETRY]) || 0;
        if (attempts < 2) {
          await chrome.storage.session?.set?.({ [STALE_TABS_RETRY]: attempts + 1 });
          await chrome.alarms.create(STALE_TABS_ALARM, { when: now() + 30_000 });
        }
      }
      return result;
    })
    .catch(() => ({ reloaded: 0, pending: 0 }))
    .finally(async () => {
      tabRefresh = null;
      if (tabRefreshQueued) {
        const queuedRetry = tabRefreshRetry;
        tabRefreshQueued = false;
        tabRefreshRetry = false;
        await refreshStaleTabs({ retry: queuedRetry });
      }
    });
  return tabRefresh;
}

export const refreshActiveStaleTab = () => refreshStaleTabs({ retry: true });

export async function senderAccount(msg, sender) {
  if (!Number.isInteger(sender?.tab?.id) || (sender.frameId ?? 0) !== 0 ||
      !/^https:\/\/(?:x|twitter)\.com\//.test(sender.url || sender.tab.url || '')) return null;
  const page = await pingTab(sender.tab);
  if (!msg.userId || msg.userId !== page?.userId) return null;
  const accounts = await kvGet(keys.accounts, {});
  const account = accountForUser(accounts, page.userId);
  return accounts[account]?.enabled && accounts[account].activation === msg.activation ? account : null;
}

export async function activePage() {
  const [tab] = await chrome.tabs.query({ ...X_TABS, active: true, currentWindow: true });
  return tab ? pingTab(tab) : null;
}

export async function pingPages() {
  const tabs = await chrome.tabs.query(X_TABS);
  return (await Promise.all(tabs.map(pingTab))).filter(Boolean);
}

/** 只有正在前台显示的已登录 X 页面才接受读取；隐藏标签页不发请求。 */
export async function hasVisiblePage(account) {
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me?.enabled || !me.userId) return false;
  return (await pingPages()).some((page) => page.userId === me.userId && page.visible !== false);
}

/** 自动更新除前台可见外，还要求该页面最近几分钟内有真实浏览交互，避免白天亮屏挂机空发请求。 */
export async function hasActivePage(account, maxIdleMs = PACE.activeInteractionMs) {
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me?.enabled || !me.userId) return false;
  const t = now();
  return (await pingPages()).some((page) =>
    page.userId === me.userId
    && page.visible !== false
    && Number.isFinite(page.lastActiveAt)
    && t - page.lastActiveAt <= maxIdleMs);
}

export async function setAccountEnabled({ userId, account, enabled }) {
  const page = enabled ? await activePage() : null;
  if (enabled && (!/^\d+$/.test(userId || '') || page?.userId !== userId)) return { error: '请在要开启的 X 账号页面重试。' };
  const updated = await serial(async () => {
    const accounts = await kvGet(keys.accounts, {});
    const existing = enabled ? accountForUser(accounts, userId) : account;
    // uid- 不可能出现在旧版使用的 @用户名键里。
    const key = existing || (enabled ? `uid-${userId}` : null);
    const previous = accounts[key];
    if (!key || (!enabled && !previous?.enabled)) return null;
    const handle = /^[A-Za-z0-9_]{1,15}$/.test(page?.handle || '') ? page.handle : previous?.handle || null;
    if (previous?.enabled === enabled) return key;
    accounts[key] = { ...previous, userId: enabled ? userId : previous.userId, handle, enabled,
      activation: Math.max(now(), (previous?.activation || 0) + 1) };
    await kvSet(keys.accounts, accounts);
    if (!enabled) await clearAccountAlarms(key);
    return key;
  });
  if (!updated) return { error: '找不到要关闭的账号。' };
  if (enabled) {
    await refreshSnapshot(updated);
    queueBridgePush();
    await recoverAlarms(updated);
  }
  return { ok: true, account: updated };
}
