import test from 'node:test';
import assert from 'node:assert/strict';
import { createBgEnv } from './helpers/bg-env.mjs';

const env = await createBgEnv();
const { store, server, alarms, listeners, outFeed, mine, send, pageSend, fire, fireJob, job, until, boardRows, setSettings, setWindow } = env;

test.after(() => env.restore());

// 预置入站基线（7 天内 Fan 4 条，15 天内 Fan 7 条）
await setSettings({ initDays: 15, windowDays: 7 });
await send({ type: 'startBackfill', account: 'me' });
await until(() => job().pages === 1 && job().nextAt, '入站基线第 1 页');
while (job().status === 'running') await fireJob();
await setSettings({ initDays: 7, windowDays: 7 });

test('我回别人：首次手动初始化、模板获取、范围切换与规则即时重算', { timeout: 20_000 }, async () => {
  // 第一次也要手动点「初始化」，到点的闹钟不会自己开始读
  assert.equal(alarms['out:me'], undefined, '入站回填不会顺带启动出站读取');
  await fire('out');
  assert.equal(store['cursor:me'].out, undefined, '没点过初始化，不自动读');
  assert.deepEqual([server.outCalls, server.opened], [0, []]);

  // 还没见过 X 自己的请求模板时读不了，只提示
  await send({ type: 'syncOutNow', account: 'me' });
  await until(() => store['cursor:me'].out?.status === 'need_tpl' && !store['cursor:me'].out.running, '没有请求地址');
  assert.equal(server.outCalls, 0);
  assert.deepEqual(server.opened, [], '等待用户打开回复页，插件不打开标签页');
  await fire('out');
  assert.equal(server.opened.length, 0, '后台重试不打开标签页');
  assert.equal((await boardRows())[0].replied, null, '出站还没读成时不冒充「一次没回」');

  // 页面上出现了那条请求：记下地址，马上补读到 7 天边界（3 页）
  delete alarms['out:me'];
  await pageSend({ type: 'xir:tpl', url: 'https://x.com/i/api/graphql/QID/UserTweetsAndReplies?variables=%7B%7D' });
  assert.ok(alarms['out:me'], '拿到地址后约好补读');
  await fire('out');
  assert.deepEqual([store['cursor:me'].out.status, store['cursor:me'].out.syncedId, server.outCalls], ['ok', '9005', 3]);
  assert.equal(store['cursor:me'].out.reachedEnd, false, '读到 7 天范围，不是列表到底');
  assert.equal((await boardRows())[0].replied, 2, '7 天内我在 Fan 的帖子下回复了 2 次（回 Other 的那条不算他的）');
  assert.equal(store['snap:me'].users.fan.replied, 2, '读完后时间线标签也带上');

  // 下一次自动时间未到时，遗留闹钟也不会发请求；若启用低频同步，间距至少 48 小时
  await fire('out');
  assert.equal(server.outCalls, 3);
  assert.ok(store['cursor:me'].out.nextAutoAt - Date.now() >= 48 * 60 * 60_000);

  // 榜单范围切到半个月、一个月：榜单和标签快照立刻按新范围重算，不发请求
  assert.ok((await setWindow(45)).error, '只接受 7、15、30、60、90');
  assert.ok((await setSettings({ initDays: 30 })).error, '补历史范围只接受 7、15');
  assert.ok((await setSettings({ initDays: 60 })).error, '补历史范围只接受 7、15');
  const callsBeforeSwitch = server.calls;
  await setWindow(15);
  assert.equal(server.calls, callsBeforeSwitch);
  assert.deepEqual((await boardRows()).map((r) => [r.handle, r.count]), [['Fan', 7]]);
  assert.equal(store['snap:me'].windowDays, 15);
  assert.equal(store['snap:me'].users.fan.count, 7);
  await setWindow(30);
  assert.equal((await boardRows()).find((r) => r.handle === 'Fan').replied, 5, '窗口没覆盖完也按已有记录显示');
  assert.equal(store['snap:me'].users.fan.replied, 5);
  await setWindow(15);

  // 改口径和颜色：榜单和标签立刻跟着变；越界的值夹回范围
  await setSettings({ minCount: 8 });
  assert.deepEqual(await boardRows(), []);
  assert.deepEqual(store['snap:me'].users, {});
  await setSettings({ minCount: 2, topN: 9999, tiers: [{ min: 5, color: 'green' }], baseColor: 'purple' });
  assert.equal(store['settings:me'].topN, 500);
  assert.equal(store['snap:me'].users.fan.color, 'green');
  const full = await send({ type: 'getBoard', account: 'me' });
  assert.deepEqual([full.people, full.replies], [1, 7]);
  await setSettings({ topN: 100, tiers: [{ min: 20, color: 'red' }, { min: 10, color: 'orange' }, { min: 5, color: 'blue' }], baseColor: 'gray' });
  assert.equal(server.calls, callsBeforeSwitch, '改设置不发请求');
});

