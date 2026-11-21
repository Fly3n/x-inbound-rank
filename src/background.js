// 后台调度：账号绑定、回填任务、增量更新、给界面供数。
// 不直接碰 X 的接口与返回结构——请求经 x.com 标签页里的抓取层(fetcher.js)发出，返回交给解析层(parser.js)。

import { mentionsEvidence } from './x/mentions-diagnostics.js';
import { record, readDiagnostics } from './diagnostics.js';
import { parseMentions, parseMyReplies, parseScheduledTweets, ParseError, idGt } from './x/parser.js';
import { replyPlaces, ranking, repliesOf, badgeSnapshot, cleanRules, DAY_MS, WINDOWS, INIT_WINDOWS, KEEP_DAYS, OUT_SCHEMA } from './rank.js';
import { putEvents, getEvents, clearEvents, pruneEvents, kvGet, kvSet, kvRemove, keys, getSettings, OUT } from './db.js';
import { queueBridgePush } from './bridge.js';

// 请求节奏。提及：旧接口额度实测 180 次 / 15 分钟、每页 20 条，新接口 1500 次 / 15 分钟、每页 40 条（2026-11-19）。
// 只保留远低于额度的节奏；真实账号还要经过行为风控，不能拿「没触发 429」当作安全。
const PACE = {
  pageGapMs: [25_000, 45_000], // 回填：两页之间的随机间隔
  batchPages: 10, // 回填：每批页数
  batchRestMs: [180_000, 300_000], // 回填：批与批之间的随机休息
  maxPagesPerRun: 600, // 回填：单次运行的页数上限，到了就暂停等用户确认
  backoffStartMs: 15 * 60_000, // 限流后首次退避，之后每次翻倍
  backoffMaxMs: 4 * 60 * 60_000,
  // 同一个后台事件里连续读多页时，页间等待要短于 Chrome 约 30 秒的空闲回收线。
  incPageGapMs: [15_000, 27_000], // 增量、回填补读、出站和诊断的页间间隔
  incPagesPerEvent: 6, // 增量：每个后台事件最多六页，读完休息后自动续，避免单次事件过长
  incRetryGapMs: 10 * 60_000, // 增量：两次尝试的最小间隔（接着上一轮补读时不受限）
  incOverlapMs: 6 * 60 * 60_000, // 增量：接续点之后再回看 6 小时，接住 X 短时迟到放出的回复
  restMs: [180_000, 300_000], // 一次读不完、分几轮读时，轮与轮之间的休息
  manualCooldownMs: 10 * 60_000, // 手动更新：十分钟内不重复向 X 发请求
  // 我的回复（「回复」栏的 GraphQL 接口）额度只有 50 次 / 15 分钟（2026-11-19 小号实测），比提及的 180 次小得多，单独定节奏：
  // 一个闹钟事件最多读 5 页，读不完休息 3–5 分钟再接着读，回填平均约每 15 分钟 16 页
  outPages: 5,
  outRestMs: [180_000, 300_000],
  outMaxRounds: 120, // 我的回复：一次读不完时最多接着读几轮（120 × 5 页 = 600 页，和回填单次上限一样），再多就到此为止
  diagnosePages: 5, // 手动回查默认最多五页，避免诊断变成大流量任务
};

// 本地数据保存多久见 rank.js 的 KEEP_DAYS（90 天，和最长的榜单范围一致）

const TICK_ALARM = 'tick';
const STALE_TABS_ALARM = 'staleTabs';
const JOB_ALARM = 'job';
const INC_ALARM = 'inc';
const OUT_ALARM = 'out';
const alarmFor = (kind, account) => `${kind}:${account}`;
const X_TABS = { url: ['https://x.com/*', 'https://twitter.com/*'] };
const STALE_TABS_RETRY = 'staleTabsRetries';
const enabledAccounts = async () => Object.entries(await kvGet(keys.accounts, {})).filter(([, a]) => a.enabled && a.userId);
const enabledAccount = async (account) => account && (await kvGet(keys.accounts, {}))[account]?.enabled === true;

