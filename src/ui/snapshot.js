// 开发用只读快照页：把 chrome.storage.local 和 IndexedDB 两份数据合成一个 JSON。
// 不经过后台消息，因为扩展页面直接读同一个扩展源；不发请求，不写业务数据。

import { getEvents, OUT, keys } from '../db.js';
import { buildSnapshot, snapshotFilename, snapshotSummary } from '../snapshot.js';

const $ = (id) => document.getElementById(id);

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function collect() {
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
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    environment: {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
    },
  });
}

let snapshot = null;

function save() {
  if (!snapshot) return;
  download(snapshotFilename(snapshot.exportedAt), JSON.stringify(snapshot));
  $('status').textContent = '已生成快照，文件在浏览器下载目录。';
  $('save').textContent = '再下载一次';
}

async function init() {
  try {
    snapshot = await collect();
    const summary = snapshotSummary(snapshot.data);
    $('summary').textContent = summary.length
      ? summary.map((s) => `${s.handle || s.account}: 入站 ${s.inbound} · 出站 ${s.outbound}`).join('\n')
      : '本机没有已绑定的账号。';
    $('status').textContent = `已读取 ${summary.length} 个账号，快照格式 v${snapshot.schemaVersion}。`;
    $('save').disabled = false;
    if (new URLSearchParams(location.search).get('auto') === '1') save();
  } catch (e) {
    $('status').textContent = `读取失败：${e?.message || e}`;
    $('status').classList.add('err');
  }
}

$('save').addEventListener('click', save);
init();
