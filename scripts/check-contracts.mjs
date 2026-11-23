import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { keys as dbKeys } from '../src/db.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const readText = (relPath) => readFileSync(join(ROOT, relPath), 'utf8');
const readJson = (relPath) => JSON.parse(readText(relPath));

function walkFiles(dir, exts) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(rel, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(rel.replace(/\\/g, '/'));
  }
  return out.sort();
}

function checkSyntax() {
  const files = ['src', 'scripts', 'test'].flatMap((dir) => walkFiles(dir, ['.js', '.mjs']));
  for (const file of files) {
    execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' });
  }
  return files.length;
}

function checkManifestAndVersions() {
  const manifest = readJson('manifest.json');
  const pkg = readJson('package.json');
  const changelog = readText('CHANGELOG.md');

  assert.equal(manifest.version, pkg.version, `manifest.json (${manifest.version}) 与 package.json (${pkg.version}) 版本不一致`);
  const firstRelease = changelog.match(/^##\s+(\d+\.\d+\.\d+)\b/m)?.[1];
  assert.equal(firstRelease, manifest.version, `CHANGELOG.md 最新版本 (${firstRelease}) 与 manifest.json (${manifest.version}) 不一致`);

  const referencedPaths = [
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    manifest.action?.default_popup,
    manifest.background?.service_worker,
    ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  ].filter(Boolean);

  for (const relPath of referencedPaths) {
    assert.ok(existsSync(join(ROOT, relPath)), `manifest.json 引用的文件不存在: ${relPath}`);
  }

  const allowedPerms = new Set(['storage', 'alarms']);
  for (const perm of manifest.permissions || []) {
    assert.ok(allowedPerms.has(perm), `manifest.json 包含未授权权限: ${perm}`);
  }

  const allowedHosts = new Set(['https://x.com/*', 'https://twitter.com/*', 'http://127.0.0.1/*']);
  for (const host of manifest.host_permissions || []) {
    assert.ok(allowedHosts.has(host), `manifest.json 包含未授权 host_permissions: ${host}`);
  }
}

function checkModuleIsolation() {
  const jsFiles = walkFiles('src', ['.js']);
  const apiPattern = /\b(in_reply_to_status_id_str|conversation_id_str|relationship_perspectives|tweet_results|globalObjects)\b|\/i\/api\/(graphql|2)\//;
  const apiAllowed = new Set([
    'src/x/fetcher.js',
    'src/x/parser.js',
    'src/x/mentions-diagnostics.js',
    'src/content/tap.js',
    'src/content/rel.js',
  ]);
  const domPattern = /data-testid="(?:tweet|User-Name)"|AppTabBar_Profile_Link|scheduledDateSelectMonth/;
  const domAllowed = new Set([
    'src/content/content.js',
    'src/content/schedule-ui.js',
  ]);

  for (const file of jsFiles) {
    const code = readText(file);
    if (!apiAllowed.has(file)) {
      const m = code.match(apiPattern);
      assert.equal(m, null, `模块隔离越界 (${file} 不应出现 X 接口字段/路径 ${m?.[0]})`);
    }
    if (!domAllowed.has(file)) {
      const m = code.match(domPattern);
      assert.equal(m, null, `模块隔离越界 (${file} 不应出现 X DOM 选择器 ${m?.[0]})`);
    }
  }
}

/** 从 JS 对象字面量源码中提取顶层属性名（用于未拆出 rpc.js 前静态读取 background.js 的 handlers）。 */
function extractHandlersFromSource(code) {
  const startMatch = code.match(/\bconst\s+handlers\s*=\s*\{/);
  assert.ok(startMatch, '未找到 handlers 对象定义');
  let i = startMatch.index + startMatch[0].length;
  let depth = 1;
  const keys = new Set();
  const tplStack = [];
  let expectKey = true;

  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);

  while (i < code.length && depth > 0) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const quote = ch;
      let val = '';
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') {
          val += code[i + 1] || '';
          i += 2;
        } else {
          val += code[i++];
        }
      }
      i++;
      if (depth === 1 && expectKey) {
        keys.add(val);
        expectKey = false;
      }
      continue;
    }
    if (ch === '`') {
      i++;
      while (i < code.length) {
        if (code[i] === '\\') {
          i += 2;
        } else if (code[i] === '$' && code[i + 1] === '{') {
          tplStack.push(depth);
          depth++;
          i += 2;
          break;
        } else if (code[i] === '`') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    if (ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (tplStack.length && tplStack[tplStack.length - 1] === depth) {
        tplStack.pop();
        i++;
        while (i < code.length) {
          if (code[i] === '\\') {
            i += 2;
          } else if (code[i] === '$' && code[i + 1] === '{') {
            tplStack.push(depth);
            depth++;
            i += 2;
            break;
          } else if (code[i] === '`') {
            i++;
            break;
          } else {
            i++;
          }
        }
        continue;
      }
      i++;
      continue;
    }
    if (depth === 1) {
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (ch === ',') {
        expectKey = true;
        i++;
        continue;
      }
      if (expectKey && isIdentStart(ch)) {
        let word = '';
        while (i < code.length && isIdent(code[i])) word += code[i++];
        if (word === 'async') continue;
        keys.add(word);
        expectKey = false;
        continue;
      }
    }
    i++;
  }
  return keys;
}

