# 维护入口（给接手的 AI / 开发者）

Chrome 插件（Manifest V3，无构建步骤，原生 JS）。统计「谁最常在我的 X 帖子下回复我」，并在时间线用户名旁标注排名。当前是维护自用阶段，开发者模式加载，不上架商店。使用说明见 `README.md`，本文件只讲技术事实和维护约束。

产品目标、固定优先级和不可越过的红线以 [`REQUIREMENTS.md`](REQUIREMENTS.md) 的「目标与取舍」为准：账号安全 > 数据完整与正确 > 轻量低噪声 > 及时性。技术实现不能拿更低的优先级去交换更高的优先级。

## 已定的产品决策（改之前先问负责人）

**功能和要求以 [`REQUIREMENTS.md`](REQUIREMENTS.md) 为准**：负责人提的新需求、改的口径先记在那里，再改代码。下面记的是这些决策在代码里怎么落地，和那份冲突时以那份为准、并把这里改掉。

- **账号启用与隔离**（2026-11-20 负责人定）：仅在当前 X 页面明确开启的账号生效。用会话 X 用户 ID 匹配本机账号，新账号的数据键为 `uid-<用户 ID>`，升级的旧账号沿用数据键，改 @用户名不会改数据归属。启用状态独立于「自动更新」开关。所有页面功能用本页会话判定；只旁听启用会话，切号清空页面缓存；主动请求发出前和响应后都核对会话。后台闹钟按账号命名，找不到对应的登录页面就等待。
- 只统计**回复**，只有一个回复榜。引用、点赞、转发、综合榜都不做（2026-11-13 负责人定）。
- **两个范围**（2026-11-19 负责人定，取代 11-14「只有一个统计范围」）：榜单范围 `windowDays`（7/15/30/60/90 天，`rank.js` 的 `WINDOWS`，榜单页的下拉框）管榜单、「我回 N」、时间线标签、汇总；初始化范围 `initDays`（7/15/30，`INIT_WINDOWS`，设置页「数据读取」）只管点「初始化」时往回读多远（回填的 `rangeDays`、「我回别人」完整读的起点）。改哪个都不自动读数据。0.11.0 之前存的设置没有 `initDays`，`cleanRules` 沿用当时的 `windowDays`（`getSettings` 故意不从默认值补它）。
- 榜单和标签只有两个条件：窗口内回复至少 `minCount` 次；最多前 `topN` 名。两个值用户可调（2026-11-13 负责人定）：`topN` 默认 100、范围 10–500、界面每次加减 50；`minCount` 默认 2、范围 1–99、每次加减 1。不足名次上限就有多少显示多少。
- 时间线标签显示「名次图标 + 名次、回复图标 + 次数」。颜色按**回复次数**分档，不按名次（名次靠后的往往都只有两三次，负责人要的是一眼判断值不值得回）。默认：≥20 次红、10–19 次橙、5–9 次蓝、其余灰（负责人 2026-11-13 按一周的量定），各个统计范围共用。用户可改每档的门槛和颜色、加档删档，最多 4 个门槛档加 1 个兜底色共 5 种；可选 8 色（`rank.js` 的 `COLORS`，色值在 `badge.css` 的 `[data-xir-c]`，弹窗通过引入同一份 CSS 共用）。颜色都是实心底色配固定字色，不随 X 的主题变。名次标签不再有自定义悬浮详情（2026-11-21 负责人定）；关系/M 小标自己的 `title` 保留。
- 规则的默认值、范围和合法化都在 `rank.js`（`DEFAULT_RULES`、`LIMITS`、`cleanRules`）；设置读出时总会过一遍 `cleanRules`，所以别处不用再校验。「恢复默认」只恢复 `topN`、`minCount`、`tiers`、`baseColor`。
- 设置页的排布（2026-11-14 负责人定）：用户要操作的在前，说明在后。「数据读取」里先是初始化范围，然后两份数据分开各占一块，按钮都叫「初始化」（别人回我：`startBackfill`；我回别人：`syncOutNow`，强制按初始化范围重新读一遍）。本机数据已经覆盖所选初始化范围时按钮置灰并说明（别人回我按 `cursor.lastBackfill` 推算；我回别人按 `cursor.out.coverTs` / `reachedEnd` 判断，不再用 `lastFullAt` 推算），第一次必须手动点，`syncOut` 非手动触发时没初始化过就直接返回，每块下面直接显示现状（不再用 `<details>` 折叠；本机条数、起止日期、上次初始化完成的时间和范围、上次更新时间，数据来自 `getAccountState` 的 `db` 和 `cursor`）；顶部读取摘要的「别人回我」「我回别人」标签后带冒号，时间显示「月/日 时:分:秒」、不显示年份；数据状态里的「上次初始化」「上次读取」显示到「月/日 时:分」、不显示秒；都用紧凑格式保持单行（`popup.js` 的 `fmtTime` / `fmtExactTime`）；「风险说明」「清空数据」在最后、默认折叠。
- 说明文字一律做成小问号（2026-11-14 负责人定）：`<button class="q" data-tip="某个 id">?</button>` 加一个 `<div class="tip" id="同一个 id" hidden>`，点了展开或收起，`popup.js` 里一个事件委托处理。内容写成简短的列表。以后加说明照这个做，不在界面上直接铺大段文字。
- 弹窗分「榜单」「设置」两页；榜单页有搜索、小问号说明（第一条是范围内总量汇总）、导出。行上只有头像是去他主页的链接，点这一行其他地方展开两个方向的回复时间，各自按榜单口径筛选并从新到旧排列，点时间打开原文（明细只读本机数据）。导出分两种：「导出榜单」（榜上的人）和「导出全量数据」（`exportAll`，两张表的全部统计相关记录，同一张 CSV 里用「类型」列区分；仅用于判定对话归属的 `own` 记录不导出），都在弹窗里本地生成文件。不做「固定」或常驻独立窗口（2026-11-21 负责人定），弹窗仍按 Chrome 默认行为在点击外部时关闭。
- 关系标签和帖子归属标签（2026-11-14 负责人定）：首页等所有有帖子的地方，用户名旁用单字标他和我的关系（只有「互」互关、「粉」他关注我而我没关注他，其他不标），对象是页面上的所有人，不限于回复过我的；通知列表里回复我的那条如果在我的帖子下，另有一个单独的「M」，不在我帖子下的不标（判断逻辑能分出「他自己的帖子」「别人的帖子」，但负责人明确不要显示）。名次标签、名次标签里的「我回他几次」、关系、帖子归属、发帖快捷档期各有一个显示开关（设置项 `showRank` / `showOut` / `showRel` / `showPlace` / `showSchedule`，随快照的 `show` 下发给内容脚本和排期界面）；以后新增显示项，也要配开关。插件不维护关注列表和粉丝列表，关系只取 X 页面自己的接口返回里带的：`tap.js` 跑在页面的脚本环境（`world: MAIN`、`document_start`），包住 `XMLHttpRequest` 和 `fetch`，把 `/i/api/graphql/`、`/i/api/2/` 的返回文本用 `postMessage` 转给隔离环境里的 `rel.js`，`rel.js` 解析后只放内存（各最多 8000 条），不落盘、不发请求。`tap.js` 只做旁听路由，不做统计业务逻辑，出错全部吞掉，不能影响 X 页面。帖子归属先用页面数据判断（`XIRRel.placeOf`），判断不了的由内容脚本发 `xir:where` 问后台，后台用两张表算（`rank.js` 的 `replyPlaces`）。关系和 M 这条旁听线尚未在真实账号上确认字段和显示效果；名次标签已在真实账号上运行。
- 每次「初始化」都从最新一条重新往回读，不做接续翻页（负责人知情后定）。
- 别人回我：**在我帖子下回我的都算，不分层**（2026-11-19 负责人定，取代同日上午的「只算第一级」）：`rank.js` 的 `underMyPosts`，计数和通知列表的 M 共用。根帖是不是我的：`root_mine === true`，或 `null` 但同一对话里有别的记录证明是我的（入站里 `root_mine === true` 的、或「我回别人」表里 `own` 的）。他在别人帖子下（包括他自己的帖子）回我的不算。
- 榜单每行另带「我回 N」：同一榜单范围内**我直接评论他的帖子**几次（只算第一层，2026-11-19 负责人定；深层回复实测只有一半左右认得出根帖主人，不算）：`rank.js` 的 `countsFromMe`，条件是 `reply_to_id === conversation_id` 且不是 `own`，记在根帖作者名下。不影响排名。弹窗榜单和导出里显示；时间线名次标签里也带：第三段，纸飞机图标 + 次数，只有「我回别人」读完过一次才出现（快照里 `replied`），设置里 `showOut` 可关。
- 「我回」的数据来自我自己主页「回复」栏背后的接口（GraphQL，2026-11-19 实测名字是 `UserRepliesTimeline`，`fetcher.js` 的 `REPLIES_RE` 新旧名字都认）。它的查询 ID 和 `features` 参数随 X 发版变化，所以不写死：`tap.js` 看到 X 页面自己发的这条请求，把地址转给内容脚本记下（浏览器的资源计时记录在 x.com 上是空的，不能靠它），抓取时只换掉 `userId`、`count`、`cursor` 照着发。缺少模板时显示「等待回复页」，由用户点链接打开自己的「回复」栏。收到模板后自动安排续读。
- 数据来源是 X 网页版「通知 → 提及」的内部接口，用已登录的网页会话读。不走官方 API，不逐帖抓评论（请求量大、接口更脆，已比较过）。优先用网页版现在自己用的 GraphQL `NotificationsTimeline`（额度 1500 次 / 15 分钟、每页 40 条，2026-11-19 负责人要求换新）：`tap.js` 看到 X 页面读通知（「全部」或「提及」）的请求就报上地址，存在 `tpl:mentions:<账号>`，`fetcher.js` 照着发、把 `timeline_type` 换成 `Mentions`。没有模板时用旧 REST `mentions.json`。**不自己开通知页取模板**：X 一打开通知页就会把未读通知标成已读，算动了账号状态。两种接口的游标不通用：一个回填任务（`job.api`）、一轮补读（`incResume.api`）从头到尾用同一个；新接口 400 / 404 时删掉模板（`pull` 返回 `tpl_bad`），回填换旧接口从最新一页重来，增量休息三到五分钟后用旧接口重读。
- **低频与作息**（2026-11-21 负责人定）：模拟人的工作周期，所有主动读取只在本地时间 08:00–24:00 发生，凌晨不自动请求；自动任务只在每天上午 08:00–11:30 和晚间 18:00–22:30 的完整窗口内随机启动，并要求同账号 X 页面在前台可见。入站每天两次，先读到上次接续点，再按上一轮读取时间向更早补 1 小时；出站每天两次，只读到接续点，两份不再互相顺带触发。手动更新十分钟冷却，成功后顺延到下一个自动时段。`fetchEnabled` 只控制日常自动读取，初始化和「立即更新」始终可用。
- 零写操作：不点赞、不关注、不发帖。数据只存本机，无任何上报。
- **发帖排期辅助**（2026-11-20 负责人定）：在 X 原生排期弹窗内注入快捷档期条，纯辅助填时间、不代点确认/发布。固定每天 07:00–24:00 每 30 分钟一档；档位 `[T - 15m, T + 15m)` 内已有排期则置灰不可选（悬停看具体时间与摘要）；已过去、距现在不足 10 分钟或距最近发帖不足 15 分钟的档跳过；弹窗内横排显示当天最近几个档，其余今天档位及明天全天收在「更多档期」下拉列表；点击空档后前后随机浮动 5–20 分钟填入 X 原生日期/时间下拉框（2026-11-21 扩大）。同步走「旁听模板 + 打开排期弹窗按需 GET（30 秒防抖）」：`tap.js` 认 `FetchScheduledTweets` 记为 `tpl:scheduled:<账号>` 并顺手旁听返回；实际发帖时通知后台记 `lastPostAt`，新建/删除排期只作废同步防抖；缓存按账号存 `scheduled:<账号>`（含 `retryAt` / `errorCount`，失败后退避）。设置页配 `showSchedule` 开关。
- 正式功能权限只有 `storage`、`alarms` 和 x.com / twitter.com 的站点权限。2026-11-21 负责人同意在维护阶段额外加 `http://127.0.0.1/*`，只用于把本机数据推给开发桥；正式分发前要移除这条，或改成按需授权。不加 `cookies`、`tabs`、`scripting`。扩展更新/重载后，后台 `ensureTick` 和 `tabs.onActivated` / `tabs.onUpdated` 调 `refreshStaleTabs`，只对当前前台、`xir:ping` 连不上或版本不一致的 x.com 常规页面执行 `chrome.tabs.reload()`；后台标签页不主动刷新，切回前台再补，通知页不自动刷新。`tabs.reload()` 不需要 `tabs` 权限，已经打开且内容脚本正常的页面不动。刷新也受作息门控，08:00 前只把 `staleTabs` 闹钟排到白天，不自动重载页面。加载中或刷新失败的页面留到 30 秒后的 `staleTabs` 补查，最多两轮（次数在 `chrome.storage.session`），成功后清零；扫描和恢复闹钟并行，不挡住原有任务。
- 不做时间衰减、不做「我回了他」加分（「我回 N」只展示，不参与排名）、不做收费。

