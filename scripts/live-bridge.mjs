#!/usr/bin/env node
// 开发用本机接收器：只监听 127.0.0.1，把扩展推来的快照写成 .local/xir-live.json。
// 不读 X、不抓网页、不向外部网络发请求。

import http from 'node:http';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { snapshotSummary, diagnosticsSummary } from '../src/snapshot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = path.join(ROOT, '.local');
const DEFAULT_PORT = 17321;
const MAX_BODY = 128 * 1024 * 1024;

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

function sendJson(res, status, value, req) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json;charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(req),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY) {
      const error = new Error('body too large');
      error.statusCode = 413;
      reject(error);
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const error = new Error('body too large');
        error.statusCode = 413;
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function atomicWrite(file, text) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

export async function startServer({ port = DEFAULT_PORT, dir = DEFAULT_DIR, log = console } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid bridge port');
  await mkdir(dir, { recursive: true });

  const server = http.createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin && !origin.startsWith('chrome-extension://')) {
        sendJson(res, 403, { ok: false, error: 'origin not allowed' }, req);
        return;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, service: 'xir-live-bridge', at: new Date().toISOString(), dir }, req);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/ingest') {
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid json' }, req);
          return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data) ||
            !payload.accounts || typeof payload.accounts !== 'object' || Array.isArray(payload.accounts)) {
          sendJson(res, 400, { ok: false, error: 'invalid snapshot' }, req);
          return;
        }

        const receivedAt = new Date().toISOString();
        const enriched = { ...payload, bridge: { receivedAt, bytes: Buffer.byteLength(raw) } };
        const text = JSON.stringify(enriched);
        const live = path.join(dir, 'xir-live.json');
        const meta = path.join(dir, 'xir-live.meta.json');
        await atomicWrite(live, text);

        const summary = {
          receivedAt,
          bytes: Buffer.byteLength(text),
          exportedAt: payload.exportedAt || null,
          extensionVersion: payload.extensionVersion || null,
          source: payload.source || null,
          accounts: snapshotSummary(payload.data),
          diagnostics: diagnosticsSummary(payload.storage),
        };
        await atomicWrite(meta, `${JSON.stringify(summary, null, 2)}\n`);
        log.info?.(`[xir-bridge] ${receivedAt} ${summary.source || 'unknown'} ${summary.accounts.length} accounts ${summary.bytes} bytes`);
        sendJson(res, 200, { ok: true, receivedAt, bytes: summary.bytes, accounts: summary.accounts.length }, req);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' }, req);
    } catch (e) {
      log.error?.(`[xir-bridge] ${e?.message || e}`);
      if (!res.headersSent) sendJson(res, e?.statusCode || 500, { ok: false, error: 'internal error' }, req);
      else res.destroy();
    }
  });
  server.requestTimeout = 120_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  log.info?.(`[xir-bridge] listening on http://127.0.0.1:${actualPort} -> ${dir}`);

  return {
    server,
    port: actualPort,
    dir,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const port = Number(process.env.XIR_BRIDGE_PORT || DEFAULT_PORT);
  const dir = process.env.XIR_BRIDGE_DIR ? path.resolve(process.env.XIR_BRIDGE_DIR) : DEFAULT_DIR;
  startServer({ port, dir }).catch((e) => {
    console.error(`[xir-bridge] failed: ${e?.message || e}`);
    process.exitCode = 1;
  });
}
