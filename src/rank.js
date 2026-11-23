// 统计层：纯函数，不依赖 X 的接口或页面结构。只统计回复。

export const DAY_MS = 86400000;
export const WINDOWS = [7, 15, 30, 60, 90]; // 榜单范围（天）：榜单、「我回 N」、时间线标签都按它
export const INIT_WINDOWS = [7, 15, 30]; // 初始化范围（天）：点「初始化」时往回读多远，和榜单范围分开（2026-11-19 定）
export const KEEP_DAYS = 90; // 本机数据保存多久，和最长的榜单范围一致；更早的每天自动清掉
export const WARN_DAYS = 80; // 最早的数据存满这么多天时，榜单上方提示「快到期了，先导出」
export const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray']; // 色值在 content/badge.css
export const LIMITS = { topN: [10, 500], minCount: [1, 99], maxTiers: 4 }; // maxTiers：阈值档最多 4 个，加上兜底色共 5 种颜色
// 「我回别人」表的数据版本。2：每条多存 reply_to_id（回的是哪条帖子），用来判断是不是直接评论他的帖子。
// 本机数据低于这个版本时，「我回 N」先不显示，后台自动重新读一遍补上。
export const OUT_SCHEMA = 2;

/**
 * 「我回别人」是否已经完整覆盖当前窗口。只用于初始化状态和覆盖提示，不用于隐藏窗口内的已有计数。
 */
export function outboundReady(out, windowDays, now = Date.now()) {
  if (!out?.lastAt || (out.schema || 1) < OUT_SCHEMA) return false;
  if (out.coverTs) return out.coverTs <= now - windowDays * DAY_MS;
  return !!out.reachedEnd;
}

/**
 * 「我回 N」有没有可用的本机记录：读过一次且是本机当前格式即可。
 * 没读完整个窗口时也照常按窗口内已有记录计数，覆盖到哪天由界面单独说明。
 */
export function outboundCountable(out) {
  return !!out?.lastAt && (out.schema || 1) >= OUT_SCHEMA;
}

/** 入站初始化是否覆盖所选范围；X 列表可信地到底且一条都没有，也算覆盖。 */
export function inboundInitCovered(lastBackfill, syncedId, initDays, now = Date.now()) {
  if (!lastBackfill || !syncedId) return false;
  if (lastBackfill.oldestTs) return lastBackfill.oldestTs <= now - initDays * DAY_MS;
  return !!lastBackfill.reachedEnd;
}

/** 出站初始化是否覆盖所选范围；提前到底不算覆盖所选范围，空列表到底才算。 */
export function outboundInitCovered(out, initDays, now = Date.now()) {
  if (!out || (out.schema || 1) < OUT_SCHEMA) return false;
  if (out.coverTs) return out.coverTs <= now - initDays * DAY_MS;
  return !!out.reachedEnd;
}

/**
 * 榜单口径和标签颜色的默认值，用户可在弹窗「设置」里改，「恢复默认」回到这里（不含 windowDays）。
 * - topN / minCount：榜单和标签只有两个条件——窗口内至少回复 minCount 次，最多前 topN 名。
 * - tiers / baseColor：标签颜色按回复次数分档，不按名次（名次靠后的一大片往往都只有两三次，
 *   名次本身说明不了「值不值得回」）。达到某档的 min 就用那档的颜色，都没达到用 baseColor。
 */
export const DEFAULT_RULES = {
  windowDays: 7, // 榜单范围
  initDays: 7, // 初始化范围
  topN: 100,
  minCount: 2,
  tiers: [
    { min: 20, color: 'red' },
    { min: 10, color: 'orange' },
    { min: 5, color: 'blue' },
  ],
  baseColor: 'gray',
  // 时间线上几种标签各自显不显示
  showRank: true, // 名次 + 回复次数
  showOut: true, // 名次标签里再带上「我回他几次」
  showRel: true, // 关系：互 / 粉
  showPlace: true, // 通知列表里回复在我的帖子下的标 M
  showSchedule: true, // 发帖排期弹窗里显示快捷档期
};

