# 完整实施方案

> **状态更新（2026-08-02）：** Gate A/B 与路线图 `TASK-D-DATA-001`~`003` 已完成，当前权威源码为本仓库 `main`；正式便携版的精确构建提交号显示在应用顶部栏。本文保留实施过程和目标设计；涉及 Zustand、schema v3/ETag/`expectedGeneration` 同步的内容属于历史候选或后续路线图，不代表当前实现。当前实现边界见 `docs/CURRENT_ARCHITECTURE.md`。

> 原方案基于 2026-07-26 的实际工作区；2026-07-27 已增加恢复 V2 前置门禁。实施者必须完整读取 `.agent-work/RECOVERY_REBUILD_PLAN.md`。Gate R 通过前不得直接实施本文件 Phase A；阶段 A 未经 Codex 验收为 PASS（或用户明确接受的 CONDITIONAL PASS）前，阶段 B 不得进入 READY。

## 0. 恢复 V2 前置方案

本文件描述最终恢复分支需要达到的目标架构和 Phase A/B 实施内容。恢复路径以 `.agent-work/RECOVERY_REBUILD_PLAN.md` 为最高优先级补充：

1. 当前目录只作为故障现场和参考实现保留，不原地继续叠加业务修改。
2. 独立验证 `origin/main@6fcbb1e` 和干净 `29ea3a4`。
3. 根据双基线结果决定从 `29ea3a4` 只重放未提交变更，或从更早的最后绿色提交选择性迁移。
4. 不按提交数量追求全部迁移；Zustand、snake_case schema、组件拆分、同步重构等都必须以需求、风险和测试证据决定。
5. 最终实施分支固定命名为 `codex/rebuild-from-stable`，但起点由 `.agent-work/RECOVERY_DECISION.md` 记录的最后绿色提交决定。
6. 迁移顺序采用测试/诊断、错误状态、migration/setting、原子 CRUD、导入恢复/同步、路径/构建治理、地区专项七个波次。

原文件后续各节继续作为目标设计，但所有“复用当前未提交实现”均解释为“在恢复分支中按函数/测试选择性移植”，不得整批覆盖稳定代码。

## 1. 需求理解

本轮不是单纯“做动态地区筛选”，而是先恢复 Windows Tauri 应用的可交付基线：锁文件安装、前端与桌面启动、SQLite 首次建库/旧库升级、核心 CRUD 与持久化、离线/无凭据容错、导入恢复同步安全、完整检查和 Windows 构建产物冒烟。只有 Gate A 通过后，才继续以 ISO alpha-2 为地区主键的动态地区专项。

验收事实以当前环境实际执行结果和 `.agent-work/evidence/` 为准。历史文档中的通过记录只作为问题线索。

## 2. 分阶段范围

### 阶段 A：恢复运行和建立稳定基线

- 建立不触碰真实用户数据库的可恢复工作基线。
- 复现依赖、启动、初始化、核心数据流程和构建问题。
- 审计并完成原子更新契约、migration 事务、setting 错误语义。
- 建立 loading/ready/error 初始化状态、重试和统一用户可见异步错误反馈。
- 统一数据库、日志、海报、备份、协议的数据路径规则。
- 用临时库/多版本夹具验证首次、已有和升级数据库，以及导入/恢复/同步失败回滚。
- 补齐真实 Tauri/SQLite 与 Windows 构建产物冒烟；现有浏览器 mock E2E 继续作为前端回归层。
- 更新 README、原子 API 文档和产物治理；建立 CI（Windows-only 的桌面构建可单独 job）。
- 运行全部强制命令并提交证据，交由 Codex 独立验收。

### 阶段 B：地区动态化专项

- 复用现有未提交的地区实现，修正 UK/GB、占位值、未知地区、排序和无效选择。
- 地区选项只由当前 mediaType/status 范围聚合，不受其他筛选和当前地区影响。
- 确保多国、旧标签回退、TMDB 多国保留、自定义标签保护及导入/恢复/同步兼容。
- 增加纯函数、组件/Hook 和 Playwright 覆盖，验证动态更新、布局和可访问性。
- 重新执行前端检查及相关 Rust/桌面回归，由 Codex独立验收。