const rand = ([a, b]) => a + Math.floor(Math.random() * (b - a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
// 模拟真人：自动任务只在本地时间 08:00–24:00 发生，凌晨不跑。
const ACTIVE_START_HOUR = 8;
const ACTIVE_LAST_START_MIN = 23 * 60 + 30;
const inActiveHours = (ts = now()) => new Date(ts).getHours() >= ACTIVE_START_HOUR;
// 日常自动读取只放在上午，模拟起床后集中看一次；错过就等下一个上午，换成手动更新。
const AUTO_MORNING_START_MIN = 8 * 60;
const AUTO_MORNING_END_MIN = 11 * 60 + 30;
const inAutoMorning = (ts = now()) => {
  const d = new Date(ts);
  const minute = d.getHours() * 60 + d.getMinutes();
  return minute >= AUTO_MORNING_START_MIN && minute < AUTO_MORNING_END_MIN;
};
/** 成功读完一轮后的下一次日常更新：下一个上午随机一次，不卡整点。 */
function nextAutoMorning(ts = now()) {
  const d = new Date(ts);
  const today = new Date(d);
  today.setHours(8, 0, 0, 0);
  if (ts < today.getTime()) return today.getTime() + rand([0, 150 * 60_000]);
  const tomorrow = new Date(d);
  tomorrow.setDate(d.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  return tomorrow.getTime() + rand([0, 150 * 60_000]);
}
function nextActiveAt(ts = now()) {
  if (inActiveHours(ts)) {
    const d = new Date(ts);
    if (d.getHours() * 60 + d.getMinutes() <= ACTIVE_LAST_START_MIN) return ts;
  }
  const d = new Date(ts);
  d.setHours(ACTIVE_START_HOUR, 0, 0, 0);
  if (d.getTime() <= ts) d.setDate(d.getDate() + 1);
  return d.getTime() + rand([0, 30 * 60_000]);
}

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

let migration;
function migrateAccounts() {
  return migration ??= serial(async () => {
    if (await kvGet('accountIsolationV1')) return;
    const accounts = await kvGet(keys.accounts, {});
    const data = await chrome.storage.local.get(null);
    const frequencies = new Map();
    for (const { userId } of Object.values(accounts)) {
      if (userId) frequencies.set(userId, (frequencies.get(userId) || 0) + 1);
    }
    const next = {};
    for (const [key, account] of Object.entries(accounts)) {
      const verified = /^\d+$/.test(account.userId || '') && frequencies.get(account.userId) === 1;
      const cur = data[keys.cursor(key)];
      const enabled = verified && !!(cur?.syncedId || cur?.lastBackfill || cur?.out?.lastAt || cur?.out?.syncedId ||
        cur?.out?.fullFor === 0 || data[keys.job(key)]?.startedAt);
      next[key] = { ...account, enabled, activation: enabled ? now() : null };
      if (enabled) {
        // 旧回复模板只提供接口参数，实际用户 ID 在发请求时会替换。旧档期缓存无法确认来源，重新同步。
        if (data.current === key && data['tpl:replies'] && !data[keys.tpl(key)]) {
          await kvSet(keys.tpl(key), data['tpl:replies']);
        }
      }
      await kvRemove([keys.scheduled(key), keys.lastPostAt(key)]);
    }
    await chrome.storage.local.set({ [keys.accounts]: next, accountIsolationV1: true });
    await kvRemove(['current', 'pendingUserId', 'activeJobAccount', 'tpl:replies', 'tpl:mentions', 'tpl:scheduled', 'domWarning']);
    await Promise.all([JOB_ALARM, INC_ALARM, OUT_ALARM].map((kind) => chrome.alarms.clear(kind)));
  }).catch((e) => {
    migration = null;
    throw e;
  });
}

function accountForUser(accounts, userId) {
  if (!/^\d+$/.test(userId || '')) return null;
  if (accounts[`uid-${userId}`]?.userId === userId) return `uid-${userId}`;
  const matches = Object.keys(accounts).filter((key) => accounts[key].userId === userId);
  return matches.length === 1 ? matches[0] : null;
}

async function pingTab(tab) {
  try {
    const page = await chrome.tabs.sendMessage(tab.id, { type: 'xir:ping' });
    if (page?.ok && page.version === chrome.runtime.getManifest().version) return page;
  } catch {
    // 页面关闭、休眠或还没加载这版插件。
  }
  return null;
}

/**
 * 扩展重载/更新后，已打开页面里的旧内容脚本不会自己换新。
 * 只刷新连不上或版本对不上的 X 标签页；正常页面不动。
 */
const isXTabUrl = (url) => /^https:\/\/(?:x|twitter)\.com\//.test(url || '');

async function reloadStaleXirTabs() {
  if (!chrome.tabs?.query || !chrome.tabs?.get || !chrome.tabs?.reload) return { reloaded: 0, pending: 0 };
  if (!inActiveHours()) {
    await chrome.alarms.create(STALE_TABS_ALARM, { when: nextActiveAt() });
    return { reloaded: 0, pending: 0 };
  }
  const tabs = await chrome.tabs.query(X_TABS).catch(() => []);
  let reloaded = 0;
  let pending = 0;
  for (const tab of tabs) {
    if (!tab?.id || tab.discarded) continue;
    if (tab.status === 'loading') {
      pending++;
      continue;
    }
    if (await pingTab(tab)) continue;
    // 失败可能刚好碰上页面开始导航。刷新前再查一次，避免打断已经换到新文档的页面。
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current || current.discarded || !isXTabUrl(current.url)) continue;
    if (current.status === 'loading') {
      pending++;
      continue;
    }
    if (await pingTab(current)) continue;
    try {
      await chrome.tabs.reload(tab.id);
      reloaded++;
    } catch {
      pending++; // 标签页可能刚关闭或暂时拒绝刷新；留下一次补查。
    }
  }
  return { reloaded, pending };
}

let tabRefresh = null;
function refreshStaleTabs({ retry = false } = {}) {
  if (tabRefresh) return tabRefresh;
  tabRefresh = reloadStaleXirTabs()
    .then(async (result) => {
      if (!result.pending) {
        await chrome.storage.session?.remove?.(STALE_TABS_RETRY);
      } else if (retry) {
        const saved = await chrome.storage.session?.get?.(STALE_TABS_RETRY);
        const attempts = Number(saved?.[STALE_TABS_RETRY]) || 0;
        if (attempts < 2) {
          await chrome.storage.session?.set?.({ [STALE_TABS_RETRY]: attempts + 1 });
          await chrome.alarms.create(STALE_TABS_ALARM, { when: now() + 30_000 });
        }
      }
      return result;
    })
    .catch(() => ({ reloaded: 0, pending: 0 }))
    .finally(() => { tabRefresh = null; });
  return tabRefresh;
}

async function senderAccount(msg, sender) {
  if (!Number.isInteger(sender?.tab?.id) || (sender.frameId ?? 0) !== 0 ||
      !/^https:\/\/(?:x|twitter)\.com\//.test(sender.url || sender.tab.url || '')) return null;
  const page = await pingTab(sender.tab);
  if (!msg.userId || msg.userId !== page?.userId) return null;
  const accounts = await kvGet(keys.accounts, {});
  const account = accountForUser(accounts, page.userId);
  return accounts[account]?.enabled && accounts[account].activation === msg.activation ? account : null;
}

async function activePage() {
  const [tab] = await chrome.tabs.query({ ...X_TABS, active: true, currentWindow: true });
  return tab ? pingTab(tab) : null;
}

async function setAccountEnabled({ userId, account, enabled }) {
  const page = enabled ? await activePage() : null;
  if (enabled && (!/^\d+$/.test(userId || '') || page?.userId !== userId)) return { error: '请在要开启的 X 账号页面重试。' };
  const updated = await serial(async () => {
    const accounts = await kvGet(keys.accounts, {});
    const existing = enabled ? accountForUser(accounts, userId) : account;
    // uid- 不可能出现在旧版使用的 @用户名键里。
    const key = existing || (enabled ? `uid-${userId}` : null);
    const previous = accounts[key];
    if (!key || (!enabled && !previous?.enabled)) return null;
    const handle = /^[A-Za-z0-9_]{1,15}$/.test(page?.handle || '') ? page.handle : previous?.handle || null;
    if (previous?.enabled === enabled) return key;
    accounts[key] = { ...previous, userId: enabled ? userId : previous.userId, handle, enabled,
      activation: Math.max(now(), (previous?.activation || 0) + 1) };
    await kvSet(keys.accounts, accounts);
    if (!enabled) await clearAccountAlarms(key);
    return key;
  });
  if (!updated) return { error: '找不到要关闭的账号。' };
  if (enabled) {
    await refreshSnapshot(updated);
    queueBridgePush();
    await recoverAlarms(updated);
  }
  return { ok: true, account: updated };
}

// ---------- 抓取一页（经 x.com 标签页） ----------

const temporaryUnavailable = (status) => [502, 503, 504].includes(status);
const serviceWait = (attempt = 0) => Math.min(60, 5 * 2 ** attempt) * 60_000;

async function fetchViaTab(account, req, trace) {
  const me = (await kvGet(keys.accounts, {}))[account];
  const started = now();
  const source = req.kind === 'out' ? 'replies' : req.kind === 'scheduled' ? 'scheduled' : req.tpl ? 'mentions-graphql' : 'mentions-rest';
  let tabsTried = 0;
  const report = async (result, tabId = null) => {
    const durationMs = now() - started;
    const evidence = await mentionsEvidence(result.requestUrl, result.body, result.responseMetadata).catch(() => null);
    await record('request', {
      ...trace, account, source, tabId, tabsTried, retryResetAt: result.rateResetAt ?? null,
      status: result.status || 0, outcome: result.error || 'response',
      continuation: !!req.cursor, durationMs, ...(evidence ? { evidence } : {}),
    });
    return result;
  };
  if (!me?.enabled || !me.userId) return { ok: false, error: 'no_tab' };
  if (!inActiveHours()) return report({ ok: false, status: 0, error: 'outside_window' });
  const tabs = await chrome.tabs.query(X_TABS);
  for (const tab of tabs) {
    tabsTried++;
    const page = await pingTab(tab);
    if (page?.userId !== me.userId || page.visible === false) continue;
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'xir:fetch', userId: me.userId, activation: me.activation, ...req });
      if (r?.userId !== me.userId || (await pingTab(tab))?.userId !== me.userId) continue;
      const saved = (await kvGet(keys.accounts, {}))[account];
      if (!saved?.enabled || saved.activation !== me.activation) return { ok: false, error: 'no_tab' };
      return report(r, tab.id);
    } catch {
      // 标签页可能已关闭，或者正在切换会话。
    }
  }
  return report({ ok: false, error: 'no_tab' });
}

async function pingPages() {
  const tabs = await chrome.tabs.query(X_TABS);
  return (await Promise.all(tabs.map(pingTab))).filter(Boolean);
}

/** 只有正在前台显示的已登录 X 页面才接受自动读取；隐藏标签页不发请求。 */
async function hasVisiblePage(account) {
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me?.enabled || !me.userId) return false;
  return (await pingPages()).some((page) => page.userId === me.userId && page.visible !== false);
}

/** 读提及用哪个接口：记下过 X 页面读通知的请求（模板）就用新接口 'gql'，否则用旧接口 'rest'。两种接口的翻页游标不通用。 */
const mentionsApi = async (account) => ((await kvGet(keys.tplMentions(account))) ? 'gql' : 'rest');

