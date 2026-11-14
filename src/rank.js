// 统计层：纯函数，不依赖 X 的接口或页面结构。只统计回复。

export const DAY_MS = 86400000;
export const WINDOWS = [7, 15]; // 可选的统计窗口（天）
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
 * rows：窗口内回复至少 minCount 次的人，最多前 topN 名；次数相同按最近回复时间排，再按 handle。每行带名次和标签颜色。
 * people / replies：窗口内在我帖子下回复过的总人数和总次数（不受 minCount、topN 影响）。
 */
export function ranking(events, rules, now = Date.now()) {
  const all = [...aggregate(events, rules.windowDays, now).values()];
  const rows = all.filter((r) => r.count >= rules.minCount);
  rows.sort((a, b) => b.count - a.count || b.last - a.last || a.handle.localeCompare(b.handle));
  return {
    rows: rows.slice(0, rules.topN).map((r, i) => ({ rank: i + 1, ...r, color: colorOf(r.count, rules) })),
    people: all.length,
    replies: all.reduce((n, r) => n + r.count, 0),
  };
}

export const board = (events, rules, now = Date.now()) => ranking(events, rules, now).rows;

/** 给内联标签用的快照：就是回复榜上的人。返回 { handle小写: { rank, count, color, last } }。 */
export function badgeSnapshot(events, rules, now = Date.now()) {
  const users = {};
  for (const r of board(events, rules, now)) users[r.handle.toLowerCase()] = { rank: r.rank, count: r.count, color: r.color, last: r.last };
  return users;
}
