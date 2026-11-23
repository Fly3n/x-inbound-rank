import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContracts } from './check-contracts.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const failures = [];

try {
  await runContracts();
} catch (err) {
  failures.push(`基础契约检查失败: ${err?.message || err}`);
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
for (const host of manifest.host_permissions || []) {
  if (/127\.0\.0\.1|localhost/i.test(host)) {
    failures.push(`manifest.json 仍包含维护期权限 ${host}，正式分发前必须移除或改为按需授权`);
  }
}

const trackedLocal = execFileSync('git', ['ls-files', '.local'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (trackedLocal) {
  failures.push(`.local 目录存在已被 git 跟踪的文件:\n${trackedLocal}`);
}

const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty) {
  failures.push(`工作区存在未提交改动:\n${dirty}`);
}

if (failures.length) {
  console.error('发布前自检未通过：');
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}

console.log('发布前自检通过：无维护期权限、无 .local 跟踪文件、工作区干净且契约全部通过。');
