# 维护入口（给接手的 AI / 开发者）

Chrome 插件「X 友」（Manifest V3，原生 JS，无构建步骤，零运行时依赖），当前处于开发者模式自用维护阶段，不上架商店。

- **产品需求、口径与不可越过的红线**以 [`docs/product.md`](docs/product.md) 为唯一出处；本文不再重复产品决策，发生冲突时以那份为准。
- 固定优先级：**账号安全 > 数据完整与正确 > 轻量低噪声 > 及时性**。技术实现不能用更高优先级去交换更低优先级。
- 三条数据与流程底线：**同一帖子 ID 只算一次**、**空值不覆盖已知事实**、**任务中断可续读**；全程只读 GET，不主动打开通知页。

## 文档导航（按需读取）

| 文档 | 内容 | 何时读 |
|---|---|---|
| [`docs/product.md`](docs/product.md) | 需求层、规则层、细节层与待实测表（唯一产品事实源） | 改产品行为或核对口径 |
| [`docs/architecture.md`](docs/architecture.md) | 数据流、全量文件职责、隔离红线、插件共存与页面/弹窗实现约定 | 定位文件或改架构/DOM |
| [`docs/storage-and-state.md`](docs/storage-and-state.md) | IndexedDB / `chrome.storage.local` 键表、`cursor.out` 与回填状态机、`PACE` 风控节奏 | 改存储、状态机或节奏 |
| [`docs/x-endpoints.md`](docs/x-endpoints.md) | X 内部接口实测状态、额度、延迟实测与待实测清单 | 排查接口/解析变更 |
| [`docs/dev-tools.md`](docs/dev-tools.md) | 本机数据桥、Chrome 数据目录、快照页、弹窗本地预览、排查与测试清单 | 调试、看本机数据或跑工具 |
| [`README.md`](README.md) | 安装与面向用户的完整使用说明 | 改用户可见用法 |
| [`CHANGELOG.md`](CHANGELOG.md) | 各版本更新流水 | 发版记录 |

## 代码导航与隔离红线

- `src/background.js` + `src/bg/`：Service Worker 入口与 9 个无环 ESM 领域模块（`runtime` / `alarms` / `accounts` / `transport` / `backfill` / `incremental` / `outbound` / `scheduled` / `rpc`）；Chrome 事件监听仅在 `src/background.js` 注册。
- `src/x/`：`fetcher.js`、`parser.js`、`mentions-diagnostics.js`（主动请求的 X 接口字段与路径只允许出现在此处）。
- `src/content/`：`tap.js`、`rel.js`（仅作旁听路由与内存解析的例外，不发请求不落候选数据）、`content.js`、`schedule.js`、`schedule-ui.js`、`share-copy.js`、`badge.css`（X 页面 DOM 选择器只允许在 `content.js`、`schedule-ui.js`、`share-copy.js`）。新的页面增强功能优先做成独立内容脚本，不往 `content.js` 里堆。
- `src/rank.js`、`src/db.js`、`src/diagnostics.js`、`src/snapshot.js`、`src/bridge.js`：纯统计口径与规则合法化、存储封装、7 天诊断日志、维护期快照/开发桥。
- `src/ui/`：`popup.html` / `popup.js` / `popup-helpers.js` / `popup.css`、`snapshot.*`。
- `test/`：按被测模块命名（`rank` / `parser` / `rel` / `schedule` / `fetcher` / `bg-*` / `popup-*` / `share-copy` 等），共用样本在 `test/helpers/fixtures.mjs`，后台测试环境在 `test/helpers/bg-env.mjs`；改哪个模块就在同名测试文件补用例。
- `scripts/`：`check-contracts.mjs`、`release-check.mjs`、`popup-preview.mjs`、`live-bridge.mjs`、`install-bridge.mjs`。

## 工程命令

- **提交前唯一门禁**：`npm run check`（运行 `scripts/check-contracts.mjs` 静态契约校验 + `npm test` 全部测试）。
- **弹窗本地预览**：`npm run popup:preview`（在 `127.0.0.1:17322` 提供注入 mock 的真实弹窗）。
- **正式分发前自检**：`npm run release:check`（校验无维护期 `http://127.0.0.1/*` 权限、无 `.local` 跟踪文件且工作区干净）。
- **本机开发桥**：`npm run bridge`（前台启动）或 `npm run bridge:install` / `bridge:uninstall`（LaunchAgent 启停，详见 [`docs/dev-tools.md`](docs/dev-tools.md)）。

## 变更纪律

- **先改 [`docs/product.md`](docs/product.md)，再改代码**；调度、界面或补漏策略的改动，不能顺手重写已经验证过的抓取、解析、入库接口和去重逻辑。确实要动核心接口时，先说明证据、影响和回退方式。
- 每次改动都要保住同一帖子 ID 只算一次、空值不覆盖已知事实、任务中断可续读这三条底线，并保持模块隔离边界与后台 ESM 无环依赖。
- 用户能感知的行为变化必须升版本、写 [`CHANGELOG.md`](CHANGELOG.md)、打标签并推送；纯文档、测试和重构不升版本。
- 可独立验收、可独立回退的功能分开提交。已经推送的历史不改写，不用 `force-push`。

## 版本与发布

- 版本号按 `主.次.修`：加功能或改用户看得到的行为升「次」，只修问题升「修」；`1.0` 之前不升「主」。
- 版本号写在两处，必须一致：`manifest.json` 的 `version`（弹窗标题旁显示）与 `package.json` 的 `version`，且与 [`CHANGELOG.md`](CHANGELOG.md) 顶部最新版本标题一致。
- 每次改了用户能感知的东西：升版本号，在 [`CHANGELOG.md`](CHANGELOG.md) 顶部加一节（日期 + 用户看得懂的改动，不写实现细节），提交后打标签 `vX.Y.Z` 并推送。
- **Git 由接手的 AI 自己管**（负责人 2026-11-19 定）：改完、通过 `npm run check` 就直接提交到 `main`，该打标签的打标签，然后推送，不用先问负责人。提交信息用中文写清楚改了什么；代码改动和纯文档改动分开提交。检查不通过的不提交，先修好或向负责人说明。
- **每个可独立验收、可独立回退的功能必须单独提交**（负责人 2026-11-21 纠正）：不要把互不依赖的变化混进同一个提交；提交前检查暂存区只含这一件事。后续否定某个功能时优先 `git revert` 对应提交，不擅自 `force-push` 改写历史。
- 仓库是公开的：提交和文档里不出现账号、令牌、真实数据截图。许可证 MIT。仓库名与目录名保持 `x-inbound-rank`，对外名称为「X 友」。图标在 `icons/`（16 / 32 / 48 / 128）。

## 约定

- 面向用户的文字与面向开发者的交互叙述用简体中文；代码标识用英文。
- 出错必须让用户看见（`alert:<账号>` 或任务的 `message`），不允许静默失败或拿旧数据冒充完整。
- 不确定 X 的行为时写成「待实测」并让代码在不符时报错，不要按猜测静默兜底。
