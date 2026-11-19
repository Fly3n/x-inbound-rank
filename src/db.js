// 存储层：互动事件放 IndexedDB（别人对我的回复、我在别人帖子下的回复各一个表），按账号隔离；小状态放 chrome.storage.local。

import { DEFAULT_RULES, cleanRules } from './rank.js';

const DB_NAME = 'xir';
const STORE = 'events'; // 别人对我的回复
export const OUT = 'out'; // 我在别人帖子下的回复
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2); // 2：加了 out
    req.onupgradeneeded = () => {
      // 主键 [account, id]：同一互动 ID 在同一账号下只存一条，去重靠它
      for (const name of [STORE, OUT]) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: ['account', 'id'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const accountRange = (account) => IDBKeyRange.bound([account, ''], [account, '￿']);

// 整表读的结果缓存在内存里（Service Worker 活着的这一阵）：算一次榜、弹窗打开一次、通知页问一次归属，
// 都要把整张表读一遍，同一份数据没变时不必反复读。写入、清理、清空时作废。
// 返回的数组是冻结的、和别处共用，调用方不能改它（要排序先复制）。
const cache = new Map(); // `${表名}\n${账号}` -> Promise<rows>
const cacheKey = (account, name) => `${name}\n${account}`;
const forget = (account, names) => names.forEach((n) => cache.delete(cacheKey(account, n)));

/** 写入事件，返回其中新增（此前不存在）的条数。 */
export async function putEvents(account, events, name = STORE) {
  if (!events.length) return 0;
  forget(account, [name]);
  try {
    return await putRows(account, events, name);
  } finally {
    forget(account, [name]);
  }
}

async function putRows(account, events, name) {
  const db = await open();
  const tx = db.transaction(name, 'readwrite');
  const store = tx.objectStore(name);
  let added = 0;
  for (const e of events) {
    const row = { ...e, account };
    const get = store.getKey([account, e.id]);
    get.onsuccess = () => {
      if (get.result === undefined) added++;
      store.put(row);
    };
  }
  await done(tx);
  return added;
}

/** 该账号在这张表里的全部事件。结果冻结、共用，不要改。 */
export function getEvents(account, name = STORE) {
  const k = cacheKey(account, name);
  if (!cache.has(k)) {
    const p = readAll(account, name).then(Object.freeze);
    p.catch(() => cache.get(k) === p && cache.delete(k)); // 读失败不留在缓存里
    cache.set(k, p);
  }
  return cache.get(k);
}

async function readAll(account, name) {
  const db = await open();
  const tx = db.transaction(name, 'readonly');
  const req = tx.objectStore(name).getAll(accountRange(account));
  await done(tx);
  return req.result;
}

export async function clearEvents(account) {
  forget(account, [STORE, OUT]);
  const db = await open();
  const tx = db.transaction([STORE, OUT], 'readwrite');
  for (const name of [STORE, OUT]) tx.objectStore(name).delete(accountRange(account));
  try {
    await done(tx);
  } finally {
    forget(account, [STORE, OUT]);
  }
}

/** 删掉早于 beforeTs 的事件，返回删了几条。 */
export async function pruneEvents(account, beforeTs, name = STORE) {
  forget(account, [name]);
  try {
    return await pruneRows(account, beforeTs, name);
  } finally {
    forget(account, [name]);
  }
}

async function pruneRows(account, beforeTs, name) {
  const db = await open();
  const tx = db.transaction(name, 'readwrite');
  let removed = 0;
  const req = tx.objectStore(name).openCursor(accountRange(account));
  req.onsuccess = () => {
    const c = req.result;
    if (!c) return;
    if (c.value.created_at < beforeTs) {
      c.delete();
      removed++;
    }
    c.continue();
  };
  await done(tx);
  return removed;
}

// ---- chrome.storage.local ----

export async function kvGet(key, fallback = null) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}

export const kvSet = (key, value) => chrome.storage.local.set({ [key]: value });
export const kvRemove = (keys) => chrome.storage.local.remove(keys);

// 设置 = 抓取总开关 + 榜单规则（统计窗口、名次上限、最少次数、颜色档位，定义和默认值在 rank.js）
export const DEFAULT_SETTINGS = { fetchEnabled: true, ...DEFAULT_RULES };

export const keys = {
  accounts: 'accounts', // { [handle]: { handle, userId, seenAt } }
  current: 'current', // 当前 X 会话登录的 handle
  pendingUserId: 'pendingUserId', // 识别不到 handle 时，等用户手动填
  settings: (a) => `settings:${a}`,
  cursor: (a) => `cursor:${a}`, // { newestId, syncedId, earliestTs, lastIncrementalAt, nextIncAt, lastAttemptAt, lastBackfill, lastPruneAt, out }
  tpl: 'tpl:replies', // { url, at }：X 页面自己读「回复」栏时的请求地址，读我的回复列表时照着它发
  tplTry: 'tplTry', // 最近一次自己去取上面这个地址的时间（自动读的时候隔一阵才再试）
  job: (a) => `job:${a}`, // 回填任务状态
  snap: (a) => `snap:${a}`, // 内联标签快照
  alert: (a) => `alert:${a}`, // 最近一次抓取/解析错误
  domWarning: 'domWarning',
};

/** 读出来的设置总是合法的：缺的补默认，越界的夹回范围。 */
export async function getSettings(a) {
  const raw = { ...DEFAULT_SETTINGS, ...(await kvGet(keys.settings(a), {})) };
  return { fetchEnabled: raw.fetchEnabled !== false, ...cleanRules(raw) };
}
