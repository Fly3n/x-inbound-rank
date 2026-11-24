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

test('立即更新收据、冷却、退避与切后台续读', { timeout: 20_000 }, async () => {
  await setSettings({ fetchEnabled: false });

  store['cursor:me'].inLastReadAt = 1;
  store['cursor:me'].out.lastReadAt = 1;
  const countBeforeManual = await count();
  Object.assign(store['cursor:me'], { nextIncAt: Date.now() + 45 * 60_000, lastAttemptAt: 0 });
  const before = server.calls;
  const beforeOut = server.outCalls;
  const receipt = await send({ type: 'updateNowWithReceipt', account: 'me' });
  assert.deepEqual(receipt, {
    ok: true,
    readAt: {
      inbound: store['cursor:me'].inLastReadAt,
    },
  });
  const firstManualCalls = server.calls - before;
  assert.ok(firstManualCalls > 0, '自动更新关闭时，立即更新仍会读取别人回我');
  assert.equal(server.outCalls, beforeOut, '别人回我立即更新不顺带请求我回别人');
  const nextAutoGap = store['cursor:me'].nextIncAt - Date.now();
  assert.ok(nextAutoGap >= 8 * 60 * 60_000 && nextAutoGap <= 13.5 * 60 * 60_000 + 1_000,
    '立即更新后顺延到下一个自动时段');
  assert.equal(alarms['inc:me'], undefined, '自动更新关闭时不安排自动读取');
  assert.equal(await count(), countBeforeManual, '这次没有新增入站记录');
  assert.ok(store['cursor:me'].inLastReadAt > 1, '零新增仍记录成功读取时间');
  assert.equal(store['cursor:me'].out.lastReadAt, 1, '别人回我立即更新不改动出站读取时间');
  assert.ok(store['cursor:me'].inLastReadCounts.read > 0);
  assert.equal(store['cursor:me'].inLastReadCounts.added, 0, '没有新记录也显示读到的条数');

  // 我回别人独立立即更新：只请求出站、有独立 10 分钟冷却、遵循账号级退避
  const outReceipt = await send({ type: 'updateOutNowWithReceipt', account: 'me' });
  assert.deepEqual(outReceipt, {
    ok: true,
    readAt: {
      outbound: store['cursor:me'].out.lastReadAt,
    },
  });
  assert.equal(server.calls, before + firstManualCalls, '我回别人立即更新不请求入站接口');
  assert.equal(server.outCalls, beforeOut + 1);
  assert.ok(store['cursor:me'].out.lastReadAt > 1);
  assert.ok(store['cursor:me'].out.lastReadCounts.read > 0);
  assert.match((await send({ type: 'updateOutNowWithReceipt', account: 'me' })).error, /刚刚更新过/);

  const beforeSecond = [server.calls, server.outCalls];
  assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /刚刚更新过/);
  assert.deepEqual([server.calls, server.outCalls], beforeSecond, '冷却期内不发请求');

  env.advanceNow(11 * 60_000);
  assert.ok((await send({ type: 'updateNowWithReceipt', account: 'me' })).ok, '完成后可再次立即更新');
  assert.deepEqual([server.calls - beforeSecond[0], server.outCalls - beforeSecond[1]], [firstManualCalls, 0]);

  const afterSecond = [server.calls, server.outCalls];
  env.advanceNow(11 * 60_000);
  store['cursor:me'].rateUntil = Date.now() + 60_000;
  const lastManualAt = store['cursor:me'].lastManualAt;
  const lastOutManualAt = store['cursor:me'].out.lastManualAt;
  assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /退避/);
  assert.match((await send({ type: 'updateOutNowWithReceipt', account: 'me' })).error, /退避/);
  assert.deepEqual([server.calls, server.outCalls], afterSecond, '接口退避时不发请求');
  assert.equal(store['cursor:me'].lastManualAt, lastManualAt, '没有发出请求就不记冷却');
  assert.equal(store['cursor:me'].out.lastManualAt, lastOutManualAt, '出站退避未发请求也不记冷却');
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

