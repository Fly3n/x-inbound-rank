// 后台调度：账号绑定、回填任务、增量更新、给界面供数。
// 不直接碰 X 的接口与返回结构——请求经 x.com 标签页里的抓取层(fetcher.js)发出，返回交给解析层(parser.js)。

import { parseMentions, parseMyReplies, ParseError, idGt } from './x/parser.js';
import { replyPlaces, ranking, repliesOf, badgeSnapshot, cleanRules, DAY_MS, WINDOWS, OUT_SCHEMA } from './rank.js';
import { putEvents, getEvents, clearEvents, pruneEvents, kvGet, kvSet, kvRemove, keys, getSettings, OUT } from './db.js';

// 请求节奏。接口硬额度实测为 180 次 / 15 分钟；下面的回填节奏约 55 次 / 15 分钟（额度的三成），
// 每小时约 220 页 ≈ 4400 条提及。X 的行为风控不公开，要再调快先小步试。
const PACE = {
  pageGapMs: [8_000, 15_000], // 回填：两页之间的随机间隔
  batchPages: 20, // 回填：每批页数
  batchRestMs: [60_000, 120_000], // 回填：批与批之间的随机休息
  maxPagesPerRun: 600, // 回填：单次运行的页数上限，到了就暂停等用户确认
  backoffStartMs: 15 * 60_000, // 限流后首次退避，之后每次翻倍
  backoffMaxMs: 4 * 60 * 60_000,
  incPageGapMs: [3_000, 6_000], // 增量：页与页之间的间隔
  incIntervalMs: [50 * 60_000, 70 * 60_000], // 增量：大约每小时一次，每轮结束后在这个范围里随机定下一次，不卡整点
  incMaxPages: 40, // 增量：单次最多页数（约 800 条提及，3 分钟内跑完，不超过 Service Worker 单次事件时限）
  incRetryGapMs: 10 * 60_000, // 增量：两次尝试的最小间隔（接着上一轮补读时不受限）
  restMs: [60_000, 120_000], // 一次读不完、分几轮读时，轮与轮之间的休息
  slowPages: 20, // 一次要读很多页时（「我回别人」初始化、增量读满 40 页后的补读）：按回填的页间隔，一个闹钟事件最多读这么多页（约 4 分钟）
  outDelayMs: [60_000, 120_000], // 我的回复：每轮增量（或回填）结束后隔这么久读，单独一个闹钟事件，不和增量挤在一起
  outMaxPages: 40, // 我的回复：平时增量单次最多页数（和别人回我的增量一样）
  outMaxRounds: 30, // 我的回复：一次读不完时最多接着读几轮（30 × 20 页 = 600 页，和回填单次上限一样），再多就到此为止
  tplWaitMs: 25_000, // 我的回复：自己开标签页取请求地址时，最多等这么久
  tplRetryMs: 6 * 60 * 60_000, // 我的回复：自动读的时候没取到，隔这么久才再开一次标签页；手动点「初始化」不受限
};

// 本地只留最近这么多天的回复：最长的统计范围是 30 天，更早的用不上，不删的话库会一直涨、每次算榜都要全读一遍
const KEEP_DAYS = 45;

const TICK_ALARM = 'tick';
const JOB_ALARM = 'job';
const INC_ALARM = 'inc';
const OUT_ALARM = 'out';
const ACTIVE_JOB = 'activeJobAccount';

const rand = ([a, b]) => a + Math.floor(Math.random() * (b - a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// 同一时刻只允许一个抓取动作。写法固定为：先不占锁查一遍该不该跑 → `if (busy) return; busy = true;`
// （这两句之间不能有 await）→ 占住之后再确认一遍。查和占中间隔着 await 的话，两个几乎同时到的触发
// （比如浏览器重启时两个 x.com 标签页同时上线）会都查到「空闲」，一起跑；反过来先占锁再慢慢查，
// 又会让只是来看一眼、根本不用跑的调用把别的动作（比如用户刚点的初始化）挡掉。
let busy = false;

// cursor:<账号> 由好几处「读出、改、写回」，必须排队一个一个来：两次交叠的话，后写的会把先写的那几项盖掉。
let cursorChain = Promise.resolve();
function serial(fn) {
  const run = cursorChain.then(fn);
  cursorChain = run.catch(() => {}); // 一次出错不卡住后面的
  return run;
}
/** 改 cursor 的唯一入口：fn 就地改 cur，它的返回值原样返回。 */
const updateCursor = (account, fn) =>
  serial(async () => {
    const cur = await kvGet(keys.cursor(account), {});
    const r = fn(cur);
    await kvSet(keys.cursor(account), cur);
    return r;
  });

// ---------- 账号 ----------

async function resolveAccount({ userId, handle }) {
  const accounts = await kvGet(keys.accounts, {});
  let key = handle ? handle.toLowerCase() : null;
  if (!key && userId) key = Object.keys(accounts).find((k) => accounts[k].userId === userId) || null;

  if (!key) {
    await kvSet(keys.pendingUserId, userId || 'unknown');
    await kvRemove(keys.current);
    return null;
  }
  accounts[key] = { handle: handle || accounts[key].handle, userId: userId || accounts[key]?.userId || null, seenAt: now() };
  await kvSet(keys.accounts, accounts);
  await kvSet(keys.current, key);
  await kvRemove(keys.pendingUserId);
  return key;
}

async function bindManualHandle(raw) {
  const handle = String(raw || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { error: 'handle 只能是 1–15 位字母、数字或下划线' };
  const pending = await kvGet(keys.pendingUserId);
  await resolveAccount({ handle, userId: pending && pending !== 'unknown' ? pending : null });
  return { ok: true };
}

// ---------- 抓取一页（经 x.com 标签页） ----------

async function fetchViaTab(req) {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  for (const tab of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'xir:fetch', ...req });
      if (r) return r;
    } catch {
      // 该标签页没有内容脚本（装插件前打开的、或已被休眠），换下一个
    }
  }
  return { ok: false, error: 'no_tab' };
}

