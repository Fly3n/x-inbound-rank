// 弹窗纯函数与常量：格式化、状态文案推导、导出构造。不依赖 DOM 或 chrome API。
import { LIMITS, underMyPosts, countsFromMe } from '../rank.js';

export const COLOR_NAMES = { red: '红', orange: '橙', yellow: '黄', green: '绿', cyan: '青', blue: '蓝', purple: '紫', gray: '灰' };

export const SHOW_KEYS = ['showRank', 'showOut', 'showRel', 'showPlace', 'showSchedule']; // 时间线上几种标签与排期辅助的开关
export const STORAGE_WATCH = /^(accounts|tpl:(replies|mentions)|(domWarning|settings|cursor|job|snap|alert):)/;

export const pad = (n) => String(n).padStart(2, '0');
export const fmtDay = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
export const fmtShortDay = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
export const fmtTime = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fmtExactTime = (ts) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const fullTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
export const windowLabel = (days) => ({ 15: '半个月', 30: '一个月', 60: ' 2 个月', 90: ' 3 个月' })[days] || ` ${days} 天`;

export function jobText(job, now = Date.now()) {
  const reached = job.oldestTs ? `，已回溯到 ${fmtDay(job.oldestTs)}` : '';
  const progress = `已读 ${job.pages} 页、入库 ${job.added} 条${reached}`;
  const next = job.nextAt && job.nextAt > now ? `，下一次请求约 ${fmtTime(job.nextAt)}` : '';
  return {
    running: `进行中（范围 ${job.rangeDays} 天）：${progress}${next}`,
    waiting_tab: `等待中：${job.message}。${progress}`,
    paused: `已暂停：${job.message}。${progress}${job.auto ? next : ''}`,
    error: `出错停止：${job.message}。${progress}`,
    done: job.reachedEnd
      ? job.oldestTs
        ? `已完成，但没翻到 ${job.rangeDays} 天前：X 的提及列表到底了，最早只拿到 ${fmtDay(job.oldestTs)}。共入库 ${job.added} 条`
        : '已完成：X 的提及列表是空的，没有可回填的数据'
      : `已完成：回溯到 ${fmtDay(job.oldestTs)}（范围 ${job.rangeDays} 天），共读 ${job.pages} 页、入库 ${job.added} 条`,
  }[job.status];
}

export function readSummary(at, counts, exact = false) {
  if (!at) return '暂无读取记录';
  const existing = counts ? Math.max(0, (counts.read || 0) - (counts.added || 0)) : 0;
  return (exact ? fmtExactTime(at) : fmtTime(at)) +
    (counts ? ` · 扫描 ${counts.read} 条 · 新增 ${counts.added} 条 · 已有 ${existing} 条` : ' · 暂无条数');
}

// 加减按钮：名次上限每次 50（10 和 50 之间直接跳），次数每次 1
export function stepRuleValue(key, current, dir) {
  if (key === 'topN') return dir > 0 ? (current < 50 ? 50 : current + 50) : current <= 50 ? LIMITS.topN[0] : current - 50;
  return current + dir;
}

// 导出为 CSV（带 BOM，Excel 直接打开不乱码）
export function buildCsv(lines) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '\uFEFF' + lines.map((l) => l.map(cell).join(',')).join('\r\n');
}

export function buildBoardExportRows(rows, outCountable) {
  return [
    ['名次', '名字', 'ID', '回复次数', '我回他次数', '最近一次回复', '主页'],
    ...rows.map((r) => [r.rank, r.name, `@${r.handle}`, r.count, outCountable ? r.replied : '', fullTime(r.last), `https://x.com/${r.handle}`]),
  ];
}

export function buildAllExportRows(inbound, outAll) {
  const counted = new Set(underMyPosts(inbound, outAll).map((e) => e.id)); // 计入回复榜的（在我帖子下回我的）
  const out = outAll.filter((o) => !o.own); // 我在自己帖子下的回复只用来认对话，不导出
  const handleOf = new Map(inbound.map((e) => [e.actor_id, e.actor_handle])); // 我回别人那份只存了用户编号，能对上的补成 @ID
  const link = (id) => `https://x.com/i/status/${id}`;
  const rows = [
    ...inbound.map((e) => ({
      ts: e.created_at,
      line: ['别人回我', fullTime(e.created_at), e.actor_name, `@${e.actor_handle}`, counted.has(e.id) ? '是' : '否', e.text || '', link(e.id)],
    })),
    ...out.map((e) => {
      const h = e.root_handle || handleOf.get(e.root_user_id);
      return { ts: e.created_at, line: ['我回别人', fullTime(e.created_at), '', h ? `@${h}` : e.root_user_id ? `用户编号 ${e.root_user_id}` : '未知', countsFromMe(e) ? '是' : '否', e.text || '', link(e.id)] };
    }),
  ].sort((x, y) => y.ts - x.ts);
  return [['类型', '时间', '对方名字', '对方 ID（我回别人时是帖子的主人）', '是否计入统计', '内容摘要', '链接'], ...rows.map((r) => r.line)];
}
