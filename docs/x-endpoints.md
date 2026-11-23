# X 接口实测状态与已知未知

最后核对日期：2026-11-23（每次实测得出新结论时同步更新本文档与 `README.md`）。

## 已确认事实

### 1. 旧版 REST 提及接口（小号实测，2026-11-13 / 2026-11-19）

- `GET /i/api/2/notifications/mentions.json` 返回 200，响应头额度为 **180 次 / 15 分钟**，页大小用 20。
- 骨架为 `globalObjects` + `timeline.instructions`，游标在 `content.operation.cursor { value, cursorType }`。
- 请求头只需公开 Bearer、`x-csrf-token`（取自 `ct0` cookie）、`x-twitter-auth-type`、`x-twitter-active-user`、`x-twitter-client-language`，**不需要** `x-client-transaction-id`。
- 列表为空时 `globalObjects` 为 `{}`，仅返回一个 `Top` 游标。
- `twid`、`ct0` 可从 `document.cookie` 读到；`a[data-testid="AppTabBar_Profile_Link"]` 可取到当前 `@handle`。

### 2. 新版 GraphQL 提及接口（小号实测，2026-11-19）

- X 网页版读通知使用 `NotificationsTimeline`（当时查询 ID 为 `XANkUc-HLIcCl8q85rGC2A`，变量 `{ timeline_type: "Mentions", count, cursor }` 与一长串 `features`）。
- 响应头额度为 **1500 次 / 15 分钟**（旧 REST 的 8 倍多），网页版自身翻页用 `count: 40`；照页面模板重发不需要 `x-client-transaction-id`，返回 200。
- 返回路径为 `data.viewer_v2.user_results.result.notification_timeline.timeline.instructions`，条目为 `TimelineTimelineItem`，`clientEventInfo.element` 标明通知类型（回复我为 `user_replied_to_your_tweet`），帖子在 `itemContent.tweet_results.result`，`legacy` 字段与「回复」栏一致，游标为 `TimelineTimelineCursor`（`Top` / `Bottom`）。
- 不得主动后台打开通知页取模板：X 一打开通知页即会将未读通知标成已读，属状态改动。

### 3. 「我回别人」接口（小号实测，2026-11-19）与发帖旁听

- 个人主页「回复」栏发送 `GET /i/api/graphql/<id>/UserRepliesTimeline?variables=...&features=...`（旧名曾为 `UserTweetsAndReplies`，`fetcher.js` 的 `REPLIES_RE` 兼容匹配）。
- 浏览器资源计时记录在 `x.com` 上为空，模板 URL 只能通过 `tap.js` 旁听截取。
- 照模板替换 `userId`、`count`、`cursor` 重发**不需要** `x-client-transaction-id`，返回 200，页大小 20；但额度只有 **50 次 / 15 分钟**。
- 返回结构在对话模块中带出我发出的回复，但**不一定带出根帖**：实测两个公开账号共 63 条深层回复中，根帖在页里的 29 条，同一页有其它帖子直接回根帖从而可推出主人的 29 条（`parseMyReplies` 尚未启用该推算），认不出根帖的 5 条；只看别人帖子下的深层回复，约一半认不出根帖主人，开头 `@` 串位置也不固定。因此「我回 N」口径定为只算第一层。
- **网页发帖实时旁听（0.31.0 新增，待真实载荷实测核对）**：在浏览器发送回复时，`tap.js` 将 `CreateTweet` POST 响应传至 `rel.js` → `content.js` → `handleOutboundTap`，由 `parseCreatedReply` 提取 `data.create_tweet.tweet_results.result`（含 `TweetWithVisibilityResults` 解包）并直接写入 `OUT` 表；结构缺失时只记录 `outbound_tap_unmatched` 诊断日志，不污染数据。

### 4. 真实账号运行与提及延迟现象

- 2026-11-14 起在负责人真实账号上运行，提及读取、榜单和名次标签可用，解析器假设的 `in_reply_to_*`、`conversation_id_str` 与条目引用形态已跑通。
- **提及短时延迟实测（2026-11-21）**：一条 10:29 发出的回复，到 10:46 提及接口仍返回 10:13 旧首页；10:47 X 页面收到新数据，10:49 插件用同一接口补回 7 条。结论为 X 提及时间线存在十几分钟级短时滞后，而非解析漏抓。

## 未确认 / 待实测清单

1. **真实账号的提及翻页深度上限**：翻不到所选初始化范围时界面如实提示最早到达日期。
2. **长期运行的行为风控边界**：响应头额度仅代表硬限流阈值，不代表 X 的非公开行为风控边界。
3. **关系 / `M` 旁听字段兼容性**：`relationship_perspectives.following / followed_by`、旧 `legacy` 内字段与页面帖子归属结构尚未在真实账号全面确认（不符时仅不显示小标，不影响榜单）。
4. **排期快捷档期弹窗兼容**：真实排期弹窗的选择器兼容性、日期联动与填入效果需随实际反馈调整。
5. **X 发版导致的结构变更**：接口或 DOM 改版后插件在弹窗/错误提示中直接报错，不做静默兜底。
6. **`CreateTweet` 真实返回载荷核对**：`parseCreatedReply` 已按 X 常见 GraphQL 结构实现，待收集真实发帖旁听的 `outbound_tap` / `outbound_tap_unmatched` 日志确认。
