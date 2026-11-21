// 开发用本机快照的纯函数。浏览器的读取和下载由 src/ui/snapshot.js 负责。

export const SNAPSHOT_SCHEMA = 1;

export function buildSnapshot({
  accounts = {},
  data = {},
  storage = {},
  exportedAt = new Date().toISOString(),
  extensionVersion = '',
  environment = {},
} = {}) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    kind: 'xir-local-snapshot',
    exportedAt,
    extensionVersion,
    environment: {
      timezone: environment.timezone ?? null,
      platform: environment.platform ?? null,
      userAgent: environment.userAgent ?? null,
    },
    accounts,
    data,
    storage,
  };
}

export function snapshotFilename(iso) {
  const d = new Date(iso);
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n) => String(n).padStart(2, '0');
  return `xir-snapshot-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.json`;
}

export function snapshotSummary(data = {}) {
  return Object.entries(data).map(([account, entry]) => ({
    account,
    handle: entry?.meta?.handle || '',
    inbound: entry?.inbound?.length || 0,
    outbound: entry?.outbound?.length || 0,
  }));
}