/**
 * 抓一页提及并入库。api：'gql' | 'rest'，同一次翻页（一个回填任务、一轮补读）从头到尾用同一个。
 * 返回 {kind:'ok',parsed,added} | {kind:'rate',resetAt} | {kind:'no_tab'} | {kind:'tpl_bad'} | {kind:'error',message}
 * tpl_bad：新接口的模板没了或过期了（已删掉），调用方改用旧接口从最新一页重来。
 */
async function pull(account, cursor, api = 'rest', batch = { read: 0, added: 0 }, trace, inspectOnly = false) {
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me?.enabled) return { kind: 'error', message: '账号未绑定' };

  const tpl = api === 'gql' ? await kvGet(keys.tplMentions(account)) : null;
  if (api === 'gql' && !tpl) return { kind: 'tpl_bad' };
  const r = await fetchViaTab(account, { cursor, tpl: tpl?.url }, trace);
  if (r.error === 'no_tab') return { kind: 'no_tab' };
  if (r.error === 'outside_window') return { kind: 'outside_window' };
  if (tpl && (r.error === 'bad_tpl' || r.status === 400 || r.status === 404)) {
    if (!inspectOnly) await kvRemove(keys.tplMentions(account)); // X 发版换了参数：等用户下次打开通知页时记下新的，在那之前用旧接口
    return { kind: 'tpl_bad' };
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
      newestAt: parsed.newestTs, oldestAt: parsed.oldestTs, more: !!parsed.bottomCursor,
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
  await record('page_saved', { ...trace, source: 'mentions', decisions, newestAt: parsed.newestTs, oldestAt: parsed.oldestTs, cursorRepeated: !!cursor && cursor === parsed.bottomCursor, entries: parsed.entryIds.length, parsed: parsed.events.length, added, more: !!parsed.bottomCursor });
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

/** 记下这一轮增量的时间，并定好下一个上午。只改 cur，在 updateCursor 里调用；返回下一次的时间，交给 armInc 约闹钟。 */
function planNextInc(cur, from) {
  cur.lastIncrementalAt = from;
  cur.nextIncAt = nextAutoMorning(from);
  return cur.nextIncAt;
}

/** 约好下一次增量（专门一个闹钟，不等 30 分钟一次的兜底闹钟）。 */
async function armInc(account, nextIncAt) {
  await chrome.alarms.create(alarmFor(INC_ALARM, account), { when: Math.max(nextIncAt, now() + 1000) });
}

// ---------- 回填 ----------

async function saveJob(account, job) {
  await kvSet(keys.job(account), job);
}

async function scheduleJob(account, job, delayMs) {
  job.nextAt = now() + delayMs;
  await chrome.alarms.create(alarmFor(JOB_ALARM, account), { when: job.nextAt });
}

async function startBackfill(account) {
  if (!await enabledAccount(account)) return { error: '请先为此账号开启插件。' };
  const settings = await getSettings(account);
  if (!inActiveHours()) return { error: '读取只在每天 08:00–24:00 进行，夜间不运行。' };
  const rangeDays = settings.initDays; // 往回读多远看初始化范围，和榜单范围分开
  const job = {
    status: 'running',
    api: await mentionsApi(account), // 这次翻页用哪个接口，中途不换（游标不通用）
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
    return true;
  });
  if (accepted) stepBackfill(account); // 不等待，界面立刻返回
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
    // syncedId：从它往后（更早）到回填终点是连续完整的；增量每次从最新读到它之后，再回看一段
    if (job.topId && (!cur.syncedId || idGt(job.topId, cur.syncedId))) cur.syncedId = job.topId;
    return planNextInc(cur, now()); // 回填期间新来的回复留给下一次增量
  });
  if ((await getSettings(account)).fetchEnabled) await armInc(account, next);
  await refreshSnapshot(account);
  queueBridgePush();
}

/** 当前有没有该往下走的回填任务：有就返回 { account, job }。 */
async function runningJob(account) {
  if (!await enabledAccount(account)) return null;
  const job = account && (await kvGet(keys.job(account)));
  return job?.status === 'running' ? job : null;
}

