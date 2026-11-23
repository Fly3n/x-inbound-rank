import test from 'node:test';
import assert from 'node:assert/strict';
import { readDiagnostics } from '../src/diagnostics.js';
import { createBgEnv } from './helpers/bg-env.mjs';

const env = await createBgEnv();
const { store, sessionStore, alarms, server, sessions, tabUrls, staleTabs, loadingTabs, hiddenTabs, reloadCalls, listeners, feed, send, pageSend, fire, until } = env;

test.after(() => env.restore());

test('多账号启用、定时更新、排期与切号隔离', { timeout: 10_000 }, async () => {
  sessions.set(9, { userId: '9', handle: 'New' });
  env.setActiveTab(9);
  assert.deepEqual((await send({ type: 'getState' })).active, { userId: '9', handle: 'New', account: null });
  assert.deepEqual(await pageSend({ type: 'xir:hello' }, 9), { account: null });
  const scheduled = (id) => ({ data: { scheduled_tweet_list: [{ id, execute_at: Date.now() + 60_000 }] } });
  const native = (id) => ({ type: 'xir:scheduled:tap', text: JSON.stringify(scheduled(id)) });
  await pageSend(native('disabled'), 9);
  assert.match((await send({ type: 'startBackfill', account: 'uid-9' })).error, /尚未开启/);
  assert.equal(store['scheduled:uid-9'], undefined);

  assert.match((await send({ type: 'setAccountEnabled', enabled: true, userId: '8' })).error, /重试/);
  assert.deepEqual(await send({ type: 'setAccountEnabled', enabled: true, userId: '9' }), { ok: true, account: 'uid-9' });
  assert.deepEqual(await pageSend({ type: 'xir:hello' }, 9), { account: 'uid-9' });
  await pageSend(native('first'), 1);
  await pageSend(native('second'), 9);
  assert.equal(store['scheduled:me'].items[0].id, 'first');
  assert.equal(store['scheduled:uid-9'].items[0].id, 'second');
  await pageSend(native('wrong-identity'), 9, '1');
  assert.equal(store['scheduled:me'].items[0].id, 'first');
  assert.equal(store['scheduled:uid-9'].items[0].id, 'second');

  const newest = feed[0].id_str;
  for (const account of ['me', 'uid-9']) {
    store[`settings:${account}`] = { fetchEnabled: true };
    store[`cursor:${account}`] = { syncedId: newest, nextIncAt: 0 };
  }
  await listeners.startup();
  assert.ok(alarms['inc:me']);
  assert.ok(alarms['inc:uid-9']);
  const originalSend = chrome.tabs.sendMessage;
  const requested = [];
  let mismatch = false;
  let releaseFirst;
  const firstFetchHeld = new Promise((resolve) => { releaseFirst = resolve; });
  let held = false;
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type !== 'xir:fetch') return originalSend(id, msg);
    requested.push([id, msg.userId, msg.kind]);
    if (msg.kind === 'scheduled') {
      if (server.scheduledFail429Once) {
        server.scheduledFail429Once = false;
        return { ok: false, status: 429, userId: msg.userId, rateResetAt: null };
      }
      if (mismatch) {
        sessions.set(id, { userId: '8', handle: 'Changed' });
      }
      return { ok: true, status: 200, userId: msg.userId, body: scheduled('requested') };
    }
    if (!held) {
      held = true;
      await firstFetchHeld;
    }
    return originalSend(id, msg);
  };
  try {
    const both = Promise.all([fire('inc', 'me'), fire('inc', 'uid-9')]);
    await until(() => requested.length === 1, '第一份请求开始');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requested.length, 1, '同时到期时只有一份请求占用读取锁');
    const firstUid = requested[0][1];
    const waiting = firstUid === '1' ? 'uid-9' : 'me';
    assert.ok(alarms[`inc:${waiting}`], '未拿到锁的账号保留自己的闹钟');
    releaseFirst();
    await both;
    assert.ok(requested.every(([, uid]) => uid === firstUid), '一轮读取期间不串到另一个账号');
    await fire('inc', waiting);
    assert.deepEqual([...new Set(requested.map(([id, uid]) => `${id}:${uid}`))].sort(), ['1:1', '9:9']);
    assert.ok(store['cursor:me'].inLastReadAt);
    assert.ok(store['cursor:uid-9'].inLastReadAt);

    const tpl = { type: 'xir:tpl', kind: 'scheduled', url: 'https://x.com/i/api/graphql/QID/FetchScheduledTweets' };
    await pageSend(tpl, 9);
    assert.equal(store['tpl:scheduled:me'], undefined);
    assert.equal((await pageSend({ type: 'xir:scheduled:sync', force: true }, 9)).items[0].id, 'requested');
    mismatch = true;
    const drift = await pageSend({ type: 'xir:scheduled:sync', force: true }, 9);
    assert.equal(drift.status, 'error', '请求返回前标签页换号，拒绝使用响应');
    assert.deepEqual((await send({ type: 'getState' })).online, ['me']);
    assert.equal(store['scheduled:uid-9'].items[0].id, 'requested');

    // 排期同步 429 后同样退避，反复打开排期弹窗不能继续发请求
    mismatch = false;
    sessions.set(9, { userId: '9', handle: 'New' });
    const scheduledCalls = () => requested.filter(([, , kind]) => kind === 'scheduled').length;
    const before429 = scheduledCalls();
    server.scheduledFail429Once = true;
    assert.equal((await pageSend({ type: 'xir:scheduled:sync', force: true }, 9)).status, 'error');
    assert.ok(store['scheduled:uid-9'].retryAt > Date.now(), '记下排期同步退避时间');
    assert.ok(store['cursor:uid-9'].rateUntil >= store['scheduled:uid-9'].retryAt, '同一个账号的主动读取一起暂停');
    assert.match((await pageSend({ type: 'xir:scheduled:sync', force: true }, 9)).message, /退避/);
    assert.equal(scheduledCalls(), before429 + 1, '退避期内不再发请求');
    assert.equal(store['cursor:uid-9'].rate429Count, 1, '账号级连续 429 计数从一处累加');

    // 一个入口被限流后，回填和出站也不能绕过去继续请求
    const blockedBefore = requested.length;
    assert.match((await send({ type: 'syncOutNow', account: 'uid-9' })).error, /退避/);
    assert.match((await send({ type: 'startBackfill', account: 'uid-9' })).error, /退避/);
    await fire('inc', 'uid-9');
    await fire('out', 'uid-9');
    assert.equal(requested.length, blockedBefore, '退避期内所有主动读取都不发请求');

    // 退避只属于当前账号，不能把另一个正常账号一起封住
    const meCalls = requested.filter(([, uid]) => uid === '1').length;
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0, rateUntil: 0, rate429Count: 0 });
    await fire('inc', 'me');
    assert.ok(requested.filter(([, uid]) => uid === '1').length > meCalls, '另一个账号照常更新');

    await send({ type: 'setAccountEnabled', enabled: false, account: 'uid-9' });
    assert.equal(alarms['inc:uid-9'], undefined);
    assert.ok(alarms['inc:me'], '关闭另一账号不影响旧账号任务');
    const before = requested.length;
    await fire('inc', 'uid-9');
    assert.equal(requested.length, before);
    assert.ok(store['cursor:uid-9'].inLastReadAt, '关闭账号保留已读进度');
    const logs = (await readDiagnostics()).filter((r) => r.account === 'me');
    assert.equal(logs.some((r) => r.tabId === 9), false);
  } finally {
    chrome.tabs.sendMessage = originalSend;
  }
});

