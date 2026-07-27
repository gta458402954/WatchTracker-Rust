# 验收标准

> 所有结果初始为 `NOT RUN`。历史文档和实施者自报结果不能直接改成 PASS；只有 Codex 在当前代码、当前环境独立验证并取得证据后才能更新结果。

## 结果定义

- `PASS`：Codex 已独立验证通过。
- `FAIL`：实际结果不符合预期。
- `NOT RUN`：没有执行验证。
- `BLOCKED`：受环境或外部条件限制。
- `NOT APPLICABLE`：经确认不适用。

## 通用证据规则

- 命令证据必须含命令、时间、工作目录、退出码和未裁剪的关键输出。
- UI/桌面验证需有截图或录屏、应用日志和所用数据库夹具标识。
- 数据库高风险测试只允许临时库/夹具/独立副本；若使用真实副本，证据必须记录源、备份、副本、恢复方法并脱敏。
- `NOT RUN`、`BLOCKED` 和缺证据均不得计作 PASS。

## Gate R：恢复基线选择

### AC-R-001：当前故障现场可完整恢复

- Requirement: RECOVERY_REBUILD_PLAN §4。
- Priority: Must
- Verification Type: Inspection
- Preconditions: 创建任何验证 worktree 前。
- Verification Steps:
  1. 核对本地 17 个提交、受控差异、未跟踪源码/测试/文档和 `.agent-work` 的快照。
  2. 核对旧可运行产物的路径、SHA-256、大小和启动记录。
  3. 核对用户数据备份与源码目录隔离，且恢复步骤可执行。
- Expected Result: 当前源码、旧产物和用户数据均有独立可验证恢复路径；没有 reset/checkout/clean 或真实库写入。
- Required Evidence: snapshot commit/副本、状态清单、hash、数据安全记录。
- Result: PASS
- Evidence: Local snapshot `bffd6cc461e1a2e6fda4c4703198fbf5f2ae3a95`; remediation `0f0697b994e894d7f96593496b50b5e46e396267`; `.agent-work/evidence/recovery/TASK-R-001-*`; independent backup `D:\Project\Backups\WatchTracker-2026-07-27` (4,854 files / 1,872,233,186 bytes); six independently recomputed source/backup SHA-256 pairs matched; restore instructions at `recovery-notes/RECOVERY.md`; Codex closure in `REVIEW_FEEDBACK.md`.

### AC-R-002：GitHub 稳定候选可从源码复现

- Requirement: RECOVERY_REBUILD_PLAN §5。
- Priority: Must
- Verification Type: Automated + Manual
- Preconditions: 独立干净 worktree、隔离测试数据。
- Verification Steps:
  1. 从 `6fcbb1e` 执行锁文件安装、该提交具备的前端/Rust检查和构建。
  2. 启动 Tauri dev 和本轮生成的 Windows 构建产物。
  3. 执行临时数据 CRUD、重启持久化和无凭据本地可用性冒烟。
  4. 对比旧可运行产物的关键行为。
- Expected Result: 明确得到 PASS/FAIL/BLOCKED 及完整证据；缺少后来新增脚本本身不算失败。
- Required Evidence: 安装/构建日志、产物 hash、桌面截图、CRUD 记录、行为差异表。
- Result: FAIL
- Evidence: Verification history and corrections in `REVIEW-R-002`; final evidence commits through `dfe6d742320ef167408058444984384db1f6d8df`; raw install/build/test logs and corrected artifact hashes in `.agent-work/evidence/recovery/stable-*`; real database hashes unchanged after process cleanup; user manual desktop verification in `stable-13-user-manual-verification.txt` confirms CRUD, update persistence after restart, deletion persistence after restart, and correct classification after changing media type. Functional reproduction is PASS, but `cargo fmt -- --check` returned 1, so the overall criterion remains FAIL as a fully green source-quality baseline. TASK-R-002 is nevertheless ACCEPTED because the required baseline determination is now complete and evidence-backed.

### AC-R-003：干净本地 HEAD 已被独立验证

- Requirement: RECOVERY_REBUILD_PLAN §6。
- Priority: Must
- Verification Type: Automated + Manual
- Preconditions: `29ea3a4` 独立 worktree，不包含未提交层。
- Verification Steps:
  1. 干净安装并运行该提交具备的全部前端/Rust门禁。
  2. 验证 Tauri dev/build、临时数据 CRUD 和重启持久化。
  3. 与 `6fcbb1e` 使用同一行为清单比较。
