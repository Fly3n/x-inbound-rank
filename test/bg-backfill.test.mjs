import test from 'node:test';
import assert from 'node:assert/strict';
import { inboundInitCovered, outboundInitCovered } from '../src/rank.js';
import { createBgEnv } from './helpers/bg-env.mjs';

const env = await createBgEnv({
  // 模拟升级：已有任务的账号继续启用，仅被识别过的账号保持关闭。
  initialStore: {
    accounts: { me: { handle: 'Me', userId: '1' }, seen: { handle: 'Seen', userId: '3' } },
    'job:me': { status: 'done', startedAt: 1 },
    current: 'me',
  },
});

const { store, server, listeners, feed, outFeed, send, pageSend, fire, fireJob, job, until, count, boardRows } = env;

test.after(() => env.restore());

test('账号升级迁移、网页提及脱敏证据与入站回填完整流程', { timeout: 20_000 }, async () => {
  await listeners.installed();
  assert.deepEqual(await pageSend({ type: 'xir:hello', handle: 'Me', userId: '1' }), { account: 'me' });
  assert.equal(server.calls, 0, '识别账号不发请求；没初始化过也不自动抓');
  assert.equal(store.accounts.me.enabled, true);
  assert.equal(store.accounts.seen.enabled, false);

  // 网页提及留独立的脱敏证据，包括正式解析器尚不支持的包装结构。
  const nativeUrl = new URL('https://x.com/i/api/graphql/exampleQuery/NotificationsTimeline');
  nativeUrl.searchParams.set('variables', JSON.stringify({ timeline_type: 'Mentions', count: 20, cursor: 'hidden-cursor', userId: 'hidden-account' }));
  nativeUrl.searchParams.set('features', JSON.stringify({ sample_flag: true }));
  nativeUrl.searchParams.set('secret', 'hidden-parameter');
  const nativeBody = {
    data: {
      instructions: [{
        type: 'TimelineAddEntries',
        entries: [{
          content: {
            entryType: 'TimelineFutureModule',
            items: [
              { itemContent: { tweet_results: { result: { rest_id: '700123', legacy: { full_text: 'hidden-body' } } } } },
              { __typename: 'User', legacy: { id_str: '800456' } },
            ],
          },
        }],
      }],
    },
  };
  const nativePayload = {
    type: 'xir:mentions:evidence', url: nativeUrl.href, status: 200,
    metadata: { age: '120', cache: 'HIT internal-node' }, text: JSON.stringify(nativeBody),
  };
  await pageSend(nativePayload, 4);
  const evidence = (await send({ type: 'getDiagnostics', account: 'me' })).find((event) => event.event === 'web_mentions_response');
  assert.equal(evidence.tabId, 4);
  assert.equal(evidence.evidence.request.count, 20);
  assert.equal(evidence.evidence.request.hasCursor, true);
  assert.match(evidence.evidence.request.featureHash, /^[0-9a-f]{16}$/);
  assert.deepEqual(evidence.evidence.response.postIds, ['700123']);
  assert.ok(evidence.evidence.response.timelineShapes.includes('TimelineFutureModule'));
  assert.equal(evidence.evidence.response.ageSeconds, 120);
  assert.deepEqual(evidence.evidence.response.cache, ['HIT']);
  assert.doesNotMatch(JSON.stringify(evidence), /hidden-|internal-node/);
  assert.equal(await count(), 0, '网页证据不入库');
  assert.equal(server.calls, 0, '网页证据不发新请求');

  // 回填，默认窗口 7 天：第 1 页
  assert.deepEqual(await send({ type: 'startBackfill', account: 'me' }), { ok: true });
  assert.equal(job().rangeDays, 7);
  await until(() => job().pages === 1 && job().nextAt, '第 1 页');
  assert.equal(job().status, 'running');
  assert.ok(job().nextAt - Date.now() >= 7_000, '两页之间要等，不连着拉');

  // 第 2 次请求被限流：暂停、定好自动恢复时间、不丢进度
  server.fail429Once = true;
  await fireJob();
  assert.equal(job().status, 'paused');
  assert.equal(job().auto, true);
  assert.equal(job().pages, 1);
  assert.ok(job().nextAt - Date.now() >= 14 * 60_000, '退避至少 15 分钟');
  assert.equal(store['cursor:me'].rate429Count, 1);

  // 退避到点后续跑，遇到 503 临时不可用时安排稍后重试，并清理过期诊断日志
  env.setNow(Math.max(env.getNow(), store['cursor:me'].rateUntil || 0));
  const sendPage = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (id, msg) => msg.type === 'xir:ping' ? sendPage(id, msg) : { ok: false, status: 503, userId: '1' };
  await fireJob();
  chrome.tabs.sendMessage = sendPage;
  assert.equal(job().status, 'paused');
  assert.equal(job().pages, 1);
  assert.equal(job().cursor, '3');
  assert.ok(job().nextAt - Date.now() > 299_000);

  const oldHour = Math.floor(Date.now() / 3_600_000) - 8 * 24;
  const expiredKey = `diagnostics:${oldHour}`;
  store[expiredKey] = [{ at: oldHour * 3_600_000, event: 'expired' }];
  const diagnostics = await send({ type: 'getDiagnostics', account: 'me' });
  const failedPage = diagnostics.find((event) => event.event === 'request' && event.status === 503);
  assert.equal(failedPage.mode, 'inbound_backfill');
  assert.equal(failedPage.page, 2);
  assert.ok(diagnostics.some((event) => event.event === 'retry_scheduled' &&
    event.run === failedPage.run && event.page === failedPage.page));
  assert.ok(diagnostics.some((event) => event.event === 'page_saved' &&
    event.decisions?.some((item) => item.postId === '1000' && item.reason === 'accepted_own_root')));
  assert.ok(diagnostics.some((event) => event.event === 'request' &&
    event.evidence?.request.api === 'rest' && event.evidence.response.postIds.includes('1000')));
  assert.equal(store[expiredKey], undefined);
  assert.ok(diagnostics.some((event) => event.event === 'request' && event.status === 503 && event.continuation));
  assert.ok(diagnostics.some((event) => event.event === 'retry_scheduled' && event.status === 503));

  await fireJob(); // 退避到点：重试第 2 页
  while (job().status === 'running') await fireJob();
  assert.equal(job().status, 'done');
  assert.equal(job().reachedEnd, false);
  assert.equal(server.calls, 4);
  assert.equal(await count(), 8, '多读一页跨过时间边界，避免混排导致漏页');

  // 榜单：Other 那条是我去别人帖子下评论后的回复，不上榜
  await env.setWindow(7);
  assert.deepEqual((await boardRows()).map((r) => [r.handle, r.count]), [['Fan', 4]]);
  assert.deepEqual(store['snap:me'].users.fan, { rank: 1, count: 4, color: 'gray', last: store['snap:me'].users.fan.last });
});

