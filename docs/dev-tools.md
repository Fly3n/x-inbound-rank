# 开发工具、调试与测试说明

## 本机数据桥（仅维护期使用）

- `manifest.json` 在维护期临时包含 `http://127.0.0.1/*` 站点权限，**正式分发前必须移除或改为按需授权**。
- `src/bridge.js` 在账号/数据变化、旁听事件落盘（含新增、去重与异常日志）、任务结束、30 分钟兜底和页面上线时将 `{ accounts, data, storage, source: 'live' }` 推送到 `http://127.0.0.1:17321/ingest`；2.5 秒防抖合并，服务不在线静默退避 60 秒，不影响抓取。
- `scripts/live-bridge.mjs` 仅监听 `127.0.0.1`，原子写出 `.local/xir-live.json` 与 `.local/xir-live.meta.json`（权限 `0600`，含账号计数与近期诊断/旁听摘要 `diagnostics`），不访问外网。
- 常用命令：
  - `npm run bridge`：前台运行桥接接收服务
  - `npm run bridge:install` / `npm run bridge:uninstall`：安装或卸载 `~/Library/LaunchAgents/com.xir.live-bridge.plist`
- 两个 `.local/` 文件包含账号标识和回复正文，绝不提交或分享。
- 负责人本机 Chrome 存储定位（2026-11-21 核对，扩展 ID 由源码绝对路径派生，不可随意移动源码目录）：
  - `~/Library/Application Support/Google/Chrome/Default/Local Extension Settings/pplobbjmpgfdghaapmflccigedljpkfm/`
  - `~/Library/Application Support/Google/Chrome/Default/IndexedDB/chrome-extension_pplobbjmpgfdghaapmflccigedljpkfm_0.indexeddb.leveldb/`
  - 仅用于定位与备份核对，不直接读写 LevelDB（macOS TCC 亦会拦截终端访问）；维护期一律通过 `.local/xir-live.json` 读取。

## 只读快照页与弹窗本地预览

- **只读快照页**（`src/snapshot.js`、`src/ui/snapshot.html` / `snapshot.js`）：直接在扩展内打开可导出合成 JSON，作本机桥的手动兜底。
- **弹窗本地 mock 预览**（`scripts/popup-preview.mjs`）：
  ```bash
  npm run popup:preview
  ```
  仅监听 `127.0.0.1:17322`（可用 `PORT` 环境变量覆盖），读取真实 `src/ui/popup.html` 并注入内存 mock `window.chrome`（内部复用 `src/rank.js` 重算榜单与规则），方便改弹窗样式/文案后直接用浏览器查看效果。

## 自动化门禁与测试

- **日常提交前门禁**：
  ```bash
  npm run check
  ```
  串联 `scripts/check-contracts.mjs`（全量 `node --check`、版本与 CHANGELOG 对齐、权限白名单、模块隔离红线、后台模块无环及无自建监听校验、跨上下文消息名与 storage 键对齐、`tap.js` / `fetcher.js` 模板正则对齐、`AGENTS.md` 体积与文档链接检查）与 `npm test`。
- **正式分发前自检**：
  ```bash
  npm run release:check
  ```
  在 `check` 基础上检查无维护期 `127.0.0.1` 权限、无 `.local` 跟踪文件、工作区干净。
- **测试文件说明**（依赖仅 `fake-indexeddb`，假数据按预期接口形态编写，验证调度/解析自洽性，不证明 X 真实返回结构）：
  - `test/rank.test.mjs`：榜单、统计口径、规则合法化、颜色分档、覆盖判定
  - `test/parser.test.mjs`：提及/我的回复/`parseCreatedReply`/通知旁听/已排期解析边界与账号异常识别
  - `test/rel.test.mjs` / `test/schedule.test.mjs` / `test/fetcher.test.mjs` / `test/bg-runtime.test.mjs`：关系与帖子归属、排期档位与防撞、抓取模板与集合上限、`PACE` 真人节律
  - `test/share-copy.test.mjs`：原文提取与分享菜单「复制原文」注入（迷你 DOM 跑 `share-copy.js`）
  - `test/bg-backfill.test.mjs`：账号迁移、提及脱敏证据、回填状态机、重复游标与可信空列表
  - `test/bg-incremental.test.mjs`：重叠即停、免补历史直启、60 页安全上限、双窗口、模板切换与 404 回退、并发锁与多段续读
  - `test/bg-outbound.test.mjs`：方案 A 默认浏览器旁听、方案 B 每 2 天低频同步开关、手动补历史、范围切换、429 退避、轮数上限与列表到底
  - `test/bg-manual-and-maintenance.test.mjs`：立即更新收据、冷却、退避、切后台续读、清空保护与 90 天清理
  - `test/bg-accounts-and-tabs.test.mjs`：多账号隔离、排期同步退避与多窗口/跨窗口聚焦旧内容脚本刷新（含 `stale_tab_refresh` 日志）
  - `test/db.test.mjs`：IndexedDB 主键去重与 `mergeKnown` 空值不覆盖
  - `test/session.test.mjs`：页面仅旁听已启用会话、`CreateTweet` 旁听触发与切号清空缓存
  - `test/interface.test.mjs`：弹窗无固定入口和诊断面板、名次标签无悬浮说明的静态约束
  - `test/popup-helpers.test.mjs` / `test/popup-preview.test.mjs`：弹窗纯函数与本地预览服务
  - `test/snapshot.test.mjs` / `test/bridge.test.mjs`：本机快照结构与桥接服务

## 运行排查

- **后台日志**：`chrome://extensions` → 本插件 →「Service Worker」（最近 7 天后台静默日志亦随开发桥落盘到 `.local/xir-live.json`）。
- **页面日志**：`x.com` 页面 DevTools 控制台。
- **查看存储**：在 Service Worker 控制台执行 `chrome.storage.local.get(null).then(console.log)`。
- **核对零请求**：打开 `x.com` DevTools Network 面板确认时间线标签渲染及浏览器发帖旁听期间无额外请求；扩展更新后插件会在 08:00–24:00 自动刷新各窗口当前前台 X 常规页面，后台页切回前台或跨窗口切换焦点时再补。
