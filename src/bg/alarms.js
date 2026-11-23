// 后台闹钟管理：清理、重试与按账号恢复待续任务。
import { kvGet, keys, getSettings } from '../db.js';
import {
  enabledAccount, alarmFor, now, inAutoSlot, nextAutoSlot,
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
    const nextIncAt = cur.nextIncAt > now() && inAutoSlot(cur.nextIncAt) ? cur.nextIncAt : nextAutoSlot();
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
      const routine = saved > now() && inAutoSlot(saved) ? saved : nextAutoSlot();
      await ensure(OUT_ALARM, routine);
    }
  }
}
