import test from 'node:test';
import assert from 'node:assert/strict';
import { createBgEnv } from './helpers/bg-env.mjs';

const env = await createBgEnv();
const { store, server, alarms, listeners, feed, hiddenTabs, idleTabs, send, pageSend, fire, fireJob, job, until, count } = env;

test.after(() => env.restore());

// 先跑完一次 15 天入站初始化作为增量测试基线
await env.setSettings({ initDays: 15, windowDays: 15, fetchEnabled: true });
await send({ type: 'startBackfill', account: 'me' });
await until(() => job().pages === 1 && job().nextAt, '基线回填第 1 页');
while (job().status === 'running') await fireJob();

test('增量更新：重叠即停与完整晚间窗口排期', { timeout: 20_000 }, async () => {
  // 增量：间隔里来了 7 条，翻到第 3 页重叠上次接续点即停（不再多补 1 小时）
  for (let i = 0; i < 7; i++) feed.unshift({ ...env.mention(0, '2', '50', '50'), id_str: String(2000 + i) });
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  let before = server.calls;
  env.setRandom(0.999999); // 下一次自动更新要能排到晚间窗口末尾附近，不能提前一小时收口
  try {
    await listeners.alarm({ name: 'tick' });
  } finally {
    env.setRandom(null);
  }
  assert.equal(server.calls - before, 3);
  assert.equal(await count(), 15);
  assert.equal(store['cursor:me'].syncedId, '2006');

  const gap = store['cursor:me'].nextIncAt - Date.now();
  assert.ok(gap > 13 * 60 * 60_000, '完整窗口内可以排到 22:30 前，而不是 21:30 就停止');
  assert.ok(gap >= 8 * 60 * 60_000 && gap <= 13.5 * 60 * 60_000 + 1_000);
  assert.equal(alarms['inc:me'].when, store['cursor:me'].nextIncAt);

  // 闹钟到点就跑，不用等兜底闹钟；没有新内容时第 1 页重叠接续点即停
  store['cursor:me'].nextIncAt = 0;
  store['cursor:me'].lastAttemptAt = 0;
  before = server.calls;
  await fire('inc');
  assert.equal(server.calls - before, 1);

  // 发现与接续点重叠立即停止，不再继续往更旧翻页
  const older = { ...env.mention(0.02, '2', '50', '50'), id_str: '1999' };
  feed.splice(9, 0, older);
  store['cursor:me'].nextIncAt = 0;
  store['cursor:me'].lastAttemptAt = 0;
  const countBeforeOverlap = await count();
  before = server.calls;
  await fire('inc');
  assert.equal(server.calls - before, 1);
  assert.equal(await count(), countBeforeOverlap, '接续点重叠后不再往更早翻页');
  feed.splice(feed.indexOf(older), 1);
});

test('提及模板切换与 404 自动回退旧接口', async () => {
  assert.equal(server.mentionTpl, undefined, '没记下之前用旧接口');
  const NT = 'https://x.com/i/api/graphql/NQ/NotificationsTimeline?variables=%7B%22timeline_type%22%3A%22All%22%7D';
  await pageSend({ type: 'xir:tpl', url: NT, kind: 'mentions' });
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  await fire('inc');
  assert.equal(server.mentionTpl, NT);
  assert.equal((await send({ type: 'getAccountState', account: 'me' })).mentionsApi, 'gql');

  const realSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (_id, msg) => (msg.type === 'xir:fetch' && msg.tpl ? { ok: false, status: 404, userId: '1' } : realSend(_id, msg));
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  await fire('inc');
  chrome.tabs.sendMessage = realSend;
  assert.equal(store['tpl:mentions:me'], undefined, '过期的模板删掉');
  assert.ok(store['cursor:me'].nextIncAt - Date.now() <= 5 * 60_000, '三到五分钟后用旧接口重读');

  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  await fire('inc');
  assert.equal(server.mentionTpl, undefined);
});

