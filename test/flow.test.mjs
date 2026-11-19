// 后台全流程：用假的 chrome API 和假的 X 接口，把 回填 → 限流退避 → 续跑 → 重新初始化去重 → 增量 → 关开关 → 清空 走一遍。
// 假接口的返回形态与 parser 的假设一致，验证的是调度逻辑，不是 X 的真实字段。
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

const DAY = 86400000;
// 后台页与页之间要等好几秒（真实节奏）；测试里把一秒以上的等待都快进成立刻，只验证流程
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 1000 ? 0 : ms, ...args);
const store = {};
const alarms = {};
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
const server = { calls: 0, fail429Once: false, outCalls: 0, outUrls: [], opened: [], closed: [], tplOnOpen: null };

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
  const start = Number(msg.cursor || 0);
  const entries = outFeed.slice(start, start + 2);
  if (start + 2 < outFeed.length) entries.push({ entryId: 'cursor-bottom', content: { value: String(start + 2), cursorType: 'Bottom' } });
  return { ok: true, status: 200, userId: '1', rateResetAt: null, body: { data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } } } };
}
function respond(cursor) {
  server.calls++;
  if (server.fail429Once) {
    server.fail429Once = false;
    return { ok: false, status: 429, userId: '1', rateResetAt: null };
  }
  const start = Number(cursor || 0);
  const page = feed.slice(start, start + 3);
  const entries = page.map((t) => ({ entryId: `tweet-${t.id_str}`, content: { item: { content: { tweet: { id: t.id_str } } } } }));
  if (page.length) entries.push({ entryId: 'cursor-bottom', content: { operation: { cursor: { value: String(start + 3), cursorType: 'Bottom' } } } });
  const tweets = Object.fromEntries([...page, otherRoot].map((t) => [t.id_str, t]));
  return { ok: true, status: 200, userId: '1', rateResetAt: null, body: { globalObjects: page.length ? { tweets, users } : {}, timeline: { id: 't', instructions: [{ addEntries: { entries } }] } } };
}

globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => Object.fromEntries(pick(k).filter((x) => x in store).map((x) => [x, structuredClone(store[x])])),
      set: async (o) => void Object.assign(store, structuredClone(o)),
      remove: async (k) => void pick(k).forEach((x) => delete store[x]),
    },
  },
  alarms: {
    create: async (name, opts) => void (alarms[name] = opts),
    get: async (name) => alarms[name],
    clear: async (name) => delete alarms[name],
    onAlarm: hook('alarm'),
  },
  runtime: { onInstalled: hook('installed'), onStartup: hook('startup'), onMessage: hook('message') },
  tabs: {
    // 后台自己开「回复」栏取请求地址：server.tplOnOpen 有值时，开出来的页面会报上这条地址；没值就当开不了
    create: async ({ url }) => {
      server.opened.push(url);
      if (!server.tplOnOpen) throw new Error('no window');
      await listeners.message({ type: 'xir:tpl', url: server.tplOnOpen }, {}, () => {});
      return { id: 9 };
    },
    remove: async (id) => void server.closed.push(id),
    query: async () => [{ id: 1 }], sendMessage: async (_id, msg) => (msg.kind === 'out' ? respondOut(msg) : ((server.mentionTpl = msg.tpl), respond(msg.cursor))) },
};

await import('../src/background.js');

const send = (msg) => new Promise((resolve) => listeners.message(msg, {}, resolve));
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
  await listeners.alarm({ name: 'job' });
}
const count = async () => (await send({ type: 'getAccountState', account: 'me' })).db.in.count;
const boardRows = async () => (await send({ type: 'getBoard', account: 'me' })).rows;
const setWindow = (days) => send({ type: 'setSettings', account: 'me', patch: { windowDays: days } });

