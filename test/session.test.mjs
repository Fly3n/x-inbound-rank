import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const tap = readFileSync(new URL('../src/content/tap.js', import.meta.url), 'utf8');
const rel = readFileSync(new URL('../src/content/rel.js', import.meta.url), 'utf8');
const fetcher = readFileSync(new URL('../src/x/fetcher.js', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeHarness() {
  const postMessages = [];
  const docListeners = new Map();
  const doc = {
    cookie: 'twid=u%3D9',
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      for (const fn of [...(docListeners.get(event.type) || [])]) fn(event);
      return true;
    },
  };
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const origin = 'https://x.com';
  let storageChanged;
  let settle;
  const window = {
    addEventListener: () => {},
    postMessage(data) {
      postMessages.push(data);
    },
    fetch: () => new Promise((resolve) => { settle = resolve; }),
  };
  const xhr = class { open() {} };
  const globals = {
    window, document: doc, CustomEvent, location: { href: origin + '/home', origin }, URL, XMLHttpRequest: xhr,
    setInterval: () => {},
    chrome: {
      storage: {
        local: { get: async () => ({ accounts: { 'uid-1': { enabled: true, userId: '1', activation: 5 } } }) },
        onChanged: { addListener: (fn) => { storageChanged = fn; } },
      },
    },
  };
  return {
    postMessages, doc, origin, window, globals,
    getStorageChanged: () => storageChanged,
    settle: (res) => settle(res),
  };
}

test('页面仅旁听已启用会话（走私有随机通道、零 window.postMessage），两种加载顺序均正常且切号丢弃迟到响应', async () => {
  for (const order of ['main-first', 'isolated-first']) {
    const h = makeHarness();
    const { postMessages, doc, origin, window, globals } = h;
    let cloned = 0;
    const isolated = { ...globals };
    if (order === 'main-first') {
      runInNewContext(tap, { ...globals });
      runInNewContext(fetcher + '\n' + rel, isolated);
    } else {
      runInNewContext(fetcher + '\n' + rel, isolated);
      runInNewContext(tap, { ...globals });
    }
    await flush();

    // P2-1: 无论哪种加载顺序，握手完成后 BOOT_READY 监听已摘除，页面脚本重放 ui:ch:r 拿不到随机通道名
    const leaked = [];
    doc.addEventListener('ui:ch:i', (e) => leaked.push(e.detail));
    doc.dispatchEvent(new globals.CustomEvent('ui:ch:r'));
    assert.equal(leaked.length, 0, `${order}: 握手完成后页面脚本伪造 ui:ch:r 不得再泄露通道名`);

    const fetchResponse = {
      status: 200, headers: new Map(),
      clone() {
        cloned++;
        return { text: async () => '{}' };
      },
    };
    const url = origin + '/i/api/graphql/example/FetchScheduledTweets';
    let pending = window.fetch(url);
    h.settle(fetchResponse);
    await pending;
    await flush();
    assert.equal(cloned, 0, `${order}: 新账号既不读取响应体，也不采集接口模板`);
    assert.equal(postMessages.length, 0, `${order}: 不得向 window.postMessage 广播`);

    doc.cookie = 'twid="u%3D1"';
    assert.equal(isolated.XIRRel.session().account, 'uid-1');
    pending = window.fetch(url);
    h.settle(fetchResponse);
    await pending;
    await flush();
    assert.equal(cloned, 1);
    assert.equal(isolated.XIRRel.tpls.at(-1), url);

    pending = window.fetch(url);
    doc.cookie = 'twid=u%3D9';
    assert.equal(isolated.XIRRel.session(), null);
    h.settle(fetchResponse);
    await pending;
    await flush();
    assert.equal(cloned, 1);
    assert.equal(isolated.XIRRel.tpls.length, 0);

    doc.cookie = 'twid=u%3D1';
    isolated.XIRRel.session();
    h.getStorageChanged()({ accounts: { newValue: { 'uid-1': { enabled: false, userId: '1', activation: 6 } } } }, 'local');
    assert.equal(isolated.XIRRel.session(), null);

    // CreateTweet 回复旁听仅对已启用账号触发，未启用或切号期间丢弃
    h.getStorageChanged()({ accounts: { newValue: { 'uid-1': { enabled: true, userId: '1', activation: 7 } } } }, 'local');
    doc.cookie = 'twid=u%3D1';
    const createTaps = [];
    isolated.XIRRel.onCreateTweetTap = (text) => createTaps.push(text);
    isolated.XIRRel.session();
    const createUrl = origin + '/i/api/graphql/ct1/CreateTweet';
    pending = window.fetch(createUrl, { method: 'POST' });
    h.settle({
      status: 200, headers: new Map(),
      clone: () => ({ text: async () => '{"data":{"create_tweet":{"tweet_results":{"result":{"rest_id":"9"}}}}}' }),
    });
    await pending;
    await flush();
    assert.equal(createTaps.length, 1, `${order}: 已启用账号的 CreateTweet 响应触发旁听回调`);

    doc.cookie = 'twid=u%3D9';
    pending = window.fetch(createUrl, { method: 'POST' });
    h.settle({
      status: 200, headers: new Map(),
      clone: () => ({ text: async () => '{"data":{"create_tweet":{"tweet_results":{"result":{"rest_id":"10"}}}}}' }),
    });
    await pending;
    await flush();
    assert.equal(createTaps.length, 1, `${order}: 未启用账号的 CreateTweet 响应不触发旁听回调`);

    // NotificationsTimeline（含 All 与 Mentions）和 UserRepliesTimeline：加载期先缓冲、挂回调后直达、切号清空
    doc.cookie = 'twid=u%3D1';
    isolated.XIRRel.session();
    const notifAllUrl = origin + '/i/api/graphql/n1/NotificationsTimeline?variables=' + encodeURIComponent(JSON.stringify({ timeline_type: 'All', count: 40 }));
    const repliesUrl = origin + '/i/api/graphql/r1/UserRepliesTimeline?variables=' + encodeURIComponent(JSON.stringify({ userId: '1', count: 20 }));
    pending = window.fetch(notifAllUrl);
    h.settle({ status: 200, headers: new Map([['age', '5']]), clone: () => ({ text: async () => '{"data":{"notif":1}}' }) });
    await pending;
    await flush();
    assert.equal(isolated.XIRRel.notificationsTaps.length, 1, `${order}: 回调未就绪前通知旁听进入短缓冲`);
    assert.equal(isolated.XIRRel.notificationsTaps[0].url, notifAllUrl);
    assert.equal(isolated.XIRRel.notificationsTaps[0].metadata.age, '5');

    pending = window.fetch(repliesUrl);
    h.settle({ status: 200, headers: new Map(), clone: () => ({ text: async () => '{"data":{"replies":1}}' }) });
    await pending;
    await flush();
    assert.equal(isolated.XIRRel.repliesTaps.length, 1, `${order}: 回调未就绪前回复栏旁听进入短缓冲`);
    assert.equal(isolated.XIRRel.repliesTaps[0].url, repliesUrl);

    const notifDelivered = [];
    const repliesDelivered = [];
    isolated.XIRRel.onNotificationsTap = (item) => notifDelivered.push(item);
    isolated.XIRRel.onRepliesTap = (item) => repliesDelivered.push(item);
    const notifMentionsUrl = origin + '/i/api/graphql/n1/NotificationsTimeline?variables=' + encodeURIComponent(JSON.stringify({ timeline_type: 'Mentions', count: 40 }));
    pending = window.fetch(notifMentionsUrl);
    h.settle({ status: 200, headers: new Map(), clone: () => ({ text: async () => '{"data":{"notif":2}}' }) });
    await pending;
    await flush();
    assert.equal(notifDelivered.length, 1, `${order}: 挂回调后通知旁听直接投递`);
    assert.equal(notifDelivered[0].url, notifMentionsUrl);

    pending = window.fetch(repliesUrl);
    h.settle({ status: 200, headers: new Map(), clone: () => ({ text: async () => '{"data":{"replies":2}}' }) });
    await pending;
    await flush();
    assert.equal(repliesDelivered.length, 1, `${order}: 挂回调后回复栏旁听直接投递`);

    doc.cookie = 'twid=u%3D9';
    assert.equal(isolated.XIRRel.session(), null);
    assert.equal(isolated.XIRRel.notificationsTaps.length, 0, `${order}: 切号清空通知旁听缓冲`);
    assert.equal(isolated.XIRRel.repliesTaps.length, 0, `${order}: 切号清空回复栏旁听缓冲`);
    assert.equal(isolated.XIRRel.tweetTexts.size, 0, `${order}: 切号清空推文原文内存缓存`);
    assert.equal(postMessages.length, 0, `${order}: 全程零 window.postMessage 明文广播`);
  }
});