- Expected Result: 能明确判断故障是否已经存在于 17 个提交中。
- Required Evidence: 完整命令日志、桌面冒烟、对比表。
- Result: FAIL
- Evidence: Initial evidence `063fd8333347d8da933542ab95ec9a1666ee9efc`; corrected evidence `ed3d785d0ecc99c237e6c6fee33ff4f54ae356aa`; `head-01`~`head-11` and 12 tracked `head-raw-*.txt` logs. Clean committed `29ea3a4` fails `npm run typecheck` (exit 2), `npm run build` (exit 2), Playwright (exit 1, 4/4 failed), and `npm run tauri build` (exit 1 because beforeBuildCommand failed); no release artifacts exist. Rust fmt/clippy/tests and selected frontend lint/Vitest gates pass. No residual process remains and all real database hashes match. This establishes that the fault exists within the 17 committed changes, before the uncommitted layer. TASK-R-003 is ACCEPTED as a completed failed-baseline investigation; candidate result remains FAIL.

### AC-R-004：故障位置和恢复基线有可复核决策

- Requirement: RECOVERY_REBUILD_PLAN §7。
- Priority: Must
- Verification Type: Inspection + Automated/Manual bisect（如适用）
- Preconditions: AC-R-002、AC-R-003 已有结论。
- Verification Steps:
  1. 应用双基线决策矩阵。
  2. 若 `29ea3a4` 失败，检查 bisect 或等价二分证据。
  3. 检查 `.agent-work/RECOVERY_DECISION.md` 的最终基线和改动处置表。
- Expected Result: 最后绿色提交、故障层级以及保留/重做/暂缓改动均有证据，不凭猜测选基线。
- Required Evidence: RECOVERY_DECISION、bisect 日志（如适用）、Codex 审查记录。
- Result: PASS
- Evidence: Codex independently used `npm ci` + `npm run build` in `D:\Project\Projects\WatchTracker-Bisect`. `38873240923c8efe145a3e16cd28065634417a0e` is the build-good boundary and `29ea3a4fc82eeb5e0bcfda58d3f23fd97ed44006` is first build-bad. A separate quality audit proved `3887324` is not fully green (lint/Vitest fail) and `93b8f7c` is not a stronger verified baseline (Rust fmt/strict clippy fail; no desktop verification). `.agent-work/RECOVERY_DECISION.md` therefore selects the functionally verified `6fcbb1e0ae851c554c905676ee9164bfb3ea303e`. See `bisect-R-004-log.txt` and `bisect-R-004-reproduction.txt`.

### AC-R-005：最终恢复分支从最后绿色提交建立

- Requirement: RECOVERY_REBUILD_PLAN §8、§14。
- Priority: Must
- Verification Type: Inspection + Automated
- Preconditions: AC-R-004 PASS。
- Verification Steps:
  1. 核对 `codex/rebuild-from-stable` 的起点与 RECOVERY_DECISION 一致。
  2. 在该分支重复基线的绿色门禁和桌面冒烟。
  3. 核对 Phase A/B/DEFERRED 已重新映射且没有提前实施。
- Expected Result: 恢复分支是可复现的绿色起点，Phase A 可以安全开放。
- Required Evidence: 分支/提交图、重复验证日志、任务映射。
- Result: FAIL
- Evidence: R3 commit `a7db65357e7f4708fdf9d803534518fe8a67af56` successfully created and used the isolated debug database, with no startup/schema error and no remaining process. However executor summaries contradict raw evidence: dev was intentionally terminated with exit 1, PIDs in TASKS/EXECUTION_LOG are stale R2 values, Rust checks overlapped npm lint/build, and Tauri build took 81.277 seconds. The recorded 23:19 artifacts were captured before the 23:20:15 build exit; current final hashes differ. Summary/evidence correction and user UI verification remain required. See `REVIEW-R-005` third re-verification.

### AC-GATE-R：Gate R 通过后才可开放 Phase A

