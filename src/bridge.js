// 开发用本机桥：把当前账号、两份回复数据和 chrome.storage.local 自动推给本机服务。
// 只在维护阶段启用；服务不在线时静默退避，不影响抓取和界面。

import { getEvents, OUT, keys } from './db.js';
import { buildSnapshot } from './snapshot.js';

export const BRIDGE_URL = 'http://127.0.0.1:17321/ingest';
const PUSH_DELAY_MS = 2_500;
const RETRY_MS = 60_000;
const TIMEOUT_MS = 60_000;

let timer = null;
let running = false;
let pending = false;
let offlineUntil = 0;

const available = () => typeof chrome !== 'undefined' && !!chrome.runtime?.id;

export async function buildLiveSnapshot() {
  const storage = await chrome.storage.local.get(null);
  const accounts = storage[keys.accounts] || {};
  const data = {};
  for (const [account, meta] of Object.entries(accounts)) {
    data[account] = {
      meta,
      inbound: await getEvents(account),
      outbound: await getEvents(account, OUT),
    };
  }
  return buildSnapshot({
    accounts,
    data,
    storage,
    source: 'live',
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    environment: {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: globalThis.navigator?.platform || '',
      userAgent: globalThis.navigator?.userAgent || '',
    },
  });
}

export async function pushLiveSnapshot() {
  if (!available()) return;
  if (running) {
    pending = true;
    return;
  }
  if (Date.now() < offlineUntil) return;
  running = true;
  try {
    const payload = await buildLiveSnapshot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    offlineUntil = 0;
    console.info('[X 友] 本机数据桥已更新');
  } catch (e) {
    offlineUntil = Date.now() + RETRY_MS;
    console.warn(`[X 友] 本机数据桥不可用，稍后重试：${e?.message || e}`);
  } finally {
    running = false;
    if (pending) {
      pending = false;
      queueBridgePush();
    }
  }
}

/** 数据变化后合并短时间内的多次触发；服务离线时直接跳过，等下一次事件再试。 */
export function queueBridgePush() {
  if (!available()) return;
  if (Date.now() < offlineUntil) return;
  if (timer) return;
  if (running) {
    pending = true;
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void pushLiveSnapshot();
  }, PUSH_DELAY_MS);
}
