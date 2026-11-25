// 后台 Service Worker 入口：装配各领域模块并集中注册 Chrome 事件监听。
import { kvGet, keys } from './db.js';
import { record, readDiagnostics } from './diagnostics.js';
import { queueBridgePush } from './bridge.js';
import {
  TICK_ALARM, STALE_TABS_ALARM, JOB_ALARM, INC_ALARM, OUT_ALARM,
  enabledAccounts, enabledAccount, refreshSnapshot,
} from './bg/runtime.js';
import { recoverAlarms } from './bg/alarms.js';
import { migrateAccounts, pingPages, refreshStaleTabs, refreshActiveStaleTab } from './bg/accounts.js';
import { wakeJob } from './bg/backfill.js';
import { maybeIncremental } from './bg/incremental.js';
import { syncOut } from './bg/outbound.js';
import { maybePrune, handlers } from './bg/rpc.js';

async function ensureTick() {
  await migrateAccounts();
  if (!(await chrome.alarms.get(TICK_ALARM))) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 30 });
  await Promise.all([
    refreshStaleTabs({ retry: true }),
    ...(await enabledAccounts()).map(([account]) => recoverAlarms(account)),
  ]);
  queueBridgePush();
}

chrome.tabs?.onActivated?.addListener?.(refreshActiveStaleTab);
chrome.tabs?.onUpdated?.addListener?.((_tabId, changeInfo) => {
  if (changeInfo?.status === 'complete' || changeInfo?.url) return refreshActiveStaleTab();
});
chrome.windows?.onFocusChanged?.addListener?.((windowId) => {
  if (windowId !== chrome.windows?.WINDOW_ID_NONE) return refreshActiveStaleTab();
});

chrome.runtime.onInstalled.addListener(ensureTick);
chrome.runtime.onStartup.addListener(ensureTick);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await migrateAccounts();
  if (alarm.name === STALE_TABS_ALARM) return refreshStaleTabs({ retry: true });
  if (alarm.name === TICK_ALARM) {
    await readDiagnostics().catch(() => {});
    await Promise.all((await enabledAccounts()).map(async ([account]) => {
      await maybePrune(account);
      await refreshSnapshot(account);
      await recoverAlarms(account);
    }));
    queueBridgePush();
    return;
  }
  const [kind, account] = alarm.name.split(':');
  if (!await enabledAccount(account)) return;
  if (kind === JOB_ALARM) {
    const job = await kvGet(keys.job(account));
    const waiting = job?.status === 'waiting_tab';
    if (waiting) {
      const me = (await kvGet(keys.accounts, {}))[account];
      if (!(await pingPages()).some((page) => page.userId === me.userId)) return;
    }
    return wakeJob(account, waiting);
  }
  if (kind === INC_ALARM) return maybeIncremental(account);
  if (kind === OUT_ALARM) return syncOut(account);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return false;
  const logged = ['startBackfill', 'syncOutNow', 'manualFetchIn', 'manualFetchOut', 'pauseJob', 'resumeJob', 'clearData', 'updateNowWithReceipt', 'updateOutNowWithReceipt'].includes(msg.type);
  Promise.resolve().then(async () => {
    await migrateAccounts();
    if (msg.type.startsWith('xir:')) return h(msg, _sender);
    if (_sender.tab) return { error: '请从插件弹窗操作。' };
    if (msg.account && msg.type !== 'setAccountEnabled' && !await enabledAccount(msg.account)) return { error: '此账号尚未开启插件。' };
    return h(msg, _sender);
  }).then(async (result) => {
    if (logged) await record(msg.type, { account: msg.account, outcome: result?.error ? 'rejected' : 'accepted' });
    sendResponse(result);
  }, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
