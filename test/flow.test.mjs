// 后台全流程：用假的 chrome API 和假的 X 接口，把 回填 → 限流退避 → 续跑 → 重新初始化去重 → 增量 → 关开关 → 清空 走一遍。
// 假接口的返回形态与 parser 的假设一致，验证的是调度逻辑，不是 X 的真实字段。
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inboundInitCovered, outboundReady, outboundInitCovered } from '../src/rank.js';

const DAY = 86400000;
// 后台页与页之间要等好几秒（真实节奏）；测试里把一秒以上的等待都快进成立刻，只验证流程
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 1000 ? 0 : ms, ...args);
let activeNow = new Date(2026, 10, 21, 9, 0, 0, 0).getTime();
const realDateNow = Date.now;
Date.now = () => activeNow;
const realRandom = Math.random;
let randomOverride = null;
Math.random = () => randomOverride ?? realRandom();
// 模拟升级：已有任务的账号继续启用，仅被识别过的账号保持关闭。
const store = {
  accounts: { me: { handle: 'Me', userId: '1' }, seen: { handle: 'Seen', userId: '3' } },
  'job:me': { status: 'done', startedAt: 1 },
  current: 'me',
};
const sessionStore = {};
const alarms = {};
const version = 'test-version';
const tabUrls = new Map();
const tab = (id) => ({ id, url: tabUrls.get(id) || 'https://x.com/home' });
const sessions = new Map([[1, { userId: '1', handle: 'Me' }], [4, { userId: '1', handle: 'Me' }]]);
const staleTabs = new Set();
const loadingTabs = new Set();
const hiddenTabs = new Set();
const reloadCalls = [];
let activeTab = 1;
const listeners = {};
const hook = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
const pick = (k) => (Array.isArray(k) ? k : [k]);

// ---- 假 X 接口：按时间倒序的提及列表，每页 3 条 ----
const users = { 1: { screen_name: 'Me', name: 'Me' }, 2: { screen_name: 'Fan', name: 'Fan' }, 3: { screen_name: 'Other', name: 'Other' } };
let seq = 1000;
const mention = (daysAgo, uid, conv, replyTo) => ({
  id_str: String(seq--), // 越新 ID 越大
  user_id_str: uid,
  created_at: new Date(Date.now() - daysAgo * DAY).toUTCString(),
  in_reply_to_user_id_str: '1',
  in_reply_to_screen_name: 'Me',
  in_reply_to_status_id_str: replyTo,
  conversation_id_str: conv,
});
const feed = [
  mention(0.1, '2', '50', '50'), mention(1, '2', '50', '50'), mention(2, '3', '60', '61'), // 第三条：我在别人帖子(60)下评论，对方回我
  mention(3, '2', '51', '51'), mention(5, '2', '51', '51'), mention(8, '2', '52', '52'),
  mention(12, '2', '52', '52'), mention(14, '2', '53', '53'),
];
const otherRoot = { id_str: '60', user_id_str: '3', created_at: new Date(Date.now() - 3 * DAY).toUTCString() };
const server = {
  calls: 0, fail429Once: false, repeatInboundCursor: false,
  earlyEndInboundAfterFirstPage: false, emptyInboundOnce: false,
  outCalls: 0, outFail429Once: false, repeatOutCursor: false,
  earlyEndOutAfterFirstPage: false, emptyOutOnce: false,
  scheduledFail429Once: false, outUrls: [], opened: [], closed: [], tplOnOpen: null,
};

// ---- 假的「我的回复」列表（GraphQL 形态），每页 2 条，按时间倒序 ----
const mine = (id, daysAgo, rootUid) => ({
  entryId: `profile-conversation-${id}`,
  content: { items: [{ item: { itemContent: { tweet_results: { result: {
    rest_id: id,
    core: { user_results: { result: { rest_id: '1', core: { screen_name: 'Me' } } } },
    legacy: { id_str: id, user_id_str: '1', created_at: new Date(Date.now() - daysAgo * DAY).toUTCString(), full_text: 'hi',
      in_reply_to_status_id_str: `r${id}`, in_reply_to_user_id_str: rootUid, conversation_id_str: `r${id}` },
  } } } } }] },
});
const outFeed = [mine('9005', 0.2, '2'), mine('9004', 1, '2'), mine('9003', 3, '3'), mine('9002', 9, '2'), mine('9001', 13, '2'), mine('9000', 20, '2')];
function respondOut(msg) {
  server.outCalls++;
  server.outUrls.push(msg.tpl);
  if (server.outFail429Once) {
    server.outFail429Once = false;
    return { ok: false, status: 429, userId: '1', rateResetAt: null };
  }
  if (server.emptyOutOnce) {
    server.emptyOutOnce = false;
    return { ok: true, status: 200, userId: '1', rateResetAt: null, body: { data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [] }] } } } } } } };
  }
  if (server.earlyEndOutAfterFirstPage && msg.cursor) {
    server.earlyEndOutAfterFirstPage = false;
    return { ok: true, status: 200, userId: '1', rateResetAt: null, body: { data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [] }] } } } } } } };
  }
  const start = Number(msg.cursor || 0);
  const entries = outFeed.slice(start, start + 2);
  const repeated = !!server.repeatOutCursor && !!msg.cursor;
  if (repeated) server.repeatOutCursor = false;
  const next = repeated ? msg.cursor : String(start + 2);
  if (start + 2 < outFeed.length || repeated) {
    entries.push({ entryId: 'cursor-bottom', content: { value: next, cursorType: 'Bottom' } });
  }
  return { ok: true, status: 200, userId: '1', rateResetAt: null, body: { data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } } } };
}
function respond(cursor) {
  server.calls++;
  if (server.fail429Once) {
    server.fail429Once = false;
    return { ok: false, status: 429, userId: '1', rateResetAt: null };
  }
  if (server.emptyInboundOnce) {
    server.emptyInboundOnce = false;
    return { ok: true, status: 200, userId: '1', rateResetAt: null,
      requestUrl: 'https://x.com/i/api/2/notifications/mentions.json?count=20', responseMetadata: { age: '0' },
      body: { globalObjects: {}, timeline: { id: 't', instructions: [{ addEntries: { entries: [] } }] } } };
  }
  if (server.earlyEndInboundAfterFirstPage && cursor) {
    server.earlyEndInboundAfterFirstPage = false;
    return { ok: true, status: 200, userId: '1', rateResetAt: null,
      requestUrl: 'https://x.com/i/api/2/notifications/mentions.json?count=20', responseMetadata: { age: '0' },
      body: { globalObjects: {}, timeline: { id: 't', instructions: [{ addEntries: { entries: [] } }] } } };
  }
  const start = Number(cursor || 0);
  const page = feed.slice(start, start + 3);
  const entries = page.map((t) => ({ entryId: `tweet-${t.id_str}`, content: { item: { content: { tweet: { id: t.id_str } } } } }));
  const next = server.repeatInboundCursor && cursor ? (server.repeatInboundCursor = false, cursor) : String(start + 3);
  if (page.length) entries.push({ entryId: 'cursor-bottom', content: { operation: { cursor: { value: next, cursorType: 'Bottom' } } } });
  const tweets = Object.fromEntries([...page, otherRoot].map((t) => [t.id_str, t]));
  return { ok: true, status: 200, userId: '1', rateResetAt: null,
    requestUrl: 'https://x.com/i/api/2/notifications/mentions.json?count=20', responseMetadata: { age: '0' }, body: { globalObjects: page.length ? { tweets, users } : {}, timeline: { id: 't', instructions: [{ addEntries: { entries } }] } } };
}

globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => Object.fromEntries((k === null ? Object.keys(store) : pick(k)).filter((x) => x in store).map((x) => [x, structuredClone(store[x])])),
      set: async (o) => void Object.assign(store, structuredClone(o)),
      remove: async (k) => void pick(k).forEach((x) => delete store[x]),
    },
    session: {
      get: async (k) => Object.fromEntries((k === null ? Object.keys(sessionStore) : pick(k)).filter((x) => x in sessionStore).map((x) => [x, structuredClone(sessionStore[x])])),
      set: async (o) => void Object.assign(sessionStore, structuredClone(o)),
      remove: async (k) => void pick(k).forEach((x) => delete sessionStore[x]),
    },
  },
  alarms: {
    create: async (name, opts) => void (alarms[name] = { ...opts, scheduledTime: opts.when }),
    get: async (name) => alarms[name],
    clear: async (name) => delete alarms[name],
    onAlarm: hook('alarm'),
  },
  runtime: {
    getManifest: () => ({ version }),
    onInstalled: hook('installed'),
    onStartup: hook('startup'),
    onMessage: hook('message'),
  },
  tabs: {
    query: async ({ active } = {}) => (active ? [tab(activeTab)] : [...sessions.keys()].map((id) => ({ ...tab(id), status: loadingTabs.has(id) ? 'loading' : 'complete' }))),
    get: async (id) => ({ ...tab(id), status: loadingTabs.has(id) ? 'loading' : 'complete' }),
    reload: async (id) => {
      reloadCalls.push(id);
      staleTabs.delete(id);
    },
    onActivated: hook('activated'),
    onUpdated: hook('updated'),
    sendMessage: async (id, msg) => {
      const session = sessions.get(id);
      if (msg.type === 'xir:ping') return session ? { ok: true, version: staleTabs.has(id) ? 'old-version' : version, visible: !hiddenTabs.has(id), ...session } : null;
      if (session?.userId !== msg.userId) throw new Error('向错误的标签页发出了请求');
      if (msg.kind === 'out') return { ...respondOut(msg), userId: session.userId };
      server.mentionTpl = msg.tpl;
      return { ...respond(msg.cursor), userId: session.userId };
    },
  },
};

await import('../src/background.js');

const send = (msg, sender = {}) => new Promise((resolve) => listeners.message(msg, sender, resolve));
const pageSend = (msg, id = 1, userId = sessions.get(id)?.userId) => send({ userId,
  activation: Object.values(store.accounts).find((entry) => entry.enabled && entry.userId === userId)?.activation,
  ...msg }, { tab: tab(id), frameId: 0 });
const fire = async (kind, account = 'me') => {
  const name = `${kind}:${account}`;
  delete alarms[name];
  return listeners.alarm({ name });
};
const job = () => store['job:me'];
async function until(cond, what) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`等待超时：${what}`);
}
/** 模拟「到点了」：把任务的下次时间拨到过去，再触发闹钟。 */
async function fireJob() {
  store['job:me'].nextAt = 0;
  await fire('job');
}
const count = async () => (await send({ type: 'getAccountState', account: 'me' })).db.in.count;
const boardRows = async () => (await send({ type: 'getBoard', account: 'me' })).rows;
const setWindow = (days) => send({ type: 'setSettings', account: 'me', patch: { windowDays: days } });

