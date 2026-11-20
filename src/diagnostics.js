const PREFIX = 'diagnostics:';
const HOUR = 3_600_000;
const KEEP = 7 * 24 * HOUR;
let writes = Promise.resolve();

// 调用方只传诊断字段。日志失败不影响数据读取。
export function record(event, fields) {
  const at = Date.now();
  const key = PREFIX + Math.floor(at / HOUR);
  writes = writes.then(async () => {
    const stored = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: [...(stored[key] || []), { at, event, ...fields }] });
  }).catch(() => {});
  return writes;
}

export async function readDiagnostics() {
  await writes;
  const cutoff = Date.now() - KEEP;
  const all = await chrome.storage.local.get(null);
  const expired = [];
  const rows = [];
  for (const [key, entries] of Object.entries(all)) {
    if (!key.startsWith(PREFIX) || !Array.isArray(entries)) continue;
    if ((Number(key.slice(PREFIX.length)) + 1) * HOUR <= cutoff) expired.push(key);
    else for (const row of entries) if (row.at >= cutoff) rows.push(row);
  }
  if (expired.length) await chrome.storage.local.remove(expired);
  return rows.sort((a, b) => b.at - a.at);
}
