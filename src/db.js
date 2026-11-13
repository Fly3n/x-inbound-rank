// 存储层：互动事件放 IndexedDB，按账号隔离；小状态放 chrome.storage.local。

const DB_NAME = 'xir';
const STORE = 'events';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      // 主键 [account, id]：同一互动 ID 在同一账号下只存一条，去重靠它
      req.result.createObjectStore(STORE, { keyPath: ['account', 'id'] });
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

/** 写入事件，返回其中新增（此前不存在）的条数。 */
export async function putEvents(account, events) {
  if (!events.length) return 0;
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
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

export async function getEvents(account) {
  const db = await open();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).getAll(accountRange(account));
  await done(tx);
  return req.result;
}

export async function clearEvents(account) {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(accountRange(account));
  await done(tx);
}

// ---- chrome.storage.local ----

export async function kvGet(key, fallback = null) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}

export const kvSet = (key, value) => chrome.storage.local.set({ [key]: value });
export const kvRemove = (keys) => chrome.storage.local.remove(keys);

export const DEFAULT_SETTINGS = { fetchEnabled: true, intervalHours: 1 }; // intervalHours: 1 | 2 | 24 | 0(关闭自动增量)

export const keys = {
  accounts: 'accounts', // { [handle]: { handle, userId, seenAt } }
  current: 'current', // 当前 X 会话登录的 handle
  pendingUserId: 'pendingUserId', // 识别不到 handle 时，等用户手动填
  settings: (a) => `settings:${a}`,
  cursor: (a) => `cursor:${a}`, // { newestId, syncedId, earliestTs, lastIncrementalAt, lastAttemptAt, lastBackfill }
  job: (a) => `job:${a}`, // 回填任务状态
  snap: (a) => `snap:${a}`, // 内联标签快照
  alert: (a) => `alert:${a}`, // 最近一次抓取/解析错误
  domWarning: 'domWarning',
};

export const getSettings = async (a) => ({ ...DEFAULT_SETTINGS, ...(await kvGet(keys.settings(a), {})) });
