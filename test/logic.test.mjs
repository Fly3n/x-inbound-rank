// 运行：node --test test
// 解析用例的输入是按「预期的接口形态」手写的，验证的是分类与边界逻辑；真实返回是否长这样要靠 README 的实测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import '../src/content/rel.js';
import '../src/content/schedule.js';
import {
  ranking, outboundCounts, countsFromMe, replyPlaces, repliesOf, badgeSnapshot, underMyPosts,
  cleanRules, colorOf, DEFAULT_RULES, DAY_MS, inboundInitCovered, outboundInitCovered,
} from '../src/rank.js';
import {
  parseCreatedReply, parseMentions, parseNotificationsTap, parseMyReplies, parseScheduledTweets,
  repliesTapTargetUserId, repliesTapHasCursor, detectAccountAnomaly, ParseError,
} from '../src/x/parser.js';

const board = (events, rules, now) => ranking(events, rules, now).rows;

const NOW = Date.UTC(2026, 10, 13);
const ev = (id, actor, daysAgo) => ({
  id: String(id), actor_id: actor, actor_handle: actor.toUpperCase(), actor_name: actor, actor_avatar: '', created_at: NOW - daysAgo * DAY_MS, conversation_id: 'c' + id, target_post_id: 'c' + id, root_mine: true, // 直接评论我的帖子 c{id}
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
  assert.equal(DEFAULT_RULES.outAutoSync, false);
  const r = cleanRules({ windowDays: 45, topN: 9999, minCount: 0, baseColor: 'pink', outAutoSync: true, showRel: false, showPlace: 0, tiers: [{ min: 5, color: 'green' }, { min: 30, color: 'nope' }, { min: 5, color: 'red' }, { min: 'x', color: 'red' }] });
  // 显示开关：只有明确写 false 才是关
  assert.deepEqual(r, { windowDays: 7, initDays: 7, outAutoSync: true, topN: 500, minCount: 1, baseColor: 'gray', showRank: true, showOut: true, showRel: false, showPlace: true, showSchedule: true, tiers: [{ min: 30, color: 'gray' }, { min: 5, color: 'green' }] });
  assert.equal(cleanRules({ topN: 3 }).topN, 10);
  assert.equal(cleanRules({ tiers: [1, 2, 3, 4, 5, 6].map((min) => ({ min, color: 'red' })) }).tiers.length, 4);
  assert.deepEqual(cleanRules({ tiers: [] }).tiers, []);
});

test('两个范围：榜单范围可到 3 个月，补历史范围只有 7/15；旧 30 天降级到 15，老设置沿用当时统计范围', () => {
  assert.deepEqual([60, 90].map((d) => cleanRules({ windowDays: d }).windowDays), [60, 90]);
  assert.equal(cleanRules({ initDays: 60 }).initDays, 7);
  assert.equal(cleanRules({ initDays: 30 }).initDays, 15, '旧版 30 天设置平滑降级为 15 天');
  assert.equal(cleanRules({ windowDays: 15 }).initDays, 15, '0.10 存的设置：统计范围 15 天，补历史也按 15 天');
  assert.equal(cleanRules({ windowDays: 90 }).initDays, 7);
  // 榜单范围比补历史长：照常按榜单范围算
  const evs = [ev(1, 'a', 50), ev(2, 'a', 80), ev(3, 'a', 95)];
  assert.equal(board(evs, rules({ windowDays: 90, minCount: 1 }), NOW)[0].count, 2);
});

test('覆盖判定：提前到底不冒充覆盖，完整到底才算数', () => {
  const out = (patch) => ({ lastAt: NOW, schema: 2, ...patch });

  assert.equal(inboundInitCovered({ oldestTs: NOW - 8 * DAY_MS }, '100', 7, NOW), true);
  assert.equal(inboundInitCovered({ oldestTs: NOW - 3 * DAY_MS, reachedEnd: true }, '100', 7, NOW), false);
  assert.equal(inboundInitCovered({ oldestTs: null, reachedEnd: true }, '100', 7, NOW), true, '空列表到底也覆盖');
  assert.equal(inboundInitCovered({ oldestTs: NOW - 8 * DAY_MS }, null, 7, NOW), false);

  assert.equal(outboundInitCovered(out({ coverTs: NOW - 8 * DAY_MS, reachedEnd: false }), 7, NOW), true);
  assert.equal(outboundInitCovered(out({ coverTs: NOW - 3 * DAY_MS, reachedEnd: true }), 7, NOW), false);
  assert.equal(outboundInitCovered(out({ coverTs: null, reachedEnd: true }), 7, NOW), true);
});

test('标签颜色：按次数分档，不按名次', () => {
  assert.deepEqual([2, 4, 5, 9, 10, 19, 20, 50].map((n) => colorOf(n, DEFAULT_RULES)), ['gray', 'gray', 'blue', 'blue', 'orange', 'orange', 'red', 'red']);
  assert.equal(colorOf(99, cleanRules({ tiers: [], baseColor: 'purple' })), 'purple');
});

test('点开某人：窗口内、我帖子下的回复，新的在前', () => {
  const events = [{ ...ev(1, 'a', 1), text: '早' }, ev(2, 'a', 3), ev(3, 'a', 10), { ...ev(4, 'a', 2), root_mine: false }, { ...ev(6, 'a', 1.5), target_post_id: 'deep' }, ev(5, 'b', 1)];
  const d = repliesOf(events, 'a', rules(), NOW);
  assert.deepEqual([d.total, d.items.map((x) => [x.id, x.text])], [3, [['1', '早'], ['6', ''], ['2', '']]], '深层回复也算，别人帖子下的不算');
  assert.equal(repliesOf(events, 'a', rules(), NOW, 1).items.length, 1);
});

