import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewServer } from '../scripts/popup-preview.mjs';

test('弹窗本地预览服务：提供注入 mock 的 HTML、静态资源并拒绝路径穿越', async () => {
  const preview = await createPreviewServer({ port: 0 });
  try {
    const base = `http://127.0.0.1:${preview.port}`;

    const rootRes = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(rootRes.status, 302);
    assert.equal(rootRes.headers.get('location'), '/src/ui/popup-preview.html');

    const htmlRes = await fetch(`${base}/src/ui/popup-preview.html`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /window\.chrome =/);
    assert.match(html, /<script type="module" src="popup\.js"><\/script>/);

    for (const asset of ['/src/ui/popup.js', '/src/ui/popup-helpers.js', '/src/content/badge.css']) {
      const res = await fetch(`${base}${asset}`);
      assert.equal(res.status, 200, `${asset} 应正常返回 200`);
    }

    for (const bad of ['/src/../package.json', '/src/%2e%2e/package.json']) {
      const traversal = await fetch(`${base}${bad}`);
      assert.equal(traversal.status, 403, `${bad} 应拒绝访问`);
    }
  } finally {
    await preview.close();
  }
});
