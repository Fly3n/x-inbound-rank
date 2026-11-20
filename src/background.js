// 后台调度：账号绑定、回填任务、增量更新、给界面供数。
// 不直接碰 X 的接口与返回结构——请求经 x.com 标签页里的抓取层(fetcher.js)发出，返回交给解析层(parser.js)。

import { mentionsEvidence } from './x/mentions-diagnostics.js';
import { record, readDiagnostics } from './diagnostics.js';
import { parseMentions, parseMyReplies, parseScheduledTweets, ParseError, idGt } from './x/parser.js';
import { replyPlaces, ranking, repliesOf, badgeSnapshot, cleanRules, DAY_MS, WINDOWS, INIT_WINDOWS, KEEP_DAYS, OUT_SCHEMA } from './rank.js';
import { putEvents, getEvents, clearEvents, pruneEvents, kvGet, kvSet, kvRemove, keys, getSettings, OUT } from './db.js';

// 请求节奏。提及：旧接口额度实测 180 次 / 15 分钟、每页 20 条，新接口 1500 次 / 15 分钟、每页 40 条（2026-11-19）。
// 下面的回填节奏约 55 次 / 15 分钟（旧接口额度的三成，负责人用了一周没被限流），每小时约 220 页。
// 新接口额度大得多，暂不提速，每页条数翻倍已经快一倍。X 的行为风控不公开，要再调快先小步试。
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
  slowPages: 20, // 一次要读很多页时（增量读满 40 页后的补读）：按回填的页间隔，一个闹钟事件最多读这么多页（约 4 分钟）
  outDelayMs: [60_000, 120_000], // 我的回复：每轮增量（或回填）结束后隔这么久读，单独一个闹钟事件，不和增量挤在一起
  // 我的回复（「回复」栏的 GraphQL 接口）额度只有 50 次 / 15 分钟（2026-11-19 小号实测），比提及的 180 次小得多，单独定节奏：
  // 一个闹钟事件最多读 5 页，读不完休息 3–5 分钟再接着读，回填平均约每 15 分钟 16 页
  outPages: 5,
  outRestMs: [180_000, 300_000],
  outMaxRounds: 120, // 我的回复：一次读不完时最多接着读几轮（120 × 5 页 = 600 页，和回填单次上限一样），再多就到此为止
};

// 本地数据保存多久见 rank.js 的 KEEP_DAYS（90 天，和最长的榜单范围一致）

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

const temporaryUnavailable = (status) => [502, 503, 504].includes(status);
const serviceWait = (attempt = 0) => Math.min(60, 5 * 2 ** attempt) * 60_000;

async function fetchViaTab(req, trace) {
  const started = now();
  const source = req.kind === 'out' ? 'replies' : req.kind === 'scheduled' ? 'scheduled' : req.tpl ? 'mentions-graphql' : 'mentions-rest';
  let tabsTried = 0;
  const report = async (result, tabId = null) => {
    const durationMs = now() - started;
    const evidence = await mentionsEvidence(result.requestUrl, result.body, result.responseMetadata).catch(() => null);
    await record('request', {
      ...trace, source, tabId, tabsTried, retryResetAt: result.rateResetAt ?? null,
      status: result.status || 0, outcome: result.error || 'response',
      continuation: !!req.cursor, durationMs, ...(evidence ? { evidence } : {}),
    });
    return result;
  };
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  for (const tab of tabs) {
    tabsTried++;
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'xir:fetch', ...req });
      if (r) return report(r, tab.id);
    } catch {
      // 该标签页没有内容脚本（装插件前打开的、或已被休眠），换下一个
    }
  }
  return report({ ok: false, error: 'no_tab' });
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

/** 读提及用哪个接口：记下过 X 页面读通知的请求（模板）就用新接口 'gql'，否则用旧接口 'rest'。两种接口的翻页游标不通用。 */
const mentionsApi = async () => ((await kvGet(keys.tplMentions)) ? 'gql' : 'rest');

/**
 * 抓一页提及并入库。api：'gql' | 'rest'，同一次翻页（一个回填任务、一轮补读）从头到尾用同一个。
 * 返回 {kind:'ok',parsed,added} | {kind:'rate',resetAt} | {kind:'no_tab'} | {kind:'tpl_bad'} | {kind:'error',message}
 * tpl_bad：新接口的模板没了或过期了（已删掉），调用方改用旧接口从最新一页重来。
 */