/** 问一圈开着的 X 页面：有没有连着插件的、是哪一版、见过哪些接口请求。没有连着的返回 null。 */
async function pingPages() {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  const seen = [];
  for (const tab of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'xir:ping' });
      if (r?.ok) seen.push(r);
    } catch {
      // 这个标签页没有（当前版本的）内容脚本
    }
  }
  if (!seen.length) return null;
  return { versions: [...new Set(seen.map((r) => r.version).filter(Boolean))], ops: [...new Set(seen.flatMap((r) => r.ops || []))] };
}

/** 抓一页并入库。返回 {kind:'ok',parsed,added} | {kind:'rate',resetAt} | {kind:'no_tab'} | {kind:'error',message} */
async function pull(account, cursor) {
  if (!(await getSettings(account)).fetchEnabled) return { kind: 'error', message: '后台抓取已关闭' };
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me) return { kind: 'error', message: '账号未绑定' };

  const r = await fetchViaTab({ cursor });
  if (r.error === 'no_tab') return { kind: 'no_tab' };
  if (r.userId && me.userId && r.userId !== me.userId) {
    return { kind: 'error', message: `当前登录的 X 账号不是 @${me.handle}，已停止，避免数据串号` };
  }
  if (r.status === 429) return { kind: 'rate', resetAt: r.rateResetAt };
  if (r.error === 'no_session' || r.status === 401 || r.status === 403) {
    return { kind: 'error', message: `X 登录状态无效或请求被拒（${r.status || '无会话'}），请确认已登录后重试` };
  }
  if (r.error === 'network') return { kind: 'error', message: `网络请求失败：${r.detail || ''}` };
  if (!r.ok) return { kind: 'error', message: `X 接口返回异常（HTTP ${r.status}），接口可能已变更，需要更新抓取层` };

  let parsed;
  try {
    parsed = parseMentions(r.body, me);
  } catch (e) {
    const why = e instanceof ParseError ? e.message : String(e);
    return { kind: 'error', message: `解析失败：${why}。X 的返回结构可能已变更，需要更新解析层` };
  }

  const added = await putEvents(account, parsed.events);
  await updateCursor(account, (cur) => {
    if (parsed.newestId && (!cur.newestId || idGt(parsed.newestId, cur.newestId))) cur.newestId = parsed.newestId;
    if (parsed.oldestTs && (!cur.earliestTs || parsed.oldestTs < cur.earliestTs)) cur.earliestTs = parsed.oldestTs;
  });
  await kvRemove(keys.alert(account));
  if (added) {
    snapDirty.add(account);
    await flushSnapshot(account, false);
  }
  return { kind: 'ok', parsed, added };
}

const board = async (account) => ranking(await getEvents(account), await getSettings(account), now(), await getEvents(account, OUT));

// 快照每写一次，每个 x.com 标签页都要把标签重画一遍、弹窗也要重画，所以抓取过程中最多每 30 秒重算一次，
// 一轮结束时再补一次（flushSnapshot(account, true)）。改设置、页面上线、兜底闹钟仍然立刻重算。
const SNAP_THROTTLE_MS = 30_000;
const snapDirty = new Set(); // 入库了新数据、快照还没跟上的账号
const snapAt = new Map(); // 账号 -> 上次重算的时间

