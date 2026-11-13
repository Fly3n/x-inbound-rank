// 统计层：纯函数，不依赖 X 的接口或页面结构。只统计回复。

export const DAY_MS = 86400000;
export const WINDOWS = [7, 15]; // 可选的统计窗口（天）
export const TOP_N = 100; // 榜单和标签最多到第几名
export const MIN_COUNT = 2; // 窗口内只回复过 1 次的不上榜、不标
// 标签颜色按回复次数分档，不按名次：名次靠后的一大片往往都只有两三次，名次本身说明不了「值不值得回」。
export const TIERS = [20, 10, 5]; // 窗口内回复 >= 20 次：1 档（红）；10–19：2 档（橙）；5–9：3 档（蓝）；其余 2–4 次：4 档（灰）
export const tierOf = (count) => TIERS.findIndex((min) => count >= min) + 1 || TIERS.length + 1;

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

/** 回复榜：窗口内回复至少 MIN_COUNT 次的人，最多前 TOP_N 名。次数相同按最近回复时间排，再按 handle。 */
export function board(events, windowDays, now = Date.now()) {
  const rows = [...aggregate(events, windowDays, now).values()].filter((r) => r.count >= MIN_COUNT);
  rows.sort((a, b) => b.count - a.count || b.last - a.last || a.handle.localeCompare(b.handle));
  return rows.slice(0, TOP_N).map((r, i) => ({ rank: i + 1, ...r }));
}

/** 给内联标签用的快照：就是回复榜上的人。返回 { handle小写: { rank, count, tier, last } }。 */
export function badgeSnapshot(events, windowDays, now = Date.now()) {
  const users = {};
  for (const r of board(events, windowDays, now)) users[r.handle.toLowerCase()] = { rank: r.rank, count: r.count, tier: tierOf(r.count), last: r.last };
  return users;
}
