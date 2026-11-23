// 后台共用常量、时间窗口、并发锁、串行 cursor 队列与快照计算。
import { getEvents, kvGet, kvSet, keys, getSettings, OUT } from '../db.js';
import { ranking, badgeSnapshot } from '../rank.js';

// 请求节奏。提及：旧接口额度实测 180 次 / 15 分钟、每页 20 条，新接口 1500 次 / 15 分钟、每页 40 条（2026-11-19）。
// 只保留远低于额度的节奏；真实账号还要经过行为风控，不能拿「没触发 429」当作安全。
export const PACE = {
  batchRestMs: [180_000, 300_000], // 回填：批与批之间的随机休息
  maxPagesPerRun: 300, // 回填（7/15 天）：单次运行的页数上限，到了就暂停等用户确认
  backoffStartMs: 15 * 60_000, // 限流后首次退避，之后每次翻倍
  backoffMaxMs: 4 * 60 * 60_000,
  incPagesPerEvent: 6, // 增量：每个后台事件最多六页，读完休息后自动续，避免单次事件过长
  incMaxRounds: 10, // 增量：单轮最多 10 段（60 页）安全上限
  incRetryGapMs: 10 * 60_000, // 增量：两次尝试的最小间隔（接着上一轮补读时不受限）
  restMs: [180_000, 300_000], // 一次读不完、分几轮读时，轮与轮之间的休息
  manualCooldownMs: 10 * 60_000, // 手动更新：十分钟内不重复向 X 发请求
  // 我的回复（「回复」栏的 GraphQL 接口）额度只有 50 次 / 15 分钟（2026-11-19 小号实测），比提及的 180 次小得多，单独定节奏：
  // 一个闹钟事件最多读 5 页，读不完休息 3–5 分钟再接着读，回填平均约每 15 分钟 16 页
  outPages: 5,
  outRestMs: [180_000, 300_000],
  outMaxRounds: 120, // 我的回复：一次读不完时最多接着读几轮（120 × 5 页 = 600 页，和回填单次上限一样），再多就到此为止
  outAutoGapMs: 48 * 60 * 60_000, // 可选方案 B：每 2 天低频自动同步兜底手机端回复
  activeInteractionMs: 5 * 60_000, // 自动更新要求同账号前台页最近 5 分钟内有真实浏览交互，避免白天亮屏离座空发请求
};

// X 的帖子编号不会为 0。可信的空列表初始化完成后用它当接续点，让自动增量能启动，又不会冒充真实帖子。
export const EMPTY_SYNC_ID = '0';

// 本地数据保存多久见 rank.js 的 KEEP_DAYS（90 天，和最长的榜单范围一致）

export const TICK_ALARM = 'tick';
export const STALE_TABS_ALARM = 'staleTabs';
export const JOB_ALARM = 'job';
export const INC_ALARM = 'inc';
export const OUT_ALARM = 'out';
export const alarmFor = (kind, account) => `${kind}:${account}`;
export const X_TABS = { url: ['https://x.com/*', 'https://twitter.com/*'] };
export const STALE_TABS_RETRY = 'staleTabsRetries';

export const enabledAccounts = async () => Object.entries(await kvGet(keys.accounts, {})).filter(([, a]) => a.enabled && a.userId);
export const enabledAccount = async (account) => account && (await kvGet(keys.accounts, {}))[account]?.enabled === true;

export function accountForUser(accounts, userId) {
  if (!/^\d+$/.test(userId || '')) return null;
  if (accounts[`uid-${userId}`]?.userId === userId) return `uid-${userId}`;
  const matches = Object.keys(accounts).filter((key) => accounts[key].userId === userId);
  return matches.length === 1 ? matches[0] : null;
}

export const rand = ([a, b]) => a + Math.floor(Math.random() * (b - a));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now();