test('并发去重、429 退避、重复游标与提前空页异常边界', async () => {
  // 两个触发几乎同时到：只跑一轮
  store['cursor:me'].nextIncAt = 0;
  store['cursor:me'].lastAttemptAt = 0;
  let before = server.calls;
  await Promise.all([fire('inc'), fire('inc')]);
  assert.equal(server.calls - before, 1, '同时到的两个触发只跑一轮');

  // 增量被限流：放弃本轮，不推进下一次补漏的锚点
  {
    const savedCursor = structuredClone(store['cursor:me']);
    const beforeAnchor = savedCursor.lastIncrementalAt;
    try {
      Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
      server.fail429Once = true;
      const result = await fire('inc');
      assert.match(result.message, /限流/);
      assert.equal(store['cursor:me'].lastIncrementalAt, beforeAnchor, '失败不推进补漏锚点');
      assert.ok(store['cursor:me'].rateUntil > Date.now());
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
      Object.assign(store['cursor:me'], { syncedId: beforeSync, nextIncAt: 0, lastAttemptAt: 0 });
      delete store['cursor:me'].incResume;
      server.repeatInboundCursor = true;
      const result = await fire('inc');
      assert.match(result.error, /翻页异常/);
      assert.equal(store['cursor:me'].syncedId, beforeSync, '重复游标不推进接续点');
      assert.equal(store['cursor:me'].lastIncrementalAt, beforeAnchor, '重复游标不推进补漏锚点');
      assert.equal(store['cursor:me'].incResume, undefined);
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
      Object.assign(store['cursor:me'], { syncedId: checkpoint, nextIncAt: 0, lastAttemptAt: 0, rateUntil: 0, rate429Count: 0 });
      delete store['cursor:me'].incResume;
      server.earlyEndInboundAfterFirstPage = true;
      const result = await fire('inc');
      assert.match(result.error, /提前结束/);
      assert.equal(store['cursor:me'].syncedId, checkpoint, '提前结束不推进接续点');
      assert.equal(store['cursor:me'].lastIncrementalAt, beforeAnchor, '提前结束不推进补漏锚点');
      assert.equal(store['cursor:me'].incResume, undefined);
      assert.match(store['alert:me'].message, /提前结束/);

      Object.assign(store['cursor:me'], { syncedId: checkpoint, nextIncAt: 0, lastAttemptAt: 0, rateUntil: 0, rate429Count: 0 });
      delete store['cursor:me'].incResume;
      server.emptyInboundOnce = true;
      assert.match((await fire('inc')).error, /提前结束/, '首屏空页也不能当成接上旧位置');
    } finally {
      server.earlyEndInboundAfterFirstPage = false;
      server.emptyInboundOnce = false;
      store['cursor:me'] = savedCursor;
      delete store['alert:me'];
      delete alarms['inc:me'];
    }
  }

  // 没到间隔不抓
  before = server.calls;
  await listeners.alarm({ name: 'tick' });
  assert.equal(server.calls, before);
});

