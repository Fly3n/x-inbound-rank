import test from 'node:test';
import assert from 'node:assert/strict';
import { readDiagnostics } from '../src/diagnostics.js';
import { createBgEnv } from './helpers/bg-env.mjs';

const env = await createBgEnv();
const { store, server, alarms, listeners, feed, hiddenTabs, idleTabs, send, pageSend, fire, fireJob, job, until, count } = env;

test.after(() => env.restore());

// 先跑完一次 15 天入站初始化作为增量测试基线
await env.setSettings({ initDays: 15, windowDays: 15 });
await send({ type: 'startBackfill', account: 'me' });
await until(() => job().pages === 1 && job().nextAt, '基线回填第 1 页');
while (job().status === 'running') await fireJob();

test('手动增量更新：重叠即停且不排后台定时闹钟', { timeout: 20_000 }, async () => {
  // 后台 tick / xir:active / 遗留 inc 闹钟均不主动发请求
  for (let i = 0; i < 7; i++) feed.unshift({ ...env.mention(0, '2', '50', '50'), id_str: String(2000 + i) });
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0, lastManualAt: 0 });
  let before = server.calls;
  await listeners.alarm({ name: 'tick' });
  await pageSend({ type: 'xir:active' }, 1);
  await fire('inc');
  assert.equal(server.calls, before, '无后台定时自动抓取，tick/active/空 inc 闹钟均零请求');
  assert.equal(alarms['inc:me'], undefined);

  // 手动点「立即更新」：翻到第 3 页重叠上次接续点即停，且完成后不安排下次自动闹钟
  const res = await send({ type: 'updateNowWithReceipt', account: 'me' });
  assert.equal(res.ok, true);
  assert.equal(server.calls - before, 3);
  assert.equal(await count(), 15);
  assert.equal(store['cursor:me'].syncedId, '2006');
  assert.equal(alarms['inc:me'], undefined, '手动更新完成后不再安排后台定时闹钟');

  // 没有新内容时第 1 页重叠接续点即停
  store['cursor:me'].lastManualAt = 0;
  before = server.calls;
  assert.equal((await send({ type: 'updateNowWithReceipt', account: 'me' })).ok, true);
  assert.equal(server.calls - before, 1);

  // 发现与接续点重叠立即停止，不再继续往更旧翻页
  const older = { ...env.mention(0.02, '2', '50', '50'), id_str: '1999' };
  feed.splice(9, 0, older);
  store['cursor:me'].lastManualAt = 0;
  const countBeforeOverlap = await count();
  before = server.calls;
  assert.equal((await send({ type: 'updateNowWithReceipt', account: 'me' })).ok, true);
  assert.equal(server.calls - before, 1);
  assert.equal(await count(), countBeforeOverlap, '接续点重叠后不再往更早翻页');
  feed.splice(feed.indexOf(older), 1);
});

test('提及模板切换：404 过期后不降级旧 REST，提示打开通知页并在捕获新模板后恢复手动更新', async () => {
  const NT = 'https://x.com/i/api/graphql/NQ/NotificationsTimeline?variables=%7B%22timeline_type%22%3A%22All%22%7D';
  await pageSend({ type: 'xir:tpl', url: NT, kind: 'mentions' });
  Object.assign(store['cursor:me'], { lastManualAt: 0 });
  assert.equal((await send({ type: 'updateNowWithReceipt', account: 'me' })).ok, true);
  assert.equal(server.mentionTpl, NT);
  assert.equal((await send({ type: 'getAccountState', account: 'me' })).mentionsApi, 'gql');

  const realSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (_id, msg) => (msg.type === 'xir:fetch' && msg.tpl ? { ok: false, status: 404, userId: '1' } : realSend(_id, msg));
  Object.assign(store['cursor:me'], { lastManualAt: 0 });
  const expired = await send({ type: 'updateNowWithReceipt', account: 'me' });
  chrome.tabs.sendMessage = realSend;
  assert.equal(store['tpl:mentions:me'], undefined, '过期的模板删掉');
  assert.equal((await send({ type: 'getAccountState', account: 'me' })).mentionsApi, 'need_tpl');
  assert.match(expired.message, /通知/);
  assert.match(store['alert:me'].message, /通知/);

  // 无模板时不再降级打旧 REST，零请求
  const beforeMissing = server.calls;
  Object.assign(store['cursor:me'], { lastManualAt: 0 });
  await send({ type: 'updateNowWithReceipt', account: 'me' });
  assert.equal(server.calls, beforeMissing, '无模板时不降级旧 REST');

  // 用户自行打开一次通知页捕到新模板后：清掉提示且不排后台自动闹钟，手动更新即可用新模板
  const NT2 = 'https://x.com/i/api/graphql/NQ2/NotificationsTimeline?variables=%7B%22timeline_type%22%3A%22Mentions%22%7D';
  await pageSend({ type: 'xir:tpl', url: NT2, kind: 'mentions' });
  assert.equal(store['alert:me'], undefined, '拿到新通知模板后清掉旧告警');
  assert.equal(alarms['inc:me'], undefined, '不安排后台自动闹钟');
  Object.assign(store['cursor:me'], { lastManualAt: 0 });
  assert.equal((await send({ type: 'updateNowWithReceipt', account: 'me' })).ok, true);
  assert.equal(server.mentionTpl, NT2);
});