test('后台全流程', { timeout: 60_000 }, async () => {
  await listeners.installed();
  assert.deepEqual(await pageSend({ type: 'xir:hello', handle: 'Me', userId: '1' }), { account: 'me' });
  assert.equal(server.calls, 0, '识别账号不发请求；没初始化过也不自动抓');
  assert.equal(store.accounts.me.enabled, true);
  assert.equal(store.accounts.seen.enabled, false);

  // 网页提及留独立的脱敏证据，包括正式解析器尚不支持的包装结构。
  const nativeUrl = new URL('https://x.com/i/api/graphql/exampleQuery/NotificationsTimeline');
  nativeUrl.searchParams.set('variables', JSON.stringify({ timeline_type: 'Mentions', count: 20, cursor: 'hidden-cursor', userId: 'hidden-account' }));
  nativeUrl.searchParams.set('features', JSON.stringify({ sample_flag: true }));
  nativeUrl.searchParams.set('secret', 'hidden-parameter');
  const nativeBody = { data: { instructions: [{ type: 'TimelineAddEntries', entries: [{
    content: { entryType: 'TimelineFutureModule', items: [
      { itemContent: { tweet_results: { result: { rest_id: '700123', legacy: { full_text: 'hidden-body' } } } } },
      { __typename: 'User', legacy: { id_str: '800456' } },
    ] },
  }] }] } };
  const nativePayload = { type: 'xir:mentions:evidence', url: nativeUrl.href, status: 200,
    metadata: { age: '120', cache: 'HIT internal-node' }, text: JSON.stringify(nativeBody) };
  await pageSend(nativePayload, 4);
  const evidence = (await send({ type: 'getDiagnostics', account: 'me' })).find((event) => event.event === 'web_mentions_response');
  assert.equal(evidence.tabId, 4);
  assert.equal(evidence.evidence.request.count, 20);
  assert.equal(evidence.evidence.request.hasCursor, true);
  assert.match(evidence.evidence.request.featureHash, /^[0-9a-f]{16}$/);
  assert.deepEqual(evidence.evidence.response.postIds, ['700123']);
  assert.ok(evidence.evidence.response.timelineShapes.includes('TimelineFutureModule'));
  assert.equal(evidence.evidence.response.ageSeconds, 120);
  assert.deepEqual(evidence.evidence.response.cache, ['HIT']);
  assert.doesNotMatch(JSON.stringify(evidence), /hidden-|internal-node/);
  assert.equal(await count(), 0, '网页证据不入库');
  assert.equal(server.calls, 0, '网页证据不发新请求');

  // 回填，默认窗口 7 天：第 1 页
  assert.deepEqual(await send({ type: 'startBackfill', account: 'me' }), { ok: true });
  assert.equal(job().rangeDays, 7);
  await until(() => job().pages === 1 && job().nextAt, '第 1 页');
  assert.equal(job().status, 'running');
  assert.ok(job().nextAt - Date.now() >= 7_000, '两页之间要等，不连着拉');

  // 第 2 次请求被限流：暂停、定好自动恢复时间、不丢进度
  server.fail429Once = true;
  await fireJob();
  assert.equal(job().status, 'paused');
  assert.equal(job().auto, true);
  assert.equal(job().pages, 1);
  assert.ok(job().nextAt - Date.now() >= 14 * 60_000, '退避至少 15 分钟');
  assert.equal(store['cursor:me'].rate429Count, 1);

  // 退避到点后续跑，第 2 页最早一条是 8 天前，超过 7 天范围 → 完成
  activeNow = Math.max(activeNow, store['cursor:me'].rateUntil || 0);
  const sendPage = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (id, msg) => msg.type === 'xir:ping' ? sendPage(id, msg) : { ok: false, status: 503, userId: '1' };
  await fireJob();
  chrome.tabs.sendMessage = sendPage;
  assert.equal(job().status, 'paused');
  assert.equal(job().pages, 1);
  assert.equal(job().cursor, '3');
  assert.ok(job().nextAt - Date.now() > 299_000);
  const oldHour = Math.floor(Date.now() / 3_600_000) - 8 * 24;
  const expiredKey = `diagnostics:${oldHour}`;
  store[expiredKey] = [{ at: oldHour * 3_600_000, event: 'expired' }];
  const diagnostics = await send({ type: 'getDiagnostics', account: 'me' });
  const failedPage = diagnostics.find((event) => event.event === 'request' && event.status === 503);
  assert.equal(failedPage.mode, 'inbound_backfill');
  assert.equal(failedPage.page, 2);
  assert.ok(diagnostics.some((event) => event.event === 'retry_scheduled' &&
    event.run === failedPage.run && event.page === failedPage.page));
  assert.ok(diagnostics.some((event) => event.event === 'page_saved' &&
    event.decisions?.some((item) => item.postId === '1000' && item.reason === 'accepted_own_root')));
  assert.ok(diagnostics.some((event) => event.event === 'request' &&
    event.evidence?.request.api === 'rest' && event.evidence.response.postIds.includes('1000')));
  assert.equal(store[expiredKey], undefined);
  assert.ok(diagnostics.some((event) => event.event === 'request' && event.status === 503 && event.continuation));
  assert.ok(diagnostics.some((event) => event.event === 'retry_scheduled' && event.status === 503));
  await fireJob(); // 退避到点：重试第 2 页
  while (job().status === 'running') await fireJob();
  assert.equal(job().status, 'done');
  assert.equal(job().reachedEnd, false);
  assert.equal(server.calls, 4);
  assert.equal(await count(), 8, '多读一页跨过时间边界，避免混排导致漏页');

  // 榜单：Other 那条是我去别人帖子下评论后的回复，不上榜
  assert.deepEqual((await boardRows()).map((r) => [r.handle, r.count]), [['Fan', 4]]);
  assert.deepEqual(store['snap:me'].users.fan, { rank: 1, count: 4, color: 'gray', last: store['snap:me'].users.fan.last });

  // 我回他多少次：第一次也要手动点「初始化」，到点的闹钟不会自己开始读
  assert.equal(alarms['out:me'], undefined, '入站回填不会顺带启动出站读取');
  await fire('out');
  assert.equal(store['cursor:me'].out, undefined, '没点过初始化，不自动读');
  assert.deepEqual([server.outCalls, server.opened], [0, []]);
  // 点了：还没见过 X 自己的那条请求时读不了，只提示
  await send({ type: 'syncOutNow', account: 'me' });
  await until(() => store['cursor:me'].out?.status === 'need_tpl' && !store['cursor:me'].out.running, '没有请求地址');
  assert.equal(server.outCalls, 0);
  assert.deepEqual(server.opened, [], '等待用户打开回复页，插件不打开标签页');
  await fire('out');
  assert.equal(server.opened.length, 0, '后台重试不打开标签页');
  assert.equal((await boardRows())[0].replied, null, '出站还没读成时不冒充「一次没回」');
  // 页面上出现了那条请求：记下地址，马上补读。整页跨过 7 天边界才停（3 页）
  delete alarms['out:me'];
  await pageSend({ type: 'xir:tpl', url: 'https://x.com/i/api/graphql/QID/UserTweetsAndReplies?variables=%7B%7D' });
  assert.ok(alarms['out:me'], '拿到地址后约好补读');
  await fire('out');
  assert.deepEqual([store['cursor:me'].out.status, store['cursor:me'].out.syncedId, server.outCalls], ['ok', '9005', 3]);
  assert.equal(store['cursor:me'].out.reachedEnd, false, '读到 7 天范围，不是列表到底');
  assert.equal((await boardRows())[0].replied, 2, '7 天内我在 Fan 的帖子下回复了 2 次（回 Other 的那条不算他的）');
  assert.equal(store['snap:me'].users.fan.replied, 2, '读完后时间线标签也带上');
  // 出站每日更新只接到上次位置；下一次自动时间未到时，遗留闹钟也不会发请求
  await fire('out');
  assert.equal(server.outCalls, 3);
  assert.ok(store['cursor:me'].out.nextAutoAt - Date.now() >= 8 * 60 * 60_000);

  // 榜单范围切到半个月：榜单和标签快照立刻按新范围重算，不发请求
  assert.ok((await setWindow(45)).error, '只接受 7、15、30、60、90');
  assert.ok((await send({ type: 'setSettings', account: 'me', patch: { initDays: 60 } })).error, '初始化范围只接受 7、15、30');
  await setWindow(15);
  assert.equal(server.calls, 4);
  assert.deepEqual((await boardRows()).map((r) => [r.handle, r.count]), [['Fan', 7]]);
  assert.equal(store['snap:me'].windowDays, 15);
  assert.equal(store['snap:me'].users.fan.count, 7);
  await setWindow(30);
  assert.equal((await boardRows()).find((r) => r.handle === 'Fan').replied, 5, '窗口没覆盖完也按已有记录显示');
  assert.equal(store['snap:me'].users.fan.replied, 5);
  await setWindow(15);

  // 改口径和颜色：榜单和标签立刻跟着变；越界的值夹回范围
  const set = (patch) => send({ type: 'setSettings', account: 'me', patch });
  await set({ minCount: 8 });
  assert.deepEqual(await boardRows(), []);
  assert.deepEqual(store['snap:me'].users, {});
  await set({ minCount: 2, topN: 9999, tiers: [{ min: 5, color: 'green' }], baseColor: 'purple' });
  assert.equal(store['settings:me'].topN, 500);
  assert.equal(store['snap:me'].users.fan.color, 'green');
  const full = await send({ type: 'getBoard', account: 'me' });
  assert.deepEqual([full.people, full.replies], [1, 7]);
  await set({ topN: 100, tiers: [{ min: 20, color: 'red' }, { min: 10, color: 'orange' }, { min: 5, color: 'blue' }], baseColor: 'gray' });
  assert.equal(server.calls, 4, '改设置不发请求');

  // 改了初始化范围也不会自己去读：到点后的日常更新只接到接续点。榜单按半个月算，本机已有的 9 天前那条也算上
  await set({ initDays: 15 });
  let outBefore = server.outCalls;
  store['cursor:me'].out.nextAutoAt = 0;
  await fire('out');
  assert.equal(server.outCalls - outBefore, 1);
  assert.equal((await boardRows())[0].replied, 4);
  assert.equal(store['cursor:me'].out.lastFullDays, 7, '还是上次初始化的范围');
  // 手动点「初始化」：不管上次读到哪，按范围重新读一遍
  outBefore = server.outCalls;
  await send({ type: 'syncOutNow', account: 'me' });
  // 这一步后台不等待，页与页之间是真实的几秒间隔，所以多等一会儿
  const redone = () => server.outCalls - outBefore === 3 && store['cursor:me'].out.fullFor === 15;
  for (let i = 0; i < 10 && !redone(); i++) await until(redone, '手动初始化我回别人').catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([server.outCalls - outBefore, store['cursor:me'].out.fullFor], [3, 15], '手动初始化我回别人');
  // X 换了接口参数（404）：丢掉旧地址，约好下一轮；下一轮自己开「回复」栏取到新地址，接着读，取完把标签页关掉
  store['cursor:me'].out.nextAutoAt = 0;
  const realSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (id, msg) => msg.type === 'xir:ping' ? realSend(id, msg) : { ok: false, status: 404, userId: '1' };
  await fire('out');
  chrome.tabs.sendMessage = realSend;
  assert.equal(store['cursor:me'].out.status, 'need_tpl');
  assert.equal(store['tpl:replies:me'], undefined);
  assert.equal((await boardRows())[0].replied, 4, '已有的数还在');
  delete alarms['out:me'];
  store['tpl:replies:me'] = { url: 'https://x.com/i/api/graphql/QID2/UserTweetsAndReplies?variables=%7B%7D', at: Date.now() };
  await listeners.startup();
  assert.ok(alarms['out:me'], '模板已存在但闹钟丢失时，恢复闹钟');
  delete alarms['out:me'];
  delete store['tpl:replies:me'];
  await pageSend({ type: 'xir:tpl', url: 'https://x.com/i/api/graphql/QID2/UserTweetsAndReplies?variables=%7B%7D' });
  assert.ok(alarms['out:me'], '页面提供新地址后安排续读');
  await fire('out');
  assert.deepEqual([store['cursor:me'].out.status, server.opened, server.outUrls.at(-1).includes('QID2')], ['ok', [], true]);

  assert.equal(store['cursor:me'].out.lastFullDays, 15, '记下完整读完成的时间和范围');

  // 出站 429 必须指数退避，不能每 15 分钟固定重试
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const savedNow = activeNow;
    try {
      Object.assign(store['cursor:me'].out, { status: 'ok', retryAt: 0, resume: null, nextAutoAt: 0, rate429Count: 0 });
      server.outFail429Once = true;
      await fire('out');
      const first = store['cursor:me'].out;
      assert.equal(first.rate429Count, 1);
      assert.equal(store['cursor:me'].rate429Count, 1);
      assert.ok(first.retryAt - Date.now() >= 15 * 60_000, '第一次 429 至少退避 15 分钟');

      activeNow = first.retryAt;
      server.outFail429Once = true;
      await fire('out');
      const second = store['cursor:me'].out;
      assert.equal(second.rate429Count, 2);
      assert.equal(store['cursor:me'].rate429Count, 2);
      assert.ok(second.retryAt - Date.now() >= 30 * 60_000, '连续 429 的等待时间翻倍');
    } finally {
      activeNow = savedNow;
      store['cursor:me'] = savedCursor;
      delete alarms['out:me'];
      server.outFail429Once = false;
    }
  }

  // 出站重复游标是异常，不得当成列表到底，也不能推进接续点或覆盖范围
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const beforeCover = savedCursor.out.coverTs;
    try {
      Object.assign(store['cursor:me'].out, { status: 'ok', retryAt: 0, resume: null, nextAutoAt: 0, syncedId: '9000' });
      const runSync = store['cursor:me'].out.syncedId;
      server.repeatOutCursor = true;
      await fire('out');
      const out = store['cursor:me'].out;
      assert.equal(out.status, 'error');
      assert.match(out.message, /重复的翻页位置/);
      assert.equal(out.syncedId, runSync, '重复游标不推进接续点');
      assert.equal(out.coverTs, beforeCover, '重复游标不冒充完整覆盖');
    } finally {
      store['cursor:me'] = savedCursor;
      delete alarms['out:me'];
      server.repeatOutCursor = false;
    }
  }

  // 出站增量在接上旧位置前提前空页：不能把中间一段静默跳过
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const beforeLastAt = savedCursor.out.lastAt;
    const beforeCover = savedCursor.out.coverTs;
    try {
      const checkpoint = '9002'; // 第一页两条都比它新，第二页提前空掉
      Object.assign(store['cursor:me'].out, {
        status: 'ok', retryAt: 0, resume: null, nextAutoAt: 0, manualTask: false,
        syncedId: checkpoint, fullFor: 15, schema: 2,
      });
      store['cursor:me'].rateUntil = 0;
      store['cursor:me'].rate429Count = 0;
      server.earlyEndOutAfterFirstPage = true;
      await fire('out');
      const out = store['cursor:me'].out;
      assert.equal(out.status, 'error');
      assert.match(out.message, /提前结束/);
      assert.equal(out.syncedId, checkpoint, '提前结束不推进接续点');
      assert.equal(out.lastAt, beforeLastAt, '提前结束不冒充读完');
      assert.equal(out.coverTs, beforeCover, '提前结束不冒充覆盖');

      Object.assign(store['cursor:me'].out, { status: 'ok', retryAt: 0, nextAutoAt: 0, resume: null, syncedId: checkpoint });
      store['cursor:me'].rateUntil = 0;
      store['cursor:me'].rate429Count = 0;
      server.emptyOutOnce = true;
      await fire('out');
      assert.match(store['cursor:me'].out.message, /提前结束/, '首屏空页也不能当成接上旧位置');
    } finally {
      store['cursor:me'] = savedCursor;
      delete alarms['out:me'];
      server.earlyEndOutAfterFirstPage = false;
      server.emptyOutOnce = false;
    }
  }

  // 自动出站的等待/续读不能绕到上午、晚间窗口之外
  {
    const savedOut = structuredClone(store['cursor:me'].out);
    const savedNow = activeNow;
    try {
      activeNow = new Date(2026, 10, 21, 11, 40, 0, 0).getTime();
      store['cursor:me'].out = {
        ...savedOut, status: 'queued', retryAt: 0, nextAutoAt: 0,
        resume: { cursor: '2', topId: '9005', rounds: 0, full: false, stopAt: '9000', nextAt: 0 },
      };
      const before = server.outCalls;
      await fire('out');
      assert.equal(server.outCalls, before, '自动出站等待期间不绕过窗口');
      assert.ok(alarms['out:me'].when >= new Date(2026, 10, 21, 18, 0, 0, 0).getTime(), '改到晚间窗口再继续');
      assert.equal(store['cursor:me'].out.resume.nextAt, alarms['out:me'].when);
    } finally {
      activeNow = savedNow;
      store['cursor:me'].out = savedOut;
      delete alarms['out:me'];
    }
  }

  // 重新初始化（半个月）：一直翻到列表到底，如实标记没翻够；重复的不重复计数
  const reinitStartedAt = Date.now();
  await send({ type: 'startBackfill', account: 'me' });
  await until(() => job().pages === 1 && job().nextAt, '重跑第 1 页');
  await send({ type: 'startBackfill', account: 'me' });
  assert.equal(job().pages, 1, '重复初始化不会重置正在进行的任务');
  while (job().status === 'running') await fireJob();
  assert.equal(job().status, 'done');
  assert.equal(job().reachedEnd, true);
  assert.equal(await count(), 8);
  assert.equal(job().rangeDays, 15);
  assert.deepEqual((await boardRows()).map((r) => [r.handle, r.count]), [['Fan', 7]]);
  assert.equal(store['cursor:me'].lastIncrementalAt, reinitStartedAt, '重新初始化完成后重置旧补漏锚点');

  // 回填遇到重复游标：暂停在异常处，不把半截数据标成“列表到底”
  {
    const savedJob = structuredClone(job());
    const savedCursor = structuredClone(store['cursor:me']);
    try {
      server.repeatInboundCursor = true;
      await send({ type: 'startBackfill', account: 'me' });
      await until(() => job().pages === 1 && job().nextAt, '重复游标测试的第 1 页');
      await fireJob();
      assert.equal(job().status, 'error');
      assert.match(job().message, /重复的翻页位置/);
      assert.equal(store['cursor:me'].syncedId, savedCursor.syncedId, '异常时不推进接续点');
      assert.deepEqual(store['cursor:me'].lastBackfill, savedCursor.lastBackfill, '异常时不改上次覆盖范围');
    } finally {
      server.repeatInboundCursor = false;
      store['job:me'] = savedJob;
      store['cursor:me'] = savedCursor;
      delete store['alert:me'];
      delete alarms['job:me'];
    }
  }

  // 增量：间隔里来了 7 条，一轮读完并在接续点之后再向更早补 1 小时
  for (let i = 0; i < 7; i++) feed.unshift({ ...mention(0, '2', '50', '50'), id_str: String(2000 + i) });
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  let before = server.calls;
  randomOverride = 0.999999; // 下一次自动更新要能排到晚间窗口末尾附近，不能提前一小时收口
  try {
    await listeners.alarm({ name: 'tick' });
  } finally {
    randomOverride = null;
  }
  assert.equal(server.calls - before, 4);
  assert.equal(await count(), 15);
  assert.equal(store['cursor:me'].syncedId, '2006');
  // 下一次定在下一个自动时段，并约好闹钟
  const gap = store['cursor:me'].nextIncAt - Date.now();
  assert.ok(gap > 13 * 60 * 60_000, '完整窗口内可以排到 22:30 前，而不是 21:30 就停止');
  assert.ok(gap >= 8 * 60 * 60_000 && gap <= 13.5 * 60 * 60_000 + 1_000);
  assert.equal(alarms['inc:me'].when, store['cursor:me'].nextIncAt);

  // 闹钟到点（把时间拨过去）就跑，不用等兜底闹钟；没有新内容时仍会做每日安全回看
  store['cursor:me'].nextIncAt = 0;
  store['cursor:me'].lastAttemptAt = 0;
  before = server.calls;
  await fire('inc');
  assert.equal(server.calls - before, 4);

  // X 晚放出来的回复即使落在已经越过的接续点之后，也要靠回看窗口捞回来
  const late = { ...mention(0.02, '2', '50', '50'), id_str: '1999' };
  feed.splice(9, 0, late);
  store['cursor:me'].nextIncAt = 0;
  store['cursor:me'].lastAttemptAt = 0;
  const countBeforeLate = await count();
  await fire('inc');
  assert.equal(await count(), countBeforeLate + 1);
  assert.ok((await send({ type: 'exportAll', account: 'me' })).inbound.some((event) => event.id === '1999'));
  feed.splice(feed.indexOf(late), 1);

  // 打开过 X 的通知页：记下它读通知的请求，下一轮起用新接口读提及；新接口参数过期（404）就删掉、改回旧接口
  assert.equal(server.mentionTpl, undefined, '没记下之前用旧接口');
  const NT = 'https://x.com/i/api/graphql/NQ/NotificationsTimeline?variables=%7B%22timeline_type%22%3A%22All%22%7D';
  await pageSend({ type: 'xir:tpl', url: NT, kind: 'mentions' });
  assert.equal(store['tpl:replies:me'].url.includes('QID2'), true, '两种模板分开存');
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  await fire('inc');
  assert.equal(server.mentionTpl, NT);
  assert.equal((await send({ type: 'getAccountState', account: 'me' })).mentionsApi, 'gql');
  const realSend2 = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (_id, msg) => (msg.type === 'xir:fetch' && msg.tpl ? { ok: false, status: 404, userId: '1' } : realSend2(_id, msg));
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  await fire('inc');
  chrome.tabs.sendMessage = realSend2;
  assert.equal(store['tpl:mentions:me'], undefined, '过期的模板删掉');
  assert.ok(store['cursor:me'].nextIncAt - Date.now() <= 5 * 60_000, '三到五分钟后用旧接口重读');
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  await fire('inc');
  assert.equal(server.mentionTpl, undefined);

  // 两个触发几乎同时到（比如浏览器重启时两个 x.com 标签页同时上线）：只跑一轮
  store['cursor:me'].nextIncAt = 0;
  store['cursor:me'].lastAttemptAt = 0;
  before = server.calls;
  await Promise.all([fire('inc'), fire('inc')]);
  assert.equal(server.calls - before, 4, '同时到的两个触发只跑一轮');

  // 增量被限流：放弃本轮，不推进下一次补漏的锚点
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const beforeAnchor = savedCursor.lastIncrementalAt;
    try {
      Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
      server.fail429Once = true;
      const result = await fire('inc');
      assert.match(result.message, /限流/);
      assert.equal(store['cursor:me'].lastIncrementalAt, beforeAnchor, '失败不推进补漏锚点');
      assert.ok(store['cursor:me'].rateUntil > Date.now());
    } finally {
      server.fail429Once = false;
      store['cursor:me'] = savedCursor;
      delete store['alert:me'];
      delete alarms['inc:me'];
    }
  }

  // 入站重复游标是异常：保留原接续点，不能当成已接上
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const beforeSync = savedCursor.syncedId;
    const beforeAnchor = savedCursor.lastIncrementalAt;
    try {
      Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
      server.repeatInboundCursor = true;
      const result = await fire('inc');
      assert.match(result.error, /翻页异常/);
      assert.equal(store['cursor:me'].syncedId, beforeSync, '重复游标不推进接续点');
      assert.equal(store['cursor:me'].lastIncrementalAt, beforeAnchor, '重复游标不推进补漏锚点');
      assert.equal(store['cursor:me'].incResume, undefined);
      assert.match(store['alert:me'].message, /重复的翻页位置/);
    } finally {
      server.repeatInboundCursor = false;
      store['cursor:me'] = savedCursor;
      delete store['alert:me'];
      delete alarms['inc:me'];
    }
  }

  // 入站分页在接上旧位置前提前空页：同样保留接续点和补漏锚点
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const beforeAnchor = savedCursor.lastIncrementalAt;
    try {
      const checkpoint = feed[4].id_str; // 第一页全是比它更新的已有记录，第二页提前空掉
      Object.assign(store['cursor:me'], { syncedId: checkpoint, nextIncAt: 0, lastAttemptAt: 0, rateUntil: 0, rate429Count: 0 });
      delete store['cursor:me'].incResume;
      server.earlyEndInboundAfterFirstPage = true;
      const result = await fire('inc');
      assert.match(result.error, /提前结束/);
      assert.equal(store['cursor:me'].syncedId, checkpoint, '提前结束不推进接续点');
      assert.equal(store['cursor:me'].lastIncrementalAt, beforeAnchor, '提前结束不推进补漏锚点');
      assert.equal(store['cursor:me'].incResume, undefined);
      assert.match(store['alert:me'].message, /提前结束/);

      Object.assign(store['cursor:me'], { syncedId: checkpoint, nextIncAt: 0, lastAttemptAt: 0, rateUntil: 0, rate429Count: 0 });
      delete store['cursor:me'].incResume;
      server.emptyInboundOnce = true;
      assert.match((await fire('inc')).error, /提前结束/, '首屏空页也不能当成接上旧位置');
    } finally {
      server.earlyEndInboundAfterFirstPage = false;
      server.emptyInboundOnce = false;
      store['cursor:me'] = savedCursor;
      delete store['alert:me'];
      delete alarms['inc:me'];
    }
  }

  // 旧版本留下的快照缺字段：页面再上线时重算补齐
  delete store['snap:me'].users.fan.color;
  await pageSend({ type: 'xir:hello', handle: 'Me', userId: '1' });
  assert.equal(store['snap:me'].users.fan.color, 'orange');

  // 没到间隔不抓
  before = server.calls;
  await listeners.alarm({ name: 'tick' });
  assert.equal(server.calls, before);

  // 人类工作时段：夜间不发请求；白天 X 页面不在前台也不发请求
  const daytime = activeNow;
  const savedCursor = structuredClone(store['cursor:me']);
  try {
    activeNow = new Date(2026, 10, 21, 2, 0, 0, 0).getTime();
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
    before = server.calls;
    await listeners.alarm({ name: 'tick' });
    assert.equal(server.calls, before, '凌晨不读取');
    assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /08:00/);

    activeNow = daytime;
    hiddenTabs.add(1);
    hiddenTabs.add(4);
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
    await listeners.alarm({ name: 'tick' });
    assert.equal(server.calls, before, 'X 页面在后台不读取');
    assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /切到.*X 页面/);

    hiddenTabs.delete(1);
    hiddenTabs.delete(4);
    activeNow = new Date(2026, 10, 21, 12, 0, 0, 0).getTime();
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
    await listeners.alarm({ name: 'tick' });
    assert.equal(server.calls, before, '两个自动窗口之间不读取');

    activeNow = new Date(2026, 10, 21, 19, 0, 0, 0).getTime();
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
    before = server.calls;
    await listeners.alarm({ name: 'tick' });
    assert.ok(server.calls > before, '晚间自动窗口会读取');
  } finally {
    hiddenTabs.delete(1);
    hiddenTabs.delete(4);
    activeNow = daytime;
    store['cursor:me'] = savedCursor;
  }

  // 关掉自动更新：清掉遗留自动闹钟，后台 tick 不请求；手动初始化仍可启动
  await chrome.alarms.create('inc:me', { when: Date.now() + 1_000 });
  await chrome.alarms.create('out:me', { when: Date.now() + 1_000 });
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: false } });
  assert.equal(alarms['inc:me'], undefined);
  assert.equal(alarms['out:me'], undefined);
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  before = server.calls;
  await listeners.alarm({ name: 'tick' });
  assert.equal(server.calls, before);
  assert.deepEqual(await send({ type: 'startBackfill', account: 'me' }), { ok: true }, '手动初始化不受自动更新开关影响');
  await until(() => job().pages === 1, '关掉自动更新后仍能手动初始化');
  await send({ type: 'pauseJob', account: 'me' });

  // 点开某人：返回他在窗口内的回复
  const detail = await send({ type: 'getReplies', account: 'me', actorId: '2' });
  assert.equal(detail.total, 15);
  assert.equal(detail.outbound.total, (await boardRows()).find((row) => row.actor_id === '2').replied);
  assert.equal(detail.outbound.items[0].id, '9005');
  assert.ok(detail.outbound.items[0].created_at);
  assert.equal(await send({ type: 'getReplies', account: 'me', actorId: '3' }).then((d) => d.total), 0, '别人帖子下的不算');

  // 数据现状和全量导出：两份数据各自的条数和起止时间
  const st = await send({ type: 'getAccountState', account: 'me' });
  assert.deepEqual([st.db.in.count, st.db.out.count], [16, 6]);
  assert.ok(st.db.out.from < st.db.out.to && st.cursor.out.lastFullAt);
  const all = await send({ type: 'exportAll', account: 'me' });
  assert.deepEqual([all.inbound.length, all.out.length], [16, 6]);

  // 单个后台事件最多读 6 页：连续多日没读时也不会让事件过长，记下位置休息后接着读到接上为止
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: true } });
  for (let i = 0; i < 130; i++) feed.unshift({ ...mention(0, '2', '50', '50'), id_str: String(3000 + i) });
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  before = server.calls;
  const incrementStartedAt = Date.now();
  await fire('inc');
  assert.equal(server.calls - before, 6, '一次后台事件最多 6 页');
  assert.equal(store['cursor:me'].syncedId, '2006', '没接上之前接续点不动');
  assert.ok(store['cursor:me'].incResume, '记下读到哪了');
  assert.equal(store['cursor:me'].incResume.startedAt, incrementStartedAt, '续读保留整轮的起始时间');
  const rest = alarms['inc:me'].when - Date.now();
  assert.ok(rest >= 179_000 && rest <= 300_000, '休息三到五分钟接着读');
  while (store['cursor:me'].incResume) {
    activeNow += 5 * 60_000; // 分多段才读完时，补漏锚点不能被最后一段带偏
    store['cursor:me'].nextIncAt = 0; // 时间到了（lastAttemptAt 还是刚才：补读不受 10 分钟间隔限制）
    await fire('inc');
  }
  assert.equal(server.calls - before, 47, '分多个短任务接上并继续回看 1 小时');
  assert.deepEqual([store['cursor:me'].syncedId, store['cursor:me'].incResume], ['3129', undefined]);
  assert.equal(store['cursor:me'].lastIncrementalAt, incrementStartedAt, '补漏锚点固定在这一轮的起点');
  assert.equal(await count(), 16 + 130, '一条不丢');
  feed.splice(0, 130); // 这批合成数据已入库，后续立即更新只验证正常的近端回看
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: false } });

  store['cursor:me'].inLastReadAt = 1;
  store['cursor:me'].out.lastReadAt = 1;
  const countBeforeManual = await count();
  Object.assign(store['cursor:me'], { nextIncAt: Date.now() + 45 * 60_000, lastAttemptAt: 0 });
  before = server.calls;
  const receipt = await send({ type: 'updateNowWithReceipt', account: 'me' });
  assert.deepEqual(receipt, { ok: true, readAt: {
    inbound: store['cursor:me'].inLastReadAt,
    outbound: store['cursor:me'].out.lastReadAt,
  } });
  const firstManualCalls = server.calls - before;
  assert.ok(firstManualCalls > 0, '自动更新关闭时，立即更新仍会读取');
  const nextAutoGap = store['cursor:me'].nextIncAt - Date.now();
  assert.ok(nextAutoGap >= 8 * 60 * 60_000 && nextAutoGap <= 13.5 * 60 * 60_000 + 1_000,
    '立即更新后顺延到下一个自动时段');
  assert.equal(alarms['inc:me'], undefined, '自动更新关闭时不安排自动读取');
  assert.equal(await count(), countBeforeManual, '这次没有新增入站记录');
  assert.ok(store['cursor:me'].inLastReadAt > 1, '零新增仍记录成功读取时间');
  assert.ok(store['cursor:me'].out.lastReadAt > 1, '手动更新返回前已成功读取出站数据');
  assert.ok(store['cursor:me'].inLastReadCounts.read > 0);
  assert.equal(store['cursor:me'].inLastReadCounts.added, 0, '没有新记录也显示读到的条数');
  assert.ok(store['cursor:me'].out.lastReadCounts.read > 0);
  const beforeSecond = [server.calls, server.outCalls];
  assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /刚刚更新过/);
  assert.deepEqual([server.calls, server.outCalls], beforeSecond, '冷却期内不发请求');
  activeNow += 11 * 60_000;
  assert.ok((await send({ type: 'updateNowWithReceipt', account: 'me' })).ok, '完成后可再次立即更新');
  assert.deepEqual([server.calls - beforeSecond[0], server.outCalls - beforeSecond[1]], [firstManualCalls, 1]);
  const afterSecond = [server.calls, server.outCalls];
  activeNow += 11 * 60_000;
  store['cursor:me'].rateUntil = Date.now() + 60_000;
  const lastManualAt = store['cursor:me'].lastManualAt;
  assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /退避/);
  assert.deepEqual([server.calls, server.outCalls], afterSecond, '接口退避时不发请求');
  assert.equal(store['cursor:me'].lastManualAt, lastManualAt, '没有发出请求就不记冷却');
  delete store['cursor:me'].rateUntil;

  // 手动更新第一页后切到后台：保存续读位置并在一分钟内重新排队，恢复前台后接着读
  const savedInterrupted = structuredClone(store['cursor:me']);
  const realInterruptedSend = chrome.tabs.sendMessage;
  let interruptedFetches = 0;
  chrome.tabs.sendMessage = async (id, msg) => {
    const result = await realInterruptedSend(id, msg);
    if (msg.type === 'xir:fetch' && msg.kind !== 'out' && ++interruptedFetches === 1) {
      hiddenTabs.add(1);
      hiddenTabs.add(4);
    }
    return result;
  };
  try {
    Object.assign(store['cursor:me'], { nextIncAt: Date.now() + 45 * 60_000, lastAttemptAt: 0 });
    delete store['cursor:me'].incResume;
    delete store['cursor:me'].lastManualAt;
    const interrupted = await send({ type: 'updateNowWithReceipt', account: 'me' });
    assert.match(interrupted.error, /暂不可用/);
    assert.equal(interruptedFetches, 1);
    assert.ok(store['cursor:me'].incResume, '切后台前读到的位置留着');
    assert.ok(store['cursor:me'].lastManualAt, '实际发出请求后才记冷却');
    const retryGap = alarms['inc:me'].when - Date.now();
    assert.ok(retryGap >= 59_000 && retryGap <= 61_000, '切后台后一分钟内重新排队');
    hiddenTabs.delete(1);
    hiddenTabs.delete(4);
    chrome.tabs.sendMessage = realInterruptedSend;
    store['cursor:me'].nextIncAt = 0;
    await fire('inc');
    assert.equal(store['cursor:me'].incResume, undefined, '恢复前台后接着读完');
  } finally {
    hiddenTabs.delete(1);
    hiddenTabs.delete(4);
    chrome.tabs.sendMessage = realInterruptedSend;
    store['cursor:me'] = savedInterrupted;
  }
  await set({ fetchEnabled: false });

  await set({ fetchEnabled: true });
  const checkpoint = store['cursor:me'].syncedId;
  const reading = store['cursor:me'].inLastReadAt;
  const originalDate = feed[2].created_at;
  feed[2].created_at = new Date(Date.now() - DAY).toUTCString();
  const diagnosis = await send({ type: 'diagnoseMentions', account: 'me',
    from: Date.now() - 60_000, to: Date.now(), postId: feed[3].id_str });
  feed[2].created_at = originalDate;
  assert.equal(diagnosis.pages, 2);
  assert.equal(diagnosis.reason, 'post_found');
  assert.equal(diagnosis.stored, true);
  assert.equal(store['cursor:me'].syncedId, checkpoint);
  assert.equal(store['cursor:me'].inLastReadAt, reading);
  await set({ fetchEnabled: false });

  // 初始化范围比 X 能提供的回复还长：读到列表底部要如实记下，不能当成已覆盖所选范围
  await set({ fetchEnabled: true, initDays: 30 });
  outBefore = server.outCalls;
  await send({ type: 'syncOutNow', account: 'me' });
  const reachedBottom = () => store['cursor:me'].out?.lastFullDays === 30 && store['cursor:me'].out?.status === 'ok';
  for (let i = 0; i < 10 && !reachedBottom(); i++) await until(reachedBottom, '读到回复列表底部').catch(() => {});
  assert.ok(reachedBottom());
  await new Promise((r) => setTimeout(r, 20)); // 等上一轮 finally 释放读取锁
  assert.ok(server.outCalls > outBefore);
  assert.equal(store['cursor:me'].out.reachedEnd, true);
  assert.ok(store['cursor:me'].out.coverTs <= Date.now() - 20 * DAY + 60_000, '记下实际读到的最早时间');

  // 单次读取达到轮数上限：不能把失败写成「初始化完成」，但要留下实际读到的最早时间
  const savedOutState = structuredClone(store['cursor:me'].out);
  const savedFeed = outFeed.splice(0, outFeed.length,
    ...Array.from({ length: 12 }, (_, i) => mine(String(9005 - (i % 6)), 1 + i, '2')));
  store['cursor:me'].out = {
    ...savedOutState,
    status: 'ok', message: null, limitReached: null, attemptCoverTs: null,
    coverTs: null,
    fullFor: 0, initDays: 30, targetTs: Date.now() - 40 * DAY,
    resume: { cursor: '0', topId: null, rounds: 119, full: true, stopAt: null, nextAt: 0 },
  };
  try {
    await fire('out');
    const afterLimit = store['cursor:me'].out;
    assert.equal(afterLimit.status, 'error');
    assert.equal(afterLimit.limitReached, true);
    assert.equal(afterLimit.lastFullAt, savedOutState.lastFullAt, '失败不改上次初始化完成时间');
    assert.equal(afterLimit.lastFullDays, savedOutState.lastFullDays, '失败不改上次初始化范围');
    assert.equal(afterLimit.coverTs, null, '失败不拿这次的部分进度冒充完整覆盖');
    assert.ok(afterLimit.attemptCoverTs >= Date.now() - 11 * DAY, '记下这次实际读到的最早时间');
    assert.equal(afterLimit.syncedId, savedOutState.syncedId, '没读完时接续点不动');
    const callsAtLimit = server.outCalls;
    await fire('out');
    assert.equal(server.outCalls, callsAtLimit, '达到上限后自动闹钟不再继续读');
    assert.equal(store['cursor:me'].out.status, 'error');
    delete alarms['out:me'];
    await pageSend({ type: 'xir:hello', handle: 'Me', userId: '1' });
    assert.equal(alarms['out:me'], undefined, '达到上限后页面上线也不再安排自动读取');
  } finally {
    outFeed.splice(0, outFeed.length, ...savedFeed);
    store['cursor:me'].out = savedOutState;
  }

  await set({ initDays: 7 });
  await set({ fetchEnabled: false });

  // 接续点比 24 小时回看边界更旧：不能只看回看边界就停，必须继续读到接续点
  await set({ fetchEnabled: true });
  const staleFeed = feed.splice(0, feed.length,
    { ...mention(25 / 24, '2', '50', '50'), id_str: '6006' },
    { ...mention(26 / 24, '2', '50', '50'), id_str: '6005' },
    { ...mention(27 / 24, '2', '50', '50'), id_str: '6004' },
    { ...mention(2, '2', '50', '50'), id_str: '6003' },
    { ...mention(2.5, '2', '50', '50'), id_str: '6002' },
    { ...mention(2.9, '2', '50', '50'), id_str: '6001' },
    { ...mention(3, '2', '50', '50'), id_str: '6000' },
    { ...mention(3.1, '2', '50', '50'), id_str: '5999' },
    { ...mention(3.2, '2', '50', '50'), id_str: '5998' },
    { ...mention(3.3, '2', '50', '50'), id_str: '5997' });
  const staleCursor = structuredClone(store['cursor:me']);
  try {
    Object.assign(store['cursor:me'], { syncedId: '6000', nextIncAt: 0, lastAttemptAt: 0 });
    delete store['cursor:me'].lastIncrementalAt;
    delete store['cursor:me'].incResume;
    delete store['cursor:me'].rateUntil;
    const staleCalls = server.calls;
    const staleCount = await count();
    await fire('inc');
    assert.equal(server.calls - staleCalls, 3, '第 3 页到接续点就停，不依赖列表结束');
    assert.equal(await count(), staleCount + 9, '接续点之前的记录一条不少');
  } finally {
    feed.splice(0, feed.length, ...staleFeed);
    store['cursor:me'] = staleCursor;
    await set({ fetchEnabled: false });
  }

  // 清空：榜单、快照、游标都没了，设置保留
  const realClearSend = chrome.tabs.sendMessage;
  let releaseHeld;
  let heldClear = false;
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'xir:fetch' && !heldClear) {
      heldClear = true;
      await new Promise((resolve) => { releaseHeld = resolve; });
    }
    return realClearSend(id, msg);
  };
  try {
    await send({ type: 'startBackfill', account: 'me' });
    await until(() => heldClear, '读取中的请求开始');
    assert.match((await send({ type: 'clearData', account: 'me' })).error, /正在读取/);
  } finally {
    releaseHeld?.();
    chrome.tabs.sendMessage = realClearSend;
  }
  let cleared;
  for (let i = 0; i < 40; i++) {
    cleared = await send({ type: 'clearData', account: 'me' });
    if (!cleared.error) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(cleared?.ok, true, '读取锁释放后再清空');
  assert.equal(await count(), 0);
  assert.deepEqual(await boardRows(), []);
  assert.equal(store['snap:me'], undefined);
  assert.equal(store['cursor:me'], undefined);
  assert.equal(store['settings:me'].fetchEnabled, false);

  // 两份数据都真的为空时：可信地记下「空初始化完成」，之后自动增量还能启动，不会卡死
  const emptySavedInbound = feed.splice(0, feed.length);
  const emptySavedOutbound = outFeed.splice(0, outFeed.length);
  try {
    await send({ type: 'startBackfill', account: 'me' });
    await until(() => job()?.status === 'done', '空的别人回我初始化完成');
    assert.deepEqual([job().reachedEnd, job().oldestTs], [true, null]);
    assert.equal(store['cursor:me'].syncedId, '0');
    assert.equal(inboundInitCovered(store['cursor:me'].lastBackfill, store['cursor:me'].syncedId, 7), true);

    await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: true } });
    await send({ type: 'syncOutNow', account: 'me' });
    await until(() => store['cursor:me'].out?.lastAt, '空的我回别人初始化完成');
    const emptyOut = store['cursor:me'].out;
    assert.deepEqual([emptyOut.reachedEnd, emptyOut.coverTs, emptyOut.syncedId], [true, null, '0']);
    assert.equal(outboundReady(emptyOut, 7), true);
    assert.equal(outboundInitCovered(emptyOut, 7), true);

    emptyOut.nextAutoAt = 0;
    await fire('out');
    assert.deepEqual([store['cursor:me'].out.status, store['cursor:me'].out.syncedId], ['ok', '0'], '可信空列表的日常增量不会报假异常');
    await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: false } });
  } finally {
    feed.splice(0, feed.length, ...emptySavedInbound);
    outFeed.splice(0, outFeed.length, ...emptySavedOutbound);
  }

  // 过期清理：只留最近 90 天，一天最多清一次；清掉过数据就记下（弹窗据此不再挂红字提示）
  const { putEvents } = await import('../src/db.js');
  const old = (id, daysAgo) => ({ id, actor_id: '2', actor_handle: 'Fan', actor_name: 'Fan', actor_avatar: '', created_at: Date.now() - daysAgo * DAY, conversation_id: '1', root_mine: true });
  await putEvents('me', [old('1', 1), old('2', 46), old('3', 85), old('4', 95)]);
  await listeners.alarm({ name: 'tick' });
  assert.equal(await count(), 3);
  assert.ok(store['cursor:me'].prunedAt);
  await putEvents('me', [old('5', 100)]);
  await listeners.alarm({ name: 'tick' });
  assert.equal(await count(), 4, '24 小时内不重复清');
});

test('多账号启用、定时更新、排期与切号隔离', { timeout: 10_000 }, async () => {
  sessions.set(9, { userId: '9', handle: 'New' });
  activeTab = 9;
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
    const logs = await send({ type: 'getDiagnostics', account: 'me' });
    assert.equal(logs.some((r) => r.tabId === 9), false);
  } finally {
    chrome.tabs.sendMessage = originalSend;
  }
});

test('扩展重载只刷新旧内容脚本', { timeout: 10_000 }, async () => {
  activeTab = 1;
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

  const daytime = activeNow;
  try {
    activeNow = new Date(2026, 10, 21, 2, 0, 0, 0).getTime();
    staleTabs.add(1);
    const nightBefore = reloadCalls.length;
    await listeners.startup();
    assert.equal(reloadCalls.length, nightBefore, '夜间不自动刷新 X 页面');
    assert.ok(staleTabs.has(1), '留到白天再刷新');
    assert.ok(alarms.staleTabs.when >= new Date(2026, 10, 21, 8, 0, 0, 0).getTime(), '白天恢复刷新');
  } finally {
    activeNow = daytime;
    staleTabs.delete(1);
    hiddenTabs.delete(1);
    tabUrls.delete(1);
    delete alarms.staleTabs;
  }
});
