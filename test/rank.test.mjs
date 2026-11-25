// 统计口径、榜单、规则合法化与标签快照（src/rank.js）
// 运行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { ranking, outboundCounts, repliesOf, badgeSnapshot, underMyPosts, cleanRules, colorOf, DEFAULT_RULES, DAY_MS, inboundInitCovered, outboundInitCovered } from '../src/rank.js';
import { NOW, ev, rules, board } from './helpers/fixtures.mjs';

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
  assert.equal(DEFAULT_RULES.tapInEnabled, true);
  assert.equal(DEFAULT_RULES.tapOutEnabled, true);
  const r = cleanRules({ windowDays: 45, topN: 9999, minCount: 0, baseColor: 'pink', tapInEnabled: false, tapOutEnabled: 0, showRel: false, showPlace: 0, tiers: [{ min: 5, color: 'green' }, { min: 30, color: 'nope' }, { min: 5, color: 'red' }, { min: 'x', color: 'red' }] });
  // 布尔开关：只有明确写 false 才是关
  assert.deepEqual(r, { windowDays: 7, initDays: 7, tapInEnabled: false, tapOutEnabled: true, topN: 500, minCount: 1, baseColor: 'gray', showRank: true, showOut: true, showRel: false, showPlace: true, showSchedule: true, tiers: [{ min: 30, color: 'gray' }, { min: 5, color: 'green' }] });
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
