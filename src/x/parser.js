// 解析层：把提及接口的原始 JSON 变成与 X 无关的结构。X 改返回结构时只改这个文件和 fetcher.js。
//
// 【待实测】按 X 网页版 v2 timeline 形态（globalObjects + timeline.instructions）写成，
// 尚未用真实返回验证；字段对不上时抛 ParseError，由上层提示用户，不静默吞掉。

export class ParseError extends Error {}

const SNOWFLAKE_EPOCH = 1288834974657n;

/** 帖子发布时间（毫秒）。优先 created_at，读不出时用雪花 ID 推算。 */
export function tweetTime(tweet) {
  const t = Date.parse(tweet.created_at);
  if (!Number.isNaN(t)) return t;
  return Number((BigInt(tweet.id_str) >> 22n) + SNOWFLAKE_EPOCH);
}

export const idGt = (a, b) => BigInt(a) > BigInt(b);

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v, visit);
}

/**
 * @param body 接口原始返回
 * @param me   { handle, userId } 当前账号
 * @returns {{
 *   events: Array,        // 入站回复/引用
 *   entryIds: string[],   // 本页时间线里的全部帖子 ID（含不计数的普通提及），用于判断翻到哪了
 *   newestId: string|null, oldestId: string|null, oldestTs: number|null,
 *   bottomCursor: string|null
 * }}
 */
export function parseMentions(body, me) {
  const tweets = body?.globalObjects?.tweets;
  const users = body?.globalObjects?.users;
  const instructions = body?.timeline?.instructions;
  if (!tweets || !users || !Array.isArray(instructions)) {
    throw new ParseError('返回结构不是预期的 globalObjects + timeline.instructions');
  }

  // 只认时间线条目直接引用的帖子：globalObjects.tweets 里还混着被回复、被引用的旧帖，不能拿来判断时间范围
  const entryIds = [];
  let bottomCursor = null;
  walk(instructions, (n) => {
    if (n.tweet && typeof n.tweet.id === 'string') entryIds.push(n.tweet.id);
    if (n.cursor && n.cursor.cursorType === 'Bottom' && typeof n.cursor.value === 'string') bottomCursor = n.cursor.value;
  });

  const myHandle = me.handle.toLowerCase();
  const isMe = (userId, screenName) =>
    (me.userId && userId === me.userId) || (screenName && screenName.toLowerCase() === myHandle);

  const events = [];
  let newestId = null;
  let oldestId = null;
  let oldestTs = null;
  let missing = 0;

  for (const id of new Set(entryIds)) {
    const t = tweets[id];
    if (!t) {
      missing++;
      continue;
    }
    const ts = tweetTime(t);
    if (!newestId || idGt(id, newestId)) newestId = id;
    if (!oldestId || idGt(oldestId, id)) {
      oldestId = id;
      oldestTs = ts;
    }

    const author = users[t.user_id_str];
    if (!author || isMe(t.user_id_str, author.screen_name)) continue;

    let type = null;
    let target = null;
    if (isMe(t.in_reply_to_user_id_str, t.in_reply_to_screen_name) && t.in_reply_to_status_id_str) {
      type = 'reply';
      target = t.in_reply_to_status_id_str;
    } else if (t.is_quote_status && t.quoted_status_id_str) {
      const quoted = tweets[t.quoted_status_id_str];
      const quotedAuthor = quoted && users[quoted.user_id_str];
      const link = t.quoted_status_permalink?.expanded || '';
      const linkHandle = (link.match(/(?:x|twitter)\.com\/([^/]+)\/status\//i) || [])[1];
      if ((quoted && isMe(quoted.user_id_str, quotedAuthor?.screen_name)) || isMe(null, linkHandle)) {
        type = 'quote';
        target = t.quoted_status_id_str;
      }
    }
    if (!type) continue; // 普通提及，或在别人帖子下的回复，不计

    events.push({
      id,
      actor_id: t.user_id_str,
      actor_handle: author.screen_name,
      actor_name: author.name,
      actor_avatar: author.profile_image_url_https || '',
      type,
      created_at: ts,
      target_post_id: target,
    });
  }

  if (entryIds.length && missing === new Set(entryIds).size) {
    throw new ParseError('时间线条目引用的帖子在返回里一条都找不到');
  }

  return { events, entryIds: [...new Set(entryIds)], newestId, oldestId, oldestTs, bottomCursor };
}