- Requirement: RECOVERY_REBUILD_PLAN §14。
- Priority: Must
- Verification Type: Inspection
- Preconditions: AC-R-001~005 均完成。
- Verification Steps:
  1. 检查所有 AC-R 结果和证据。
  2. 检查 `RECOVERY_DECISION.md` 的 Gate R 结论。
  3. 检查 Phase A 状态变更历史。
- Expected Result: Gate R PASS 前没有 Phase A/B 任务进入实施状态。
- Required Evidence: RECOVERY_DECISION、TASKS 状态、Codex 审查记录。
- Result: BLOCKED
- Evidence: Gate R remains BLOCKED pending Codex re-verification of automated R2 evidence and user manual UI verification. Phase A tasks remain strictly BLOCKED.

## Gate A

### AC-GATE-001：阶段 A 通过后才可开放阶段 B

- Requirement: REQUEST §11 两阶段门禁；用户特别指示。
- Priority: Must
- Verification Type: Inspection
- Preconditions: AC-GATE-R 已 PASS，所有 Phase A 任务均已由 Codex 审查。
- Verification Steps:
  1. 检查所有 AC-A-* 强制项结果及证据。
  2. 检查 `.agent-work/ACCEPTANCE_REPORT_BASELINE.md` 最终结论。
  3. 检查 Phase A 只在 Gate R 后实施，并检查 Phase B 任务状态变更历史。
- Expected Result: Gate R 前没有实施 Phase A；阶段 A 报告为 PASS（或用户书面接受指定条件的 CONDITIONAL PASS）前，没有 Phase B 任务进入 READY/IN_PROGRESS/IMPLEMENTED。
- Required Evidence: baseline 报告、TASKS 状态、用户确认（如适用）。
- Result: NOT RUN
- Evidence: Pending

## 阶段 A：恢复运行和稳定基线

### AC-A-001：工作区与用户数据受到保护

- Requirement: BR-03.7~9、BR-05.3、BR-05.7。
- Priority: Must
- Verification Type: Inspection
- Preconditions: 实施前。
- Verification Steps:
  1. 记录分支、HEAD、ahead/behind、完整 porcelain 状态和 diff stat。
  2. 检查每个数据库测试的路径来源。
  3. 如使用真实库副本，核对备份、测试副本和恢复方法；否则确认仅使用临时库/夹具。
- Expected Result: 既有修改未被覆盖/清除；没有测试直接打开或改写活动用户数据库；证据无凭据和非必要个人数据。
- Required Evidence: `TASK-A-001-*` 状态与数据安全清单。
- Result: NOT RUN
- Evidence: Pending

### AC-A-002：Windows 工具链与锁文件安装可重复

- Requirement: BR-01.1~3。
- Priority: Must
- Verification Type: Automated / Inspection
- Preconditions: 目标 Windows 环境，保留 `package-lock.json`、`Cargo.lock`。
- Verification Steps:
  1. 记录 `node --version`、`npm --version`、`rustc --version`、`cargo --version`。
  2. 在干净依赖环境执行 `npm ci`，不得回写锁文件。
  3. 执行 Cargo dependency resolution/build-related check，并核对 Tauri Windows 前置条件。
- Expected Result: 锁文件安装和 Rust 依赖解析成功，不依赖未记录全局包/私有文件；最低版本文档准确。
- Required Evidence: 环境与安装日志、lock diff 为零。
- Result: NOT RUN
- Evidence: Pending

### AC-A-003：前端开发服务器可启动

- Requirement: BR-02.1。
- Priority: Must
- Verification Type: Automated / Manual
- Preconditions: AC-A-002。
- Verification Steps:
  1. 执行 `npm run dev`。
  2. 访问 `http://127.0.0.1:5173`，检查页面和终端致命错误。
  3. 正常停止服务器。
- Expected Result: 固定端口监听成功，页面可渲染，无阻塞致命错误。
- Required Evidence: 启停日志、页面截图。
- Result: NOT RUN
- Evidence: Pending

### AC-A-004：Tauri dev 与三类数据库启动场景通过

- Requirement: BR-02.2~4、BR-03.1~2、完成定义 A.1~2。
- Priority: Must
- Verification Type: Manual / Integration
- Preconditions: 临时数据目录；空库、当前库、旧版升级库夹具。
- Verification Steps:
  1. 对首次、已有当前库、旧版升级库分别执行/启动 `npm run tauri dev`。
  2. 每次进入主界面，查看应用日志，确认没有白屏、崩溃或无限加载。
  3. 升级后重启并核对数据和 schema/version。
