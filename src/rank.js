// 统计层：纯函数，不依赖 X 的接口或页面结构。只统计回复。

export const DAY_MS = 86400000;

/** 按回复者聚合时间窗内的回复。返回 Map<actor_id, row>。 */
export function aggregate(events, windowDays, now = Date.now()) {
  const since = now - windowDays * DAY_MS;
  const byActor = new Map();
  for (const e of events) {
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

/** 回复榜。次数相同按最近回复时间排，再按 handle。 */
export function board(events, windowDays, now = Date.now()) {
  const rows = [...aggregate(events, windowDays, now).values()];
  rows.sort((a, b) => b.count - a.count || b.last - a.last || a.handle.localeCompare(b.handle));
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

/**
 * 给内联标签用的快照：以 30 天回复榜定排名，附 7 天次数。
 * 返回 { handle小写: { rank, c30, c7, last } }，只含 30 天内回复过的人。
 */
export function badgeSnapshot(events, now = Date.now()) {
  const d7 = aggregate(events, 7, now);
  const users = {};
  for (const r of board(events, 30, now)) {
    users[r.handle.toLowerCase()] = { rank: r.rank, c30: r.count, c7: d7.get(r.actor_id)?.count || 0, last: r.last };
  }
  return users;
}