test('并发去重、429 退避、重复游标与提前空页异常边界', async () => {
  // 两个手动触发同时到：只跑一轮，另一个被锁拒
  Object.assign(store['cursor:me'], { lastManualAt: 0, rateUntil: 0 });
  let before = server.calls;
  const [r1, r2] = await Promise.all([
    send({ type: 'updateNowWithReceipt', account: 'me' }),
    send({ type: 'updateNowWithReceipt', account: 'me' }),
  ]);
  assert.equal(server.calls - before, 1, '同时到的两个手动触发只跑一轮');
  assert.ok((r1.ok && r2.error) || (r2.ok && r1.error));

  // 手动增量被限流：放弃本轮，不推进补漏锚点，不排自动重试闹钟
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const beforeAnchor = savedCursor.lastIncrementalAt;
    try {
      Object.assign(store['cursor:me'], { lastManualAt: 0, rateUntil: 0, rate429Count: 0 });
      server.fail429Once = true;
      const result = await send({ type: 'updateNowWithReceipt', account: 'me' });
      assert.match(result.message, /限流/);
      assert.equal(store['cursor:me'].lastIncrementalAt, beforeAnchor, '失败不推进补漏锚点');
      assert.ok(store['cursor:me'].rateUntil > Date.now());
      assert.equal(alarms['inc:me'], undefined, '限流后不排后台自动重试闹钟');
    } finally {
      server.fail429Once = false;
      store['cursor:me'] = savedCursor;
      delete store['alert:me'];
      delete alarms['inc:me'];
    }
  }

  // 入站重复游标是异常：保留原接续点，不能当成已接上
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const beforeSync = feed[4].id_str;
    const beforeAnchor = savedCursor.lastIncrementalAt;
    try {
      Object.assign(store['cursor:me'], { syncedId: beforeSync, lastManualAt: 0, rateUntil: 0, rate429Count: 0 });
      delete store['cursor:me'].incResume;
      server.repeatInboundCursor = true;
      const result = await send({ type: 'updateNowWithReceipt', account: 'me' });
      assert.match(result.error, /翻页异常/);
      assert.equal(store['cursor:me'].syncedId, beforeSync, '重复游标不推进接续点');
      assert.equal(store['cursor:me'].lastIncrementalAt, beforeAnchor, '重复游标不推进补漏锚点');
      assert.equal(store['cursor:me'].incResume, undefined);
      assert.equal(alarms['inc:me'], undefined);
      assert.match(store['alert:me'].message, /重复的翻页位置/);
    } finally {
      server.repeatInboundCursor = false;
      store['cursor:me'] = savedCursor;
      delete store['alert:me'];
      delete alarms['inc:me'];
    }
  }

  // 入站分页在接上旧位置前提前空页：同样保留接续点和补漏锚点
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const beforeAnchor = savedCursor.lastIncrementalAt;
    try {
      const checkpoint = feed[4].id_str; // 第一页全是比它更新的已有记录，第二页提前空掉
      Object.assign(store['cursor:me'], { syncedId: checkpoint, lastManualAt: 0, rateUntil: 0, rate429Count: 0 });
      delete store['cursor:me'].incResume;
      server.earlyEndInboundAfterFirstPage = true;
      const result = await send({ type: 'updateNowWithReceipt', account: 'me' });
      assert.match(result.error, /提前结束/);
      assert.equal(store['cursor:me'].syncedId, checkpoint, '提前结束不推进接续点');
      assert.equal(store['cursor:me'].lastIncrementalAt, beforeAnchor, '提前结束不推进补漏锚点');
      assert.equal(store['cursor:me'].incResume, undefined);
      assert.match(store['alert:me'].message, /提前结束/);

      Object.assign(store['cursor:me'], { syncedId: checkpoint, lastManualAt: 0, rateUntil: 0, rate429Count: 0 });
      delete store['cursor:me'].incResume;
      server.emptyInboundOnce = true;
      assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /提前结束/, '首屏空页也不能当成接上旧位置');
    } finally {
      server.earlyEndInboundAfterFirstPage = false;
      server.emptyInboundOnce = false;
      store['cursor:me'] = savedCursor;
      delete store['alert:me'];
      delete alarms['inc:me'];
    }
  }
});