const clampInt = (v, [lo, hi], fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const color = (c, fallback) => (COLORS.includes(c) ? c : fallback);

/** 把存储里或界面传来的设置整理成合法的规则：越界的夹回范围，档位按次数从高到低、去重、最多 maxTiers 个。 */
export function cleanRules(raw = {}) {
  const d = DEFAULT_RULES;
  const seen = new Set();
  const tiers = (Array.isArray(raw.tiers) ? raw.tiers : d.tiers)
    .map((t) => ({ min: clampInt(t?.min, [1, 9999], null), color: color(t?.color, 'gray') }))
    .filter((t) => t.min !== null && !seen.has(t.min) && seen.add(t.min))
    .sort((a, b) => b.min - a.min)
    .slice(0, LIMITS.maxTiers);
  return {
    windowDays: WINDOWS.includes(raw.windowDays) ? raw.windowDays : d.windowDays,
    // 0.11.0 之前只有一个范围（7/15/30）：没存过初始化范围的，沿用当时那个
    initDays: INIT_WINDOWS.includes(raw.initDays) ? raw.initDays : INIT_WINDOWS.includes(raw.windowDays) ? raw.windowDays : d.initDays,
    topN: clampInt(raw.topN, LIMITS.topN, d.topN),
    minCount: clampInt(raw.minCount, LIMITS.minCount, d.minCount),
    tiers,
    baseColor: color(raw.baseColor, d.baseColor),
    showRank: raw.showRank !== false,
    showOut: raw.showOut !== false,
    showRel: raw.showRel !== false,
    showPlace: raw.showPlace !== false,
    showSchedule: raw.showSchedule !== false,
  };
}

export const colorOf = (count, rules) => (rules.tiers.find((t) => count >= t.min) || { color: rules.baseColor }).color;

/**
 * 「我回 N」计入的那一条：我直接评论他的帖子（第一层），记在帖子主人名下（负责人 2026-11-19 定）。
 * 深层（回他帖子下的评论、他回我后我再回）不算：实测只有一半左右认得出根帖是谁的。
 * own：我在自己帖子下的回复，只用来认「哪些对话是我的」，不计数。没有 reply_to_id 的是旧版本存的，判断不了，不算。
 */
export const countsFromMe = (o) => !o.own && !!o.reply_to_id && o.reply_to_id === o.conversation_id && !!o.root_user_id;

/** 本机数据能证明根帖是我的那些对话：入站里 root_mine 为 true 的，加上「我回别人」表里我在自己帖子下回复过的。 */
function myConversations(events, out = []) {
  const mine = new Set(events.filter((e) => e.root_mine === true).map((e) => e.conversation_id));
  for (const o of out) if (o.own) mine.add(o.conversation_id);
  return mine;
}

/**
 * 「在我的帖子下」的回复（任何一层）：对话根帖是我的。计数（回复榜）和通知列表的 M 都用它（负责人 2026-11-19 定：别人回我不分层都算）。
 * 表里存的都是「回复的是我」的，所以这里只要判断根帖是不是我的。
 * root_mine 为 null 的（抓取时看不出根帖是谁的），同一对话里有别的记录证明根帖是我的就算；否则不算。
 * 他在别人帖子下（包括他自己的帖子）回我的不算。
 */
export function underMyPosts(events, out = []) {
  const mine = myConversations(events, out);
  return events.filter((e) => e.root_mine === true || (e.root_mine === null && mine.has(e.conversation_id)));
}

/**
 * 别人回复我的那几条（ids），各自是在谁的帖子下：'me' 我的 / 'him' 回复者自己的 / 'other' 别人的 / null 本机数据看不出来。
 * 我的帖子靠入站事件的 root_mine；不是我的，就看「我回别人」那张表里同一个对话的根帖主人是谁。
 */
export function replyPlaces(events, out, ids) {
  const mine = new Set(underMyPosts(events, out).map((e) => e.id));
  const byId = new Map(events.map((e) => [e.id, e]));
  const rootOf = new Map(out.filter((o) => o.root_user_id && !o.own).map((o) => [o.conversation_id, o.root_user_id]));
  return Object.fromEntries(
    ids.map((id) => {
      const e = byId.get(id);
      if (!e) return [id, null];
      if (mine.has(id)) return [id, 'me'];
      const root = rootOf.get(e.conversation_id);
      return [id, !root ? null : root === e.actor_id ? 'him' : 'other'];
    }),
  );
}

const inOutboundWindow = (e, since, now) => e.created_at >= since && e.created_at <= now && countsFromMe(e);

/** 窗口内我直接评论了谁的帖子几次（口径见 countsFromMe）。返回 Map<帖子主人 user_id, 次数>。 */
export function outboundCounts(out, windowDays, now = Date.now()) {
  const since = now - windowDays * DAY_MS;
  const counts = new Map();
  for (const e of out) {
    if (!inOutboundWindow(e, since, now)) continue;
    counts.set(e.root_user_id, (counts.get(e.root_user_id) || 0) + 1);
  }
  return counts;
}

/** 按回复者聚合时间窗内计入榜单的回复（口径见 underMyPosts）。返回 Map<actor_id, row>。 */
export function aggregate(events, windowDays, now = Date.now(), out = []) {
  const since = now - windowDays * DAY_MS;
  const byActor = new Map();
  for (const e of underMyPosts(events, out)) {
    if (e.created_at < since || e.created_at > now) continue;
    let row = byActor.get(e.actor_id);
    if (!row) {
      const handle = String(e.actor_handle || e.actor_id || '');
      row = { actor_id: e.actor_id, handle, name: e.actor_name || handle, avatar: e.actor_avatar || '', count: 0, last: 0 };
      byActor.set(e.actor_id, row);
    }
    row.count++;
    // 改过名或头像的人，展示最近一次回复时的资料
    if (e.created_at >= row.last) {
      const handle = String(e.actor_handle || e.actor_id || '');
      row.last = e.created_at;
      row.handle = handle;
      row.name = e.actor_name || handle;
      row.avatar = e.actor_avatar || '';
    }
  }
  return byActor;
}

/**
 * 回复榜 + 窗口内的总量。
 * rows：窗口内回复至少 minCount 次的人，最多前 topN 名；次数相同按最近回复时间排，再按 handle。每行带名次、标签颜色，
 *       以及 replied——同一窗口内我直接评论他的帖子几次（out 是我发出的回复，没有就都是 0）。
 * people / replies：窗口内在我帖子下回复过我的总人数和总次数（不受 minCount、topN 影响）。
 */
export function ranking(events, rules, now = Date.now(), out = [], showOut = true) {
  const mine = showOut ? outboundCounts(out, rules.windowDays, now) : null;
  const all = [...aggregate(events, rules.windowDays, now, out).values()];
  const rows = all.filter((r) => r.count >= rules.minCount);
  rows.sort((a, b) => b.count - a.count || b.last - a.last || a.handle.localeCompare(b.handle));
  return {
    rows: rows.slice(0, rules.topN).map((r, i) => ({
      rank: i + 1, ...r, color: colorOf(r.count, rules),
      replied: showOut ? mine.get(r.actor_id) || 0 : null,
    })),
    people: all.length,
    replies: all.reduce((n, r) => n + r.count, 0),
  };
}

/** 某个人在窗口内计入两种次数的回复，按时间倒序，每栏最多 limit 条。 */
export function repliesOf(events, actorId, rules, now = Date.now(), limit = 50, out = []) {
  const since = now - rules.windowDays * DAY_MS;
  const mine = underMyPosts(events, out)
    .filter((e) => e.actor_id === actorId && e.created_at >= since && e.created_at <= now)
    .sort((a, b) => b.created_at - a.created_at);
  const sent = out.filter((e) => e.root_user_id === actorId && inOutboundWindow(e, since, now))
    .sort((a, b) => b.created_at - a.created_at);
  return {
    total: mine.length,
    items: mine.slice(0, limit).map((e) => ({ id: e.id, created_at: e.created_at, text: e.text || '' })),
    outbound: {
      total: sent.length,
      items: sent.slice(0, limit).map((e) => ({ id: e.id, created_at: e.created_at, text: e.text || '' })),
    },
  };
}

/**
 * 给内联标签用的快照：就是回复榜上的人。返回 { handle小写: { rank, count, color, last, replied? } }。
 * replied：同一窗口内我直接评论他的帖子几次。只有 showOut 为 true（「我回别人」已经读完）才带，没读过时不写 0，免得看成「一次没回」。
 * out 总是要传本机有的：认「哪些对话是我的」也要用它。
 */
export function badgeSnapshot(events, rules, now = Date.now(), out = [], showOut = true) {
  const users = {};
  for (const r of ranking(events, rules, now, out || []).rows) {
    const key = String(r.handle || r.actor_id || '').toLowerCase();
    if (key) users[key] = { rank: r.rank, count: r.count, color: r.color, last: r.last, ...(showOut ? { replied: r.replied } : {}) };
  }
  return users;
}