test('改初始化范围重读、模板 404 恢复与限流/分页/窗口边界', { timeout: 20_000 }, async () => {
  // 默认方案 A（outAutoSync: false）下：就算次日窗口到了也不自动发回复栏请求；手动开启方案 B 才定时同步
  let outBefore = server.outCalls;
  store['cursor:me'].out.nextAutoAt = 0;
  await fire('out');
  assert.equal(server.outCalls, outBefore, '默认关闭低频同步时，自动闹钟不请求回复栏');

  await setSettings({ initDays: 15, outAutoSync: true });
  outBefore = server.outCalls;
  store['cursor:me'].out.nextAutoAt = 0;
  await fire('out');
  assert.equal(server.outCalls - outBefore, 1);
  assert.equal((await boardRows())[0].replied, 4);
  assert.equal(store['cursor:me'].out.lastFullDays, 7, '还是上次初始化的范围');

  // 手动点「初始化」：不管上次读到哪，按范围重新读一遍
  outBefore = server.outCalls;
  await send({ type: 'syncOutNow', account: 'me' });
  const redone = () => server.outCalls - outBefore === 3 && store['cursor:me'].out.fullFor === 15;
  for (let i = 0; i < 10 && !redone(); i++) await until(redone, '手动初始化我回别人').catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([server.outCalls - outBefore, store['cursor:me'].out.fullFor], [3, 15], '手动初始化我回别人');

  // X 换了接口参数（404）：丢掉旧地址，保留已有计数；页面提供新地址后继续
  store['cursor:me'].out.nextAutoAt = 0;
  const realSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (id, msg) => msg.type === 'xir:ping' ? realSend(id, msg) : { ok: false, status: 404, userId: '1' };
  await fire('out');
  chrome.tabs.sendMessage = realSend;
  assert.equal(store['cursor:me'].out.status, 'need_tpl');
  assert.equal(store['tpl:replies:me'], undefined);
  assert.equal((await boardRows())[0].replied, 4, '已有的数还在');
  delete alarms['out:me'];
  store['tpl:replies:me'] = { url: 'https://x.com/i/api/graphql/QID2/UserTweetsAndReplies?variables=%7B%7D', at: Date.now() };
  await listeners.startup();
  assert.ok(alarms['out:me'], '模板已存在但闹钟丢失时，恢复闹钟');
  delete alarms['out:me'];
  delete store['tpl:replies:me'];
  await pageSend({ type: 'xir:tpl', url: 'https://x.com/i/api/graphql/QID2/UserTweetsAndReplies?variables=%7B%7D' });
  assert.ok(alarms['out:me'], '页面提供新地址后安排续读');
  await fire('out');
  assert.deepEqual([store['cursor:me'].out.status, server.opened, server.outUrls.at(-1).includes('QID2')], ['ok', [], true]);
  assert.equal(store['cursor:me'].out.lastFullDays, 15, '记下完整读完成的时间和范围');

  // 出站 429 指数退避
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const savedNow = env.getNow();
    try {
      Object.assign(store['cursor:me'].out, { status: 'ok', retryAt: 0, resume: null, nextAutoAt: 0, rate429Count: 0 });
      server.outFail429Once = true;
      await fire('out');
      const first = store['cursor:me'].out;
      assert.equal(first.rate429Count, 1);
      assert.equal(store['cursor:me'].rate429Count, 1);
      assert.ok(first.retryAt - Date.now() >= 15 * 60_000, '第一次 429 至少退避 15 分钟');

      env.setNow(first.retryAt);
      server.outFail429Once = true;
      await fire('out');
      const second = store['cursor:me'].out;
      assert.equal(second.rate429Count, 2);
      assert.equal(store['cursor:me'].rate429Count, 2);
      assert.ok(second.retryAt - Date.now() >= 30 * 60_000, '连续 429 的等待时间翻倍');
    } finally {
      env.setNow(savedNow);
      store['cursor:me'] = savedCursor;
      delete alarms['out:me'];
      server.outFail429Once = false;
    }
  }

  // 出站重复游标是异常
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const beforeCover = savedCursor.out.coverTs;
    try {
      Object.assign(store['cursor:me'].out, { status: 'ok', retryAt: 0, resume: null, nextAutoAt: 0, syncedId: '9000' });
      const runSync = store['cursor:me'].out.syncedId;
      server.repeatOutCursor = true;
      await fire('out');
      const out = store['cursor:me'].out;
      assert.equal(out.status, 'error');
      assert.match(out.message, /重复的翻页位置/);
      assert.equal(out.syncedId, runSync, '重复游标不推进接续点');
      assert.equal(out.coverTs, beforeCover, '重复游标不冒充完整覆盖');
    } finally {
      store['cursor:me'] = savedCursor;
      delete alarms['out:me'];
      server.repeatOutCursor = false;
    }
  }

  // 出站增量在接上旧位置前提前空页与首屏空页
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const beforeLastAt = savedCursor.out.lastAt;
    const beforeCover = savedCursor.out.coverTs;
    try {
      const checkpoint = '9002';
      Object.assign(store['cursor:me'].out, {
        status: 'ok', retryAt: 0, resume: null, nextAutoAt: 0, manualTask: false,
        syncedId: checkpoint, fullFor: 15, schema: 2,
      });
      store['cursor:me'].rateUntil = 0;
      store['cursor:me'].rate429Count = 0;
      server.earlyEndOutAfterFirstPage = true;
      await fire('out');
      const out = store['cursor:me'].out;
      assert.equal(out.status, 'error');
      assert.match(out.message, /提前结束/);
      assert.equal(out.syncedId, checkpoint, '提前结束不推进接续点');
      assert.equal(out.lastAt, beforeLastAt, '提前结束不冒充读完');
      assert.equal(out.coverTs, beforeCover, '提前结束不冒充覆盖');

      Object.assign(store['cursor:me'].out, { status: 'ok', retryAt: 0, nextAutoAt: 0, resume: null, syncedId: checkpoint });
      store['cursor:me'].rateUntil = 0;
      store['cursor:me'].rate429Count = 0;
      server.emptyOutOnce = true;
      await fire('out');
      assert.match(store['cursor:me'].out.message, /提前结束/, '首屏空页也不能当成接上旧位置');
    } finally {
      store['cursor:me'] = savedCursor;
      delete alarms['out:me'];
      server.earlyEndOutAfterFirstPage = false;
      server.emptyOutOnce = false;
    }
  }

  // 自动出站的等待/续读不能绕到上午、晚间窗口之外
  {
    const savedOut = structuredClone(store['cursor:me'].out);
    const savedNow = env.getNow();
    try {
      env.setNow(new Date(2026, 10, 21, 11, 40, 0, 0).getTime());
      store['cursor:me'].out = {
        ...savedOut, status: 'queued', retryAt: 0, nextAutoAt: 0,
        resume: { cursor: '2', topId: '9005', rounds: 0, full: false, stopAt: '9000', nextAt: 0 },
      };
      const before = server.outCalls;
      await fire('out');
      assert.equal(server.outCalls, before, '自动出站等待期间不绕过窗口');
      assert.ok(alarms['out:me'].when >= new Date(2026, 10, 21, 18, 0, 0, 0).getTime(), '改到晚间窗口再继续');
      assert.equal(store['cursor:me'].out.resume.nextAt, alarms['out:me'].when);
    } finally {
      env.setNow(savedNow);
      store['cursor:me'].out = savedOut;
      delete alarms['out:me'];
    }
  }
});

