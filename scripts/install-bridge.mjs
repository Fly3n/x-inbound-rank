#!/usr/bin/env node
// 安装用户级 LaunchAgent，让本机桥随登录启动；不修改 Chrome 文件，也不需要管理员权限。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.xir.live-bridge';
const UID = process.getuid?.() ?? 0;
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(ROOT, '.local', 'bridge.log');
// Homebrew 的版本目录会随升级变化，优先用稳定符号链接；其他安装方式沿用当前 Node。
const NODE = process.env.XIR_NODE || (existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath);
const SCRIPT = path.join(ROOT, 'scripts', 'live-bridge.mjs');

const esc = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

function launchctl(args, { quiet = false } = {}) {
  return execFileSync('launchctl', args, { stdio: quiet ? 'ignore' : 'inherit' });
}

async function install() {
  await mkdir(path.join(ROOT, '.local'), { recursive: true });
  await mkdir(path.dirname(PLIST), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(NODE)}</string>
    <string>${esc(SCRIPT)}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`;
  await writeFile(PLIST, plist, { mode: 0o644 });

  try {
    launchctl(['bootout', `gui/${UID}`, PLIST], { quiet: true });
  } catch {
    // 第一次安装时没有旧服务。
  }
  try {
    launchctl(['bootstrap', `gui/${UID}`, PLIST], { quiet: true });
  } catch {
    // 已加载时 bootstrap 会报错，下面 kickstart 仍会重启。
  }
  launchctl(['kickstart', '-k', `gui/${UID}/${LABEL}`]);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:17321/health`);
      const body = await response.json();
      if (response.ok && body.service === 'xir-live-bridge') {
        console.log(`本机桥已启动：http://127.0.0.1:17321`);
        console.log(`日志：${LOG}`);
        console.log('现在到 chrome://extensions 刷新一次「X 友」，让新的本机权限生效。');
        return;
      }
    } catch {
      // 等 LaunchAgent 起来。
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`本机桥没有在 10 秒内启动，查看 ${LOG}`);
}

async function uninstall() {
  try {
    launchctl(['bootout', `gui/${UID}`, PLIST], { quiet: true });
  } catch {
    // 没在运行也可以卸载。
  }
  await rm(PLIST, { force: true });
  console.log(`已停止并移除 LaunchAgent：${PLIST}`);
}

const command = process.argv[2] || 'install';
if (command === 'install') {
  install().catch((e) => {
    console.error(`安装失败：${e?.message || e}`);
    process.exitCode = 1;
  });
} else if (command === 'uninstall') {
  uninstall().catch((e) => {
    console.error(`卸载失败：${e?.message || e}`);
    process.exitCode = 1;
  });
} else {
  console.error('用法：node scripts/install-bridge.mjs [install|uninstall]');
  process.exitCode = 2;
}
