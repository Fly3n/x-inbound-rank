import test from 'node:test';
import assert from 'node:assert/strict';

import { SNAPSHOT_SCHEMA, buildSnapshot, snapshotFilename, snapshotSummary } from '../src/snapshot.js';

test('本机快照：版本、账号、两份数据和环境信息', () => {
  const data = {
    'uid-1': { meta: { handle: 'alice' }, inbound: [{ id: '1' }], outbound: [] },
  };
  const snapshot = buildSnapshot({
    accounts: { 'uid-1': { handle: 'alice' } },
    data,
    storage: { accounts: {} },
    exportedAt: '2026-11-21T03:04:05.000Z',
    extensionVersion: '0.23.1',
    environment: { timezone: 'Asia/Shanghai' },
    source: 'live',
  });

  assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA);
  assert.equal(snapshot.kind, 'xir-local-snapshot');
  assert.equal(snapshot.source, 'live');
  assert.equal(snapshot.extensionVersion, '0.23.1');
  assert.equal(snapshot.environment.timezone, 'Asia/Shanghai');
  assert.deepEqual(snapshot.data, data);
  assert.deepEqual(snapshot.storage, { accounts: {} });
});

test('本机快照：文件名和摘要', () => {
  assert.match(snapshotFilename('2026-11-21T03:04:05.000Z'), /^xir-snapshot-\d{8}-\d{6}\.json$/);
  assert.deepEqual(snapshotSummary({
    a: { meta: { handle: 'alice' }, inbound: [1, 2], outbound: [3] },
    b: {},
  }), [
    { account: 'a', handle: 'alice', inbound: 2, outbound: 1 },
    { account: 'b', handle: '', inbound: 0, outbound: 0 },
  ]);
});
