# 维护入口（给接手的 AI / 开发者）

Chrome 插件（Manifest V3，无构建步骤，原生 JS）。统计「谁最常在我的 X 帖子下回复我」，并在时间线用户名旁标注排名。只自用，开发者模式加载，不上架商店。使用说明见 `README.md`，本文件只讲技术事实和维护约束。

## 已定的产品决策（改之前先问负责人）

- 只统计**回复**，只有一个回复榜。引用、点赞、转发、综合榜都不做（2026-11-13 负责人定）。
- 只有一个**统计范围**（代码里叫统计窗口，设置项 `windowDays`）：7 天（默认）、15 天或 30 天（30 天是负责人 2026-11-14 加的，之前定过不要）。回填范围、榜单、时间线标签都用它；榜单页和设置页「数据读取」里的两个下拉框改的是同一个设置。
- 榜单和标签只有两个条件：窗口内回复至少 `minCount` 次；最多前 `topN` 名。两个值用户可调（2026-11-13 负责人定）：`topN` 默认 100、范围 10–500、界面每次加减 50；`minCount` 默认 2、范围 1–99、每次加减 1。不足名次上限就有多少显示多少。
- 时间线标签显示「名次图标 + 名次、回复图标 + 次数」。颜色按**回复次数**分档，不按名次（名次靠后的往往都只有两三次，负责人要的是一眼判断值不值得回）。默认：≥20 次红、10–19 次橙、5–9 次蓝、其余灰（负责人 2026-11-13 按一周的量定），各个统计范围共用。用户可改每档的门槛和颜色、加档删档，最多 4 个门槛档加 1 个兜底色共 5 种；可选 8 色（`rank.js` 的 `COLORS`，色值在 `badge.css` 的 `[data-xir-c]`，弹窗通过引入同一份 CSS 共用）。颜色都是实心底色配固定字色，不随 X 的主题变。
- 规则的默认值、范围和合法化都在 `rank.js`（`DEFAULT_RULES`、`LIMITS`、`cleanRules`）；设置读出时总会过一遍 `cleanRules`，所以别处不用再校验。「恢复默认」只恢复 `topN`、`minCount`、`tiers`、`baseColor`。
- 设置页的排布（2026-11-14 负责人定）：用户要操作的在前，说明在后。「数据读取」里先是统计范围，然后两份数据分开各占一块，按钮都叫「初始化」（别人回我：`startBackfill`；我回别人：`syncOutNow`，强制按范围重新读一遍），每块下面一行现状（本机条数、起止日期、上次初始化完成的时间和范围、上次更新时间，数据来自 `getAccountState` 的 `db` 和 `cursor`）；「风险说明」「清空数据」在最后、默认折叠。
- 说明文字一律做成小问号（2026-11-14 负责人定）：`<button class="q" data-tip="某个 id">?</button>` 加一个 `<div class="tip" id="同一个 id" hidden>`，点了展开或收起，`popup.js` 里一个事件委托处理。内容写成简短的列表。以后加说明照这个做，不在界面上直接铺大段文字。
- 弹窗分「榜单」「设置」两页；榜单页有搜索、小问号说明（第一条是范围内总量汇总）、导出。行上只有头像是去他主页的链接，点这一行其他地方展开这个人在范围内的回复列表（只用本地已有数据，不发请求）。导出分两种：「导出榜单」（榜上的人）和「导出全量数据」（`exportAll`，两张表的每一条，同一张 CSV 里用「类型」列区分），都在弹窗里本地生成文件。
- 关系标签和「我帖 / 他帖」（2026-11-14 负责人定）：首页等所有有帖子的地方，用户名旁标他和我的关系（互关 / 粉丝 / 已关注，互不关注不标），对象是页面上的所有人，不限于回复过我的；通知列表里回复我的那条再标是在谁的帖子下。插件不维护关注列表和粉丝列表，关系只取 X 页面自己的接口返回里带的：`tap.js` 跑在页面的脚本环境（`world: MAIN`、`document_start`），包住 `XMLHttpRequest` 和 `fetch`，把 `/i/api/graphql/`、`/i/api/2/` 的返回文本用 `postMessage` 转给隔离环境里的 `rel.js`，`rel.js` 解析后只放内存（各最多 8000 条），不落盘、不发请求。`tap.js` 里不放任何业务逻辑，出错全部吞掉，不能影响 X 页面。帖子归属先用页面数据判断（`XIRRel.placeOf`），判断不了的由内容脚本发 `xir:where` 问后台，后台用两张表算（`rank.js` 的 `replyPlaces`）。整条线未在真实账号上验证。
- 每次「初始化」都从最新一条重新往回读，不做接续翻页（负责人知情后定）。
- 只算**我的帖子下**别人直接回复我的；我去别人帖子下评论后对方回我的不算（同日定）。
- 榜单每行另带「我回 N」：同一窗口内**我在他的帖子下**回复了几次（2026-11-14 负责人定）。按对话根帖的作者算——在他帖子下回复任何人都算他的，在我自己帖子下回他的不算。只在弹窗榜单和导出里显示，不影响排名、不进时间线标签。
- 「我回」的数据来自我自己主页「回复」栏背后的接口（GraphQL `UserTweetsAndReplies`）。它的查询 ID 和 `features` 参数随 X 发版变化，所以不写死：内容脚本从浏览器的资源计时记录里记下 X 页面自己发过的那条请求地址，抓取时只换掉 `userId`、`count`、`cursor` 照着发。代价是用户要在 X 上打开过一次任意主页的「回复」栏，X 换参数后要再打开一次（弹窗会提示）。
- 数据来源是 X 网页版「通知 → 提及」的内部接口，用已登录的网页会话读。不走官方 API，不逐帖抓评论（请求量大、接口更脆，已比较过）。
- 零写操作：不点赞、不关注、不发帖。数据只存本机，无任何上报。
- 权限只有 `storage`、`alarms` 和 x.com / twitter.com 的站点权限。不加 `cookies`、`tabs`、`scripting`。
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