## 数据流

```text
弹窗(popup) ──消息──▶ 后台(background.js) ──tabs.sendMessage──▶ x.com 标签页里的内容脚本(content.js)
                         │                                         │ 调 fetcher.js 用页面会话发请求
                         │◀────────── 原始 JSON ───────────────────┘
                         │ parser.js 解析 → db.js 入库(IndexedDB)
                         │ rank.js 算榜 → 快照写入 chrome.storage.local
                         ▼
内容脚本监听 storage 变化，读快照，在用户名旁画标签（不发请求）
```

请求必须从 x.com 页面里发：同源、自带会话 cookie，`ct0` 可从 `document.cookie` 读到，所以不需要 `cookies` 权限。必须有同一个已启用账号的登录页面。没有匹配页面时，该账号的任务等待，页面上线发 `xir:hello` 后恢复闹钟。

## 文件职责

| 文件 | 职责 | 何时改 |
|---|---|---|
| `src/x/fetcher.js` | 抓取层：接口路径、参数、请求头。`fetchMentions` 读提及，`fetchMyReplies(tpl, cursor)` 照模板读我的回复列表，`fetchScheduled` 读已排期列表。返回 `{ ok, status, body, rateResetAt, userId, error }`，不抛异常 | X 改接口 |
| `src/x/parser.js` | 解析层：`parseMentions` 原始 JSON → `{ events, entryIds, newestId, newestTs, oldestId, oldestTs, bottomCursor }`；`parseMyReplies` → 我在别人帖子下的回复；`parseScheduledTweets` → 已排期列表。结构不符抛 `ParseError` | X 改返回结构 |
| `src/x/mentions-diagnostics.js` | 提及诊断：把请求 URL 和响应裁剪成条件指纹、帖子编号和时间线结构，不保存完整地址、游标或正文 | X 改提及返回结构或排查漏收 |
| `src/content/tap.js` | 页面脚本环境的旁听层：包住 XHR / fetch，只把相关返回文本转给 `rel.js`，不发请求、不改请求和返回，所有错误吞掉 | X 改页面请求方式 |
| `src/content/rel.js` | 从旁听数据取关注关系、帖子归属、读取模板、提及证据和排期事件；只放内存（各最多 8000 条），不落盘、不发请求 | 改旁听字段或关系判断 |
| `src/content/schedule.js` | 发帖排期纯逻辑：每天 07:00–24:00 半小时档、±15 分钟冲突、首个可用档、随机浮动；不依赖 DOM 和 chrome API | 改档位规则 |
| `src/content/schedule-ui.js` | X 原生排期弹窗里的快捷档期条：找原生表单、展示占用、点击填入日期/时间，不代点确认或发布 | X 改排期弹窗结构 |
| `src/content/content.js` | 账号识别、代发请求、画名次/关系/M 标签、记下 X 读「回复」栏和通知的请求地址（`xir:tpl`）。页面选择器集中在顶部 `SEL` | X 改页面结构 |
| `src/background.js` | 调度：回填、增量、限流退避、账号绑定、消息处理、扩展更新后刷新旧内容脚本。节奏参数集中在顶部 `PACE` | 调节奏、改流程 |
| `src/rank.js` | 纯函数：口径过滤 `underMyPosts`、聚合、榜单、标签快照、`outboundCounts`（我回他几次）；榜单规则的默认值、范围、合法化 | 改统计口径、规则默认值 |
| `src/db.js` | IndexedDB 封装与 `chrome.storage.local` 键名；重读同一条时合并，不让空值覆盖已知事实 | 改数据模型 |
| `src/diagnostics.js` | 本机诊断日志：按小时分键写入，保留最近 7 天，读取时清理过期小时 | 改日志字段或保留期 |
| `src/ui/` | 弹窗 | 改界面 |
| `src/snapshot.js` / `src/ui/snapshot.*` | 开发用只读本机快照页：把 `chrome.storage.local` 和 IndexedDB 两份数据合成 JSON；不挂弹窗入口、不发请求、不新增权限 | 改本机数据迁移或排查工具 |
| `src/bridge.js` | 开发用本机数据桥：把当前快照自动 POST 到 `127.0.0.1:17321`；服务不在线时退避，不影响抓取 | 改开发数据通道 |
| `scripts/live-bridge.mjs` | 本机 HTTP 接收器：只监听 `127.0.0.1`，原子写 `.local/xir-live.json` 和摘要 | 改桥接服务 |
| `scripts/install-bridge.mjs` | 安装/卸载用户级 LaunchAgent，让本机服务随登录启动 | 改桥接启动方式 |

