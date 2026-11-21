import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { OUT, clearEvents, getEvents, putEvents } from '../src/db.js';

test('重复抓取同一条：主键去重，并保留已知的根帖归属和正文', async () => {
  const account = 'merge-test';
  await clearEvents(account);
  try {
    const inbound = {
      id: '1',
      actor_id: '2',
      actor_handle: 'Fan',
      actor_name: 'Fan',
      actor_avatar: 'avatar.jpg',
      created_at: 1_000,
      target_post_id: '10',
      conversation_id: '10',
      root_mine: true,
      text: '原来的正文',
    };
    assert.equal(await putEvents(account, [inbound]), 1);
    assert.equal(await putEvents(account, [{ ...inbound, actor_avatar: '', root_mine: null, text: '' }]), 0);
    let [row] = await getEvents(account);
    assert.deepEqual(
      [row.root_mine, row.text, row.actor_avatar],
      [true, '原来的正文', 'avatar.jpg'],
      '空值不能覆盖已知事实',
    );

    assert.equal(await putEvents(account, [{ ...inbound, root_mine: false, text: '更新后的正文' }]), 0);
    [row] = await getEvents(account);
    assert.deepEqual([row.root_mine, row.text], [false, '更新后的正文'], '新的有效值照常更新');

    const outbound = {
      id: '2',
      created_at: 2_000,
      reply_to_id: '20',
      to_user_id: '9',
      root_user_id: '9',
      root_handle: 'Other',
      conversation_id: '20',
      own: true,
      text: '我的回复',
    };
    assert.equal(await putEvents(account, [outbound], OUT), 1);
    assert.equal(await putEvents(account, [{ ...outbound, root_user_id: null, root_handle: null, own: undefined, text: '' }], OUT), 0);
    let [out] = await getEvents(account, OUT);
    assert.deepEqual([out.root_user_id, out.root_handle, out.own, out.text], ['9', 'Other', true, '我的回复']);
  } finally {
    await clearEvents(account);
  }
});
