// 后台调度：账号绑定、回填任务、增量更新、给界面供数。
// 不直接碰 X 的接口与返回结构——请求经 x.com 标签页里的抓取层(fetcher.js)发出，返回交给解析层(parser.js)。

import { parseMentions, ParseError, idGt } from './x/parser.js';
import { board, badgeSnapshot, DAY_MS, WINDOWS } from './rank.js';
import { putEvents, getEvents, clearEvents, kvGet, kvSet, kvRemove, keys, getSettings } from './db.js';

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
  incMaxPages: 40, // 增量：单次最多页数（约 800 条提及，3 分钟内跑完，不超过 Service Worker 单次事件时限）；到了就停，不提示
  incRetryGapMs: 10 * 60_000, // 增量：两次尝试的最小间隔
};

const TICK_ALARM = 'tick';
const JOB_ALARM = 'job';
const INC_ALARM = 'inc';
const ACTIVE_JOB = 'activeJobAccount';

const rand = ([a, b]) => a + Math.floor(Math.random() * (b - a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

let busy = false; // 同一时刻只允许一个抓取动作

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

async function fetchViaTab(cursor) {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  for (const tab of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'xir:fetch', cursor });
      if (r) return r;
    } catch {
      // 该标签页没有内容脚本（装插件前打开的、或已被休眠），换下一个
    }
  }
  return { ok: false, error: 'no_tab' };
}

/** 抓一页并入库。返回 {kind:'ok',parsed,added} | {kind:'rate',resetAt} | {kind:'no_tab'} | {kind:'error',message} */
async function pull(account, cursor) {
  if (!(await getSettings(account)).fetchEnabled) return { kind: 'error', message: '后台抓取已关闭' };
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me) return { kind: 'error', message: '账号未绑定' };

  const r = await fetchViaTab(cursor);
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
  const cur = await kvGet(keys.cursor(account), {});
  if (parsed.newestId && (!cur.newestId || idGt(parsed.newestId, cur.newestId))) cur.newestId = parsed.newestId;
  if (parsed.oldestTs && (!cur.earliestTs || parsed.oldestTs < cur.earliestTs)) cur.earliestTs = parsed.oldestTs;
  await kvSet(keys.cursor(account), cur);
  await kvRemove(keys.alert(account));
  if (added) await refreshSnapshot(account);
  return { kind: 'ok', parsed, added };
}

async function refreshSnapshot(account) {
  const { windowDays } = await getSettings(account);
  await kvSet(keys.snap(account), { at: now(), windowDays, users: badgeSnapshot(await getEvents(account), windowDays) });
}

const setAlert = (account, message) => kvSet(keys.alert(account), { at: now(), message });

/** 记下这一轮增量的时间，并随机定好下一次（专门约一个闹钟，不等 30 分钟一次的兜底闹钟）。 */
async function planNextInc(cur, from) {
  cur.lastIncrementalAt = from;
  cur.nextIncAt = from + rand(PACE.incIntervalMs);
  await chrome.alarms.create(INC_ALARM, { when: Math.max(cur.nextIncAt, now() + 1000) });
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
  if (!settings.fetchEnabled) return { error: '后台抓取已关闭，先在设置里打开' };
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
  const cur = await kvGet(keys.cursor(account), {});
  cur.lastBackfill = { rangeDays: job.rangeDays, finishedAt: job.finishedAt, oldestTs: job.oldestTs, reachedEnd };
  // syncedId：从它往后（更早）到回填终点是连续完整的；增量每次从最新读回到它为止
  if (job.topId && (!cur.syncedId || idGt(job.topId, cur.syncedId))) cur.syncedId = job.topId;
  await planNextInc(cur, job.startedAt); // 回填期间新来的回复留给下一次增量
  await kvSet(keys.cursor(account), cur);
  await refreshSnapshot(account);
}