/** 模拟真人刷通知的非均匀页间停顿（单事件内必须低于 Chrome ~30s 空闲回收线）。 */
export function humanIncDelay() {
  const r = Math.random();
  if (r < 0.35) return rand([4_000, 10_000]);
  if (r < 0.80) return rand([12_000, 22_000]);
  return rand([22_000, 28_000]);
}

/** 模拟真人补历史页间停顿（每页独立闹钟唤醒，允许长停顿）。 */
export function humanBackfillDelay() {
  const r = Math.random();
  if (r < 0.30) return rand([15_000, 28_000]);
  if (r < 0.75) return rand([30_000, 55_000]);
  return rand([60_000, 110_000]);
}

export const humanBatchPages = () => rand([8, 13]); // 每批 8–12 页后休息

// 模拟真人：自动任务只在本地时间 08:00–24:00 发生，凌晨不跑。
export const ACTIVE_START_HOUR = 8;
export const ACTIVE_LAST_START_MIN = 23 * 60 + 30;
export const inActiveHours = (ts = now()) => new Date(ts).getHours() >= ACTIVE_START_HOUR;

// 日常自动读取放在上午和晚间，模拟人自己刷通知的两个自然时段。
export const AUTO_SLOTS = [
  { start: 8 * 60, end: 11 * 60 + 30 },
  { start: 18 * 60, end: 22 * 60 + 30 },
];

export const inAutoSlot = (ts = now()) => {
  const d = new Date(ts);
  const minute = d.getHours() * 60 + d.getMinutes();
  return AUTO_SLOTS.some(({ start, end }) => minute >= start && minute < end);
};