async function getBackgroundHandlers() {
  if (existsSync(join(ROOT, 'src/bg/rpc.js'))) {
    const mod = await import('../src/bg/rpc.js');
    return new Set(Object.keys(mod.handlers));
  }
  return extractHandlersFromSource(readText('src/background.js'));
}

async function checkMessageContracts() {
  const bgHandlers = await getBackgroundHandlers();
  assert.ok(bgHandlers.size > 0, '后台 handlers 集合为空');

  const contentFiles = walkFiles('src/content', ['.js']);
  for (const file of contentFiles) {
    const code = readText(file);
    for (const m of code.matchAll(/\b(?:sendForSession|send)\(\{\s*type:\s*['"]([^'"]+)['"]/g)) {
      assert.ok(bgHandlers.has(m[1]), `${file} 发送了后台未处理的消息类型: ${m[1]}`);
    }
  }

  const popupCode = readText('src/ui/popup.js');
  for (const m of popupCode.matchAll(/\b(?:call|act)\(\s*['"]([^'"]+)['"]/g)) {
    assert.ok(bgHandlers.has(m[1]), `src/ui/popup.js 调用了后台未处理的消息类型: ${m[1]}`);
  }
  for (const m of popupCode.matchAll(/\binitialize\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g)) {
    assert.ok(bgHandlers.has(m[1]), `src/ui/popup.js initialize 调用了后台未处理的消息类型: ${m[1]}`);
  }

  const bgFiles = ['src/background.js', ...(existsSync(join(ROOT, 'src/bg')) ? walkFiles('src/bg', ['.js']) : [])];
  const contentCode = readText('src/content/content.js');
  for (const file of bgFiles) {
    const code = readText(file);
    for (const m of code.matchAll(/tabs\.sendMessage\([^,]+,\s*\{\s*type:\s*['"]([^'"]+)['"]/g)) {
      assert.ok(
        contentCode.includes(`'${m[1]}'`) || contentCode.includes(`"${m[1]}"`),
        `${file} 发送了内容脚本未处理的消息类型: ${m[1]}`,
      );
    }
  }
}

/** 展开只含字符与 (...) 分组/选择的简单正则表达式分支，校验 WATCH 中的每个键前缀都真实存在。 */
function expandSimpleRegexBranches(pattern) {
  let clean = pattern.replace(/^\^/, '').replace(/\$$/, '');
  function parseSeq(pos) {
    const branches = [];
    let current = [''];
    while (pos < clean.length) {
      const ch = clean[pos];
      if (ch === ')') break;
      if (ch === '|') {
        branches.push(...current);
        current = [''];
        pos++;
        continue;
      }
      if (ch === '(') {
        const inner = parseSeq(pos + 1);
        assert.equal(clean[inner.pos], ')', `WATCH 正则括号未闭合: ${pattern}`);
        const next = [];
        for (const prefix of current) {
          for (const suffix of inner.values) next.push(prefix + suffix);
        }
        current = next;
        pos = inner.pos + 1;
        continue;
      }
      current = current.map((s) => s + ch);
      pos++;
    }
    return { values: [...branches, ...current], pos };
  }
  return parseSeq(0).values;
}

function checkStorageKeyContracts() {
  const staticKeys = new Set();
  const prefixes = new Set();
  for (const val of Object.values(dbKeys)) {
    if (typeof val === 'string') staticKeys.add(val);
    else if (typeof val === 'function') {
      const rendered = val('__ACC__');
      const idx = rendered.indexOf('__ACC__');
      assert.ok(idx > 0, `db.js 键函数格式异常: ${rendered}`);
      prefixes.add(rendered.slice(0, idx));
    }
  }

  for (const file of ['src/content/content.js', 'src/content/schedule-ui.js']) {
    const code = readText(file);
    for (const m of code.matchAll(/`([A-Za-z0-9_:]+:)\$\{[^}]+\}`/g)) {
      assert.ok(prefixes.has(m[1]), `${file} 使用了 db.js 中不存在的键前缀: ${m[1]}`);
    }
  }

  const relCode = readText('src/content/rel.js');
  for (const m of relCode.matchAll(/storage\.local\.get\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    assert.ok(staticKeys.has(m[1]), `src/content/rel.js 读取了 db.js 中不存在的静态键: ${m[1]}`);
  }

  const watchFile = existsSync(join(ROOT, 'src/ui/popup-helpers.js')) ? 'src/ui/popup-helpers.js' : 'src/ui/popup.js';
  const watchCode = readText(watchFile);
  const watchMatch = watchCode.match(/\b(?:const|export\s+const)\s+(?:WATCH|STORAGE_WATCH)\s*=\s*\/([^/]+)\//);
  assert.ok(watchMatch, `${watchFile} 缺少 WATCH / STORAGE_WATCH 正则`);
  const branches = expandSimpleRegexBranches(watchMatch[1]);
  for (const branch of branches) {
    const known = staticKeys.has(branch) || [...prefixes].some((p) => p === branch || p === `${branch}:`);
    assert.ok(known, `${watchFile} WATCH 包含未定义键/前缀: ${branch}`);
  }
}

function checkTplAlignment() {
  const tapCode = readText('src/content/tap.js');
  const tapOpMatch = tapCode.match(/const\s+TPL_OP\s*=\s*(\/[^;]+\/[gimsuy]*)\s*;/);
  const opMatch = tapCode.match(/const\s+OP\s*=\s*(\/[^;]+\/[gimsuy]*)\s*;/);
  assert.ok(tapOpMatch && opMatch, 'src/content/tap.js 缺少 TPL_OP 或 OP 定义');

  const TPL_OP = runInNewContext(tapOpMatch[1]);
  const OP = runInNewContext(opMatch[1]);
  const fetcherCtx = { location: { origin: 'https://x.com' }, URL };
  runInNewContext(readText('src/x/fetcher.js'), fetcherCtx);
  const { tplKind } = fetcherCtx.XIRFetcher;

  const samples = [
    ['https://x.com/i/api/graphql/QID1/UserRepliesTimeline?variables=%7B%7D', true],
    ['https://x.com/i/api/graphql/QID2/UserTweetsAndReplies?variables=%7B%7D', true],
    ['https://x.com/i/api/graphql/QID3/NotificationsTimeline?variables=%7B%7D', true],
    ['https://x.com/i/api/graphql/QID4/FetchScheduledTweets?variables=%7B%7D', true],
    ['https://x.com/i/api/graphql/QID5/HomeTimeline?variables=%7B%7D', false],
    ['https://x.com/i/api/graphql/QID6/CreateTweet?variables=%7B%7D', false],
    ['https://x.com/i/api/graphql/QID7/NotificationsTimelineExtra?variables=%7B%7D', false],
    ['https://x.com/i/api/2/notifications/mentions.json?count=20', false],
  ];

  for (const [url, expected] of samples) {
    const op = url.match(OP)?.[1] || null;
    const tapMatched = Boolean(op && TPL_OP.test(op));
    const fetcherMatched = Boolean(tplKind(url));
    assert.equal(tapMatched, expected, `tap.js 模板匹配与预期不符: ${url}`);
    assert.equal(fetcherMatched, expected, `fetcher.js tplKind 与预期不符: ${url}`);
    assert.equal(tapMatched, fetcherMatched, `tap.js 与 fetcher.js 对模板的判定不一致: ${url}`);
  }
}

function checkBgModules() {
  if (!existsSync(join(ROOT, 'src/bg'))) return;
  const bgFiles = walkFiles('src/bg', ['.js']);
  for (const file of bgFiles) {
    const code = readText(file);
    assert.equal(/\baddListener\b/.test(code), false, `${file} 不得自行注册 Chrome 监听器（应集中在 src/background.js）`);
  }

  const allSrc = walkFiles('src', ['.js']);
  const graph = new Map();
  for (const file of allSrc) {
    const code = readText(file);
    const deps = [];
    for (const m of code.matchAll(/(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(join(ROOT, file)), m[1]);
      const rel = target.slice(ROOT.length + 1).replace(/\\/g, '/');
      deps.push(rel);
    }
    graph.set(file, deps);
  }

  const state = new Map();
  function visit(node, stack) {
    const s = state.get(node);
    if (s === 2) return;
    if (s === 1) {
      assert.fail(`发现循环依赖: ${[...stack, node].join(' -> ')}`);
    }
    state.set(node, 1);
    for (const dep of graph.get(node) || []) visit(dep, [...stack, node]);
    state.set(node, 2);
  }
  for (const node of graph.keys()) visit(node, []);
}

export async function runContracts() {
  const checkedFiles = checkSyntax();
  checkManifestAndVersions();
  checkModuleIsolation();
  checkBgModules();
  await checkMessageContracts();
  checkStorageKeyContracts();
  checkTplAlignment();
  return { checkedFiles };
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  const { checkedFiles } = await runContracts();
  console.log(`契约检查通过（语法校验 ${checkedFiles} 个文件，版本/权限/隔离/消息/键名/模板全对齐）`);
}
