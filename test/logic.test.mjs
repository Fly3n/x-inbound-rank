// 运行：node --test projects/x-inbound-rank/test
// 解析用例的输入是按「预期的接口形态」手写的，验证的是分类与边界逻辑；真实返回是否长这样要靠 README 的实测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { board, badgeSnapshot, DAY_MS } from '../src/rank.js';
import { parseMentions, ParseError } from '../src/x/parser.js';

const NOW = Date.UTC(2026, 10, 13);
const ev = (id, actor, type, daysAgo) => ({
  id: String(id), actor_id: actor, actor_handle: actor.toUpperCase(), actor_name: actor, actor_avatar: '', type, created_at: NOW - daysAgo * DAY_MS,
});

test('榜单：时间窗、三个榜、同分按最近互动', () => {
  const events = [
    ev(1, 'a', 'reply', 1), ev(2, 'a', 'reply', 10), ev(3, 'a', 'quote', 20),
    ev(4, 'b', 'quote', 2), ev(5, 'b', 'quote', 3),
    ev(6, 'c', 'reply', 0.5), ev(7, 'c', 'reply', 40),
  ];
  assert.deepEqual(board(events, 'total', 30, NOW).map((r) => [r.handle, r.total]), [['A', 3], ['B', 2], ['C', 1]]);
  // 7 天窗：a 只剩 1 条回复，b 2 条引用，c 1 条回复且比 a 更近
  assert.deepEqual(board(events, 'total', 7, NOW).map((r) => r.handle), ['B', 'C', 'A']);
  assert.deepEqual(board(events, 'reply', 30, NOW).map((r) => [r.handle, r.reply]), [['A', 2], ['C', 1]]);
  assert.deepEqual(board(events, 'quote', 7, NOW).map((r) => r.handle), ['B']);
});

test('标签快照：按 30 天综合榜定名次，键为小写 handle', () => {
  const snap = badgeSnapshot([ev(1, 'a', 'reply', 1), ev(2, 'a', 'reply', 10), ev(3, 'b', 'quote', 2), ev(4, 'c', 'reply', 31)], NOW);
  assert.deepEqual(snap.a, { rank: 1, r30: 2, q30: 0, r7: 1, q7: 0, last: NOW - DAY_MS });
  assert.equal(snap.b.rank, 2);
  assert.equal(snap.c, undefined);
});

const user = (id, screen_name) => ({ id_str: id, screen_name, name: screen_name, profile_image_url_https: `https://pbs.twimg.com/${id}.jpg` });
const tweet = (id, uid, extra = {}) => ({ id_str: id, user_id_str: uid, created_at: 'Thu Nov 12 08:00:00 +0000 2026', ...extra });
const entry = (id) => ({ entryId: `tweet-${id}`, content: { item: { content: { tweet: { id, displayType: 'Tweet' } } } } });
const body = (tweets, entryIds, cursor = 'CURSOR') => ({
  globalObjects: {
    users: { 1: user('1', 'Me'), 2: user('2', 'Fan'), 3: user('3', 'Other') },
    tweets: Object.fromEntries(tweets.map((t) => [t.id_str, t])),
  },
  timeline: {
    instructions: [{ addEntries: { entries: [
      ...entryIds.map(entry),
      { entryId: 'cursor-top', content: { operation: { cursor: { value: 'TOP', cursorType: 'Top' } } } },
      ...(cursor ? [{ entryId: 'cursor-bottom', content: { operation: { cursor: { value: cursor, cursorType: 'Bottom' } } } }] : []),
    ] } }],
  },
});
const me = { handle: 'me', userId: '1' };

test('解析：只收对我帖子的回复和对我帖子的引用', () => {
  const myOld = tweet('100', '1', { created_at: 'Thu Jan 01 00:00:00 +0000 2026' });
  const b = body(
    [
      myOld,
      tweet('200', '2', { in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'Me', in_reply_to_status_id_str: '100' }), // 回复我
      tweet('201', '2', { is_quote_status: true, quoted_status_id_str: '100' }), // 引用我
      tweet('202', '2', { in_reply_to_user_id_str: '3', in_reply_to_screen_name: 'Other', in_reply_to_status_id_str: '150' }), // 在别人帖下提到我
      tweet('203', '3', {}), // 普通提及
      tweet('204', '1', { in_reply_to_user_id_str: '1', in_reply_to_status_id_str: '100' }), // 我自己接自己的帖
      tweet('205', '3', { is_quote_status: true, quoted_status_id_str: '202' }), // 引用的是别人的帖
    ],
    ['200', '201', '202', '203', '204', '205'],
  );
  const r = parseMentions(b, me);
  assert.deepEqual(r.events.map((e) => [e.id, e.type, e.actor_handle, e.target_post_id]), [['200', 'reply', 'Fan', '100'], ['201', 'quote', 'Fan', '100']]);
  assert.equal(r.bottomCursor, 'CURSOR');
  assert.equal(r.newestId, '205');
  // 被引用的旧帖 100 不在时间线条目里，不能把「本页最早时间」拉回到 1 月
  assert.equal(r.oldestId, '200');
  assert.equal(new Date(r.oldestTs).getUTCMonth(), 10);
});

test('解析：只有手填 handle、没有用户 ID 时靠 screen_name 匹配', () => {
  const b = body([tweet('300', '2', { in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'ME', in_reply_to_status_id_str: '100' })], ['300']);
  assert.equal(parseMentions(b, { handle: 'me', userId: null }).events.length, 1);
});

test('解析：结构不对就报错，不返回空结果', () => {
  assert.throws(() => parseMentions({ data: {} }, me), ParseError);
  assert.throws(() => parseMentions(body([], ['999']), me), ParseError);
  assert.equal(parseMentions(body([], [], null), me).bottomCursor, null); // 空列表是合法的「到底了」
});
