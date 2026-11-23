# 架构与模块职责

Chrome Manifest V3 插件，无构建步骤，零运行时依赖，Service Worker 与弹窗使用原生 ESM，内容脚本按经典脚本注入。

## 数据流

```text
弹窗(popup) ──消息──▶ 后台(background.js + src/bg/*) ──tabs.sendMessage──▶ x.com 内容脚本(content.js)
                         │                                                     │ 调 fetcher.js 用页面会话发请求
                         │◀────────── 原始 JSON ───────────────────────────────┘
                         │ parser.js 解析 → db.js 入库(IndexedDB)
                         │ rank.js 算榜 → 快照写入 chrome.storage.local
                         ▼
内容脚本监听 storage 变化，读快照，在用户名旁画标签（不发请求）
```

请求必须从已登录的 `x.com` 页面里发出：同源、自带会话 cookie，`ct0` 可从 `document.cookie` 读到，因此无需 `cookies` 权限。必须存在同一已启用账号的登录页面；无匹配页面时该账号任务等待，页面上线发送 `xir:hello` 后恢复闹钟。

## 文件职责

| 文件 / 目录 | 职责 | 何时改 |
|---|---|---|
| `src/x/fetcher.js` | 抓取层：接口路径、参数、请求头；`fetchMentions` / `fetchMyReplies` / `fetchScheduled` 均返回 `{ ok, status, body, rateResetAt, userId, error }` 不抛异常；`own` 集合上限 500 | X 改接口 |
| `src/x/parser.js` | 解析层：`parseMentions`、`parseMyReplies`、`parseCreatedReply`、`parseScheduledTweets`；结构不符抛 `ParseError` | X 改返回结构 |
| `src/x/mentions-diagnostics.js` | 提及诊断：裁剪请求与响应为条件指纹、帖子编号与时间线结构，不保存完整地址、游标或正文 | X 改提及返回结构或排查漏收 |
| `src/content/tap.js` | 页面脚本环境（`world: MAIN`、`document_start`）旁听层：包住 XHR / `fetch`，将相关文本经 `postMessage` 转给 `rel.js`；吞掉全部异常，不改请求/返回 | X 改页面请求方式 |
| `src/content/rel.js` | 解析旁听数据里的关注关系、帖子归属、请求模板（`tplKind`）、`CreateTweet` 回复与排期事件；仅放页面内存（`rel` / `tweets` 各最多 8000 条），不落盘、不发请求 | 改旁听字段或关系判断 |
| `src/content/schedule.js` | 发帖排期纯逻辑：07:00–24:00 半小时档、±15 分钟冲突、首个可用档、5–20 分钟随机浮动；无 DOM/Chrome 依赖 | 改档位规则 |
| `src/content/schedule-ui.js` | X 原生排期弹窗快捷档期条：找原生表单（`data-testid` 优先、语义兜底）、展示占用、点击填入日期/时间，不代点确认或发布 | X 改排期弹窗结构 |
| `src/content/content.js` | 账号识别、代发请求、注入名次/关系/`M` 标签、上报接口模板与 `CreateTweet` 旁听文本；X DOM 选择器集中在顶部 `SEL` | X 改页面结构 |
| `src/background.js` | Service Worker 入口：初始化与集中注册 Chrome 事件监听（`tabs.onActivated`/`tabs.onUpdated`/`windows.onFocusChanged`/`runtime.onInstalled`/`runtime.onStartup`/`alarms.onAlarm`/`runtime.onMessage`） | 增删顶级事件入口 |
| `src/bg/runtime.js` | 后台公共常量 `PACE`、模拟真人停顿函数（`humanIncDelay`/`humanBackfillDelay`/`humanBatchPages`）、双窗口调度（含 `nextOutAutoSlot`）、并发 `busy` 锁、串行 `cursor` 队列、`board` 与快照节流计算 | 调风控节奏或锁 |
| `src/bg/alarms.js` | 按账号命名闹钟清理、重试与恢复（`job:` / `inc:` / `out:`） | 改闹钟恢复条件 |
| `src/bg/accounts.js` | 账号升级迁移、会话校验 `senderAccount`、启停控制、`refreshStaleTabs` 各窗口前台旧内容脚本刷新与 `stale_tab_refresh` 日志记录 | 改账号隔离或刷新策略 |
| `src/bg/transport.js` | `fetchViaTab`、`recordRateLimit`/`clearRateLimit` 账号级 429 退避、提及 `pull` 入库与诊断记录 | 改请求退避或入库流程 |
| `src/bg/backfill.js` | 别人回我历史补读状态机（启动、逐页、暂停、恢复、唤醒） | 改回填流程 |
| `src/bg/incremental.js` | 别人回我增量拉取（免补历史直启、发现重叠即停、单轮 10 段/60 页安全上限） | 改增量停止或上限逻辑 |
| `src/bg/outbound.js` | 我回别人浏览器发帖实时旁听 `handleOutboundTap`，以及手动补历史与可选 2 天低频自动同步（`syncOut` / `syncOutNow`） | 改出站旁听或同步策略 |
| `src/bg/scheduled.js` | 发帖排期按需同步、`xir:scheduled:tap` 与 `xir:postEvent` 处理 | 改排期同步与退避 |
| `src/bg/rpc.js` | `maybePrune`、`clearData` 与全量 `handlers` 消息路由表（含 `xir:outbound:tap`） | 改 RPC 消息接口 |
| `src/rank.js` | 纯函数：口径过滤 `underMyPosts`、聚合、榜单、标签快照、`countsFromMe`、规则默认值 `DEFAULT_RULES`（含 `outAutoSync: false`）与 `cleanRules` | 改统计口径或规则范围 |
| `src/db.js` | IndexedDB 封装与 `chrome.storage.local` 键名 `keys`；重读同一条按 `mergeKnown` 合并；整表冻结缓存 | 改数据模型或存储键 |
| `src/diagnostics.js` | 本机诊断日志按小时分键静默写入，保留最近 7 天，读取时清理过期小时 | 改日志字段或保留期 |
| `src/ui/popup-helpers.js` | 弹窗纯函数与常量：格式化、状态文案、步进与 CSV 导出构造 | 改弹窗文案或导出格式 |
| `src/ui/popup.html` / `popup.js` / `popup.css` | 弹窗「榜单」「设置」两页渲染与事件处理；引入 `badge.css` 共用色板 | 改界面 |
| `src/snapshot.js` / `src/ui/snapshot.*` | 开发用只读本机快照页：把 `chrome.storage.local` 与 IndexedDB 合成 JSON；不挂弹窗入口 | 改快照格式 |
| `src/bridge.js` | 开发用本机数据桥：将快照推送到 `127.0.0.1:17321`；2.5 秒合并、离线静默退避 60 秒 | 改开发数据通道 |
| `scripts/live-bridge.mjs` / `install-bridge.mjs` | 回环 HTTP 接收器（写 `.local/xir-live.json` 与摘要）及用户级 LaunchAgent 启停 | 改本机桥服务 |
| `scripts/check-contracts.mjs` / `release-check.mjs` / `popup-preview.mjs` | 静态契约门禁、正式分发前自检、弹窗本地 mock 预览服务 | 改工程护栏或预览 |