请求必须从 x.com 页面里发：同源、自带会话 cookie，`ct0` 可从 `document.cookie` 读到，所以不需要 `cookies` 权限。代价是没有 x.com 标签页开着就抓不了，任务会停在「等待标签页」，下次有页面上线（内容脚本发 `xir:hello`）时自动接上。

## 文件职责

| 文件 | 职责 | 何时改 |
|---|---|---|
| `src/x/fetcher.js` | 抓取层：接口路径、参数、请求头。`fetchMentions` 读提及，`fetchMyReplies(tpl, cursor)` 照模板读我的回复列表。返回 `{ ok, status, body, rateResetAt, userId, error }`，不抛异常 | X 改接口 |
| `src/x/parser.js` | 解析层：`parseMentions` 原始 JSON → `{ events, entryIds, newestId, oldestId, oldestTs, bottomCursor }`；`parseMyReplies` → 我在别人帖子下的回复。结构不符抛 `ParseError` | X 改返回结构 |
| `src/content/content.js` | 账号识别、代发请求、画标签、记下 X 读「回复」栏的请求地址（`xir:tpl`）。页面选择器集中在顶部 `SEL` | X 改页面结构 |
| `src/background.js` | 调度：回填、增量、限流退避、账号绑定、消息处理。节奏参数集中在顶部 `PACE` | 调节奏、改流程 |
| `src/rank.js` | 纯函数：口径过滤 `underMyPosts`、聚合、榜单、标签快照、`outboundCounts`（我回他几次）；榜单规则的默认值、范围、合法化 | 改统计口径、规则默认值 |
| `src/db.js` | IndexedDB 封装与 `chrome.storage.local` 键名 | 改数据模型 |
| `src/ui/` | 弹窗 | 改界面 |

**隔离原则**：只有 `fetcher.js` 和 `parser.js` 知道 X 接口长什么样，只有 `content.js` 的 `SEL` 知道 X 页面长什么样。其他文件不得出现 X 的字段名或选择器。

## 数据模型

IndexedDB 库 `xir`，表 `events`，主键 `[account, id]`（账号小写 handle + 回复的帖子 ID），去重靠主键。

| 字段 | 含义 |
|---|---|
| `id` | 这条回复的帖子 ID |
| `actor_id` / `actor_handle` / `actor_name` / `actor_avatar` | 回复者 |
| `created_at` | 毫秒时间戳 |
| `target_post_id` | 被回复的那条（我的帖子或评论） |
| `conversation_id` | 对话根帖 ID |
| `root_mine` | 根帖是不是我的：`true` / `false` / `null`（抓取时那页看不出来） |
| `text` | 回复内容摘要：去掉开头的 @、最多 100 字；只给弹窗「点开某人」看，拿不到是空串。2026-11-14 之前入库的没有这个字段，重新初始化会补上 |