### DEFERRED：本轮禁止实施

REQUEST 第 9 节路线图已于 2026-08-02 按当前 `main` 重分类为 18 个独立 `TASK-D-*`：数据安全/完整性/恢复、同步一致性/可靠性/隔离、凭据安全、观看历史、内容发现、数据交换、网络安全、可访问性、检索/追剧/内容组织、工程架构和外部集成。`TASK-D-DATA-001` 元数据安全重构和 `TASK-D-DATA-002` V18 数据完整性加固均已实现；后者包括 V19 安全转换回 V18、V20+ 零修改拒绝、明确 records UPSERT，以及新增/更新/导入/同步替换的统一 Rust 领域边界。自动恢复点与 V18/V19 兼容提升为 R0，完整弹窗可访问性提升为 R1；持续集成已经实现并转为 `MAINTENANCE-CI`。权威任务编号、状态和边界见 `.agent-work/TASKS.md` 的路线图部分。

## 3. 实施原则

1. 每个任务开始前运行 `git status --short --branch` 和目标文件差异审计。
2. 保留所有现有改动；如果既有实现已满足要求，任务转为验证和补证据，不重写。
3. 先记录复现，再做最小修复；不禁用测试、不跳过 migration、不删除用户数据。
4. 所有数据破坏性测试只操作临时路径；真实库仅在用户另行授权后只读复制，并先建立可恢复备份。
5. 阶段 B 的代码当前即使已存在，也不得在 Gate A 前继续实施或标 READY。

## 4. 总体技术设计

### 4.1 启动状态与错误反馈

- 在应用/store 中表达 `loading | ready | error`，error 保存可显示的安全消息。
- 初始化失败渲染独立错误态和“重试”入口，不复用空列表 UI。
- 为 CRUD、导入、恢复、同步和设置写入建立统一通知接口；业务函数继续抛出类型化错误，页面边界负责用户反馈。
- Rust 日志记录命令、错误类别和上下文，但不输出凭据、完整 WebDAV payload 或不必要个人数据。

### 4.2 数据库与原子契约

- 保留现有 `UpdateWatchRecord` 方向，核对 TypeScript/Rust 字段集合一致。
- 系统字段永远不进入 DTO；`updatedAt` 由 Rust 事务生成；空更新返回可识别参数错误。
- 参数反序列化失败必须发生在事务前；SQL 或 setting 写入失败时 record、同 ID Tombstone、generation、dirty/相关 setting（若存在）全部回滚。
- 将每个 migration 的 `up` 与 `db_version` 更新放进同一个 SQLite 事务；移除 migration 内部手写事务，确保失败可重试。
- `get_setting` 仅将 `QueryReturnedNoRows` 映射为 `None`，其余错误上传。

### 4.3 统一数据路径

- 在用户确认 CONFIRM-001 后，引入单一 `AppPaths`/路径解析模块。
- 同一个解析结果供 DB、日志、posters、backups 和 `poster://` 使用；不得使用空 Path 作为静默回退。
- 路径决策可通过注入 executable/app-data 测试路径做单元测试，避免依赖真实安装目录。
- README 精确记录便携模式触发条件、系统 app-data 回退、迁移/恢复方法和各子目录。

### 4.4 数据兼容与真实桌面验证

- 建立临时 SQLite 夹具：空库、当前 schema、有代表性的旧 schema、单条脏数据和 migration 故障注入。
- 浏览器 Playwright 验证 UI 工作流；另加可重复的真实 Tauri/SQLite 冒烟步骤覆盖启动、CRUD、重启持久化和构建产物。
- 无 TMDB/WebDAV 凭据和网络失败必须只影响网络功能，本地列表和 CRUD 保持可用。

### 4.5 地区领域模型

