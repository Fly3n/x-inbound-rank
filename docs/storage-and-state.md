# 存储模型、状态机与风控节奏

## IndexedDB（库 `xir`，版本 2）

两张表均以 `[account, id]` 为复合主键，靠主键去重。`src/db.js` 将整表读（`getEvents`）结果以冻结数组缓存在 Service Worker 内存中，写入、清理或清空时作废（调用方排序须先复制）。`putEvents` 重读同一条时调用 `mergeKnown`：新响应里的 `null` / 空串不覆盖已有的根帖归属、正文、头像等已知事实。

### 表 `events`（别人回我）

| 字段 | 含义 |
|---|---|
| `id` | 回复帖子 ID |
| `actor_id` / `actor_handle` / `actor_name` / `actor_avatar` | 回复者身份与头像 |
| `created_at` | 毫秒时间戳 |
| `target_post_id` | 被回复的帖子 ID（我的帖子或评论） |
| `conversation_id` | 对话根帖 ID |
| `root_mine` | 根帖是否属于我：`true` / `false` / `null`（抓取页未带出时） |
| `text` | 去掉开头 `@`、最多 100 字的摘要；拿不到为空串（2026-11-14 前入库无此字段） |

表内全量保留所有直接回复我的记录（含 `root_mine === false`），算榜时由 `rank.js` `underMyPosts` 判定：直接为 `true`，或 `null` 时同 `conversation_id` 下存在 `root_mine === true` 的入站记录或 `out` 表 `own: true` 记录，改口径无需重抓。

### 表 `out`（我回别人）

| 字段 | 含义 |
|---|---|
| `id` | 我的回复帖子 ID |
| `created_at` | 毫秒时间戳 |
| `reply_to_id` | 直接回复的帖子 ID；等于 `conversation_id` 即直接评论根帖（`countsFromMe` 仅算此类） |
| `to_user_id` | 直接回复的对象 ID |
| `root_user_id` | 对话根帖作者 ID（`null` 表示该页未带出根帖；第一层必有） |
| `root_handle` | 根帖主人 `@ID`（仅用于全量导出显示） |
| `conversation_id` | 对话根帖 ID |
| `own` | 我在自己帖子下的回复标记为 `true`：不计数、不导出、不算入条数，仅作 `underMyPosts` 对话归属旁证（0.11.0 起存储） |
| `text` | 内容摘要 |

### 90 天保留与清理

两张表仅保留最近 90 天（`rank.js` `KEEP_DAYS`），兜底闹钟 `tick` 每天最多清一次；清掉过期数据后记 `cursor.prunedAt`。最早数据满 80 天（`WARN_DAYS`）且未清理过时弹窗上方红字提示导出，清理过后转为灰色小字提示。量级参考：单条约 300–500 字节，一周 1 万条回复的量级下，90 天约 13 万条、约 50 MB，全表读取约数百毫秒。

## `chrome.storage.local` 键设计（`db.js` `keys`）

| 键 | 内容 |
|---|---|
| `accounts` | `{ [dataKey]: { handle, userId, enabled, activation } }`；以 `userId` 为唯一身份基准 |
| `settings:<账号>` | `{ tapInEnabled, tapOutEnabled, windowDays, initDays, topN, minCount, tiers: [{ min, color }], baseColor, show* }`（旧版 `fetchEnabled` / `outAutoSync` 静默废弃） |
| `tpl:replies:<账号>` / `tpl:mentions:<账号>` / `tpl:scheduled:<账号>` | `{ url, at }`：从 X 页面旁听到的请求模板 |
| `scheduled:<账号>` | `{ items, syncedAt, retryAt, errorCount }`：已排期列表缓存与失败退避 |
| `lastPostAt:<账号>` | 最近一次电脑端原创/引用主帖时间戳（由 `CreateTweet` 旁听记录，不含回复评论） |
| `cursor:<账号>` | `{ newestId, syncedId, earliestTs, lastIncrementalAt, inLastReadAt, inLastReadCounts, inLastTapAt, inLastTapCounts, outLastTapAt, outLastTapCounts, nextIncAt, lastManualAt, lastAttemptAt, lastBackfill, lastPruneAt, incResume, incLimitReached, rateUntil, rate429Count, circuitBroken, out }` |
| `job:<账号>` | 入站历史补读任务状态 |
| `snap:<账号>` | 标签快照 `{ at, windowDays, show, users }`；抓取期节流 30 秒，结束时补算，内容不变不写入 |
| `alert:<账号>` | 最近一次抓取/解析错误，下次成功后清除 |
| `domWarning:<账号>` | 内容脚本结构自检异常标记 |
| `diagnostics:<小时>` | 本机读取诊断事件，按小时分键保留最近 7 天、全量不抽样（`diagnostics.js`） |