async function refreshSnapshot(account) {
  snapDirty.delete(account);
  snapAt.set(account, now());
  const rules = await getSettings(account);
  // 「我回别人」读完过一次之后，标签里才带「我回他几次」
  const o = (await kvGet(keys.cursor(account), {})).out;
  const out = o?.lastAt && (o.schema || 1) >= OUT_SCHEMA ? await getEvents(account, OUT) : null; // 旧版本存的数据口径不全，宁可先不显示
  const snap = { windowDays: rules.windowDays, show: { rank: rules.showRank, out: rules.showOut, rel: rules.showRel, place: rules.showPlace }, users: badgeSnapshot(await getEvents(account), rules, now(), out) };
  // 和存着的一样就不写：写了也只会让各个页面白白重画一遍
  const prev = await kvGet(keys.snap(account));
  if (prev && JSON.stringify({ windowDays: prev.windowDays, show: prev.show, users: prev.users }) === JSON.stringify(snap)) return;
  await kvSet(keys.snap(account), { at: now(), ...snap });
}

/** 有没跟上的新数据才重算；force 为假时离上次重算不到 30 秒就先不算。 */
async function flushSnapshot(account, force) {
  if (!snapDirty.has(account)) return;
  if (!force && now() - (snapAt.get(account) || 0) < SNAP_THROTTLE_MS) return;
  await refreshSnapshot(account);
}

const setAlert = (account, message) => kvSet(keys.alert(account), { at: now(), message });

/** 记下这一轮增量的时间，并随机定好下一次。只改 cur，在 updateCursor 里调用；返回下一次的时间，交给 armInc 约闹钟。 */
function planNextInc(cur, from) {
  cur.lastIncrementalAt = from;
  cur.nextIncAt = from + rand(PACE.incIntervalMs);
  return cur.nextIncAt;
}

/** 约好下一次增量（专门一个闹钟，不等 30 分钟一次的兜底闹钟），以及别人的回复读完后接着读我自己的。 */
async function armInc(nextIncAt) {
  await chrome.alarms.create(INC_ALARM, { when: Math.max(nextIncAt, now() + 1000) });
  await chrome.alarms.create(OUT_ALARM, { when: now() + rand(PACE.outDelayMs) });
}

// ---------- 回填 ----------

async function saveJob(account, job) {
  await kvSet(keys.job(account), job);
}

async function scheduleJob(job, delayMs) {
  job.nextAt = now() + delayMs;
  await chrome.alarms.create(JOB_ALARM, { when: job.nextAt });
}

async function startBackfill(account) {
  const settings = await getSettings(account);
  if (!settings.fetchEnabled) return { error: '自动更新已关闭，先在设置里打开' };
  const rangeDays = settings.windowDays; // 回填范围就是统计窗口
  const job = {
    status: 'running',
    rangeDays,
    targetTs: now() - rangeDays * DAY_MS,
    cursor: null,
    pages: 0,
    added: 0,
    batchPages: 0,
    oldestTs: null,
    startedAt: now(),
    backoffMs: PACE.backoffStartMs,
  };
  await saveJob(account, job);
  await kvSet(ACTIVE_JOB, account);
  stepBackfill(); // 不等待，界面立刻返回
  return { ok: true };
}

async function finishJob(account, job, { reachedEnd }) {
  job.status = 'done';
  job.reachedEnd = reachedEnd; // true = X 的列表到底了，没翻到用户选的范围
  job.finishedAt = now();
  job.nextAt = null;
  await saveJob(account, job);
  const next = await updateCursor(account, (cur) => {
    cur.lastBackfill = { rangeDays: job.rangeDays, finishedAt: job.finishedAt, oldestTs: job.oldestTs, reachedEnd };
    // syncedId：从它往后（更早）到回填终点是连续完整的；增量每次从最新读回到它为止
    if (job.topId && (!cur.syncedId || idGt(job.topId, cur.syncedId))) cur.syncedId = job.topId;
    return planNextInc(cur, job.startedAt); // 回填期间新来的回复留给下一次增量
  });
  await armInc(next);
  await refreshSnapshot(account);
}

/** 抓取被别的动作占着：约一个闹钟一分钟后再来（已经约了更早的就不动）。 */
async function retryJobLater() {
  const when = now() + 60_000;
  const a = await chrome.alarms.get(JOB_ALARM);
  if (!a || !(a.scheduledTime <= when)) await chrome.alarms.create(JOB_ALARM, { when });
}

/** 当前有没有该往下走的回填任务：有就返回 { account, job }。 */
async function runningJob() {
  const account = await kvGet(ACTIVE_JOB);
  const job = account && (await kvGet(keys.job(account)));
  return job && job.status === 'running' ? { account, job } : null;
}

