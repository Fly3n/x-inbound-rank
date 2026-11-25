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

const SAFE_DIAG_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const safeDiagToken = (v) => (typeof v === 'string' && SAFE_DIAG_TOKEN.test(v) ? v : null);

/** GraphQL：每个条目自带帖子和作者，这里换成和 REST 一样的形状（帖子表、用户表、条目里的帖子 ID）。 */
function fromGraphql(body, inspect, { allowNonTweet = false } = {}) {
  let instructions = null;
  walk(body?.data, (n) => {
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
  let candidates = 0;
  let unknown = 0;
  let nonTweetEntries = 0;
  const nonTweetKinds = new Set();
  const recordNonTweet = (parts) => {
    nonTweetEntries++;
    if (nonTweetKinds.size >= 24) return;
    const label = parts.map(safeDiagToken).filter(Boolean).join(':') || 'unknown';
    nonTweetKinds.add(label.slice(0, 80));
  };
  for (const ins of instructions) {
    for (const entry of ins?.entries || []) {
      let knownContent = false;
      const entryElement = entry?.content?.clientEventInfo?.element;
      walk(entry?.content, (node) => {
        if (node.cursorType) {
          if (node.cursorType === 'Bottom' && typeof node.value === 'string') bottomCursor = node.value;
          knownContent = true;
          return;
        }
        const item = node.itemContent;
        if (!item) return;
        knownContent = true;
        if (item.itemType !== 'TimelineTweet' && !item.tweet_results?.result) {
          if (allowNonTweet) {
            recordNonTweet([item.itemType || item.__typename, item.notification_icon, entryElement]);
            return;
          }
          unknown++;
          return;
        }
        candidates++;
        let t = item.tweet_results?.result;
        if (t?.__typename === 'TweetWithVisibilityResults') t = t.tweet;
        if (t?.__typename === 'TweetUnavailable' || t?.__typename === 'TweetTombstone') {
          inspect?.(t?.rest_id, 'unavailable_post');
          return;
        }
        const l = t?.legacy;
        if (!l || typeof l.id_str !== 'string') {
          throw new ParseError('通知里有帖子条目，但缺少帖子编号或正文结构');
        }
        const u = t.core?.user_results?.result;
        const userId = l.user_id_str || u?.rest_id;
        if (!userId) throw new ParseError('通知里的帖子缺少作者数字 ID，无法确认回复人');
        tweets[l.id_str] = userId === l.user_id_str ? l : { ...l, user_id_str: userId };
        entryIds.push(l.id_str);
        if (u && !users[userId]) {
          users[userId] = {
            screen_name: u.core?.screen_name ?? u.legacy?.screen_name,
            name: u.core?.name ?? u.legacy?.name ?? '',
            profile_image_url_https: u.avatar?.image_url ?? u.legacy?.profile_image_url_https ?? '',
          };
        }
      });
      if (!knownContent) {
        if (allowNonTweet) recordNonTweet([entry?.content?.entryType || entry?.content?.__typename, entryElement]);
        else unknown++;
      }
    }
  }
  if (unknown) throw new ParseError('通知里有无法识别或缺少内容的条目，不能把这一页当成完整结果');
  if (!entryIds.length && candidates) {
    throw new ParseError('通知里有条目，但解析不出任何帖子内容');
  }
  return { tweets, users, entryIds, bottomCursor, nonTweetEntries, nonTweetKinds: [...nonTweetKinds] };
}

function buildMentionResult({ tweets, users, entryIds, bottomCursor }, me, inspect) {
  const myHandle = (me.handle || '').toLowerCase();
  const mine = (userId, screenName) => {
    if (me.userId && userId) return userId === me.userId;
    if (myHandle && screenName) return screenName.toLowerCase() === myHandle;
    return null;
  };
  const isMe = (userId, screenName) => mine(userId, screenName) === true;

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

    if (!t.user_id_str) throw new ParseError('回复里缺少作者的数字用户 ID，无法确认是谁回复的');
    // 作者资料缺失时仍保留数字用户 ID：名字和头像可以先空着，不能因此静默丢掉整条回复。
    const author = users[t.user_id_str] || { screen_name: '', name: '', profile_image_url_https: '' };
    if (isMe(t.user_id_str, author.screen_name)) {
      inspect?.(id, 'own_reply');
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
    else if (root) rootMine = mine(root.user_id_str, users[root.user_id_str]?.screen_name);

    inspect?.(id, rootMine === true ? 'accepted_own_root' : rootMine === false ? 'accepted_other_root' : 'accepted_unknown_root');
    events.push({
      id,
      actor_id: t.user_id_str,
      actor_handle: author.screen_name || '',
      actor_name: author.name || '',
      actor_avatar: author.profile_image_url_https || '',
      created_at: ts,
      target_post_id: t.in_reply_to_status_id_str,
      conversation_id: conv,
      root_mine: rootMine,
      text: snippet(t.full_text ?? t.text),
    });
  }

  if (missing) throw new ParseError('时间线条目引用的帖子在返回里缺失，不能把这一页当成完整结果');

  return { events, entryIds: [...new Set(entryIds)], newestId, newestTs, oldestId, oldestTs, bottomCursor };
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
  const raw = body?.data || (Array.isArray(body?.errors) && !body?.globalObjects)
    ? fromGraphql(body, inspect)
    : fromRest(body);
  return buildMentionResult(raw, me, inspect);
}

/**
 * 解析浏览器旁听到的 NotificationsTimeline（含「全部」「提及」「已认证」页）。
 * Mentions 维持严格校验；All / Verified 允许跳过点赞、关注等非帖子通知并输出去敏类型清单供诊断核对。
 */
export function parseNotificationsTap(body, me, { timeline = null, inspect = null } = {}) {
  if (!body || typeof body !== 'object') throw new ParseError('通知旁听返回不是有效对象');
  const raw = fromGraphql(body, inspect, { allowNonTweet: timeline !== 'Mentions' });
  return {
    ...buildMentionResult(raw, me, inspect),
    nonTweetEntries: raw.nonTweetEntries,
    nonTweetKinds: raw.nonTweetKinds,
  };
}

/** 从旁听到的 UserRepliesTimeline URL 提取目标用户数字 ID，读不到返回 null。 */
export function repliesTapTargetUserId(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 30_000) return null;
  try {
    const vars = JSON.parse(new URL(rawUrl).searchParams.get('variables') || '{}');
    const id = vars?.userId == null ? '' : String(vars.userId);
    return /^\d{1,24}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** 判断旁听到的 UserRepliesTimeline 请求是否带翻页 cursor（用于诊断日志）。 */
export function repliesTapHasCursor(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 30_000) return null;
  try {
    const vars = JSON.parse(new URL(rawUrl).searchParams.get('variables') || '{}');
    return Boolean(vars?.cursor);
  } catch {
    return null;
  }
}

// ---------- 我自己的回复列表（GraphQL：个人主页「回复」栏） ----------
// 【待实测】按 X 网页版 GraphQL 时间线的常见形态写：data 里某处有 instructions，条目里的帖子是
// { legacy: { id_str, user_id_str, in_reply_to_*, conversation_id_str, ... }, core: { user_results } }。
// 不依赖具体层级，按特征找；找不到就抛 ParseError。

const NESTED = new Set(['retweeted_status_result', 'quoted_status_result', 'quotedRefResult']); // 被转发、被引用的原帖不算这个条目里的帖子

function collectTweets(node, out, info) {
  if (!node || typeof node !== 'object') return;
  if (node.__typename === 'TweetUnavailable' || node.__typename === 'TweetTombstone') {
    if (info) info.unavailable++;
    return;
  }
  const l = node.legacy;
  const tweetNode = node.__typename === 'Tweet' || node.__typename === 'TweetWithVisibilityResults' || !!l?.user_id_str;
  if (l && typeof l === 'object' && typeof l.id_str === 'string' && tweetNode) {
    const u = node.core?.user_results?.result;
    const userId = l.user_id_str || u?.rest_id;
    if (!userId) throw new ParseError('我的回复条目缺少作者数字 ID，不能把这一页当成完整结果');
    out.push({ ...l, user_id_str: userId, screen: u?.core?.screen_name ?? u?.legacy?.screen_name ?? null });
  }
  for (const [k, v] of Object.entries(node)) if (!NESTED.has(k)) collectTweets(v, out, info);
}

const isAuthorOf = (me, userId, screenName) => {
  if (me?.userId && userId) return userId === me.userId;
  const myHandle = (me?.handle || '').toLowerCase();
  return !!myHandle && !!screenName && screenName.toLowerCase() === myHandle;
};

function buildOutboundEvent({ id, createdAt, replyToId, toUserId, rootUser, rootScreen, conversationId, rawText }, me) {
  const own = rootUser ? isAuthorOf(me, rootUser, rootScreen) : !me?.userId && isAuthorOf(me, null, rootScreen);
  return {
    ...(own ? { own: true } : {}),
    id,
    created_at: createdAt,
    reply_to_id: replyToId,
    to_user_id: toUserId || null,
    root_user_id: rootUser || null,
    root_handle: rootScreen || null,
    conversation_id: conversationId,
    text: snippet(rawText),
  };
}

/** 解析网页端 CreateTweet 回复响应；仅在我本人发出的回复时返回可入库记录，结构不符则返回错误原因。 */
export function parseCreatedReply(body, me = {}) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid_body' };
  if (Array.isArray(body.errors) && body.errors.length && !body?.data?.create_tweet) {
    return { ok: true, event: null, reason: 'api_error' };
  }
  let raw = body?.data?.create_tweet?.tweet_results?.result;
  if (raw?.__typename === 'TweetWithVisibilityResults') raw = raw.tweet;
  const l = raw?.legacy;
  const id = l?.id_str || raw?.rest_id;
  if (!raw || !l || typeof id !== 'string' || !id) {
    return { ok: false, reason: 'missing_tweet_result' };
  }
  const u = raw.core?.user_results?.result;
  const userId = l.user_id_str || u?.rest_id || null;
  const screen = u?.core?.screen_name ?? u?.legacy?.screen_name ?? null;
  if (!isAuthorOf(me, userId, screen)) return { ok: true, event: null, reason: 'not_me' };
  if (!l.in_reply_to_status_id_str) return { ok: true, event: null, reason: 'not_reply' };
  const conv = l.conversation_id_str;
  if (!conv) return { ok: false, reason: 'missing_conversation_id' };
  const parsedTs = Date.parse(l.created_at);
  const createdAt = !Number.isNaN(parsedTs) ? parsedTs
    : /^\d{15,24}$/.test(id) ? Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH) : NaN;
  if (!Number.isFinite(createdAt)) return { ok: false, reason: 'missing_created_at' };
  const direct = conv === l.in_reply_to_status_id_str;
  return {
    ok: true,
    event: buildOutboundEvent({
      id,
      createdAt,
      replyToId: l.in_reply_to_status_id_str,
      toUserId: l.in_reply_to_user_id_str,
      rootUser: direct ? l.in_reply_to_user_id_str : null,
      rootScreen: direct ? l.in_reply_to_screen_name : null,
      conversationId: conv,
      rawText: l.full_text ?? l.text,
    }, me),
  };
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

  const byId = new Map(); // 本页出现过的所有帖子，用来查对话根帖是谁发的
  const mine = new Map(); // 我发的
  const mains = []; // 每个条目里我发的最后一条：条目按它的时间排，前面的是被回复的旧帖
  let bottomCursor = null;
  let parsedEntries = 0;
  let blankEntries = 0;
  let contentEntries = 0;
  let unavailableEntries = 0;

  for (const ins of instructions) {
    if (ins?.type === 'TimelinePinEntry') continue; // 置顶帖可能很旧，不参与判断时间范围
    for (const entry of ins?.entries || []) {
      let cursorEntry = false;
      walk(entry, (n) => { if (n?.cursorType) cursorEntry = true; });
      if (/^cursor-/.test(entry?.entryId || '') || cursorEntry) continue;
      contentEntries++;
      const found = [];
      const info = { unavailable: 0 };
      collectTweets(entry, found, info);
      if (!found.length) {
        if (info.unavailable) {
          unavailableEntries++;
          continue;
        }
        blankEntries++;
        continue;
      }
      parsedEntries++;
      let last = null;
      for (const t of found) {
        byId.set(t.id_str, t);
        if (isAuthorOf(me, t.user_id_str, t.screen)) {
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
  if (blankEntries) throw new ParseError('时间线里有内容条目，但解析不出帖子内容');
  if (contentEntries && !parsedEntries && unavailableEntries) {
    throw new ParseError('时间线里只有不可用的帖子，无法判断读取范围');
  }

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
    events.push(buildOutboundEvent({
      id: t.id_str,
      createdAt: tweetTime(t),
      replyToId: t.in_reply_to_status_id_str, // 回的是哪条帖子；等于 conversation_id 就是直接评论根帖
      toUserId: t.in_reply_to_user_id_str,
      rootUser,
      rootScreen,
      conversationId: conv,
      rawText: t.full_text ?? t.text,
    }, me));
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

function safeJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** 提取脱敏字段骨架路径（仅保留键名，绝不输出任何正文或用户数据），用于旁听诊断核对。 */
function shapeKeys(obj, maxDepth = 3, maxKeys = 24) {
  if (!obj || typeof obj !== 'object') return [];
  const out = [];
  const visit = (node, prefix, depth) => {
    if (!node || typeof node !== 'object' || depth > maxDepth || out.length >= maxKeys) return;
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === 'object') visit(node[0], `${prefix}[]`, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (out.length >= maxKeys) break;
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < maxDepth) {
        visit(v, path, depth + 1);
      } else {
        out.push(path);
      }
    }
  };
  visit(obj, '', 0);
  return out;
}

const normalizeExecTs = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
};

/** 解析 CreateScheduledTweet 旁听请求体与响应体，返回新增排期条目与脱敏结构诊断。 */
export function parseScheduledCreate(reqRaw, resRaw) {
  const req = safeJson(reqRaw);
  const res = safeJson(resRaw);
  const diag = { reqKeys: shapeKeys(req), resKeys: shapeKeys(res) };
  if (Array.isArray(res?.errors) && res.errors.length && !res?.data) {
    return { item: null, reason: 'api_error', diag };
  }
  let executeAt = normalizeExecTs(req?.variables?.execute_at ?? req?.execute_at);
  let text = schedSnippet(req?.variables?.post_tweet_request?.status ?? req?.variables?.status ?? '');
  let id = null;
  walk(res?.data, (n) => {
    if (!id && typeof n.rest_id === 'string' && n.rest_id) id = n.rest_id;
    if (!id && typeof n.scheduled_tweet_id === 'string' && n.scheduled_tweet_id) id = n.scheduled_tweet_id;
    if (!id && typeof n.id === 'string' && n.id) id = n.id;
    if (!executeAt) executeAt = normalizeExecTs(n.scheduling_info?.execute_at ?? n.execute_at);
    if (!text) text = schedSnippet(n.tweet_create_request?.status ?? n.post_tweet_request?.status ?? n.status ?? '');
  });
  if (!executeAt) {
    walk(req, (n) => {
      if (!executeAt) executeAt = normalizeExecTs(n.execute_at);
      if (!text) text = schedSnippet(n.post_tweet_request?.status ?? n.tweet_create_request?.status ?? n.status ?? '');
    });
  }
  if (!executeAt) return { item: null, reason: 'missing_execute_at', diag };
  return { item: { id: String(id ?? executeAt), executeAt, text }, reason: null, diag };
}

/** 解析 DeleteScheduledTweet 旁听请求体与响应体，返回被删排期 ID 与脱敏结构诊断。 */
export function parseScheduledDelete(reqRaw, resRaw) {
  const req = safeJson(reqRaw);
  const res = safeJson(resRaw);
  const diag = { reqKeys: shapeKeys(req), resKeys: shapeKeys(res) };
  if (Array.isArray(res?.errors) && res.errors.length && !res?.data) {
    return { id: null, reason: 'api_error', diag };
  }
  let id = req?.variables?.scheduled_tweet_id ?? req?.variables?.id ?? req?.variables?.rest_id ?? null;
  if (!id) {
    walk(req, (n) => {
      if (!id && (typeof n.scheduled_tweet_id === 'string' || typeof n.scheduled_tweet_id === 'number')) {
        id = String(n.scheduled_tweet_id);
      }
    });
  }
  if (!id) {
    walk(res?.data, (n) => {
      if (!id && typeof n.scheduled_tweet_id === 'string' && n.scheduled_tweet_id) id = n.scheduled_tweet_id;
      if (!id && typeof n.rest_id === 'string' && n.rest_id) id = n.rest_id;
    });
  }
  const cleanId = id != null && String(id).trim() ? String(id).trim() : null;
  return { id: cleanId, reason: cleanId ? null : 'missing_id', diag };
}

const ACCOUNT_ANOMALY_CODES = new Set([32, 64, 89, 226, 326]);
const ACCOUNT_ANOMALY_RE = /\b(account is locked|temporarily locked|temporarily restricted|suspended|automated|challenge|verify your account|bounce)\b/i;
const HTML_CHALLENGE_RE = /<!doctype\s+html|<html\b|just a moment|account\/access|arkose|challenge|verify your/i;
const STRONG_CHALLENGE_RE = /just a moment|arkose|account\/access|cf-browser-verification|challenge-platform|verify your account/i;
const CHALLENGE_REDIRECT_RE = /\/(?:account\/access|i\/flow\/|login)(?:[/?#]|$)/i;

/** 识别 X 账号侧异常与验证挑战信号（401/403、cf-mitigated、挑战重定向、非 5xx HTML 验证页、503 强挑战页或锁定错误码）；普通 429 与常规 5xx 网关故障不误判。 */
export function detectAccountAnomaly(status, body, meta = {}) {
  if (meta?.cfMitigated) {
    return {
      code: 'cf_mitigated',
      reason: `Cloudflare 挑战限制（HTTP ${status || 0} / cf-mitigated: ${String(meta.cfMitigated).slice(0, 60)}）`,
    };
  }
  if (meta?.redirected && CHALLENGE_REDIRECT_RE.test(String(meta.finalUrl || ''))) {
    return {
      code: 'challenge_redirect',
      reason: `请求被重定向至账号验证/登录页（HTTP ${status || 0}）`,
    };
  }
  if (status === 401 || status === 403) {
    const err = Array.isArray(body?.errors) ? body.errors[0] : null;
    const code = err?.code;
    const msg = err?.message ? String(err.message).slice(0, 120) : '';
    return {
      code: code ?? status,
      reason: `HTTP ${status}${code ? ` / code ${code}` : ''}${msg ? `：${msg}` : ''}`,
    };
  }
  // 非 5xx 的 HTML 响应，以及 503 下带明确 Cloudflare/Arkose 挑战特征的页面（排除普通 502/503/504 网关报错页）
  if (meta?.error === 'not_json') {
    const ct = String(meta.contentType || '').toLowerCase();
    const detail = String(meta.detail || '');
    if (status > 0 && status < 500 && (ct.includes('text/html') || HTML_CHALLENGE_RE.test(detail))) {
      return {
        code: 'html_challenge',
        reason: `收到非 JSON 网页/验证响应（HTTP ${status}）`,
      };
    }
    if (status === 503 && STRONG_CHALLENGE_RE.test(detail)) {
      return {
        code: 'html_challenge',
        reason: `收到验证挑战页面（HTTP 503）`,
      };
    }
  }
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  for (const err of errors) {
    if (!err || typeof err !== 'object') continue;
    const code = Number(err.code);
    const kind = String(err.kind || '');
    const msg = String(err.message || '');
    if (ACCOUNT_ANOMALY_CODES.has(code) || kind === 'Bounce' || err.bounce || ACCOUNT_ANOMALY_RE.test(msg)) {
      return {
        code: Number.isFinite(code) && code > 0 ? code : (kind || 'anomaly'),
        reason: `${Number.isFinite(code) && code > 0 ? `code ${code}` : (kind || '账号异常')}${msg ? `：${msg.slice(0, 120)}` : ''}`,
      };
    }
  }
  return null;
}
