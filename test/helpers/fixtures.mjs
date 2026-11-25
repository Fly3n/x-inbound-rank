// 多个测试文件共用的样本数据与小工具
import { ranking, cleanRules, DEFAULT_RULES, DAY_MS } from '../../src/rank.js';

export const NOW = Date.UTC(2026, 10, 13);

/** 一条直接评论我的帖子 c{id} 的回复事件 */
export const ev = (id, actor, daysAgo) => ({
  id: String(id), actor_id: actor, actor_handle: actor.toUpperCase(), actor_name: actor, actor_avatar: '', created_at: NOW - daysAgo * DAY_MS, conversation_id: 'c' + id, target_post_id: 'c' + id, root_mine: true,
});

export const rules = (o = {}) => cleanRules({ ...DEFAULT_RULES, ...o });

export const board = (events, r, now) => ranking(events, r, now).rows;

