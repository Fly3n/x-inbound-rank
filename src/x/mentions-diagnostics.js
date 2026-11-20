// 只保留能对比请求和结构的字段。完整地址、游标、正文、账号和凭证留在内存中。
const isPostId = (id) => typeof id === 'string' && /^\d{1,24}$/.test(id);

function jsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function requestSummary(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 30_000) return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!['https://x.com', 'https://twitter.com'].includes(url.origin)) return null;
  const graphql = url.pathname.match(/^\/i\/api\/graphql\/([\w-]{1,64})\/NotificationsTimeline$/);
  const rest = url.pathname === '/i/api/2/notifications/mentions.json';
  if (!graphql && !rest) return null;

  const vars = jsonObject(url.searchParams.get('variables'));
  const features = Object.entries(jsonObject(url.searchParams.get('features')))
    .filter(([, value]) => typeof value === 'boolean')
    .sort(([a], [b]) => a.localeCompare(b, 'en'));
  const featureHash = features.length
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(features)))),
        (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
    : null;
  const count = Number(graphql ? vars.count : url.searchParams.get('count'));
  return {
    host: url.hostname,
    api: graphql ? 'graphql' : 'rest',
    queryId: graphql?.[1] ?? null,
    timeline: ['Mentions', 'All', 'Verified'].includes(vars.timeline_type) ? vars.timeline_type : null,
    count: Number.isInteger(count) && count > 0 && count <= 1000 ? count : null,
    hasCursor: Boolean(graphql ? vars.cursor : url.searchParams.get('cursor')),
    featureCount: features.length,
    featureHash,
  };
}

function responseSummary(body, metadata) {
  const date = typeof metadata?.date === 'string' ? Date.parse(metadata.date) : NaN;
  const age = typeof metadata?.age === 'string' && /^\d{1,10}$/.test(metadata.age) ? Number(metadata.age) : null;
  const cache = [metadata?.cache, metadata?.cloudflareCache].filter((x) => typeof x === 'string')
    .map((x) => x.match(/\b(HIT|MISS|BYPASS|DYNAMIC|EXPIRED|STALE|REVALIDATED|UPDATING)\b/i)?.[1]?.toUpperCase())
    .filter(Boolean);
  // 独立于正式解析器，保留嵌套帖子结果和不受支持的时间线条目结构。
  const ids = new Set();
  const shapes = new Set();
  const pending = [body];
  let visited = 0;
  while (pending.length && visited++ < 80_000) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const post = node.tweet_results?.result;
    const isTweet = node.__typename === 'Tweet' || typeof node.legacy?.conversation_id_str === 'string';
    const id = post?.tweet?.rest_id ?? post?.rest_id ?? (isTweet ? node.legacy?.id_str ?? node.rest_id : null);
    if (isPostId(id)) ids.add(id);
    const entryId = typeof node.entryId === 'string' ? node.entryId.match(/^tweet-(\d{1,24})$/)?.[1] : null;
    if (entryId) ids.add(entryId);
    if (isPostId(node.tweet?.id)) ids.add(node.tweet.id);
    for (const id of Object.keys(node.globalObjects?.tweets || {})) {
      if (isPostId(id)) ids.add(id);
    }
    for (const value of [node.entryType, node.itemType, node.type]) {
      if (typeof value === 'string' && /^Timeline[A-Za-z0-9_]{1,60}$/.test(value)) shapes.add(value);
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  let latestId = 0n;
  for (const id of ids) if (BigInt(id) > latestId) latestId = BigInt(id);
  return {
    latestPostAt: latestId ? Number((latestId >> 22n) + 1288834974657n) : null,
    serverDate: Number.isFinite(date) ? date : null,
    ageSeconds: age,
    cache,
    payload: body?.globalObjects ? 'rest' : body?.data ? 'graphql' : body ? 'other' : 'missing',
    postIds: [...ids].slice(0, 256),
    postCount: ids.size,
    timelineShapes: [...shapes].slice(0, 24),
    truncated: pending.length > 0 || ids.size > 256 || shapes.size > 24,
  };
}

export async function mentionsEvidence(url, body, metadata) {
  const request = await requestSummary(url);
  return request ? { request, response: responseSummary(body, metadata) } : null;
}