test('工作时段、前台可见性、零后台自动抓取与旧接续点穿透', { timeout: 20_000 }, async () => {
  // 人类工作时段：夜间拒绝手动读取；白天 X 页面不在前台也拒绝手动读取；后台 tick 任何时段都不发请求
  const daytime = env.getNow();
  const savedCursor = structuredClone(store['cursor:me']);
  try {
    env.setNow(new Date(2026, 10, 21, 2, 0, 0, 0).getTime());
    Object.assign(store['cursor:me'], { lastManualAt: 0 });
    let before = server.calls;
    await listeners.alarm({ name: 'tick' });
    assert.equal(server.calls, before, '凌晨不读取');
    assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /08:00/);

    env.setNow(daytime);
    hiddenTabs.add(1);
    hiddenTabs.add(4);
    await listeners.alarm({ name: 'tick' });
    assert.equal(server.calls, before, 'X 页面在后台不读取');
    assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /切到.*X 页面/);

    hiddenTabs.delete(1);
    hiddenTabs.delete(4);
    env.setNow(new Date(2026, 10, 21, 19, 0, 0, 0).getTime());
    await listeners.alarm({ name: 'tick' });
    assert.equal(server.calls, before, '晚间时段后台 tick 也不再自动发请求');
  } finally {
    hiddenTabs.delete(1);
    hiddenTabs.delete(4);
    env.setNow(daytime);
    store['cursor:me'] = savedCursor;
  }

  // 关掉旁听收集开关不影响手动补历史与手动立即更新
  await send({ type: 'setSettings', account: 'me', patch: { tapInEnabled: false } });
  assert.deepEqual(await send({ type: 'startBackfill', account: 'me' }), { ok: true }, '手动初始化不受旁听开关影响');
  await until(() => job().pages === 1, '关掉旁听开关后仍能手动初始化');
  await send({ type: 'pauseJob', account: 'me' });
  await send({ type: 'setSettings', account: 'me', patch: { tapInEnabled: true } });

  // 接续点尚未重叠时：手动更新必须继续读到与接续点重叠为止
  const staleFeed = feed.splice(0, feed.length,
    { ...env.mention(25 / 24, '2', '50', '50'), id_str: '6006' },
    { ...env.mention(26 / 24, '2', '50', '50'), id_str: '6005' },
    { ...env.mention(27 / 24, '2', '50', '50'), id_str: '6004' },
    { ...env.mention(2, '2', '50', '50'), id_str: '6003' },
    { ...env.mention(2.5, '2', '50', '50'), id_str: '6002' },
    { ...env.mention(2.9, '2', '50', '50'), id_str: '6001' },
    { ...env.mention(3, '2', '50', '50'), id_str: '6000' },
    { ...env.mention(3.1, '2', '50', '50'), id_str: '5999' },
    { ...env.mention(3.2, '2', '50', '50'), id_str: '5998' },
    { ...env.mention(3.3, '2', '50', '50'), id_str: '5997' });
  const staleCursor = structuredClone(store['cursor:me']);
  try {
    Object.assign(store['cursor:me'], { syncedId: '6000', lastManualAt: 0 });
    delete store['cursor:me'].lastIncrementalAt;
    delete store['cursor:me'].incResume;
    delete store['cursor:me'].rateUntil;
    const staleCalls = server.calls;
    const staleCount = await count();
    assert.equal((await send({ type: 'updateNowWithReceipt', account: 'me' })).ok, true);
    assert.equal(server.calls - staleCalls, 3, '第 3 页到接续点就停，不依赖列表结束');
    assert.equal(await count(), staleCount + 9, '接续点之前的记录一条不少');
  } finally {
    feed.splice(0, feed.length, ...staleFeed);
    store['cursor:me'] = staleCursor;
  }
});