- 内部 key 使用标准化两位代码；定义专用未知地区哨兵（不可与真实 ISO 代码冲突），显示为“未知地区”。
- 解析顺序：规范化 `originCountry`；若结果为空再解析旧 `contentTags`；仍为空则未知。
- 先过滤占位符，再做别名规范化（`UK -> GB`），再验证 `^[A-Z]{2}$`，最后去重。
- 未配置中文名的格式有效代码保留并显示自身；CN/HK/TW 独立。
- 聚合输入只预过滤 mediaType/status；搜索、评分、锁定、排序和 activeRegion 不参与计数。
- 排序严格实现优先序、数量降序、显示名升序、代码升序、未知最后。
- 当 records/mediaType/status 变化使 activeRegion 不再存在时，effect/受控状态将其重置为 `all`，不保留 0 数量幽灵选项。

## 5. 数据流与控制流

### 启动

`Tauri setup -> 统一路径解析 -> 日志 -> SQLite open -> migration transaction(s) -> manage state -> React init -> settings/records -> ready`；任一步失败进入 error 状态并可重试，不显示空数据。

### 本地写入

当前实现：`UI -> useWatchList action -> typed database IPC -> Rust validation -> SQLite transaction(record/tombstone/generation/settings) -> persisted DTO -> React state publish -> 可选同步调度`。网络同步失败不得回滚已成功的本地事务或破坏本地数据。Zustand 仅在能证明收益并完成独立迁移验收后才考虑引入。

### 地区筛选

`records -> mediaType/status scope -> regionCodesOf(record) -> aggregateRegions -> stable options`；列表结果再依次应用 mediaType/status/region/search/rating/lock/sort。当前地区不会反向影响地区选项数量。

TASK-B-002 接线时内部选择使用 `CountryCode | 'all'`。App memoize mediaType/status scope 与 `RegionOption[]`，StatsBar 只消费已生成选项，以 `label` 显示、以 `code` 作为筛选值和 React key。若选择在新 scope 中失效，本次渲染先使用派生的有效选择 `all`，随后把实际 state 清理为 `all`；未来同代码重新出现时不得恢复旧选择。

## 6. 文件变更计划

| 文件或目录 | 操作 | 计划变更 |
|---|---|---|
| `src/app/App.tsx` | 修改 | 三态初始化、重试、无效地区清理、统一错误展示接线 |
| `src/features/watchlist/hooks/useWatchList.ts` | 已实现/后续审计 | 当前稳定状态层；维持持久化成功后发布和可诊断错误边界。Zustand 迁移仍为可选路线图 |
| `src/shared/components/*` | 新增/修改 | 最小统一通知/错误反馈组件与测试 |
| `src/shared/lib/database.ts` | 修改 | 保持强类型 IPC，补参数/错误语义测试 |
| `src-tauri/src/db.rs` | 修改 | migration 单事务、setting 错误区分、必要的显式 UPSERT |
| `src-tauri/src/app_paths.rs`（建议） | 新增 | 唯一数据目录解析与可测试路径对象 |
| `src-tauri/src/lib.rs`, `net.rs`, `commands.rs` | 修改 | 复用统一路径并传播可诊断错误 |
| `src-tauri/src/db_atomic_*.rs`, `models.rs` | 审计/最小修改 | 复用既有原子实现，补契约和回滚缺口 |
| `src/shared/lib/classification.ts` | 修改 | 地区规范化、未知、排序、聚合规则 |
| `src/shared/lib/countryNames.ts` | 修改 | 固定名称、别名、优先序和类型 |
| `src/shared/lib/filtering.ts` | 新增 | TASK-B-002 的 mediaType/status scope、组合筛选与失效选择纯函数；复用 classification 的唯一地区规则 |
| `src/shared/lib/__tests__/filtering.test.mjs` | 新增 | Node 原生 scope、计数独立性、组合筛选与失效回退测试 |
| `src/features/watchlist/components/StatsBar.tsx` | 修改 | 稳定动态选项、布局、ARIA，不保留失效选项 |
| `src/features/settings/components/SettingsModal.tsx` | 条件修改 | TASK-B-002 仅可更新 originCountry 主源/contentTags 旧数据回退说明文字 |
| `src/shared/lib/tmdbMapper.ts`, `RecordForm.tsx`, `SettingsToolsTab.tsx` | 审计/最小修改 | 多国保存和自定义标签保护 |
| `src/shared/lib/__tests__/*` | 修改/新增 | 阶段 A/B 单元和集成回归 |
| `tests/regions.spec.ts`, `tests/fixtures/mockIpc.ts` | 修改/新增 | TASK-B-002 动态地区 UI、失效选择、布局、ARIA 与严格 mock 契约 |
| `src-tauri/src/*_tests.rs` 或现有测试模块 | 修改/新增 | migration、setting、原子失败和路径测试 |
| `README.md` | 修改 | Windows 前置、运行构建、数据目录、离线行为 |
| `docs/REFACTOR_ATOMIC_API.md` | 重写 | 当前真实原子 API 契约与恢复限制 |
| `.github/workflows/*` | 新增 | 前端/Rust检查；Windows Tauri 构建按可复核 job 配置 |
| `.gitignore` 及已跟踪产物 | 修改/移除跟踪 | 禁止测试/构建本地产物进入提交 |

