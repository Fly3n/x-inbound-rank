import assert from 'node:assert/strict';
import test from 'node:test';
import {
  jobText, readSummary, formatDiagnosticRow, formatDiagnosisResult, stepRuleValue,
  buildCsv, buildBoardExportRows, buildAllExportRows, buildDiagnosticReport,
} from '../src/ui/popup-helpers.js';

test('jobText 与 readSummary：展示进行中、等待、完成和零新增已有条数', () => {
  const now = new Date(2026, 10, 21, 10, 0, 0).getTime();
  assert.match(jobText({ status: 'running', rangeDays: 7, pages: 3, added: 15, oldestTs: now - 86_400_000, nextAt: now + 60_000 }, now), /进行中（范围 7 天）：已读 3 页、入库 15 条.*下一次请求约/);
  assert.match(jobText({ status: 'waiting_tab', message: '打开页面', pages: 1, added: 0 }), /等待中：打开页面/);
  assert.match(jobText({ status: 'paused', message: '暂停', pages: 2, added: 5, auto: true, nextAt: now + 120_000 }, now), /已暂停：暂停.*下一次请求约/);
  assert.match(jobText({ status: 'error', message: '失败', pages: 0, added: 0 }), /出错停止：失败/);
  assert.match(jobText({ status: 'done', reachedEnd: true, oldestTs: null, added: 0 }), /提及列表是空的/);
  assert.match(jobText({ status: 'done', reachedEnd: true, oldestTs: now, rangeDays: 30, added: 8 }), /没翻到 30 天前/);
  assert.match(jobText({ status: 'done', reachedEnd: false, oldestTs: now, rangeDays: 7, pages: 4, added: 20 }), /已完成：回溯到/);

  assert.equal(readSummary(null, null), '暂无读取记录');
  assert.match(readSummary(now, { read: 10, added: 0 }, true), /11\/21 10:00:00 · 扫描 10 条 · 新增 0 条 · 已有 10 条/);
  assert.match(readSummary(now, null), /11\/21 10:00 · 暂无条数/);
});

test('stepRuleValue：topN 在 10 与 50 之间直接跳，其余按步长增减', () => {
  assert.equal(stepRuleValue('topN', 10, 1), 50);
  assert.equal(stepRuleValue('topN', 50, 1), 100);
  assert.equal(stepRuleValue('topN', 50, -1), 10);
  assert.equal(stepRuleValue('topN', 100, -1), 50);
  assert.equal(stepRuleValue('minCount', 2, 1), 3);
  assert.equal(stepRuleValue('minCount', 2, -1), 1);
});

test('诊断格式化与报告构建', () => {
  const now = new Date(2026, 10, 21, 9, 30, 0).getTime();
  assert.equal(formatDiagnosticRow({ at: now, event: 'request', source: 'mentions-graphql', status: 200 }), '11/21 09:30 · 读取请求 · 别人回我 · 新接口 · HTTP 200');
  assert.equal(formatDiagnosticRow({ at: now, event: 'request', source: 'replies', outcome: 'no_tab' }), '11/21 09:30 · 读取请求 · 我回别人 · X 页面未连接');
  assert.equal(formatDiagnosticRow({ at: now, event: 'scheduled_sync', source: 'scheduled', outcome: 'ok', count: 3 }), '11/21 09:30 · 同步排期 · 发帖排期 · 成功 · 共 3 条');

  assert.match(formatDiagnosisResult({ pages: 2, matches: 4, reason: 'post_found', target: { reason: 'accepted_own_root' }, stored: true }), /已找到目标；解析判定 accepted_own_root，本机已有这条记录/);
  assert.match(formatDiagnosisResult({ pages: 5, matches: 0, reason: 'page_limit' }), /已达到单次回查页数上限/);

  const report = buildDiagnosticReport([{ event: 'ping' }], { exportedAt: '2026-11-21T00:00:00.000Z', extensionVersion: '0.30.2', platform: 'MacIntel', browser: ['Chrome/130'], timezone: 'Asia/Shanghai' });
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.extensionVersion, '0.30.2');
  assert.deepEqual(report.events, [{ event: 'ping' }]);
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
  ];
  const outAll = [
    { id: '3', created_at: ts + 1000, reply_to_id: '30', conversation_id: '30', root_user_id: '2', text: '我回Alice' },
    { id: '4', created_at: ts + 2000, reply_to_id: '10', conversation_id: '10', root_user_id: '1', own: true, text: '自回复' },
  ];
  const all = buildAllExportRows(inbound, outAll);
  assert.equal(all.length, 4, '含表头共 4 行，已过滤 own 记录');
  assert.equal(all[1][0], '我回别人');
  assert.equal(all[1][3], '@alice');
  assert.equal(all[1][4], '是');
  assert.equal(all[2][4], '是');
  assert.equal(all[3][4], '否');
});