## 模块隔离与工程约束

1. **接口/DOM 隔离红线**（由 `scripts/check-contracts.mjs` 自动校验）：
   - 主动请求 X 接口字段与路径只能出现在 `src/x/fetcher.js`、`src/x/parser.js`、`src/x/mentions-diagnostics.js`；旁听层 `src/content/tap.js` 与 `src/content/rel.js` 为明确例外，仅做旁听路由与内存解析，不得发请求或落候选数据。
   - X 页面 DOM 选择器只能出现在 `src/content/content.js` 与 `src/content/schedule-ui.js`。
2. **后台模块化红线**（同样受契约校验）：
   - `src/bg/*.js` 之间保持严格无环 DAG，且内部不得注册 `chrome.*.addListener`，所有监听集中于 `src/background.js`。
3. **与其他插件共存**（2026-11-13 实测 FeedSieve）：
   - 标签挂在 `[data-testid="User-Name"]` 的**最后一个子节点内部**，不直接作为它的子节点；若成为最后一个直接子节点，FeedSieve 会把自身标记塞进我们的标签里。

## 关键实现约定

- **账号识别与会话隔离**：新账号数据键为 `uid-<用户 ID>`，升级旧账号沿用原键；启用状态独立于 `fetchEnabled`。页面层仅旁听已启用会话，切号清空页面缓存；主动请求前及响应后均校验会话 `userId` 与 `activation`。
- **两个范围与向后兼容**：`windowDays`（`WINDOWS = [7, 15, 30, 60, 90]`）控制榜单、「我回 N」、时间线标签和汇总；`initDays`（`INIT_WINDOWS = [7, 15]`）只管点击「补历史」时回溯多远，旧设置里的 `30` 由 `cleanRules` 平滑降级为 `15`。`getSettings` 故意不从 `DEFAULT_SETTINGS` 补 `initDays`，以便 `cleanRules` 为 0.11.0 之前无此字段的设置沿用当时的 `windowDays`。
- **规则校验单点化**：默认值、上下限与合法化集中在 `src/rank.js`（`DEFAULT_RULES`、`LIMITS`、`cleanRules`）；读出时统一走 `cleanRules`，「恢复默认」只重置 `topN`、`minCount`、`tiers`、`baseColor`。
- **标签渲染与显示开关**：`rank.js` `COLORS` 对应 `src/content/badge.css` `[data-xir-c]`（实心底色+固定字色，不随 X 主题变；弹窗复用该 CSS）。名次标签不带自定义悬浮详情，关系/`M` 小标保留原生 `title`。`showRank` / `showOut` / `showRel` / `showPlace` / `showSchedule` 随快照 `show` 字段下发。
- **弹窗交互约定**：小问号使用 `<button class="q" data-tip="id">` + `<div class="tip" id="id" hidden>`，由 `popup.js` 单一事件委托处理；列表行仅头像是外链，点击行其余区域展开双方回复时间明细（读本机数据）；导出均在弹窗本地生成 CSV；不做固定或常驻独立窗口，弹窗不再放诊断回查或日志导出界面（日志由后台静默落盘并经 `.local/` 数据桥查看）。
- **扩展更新后刷新旧内容脚本**：`ensureTick`、`tabs.onActivated`、`tabs.onUpdated` 与 `windows.onFocusChanged`（过滤 `WINDOW_ID_NONE`）触发 `refreshStaleTabs`，仅在 08:00–24:00 查询 `{ ...X_TABS, active: true }`（不限 `lastFocusedWindow`，覆盖多窗口各当前前台页），对 `xir:ping` 连不上或版本不一致的 x.com 常规页面执行 `chrome.tabs.reload()`（无需 `tabs` 权限），跳过后台标签页与通知页并记录 `stale_tab_refresh` 诊断事件；加载中或失败时通过 `staleTabs` 闹钟 30 秒后补查，最多 2 轮（计数存 `chrome.storage.session`）。
- **发帖排期辅助**：`tap.js` 识别 `FetchScheduledTweets` 记为 `tpl:scheduled:<账号>` 并旁听返回，`CreateTweet` 更新 `lastPostAt`，`CreateScheduledTweet` / `DeleteScheduledTweet` 清空 `syncedAt` 作废 30 秒防抖；打开排期弹窗先显缓存再按需 GET（共用账号级退避与 `busy` 锁），纯档位计算在 `schedule.js`，填入原生 `<select>` 在 `schedule-ui.js`。
