#!/usr/bin/env node
// 开发用弹窗预览服务：仅监听 127.0.0.1，读取真实 popup.html 并注入内存里的 chrome mock，方便改 UI 后直接核对样式与交互。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = path.join(ROOT, 'src');
const DEFAULT_PORT = 17322;

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'application/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function buildMockShim(version) {
  return `<script type="module">
import { cleanRules, DEFAULT_RULES, ranking, repliesOf, DAY_MS, WINDOWS, INIT_WINDOWS } from '../rank.js';

const NOW = Date.now();
const accountKey = 'uid-10001';
const state = {
  accounts: {
    [accountKey]: { handle: 'flynn_demo', userId: '10001', enabled: true, activation: 1 },
  },
  settings: {
    [accountKey]: { ...DEFAULT_RULES },
  },
  inbound: [
    { id: '901', actor_id: '2001', actor_handle: 'alice', actor_name: 'Alice', actor_avatar: '', created_at: NOW - 2 * 3600_000, target_post_id: '10', conversation_id: '10', root_mine: true, text: '很认同这个拆解！' },
    { id: '902', actor_id: '2001', actor_handle: 'alice', actor_name: 'Alice', actor_avatar: '', created_at: NOW - 26 * 3600_000, target_post_id: '11', conversation_id: '11', root_mine: true, text: '补充一个边界条件' },
    { id: '903', actor_id: '2002', actor_handle: 'bob', actor_name: 'Bob', actor_avatar: '', created_at: NOW - 48 * 3600_000, target_post_id: '12', conversation_id: '12', root_mine: true, text: '实测有效' },
    { id: '904', actor_id: '2002', actor_handle: 'bob', actor_name: 'Bob', actor_avatar: '', created_at: NOW - 72 * 3600_000, target_post_id: '13', conversation_id: '13', root_mine: true, text: '谢谢分享' },
  ],
  outbound: [
    { id: '951', created_at: NOW - 3600_000, reply_to_id: '701', conversation_id: '701', root_user_id: '2001', root_handle: 'alice', text: '谢谢补充！' },
  ],
  cursor: {
    [accountKey]: {
      syncedId: '904',
      inLastReadAt: NOW - 15 * 60_000,
      inLastReadCounts: { read: 12, added: 1 },
      lastBackfill: { rangeDays: 7, finishedAt: NOW - 2 * DAY_MS, oldestTs: NOW - 8 * DAY_MS, reachedEnd: false },
      out: { status: 'ok', lastAt: NOW - 20 * 60_000, lastReadAt: NOW - 20 * 60_000, lastReadCounts: { read: 5, added: 0 }, coverTs: NOW - 8 * DAY_MS, lastFullAt: NOW - 2 * DAY_MS, lastFullDays: 7, schema: 2, reachedEnd: false },
    },
  },
};

const listeners = new Set();
const span = (rows) => rows.reduce((d, e) => ({ count: d.count + 1, from: Math.min(d.from ?? e.created_at, e.created_at), to: Math.max(d.to ?? e.created_at, e.created_at) }), { count: 0, from: null, to: null });

window.chrome = {
  runtime: {
    getManifest: () => ({ version: ${JSON.stringify(version)} }),
    async sendMessage(msg) {
      const account = msg.account || accountKey;
      const settings = state.settings[account] || { ...DEFAULT_RULES };
      const cur = state.cursor[account] || {};
      switch (msg.type) {
        case 'getState':
          return { accounts: state.accounts, active: { userId: '10001', handle: 'flynn_demo', account: accountKey }, online: [accountKey] };
        case 'getAccountState':
          return { settings, cursor: cur, job: null, alert: null, db: { in: span(state.inbound), out: span(state.outbound) }, domWarning: null, tplAt: NOW - DAY_MS, mentionsApi: 'gql' };
        case 'getBoard':
          return ranking(state.inbound, settings, NOW, state.outbound, true);
        case 'getReplies':
          return repliesOf(state.inbound, msg.actorId, settings, NOW, 50, state.outbound);
        case 'exportAll':
          return { inbound: state.inbound, out: state.outbound };
        case 'setSettings': {
          if ('windowDays' in msg.patch && !WINDOWS.includes(msg.patch.windowDays)) return { error: '无效的榜单范围' };
          if ('initDays' in msg.patch && !INIT_WINDOWS.includes(msg.patch.initDays)) return { error: '无效的初始化范围' };
          const merged = { ...settings, ...msg.patch };
          state.settings[account] = cleanRules(merged);
          for (const fn of listeners) fn({ [\`settings:\${account}\`]: { newValue: state.settings[account] } }, 'local');
          return { ok: true };
        }
        case 'manualFetchIn':
          cur.inLastReadAt = Date.now();
          cur.inLastReadCounts = { read: 12, added: 0 };
          return { ok: true, readAt: { inbound: cur.inLastReadAt } };
        case 'manualFetchOut':
          cur.out = { ...cur.out, lastReadAt: Date.now(), lastReadCounts: { read: 5, added: 0 } };
          return { ok: true, readAt: { outbound: cur.out.lastReadAt } };
        default:
          return { ok: true };
      }
    },
  },
  storage: {
    onChanged: { addListener: (fn) => listeners.add(fn) },
  },
};
</script>`;
}

export async function createPreviewServer({ host = '127.0.0.1', port = DEFAULT_PORT } = {}) {
  if (host !== '127.0.0.1') throw new Error('popup-preview only allows 127.0.0.1');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid preview port');

  const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://${host}`);
      const pathname = decodeURIComponent(reqUrl.pathname);

      if (pathname === '/') {
        res.writeHead(302, { Location: '/src/ui/popup-preview.html' });
        res.end();
        return;
      }

      if (pathname === '/src/ui/popup-preview.html') {
        const rawHtml = await readFile(path.join(SRC_ROOT, 'ui', 'popup.html'), 'utf8');
        const marker = '<script type="module" src="popup.js"></script>';
        if (!rawHtml.includes(marker)) throw new Error('popup.html script marker missing');
        const html = rawHtml.replace(marker, `${buildMockShim(manifest.version)}\n  ${marker}`);
        res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (!pathname.startsWith('/src/')) {
        res.writeHead(403, { 'Content-Type': 'text/plain;charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      const rel = pathname.slice('/src/'.length);
      const filePath = path.resolve(SRC_ROOT, rel);
      if (filePath !== SRC_ROOT && !filePath.startsWith(SRC_ROOT + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain;charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      const body = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) {
      if (e?.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain;charset=utf-8' });
      res.end(String(e?.message || e));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  const actualPort = addr && typeof addr === 'object' ? addr.port : port;
  const url = `http://${host}:${actualPort}/src/ui/popup-preview.html`;

  return {
    server,
    port: actualPort,
    url,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  createPreviewServer({ port }).then(
    ({ url }) => console.log(`[xir-popup-preview] ${url}`),
    (e) => {
      console.error(`[xir-popup-preview] failed: ${e?.message || e}`);
      process.exitCode = 1;
    },
  );
}