async function stepBackfill() {
  if (busy) return retryJobLater();
  if (!(await runningJob())) return;
  if (busy) return retryJobLater();
  busy = true;
  let account = null;
  try {
    const cur = await runningJob(); // 占住之后重读：上面等待的工夫里，上一步可能刚存了新进度
    if (!cur) return;
    account = cur.account;
    const job = cur.job;

    const res = await pull(account, job.cursor);
    // 请求的这一两秒里，用户可能点了暂停、重新初始化或清空：那就以存储里的为准，这一步的结果不再写回
    const latest = await kvGet(keys.job(account));
    if (!latest || latest.startedAt !== job.startedAt || latest.status !== 'running') return;

    if (res.kind === 'no_tab') {
      job.status = 'waiting_tab';
      job.message = '没有可用的 X 标签页。打开或刷新一个 x.com 页面后自动继续';
    } else if (res.kind === 'rate') {
      job.status = 'paused';
      job.auto = true;
      const wait = Math.max(job.backoffMs, (res.resetAt || 0) - now());
      job.backoffMs = Math.min(job.backoffMs * 2, PACE.backoffMaxMs);
      job.message = '被 X 限流（429），已暂停，到时间自动继续';
      await scheduleJob(job, wait);
    } else if (res.kind === 'error') {
      job.status = 'error';
      job.message = res.message;
      await setAlert(account, res.message);
    } else {
      const p = res.parsed;
      if (job.pages === 0) job.topId = p.newestId; // 本次回填的起点，完成后作为增量的接续点
      job.pages++;
      job.batchPages++;
      job.added += res.added;
      job.message = null;
      job.backoffMs = PACE.backoffStartMs;
      if (p.oldestTs) job.oldestTs = p.oldestTs;

      if (p.oldestTs && p.oldestTs <= job.targetTs) {
        await finishJob(account, job, { reachedEnd: false });
        return;
      }
      if (!p.bottomCursor || !p.entryIds.length || p.bottomCursor === job.cursor) {
        await finishJob(account, job, { reachedEnd: true });
        return;
      }
      job.cursor = p.bottomCursor;
      if (job.pages % PACE.maxPagesPerRun === 0) {
        job.status = 'paused';
        job.auto = false;
        job.message = `已连续翻 ${job.pages} 页，为安全起见先停下。确认账号没有异常后可点「继续」`;
      } else if (job.batchPages >= PACE.batchPages) {
        job.batchPages = 0;
        await scheduleJob(job, rand(PACE.batchRestMs));
      } else {
        await scheduleJob(job, rand(PACE.pageGapMs));
      }
    }
    await saveJob(account, job);
  } finally {
    // 任务停下来（暂停、出错、等标签页）时，把节流期间没跟上的数据补进快照
    if (account) await flushSnapshot(account, (await kvGet(keys.job(account)))?.status !== 'running').catch(() => {});
    busy = false;
  }
}

async function pauseJob(account, message = '已手动暂停') {
  const job = await kvGet(keys.job(account));
  if (!job || !['running', 'waiting_tab', 'paused'].includes(job.status)) return;
  job.status = 'paused';
  job.auto = false;
  job.nextAt = null;
  job.message = message;
  await saveJob(account, job);
  await chrome.alarms.clear(JOB_ALARM);
}

async function resumeJob(account) {
  const job = await kvGet(keys.job(account));
  if (!job || !['paused', 'error', 'waiting_tab'].includes(job.status)) return { error: '没有可继续的任务' };
  if (!(await getSettings(account)).fetchEnabled) return { error: '后台抓取已关闭，先在设置里打开' };
  job.status = 'running';
  job.auto = false;
  job.message = null;
  await saveJob(account, job);
  await kvSet(ACTIVE_JOB, account);
  stepBackfill();
  return { ok: true };
}

/** 闹钟到点、或有 X 标签页上线时调用：把该继续的任务接上。 */
async function wakeJob(tabOnline) {
  const account = await kvGet(ACTIVE_JOB);
  if (!account) return;
  const job = await kvGet(keys.job(account));
  if (!job) return;
  const due = !job.nextAt || job.nextAt <= now();
  if (job.status === 'running') {
    // 已经在跑的不写回：这一步可能正在请求中，写回会把它刚存的进度盖掉
    if (!due) return;
  } else {
    if (job.status === 'paused' && job.auto && due) job.status = 'running';
    else if (job.status === 'waiting_tab' && tabOnline && account === (await kvGet(keys.current))) job.status = 'running';
    else return;
    job.auto = false;
    await saveJob(account, job);
  }
  await stepBackfill();
}

// ---------- 增量 ----------