async function pull(account, cursor, api = 'rest', batch = { read: 0, added: 0 }, trace, inspectOnly = false) {
  if (!(await getSettings(account)).fetchEnabled) return { kind: 'error', message: '后台抓取已关闭' };
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me) return { kind: 'error', message: '账号未绑定' };

  const tpl = api === 'gql' ? await kvGet(keys.tplMentions) : null;
  if (api === 'gql' && !tpl) return { kind: 'tpl_bad' };
  const r = await fetchViaTab({ cursor, tpl: tpl?.url }, trace);
  if (r.error === 'no_tab') return { kind: 'no_tab' };
  if (tpl && (r.error === 'bad_tpl' || r.status === 400 || r.status === 404)) {
    if (!inspectOnly) await kvRemove(keys.tplMentions); // X 发版换了参数：等用户下次打开通知页时记下新的，在那之前用旧接口
    return { kind: 'tpl_bad' };
  }
  if (r.userId && me.userId && r.userId !== me.userId) {
    return { kind: 'error', message: `当前登录的 X 账号不是 @${me.handle}，已停止，避免数据串号` };
  }
  if (temporaryUnavailable(r.status)) return { kind: 'unavailable', status: r.status };
  if (r.status === 429) return { kind: 'rate', resetAt: r.rateResetAt };
  if (r.error === 'no_session' || r.status === 401 || r.status === 403) {
    return { kind: 'error', message: `X 登录状态无效或请求被拒（${r.status || '无会话'}），请确认已登录后重试` };
  }
  if (r.error === 'network') return { kind: 'error', message: `网络请求失败：${r.detail || ''}` };
  if (!r.ok) return { kind: 'error', message: `X 接口返回异常（HTTP ${r.status}），接口可能已变更，需要更新抓取层` };

  let parsed;
  const decisions = [];
  try {
    parsed = parseMentions(r.body, me, (id, reason) => {
      decisions.push({ postId: typeof id === 'string' && /^\d{1,24}$/.test(id) ? id : null, reason });
    });
  } catch (e) {
    await record('parse_failed', { ...trace, source: 'mentions', decisions, category: e instanceof ParseError ? 'unexpected_payload' : 'parser_exception' });
    const why = e instanceof ParseError ? e.message : String(e);
    return { kind: 'error', message: `解析失败：${why}。X 的返回结构可能已变更，需要更新解析层` };
  }

  if (inspectOnly) {
    await record('diagnostic_page', {
      ...trace, source: 'mentions', decisions, entries: parsed.entryIds.length,
      oldestAt: parsed.oldestTs, more: !!parsed.bottomCursor,
    });
    return { kind: 'ok', parsed, decisions };
  }

  const readAt = now();
  let added;
  try {
    added = await putEvents(account, parsed.events);
  } catch {
    await record('save_failed', { ...trace, source: 'mentions', decisions });
    return { kind: 'error', message: '写入本机回复数据失败，请查看诊断日志。' };
  }
  batch.read += parsed.events.length;
  batch.added += added;
  await record('page_saved', { ...trace, source: 'mentions', decisions, oldestAt: parsed.oldestTs, cursorRepeated: !!cursor && cursor === parsed.bottomCursor, entries: parsed.entryIds.length, parsed: parsed.events.length, added, more: !!parsed.bottomCursor });
  await updateCursor(account, (cur) => {
    cur.inLastReadAt = readAt;
    cur.inLastReadCounts = { ...batch };
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
  const outReady = !!o?.lastAt && (o.schema || 1) >= OUT_SCHEMA; // 旧版本存的数据口径不全，宁可先不显示
  const snap = { windowDays: rules.windowDays, show: { rank: rules.showRank, out: rules.showOut, rel: rules.showRel, place: rules.showPlace, schedule: rules.showSchedule }, users: badgeSnapshot(await getEvents(account), rules, now(), await getEvents(account, OUT), outReady) };
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
async function armInc(nextIncAt, scheduleOut = true) {
  await chrome.alarms.create(INC_ALARM, { when: Math.max(nextIncAt, now() + 1000) });
  if (scheduleOut) await chrome.alarms.create(OUT_ALARM, { when: now() + rand(PACE.outDelayMs) });
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
  if (account !== await kvGet(keys.current)) return { error: '只能读当前登录 X 的账号' };
  const settings = await getSettings(account);
  if (!settings.fetchEnabled) return { error: '自动更新已关闭，先在设置里打开' };
  const rangeDays = settings.initDays; // 往回读多远看初始化范围，和榜单范围分开
  const job = {
    status: 'running',
    api: await mentionsApi(), // 这次翻页用哪个接口，中途不换（游标不通用）
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
  const accepted = await serial(async () => {
    const existing = await kvGet(keys.job(account));
    if (existing?.status === 'running' || existing?.status === 'waiting_tab' || existing?.auto && existing.status === 'paused') return;
    await saveJob(account, job);
    await kvSet(ACTIVE_JOB, account);
    return true;
  });
  if (accepted) stepBackfill(); // 不等待，界面立刻返回
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

    const trace = { mode: 'inbound_backfill', run: job.startedAt, page: job.pages + 1 };
    const res = await pull(account, job.cursor, job.api || 'rest', undefined, trace);
    // 请求的这一两秒里，用户可能点了暂停、重新初始化或清空：那就以存储里的为准，这一步的结果不再写回
    const latest = await kvGet(keys.job(account));
    if (!latest || latest.startedAt !== job.startedAt || latest.status !== 'running') return;

    if (res.kind === 'tpl_bad') {
      // 新接口的模板失效：换旧接口从最新一页重来，已入库的靠主键去重
      job.api = 'rest';
      job.cursor = null;
      job.topId = null;
      job.restarted = (job.restarted || 0) + 1;
      if (job.restarted > 3) {
        job.status = 'error';
        job.message = '读取方式反复失效，已停止';
      } else await scheduleJob(job, rand(PACE.pageGapMs));
    } else if (res.kind === 'no_tab') {
      job.status = 'waiting_tab';
      job.message = '没有可用的 X 标签页。打开或刷新一个 x.com 页面后自动继续';
    } else if (res.kind === 'unavailable') {
      job.status = 'paused';
      job.auto = true;
      job.message = `X 暂时不可用（HTTP ${res.status}），稍后从当前页重试`;
      const wait = serviceWait(job.serviceRetries);
      job.serviceRetries = (job.serviceRetries || 0) + 1;
      await scheduleJob(job, wait);
      await record('retry_scheduled', { ...trace, source: 'backfill', status: res.status, waitMs: wait });
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
      if (!job.topId) job.topId = p.newestId; // 本次回填的起点，完成后作为增量的接续点
      job.pages++;
      job.batchPages++;
      job.added += res.added;
      job.message = null;
      job.backoffMs = PACE.backoffStartMs;
      job.serviceRetries = 0;
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
async function incDue(manualAccount) {
  const account = await kvGet(keys.current);
  if (!account || (manualAccount && manualAccount !== account)) return null;
  const settings = await getSettings(account);
  if (!settings.fetchEnabled) return null;
  const cur = await kvGet(keys.cursor(account), {});
  if (!cur.syncedId) return null; // 还没完成过初始化，不自动抓
  const job = await kvGet(keys.job(account));
  if (job && ['running', 'waiting_tab'].includes(job.status)) return null;
  if (job && job.status === 'paused' && job.auto) return null; // 限流退避中
  const t = now();
  if (cur.rateUntil > t) return null;
  if (t < (cur.nextIncAt || 0) && (!manualAccount || cur.incResume || cur.serviceRetries || cur.rateUntil > t)) return null;
  if (!cur.incResume && !cur.serviceRetries && t - (cur.lastAttemptAt || 0) < PACE.incRetryGapMs) return null; // 接着上一轮补读的不受这个限制
  return { account, cur, settings };
}

async function maybeIncremental(manualAccount) {
  // 正在跑的那个动作结束后会自己约下一次；到点没跑上的由兜底闹钟接上
  if (busy || !(await incDue(manualAccount))) return false;
  if (busy) return false;
  busy = true;
  let account = null;
  try {
    const due = await incDue(manualAccount); // 占住之后再确认一遍：上面查的工夫里刚跑完一轮的话，时间已经往后推了
    if (!due) return false;
    account = due.account;
    const { cur } = due;

    // 从最新一页往回读，读到上次的接续点为止：间隔里来了多少就读多少，不丢。
    // 一轮最多 40 页，平时一小时的量远到不了。读满还没接上（比如电脑关了一整天），
    // 记下位置，一两分钟后按回填的慢节奏接着读，直到接上、或者读到保存期限（90 天前，更早的反正要清掉）。
    // 接上之前接续点不动；出错中断时下次重读这一段，靠主键去重。
    const stopAt = cur.syncedId;
    const resume = cur.incResume?.stopAt === stopAt ? cur.incResume : null;
    const floorTs = now() - KEEP_DAYS * DAY_MS;
    const api = resume?.api || (await mentionsApi()); // 接着上一轮读的，游标是哪个接口的就用哪个
    const gap = resume ? PACE.pageGapMs : PACE.incPageGapMs;
    const maxPages = resume ? PACE.slowPages : PACE.incMaxPages;
    let cursor = resume?.cursor || null;
    let topId = resume?.topId || null;
    let caughtUp = false;
    const run = now();
    const batch = { read: 0, added: 0 };
    for (let page = 0; page < maxPages; page++) {
      if (page) await sleep(rand(gap));
      const trace = { mode: manualAccount ? 'inbound_manual' : 'inbound_auto', run, page: page + 1 };
      const res = await pull(account, cursor, api, batch, trace);
      if (res.kind === 'no_tab') return false; // 没有 X 标签页，等下次有页面上线再试
      if (res.kind === 'tpl_bad') {
        // 新接口的模板失效：一两分钟后用旧接口从最新一页重读这一段
        const when = now() + rand(PACE.restMs);
        await updateCursor(account, (c) => {
          delete c.incResume;
          c.nextIncAt = when;
        });
        await chrome.alarms.create(INC_ALARM, { when });
        return { message: '新版读取方式失效，已安排用旧接口重试。' };
      }
      await updateCursor(account, (c) => {
        c.lastAttemptAt = now();
      });
      if (res.kind === 'unavailable') {
        const wait = serviceWait(cur.serviceRetries);
        const when = now() + wait;
        await updateCursor(account, (c) => {
          c.nextIncAt = when;
          c.serviceRetries = (c.serviceRetries || 0) + 1;
        });
        await chrome.alarms.create(INC_ALARM, { when });
        await setAlert(account, `X 暂时不可用（HTTP ${res.status}），稍后重试`);
        await record('retry_scheduled', { ...trace, source: 'incremental', status: res.status, waitMs: wait });
        return { message: `别人回我读取失败（HTTP ${res.status}），已安排重试。` };
      }
      if (res.kind === 'rate') {
        await armInc(await updateCursor(account, (c) => {
          const next = planNextInc(c, now());
          c.rateUntil = Math.max(next, res.resetAt || 0);
          c.nextIncAt = c.rateUntil;
          return c.nextIncAt;
        }));
        await setAlert(account, '增量更新被 X 限流（429），本轮已放弃，下个周期再试');
        return { message: '别人回我遇到限流，已退避。' };
      }
      if (res.kind === 'error') {
        await setAlert(account, res.message);
        return { error: res.message };
      }
      const p = res.parsed;
      if (page === 0 && !resume) topId = p.newestId;
      const stopReason = !p.entryIds.length ? 'empty_page'
        : !idGt(p.oldestId, stopAt) ? 'reached_checkpoint'
        : !p.bottomCursor ? 'no_next_page'
        : p.oldestTs <= floorTs ? 'retention_boundary' : null;
      if (stopReason) {
        await record('pagination_stop', { ...trace, source: 'mentions', reason: stopReason, checkpoint: stopAt });
        caughtUp = true;
        break;
      }
      cursor = p.bottomCursor;
    }
    if (!caughtUp) {
      const when = now() + rand(PACE.restMs);
      await updateCursor(account, (c) => {
        if (!c.syncedId) return; // 读的过程中被清空了
        c.incResume = { cursor, topId, stopAt, api };
        c.nextIncAt = when;
      });
      await chrome.alarms.create(INC_ALARM, { when });
      return { message: '别人回我已读完一批，等待续读；随后安排我回别人。' };
    }
    const next = await updateCursor(account, (c) => {
      // 读的过程中被清空了（没有 syncedId）就不补：清空后要重新初始化才自动抓
      if (topId && c.syncedId && idGt(topId, c.syncedId)) c.syncedId = topId;
      delete c.incResume;
      delete c.serviceRetries;
      if (manualAccount && c.nextIncAt > now()) {
        c.lastIncrementalAt = now();
        return c.nextIncAt;
      }
      return planNextInc(c, now());
    });
    await armInc(next, !manualAccount);
    return { ok: true };
  } finally {
    if (account) await flushSnapshot(account, true).catch(() => {});
    busy = false;
  }
}

// ---------- 我在别人帖子下的回复 ----------
// 数据来自我自己主页「回复」栏的列表（里面混着原创帖和转发，解析时只留回复）。
// 状态放在 cursor.out：{ status: 'ok'|'need_tpl'|'error', message, syncedId, coverTs, lastAt, pages }
//   running：{ at, pages } 正在读、已读几页（读完清掉）；syncedId：上次读到的最新一条；fullFor：最近一次完整读覆盖的初始化范围（天），手动点「初始化」时清成 0 表示要完整读；
//   resume：完整读被页数上限截断时的续读位置；lastAt：最近一次读完的时间；lastFullAt / lastFullDays：最近一次完整读（初始化）完成的时间和范围。

const saveOut = (account, patch) =>
  updateCursor(account, (cur) => {
    cur.out = { ...cur.out, ...patch };
  });

/** 读取已排队的初始化，或更新已经初始化过的账号。 */
async function syncOut(expectedAccount) {
  const account = await kvGet(keys.current);
  if (!account || (expectedAccount && account !== expectedAccount)) return;
  const settings = await getSettings(account);
  if (!settings.fetchEnabled) return;
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me) return;
  if (busy) {
    // 正在读另一份数据：稍后继续。
    await chrome.alarms.create(OUT_ALARM, { when: now() + rand(PACE.outDelayMs) });
    return;
  }
  busy = true;
  let started = false;
  try {
    const cur = await kvGet(keys.cursor(account), {});

    const prev = cur.out || {};
    const nextAt = Math.max(prev.resume?.nextAt || 0, prev.retryAt || 0);
    if (nextAt > now()) {
      await chrome.alarms.create(OUT_ALARM, { when: nextAt });
      return;
    }
    const initDays = prev.initDays ?? settings.initDays;
    const targetTs = prev.targetTs ?? now() - initDays * DAY_MS;
    // 第一次必须手动点「初始化」（点的时候正好在读另一份数据，会先记下 fullFor: 0，过一会儿由闹钟来读）
    if (!prev.lastAt && !prev.syncedId && prev.fullFor !== 0) return;
    // 完整读：手动初始化（fullFor 被清成 0）、或本机数据是旧版本存的——读到初始化范围的起点。否则只读到上次的位置。
    const full = !prev.syncedId || prev.fullFor === 0 || (prev.schema || 1) < OUT_SCHEMA;
    // 上一轮被页数上限截断、留了续读位置：同一种读法就接着读；读法变了（比如范围调大了）就从头来
    const resume = prev.resume && (prev.resume.full ?? true) === full ? prev.resume : null;
    const stopAt = full ? null : resume?.stopAt || prev.syncedId;
    // 一次要读很多页（完整读、或接着上一轮读）时按回填的节奏，慢一些；平时的增量一般就一两页，按增量的节奏
    const slow = full || !!resume;
    const gap = slow ? PACE.pageGapMs : PACE.incPageGapMs;
    const maxPages = PACE.outPages; // 这个接口额度小，不管哪种读法一轮都只读几页

    // running：正在读，读到第几页。弹窗据此显示进度；不管怎么结束，finally 里都会清掉
    started = true;
    await saveOut(account, { status: 'reading', retryAt: null, message: null, running: { at: now(), pages: 0 } });
    const tpl = await kvGet(keys.tpl);
    if (!tpl) return saveOut(account, { status: 'need_tpl', message: '打开 X 的「回复」栏一次，插件会自动继续。' });
    let cursor = resume?.cursor || null;
    let topId = resume?.topId || null;
    let reachedTs = null;
    let complete = false; // 读到了该停的位置（不是被页数上限截断）
    let pages = 0;
    const run = now();
    const batch = { read: 0, added: 0 };
    for (; pages < maxPages; pages++) {
      if (pages) await sleep(rand(gap));
      if (!(await getSettings(account)).fetchEnabled) return saveOut(account, { status: 'error', message: '自动更新已关闭，读取已暂停。' });
      const trace = { mode: full ? 'outbound_backfill' : expectedAccount ? 'outbound_manual' : 'outbound_auto', run, page: pages + 1 };
      const r = await fetchViaTab({ kind: 'out', tpl: tpl.url, cursor }, trace);
      // 没有 X 标签页、或登录的不是这个账号：自动读的时候悄悄等下一轮，手动点的要说清楚为什么没读
      if (r.error === 'no_tab') return saveOut(account, { status: 'waiting_tab', message: '打开或刷新一个 X 页面后自动继续。' });
      if (r.userId && me.userId && r.userId !== me.userId) return saveOut(account, { status: 'error', message: `当前登录的 X 账号不是 @${me.handle}，没有读` });
      if (temporaryUnavailable(r.status)) {
        const wait = serviceWait(prev.serviceRetries);
        const retryAt = now() + wait;
        await saveOut(account, { status: 'queued', retryAt, resume: { cursor, topId, rounds: resume?.rounds || 0, full, stopAt }, serviceRetries: (prev.serviceRetries || 0) + 1,
          message: `X 暂时不可用（HTTP ${r.status}），稍后继续读取。` });
        await chrome.alarms.create(OUT_ALARM, { when: retryAt });
        await record('retry_scheduled', { ...trace, source: 'replies', status: r.status, waitMs: wait });
        return;
      }
      if (r.status === 429) return saveOut(account, { status: 'error', message: 'X 暂时限制了读取（429），请稍后再试。' });
      if (r.error === 'bad_tpl' || r.status === 400 || r.status === 404) {
        await kvRemove(keys.tpl); // 模板过期了（X 发版换了参数）：过一会儿的下一轮会自己重新取
        return saveOut(account, { status: 'need_tpl', resume: null, message: 'X 的读取方式已更新。打开「回复」页后自动继续。' });
      }
      if (!r.ok) return saveOut(account, { status: 'error', message: `读我的回复列表失败（${r.error || 'HTTP ' + r.status}）` });

      let p;
      try {
        p = parseMyReplies(r.body, me);
      } catch (e) {
        await record('parse_failed', { ...trace, source: 'replies', category: e instanceof ParseError ? 'unexpected_payload' : 'parser_exception' });
        return saveOut(account, { status: 'error', message: `我的回复列表解析失败：${e instanceof ParseError ? e.message : String(e)}` });
      }
      const readAt = now();
      const added = await putEvents(account, p.events, OUT);
      batch.read += p.events.length;
      batch.added += added;
      await record('page_saved', { ...trace, source: 'replies', posts: p.events.map(({ id, own, created_at }) => ({ postId: id, own: !!own, createdAt: created_at })), oldestAt: p.oldestTs, cursorRepeated: !!cursor && cursor === p.bottomCursor, parsed: p.events.length, added, more: !!p.bottomCursor });
      await saveOut(account, { lastReadAt: readAt, lastReadCounts: { ...batch }, running: { at: now(), pages: pages + 1 } });
      if (!topId) topId = p.newestId;
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
      // 一轮没读完：记下位置，休息一批的间隔后在新的闹钟事件里接着读。读完之前接续点不动
      const nextAt = now() + rand(PACE.outRestMs);
      await saveOut(account, { status: 'ok', serviceRetries: 0, message: null, pages, ...(full ? { coverTs: reachedTs } : {}), resume: { cursor, topId, rounds, full, stopAt, nextAt } });
      await chrome.alarms.create(OUT_ALARM, { when: nextAt });
      return;
    }
    // 读完了（读到该停的位置、列表到底，或续读轮数用完到此为止）
    const syncedId = topId && (!prev.syncedId || idGt(topId, prev.syncedId)) ? topId : prev.syncedId || topId;
    const done = { status: 'ok', serviceRetries: 0, message: null, pages, syncedId, resume: null, lastAt: now() };
    if (!full) return saveOut(account, done);
    await saveOut(account, { ...done, coverTs: reachedTs, fullFor: initDays, schema: OUT_SCHEMA, lastFullAt: now(), lastFullDays: initDays, initDays: null, targetTs: null });
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
  const removed = (await pruneEvents(account, now() - KEEP_DAYS * DAY_MS)) + (await pruneEvents(account, now() - KEEP_DAYS * DAY_MS, OUT));
  await updateCursor(account, (c) => {
    c.lastPruneAt = now();
    if (removed) c.prunedAt = now(); // 清掉过到期的数据：之后弹窗不再挂红字提示，改成一行小字
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
  await serial(() => kvRemove([keys.cursor(account), keys.job(account), keys.snap(account), keys.alert(account), keys.scheduled(account), keys.lastPostAt(account)])); // 和改 cursor 的排同一个队
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
    await readDiagnostics().catch(() => {});
    const account = await kvGet(keys.current);
    if (account) {
      await maybePrune(account);
      await refreshSnapshot(account); // 时间窗会随时间滑动，定期重算，不发请求
    }
    await wakeJob(false);
    await maybeIncremental();
  }
});

async function diagnoseMentions({ account, from, to, postId, source }) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > DAY_MS ||
      (postId && !/^\d{1,24}$/.test(postId))) {
    return { error: '请选择一个不超过 24 小时的时间窗，帖子编号只填数字。' };
  }
  if (!account || account !== await kvGet(keys.current)) return { error: '请切换到当前登录的 X 账号。' };
  const state = await kvGet(keys.cursor(account), {});
  const job = await kvGet(keys.job(account));
  if (busy || (state.rateUntil || 0) > now() || state.serviceRetries && state.nextIncAt > now() ||
      job?.status === 'running' || job?.status === 'paused' && job.auto) {
    return { error: '正在读取或处于退避期，请稍后回查。' };
  }
  busy = true;
  const run = now();
  try {
    const api = source === 'rest' ? 'rest' : await mentionsApi();
    await record('diagnostic_start', { source: 'mentions', run, api, from, to, postId: postId || null });
    let cursor = null;
    let pages = 0;
    let matches = 0;
    let reason = 'page_limit';
    let target = null;
    for (let page = 1; page <= PACE.batchPages; page++) {
      if (page > 1) await sleep(rand(PACE.pageGapMs));
      if (account !== await kvGet(keys.current)) { reason = 'account_changed'; break; }
      pages = page;
      const result = await pull(account, cursor, api, undefined, { mode: 'inbound_diagnostic', run, page }, true);
      if (result.kind !== 'ok') {
        reason = result.kind === 'unavailable' || result.kind === 'rate' ? String(result.status || 429) : result.kind;
        if (result.kind === 'rate' || result.kind === 'unavailable') {
          await updateCursor(account, (c) => {
            c.rateUntil = Math.max(c.rateUntil || 0, result.resetAt || 0, now() + PACE.backoffStartMs);
          });
        }
        break;
      }
      const { parsed, decisions } = result;
      matches += parsed.events.filter((event) => event.created_at >= from && event.created_at <= to).length;
      target = postId ? decisions.find((item) => item.postId === postId) : null;
      if (target) { reason = 'post_found'; break; }
      // 提及列表可能混排，旧帖出现在第一页不能证明后续页没有目标。
      if (!parsed.bottomCursor) { reason = 'end_of_feed'; break; }
      if (parsed.bottomCursor === cursor) { reason = 'repeated_cursor'; break; }
      cursor = parsed.bottomCursor;
    }
    const stored = postId ? (await getEvents(account)).some((event) => event.id === postId) : null;
    await record('diagnostic_end', { source: 'mentions', run, pages, matches, reason, target, stored });
    return { pages, matches, reason, target, stored };
  } finally {
    busy = false;
  }
}

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
      if (out?.status === 'waiting_tab') await chrome.alarms.create(OUT_ALARM, { when: now() + rand(PACE.outDelayMs) });
      wakeJob(true).then(maybeIncremental);
    }
    return { account };
  },
  async 'xir:tpl'({ url, kind }) {
    if (typeof url !== 'string' || url.length > 30000) return {};
    if (kind === 'mentions') {
      await kvSet(keys.tplMentions, { url, at: now() }); // 下一次翻页起改用新接口（正在翻的那次不换，游标不通用）
      return {};
    }
    if (kind === 'scheduled') {
      await kvSet(keys.tplScheduled, { url, at: now() });
      return {};
    }
    await kvSet(keys.tpl, { url, at: now() });
    // 之前因为没有模板没读成的，现在马上补读
    const account = await kvGet(keys.current);
    const out = account && (await kvGet(keys.cursor(account), {})).out;
    if (out?.status === 'need_tpl') await chrome.alarms.create(OUT_ALARM, { when: now() + 3000 }); // busy：正在读的那一轮自己会用上
    return {};
  },
  async 'xir:mentions:evidence'({ url, status, metadata, text }, sender) {
    const tab = sender?.tab;
    if (!Number.isInteger(tab?.id) || !/^https:\/\/(?:x|twitter)\.com\//.test(tab.url || '') ||
        typeof text !== 'string' || text.length > 8_000_000) return {};
    let body;
    try { body = JSON.parse(text); } catch { /* 保留请求与 HTTP 信息 */ }
    const evidence = await mentionsEvidence(url, body, metadata).catch(() => null);
    if (evidence?.request.timeline === 'Mentions') {
      await record('web_mentions_response', {
        source: 'mentions-graphql', tabId: tab.id,
        status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0, evidence,
      });
    }
    return {};
  },
  async 'xir:scheduled:tap'({ text }) {
    const account = await kvGet(keys.current);
    if (!account || typeof text !== 'string') return {};
    try {
      const items = parseScheduledTweets(JSON.parse(text));
      const syncedAt = now();
      await kvSet(keys.scheduled(account), { items, syncedAt, error: null });
      await record('scheduled_sync', { source: 'scheduled', mode: 'tap', outcome: 'ok', count: items.length, scheduledTimes: items.map(({ executeAt }) => executeAt) });
      return { ok: true, items, syncedAt };
    } catch (e) {
      await record('parse_failed', { source: 'scheduled', mode: 'tap', category: e instanceof ParseError ? 'unexpected_payload' : 'parser_exception' });
      return {};
    }
  },
  async 'xir:postEvent'({ op, at }) {
    const account = await kvGet(keys.current);
    if (!account) return {};
    const ts = Number.isFinite(at) ? at : now();
    if (op === 'CreateTweet') {
      await kvSet(keys.lastPostAt(account), ts);
    }
    if (op === 'CreateScheduledTweet' || op === 'DeleteScheduledTweet') {
      const cached = await kvGet(keys.scheduled(account));
      if (cached) await kvSet(keys.scheduled(account), { ...cached, syncedAt: 0 }); // 下次打开排期弹窗立刻拉最新
    }
    return {};
  },
  async 'xir:scheduled:sync'({ force } = {}) {
    const account = await kvGet(keys.current);
    if (!account) return { items: [], syncedAt: 0, lastPostAt: 0, status: 'error', message: '未识别到当前 X 账号' };
    const cached = (await kvGet(keys.scheduled(account))) || { items: [], syncedAt: 0, error: null };
    const lastPostAt = (await kvGet(keys.lastPostAt(account))) || 0;
    const tpl = await kvGet(keys.tplScheduled);
    if (!tpl) {
      await record('scheduled_sync', { source: 'scheduled', mode: force ? 'manual' : 'auto', outcome: 'need_tpl' });
      return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'need_tpl', message: '点一下下方「已排期帖子」完成首次同步' };
    }
    // 30 秒防抖：连续开关排期弹窗不重复发请求
    if (!force && cached.syncedAt && now() - cached.syncedAt < 30_000) {
      return { items: cached.items || [], syncedAt: cached.syncedAt, lastPostAt, status: 'ok' };
    }
    const r = await fetchViaTab({ kind: 'scheduled', tpl: tpl.url }, { mode: force ? 'scheduled_manual' : 'scheduled_auto', run: now(), page: 1 });
    if (r.error === 'no_tab') return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: '未连接到 X 页面，已显示上次缓存' };
    if (r.error === 'bad_tpl' || r.status === 400 || r.status === 404) {
      await kvRemove(keys.tplScheduled);
      await record('scheduled_sync', { source: 'scheduled', mode: force ? 'manual' : 'auto', outcome: 'tpl_expired', status: r.status || 0 });
      return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'need_tpl', message: '接口参数已更新，请点一下「已排期帖子」重新连接' };
    }
    if (r.status === 429) return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: '暂时被 X 限流（429），已显示上次缓存' };
    if (!r.ok) return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: `同步排期失败（${r.error || 'HTTP ' + r.status}），已显示缓存` };
    try {
      const items = parseScheduledTweets(r.body);
      const syncedAt = now();
      await kvSet(keys.scheduled(account), { items, syncedAt, error: null });
      await record('scheduled_sync', { source: 'scheduled', mode: force ? 'manual' : 'auto', outcome: 'ok', count: items.length, scheduledTimes: items.map(({ executeAt }) => executeAt) });
      return { items, syncedAt, lastPostAt, status: 'ok' };
    } catch (e) {
      await record('parse_failed', { source: 'scheduled', mode: force ? 'manual' : 'auto', category: e instanceof ParseError ? 'unexpected_payload' : 'parser_exception' });
      const why = e instanceof ParseError ? e.message : String(e);
      return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: `排期解析失败：${why}` };
    }
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
  getDiagnostics: () => readDiagnostics(),
  diagnoseMentions,
  async updateNowWithReceipt({ account }) {
    const startedAt = now();
    if (!account || !await incDue(account) || busy) {
      return { error: '当前无法更新。请先完成「别人回我」初始化，并等待正在运行的读取、最短更新间隔或退避结束。' };
    }
    const result = await maybeIncremental(account);
    if (result === false) return { error: '读取暂不可用，请确认已有登录的 X 页面并稍后再试。' };
    if (!result?.ok) return result;

    const before = (await kvGet(keys.cursor(account), {})).out;
    if (!before?.lastAt && !before?.syncedId) {
      return { message: '别人回我已读完；请先初始化「我回别人」。' };
    }
    await syncOut(account);
    const after = (await kvGet(keys.cursor(account), {})).out;
    if (after?.message) return { message: `别人回我已读完；我回别人：${after.message}` };
    if (after?.resume) return { message: '别人回我已读完；我回别人还有数据等待续读。' };
    if (after?.lastReadAt >= startedAt && after.lastReadAt > (before.lastReadAt || 0)) {
      const { inLastReadAt } = await kvGet(keys.cursor(account), {});
      if (inLastReadAt >= startedAt) return { ok: true, readAt: { inbound: inLastReadAt, outbound: after.lastReadAt } };
    }
    return { message: '别人回我已读完；我回别人暂未读取，请查看数据状态。' };
  },
  async getState() {
    const accounts = await kvGet(keys.accounts, {});
    const current = await kvGet(keys.current);
    const state = { accounts, current, pendingUserId: await kvGet(keys.pendingUserId), domWarning: await kvGet(keys.domWarning), page: await pingPages() };
    return state;
  },
  async getAccountState({ account }) {
    // 本机两份数据各有多少条、从哪天到哪天
    const span = (rows) => rows.reduce((d, e) => ({ count: d.count + 1, from: Math.min(d.from ?? e.created_at, e.created_at), to: Math.max(d.to ?? e.created_at, e.created_at) }), { count: 0, from: null, to: null });
    const db = { in: span(await getEvents(account)), out: span((await getEvents(account, OUT)).filter((o) => !o.own)) }; // own：我在自己帖子下的回复，只用来认对话，不算这份数据
    return {
      settings: await getSettings(account),
      cursor: await kvGet(keys.cursor(account), {}),
      job: await kvGet(keys.job(account)),
      alert: await kvGet(keys.alert(account)),
      db,
      tplAt: (await kvGet(keys.tpl))?.at || null, // 什么时候看到过 X 读「回复」列表的请求；没看到过就读不了「我回别人」
      mentionsApi: await mentionsApi(), // 别人回我现在用哪个接口：'gql' 新 / 'rest' 旧
    };
  },
  async getBoard({ account }) {
    return board(account); // { rows, people, replies }
  },
  exportAll: async ({ account }) => ({ inbound: await getEvents(account), out: await getEvents(account, OUT) }),
  getReplies: async ({ account, actorId }) => repliesOf(await getEvents(account), actorId, await getSettings(account), now(), 50, await getEvents(account, OUT)),
  startBackfill: ({ account }) => startBackfill(account),
  async syncOutNow({ account }) {
    if (account !== (await kvGet(keys.current))) return { error: '只能读当前登录 X 的账号' };
    if (!(await getSettings(account)).fetchEnabled) return { error: '自动更新已关闭，先打开' };
    const { initDays } = await getSettings(account);
    const queued = await updateCursor(account, (cur) => {
      const out = cur.out || {};
      if (out.running && now() - out.running.at < 120_000) return;
      if (['queued', 'need_tpl', 'waiting_tab'].includes(out.status) || out.resume && out.status !== 'error') return;
      cur.out = { ...out, status: 'queued', message: null, fullFor: 0, resume: null, initDays, targetTs: now() - initDays * DAY_MS };
      return true;
    });
    if (!queued) return { ok: true };
    await chrome.alarms.create(OUT_ALARM, { when: now() + rand(PACE.outDelayMs) });
    syncOut().catch((e) => saveOut(account, { status: 'error', message: `读取时出错：${String(e?.message || e)}` }));
    return { ok: true };
  },
  pauseJob: async ({ account }) => (await pauseJob(account), { ok: true }),
  resumeJob: ({ account }) => resumeJob(account),
  async setSettings({ account, patch }) {
    if ('windowDays' in patch && !WINDOWS.includes(patch.windowDays)) return { error: '榜单范围只能是 7 天、15 天、30 天、2 个月或 3 个月' };
    if ('initDays' in patch && !INIT_WINDOWS.includes(patch.initDays)) return { error: '初始化范围只能是 7 天、15 天或 30 天' };
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
  const logged = ['startBackfill', 'syncOutNow', 'pauseJob', 'resumeJob', 'clearData', 'updateNowWithReceipt'].includes(msg.type);
  Promise.resolve().then(() => h(msg, _sender)).then(async (result) => {
    if (logged) await record(msg.type, { outcome: result?.error ? 'rejected' : 'accepted' });
    sendResponse(result);
  }, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