**隔离原则**：只有 `fetcher.js` 和 `parser.js`（以及专做提及诊断的 `mentions-diagnostics.js`）知道主动请求的 X 接口字段，只有 `content.js` / `schedule-ui.js` 的页面选择器知道 X DOM。`rel.js` 是明确例外：它只解析 `tap.js` 旁听到的页面返回（关注关系、帖子归属、模板、提及证据、排期事件），不发请求、不写候选数据；其他文件不得出现 X 的字段名或选择器。

### 开发用本机数据桥（仅维护阶段）

- `manifest.json` 临时带 `http://127.0.0.1/*` host permission；分发前必须处理。
- `src/bridge.js` 在账号/数据变化、任务结束、30 分钟兜底和 X 页面上线时，把 `{ accounts, data, storage, source: 'live' }` 推到 `http://127.0.0.1:17321/ingest`。2.5 秒合并短时间内的多次触发；服务不在线时静默退避 60 秒，不弹窗，不影响抓取。
- `scripts/live-bridge.mjs` 只监听回环地址，原子替换 `.local/xir-live.json` 和 `.local/xir-live.meta.json`，文件权限 600；不读 X、不访问外网。
- `npm run bridge:install` 安装 `~/Library/LaunchAgents/com.xir.live-bridge.plist` 并启动；`npm run bridge:uninstall` 停止并移除服务。前台调试用 `npm run bridge`。
- 两个 `.local` 文件包含账号标识和回复内容，不提交、不分享；快照页保留作手动兜底。
- 负责人本机 Chrome 数据位置（2026-11-21 核对，扩展 ID 由源码绝对路径派生）：
  - `~/Library/Application Support/Google/Chrome/Default/Local Extension Settings/pplobbjmpgfdghaapmflccigedljpkfm/`
  - `~/Library/Application Support/Google/Chrome/Default/IndexedDB/chrome-extension_pplobbjmpgfdghaapmflccigedljpkfm_0.indexeddb.leveldb/`
