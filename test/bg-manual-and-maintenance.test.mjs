import test from 'node:test';
import assert from 'node:assert/strict';
import { putEvents } from '../src/db.js';
import { createBgEnv } from './helpers/bg-env.mjs';

const env = await createBgEnv();
const { store, server, alarms, listeners, feed, hiddenTabs, send, pageSend, fire, fireJob, job, until, count, boardRows, setSettings } = env;

test.after(() => env.restore());

// 预置入站（15 天）和出站（7 天）基线数据
await setSettings({ initDays: 15, windowDays: 15 });
await send({ type: 'startBackfill', account: 'me' });
await until(() => job().pages === 1 && job().nextAt, '入站基线第 1 页');
while (job().status === 'running') await fireJob();
await setSettings({ initDays: 7, windowDays: 15 });
await pageSend({ type: 'xir:tpl', url: 'https://x.com/i/api/graphql/QID/UserTweetsAndReplies?variables=%7B%7D' });
await send({ type: 'syncOutNow', account: 'me' });
await until(() => store['cursor:me'].out?.lastFullDays === 7 && store['cursor:me'].out?.status === 'ok', '出站基线初始化');
await new Promise((r) => setTimeout(r, 20)); // 等 finally 释放读取锁

test('快照字段补齐、双向明细、状态汇总与全量导出', async () => {
  // 旧版本留下的快照缺字段：页面再上线时重算补齐
  delete store['snap:me'].users.fan.color;
  await pageSend({ type: 'xir:hello', handle: 'Me', userId: '1' });
  assert.equal(store['snap:me'].users.fan.color, 'blue');

  // 点开某人：返回他在窗口内的回复与我回他次数
  const detail = await send({ type: 'getReplies', account: 'me', actorId: '2' });
  assert.equal(detail.total, 7);
  assert.equal(detail.outbound.total, (await boardRows()).find((row) => row.actor_id === '2').replied);
  assert.equal(detail.outbound.items[0].id, '9005');
  assert.ok(detail.outbound.items[0].created_at);
  assert.equal(await send({ type: 'getReplies', account: 'me', actorId: '3' }).then((d) => d.total), 0, '别人帖子下的不算');

  // 数据现状和全量导出：两份数据各自的条数和起止时间
  const st = await send({ type: 'getAccountState', account: 'me' });
  assert.deepEqual([st.db.in.count, st.db.out.count], [8, 6]);
  assert.ok(st.db.out.from < st.db.out.to && st.cursor.out.lastFullAt);
  const all = await send({ type: 'exportAll', account: 'me' });
  assert.deepEqual([all.inbound.length, all.out.length], [8, 6]);
});

