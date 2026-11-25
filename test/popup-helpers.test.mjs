import assert from 'node:assert/strict';
import test from 'node:test';
import {
  jobText, readSummary, formatDurationLabel, suggestFetchWindow, stepRuleValue,
  buildCsv, buildBoardExportRows, buildAllExportRows,
  fmtCompactTime, latestOf, inTaskPhase, outTaskState,
} from '../src/ui/popup-helpers.js';

test('jobText 与 readSummary：展示进行中、等待、完成与精确扫描/新增条数', () => {
  const now = new Date(2026, 10, 21, 10, 0, 0).getTime();
  assert.match(jobText({ status: 'running', rangeDays: 7, pages: 3, added: 15, oldestTs: now - 86_400_000, nextAt: now + 60_000 }, now), /进行中（范围 7 天）：已读 3 页、入库 15 条.*下一次请求约/);
  assert.match(jobText({ status: 'waiting_tab', message: '打开页面', pages: 1, added: 0 }), /等待中：打开页面/);
  assert.match(jobText({ status: 'paused', message: '暂停', pages: 2, added: 5, auto: true, nextAt: now + 120_000 }, now), /已暂停：暂停.*下一次请求约/);
  assert.match(jobText({ status: 'error', message: '失败', pages: 0, added: 0 }), /出错停止：失败/);
  assert.match(jobText({ status: 'done', reachedEnd: true, oldestTs: null, added: 0 }), /提及列表是空的/);
  assert.match(jobText({ status: 'done', reachedEnd: true, oldestTs: now, rangeDays: 30, added: 8 }), /没翻到 30 天前/);
  assert.match(jobText({ status: 'done', reachedEnd: false, oldestTs: now, rangeDays: 7, pages: 4, added: 20 }), /已完成：回溯到/);

  assert.equal(readSummary(null, null), '暂无读取记录');
  assert.equal(readSummary(now, { read: 10, added: 0 }, true), '11/21 10:00:00 · 扫描 10 条 · 新增 0 条');
  assert.match(readSummary(now, null), /11\/21 10:00 · 暂无条数/);

  assert.equal(formatDurationLabel(3), '3 小时');
  assert.equal(formatDurationLabel(24), '24 小时');
  assert.equal(formatDurationLabel(72), '3 天');
  assert.deepEqual(suggestFetchWindow(null, now), { amount: 3, unit: 'h', note: '暂无同步记录，可按需调整时长手动补读' });
  assert.equal(suggestFetchWindow(now - 20 * 60_000, now).amount, 1);
  assert.match(suggestFetchWindow(now - 20 * 60_000, now).note, /刚刚/);
  assert.deepEqual(suggestFetchWindow(now - 2.3 * 3_600_000, now), { amount: 3, unit: 'h', note: '距上次同步约 3 小时（已预填，可自调）' });
  assert.deepEqual(suggestFetchWindow(now - 36 * 3_600_000, now), { amount: 2, unit: 'd', note: '距上次同步约 2 天（已预填，可自调）' });
  assert.equal(suggestFetchWindow(now - 40 * 86_400_000, now).amount, 15);
});

test('stepRuleValue：topN 在 10 与 50 之间直接跳，其余按步长增减', () => {
  assert.equal(stepRuleValue('topN', 10, 1), 50);
  assert.equal(stepRuleValue('topN', 50, 1), 100);
  assert.equal(stepRuleValue('topN', 50, -1), 10);
  assert.equal(stepRuleValue('topN', 100, -1), 50);
  assert.equal(stepRuleValue('minCount', 2, 1), 3);
  assert.equal(stepRuleValue('minCount', 2, -1), 1);
});

test('导出构造：CSV BOM 转义、榜单导出和全量导出过滤 own 并补全 @ID', () => {
  const csv = buildCsv([['a', 'b"c'], ['1', '2']]);
  assert.equal(csv, '\uFEFF"a","b""c"\r\n"1","2"');

  const ts = new Date(2026, 10, 21, 8, 0, 0).getTime();
  const boardVisible = buildBoardExportRows([{ rank: 1, name: 'Alice', handle: 'alice', count: 5, replied: 2, last: ts }], true);
  assert.equal(boardVisible[1][4], 2);
  const boardHidden = buildBoardExportRows([{ rank: 1, name: 'Alice', handle: 'alice', count: 5, replied: 2, last: ts }], false);
  assert.equal(boardHidden[1][4], '');

  const inbound = [
    { id: '1', actor_id: '2', actor_handle: 'alice', actor_name: 'Alice', created_at: ts, target_post_id: '10', conversation_id: '10', root_mine: true, text: '你好' },
    { id: '2', actor_id: '3', actor_handle: 'bob', actor_name: 'Bob', created_at: ts - 1000, target_post_id: '20', conversation_id: '20', root_mine: false, text: '他帖下' },
    { id: '5', actor_id: '4', actor_handle: '', actor_name: '', created_at: ts - 2000, target_post_id: '25', conversation_id: '25', root_mine: true, text: '缺ID名' },
  ];
  const outAll = [
    { id: '3', created_at: ts + 1000, reply_to_id: '30', conversation_id: '30', root_user_id: '2', text: '我回Alice' },
    { id: '4', created_at: ts + 2000, reply_to_id: '10', conversation_id: '10', root_user_id: '1', own: true, text: '自回复' },
  ];
  const all = buildAllExportRows(inbound, outAll);
  assert.equal(all.length, 5, '含表头共 5 行，已过滤 own 记录');
  assert.equal(all[1][0], '我回别人');
  assert.equal(all[1][3], '@alice');
  assert.equal(all[1][4], '是');
  assert.equal(all[2][4], '是');
  assert.equal(all[3][4], '否');
  assert.equal(all[4][3], '用户编号 4', '入站记录缺少 handle 时导出数字 ID 而非空 @');
});

test('弹窗状态纯函数：紧凑时间、最新时间、两路任务阶段', () => {
  const now = new Date(2026, 10, 21, 10, 0, 0).getTime();
  assert.equal(fmtCompactTime(null, now), '未读取');
  assert.equal(fmtCompactTime(new Date(2026, 10, 21, 8, 5).getTime(), now), '今天 08:05');
  assert.equal(fmtCompactTime(new Date(2026, 10, 19, 23, 9).getTime(), now), '11/19 23:09');
  assert.equal(latestOf(null, 3, undefined, 7), 7);
  assert.equal(latestOf(null, undefined), null);
  assert.equal(inTaskPhase({ status: 'paused' }), '已暂停');
  assert.equal(inTaskPhase(null), '');
  assert.deepEqual(outTaskState({ running: { at: now - 1000, pages: 2 }, status: 'reading' }, now),
    { phase: '进行中', pending: true, progress: '进行中，本轮已读 2 页。', error: '' });
  // 超过两分钟没动静的 running 不算进行中
  assert.equal(outTaskState({ running: { at: now - 200_000, pages: 2 }, status: 'reading' }, now).phase, '');
  assert.deepEqual(outTaskState({ status: 'error', message: '失败', resume: { cursor: 'x' } }, now),
    { phase: '', pending: false, progress: '', error: '失败' });
  assert.equal(outTaskState({ status: 'ok', fullFor: 0 }, now).pending, true);
  assert.equal(outTaskState({ status: 'need_tpl' }, now).progress, '等待回复页。');
});
