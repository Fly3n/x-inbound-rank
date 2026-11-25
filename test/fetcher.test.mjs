// 抓取层模板识别与自有请求集合（src/x/fetcher.js）
// 运行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('抓取层：模板识别且自有请求集合有容量上限', async () => {
  const fetcherCode = readFileSync(new URL('../src/x/fetcher.js', import.meta.url), 'utf8');
  const sentUrls = [];
  const ctx = {
    location: { origin: 'https://x.com' },
    URL,
    URLSearchParams,
    document: { cookie: 'twid=u%3D1; ct0=tok', documentElement: { lang: 'en' } },
    fetch: async (url) => {
      sentUrls.push(url);
      return { ok: true, status: 200, headers: new Map(), text: async () => '{}' };
    },
  };
  runInNewContext(fetcherCode, ctx);
  const { tplKind, fetchMentions, fetchMyReplies, fetchScheduled, isOwn } = ctx.XIRFetcher;

  assert.equal(tplKind('https://x.com/i/api/graphql/Q1/UserRepliesTimeline?variables=%7B%7D'), 'replies');
  assert.equal(tplKind('https://x.com/i/api/graphql/Q2/NotificationsTimeline?variables=%7B%7D'), 'mentions');
  assert.equal(tplKind('https://x.com/i/api/graphql/Q3/FetchScheduledTweets'), 'scheduled');
  assert.equal(tplKind('https://evil.example/i/api/graphql/Q1/UserRepliesTimeline?variables=%7B%7D'), null);
  assert.equal(tplKind('https://x.com/i/api/graphql/Q4/HomeTimeline?variables=%7B%7D'), null);

  const missingTpl = await fetchMentions('c_no_tpl');
  assert.equal(missingTpl.error, 'bad_tpl', '无通知模板时拒绝降级旧 REST');
  assert.equal(sentUrls.length, 0);

  const ntTpl = 'https://x.com/i/api/graphql/Q2/NotificationsTimeline?variables=%7B%7D';
  for (let i = 0; i < 505; i++) {
    await fetchMentions(`c${i}`, ntTpl);
  }
  await fetchMyReplies('https://x.com/i/api/graphql/Q1/UserRepliesTimeline?variables=%7B%7D', 'c_out');
  await fetchScheduled('https://x.com/i/api/graphql/Q3/FetchScheduledTweets');

  assert.equal(sentUrls.length, 507);
  assert.equal(isOwn(sentUrls[0]), false, '最早的请求应被淘汰');
  assert.equal(isOwn(sentUrls[6]), false, '超出 500 上限的早期请求应被淘汰');
  assert.equal(isOwn(sentUrls[7]), true, '第 500 个起的最新请求应保留');
  assert.equal(isOwn(sentUrls.at(-1)), true, '最近发出的请求应保留');
});