/** 增量现在该不该跑：该跑返回 { account, cur, settings }，不该返回 null。 */
async function incDue() {
  const account = await kvGet(keys.current);
  if (!account) return null;
  const settings = await getSettings(account);
  if (!settings.fetchEnabled) return null;
  const cur = await kvGet(keys.cursor(account), {});
  if (!cur.syncedId) return null; // 还没完成过初始化，不自动抓
  const job = await kvGet(keys.job(account));
  if (job && ['running', 'waiting_tab'].includes(job.status)) return null;
  if (job && job.status === 'paused' && job.auto) return null; // 限流退避中
  const t = now();
  if (t < (cur.nextIncAt || 0)) return null;
  if (!cur.incResume && t - (cur.lastAttemptAt || 0) < PACE.incRetryGapMs) return null; // 接着上一轮补读的不受这个限制
  return { account, cur, settings };
}

async function maybeIncremental() {
  // 正在跑的那个动作结束后会自己约下一次；到点没跑上的由兜底闹钟接上
  if (busy || !(await incDue())) return;
  if (busy) return;
  busy = true;
  let account = null;
  try {
    const due = await incDue(); // 占住之后再确认一遍：上面查的工夫里刚跑完一轮的话，时间已经往后推了
    if (!due) return;
    account = due.account;
    const { cur, settings } = due;

    // 从最新一页往回读，读到上次的接续点为止：间隔里来了多少就读多少，不丢。
    // 一轮最多 40 页（约 800 条），平时一小时的量远到不了。读满还没接上（比如电脑关了一整天），
    // 记下位置，一两分钟后按回填的慢节奏接着读，直到接上、或者读到统计范围的起点（更早的用不上）。
    // 接上之前接续点不动；出错中断时下次重读这一段，靠主键去重。
    const stopAt = cur.syncedId;
    const resume = cur.incResume?.stopAt === stopAt ? cur.incResume : null;
    const floorTs = now() - settings.windowDays * DAY_MS;
    const gap = resume ? PACE.pageGapMs : PACE.incPageGapMs;
    const maxPages = resume ? PACE.slowPages : PACE.incMaxPages;
    let cursor = resume?.cursor || null;
    let topId = resume?.topId || null;
    let caughtUp = false;
    for (let page = 0; page < maxPages; page++) {
      if (page) await sleep(rand(gap));
      const res = await pull(account, cursor);
      if (res.kind === 'no_tab') return; // 没有 X 标签页，等下次有页面上线再试，不记失败
      await updateCursor(account, (c) => {
        c.lastAttemptAt = now();
      });
      if (res.kind === 'rate') {
        await armInc(await updateCursor(account, (c) => planNextInc(c, now()))); // 这一轮放弃，等下个周期
        await setAlert(account, '增量更新被 X 限流（429），本轮已放弃，下个周期再试');
        return;
      }
      if (res.kind === 'error') {
        await setAlert(account, res.message);
        return;
      }
      const p = res.parsed;
      if (page === 0 && !resume) topId = p.newestId;
      if (!p.entryIds.length || !idGt(p.oldestId, stopAt) || !p.bottomCursor || p.oldestTs <= floorTs) {
        caughtUp = true;
        break;
      }
      cursor = p.bottomCursor;
    }
    if (!caughtUp) {
      const when = now() + rand(PACE.restMs);
      await updateCursor(account, (c) => {
        if (!c.syncedId) return; // 读的过程中被清空了
        c.incResume = { cursor, topId, stopAt };
        c.nextIncAt = when;
      });
      await chrome.alarms.create(INC_ALARM, { when });
      return;
    }
    const next = await updateCursor(account, (c) => {
      // 读的过程中被清空了（没有 syncedId）就不补：清空后要重新初始化才自动抓
      if (topId && c.syncedId && idGt(topId, c.syncedId)) c.syncedId = topId;
      delete c.incResume;
      return planNextInc(c, now());
    });
    await armInc(next);
  } finally {
    if (account) await flushSnapshot(account, true).catch(() => {});
    busy = false;
  }
}

// ---------- 我在别人帖子下的回复 ----------
// 数据来自我自己主页「回复」栏的列表（里面混着原创帖和转发，解析时只留回复）。
// 状态放在 cursor.out：{ status: 'ok'|'need_tpl'|'error', message, syncedId, coverTs, lastAt, pages }
//   running：{ at, pages } 正在读、已读几页（读完清掉）；syncedId：上次读到的最新一条；fullFor：最近一次完整读覆盖的统计范围（天），比当前范围小就要重新完整读；
//   resume：完整读被页数上限截断时的续读位置；lastAt：最近一次读完的时间；lastFullAt / lastFullDays：最近一次完整读（初始化）完成的时间和范围。

const NEED_TPL = '请在 X 上打开你自己主页的「回复」栏一次';

/**
 * 读「回复」列表要照着 X 页面自己发的那条请求（查询 ID 和参数随 X 发版变，不能写死）。
 * 手里没有的时候自己去取：在后台开一个标签页到我主页的「回复」栏，X 页面会发那条请求，
 * 那个页面里的内容脚本记下地址（xir:tpl）后，把这个标签页关掉。用户不用做任何事。
 * force：手动点的，不受重试间隔限制。取不到返回 null。
 */
