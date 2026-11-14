// 统计层：纯函数，不依赖 X 的接口或页面结构。只统计回复。

export const DAY_MS = 86400000;
export const WINDOWS = [7, 15, 30]; // 可选的统计范围（天）
export const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray']; // 色值在 content/badge.css
export const LIMITS = { topN: [10, 500], minCount: [1, 99], maxTiers: 4 }; // maxTiers：阈值档最多 4 个，加上兜底色共 5 种颜色

/**
 * 榜单口径和标签颜色的默认值，用户可在弹窗「设置」里改，「恢复默认」回到这里（不含 windowDays）。
 * - topN / minCount：榜单和标签只有两个条件——窗口内至少回复 minCount 次，最多前 topN 名。
 * - tiers / baseColor：标签颜色按回复次数分档，不按名次（名次靠后的一大片往往都只有两三次，
 *   名次本身说明不了「值不值得回」）。达到某档的 min 就用那档的颜色，都没达到用 baseColor。
 */
export const DEFAULT_RULES = {
  windowDays: 7,
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
    topN: clampInt(raw.topN, LIMITS.topN, d.topN),
    minCount: clampInt(raw.minCount, LIMITS.minCount, d.minCount),
    tiers,
    baseColor: color(raw.baseColor, d.baseColor),
    showRank: raw.showRank !== false,
    showOut: raw.showOut !== false,
    showRel: raw.showRel !== false,
    showPlace: raw.showPlace !== false,
  };
}

export const colorOf = (count, rules) => (rules.tiers.find((t) => count >= t.min) || { color: rules.baseColor }).color;

/**
 * 只留「我的帖子下」的回复：对话根帖是我的才算，我去别人帖子下评论、对方回我的不算。
 * root_mine 为 null 的（抓取时那一页看不出根帖是谁的），如果同一对话里有别的回复已证明根帖是我的，也算；否则不算。
 */
export function underMyPosts(events) {
  const mine = new Set(events.filter((e) => e.root_mine === true).map((e) => e.conversation_id));
  return events.filter((e) => e.root_mine === true || (e.root_mine === null && mine.has(e.conversation_id)));
}

/**
 * 我在别人帖子下的回复，按「帖子是谁的」计数。返回 Map<user_id, 次数>。
 * 算的是对话根帖的作者：在他的帖子下回复任何人都算他的；在我自己帖子下回他的不算（解析时已去掉）。
 * root_user_id 为 null 的（抓取时那一页看不出根帖是谁的），同一对话里有别的回复知道根帖是谁的就跟着算，否则不算。
 */
/**
 * 别人回复我的那几条（ids），各自是在谁的帖子下：'me' 我的 / 'him' 回复者自己的 / 'other' 别人的 / null 本机数据看不出来。
 * 我的帖子靠入站事件的 root_mine；不是我的，就看「我回别人」那张表里同一个对话的根帖主人是谁。
 */
export function replyPlaces(events, out, ids) {
  const mine = new Set(underMyPosts(events).map((e) => e.id));
  const byId = new Map(events.map((e) => [e.id, e]));
  const rootOf = new Map(out.filter((o) => o.root_user_id).map((o) => [o.conversation_id, o.root_user_id]));
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

export function outboundCounts(out, windowDays, now = Date.now()) {
  const since = now - windowDays * DAY_MS;
  const rootOf = new Map(out.filter((e) => e.root_user_id).map((e) => [e.conversation_id, e.root_user_id]));
  const counts = new Map();
  for (const e of out) {
    if (e.created_at < since || e.created_at > now) continue;
    const root = e.root_user_id || rootOf.get(e.conversation_id);
    if (root) counts.set(root, (counts.get(root) || 0) + 1);
  }
  return counts;
}

/** 按回复者聚合时间窗内、我帖子下的回复。返回 Map<actor_id, row>。 */
export function aggregate(events, windowDays, now = Date.now()) {
  const since = now - windowDays * DAY_MS;
  const byActor = new Map();
  for (const e of underMyPosts(events)) {
    if (e.created_at < since || e.created_at > now) continue;
    let row = byActor.get(e.actor_id);
    if (!row) {
      row = { actor_id: e.actor_id, handle: e.actor_handle, name: e.actor_name, avatar: e.actor_avatar, count: 0, last: 0 };
      byActor.set(e.actor_id, row);
    }
    row.count++;
    // 改过名或头像的人，展示最近一次回复时的资料
    if (e.created_at >= row.last) {
      row.last = e.created_at;
      row.handle = e.actor_handle;
      row.name = e.actor_name;
      row.avatar = e.actor_avatar;
    }
  }
  return byActor;
}

/**
 * 回复榜 + 窗口内的总量。
 * rows：窗口内回复至少 minCount 次的人，最多前 topN 名；次数相同按最近回复时间排，再按 handle。每行带名次、标签颜色，
 *       以及 replied——同一窗口内我在他帖子下回复了几次（out 是我发出的回复，没有就都是 0）。
 * people / replies：窗口内在我帖子下回复过的总人数和总次数（不受 minCount、topN 影响）。
 */
export function ranking(events, rules, now = Date.now(), out = []) {
  const mine = outboundCounts(out, rules.windowDays, now);
  const all = [...aggregate(events, rules.windowDays, now).values()];
  const rows = all.filter((r) => r.count >= rules.minCount);
  rows.sort((a, b) => b.count - a.count || b.last - a.last || a.handle.localeCompare(b.handle));
  return {
    rows: rows.slice(0, rules.topN).map((r, i) => ({ rank: i + 1, ...r, color: colorOf(r.count, rules), replied: mine.get(r.actor_id) || 0 })),
    people: all.length,
    replies: all.reduce((n, r) => n + r.count, 0),
  };
}

export const board = (events, rules, now = Date.now()) => ranking(events, rules, now).rows;

/** 某个人在窗口内、我帖子下的回复，新的在前。total 是总数，items 最多 limit 条。 */
export function repliesOf(events, actorId, rules, now = Date.now(), limit = 50) {
  const since = now - rules.windowDays * DAY_MS;
  const mine = underMyPosts(events)
    .filter((e) => e.actor_id === actorId && e.created_at >= since && e.created_at <= now)
    .sort((a, b) => b.created_at - a.created_at);
  return { total: mine.length, items: mine.slice(0, limit).map((e) => ({ id: e.id, created_at: e.created_at, text: e.text || '' })) };
}

/**
 * 给内联标签用的快照：就是回复榜上的人。返回 { handle小写: { rank, count, color, last, replied? } }。
 * replied：同一窗口内我在他帖子下回复了几次。只有传了 out（「我回别人」已经读过）才带，没读过时不写 0，免得看成「一次没回」。
 */
export function badgeSnapshot(events, rules, now = Date.now(), out = null) {
  const users = {};
  for (const r of ranking(events, rules, now, out || []).rows) users[r.handle.toLowerCase()] = { rank: r.rank, count: r.count, color: r.color, last: r.last, ...(out ? { replied: r.replied } : {}) };
  return users;
}