test('账号异常硬熔断：命中 403/验证锁定信号立即关停全部自动抓取、不自动恢复，仅用户手动重开后解除', async () => {
  await setSettings({ fetchEnabled: true, outAutoSync: true });
  await pageSend({ type: 'xir:tpl', url: 'https://x.com/i/api/graphql/QID/FetchScheduledTweets?variables=%7B%7D' });
  assert.ok(alarms['inc:me'], '熔断前已安排入站自动闹钟');
  assert.ok(alarms['out:me'], '熔断前已安排出站自动闹钟');

  const realSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'xir:fetch') {
      return {
        ok: true,
        status: 200,
        userId: '1',
        body: { errors: [{ code: 326, message: 'To protect our users from spam, this account is temporarily locked.' }] },
      };
    }
    return realSend(id, msg);
  };
  try {
    store['cursor:me'].nextIncAt = 0;
    store['cursor:me'].lastAttemptAt = 0;
    await fire('inc');
  } finally {
    chrome.tabs.sendMessage = realSend;
  }

  // 立即硬熔断：自动更新与低频同步均强制关闭、全部闹钟清空、写红字告警与熔断标记
  assert.equal(store['settings:me'].fetchEnabled, false, '熔断后强制关闭自动更新');
  assert.equal(store['settings:me'].outAutoSync, false, '熔断后强制关闭低频同步');
  assert.equal(alarms['inc:me'], undefined, '熔断后清空入站闹钟');
  assert.equal(alarms['out:me'], undefined, '熔断后清空出站闹钟');
  assert.equal(alarms['job:me'], undefined, '熔断后清空补历史闹钟');
  assert.equal(store['cursor:me'].circuitBroken.code, 326);
  assert.match(store['alert:me'].message, /熔断/);

  // 绝不自动恢复：推进到下一时段、触发 tick/inc/out/hello/active/排期同步均零请求
  const beforeNoAuto = [server.calls, server.outCalls];
  env.advanceNow(12 * 60 * 60_000);
  await listeners.alarm({ name: 'tick' });
  await fire('inc');
  await fire('out');
  await pageSend({ type: 'xir:hello', handle: 'Me', userId: '1' });
  await pageSend({ type: 'xir:active' });
  const schedRes = await pageSend({ type: 'xir:scheduled:sync', force: false });
  assert.equal(schedRes.status, 'error');
  assert.match(schedRes.message, /熔断/);
  assert.deepEqual([server.calls, server.outCalls], beforeNoAuto, '熔断期间任何自动路径均不得发请求');
  assert.equal(alarms['inc:me'], undefined, '熔断期间页面上线与 tick 不重新排期');

  // 仅用户手动重新开启自动更新后才解除熔断并恢复排期
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: true } });
  assert.equal(store['cursor:me'].circuitBroken, undefined, '用户手动重开后解除熔断标记');
  assert.equal(store['alert:me'], undefined, '解除熔断后清除告警');
  assert.ok(alarms['inc:me'], '用户手动重开后恢复自动排期');

  // 连续 3 次 429 升级为硬熔断（前 2 次正常指数退避，第 3 次直接停抓）
  store['cursor:me'].rate429Count = 2;
  store['cursor:me'].rateUntil = 0;
  store['cursor:me'].nextIncAt = 0;
  store['cursor:me'].lastAttemptAt = 0;
  server.fail429Once = true;
  await fire('inc');
  assert.equal(store['settings:me'].fetchEnabled, false, '连续第 3 次 429 升级硬熔断并关闭自动更新');
  assert.equal(store['cursor:me'].circuitBroken.code, 429);
  assert.equal(alarms['inc:me'], undefined);

  // 非 5xx HTML 挑战页（not_json）同样触发硬熔断
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: true } });
  const realSendHtml = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'xir:fetch') {
      return { ok: false, status: 200, userId: '1', error: 'not_json', contentType: 'text/html', detail: '<!DOCTYPE html><title>Just a moment</title>' };
    }
    return realSendHtml(id, msg);
  };
  try {
    store['cursor:me'].rateUntil = 0;
    store['cursor:me'].rate429Count = 0;
    store['cursor:me'].nextIncAt = 0;
    store['cursor:me'].lastAttemptAt = 0;
    await fire('inc');
  } finally {
    chrome.tabs.sendMessage = realSendHtml;
  }
  assert.equal(store['settings:me'].fetchEnabled, false, 'HTML 挑战页落入 not_json 也触发硬熔断');
  assert.equal(store['cursor:me'].circuitBroken.code, 'html_challenge');
});