- 上述目录只用于定位和备份核对，不直接读取或修改 LevelDB。macOS TCC 会拦住终端读取其内容；维护时以桥接生成的 `.local/xir-live.json` 为准。移动源码目录会改变扩展 ID，数据和扩展会被视为另一份，先确认 ID 再操作。

## 数据模型

IndexedDB 库 `xir`，表 `events`，主键 `[account, id]`（账号数据键 + 回复的帖子 ID），去重靠主键。

| 字段 | 含义 |
|---|---|
| `id` | 这条回复的帖子 ID |
| `actor_id` / `actor_handle` / `actor_name` / `actor_avatar` | 回复者 |
| `created_at` | 毫秒时间戳 |
| `target_post_id` | 被回复的那条（我的帖子或评论） |
| `conversation_id` | 对话根帖 ID |
| `root_mine` | 根帖是不是我的：`true` / `false` / `null`（抓取时那页看不出来） |
| `text` | 回复内容摘要：去掉开头的 @、最多 100 字；只给弹窗「点开某人」看，拿不到是空串。2026-11-14 之前入库的没有这个字段，重新初始化会补上 |

`db.js` 把整表读（`getEvents`）的结果缓存在 Service Worker 内存里，写入、清理、清空时作废；返回的数组是冻结共用的，调用方要排序先复制。

`putEvents` 重复写入同一条时按主键合并：只有此前不存在才算新增；新响应里的 `null` / 空串不覆盖已有的根帖归属、正文、头像等已知值，有效的新值照常更新。

`parseMentions` / `parseMyReplies` 的返回值都带 `newestTs`（本页最新一条的时间），翻页时用它判断整页是否已经跨过范围或回看边界。

表里存的是**所有直接回复我的**，包括 `root_mine` 为 `false` 的；是否计数在 `rank.js` 的 `underMyPosts` 里判断。这样改口径不用重新抓（2026-11-19 两次改口径都没重抓）。新接口的条目只带回复本身、不带根帖，深层回复的 `root_mine` 多半是 `null`，靠同一对话的旁证补判。

表 `out`（库版本 2 加的）：我在别人帖子下的回复，主键同样是 `[account, id]`。字段：`created_at`、`reply_to_id`（回的是哪条帖子，0.10.0 加的；等于 `conversation_id` 就是直接评论根帖，「我回 N」只算这种）、`to_user_id`（直接回复的人）、`root_user_id`（对话根帖作者，`null` = 抓取时那页没带出根帖；第一级的回复一定有）、`conversation_id`、`text`。我自己帖子下的回复也入库，标 `own: true`、`root_user_id` 是我：不计数、不导出、不算进条数，只用来证明「这个对话是我的」（比如我自己的串推下别人回我）。0.11.0 起才存，之前的数据里没有，不为此重读。

