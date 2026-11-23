import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const tap = readFileSync(new URL('../src/content/tap.js', import.meta.url), 'utf8');
const rel = readFileSync(new URL('../src/content/rel.js', import.meta.url), 'utf8');
const fetcher = readFileSync(new URL('../src/x/fetcher.js', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('页面仅旁听已启用会话，切号丢弃迟到响应和页面缓存', async () => {
  const events = [];
  const listeners = [];
  const doc = { cookie: 'twid=u%3D9' };
  const origin = 'https://x.com';
  let storageChanged;
  let settle;
  let cloned = 0;
  const window = {
    addEventListener: (_, fn) => listeners.push(fn),
    postMessage(data) {
      events.push(data);
      for (const listener of listeners) listener({ data, source: window, origin });
    },
    fetch: () => new Promise((resolve) => { settle = resolve; }),
  };
  const xhr = class { open() {} };
  const globals = {
    window, document: doc, location: { href: origin + '/home', origin }, URL, XMLHttpRequest: xhr,
    setInterval: () => {},
    chrome: {
      storage: {
        local: { get: async () => ({ accounts: { 'uid-1': { enabled: true, userId: '1', activation: 5 } } }) },
        onChanged: { addListener: (fn) => { storageChanged = fn; } },
      },
    },
  };
  // Chrome 的 MAIN 和隔离环境共享页面消息机制，各自有脚本全局环境。
  runInNewContext(tap, { ...globals });
  const isolated = { ...globals };
  runInNewContext(fetcher + '\n' + rel, isolated);
  await flush();

  const fetchResponse = {
    status: 200, headers: new Map(),
    clone() {
      cloned++;
      return { text: async () => '{}' };
    },
  };
  const url = origin + '/i/api/graphql/example/FetchScheduledTweets';
  let pending = window.fetch(url);
  settle(fetchResponse);
  await pending;
  await flush();
  assert.equal(cloned, 0, '新账号既不读取响应体，也不采集接口模板');
  assert.equal(events.some((e) => e.xirTpl), false);

  doc.cookie = 'twid="u%3D1"';
  assert.equal(isolated.XIRRel.session().account, 'uid-1');
  pending = window.fetch(url);
  settle(fetchResponse);
  await pending;
  await flush();
  assert.equal(cloned, 1);
  assert.equal(isolated.XIRRel.tpls.at(-1), url);

  pending = window.fetch(url);
  doc.cookie = 'twid=u%3D9';
  assert.equal(isolated.XIRRel.session(), null);
  settle(fetchResponse);
  await pending;
  await flush();
  assert.equal(cloned, 1);
  assert.equal(isolated.XIRRel.tpls.length, 0);

  doc.cookie = 'twid=u%3D1';
  isolated.XIRRel.session();
  storageChanged({ accounts: { newValue: { 'uid-1': { enabled: false, userId: '1', activation: 6 } } } }, 'local');
  assert.equal(isolated.XIRRel.session(), null);

  // CreateTweet 回复旁听仅对已启用账号触发，未启用或切号期间丢弃
  storageChanged({ accounts: { newValue: { 'uid-1': { enabled: true, userId: '1', activation: 7 } } } }, 'local');
  doc.cookie = 'twid=u%3D1';
  const createTaps = [];
  isolated.XIRRel.onCreateTweetTap = (text) => createTaps.push(text);
  isolated.XIRRel.session();
  const createUrl = origin + '/i/api/graphql/ct1/CreateTweet';
  pending = window.fetch(createUrl, { method: 'POST' });
  settle({
    status: 200, headers: new Map(),
    clone: () => ({ text: async () => '{"data":{"create_tweet":{"tweet_results":{"result":{"rest_id":"9"}}}}}' }),
  });
  await pending;
  await flush();
  assert.equal(createTaps.length, 1, '已启用账号的 CreateTweet 响应触发旁听回调');

  doc.cookie = 'twid=u%3D9';
  pending = window.fetch(createUrl, { method: 'POST' });
  settle({
    status: 200, headers: new Map(),
    clone: () => ({ text: async () => '{"data":{"create_tweet":{"tweet_results":{"result":{"rest_id":"10"}}}}}' }),
  });
  await pending;
  await flush();
  assert.equal(createTaps.length, 1, '未启用账号的 CreateTweet 响应不触发旁听回调');
});
