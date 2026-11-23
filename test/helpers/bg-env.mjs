// 后台测试通用环境：提供假 chrome API、可控时钟、假 X 服务端状态与常用测试辅助。
// 测试中将 1 秒以上的 setTimeout 压成立刻执行，仅验证调度逻辑与边界条件。
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

export const DAY = 86400000;

export async function createBgEnv({
  initialNow = new Date(2026, 10, 21, 9, 0, 0, 0).getTime(),
  initialStore = null,
  initialSessions = [[1, { userId: '1', handle: 'Me' }], [4, { userId: '1', handle: 'Me' }]],
  initialActiveTab = 1,
  version = 'test-version',
} = {}) {
  const realSetTimeout = globalThis.setTimeout;
  const realDateNow = Date.now;
  const realRandom = Math.random;

  let activeNow = initialNow;
  let randomOverride = null;
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 1000 ? 0 : ms, ...args);
  Date.now = () => activeNow;
  Math.random = () => randomOverride ?? realRandom();

  const store = structuredClone(initialStore || {
    accountIsolationV1: true,
    accounts: {
      me: { handle: 'Me', userId: '1', enabled: true, activation: 1 },
      seen: { handle: 'Seen', userId: '3', enabled: false, activation: null },
    },
  });
  const sessionStore = {};
  const alarms = {};
  const tabUrls = new Map();
  const tab = (id) => ({ id, url: tabUrls.get(id) || 'https://x.com/home' });
  const sessions = new Map(initialSessions);
  const staleTabs = new Set();
  const loadingTabs = new Set();
  const hiddenTabs = new Set();
  const idleTabs = new Set();
  const reloadCalls = [];
  let activeTab = initialActiveTab;
  const listeners = {};
  const hook = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const pick = (k) => (Array.isArray(k) ? k : [k]);

  const users = { 1: { screen_name: 'Me', name: 'Me' }, 2: { screen_name: 'Fan', name: 'Fan' }, 3: { screen_name: 'Other', name: 'Other' } };
  let seq = 1000;
  const mention = (daysAgo, uid, conv, replyTo) => ({
    id_str: String(seq--),
    user_id_str: uid,
    created_at: new Date(Date.now() - daysAgo * DAY).toUTCString(),
    in_reply_to_user_id_str: '1',
    in_reply_to_screen_name: 'Me',
    in_reply_to_status_id_str: replyTo,
    conversation_id_str: conv,
  });
  const feed = [
    mention(0.1, '2', '50', '50'),
    mention(1, '2', '50', '50'),
    mention(2, '3', '60', '61'), // 我在别人帖子(60)下评论，对方回我
    mention(3, '2', '51', '51'),
    mention(5, '2', '51', '51'),
    mention(8, '2', '52', '52'),
    mention(12, '2', '52', '52'),
    mention(14, '2', '53', '53'),
  ];
  const otherRoot = { id_str: '60', user_id_str: '3', created_at: new Date(Date.now() - 3 * DAY).toUTCString() };

  const server = {
    calls: 0, fail429Once: false, repeatInboundCursor: false,
    earlyEndInboundAfterFirstPage: false, emptyInboundOnce: false,
    outCalls: 0, outFail429Once: false, repeatOutCursor: false,
    earlyEndOutAfterFirstPage: false, emptyOutOnce: false,
    scheduledFail429Once: false, outUrls: [], opened: [], closed: [], tplOnOpen: null,
  };

  const mine = (id, daysAgo, rootUid) => ({
    entryId: `profile-conversation-${id}`,
    content: { items: [{ item: { itemContent: { tweet_results: { result: {
      rest_id: id,
      core: { user_results: { result: { rest_id: '1', core: { screen_name: 'Me' } } } },
      legacy: {
        id_str: id, user_id_str: '1', created_at: new Date(Date.now() - daysAgo * DAY).toUTCString(), full_text: 'hi',
        in_reply_to_status_id_str: `r${id}`, in_reply_to_user_id_str: rootUid, conversation_id_str: `r${id}`,
      },
    } } } } }] },
  });
  const outFeed = [
    mine('9005', 0.2, '2'), mine('9004', 1, '2'), mine('9003', 3, '3'),
    mine('9002', 9, '2'), mine('9001', 13, '2'), mine('9000', 20, '2'),
  ];

  function respondOut(msg) {
    server.outCalls++;
    server.outUrls.push(msg.tpl);
    if (server.outFail429Once) {
      server.outFail429Once = false;
      return { ok: false, status: 429, userId: '1', rateResetAt: null };
    }
    if (server.emptyOutOnce) {
      server.emptyOutOnce = false;
      return { ok: true, status: 200, userId: '1', rateResetAt: null, body: { data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [] }] } } } } } } };
    }
    if (server.earlyEndOutAfterFirstPage && msg.cursor) {
      server.earlyEndOutAfterFirstPage = false;
      return { ok: true, status: 200, userId: '1', rateResetAt: null, body: { data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [] }] } } } } } } };
    }
    const start = Number(msg.cursor || 0);
    const entries = outFeed.slice(start, start + 2);
    const repeated = !!server.repeatOutCursor && !!msg.cursor;
    if (repeated) server.repeatOutCursor = false;
    const next = repeated ? msg.cursor : String(start + 2);
    if (start + 2 < outFeed.length || repeated) {
      entries.push({ entryId: 'cursor-bottom', content: { value: next, cursorType: 'Bottom' } });
    }
    return { ok: true, status: 200, userId: '1', rateResetAt: null, body: { data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } } } };
  }

  function respond(cursor) {
    server.calls++;
    if (server.fail429Once) {
      server.fail429Once = false;
      return { ok: false, status: 429, userId: '1', rateResetAt: null };
    }
    if (server.emptyInboundOnce) {
      server.emptyInboundOnce = false;
      return {
        ok: true, status: 200, userId: '1', rateResetAt: null,
        requestUrl: 'https://x.com/i/api/2/notifications/mentions.json?count=20', responseMetadata: { age: '0' },
        body: { globalObjects: {}, timeline: { id: 't', instructions: [{ addEntries: { entries: [] } }] } },
      };
    }
    if (server.earlyEndInboundAfterFirstPage && cursor) {
      server.earlyEndInboundAfterFirstPage = false;
      return {
        ok: true, status: 200, userId: '1', rateResetAt: null,
        requestUrl: 'https://x.com/i/api/2/notifications/mentions.json?count=20', responseMetadata: { age: '0' },
        body: { globalObjects: {}, timeline: { id: 't', instructions: [{ addEntries: { entries: [] } }] } },
      };
    }
    const start = Number(cursor || 0);
    const page = feed.slice(start, start + 3);
    const entries = page.map((t) => ({ entryId: `tweet-${t.id_str}`, content: { item: { content: { tweet: { id: t.id_str } } } } }));
    const next = server.repeatInboundCursor && cursor ? (server.repeatInboundCursor = false, cursor) : String(start + 3);
    if (page.length) entries.push({ entryId: 'cursor-bottom', content: { operation: { cursor: { value: next, cursorType: 'Bottom' } } } });
    const tweets = Object.fromEntries([...page, otherRoot].map((t) => [t.id_str, t]));
    return {
      ok: true, status: 200, userId: '1', rateResetAt: null,
      requestUrl: 'https://x.com/i/api/2/notifications/mentions.json?count=20', responseMetadata: { age: '0' },
      body: { globalObjects: page.length ? { tweets, users } : {}, timeline: { id: 't', instructions: [{ addEntries: { entries } }] } },
    };
  }

  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => Object.fromEntries((k === null ? Object.keys(store) : pick(k)).filter((x) => x in store).map((x) => [x, structuredClone(store[x])])),
        set: async (o) => void Object.assign(store, structuredClone(o)),
        remove: async (k) => void pick(k).forEach((x) => delete store[x]),
      },
      session: {
        get: async (k) => Object.fromEntries((k === null ? Object.keys(sessionStore) : pick(k)).filter((x) => x in sessionStore).map((x) => [x, structuredClone(sessionStore[x])])),
        set: async (o) => void Object.assign(sessionStore, structuredClone(o)),
        remove: async (k) => void pick(k).forEach((x) => delete sessionStore[x]),
      },
    },
    alarms: {
      create: async (name, opts) => void (alarms[name] = { ...opts, scheduledTime: opts.when }),
      get: async (name) => alarms[name],
      clear: async (name) => delete alarms[name],
      onAlarm: hook('alarm'),
    },
    runtime: {
      getManifest: () => ({ version }),
      onInstalled: hook('installed'),
      onStartup: hook('startup'),
      onMessage: hook('message'),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: hook('windowFocus'),
    },
    tabs: {
      query: async ({ active } = {}) => (active ? [tab(activeTab)] : [...sessions.keys()].map((id) => ({ ...tab(id), status: loadingTabs.has(id) ? 'loading' : 'complete' }))),
      get: async (id) => ({ ...tab(id), status: loadingTabs.has(id) ? 'loading' : 'complete' }),
      reload: async (id) => {
        reloadCalls.push(id);
        staleTabs.delete(id);
      },
      onActivated: hook('activated'),
      onUpdated: hook('updated'),
      sendMessage: async (id, msg) => {
        const session = sessions.get(id);
        if (msg.type === 'xir:ping') return session ? { ok: true, version: staleTabs.has(id) ? 'old-version' : version, visible: !hiddenTabs.has(id), lastActiveAt: idleTabs.has(id) ? activeNow - 10 * 60_000 : activeNow, ...session } : null;
        if (session?.userId !== msg.userId) throw new Error('向错误的标签页发出了请求');
        if (msg.kind === 'out') return { ...respondOut(msg), userId: session.userId };
        server.mentionTpl = msg.tpl;
        return { ...respond(msg.cursor), userId: session.userId };
      },
    },
  };

  await import('../../src/background.js');

  const send = (msg, sender = {}) => new Promise((resolve) => listeners.message(msg, sender, resolve));
  const pageSend = (msg, id = 1, userId = sessions.get(id)?.userId) => send({
    userId,
    activation: Object.values(store.accounts || {}).find((entry) => entry.enabled && entry.userId === userId)?.activation,
    ...msg,
  }, { tab: tab(id), frameId: 0 });
  const fire = async (kind, account = 'me') => {
    const name = `${kind}:${account}`;
    delete alarms[name];
    return listeners.alarm({ name });
  };
  const job = (account = 'me') => store[`job:${account}`];
  async function until(cond, what) {
    for (let i = 0; i < 400; i++) {
      if (cond()) return;
      await new Promise((r) => realSetTimeout(r, 5));
    }
    assert.fail(`等待超时：${what}`);
  }
  async function fireJob(account = 'me') {
    store[`job:${account}`].nextAt = 0;
    await fire('job', account);
  }
  const count = async (account = 'me') => (await send({ type: 'getAccountState', account })).db.in.count;
  const boardRows = async (account = 'me') => (await send({ type: 'getBoard', account })).rows;
  const setSettings = (patch, account = 'me') => send({ type: 'setSettings', account, patch });
  const setWindow = (days, account = 'me') => setSettings({ windowDays: days }, account);

  return {
    DAY,
    store,
    sessionStore,
    alarms,
    server,
    sessions,
    tabUrls,
    staleTabs,
    loadingTabs,
    hiddenTabs,
    idleTabs,
    reloadCalls,
    listeners,
    feed,
    outFeed,
    mention,
    mine,
    otherRoot,
    getNow: () => activeNow,
    setNow: (t) => { activeNow = t; },
    advanceNow: (ms) => { activeNow += ms; },
    setRandom: (v) => { randomOverride = v; },
    setActiveTab: (id) => { activeTab = id; },
    send,
    pageSend,
    fire,
    fireJob,
    job,
    until,
    count,
    boardRows,
    setSettings,
    setWindow,
    restore() {
      globalThis.setTimeout = realSetTimeout;
      Date.now = realDateNow;
      Math.random = realRandom;
    },
  };
}