async function stepBackfill(account) {
  if (busy) return retryAlarm(JOB_ALARM, account);
  if (!(await runningJob(account))) return;
  if (busy) return retryAlarm(JOB_ALARM, account);
  busy = true;
  try {
    const job = await runningJob(account); // 占住之后重读：上一步可能刚存了新进度
    if (!job) return;
    if (!inActiveHours()) {
      job.status = 'paused';
      job.auto = true;
      job.message = '已到夜间休息时间，明天 08:00 后自动继续';
      await saveJob(account, job);
      await scheduleJob(account, job, nextActiveAt() - now());
      return;
    }

    const trace = { account, mode: 'inbound_backfill', run: job.startedAt, page: job.pages + 1 };
    const res = await pull(account, job.cursor, job.api || 'rest', undefined, trace);
    // 请求的这一两秒里，用户可能点了暂停、重新初始化或清空：那就以存储里的为准，这一步的结果不再写回
    const latest = await kvGet(keys.job(account));
    if (!await enabledAccount(account) || !latest || latest.startedAt !== job.startedAt || latest.status !== 'running') return;

    if (res.kind === 'tpl_bad') {
      // 新接口的模板失效：换旧接口从最新一页重来，已入库的靠主键去重
      job.api = 'rest';
      job.cursor = null;
      job.topId = null;
      job.restarted = (job.restarted || 0) + 1;
      if (job.restarted > 3) {
        job.status = 'error';
        job.message = '读取方式反复失效，已停止';
      } else await scheduleJob(account, job, rand(PACE.pageGapMs));
    } else if (res.kind === 'no_tab') {
      job.status = 'waiting_tab';
      job.message = '打开此账号的 X 页面后自动继续';
    } else if (res.kind === 'outside_window') {
      job.status = 'paused';
      job.auto = true;
      job.message = '已到夜间休息时间，明天 08:00 后自动继续';
      await scheduleJob(account, job, nextActiveAt() - now());
    } else if (res.kind === 'unavailable') {
      job.status = 'paused';
      job.auto = true;
      job.message = `X 暂时不可用（HTTP ${res.status}），稍后从当前页重试`;
      const wait = serviceWait(job.serviceRetries);
      job.serviceRetries = (job.serviceRetries || 0) + 1;
      await scheduleJob(account, job, wait);
      await record('retry_scheduled', { ...trace, source: 'backfill', status: res.status, waitMs: wait });
    } else if (res.kind === 'rate') {
      job.status = 'paused';
      job.auto = true;
      const wait = Math.max(job.backoffMs, (res.resetAt || 0) - now());
      job.backoffMs = Math.min(job.backoffMs * 2, PACE.backoffMaxMs);
      job.message = '被 X 限流（429），已暂停，到时间自动继续';
      await scheduleJob(account, job, wait);
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

      if (p.newestTs && p.newestTs < job.targetTs) {
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
        queueBridgePush(); // 每批结束把本机数据推给开发桥，长回填期间也能看到进度
        await scheduleJob(account, job, rand(PACE.batchRestMs));
      } else {
        await scheduleJob(account, job, rand(PACE.pageGapMs));
      }
    }
    await saveJob(account, job);
  } finally {
    // 任务停下来（暂停、出错、等标签页）时，把节流期间没跟上的数据补进快照
    if (account) {
      const status = (await kvGet(keys.job(account)))?.status;
      await flushSnapshot(account, status !== 'running').catch(() => {});
      if (status !== 'running') queueBridgePush();
    }
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
  await chrome.alarms.clear(alarmFor(JOB_ALARM, account));
}

async function resumeJob(account) {
  const job = await kvGet(keys.job(account));
  if (!job || !['paused', 'error', 'waiting_tab'].includes(job.status)) return { error: '没有可继续的任务' };
  job.status = 'running';
  job.auto = false;
  job.message = null;
  await saveJob(account, job);
  stepBackfill(account);
  return { ok: true };
}

/** 闹钟到点、或有 X 标签页上线时调用：把该继续的任务接上。 */
async function wakeJob(account, tabOnline) {
  if (!await enabledAccount(account)) return;
  const job = await kvGet(keys.job(account));
  if (!job) return;
  const due = !job.nextAt || job.nextAt <= now();
  if (job.status === 'running') {
    // 已经在跑的不写回：这一步可能正在请求中，写回会把它刚存的进度盖掉
    if (!due) return;
  } else {
    if (job.status === 'paused' && job.auto && due) job.status = 'running';
    else if (job.status === 'waiting_tab' && tabOnline) job.status = 'running';
    else return;
    job.auto = false;
    await saveJob(account, job);
  }
  await stepBackfill(account);
}

// ---------- 增量 ----------

/** 自动任务未到期返回 null，手动任务受阻时返回具体原因。 */
async function incDue(account, manual) {
  const blocked = (error) => manual ? { error } : null;
  if (!await enabledAccount(account)) return blocked('请先为此账号开启插件。');
  const settings = await getSettings(account);
  const cur = await kvGet(keys.cursor(account), {});
  if (!cur.syncedId) return blocked('请先完成「别人回我」初始化。');
  const job = await kvGet(keys.job(account));
  if (job && ['running', 'waiting_tab'].includes(job.status)) return blocked('「别人回我」正在初始化，请等它结束。');
  if (job?.status === 'paused' && job.auto) return blocked(job.message || '初始化正在退避，稍后自动继续。');
  const t = now();
  if (!inActiveHours(t)) return blocked('读取只在每天 08:00–24:00 进行，夜间不自动发请求。');
  const until = Math.max(cur.rateUntil || 0, cur.serviceRetries ? cur.nextIncAt || 0 : 0);
  if (until > t) return blocked(`接口正在退避，请在 ${new Date(until).toLocaleTimeString()} 后再试。`);
  if (t < (cur.nextIncAt || 0)) {
    if (cur.incResume) return blocked('上一轮还有数据等待续读，插件会自动继续。');
    if (!manual) return null;
  }
  const resumeManual = !!cur.incResume?.manual;
  if (!manual && !resumeManual && !settings.fetchEnabled) return null;
  if (!manual && !resumeManual && !inAutoMorning(t)) return null;
  if (!manual && !cur.incResume && !cur.serviceRetries && t - (cur.lastAttemptAt || 0) < PACE.incRetryGapMs) return null;
  if (!manual && !(await hasVisiblePage(account))) return null;
  return { account, cur, settings };
}

async function maybeIncremental(account, manual = false) {
  const inProgress = { error: '已有读取任务正在运行，请等这次完成。' };
  const eligibility = await incDue(account, manual);
  if (!eligibility || eligibility.error) return eligibility || false;
  if (busy) return manual ? inProgress : retryAlarm(INC_ALARM, account);
  busy = true;
  try {
    const due = await incDue(account, manual); // 占住之后再确认一遍：上面查的工夫里刚跑完一轮的话，时间已经往后推了
    if (!due || due.error) return due || false;
    const { cur } = due;

    // 每天上午从最新一页往回读，并在上次成功读取的位置之外回看 6 小时：接住 X 短时晚放的回复。
    // 每个后台事件最多读 6 页；没读完就记下位置，休息 3–5 分钟后继续，
    // 直到接上、或者读到保存期限（90 天前，更早的反正要清掉）。
    // 接上之前接续点不动；出错中断时下次重读这一段，靠主键去重。
    const stopAt = cur.syncedId;
    const resume = cur.incResume?.stopAt === stopAt ? cur.incResume : null;
    const taskManual = manual || !!resume?.manual;
    const floorTs = now() - KEEP_DAYS * DAY_MS;
    const overlapCutoff = Math.min(cur.lastIncrementalAt || now(), now()) - PACE.incOverlapMs;
    const api = resume?.api || (await mentionsApi(account)); // 接着上一轮读的，游标是哪个接口的就用哪个
    const canRequest = api !== 'gql' || !!(await kvGet(keys.tplMentions(account)));
    const gap = PACE.incPageGapMs;
    const maxPages = PACE.incPagesPerEvent;
    let cursor = resume?.cursor || null;
    let topId = resume?.topId || null;
    let caughtUp = false;
    let manualMarked = false;
    const run = now();
    const batch = { read: 0, added: 0 };
    for (let page = 0; page < maxPages; page++) {
      if (page) await sleep(rand(gap));
      const trace = { account, mode: taskManual ? 'inbound_manual' : 'inbound_auto', run, page: page + 1 };
      const res = await pull(account, cursor, api, batch, trace);
      if (manual && canRequest && !manualMarked && !['no_tab', 'outside_window'].includes(res.kind)) {
        manualMarked = true;
        await updateCursor(account, (c) => { c.lastManualAt = now(); });
      }
      if (!await enabledAccount(account)) return false;
      if (res.kind === 'no_tab') {
        const when = nextActiveAt(now() + (cursor ? 60_000 : PACE.incRetryGapMs));
        await updateCursor(account, (c) => {
          if (cursor && c.syncedId === stopAt) c.incResume = { cursor, topId, stopAt, api, manual: taskManual };
          c.nextIncAt = when;
        });
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        return false; // 没有本账号的 X 页面，等它重新连上
      }
      if (res.kind === 'outside_window') {
        const when = nextActiveAt(now());
        await updateCursor(account, (c) => {
          if (cursor && c.syncedId === stopAt) c.incResume = { cursor, topId, stopAt, api, manual: taskManual };
          c.nextIncAt = when;
        });
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        return { message: '已到夜间休息时间，明天 08:00 后继续。' };
      }
      if (res.kind === 'tpl_bad') {
        // 新接口的模板失效：休息三到五分钟后用旧接口从最新一页重读这一段
        const when = nextActiveAt(now() + rand(PACE.restMs));
        await updateCursor(account, (c) => {
          delete c.incResume;
          c.nextIncAt = when;
        });
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        return { message: '新版读取方式失效，已安排用旧接口重试。' };
      }
      await updateCursor(account, (c) => {
        c.lastAttemptAt = now();
      });
      if (res.kind === 'unavailable') {
        const wait = serviceWait(cur.serviceRetries);
        const when = nextActiveAt(now() + wait);
        await updateCursor(account, (c) => {
          c.nextIncAt = when;
          c.serviceRetries = (c.serviceRetries || 0) + 1;
        });
        await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
        await setAlert(account, `X 暂时不可用（HTTP ${res.status}），稍后重试`);
        await record('retry_scheduled', { ...trace, source: 'incremental', status: res.status, waitMs: wait });
        return { message: `别人回我读取失败（HTTP ${res.status}），已安排重试。` };
      }
      if (res.kind === 'rate') {
        await armInc(account, await updateCursor(account, (c) => {
          const next = planNextInc(c, now());
          c.rateUntil = Math.max(next, res.resetAt ? nextActiveAt(res.resetAt) : 0);
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
      const crossedCheckpoint = !stopAt || !!(p.newestId && !idGt(p.newestId, stopAt));
      const pastOverlap = p.newestTs != null && p.newestTs < overlapCutoff;
      const stopReason = !p.entryIds.length ? 'empty_page'
        : !p.bottomCursor ? 'no_next_page'
        : p.bottomCursor === cursor ? 'repeated_cursor'
        : p.newestTs != null && p.newestTs < floorTs ? 'retention_boundary'
        : p.newestTs != null ? (pastOverlap && crossedCheckpoint ? 'reached_overlap' : null)
        : crossedCheckpoint ? 'reached_checkpoint' : null;
      if (stopReason) {
        await record('pagination_stop', { ...trace, source: 'mentions', reason: stopReason, checkpoint: stopAt });
        caughtUp = true;
        break;
      }
      cursor = p.bottomCursor;
    }
    if (!caughtUp) {
      const when = nextActiveAt(now() + rand(PACE.restMs));
      await updateCursor(account, (c) => {
        if (!c.syncedId) return; // 读的过程中被清空了
        c.incResume = { cursor, topId, stopAt, api, manual: taskManual };
        c.nextIncAt = when;
      });
      await chrome.alarms.create(alarmFor(INC_ALARM, account), { when });
      return { message: '别人回我已读完一批，等待续读；随后安排我回别人。' };
    }
    const next = await updateCursor(account, (c) => {
      // 读的过程中被清空了（没有 syncedId）就不补：清空后要重新初始化才自动抓
      if (topId && c.syncedId && idGt(topId, c.syncedId)) c.syncedId = topId;
      delete c.incResume;
      delete c.serviceRetries;
      // 手动更新已经拿到最新数据，下一次自动更新顺延到下一个上午，避免当天再扫一遍。
      return planNextInc(c, now());
    });
    if ((await getSettings(account)).fetchEnabled) await armInc(account, next);
    return { ok: true };
  } finally {
    if (account) await flushSnapshot(account, true).catch(() => {});
    queueBridgePush();
    busy = false;
  }
}

// ---------- 我在别人帖子下的回复 ----------
// 数据来自我自己主页「回复」栏的列表（里面混着原创帖和转发，解析时只留回复）。
// 状态放在 cursor.out：{ status: 'ok'|'need_tpl'|'error', message, syncedId, coverTs, lastAt, pages }
//   running：{ at, pages } 正在读、已读几页（读完清掉）；syncedId：上次读到的最新一条；fullFor：最近一次完整读覆盖的初始化范围（天），手动点「初始化」时清成 0 表示要完整读；
//   resume：完整读被页数上限截断时的续读位置；lastAt：最近一次读完的时间；lastFullAt / lastFullDays：最近一次完整读（初始化）完成的时间和范围。
// 我自己的回复不依赖「提及」的迟到补发；日常只从最新一页读到上次接续点，通常一页。

const saveOut = (account, patch) =>
  updateCursor(account, (cur) => {
    cur.out = { ...cur.out, ...patch };
  });

/** 读取已排队的初始化，或更新已经初始化过的账号。 */
async function syncOut(account, manual = false) {
  if (!await enabledAccount(account)) return;
  const settings = await getSettings(account);
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me?.enabled) return;
  if (busy) return retryAlarm(OUT_ALARM, account);
  busy = true;
  let started = false;
  try {
    const cur = await kvGet(keys.cursor(account), {});

    const prev = cur.out || {};
    const pending = !!prev.resume || !!prev.retryAt || ['need_tpl', 'queued', 'waiting_tab', 'reading'].includes(prev.status);
    // 手动读取一旦开始，就允许跨分段续完；自动读取只受开关和上午窗口约束。
    const taskManual = manual || (!!prev.manualTask && pending);
    if (!taskManual && !settings.fetchEnabled) return;
    if (!taskManual && !pending && !inAutoMorning()) return;
    if (!inActiveHours()) {
      if (!manual) {
        const when = nextActiveAt();
        await saveOut(account, {
          nextAutoAt: when,
          ...(prev.resume ? { resume: { ...prev.resume, nextAt: when } } : {}),
          ...(prev.retryAt ? { retryAt: when } : {}),
        });
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when });
      }
      return;
    }
    // 达到单次上限后已经明确报错停下：自动闹钟不要继续烧额度，等用户手动点初始化或立即更新再试
    if (!manual && prev.status === 'error' && prev.limitReached) return;
    const autoDue = prev.nextAutoAt ?? (prev.lastAt ? nextAutoMorning(prev.lastAt) : 0);
    const recovering = pending || prev.status === 'need_tpl';
    const nextAt = Math.max(prev.resume?.nextAt || 0, prev.retryAt || 0, !manual && !recovering ? autoDue : 0);
    if (nextAt > now()) {
      await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: nextAt });
      return;
    }
    if (!manual && !(await hasVisiblePage(account))) return;
    const initDays = prev.initDays ?? settings.initDays;
    const targetTs = prev.targetTs ?? now() - initDays * DAY_MS;
    // 第一次必须手动点「初始化」（点的时候正好在读另一份数据，会先记下 fullFor: 0，过一会儿由闹钟来读）
    if (!prev.lastAt && !prev.syncedId && prev.fullFor !== 0) return;
    // 完整读：手动初始化（fullFor 被清成 0）、或本机数据是旧版本存的——读到初始化范围的起点。否则读到上次位置之后再回看一段。
    const full = !prev.syncedId || prev.fullFor === 0 || (prev.schema || 1) < OUT_SCHEMA;
    // 上一轮被页数上限截断、留了续读位置：同一种读法就接着读；读法变了（比如范围调大了）就从头来
    const resume = prev.resume && (prev.resume.full ?? true) === full ? prev.resume : null;
    const stopAt = full ? null : resume?.stopAt || prev.syncedId;
    // 这个接口一轮最多读五页；页间等待保持在 Chrome 的空闲回收线以内。
    const gap = PACE.incPageGapMs;
    const maxPages = PACE.outPages; // 这个接口额度小，不管哪种读法一轮都只读几页

    // running：正在读，读到第几页。弹窗据此显示进度；不管怎么结束，finally 里都会清掉
    started = true;
    await saveOut(account, { status: 'reading', retryAt: null, message: null, limitReached: null, attemptCoverTs: null, manualTask: taskManual, running: { at: now(), pages: 0 } });
    const tpl = await kvGet(keys.tpl(account));
    if (!tpl) {
      await saveOut(account, { status: 'need_tpl', message: '打开 X 的「回复」栏一次，插件会自动继续。' });
      if (await kvGet(keys.tpl(account))) {
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: now() + 3000 });
      }
      return;
    }
    let cursor = resume?.cursor || null;
    let topId = resume?.topId || null;
    let reachedTs = null;
    let complete = false; // 读到了该停的位置（不是被页数上限截断）
    let reachedEnd = false; // 本次完整读是因为列表到底才停下
    let pages = 0;
    const run = now();
    const batch = { read: 0, added: 0 };
    for (; pages < maxPages; pages++) {
      if (pages) await sleep(rand(gap));
      if (!await enabledAccount(account)) return;
      if (!taskManual && !(await getSettings(account)).fetchEnabled) return saveOut(account, { status: 'error', message: '自动更新已关闭，读取已暂停。' });
      const trace = { account, mode: full ? 'outbound_backfill' : manual ? 'outbound_manual' : 'outbound_auto', run, page: pages + 1 };
      const r = await fetchViaTab(account, { kind: 'out', tpl: tpl.url, cursor }, trace);
      // 没有 X 标签页、或登录的不是这个账号：自动读的时候悄悄等下一轮，手动点的要说清楚为什么没读
      if (r.error === 'no_tab') return saveOut(account, { status: 'waiting_tab', resume: { cursor, topId, rounds: resume?.rounds || 0, full, stopAt }, message: '打开此账号的 X 页面后自动继续。' });
      if (r.error === 'outside_window') {
        const when = nextActiveAt();
        await saveOut(account, { status: 'ok', message: '已到夜间休息时间，明天再继续。', ...(cursor ? { resume: { cursor, topId, rounds: resume?.rounds || 0, full, stopAt, nextAt: when } } : { nextAutoAt: when }) });
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when });
        return;
      }
      if (temporaryUnavailable(r.status)) {
        const wait = serviceWait(prev.serviceRetries);
        const retryAt = now() + wait;
        await saveOut(account, { status: 'queued', retryAt, resume: { cursor, topId, rounds: resume?.rounds || 0, full, stopAt }, serviceRetries: (prev.serviceRetries || 0) + 1,
          message: `X 暂时不可用（HTTP ${r.status}），稍后继续读取。` });
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: retryAt });
        await record('retry_scheduled', { ...trace, source: 'replies', status: r.status, waitMs: wait });
        return;
      }
      if (r.status === 429) {
        const retryAt = Math.max(r.rateResetAt || 0, now() + PACE.backoffStartMs);
        await saveOut(account, { status: 'queued', retryAt,
          resume: { cursor, topId, rounds: resume?.rounds || 0, full, stopAt },
          message: `X 暂时限制了读取（429），将在 ${new Date(retryAt).toLocaleTimeString()} 后续读。` });
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: retryAt });
        await record('retry_scheduled', { ...trace, source: 'replies', status: 429, waitMs: retryAt - now() });
        return;
      }
      if (r.error === 'bad_tpl' || r.status === 400 || r.status === 404) {
        await kvRemove(keys.tpl(account)); // 模板过期了（X 发版换了参数）：过一会儿的下一轮会自己重新取
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
      await record('page_saved', { ...trace, source: 'replies', posts: p.events.map(({ id, own, created_at }) => ({ postId: id, own: !!own, createdAt: created_at })), newestAt: p.newestTs, oldestAt: p.oldestTs, cursorRepeated: !!cursor && cursor === p.bottomCursor, parsed: p.events.length, added, more: !!p.bottomCursor });
      await saveOut(account, { lastReadAt: readAt, lastReadCounts: { ...batch }, running: { at: now(), pages: pages + 1 } });
      if (!topId) topId = p.newestId;
      if (p.oldestTs) reachedTs = p.oldestTs;
      const ended = !p.oldestId || !p.bottomCursor || p.bottomCursor === cursor; // 列表到底了
      const reachedTarget = p.newestTs != null && p.newestTs < targetTs;
      const crossedCheckpoint = !stopAt || !!(p.newestId && !idGt(p.newestId, stopAt));
      const stoppedByTime = full ? reachedTarget : crossedCheckpoint;
      if (ended || stoppedByTime) {
        complete = true;
        reachedEnd = ended && !reachedTarget;
        pages++;
        break;
      }
      cursor = p.bottomCursor;
    }
    const rounds = (resume?.rounds || 0) + 1;
    if (!complete && rounds >= PACE.outMaxRounds) {
      const message = full
        ? '本次初始化达到单次页数上限，仍未读到所选范围。可重新初始化或缩小范围。'
        : '本次读取达到单次页数上限，仍未接上上次进度。稍后可再点「立即更新」。';
      await saveOut(account, {
        status: 'error', retryAt: null, running: null, resume: null, pages,
        message, limitReached: true, attemptCoverTs: reachedTs || prev.attemptCoverTs || null,
        ...(full ? {
          coverTs: reachedTs && prev.coverTs ? Math.min(prev.coverTs, reachedTs) : reachedTs || prev.coverTs || null,
          reachedEnd: false,
          fullFor: initDays, // 本次完整读没有完成，下次自动运行只做增量，等用户再点初始化
          initDays: null,
          targetTs: null,
        } : {}),
      });
      return;
    }
    if (!complete && rounds < PACE.outMaxRounds) {
      // 一轮没读完：记下位置，休息一批的间隔后在新的闹钟事件里接着读。读完之前接续点不动
      const nextAt = now() + rand(PACE.outRestMs);
      await saveOut(account, { status: 'ok', serviceRetries: 0, message: null, pages, limitReached: null, ...(full ? { attemptCoverTs: reachedTs } : {}), resume: { cursor, topId, rounds, full, stopAt, nextAt } });
      await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: nextAt });
      return;
    }
    // 读完了（读到该停的位置、列表到底，或续读轮数用完到此为止）
    const syncedId = topId && (!prev.syncedId || idGt(topId, prev.syncedId)) ? topId : prev.syncedId || topId;
    const nextAutoAt = nextAutoMorning(now());
    const done = { status: 'ok', serviceRetries: 0, message: null, pages, syncedId, resume: null, lastAt: now(), nextAutoAt, manualTask: false };
    await saveOut(account, full ? {
      ...done,
      coverTs: reachedTs && prev.coverTs ? Math.min(prev.coverTs, reachedTs) : reachedTs || prev.coverTs || null,
      attemptCoverTs: reachedTs || prev.attemptCoverTs || null,
      reachedEnd,
      limitReached: null,
      fullFor: initDays,
      schema: OUT_SCHEMA,
      lastFullAt: now(),
      lastFullDays: initDays,
      initDays: null,
      targetTs: null,
    } : done);
    if ((await getSettings(account)).fetchEnabled) {
      await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: nextAutoAt });
    }
  } catch (e) {
    // 没料到的错误也要落到状态里，不然手动点了之后界面上什么都看不到
    await saveOut(account, { status: 'error', message: `读取时出错：${String(e?.message || e)}` });
  } finally {
    if (started) {
      await saveOut(account, { running: null }).catch(() => {});
      await refreshSnapshot(account).catch(() => {}); // 标签里的「我回他几次」跟着更新
      queueBridgePush();
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
  if (removed) queueBridgePush();
}

// ---------- 清空 ----------

async function clearData(account) {
  await clearAccountAlarms(account);
  await clearEvents(account);
  snapDirty.delete(account);
  await serial(() => kvRemove([keys.cursor(account), keys.job(account), keys.snap(account), keys.alert(account), keys.scheduled(account), keys.lastPostAt(account)])); // 和改 cursor 的排同一个队
  queueBridgePush();
}

// ---------- 事件入口 ----------

async function clearAccountAlarms(account) {
  await Promise.all([JOB_ALARM, INC_ALARM, OUT_ALARM].map((kind) => chrome.alarms.clear(alarmFor(kind, account))));
}

async function retryAlarm(kind, account) {
  const name = alarmFor(kind, account);
  const when = now() + 60_000;
  const pending = await chrome.alarms.get(name);
  if (!pending || pending.scheduledTime <= now() || pending.scheduledTime > when) {
    await chrome.alarms.create(name, { when });
  }
}

async function recoverAlarms(account) {
  if (!await enabledAccount(account)) return;
  const autoEnabled = (await getSettings(account)).fetchEnabled;
  const cur = await kvGet(keys.cursor(account), {});
  const job = await kvGet(keys.job(account));
  const out = cur.out;
  const ensure = async (kind, when) => {
    const name = alarmFor(kind, account);
    if (!(await chrome.alarms.get(name))) await chrome.alarms.create(name, { when: Math.max(when, now() + 1_000) });
  };
  if (['running', 'waiting_tab'].includes(job?.status) || (job?.status === 'paused' && job.auto)) {
    await ensure(JOB_ALARM, job.nextAt || 0);
  }
  if ((autoEnabled || cur.incResume?.manual) && cur.syncedId) {
    const nextIncAt = cur.nextIncAt > now() && inAutoMorning(cur.nextIncAt) ? cur.nextIncAt : nextAutoMorning();
    await ensure(INC_ALARM, nextIncAt);
  }
  // 已开始的出站初始化独立续跑，即使入站还没完成首次初始化。
  if (out?.status === 'need_tpl' && !out.limitReached && await kvGet(keys.tpl(account))) {
    await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: now() + 3000 });
  } else if (out && !out.limitReached && (out.fullFor === 0 || out.lastAt || out.syncedId) && out.status !== 'need_tpl') {
    const retryAt = Math.max(out.resume?.nextAt || 0, out.retryAt || 0);
    const pending = out.fullFor === 0 || out.resume || ['queued', 'waiting_tab', 'reading'].includes(out.status);
    if (pending) await ensure(OUT_ALARM, retryAt);
    else if (autoEnabled) {
      const saved = out.nextAutoAt;
      const routine = saved > now() && inAutoMorning(saved) ? saved : nextAutoMorning();
      await ensure(OUT_ALARM, routine);
    }
  }
}

