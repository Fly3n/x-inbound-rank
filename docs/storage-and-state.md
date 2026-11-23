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
| `settings:<账号>` | `{ fetchEnabled, windowDays, initDays, topN, minCount, tiers: [{ min, color }], baseColor, show* }` |
| `tpl:replies:<账号>` / `tpl:mentions:<账号>` / `tpl:scheduled:<账号>` | `{ url, at }`：从 X 页面旁听到的请求模板 |
| `scheduled:<账号>` | `{ items, syncedAt, retryAt, errorCount }`：已排期列表缓存与失败退避 |
| `lastPostAt:<账号>` | 最近发帖或新建排期时间戳 |
| `cursor:<账号>` | `{ newestId, syncedId, earliestTs, lastIncrementalAt, nextIncAt, lastManualAt, lastAttemptAt, lastBackfill, lastPruneAt, incResume, rateUntil, rate429Count, out }` |
| `job:<账号>` | 入站历史回填任务状态 |
| `snap:<账号>` | 标签快照 `{ at, windowDays, show, users }`；抓取期节流 30 秒，结束时补算，内容不变不写入 |
| `alert:<账号>` | 最近一次抓取/解析错误，下次成功后清除 |
| `domWarning:<账号>` | 内容脚本结构自检异常标记 |
| `diagnostics:<小时>` | 本机读取诊断事件，按小时分键保留最近 7 天、全量不抽样（`diagnostics.js`） |

## 状态机与游标语义

### 回填任务（`job:<账号>`）

- `status`：`running` → `done`，中途可进入 `paused`（`auto: true` 为限流/503/夜间自动恢复，`auto: false` 为手动暂停或到达 600 页上限）、`waiting_tab`、`error`（登录失效、结构变更或重复游标）。
- 一步一页通过 `job:<账号>` 闹钟接力，避免 Service Worker 回收丢定时；30 分钟 `tick` 闹钟兜底接续、算榜与检查增量。
- 结束判定：本页 `newestTs < targetTs` 正常完成；无 `bottomCursor` 或空页记 `reachedEnd: true`；首屏可信空列表记哨兵 `syncedId = '0'`；新接口模板 400/404 删模板并退回旧 REST 从最新一页重来；翻页返回相同 `bottomCursor` 报 `error` 不推进接续点。

### 出站同步（`cursor.out`）

- 核心字段：`status`（`ok | need_tpl | error | queued | waiting_tab | reading`）、`syncedId`（空列表完成记 `'0'`）、`coverTs`、`reachedEnd`、`attemptCoverTs`（部分进度只用于展示，不作覆盖证明）、`limitReached`、`retryAt`、`rate429Count`、`fullFor`、`resume`、`manualTask`、`lastAt`、`lastFullAt`、`lastFullDays`、`nextAutoAt`、`pages`、`schema`（`OUT_SCHEMA = 2`）。
- 当 `!syncedId`、`fullFor === 0` 或 `schema < OUT_SCHEMA` 时做完整读；达到 `PACE.outMaxRounds`（120 轮 × 5 页 = 600 页）记 `error` + `limitReached: true` 並阻止自动闹钟空耗；返回 400/404 删除 `tpl:replies:<账号>` 并在拿到新 `xir:tpl` 后 3 秒安排续读。
- `outboundCountable(out)` 只要 `lastAt` 存在且 `schema >= OUT_SCHEMA` 即按窗口已有记录计数；`outboundReady` 仅用于初始化完成态与界面提示。

### 增量与分页异常边界

- 入站增量先接到 `syncedId`，再回看至 `lastIncrementalAt - 1h`（`PACE.incOverlapMs`）；两条件必须同时满足才停，防止接续点较旧或首页滞后提前结束。
- 入站或出站增量在接上旧接续点前遇到空页、无下一页或重复 `bottomCursor` 一律按分页异常中止，**绝不推进** `syncedId` / `lastIncrementalAt` / `coverTs`。
- 解析层遇到已删除/受保护等不可用单条回复只跳过该条；结构未知或作者数字 ID 缺失则整页抛 `ParseError`。

## 风控与并发参数（`src/bg/runtime.js` `PACE`）

| 机制 | 当前值 | 说明 |
|---|---|---|
| 回填页间隔 / 批休 | 随机 25–45 秒；每 10 页休 3–5 分钟 | 单次上限 600 页后暂停等确认 |
| 账号级 429 退避 | `max(X 重置时间, 15 分钟 × 2^n)` 上限 4 小时 | 回填、入站、出站、手动更新、诊断、排期同步共用，到期成功读取后清零 |
| 入站每日自动 | 08:00–11:30 与 18:00–22:30 完整窗口各随机 1 次 | 页间 15–27 秒，单事件最多 6 页；分段记 `incResume` 休 3–5 分钟，跨窗口留待下个窗口 |
| 出站每日自动 | 上述两窗口各随机 1 次，仅读到接续点 | 页间 15–27 秒，单轮最多 5 页（受 50 次/15 分钟额度限制），不与入站互相触发 |
| 手动立即更新 | 10 分钟冷却 | 成功后顺延下一次自动时段；`fetchEnabled` 不限制初始化与手动更新 |
| 时段与前台门控 | 本地 08:00–24:00 且同账号页面 `visible` | `fetchViaTab` 统一拦截夜间与后台标签页 |
| 并发与串行队列 | 全局 `busy` 锁 + `serial` 排队更新 `cursor` | 固定写法：先检查 → `tryAcquireBusy()`（无 `await`）→ 占住后再核对一次 |
