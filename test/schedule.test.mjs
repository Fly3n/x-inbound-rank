// 发帖排期档位与防撞纯逻辑（src/content/schedule.js）
// 运行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/content/schedule.js';

test('排期档位：07:00–24:00 半小时一档，过去与过近的档跳过，刚发帖后自动顺延', () => {
  const { buildDaySlots, buildSchedulePlan } = globalThis.XIRSchedule;
  const at = (h, m, dayOffset = 0) => new Date(2026, 10, 20 + dayOffset, h, m, 0, 0).getTime();

  // 中午 12:00 打开：上午的都不显示，第一个档是 12:30，最后一个是 24:00
  const noon = buildDaySlots({ nowTs: at(12, 0), dayOffset: 0 });
  assert.equal(noon.slots[0].label, '12:30');
  assert.equal(noon.slots[noon.slots.length - 1].label, '24:00');

  // 12:25 打开：距离 12:30 不足 10 分钟，首个档顺延到 13:00
  const tight = buildDaySlots({ nowTs: at(12, 25), dayOffset: 0 });
  assert.equal(tight.slots[0].label, '13:00');

  // 12:19 刚发过主帖，12:20 打开：12:19 + 30m = 12:49 > 12:30，跳过 12:30 从 13:00 开始
  const justPosted = buildDaySlots({ nowTs: at(12, 20), dayOffset: 0, lastPostAt: at(12, 19) });
  assert.equal(justPosted.slots[0].label, '13:00');
  // 12:05 刚发过主帖，12:20 打开：12:05 + 30m = 12:35 > 12:30，同样跳过 12:30 从 13:00 开始
  const postedEarlier = buildDaySlots({ nowTs: at(12, 20), dayOffset: 0, lastPostAt: at(12, 5) });
  assert.equal(postedEarlier.slots[0].label, '13:00');

  // 明天完整覆盖 07:00–24:00（共 35 档）
  const plan = buildSchedulePlan({ nowTs: at(12, 0), days: 7 });
  assert.equal(plan.groups.length, 7);
  assert.equal(plan.groups[1].slots.length, 35);
  assert.equal(plan.groups[1].slots[0].label, '07:00');
  assert.equal(plan.groups[1].slots[34].label, '24:00');
});