async function ensureTick() {
  await migrateAccounts();
  if (!(await chrome.alarms.get(TICK_ALARM))) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 30 });
  await Promise.all([
    refreshStaleTabs({ retry: true }),
    ...(await enabledAccounts()).map(([account]) => recoverAlarms(account)),
  ]);
  queueBridgePush();
}
chrome.runtime.onInstalled.addListener(ensureTick);
chrome.runtime.onStartup.addListener(ensureTick);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await migrateAccounts();
  if (alarm.name === STALE_TABS_ALARM) return refreshStaleTabs({ retry: true });
  if (alarm.name === TICK_ALARM) {
    await readDiagnostics().catch(() => {});
    await Promise.all((await enabledAccounts()).map(async ([account]) => {
      await maybePrune(account);
      await refreshSnapshot(account);
      await recoverAlarms(account);
      await maybeIncremental(account);
    }));
    queueBridgePush();
    return;
  }
  const [kind, account] = alarm.name.split(':');
  if (!await enabledAccount(account)) return;
  if (kind === JOB_ALARM) {
    const job = await kvGet(keys.job(account));
    const waiting = job?.status === 'waiting_tab';
    if (waiting) {
      const me = (await kvGet(keys.accounts, {}))[account];
      if (!(await pingPages()).some((page) => page.userId === me.userId)) return;
    }
    return wakeJob(account, waiting);
  }
  if (kind === INC_ALARM) return maybeIncremental(account);
  if (kind === OUT_ALARM) return syncOut(account);
});