表里存的是**所有直接回复我的**，包括 `root_mine` 为 `false` 的；是否上榜在 `rank.js` 的 `underMyPosts` 里过滤。这样以后改口径不用重新抓。`root_mine === null` 的，只有同一 `conversation_id` 下存在 `root_mine === true` 的记录时才计入。

表 `out`（库版本 2 加的）：我在别人帖子下的回复，主键同样是 `[account, id]`。字段：`created_at`、`to_user_id`（直接回复的人）、`root_user_id`（对话根帖作者，`null` = 抓取时那页没带出根帖，统计时靠同一对话的其他回复补判，补不了不计）、`conversation_id`、`text`。我自己帖子下的回复在解析时就丢掉，不入库。

「我回」的同步状态在 `cursor.out`：`{ status: 'ok' | 'need_tpl' | 'error', message, syncedId, coverTs, fullFor, resume, lastAt, lastFullAt, lastFullDays, pages }`。`syncedId` 是上次读到的最新一条；`fullFor` 是最近一次完整读覆盖的统计范围（天）。`fullFor` 不小于当前范围时只读到 `syncedId` 为止；否则（第一次、范围改大了、手动点「初始化」把它清零）做一次完整读，读到范围起点。单个闹钟事件最多 40 页；完整读没读完就把位置记在 `resume` 里，1–2 分钟后的下一个 `out` 闹钟接着读，最多 10 轮（`PACE.outMaxRounds`），读完记 `lastFullAt` / `lastFullDays`。`lastAt` 是最近一次读完的时间，弹窗据此决定显不显示「我回 N」。平时由 `out` 闹钟触发：每轮增量或回填结束后 1–2 分钟，单独一个事件。接口返回 400 / 404 时认为模板过期，删掉 `tpl:replies` 并提示用户再打开一次「回复」栏；拿到新模板（`xir:tpl`）后 3 秒补读。事件里的 `root_handle`（根帖主人的 @ID）只给全量导出显示用，不参与统计。

**保留期**：两张表都只留最近 45 天（`background.js` 的 `KEEP_DAYS`），兜底闹钟里每天最多清一次。最长的统计范围是 30 天，更早的用不上；不清的话库会无限增长，而每次重算快照都要把该账号的事件全读一遍。量级参考：一条约 300–500 字节，一周 1 万条回复时 45 天约 6 万多条、二三十 MB，全读一遍在百毫秒级。

`chrome.storage.local` 键（定义在 `db.js` 的 `keys`）：

| 键 | 内容 |
|---|---|
| `accounts` | `{ [handle小写]: { handle, userId, seenAt } }` |
| `current` | 当前 X 会话登录的账号 |
| `pendingUserId` | 识别不到 handle、等用户手填时暂存的用户 ID |
| `settings:<账号>` | `{ fetchEnabled, windowDays, topN, minCount, tiers: [{ min, color }], baseColor }`，后五项是榜单规则，见 `rank.js` 的 `DEFAULT_RULES` |
| `cursor:<账号>` | `{ newestId, syncedId, earliestTs, lastIncrementalAt, nextIncAt, lastAttemptAt, lastBackfill, lastPruneAt }`。`nextIncAt` 是下一次增量最早什么时候跑。`syncedId` 是增量的接续点：从它往更早到回填终点是连续完整的。回填完成时设为该次回填的起点；增量正常结束或读满上限时前移到本轮最新一条，出错中断时不动、下次重读这一段（靠主键去重） |
| `job:<账号>` | 回填任务状态，见下 |
| `snap:<账号>` | 标签快照 `{ at, windowDays, users: { handle小写: { rank, count, color, last } } }`，内容就是回复榜；改任何设置、有 X 页面上线时都立刻重算 |
| `alert:<账号>` | 最近一次抓取或解析错误，下次成功后清除 |
| `activeJobAccount` | 当前回填任务属于哪个账号（同一时刻只有一个） |
| `domWarning` | 内容脚本发现页面结构对不上时置位 |

## 回填任务状态机

`job.status`：`running` → `done`；中途可能进入 `paused`（`auto: true` 是限流退避、到 `nextAt` 自动恢复；`auto: false` 是手动暂停或达到单次页数上限，要用户点继续）、`waiting_tab`（没有可用的 x.com 标签页）、`error`（登录失效、接口异常、解析失败、账号不一致，不自动重试）。