test('多段续读：手动立即更新单个事件最多 6 页，分段休息后自动续完并固定锚点', { timeout: 20_000 }, async () => {
  const beforeCount = await count();
  for (let i = 0; i < 130; i++) feed.unshift({ ...env.mention(0, '2', '50', '50'), id_str: String(3000 + i) });
  Object.assign(store['cursor:me'], { lastManualAt: 0, nextIncAt: 0 });
  const before = server.calls;
  const incrementStartedAt = Date.now();
  const first = await send({ type: 'updateNowWithReceipt', account: 'me' });
  assert.match(first.message, /等待续读/);
  assert.equal(server.calls - before, 6, '一次后台事件最多 6 页');
  assert.equal(store['cursor:me'].syncedId, '2006', '没接上之前接续点不动');
  assert.equal(store['cursor:me'].incResume.manual, true, '标记为手动续读');
  assert.equal(store['cursor:me'].incResume.startedAt, incrementStartedAt, '续读保留整轮的起始时间');
  const rest = alarms['inc:me'].when - Date.now();
  assert.ok(rest >= 179_000 && rest <= 300_000, '休息三到五分钟接着读');
  while (store['cursor:me'].incResume) {
    env.advanceNow(5 * 60_000);
    store['cursor:me'].nextIncAt = 0;
    await fire('inc');
  }
  assert.equal(server.calls - before, 44, '分多个短任务在重叠接续点时立即停下');
  assert.deepEqual([store['cursor:me'].syncedId, store['cursor:me'].incResume], ['3129', undefined]);
  assert.equal(alarms['inc:me'], undefined, '手动多段续读完成后清空闹钟');
  assert.equal(store['cursor:me'].lastIncrementalAt, incrementStartedAt, '本轮起点保持在开始时刻');
  assert.equal(await count(), beforeCount + 130, '一条不丢');
  feed.splice(0, 130);
});

test('免补历史手动直接增量与 48 页安全上限拦截', { timeout: 20_000 }, async () => {
  const savedCursor = structuredClone(store['cursor:me']);
  const savedActivation = store.accounts.me.activation;
  const savedFeed = [...feed];
  try {
    // 1. 从未补过历史（无 syncedId）也能手动点立即更新建起点，且单轮最多读 2 页
    delete store['cursor:me'];
    delete alarms['inc:me'];
    store.accounts.me.activation = Date.now() - 2 * 60 * 60_000;
    feed.splice(0, feed.length,
      { ...env.mention(0.01, '2', '50', '50'), id_str: '7008' },
      { ...env.mention(0.02, '2', '50', '50'), id_str: '7007' },
      { ...env.mention(0.03, '2', '50', '50'), id_str: '7006' },
      { ...env.mention(0.04, '2', '50', '50'), id_str: '7005' },
      { ...env.mention(0.05, '2', '50', '50'), id_str: '7004' },
      { ...env.mention(0.06, '2', '50', '50'), id_str: '7003' },
      { ...env.mention(0.5, '2', '50', '50'), id_str: '7002' },
    );
    await pageSend({ type: 'xir:hello', handle: 'Me', userId: '1' });
    assert.equal(alarms['inc:me'], undefined, '新账号页面上线不安排后台自动闹钟');
    const beforeInitFree = server.calls;
    assert.equal((await send({ type: 'updateNowWithReceipt', account: 'me' })).ok, true);
    assert.equal(server.calls - beforeInitFree, 2, '免补历史手动首轮最多读 2 页建立接续点');
    assert.equal(store['cursor:me'].syncedId, '7008');

    // 2. 单轮超过 8 段（48 页）仍未重叠接续点：触及安全上限停止，等待人工介入或补历史
    feed.splice(0, feed.length, ...Array.from({ length: 200 }, (_, i) => (
      { ...env.mention(0, '2', '50', '50'), id_str: String(8199 - i) }
    )));
    Object.assign(store['cursor:me'], { syncedId: '7008', lastManualAt: 0, nextIncAt: 0 });
    delete store['cursor:me'].incResume;
    delete store['cursor:me'].incLimitReached;
    const beforeCap = server.calls;
    let lastResult = await send({ type: 'updateNowWithReceipt', account: 'me' });
    while (store['cursor:me'].incResume) {
      env.advanceNow(5 * 60_000);
      store['cursor:me'].nextIncAt = 0;
      lastResult = await fire('inc');
    }
    assert.equal(server.calls - beforeCap, 48, '8 段累计读取 48 页后触及安全上限');
    assert.match(lastResult.error, /安全页数上限/);
    assert.equal(store['cursor:me'].incLimitReached, true);
    assert.equal(store['cursor:me'].incResume, undefined);
    assert.equal(alarms['inc:me'], undefined, '触及上限后清空闹钟');
    assert.equal(store['cursor:me'].syncedId, '7008', '未接上时接续点不动');
    assert.match(store['alert:me']?.message, /48 页/);

    // 补一次历史成功后解除锁定并清除标记
    feed.splice(0, feed.length, { ...env.mention(0, '2', '50', '50'), id_str: '8200' });
    await send({ type: 'startBackfill', account: 'me' });
    await until(() => job()?.status === 'done' || job()?.nextAt, '补历史完成或进入下一页');
    while (job()?.status === 'running') await fireJob();
    assert.equal(store['cursor:me'].incLimitReached, undefined, '补历史完成后解除安全上限锁定');
  } finally {
    feed.splice(0, feed.length, ...savedFeed);
    store['cursor:me'] = savedCursor;
    store.accounts.me.activation = savedActivation;
    delete store['alert:me'];
    delete alarms['inc:me'];
    delete store['job:me'];
  }
});

