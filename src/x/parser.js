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

/** 回复内容的摘要：去掉开头的 @某人，最多留 100 个字。只给弹窗「点开某人」时看，拿不到就是空串，不影响统计。 */
const snippet = (raw) => (typeof raw === 'string' ? [...raw.replace(/^(@\w+\s+)+/, '').trim()].slice(0, 100).join('') : '');

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v, visit);
}

/**
 * @param body 接口原始返回
 * @param me   { handle, userId } 当前账号
 * @returns {{
 *   events: Array,        // 别人对我的回复
 *   entryIds: string[],   // 本页时间线里的全部帖子 ID（含不计数的普通提及），用于判断翻到哪了
 *   newestId: string|null, oldestId: string|null, oldestTs: number|null,
 *   bottomCursor: string|null
 * }}
 */
export function parseMentions(body, me) {
  const go = body?.globalObjects;
  const instructions = body?.timeline?.instructions;
  // 实测：列表为空时 globalObjects 是 {}，没有 tweets / users 这两个键
  const tweets = go?.tweets || {};
  const users = go?.users || {};
  if (!go || typeof go !== 'object' || !Array.isArray(instructions)) {
    throw new ParseError('返回结构不是预期的 globalObjects + timeline.instructions');
  }

  // 只认时间线条目直接引用的帖子：globalObjects.tweets 里还混着被回复、被引用的旧帖，不能拿来判断时间范围
  const entryIds = [];
  let bottomCursor = null;
  walk(instructions, (n) => {
    if (n.tweet && typeof n.tweet.id === 'string') entryIds.push(n.tweet.id);
    if (n.cursor && n.cursor.cursorType === 'Bottom' && typeof n.cursor.value === 'string') bottomCursor = n.cursor.value;
  });
  // 返回里明明有帖子，时间线却一条都没引用到：说明条目结构变了，不能当成「列表为空」
  if (!entryIds.length && Object.keys(tweets).length) {
    throw new ParseError('返回里有帖子，但时间线条目里找不到对它们的引用');
  }

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

    // 只收「直接回复我某条帖子/评论」的。引用、普通提及、回复别人时顺带 @ 我的，都不计
    if (!t.in_reply_to_status_id_str || !isMe(t.in_reply_to_user_id_str, t.in_reply_to_screen_name)) continue;

    // 这串对话是不是从我的帖子开始的：只有「我的帖子下」的回复才上榜，
    // 我去别人帖子下评论、对方回我的不算。conversation_id_str 是对话根帖的 ID。
    const conv = t.conversation_id_str;
    if (!conv) throw new ParseError('回复里没有 conversation_id_str，无法判断是不是我帖子下的回复');
    const root = tweets[conv];
    let rootMine = null; // null = 这一页里看不出来，留给统计层用已知的根帖归属补判
    if (conv === t.in_reply_to_status_id_str) rootMine = true; // 直接回的就是根帖，而被回的人是我
    else if (root) rootMine = isMe(root.user_id_str, users[root.user_id_str]?.screen_name) || false;

    events.push({
      id,
      actor_id: t.user_id_str,
      actor_handle: author.screen_name,
      actor_name: author.name,
      actor_avatar: author.profile_image_url_https || '',
      created_at: ts,
      target_post_id: t.in_reply_to_status_id_str,
      conversation_id: conv,
      root_mine: rootMine,
      text: snippet(t.full_text ?? t.text),
    });
  }

  if (entryIds.length && missing === new Set(entryIds).size) {
    throw new ParseError('时间线条目引用的帖子在返回里一条都找不到');
  }

  return { events, entryIds: [...new Set(entryIds)], newestId, oldestId, oldestTs, bottomCursor };
}
