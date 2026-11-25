// X 返回解析与账号异常识别（src/x/parser.js）；输入按「预期的接口形态」手写，验证分类与边界，真实形态见 docs/x-endpoints.md
// 运行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { ranking, outboundCounts, countsFromMe, badgeSnapshot, DAY_MS } from '../src/rank.js';
import { parseCreatedReply, parseMentions, parseNotificationsTap, parseMyReplies, parseScheduledTweets, repliesTapTargetUserId, repliesTapHasCursor, detectAccountAnomaly, ParseError } from '../src/x/parser.js';
import { NOW, ev, rules } from './helpers/fixtures.mjs';

// ---- 旧版提及接口（REST globalObjects）样本 ----
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
// ---- 我在别人帖子下的回复 ----
const gt = (id, uid, extra = {}) => ({
  __typename: 'Tweet',
  rest_id: id,
  core: { user_results: { result: { rest_id: uid, core: { screen_name: uid === '1' ? 'Me' : `u${uid}` } } } },
  legacy: { id_str: id, user_id_str: uid, conversation_id_str: id, created_at: 'Thu Nov 12 08:00:00 +0000 2026', full_text: `t${id}`, ...extra },
});
const item = (t) => ({ itemContent: { tweet_results: { result: t } } });
const single = (t) => ({ entryId: `tweet-${t.rest_id}`, content: { entryType: 'TimelineTimelineItem', ...item(t) } });
const thread = (...ts) => ({ entryId: `profile-conversation-${ts[0].rest_id}`, content: { entryType: 'TimelineTimelineModule', items: ts.map((t) => ({ item: item(t) })) } });
const re = (to, uid, conv) => ({ in_reply_to_status_id_str: to, in_reply_to_user_id_str: uid, in_reply_to_screen_name: `u${uid}`, conversation_id_str: conv });
const gql = (entries, pinned) => ({
  data: { user: { result: { timeline: { timeline: { instructions: [
    ...(pinned ? [{ type: 'TimelinePinEntry', entry: single(pinned) }] : []),
    { type: 'TimelineAddEntries', entries: [...entries, { entryId: 'cursor-bottom-1', content: { entryType: 'TimelineTimelineCursor', value: 'NEXT', cursorType: 'Bottom' } }] },
  ] } } } } },
});

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
  assert.equal(detectAccountAnomaly(429, undefined, { cfMitigated: 'challenge', error: 'not_json' })?.code, 'cf_mitigated');
  assert.equal(detectAccountAnomaly(200, undefined, { redirected: true, finalUrl: 'https://x.com/account/access' })?.code, 'challenge_redirect');
  assert.equal(detectAccountAnomaly(200, undefined, { redirected: true, finalUrl: 'https://x.com/i/flow/login?redirect_after_login=%2Fhome' })?.code, 'challenge_redirect');
  assert.equal(detectAccountAnomaly(200, undefined, { error: 'not_json', contentType: 'text/html; charset=utf-8', detail: '<!DOCTYPE html><title>Just a moment...</title>' })?.code, 'html_challenge');
  assert.equal(detectAccountAnomaly(503, undefined, { error: 'not_json', contentType: 'text/html; charset=utf-8', detail: '<!DOCTYPE html><title>Just a moment...</title>' })?.code, 'html_challenge', '503 携带强 Cloudflare/Arkose 挑战页应触发硬熔断');
  assert.equal(detectAccountAnomaly(503, undefined, { error: 'not_json', contentType: 'text/html', detail: '<!DOCTYPE html>503 Service Unavailable' }), null, '普通 5xx 临时网关错误页不能误触发硬熔断');
  assert.equal(detectAccountAnomaly(429, { errors: [{ code: 88, message: 'Rate limit exceeded' }] }), null);
  assert.equal(detectAccountAnomaly(503, {}), null);
  assert.equal(detectAccountAnomaly(404, {}), null);
  assert.equal(detectAccountAnomaly(200, { data: {} }), null);
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