「我回」的同步状态在 `cursor.out`：`{ status: 'ok' | 'need_tpl' | 'error', message, syncedId, coverTs, reachedEnd, attemptCoverTs, limitReached, fullFor, resume, manualTask, lastAt, lastFullAt, lastFullDays, nextAutoAt, retryAt, pages, rate429Count }`。`syncedId` 是上次读到的最新一条；可信的空列表初始化完成后用 `'0'` 当哨兵，表示“确实没有记录但已经初始化”，避免自动增量一直无法启动；`coverTs` 是完整读成功覆盖到的最早时间；`reachedEnd` 表示完整读是因为 X 的列表到底才停下，没到所选范围；`attemptCoverTs` 是最近一次完整读实际走到的最早时间（失败或中途续读也会更新，只用于如实展示进度，不能单独当作已覆盖）；`limitReached` 表示这次是因为单次页数上限停下，弹窗据此在错误后补一句实际最早读到哪天；`retryAt` 是出站自己的临时服务退避；`rate429Count` 是连续 429 次数，退避到期后任意一路成功读取就清零。`fullFor` 是最近一次完整读请求的初始化范围（天），手动点「初始化」时清成 0。完整读的条件：没有 `syncedId`、`fullFor === 0`、或本机这份数据的格式版本 `schema` 低于 `OUT_SCHEMA`；读到初始化范围起点。否则只从最新读到接续点，不再向更早回扫。改初始化范围不触发完整读，要用户点。这个接口的额度只有 **50 次 / 15 分钟**（2026-11-19 实测），节奏单独定：单个闹钟事件最多 5 页（`PACE.outPages`），页间 15–27 秒，避免超过 Service Worker 的空闲回收线；没读完就把位置记在 `resume`（`{ cursor, topId, rounds, full, stopAt }`）里，休息 3–5 分钟（`PACE.outRestMs`）后的下一个 `out` 闹钟接着读。`manualTask` 标记这次读取由手动初始化或立即更新启动，关闭自动更新后仍允许分段续完。读完之前 `syncedId` 不动，最多 120 轮（`PACE.outMaxRounds`，共 600 页）；达到上限时状态记为 `error`、`limitReached: true`、清掉 `resume`，`lastFullAt` / `lastFullDays` 保持上一次成功初始化的值，不能把失败写成完成；`fullFor` 置为本次范围，避免自动更新立刻重跑完整读；自动闹钟看到 `limitReached` 会直接返回，继续完整读要用户再点「初始化」，点「立即更新」只做增量。只有在读到目标时间或列表底部时，完整读才记 `coverTs` / `reachedEnd` / `lastFullAt` / `lastFullDays` 和 `schema`；翻页异常或页数上限失败只记 `attemptCoverTs`。`schema` 只是本机数据格式的升级标记（`rank.js` 的 `OUT_SCHEMA`，2 = 带 `reply_to_id`），不是两套产品效果：低于当前版本时后台自动补读，补完之前弹窗和标签都不显示「我回 N」。`lastAt` 是最近一次读完的时间，弹窗据此决定显不显示「我回 N」；`nextAutoAt` 是下一次日常自动读取，定在下一个上午或晚间时段。日常由 `out` 闹钟触发，不再跟每次入站顺带启动。接口返回 400 / 404 时认为模板过期，删掉 `tpl:replies:<账号>` 并展示「打开我的回复页」入口；拿到新模板（`xir:tpl`）后 3 秒补读。事件里的 `root_handle`（根帖主人的 @ID）只给全量导出显示用，不参与统计。

**保留期**：两张表都只留最近 90 天（`rank.js` 的 `KEEP_DAYS`，和最长的榜单范围一致，2026-11-19 负责人定），兜底闹钟里每天最多清一次；清掉过数据就记 `cursor.prunedAt`。弹窗：最早的数据存满 80 天（`WARN_DAYS`）且还没清过时，榜单上方红字提示并给导出按钮；清过之后改成一行小字（数据每天滚动清，不一直挂红字）。设置页显示条数和 `navigator.storage.estimate()` 的占用。不清的话库会无限增长，而每次重算快照都要把该账号的事件全读一遍。量级参考：一条约 300–500 字节，一周 1 万条回复时 90 天约 13 万条、约 50 MB，全读一遍在几百毫秒。

`chrome.storage.local` 键（定义在 `db.js` 的 `keys`）：

| 键 | 内容 |
|---|---|
| `accounts` | `{ [dataKey]: { handle, userId, enabled, activation } }`；`userId` 是 X 的数字用户 ID，唯一且不随改名变化；`handle` 是可变的 @名，只作显示和兜底，页面识别不到时可以为空，解析必须以 `userId` 为准；`activation` 区分开启前后的请求 |
| `settings:<账号>` | `{ fetchEnabled, windowDays, initDays, topN, minCount, tiers: [{ min, color }], baseColor, show* }`，见 `rank.js` 的 `DEFAULT_RULES` |
| `tpl:replies:<账号>` / `tpl:mentions:<账号>` / `tpl:scheduled:<账号>` | `{ url, at }`：X 页面自己读「回复」栏、读通知的请求地址，照着它发 |
| `scheduled:<账号>` | `{ items, syncedAt, retryAt, errorCount }`：已排期列表缓存；失败后退避，退避期内不重复请求 |
| `cursor:<账号>` | `{ newestId, syncedId, earliestTs, lastIncrementalAt, nextIncAt, lastManualAt, lastAttemptAt, lastBackfill, lastPruneAt, incResume, rateUntil, rate429Count, out }`。`nextIncAt` 是下一次上午或晚间自动入站更新的时间。`syncedId` 是增量的接续点：从它往更早到回填终点是连续完整的。回填完成时设为该次回填的起点；可信的空列表初始化完成后用 `'0'` 当哨兵。增量只有完整接上接续点后才前移到本轮最新一条，分段续读、提前到底、重复游标或出错时都不动，下次重读这一段（靠主键去重）。`lastIncrementalAt` 是上一轮增量的起点时间，跨多个后台事件也固定在同一轮第一次启动时；本轮以它为基准再向更早补 `PACE.incOverlapMs`（1 小时）。`incResume` 保存续读位置与 `startedAt`，避免分段完成后锚点漂移。`rateUntil` / `rate429Count` 是账号级 429 退避的截止时间和连续次数，所有主动读取入口共用。`lastManualAt` 是手动更新的冷却基准 |
| `job:<账号>` | 回填任务状态，见下 |
| `snap:<账号>` | 标签快照 `{ at, windowDays, users: { handle小写: { rank, count, color, last } } }`，内容就是回复榜；改任何设置、有 X 页面上线时都立刻重算。抓取过程中节流：最多每 30 秒重算一次，一轮结束或任务停下时补一次（`background.js` 的 `flushSnapshot`）；算出来和存着的一样就不写，免得各页面白白重画 |
| `alert:<账号>` | 最近一次抓取或解析错误，下次成功后清除 |
| `domWarning:<账号>` | 内容脚本发现页面结构对不上时置位 |
| `diagnostics:<小时>` | 本机读取诊断事件，保留最近 7 天、全量不抽样；`diagnostics.js` 负责读写和过期清理 |

