// 解析层：把接口的原始 JSON 变成与 X 无关的结构。X 改返回结构时只改这个文件和 fetcher.js。
// parseMentions：别人对我的回复（提及列表）；parseMyReplies：我在别人帖子下的回复（文件后半）。
//
// 提及有两种来源，parseMentions 自己认：
// - GraphQL NotificationsTimeline（X 网页版现在用的，2026-11-19 小号实测结构）：data…notification_timeline.timeline.instructions，
//   条目 TimelineTimelineItem 里是 itemContent.tweet_results.result（legacy + core.user_results），游标在 TimelineTimelineCursor。
// - 旧版 REST mentions.json：globalObjects + timeline.instructions，在真实账号上用过。
// 字段对不上时抛 ParseError，由上层提示用户，不静默吞掉。

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

/** 旧版 REST：globalObjects 里是帖子和用户，时间线条目只引用帖子 ID。 */
function fromRest(body) {
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
  return { tweets, users, entryIds, bottomCursor };
}

/** GraphQL：每个条目自带帖子和作者，这里换成和 REST 一样的形状（帖子表、用户表、条目里的帖子 ID）。 */
function fromGraphql(body, inspect) {
  let instructions = null;
  walk(body.data, (n) => {
    if (!instructions && Array.isArray(n.instructions)) instructions = n.instructions;
  });
  if (!instructions) {
    const err = body?.errors?.[0]?.message;
    throw new ParseError(err ? `X 返回错误：${String(err).slice(0, 200)}` : '返回里找不到通知时间线（instructions）');
  }
  const tweets = {};
  const users = {};
  const entryIds = [];
  let bottomCursor = null;
  let blank = 0;
  for (const ins of instructions) {
    for (const entry of ins?.entries || []) {
      const c = entry?.content;
      if (c?.cursorType === 'Bottom' && typeof c.value === 'string') bottomCursor = c.value;
      const item = c?.itemContent;
      if (!item || item.itemType !== 'TimelineTweet') continue;
      let t = item.tweet_results?.result;
      if (t?.__typename === 'TweetWithVisibilityResults') t = t.tweet;
      const l = t?.legacy;
      if (!l || typeof l.id_str !== 'string') {
        inspect?.(t?.rest_id, 'missing_post_payload');
        blank++;
        continue;
      }
      const u = t.core?.user_results?.result;
      tweets[l.id_str] = l;
      entryIds.push(l.id_str);
      if (u && l.user_id_str && !users[l.user_id_str]) {
        users[l.user_id_str] = {
          screen_name: u.core?.screen_name ?? u.legacy?.screen_name,
          name: u.core?.name ?? u.legacy?.name ?? '',
          profile_image_url_https: u.avatar?.image_url ?? u.legacy?.profile_image_url_https ?? '',
        };
      }
    }
  }
  if (blank && !entryIds.length) throw new ParseError('通知里有帖子条目，但解析不出帖子内容');
  return { tweets, users, entryIds, bottomCursor };
}

/**
 * @param body 接口原始返回
 * @param me   { handle, userId } 当前账号
 * @returns {{
 *   events: Array,        // 别人对我的回复
 *   entryIds: string[],   // 本页时间线里的全部帖子 ID（含不计数的普通提及），用于判断翻到哪了
 *   newestId: string|null, newestTs: number|null, oldestId: string|null, oldestTs: number|null,
 *   bottomCursor: string|null
 * }}
 */