test('扩展重载只刷新旧内容脚本', { timeout: 10_000 }, async () => {
  env.setActiveTab(1);
  staleTabs.add(1);
  loadingTabs.add(1);
  const before = reloadCalls.length;
  await listeners.startup();
  assert.equal(reloadCalls.length, before, '加载中的页面先不打断');
  assert.ok(alarms.staleTabs, '安排一次补查');
  assert.equal(sessionStore.staleTabsRetries, 1);
  await listeners.alarm({ name: 'staleTabs' });
  assert.equal(sessionStore.staleTabsRetries, 2);
  await listeners.alarm({ name: 'staleTabs' });
  assert.equal(sessionStore.staleTabsRetries, 2, '最多补查两轮，避免无限刷新');
  loadingTabs.delete(1);
  await listeners.alarm({ name: 'staleTabs' });
  assert.deepEqual(reloadCalls.slice(before), [1], '页面加载完后只刷新旧内容脚本所在的 X 页面');
  assert.equal(staleTabs.has(1), false);
  assert.equal(sessionStore.staleTabsRetries, undefined);

  // 后台标签页不刷新；切回前台时再补刷
  hiddenTabs.add(1);
  staleTabs.add(1);
  const hiddenBefore = reloadCalls.length;
  await listeners.startup();
  assert.equal(reloadCalls.length, hiddenBefore, '后台标签页不主动刷新');
  assert.ok(staleTabs.has(1), '留给切回前台时处理');
  hiddenTabs.delete(1);
  await listeners.activated({ tabId: 1, windowId: 1 });
  assert.deepEqual(reloadCalls.slice(hiddenBefore), [1], '切回前台后刷新旧内容脚本');

  // 通知页不自动刷新，离开通知页后再补刷
  tabUrls.set(1, 'https://x.com/notifications');
  staleTabs.add(1);
  const noticeBefore = reloadCalls.length;
  await listeners.startup();
  assert.equal(reloadCalls.length, noticeBefore, '不替用户刷新通知页');
  tabUrls.delete(1);
  await listeners.updated(1, { status: 'complete', url: 'https://x.com/home' });
  assert.deepEqual(reloadCalls.slice(noticeBefore), [1], '离开通知页并导航完成后补刷');

  // 跨窗口切回 X 窗口：失去焦点忽略，聚焦新窗口补刷该窗口前台旧页面，且不限制 lastFocusedWindow 并写诊断日志
  staleTabs.add(1);
  const focusBefore = reloadCalls.length;
  await listeners.windowFocus(-1);
  assert.equal(reloadCalls.length, focusBefore, '窗口失焦不触发刷新');
  await listeners.windowFocus(2);
  assert.deepEqual(reloadCalls.slice(focusBefore), [1], '跨窗口切换焦点后补刷前台旧页面');

  const realQuery = chrome.tabs.query;
  const queries = [];
  staleTabs.add(1);
  staleTabs.add(4);
  chrome.tabs.query = async (query) => {
    queries.push(query);
    return [{ id: 1, url: 'https://x.com/home', status: 'complete' }, { id: 4, url: 'https://x.com/home', status: 'complete' }];
  };
  const multiBefore = reloadCalls.length;
  try {
    await listeners.startup();
  } finally {
    chrome.tabs.query = realQuery;
  }
  assert.equal(queries.at(-1).lastFocusedWindow, undefined, '查询不限定 lastFocusedWindow，覆盖多个窗口前台页');
  assert.deepEqual(reloadCalls.slice(multiBefore), [1, 4], '一次性刷新各窗口正在前台的旧页面');
  assert.ok((await readDiagnostics()).some((r) => r.event === 'stale_tab_refresh' && r.reloaded === 2 && r.pending === 0));

  const daytime = env.getNow();
  try {
    env.setNow(new Date(2026, 10, 21, 2, 0, 0, 0).getTime());
    staleTabs.add(1);
    const nightBefore = reloadCalls.length;
    await listeners.startup();
    assert.equal(reloadCalls.length, nightBefore, '夜间不自动刷新 X 页面');
    assert.ok(staleTabs.has(1), '留到白天再刷新');
    assert.ok(alarms.staleTabs.when >= new Date(2026, 10, 21, 8, 0, 0, 0).getTime(), '白天恢复刷新');
  } finally {
    env.setNow(daytime);
    staleTabs.delete(1);
    hiddenTabs.delete(1);
    tabUrls.delete(1);
    delete alarms.staleTabs;
  }
});