async function grabTpl(me, force) {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(me.handle || '')) return null;
  if (!force && now() - (await kvGet(keys.tplTry, 0)) < PACE.tplRetryMs) return null;
  await kvSet(keys.tplTry, now());
  let tab;
  try {
    tab = await chrome.tabs.create({ url: `https://x.com/${me.handle}/with_replies`, active: false });
    for (const until = now() + PACE.tplWaitMs; now() < until; await sleep(500)) {
      const tpl = await kvGet(keys.tpl);
      if (tpl) return tpl;
    }
  } catch {
    // 开不了标签页就当没取到
  } finally {
    if (tab?.id != null) await chrome.tabs.remove(tab.id).catch(() => {});
  }
  return null;
}

const saveOut = (account, patch) =>
  updateCursor(account, (cur) => {
    cur.out = { ...cur.out, ...patch };
  });

/** force：手动点「初始化」，不管上次读到哪，按统计范围重新读一遍。 */
async function syncOut(force = false) {
  const account = await kvGet(keys.current);
  if (!account) return;
  const settings = await getSettings(account);
  if (!settings.fetchEnabled) return;
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me) return;
  if (busy) {
    // 正在读另一份数据：过一两分钟再来。手动点的先把「要重新完整读」记下，到时候照办
    if (force) await saveOut(account, { fullFor: 0, resume: null });
    await chrome.alarms.create(OUT_ALARM, { when: now() + rand(PACE.outDelayMs) });
    return;
  }
  busy = true;
  let started = false;
  try {
    if (force) await saveOut(account, { fullFor: 0, resume: null });
    const cur = await kvGet(keys.cursor(account), {});

    const targetTs = now() - settings.windowDays * DAY_MS;
    const prev = cur.out || {};
    // 完整读：第一次、统计范围调大了、手动初始化、或本机数据是旧版本存的——读到范围起点。否则只读到上次的位置。
    const full = !prev.syncedId || (prev.fullFor || 0) < settings.windowDays || (prev.schema || 1) < OUT_SCHEMA;
    // 上一轮被页数上限截断、留了续读位置：同一种读法就接着读；读法变了（比如范围调大了）就从头来
    const resume = prev.resume && (prev.resume.full ?? true) === full ? prev.resume : null;
    const stopAt = full ? null : resume?.stopAt || prev.syncedId;
    // 一次要读很多页（完整读、或接着上一轮读）时按回填的节奏，慢一些；平时的增量一般就一两页，按增量的节奏
    const slow = full || !!resume;
    const gap = slow ? PACE.pageGapMs : PACE.incPageGapMs;
    const maxPages = slow ? PACE.slowPages : PACE.outMaxPages;

    // running：正在读，读到第几页。弹窗据此显示进度；不管怎么结束，finally 里都会清掉
    started = true;
    await saveOut(account, { running: { at: now(), pages: 0 } });
    const tpl = (await kvGet(keys.tpl)) || (await grabTpl(me, force));
    if (!tpl) return saveOut(account, { status: 'need_tpl', message: `没能自动取到 X 读「回复」列表的方式。${NEED_TPL}（x.com/${me.handle}/with_replies），插件看到后会自己开始读` });
    let cursor = resume?.cursor || null;
    let topId = resume?.topId || null;
    let reachedTs = null;
    let complete = false; // 读到了该停的位置（不是被页数上限截断）
    let pages = 0;
    for (; pages < maxPages; pages++) {
      if (pages) await sleep(rand(gap));
      const r = await fetchViaTab({ kind: 'out', tpl: tpl.url, cursor });
      // 没有 X 标签页、或登录的不是这个账号：自动读的时候悄悄等下一轮，手动点的要说清楚为什么没读
      if (r.error === 'no_tab') return force && saveOut(account, { status: 'error', message: '没有可用的 X 标签页。打开或刷新一个 x.com 页面后再点「初始化」' });
      if (r.userId && me.userId && r.userId !== me.userId) return force && saveOut(account, { status: 'error', message: `当前登录的 X 账号不是 @${me.handle}，没有读` });
      if (r.status === 429) return saveOut(account, { status: 'error', message: '被 X 限流（429），下一轮再读' });
      if (r.error === 'bad_tpl' || r.status === 400 || r.status === 404) {
        await kvRemove(keys.tpl); // 模板过期了（X 发版换了参数）：过一会儿的下一轮会自己重新取
        await chrome.alarms.create(OUT_ALARM, { when: now() + rand(PACE.outDelayMs) });
        return saveOut(account, { status: 'need_tpl', message: `X 的回复列表接口参数变了（${r.status || '模板无效'}），一两分钟后自动重新取一次再读` });
      }
      if (!r.ok) return saveOut(account, { status: 'error', message: `读我的回复列表失败（${r.error || 'HTTP ' + r.status}）` });

      let p;
      try {
        p = parseMyReplies(r.body, me);
      } catch (e) {
        return saveOut(account, { status: 'error', message: `我的回复列表解析失败：${e instanceof ParseError ? e.message : String(e)}` });
      }
      await putEvents(account, p.events, OUT);
      await saveOut(account, { running: { at: now(), pages: pages + 1 } });
      if (pages === 0 && !resume) topId = p.newestId;
      if (p.oldestTs) reachedTs = p.oldestTs;
      const ended = !p.oldestId || !p.bottomCursor || p.bottomCursor === cursor; // 列表到底了
      if (ended || p.oldestTs <= targetTs || (stopAt && !idGt(p.oldestId, stopAt))) {
        complete = true;
        pages++;
        break;
      }
      cursor = p.bottomCursor;
    }
    const rounds = (resume?.rounds || 0) + 1;
    if (!complete && rounds < PACE.outMaxRounds) {
      // 一轮没读完：记下位置，过一两分钟在新的闹钟事件里接着读。读完之前接续点不动
      await saveOut(account, { status: 'ok', message: null, pages, ...(full ? { coverTs: reachedTs } : {}), resume: { cursor, topId, rounds, full, stopAt } });
      await chrome.alarms.create(OUT_ALARM, { when: now() + rand(PACE.restMs) });
      return;
    }
    // 读完了（读到该停的位置、列表到底，或续读轮数用完到此为止）
    const syncedId = topId && (!prev.syncedId || idGt(topId, prev.syncedId)) ? topId : prev.syncedId || topId;
    const done = { status: 'ok', message: null, pages, syncedId, resume: null, lastAt: now() };
    if (!full) return saveOut(account, done);
    await saveOut(account, { ...done, coverTs: reachedTs, fullFor: settings.windowDays, schema: OUT_SCHEMA, lastFullAt: now(), lastFullDays: settings.windowDays });
  } catch (e) {
    // 没料到的错误也要落到状态里，不然手动点了之后界面上什么都看不到
    await saveOut(account, { status: 'error', message: `读取时出错：${String(e?.message || e)}` });
  } finally {
    if (started) {
      await saveOut(account, { running: null }).catch(() => {});
      await refreshSnapshot(account).catch(() => {}); // 标签里的「我回他几次」跟着更新
    }
    busy = false;
  }
}

