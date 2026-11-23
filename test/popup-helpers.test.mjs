import assert from 'node:assert/strict';
import test from 'node:test';
import {
  jobText, readSummary, stepRuleValue,
  buildCsv, buildBoardExportRows, buildAllExportRows,
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