test('排期冲突与安全间距：硬性 25 分钟防撞、优先贴合 30–40 分钟、夹缝档自动置灰与上下空档', () => {
  const { buildDaySlots, buildSchedulePlan, availableSlots, pickJitteredTime } = globalThis.XIRSchedule;
  const at = (h, m) => new Date(2026, 10, 20, h, m, 0, 0).getTime();
  const scheduled = [
    { id: '1', executeAt: at(15, 22), text: '下午茶' }, // 落在 15:30 档 [15:15, 15:45)
    { id: '2', executeAt: at(15, 45), text: '边界测试' }, // 正好 15:45，归入 16:00 档 [15:45, 16:15)，不重复占 15:30
  ];
  const day = buildDaySlots({ nowTs: at(14, 0), dayOffset: 0, scheduled });
  const byLabel = Object.fromEntries(day.slots.map((s) => [s.label, s]));
  assert.equal(byLabel['15:00'].occupied, false);
  assert.equal(byLabel['15:30'].occupied, true);
  assert.deepEqual(byLabel['15:30'].items.map((x) => x.id), ['1']);
  assert.equal(byLabel['16:00'].occupied, true);
  assert.deepEqual(byLabel['16:00'].items.map((x) => x.id), ['2']);
  assert.equal(byLabel['16:30'].occupied, false);

  // 点「具体档位 15:00」：15:22 已排，±1-3m 内（14:57-15:03）里 14:57 与 15:22 相距恰好 25 分钟，满足硬性安全间距
  for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
    const picked = pickJitteredTime(at(15, 0), { nowTs: at(14, 0), scheduled, random: () => r, mode: 'slot' });
    const diffMin = Math.round((picked - at(15, 0)) / 60_000);
    const gapMin = Math.round(Math.abs(picked - at(15, 22)) / 60_000);
    assert.ok(Math.abs(diffMin) >= 1 && Math.abs(diffMin) <= 3, `点具体档位应小幅浮动 ±1-3m，实际 ${diffMin} 分钟`);
    assert.ok(gapMin >= 25, `与 15:22 间距必须 >= 25 分钟，实际 ${gapMin} 分钟`);
  }

  // 点「下一空档 →」：前一条在 21:05（占 21:00），后面无排期 -> 落在 21:35–21:45（距 21:05 正好 30–40 分钟）
  const tightPrev = [{ id: 'p', executeAt: at(21, 5), text: '上一条' }];
  for (const r of [0, 0.3, 0.7, 0.99]) {
    const picked = pickJitteredTime(at(21, 30), { nowTs: at(20, 0), scheduled: tightPrev, random: () => r, mode: 'next' });
    const gapMin = Math.round((picked - at(21, 5)) / 60_000);
    assert.ok(gapMin >= 30 && gapMin <= 40, `应距 21:05 间隔 30-40 分钟，实际 ${gapMin} 分钟`);
  }

  // 点「下一空档 →」：前后正好差 1 小时（21:00 与 22:00）-> 居中均分落在 21:27–21:33（两边各 27–33 分钟）
  const oneHourGap = [
    { id: 'h1', executeAt: at(21, 0), text: '前' },
    { id: 'h2', executeAt: at(22, 0), text: '后' },
  ];
  for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
    const picked = pickJitteredTime(at(21, 30), { nowTs: at(20, 0), scheduled: oneHourGap, random: () => r, mode: 'next' });
    const gapPrev = Math.round((picked - at(21, 0)) / 60_000);
    const gapNext = Math.round((at(22, 0) - picked) / 60_000);
    assert.ok(gapPrev >= 27 && gapPrev <= 33 && gapNext >= 27 && gapNext <= 33, `1 小时夹缝应居中均分，实际前 ${gapPrev}m / 后 ${gapNext}m`);
  }

  // 夹缝档检测：20:50 与 21:35 之间仅隔 45 分钟，21:00 与 21:30 周围都没有 >=25m 的安全分钟，均自动置灰
  const squeezed = [
    { id: 'a', executeAt: at(20, 50), text: '前' },
    { id: 'b', executeAt: at(21, 35), text: '后' },
  ];
  const squeezedDay = buildDaySlots({ nowTs: at(20, 0), dayOffset: 0, scheduled: squeezed });
  const sqMap = Object.fromEntries(squeezedDay.slots.map((s) => [s.label, s]));
  assert.equal(sqMap['21:00'].occupied, true);
  assert.equal(sqMap['21:30'].occupied, true);
  assert.equal(sqMap['22:00'].occupied, false);

  // availableSlots 按时间顺序列出全部未占用空档，供「← 上一档」「下一空档 →」使用
  const free = availableSlots(buildSchedulePlan({ nowTs: at(20, 0), days: 2, scheduled: squeezed }));
  assert.equal(free[0].label, '20:30');
  assert.ok(!free.some((s) => s.ts === at(21, 0) || s.ts === at(21, 30)));

  // 无紧邻排期时：点具体档位做 ±1–3 分钟小幅浮动；点「下一空档」做 ±5–12 分钟自然浮动
  for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
    const pickedSlot = pickJitteredTime(at(15, 0), { nowTs: at(14, 0), scheduled: [], random: () => r, mode: 'slot' });
    const diffSlot = Math.round((pickedSlot - at(15, 0)) / 60_000);
    assert.ok(Math.abs(diffSlot) >= 1 && Math.abs(diffSlot) <= 3, `无紧邻排期点具体档位应浮动 1-3 分钟，实际 ${diffSlot}`);
    const pickedNext = pickJitteredTime(at(15, 0), { nowTs: at(14, 0), scheduled: [], random: () => r, mode: 'next' });
    const diffNext = Math.round((pickedNext - at(15, 0)) / 60_000);
    assert.ok(Math.abs(diffNext) >= 5 && Math.abs(diffNext) <= 12, `无紧邻排期点下一空档应浮动 5-12 分钟，实际 ${diffNext}`);
  }

  // 首尾档位浮动不能越出当天 07:00–24:00
  const tomorrow = buildDaySlots({ nowTs: at(12, 0), dayOffset: 1 });
  const firstSlot = tomorrow.slots[0];
  const lastSlot = tomorrow.slots.at(-1);
  const firstPicked = pickJitteredTime(firstSlot.ts, { nowTs: at(12, 0), dayStart: firstSlot.dayStart, random: () => 0 });
  const lastPicked = pickJitteredTime(lastSlot.ts, { nowTs: at(12, 0), dayStart: lastSlot.dayStart, random: () => 0.999 });
  assert.ok(firstPicked >= firstSlot.ts, '07:00 档不能向前浮动到早上 7 点前');
  assert.ok(lastPicked <= lastSlot.ts, '24:00 档不能向后浮动到次日');

  // 实际填入也要避开「现在 10 分钟」和「刚发主帖 30 分钟」两个门槛
  const boundarySlot = buildDaySlots({ nowTs: at(12, 50), scheduled: [], lastPostAt: at(12, 45) }).slots.find((slot) => slot.ts === at(13, 30));
  const boundaryPicked = pickJitteredTime(boundarySlot.ts, {
    nowTs: at(12, 50), scheduled: [], lastPostAt: at(12, 45), random: () => 0,
  });
  assert.ok(boundaryPicked >= at(13, 15), '浮动后不能早于最近主帖 30 分钟');

  // 前后参考时间差计算：有上一条和下一条都返回；后面无排期时 next 为 null；刚发主帖比更早排期近时优先显示刚发主帖
  const { neighborSummary, formatGap } = globalThis.XIRSchedule;
  const both = neighborSummary(at(22, 8), {
    scheduled: [{ id: '1', executeAt: at(21, 32) }, { id: '2', executeAt: at(22, 45) }],
  });
  assert.equal(both.prev.kind, 'scheduled');
  assert.equal(formatGap(both.prev.gapMs), '36 分钟');
  assert.equal(both.next.kind, 'scheduled');
  assert.equal(formatGap(both.next.gapMs), '37 分钟');

  const onlyPrevPost = neighborSummary(at(22, 8), {
    scheduled: [{ id: '1', executeAt: at(20, 0) }],
    lastPostAt: at(21, 30),
  });
  assert.equal(onlyPrevPost.prev.kind, 'post');
  assert.equal(formatGap(onlyPrevPost.prev.gapMs), '38 分钟');
  assert.equal(onlyPrevPost.next, null);
  assert.equal(formatGap(95 * 60_000), '1 小时 35 分钟');
});
