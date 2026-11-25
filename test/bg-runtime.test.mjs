// 后台风控节奏与模拟真人停顿（src/bg/runtime.js）
// 运行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';

test('模拟真人节律：连续平滑分布无断层、低于空闲回收线，可选出站同步间隔不少于 48 小时', async () => {
  const { PACE, humanIncDelay, humanBackfillDelay, humanRestDelay, humanBatchPages, nextOutAutoSlot } = await import('../src/bg/runtime.js');
  let incMidGapHits = 0;
  let backfillMidGapHits = 0;
  for (let i = 0; i < 400; i++) {
    const incDelay = humanIncDelay();
    assert.ok(incDelay >= 4_000 && incDelay < 28_000, `增量页间停顿 ${incDelay}ms 须严格在 [4s, 28s)`);
    if (incDelay >= 10_000 && incDelay < 12_000) incMidGapHits++;
    const backfillDelay = humanBackfillDelay();
    assert.ok(backfillDelay >= 15_000 && backfillDelay < 110_000, `补历史停顿 ${backfillDelay}ms 应在预期区间内`);
    if (backfillDelay >= 28_000 && backfillDelay < 30_000) backfillMidGapHits++;
    const rest = humanRestDelay();
    assert.ok(rest >= 180_000 && rest < 300_000, `批间休息 ${rest}ms 应在 [180s, 300s)`);
    const batch = humanBatchPages();
    assert.ok(batch >= 8 && batch <= 12, `补历史每批页数 ${batch} 应在 8–12 页`);
  }
  assert.ok(incMidGapHits > 0, '增量停顿 10–12s 区间不再存在零概率断层');
  assert.ok(backfillMidGapHits > 0, '补历史停顿 28–30s 区间不再存在零概率断层');
  const base = new Date(2026, 10, 21, 9, 0, 0, 0).getTime();
  const nextOut = nextOutAutoSlot(base);
  assert.ok(nextOut - base >= PACE.outAutoGapMs, '可选低频出站自动同步间隔至少 48 小时');
});