- Expected Result: 三种场景均稳定进入主界面，旧记录可读且无丢失；可恢复错误有 UI 提示和日志。
- Required Evidence: 三组启动日志、截图、升级前后数据/schema 摘要。
- Result: NOT RUN
- Evidence: Pending

### AC-A-005：初始化三态、重试和统一错误反馈

- Requirement: BR-02.5~6、测试要求 7.1.9、完成定义 A.10。
- Priority: Must
- Verification Type: Automated / Manual
- Preconditions: 可注入读库、写入、设置和网络失败。
- Verification Steps:
  1. 验证 loading、ready、error 三态。
  2. 注入初始化读取失败，检查错误说明和重试入口；解除失败后重试。
  3. 分别注入新增、编辑、删除、导入、恢复、同步/设置失败。
- Expected Result: 初始化失败不显示正常空列表；重试可恢复；所有异步失败有统一用户可见反馈和脱敏日志，本地既有数据不被清空。
- Required Evidence: Vitest/Playwright 日志、截图、应用日志。
- Result: NOT RUN
- Evidence: Pending

### AC-A-006：核心 CRUD、持久化与组合交互通过

- Requirement: BR-03.2~4、完成定义 A.3。
- Priority: Must
- Verification Type: Integration / Manual
- Preconditions: 临时 SQLite 数据目录，含正常和单条旧/脏数据夹具。
- Verification Steps:
  1. 加载、查看、新增、编辑、删除记录。
  2. 重启应用，核对新增/编辑/删除持久化。
  3. 组合搜索、影视类型、观看状态、地区、评分、锁定和排序。
  4. 验证单条兼容脏数据不会使整个列表失败。
- Expected Result: CRUD 与重启状态一致，组合交互正确，坏单条记录按明确兼容/错误策略处理且不拖垮列表。
- Required Evidence: 真实 Tauri/SQLite 冒烟记录、前后快照、截图。
- Result: NOT RUN
- Evidence: Pending

### AC-A-007：设置、导入导出、备份恢复与网络降级安全

- Requirement: BR-01.4、BR-03.5~6、完成定义 A.4。
- Priority: Must
- Verification Type: Integration / Manual
- Preconditions: 临时库；脱敏导入/同步夹具；无凭据和网络失败可控。
- Verification Steps:
  1. 读取/保存设置并重启核对。
  2. 执行导出、导入、备份、恢复，核对前后记录和 `originCountry`。
  3. 在无 TMDB/WebDAV 凭据及网络失败下启动和执行本地 CRUD。
  4. 注入导入/恢复/同步失败，核对本地数据未受破坏。
- Expected Result: 本地核心功能始终可用；成功流程数据一致；失败流程可恢复且无部分覆盖。
- Required Evidence: 操作日志、脱敏校验摘要、截图。
- Result: NOT RUN
- Evidence: Pending

### AC-A-008：原子更新接口契约完整

- Requirement: BR-06 全部、测试要求 7.1.1~6。
- Priority: Must
- Verification Type: Automated
- Preconditions: Rust 临时内存/临时文件数据库。
- Verification Steps:
  1. 拒绝 `id/createdAt/updatedAt/rev/revActor`、未知字段、数组、对象、错误数字类型和非有限前端数字。
  2. 验证空更新返回可识别参数错误且不改变 record/Tombstone/generation/settings。
  3. 验证 `updatedAt` 为 Rust 事务时间。
  4. 注入 SQL 与后续 setting 写入失败，核对全量回滚。
  5. 更新不存在记录，核对预存 Tombstone 不变。
- Expected Result: 所有契约与原子不变量均有直接断言并通过。
- Required Evidence: 指定 Rust/TS 测试日志和测试名称清单。
- Result: NOT RUN
- Evidence: Pending

### AC-A-009：每个 migration 原子回滚并可重试

