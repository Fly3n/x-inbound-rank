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
    store[`cursor:${account}`] = { syncedId: newest, nextIncAt: 0, lastManualAt: 0 };
  }
  // 启动时不安排任何后台定时抓取闹钟，并清理旧版遗留的非手动闹钟
  await chrome.alarms.create('inc:me', { when: Date.now() + 1_000 });
  await chrome.alarms.create('out:uid-9', { when: Date.now() + 1_000 });
  await listeners.startup();
  assert.equal(alarms['inc:me'], undefined, '启动后清理旧版非手动入站闹钟');
  assert.equal(alarms['inc:uid-9'], undefined, '启动后不安排后台定时入站闹钟');
  assert.equal(alarms['out:uid-9'], undefined, '启动后清理旧版非手动出站闹钟');
  const originalSend = chrome.tabs.sendMessage;
  const requested = [];
  let releaseFirst;
  const firstFetchHeld = new Promise((resolve) => { releaseFirst = resolve; });
  let held = false;
  let fail429Once = false;
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type !== 'xir:fetch') return originalSend(id, msg);
    requested.push([id, msg.userId, msg.kind]);
    if (fail429Once && msg.userId === '9') {
      fail429Once = false;
      return { ok: false, status: 429, userId: msg.userId, rateResetAt: null };
    }
    if (!held) {
      held = true;
      await firstFetchHeld;
    }
    return originalSend(id, msg);
  };
  try {
    await pageSend({ type: 'xir:tpl', kind: 'mentions', url: 'https://x.com/i/api/graphql/Q9/NotificationsTimeline?variables=%7B%22timeline_type%22%3A%22Mentions%22%7D' }, 9);
    const firstManual = send({ type: 'updateNowWithReceipt', account: 'me' });
    await until(() => requested.length === 1, '第一份手动请求开始');
    const secondManual = await send({ type: 'updateNowWithReceipt', account: 'uid-9' });
    assert.match(secondManual.error, /已有读取任务正在运行/, '同时手动更新时只有一份占用全局读取锁');
    assert.equal(requested.length, 1);
    releaseFirst();
    assert.equal((await firstManual).ok, true);
    assert.equal((await send({ type: 'updateNowWithReceipt', account: 'uid-9' })).ok, true);
    assert.deepEqual([...new Set(requested.map(([id, uid]) => `${id}:${uid}`))].sort(), ['1:1', '9:9']);
    assert.ok(store['cursor:me'].inLastReadAt);
    assert.ok(store['cursor:uid-9'].inLastReadAt);

    // 排期纯旁听增量维护（零主动请求）：新建追加、删除移除、自然到点后全量校准保留 24 小时已发参考
    const beforeSchedOps = requested.length;
    const tCreate = Date.now() + 2 * 3_600_000;
    const createRes = await pageSend({
      type: 'xir:postEvent',
      op: 'CreateScheduledTweet',
      at: Date.now(),
      req: JSON.stringify({ variables: { execute_at: Math.floor(tCreate / 1000), post_tweet_request: { status: '新增测试排期' } } }),
      res: JSON.stringify({ data: { tweet: { rest_id: 'sched-new' } } }),
    }, 9);
    assert.equal(createRes.ok, true);
    assert.ok(store['scheduled:uid-9'].items.some((x) => x.id === 'sched-new' && x.text === '新增测试排期'));
    assert.equal(requested.length, beforeSchedOps, '排期新建零主动请求');

    const delRes = await pageSend({
      type: 'xir:postEvent',
      op: 'DeleteScheduledTweet',
      at: Date.now(),
      req: JSON.stringify({ variables: { scheduled_tweet_id: 'sched-new' } }),
      res: JSON.stringify({ data: { scheduledtweet_delete: 'Done' } }),
    }, 9);
    assert.equal(delRes.ok, true);
    assert.equal(delRes.removed, 1);
    assert.equal(store['scheduled:uid-9'].items.some((x) => x.id === 'sched-new'), false);

    // 旧排期 'second' 到点后，即便点开「已排期帖子」全量校准返回不含它的新列表，也会归档进 recentSent 保留 24 小时
    env.advanceNow(10 * 60_000);
    await pageSend(native('third'), 9);
    assert.deepEqual(store['scheduled:uid-9'].items.map((x) => x.id), ['third']);
    assert.deepEqual(store['scheduled:uid-9'].recentSent.map((x) => x.id), ['second'], '到点发出的排期在全量校准后保留为近期已发参考');
    assert.equal(requested.length, beforeSchedOps, '排期全程零主动请求');

    // 任一入口 429 后整个账号统一进入退避，回填、手动更新和出站都不能绕过去继续请求
    store['cursor:uid-9'].lastManualAt = 0;
    fail429Once = true;
    await send({ type: 'updateNowWithReceipt', account: 'uid-9' });
    assert.ok(store['cursor:uid-9'].rateUntil > Date.now(), '同一个账号的主动读取一起暂停');
    assert.equal(store['cursor:uid-9'].rate429Count, 1, '账号级连续 429 计数从一处累加');

    const blockedBefore = requested.length;
    assert.match((await send({ type: 'syncOutNow', account: 'uid-9' })).error, /退避/);
    assert.match((await send({ type: 'startBackfill', account: 'uid-9' })).error, /退避/);
    store['cursor:uid-9'].lastManualAt = 0;
    assert.match((await send({ type: 'updateNowWithReceipt', account: 'uid-9' })).error, /退避/);
    assert.equal(requested.length, blockedBefore, '退避期内所有主动读取都不发请求');

    // 退避只属于当前账号，不能把另一个正常账号一起封住
    const meCalls = requested.filter(([, uid]) => uid === '1').length;
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastManualAt: 0, lastAttemptAt: 0, rateUntil: 0, rate429Count: 0 });
    assert.equal((await send({ type: 'updateNowWithReceipt', account: 'me' })).ok, true);
    assert.ok(requested.filter(([, uid]) => uid === '1').length > meCalls, '另一个账号照常手动更新');

    await send({ type: 'setAccountEnabled', enabled: false, account: 'uid-9' });
    assert.equal(alarms['inc:uid-9'], undefined);
    const before = requested.length;
    assert.match((await send({ type: 'updateNowWithReceipt', account: 'uid-9' })).error, /尚未开启/);
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

  // 同一标签页 5 分钟冷却内不重复刷新，防止离线/挑战页陷入循环刷新
  staleTabs.add(1);
  const cooldownBefore = reloadCalls.length;
  await listeners.startup();
  assert.equal(reloadCalls.length, cooldownBefore, '单标签页 5 分钟冷却期内不重复刷新');
  env.advanceNow(6 * 60_000);

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

  // 通知页、发帖页、登录/挑战/设置页及已熔断账号绝不自动刷新
  env.advanceNow(6 * 60_000);
  for (const blockedUrl of [
    'https://x.com/notifications',
    'https://x.com/compose/post',
    'https://x.com/account/access',
    'https://x.com/i/flow/login',
    'https://x.com/login',
    'https://x.com/settings/account',
  ]) {
    tabUrls.set(1, blockedUrl);
    staleTabs.add(1);
    const guardBefore = reloadCalls.length;
    await listeners.startup();
    assert.equal(reloadCalls.length, guardBefore, `敏感页面不自动刷新: ${blockedUrl}`);
  }
  tabUrls.delete(1);
  store['cursor:me'] = { ...(store['cursor:me'] || {}), circuitBroken: { at: Date.now(), code: 326, reason: 'locked' } };
  const brokenBefore = reloadCalls.length;
  await listeners.startup();
  assert.equal(reloadCalls.length, brokenBefore, '已熔断账号不自动刷新页面');
  delete store['cursor:me'].circuitBroken;
  const noticeBefore = reloadCalls.length;
  await listeners.updated(1, { status: 'complete', url: 'https://x.com/home' });
  assert.deepEqual(reloadCalls.slice(noticeBefore), [1], '离开敏感页并导航完成后补刷');

  // 跨窗口切回 X 窗口：失去焦点忽略，聚焦新窗口补刷该窗口前台旧页面，且不限制 lastFocusedWindow 并写诊断日志
  env.advanceNow(6 * 60_000);
  staleTabs.add(1);
  const focusBefore = reloadCalls.length;
  await listeners.windowFocus(-1);
  assert.equal(reloadCalls.length, focusBefore, '窗口失焦不触发刷新');
  await listeners.windowFocus(2);
  assert.deepEqual(reloadCalls.slice(focusBefore), [1], '跨窗口切换焦点后补刷前台旧页面');

  env.advanceNow(6 * 60_000);
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
  assert.ok((await readDiagnostics()).some((r) => r.event === 'stale_tab_refresh' && r.queried === 2 && r.reloaded === 2 && r.pending === 0));

  // 并发触发竞态：第一轮未结束时切换到新旧脚本页，第一轮结束后不丢事件自动补跑
  env.advanceNow(6 * 60_000);
  const realRaceSend = chrome.tabs.sendMessage;
  let releaseFirstPing;
  const firstPingBlocked = new Promise((resolve) => { releaseFirstPing = resolve; });
  let pingHeld = false;
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'xir:ping' && id === 1 && !pingHeld) {
      pingHeld = true;
      await firstPingBlocked;
    }
    return realRaceSend(id, msg);
  };
  const raceBefore = reloadCalls.length;
  try {
    env.setActiveTab(1);
    const firstRun = listeners.startup();
    await until(() => pingHeld, '第一轮补刷开始探活');
    env.setActiveTab(4);
    staleTabs.add(4);
    const secondRun = listeners.activated({ tabId: 4, windowId: 2 });
    releaseFirstPing();
    await Promise.all([firstRun, secondRun]);
    assert.deepEqual(reloadCalls.slice(raceBefore), [4], '进行中新增的触发不丢弃，结束后自动补跑并刷新旧页');
  } finally {
    chrome.tabs.sendMessage = realRaceSend;
    env.setActiveTab(1);
  }

  // 打开弹窗检测到当前账号离线/旧版时立即兜底补刷（常规 X 页刷新，通知页保持不动）
  env.advanceNow(6 * 60_000);
  staleTabs.add(1);
  const popupBefore = reloadCalls.length;
  await send({ type: 'getState' });
  await until(() => reloadCalls.length > popupBefore, '打开弹窗触发未连接常规页补刷');
  assert.deepEqual(reloadCalls.slice(popupBefore), [1]);

  env.advanceNow(6 * 60_000);
  tabUrls.set(1, 'https://x.com/notifications');
  staleTabs.add(1);
  const popupNoticeBefore = reloadCalls.length;
  await send({ type: 'getState' });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(reloadCalls.length, popupNoticeBefore, '打开弹窗兜底补刷也绝不碰通知页');
  tabUrls.delete(1);
  staleTabs.delete(1);

  env.advanceNow(6 * 60_000);

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
