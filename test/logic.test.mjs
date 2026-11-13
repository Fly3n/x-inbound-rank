// 运行：node --test test
// 解析用例的输入是按「预期的接口形态」手写的，验证的是分类与边界逻辑；真实返回是否长这样要靠 README 的实测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { board, badgeSnapshot, underMyPosts, DAY_MS } from '../src/rank.js';
import { parseMentions, ParseError } from '../src/x/parser.js';

const NOW = Date.UTC(2026, 10, 13);
const ev = (id, actor, daysAgo) => ({
  id: String(id), actor_id: actor, actor_handle: actor.toUpperCase(), actor_name: actor, actor_avatar: '', created_at: NOW - daysAgo * DAY_MS, conversation_id: 'c' + id, root_mine: true,
});

test('回复榜：时间窗、同分按最近回复', () => {
  const events = [ev(1, 'a', 1), ev(2, 'a', 10), ev(3, 'a', 20), ev(4, 'b', 2), ev(5, 'b', 3), ev(6, 'c', 0.5), ev(7, 'c', 40)];
  assert.deepEqual(board(events, 30, NOW).map((r) => [r.rank, r.handle, r.count]), [[1, 'A', 3], [2, 'B', 2], [3, 'C', 1]]);
  // 7 天窗：a 只剩 1 条，c 也 1 条但更近
  assert.deepEqual(board(events, 7, NOW).map((r) => r.handle), ['B', 'C', 'A']);
});

test('标签快照：按 30 天回复榜定名次，键为小写 handle', () => {
  const snap = badgeSnapshot([ev(1, 'a', 1), ev(2, 'a', 10), ev(3, 'b', 2), ev(4, 'c', 31)], NOW);
  assert.deepEqual(snap.a, { rank: 1, c30: 2, c7: 1, last: NOW - DAY_MS });
  assert.equal(snap.b.rank, 2);
  assert.equal(snap.c, undefined);
});

test('口径：只算我帖子下的回复，根帖归属未知的靠同一对话补判', () => {
  const e = (id, conversation_id, root_mine) => ({ ...ev(id, 'a', 1), conversation_id, root_mine });
  const kept = underMyPosts([
    e(1, 'mine', true), // 直接评论我的帖子
    e(2, 'mine', null), // 同一对话里的深层回复，根帖已被上一条证明是我的
    e(3, 'theirs', false), // 我在别人帖子下评论，对方回我
    e(4, 'unknown', null), // 看不出根帖是谁的，也没有旁证
  ]);
  assert.deepEqual(kept.map((x) => x.id), ['1', '2']);
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

test('解析：只收直接回复我的，引用和提及不计', () => {
  const myOld = tweet('100', '1', { created_at: 'Thu Jan 01 00:00:00 +0000 2026' });
  const b = body(
    [
      myOld,
      tweet('200', '2', { in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'Me', in_reply_to_status_id_str: '100', conversation_id_str: '100' }), // 评论我的帖子
      tweet('150', '3', {}), // 别人的帖子
      tweet('206', '3', { in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'Me', in_reply_to_status_id_str: '160', conversation_id_str: '150' }), // 我在别人帖下评论，对方回我
      tweet('207', '2', { in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'Me', in_reply_to_status_id_str: '170', conversation_id_str: '90' }), // 深层回复，根帖 90 不在这一页里
      tweet('201', '2', { is_quote_status: true, quoted_status_id_str: '100' }), // 引用我
      tweet('202', '2', { in_reply_to_user_id_str: '3', in_reply_to_screen_name: 'Other', in_reply_to_status_id_str: '150' }), // 在别人帖下提到我
      tweet('203', '3', {}), // 普通提及
      tweet('204', '1', { in_reply_to_user_id_str: '1', in_reply_to_status_id_str: '100' }), // 我自己接自己的帖
      tweet('205', '3', { is_quote_status: true, quoted_status_id_str: '202' }), // 引用的是别人的帖
    ],
    ['200', '201', '202', '203', '204', '205', '206', '207'],
  );
  const r = parseMentions(b, me);
  assert.deepEqual(r.events.map((e) => [e.id, e.actor_handle, e.root_mine]), [['200', 'Fan', true], ['206', 'Other', false], ['207', 'Fan', null]]);
  assert.equal(r.bottomCursor, 'CURSOR');
  assert.equal(r.newestId, '207');
  // 被引用的旧帖 100 不在时间线条目里，不能把「本页最早时间」拉回到 1 月
  assert.equal(r.oldestId, '200');
  assert.equal(new Date(r.oldestTs).getUTCMonth(), 10);
});

test('解析：只有手填 handle、没有用户 ID 时靠 screen_name 匹配', () => {
  const b = body([tweet('300', '2', { in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'ME', in_reply_to_status_id_str: '100', conversation_id_str: '100' })], ['300']);
  assert.equal(parseMentions(b, { handle: 'me', userId: null }).events.length, 1);
});

test('解析：结构不对就报错，不返回空结果', () => {
  assert.throws(() => parseMentions({ data: {} }, me), ParseError);
  assert.throws(() => parseMentions(body([], ['999']), me), ParseError);
  assert.equal(parseMentions(body([], [], null), me).bottomCursor, null); // 空列表是合法的「到底了」
  // 实测到的空账号返回：globalObjects 是 {}，时间线里只有一个 Top 游标
  const empty = { globalObjects: {}, timeline: { id: 'x', instructions: [{ clearCache: {} }, { addEntries: { entries: [{ entryId: 'cursor-top-1', content: { operation: { cursor: { value: 'T', cursorType: 'Top' } } } }] } }] } };
  assert.deepEqual(parseMentions(empty, me), { events: [], entryIds: [], newestId: null, oldestId: null, oldestTs: null, bottomCursor: null });
});
