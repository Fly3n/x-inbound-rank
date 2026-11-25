import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('弹窗不再提供固定入口和前端诊断面板且设置页收敛高级区，名次标签不再显示鼠标悬浮说明', () => {
  const html = read('src/ui/popup.html');
  const popup = read('src/ui/popup.js');
  assert.doesNotMatch(html, /id="pin"|固定为独立窗口/);
  assert.doesNotMatch(html, /id="diagnostics"|diagnoseMentions/);
  assert.match(html, /id="advanced"/);
  assert.match(html, /id="inReadSummary"/);
  assert.match(html, /id="outReadSummary"/);
  assert.match(html, /id="inLastAt"/);
  assert.match(html, /id="outLastAt"/);
  assert.doesNotMatch(html, /id="backfillCard"|id="updateSummary"/);
  assert.match(html, /id="tapInEnabled"/);
  assert.match(html, /id="tapOutEnabled"/);
  assert.doesNotMatch(html, /id="fetchEnabled"|id="outAutoSync"/);
  assert.match(html, /id="fetchAmount"/);
  assert.match(html, /id="fetchUnit"/);
  assert.match(html, /id="fetchInBtn"/);
  assert.match(html, /id="fetchOutBtn"/);
  assert.ok(html.indexOf('id="tapInEnabled"') < html.indexOf('id="fetchInBtn"'), '旁听收集开关应在手动补读按钮之前');
  assert.ok(html.indexOf('id="fetchInBtn"') < html.indexOf('id="advanced"'), '手动补读按钮应在高级折叠区之前');
  assert.ok(html.indexOf('id="fetchOutBtn"') < html.indexOf('id="advanced"'), '我回别人手动补读按钮应在高级折叠区之前');
  assert.doesNotMatch(html, /<summary>数据怎么读取<\/summary>|<summary>统计口径与读取频率<\/summary>|<summary>本机存储（两份数据合计）<\/summary>/);
  assert.doesNotMatch(popup, /pinned|openPinned/);
  assert.doesNotMatch(popup, /diagnoseMentions|getDiagnostics/);

  const content = read('src/content/content.js');
  const css = read('src/content/badge.css');
  assert.doesNotMatch(content, /xir-tip|mouseenter|mouseleave/);
  assert.doesNotMatch(css, /\.xir-tip/);
});