test('出站列表先到底与达到单次轮数上限的覆盖边界', { timeout: 20_000 }, async () => {
  await setSettings({ fetchEnabled: true, initDays: 15 });
  Object.assign(store['cursor:me'].out, { coverTs: null, lastFullDays: null, lastFullAt: null });
  const removedOldest = outFeed.pop(); // 剩下最早一条是 13 天前，会在 15 天前到底
  let outBefore = server.outCalls;
  try {
    await send({ type: 'syncOutNow', account: 'me' });
    const reachedBottom = () => store['cursor:me'].out?.lastFullDays === 15 && store['cursor:me'].out?.status === 'ok';
    for (let i = 0; i < 10 && !reachedBottom(); i++) await until(reachedBottom, '读到回复列表底部').catch(() => {});
    assert.ok(reachedBottom());
    await new Promise((r) => setTimeout(r, 20)); // 等上一轮 finally 释放读取锁
    assert.ok(server.outCalls > outBefore);
    assert.equal(store['cursor:me'].out.reachedEnd, true);
    assert.ok(store['cursor:me'].out.coverTs > Date.now() - 15 * env.DAY, '记下实际读到的最早时间（未满 15 天）');
  } finally {
    outFeed.push(removedOldest);
  }

  // 单次读取达到轮数上限：不能把失败写成「初始化完成」，但要留下实际读到的最早时间
  const savedOutState = structuredClone(store['cursor:me'].out);
  const savedFeed = outFeed.splice(0, outFeed.length,
    ...Array.from({ length: 12 }, (_, i) => mine(String(9005 - (i % 6)), 1 + i, '2')));
  store['cursor:me'].out = {
    ...savedOutState,
    status: 'ok', message: null, limitReached: null, attemptCoverTs: null,
    coverTs: null,
    fullFor: 0, initDays: 15, targetTs: Date.now() - 20 * env.DAY,
    resume: { cursor: '0', topId: null, rounds: 119, full: true, stopAt: null, nextAt: 0 },
  };
  try {
    await fire('out');
    const afterLimit = store['cursor:me'].out;
    assert.equal(afterLimit.status, 'error');
    assert.equal(afterLimit.limitReached, true);
    assert.equal(afterLimit.lastFullAt, savedOutState.lastFullAt, '失败不改上次初始化完成时间');
    assert.equal(afterLimit.lastFullDays, savedOutState.lastFullDays, '失败不改上次初始化范围');
    assert.equal(afterLimit.coverTs, null, '失败不拿这次的部分进度冒充完整覆盖');
    assert.ok(afterLimit.attemptCoverTs >= Date.now() - 11 * env.DAY, '记下这次实际读到的最早时间');
    assert.equal(afterLimit.syncedId, savedOutState.syncedId, '没读完时接续点不动');
    const callsAtLimit = server.outCalls;
    await fire('out');
    assert.equal(server.outCalls, callsAtLimit, '达到上限后自动闹钟不再继续读');
    assert.equal(store['cursor:me'].out.status, 'error');
    delete alarms['out:me'];
    await pageSend({ type: 'xir:hello', handle: 'Me', userId: '1' });
    assert.equal(alarms['out:me'], undefined, '达到上限后页面上线也不再安排自动读取');
    await send({ type: 'setSettings', account: 'me', patch: { outAutoSync: false } });
    await pageSend({ type: 'xir:hello', handle: 'Me', userId: '1' });
    assert.equal(alarms['out:me'], undefined, '关闭低频同步且无上限挂起时不安排自动出站闹钟');
  } finally {
    outFeed.splice(0, outFeed.length, ...savedFeed);
    store['cursor:me'].out = savedOutState;
  }
});