test('重新初始化去重、防重入与重复游标异常', { timeout: 20_000 }, async () => {
  await env.setSettings({ initDays: 15, windowDays: 15 });
  const reinitStartedAt = Date.now();
  await send({ type: 'startBackfill', account: 'me' });
  await until(() => job().pages === 1 && job().nextAt, '重跑第 1 页');
  await send({ type: 'startBackfill', account: 'me' });
  assert.equal(job().pages, 1, '重复初始化不会重置正在进行的任务');
  while (job().status === 'running') await fireJob();
  assert.equal(job().status, 'done');
  assert.equal(job().reachedEnd, true);
  assert.equal(await count(), 8);
  assert.equal(job().rangeDays, 15);
  assert.deepEqual((await boardRows()).map((r) => [r.handle, r.count]), [['Fan', 7]]);
  assert.equal(store['cursor:me'].lastIncrementalAt, reinitStartedAt, '重新初始化完成后重置旧补漏锚点');

  // 回填遇到重复游标：暂停在异常处，不把半截数据标成“列表到底”
  const savedJob = structuredClone(job());
  const savedCursor = structuredClone(store['cursor:me']);
  try {
    server.repeatInboundCursor = true;
    await send({ type: 'startBackfill', account: 'me' });
    await until(() => job().pages === 1 && job().nextAt, '重复游标测试的第 1 页');
    await fireJob();
    assert.equal(job().status, 'error');
    assert.match(job().message, /重复的翻页位置/);
    assert.equal(store['cursor:me'].syncedId, savedCursor.syncedId, '异常时不推进接续点');
    assert.deepEqual(store['cursor:me'].lastBackfill, savedCursor.lastBackfill, '异常时不改上次覆盖范围');
  } finally {
    server.repeatInboundCursor = false;
    store['job:me'] = savedJob;
    store['cursor:me'] = savedCursor;
    delete store['alert:me'];
    delete env.alarms['job:me'];
  }
});

test('入站和出站可信空列表初始化', { timeout: 20_000 }, async () => {
  assert.equal((await send({ type: 'clearData', account: 'me' })).ok, true);
  await env.setSettings({ initDays: 7, fetchEnabled: false });
  store['tpl:replies:me'] = { url: 'https://x.com/i/api/graphql/QID/UserTweetsAndReplies?variables=%7B%7D', at: Date.now() };

  const emptySavedInbound = feed.splice(0, feed.length);
  const emptySavedOutbound = outFeed.splice(0, outFeed.length);
  try {
    await send({ type: 'startBackfill', account: 'me' });
    await until(() => job()?.status === 'done', '空的别人回我初始化完成');
    assert.deepEqual([job().reachedEnd, job().oldestTs], [true, null]);
    assert.equal(store['cursor:me'].syncedId, '0');
    assert.equal(inboundInitCovered(store['cursor:me'].lastBackfill, store['cursor:me'].syncedId, 7), true);

    await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: true } });
    await send({ type: 'syncOutNow', account: 'me' });
    await until(() => store['cursor:me'].out?.lastAt, '空的我回别人初始化完成');
    const emptyOut = store['cursor:me'].out;
    assert.deepEqual([emptyOut.reachedEnd, emptyOut.coverTs, emptyOut.syncedId], [true, null, '0']);
    assert.equal(outboundInitCovered(emptyOut, 7), true);

    emptyOut.nextAutoAt = 0;
    await fire('out');
    assert.deepEqual([store['cursor:me'].out.status, store['cursor:me'].out.syncedId], ['ok', '0'], '可信空列表的日常增量不会报假异常');
    await send({ type: 'setSettings', account: 'me', patch: { fetchEnabled: false } });
  } finally {
    feed.splice(0, feed.length, ...emptySavedInbound);
    outFeed.splice(0, outFeed.length, ...emptySavedOutbound);
  }
});