test('零后台定时抓接口：tick 与 xir:active 永不自动发请求，手动更新正常放行', { timeout: 20_000 }, async () => {
  const savedCursor = structuredClone(store['cursor:me']);
  try {
    idleTabs.add(1);
    idleTabs.add(4);
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0, lastManualAt: 0 });
    delete store['cursor:me'].incResume;
    const beforeIdle = server.calls;
    await listeners.alarm({ name: 'tick' });
    await fire('inc');
    idleTabs.delete(1);
    idleTabs.delete(4);
    await pageSend({ type: 'xir:active' }, 1);
    assert.equal(server.calls, beforeIdle, 'tick / inc / xir:active 均绝不自动发请求');

    const manualRes = await send({ type: 'updateNowWithReceipt', account: 'me' });
    assert.equal(manualRes.ok, true, '手动立即更新正常读取');
    assert.ok(server.calls > beforeIdle);
  } finally {
    idleTabs.delete(1);
    idleTabs.delete(4);
    store['cursor:me'] = savedCursor;
    delete alarms['inc:me'];
  }
});

test('通知页与提及页零请求旁听收集：开关控制、All 过滤非帖子通知、Mentions 去重并写日志、绝不推进 syncedId', { timeout: 20_000 }, async () => {
  await send({ type: 'setSettings', account: 'me', patch: { tapInEnabled: true, windowDays: 15 } });
  const savedCursor = structuredClone(store['cursor:me'] || {});
  const beforeCalls = server.calls;
  const beforeSynced = store['cursor:me']?.syncedId;
  const nowStr = new Date(Date.now()).toUTCString();
  const makeEntry = (id, actorId, handle, name, text, rootId = '50') => ({
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        tweet_results: {
          result: {
            rest_id: id,
            core: { user_results: { result: { rest_id: actorId, core: { screen_name: handle, name } } } },
            legacy: {
              id_str: id, user_id_str: actorId, created_at: nowStr, full_text: text,
              in_reply_to_status_id_str: rootId, in_reply_to_user_id_str: '1', in_reply_to_screen_name: 'Me', conversation_id_str: rootId,
            },
          },
        },
      },
    },
  });
  const wrapNotif = (entries) => JSON.stringify({
    data: { viewer_v2: { user_results: { result: { notification_timeline: { timeline: { instructions: [{ entries }] } } } } } },
  });

  try {
    // 0. 关闭「旁听收集 [别人回我]」时不写入数据
    const allUrl = 'https://x.com/i/api/graphql/QID/NotificationsTimeline?variables=' + encodeURIComponent(JSON.stringify({ timeline_type: 'All', count: 40 }));
    await send({ type: 'setSettings', account: 'me', patch: { tapInEnabled: false } });
    assert.deepEqual(await pageSend({
      type: 'xir:inbound:tap',
      url: allUrl,
      status: 200,
      metadata: {},
      text: wrapNotif([makeEntry('95000', '77', 'TapFan', '旁听好友', '@Me 关掉开关不应入库')]),
    }, 1), { skipped: 'tap_disabled' });
    await send({ type: 'setSettings', account: 'me', patch: { tapInEnabled: true } });

    // 1. 「全部」通知页：混有赞/关通知 + 1 条新回复 → 零请求入库、不动 syncedId、记全诊断日志
    const resAll = await pageSend({
      type: 'xir:inbound:tap',
      url: allUrl,
      status: 200,
      metadata: { age: '3', cache: 'BYPASS' },
      text: wrapNotif([
        { content: { entryType: 'TimelineTimelineItem', clientEventInfo: { element: 'users_liked_your_tweet' }, itemContent: { itemType: 'TimelineNotification', notification_icon: 'heart_icon' } } },
        makeEntry('95001', '77', 'TapFan', '旁听好友', '@Me 刷通知就记进来了'),
        { content: { cursorType: 'Bottom', value: 'CUR_ALL' } },
      ]),
    }, 1);
    assert.deepEqual(resAll, { ok: true, added: 1, parsed: 1, timeline: 'All' });
    assert.equal(server.calls, beforeCalls, '旁听入库全程零主动请求');
    assert.equal(store['cursor:me']?.syncedId, beforeSynced, '旁听入库绝不推进主动增量接续点');
    assert.ok(store['cursor:me'].inLastTapAt > 0);
    assert.deepEqual(store['cursor:me'].inLastTapCounts, { read: 1, added: 1, timeline: 'All' });

    // 2. 「提及」页：含刚入库的重复 ID + 1 条新回复 → 主键去重 + 同写 inbound_tap 与 web_mentions_response
    const mentionsUrl = 'https://x.com/i/api/graphql/QID/NotificationsTimeline?variables=' + encodeURIComponent(JSON.stringify({ timeline_type: 'Mentions', count: 40, cursor: 'C2' }));
    const resMentions = await pageSend({
      type: 'xir:inbound:tap',
      url: mentionsUrl,
      status: 200,
      metadata: { age: '10', cache: 'MISS' },
      text: wrapNotif([
        makeEntry('95001', '77', 'TapFan', '旁听好友', '@Me 重复条目'),
        makeEntry('95002', '77', 'TapFan', '旁听好友', '@Me 第二条回复'),
      ]),
    }, 1);
    assert.deepEqual(resMentions, { ok: true, added: 1, parsed: 2, timeline: 'Mentions' });
    assert.ok(store['snap:me'].users.tapfan.count >= 2, '旁听入库即时刷新时间线标签快照');

    // 3. 非 2xx 响应跳过留日志；Mentions 异常结构记 inbound_tap_failed 且不挂红字告警
    const res429 = await pageSend({ type: 'xir:inbound:tap', url: mentionsUrl, status: 429, metadata: {}, text: '{"errors":[{"message":"rate"}]}' }, 1);
    assert.deepEqual(res429, { ok: false, skipped: true });
    const resBad = await pageSend({ type: 'xir:inbound:tap', url: mentionsUrl, status: 200, metadata: {}, text: JSON.stringify({ data: { unexpected: true } }) }, 1);
    assert.deepEqual(resBad, { ok: false });
    assert.equal(store['alert:me'], undefined, '旁听解析异常只写诊断日志，不误弹主动抓取红字告警');

    const logs = (await readDiagnostics()).filter((e) => e.account === 'me');
    const allLog = logs.find((e) => e.event === 'inbound_tap' && e.timeline === 'All');
    assert.equal(allLog.nonTweetEntries, 1);
    assert.deepEqual(allLog.nonTweetKinds, ['TimelineNotification:heart_icon:users_liked_your_tweet']);
    assert.equal(allLog.added, 1);
    const mentionsLog = logs.find((e) => e.event === 'inbound_tap' && e.timeline === 'Mentions');
    assert.equal(mentionsLog.added, 1);
    assert.equal(mentionsLog.deduped, 1);
    assert.equal(mentionsLog.hasCursor, true);
    assert.ok(logs.some((e) => e.event === 'web_mentions_response' && e.evidence?.request?.timeline === 'Mentions'));
    assert.ok(logs.some((e) => e.event === 'inbound_tap_skipped' && e.status === 429));
    assert.ok(logs.some((e) => e.event === 'inbound_tap_failed' && e.category === 'unexpected_payload'));
  } finally {
    store['cursor:me'] = savedCursor;
    delete store['alert:me'];
    await send({ type: 'setSettings', account: 'me', patch: { tapInEnabled: true } });
  }
});