export function parseMentions(body, me, inspect) {
  const { tweets, users, entryIds, bottomCursor } = body?.data || (Array.isArray(body?.errors) && !body?.globalObjects) ? fromGraphql(body, inspect) : fromRest(body);
  const myHandle = (me.handle || '').toLowerCase();
  const isMe = (userId, screenName) =>
    (me.userId && userId === me.userId) || (!!myHandle && screenName && screenName.toLowerCase() === myHandle);

  const events = [];
  let newestId = null;
  let newestTs = null;
  let oldestId = null;
  let oldestTs = null;
  let missing = 0;

  for (const id of new Set(entryIds)) {
    const t = tweets[id];
    if (!t) {
      inspect?.(id, 'missing_post_payload');
      missing++;
      continue;
    }
    const ts = tweetTime(t);
    if (!newestId || idGt(id, newestId)) {
      newestId = id;
      newestTs = ts;
    }
    if (!oldestId || idGt(oldestId, id)) {
      oldestId = id;
      oldestTs = ts;
    }

    const author = users[t.user_id_str];
    if (!author || isMe(t.user_id_str, author.screen_name)) {
      inspect?.(id, author ? 'own_reply' : 'missing_author');
      continue;
    }

    // 只收「直接回复我某条帖子/评论」的。引用、普通提及、回复别人时顺带 @ 我的，都不计
    if (!t.in_reply_to_status_id_str || !isMe(t.in_reply_to_user_id_str, t.in_reply_to_screen_name)) {
      inspect?.(id, t.in_reply_to_status_id_str ? 'reply_target_not_me' : 'not_reply');
      continue;
    }

    // 这串对话是不是从我的帖子开始的：只有「我的帖子下」的回复才上榜，
    // 我去别人帖子下评论、对方回我的不算。conversation_id_str 是对话根帖的 ID。
    const conv = t.conversation_id_str;
    if (!conv) throw new ParseError('回复里没有 conversation_id_str，无法判断是不是我帖子下的回复');
    const root = tweets[conv];
    let rootMine = null; // null = 这一页里看不出来，留给统计层用已知的根帖归属补判
    if (conv === t.in_reply_to_status_id_str) rootMine = true; // 直接回的就是根帖，而被回的人是我
    else if (root) rootMine = isMe(root.user_id_str, users[root.user_id_str]?.screen_name) || false;

    inspect?.(id, rootMine === true ? 'accepted_own_root' : rootMine === false ? 'accepted_other_root' : 'accepted_unknown_root');
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

  return { events, entryIds: [...new Set(entryIds)], newestId, newestTs, oldestId, oldestTs, bottomCursor };
}

// ---------- 我自己的回复列表（GraphQL：个人主页「回复」栏） ----------
// 【待实测】按 X 网页版 GraphQL 时间线的常见形态写：data 里某处有 instructions，条目里的帖子是
// { legacy: { id_str, user_id_str, in_reply_to_*, conversation_id_str, ... }, core: { user_results } }。
// 不依赖具体层级，按特征找；找不到就抛 ParseError。

const NESTED = new Set(['retweeted_status_result', 'quoted_status_result', 'quotedRefResult']); // 被转发、被引用的原帖不算这个条目里的帖子

function collectTweets(node, out) {
  if (!node || typeof node !== 'object') return;
  const l = node.legacy;
  if (l && typeof l === 'object' && typeof l.id_str === 'string' && typeof l.user_id_str === 'string') {
    const u = node.core?.user_results?.result;
    out.push({ ...l, screen: u?.core?.screen_name ?? u?.legacy?.screen_name ?? null });
  }
  for (const [k, v] of Object.entries(node)) if (!NESTED.has(k)) collectTweets(v, out);
}

/**
 * @returns {{
 *   events: Array,   // 我在别人帖子下的回复：{ id, created_at, reply_to_id, to_user_id, root_user_id, root_handle, conversation_id, text }
 *   newestId, newestTs, oldestId, oldestTs,   // 本页里我自己发的帖子（每个条目取最后一条，不含置顶）的范围，用于判断翻到哪了
 *   bottomCursor
 * }}
 */
export function parseMyReplies(body, me) {
  let instructions = null;
  walk(body?.data, (n) => {
    if (!instructions && Array.isArray(n.instructions)) instructions = n.instructions;
  });
  if (!instructions) {
    const err = body?.errors?.[0]?.message;
    throw new ParseError(err ? `X 返回错误：${String(err).slice(0, 200)}` : '返回里找不到时间线（instructions）');
  }

  const myHandle = (me.handle || '').toLowerCase();
  const isMe = (userId, screenName) =>
    (me.userId && userId === me.userId) || (!me.userId && !!myHandle && screenName && screenName.toLowerCase() === myHandle);

  const byId = new Map(); // 本页出现过的所有帖子，用来查对话根帖是谁发的
  const mine = new Map(); // 我发的
  const mains = []; // 每个条目里我发的最后一条：条目按它的时间排，前面的是被回复的旧帖
  let bottomCursor = null;
  let parsedEntries = 0;
  let blankEntries = 0;

  for (const ins of instructions) {
    if (ins?.type === 'TimelinePinEntry') continue; // 置顶帖可能很旧，不参与判断时间范围
    for (const entry of ins?.entries || []) {
      const found = [];
      collectTweets(entry, found);
      if (!found.length) {
        if (/^(tweet|profile-conversation)/.test(entry?.entryId || '')) blankEntries++;
        continue;
      }
      parsedEntries++;
      let last = null;
      for (const t of found) {
        byId.set(t.id_str, t);
        if (isMe(t.user_id_str, t.screen)) {
          mine.set(t.id_str, t);
          last = t;
        }
      }
      if (last) mains.push(last);
    }
  }
  walk(instructions, (n) => {
    if (n.cursorType === 'Bottom' && typeof n.value === 'string') bottomCursor = n.value;
  });
  if (blankEntries && !parsedEntries) throw new ParseError('时间线里有帖子条目，但解析不出帖子内容');

  let newestId = null;
  let newestTs = null;
  let oldestId = null;
  let oldestTs = null;
  for (const t of mains) {
    if (!newestId || idGt(t.id_str, newestId)) {
      newestId = t.id_str;
      newestTs = tweetTime(t);
    }
    if (!oldestId || idGt(oldestId, t.id_str)) {
      oldestId = t.id_str;
      oldestTs = tweetTime(t);
    }
  }

  const events = [];
  for (const t of mine.values()) {
    if (!t.in_reply_to_status_id_str) continue; // 原创帖、转发
    const conv = t.conversation_id_str;
    if (!conv) throw new ParseError('我的回复里没有 conversation_id_str，无法判断是在谁的帖子下');
    // 对话根帖是谁发的：直接回的就是根帖时看被回复的人；否则看这一页里有没有带出根帖
    const root = byId.get(conv);
    let rootUser = null;
    let rootScreen = null;
    if (conv === t.in_reply_to_status_id_str) [rootUser, rootScreen] = [t.in_reply_to_user_id_str || null, t.in_reply_to_screen_name];
    else if (root) [rootUser, rootScreen] = [root.user_id_str, root.screen];
    // 我自己帖子下的回复：不计数，只记下「这个对话是我的」，帮别人回我的那份认出深层回复是不是在我帖子下
    const own = (rootUser && isMe(rootUser, rootScreen)) || (!rootUser && !me.userId && !!rootScreen && rootScreen.toLowerCase() === myHandle);
    events.push({
      ...(own ? { own: true } : {}),
      id: t.id_str,
      created_at: tweetTime(t),
      reply_to_id: t.in_reply_to_status_id_str, // 回的是哪条帖子；等于 conversation_id 就是直接评论根帖
      to_user_id: t.in_reply_to_user_id_str || null,
      root_user_id: rootUser, // null = 这一页里看不出根帖是谁的
      root_handle: rootScreen || null, // 只给导出时显示用
      conversation_id: conv,
      text: snippet(t.full_text ?? t.text),
    });
  }

  return { events, newestId, newestTs, oldestId, oldestTs, bottomCursor };
}

// ---------- 已排期帖子列表（GraphQL：FetchScheduledTweets） ----------
// 【待实测】按 X 网页版 FetchScheduledTweets 常见结构解析：data.viewer.scheduled_tweet_list（或 data 下任意 scheduled_tweet_list 数组），
// 每项含 rest_id / id、scheduling_info.execute_at（秒或毫秒时间戳）、tweet_create_request.status。结构对不上就抛 ParseError。

const schedSnippet = (raw) => (typeof raw === 'string' ? [...raw.replace(/\s+/g, ' ').trim()].slice(0, 60).join('') : '');

/**
 * 解析已排期帖子列表。
 * @returns {Array<{ id: string, executeAt: number, text: string }>} 按执行时间升序
 */
export function parseScheduledTweets(body) {
  if (Array.isArray(body?.errors) && body.errors.length && !body?.data) {
    throw new ParseError(`X 返回错误：${String(body.errors[0]?.message || '未知错误').slice(0, 200)}`);
  }
  let list = null;
  walk(body?.data, (n) => {
    if (!list && Array.isArray(n.scheduled_tweet_list)) list = n.scheduled_tweet_list;
  });
  if (!list) {
    const err = body?.errors?.[0]?.message;
    throw new ParseError(err ? `X 返回错误：${String(err).slice(0, 200)}` : '返回里找不到已排期列表（scheduled_tweet_list）');
  }
  const items = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const rawTs = Number(raw.scheduling_info?.execute_at ?? raw.execute_at);
    if (!Number.isFinite(rawTs) || rawTs <= 0) continue;
    const executeAt = rawTs < 1e12 ? rawTs * 1000 : rawTs;
    const id = String(raw.rest_id ?? raw.id ?? executeAt);
    const text = schedSnippet(raw.tweet_create_request?.status ?? raw.status ?? raw.text ?? '');
    items.push({ id, executeAt, text });
  }
  if (list.length && !items.length) {
    throw new ParseError('已排期列表不为空，但解析不出排期时间（execute_at）');
  }
  items.sort((a, b) => a.executeAt - b.executeAt);
  return items;
}