async function stepBackfill() {
  if (busy) return;
  const account = await kvGet(ACTIVE_JOB);
  if (!account) return;
  const job = await kvGet(keys.job(account));
  if (!job || job.status !== 'running') return;

  busy = true;
  try {
    const res = await pull(account, job.cursor);

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
  if (job.status === 'paused' && job.auto && due) job.status = 'running';
  else if (job.status === 'waiting_tab' && tabOnline && account === (await kvGet(keys.current))) job.status = 'running';
  else if (!(job.status === 'running' && due)) return;
  job.auto = false;
  await saveJob(account, job);
  await stepBackfill();
}

// ---------- 增量 ----------

async function maybeIncremental() {
  if (busy) return;
  const account = await kvGet(keys.current);
  if (!account) return;
  const settings = await getSettings(account);
  if (!settings.fetchEnabled) return;
  const cur = await kvGet(keys.cursor(account), {});
  if (!cur.syncedId) return; // 还没完成过初始化，不自动抓
  const job = await kvGet(keys.job(account));
  if (job && ['running', 'waiting_tab'].includes(job.status)) return;
  if (job && job.status === 'paused' && job.auto) return; // 限流退避中
  const t = now();
  if (t < (cur.nextIncAt || 0)) return;
  if (t - (cur.lastAttemptAt || 0) < PACE.incRetryGapMs) return;

  busy = true;
  try {
    // 从最新一页往回读，读到上次的接续点为止：间隔里来了多少就读多少页。
    // 出错中断时接续点不动，下次重读这一段，靠主键去重。
    // 读满上限还没接上（一小时超过约 800 条）就到此为止：接续点照样前移，没读到的那段放弃，不提示（负责人定，不需要那么严格）。
    const stopAt = cur.syncedId;
    let cursor = null;
    let topId = null;
    for (let page = 0; page < PACE.incMaxPages; page++) {
      if (page) await sleep(rand(PACE.incPageGapMs));
      const res = await pull(account, cursor);
      if (res.kind === 'no_tab') return; // 没有 X 标签页，等下次有页面上线再试，不记失败
      const c = await kvGet(keys.cursor(account), {});
      c.lastAttemptAt = now();
      await kvSet(keys.cursor(account), c);
      if (res.kind === 'rate') {
        await planNextInc(c, now()); // 这一轮放弃，等下个周期
        await kvSet(keys.cursor(account), c);
        await setAlert(account, '增量更新被 X 限流（429），本轮已放弃，下个周期再试');
        return;
      }
      if (res.kind === 'error') {
        await setAlert(account, res.message);
        return;
      }
      const p = res.parsed;
      if (page === 0) topId = p.newestId;
      if (!p.entryIds.length || !idGt(p.oldestId, stopAt) || !p.bottomCursor) {
        break;
      }
      cursor = p.bottomCursor;
    }
    const c = await kvGet(keys.cursor(account), {});
    await planNextInc(c, now());
    if (topId && idGt(topId, c.syncedId)) c.syncedId = topId;
    await kvSet(keys.cursor(account), c);
  } finally {
    busy = false;
  }
}

// ---------- 清空 ----------

async function clearData(account) {
  if ((await kvGet(ACTIVE_JOB)) === account) {
    await chrome.alarms.clear(JOB_ALARM);
    await kvRemove(ACTIVE_JOB);
  }
  await clearEvents(account);
  await kvRemove([keys.cursor(account), keys.job(account), keys.snap(account), keys.alert(account)]);
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
  if (alarm.name === TICK_ALARM) {
    const account = await kvGet(keys.current);
    if (account) await refreshSnapshot(account); // 时间窗会随时间滑动，定期重算，不发请求
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
      wakeJob(true).then(maybeIncremental);
    }
    return { account };
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
    const state = { accounts, current, pendingUserId: await kvGet(keys.pendingUserId), domWarning: await kvGet(keys.domWarning) };
    return state;
  },
  async getAccountState({ account }) {
    return {
      settings: await getSettings(account),
      cursor: await kvGet(keys.cursor(account), {}),
      job: await kvGet(keys.job(account)),
      alert: await kvGet(keys.alert(account)),
      eventCount: (await getEvents(account)).length,
    };
  },
  async getBoard({ account }) {
    const { windowDays } = await getSettings(account);
    return { windowDays, rows: board(await getEvents(account), windowDays) };
  },
  startBackfill: ({ account }) => startBackfill(account),
  pauseJob: async ({ account }) => (await pauseJob(account), { ok: true }),
  resumeJob: ({ account }) => resumeJob(account),
  async setSettings({ account, patch }) {
    const next = { ...(await getSettings(account)), ...patch };
    if (!WINDOWS.includes(next.windowDays)) return { error: '统计窗口只能是 7 天或 15 天' };
    await kvSet(keys.settings(account), next);
    if (!next.fetchEnabled) await pauseJob(account, '后台抓取已关闭，任务暂停');
    if ('windowDays' in patch) await refreshSnapshot(account);
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