- Requirement: BR-03.10、测试要求 7.1.7。
- Priority: Must
- Verification Type: Automated
- Preconditions: 多版本临时数据库夹具和故障注入。
- Verification Steps:
  1. 对代表性 schema/data migration 在中途注入失败。
  2. 核对 schema、数据、`db_version` 全部保持迁移前状态。
  3. 移除故障并重新运行，核对只执行一次且升级成功。
  4. 覆盖空库和至少 v12/v17/v18 到当前版本路径。
- Expected Result: 不存在半迁移状态，重启可安全重试。
- Required Evidence: Rust 测试日志、迁移前后 schema/version 快照。
- Result: NOT RUN
- Evidence: Pending

### AC-A-010：setting 不存在与查询失败严格区分

- Requirement: BR-03.11、测试要求 7.1.8。
- Priority: Must
- Verification Type: Automated
- Preconditions: 临时 SQLite 数据库。
- Verification Steps:
  1. 查询不存在 key，断言返回 None/null。
  2. 注入类型、锁定或底层查询错误，断言错误上传并记录。
  3. 验证调用方不把错误转换为默认值。
- Expected Result: 只有 `QueryReturnedNoRows` 映射为空，其余错误可诊断。
- Required Evidence: Rust/IPC 测试日志。
- Result: NOT RUN
- Evidence: Pending

### AC-A-011：统一应用数据目录规则

- Requirement: BR-04.5~6、测试要求 7.1.10、完成定义 A.7/11。
- Priority: Must
- Verification Type: Automated / Manual
- Preconditions: CONFIRM-001 已决定；可写/不可写便携目录与 app-data 测试矩阵。
- Verification Steps:
  1. 验证数据库、日志、posters、backups 和 `poster://` 使用同一根目录对象。
  2. 验证便携模式触发、系统 app-data 回退和路径错误语义。
  3. 在 dev 和构建产物中保存/读取海报及数据库。
  4. 对照 README。
- Expected Result: 所有消费者路径一致、可测试、无空路径静默回退，README 与实际一致。
- Required Evidence: 路径单测、运行日志、README 对照表。
- Result: BLOCKED
- Evidence: Waiting for CONFIRM-001

### AC-A-012：原子 API 文档与真实实现一致

- Requirement: BR-05.6。
- Priority: Must
- Verification Type: Inspection
- Preconditions: 原子 API 最终实现稳定。
- Verification Steps:
  1. 将文档中的命令/DTO 与 Rust 注册和 TypeScript 调用逐项对照。
  2. 检查 generation、commitId、事务不变量、错误语义、stale snapshot、安全重试、恢复流程。
  3. 检查是否明确 WebDAV PUT 与 SQLite 无分布式事务。
- Expected Result: 不再描述废弃 IPC，不声称未经验证的“完美落实”，所有必需主题准确。
- Required Evidence: 文档审查清单与代码引用。
- Result: NOT RUN
- Evidence: Pending

### AC-A-013：前端质量门禁全部通过

- Requirement: BR-04.1、NFR 6.4、测试要求 7.4。
- Priority: Must
- Verification Type: Automated
- Preconditions: 阶段 A 实现完成。
- Verification Steps:
  1. `npm run typecheck`
  2. `npm run lint`
  3. `npm run test`
  4. `npm run build`
  5. `npx playwright test`
- Expected Result: 全部退出码 0；不得关闭检查、跳过测试或依赖残留 dev server。
- Required Evidence: 五份完整日志和 Playwright 结果摘要。
- Result: NOT RUN
- Evidence: Pending

### AC-A-014：Rust 质量门禁全部通过

- Requirement: BR-04.2、NFR 6.4、测试要求 7.4。
- Priority: Must
- Verification Type: Automated
- Preconditions: 阶段 A 实现完成。
- Verification Steps:
  1. `cargo fmt -- --check`
  2. `cargo clippy --all-targets --all-features -- -D warnings`
  3. `cargo test`
- Expected Result: 全部退出码 0，无 warning 被放宽。
- Required Evidence: 三份完整日志。
- Result: NOT RUN
- Evidence: Pending

### AC-A-015：Windows 构建产物生成并通过冒烟

- Requirement: BR-04.3~4、完成定义 A.6。
- Priority: Must
- Verification Type: Automated / Manual
- Preconditions: 阶段 A 检查通过，目标 Windows 构建环境。
- Verification Steps:
  1. 执行 `npm run tauri build`。
  2. 记录实际产物路径、大小/hash 和安装器/可执行文件类型。
  3. 启动产物，完成最小 CRUD、重启持久化及数据目录/日志/海报检查。