具体修改以任务执行时审计结果为准；表中的“审计”不授权无关重构。

## 7. 数据模型与迁移

- 地区专项不新增数据库字段、不做破坏性数据迁移；当前 V18 schema 继续使用 `originCountry` 与 `contentTags`。
- migration 框架当前最终 schema/version 为 V18，并用至少空库、v12/v17/current 代表夹具验证。V19 snake_case 兼容或升级必须另行设计、备份和验收。
- 每个 migration：开启事务 -> 执行 schema/data 变化 -> UPSERT `db_version` -> commit；故障则 rollback，重启可再次执行。
- 禁止使用真实活动数据库跑 migration 故障测试。

## 8. API 设计

- `update_record(id, updates: UpdateWatchRecord, actorId?)`：当前注册的 IPC 名称；只收业务字段，空对象、未知/系统字段、非法类型返回可识别参数错误，内部由 Rust 原子事务实现。
- `get_setting(key)`：不存在返回 `null`；查询/类型/锁/损坏错误返回 IPC error。
- 当前没有注册高级 snapshot/commit DTO；相关能力属于后续同步路线图。
- 若新增初始化重试命令，必须复用同一数据库状态生命周期，不创建并发 Connection 覆盖现有状态；优先让前端重试幂等读取。

## 9. UI/UX 设计

- 保持现有筛选栏视觉；错误态提供简短说明和重试按钮。
- 通知应有 success/error 语义和可访问的 live region；破坏性操作继续保留确认。
- 地区按钮保留 `aria-pressed`，数量多时使用 wrap 或横向滚动，不能挤压状态筛选。
- 未知地区仅在存在对应记录时显示，始终最后。

## 10. 错误处理、日志与隐私

- 用户消息不暴露 SQL、路径内个人名或凭据；日志记录错误链、模块和可关联操作。
- TMDB/WebDAV 缺凭据、超时、HTTP 错误均可恢复，本地状态不被清空。
- 证据日志在保存前检查 TMDB key、WebDAV URL 用户信息、密码和记录内容。

## 11. 兼容性

- 保留旧 camelCase schema migration、旧 `contentTags` 地区别名、`UK`、中英文逗号和混合新旧记录。
- 不改变非地区字段语义，不清洗用户自定义标签。
- 不修改 TMDB 搜索接口或引入在线国家表/新运行时依赖。

## 12. 测试策略

### 阶段 A

- Rust：DTO 反序列化、系统字段/空更新/非法值、服务器时间、SQL/setting 回滚、不存在记录和 Tombstone、migration 回滚重试、setting 错误、路径矩阵。
- Node 原生测试：初始化状态、错误归类、筛选和相关前端逻辑。
- Playwright mock：空态、CRUD、初始化失败/重试、可见错误、导入/恢复/同步失败不清空。
- 真实 Windows：`tauri dev`、首次/已有/升级库、CRUD 重启、无凭据/离线、`tauri build` 产物启动。
- 全量命令严格按 REQUEST 7.4。

