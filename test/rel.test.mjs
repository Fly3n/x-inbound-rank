// 页面旁听内存里的关注关系与帖子归属（src/content/rel.js）
// 运行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/content/rel.js';
import { replyPlaces } from '../src/rank.js';

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

test('帖子归属：我帖子下的二、三级评论（回复别人而非直接回我）也能通过同对话旁证识别为 me', () => {
  const { extract, placeOf } = globalThis.XIRRel;
  const tw = (id, uid, conv, rtoStatus, rtoUser) => ({ rest_id: id, legacy: { user_id_str: uid, conversation_id_str: conv, in_reply_to_status_id_str: rtoStatus, in_reply_to_user_id_str: rtoUser } });

  // 场景 A：页面里没有根帖，但有一级评论（回我的根帖 100）和二级评论（作者 3 回作者 2）
  const body = {
    x: [
      tw('101', '2', '100', '100', '1'), // 一级评论：直接回我
      tw('102', '3', '100', '101', '2'), // 二级评论：在我帖子下回一级评论者
      tw('103', '4', '100', '102', '3'), // 三级评论：在我帖子下继续回别人
      tw('200', '2', '200'), // 别人根帖
      tw('201', '3', '200', '200', '2'), // 别人帖子下的一级评论
      tw('202', '4', '200', '201', '3'), // 别人帖子下的二级评论：不标 M
      tw('302', '4', '300', '301', '3'), // 无根帖也无一级评论：不标 M
    ],
  };
  const tweets = new Map(extract(body).tweets.map((t) => [t.id, t]));
  const convOwners = new Map([['100', '1'], ['200', '2']]);
  // 同时验证带 convOwners（O(1) 路径）和不带 convOwners（兼容路径）
  for (const owners of [convOwners, undefined]) {
    assert.equal(placeOf('101', '1', tweets, owners), 'me');
    assert.equal(placeOf('102', '1', tweets, owners), 'me');
    assert.equal(placeOf('103', '1', tweets, owners), 'me');
    assert.equal(placeOf('201', '1', tweets, owners), null);
    assert.equal(placeOf('202', '1', tweets, owners), null);
    assert.equal(placeOf('302', '1', tweets, owners), null);
  }

  // 场景 B：页面里只有二级评论（未进入站表），后台通过 convById 查本机 myConversations（入站一级评论或出站 own 记录）
  const inb = (id, actor, conv, rootMine) => ({ id, actor_id: actor, conversation_id: conv, root_mine: rootMine, created_at: 1 });
  const events = [inb('101', '2', '100', true)];
  const out = [{ id: 'o1', conversation_id: '400', root_user_id: '1', own: true }, { id: 'o2', conversation_id: '200', root_user_id: '2' }];
  assert.deepEqual(
    replyPlaces(events, out, ['102', '402', '202', '302'], { 102: '100', 402: '400', 202: '200', 302: '300' }),
    { 102: 'me', 402: 'me', 202: null, 302: null },
  );
});