## 回填任务状态机

`job.status`：`running` → `done`；中途可能进入 `paused`（`auto: true` 是限流退避、到 `nextAt` 自动恢复；`auto: false` 是手动暂停或达到单次页数上限，要用户点继续）、`waiting_tab`（没有可用的 x.com 标签页）、`error`（登录失效、接口异常、解析失败、账号不一致，不自动重试）。

每一步由 `stepBackfill()` 拉一页，再用 `chrome.alarms` 以 `job:<账号>`、`inc:<账号>` 和 `out:<账号>` 区分各账号的任务（Service Worker 会被回收，不能靠 `setTimeout` 等长间隔；状态全部落在 storage 里）。每 30 分钟的 `tick` 闹钟兜底：接上丢失的步骤、重算快照、检查增量是否到期。

结束条件：本页最新一条都早于目标时间（整页跨过范围边界）→ 正常完成；没有下一页游标或本页为空 → 完成并标 `reachedEnd: true`，界面如实显示「最早只拿到某天」；第一页就是可信的空列表时记空哨兵 `'0'`。这样同一页里新旧回复混排时不会在边界处提前停。增量在接上旧接续点前遇到空页、没有下一页或重复游标时一律视为分页异常：不推进 `syncedId` / `lastIncrementalAt` / `coverTs`，也不冒充列表到底。解析层遇到未知条目结构或作者数字 ID 缺失会整页报错；正常的已删除/不可用帖子只跳过该条，不能拖垮同页其它回复。

重新初始化会从最新一页重新翻，已有记录靠主键去重。

## 风控（节奏参数在 `background.js` 的 `PACE`）

| 机制 | 当前值 | 说明 |
|---|---|---|
| 回填页间隔 | 随机 25–45 秒；每 10 页休息 3–5 分钟 | 回填是一页一个 `job` 闹钟，不受单次 Service Worker 时限影响；仍然远低于接口额度 |
| 单次页数上限 | 600 页（约 1.2 万条）后暂停等用户确认 | 防止连续回填失控 |
| 限流退避 | 任一入口 429 → 整个账号暂停；等待时间取「接口给的重置时间」和「15 分钟起、逐次翻倍、最长 4 小时」中的较大者；退避到期并成功读取后重置 | 回填、入站、出站、手动更新、诊断和排期同步共用；不能用另一个入口绕过 |
| 入站每日更新 | 每天上午 08:00–11:30、晚间 18:00–22:30 完整窗口内各随机一次；页间 15–27 秒，每个后台事件最多 6 页；先读到接续点，再按上一轮读取时间向更早补 1 小时（`PACE.incOverlapMs`） | 普通尝试至少隔 10 分钟；有 `incResume` 或服务退避时不适用这个间隔。额外补漏只覆盖 X 的短时迟到，超过 1 小时没有绝对保证；重复靠主键去重。没接上时位置记在 `cursor.incResume`（`manual: true` 表示由初始化或立即更新启动），休息 3–5 分钟再续；自动续读跨出窗口就留到下一个窗口；接上之前 `syncedId` 不动 |
| 出站每日更新 | 每天上午 08:00–11:30、晚间 18:00–22:30 各随机一次；只读到接续点，通常一页；完整读或续读时每轮最多 5 页、页间 15–27 秒 | 不由入站顺带触发；`cursor.out.nextAutoAt` 决定下一次；自动等待/续读跨出窗口就留到下一个窗口 |
| 手动更新 | 10 分钟冷却；成功后把两份数据的下一次自动更新顺延到下一个上午或晚间时段 | 防止连点和当天重复扫 |
| 工作时段 / 前台 | 所有主动请求在本地时间 08:00–24:00；日常自动更新只在 08:00–11:30 和 18:00–22:30 启动；同账号 X 页面 `document.visibilityState === 'visible'` | `fetchViaTab()` 统一门控；其他时间、后台标签页、最小化窗口都不发主动请求；窗口外不补跑自动任务 |
| 增量被限流 | 放弃本轮，等下个周期 | |
| 并发 | 全局 `busy` 锁，同一时刻只有一个抓取动作。写法：先不占锁查该不该跑 → `if (busy) return; busy = true;`（中间不能有 `await`）→ 占住后再确认一遍；回填被占时约一个 1 分钟后的 `job` 闹钟再来 | `cursor:<账号>` 有多处读改写，一律走 `updateCursor`（排队），不要直接 `kvSet` |
| 首次抓取 | 必须用户手动点「初始化」；没初始化过的账号不自动抓 | |
| 总开关 | `fetchEnabled` 只控制日常自动读取；初始化和手动更新不走这个门控，关闭后仍能启动和续完 | 排期同步也不受这个开关控制，由打开排期弹窗按需触发 |
| 串号保护 | 请求只发给同一账号的页面，返回时身份不符则丢弃 | 找不到可用的同账号页面就等待 |
| 只读 | 全程只有 GET，没有任何写接口 | |

