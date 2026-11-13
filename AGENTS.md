# 维护入口（给接手的 AI / 开发者）

Chrome 插件（Manifest V3，无构建步骤，原生 JS）。统计「谁最常在我的 X 帖子下回复我」，并在时间线用户名旁标注排名。只自用，开发者模式加载，不上架商店。使用说明见 `README.md`，本文件只讲技术事实和维护约束。

## 已定的产品决策（改之前先问负责人）

- 只统计**回复**，只有一个回复榜（7 天 / 30 天）。引用、点赞、转发、综合榜都不做（2026-11-13 负责人定）。
- 只算**我的帖子下**别人直接回复我的；我去别人帖子下评论后对方回我的不算（同日定）。
- 数据来源是 X 网页版「通知 → 提及」的内部接口，用已登录的网页会话读。不走官方 API，不逐帖抓评论（请求量大、接口更脆，已比较过）。
- 零写操作：不点赞、不关注、不发帖。数据只存本机，无任何上报。
- 权限只有 `storage`、`alarms` 和 x.com / twitter.com 的站点权限。不加 `cookies`、`tabs`、`scripting`。
- 不做时间衰减、不做「我回了他」加分、不做收费。

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
| `src/x/fetcher.js` | 抓取层：接口路径、参数、请求头。返回 `{ ok, status, body, rateResetAt, userId, error }`，不抛异常 | X 改接口 |
| `src/x/parser.js` | 解析层：原始 JSON → `{ events, entryIds, newestId, oldestId, oldestTs, bottomCursor }`。结构不符抛 `ParseError` | X 改返回结构 |
| `src/content/content.js` | 账号识别、代发请求、画标签。页面选择器集中在顶部 `SEL` | X 改页面结构 |
| `src/background.js` | 调度：回填、增量、限流退避、账号绑定、消息处理。节奏参数集中在顶部 `PACE` | 调节奏、改流程 |
| `src/rank.js` | 纯函数：口径过滤 `underMyPosts`、聚合、榜单、标签快照 | 改统计口径 |
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

表里存的是**所有直接回复我的**，包括 `root_mine` 为 `false` 的；是否上榜在 `rank.js` 的 `underMyPosts` 里过滤。这样以后改口径不用重新抓。`root_mine === null` 的，只有同一 `conversation_id` 下存在 `root_mine === true` 的记录时才计入。

`chrome.storage.local` 键（定义在 `db.js` 的 `keys`）：

| 键 | 内容 |
|---|---|
| `accounts` | `{ [handle小写]: { handle, userId, seenAt } }` |
| `current` | 当前 X 会话登录的账号 |
| `pendingUserId` | 识别不到 handle、等用户手填时暂存的用户 ID |
| `settings:<账号>` | `{ fetchEnabled }` |
| `cursor:<账号>` | `{ newestId, syncedId, earliestTs, lastIncrementalAt, lastAttemptAt, lastBackfill }`。`syncedId` 是增量的接续点：从它往更早到回填终点是连续完整的。回填完成时设为该次回填的起点；增量正常结束或读满上限时前移到本轮最新一条，出错中断时不动、下次重读这一段（靠主键去重） |
| `job:<账号>` | 回填任务状态，见下 |
| `snap:<账号>` | 标签快照 `{ at, users: { handle小写: { rank, c30, c7, last } } }` |
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
| 增量 | 固定每小时一次（不可配，要停用关总开关），从最新读回到上次的接续点为止，页间 3–6 秒，单次最多 40 页（约 800 条），两次尝试至少隔 10 分钟 | 间隔里来多少读多少；40 页上限是为了不超过 Service Worker 单次事件约 5 分钟的时限。读满 40 页还没接上就静默停止、放弃没读到的那段，不提示（负责人 2026-11-13 定：不需要那么严格） |
| 增量被限流 | 放弃本轮，等下个周期 | |
| 并发 | 全局 `busy` 锁，同一时刻只有一个抓取动作 | |
| 首次抓取 | 必须用户手动点「启动 / 初始化」；没初始化过的账号不自动抓 | |
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

**未确认**（没有真实回复数据，第一次在有回复的账号上运行时才见分晓）：

1. 回复条目是否带 `in_reply_to_user_id_str` / `in_reply_to_screen_name` / `in_reply_to_status_id_str` / `conversation_id_str`，以及时间线条目是否以 `{ tweet: { id } }` 引用帖子。任何一项不符，解析层会抛 `ParseError`，弹窗显示错误，不会产生错误数据。
2. 提及列表能往回翻多深。
3. 连续回填是否触发行为风控。
4. 内容脚本里的标签注入（`[data-testid="User-Name"]`）在真实时间线上的显示效果。
5. 整个插件尚未在真实 Chrome 里加载运行过；验证过的是纯逻辑和用假 chrome API 跑的后台流程（见测试）。

**最大的维护风险**：X 网页版自己已改用 GraphQL `NotificationsTimeline`（变量 `{ timeline_type: "Mentions", count: 20 }`，查询 ID 当时为 `XANkUc-HLIcCl8q85rGC2A`，另带一长串 `features` 参数），上面的 REST 接口是旧版，随时可能下线。下线后要重写 `fetcher.js` 和 `parser.js`：GraphQL 的查询 ID 和 `features` 随 X 发版变化，需要从页面实际请求里取，不能写死太久。

每次实测有新结论，更新本节和 README 的「实测结论」。

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

- `test/logic.test.mjs`：榜单、口径过滤、解析分类与边界。
- `test/flow.test.mjs`：用假的 chrome API 和假接口跑后台全流程（回填、429 退避与续跑、去重、增量、关开关、清空）。

两者的假数据都是按「预期的接口形态」写的，能证明逻辑自洽，**不能证明 X 真实返回长这样**。`fake-indexeddb` 只是测试依赖，插件本身零依赖、无需构建。

## 约定

- 面向用户的文字用简体中文；代码标识用英文。
- 出错必须让用户看见（`alert:<账号>` 或任务的 `message`），不允许静默失败或拿旧数据冒充完整。
- 不确定 X 的行为时写成「待实测」并让代码在不符时报错，不要按猜测静默兜底。
