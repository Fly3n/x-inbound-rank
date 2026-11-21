import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../scripts/live-bridge.mjs';

const silent = { info() {}, error() {} };

test('本机桥：健康检查、接收快照、写主文件和摘要', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xir-bridge-'));
  const bridge = await startServer({ port: 0, dir, log: silent });
  try {
    const health = await fetch(`http://127.0.0.1:${bridge.port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'xir-live-bridge');

    const payload = {
      schemaVersion: 1,
      kind: 'xir-local-snapshot',
      source: 'live',
      exportedAt: '2026-11-21T03:04:05.000Z',
      extensionVersion: '0.23.1',
      accounts: { a: { handle: 'alice' } },
      data: {
        a: {
          meta: { handle: 'alice' },
          inbound: [{ id: '1' }],
          outbound: [{ id: '2' }],
        },
      },
      storage: { accounts: { a: { handle: 'alice' } } },
    };
    const response = await fetch(`http://127.0.0.1:${bridge.port}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);

    const saved = JSON.parse(await readFile(path.join(dir, 'xir-live.json'), 'utf8'));
    assert.equal(saved.source, 'live');
    assert.equal(saved.data.a.inbound.length, 1);
    assert.equal(saved.bridge.bytes > 0, true);
    assert.match(saved.bridge.receivedAt, /^\d{4}-\d{2}-\d{2}T/);

    const meta = JSON.parse(await readFile(path.join(dir, 'xir-live.meta.json'), 'utf8'));
    assert.deepEqual(meta.accounts, [{ account: 'a', handle: 'alice', inbound: 1, outbound: 1 }]);
    assert.equal(meta.extensionVersion, '0.23.1');
  } finally {
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('本机桥：拒绝坏 JSON 和非扩展来源', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xir-bridge-'));
  const bridge = await startServer({ port: 0, dir, log: silent });
  try {
    const bad = await fetch(`http://127.0.0.1:${bridge.port}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(bad.status, 400);

    const foreign = await fetch(`http://127.0.0.1:${bridge.port}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: '{}',
    });
    assert.equal(foreign.status, 403);
  } finally {
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
});