入站增量停止前要同时满足：整页最新一条早于「上一轮读取时间减 1 小时」的边界，并且整页最新一条不新于接续点。只满足其中一个就继续翻页，避免接续点较旧或 X 首页滞后时提前停。出站日常增量只读到接续点，不做时间回扫。

入站或出站增量遇到同一个 Bottom 游标会按分页异常停止，避免 X 重复返回同一页时空转消耗请求；接续点和覆盖范围都不前移。

实测依据：该接口响应头显示额度为 **180 次 / 15 分钟**（2026-11-13），网页版自用的 GraphQL 提及接口额度为 **1500 次 / 15 分钟**。2026-11-21 起不再追求接近额度，而是把请求压到每天很少几轮，并错开午夜和后台标签页。额度只是硬限流，X 的行为风控不公开；这套低频节奏仍需在真实账号上长期观察，但不应再靠短间隔回扫来换实时性。

页大小：旧提及 REST 接口和「我的回复」列表用 20，X 网页版的提及 GraphQL 用 40（2026-11-19 实测）。都在 `fetcher.js` 里集中定义；再调大前先实测服务端是否接受。

## 实测状态与已知未知（更新到 2026-11-21）

已确认（用一个提及列表为空的小号）：

- `GET /i/api/2/notifications/mentions.json` 返回 200，骨架为 `globalObjects` + `timeline.instructions`，游标在 `content.operation.cursor { value, cursorType }`。
- 请求头只需公开 Bearer、`x-csrf-token`（取自 `ct0`）、`x-twitter-auth-type`、`x-twitter-active-user`、`x-twitter-client-language`，**不需要** `x-client-transaction-id`。
- 列表为空时 `globalObjects` 是 `{}`，只返回一个 `Top` 游标。
- `twid`、`ct0` 可从 `document.cookie` 读到；`a[data-testid="AppTabBar_Profile_Link"]` 能取到 handle。

**「我回」这条线的实测（2026-11-19，小号；看的是两个公开账号的「回复」栏，和读我自己的是同一个接口）**：① 登录后读「回复」栏发的是 `GET /i/api/graphql/<id>/UserRepliesTimeline?variables=…&features=…`（名字变了，`REPLIES_RE` 认得）；② 资源计时记录在 x.com 上是空的，模板只能靠 `tap.js` 截到；③ 照模板重发**不需要** `x-client-transaction-id`，返回 200；④ 返回结构和 `parseMyReplies` 的假设一致（`legacy` 带 `in_reply_to_*`、`conversation_id_str`；条目是对话模块，带出我回的那条，但**不一定带出根帖**）；⑤ 额度 50 次 / 15 分钟。深层回复能不能认出根帖主人：两个账号共 63 条深层，根帖在页里的 29 条；根帖不在、但同一页有别的帖子直接回根帖、从而能推出主人的 29 条（现在的 `parseMyReplies` 还没用这一招）；认不出的 5 条。只看在别人帖子下的深层，认不出的约一半。开头那串 @ 里总包含根帖主人，但位置不固定，不能单靠它认。

**已确认的运行现状**：2026-11-14 起已在负责人的真实账号上运行，提及读取、榜单和名次标签能用；负责人不做逐条人工核对，以体验反馈为准。解析器认的 `in_reply_to_*`、`conversation_id_str` 和时间线条目引用形态已经在真实返回上跑通；任何一项不符仍会抛 `ParseError`，不会产生错误数据。

**提及延迟的实测（2026-11-21）**：一条回复在 10:29 发出，X 的提及接口到 10:46 仍只返回 10:13 的旧首页；10:47 X 页面自己拿到新数据，10:49 插件用同一接口补回 7 条。结论：不是插件的接口或解析漏抓，而是 X 的提及时间线短时滞后。0.24.0 曾改为每小时回看 24 小时；0.26.0 改为每天回看 52 小时；0.27.0 改为每天上午一次、接续点后只回看 6 小时，并把手动更新与自动更新开关拆开；0.28.0 改为每天上午、晚间各一次；0.29.0 把接续点后的补漏缩到 1 小时；0.30.0 恢复为在上午、晚间完整窗口内随机启动。

**未确认 / 待实测**：

1. 提及列表在真实账号的数据量下能往回翻多深；翻不到所选范围时界面会如实显示最早拿到哪天。
2. 长时间连续回填、增量是否会触发额度之外的行为风控。额度头和现有节奏只能证明不撞硬限流，不能证明 X 的行为风控边界。
3. 关系/M 的旁听字段（`relationship_perspectives.following / followed_by`、旧结构里的 `following / followed_by`、帖子归属结构）尚未在真实账号上确认；不符时只是不显示标签，不影响榜单。
4. 发帖排期快捷档期在真实 X 排期弹窗里的选择器兼容、日期联动和填入效果，需要按实际使用反馈调整；填入失败时界面会提示手动选时间。
5. X 改版后的页面结构和接口变化。读不了时弹窗报错，不静默兜底。

**提及的新接口实测（2026-11-19，小号）**：X 网页版读「提及」用 GraphQL `NotificationsTimeline`（查询 ID 当时仍是 `XANkUc-HLIcCl8q85rGC2A`，变量 `{ timeline_type: "Mentions", count, cursor }`，另带一长串 `features`）。额度 **1500 次 / 15 分钟**（旧 REST 接口 180 次）；网页版自己翻页用 `count: 40`；照模板重发不需要 `x-client-transaction-id`，`count: 40` 返回 200。返回在 `data.viewer_v2.user_results.result.notification_timeline.timeline.instructions`，条目是 `TimelineTimelineItem`，`clientEventInfo.element` 标明类型（回复我的是 `user_replied_to_your_tweet`），帖子在 `itemContent.tweet_results.result`，`legacy` 字段和「回复」栏的一样，游标在 `TimelineTimelineCursor`（`Top` / `Bottom`）。旧 REST 接口当天也还能用（200，180 次）。