test('点开某人：我回他的时间和原帖 ID 对应榜单次数', () => {
  const out = (id, days, patch = {}) => ({
    id, created_at: NOW - days * DAY_MS, conversation_id: 'root', reply_to_id: 'root', root_user_id: 'a', ...patch,
  });
  const sent = [
    out('older', 7), out('newer', 1), out('after-now', -1), out('out-of-range', 8),
    out('deep', 1, { reply_to_id: 'comment' }), out('mine', 1, { own: true }),
    out('another-author', 1, { root_user_id: 'b' }),
  ];
  const { outbound } = repliesOf([], 'a', rules(), NOW, 1, sent);
  assert.equal(outbound.total, outboundCounts(sent, 7, NOW).get('a'));
  assert.deepEqual(outbound, { total: 2, items: [{ id: 'newer', created_at: NOW - DAY_MS, text: '' }] });
  assert.deepEqual(repliesOf([], 'a', rules(), NOW, 50, sent).outbound.items.map(({ id }) => id), ['newer', 'older']);
});

test('标签快照：就是榜上的人，键为小写 handle', () => {
  const snap = badgeSnapshot([ev(1, 'a', 1), ev(2, 'a', 10), ev(3, 'b', 2), ev(4, 'c', 3), ev(5, 'c', 16)], rules({ windowDays: 15 }), NOW, [], false);
  assert.deepEqual(snap, { a: { rank: 1, count: 2, color: 'gray', last: NOW - DAY_MS } });
  // 「我回别人」读过之后带上我回他几次；一次没回是 0
  const mine = [{ id: 'o1', created_at: NOW - DAY_MS, conversation_id: 'x1', reply_to_id: 'x1', root_user_id: 'a' }, { id: 'o2', created_at: NOW - 20 * DAY_MS, conversation_id: 'x2', reply_to_id: 'x2', root_user_id: 'a' }];
  const evs = [ev(1, 'a', 1), ev(2, 'a', 10)];
  assert.equal(badgeSnapshot(evs, rules({ windowDays: 15 }), NOW, mine).a.replied, 1);
  assert.equal(badgeSnapshot(evs, rules({ windowDays: 15 }), NOW, []).a.replied, 0);
});

test('口径：别人回我，在我帖子下回我的都算、不分层；别人帖子下的不算', () => {
  const e = (id, conv, target, root_mine) => ({ ...ev(id, 'a', 1), conversation_id: conv, target_post_id: target, root_mine });
  const events = [
    e(1, 'p', 'p', true), // 直接评论我的帖子 p
    e(2, 'p', 'my-comment', null), // 我帖子下：他评论 → 我回他 → 他再回我。根帖看不出来，但同一对话里第 1 条证明是我的
    e(3, 'q', 'x', false), // 别人的帖子（包括他自己的）下回我
    e(4, 'r', 'x', null), // 看不出根帖是谁的、也没有旁证：不算
    e(5, 's', 'my-thread', null), // 我自己串推下回我：「我回别人」表里我在 s 下回过（own），证明 s 是我的
  ];
  const own = [{ id: 'o', own: true, conversation_id: 's', reply_to_id: 's', root_user_id: '1', created_at: NOW - DAY_MS }];
  assert.deepEqual(ranking(events, rules(), NOW).rows.map((r) => r.count), [2]);
  assert.deepEqual(ranking(events, rules(), NOW, own).rows.map((r) => [r.count, r.replied]), [[3, 0]], 'own 只用来认对话，不算「我回 N」');
});

test('通知列表 M 的「在我帖子下」不分层：根帖归属未知的靠同一对话补判', () => {
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
  assert.equal(r.newestTs, Date.parse('Thu Nov 12 08:00:00 +0000 2026'));
  // 被引用的旧帖 100 不在时间线条目里，不能把「本页最早时间」拉回到 1 月
  assert.equal(r.oldestId, '200');
  assert.equal(new Date(r.oldestTs).getUTCMonth(), 10);
});

// 新接口 NotificationsTimeline 的返回（按 2026-11-19 小号实测的结构）
const nt = (id, uid, screen, extra = {}) => ({
  entryId: `notification-${id}`,
  content: {
    entryType: 'TimelineTimelineItem',
    clientEventInfo: { element: 'user_replied_to_your_tweet' },
    itemContent: { itemType: 'TimelineTweet', tweet_results: { result: { __typename: 'Tweet', core: { user_results: { result: { rest_id: uid, core: { screen_name: screen, name: screen }, avatar: { image_url: `https://pbs.twimg.com/${uid}.jpg` } } } }, legacy: { id_str: id, user_id_str: uid, created_at: 'Thu Nov 12 08:00:00 +0000 2026', ...extra } } } },
  },
});
const notif = (entries, bottom = 'B') => ({
  data: { viewer_v2: { user_results: { result: { notification_timeline: { timeline: { instructions: [
    { type: 'TimelineClearCache' },
    { type: 'TimelineAddEntries', entries: [{ entryId: 'cursor-top', content: { cursorType: 'Top', value: 'T' } }, ...entries, ...(bottom ? [{ entryId: 'cursor-bottom', content: { cursorType: 'Bottom', value: bottom } }] : [])] },
  ] } } } } } },
});

test('解析新接口的提及：和旧接口一样分类', () => {
  const r = parseMentions(
    notif([
      nt('500', '2', 'Fan', { full_text: '@Me 好', in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'Me', in_reply_to_status_id_str: '100', conversation_id_str: '100' }),
      nt('501', '2', 'Fan', { in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'Me', in_reply_to_status_id_str: '170', conversation_id_str: '90' }),
      nt('502', '3', 'Other', {}), // 普通提及
    ]),
    me,
  );
  assert.deepEqual(r.events.map((e) => [e.id, e.actor_handle, e.root_mine, e.text, e.actor_avatar]), [
    ['500', 'Fan', true, '好', 'https://pbs.twimg.com/2.jpg'],
    ['501', 'Fan', null, '', 'https://pbs.twimg.com/2.jpg'],
  ]);
  assert.deepEqual([r.entryIds.length, r.newestId, r.oldestId, r.bottomCursor], [3, '502', '500', 'B']);
  assert.deepEqual(parseMentions(notif([], null), me).events, [], '空列表不算错');
  assert.throws(() => parseMentions({ errors: [{ message: 'boom' }] }, me), /boom/);
});