test('工作时段、前台可见性、自动更新开关与旧接续点穿透', { timeout: 20_000 }, async () => {
  // 人类工作时段：夜间不发请求；白天 X 页面不在前台也不发请求
  const daytime = env.getNow();
  const savedCursor = structuredClone(store['cursor:me']);
  try {
    env.setNow(new Date(2026, 10, 21, 2, 0, 0, 0).getTime());
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
    let before = server.calls;
    await listeners.alarm({ name: 'tick' });
    assert.equal(server.calls, before, '凌晨不读取');
    assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /08:00/);

    env.setNow(daytime);
    hiddenTabs.add(1);
    hiddenTabs.add(4);
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
    await listeners.alarm({ name: 'tick' });
    assert.equal(server.calls, before, 'X 页面在后台不读取');
    assert.match((await send({ type: 'updateNowWithReceipt', account: 'me' })).error, /切到.*X 页面/);

    hiddenTabs.delete(1);
    hiddenTabs.delete(4);
    env.setNow(new Date(2026, 10, 21, 12, 0, 0, 0).getTime());
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
    await listeners.alarm({ name: 'tick' });
    assert.equal(server.calls, before, '两个自动窗口之间不读取');

    env.setNow(new Date(2026, 10, 21, 19, 0, 0, 0).getTime());
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
    before = server.calls;
    await listeners.alarm({ name: 'tick' });
    assert.ok(server.calls > before, '晚间自动窗口会读取');
  } finally {
    hiddenTabs.delete(1);
    hiddenTabs.delete(4);
    env.setNow(daytime);
    store['cursor:me'] = savedCursor;
  }

  // 关掉自动更新：清掉遗留自动闹钟，后台 tick 不请求；手动初始化仍可启动
  await chrome.alarms.create('inc:me', { when: Date.now() + 1_000 });
  await chrome.alarms.create('out:me', { when: Date.now() + 1_000 });
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: false } });
  assert.equal(alarms['inc:me'], undefined);
  assert.equal(alarms['out:me'], undefined);
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  const beforeOff = server.calls;
  await listeners.alarm({ name: 'tick' });
  assert.equal(server.calls, beforeOff);
  assert.deepEqual(await send({ type: 'startBackfill', account: 'me' }), { ok: true }, '手动初始化不受自动更新开关影响');
  await until(() => job().pages === 1, '关掉自动更新后仍能手动初始化');
  await send({ type: 'pauseJob', account: 'me' });

  // 接续点尚未重叠时：必须继续读到与接续点重叠为止
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: true } });
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
    Object.assign(store['cursor:me'], { syncedId: '6000', nextIncAt: 0, lastAttemptAt: 0 });
    delete store['cursor:me'].lastIncrementalAt;
    delete store['cursor:me'].incResume;
    delete store['cursor:me'].rateUntil;
    const staleCalls = server.calls;
    const staleCount = await count();
    await fire('inc');
    assert.equal(server.calls - staleCalls, 3, '第 3 页到接续点就停，不依赖列表结束');
    assert.equal(await count(), staleCount + 9, '接续点之前的记录一条不少');
  } finally {
    feed.splice(0, feed.length, ...staleFeed);
    store['cursor:me'] = staleCursor;
  }
});

test('多段续读：单个事件最多 6 页，分段休息后接上并固定锚点', { timeout: 20_000 }, async () => {
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: true } });
  const beforeCount = await count();
  for (let i = 0; i < 130; i++) feed.unshift({ ...env.mention(0, '2', '50', '50'), id_str: String(3000 + i) });
  Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
  const before = server.calls;
  const incrementStartedAt = Date.now();
  await fire('inc');
  assert.equal(server.calls - before, 6, '一次后台事件最多 6 页');
  assert.equal(store['cursor:me'].syncedId, '2006', '没接上之前接续点不动');
  assert.ok(store['cursor:me'].incResume, '记下读到哪了');
  assert.equal(store['cursor:me'].incResume.startedAt, incrementStartedAt, '续读保留整轮的起始时间');
  const rest = alarms['inc:me'].when - Date.now();
  assert.ok(rest >= 179_000 && rest <= 300_000, '休息三到五分钟接着读');
  while (store['cursor:me'].incResume) {
    env.advanceNow(5 * 60_000); // 分多段才读完时，补漏锚点不能被最后一段带偏
    store['cursor:me'].nextIncAt = 0; // 时间到了（lastAttemptAt 还是刚才：补读不受 10 分钟间隔限制）
    await fire('inc');
  }
  assert.equal(server.calls - before, 44, '分多个短任务在重叠接续点时立即停下');
  assert.deepEqual([store['cursor:me'].syncedId, store['cursor:me'].incResume], ['3129', undefined]);
  assert.equal(store['cursor:me'].lastIncrementalAt, incrementStartedAt, '本轮起点保持在开始时刻');
  assert.equal(await count(), beforeCount + 130, '一条不丢');
  feed.splice(0, 130);
});

