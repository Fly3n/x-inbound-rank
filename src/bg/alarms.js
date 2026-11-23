// 后台闹钟管理：清理、重试与按账号恢复待续任务。
import { kvGet, keys, getSettings } from '../db.js';
import {
  enabledAccount, alarmFor, now, inAutoSlot, nextAutoSlot, nextOutAutoSlot,
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
  const settings = await getSettings(account);
  const autoEnabled = settings.fetchEnabled;
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
  // 免初始化直启：只要开启自动更新（或有未完成的手动续读）且未撞安全上限，就安排入站增量
  if ((autoEnabled || cur.incResume?.manual) && !cur.incLimitReached) {
    const nextIncAt = cur.nextIncAt > now() && inAutoSlot(cur.nextIncAt) ? cur.nextIncAt : nextAutoSlot();
    await ensure(INC_ALARM, nextIncAt);
  }
  // 进行中的手动出站同步独立续跑；日常低频定时仅在显式开启 outAutoSync 时安排
  if (out?.status === 'need_tpl' && !out.limitReached && await kvGet(keys.tpl(account))) {
    await chrome.alarms.create(alarmFor(OUT_ALARM, account), { when: now() + 3000 });
  } else if (out && !out.limitReached && (out.fullFor === 0 || out.lastAt || out.syncedId) && out.status !== 'need_tpl') {
    const retryAt = Math.max(out.resume?.nextAt || 0, out.retryAt || 0);
    const pending = out.fullFor === 0 || out.resume || ['queued', 'waiting_tab', 'reading'].includes(out.status);
    if (pending) await ensure(OUT_ALARM, retryAt);
    else if (autoEnabled && settings.outAutoSync) {
      const saved = out.nextAutoAt;
      const routine = saved > now() && inAutoSlot(saved) ? saved : nextOutAutoSlot();
      await ensure(OUT_ALARM, routine);
    }
  }
}
