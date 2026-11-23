// 经由 x.com 标签页发请求、统一限流退避、账号异常硬熔断与提及拉取入库。
import { putEvents, kvGet, kvSet, kvRemove, keys, getSettings } from '../db.js';
import { record } from '../diagnostics.js';
import { queueBridgePush } from '../bridge.js';
import { parseMentions, detectAccountAnomaly, ParseError, idGt } from '../x/parser.js';
import { mentionsEvidence } from '../x/mentions-diagnostics.js';
import {
  PACE, X_TABS, now, inActiveHours, temporaryUnavailable,
  updateCursor, setAlert, markSnapDirty, flushSnapshot,
} from './runtime.js';
import { clearAccountAlarms } from './alarms.js';
import { pingTab } from './accounts.js';

/** 命中 X 账号侧异常信号时立即硬熔断：关闭全部自动抓取、清空闹钟与续读、挂红字告警，绝不自动恢复。 */
export async function tripAccountCircuit(account, anomaly, source) {
  const settings = await getSettings(account);
  if (settings.fetchEnabled || settings.outAutoSync) {
    await kvSet(keys.settings(account), { ...settings, fetchEnabled: false, outAutoSync: false });
  }
  await clearAccountAlarms(account);
  await updateCursor(account, (cur) => {
    cur.circuitBroken = { at: now(), code: anomaly.code, reason: anomaly.reason, source };
    delete cur.incResume;
    if (cur.out) {
      cur.out = {
        ...cur.out,
        status: 'error',
        resume: null,
        retryAt: null,
        running: null,
        manualTask: false,
        message: '检测到 X 账号异常，已熔断停止读取。',
      };
    }
  });
  const job = await kvGet(keys.job(account));
  if (job && job.status !== 'done') {
    await kvSet(keys.job(account), { ...job, status: 'error', nextAt: null, message: '检测到 X 账号异常，已熔断停止读取。' });
  }
  await setAlert(account, `检测到 X 账号异常/验证限制（${anomaly.reason}），已立即熔断并关闭全部自动抓取；请先在 X 确认账号正常后，再手动重新开启自动更新。`);
  await record('circuit_breaker', { account, source, code: anomaly.code, reason: anomaly.reason });
  queueBridgePush();
}

/** 仅在用户手动重新开启自动更新或显式触发手动读取时解除熔断。 */
export async function clearAccountCircuit(account) {
  const had = await updateCursor(account, (cur) => {
    if (!cur.circuitBroken) return false;
    delete cur.circuitBroken;
    return true;
  });
  if (had) {
    await kvRemove(keys.alert(account));
    queueBridgePush();
  }
}

/** 任一读取入口收到 429 后，统一抬高账号级退避并累计连续次数。 */
export async function recordRateLimit(account, resetAt = 0) {
  return updateCursor(account, (cur) => {
    const attempts = (cur.rate429Count || 0) + 1;
    const wait = Math.min(PACE.backoffStartMs * 2 ** Math.min(attempts - 1, 12), PACE.backoffMaxMs);
    const until = Math.max(Number(resetAt) || 0, now() + wait);
    cur.rate429Count = attempts;
    cur.rateUntil = Math.max(cur.rateUntil || 0, until);
    return { attempts, until };
  });
}

/** 退避到期后任意一路成功，说明账号已经恢复，下一次 429 从 15 分钟重新计。 */
export const clearRateLimit = (account) => updateCursor(account, (cur) => {
  if (cur.rateUntil && cur.rateUntil > now()) return;
  cur.rateUntil = 0;
  cur.rate429Count = 0;
});

export async function fetchViaTab(account, req, trace) {
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
  // 429 是账号级信号：所有主动读取入口都从这里过，不能只挡当前那一路。
  // out.retryAt 只用于出站自己的等待（包括 503），不拿来封住入站和回填。
  const cur = await kvGet(keys.cursor(account), {});
  if (cur.circuitBroken) {
    return report({ ok: false, status: 0, error: 'circuit_broken', reason: cur.circuitBroken.reason });
  }
  const blockedUntil = Math.max(cur.rateUntil || 0, req.kind === 'out' ? cur.out?.retryAt || 0 : 0);
  if (blockedUntil > now()) {
    return report({ ok: false, status: 0, error: 'backoff', rateResetAt: blockedUntil });
  }
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
      const result = await report(r, tab.id);
      if (r?.status === 429) {
        const rate = await recordRateLimit(account, r.rateResetAt);
        return { ...result, backoffUntil: rate.until, rate429Count: rate.attempts, rateResetAt: rate.until };
      }
      const anomaly = detectAccountAnomaly(r?.status, r?.body);
      if (anomaly) {
        await tripAccountCircuit(account, anomaly, source);
        return { ...result, ok: false, error: 'circuit_broken', anomaly };
      }
      if (r?.ok) await clearRateLimit(account);
      return result;
    } catch {
      // 标签页可能已关闭，或者正在切换会话。
    }
  }
  return report({ ok: false, error: 'no_tab' });
}

/** 读提及用哪个接口：记下过 X 页面读通知的请求（模板）就用新接口 'gql'，否则用旧接口 'rest'。两种接口的翻页游标不通用。 */
export const mentionsApi = async (account) => ((await kvGet(keys.tplMentions(account))) ? 'gql' : 'rest');

/**
 * 抓一页提及并入库。api：'gql' | 'rest'，同一次翻页（一个回填任务、一轮补读）从头到尾用同一个。
 * 返回 {kind:'ok',parsed,added} | {kind:'rate',resetAt} | {kind:'no_tab'} | {kind:'tpl_bad'} | {kind:'error',message}
 * tpl_bad：新接口的模板没了或过期了（已删掉），调用方改用旧接口从最新一页重来。
 */
export async function pull(account, cursor, api = 'rest', batch = { read: 0, added: 0 }, trace, inspectOnly = false) {
  const me = (await kvGet(keys.accounts, {}))[account];
  if (!me?.enabled) return { kind: 'error', message: '账号未绑定' };

  const tpl = api === 'gql' ? await kvGet(keys.tplMentions(account)) : null;
  if (api === 'gql' && !tpl) return { kind: 'tpl_bad' };
  const r = await fetchViaTab(account, { cursor, tpl: tpl?.url }, trace);
  if (r.error === 'no_tab') return { kind: 'no_tab' };
  if (r.error === 'outside_window') return { kind: 'outside_window' };
  if (r.error === 'circuit_broken') return { kind: 'circuit_broken', message: '检测到 X 账号异常，已熔断并关闭全部自动抓取；请先在 X 确认账号正常后再手动开启。' };
  if (r.error === 'backoff') return { kind: 'backoff', retryAt: r.rateResetAt || 0 };
  if (tpl && (r.error === 'bad_tpl' || r.status === 400 || r.status === 404)) {
    if (!inspectOnly) await kvRemove(keys.tplMentions(account)); // X 发版换了参数：等用户下次打开通知页时记下新的，在那之前用旧接口
    return { kind: 'tpl_bad' };
  }
  if (temporaryUnavailable(r.status)) return { kind: 'unavailable', status: r.status };
  if (r.status === 429) return { kind: 'rate', resetAt: r.backoffUntil || r.rateResetAt };
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
    markSnapDirty(account);
    await flushSnapshot(account, false);
  }
  return { kind: 'ok', parsed, added };
}