/** 成功读完一轮后的下一次日常更新：下一个上午或晚间随机一次，不卡整点。 */
export function nextAutoSlot(ts = now()) {
  const d = new Date(ts);
  const minute = d.getHours() * 60 + d.getMinutes();
  for (const slot of AUTO_SLOTS) {
    if (minute >= slot.start) continue;
    const base = new Date(d);
    base.setHours(0, 0, 0, 0);
    return base.getTime() + slot.start * 60_000 + rand([0, (slot.end - slot.start) * 60_000]);
  }
  const first = AUTO_SLOTS[0];
  const tomorrow = new Date(d);
  tomorrow.setDate(d.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.getTime() + first.start * 60_000 + rand([0, (first.end - first.start) * 60_000]);
}

/** 可选方案 B：以至少 48 小时后为基准挑下一个上午或晚间随机窗口。 */
export const nextOutAutoSlot = (ts = now()) => nextAutoSlot(ts + PACE.outAutoGapMs);

export function nextActiveAt(ts = now()) {
  if (inActiveHours(ts)) {
    const d = new Date(ts);
    if (d.getHours() * 60 + d.getMinutes() <= ACTIVE_LAST_START_MIN) return ts;
  }
  const d = new Date(ts);
  d.setHours(ACTIVE_START_HOUR, 0, 0, 0);
  if (d.getTime() <= ts) d.setDate(d.getDate() + 1);
  return d.getTime() + rand([0, 30 * 60_000]);
}

export const temporaryUnavailable = (status) => [502, 503, 504].includes(status);
export const serviceWait = (attempt = 0) => Math.min(60, 5 * 2 ** attempt) * 60_000;

// 同一时刻只允许一个抓取动作。写法固定为：先不占锁查一遍该不该跑 → tryAcquireBusy()
// （检查与置位之间不能有 await）→ 占住之后再确认一遍。
let busy = false;
export const isBusy = () => busy;
export function tryAcquireBusy() {
  if (busy) return false;
  busy = true;
  return true;
}
export function releaseBusy() {
  busy = false;
}

// cursor:<账号> 由好几处「读出、改、写回」，必须排队一个一个来：两次交叠的话，后写的会把先写的那几项盖掉。
let cursorChain = Promise.resolve();
export function serial(fn) {
  const run = cursorChain.then(fn);
  cursorChain = run.catch(() => {}); // 一次出错不卡住后面的
  return run;
}

/** 改 cursor 的唯一入口：fn 就地改 cur，它的返回值原样返回。 */
export const updateCursor = (account, fn) =>
  serial(async () => {
    const cur = await kvGet(keys.cursor(account), {});
    const r = fn(cur);
    await kvSet(keys.cursor(account), cur);
    return r;
  });

export const board = async (account) => {
  const settings = await getSettings(account);
  const cur = await kvGet(keys.cursor(account), {});
  const out = await getEvents(account, OUT);
  // 有本机记录或至少同步过一次，就按当前榜单窗口直接聚合显示
  const hasOutData = out.some((o) => !o.own) || !!cur.out?.lastAt;
  return ranking(await getEvents(account), settings, now(), out, hasOutData);
};

// 快照每写一次，每个 x.com 标签页都要把标签重画一遍、弹窗也要重画，所以抓取过程中最多每 30 秒重算一次，
// 一轮结束时再补一次（flushSnapshot(account, true)）。改设置、页面上线、兜底闹钟仍然立刻重算。
export const SNAP_THROTTLE_MS = 30_000;
const snapDirty = new Set(); // 入库了新数据、快照还没跟上的账号
const snapAt = new Map(); // 账号 -> 上次重算的时间
export const markSnapDirty = (account) => snapDirty.add(account);
export const clearSnapDirty = (account) => snapDirty.delete(account);

export async function refreshSnapshot(account) {
  snapDirty.delete(account);
  snapAt.set(account, now());
  const rules = await getSettings(account);
  const o = (await kvGet(keys.cursor(account), {})).out;
  const out = await getEvents(account, OUT);
  const hasOutData = out.some((item) => !item.own) || !!o?.lastAt;
  const snap = {
    windowDays: rules.windowDays,
    show: { rank: rules.showRank, out: rules.showOut, rel: rules.showRel, place: rules.showPlace, schedule: rules.showSchedule },
    users: badgeSnapshot(await getEvents(account), rules, now(), out, hasOutData),
  };
  // 和存着的一样就不写：写了也只会让各个页面白白重画一遍
  const prev = await kvGet(keys.snap(account));
  if (prev && JSON.stringify({ windowDays: prev.windowDays, show: prev.show, users: prev.users }) === JSON.stringify(snap)) return;
  await kvSet(keys.snap(account), { at: now(), ...snap });
}

/** 有没跟上的新数据才重算；force 为假时离上次重算不到 30 秒就先不算。 */
export async function flushSnapshot(account, force) {
  if (!snapDirty.has(account)) return;
  if (!force && now() - (snapAt.get(account) || 0) < SNAP_THROTTLE_MS) return;
  await refreshSnapshot(account);
}

export const setAlert = (account, message) => kvSet(keys.alert(account), { at: now(), message });

/** 定好下一个上午或晚间时段；不改变补漏锚点。 */
export function scheduleNextInc(cur, from) {
  cur.nextIncAt = nextAutoSlot(from);
  return cur.nextIncAt;
}

/** 成功读完后，把本轮起点记为下一次补漏的锚点。 */
export function completeIncRound(cur, runStartedAt) {
  cur.lastIncrementalAt = runStartedAt;
  return scheduleNextInc(cur, now());
}

/** 回填完成后重置补漏锚点：下一次增量只看回填结束前 1 小时，不再沿用旧锚点大范围重扫。 */
export function completeBackfillRound(cur, finishedAt) {
  cur.lastIncrementalAt = finishedAt;
  return scheduleNextInc(cur, finishedAt);
}

/** 约好下一次增量（专门一个闹钟，不等 30 分钟一次的兜底闹钟）。 */
export async function armInc(account, nextIncAt) {
  await chrome.alarms.create(alarmFor(INC_ALARM, account), { when: Math.max(nextIncAt, now() + 1000) });
}