// ---------- 清理过期数据 ----------

async function maybePrune(account) {
  const cur = await kvGet(keys.cursor(account), {});
  if (now() - (cur.lastPruneAt || 0) < DAY_MS) return; // 一天最多清一次
  await pruneEvents(account, now() - KEEP_DAYS * DAY_MS);
  await pruneEvents(account, now() - KEEP_DAYS * DAY_MS, OUT);
  await updateCursor(account, (c) => {
    c.lastPruneAt = now();
  });
}

// ---------- 清空 ----------

async function clearData(account) {
  if ((await kvGet(ACTIVE_JOB)) === account) {
    await chrome.alarms.clear(JOB_ALARM);
    await kvRemove(ACTIVE_JOB);
  }
  await clearEvents(account);
  snapDirty.delete(account);
  await serial(() => kvRemove([keys.cursor(account), keys.job(account), keys.snap(account), keys.alert(account)])); // 和改 cursor 的排同一个队
}

// ---------- 事件入口 ----------

async function ensureTick() {
  if (!(await chrome.alarms.get(TICK_ALARM))) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 30 });
}
chrome.runtime.onInstalled.addListener(ensureTick);
chrome.runtime.onStartup.addListener(ensureTick);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === JOB_ALARM) return wakeJob(false);
  if (alarm.name === INC_ALARM) return maybeIncremental();
  if (alarm.name === OUT_ALARM) return syncOut();
  if (alarm.name === TICK_ALARM) {
    const account = await kvGet(keys.current);
    if (account) {
      await maybePrune(account);
      await refreshSnapshot(account); // 时间窗会随时间滑动，定期重算，不发请求
    }
    await wakeJob(false);
    await maybeIncremental();
  }
});