### 阶段 B

- Node 原生单元测试：所有 FR-01~06 规则、排序、未知、多国、来源优先、自定义标签保护；沿用阶段 A 已建立的 `npm test` 入口，不为 Phase B 重新引入第二套单元测试框架。
- Hook/组件：计数基础范围和无效选择清理。
- Playwright：混合数据、CN/HK/TW、GB/UK、多国、未知、组合筛选、动态更新和大量地区布局。
- 回归：全量前端检查、Playwright，相关 Rust 检查，并确认 import/restore/sync 保留 `originCountry`。

## 13. 部署与回滚

- 任何实施前保存 Git 状态和差异清单；当前故障现场不得 reset。Recovery Snapshot 提交只能在用户明确授权后创建，并且不得推送或视为发布版本。
- `origin/main@6fcbb1e`、干净 `29ea3a4` 和最终恢复分支必须位于独立 worktree，不能共享依赖缓存、Rust target 或活动数据目录。
- 数据测试使用临时目录；如用户授权真实副本，记录源、副本、备份和恢复命令，绝不原地操作。
- 构建产物放入忽略目录；若 schema 修复进入发布，应先提供旧库备份路径和可重试证明。
- WebDAV PUT 与本地 SQLite 无法组成分布式事务。当前 schema v2 实现只提供时间戳/Tombstone 合并和安全失败边界；generation/commitId/ETag 协议如在后续引入，必须通过独立设计与重试恢复验收。

## 14. 主要风险及应对

- **既有改动被覆盖**：任务开始先 diff，按函数补丁修改，证据列出复用项。
- **半 migration**：逐 migration 事务 + 故障注入 + 多版本夹具。
- **数据目录选择错误**：CONFIRM-001 已确认采用规则 1；统一路径对象后做矩阵测试。
- **mock 假阳性**：浏览器 E2E 与真实 Tauri/SQLite 冒烟分层。
- **地区筛选跳变/幽灵状态**：计数与最终筛选分离，主动校验 activeRegion。
- **本地网络失败污染数据**：网络与本地事务边界分离，失败前后快照断言。

## 15. 实施顺序与门禁

1. TASK-R-001 保全当前现场、旧可运行产物和用户数据。
2. TASK-R-002 与 R-003 分别在独立 worktree 验证 `6fcbb1e` 和干净 `29ea3a4`。
3. TASK-R-004 由 Codex 应用决策矩阵，必要时 bisect，并填写 `RECOVERY_DECISION.md`。
4. TASK-R-005 从最后绿色提交建立 `codex/rebuild-from-stable`，重复绿色门禁；Codex 通过 Gate R 后才开放 A-001。
5. TASK-A-001 在恢复分支建立 Wave 0~5 迁移基线；后续 A 任务只选择性移植当前快照中的必要实现。
6. TASK-A-004 已按旧治理方案完成统一路径；用户确认只有可执行文件旁预先存在 `data/` 时才进入便携模式。
7. TASK-A-004 `ACCEPTED` 后切换到简化流程。TASK-A-005 及后续任务由 Codex Implementation Pass 实施并正常提交，再由独立 Verification Pass 复核；不再要求 JSON 合同、Runner、Safe Commit、Receipt 或 Attestation。
8. Gate A 已通过；B-001 与 B-002 已验收。以 B-002 验收提交 `d566861` 创建 `codex/phase-b-integration`，后续 B-003~B-005 从最新已验收 integration HEAD 串行签发、实施和独立验收，不再从旧 `origin/main@b6f3091` 并行起步。
9. 每个 B 任务保持独立合同、Implementation 提交和 Verification 提交；只有 `ACCEPTED` 的任务才能推进 integration。隔离的 `codex/phase-b-complete` 及其提交/工作区只作审计参考，不得作为 BASE 或整体迁移。
10. B-005 完成本地全量证据和地区报告后，创建唯一的 Phase B PR；远端 CI、AC-GATE-B 和综合报告完成后才合并到 `main`。