test('统一手动补读（manualFetchIn）：自定义小时窗口截断、连续覆盖智能早停与长窗口切换回填', { timeout: 20_000 }, async () => {
  const savedCursor = structuredClone(store['cursor:me'] || {});
  const savedFeed = [...feed];
  try {
    // 1. 场景：30 天没点过主动 fetch（旧 syncedId 在 30 天前），现在手动补读「最近 3 小时」→ 到 3 小时边界即停，不追 30 天前旧点
    feed.splice(0, feed.length,
      { ...env.mention(0.5 / 24, '2', '50', '50'), id_str: '96010' },
      { ...env.mention(1.5 / 24, '2', '50', '50'), id_str: '96009' },
      { ...env.mention(4 / 24, '2', '50', '50'), id_str: '96008' },
      { ...env.mention(10 / 24, '2', '50', '50'), id_str: '96007' },
      { ...env.mention(20 / 24, '2', '50', '50'), id_str: '96006' },
      { ...env.mention(30, '2', '50', '50'), id_str: '96001' },
    );
    store['cursor:me'] = {
      syncedId: '96001',
      lastManualAt: 0,
      lastBackfill: { rangeDays: 7, finishedAt: Date.now() - 30 * 86_400_000, oldestTs: Date.now() - 37 * 86_400_000, reachedEnd: false },
    };
    const beforeShort = server.calls;
    const shortRes = await send({ type: 'manualFetchIn', account: 'me', hours: 3 });
    assert.equal(shortRes.ok, true);
    assert.equal(server.calls - beforeShort, 1, '第 1 页最旧已早于 3 小时，立刻停止不追 30 天前旧点');
    assert.equal(store['cursor:me'].syncedId, '96010');
    assert.equal(store['cursor:me'].lastBackfill.hours, 3);
    // 跳过空白期后，lastBackfill.oldestTs 重建为本次实际覆盖，不冒充覆盖了中间 30 天
    assert.ok(store['cursor:me'].lastBackfill.oldestTs > Date.now() - 24 * 3_600_000);

    // 2. 场景：刚刚连续补读覆盖到 12 小时前，2 小时后又点「最近 6 小时」→ 命中 syncedId 直接早停
    store['cursor:me'].lastBackfill.oldestTs = Date.now() - 12 * 3_600_000;
    store['cursor:me'].lastManualAt = 0;
    feed.unshift({ ...env.mention(0.1 / 24, '2', '50', '50'), id_str: '96011' });
    const beforeEarly = server.calls;
    assert.equal((await send({ type: 'manualFetchIn', account: 'me', hours: 6 })).ok, true);
    assert.equal(server.calls - beforeEarly, 1, '上次连续覆盖已盖过 6 小时，命中 syncedId 自动早停');
    assert.ok(store['cursor:me'].lastBackfill.oldestTs <= Date.now() - 12 * 3_600_000, '早停后保留更早的连续覆盖起点');

    // 3. 非法时长拦截，长窗口（> 24 小时）走慢速回填状态机
    assert.match((await send({ type: 'manualFetchIn', account: 'me', hours: 0 })).error, /仅支持/);
    assert.match((await send({ type: 'manualFetchIn', account: 'me', hours: 400 })).error, /仅支持/);
    assert.equal((await send({ type: 'manualFetchIn', account: 'me', hours: 72 })).ok, true);
    await until(() => job()?.hours === 72 && (job().status === 'done' || job().pages >= 1), '长窗口进入回填任务');
    if (job()?.status !== 'done') await send({ type: 'pauseJob', account: 'me' });
  } finally {
    feed.splice(0, feed.length, ...savedFeed);
    store['cursor:me'] = savedCursor;
    delete store['job:me'];
    delete store['alert:me'];
    delete alarms['job:me'];
    delete alarms['inc:me'];
  }
});
