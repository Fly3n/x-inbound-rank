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
  assert.doesNotMatch(html, /id="updateSummary"/);
  assert.ok(html.indexOf('id="start"') < html.indexOf('id="advanced"'), '补历史按钮应在主卡片中、位于高级折叠区之前');
  assert.ok(html.indexOf('id="outSync"') < html.indexOf('id="advanced"'), '我回别人补历史按钮应在主卡片中、位于高级折叠区之前');
  assert.doesNotMatch(html, /<summary>数据怎么读取<\/summary>|<summary>统计口径与读取频率<\/summary>|<summary>本机存储（两份数据合计）<\/summary>/);
  assert.doesNotMatch(popup, /pinned|openPinned/);
  assert.doesNotMatch(popup, /diagnoseMentions|getDiagnostics/);

  const content = read('src/content/content.js');
  const css = read('src/content/badge.css');
  assert.doesNotMatch(content, /xir-tip|mouseenter|mouseleave/);
  assert.doesNotMatch(css, /\.xir-tip/);
});