- Expected Result: 构建退出码 0且产物可运行；若仅签名/安装器环境阻塞，必须有可复核错误和代码/环境分类，不能推断通过。
- Required Evidence: build 日志、产物清单/hash、运行截图和应用日志。
- Result: NOT RUN
- Evidence: Pending

### AC-A-016：README、CI 与仓库产物治理达标

- Requirement: BR-04.5、BR-05.7、路线图中当前明确要求的 CI 基线。
- Priority: Must
- Verification Type: Inspection / Automated
- Preconditions: 最终命令与路径语义确定。
- Verification Steps:
  1. 按 README 从安装到 dev/build 逐条验证。
  2. 检查 CI 覆盖 typecheck/lint/Vitest/Playwright/Rust fmt/clippy/test/build。
  3. 检查 Git 无一次性脚本、缓存、`playwright-report/`、`test-results/`、本地构建产物待提交。
- Expected Result: 文档可复现；CI 配置有效；产物从跟踪中移除并被忽略，不误删用户源文件。
- Required Evidence: README 执行日志、CI 配置检查、最终 git status/ignore check。
- Result: NOT RUN
- Evidence: Pending

### AC-A-017：阶段 A 独立验收报告完整

- Requirement: 完成定义 A.12。
- Priority: Must
- Verification Type: Inspection
- Preconditions: AC-A-001~016 已独立验证。
- Verification Steps:
  1. 检查报告列出原始问题、修复、命令、结果、产物和剩余风险。
  2. 检查每个结论均链接证据。
- Expected Result: `.agent-work/ACCEPTANCE_REPORT_BASELINE.md` 真实、完整；未验证项未标 PASS。
- Required Evidence: baseline 报告和证据索引。
- Result: NOT RUN
- Evidence: Pending

## 阶段 B：地区动态化专项

### AC-B-001：国家代码规范化正确

- Requirement: FR-01。
- Priority: Must
- Verification Type: Automated
- Preconditions: Gate A 通过。
- Verification Steps:
  1. 覆盖 trim、大小写、中英文逗号、重复、多国。
  2. 覆盖 `UK -> GB`、CN/HK/TW 独立。
  3. 过滤 N/A、NA、NULL、UNKNOWN、空和非两字母值。
  4. 保留未映射但格式有效两位代码。
- Expected Result: 输出为稳定、去重的大写代码数组，完全符合 FR-01。
- Required Evidence: Vitest 测试名称与日志。
- Result: NOT RUN
- Evidence: Blocked by AC-GATE-001

### AC-B-002：地区显示与未知地区正确

- Requirement: FR-02。
- Priority: Must
- Verification Type: Automated / Inspection
- Preconditions: Gate A 通过。
- Verification Steps:
  1. 核对固定中文名 CN/HK/TW/GB。
  2. 核对未映射代码显示自身。
  3. 核对无可识别来源显示/筛选“未知地区”。
- Expected Result: 三个中国地区互不合并；未知有统一哨兵且不与真实代码冲突。
- Required Evidence: 单测和 UI 截图。
- Result: NOT RUN
- Evidence: Blocked by AC-GATE-001

### AC-B-003：动态选项范围、数量与失效选择正确

- Requirement: FR-03、NFR 6.1。
- Priority: Must
- Verification Type: Automated / Manual
- Preconditions: Gate A 通过，混合数据夹具。
- Verification Steps:
  1. 在新增、编辑、删除、导入、同步后检查选项更新。
  2. 切换 mediaType/status，核对选项和数量。
  3. 改变评分、搜索、锁定、排序、activeRegion，核对基础集合/数量不变。
  4. 使当前地区消失，核对自动回到 all；空记录无地区栏。
- Expected Result: 只显示当前 mediaType/status 范围内实际存在项；无 0 数量和不可见幽灵状态；聚合无不必要重复全量计算。
- Required Evidence: 纯函数/Hook/组件测试、E2E 截图。
- Result: NOT RUN
- Evidence: Blocked by AC-GATE-001

### AC-B-004：地区统计、筛选与稳定排序正确