每次实测有新结论，更新本节和 README 的「实测结论」。

## 与其他插件共存

标签挂在 `[data-testid="User-Name"]` 的**最后一个子节点里面**，不直接做它的子节点。原因（2026-11-13 实测）：FeedSieve 取「User-Name 的最后一个非自家子节点」作为插入位置，我们的标签如果是直接子节点，它的标记就会被塞进我们的标签里。以后改标签位置时保持这一点；再遇到别的插件冲突，先看对方怎么选插入点。

## 变更纪律

- 先改 `REQUIREMENTS.md`，再改代码；调度、界面或补漏策略的改动，不能顺手重写已经验证过的抓取、解析、入库接口和去重逻辑。确实要动核心接口时，先说明证据、影响和回退方式。
- 每次改动都要保住同一帖子 ID 只算一次、空值不覆盖已知事实、任务中断可续读这三条底线。
- 用户能感知的行为变化必须升版本、写 `CHANGELOG.md`、打标签并推送；纯文档、测试和重构不升版本。
- 可独立验收、可独立回退的功能分开提交。已经推送的历史不改写，不用 force-push。

## 版本与发布

- 版本号按 `主.次.修`：加功能或改用户看得到的行为升「次」，只修问题升「修」；1.0 之前不升「主」。
- 版本号写在两处，必须一致：`manifest.json` 的 `version`（弹窗标题旁显示的就是它）和 `package.json` 的 `version`。
- 每次改了用户能感知的东西：升版本号，在 `CHANGELOG.md` 顶部加一节（日期 + 用户看得懂的改动，不写实现细节），提交后打标签 `vX.Y.Z` 并推送。纯文档、测试、重构不升版本。
- **Git 由接手的 AI 自己管**（负责人 2026-11-19 定）：改完、测试通过就直接提交到 `main`，该打标签的打标签，然后推送，不用先问负责人。提交信息用中文写清楚改了什么；代码改动和纯文档改动分开提交。测试没跑通的不提交，先修好或者向负责人说明。
- **每个可独立验收、可独立回退的功能必须单独提交**（负责人 2026-11-21 纠正）：不要把按钮/窗口、自动刷新、样式或文案调整等互不依赖的变化混进同一个提交。提交前检查暂存区只含这一件事。后续否定某个功能时，优先 `git revert` 对应功能提交；如果该功能后来还有小修，就逐条回退对应提交，或单独提交“移除该功能”，不能连带撤掉其他已确认的功能。已经推送的历史不擅自 force-push 改写，保持标签和提交可追溯。
- 仓库是公开的：提交和文档里不出现账号、令牌、真实数据截图。许可证 MIT。
- 仓库名和目录名仍是 `x-inbound-rank`（最初的名字），插件对外的名字是「X 友」。
- 图标在 `icons/`（16 / 32 / 48 / 128），是自己画的蓝色花边圆章加白色对勾，不是 X 的原图。

## 排查

- 后台日志：`chrome://extensions` → 本插件 →「Service Worker」。
- 内容脚本日志：x.com 页面的 DevTools 控制台。
- 看状态：在 Service Worker 控制台执行 `chrome.storage.local.get(null).then(console.log)`。
- 看请求：x.com 页面 DevTools 的 Network 面板过滤 `mentions.json`。标签渲染时不应出现任何新请求。
- 改完代码在扩展页点刷新。插件会在 08:00–24:00 自动刷新当前前台的 x.com 常规页面；后台页面切到前台再补，通知页和夜间不自动刷新，只有自动刷新没发生时再手动刷新一次。

## 测试

```bash
npm install
```

```bash
npm test
```

- `test/logic.test.mjs`：榜单、口径过滤、规则合法化、颜色分档、解析分类与边界。
- `test/flow.test.mjs`：用假的 chrome API 和假接口跑后台全流程（回填、429 退避与续跑、去重、增量、关开关、清空）。
- `test/interface.test.mjs`：弹窗入口和标签悬浮信息的静态约束。
- `test/db.test.mjs`：重复写入的合并规则，空值不覆盖已知事实。
- `test/session.test.mjs`：账号会话切换和页面缓存隔离。
- `test/snapshot.test.mjs`：开发用本机快照的结构、文件名和摘要。
- `test/bridge.test.mjs`：本机桥的健康检查、快照落盘、摘要和来源校验。

这些测试的假数据都是按「预期的接口形态」写的，能证明逻辑自洽，**不能证明 X 真实返回长这样**。最近一次完整测试为 38 项全过（2026-11-21）。`fake-indexeddb` 只是测试依赖，插件本身零依赖、无需构建。

弹窗没有浏览器级自动测试（只有 `interface.test.mjs` 的静态约束）。改弹窗后可以临时做一个预览页来看：把 `src/ui/popup.html` 复制一份，在前面插一段模块脚本，用内存里的假数据实现 `chrome.runtime.sendMessage`（`getState`、`getAccountState`、`getBoard`、`setSettings`）和 `chrome.storage.onChanged`，用本地静态服务器打开。预览页用完删掉，不进仓库。

## 约定

- 面向用户的文字用简体中文；代码标识用英文。
- 出错必须让用户看见（`alert:<账号>` 或任务的 `message`），不允许静默失败或拿旧数据冒充完整。
- 不确定 X 的行为时写成「待实测」并让代码在不符时报错，不要按猜测静默兜底。