每一步由 `stepBackfill()` 拉一页，再用 `chrome.alarms` 约下一步（Service Worker 会被回收，不能靠 `setTimeout` 等长间隔；状态全部落在 storage 里）。每 30 分钟的 `tick` 闹钟兜底：接上丢失的步骤、重算快照、检查增量是否到期。

结束条件：本页最早一条早于目标时间 → 正常完成；没有下一页游标或本页为空 → 完成并标 `reachedEnd: true`，界面如实显示「最早只拿到某天」。

重新初始化会从最新一页重新翻，已有记录靠主键去重。

## 风控（节奏参数在 `background.js` 的 `PACE`）

| 机制 | 当前值 | 说明 |
|---|---|---|
| 回填页间隔 | 随机 8–15 秒 | 接近人手快速下拉的频率 |
| 回填分批 | 每 20 页休息随机 1–2 分钟 | 合计约每小时 220 页 ≈ 4400 条提及；约为硬额度的三成 |
| 单次页数上限 | 600 页（约 1.2 万条）后暂停等用户确认 | 防止失控 |
| 限流退避 | 429 → 暂停；等待时间取「接口给的重置时间」和「15 分钟起、逐次翻倍、最长 4 小时」中的较大者；成功一页后退避重置 | |
| 增量 | 大约每小时一次：每轮结束后随机定 50–70 分钟后的下一次，约一个专门的 `inc` 闹钟（不可配，要停用关总开关），从最新读回到上次的接续点为止，页间 3–6 秒，单次最多 40 页（约 800 条），两次尝试至少隔 10 分钟 | 间隔里来多少读多少；40 页上限是为了不超过 Service Worker 单次事件约 5 分钟的时限。读满 40 页还没接上就静默停止、放弃没读到的那段，不提示（负责人 2026-11-13 定：不需要那么严格） |
| 增量被限流 | 放弃本轮，等下个周期 | |
| 并发 | 全局 `busy` 锁，同一时刻只有一个抓取动作 | |
| 首次抓取 | 必须用户手动点「初始化」；没初始化过的账号不自动抓 | |
| 总开关 | `fetchEnabled` 关闭后 `pull()` 直接拒绝，正在跑的任务被暂停 | |
| 串号保护 | 每次请求带回当前会话的用户 ID，与任务账号不一致就报错停止 | |
| 只读 | 全程只有 GET，没有任何写接口 | |

实测依据：该接口响应头显示额度为 **180 次 / 15 分钟**（2026-11-13）。最初的节奏是每页 40–80 秒、每 6 页休息 10–20 分钟（约每小时 18 页），负责人反馈一周可能有上千到上万条回复、太慢，2026-11-13 调到现值（约 55 次 / 15 分钟）。额度只是硬限流，X 的行为风控不公开；这个节奏尚未在真实账号上长时间跑过，要再调快先小步试，被限流过就往回调。

页大小 `count` 固定 20（与网页版一致）。调大它能成倍提速，但服务端是否接受更大的值未验证，且与网页版行为不一致，暂不动。

## 实测状态与已知未知（2026-11-13）

已确认（用一个提及列表为空的小号）：

- `GET /i/api/2/notifications/mentions.json` 返回 200，骨架为 `globalObjects` + `timeline.instructions`，游标在 `content.operation.cursor { value, cursorType }`。
- 请求头只需公开 Bearer、`x-csrf-token`（取自 `ct0`）、`x-twitter-auth-type`、`x-twitter-active-user`、`x-twitter-client-language`，**不需要** `x-client-transaction-id`。
- 列表为空时 `globalObjects` 是 `{}`，只返回一个 `Top` 游标。
- `twid`、`ct0` 可从 `document.cookie` 读到；`a[data-testid="AppTabBar_Profile_Link"]` 能取到 handle。

**「我回」这条线整个待实测（2026-11-14 写成，一次真实请求都没发过）**：① 登录后的网页版读「回复」栏是不是还发 `GET /i/api/graphql/<id>/UserTweetsAndReplies?variables=…&features=…`（未登录的 x.com 已换成另一套前端，看不到登录后的请求）；② 资源计时记录里能不能看到这条地址；③ 照模板重发要不要 `x-client-transaction-id`（提及接口不需要，GraphQL 未知）；④ 返回结构是否如 `parseMyReplies` 所假设（帖子是 `{ legacy: { id_str, user_id_str, in_reply_to_*, conversation_id_str }, core.user_results }`，对话条目会带出根帖）。任何一项不符，结果是弹窗里「我回」那行显示读不了或出错，榜单其余部分不受影响。

