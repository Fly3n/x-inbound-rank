// 开发用本机快照的纯函数。浏览器的读取和下载由 src/ui/snapshot.js 负责。

export const SNAPSHOT_SCHEMA = 1;

export function buildSnapshot({
  accounts = {},
  data = {},
  storage = {},
  exportedAt = new Date().toISOString(),
  extensionVersion = '',
  environment = {},
  source = 'manual',
} = {}) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    kind: 'xir-local-snapshot',
    source,
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

const TAP_ERROR_EVENTS = new Set([
  'inbound_tap_failed',
  'inbound_tap_skipped',
  'outbound_tap_unmatched',
  'outbound_replies_tap_failed',
  'outbound_replies_tap_skipped',
]);

/** 从 storage 的 diagnostics:* 分桶提炼概览与最近旁听状态，供本机桥元信息快速核对。 */
export function diagnosticsSummary(storage = {}) {
  const counts = {};
  let total = 0;
  let latestAt = null;
  let inbound = null;
  let outbound = null;
  let replies = null;
  let error = null;

  const pickNewer = (prev, next) => (!prev || (next.at || 0) >= (prev.at || 0) ? next : prev);

  for (const [key, rows] of Object.entries(storage || {})) {
    if (!key.startsWith('diagnostics:') || !Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.event !== 'string') continue;
      total++;
      counts[row.event] = (counts[row.event] || 0) + 1;
      const at = Number.isFinite(row.at) ? row.at : null;
      if (at != null && (latestAt == null || at > latestAt)) latestAt = at;
      if (row.event === 'inbound_tap') {
        inbound = pickNewer(inbound, {
          at, account: row.account || null, timeline: row.timeline || null,
          entries: row.entries ?? 0, nonTweetEntries: row.nonTweetEntries ?? 0,
          parsed: row.parsed ?? 0, added: row.added ?? 0, deduped: row.deduped ?? 0,
        });
      } else if (row.event === 'outbound_tap') {
        outbound = pickNewer(outbound, {
          at, account: row.account || null, postId: row.postId || null,
          own: !!row.own, direct: !!row.direct, added: row.added ?? 0,
        });
      } else if (row.event === 'outbound_replies_tap') {
        replies = pickNewer(replies, {
          at, account: row.account || null,
          parsed: row.parsed ?? 0, added: row.added ?? 0, deduped: row.deduped ?? 0,
        });
      } else if (TAP_ERROR_EVENTS.has(row.event)) {
        error = pickNewer(error, {
          at, event: row.event, account: row.account || null,
          timeline: row.timeline || null, category: row.category || null, reason: row.reason || null,
        });
      }
    }
  }

  const sortedCounts = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b, 'en')));
  return { total, latestAt, counts: sortedCounts, lastTap: { inbound, outbound, replies, error } };
}