async function diagnoseMentions({ account, from, to, postId, source }) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > DAY_MS ||
      (postId && !/^\d{1,24}$/.test(postId))) {
    return { error: '请选择一个不超过 24 小时的时间窗，帖子编号只填数字。' };
  }
  if (!await enabledAccount(account)) return { error: '请先为此账号开启插件。' };
  if (!inActiveHours()) return { error: '读取只在每天 08:00–24:00 进行，夜间不运行。' };
  const state = await kvGet(keys.cursor(account), {});
  const job = await kvGet(keys.job(account));
  if (busy || (state.rateUntil || 0) > now() || state.serviceRetries && state.nextIncAt > now() ||
      job?.status === 'running' || job?.status === 'paused' && job.auto) {
    return { error: '正在读取或处于退避期，请稍后回查。' };
  }
  busy = true;
  const run = now();
  try {
    const api = source === 'rest' ? 'rest' : await mentionsApi(account);
    await record('diagnostic_start', { account, source: 'mentions', run, api, from, to, postId: postId || null });
    let cursor = null;
    let pages = 0;
    let matches = 0;
    let reason = 'page_limit';
    let target = null;
    for (let page = 1; page <= PACE.diagnosePages; page++) {
      if (page > 1) await sleep(rand(PACE.incPageGapMs));
      if (!await enabledAccount(account)) { reason = 'account_disabled'; break; }
      pages = page;
      const result = await pull(account, cursor, api, undefined, { account, mode: 'inbound_diagnostic', run, page }, true);
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
    await record('diagnostic_end', { account, source: 'mentions', run, pages, matches, reason, target, stored });
    return { pages, matches, reason, target, stored };
  } finally {
    busy = false;
  }
}