test('方案 A 默认浏览器回复旁听：实时入库、去重、错构留日志且不动手机端游标', { timeout: 20_000 }, async () => {
  assert.equal((await send({ type: 'clearData', account: 'me' })).ok, true);
  await setSettings({ fetchEnabled: true, outAutoSync: false, windowDays: 15 });
  await send({ type: 'startBackfill', account: 'me' });
  await until(() => job()?.status === 'done' || job()?.nextAt, '重新放入入站基线');
  while (job()?.status === 'running') await fireJob();

  const beforeOutCalls = server.outCalls;
  await fire('out');
  assert.equal(server.outCalls, beforeOutCalls, '方案 A 默认自动更新不请求出站接口');

  const createPayload = ({ id, replyTo, toUid, toHandle, conv, text }) => JSON.stringify({
    data: {
      create_tweet: {
        tweet_results: {
          result: {
            rest_id: id,
            core: { user_results: { result: { rest_id: '1', core: { screen_name: 'Me' } } } },
            legacy: {
              id_str: id,
              user_id_str: '1',
              created_at: new Date(Date.now()).toUTCString(),
              full_text: text,
              in_reply_to_status_id_str: replyTo,
              in_reply_to_user_id_str: toUid,
              in_reply_to_screen_name: toHandle,
              conversation_id_str: conv,
            },
          },
        },
      },
    },
  });

  // 1. 直接评论 Fan：实时记入并显示「我回 1」，同时不写入 cur.out.lastAt/syncedId
  const tapRes = await pageSend({
    type: 'xir:outbound:tap',
    text: createPayload({ id: '9901', replyTo: '50', toUid: '2', toHandle: 'Fan', conv: '50', text: '@Fan 来了' }),
  });
  assert.deepEqual(tapRes, { ok: true, added: 1 });
  assert.equal((await boardRows())[0].replied, 1);
  assert.equal(store['snap:me'].users.fan.replied, 1);
  assert.equal(store['cursor:me'].out, undefined, '旁听入库不伪造回复栏同步游标或时间');

  // 2. 重复同一条帖子编号与二层/自帖回复：不重复计入
  assert.deepEqual(await pageSend({
    type: 'xir:outbound:tap',
    text: createPayload({ id: '9901', replyTo: '50', toUid: '2', toHandle: 'Fan', conv: '50', text: '@Fan 来了' }),
  }), { ok: true, added: 0 });
  await pageSend({
    type: 'xir:outbound:tap',
    text: createPayload({ id: '9902', replyTo: '599', toUid: '9', toHandle: 'Other', conv: '50', text: '二层' }),
  });
  await pageSend({
    type: 'xir:outbound:tap',
    text: createPayload({ id: '9903', replyTo: '100', toUid: '1', toHandle: 'Me', conv: '100', text: '自回复' }),
  });
  assert.equal((await boardRows())[0].replied, 1, '重复 ID、二级回复和自己帖子下回复都不误算');

  // 3. 异常载荷记入后台诊断日志，不污染数据
  await pageSend({ type: 'xir:outbound:tap', text: JSON.stringify({ data: { unexpected: true } }) });
  const logs = await send({ type: 'getDiagnostics', account: 'me' });
  assert.ok(logs.some((e) => e.event === 'outbound_tap_unmatched' && e.reason === 'missing_tweet_result'));
  assert.ok(logs.some((e) => e.event === 'outbound_tap' && e.postId === '9901' && e.added === 1));

  // 4. 手动「立即更新」在方案 A 默认下只刷新别人回我，不再强求先初始化我回别人
  Object.assign(store['cursor:me'], { lastManualAt: 0, nextIncAt: 0, lastAttemptAt: 0 });
  const receipt = await send({ type: 'updateNowWithReceipt', account: 'me' });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.outboundPassive, true);
  assert.equal(receipt.readAt.outbound, null);
  assert.equal(server.outCalls, beforeOutCalls);
});
