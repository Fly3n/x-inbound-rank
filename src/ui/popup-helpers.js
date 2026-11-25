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
  return (exact ? fmtExactTime(at) : fmtTime(at)) +
    (counts ? ` · 扫描 ${counts.read} 条 · 新增 ${counts.added} 条` : ' · 暂无条数');
}

export function formatDurationLabel(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return '';
  if (hours <= 24 || hours % 24 !== 0) return `${hours} 小时`;
  return `${hours / 24} 天`;
}

/** 按本机最近一次旁听或手动补读时间推算建议补读时长（向上取整，上限 15 天）。 */
export function suggestFetchWindow(lastSyncAt, now = Date.now()) {
  if (!lastSyncAt) return { amount: 3, unit: 'h', note: '暂无同步记录，可按需调整时长手动补读' };
  const gapMs = Math.max(0, now - lastSyncAt);
  if (gapMs < 60 * 60_000) return { amount: 1, unit: 'h', note: '刚刚已旁听/更新，通常无需补读' };
  if (gapMs <= 24 * 3_600_000) {
    const h = Math.min(24, Math.ceil(gapMs / 3_600_000));
    return { amount: h, unit: 'h', note: `距上次同步约 ${h} 小时（已预填，可自调）` };
  }
  const d = Math.min(15, Math.ceil(gapMs / 86_400_000));
  return { amount: d, unit: 'd', note: `距上次同步约 ${d} 天（已预填，可自调）` };
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
  const handleOf = new Map(inbound.filter((e) => e.actor_handle).map((e) => [e.actor_id, e.actor_handle])); // 我回别人那份只存了用户编号，能对上的补成 @ID
  const link = (id) => `https://x.com/i/status/${id}`;
  const rows = [
    ...inbound.map((e) => ({
      ts: e.created_at,
      line: ['别人回我', fullTime(e.created_at), e.actor_name, e.actor_handle ? `@${e.actor_handle}` : `用户编号 ${e.actor_id}`, counted.has(e.id) ? '是' : '否', e.text || '', link(e.id)],
    })),
    ...out.map((e) => {
      const h = e.root_handle || handleOf.get(e.root_user_id);
      return { ts: e.created_at, line: ['我回别人', fullTime(e.created_at), '', h ? `@${h}` : e.root_user_id ? `用户编号 ${e.root_user_id}` : '未知', countsFromMe(e) ? '是' : '否', e.text || '', link(e.id)] };
    }),
  ].sort((x, y) => y.ts - x.ts);
  return [['类型', '时间', '对方名字', '对方 ID（我回别人时是帖子的主人）', '是否计入统计', '内容摘要', '链接'], ...rows.map((r) => r.line)];
}

/** 紧凑的「上次读到」时间：今天只显示时分，其余显示月/日 时分。 */
export function fmtCompactTime(ts, now = Date.now()) {
  if (!ts) return '未读取';
  const d = new Date(ts);
  const nowD = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === nowD.getFullYear() && d.getMonth() === nowD.getMonth() && d.getDate() === nowD.getDate();
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 几个时间戳里最新的一个；都没有返回 null。 */
export const latestOf = (...vals) => Math.max(0, ...vals.map((v) => v || 0)) || null;

/** 「别人回我」补历史任务当前阶段的短文案；没在跑返回空串。 */
export const inTaskPhase = (job) => (job?.status === 'running' ? '进行中' : job?.status === 'waiting_tab' ? '等待 X 页面'
  : job?.status === 'paused' ? '已暂停' : '');

/** 「我回别人」手动任务的状态：阶段文案、是否有未结束任务、进度句与报错句。running 超过两分钟没动静当它已停。 */
export function outTaskState(out, now = Date.now()) {
  const running = out?.running && now - out.running.at < 120000 ? out.running : null;
  const phase = running ? '进行中' : out?.status === 'queued' ? '排队中'
    : out?.status === 'need_tpl' ? '等待回复页' : out?.status === 'waiting_tab' ? '等待 X 页面'
      : out?.resume && out.status !== 'error' ? '等待续读' : '';
  return {
    phase,
    pending: !!phase || (out?.fullFor === 0 && out?.status !== 'error'),
    progress: running ? `进行中，本轮已读 ${running.pages} 页。` : phase ? `${phase}。` : '',
    error: out?.message || '',
  };
}
