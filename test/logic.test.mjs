// 运行：node --test test
// 解析用例的输入是按「预期的接口形态」手写的，验证的是分类与边界逻辑；真实返回是否长这样要靠 README 的实测。
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/content/rel.js';
import { board, ranking, outboundCounts, replyPlaces, repliesOf, badgeSnapshot, underMyPosts, cleanRules, colorOf, DEFAULT_RULES, DAY_MS } from '../src/rank.js';
import { parseMentions, parseMyReplies, ParseError } from '../src/x/parser.js';

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
  const r = cleanRules({ windowDays: 60, topN: 9999, minCount: 0, baseColor: 'pink', tiers: [{ min: 5, color: 'green' }, { min: 30, color: 'nope' }, { min: 5, color: 'red' }, { min: 'x', color: 'red' }] });
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

// ---- 我在别人帖子下的回复 ----

test('我回：按帖子是谁的计数，根帖未知的靠同一对话补判', () => {
  const o = (id, daysAgo, conv, root) => ({ id, created_at: NOW - daysAgo * DAY_MS, conversation_id: conv, root_user_id: root, to_user_id: 'x' });
  const out = [o('1', 1, 'c1', 'a'), o('2', 2, 'c1', null), o('3', 3, 'c2', null), o('4', 10, 'c3', 'a'), o('5', 1, 'c4', 'b')];
  assert.deepEqual([...outboundCounts(out, 7, NOW)], [['a', 2], ['b', 1]]);
  const events = [ev(1, 'a', 1), ev(2, 'a', 2), ev(3, 'b', 1), ev(4, 'b', 2)];
  assert.deepEqual(ranking(events, rules(), NOW, out).rows.map((r) => [r.actor_id, r.replied]), [['a', 2], ['b', 1]]);
  assert.deepEqual(ranking(events, rules(), NOW).rows.map((r) => r.replied), [0, 0], '没有出站数据时是 0');
});

// GraphQL 时间线的假返回：形态与 parseMyReplies 的假设一致
const gt = (id, uid, extra = {}) => ({
  __typename: 'Tweet',
  rest_id: id,
  core: { user_results: { result: { rest_id: uid, core: { screen_name: uid === '1' ? 'Me' : `u${uid}` } } } },
  legacy: { id_str: id, user_id_str: uid, conversation_id_str: id, created_at: 'Thu Nov 12 08:00:00 +0000 2026', full_text: `t${id}`, ...extra },
});
const item = (t) => ({ itemContent: { tweet_results: { result: t } } });
const single = (t) => ({ entryId: `tweet-${t.rest_id}`, content: { entryType: 'TimelineTimelineItem', ...item(t) } });
const thread = (...ts) => ({ entryId: `profile-conversation-${ts[0].rest_id}`, content: { entryType: 'TimelineTimelineModule', items: ts.map((t) => ({ item: item(t) })) } });
const gql = (entries, pinned) => ({
  data: { user: { result: { timeline: { timeline: { instructions: [
    ...(pinned ? [{ type: 'TimelinePinEntry', entry: single(pinned) }] : []),
    { type: 'TimelineAddEntries', entries: [...entries, { entryId: 'cursor-bottom-1', content: { entryType: 'TimelineTimelineCursor', value: 'NEXT', cursorType: 'Bottom' } }] },
  ] } } } } },
});
const re = (to, uid, conv) => ({ in_reply_to_status_id_str: to, in_reply_to_user_id_str: uid, in_reply_to_screen_name: `u${uid}`, conversation_id_str: conv });

test('解析我的回复：只留别人帖子下的，置顶、原创、转发、我自己帖子下的不算', () => {
  const old = { created_at: 'Thu Oct 01 08:00:00 +0000 2026' };
  const body = gql(
    [
      thread(gt('100', '2'), gt('900', '1', { ...re('100', '2', '100'), full_text: '@u2 好文' })), // 直接评论 2 的帖子
      thread(gt('200', '3'), gt('201', '4', re('200', '3', '200')), gt('901', '1', re('201', '4', '200'))), // 在 3 的帖子下回 4：算 3 的
      thread(gt('902', '1', re('301', '5', '300'))), // 根帖没带出来：root 未知
      thread(gt('400', '1', old), gt('401', '2', re('400', '1', '400')), gt('903', '1', re('401', '2', '400'))), // 我自己帖子下回 2：不要
      single(gt('904', '1')), // 原创
      single(gt('905', '1', { retweeted_status_result: { result: gt('50', '1', { ...old, ...re('49', '2', '49') }) } })), // 转发自己的旧回复：原帖不看
    ],
    gt('10', '1', old),
  );
  const r = parseMyReplies(body, me);
  assert.deepEqual(r.events.map((e) => [e.id, e.root_user_id, e.to_user_id, e.text]), [
    ['900', '2', '2', '好文'],
    ['901', '3', '4', 't901'],
    ['902', null, '5', 't902'],
  ]);
  assert.deepEqual(r.events.map((e) => e.root_handle), ['u2', 'u3', null], '根帖主人的 @ID 只给导出用');
  assert.deepEqual([r.newestId, r.oldestId, r.bottomCursor], ['905', '900', 'NEXT'], '范围只看每个条目里我发的最后一条');
  assert.equal(new Date(r.oldestTs).getUTCMonth(), 10, '置顶帖和被回复的旧帖不拉低时间范围');
});

