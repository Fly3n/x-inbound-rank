// 后台全流程：用假的 chrome API 和假的 X 接口，把 回填 → 限流退避 → 续跑 → 重新初始化去重 → 增量 → 关开关 → 清空 走一遍。
// 假接口的返回形态与 parser 的假设一致，验证的是调度逻辑，不是 X 的真实字段。
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

const DAY = 86400000;
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
const server = { calls: 0, fail429Once: false };
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
  tabs: { query: async () => [{ id: 1 }], sendMessage: async (_id, msg) => respond(msg.cursor) },
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
const count = async () => (await send({ type: 'getAccountState', account: 'me' })).eventCount;
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
  assert.deepEqual(store['snap:me'].users.fan, { rank: 1, count: 4, tier: 4, last: store['snap:me'].users.fan.last });

  // 窗口切到半个月：榜单和标签快照立刻按新窗口重算，不发请求
  assert.ok((await setWindow(30)).error, '只接受 7 或 15');
  await setWindow(15);
  assert.equal(server.calls, 3);
  assert.deepEqual((await boardRows()).map((r) => [r.handle, r.count]), [['Fan', 5]]);
  assert.equal(store['snap:me'].windowDays, 15);
  assert.equal(store['snap:me'].users.fan.count, 5);

  // 重新初始化（半个月）：一直翻到列表到底，如实标记没翻够；重复的不重复计数
  await send({ type: 'startBackfill', account: 'me' });
  await until(() => job().pages === 1 && job().nextAt, '重跑第 1 页');
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

  // 旧版本留下的快照缺字段：页面再上线时重算补齐
  delete store['snap:me'].users.fan.tier;
  await send({ type: 'xir:hello', handle: 'Me', userId: '1' });
  assert.equal(store['snap:me'].users.fan.tier, 2);

  // 没到间隔不抓
  before = server.calls;
  await listeners.alarm({ name: 'tick' });
  assert.equal(server.calls, before);

  // 关掉抓取开关：到了间隔也不发请求，初始化也被拒
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: false } });
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  await listeners.alarm({ name: 'tick' });
  assert.ok((await send({ type: 'startBackfill', account: 'me' })).error);
  assert.equal(server.calls, before);

  // 清空：榜单、快照、游标都没了，设置保留
  await send({ type: 'clearData', account: 'me' });
  assert.equal(await count(), 0);
  assert.deepEqual(await boardRows(), []);
  assert.equal(store['snap:me'], undefined);
  assert.equal(store['cursor:me'], undefined);
  assert.equal(store['settings:me'].fetchEnabled, false);
});