test('立即更新收据、冷却、退避、切后台续读与只读诊断回查', { timeout: 20_000 }, async () => {
  await setSettings({ fetchEnabled: false });

  store['cursor:me'].inLastReadAt = 1;
  store['cursor:me'].out.lastReadAt = 1;
  const countBeforeManual = await count();
  Object.assign(store['cursor:me'], { nextIncAt: Date.now() + 45 * 60_000, lastAttemptAt: 0 });
  const before = server.calls;
  const receipt = await send({ type: 'updateNowWithReceipt', account: 'me' });
  assert.deepEqual(receipt, {
    ok: true,
    readAt: {
      inbound: store['cursor:me'].inLastReadAt,
      outbound: store['cursor:me'].out.lastReadAt,
    },
  });
  const firstManualCalls = server.calls - before;
  assert.ok(firstManualCalls > 0, '自动更新关闭时，立即更新仍会读取');
  const nextAutoGap = store['cursor:me'].nextIncAt - Date.now();
  assert.ok(nextAutoGap >= 8 * 60 * 60_000 && nextAutoGap <= 13.5 * 60 * 60_000 + 1_000,
    '立即更新后顺延到下一个自动时段');
  assert.equal(alarms['inc:me'], undefined, '自动更新关闭时不安排自动读取');
  assert.equal(await count(), countBeforeManual, '这次没有新增入站记录');
  assert.ok(store['cursor:me'].inLastReadAt > 1, '零新增仍记录成功读取时间');
  assert.ok(store['cursor:me'].out.lastReadAt > 1, '手动更新返回前已成功读取出站数据');
  assert.ok(store['cursor:me'].inLastReadCounts.read > 0);
  assert.equal(store['cursor:me'].inLastReadCounts.added, 0, '没有新记录也显示读到的条数');
  assert.ok(store['cursor:me'].out.lastReadCounts.read > 0);

  const beforeSecond = [server.calls, server.outCalls];
  assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /刚刚更新过/);
  assert.deepEqual([server.calls, server.outCalls], beforeSecond, '冷却期内不发请求');

  env.advanceNow(11 * 60_000);
  assert.ok((await send({ type: 'updateNowWithReceipt', account: 'me' })).ok, '完成后可再次立即更新');
  assert.deepEqual([server.calls - beforeSecond[0], server.outCalls - beforeSecond[1]], [firstManualCalls, 1]);

  const afterSecond = [server.calls, server.outCalls];
  env.advanceNow(11 * 60_000);
  store['cursor:me'].rateUntil = Date.now() + 60_000;
  const lastManualAt = store['cursor:me'].lastManualAt;
  assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /退避/);
  assert.deepEqual([server.calls, server.outCalls], afterSecond, '接口退避时不发请求');
  assert.equal(store['cursor:me'].lastManualAt, lastManualAt, '没有发出请求就不记冷却');
  delete store['cursor:me'].rateUntil;

  // 手动更新第一页后切到后台：保存续读位置并在一分钟内重新排队，恢复前台后接着读
  const savedInterrupted = structuredClone(store['cursor:me']);
  const realInterruptedSend = chrome.tabs.sendMessage;
  let interruptedFetches = 0;
  feed.unshift(...Array.from({ length: 4 }, (_, i) => ({ ...env.mention(0, '2', '50', '50'), id_str: String(2003 - i) })));
  chrome.tabs.sendMessage = async (id, msg) => {
    const result = await realInterruptedSend(id, msg);
    if (msg.type === 'xir:fetch' && msg.kind !== 'out' && ++interruptedFetches === 1) {
      hiddenTabs.add(1);
      hiddenTabs.add(4);
    }
    return result;
  };
  try {
    Object.assign(store['cursor:me'], { nextIncAt: Date.now() + 45 * 60_000, lastAttemptAt: 0 });
    delete store['cursor:me'].incResume;
    delete store['cursor:me'].lastManualAt;
    const interrupted = await send({ type: 'updateNowWithReceipt', account: 'me' });
    assert.match(interrupted.error, /暂不可用/);
    assert.equal(interruptedFetches, 1);
    assert.ok(store['cursor:me'].incResume, '切后台前读到的位置留着');
    assert.ok(store['cursor:me'].lastManualAt, '实际发出请求后才记冷却');
    const retryGap = alarms['inc:me'].when - Date.now();
    assert.ok(retryGap >= 59_000 && retryGap <= 61_000, '切后台后一分钟内重新排队');
    hiddenTabs.delete(1);
    hiddenTabs.delete(4);
    chrome.tabs.sendMessage = realInterruptedSend;
    store['cursor:me'].nextIncAt = 0;
    await fire('inc');
    assert.equal(store['cursor:me'].incResume, undefined, '恢复前台后接着读完');
  } finally {
    feed.splice(0, 4);
    hiddenTabs.delete(1);
    hiddenTabs.delete(4);
    chrome.tabs.sendMessage = realInterruptedSend;
    store['cursor:me'] = savedInterrupted;
  }

  // 手动按时间回查：只读不改接续点
  await setSettings({ fetchEnabled: true });
  const checkpoint = store['cursor:me'].syncedId;
  const reading = store['cursor:me'].inLastReadAt;
  const originalDate = feed[2].created_at;
  feed[2].created_at = new Date(Date.now() - env.DAY).toUTCString();
  const diagnosis = await send({
    type: 'diagnoseMentions', account: 'me',
    from: Date.now() - 60_000, to: Date.now(), postId: feed[3].id_str,
  });
  feed[2].created_at = originalDate;
  assert.equal(diagnosis.pages, 2);
  assert.equal(diagnosis.reason, 'post_found');
  assert.equal(diagnosis.stored, true);
  assert.equal(store['cursor:me'].syncedId, checkpoint);
  assert.equal(store['cursor:me'].inLastReadAt, reading);
  await setSettings({ fetchEnabled: false });
});

test('清空数据并发保护与 90 天过期数据滚动清理', async () => {
  // 清空：读取期间拒绝清空，锁释放后再清空，设置保留
  const realClearSend = chrome.tabs.sendMessage;
  let releaseHeld;
  let heldClear = false;
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'xir:fetch' && !heldClear) {
      heldClear = true;
      await new Promise((resolve) => { releaseHeld = resolve; });
    }
    return realClearSend(id, msg);
  };
  try {
    await send({ type: 'startBackfill', account: 'me' });
    await until(() => heldClear, '读取中的请求开始');
    assert.match((await send({ type: 'clearData', account: 'me' })).error, /正在读取/);
  } finally {
    releaseHeld?.();
    chrome.tabs.sendMessage = realClearSend;
  }
  let cleared;
  for (let i = 0; i < 40; i++) {
    cleared = await send({ type: 'clearData', account: 'me' });
    if (!cleared.error) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(cleared?.ok, true, '读取锁释放后再清空');
  assert.equal(await count(), 0);
  assert.deepEqual(await boardRows(), []);
  assert.equal(store['snap:me'], undefined);
  assert.equal(store['cursor:me'], undefined);
  assert.equal(store['settings:me'].fetchEnabled, false);

  // 过期清理：只留最近 90 天，一天最多清一次；清掉过数据就记下（弹窗据此不再挂红字提示）
  const old = (id, daysAgo) => ({ id, actor_id: '2', actor_handle: 'Fan', actor_name: 'Fan', actor_avatar: '', created_at: Date.now() - daysAgo * env.DAY, conversation_id: '1', root_mine: true });
  await putEvents('me', [old('1', 1), old('2', 46), old('3', 85), old('4', 95)]);
  await listeners.alarm({ name: 'tick' });
  assert.equal(await count(), 3);
  assert.ok(store['cursor:me'].prunedAt);
  await putEvents('me', [old('5', 100)]);
  await listeners.alarm({ name: 'tick' });
  assert.equal(await count(), 4, '24 小时内不重复清');
});