test('解析我的回复：结构不对或 X 报错就抛错', () => {
  assert.throws(() => parseMyReplies({ data: {} }, me), ParseError);
  assert.throws(() => parseMyReplies({ errors: [{ message: 'features cannot be null' }] }, me), /features cannot be null/);
  assert.throws(() => parseMyReplies(gql([{ entryId: 'tweet-1', content: { something: 'new' } }]), me), ParseError);
  assert.deepEqual(parseMyReplies({ data: { x: { instructions: [] } } }, me).events, [], '空列表不算错');
});

test('关系：从 X 的返回里挑出每个人和我的关注关系，新旧两种结构都认', () => {
  const { extract, relOf } = globalThis.XIRRel;
  const body = {
    data: {
      a: { __typename: 'User', rest_id: '2', core: { screen_name: 'Mutual' }, relationship_perspectives: { following: true, followed_by: true }, legacy: {} },
      b: [{ rest_id: '3', legacy: { screen_name: 'Fan', followed_by: true } }],
      c: { rest_id: '4', core: { screen_name: 'Idol' }, relationship_perspectives: { following: true } },
      d: { rest_id: '5', core: { screen_name: 'Stranger' }, relationship_perspectives: { following: false, followed_by: false } },
      e: { rest_id: '6', core: { screen_name: 'Unknown' }, legacy: {} }, // 没有任何关系字段：不知道，不记
    },
    globalObjects: { users: { 7: { id_str: '7', screen_name: 'Rest', following: false, followed_by: true } } },
  };
  const got = Object.fromEntries(extract(body).users.map((u) => [u.handle, relOf(u)]));
  assert.deepEqual(got, { mutual: 'mutual', fan: 'fan', idol: 'following', stranger: 'none', rest: 'fan' });
});

test('帖子归属：页面数据能定的直接定，定不了的靠本机两张表', () => {
  const { extract, placeOf } = globalThis.XIRRel;
  const tw = (id, uid, conv, rtoStatus, rtoUser) => ({ rest_id: id, legacy: { user_id_str: uid, conversation_id_str: conv, in_reply_to_status_id_str: rtoStatus, in_reply_to_user_id_str: rtoUser } });
  const body = { x: [tw('10', '1', '10'), tw('11', '2', '10', '10', '1'), tw('20', '2', '20'), tw('22', '2', '20', '21', '1'), tw('30', '3', '30'), tw('32', '2', '30', '31', '1'), tw('42', '2', '40', '41', '1'), tw('50', '2', '50', '49', '9')] };
  const tweets = new Map(extract(body).tweets.map((t) => [t.id, t]));
  assert.equal(tweets.size, 8);
  assert.deepEqual(['11', '22', '32', '42', '50', '99'].map((id) => placeOf(id, '1', tweets)), ['me', 'him', 'other', null, null, null]);

  // 本机数据：入站事件 + 我回别人
  const inb = (id, actor, conv, rootMine) => ({ id, actor_id: actor, conversation_id: conv, root_mine: rootMine, created_at: 1 });
  const events = [inb('a', '2', 'c1', true), inb('b', '2', 'c2', false), inb('c', '2', 'c3', false), inb('d', '2', 'c4', false)];
  const out = [{ id: 'o1', conversation_id: 'c2', root_user_id: '2' }, { id: 'o2', conversation_id: 'c3', root_user_id: '8' }];
  assert.deepEqual(replyPlaces(events, out, ['a', 'b', 'c', 'd', 'zz']), { a: 'me', b: 'him', c: 'other', d: null, zz: null });
});