**未确认**（没有真实回复数据，第一次在有回复的账号上运行时才见分晓）：

1. 回复条目是否带 `in_reply_to_user_id_str` / `in_reply_to_screen_name` / `in_reply_to_status_id_str` / `conversation_id_str`，以及时间线条目是否以 `{ tweet: { id } }` 引用帖子。任何一项不符，解析层会抛 `ParseError`，弹窗显示错误，不会产生错误数据。
2. 提及列表能往回翻多深。
3. 连续回填是否触发行为风控。
4. 内容脚本里的标签注入（`[data-testid="User-Name"]`）在真实时间线上的显示效果。
5. 整个插件尚未在真实 Chrome 里加载运行过；验证过的是纯逻辑和用假 chrome API 跑的后台流程（见测试）。

**最大的维护风险**：X 网页版自己已改用 GraphQL `NotificationsTimeline`（变量 `{ timeline_type: "Mentions", count: 20 }`，查询 ID 当时为 `XANkUc-HLIcCl8q85rGC2A`，另带一长串 `features` 参数），上面的 REST 接口是旧版，随时可能下线。下线后要重写 `fetcher.js` 和 `parser.js`：GraphQL 的查询 ID 和 `features` 随 X 发版变化，需要从页面实际请求里取，不能写死太久。

每次实测有新结论，更新本节和 README 的「实测结论」。

## 与其他插件共存

标签挂在 `[data-testid="User-Name"]` 的**最后一个子节点里面**，不直接做它的子节点。原因（2026-11-13 实测）：FeedSieve 取「User-Name 的最后一个非自家子节点」作为插入位置，我们的标签如果是直接子节点，它的标记就会被塞进我们的标签里。以后改标签位置时保持这一点；再遇到别的插件冲突，先看对方怎么选插入点。

## 版本与发布

- 版本号按 `主.次.修`：加功能或改用户看得到的行为升「次」，只修问题升「修」；1.0 之前不升「主」。
- 版本号写在两处，必须一致：`manifest.json` 的 `version`（弹窗标题旁显示的就是它）和 `package.json` 的 `version`。
- 每次改了用户能感知的东西：升版本号，在 `CHANGELOG.md` 顶部加一节（日期 + 用户看得懂的改动，不写实现细节），提交后打标签 `vX.Y.Z` 并推送。纯文档、测试、重构不升版本。
- 仓库是公开的：提交和文档里不出现账号、令牌、真实数据截图。许可证 MIT。
- 仓库名和目录名仍是 `x-inbound-rank`（最初的名字），插件对外的名字是「X 回复榜」。
- 图标在 `icons/`（16 / 32 / 48 / 128），是自己画的蓝色花边圆章加白色对勾，不是 X 的原图。

## 排查

- 后台日志：`chrome://extensions` → 本插件 →「Service Worker」。
- 内容脚本日志：x.com 页面的 DevTools 控制台。
- 看状态：在 Service Worker 控制台执行 `chrome.storage.local.get(null).then(console.log)`。
- 看请求：x.com 页面 DevTools 的 Network 面板过滤 `mentions.json`。标签渲染时不应出现任何新请求。
- 改完代码要在扩展页点刷新，**并刷新 x.com 标签页**（旧内容脚本已失效）。

## 测试

```bash
npm install
```

```bash
npm test
```

- `test/logic.test.mjs`：榜单、口径过滤、规则合法化、颜色分档、解析分类与边界。
- `test/flow.test.mjs`：用假的 chrome API 和假接口跑后台全流程（回填、429 退避与续跑、去重、增量、关开关、清空）。

两者的假数据都是按「预期的接口形态」写的，能证明逻辑自洽，**不能证明 X 真实返回长这样**。`fake-indexeddb` 只是测试依赖，插件本身零依赖、无需构建。

弹窗没有自动测试。改弹窗后可以临时做一个预览页来看：把 `src/ui/popup.html` 复制一份，在前面插一段模块脚本，用内存里的假数据实现 `chrome.runtime.sendMessage`（`getState`、`getAccountState`、`getBoard`、`setSettings`）和 `chrome.storage.onChanged`，用本地静态服务器打开。预览页用完删掉，不进仓库。

## 约定

- 面向用户的文字用简体中文；代码标识用英文。
- 出错必须让用户看见（`alert:<账号>` 或任务的 `message`），不允许静默失败或拿旧数据冒充完整。
- 不确定 X 的行为时写成「待实测」并让代码在不符时报错，不要按猜测静默兜底。