## 状态机与游标语义

### 回填任务（`job:<账号>`）

- `status`：`running` → `done`，中途可进入 `paused`（`auto: true` 为限流/503/夜间自动恢复，`auto: false` 为手动暂停或到达 220 页上限）、`waiting_tab`、`error`（登录失效、结构变更、重复游标或缺少通知接口模板 `needTpl: true`）。
- 一步一页通过 `job:<账号>` 闹钟接力，避免 Service Worker 回收丢定时；30 分钟 `tick` 闹钟兜底接续、算榜与检查增量；完成后清除 `incLimitReached`。
- 结束判定：本页 `newestTs < targetTs` 正常完成；无 `bottomCursor` 或空页记 `reachedEnd: true`；首屏可信空列表记哨兵 `syncedId = '0'`；通知模板缺失或 400/404 过期时删除模板并暂停等待用户自行打开一次 X 通知页刷新（不再降级旧 REST）；翻页返回相同 `bottomCursor` 报 `error` 不推进接续点。

### 旁听收集（零主动请求，默认日常数据来源）

- **别人回我（`tapInEnabled`，默认开启）**：`tap.js` → `rel.js` → `content.js` 捕获 X 页面自身发出的 `NotificationsTimeline` GET 响应（过滤自身主动请求），发往 `xir:inbound:tap` → `handleInboundTap`；关闭 `tapInEnabled` 时静默跳过不写库。`Mentions` 严格按 `parseMentions` 校验，`All` / `Verified` 允许跳过点赞/关注等非帖子条目并记录 `nonTweetEntries` / `nonTweetKinds`。结果按主键去重写入 `events` 表，记录 `cur.inLastTapAt` / `cur.inLastTapCounts`，**绝不推进 `cur.syncedId`**；全程记录 `inbound_tap`（以及异常时的 `inbound_tap_skipped` / `inbound_tap_failed`）与 `web_mentions_response` 日志，并在有新增时立即刷新快照、每次事件均触发 `queueBridgePush()` 同步至本机数据桥。
- **我回别人（`tapOutEnabled`，默认开启）**：
  - `CreateTweet` 响应经 `xir:outbound:tap` → `handleOutboundTap` 处理：原创/引用主帖刷新 `lastPostAt` 供发帖排期缓冲（不受 `tapOutEnabled` 影响）；回复事件在 `tapOutEnabled` 开启时写入 `OUT` 表并记录 `outbound_tap` / `outbound_tap_unmatched`、`cur.outLastTapAt` / `cur.outLastTapCounts`、触发 `queueBridgePush()`（不碰 `cur.out`）。
  - `UserRepliesTimeline` / `UserTweetsAndReplies` GET 响应经 `xir:replies:tap` → `handleRepliesTap` 在 `tapOutEnabled` 开启时核验 URL 中 `variables.userId === me.userId`（浏览他人主页时静默跳过），调用 `parseMyReplies` 写入 `OUT` 表，记录 `outbound_replies_tap` / `outbound_replies_tap_skipped` / `outbound_replies_tap_failed` 与 `cur.outLastTapAt` / `cur.outLastTapCounts`，**绝不碰 `cur.out`**（不推进 `syncedId` / `coverTs` / `lastAt`），每次事件均触发 `queueBridgePush()`。

### 出站手动同步（`cursor.out`）

