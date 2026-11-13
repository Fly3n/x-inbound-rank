// 统计层：纯函数，不依赖 X 的接口或页面结构。

export const DAY_MS = 86400000;
export const WINDOWS = [7, 30];
export const BOARDS = ['total', 'reply', 'quote'];

/** 按互动者聚合时间窗内的事件。返回 Map<actor_id, row>。 */
export function aggregate(events, windowDays, now = Date.now()) {
  const since = now - windowDays * DAY_MS;
  const byActor = new Map();
  for (const e of events) {
    if (e.created_at < since || e.created_at > now) continue;
    let row = byActor.get(e.actor_id);
    if (!row) {
      row = { actor_id: e.actor_id, handle: e.actor_handle, name: e.actor_name, avatar: e.actor_avatar, reply: 0, quote: 0, total: 0, last: 0, profileAt: 0 };
      byActor.set(e.actor_id, row);
    }
    if (e.type === 'reply') row.reply++;
    else if (e.type === 'quote') row.quote++;
    else continue;
    row.total = row.reply + row.quote; // 综合 = 回复 + 引用，等权
    if (e.created_at > row.last) row.last = e.created_at;
    // 改过名或头像的人，展示最近一次互动时的资料
    if (e.created_at >= row.profileAt) {
      row.profileAt = e.created_at;
      row.handle = e.actor_handle;
      row.name = e.actor_name;
      row.avatar = e.actor_avatar;
    }
  }
  return byActor;
}

/** 生成某个榜：board 为 total / reply / quote。次数相同按最近互动时间排，再按 handle。 */
export function board(events, boardKey, windowDays, now = Date.now()) {
  const rows = [...aggregate(events, windowDays, now).values()].filter((r) => r[boardKey] > 0);
  rows.sort((a, b) => b[boardKey] - a[boardKey] || b.last - a.last || a.handle.localeCompare(b.handle));
  return rows.map((r, i) => ({ rank: i + 1, actor_id: r.actor_id, handle: r.handle, name: r.name, avatar: r.avatar, reply: r.reply, quote: r.quote, total: r.total, last: r.last }));
}

/**
 * 给内联标签用的快照：以 30 天综合榜为准定排名，附 7 天次数。
 * 返回 { handle小写: { rank, r30, q30, r7, q7, last } }，只含 30 天内有互动的人。
 */
export function badgeSnapshot(events, now = Date.now()) {
  const d7 = aggregate(events, 7, now);
  const users = {};
  for (const r of board(events, 'total', 30, now)) {
    const w = d7.get(r.actor_id);
    users[r.handle.toLowerCase()] = { rank: r.rank, r30: r.reply, q30: r.quote, r7: w ? w.reply : 0, q7: w ? w.quote : 0, last: r.last };
  }
  return users;
}
