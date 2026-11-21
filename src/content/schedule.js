// 发帖排期纯逻辑：固定半小时档位（每天 07:00–24:00）、±15 分钟冲突判定、首个可用档顺延、点击后大范围随机浮动。
// 经典脚本，供内容脚本（schedule-ui.js）和单元测试共用，不依赖 DOM 或 chrome API。
const XIRSchedule = (() => {
  const MIN_MS = 60_000;
  const STEP_MIN = 30; // 半小时一档
  const START_MIN = 7 * 60; // 07:00
  const END_MIN = 24 * 60; // 24:00（次日 00:00）
  const CONFLICT_MS = 15 * MIN_MS; // 档位前后 15 分钟内已有排期即视为已占
  const LEAD_MS = 10 * MIN_MS; // 首个可选档距当前时间至少 10 分钟（给浮动和 X 原生最小提前量留余地）
  const POST_BUFFER_MS = 15 * MIN_MS; // 刚发过帖后 15 分钟内的档自动跳过
  const MIN_FUTURE_MS = 5 * MIN_MS; // 浮动后填入的时间至少在未来 5 分钟
  const JITTER_MIN = 5; // 至少浮动 5 分钟，避开整点和半点附近
  const JITTER_MAX = 20; // 最多浮动 20 分钟，模拟真人不会总卡在同一分钟

  const pad2 = (n) => String(n).padStart(2, '0');
  const startOfDay = (ts) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };

  /** 一天内的档位标签：24*60 显示为 '24:00'，其余 'HH:MM'。 */
  function formatSlotLabel(minuteOfDay) {
    if (minuteOfDay === END_MIN) return '24:00';
    return `${pad2(Math.floor(minuteOfDay / 60))}:${pad2(minuteOfDay % 60)}`;
  }

  /** 格式化具体时间点，供悬停提示和状态栏使用。 */
  function formatTime(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** 日期分组标题：今天 / 明天 / 后天 / M月D日 周X。 */
  function formatDayTitle(dayStartTs, nowTs) {
    const today = startOfDay(nowTs);
    const diff = Math.round((dayStartTs - today) / 86_400_000);
    const d = new Date(dayStartTs);
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    if (diff === 0) return `今天（${md}）`;
    if (diff === 1) return `明天（${md} ${wk}）`;
    if (diff === 2) return `后天（${md} ${wk}）`;
    return `${md} ${wk}`;
  }

  /**
   * 某档位 slotTs 是否被已有排期占用。
   * 判定窗口为半开区间 [slotTs - 15m, slotTs + 15m)，确保任意排期时间精确归属且仅归属一个半小时档，
   * 不会在 15 分边界把相邻两个档都误判为已占。
   */
  function conflictsFor(slotTs, scheduled = []) {
    const hits = [];
    for (const item of scheduled) {
      if (!item || !Number.isFinite(item.executeAt)) continue;
      const diff = item.executeAt - slotTs;
      if (diff >= -CONFLICT_MS && diff < CONFLICT_MS) hits.push(item);
    }
    hits.sort((a, b) => a.executeAt - b.executeAt);
    return hits;
  }

  /**
   * 首个可展示档位的最早时间戳：
   * - 必须至少晚于 now + 10 分钟（已过去的、过近的档跳过）；
   * - 若刚发过帖（lastPostAt 在近 15 分钟内），再顺延到 lastPostAt + 15 分钟之后。
   */
  function earliestAllowedTs(nowTs, lastPostAt = 0) {
    const fromNow = nowTs + LEAD_MS;
    const fromPost = lastPostAt && lastPostAt <= nowTs && nowTs - lastPostAt < POST_BUFFER_MS ? lastPostAt + POST_BUFFER_MS : 0;
    return Math.max(fromNow, fromPost);
  }

  /**
   * 生成某一天（从 dayOffset = 0 今天起）的档位列表。
   * 今天自动过滤掉早于 earliestAllowedTs 的档位；未来日期展示完整 07:00–24:00。
   */
  function buildDaySlots({ nowTs = Date.now(), dayOffset = 0, scheduled = [], lastPostAt = 0 } = {}) {
    const base = new Date(startOfDay(nowTs));
    base.setDate(base.getDate() + dayOffset);
    const dayStart = base.getTime();
    const minTs = dayOffset === 0 ? earliestAllowedTs(nowTs, lastPostAt) : 0;
    const slots = [];
    for (let m = START_MIN; m <= END_MIN; m += STEP_MIN) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(m / 60), m % 60, 0, 0);
      const ts = d.getTime();
      if (dayOffset === 0 && ts < minTs) continue;
      const items = conflictsFor(ts, scheduled);
      slots.push({
        ts,
        minuteOfDay: m,
        label: formatSlotLabel(m),
        isHour: m % 60 === 0,
        occupied: items.length > 0,
        items,
      });
    }
    return { dayOffset, dayStart, title: formatDayTitle(dayStart, nowTs), slots };
  }

  /**
   * 生成今天 + 未来 days-1 天（默认共 7 天）的档期视图：
   * - today：当天剩余档位（若今天已无剩余档，仍保留空数组，界面可直接展示明天或下拉）
   * - days：按天分组的所有档位（去掉空天，供「更多档期」下拉列表使用）
   */
  function buildSchedulePlan({ nowTs = Date.now(), days = 7, scheduled = [], lastPostAt = 0 } = {}) {
    const groups = [];
    for (let i = 0; i < days; i++) {
      const g = buildDaySlots({ nowTs, dayOffset: i, scheduled, lastPostAt });
      if (g.slots.length) groups.push(g);
    }
    const primary = groups[0] || buildDaySlots({ nowTs, dayOffset: 1, scheduled, lastPostAt });
    return { primary, groups };
  }

  /**
   * 点击某个空档 slotTs 后，计算实际填入 X 原生表单的浮动时间（精确到分钟）：
   * - 默认在 [-20..-5, +5..+20] 分钟内随机挑选，避开整点和半点附近；
   * - 保证结果 >= nowTs + 5 分钟；
   * - 保证与已有排期距离 >= 15 分钟（不撞档）；
   * - 若所有随机候选都不满足，按最接近 slotTs 的合法分钟兜底。
   */
  function pickJitteredTime(slotTs, { nowTs = Date.now(), scheduled = [], random = Math.random } = {}) {
    const minTs = nowTs + MIN_FUTURE_MS;
    const safe = (ts) => {
      if (ts < minTs) return false;
      for (const item of scheduled) {
        if (item && Number.isFinite(item.executeAt) && Math.abs(ts - item.executeAt) < CONFLICT_MS) return false;
      }
      return true;
    };
    const offsets = [];
    for (let d = JITTER_MIN; d <= JITTER_MAX; d++) {
      offsets.push(-d, d);
    }
    const valid = offsets.map((d) => slotTs + d * MIN_MS).filter(safe);
    if (valid.length) {
      const idx = Math.min(valid.length - 1, Math.floor(random() * valid.length));
      return valid[idx];
    }
    if (safe(slotTs)) return slotTs;
    // 兜底：向后微调到合法分钟
    const fallback = Math.ceil(minTs / MIN_MS) * MIN_MS;
    return Math.max(slotTs, fallback);
  }

  return {
    STEP_MIN,
    START_MIN,
    END_MIN,
    CONFLICT_MS,
    LEAD_MS,
    POST_BUFFER_MS,
    formatSlotLabel,
    formatTime,
    formatDayTitle,
    conflictsFor,
    earliestAllowedTs,
    buildDaySlots,
    buildSchedulePlan,
    pickJitteredTime,
  };
})();
if (typeof globalThis !== 'undefined') globalThis.XIRSchedule = XIRSchedule;
