// 后台闹钟管理：清理、重试与按账号恢复未完成的手动续读任务（不再安排后台定时自动抓取）。
import { kvGet, keys } from '../db.js';
import {
  enabledAccount, alarmFor, now,
  JOB_ALARM, INC_ALARM, OUT_ALARM,
} from './runtime.js';

export async function clearAccountAlarms(account) {
  await Promise.all([JOB_ALARM, INC_ALARM, OUT_ALARM].map((kind) => chrome.alarms.clear(alarmFor(kind, account))));
}

export async function retryAlarm(kind, account) {
  const name = alarmFor(kind, account);
  const when = now() + 60_000;
  const pending = await chrome.alarms.get(name);
  if (!pending || pending.scheduledTime <= now() || pending.scheduledTime > when) {
    await chrome.alarms.create(name, { when });
  }
}

export async function recoverAlarms(account) {
  if (!await enabledAccount(account)) return;
  const cur = await kvGet(keys.cursor(account), {});
  if (cur.circuitBroken) return;
  const job = await kvGet(keys.job(account));
  const out = cur.out;
  const ensure = async (kind, when) => {
    const name = alarmFor(kind, account);
    if (!(await chrome.alarms.get(name))) await chrome.alarms.create(name, { when: Math.max(when, now() + 1_000) });
  };
  if (['running', 'waiting_tab'].includes(job?.status) || (job?.status === 'paused' && job.auto)) {
    await ensure(JOB_ALARM, job.nextAt || 0);
  }
  // 仅恢复用户手动触发且尚未读完的分段续读；清理旧版遗留的非手动自动抓取闹钟
  if (cur.incResume?.manual && !cur.incLimitReached) {
    await ensure(INC_ALARM, cur.nextIncAt || 0);
  } else {
    await chrome.alarms.clear(alarmFor(INC_ALARM, account));
  }
  const outPending = !!(out?.manualTask && !out.limitReached && (out.fullFor === 0 || out.resume || out.retryAt || ['queued', 'waiting_tab', 'reading'].includes(out.status)));
  if (out?.manualTask && out.status === 'need_tpl' && !out.limitReached && await kvGet(keys.tpl(account))) {
    await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: now() + 3000 });
  } else if (outPending && out?.status !== 'need_tpl') {
    const retryAt = Math.max(out?.resume?.nextAt || 0, out?.retryAt || 0);
    await ensure(OUT_ALARM, retryAt);
  } else {
    await chrome.alarms.clear(alarmFor(OUT_ALARM, account));
  }
}