- **按需手动补历史与独立立即更新**：后台不再定时自动刷回复栏，仅由用户手动点击「补历史」或「立即更新」触发 `syncOut(account, true)`（标 `manualTask: true`），中途退避/分段续读由 `OUT_ALARM` 自动接续直到本次手动任务结束，结束后即清空 `manualTask` 不再排期。`cursor.out` 核心字段为 `status`（`ok | need_tpl | error | queued | waiting_tab | reading`）、`syncedId`（空列表完成记 `'0'`）、`coverTs`、`reachedEnd`、`attemptCoverTs`（部分进度只用于展示，不作覆盖证明）、`limitReached`、`retryAt`、`rate429Count`、`fullFor`、`resume`、`manualTask`、`lastAt`、`lastManualAt`（独立 10 分钟冷却）、`lastFullAt`、`lastFullDays`、`pages`、`schema`（`OUT_SCHEMA = 2`）。
- 仅在 `fullFor === 0` 或已有旧结构升级（`schema < OUT_SCHEMA`）时做完整补历史；新账号无 `syncedId` 直接点出站「立即更新」时进入免补历史建起点模式（`bootstrap`，最多读 2 页即建立 `syncedId` 且不冒充已补历史）。达到 `PACE.outMaxRounds`（45 轮 × 5 页 = 225 页）记 `error` + `limitReached: true`；返回 400/404 删除 `tpl:replies:<账号>` 并在拿到新 `xir:tpl` 后 3 秒续完进行中的手动任务。
- **显示口径（有啥显示啥）**：`board()` 与 `refreshSnapshot()` 只要 `OUT` 表存在任一条非 `own` 记录，或 `cur.out?.lastAt` 存在，即在榜单与时间线标签按当前 `windowDays` 聚合展示「我回 N」；仅当两者皆无时才显示「—」。

### 手动增量与分页异常边界

- **不再定时自动抓取**：`maybeIncremental` 仅响应用户点击「立即更新」（`manual: true`）或续完该次未结束的分段手动任务（`cur.incResume?.manual === true`）；`tick`、`xir:active` 与 `recoverAlarms` 绝不自动发起入站或出站请求，升级时顺手清理旧版遗留的非手动 `inc:` / `out:` 闹钟。
- **免补历史直启与重叠即停**：尚未补过历史（无 `syncedId`）的账号手动点「立即更新」时，可直接以启用时间 `activation` 为起点最多翻 2 页建立接续点；已有 `syncedId` 时只要本页 `oldestId` 已与 `syncedId` 重叠（`!idGt(p.oldestId, stopAt)`）或越过 `KEEP_DAYS` 即停。
- **单轮 48 页安全上限**：入站手动更新单轮最多续读 `PACE.incMaxRounds = 8` 段（`8 × 6 = 48` 页）。第 8 段仍未重叠接续点时清除 `incResume`、置位 `cur.incLimitReached = true`、记录 `inc_limit_reached` 并停下提示。
- 入站或出站增量在接上旧接续点前遇到空页、无下一页或重复 `bottomCursor` 一律按分页异常中止，**绝不推进** `syncedId` / `lastIncrementalAt` / `coverTs`。
- 解析层遇到已删除/受保护等不可用单条回复只跳过该条；结构未知或作者数字 ID 缺失则整页抛 `ParseError`。

## 风控与并发参数（`src/bg/runtime.js` `PACE`）

| 机制 | 当前值 | 说明 |
|---|---|---|
| 回填页间隔 / 批休 | `humanBackfillDelay()`（15–110 秒连续右偏分布）；每 `humanBatchPages()`（8–12 页）休 3–5 分钟（连续分布） | 仅手动触发；单次上限 **220 页**后暂停等确认 |
| 账号级 429 退避 | `max(X 重置时间, 15 分钟 × 2^n)` 上限 4 小时；连续 3 次 429 升级硬熔断 | 回填、手动立即更新、排期同步共用，到期成功读取后清零 |
| 账号异常硬熔断 | 命中 HTTP 401/403、连续 3 次 429、`cf-mitigated`、非 5xx HTML 挑战页或账号异常错误码（32/64/89/226/326、`Bounce` 等）立即熔断 | 立即中止当前手动任务、清空全部闹钟与续读、记 `cursor.circuitBroken` 与红字告警；绝不自动恢复，仅用户确认账号正常后再次手动触发读取才解除 |
| 日常数据收集 | 零后台定时 `fetch`；默认由 `tapInEnabled` / `tapOutEnabled` 旁听浏览器自然请求入库 | 浏览通知页/提及页、发回复、浏览本人回复栏时即时去重写入，零额外网络请求 |
| 手动立即更新 | 入站（`updateNowWithReceipt`，单轮 8 段/48 页、页间 `humanIncDelay()`）与出站（`updateOutNowWithReceipt`，单轮 45 轮/225 页）各自独立 10 分钟冷却 | 仅用户手动点击触发，彼此互不牵连，不受旁听收集开关影响 |
| 时段与前台门控 | 本地 08:00–24:00、同账号页面 `visible` | `fetchViaTab` 统一拦截夜间与后台标签页；后台不发任何无人值守定时请求 |
| 并发与串行队列 | 全局 `busy` 锁 + `serial` 排队更新 `cursor` | 固定写法：先检查 → `tryAcquireBusy()`（无 `await`）→ 占住后再核对一次 |
