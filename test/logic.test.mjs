// 运行：node --test test
// 解析用例的输入是按「预期的接口形态」手写的，验证的是分类与边界逻辑；真实返回是否长这样要靠 README 的实测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { board, ranking, repliesOf, badgeSnapshot, underMyPosts, cleanRules, colorOf, DEFAULT_RULES, DAY_MS } from '../src/rank.js';
import { parseMentions, ParseError } from '../src/x/parser.js';

const NOW = Date.UTC(2026, 10, 13);
const ev = (id, actor, daysAgo) => ({
  id: String(id), actor_id: actor, actor_handle: actor.toUpperCase(), actor_name: actor, actor_avatar: '', created_at: NOW - daysAgo * DAY_MS, conversation_id: 'c' + id, root_mine: true,
});

const rules = (o = {}) => cleanRules({ ...DEFAULT_RULES, ...o });

test('回复榜：时间窗、同分按最近回复、次数不够的不上榜', () => {
  const events = [ev(1, 'a', 1), ev(2, 'a', 10), ev(3, 'a', 20), ev(4, 'b', 2), ev(5, 'b', 3), ev(6, 'c', 0.5), ev(7, 'c', 40)];
  // 15 天窗：a、b 都是 2 条，a 最近一次更近；c 只有 1 条不上榜
  assert.deepEqual(board(events, rules({ windowDays: 15 }), NOW).map((r) => [r.rank, r.handle, r.count]), [[1, 'A', 2], [2, 'B', 2]]);
  // 7 天窗：a 只剩 1 条，也掉出去
  assert.deepEqual(board(events, rules(), NOW).map((r) => r.handle), ['B']);
  // 最少次数调到 1：都上榜；总量不受口径影响
  const all = ranking(events, rules({ minCount: 1 }), NOW);
  assert.deepEqual(all.rows.map((r) => r.handle), ['B', 'C', 'A']);
  assert.deepEqual([all.people, all.replies], [3, 4]);
  assert.deepEqual([ranking(events, rules(), NOW).people, ranking(events, rules(), NOW).replies], [3, 4]);
});

test('回复榜：名次上限可调，默认 100', () => {
  const events = [];
  for (let i = 0; i < 120; i++) events.push(ev(i * 2, 'u' + i, 1), ev(i * 2 + 1, 'u' + i, 2));
  assert.equal(board(events, rules(), NOW).length, 100);
  assert.equal(board(events, rules({ topN: 10 }), NOW).length, 10);
  assert.equal(board(events, rules({ topN: 500 }), NOW).length, 120);
});

test('规则整理：越界夹回范围，档位排序去重，非法颜色兜底', () => {
  assert.deepEqual(cleanRules({}), DEFAULT_RULES);
  const r = cleanRules({ windowDays: 30, topN: 9999, minCount: 0, baseColor: 'pink', tiers: [{ min: 5, color: 'green' }, { min: 30, color: 'nope' }, { min: 5, color: 'red' }, { min: 'x', color: 'red' }] });
  assert.deepEqual(r, { windowDays: 7, topN: 500, minCount: 1, baseColor: 'gray', tiers: [{ min: 30, color: 'gray' }, { min: 5, color: 'green' }] });
  assert.equal(cleanRules({ topN: 3 }).topN, 10);
  assert.equal(cleanRules({ tiers: [1, 2, 3, 4, 5, 6].map((min) => ({ min, color: 'red' })) }).tiers.length, 4);
  assert.deepEqual(cleanRules({ tiers: [] }).tiers, []);
});

test('标签颜色：按次数分档，不按名次', () => {
  assert.deepEqual([2, 4, 5, 9, 10, 19, 20, 50].map((n) => colorOf(n, DEFAULT_RULES)), ['gray', 'gray', 'blue', 'blue', 'orange', 'orange', 'red', 'red']);
  assert.equal(colorOf(99, cleanRules({ tiers: [], baseColor: 'purple' })), 'purple');
});

test('点开某人：窗口内、我帖子下的回复，新的在前', () => {
  const events = [{ ...ev(1, 'a', 1), text: '早' }, ev(2, 'a', 3), ev(3, 'a', 10), { ...ev(4, 'a', 2), root_mine: false }, ev(5, 'b', 1)];
  const d = repliesOf(events, 'a', rules(), NOW);
  assert.deepEqual([d.total, d.items.map((x) => [x.id, x.text])], [2, [['1', '早'], ['2', '']]]);
  assert.equal(repliesOf(events, 'a', rules(), NOW, 1).items.length, 1);
});

test('标签快照：就是榜上的人，键为小写 handle', () => {
  const snap = badgeSnapshot([ev(1, 'a', 1), ev(2, 'a', 10), ev(3, 'b', 2), ev(4, 'c', 3), ev(5, 'c', 16)], rules({ windowDays: 15 }), NOW);
  assert.deepEqual(snap, { a: { rank: 1, count: 2, color: 'gray', last: NOW - DAY_MS } });
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
      tweet('200', '2', { full_text: '@Me @Other 说得对', in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'Me', in_reply_to_status_id_str: '100', conversation_id_str: '100' }), // 评论我的帖子
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
  assert.deepEqual(r.events.map((e) => e.text), ['说得对', '', ''], '摘要去掉开头的 @，拿不到内容就是空串');
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