const handlers = {
  // 内容脚本
  async 'xir:hello'(msg) {
    const account = await resolveAccount(msg);
    if (account) {
      // 每次有 X 页面上线都重算一次快照：插件更新后旧快照可能缺新字段（实测：缺 tier 时标签全是默认灰色）
      await refreshSnapshot(account);
      // 「我回别人」是旧版本存的（口径不全）：不等下一次增量，一两分钟后就重新读
      const out = (await kvGet(keys.cursor(account), {})).out;
      if (out?.lastAt && (out.schema || 1) < OUT_SCHEMA && !(await chrome.alarms.get(OUT_ALARM))) await chrome.alarms.create(OUT_ALARM, { when: now() + rand(PACE.outDelayMs) });
      wakeJob(true).then(maybeIncremental);
    }
    return { account };
  },
  async 'xir:tpl'({ url }) {
    if (typeof url !== 'string' || url.length > 30000) return {};
    await kvSet(keys.tpl, { url, at: now() });
    // 之前因为没有模板没读成的，现在马上补读
    const account = await kvGet(keys.current);
    const out = account && (await kvGet(keys.cursor(account), {})).out;
    if (out?.status === 'need_tpl' && !busy) await chrome.alarms.create(OUT_ALARM, { when: now() + 3000 }); // busy：正在读的那一轮自己会用上
    return {};
  },
  // 通知列表里的回复是在谁的帖子下：页面数据看不出来的，内容脚本拿帖子 ID 来问本机数据
  async 'xir:where'({ ids }) {
    const account = await kvGet(keys.current);
    if (!account || !Array.isArray(ids)) return { places: {} };
    return { places: replyPlaces(await getEvents(account), await getEvents(account, OUT), ids.slice(0, 200).map(String)) };
  },
  async 'xir:dom'(msg) {
    if (msg.broken) await kvSet(keys.domWarning, { at: now() });
    else await kvRemove(keys.domWarning);
    return {};
  },

  // 弹窗
  async getState() {
    const accounts = await kvGet(keys.accounts, {});
    const current = await kvGet(keys.current);
    const state = { accounts, current, pendingUserId: await kvGet(keys.pendingUserId), domWarning: await kvGet(keys.domWarning), page: await pingPages() };
    return state;
  },
  async getAccountState({ account }) {
    // 本机两份数据各有多少条、从哪天到哪天
    const span = (rows) => rows.reduce((d, e) => ({ count: d.count + 1, from: Math.min(d.from ?? e.created_at, e.created_at), to: Math.max(d.to ?? e.created_at, e.created_at) }), { count: 0, from: null, to: null });
    const db = { in: span(await getEvents(account)), out: span(await getEvents(account, OUT)) };
    return {
      settings: await getSettings(account),
      cursor: await kvGet(keys.cursor(account), {}),
      job: await kvGet(keys.job(account)),
      alert: await kvGet(keys.alert(account)),
      db,
      tplAt: (await kvGet(keys.tpl))?.at || null, // 什么时候看到过 X 读「回复」列表的请求；没看到过就读不了「我回别人」
    };
  },
  async getBoard({ account }) {
    return board(account); // { rows, people, replies }
  },
  exportAll: async ({ account }) => ({ inbound: await getEvents(account), out: await getEvents(account, OUT) }),
  getReplies: async ({ account, actorId }) => repliesOf(await getEvents(account), actorId, await getSettings(account)),
  startBackfill: ({ account }) => startBackfill(account),
  async syncOutNow({ account }) {
    if (account !== (await kvGet(keys.current))) return { error: '只能读当前登录 X 的账号' };
    if (!(await getSettings(account)).fetchEnabled) return { error: '自动更新已关闭，先打开' };
    // 点了一定要有回应：进度和读不了的原因都显示在设置页「我回别人」那一行。
    // 正在读另一份数据时，syncOut 自己会记下「要重新完整读」并约一两分钟后再来
    const queued = busy;
    syncOut(true).catch((e) => saveOut(account, { status: 'error', message: `读取时出错：${String(e?.message || e)}` })); // 不等待
    return queued ? { error: '正在读另一份数据，一两分钟后会自动开始读「我回别人」，不用再点。' } : { ok: true };
  },
  pauseJob: async ({ account }) => (await pauseJob(account), { ok: true }),
  resumeJob: ({ account }) => resumeJob(account),
  async setSettings({ account, patch }) {
    if ('windowDays' in patch && !WINDOWS.includes(patch.windowDays)) return { error: '统计范围只能是 7 天、15 天或 30 天' };
    const merged = { ...(await getSettings(account)), ...patch };
    const next = { fetchEnabled: merged.fetchEnabled !== false, ...cleanRules(merged) }; // 其余越界的值夹回范围
    await kvSet(keys.settings(account), next);
    if (!next.fetchEnabled) await pauseJob(account, '后台抓取已关闭，任务暂停');
    await refreshSnapshot(account); // 口径或颜色变了，标签立刻跟着变
    return { ok: true };
  },
  clearData: async ({ account }) => (await clearData(account), { ok: true }),
  setManualHandle: ({ handle }) => bindManualHandle(handle),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return false;
  Promise.resolve(h(msg)).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