- Requirement: FR-04。
- Priority: Must
- Verification Type: Automated
- Preconditions: Gate A 通过。
- Verification Steps:
  1. 单国、多国、重复代码、未知记录计数和筛选。
  2. 验证地区与 mediaType/status/rating/search/lock 组合。
  3. 验证优先序 `CN,HK,TW,US,JP,KR,GB`，其余数量降序、名称升序、代码升序，未知最后。
- Expected Result: 每记录每地区最多计一次，多国可贡献多个地区，排序完全稳定。
- Required Evidence: Vitest/Playwright 日志和期望数据表。
- Result: NOT RUN
- Evidence: Blocked by AC-GATE-001

### AC-B-005：TMDB 多国保存和自定义标签保护

- Requirement: FR-05。
- Priority: Must
- Verification Type: Automated / Integration
- Preconditions: Gate A 通过。
- Verification Steps:
  1. 电影 production countries 和剧集 origin countries 分别映射。
  2. 新增/更新保存全部规范化代码。
  3. 更新自动地区标签前后对比用户自定义非地区标签。
- Expected Result: `originCountry` 不丢多国代码；筛选用代码；自定义标签不被覆盖或误删；不修改 TMDB 搜索接口。
- Required Evidence: mapper/classification/store 测试日志。
- Result: NOT RUN
- Evidence: Blocked by AC-GATE-001

### AC-B-006：旧数据、导入恢复同步兼容

- Requirement: FR-06、NFR 6.2。
- Priority: Must
- Verification Type: Automated / Integration
- Preconditions: Gate A 通过，旧标签/UK/混合数据夹具。
- Verification Steps:
  1. 仅 contentTags 的美/韩/日/英/CN/HK/TW 及现有别名回退。
  2. 验证 originCountry 有有效值时不读取冲突旧标签。
  3. 通过导入、备份恢复和同步输入旧记录，核对相同分类且 `originCountry` 不丢。
- Expected Result: 无破坏性迁移，新旧混合结果可预测一致。
- Required Evidence: Vitest、Rust/IPC 或 E2E 集成日志。
- Result: NOT RUN
- Evidence: Blocked by AC-GATE-001

### AC-B-007：地区专项自动化与界面流程完整

- Requirement: 测试要求 7.2、7.3、NFR 6.3。
- Priority: Must
- Verification Type: Automated / Manual
- Preconditions: AC-B-001~006 实现完成。
- Verification Steps:
  1. 执行全部地区单元测试。
  2. 执行混合数据地区 Playwright 流程：CN/HK/TW、GB/UK、多国、未知、组合筛选和动态更新。
  3. 用大量地区检查 wrap/滚动、选中态、`aria-pressed` 和无重叠。
- Expected Result: REQUEST 7.2/7.3 全部场景有自动化覆盖；布局与可访问性无明显回归。
- Required Evidence: 测试日志、截图/trace。
- Result: NOT RUN
- Evidence: Blocked by AC-GATE-001

### AC-B-008：地区专项回归与报告通过

- Requirement: 完成定义 B.6~9。
- Priority: Must
- Verification Type: Automated / Inspection
- Preconditions: AC-B-001~007 通过。
- Verification Steps:
  1. 执行 `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, `npx playwright test`。
  2. 执行相关 Rust fmt/clippy/test 与必要桌面冒烟。
  3. Codex 填写地区报告并逐项链接证据。
- Expected Result: 无现有筛选回归；所有命令通过；`.agent-work/ACCEPTANCE_REPORT_REGION.md` 结论真实完整。
- Required Evidence: 全量日志、地区报告、证据索引。
- Result: NOT RUN
- Evidence: Blocked by AC-GATE-001

## 最终综合报告

### AC-FINAL-001：两阶段综合验收报告完整

- Requirement: 完成定义 B.9。
- Priority: Must
- Verification Type: Inspection
- Preconditions: 阶段 A 与 B 报告均完成。
- Verification Steps:
  1. 汇总任务、标准、环境限制、未解决问题和证据。
  2. 核对最终结论不把 NOT RUN/BLOCKED 算作 PASS。
- Expected Result: `.agent-work/ACCEPTANCE_REPORT.md` 可追溯到两阶段全部证据。
- Required Evidence: 综合报告。
- Result: NOT RUN
- Evidence: Pending