test('解析新接口：条目结构变了就报错，不冒充空列表', () => {
  const modular = {
    entryId: 'notification-module',
    content: {
      entryType: 'TimelineTimelineModule',
      items: [{ item: { itemContent: nt('503', '2', 'Fan', { in_reply_to_user_id_str: '1', in_reply_to_status_id_str: '100', conversation_id_str: '100' }).content.itemContent } }],
    },
  };
  assert.deepEqual(parseMentions(notif([modular]), me).events.map((e) => e.id), ['503'], '模块里包着的帖子也要解析');
  const unavailable = (type) => ({
    entryId: `notification-${type}`,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: { itemType: 'TimelineTweet', tweet_results: { result: { __typename: type } } },
    },
  });
  assert.deepEqual(
    parseMentions(notif([
      nt('505', '2', 'Fan', { in_reply_to_user_id_str: '1', in_reply_to_status_id_str: '100', conversation_id_str: '100' }),
      unavailable('TweetUnavailable'),
      unavailable('TweetTombstone'),
    ]), me).events.map((e) => e.id),
    ['505'],
    '正常的不可用条目只跳过自己，不能拖垮同页其它回复',
  );
  assert.throws(
    () => parseMentions(notif([{ entryId: 'future-1', content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineFuture' } } }]), me),
    /无法识别或缺少内容/,
  );
  assert.throws(
    () => parseMentions(notif([{ entryId: 'future-2', content: { entryType: 'TimelineFutureModule', items: [] } }]), me),
    /无法识别或缺少内容/,
  );
  assert.throws(
    () => parseMentions(notif([{ entryId: 'missing-content', content: null }]), me),
    /无法识别或缺少内容/,
  );
  assert.throws(
    () => parseMentions(notif([
      nt('506', '2', 'Fan', { in_reply_to_user_id_str: '1', in_reply_to_status_id_str: '100', conversation_id_str: '100' }),
      { entryId: 'missing-content-2', content: null },
    ]), me),
    /无法识别或缺少内容/,
    '同页有正常帖子时，异常条目也不能被静默丢掉',
  );
});

test('解析：只有手填 handle、没有用户 ID 时靠 screen_name 匹配', () => {
  const b = body([tweet('300', '2', { in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'ME', in_reply_to_status_id_str: '100', conversation_id_str: '100' })], ['300']);
  assert.equal(parseMentions(b, { handle: 'me', userId: null }).events.length, 1);
});

test('解析：数字 ID 优先；缺 handle 也能入库和算榜', () => {
  const b = body([tweet('301', '2', { in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'Me', in_reply_to_status_id_str: '100', conversation_id_str: '100' })], ['301']);
  b.globalObjects.users[2] = { ...user('2', 'Me'), screen_name: undefined, name: undefined };
  const parsed = parseMentions(b, me);
  assert.equal(parsed.events.length, 1, '数字 ID 不等于我时，不能拿同名的 handle 兜底');
  assert.deepEqual([parsed.events[0].actor_handle, parsed.events[0].actor_name], ['', '']);
  const row = ranking(parsed.events, rules({ minCount: 1 }), NOW).rows[0];
  assert.deepEqual([row.handle, row.name], ['2', '2']);
  assert.doesNotThrow(() => badgeSnapshot(parsed.events, rules({ minCount: 1 }), NOW));
});

test('解析：作者资料整块缺失时保留数字 ID，不静默丢回复', () => {
  const b = body([tweet('302', '2', { in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'Me', in_reply_to_status_id_str: '100', conversation_id_str: '100' })], ['302']);
  delete b.globalObjects.users[2];
  const parsed = parseMentions(b, me);
  assert.deepEqual([parsed.events.length, parsed.events[0].actor_id, parsed.events[0].actor_handle], [1, '2', '']);
  assert.deepEqual(ranking(parsed.events, rules({ minCount: 1 }), NOW).rows.map((r) => [r.handle, r.name]), [['2', '2']]);
});

test('解析：帖子有编号但作者数字 ID 缺失时整页报错，不悄悄漏一条', () => {
  const missing = tweet('303', '2', { in_reply_to_user_id_str: '1', in_reply_to_status_id_str: '100', conversation_id_str: '100' });
  delete missing.user_id_str;
  assert.throws(() => parseMentions(body([missing], ['303']), me), /作者的数字用户 ID/);

  const gqlMissing = nt('504', '2', 'Fan', {});
  delete gqlMissing.content.itemContent.tweet_results.result.legacy.user_id_str;
  delete gqlMissing.content.itemContent.tweet_results.result.core.user_results.result.rest_id;
  assert.throws(() => parseMentions(notif([gqlMissing]), me), /作者数字 ID/);

  const myMissing = gt('906', '1', re('100', '2', '100'));
  delete myMissing.legacy.user_id_str;
  delete myMissing.core.user_results.result.rest_id;
  assert.throws(() => parseMyReplies(gql([single(myMissing)]), me), /作者数字 ID/);
});

test('解析：结构不对就报错，不返回空结果', () => {
  assert.throws(() => parseMentions({ data: {} }, me), ParseError);
  assert.throws(() => parseMentions({ foo: 1 }, me), ParseError);
  assert.throws(() => parseMentions(body([], ['999']), me), ParseError);
  assert.equal(parseMentions(body([], [], null), me).bottomCursor, null); // 空列表是合法的「到底了」
  // 实测到的空账号返回：globalObjects 是 {}，时间线里只有一个 Top 游标
  const empty = { globalObjects: {}, timeline: { id: 'x', instructions: [{ clearCache: {} }, { addEntries: { entries: [{ entryId: 'cursor-top-1', content: { operation: { cursor: { value: 'T', cursorType: 'Top' } } } }] } }] } };
  assert.deepEqual(parseMentions(empty, me), { events: [], entryIds: [], newestId: null, newestTs: null, oldestId: null, oldestTs: null, bottomCursor: null });
});

// ---- 我在别人帖子下的回复 ----

test('我回：只算我直接评论他的帖子（第一级），记在帖子主人名下', () => {
  const o = (id, daysAgo, conv, root, replyTo = conv) => ({ id, created_at: NOW - daysAgo * DAY_MS, conversation_id: conv, reply_to_id: replyTo, root_user_id: root, to_user_id: 'x' });
  const out = [
    o('1', 1, 'c1', 'a'), // 直接评论 a 的帖子
    o('2', 2, 'c1', 'a', 'cmt'), // 在 a 的帖子下回评论：不算
    o('3', 3, 'c2', null, 'cmt'), // 根帖不明的深层回复：不算
    o('6', 2, 'c5', 'a'), // 又一次直接评论 a
    o('4', 10, 'c3', 'a'), // 窗口外
    o('5', 1, 'c4', 'b'),
    { ...o('7', 1, 'c6', 'b'), reply_to_id: undefined }, // 旧版本存的，没有 reply_to_id：判断不了，不算
  ];
  assert.deepEqual([...outboundCounts(out, 7, NOW)], [['a', 2], ['b', 1]]);
  assert.equal(countsFromMe(out[1]), false);
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
  assert.deepEqual(r.events.map((e) => [e.id, e.root_user_id, e.to_user_id, e.text, !!e.own]), [
    ['900', '2', '2', '好文', false],
    ['901', '3', '4', 't901', false],
    ['902', null, '5', 't902', false],
    ['903', '1', '2', 't903', true], // 我自己帖子下的：留着认对话，标 own，不计数
  ]);
  assert.equal(countsFromMe(r.events[3]), false);
  assert.deepEqual(r.events.map((e) => e.root_handle), ['u2', 'u3', null, 'Me'], '根帖主人的 @ID 只给导出用');
  assert.deepEqual([r.newestId, r.oldestId, r.bottomCursor], ['905', '900', 'NEXT'], '范围只看每个条目里我发的最后一条');
  assert.equal(r.newestTs, Date.parse('Thu Nov 12 08:00:00 +0000 2026'));
  assert.equal(new Date(r.oldestTs).getUTCMonth(), 10, '置顶帖和被回复的旧帖不拉低时间范围');
});

test('解析我的回复：结构不对或 X 报错就抛错', () => {
  assert.throws(() => parseMyReplies({ data: {} }, me), ParseError);
  assert.throws(() => parseMyReplies({ errors: [{ message: 'features cannot be null' }] }, me), /features cannot be null/);
  assert.throws(() => parseMyReplies(gql([{ entryId: 'tweet-1', content: { something: 'new' } }]), me), ParseError);
  assert.throws(() => parseMyReplies(gql([{ entryId: 'tweet-null', content: null }]), me), /解析不出帖子内容/);
  assert.throws(
    () => parseMyReplies(gql([
      single(gt('907', '1', re('100', '2', '100'))),
      { entryId: 'tweet-null-2', content: null },
    ]), me),
    /解析不出帖子内容/,
    '同页有正常回复时，异常条目也不能被静默丢掉',
  );
  const unavailable = (type) => ({
    entryId: `tweet-${type}`,
    content: { entryType: 'TimelineTimelineItem', itemContent: { tweet_results: { result: { __typename: type } } } },
  });
  const mixed = parseMyReplies(gql([
    single(gt('908', '1', re('100', '2', '100'))),
    unavailable('TweetUnavailable'),
    unavailable('TweetTombstone'),
  ]), me);
  assert.deepEqual(mixed.events.map((e) => e.id), ['908'], '不可用回复只跳过自己');
  assert.throws(
    () => parseMyReplies(gql([unavailable('TweetUnavailable')]), me),
    /只有不可用的帖子/,
    '整页都无法判断范围时不能冒充空列表',
  );
  assert.deepEqual(parseMyReplies({ data: { x: { instructions: [] } } }, me).events, [], '空列表不算错');
});

test('解析：账号没有 handle 时只用用户 ID 也能工作', () => {
  const noHandle = { userId: '1', handle: null };
  const mentions = body(
    [tweet('300', '2', { in_reply_to_user_id_str: '1', in_reply_to_status_id_str: '100', conversation_id_str: '100' })],
    ['300'],
  );
  assert.equal(parseMentions(mentions, noHandle).events.length, 1);
  const replies = gql([thread(gt('100', '2'), gt('900', '1', re('100', '2', '100')))]);
  assert.equal(parseMyReplies(replies, noHandle).events.length, 1);
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

// ---- 发帖排期辅助 ----

test('解析已排期列表：兼容秒和毫秒时间戳，按时间升序，结构不对抛错', () => {
  const t1 = 1_795_000_000; // 秒
  const t2 = 1_795_003_600_000; // 毫秒
  const body = {
    data: {
      viewer: {
        scheduled_tweet_list: [
          { rest_id: 's2', scheduling_info: { execute_at: t2 }, tweet_create_request: { status: '第二条  排期帖子' } },
          { rest_id: 's1', scheduling_info: { execute_at: t1 }, tweet_create_request: { status: '第一条排期' } },
        ],
      },
    },
  };
  assert.deepEqual(parseScheduledTweets(body), [
    { id: 's1', executeAt: t1 * 1000, text: '第一条排期' },
    { id: 's2', executeAt: t2, text: '第二条 排期帖子' },
  ]);
  assert.deepEqual(parseScheduledTweets({ data: { viewer: { scheduled_tweet_list: [] } } }), [], '空排期列表不算错');
  assert.throws(() => parseScheduledTweets({ errors: [{ message: 'denied' }] }), /denied/);
  assert.throws(() => parseScheduledTweets({ data: {} }), ParseError);
  assert.throws(() => parseScheduledTweets({ data: { viewer: { scheduled_tweet_list: [{ rest_id: 'bad' }] } } }), ParseError);
});

test('detectAccountAnomaly：精准识别 401/403、cf-mitigated、非 5xx HTML 挑战与锁定错误码，不误伤 429/503/404', () => {
  assert.equal(detectAccountAnomaly(401, {})?.code, 401);
  assert.equal(detectAccountAnomaly(403, { errors: [{ code: 326, message: 'Account is locked' }] })?.code, 326);
  assert.equal(detectAccountAnomaly(200, { errors: [{ code: 226, message: 'This request looks like it might be automated.' }] })?.code, 226);
  assert.equal(detectAccountAnomaly(200, { errors: [{ code: 64, message: 'Your account is suspended' }] })?.code, 64);
  assert.ok(detectAccountAnomaly(200, { errors: [{ kind: 'Bounce', message: 'Challenge required' }] }));
  assert.equal(detectAccountAnomaly(200, undefined, { cfMitigated: 'challenge', error: 'not_json' })?.code, 'cf_mitigated');
  assert.equal(detectAccountAnomaly(200, undefined, { error: 'not_json', contentType: 'text/html; charset=utf-8', detail: '<!DOCTYPE html><title>Just a moment...</title>' })?.code, 'html_challenge');
  assert.equal(detectAccountAnomaly(503, undefined, { error: 'not_json', contentType: 'text/html', detail: '<!DOCTYPE html>503 Service Unavailable' }), null, '5xx 临时网关错误页不能误触发硬熔断');
  assert.equal(detectAccountAnomaly(429, { errors: [{ code: 88, message: 'Rate limit exceeded' }] }), null);
  assert.equal(detectAccountAnomaly(503, {}), null);
  assert.equal(detectAccountAnomaly(404, {}), null);
  assert.equal(detectAccountAnomaly(200, { data: {} }), null);
});

test('排期档位：07:00–24:00 半小时一档，过去与过近的档跳过，刚发帖后自动顺延', () => {
  const { buildDaySlots, buildSchedulePlan } = globalThis.XIRSchedule;
  const at = (h, m, dayOffset = 0) => new Date(2026, 10, 20 + dayOffset, h, m, 0, 0).getTime();

  // 中午 12:00 打开：上午的都不显示，第一个档是 12:30，最后一个是 24:00
  const noon = buildDaySlots({ nowTs: at(12, 0), dayOffset: 0 });
  assert.equal(noon.slots[0].label, '12:30');
  assert.equal(noon.slots[noon.slots.length - 1].label, '24:00');

  // 12:25 打开：距离 12:30 不足 10 分钟，首个档顺延到 13:00
  const tight = buildDaySlots({ nowTs: at(12, 25), dayOffset: 0 });
  assert.equal(tight.slots[0].label, '13:00');

  // 12:19 刚发过主帖，12:20 打开：12:19 + 30m = 12:49 > 12:30，跳过 12:30 从 13:00 开始
  const justPosted = buildDaySlots({ nowTs: at(12, 20), dayOffset: 0, lastPostAt: at(12, 19) });
  assert.equal(justPosted.slots[0].label, '13:00');
  // 12:05 刚发过主帖，12:20 打开：12:05 + 30m = 12:35 > 12:30，同样跳过 12:30 从 13:00 开始
  const postedEarlier = buildDaySlots({ nowTs: at(12, 20), dayOffset: 0, lastPostAt: at(12, 5) });
  assert.equal(postedEarlier.slots[0].label, '13:00');

  // 明天完整覆盖 07:00–24:00（共 35 档）
  const plan = buildSchedulePlan({ nowTs: at(12, 0), days: 7 });
  assert.equal(plan.groups.length, 7);
  assert.equal(plan.groups[1].slots.length, 35);
  assert.equal(plan.groups[1].slots[0].label, '07:00');
  assert.equal(plan.groups[1].slots[34].label, '24:00');
});

test('排期冲突与安全间距：硬性 25 分钟防撞、优先贴合 30–40 分钟、夹缝档自动置灰与上下空档', () => {
  const { buildDaySlots, buildSchedulePlan, availableSlots, pickJitteredTime } = globalThis.XIRSchedule;
  const at = (h, m) => new Date(2026, 10, 20, h, m, 0, 0).getTime();
  const scheduled = [
    { id: '1', executeAt: at(15, 22), text: '下午茶' }, // 落在 15:30 档 [15:15, 15:45)
    { id: '2', executeAt: at(15, 45), text: '边界测试' }, // 正好 15:45，归入 16:00 档 [15:45, 16:15)，不重复占 15:30
  ];
  const day = buildDaySlots({ nowTs: at(14, 0), dayOffset: 0, scheduled });
  const byLabel = Object.fromEntries(day.slots.map((s) => [s.label, s]));
  assert.equal(byLabel['15:00'].occupied, false);
  assert.equal(byLabel['15:30'].occupied, true);
  assert.deepEqual(byLabel['15:30'].items.map((x) => x.id), ['1']);
  assert.equal(byLabel['16:00'].occupied, true);
  assert.deepEqual(byLabel['16:00'].items.map((x) => x.id), ['2']);
  assert.equal(byLabel['16:30'].occupied, false);

  // 点「具体档位 15:00」：15:22 已排，±1-3m 内（14:57-15:03）里 14:57 与 15:22 相距恰好 25 分钟，满足硬性安全间距
  for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
    const picked = pickJitteredTime(at(15, 0), { nowTs: at(14, 0), scheduled, random: () => r, mode: 'slot' });
    const diffMin = Math.round((picked - at(15, 0)) / 60_000);
    const gapMin = Math.round(Math.abs(picked - at(15, 22)) / 60_000);
    assert.ok(Math.abs(diffMin) >= 1 && Math.abs(diffMin) <= 3, `点具体档位应小幅浮动 ±1-3m，实际 ${diffMin} 分钟`);
    assert.ok(gapMin >= 25, `与 15:22 间距必须 >= 25 分钟，实际 ${gapMin} 分钟`);
  }

  // 点「下一空档 →」：前一条在 21:05（占 21:00），后面无排期 -> 落在 21:35–21:45（距 21:05 正好 30–40 分钟）
  const tightPrev = [{ id: 'p', executeAt: at(21, 5), text: '上一条' }];
  for (const r of [0, 0.3, 0.7, 0.99]) {
    const picked = pickJitteredTime(at(21, 30), { nowTs: at(20, 0), scheduled: tightPrev, random: () => r, mode: 'next' });
    const gapMin = Math.round((picked - at(21, 5)) / 60_000);
    assert.ok(gapMin >= 30 && gapMin <= 40, `应距 21:05 间隔 30-40 分钟，实际 ${gapMin} 分钟`);
  }

  // 点「下一空档 →」：前后正好差 1 小时（21:00 与 22:00）-> 居中均分落在 21:27–21:33（两边各 27–33 分钟）
  const oneHourGap = [
    { id: 'h1', executeAt: at(21, 0), text: '前' },
    { id: 'h2', executeAt: at(22, 0), text: '后' },
  ];
  for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
    const picked = pickJitteredTime(at(21, 30), { nowTs: at(20, 0), scheduled: oneHourGap, random: () => r, mode: 'next' });
    const gapPrev = Math.round((picked - at(21, 0)) / 60_000);
    const gapNext = Math.round((at(22, 0) - picked) / 60_000);
    assert.ok(gapPrev >= 27 && gapPrev <= 33 && gapNext >= 27 && gapNext <= 33, `1 小时夹缝应居中均分，实际前 ${gapPrev}m / 后 ${gapNext}m`);
  }

  // 夹缝档检测：20:50 与 21:35 之间仅隔 45 分钟，21:00 与 21:30 周围都没有 >=25m 的安全分钟，均自动置灰
  const squeezed = [
    { id: 'a', executeAt: at(20, 50), text: '前' },
    { id: 'b', executeAt: at(21, 35), text: '后' },
  ];
  const squeezedDay = buildDaySlots({ nowTs: at(20, 0), dayOffset: 0, scheduled: squeezed });
  const sqMap = Object.fromEntries(squeezedDay.slots.map((s) => [s.label, s]));
  assert.equal(sqMap['21:00'].occupied, true);
  assert.equal(sqMap['21:30'].occupied, true);
  assert.equal(sqMap['22:00'].occupied, false);

  // availableSlots 按时间顺序列出全部未占用空档，供「← 上一档」「下一空档 →」使用
  const free = availableSlots(buildSchedulePlan({ nowTs: at(20, 0), days: 2, scheduled: squeezed }));
  assert.equal(free[0].label, '20:30');
  assert.ok(!free.some((s) => s.ts === at(21, 0) || s.ts === at(21, 30)));

  // 无紧邻排期时：点具体档位做 ±1–3 分钟小幅浮动；点「下一空档」做 ±5–12 分钟自然浮动
  for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
    const pickedSlot = pickJitteredTime(at(15, 0), { nowTs: at(14, 0), scheduled: [], random: () => r, mode: 'slot' });
    const diffSlot = Math.round((pickedSlot - at(15, 0)) / 60_000);
    assert.ok(Math.abs(diffSlot) >= 1 && Math.abs(diffSlot) <= 3, `无紧邻排期点具体档位应浮动 1-3 分钟，实际 ${diffSlot}`);
    const pickedNext = pickJitteredTime(at(15, 0), { nowTs: at(14, 0), scheduled: [], random: () => r, mode: 'next' });
    const diffNext = Math.round((pickedNext - at(15, 0)) / 60_000);
    assert.ok(Math.abs(diffNext) >= 5 && Math.abs(diffNext) <= 12, `无紧邻排期点下一空档应浮动 5-12 分钟，实际 ${diffNext}`);
  }

  // 首尾档位浮动不能越出当天 07:00–24:00
  const tomorrow = buildDaySlots({ nowTs: at(12, 0), dayOffset: 1 });
  const firstSlot = tomorrow.slots[0];
  const lastSlot = tomorrow.slots.at(-1);
  const firstPicked = pickJitteredTime(firstSlot.ts, { nowTs: at(12, 0), dayStart: firstSlot.dayStart, random: () => 0 });
  const lastPicked = pickJitteredTime(lastSlot.ts, { nowTs: at(12, 0), dayStart: lastSlot.dayStart, random: () => 0.999 });
  assert.ok(firstPicked >= firstSlot.ts, '07:00 档不能向前浮动到早上 7 点前');
  assert.ok(lastPicked <= lastSlot.ts, '24:00 档不能向后浮动到次日');

  // 实际填入也要避开「现在 10 分钟」和「刚发主帖 30 分钟」两个门槛
  const boundarySlot = buildDaySlots({ nowTs: at(12, 50), scheduled: [], lastPostAt: at(12, 45) }).slots.find((slot) => slot.ts === at(13, 30));
  const boundaryPicked = pickJitteredTime(boundarySlot.ts, {
    nowTs: at(12, 50), scheduled: [], lastPostAt: at(12, 45), random: () => 0,
  });
  assert.ok(boundaryPicked >= at(13, 15), '浮动后不能早于最近主帖 30 分钟');

  // 前后参考时间差计算：有上一条和下一条都返回；后面无排期时 next 为 null；刚发主帖比更早排期近时优先显示刚发主帖
  const { neighborSummary, formatGap } = globalThis.XIRSchedule;
  const both = neighborSummary(at(22, 8), {
    scheduled: [{ id: '1', executeAt: at(21, 32) }, { id: '2', executeAt: at(22, 45) }],
  });
  assert.equal(both.prev.kind, 'scheduled');
  assert.equal(formatGap(both.prev.gapMs), '36 分钟');
  assert.equal(both.next.kind, 'scheduled');
  assert.equal(formatGap(both.next.gapMs), '37 分钟');

  const onlyPrevPost = neighborSummary(at(22, 8), {
    scheduled: [{ id: '1', executeAt: at(20, 0) }],
    lastPostAt: at(21, 30),
  });
  assert.equal(onlyPrevPost.prev.kind, 'post');
  assert.equal(formatGap(onlyPrevPost.prev.gapMs), '38 分钟');
  assert.equal(onlyPrevPost.next, null);
  assert.equal(formatGap(95 * 60_000), '1 小时 35 分钟');
});

test('抓取层：模板识别且自有请求集合有容量上限', async () => {
  const fetcherCode = readFileSync(new URL('../src/x/fetcher.js', import.meta.url), 'utf8');
  const sentUrls = [];
  const ctx = {
    location: { origin: 'https://x.com' },
    URL,
    URLSearchParams,
    document: { cookie: 'twid=u%3D1; ct0=tok', documentElement: { lang: 'en' } },
    fetch: async (url) => {
      sentUrls.push(url);
      return { ok: true, status: 200, headers: new Map(), text: async () => '{}' };
    },
  };
  runInNewContext(fetcherCode, ctx);
  const { tplKind, fetchMentions, fetchMyReplies, fetchScheduled, isOwn } = ctx.XIRFetcher;

  assert.equal(tplKind('https://x.com/i/api/graphql/Q1/UserRepliesTimeline?variables=%7B%7D'), 'replies');
  assert.equal(tplKind('https://x.com/i/api/graphql/Q2/NotificationsTimeline?variables=%7B%7D'), 'mentions');
  assert.equal(tplKind('https://x.com/i/api/graphql/Q3/FetchScheduledTweets'), 'scheduled');
  assert.equal(tplKind('https://evil.example/i/api/graphql/Q1/UserRepliesTimeline?variables=%7B%7D'), null);
  assert.equal(tplKind('https://x.com/i/api/graphql/Q4/HomeTimeline?variables=%7B%7D'), null);

  const missingTpl = await fetchMentions('c_no_tpl');
  assert.equal(missingTpl.error, 'bad_tpl', '无通知模板时拒绝降级旧 REST');
  assert.equal(sentUrls.length, 0);

  const ntTpl = 'https://x.com/i/api/graphql/Q2/NotificationsTimeline?variables=%7B%7D';
  for (let i = 0; i < 505; i++) {
    await fetchMentions(`c${i}`, ntTpl);
  }
  await fetchMyReplies('https://x.com/i/api/graphql/Q1/UserRepliesTimeline?variables=%7B%7D', 'c_out');
  await fetchScheduled('https://x.com/i/api/graphql/Q3/FetchScheduledTweets');

  assert.equal(sentUrls.length, 507);
  assert.equal(isOwn(sentUrls[0]), false, '最早的请求应被淘汰');
  assert.equal(isOwn(sentUrls[6]), false, '超出 500 上限的早期请求应被淘汰');
  assert.equal(isOwn(sentUrls[7]), true, '第 500 个起的最新请求应保留');
  assert.equal(isOwn(sentUrls.at(-1)), true, '最近发出的请求应保留');
});

test('模拟真人节律：连续平滑分布无断层、低于空闲回收线，可选出站同步间隔不少于 48 小时', async () => {
  const { PACE, humanIncDelay, humanBackfillDelay, humanRestDelay, humanBatchPages, nextOutAutoSlot } = await import('../src/bg/runtime.js');
  let incMidGapHits = 0;
  let backfillMidGapHits = 0;
  for (let i = 0; i < 400; i++) {
    const incDelay = humanIncDelay();
    assert.ok(incDelay >= 4_000 && incDelay < 28_000, `增量页间停顿 ${incDelay}ms 须严格在 [4s, 28s)`);
    if (incDelay >= 10_000 && incDelay < 12_000) incMidGapHits++;
    const backfillDelay = humanBackfillDelay();
    assert.ok(backfillDelay >= 15_000 && backfillDelay < 110_000, `补历史停顿 ${backfillDelay}ms 应在预期区间内`);
    if (backfillDelay >= 28_000 && backfillDelay < 30_000) backfillMidGapHits++;
    const rest = humanRestDelay();
    assert.ok(rest >= 180_000 && rest < 300_000, `批间休息 ${rest}ms 应在 [180s, 300s)`);
    const batch = humanBatchPages();
    assert.ok(batch >= 8 && batch <= 12, `补历史每批页数 ${batch} 应在 8–12 页`);
  }
  assert.ok(incMidGapHits > 0, '增量停顿 10–12s 区间不再存在零概率断层');
  assert.ok(backfillMidGapHits > 0, '补历史停顿 28–30s 区间不再存在零概率断层');
  const base = new Date(2026, 10, 21, 9, 0, 0, 0).getTime();
  const nextOut = nextOutAutoSlot(base);
  assert.ok(nextOut - base >= PACE.outAutoGapMs, '可选低频出站自动同步间隔至少 48 小时');
});

test('parseCreatedReply：实时旁听 CreateTweet 回复解析（直评/深层/自回复/异常结构）', () => {
  const meRef = { userId: '1', handle: 'Me' };
  const makeCreate = ({ id = '9100', uid = '1', handle = 'Me', replyTo, toUid, toHandle, conv, text = '@u2 说得对', createdAt = 'Thu Nov 12 08:00:00 +0000 2026', visibility = false } = {}) => {
    const inner = {
      rest_id: id,
      core: { user_results: { result: { rest_id: uid, core: { screen_name: handle } } } },
      legacy: {
        id_str: id, user_id_str: uid, created_at: createdAt, full_text: text,
        ...(replyTo ? { in_reply_to_status_id_str: replyTo, in_reply_to_user_id_str: toUid, in_reply_to_screen_name: toHandle } : {}),
        ...(conv ? { conversation_id_str: conv } : {}),
      },
    };
    return {
      data: {
        create_tweet: {
          tweet_results: {
            result: visibility ? { __typename: 'TweetWithVisibilityResults', tweet: inner } : inner,
          },
        },
      },
    };
  };

  // 1. 直接评论他人根帖：记入 root_user_id，计入我回 N
  const direct = parseCreatedReply(makeCreate({ replyTo: '100', toUid: '2', toHandle: 'Fan', conv: '100', visibility: true }), meRef);
  assert.equal(direct.ok, true);
  assert.equal(direct.event.root_user_id, '2');
  assert.equal(direct.event.root_handle, 'Fan');
  assert.equal(direct.event.text, '说得对');
  assert.equal(countsFromMe(direct.event), true);

  // 2. 二级回复（replyTo !== conv）：保留记录但 root_user_id 为 null，不计入我回 N
  const deep = parseCreatedReply(makeCreate({ id: '9101', replyTo: '201', toUid: '4', toHandle: 'Other', conv: '200' }), meRef);
  assert.equal(deep.ok, true);
  assert.equal(deep.event.root_user_id, null);
  assert.equal(countsFromMe(deep.event), false);

  // 3. 在自己帖子下回复别人：标 own: true，不计入我回 N
  const ownThread = parseCreatedReply(makeCreate({ id: '9102', replyTo: '300', toUid: '1', toHandle: 'Me', conv: '300' }), meRef);
  assert.equal(ownThread.ok, true);
  assert.equal(ownThread.event.own, true);
  assert.equal(countsFromMe(ownThread.event), false);

  // 4. 原创帖 & 他人帖 & X 接口错：安全忽略
  assert.deepEqual(parseCreatedReply(makeCreate(), meRef), { ok: true, event: null, reason: 'not_reply' });
  assert.deepEqual(parseCreatedReply(makeCreate({ uid: '9', handle: 'Else', replyTo: '100', toUid: '2', toHandle: 'Fan', conv: '100' }), meRef), { ok: true, event: null, reason: 'not_me' });
  assert.deepEqual(parseCreatedReply({ errors: [{ message: 'rate limit' }] }, meRef), { ok: true, event: null, reason: 'api_error' });

  // 5. 结构缺失：明确返回 ok: false 以便写入日志
  assert.deepEqual(parseCreatedReply({ data: {} }, meRef), { ok: false, reason: 'missing_tweet_result' });
  assert.deepEqual(parseCreatedReply(makeCreate({ replyTo: '100', toUid: '2', toHandle: 'Fan', conv: null }), meRef), { ok: false, reason: 'missing_conversation_id' });
  assert.deepEqual(parseCreatedReply(makeCreate({ replyTo: '100', toUid: '2', toHandle: 'Fan', conv: '100', createdAt: 'bad-date' }), meRef), { ok: false, reason: 'missing_created_at' });
});

test('parseNotificationsTap 与回复栏 URL 解析：All 跳过非帖子通知并留去敏类型，Mentions 维持严格校验', () => {
  const meRef = { userId: '1', handle: 'Me' };
  const mixedPayload = {
    data: {
      viewer_v2: {
        user_results: {
          result: {
            notification_timeline: {
              timeline: {
                instructions: [{
                  entries: [
                    {
                      content: {
                        entryType: 'TimelineTimelineItem',
                        clientEventInfo: { element: 'users_liked_your_tweet' },
                        itemContent: {
                          itemType: 'TimelineNotification',
                          notification_icon: 'heart_icon',
                          template: { target_objects: [{ tweet_results: { result: { rest_id: '50' } } }] },
                        },
                      },
                    },
                    {
                      content: {
                        entryType: 'TimelineTimelineItem',
                        itemContent: {
                          itemType: 'TimelineTweet',
                          tweet_results: {
                            result: {
                              rest_id: '9201',
                              core: { user_results: { result: { rest_id: '2', core: { screen_name: 'Fan', name: '粉丝' } } } },
                              legacy: {
                                id_str: '9201', user_id_str: '2', created_at: 'Thu Nov 12 08:00:00 +0000 2026',
                                full_text: '@Me 很赞', in_reply_to_status_id_str: '50',
                                in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'Me', conversation_id_str: '50',
                              },
                            },
                          },
                        },
                      },
                    },
                    { content: { cursorType: 'Bottom', value: 'CUR_NEXT' } },
                  ],
                }],
              },
            },
          },
        },
      },
    },
  };

  // All 页：抽出回复，跳过点赞通知并保留去敏类型，不抛错
  const all = parseNotificationsTap(mixedPayload, meRef, { timeline: 'All' });
  assert.equal(all.events.length, 1);
  assert.equal(all.events[0].id, '9201');
  assert.equal(all.events[0].root_mine, true);
  assert.equal(all.nonTweetEntries, 1);
  assert.deepEqual(all.nonTweetKinds, ['TimelineNotification:heart_icon:users_liked_your_tweet']);
  assert.equal(all.bottomCursor, 'CUR_NEXT');

  // Mentions 页：保持严格校验，遇到非帖子条目明确抛错
  assert.throws(() => parseNotificationsTap(mixedPayload, meRef, { timeline: 'Mentions' }), ParseError);

  // UserRepliesTimeline URL 目标用户与游标解析
  const ownUrl = 'https://x.com/i/api/graphql/QID/UserRepliesTimeline?variables=%7B%22userId%22%3A%221%22%2C%22count%22%3A20%2C%22cursor%22%3A%22C1%22%7D';
  const noCurUrl = 'https://x.com/i/api/graphql/QID/UserTweetsAndReplies?variables=%7B%22userId%22%3A%22999%22%7D';
  assert.equal(repliesTapTargetUserId(ownUrl), '1');
  assert.equal(repliesTapHasCursor(ownUrl), true);
  assert.equal(repliesTapTargetUserId(noCurUrl), '999');
  assert.equal(repliesTapHasCursor(noCurUrl), false);
  assert.equal(repliesTapTargetUserId('not-a-url'), null);
});
