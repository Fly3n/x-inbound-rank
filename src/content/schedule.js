// 发帖排期纯逻辑：固定半小时档位（每天 07:00–24:00）、硬性 25 分钟安全防撞、优先贴合相邻排期 30–40 分钟、刚发主帖 30 分钟顺延。
// 经典脚本，供内容脚本（schedule-ui.js）和单元测试共用，不依赖 DOM 或 chrome API。
const XIRSchedule = (() => {
  const MIN_MS = 60_000;
  const STEP_MIN = 30; // 半小时一档
  const START_MIN = 7 * 60; // 07:00
  const END_MIN = 24 * 60; // 24:00（次日 00:00）
  const CONFLICT_MS = 15 * MIN_MS; // 档位前后 15 分钟内已有排期即归属该档并视为已占
  const MIN_GAP_MS = 25 * MIN_MS; // 任意两条排期之间硬性最小安全间距 25 分钟
  const IDEAL_MIN_MS = 30 * MIN_MS; // 优先贴合最近前/后排期 30–40 分钟区间
  const IDEAL_MAX_MS = 40 * MIN_MS;
  const LEAD_MS = 10 * MIN_MS; // 首个可选档距当前时间至少 10 分钟（给浮动和 X 原生最小提前量留余地）
  const POST_BUFFER_MS = 30 * MIN_MS; // 刚发过主帖后 30 分钟内的档自动跳过
  const MIN_FUTURE_MS = 5 * MIN_MS; // 浮动后填入的时间至少在未来 5 分钟
  const JITTER_MIN = 5; // 无紧邻排期时的自然随机浮动下限（避开整点/半点）
  const JITTER_MAX = 12; // 无紧邻排期时的自然随机浮动上限
  const SEARCH_MAX = 15; // 围绕点击档位搜索安全分钟的最大半径（±15 分钟）

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

  function nearestGapMs(ts, scheduled = []) {
    let best = Infinity;
    for (const item of scheduled) {
      if (!item || !Number.isFinite(item.executeAt)) continue;
      const gap = Math.abs(ts - item.executeAt);
      if (gap < best) best = gap;
    }
    return best;
  }

  function isSafeCandidate(ts, { minTs, dayMin, dayMax, scheduled }) {
    if (ts < minTs || ts < dayMin || ts > dayMax) return false;
    return nearestGapMs(ts, scheduled) >= MIN_GAP_MS;
  }

  function hasSafeMinuteInSlot(slotTs, { minTs, dayMin, dayMax, scheduled }) {
    for (let d = -SEARCH_MAX; d <= SEARCH_MAX; d++) {
      if (isSafeCandidate(slotTs + d * MIN_MS, { minTs, dayMin, dayMax, scheduled })) return true;
    }
    return false;
  }

  /**
   * 首个可展示档位的最早时间戳：
   * - 必须至少晚于 now + 10 分钟（已过去的、过近的档跳过）；
   * - 若刚发过主帖（lastPostAt 在近 30 分钟内），再顺延到 lastPostAt + 30 分钟之后。
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
    const dayMin = dayStart + START_MIN * MIN_MS;
    const dayMax = dayStart + END_MIN * MIN_MS;
    const minTs = dayOffset === 0 ? earliestAllowedTs(nowTs, lastPostAt) : 0;
    const slots = [];
    for (let m = START_MIN; m <= END_MIN; m += STEP_MIN) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(m / 60), m % 60, 0, 0);
      const ts = d.getTime();
      if (dayOffset === 0 && ts < minTs) continue;
      const items = conflictsFor(ts, scheduled);
      let tooClose = false;
      let occupied = items.length > 0;
      if (!occupied && !hasSafeMinuteInSlot(ts, { minTs: Math.max(nowTs + MIN_FUTURE_MS, minTs), dayMin, dayMax, scheduled })) {
        occupied = true;
        tooClose = true;
        for (const item of scheduled) {
          if (item && Number.isFinite(item.executeAt) && Math.abs(item.executeAt - ts) < MIN_GAP_MS + SEARCH_MAX * MIN_MS) {
            items.push(item);
          }
        }
        items.sort((a, b) => Math.abs(a.executeAt - ts) - Math.abs(b.executeAt - ts));
      }
      slots.push({
        ts,
        dayStart,
        minuteOfDay: m,
        label: formatSlotLabel(m),
        isHour: m % 60 === 0,
        occupied,
        tooClose,
        items,
      });
    }
    return { dayOffset, dayStart, title: formatDayTitle(dayStart, nowTs), slots };
  }

  /**
   * 生成今天 + 未来 days-1 天（默认共 7 天）的档期视图：
   * - primary：首个有档位的日期（今天或明天）
   * - groups：按天分组的所有档位（去掉空天，供「更多档期」下拉列表使用）
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

  /** 按时间顺序提取所有可用空档，供「← 上一档」「下一空档 →」快捷切换使用。 */
  function availableSlots(plan) {
    const out = [];
    for (const g of plan?.groups || []) {
      for (const s of g.slots || []) if (!s.occupied) out.push(s);
    }
    return out;
  }

  /**
   * 点击某个空档 slotTs 后，计算实际填入 X 原生表单的安全时间（精确到分钟）：
   * - 硬性保证：>= now + 5m、>= earliestAllowedTs、不越出 07:00–24:00、与所有已有排期至少相距 25 分钟；
   * - 若附近 60 分钟内有已有排期，优先挑选与最近排期距离落在 30–40 分钟区间内的随机分钟（尽量避开整点/半点）；
   * - 若周围无紧邻排期，则在 [-12..-5, +5..+12] 分钟内随机挑选（自然避开整点/半点）。
   */
  function pickJitteredTime(slotTs, { nowTs = Date.now(), scheduled = [], random = Math.random, dayStart = null, lastPostAt = 0 } = {}) {
    const minTs = Math.max(nowTs + MIN_FUTURE_MS, earliestAllowedTs(nowTs, lastPostAt));
    let slotDay = dayStart;
    if (!Number.isFinite(slotDay)) {
      const d = new Date(slotTs);
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      slotDay = d.getHours() === 0 && d.getMinutes() === 0 ? midnight - 86_400_000 : midnight;
    }
    const dayMin = slotDay + START_MIN * MIN_MS;
    const dayMax = slotDay + END_MIN * MIN_MS;
    const pickRandom = (list) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];

    const safeAll = [];
    for (let d = -SEARCH_MAX; d <= SEARCH_MAX; d++) {
      const ts = slotTs + d * MIN_MS;
      if (isSafeCandidate(ts, { minTs, dayMin, dayMax, scheduled })) {
        safeAll.push({ d, ts, gap: nearestGapMs(ts, scheduled) });
      }
    }
    const hasTightNeighbor = nearestGapMs(slotTs, scheduled) <= 60 * MIN_MS;
    if (hasTightNeighbor) {
      const idealNonZero = safeAll.filter((c) => c.d !== 0 && c.gap >= IDEAL_MIN_MS && c.gap <= IDEAL_MAX_MS);
      if (idealNonZero.length) return pickRandom(idealNonZero).ts;
      const idealAny = safeAll.filter((c) => c.gap >= IDEAL_MIN_MS && c.gap <= IDEAL_MAX_MS);
      if (idealAny.length) return pickRandom(idealAny).ts;
    }
    const natural = safeAll.filter((c) => Math.abs(c.d) >= JITTER_MIN && Math.abs(c.d) <= JITTER_MAX);
    if (natural.length) return pickRandom(natural).ts;
    const nonZero = safeAll.filter((c) => c.d !== 0);
    if (nonZero.length) return pickRandom(nonZero).ts;
    if (safeAll.length) return pickRandom(safeAll).ts;
    // 兜底：向后微调到合法分钟
    const fallback = Math.ceil(minTs / MIN_MS) * MIN_MS;
    return Math.max(slotTs, fallback);
  }

  return {
    STEP_MIN,
    START_MIN,
    END_MIN,
    CONFLICT_MS,
    MIN_GAP_MS,
    IDEAL_MIN_MS,
    IDEAL_MAX_MS,
    LEAD_MS,
    POST_BUFFER_MS,
    formatSlotLabel,
    formatTime,
    formatDayTitle,
    conflictsFor,
    earliestAllowedTs,
    buildDaySlots,
    buildSchedulePlan,
    availableSlots,
    pickJitteredTime,
  };
})();
if (typeof globalThis !== 'undefined') globalThis.XIRSchedule = XIRSchedule;