const handlers = {
  // 内容脚本
  async 'xir:hello'(msg, sender) {
    const account = await senderAccount(msg, sender);
    if (!account) return { account: null };
    if (/^[A-Za-z0-9_]{1,15}$/.test(msg.handle || '')) {
      await serial(async () => {
        const accounts = await kvGet(keys.accounts, {});
        if (accounts[account]?.enabled && accounts[account].handle !== msg.handle) {
          accounts[account].handle = msg.handle;
          await kvSet(keys.accounts, accounts);
        }
      });
    }
    await refreshSnapshot(account);
    queueBridgePush();
    await recoverAlarms(account);
    return { account };
  },
  async 'xir:tpl'(msg, sender) {
    const account = await senderAccount(msg, sender);
    const { url, kind } = msg;
    if (!account || typeof url !== 'string' || url.length > 30000) return {};
    const template = kind === 'mentions' ? keys.tplMentions : kind === 'scheduled' ? keys.tplScheduled : keys.tpl;
    await kvSet(template(account), { url, at: now() });
    if (template === keys.tpl) {
      const out = (await kvGet(keys.cursor(account), {})).out;
      if (out?.status === 'need_tpl' && !out.limitReached) {
        await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: now() + 3000 });
      }
    }
    return {};
  },
  async 'xir:mentions:evidence'(msg, sender) {
    const { url, status, metadata, text } = msg;
    const account = await senderAccount(msg, sender);
    if (!account || typeof text !== 'string' || text.length > 8_000_000) return {};
    let body;
    try { body = JSON.parse(text); } catch { /* 保留请求与 HTTP 信息 */ }
    const evidence = await mentionsEvidence(url, body, metadata).catch(() => null);
    if (evidence?.request.timeline === 'Mentions') {
      await record('web_mentions_response', {
        account, source: 'mentions-graphql', tabId: sender.tab.id,
        status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0, evidence,
      });
    }
    return {};
  },
  async 'xir:scheduled:tap'(msg, sender) {
    const { text } = msg;
    const account = await senderAccount(msg, sender);
    if (!account || typeof text !== 'string') return {};
    try {
      const items = parseScheduledTweets(JSON.parse(text));
      const syncedAt = now();
      await kvSet(keys.scheduled(account), { items, syncedAt, error: null });
      await record('scheduled_sync', { account, source: 'scheduled', mode: 'tap', outcome: 'ok', count: items.length, scheduledTimes: items.map(({ executeAt }) => executeAt) });
      return { ok: true, items, syncedAt };
    } catch (e) {
      await record('parse_failed', { account, source: 'scheduled', mode: 'tap', category: e instanceof ParseError ? 'unexpected_payload' : 'parser_exception' });
      return {};
    }
  },
  async 'xir:postEvent'(msg, sender) {
    const { op, at } = msg;
    const account = await senderAccount(msg, sender);
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
  async 'xir:scheduled:sync'(msg, sender) {
    const { force } = msg;
    const account = await senderAccount(msg, sender);
    if (!account) return { items: [], syncedAt: 0, lastPostAt: 0, status: 'error', message: '未识别到当前 X 账号' };
    const cached = (await kvGet(keys.scheduled(account))) || { items: [], syncedAt: 0, error: null };
    const lastPostAt = (await kvGet(keys.lastPostAt(account))) || 0;
    const tpl = await kvGet(keys.tplScheduled(account));
    if (!tpl) {
      await record('scheduled_sync', { account, source: 'scheduled', mode: force ? 'manual' : 'auto', outcome: 'need_tpl' });
      return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'need_tpl', message: '点一下下方「已排期帖子」完成首次同步' };
    }
    // 30 秒防抖：连续开关排期弹窗不重复发请求
    if (!force && cached.syncedAt && now() - cached.syncedAt < 30_000) {
      return { items: cached.items || [], syncedAt: cached.syncedAt, lastPostAt, status: 'ok' };
    }
    const r = await fetchViaTab(account, { kind: 'scheduled', tpl: tpl.url }, { account, mode: force ? 'scheduled_manual' : 'scheduled_auto', run: now(), page: 1 });
    if (r.error === 'no_tab') return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: '未连接到 X 页面，已显示上次缓存' };
    if (r.error === 'outside_window') return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: '读取只在每天 08:00–24:00 进行，已显示上次缓存' };
    if (r.error === 'bad_tpl' || r.status === 400 || r.status === 404) {
      await kvRemove(keys.tplScheduled(account));
      await record('scheduled_sync', { account, source: 'scheduled', mode: force ? 'manual' : 'auto', outcome: 'tpl_expired', status: r.status || 0 });
      return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'need_tpl', message: '接口参数已更新，请点一下「已排期帖子」重新连接' };
    }
    if (r.status === 429) return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: '暂时被 X 限流（429），已显示上次缓存' };
    if (!r.ok) return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: `同步排期失败（${r.error || 'HTTP ' + r.status}），已显示缓存` };
    try {
      const items = parseScheduledTweets(r.body);
      const syncedAt = now();
      await kvSet(keys.scheduled(account), { items, syncedAt, error: null });
      await record('scheduled_sync', { account, source: 'scheduled', mode: force ? 'manual' : 'auto', outcome: 'ok', count: items.length, scheduledTimes: items.map(({ executeAt }) => executeAt) });
      return { items, syncedAt, lastPostAt, status: 'ok' };
    } catch (e) {
      await record('parse_failed', { account, source: 'scheduled', mode: force ? 'manual' : 'auto', category: e instanceof ParseError ? 'unexpected_payload' : 'parser_exception' });
      const why = e instanceof ParseError ? e.message : String(e);
      return { items: cached.items || [], syncedAt: cached.syncedAt || 0, lastPostAt, status: 'error', message: `排期解析失败：${why}` };
    }
  },
  // 通知列表里的回复是在谁的帖子下：页面数据看不出来的，内容脚本拿帖子 ID 来问本机数据
  async 'xir:where'(msg, sender) {
    const { ids } = msg;
    const account = await senderAccount(msg, sender);
    if (!account || !Array.isArray(ids)) return { places: {} };
    return { places: replyPlaces(await getEvents(account), await getEvents(account, OUT), ids.slice(0, 200).map(String)) };
  },
  async 'xir:dom'(msg, sender) {
    const account = await senderAccount(msg, sender);
    if (!account) return {};
    if (msg.broken) await kvSet(keys.domWarning(account), { at: now() });
    else await kvRemove(keys.domWarning(account));
    return {};
  },

  // 弹窗
  getDiagnostics: async ({ account }) => (await readDiagnostics()).filter((event) => event.account === account).map(({ account: _, ...event }) => event),
  diagnoseMentions,
  async updateNowWithReceipt({ account }) {
    const startedAt = now();
    if (!account) return { error: '请先选择已登录的 X 账号。' };
    if (!inActiveHours()) return { error: '读取只在每天 08:00–24:00 进行，夜间不运行。' };
    if (!(await hasVisiblePage(account))) return { error: '请切到该账号的 X 页面后再更新。' };
    const beforeManual = await kvGet(keys.cursor(account), {});
    const wait = PACE.manualCooldownMs - (now() - (beforeManual.lastManualAt || 0));
    if (wait > 0) return { error: `刚刚更新过，请 ${Math.ceil(wait / 60_000)} 分钟后再试。` };
    const result = await maybeIncremental(account, true);
    if (result === false) return { error: '读取暂不可用，请确认已有登录的 X 页面并稍后再试。' };
    if (!result?.ok) return result;

    const before = (await kvGet(keys.cursor(account), {})).out;
    if (!before?.lastAt && !before?.syncedId) {
      return { message: '别人回我已读完；请先初始化「我回别人」。' };
    }
    await syncOut(account, true);
    const after = (await kvGet(keys.cursor(account), {})).out;
    if (after?.message) return { message: `别人回我已读完；我回别人：${after.message}` };
    if (after?.resume) return { message: '别人回我已读完；我回别人还有数据等待续读。' };
    if (after?.lastReadAt >= startedAt) {
      const { inLastReadAt } = await kvGet(keys.cursor(account), {});
      if (inLastReadAt >= startedAt) return { ok: true, readAt: { inbound: inLastReadAt, outbound: after.lastReadAt } };
    }
    return { message: '别人回我已读完；我回别人暂未读取，请查看数据状态。' };
  },
  setAccountEnabled,
  async getState() {
    const registry = await kvGet(keys.accounts, {});
    const accounts = Object.fromEntries(Object.entries(registry).filter(([, a]) => a.enabled));
    const [page, pages] = await Promise.all([activePage(), pingPages()]);
    const activeKey = accountForUser(accounts, page?.userId);
    const active = page?.userId ? { userId: page.userId, handle: page.handle, account: activeKey } : null;
    const online = [...new Set(pages.map((p) => accountForUser(accounts, p.userId)).filter(Boolean))];
    return { accounts, active, online };
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
      domWarning: await kvGet(keys.domWarning(account)),
      tplAt: (await kvGet(keys.tpl(account)))?.at || null, // 什么时候看到过 X 读「回复」列表的请求；没看到过就读不了「我回别人」
      mentionsApi: await mentionsApi(account), // 别人回我现在用哪个接口：'gql' 新 / 'rest' 旧
    };
  },
  async getBoard({ account }) {
    return board(account); // { rows, people, replies }
  },
  exportAll: async ({ account }) => ({ inbound: await getEvents(account), out: await getEvents(account, OUT) }),
  getReplies: async ({ account, actorId }) => repliesOf(await getEvents(account), actorId, await getSettings(account), now(), 50, await getEvents(account, OUT)),
  startBackfill: ({ account }) => startBackfill(account),
  async syncOutNow({ account }) {
    if (!await enabledAccount(account)) return { error: '请先为此账号开启插件。' };
    if (!inActiveHours()) return { error: '读取只在每天 08:00–24:00 进行，夜间不运行。' };
    const { initDays } = await getSettings(account);
    const queued = await updateCursor(account, (cur) => {
      const out = cur.out || {};
      if (out.running && now() - out.running.at < 120_000) return;
      if (['queued', 'waiting_tab'].includes(out.status) || out.resume && out.status !== 'error') return;
      cur.out = { ...out, status: 'queued', message: null, manualTask: true, fullFor: 0, resume: null, initDays, targetTs: now() - initDays * DAY_MS };
      return true;
    });
    if (!queued) return { ok: true };
    syncOut(account, true).catch((e) => saveOut(account, { status: 'error', message: `读取时出错：${String(e?.message || e)}` }));
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
    if (!next.fetchEnabled) {
      // 开关只停日常自动读取；正在跑的手动初始化和立即更新仍可续完。
      const cur = await kvGet(keys.cursor(account), {});
      if (!cur.incResume?.manual) await chrome.alarms.clear(alarmFor(INC_ALARM, account));
      const out = cur.out;
      const outPending = !!out?.resume || ['need_tpl', 'queued', 'waiting_tab', 'reading'].includes(out?.status);
      if (!outPending) await chrome.alarms.clear(alarmFor(OUT_ALARM, account));
    }
    else if ('fetchEnabled' in patch) await recoverAlarms(account);
    await refreshSnapshot(account); // 口径或颜色变了，标签立刻跟着变
    queueBridgePush();
    return { ok: true };
  },
  clearData: async ({ account }) => (await clearData(account), { ok: true }),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return false;
  const logged = ['startBackfill', 'syncOutNow', 'pauseJob', 'resumeJob', 'clearData', 'updateNowWithReceipt'].includes(msg.type);
  Promise.resolve().then(async () => {
    await migrateAccounts();
    if (msg.type.startsWith('xir:')) return h(msg, _sender);
    if (_sender.tab) return { error: '请从插件弹窗操作。' };
    if (msg.account && msg.type !== 'setAccountEnabled' && !await enabledAccount(msg.account)) return { error: '此账号尚未开启插件。' };
    return h(msg, _sender);
  }).then(async (result) => {
    if (logged) await record(msg.type, { account: msg.account, outcome: result?.error ? 'rejected' : 'accepted' });
    sendResponse(result);
  }, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