test('免补历史直接增量与 60 页安全上限拦截', { timeout: 20_000 }, async () => {
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: true } });
  const savedCursor = structuredClone(store['cursor:me']);
  const savedActivation = store.accounts.me.activation;
  const savedFeed = [...feed];
  try {
    // 1. 从未补过历史（无 syncedId）也能直接建起点，且单轮最多读 2 页
    delete store['cursor:me'];
    delete alarms['inc:me'];
    store.accounts.me.activation = Date.now() - 2 * 60 * 60_000; // 两小时前启用
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
    assert.ok(alarms['inc:me'], '免补历史账号开启自动更新后自动安排增量闹钟');
    const beforeInitFree = server.calls;
    await fire('inc');
    assert.equal(server.calls - beforeInitFree, 2, '免补历史首轮最多读 2 页建立接续点');
    assert.equal(store['cursor:me'].syncedId, '7008');

    // 2. 单轮超过 10 段（60 页）仍未重叠接续点：触及安全上限停止，等待人工介入或补历史
    feed.splice(0, feed.length, ...Array.from({ length: 200 }, (_, i) => (
      { ...env.mention(0, '2', '50', '50'), id_str: String(8199 - i) }
    )));
    Object.assign(store['cursor:me'], { syncedId: '7008', nextIncAt: 0, lastAttemptAt: 0 });
    delete store['cursor:me'].incResume;
    delete store['cursor:me'].incLimitReached;
    const beforeCap = server.calls;
    let lastResult = await fire('inc');
    while (store['cursor:me'].incResume) {
      env.advanceNow(5 * 60_000);
      store['cursor:me'].nextIncAt = 0;
      lastResult = await fire('inc');
    }
    assert.equal(server.calls - beforeCap, 60, '10 段累计读取 60 页后触及安全上限');
    assert.match(lastResult.error, /安全页数上限/);
    assert.equal(store['cursor:me'].incLimitReached, true);
    assert.equal(store['cursor:me'].incResume, undefined);
    assert.equal(alarms['inc:me'], undefined, '触及上限后暂停自动定时');
    assert.equal(store['cursor:me'].syncedId, '7008', '未接上时接续点不动');
    assert.match(store['alert:me']?.message, /60 页/);

    // 触发安全上限后自动 tick 不再发请求
    const callsDuringPaused = server.calls;
    store['cursor:me'].nextIncAt = 0;
    await listeners.alarm({ name: 'tick' });
    assert.equal(server.calls, callsDuringPaused, '触及上限后自动读取保持暂停');

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

test('近期真实交互门控：亮屏离座不自动抓，手动更新不受限，回来交互顺带唤醒', { timeout: 20_000 }, async () => {
  await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: true } });
  const savedCursor = structuredClone(store['cursor:me']);
  try {
    // 1. 两个前台标签页虽 visible 但均已空闲超过 5 分钟：自动 tick 和闹钟都不发请求
    idleTabs.add(1);
    idleTabs.add(4);
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0, lastManualAt: 0 });
    delete store['cursor:me'].incResume;
    const beforeIdle = server.calls;
    await listeners.alarm({ name: 'tick' });
    await fire('inc');
    assert.equal(server.calls, beforeIdle, '亮屏但超过 5 分钟无交互时不自动发请求');

    // 2. 手动「立即更新」不受 5 分钟交互门槛限制（只要页面前台可见即可）
    const manualRes = await send({ type: 'updateNowWithReceipt', account: 'me' });
    assert.equal(manualRes.ok, true, '手动立即更新不受空闲交互门控拦截');
    assert.ok(server.calls > beforeIdle);

    // 3. 回到 X 页面产生真实交互：窗口内已有到期任务时经 xir:active 顺带完成，完成后再发不重复抓
    Object.assign(store['cursor:me'], { nextIncAt: 0, lastAttemptAt: 0 });
    const beforeWake = server.calls;
    idleTabs.delete(1);
    await pageSend({ type: 'xir:active' }, 1);
    assert.ok(server.calls > beforeWake, '恢复交互后顺带唤醒并完成到期增量');
    const afterWake = server.calls;
    await pageSend({ type: 'xir:active' }, 1);
    assert.equal(server.calls, afterWake, '本轮已推至下一时段后，后续交互唤醒不重复发请求');
  } finally {
    idleTabs.delete(1);
    idleTabs.delete(4);
    store['cursor:me'] = savedCursor;
    delete alarms['inc:me'];
  }
});
