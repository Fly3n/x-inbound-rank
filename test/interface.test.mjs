import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('弹窗提供固定入口，名次标签不再显示鼠标悬浮说明', () => {
  const html = read('src/ui/popup.html');
  const popup = read('src/ui/popup.js');
  assert.match(html, /id="pin"/);
  assert.match(popup, /new URLSearchParams\(location\.search\)\.has\('pinned'\)/);
  assert.match(popup, /call\('openPinned'\)/);

  const content = read('src/content/content.js');
  const css = read('src/content/badge.css');
  assert.doesNotMatch(content, /xir-tip|mouseenter|mouseleave/);
  assert.doesNotMatch(css, /\.xir-tip/);
});