test('后台全流程', { timeout: 60_000 }, async () => {
  assert.deepEqual(await send({ type: 'xir:hello', handle: 'Me', userId: '1' }), { account: 'me' });
  assert.equal(server.calls, 0, '识别账号不发请求；没初始化过也不自动抓');
  assert.deepEqual(store['snap:me'].users, {}, '页面上线时重算快照');

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

  // 退避到点后续跑，第 2 页最早一条是 8 天前，超过 7 天范围 → 完成
  await fireJob();
  assert.equal(job().status, 'done');
  assert.equal(job().reachedEnd, false);
  assert.equal(server.calls, 3);
  assert.equal(await count(), 6);

  // 榜单：Other 那条是我去别人帖子下评论后的回复，不上榜
  assert.deepEqual((await boardRows()).map((r) => [r.handle, r.count]), [['Fan', 4]]);
  assert.deepEqual(store['snap:me'].users.fan, { rank: 1, count: 4, color: 'gray', last: store['snap:me'].users.fan.last });

  // 我回他多少次：第一次也要手动点「初始化」，到点的闹钟不会自己开始读
  assert.ok(alarms.out.when - Date.now() >= 59_000, '回填完成后照常约好闹钟');
  await listeners.alarm({ name: 'out' });
  assert.equal(store['cursor:me'].out, undefined, '没点过初始化，不自动读');
  assert.deepEqual([server.outCalls, server.opened], [0, []]);
  // 点了：还没见过 X 自己的那条请求时读不了，只提示
  await send({ type: 'syncOutNow', account: 'me' });
  await until(() => store['cursor:me'].out?.status === 'need_tpl' && !store['cursor:me'].out.running, '没有请求地址');
  assert.equal(server.outCalls, 0);
  assert.deepEqual(server.opened, [], '等待用户打开回复页，插件不打开标签页');
  await listeners.alarm({ name: 'out' });
  assert.equal(server.opened.length, 0, '后台重试不打开标签页');
  assert.equal((await boardRows())[0].replied, 0);
  // 页面上出现了那条请求：记下地址，马上补读。7 天窗口读到 9 天前那条为止（2 页）
  delete alarms.out;
  await send({ type: 'xir:tpl', url: 'https://x.com/i/api/graphql/QID/UserTweetsAndReplies?variables=%7B%7D' });
  assert.ok(alarms.out, '拿到地址后约好补读');
  await listeners.alarm({ name: 'out' });
  assert.deepEqual([store['cursor:me'].out.status, store['cursor:me'].out.syncedId, server.outCalls], ['ok', '9005', 2]);
  assert.equal((await boardRows())[0].replied, 2, '7 天内我在 Fan 的帖子下回复了 2 次（回 Other 的那条不算他的）');
  assert.equal(store['snap:me'].users.fan.replied, 2, '读完后时间线标签也带上');
  // 没有新回复时只读 1 页
  await listeners.alarm({ name: 'out' });
  assert.equal(server.outCalls, 3);

  // 榜单范围切到半个月：榜单和标签快照立刻按新范围重算，不发请求
  assert.ok((await setWindow(45)).error, '只接受 7、15、30、60、90');
  assert.ok((await send({ type: 'setSettings', account: 'me', patch: { initDays: 60 } })).error, '初始化范围只接受 7、15、30');
  await setWindow(15);
  assert.equal(server.calls, 3);
  assert.deepEqual((await boardRows()).map((r) => [r.handle, r.count]), [['Fan', 5]]);
  assert.equal(store['snap:me'].windowDays, 15);
  assert.equal(store['snap:me'].users.fan.count, 5);

  // 改口径和颜色：榜单和标签立刻跟着变；越界的值夹回范围
  const set = (patch) => send({ type: 'setSettings', account: 'me', patch });
  await set({ minCount: 6 });
  assert.deepEqual(await boardRows(), []);
  assert.deepEqual(store['snap:me'].users, {});
  await set({ minCount: 2, topN: 9999, tiers: [{ min: 5, color: 'green' }], baseColor: 'purple' });
  assert.equal(store['settings:me'].topN, 500);
  assert.equal(store['snap:me'].users.fan.color, 'green');
  const full = await send({ type: 'getBoard', account: 'me' });
  assert.deepEqual([full.people, full.replies], [1, 5]);
  await set({ topN: 100, tiers: [{ min: 20, color: 'red' }, { min: 10, color: 'orange' }, { min: 5, color: 'blue' }], baseColor: 'gray' });
  assert.equal(server.calls, 3, '改设置不发请求');

  // 改了初始化范围也不会自己去读：闹钟到点只读新来的（1 页）。榜单按半个月算，本机已有的 9 天前那条也算上
  await set({ initDays: 15 });
  let outBefore = server.outCalls;
  await listeners.alarm({ name: 'out' });
  assert.equal(server.outCalls - outBefore, 1);
  assert.equal((await boardRows())[0].replied, 3);
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
  const realSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async () => ({ ok: false, status: 404, userId: '1' });
  await listeners.alarm({ name: 'out' });
  chrome.tabs.sendMessage = realSend;
  assert.equal(store['cursor:me'].out.status, 'need_tpl');
  assert.equal(store['tpl:replies'], undefined);
  assert.equal((await boardRows())[0].replied, 4, '已有的数还在');
  delete alarms.out;
  await send({ type: 'xir:tpl', url: 'https://x.com/i/api/graphql/QID2/UserTweetsAndReplies?variables=%7B%7D' });
  assert.ok(alarms.out, '页面提供新地址后安排续读');
  await listeners.alarm({ name: 'out' });
  assert.deepEqual([store['cursor:me'].out.status, server.opened, server.outUrls.at(-1).includes('QID2')], ['ok', [], true]);

  assert.equal(store['cursor:me'].out.lastFullDays, 15, '记下完整读完成的时间和范围');

  // 重新初始化（半个月）：一直翻到列表到底，如实标记没翻够；重复的不重复计数
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

  // 增量：间隔里来了 7 条（跨 3 页），一轮读完，读到上次的位置就停
  for (let i = 0; i < 7; i++) feed.unshift({ ...mention(0, '2', '50', '50'), id_str: String(2000 + i) });
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  let before = server.calls;
  await listeners.alarm({ name: 'tick' });
  assert.equal(server.calls - before, 3);
  assert.equal(await count(), 15);
  assert.equal(store['cursor:me'].syncedId, '2006');
  // 下一次随机定在 50–70 分钟后，并约好闹钟
  const gap = store['cursor:me'].nextIncAt - Date.now();
  assert.ok(gap > 49 * 60_000 && gap < 70 * 60_000);
  assert.equal(alarms.inc.when, store['cursor:me'].nextIncAt);

  // 闹钟到点（把时间拨过去）就跑，不用等兜底闹钟；没有新内容时只读 1 页
  store['cursor:me'].nextIncAt = 0;
  store['cursor:me'].lastAttemptAt = 0;
  before = server.calls;
  await listeners.alarm({ name: 'inc' });
  assert.equal(server.calls - before, 1);

  // 打开过 X 的通知页：记下它读通知的请求，下一轮起用新接口读提及；新接口参数过期（404）就删掉、改回旧接口
  assert.equal(server.mentionTpl, undefined, '没记下之前用旧接口');
  const NT = 'https://x.com/i/api/graphql/NQ/NotificationsTimeline?variables=%7B%22timeline_type%22%3A%22All%22%7D';
  await send({ type: 'xir:tpl', url: NT, kind: 'mentions' });
  assert.equal(store['tpl:replies'].url.includes('QID2'), true, '两种模板分开存');
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  await listeners.alarm({ name: 'inc' });
  assert.equal(server.mentionTpl, NT);
  assert.equal((await send({ type: 'getAccountState', account: 'me' })).mentionsApi, 'gql');
  const realSend2 = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (_id, msg) => (msg.tpl ? { ok: false, status: 404, userId: '1' } : realSend2(_id, msg));
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  await listeners.alarm({ name: 'inc' });
  chrome.tabs.sendMessage = realSend2;
  assert.equal(store['tpl:mentions'], undefined, '过期的模板删掉');
  assert.ok(store['cursor:me'].nextIncAt - Date.now() < 3 * 60_000, '一两分钟后用旧接口重读');
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  await listeners.alarm({ name: 'inc' });
  assert.equal(server.mentionTpl, undefined);

  // 两个触发几乎同时到（比如浏览器重启时两个 x.com 标签页同时上线）：只跑一轮
  store['cursor:me'].nextIncAt = 0;
  store['cursor:me'].lastAttemptAt = 0;
  before = server.calls;
  await Promise.all([listeners.alarm({ name: 'inc' }), listeners.alarm({ name: 'inc' })]);
  assert.equal(server.calls - before, 1, '同时到的两个触发只跑一轮');

  // 旧版本留下的快照缺字段：页面再上线时重算补齐
  delete store['snap:me'].users.fan.color;
  await send({ type: 'xir:hello', handle: 'Me', userId: '1' });
  assert.equal(store['snap:me'].users.fan.color, 'orange');

  // 没到间隔不抓
  before = server.calls;
  await listeners.alarm({ name: 'tick' });
  assert.equal(server.calls, before);

  // 关掉抓取开关：到了间隔也不发请求，初始化也被拒
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: false } });
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  await listeners.alarm({ name: 'tick' });
  assert.ok((await send({ type: 'startBackfill', account: 'me' })).error);
  assert.ok((await send({ type: 'syncOutNow', account: 'me' })).error, '关了开关，手动读我的回复也被拒');
  assert.equal(server.calls, before);

  // 点开某人：返回他在窗口内的回复
  const detail = await send({ type: 'getReplies', account: 'me', actorId: '2' });
  assert.equal(detail.total, 14);
  assert.equal(await send({ type: 'getReplies', account: 'me', actorId: '3' }).then((d) => d.total), 0, '别人帖子下的不算');

  // 数据现状和全量导出：两份数据各自的条数和起止时间
  const st = await send({ type: 'getAccountState', account: 'me' });
  assert.deepEqual([st.db.in.count, st.db.out.count], [15, 6]);
  assert.ok(st.db.out.from < st.db.out.to && st.cursor.out.lastFullAt);
  const all = await send({ type: 'exportAll', account: 'me' });
  assert.deepEqual([all.inbound.length, all.out.length], [15, 6]);

  // 增量读满 40 页（约 800 条）还没接上（比如电脑关了一整天）：不再放弃，记下位置，一两分钟后接着读到接上为止
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: true } });
  for (let i = 0; i < 130; i++) feed.unshift({ ...mention(0, '2', '50', '50'), id_str: String(3000 + i) });
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  before = server.calls;
  await listeners.alarm({ name: 'inc' });
  assert.equal(server.calls - before, 40, '一轮最多 40 页');
  assert.equal(store['cursor:me'].syncedId, '2006', '没接上之前接续点不动');
  assert.ok(store['cursor:me'].incResume, '记下读到哪了');
  const rest = alarms.inc.when - Date.now();
  assert.ok(rest >= 59_000 && rest <= 120_000, '休息一两分钟接着读');
  store['cursor:me'].nextIncAt = 0; // 时间到了（lastAttemptAt 还是刚才：补读不受 10 分钟间隔限制）
  await listeners.alarm({ name: 'inc' });
  assert.equal(server.calls - before, 44);
  assert.deepEqual([store['cursor:me'].syncedId, store['cursor:me'].incResume], ['3129', undefined]);
  assert.equal(await count(), 15 + 130, '一条不丢');
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: false } });

  // 清空：榜单、快照、游标都没了，设置保留
  await send({ type: 'clearData', account: 'me' });
  assert.equal(await count(), 0);
  assert.deepEqual(await boardRows(), []);
  assert.equal(store['snap:me'], undefined);
  assert.equal(store['cursor:me'], undefined);
  assert.equal(store['settings:me'].fetchEnabled, false);

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
