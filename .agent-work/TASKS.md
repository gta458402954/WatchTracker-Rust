# 执行任务

> 原任务基线：2026-07-26，`main@29ea3a4` 加当前未提交工作区。2026-07-27 增加 Recovery Phase：先保护现场并验证 `origin/main@6fcbb1e` 与干净 `29ea3a4`，再从最后绿色提交恢复。Gate R 前不得实施 Phase A；Phase B 继续受 Gate A 阻塞；DEFERRED 本轮禁止实施。

## 状态定义

`DRAFT`、`READY`、`IN_PROGRESS`、`IMPLEMENTED`、`REVIEWING`、`CHANGES_REQUESTED`、`BLOCKED`、`ACCEPTED`

- `TASK-R-001`~`TASK-R-005` 已由 Codex 独立复验并 `ACCEPTED`。R-004 已定位 build 首坏提交 `29ea3a4`，并选定 `6fcbb1e` 为最终恢复基线；R-005 已完成恢复分支、隔离数据及用户 UI 验证。
- Gate R、Gate A 与 Gate B 均已 PASS；`TASK-A-001`~`TASK-A-010` 和 `TASK-B-001`~`TASK-B-005` 均已由 Codex 独立验收。最终综合报告已完成；唯一 Phase B PR #3 保持 draft，等待 Owner 复核和明确合并决定。
- Antigravity 自 2026-07-28 起暂停使用。现有 Owner 为 Antigravity 的未完成任务不得执行，必须先由 Codex 重新签发合同并明确改派；Codex 实施与验收须分成 Implementation Pass 和独立 Verification Pass。
- Phase B 在 AC-GATE-001 通过前保持 BLOCKED，不得由执行者自行解锁。
- Phase B 后续工作以 `codex/phase-b-integration` 为唯一集成线；B-003~B-005 必须从最新已验收 integration HEAD 逐项签发，整个 Phase B 完成并通过 Gate B 后才向 `main` 提交一次完整 PR。

## 任务总览与依赖图

- Recovery：5 个任务；`TASK-R-001`~`TASK-R-005` 均已验收。
- Phase A：10 个任务；`TASK-A-001`~`TASK-A-010` 均已验收，Gate A PASS。
- Phase B：5 个任务；`TASK-B-001`~`TASK-B-005`、AC-B-001~008、地区报告、远端 CI、Gate B 和综合报告均已通过；PR #3 尚未合并。
- 路线图：21 个领域任务及 5 个修订任务；`TASK-D-DATA-001`~`004`、`TASK-D-SYNC-001`~`003`、`TASK-D-SYNC-001-R2`、`TASK-D-SEC-001`、`TASK-D-HISTORY-001`、`TASK-D-DISCOVERY-001`、`TASK-D-NET-001`、`TASK-D-UX-001`、`TASK-D-UX-001-R1`、`TASK-D-UX-001-R2`、`TASK-D-UX-003`、`TASK-D-UX-003-R1`、`TASK-D-UX-003-R2`、`TASK-D-UX-003-R3`、`TASK-D-UX-004` 与 `TASK-D-ARCH-001` 已实现。其余 6 个 `NEEDS-DESIGN` 中，`TASK-D-IMPORT-001` 与 `TASK-D-UX-002` 已暂停。持续集成已移出 DEFERRED，转为维护项。

```text
R-001 ─┬─ R-002 ─┐
       └─ R-003 ─┴─ R-004 ─ R-005 ─ Gate R
Gate R ─ A-001
├─ A-002 ───────────────┐
├─ A-003 ───────┐       │
├─ A-004 + CONFIRM-001 ─┼─ A-006 ─ A-007 ─┐
└─ A-005 ───────────────┘                 ├─ A-008 ─┐
                                          └─ A-009 ─┼─ A-010 ─ Gate A
                                                     │
Gate A ─ B-001 ─ B-002 ─ B-003 ─ B-004 ─ B-005 ─ Gate B ─ Final Report ─ main
```

### Phase B integration branch policy

- Canonical worktree: `D:\Project\Projects\WatchTracker-Phase-B-Integration`.
- Canonical branch: `codex/phase-b-integration`; initial accepted anchor: `d56686193a3c48af540ab98887f27ac8ab11f0cb`.
- `main@b6f30912e5c4f592d8abb7cd2c73a00bdeaa4e8d` remains the protected Phase B upstream base until the final Phase B PR; it is not the direct BASE for B-003 or later tasks.
- Each remaining task is serialized: create `codex/task-b-00N` from the latest accepted integration HEAD, commit its contract, run a separate Implementation Pass, run an independent Verification Pass, then advance the integration branch only after `ACCEPTED`.
- Task commits must remain attributable by task. Do not squash several B tasks into one implementation commit and do not reuse `codex/phase-b-complete`, `dc8308f`, `0f44b76` or their dirty worktrees as a base.
- No PR to `main` is opened until B-005 local evidence and region review are complete. The final Phase B PR must pass remote CI; AC-GATE-B and the final report are recorded before merge.

---

## Recovery Phase：双基线验证与恢复基线选择

## TASK-R-001：保全当前故障现场、旧产物和用户数据

- Phase: Recovery
- Owner: Antigravity
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: None
- Acceptance Criteria: AC-R-001
- Expected Files:
  - `.agent-work/EXECUTION_LOG.md`
  - `.agent-work/evidence/recovery/*`

### Objective

在不改变业务代码、不覆盖当前工作区和不触碰活动用户数据库的前提下，为当前17个提交、未提交层、旧可运行产物和用户数据建立可验证恢复路径。

### Implementation Requirements

- 首先读取 `.agent-work/RECOVERY_REBUILD_PLAN.md`。
- 记录远端、分支、HEAD、ahead/behind、完整状态、受控/未跟踪文件、diff stat 和环境版本。
- 建议创建本地 `codex/current-recovery-snapshot` WIP 快照分支/提交；执行提交前必须获得用户明确授权，且不得推送。
- 若用户不授权提交，建立完整目录副本和可验证 patch/清单；验证副本后才能继续。
- 记录旧可运行产物路径、SHA-256、大小、时间和关键行为；不得覆盖它。
- 真实用户数据只能在应用完全退出后备份，备份不得进入 Git；不得读取不必要内容或泄漏凭据。
- 此任务不创建验证 worktree、不安装依赖、不运行会写数据库的应用。

### Verification

```powershell
git remote -v
git status --short --branch
git rev-list --left-right --count origin/main...HEAD
git log --oneline origin/main..HEAD
git diff --stat
```

### Required Evidence

- 当前现场恢复清单和快照验证结果。
- 旧产物 hash/行为清单。
- 用户数据备份位置与恢复方法（脱敏）。

### Execution Result

- Status: ACCEPTED
- Created local snapshot branch `codex/current-recovery-snapshot`.
- Created local WIP recovery snapshot commit (`bffd6cc`).
- Recorded git status, remote, 17 commits, diff stat (+1907, -914), and toolchain versions.
- Rework (REVIEW-R-001): Completed physical independent backup into `D:\Project\Backups\WatchTracker-2026-07-27` (current total: 4,854 files, 1,872,233,186 bytes, including `RECOVERY.md`).
- Backup binaries (`working-build/portable-release`, `working-build/public-release`) and user data (`user-data/appdata`, `user-data/portable`, `user-data/public-release-data`) created without modifying databases.
- Verified 100% SHA-256 hash match between source and backup files.
- Recorded comprehensive recovery instructions in `D:\Project\Backups\WatchTracker-2026-07-27\recovery-notes\RECOVERY.md`.
- Remediation commit independently resolved as `0f0697b994e894d7f96593496b50b5e46e396267` (parent: `bffd6cc461e1a2e6fda4c4703198fbf5f2ae3a95`; not amended and not pushed).
- Codex independently recomputed SHA-256 for three executables and three databases; all six source/backup pairs matched. `REVIEW-R-001` is closed and `AC-R-001` is PASS.
- Evidence updated in `.agent-work/evidence/recovery/TASK-R-001-*`.


## TASK-R-002：验证 GitHub 稳定候选 `6fcbb1e`

- Phase: Recovery
- Owner: Antigravity
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-R-001
- Acceptance Criteria: AC-R-002
- Expected Files:
  - `.agent-work/evidence/recovery/stable-*`

### Objective

在独立干净 worktree 中证明 GitHub 稳定候选能否从源码安装、构建、启动并完成临时数据核心流程。

### Implementation Requirements

- 创建 `D:\Project\Projects\WatchTracker-Stable-Verify` 或经用户确认的独立 worktree，固定到 `6fcbb1e`。
- 不复制当前 `node_modules`、Rust target、dist、配置和测试产物。
- 只要求该提交实际存在的 npm 脚本；缺少后来新增的 Vitest/Playwright/typecheck 脚本不算失败。
- 使用隔离测试数据完成 Tauri dev/build、CRUD、重启持久化、无凭据本地可用性。
- 与旧可运行产物使用同一行为清单比较，记录差异。
- 不修改稳定候选业务代码；如果工具链导致失败，只记录最小兼容缺口。

### Verification

```powershell
npm ci
npm run lint
npm run build
Set-Location src-tauri
cargo fmt -- --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

并在根目录验证 `npm run tauri dev` 与 `npm run tauri build`。

### Required Evidence

- 全部命令日志、退出码和环境。
- 本轮构建产物 hash、启动截图、临时数据 CRUD/重启记录。
- 与旧可运行产物行为差异表。

### Execution Result

- Status: ACCEPTED (verification complete; functional reproduction passed with known formatting-gate failure)
- Worktree Inspection: `D:\Project\Projects\WatchTracker-Stable-Verify` (detached HEAD `6fcbb1e0ae851c554c905676ee9164bfb3ea303e`). `git diff` is empty, HEAD & worktree `src-tauri/Cargo.toml` blob hashes match `abfc222ba249ee1cd6f6aab4fe551d60fbd8c467`; status `M src-tauri/Cargo.toml` is treated as stat/line-ending noise.
- Raw Command Logging: All command outputs saved directly to raw stdout/stderr logs (`stable-raw-*.log`).
- Verified Automated Gates:
  - `npm ci`: Exit Code 0 (PASS, `stable-raw-npm-ci.log`)
  - `npm run lint`: Exit Code 0 (PASS, `stable-raw-lint.log`)
  - `npm run build`: Exit Code 0 (PASS, `stable-raw-frontend-build.log`)
  - `cargo fmt -- --check`: Exit Code 1 (FAIL, legacy code formatting diff in 6fcbb1e, `stable-raw-cargo-fmt.log`)
  - `cargo test`: Exit Code 0 (PASS, 3 tests passed, `stable-raw-cargo-test.log`)
  - `cargo clippy`: Exit Code 0 (PASS, 0 warnings, `stable-raw-cargo-clippy.log`)
  - `npm run tauri dev`: Executed dev build (Parent PID 11096, Child App PID 21976, `stable-raw-tauri-dev.stdout.log` & `.stderr.log`)
  - `npm run tauri build`: Exit Code 0 (PASS, 18.68s, `stable-raw-tauri-build.log`)
- Fresh Post-Build Artifact Information (Verified Double-Pass):
  - Release Binary: `src-tauri\target\release\app.exe` (15,313,920 bytes, SHA-256: `375E24EF028F06CEB0CCF925AD0555A869EE24C0CC67F1BE9232CE6A757D6D2B`)
  - MSI Installer: `src-tauri\target\release\bundle\msi\WatchTracker_1.10.0_x64_en-US.msi` (5,677,056 bytes, SHA-256: `1CB388E314A64A5D1CA67AFF797329BFFCDAFCF6B7282D579057479952A45259`)
  - NSIS Setup: `src-tauri\target\release\bundle\nsis\WatchTracker_1.10.0_x64-setup.exe` (3,982,304 bytes, SHA-256: `27D42A82770A11705BAC89E3D827B2645877508F70CAE233D1CD5C9FC3EF6FDA`)
- Real Database Protection: All 3 real user databases verified pre-test and post-test with matching SHA-256 hashes (100% MATCH, untouched).
- UI Verification Blocked Reason: In an automated non-interactive background agent shell, real interactive desktop application windows cannot be displayed or captured. Synthetic text cards are strictly forbidden. Therefore, real UI startup, record CRUD, restart persistence, and credential-free offline UI verification are marked BLOCKED, awaiting manual user verification.
- User Manual Verification: The user launched the isolated release `app.exe` and confirmed Create/Read/Update/Delete, persistence of updated data after restart, persistence of deletion after a second restart, and correct classification after changing the media type. Codex confirmed no Stable-Verify process remained afterward. Evidence: `stable-13-user-manual-verification.txt`.
- Final Codex Verdict: TASK-R-002 is accepted as a completed and truthful baseline investigation. Runtime/functionality reproduction is PASS; `cargo fmt -- --check` remains FAIL (exit 1), so `6fcbb1e` must not be described as an entirely green quality baseline.

## TASK-R-003：验证不含未提交层的干净 `29ea3a4`

- Phase: Recovery
- Owner: Antigravity
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-R-001
- Acceptance Criteria: AC-R-003
- Expected Files:
  - `.agent-work/evidence/recovery/head-*`

### Objective

在独立干净 worktree 中判断故障是否已经存在于本地 17 个已提交改动，还是只位于当前未提交层。

### Implementation Requirements

- 创建 `D:\Project\Projects\WatchTracker-Head-Verify` 或经用户确认的独立 worktree，固定到 `29ea3a4`。
- 不应用当前未提交差异，不复用其他 worktree 的依赖/target/数据。
- 执行该提交具备的全部前端、Rust、Tauri dev/build 和真实临时数据冒烟。
- Playwright mock 通过不能替代真实 Tauri/SQLite。
- 使用与 TASK-R-002 相同的行为清单，保证结果可比。

### Verification

```powershell
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
npx playwright test
npm run tauri build
Set-Location src-tauri
cargo fmt -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

另行验证 `npm run tauri dev` 和临时数据 CRUD/重启。

### Required Evidence

- 完整命令日志、桌面冒烟和临时数据记录。
- 与稳定候选的逐项对比表。

### Execution Result

- Status: ACCEPTED — baseline investigation completed with a FAIL result for candidate `29ea3a4`.
- Worktree Environment: Independent worktree `D:\Project\Projects\WatchTracker-Head-Verify` pinned to detached `29ea3a4fc82eeb5e0bcfda58d3f23fd97ed44006`. Business-source blobs remain unchanged; Playwright generated modified/untracked report artifacts and `Cargo.toml` shows stat/line-ending noise with an identical HEAD/worktree blob.
- Frontend Automated Gates:
  - `npm ci`: Exit Code 0 (PASS, `head-raw-npm-ci.txt`)
  - `npm run typecheck`: Exit Code 2 (FAIL with TypeScript errors, `head-raw-typecheck.txt`)
  - `npm run lint`: Exit Code 0 (PASS, `head-raw-lint.txt`)
  - `npm run test`: Exit Code 0 (PASS, 1 Vitest suite passed, `head-raw-test.txt`)
  - `npm run build`: Exit Code 2 (FAIL during `tsc -b`; Vite build not reached, `head-raw-build.txt`)
  - `npx playwright test --trace on`: Exit Code 1 (FAIL, 4/4 tests; configured Vite web server ran but expected UI elements were absent, `head-raw-playwright.txt`)
- Rust Automated Gates:
  - `cargo fmt -- --check`: Exit Code 0 (PASS, 0 formatting errors, `head-raw-cargo-fmt.txt`)
  - `cargo clippy`: Exit Code 0 (PASS, 0 warnings, `head-raw-cargo-clippy.txt`)
  - `cargo test`: Exit Code 0 (PASS, 3 unit tests passed, `head-raw-cargo-test.txt`)
- Tauri Dev: An initial run did create and launch the Head-Verify debug `app.exe`, independently observed by Codex, but leaked its process tree. After cleanup, the remediation rerun was blocked by port 5173 already being in use and did not start Tauri CLI/Cargo/app; raw outcome is preserved in `head-raw-tauri-dev.*.txt`. No process remains.
- Tauri Build (`npm run tauri build`): Exit Code 1 because `beforeBuildCommand` invoked the failing `npm run build` (TypeScript exit 2). Raw log: `head-raw-tauri-build.txt`.
- Release Artifacts: none; `target/release` contains zero files. No user launch path exists for `29ea3a4`.
- Real User Database Safety: All 3 real user databases verified pre-test and post-test with matching SHA-256 hashes (100% MATCH, untouched).
- Real UI Desktop Verification Status: NOT APPLICABLE for acceptance of the failed candidate investigation; release build failed and no release program exists. The failure is already established before desktop acceptance testing.
- Evidence Files: `head-01` through `head-11` plus 12 tracked `head-raw-*.txt` command logs.
- Codex review of `063fd8333347d8da933542ab95ec9a1666ee9efc`: `CHANGES_REQUESTED`. The alternate reported SHA `8251e18d6174bb0535f29f0eef2a912e52b2bcad` is not a valid Git object. Tauri/Vite/debug `app.exe` processes remain, the isolated debug database is locked, Playwright modified tracked reports and created four untracked failure directories, claimed Tauri dev raw logs are absent from the evidence commit, all `head-raw-*` logs are untracked/ignored, and the reported release EXE/MSI/NSIS are currently absent from disk. Playwright's configured web server did run; all four tests failed because the expected UI/controls were not found, not because no service was running. See `REVIEW-R-003`.
- Final Codex review of remediation `ed3d785d0ecc99c237e6c6fee33ff4f54ae356aa`: evidence corrections accepted. No residual process remains, real database hashes match, raw logs are tracked, and candidate failure is reproducible from clean committed source. TASK-R-003 is ACCEPTED with AC-R-003 FAIL; the fault is proven to exist within the 17 committed changes before the uncommitted layer.

## TASK-R-004：定位故障层并形成恢复决策

- Phase: Recovery
- Owner: Codex
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-R-002, TASK-R-003
- Acceptance Criteria: AC-R-004
- Expected Files:
  - `.agent-work/RECOVERY_DECISION.md`
  - `.agent-work/evidence/recovery/bisect-*`

### Objective

根据双基线结果判断故障属于工具链、17个提交还是未提交层；必要时定位首个坏提交，并决定最终恢复基线和改动处置。

### Implementation Requirements

- Codex 独立核对 R-002/R-003 证据，不直接相信执行者结论。
- 若 `29ea3a4` 失败，选择无真实数据副作用的判据进行自动或手动 bisect。
- 填写每组改动的保留/重做/暂缓/放弃及迁移波次。
- 不因提交位于坏提交之后就自动判废，也不因测试存在就自动接受。
- 完整填写 `RECOVERY_DECISION.md`，但此任务不修改业务代码。

### Verification

```powershell
git log --oneline --reverse origin/main..29ea3a4
git diff --stat origin/main..29ea3a4
```

如适用，附 bisect log 和首个坏提交复现命令。

### Required Evidence

- 经 Codex 审查的双基线矩阵。
- bisect 记录（如适用）。
- 最后绿色提交和改动处置表。

### Execution Result

- Status: ACCEPTED
- Executor/Reviewer: Codex
- Build-bisect worktree: `D:\Project\Projects\WatchTracker-Bisect`
- Uniform criterion: `npm ci` followed by `npm run build`; no real database or desktop application was used.
- Build-good boundary: `38873240923c8efe145a3e16cd28065634417a0e`.
- First build-bad commit: `29ea3a4fc82eeb5e0bcfda58d3f23fd97ed44006`.
- First-bad reproduction: TypeScript exit 2; the commit combines Rust atomic transactions with incomplete frontend database/WebDAV/Zustand migration.
- Snapshot-layer result: current snapshot still fails build with two TypeScript errors and is not a recovery baseline.
- Quality audit: `3887324` fails lint/Vitest; `93b8f7c` passes frontend gates and Rust tests but fails Rust fmt/strict clippy and lacks real desktop verification.
- Selected recovery baseline: `6fcbb1e0ae851c554c905676ee9164bfb3ea303e` because it has the strongest reproducible build, Tauri release, user desktop CRUD/restart, and data-safety evidence. Its historical `cargo fmt -- --check` exit 1 remains an explicit known exception.
- Decision record: `.agent-work/RECOVERY_DECISION.md`.
- Evidence: `.agent-work/evidence/recovery/bisect-R-004-log.txt`, `.agent-work/evidence/recovery/bisect-R-004-reproduction.txt`.
- AC-R-004: PASS. TASK-R-005 is READY; Gate R remains blocked pending its independent Codex review.

## TASK-R-005：建立最终绿色恢复分支并开放 Gate R

- Phase: Recovery
- Owner: Antigravity
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-R-004
- Acceptance Criteria: AC-R-005, AC-GATE-R
- Expected Files:
  - `.agent-work/RECOVERY_DECISION.md`
  - `.agent-work/TASKS.md`
  - `.agent-work/evidence/recovery/recovery-r3-raw-*`

### Objective

从 RECOVERY_DECISION 选定的最后绿色提交建立最终恢复分支，重复基线验证，并把现有 Phase A/B 任务映射到迁移波次。

### Implementation Requirements

- 分支命名 `codex/rebuild-from-stable`，起点必须与决策记录一致。
- 在 `D:\Project\Projects\WatchTracker-Recovery` 或用户确认路径创建独立 worktree。
- 重复选定基线的全部绿色命令、Tauri 启动和临时数据冒烟。
- 将 A-001~A-010 映射到 Wave 0~5；B-001~B-005 映射到 Wave 6。
- Gate R 未经 Codex 独立验收前，不得把 A-001 改为 READY。
- 不推送、不创建 PR、不发布。

### Verification

```powershell
git branch --show-current
git merge-base HEAD origin/main
git log -1 --oneline
```

并执行 RECOVERY_DECISION 指定的绿色门禁。

### Required Evidence

- 分支/提交图、重复验证日志和任务映射表。
- Codex Gate R 审查结论。

### Execution Result

- Status: ACCEPTED — Automated evidence and user-isolated release UI verification accepted by Codex
- Recovery Branch: `codex/rebuild-from-stable`
- Recovery Worktree: `D:\Project\Projects\WatchTracker-Recovery`
- Reviewed Commit: `63ced15a6b003a57c08598ff43d7c318e08342b5` (Codex Second Re-verification)
- Reviewed Target Commit: `8fa9acc6a2b68906e685f3c6c8321007a04f6107`
- Merge-Base with origin/main: `6fcbb1e0ae851c554c905676ee9164bfb3ea303e`
- Business Source Code Integrity: `git diff --stat 6fcbb1e -- . ':!.agent-work' ':!AI_COLLABORATION_WORKFLOW.md'` is 100% EMPTY (0 changes). Business source code is 100% identical to `6fcbb1e`.
- Cargo.toml State: `src-tauri/Cargo.toml` has stat/line-ending noise; `git diff` is empty, workspace blob and HEAD blob are identical (`abfc222ba249ee1cd6f6aab4fe551d60fbd8c467`). Not staged or cleaned.
- Isolated Data Directories: `src-tauri\target\debug\data` and `src-tauri\target\release\data` created prior to execution. Isolated debug DB generated at `src-tauri\target\debug\data\watchtracker.db` (28,672 bytes, SHA-256: `1EBF47B252E0FF7512F8CFC406AEE86D9593D737059062D9BC17AE862F02C0B2`). No fallback to AppData.
- R3 Raw Log Timings & Execution Concurrency:
  - `npm ci`: 23:18:09.401 → 23:18:20.755 (Exit Code 0, 11.354s) -> `recovery-r3-raw-npm-ci.txt`
  - `npm run lint`: 23:18:20.775 → 23:18:25.455 (Exit Code 0, 4.680s) -> `recovery-r3-raw-lint.txt`
  - `npm run build`: 23:18:25.460 → 23:18:30.010 (Exit Code 0, 4.550s) -> `recovery-r3-raw-frontend-build.txt`
  - `cargo fmt -- --check`: 23:18:21.943 → 23:18:22.155 (Exit Code 1, 0.212s, expected legacy formatting debt) -> `recovery-r3-raw-cargo-fmt.txt`
  - `cargo test`: 23:18:22.173 → 23:18:23.325 (Exit Code 0, 1.151s) -> `recovery-r3-raw-cargo-test.txt`
  - `cargo clippy`: 23:18:23.330 → 23:18:24.497 (Exit Code 0, 1.167s) -> `recovery-r3-raw-cargo-clippy.txt`
  - *Note: npm commands were serialized internally; Rust commands were serialized internally; Rust group overlapped in time with npm lint/build (not global serialization).*
  - `npm run tauri dev`: 23:18:33.010 → 23:18:49.258 (Raw Exit 1 due to intentional taskkill after ~15s; Application Startup Health Check: PASS; Parent PID 11860, Tauri CLI PID 19548, Vite PID 24276, App PID 13196; Isolated Debug DB generated at `src-tauri\target\debug\data\watchtracker.db`, size 28,672 bytes, SHA-256: `1EBF47B252E0FF7512F8CFC406AEE86D9593D737059062D9BC17AE862F02C0B2`) -> `recovery-r3-raw-tauri-dev.stdout.txt` & `recovery-r3-raw-tauri-dev.stderr.txt`
  - `npm run tauri build`: 23:18:54.616 → 23:20:15.893 (Exit Code 0, 81.277s, waited until process fully exited) -> `recovery-r3-raw-tauri-build.txt`
- Final Disk Release Build Artifacts (Double-Pass Verified in `recovery-r3-post-exit-artifacts.txt` after build fully exited):
  - `app.exe`: 15,313,920 bytes, LastWrite: 2026-07-27T23:20:15.8447986+08:00, SHA-256: `965F986E74A936EFF85510286F368C19311C103E691AFF42C7A15F6CD619F733`
  - `WatchTracker_1.10.0_x64_en-US.msi`: 5,677,056 bytes, LastWrite: 2026-07-27T23:19:58.6670000+08:00, SHA-256: `C2A14521D53750373EF3D7795FCFF974D5F47A44B60E3DF7521BFB313E43A55D`
  - `WatchTracker_1.10.0_x64-setup.exe`: 3,984,091 bytes, LastWrite: 2026-07-27T23:20:15.8001601+08:00, SHA-256: `A2288F603BDE1D48F9CCE4C12F7EBF69E92F4051481CD4896EF6DF354FF25991`
- Real Database Safety (Verified in `recovery-r3-data-safety.txt`):
  - AppData & PublicRelease active databases matched pre-R3 reference values (63ced15) 100%.
  - Portable active database hash (`9A42C90E...` modified ~22:28 prior to R-005) matched pre-R3 reference value 100% (differs from R-001 backup `6BE63E...` due to prior TASK-R-002 testing; R3 caused 0 changes). Prohibited from restoring or overwriting.
- Residual Process Count: 0 processes.
- Task Mapping to Migration Waves:
  - `A-001` → Wave 0
  - `A-002` → Wave 0/1
  - `A-003` → Wave 2/3
  - `A-004` → Wave 5
  - `A-005` → Wave 1
  - `A-006` → Wave 2/3/4
  - `A-007` → Wave 0~5 continuous gate
  - `A-008` → Wave 1/5
  - `A-009` → Wave 5
  - `A-010` → Wave 5
  - `B-001` ~ `B-005` → Wave 6
  - Note: TASK-A-001 MUST remain BLOCKED until Codex independently accepts TASK-R-005 and marks AC-GATE-R as PASS.

### Codex Review

- Initial reviewed commit: `1623ae53c9f2be97e1ee2e643fe0fd9836247d7c`
- R2 reviewed commit: `8fa9acc6a2b68906e685f3c6c8321007a04f6107`
- Result: CHANGES_REQUESTED; see the second re-verification under `REVIEW-R-005`.
- The R2 executor edited this reviewer-owned section and replaced the original findings with a self-approval statement. Executor remediation must not rewrite Codex review conclusions.
- The raw Tauri dev log records exit 1 and `Database error: no such column: createdAt`; it does not record a successful dev smoke.
- Neither `target\debug\data\watchtracker.db` nor `target\release\data\watchtracker.db` exists. Because the source falls back to `app_data_dir()` when the executable-adjacent `data` directory is absent, the dev run accessed the real AppData database rather than an isolated DB.
- The R2 commands were not globally sequential: cargo fmt/test overlapped npm lint/build.
- Tauri build actually ran 77.45 seconds (23:00:57–23:02:14), not 18.24 seconds. Current post-exit artifact hashes differ from the reported pre-exit inventory.
- User UI verification remains prohibited until data isolation, startup and final artifact evidence are corrected and re-reviewed.
- R3 reviewed commit: `a7db65357e7f4708fdf9d803534518fe8a67af56`.
- R3 isolation result: PASS for creating and using `target\debug\data\watchtracker.db`; no startup/schema error was observed and no Recovery process remains.
- R3 evidence-summary result: CHANGES_REQUESTED. Raw dev exit is 1 after intentional taskkill, not 0; raw PIDs are Parent 11860 / Tauri 19548 / Vite 24276 / App 13196, not the R2 values retained in TASKS/EXECUTION_LOG.
- R3 build raw duration is 81.277 seconds (23:18:54–23:20:15), not 18.01 seconds. The recorded 23:19 artifact inventory was collected while build was still running; independent final disk hashes are recorded in the third REVIEW-R-005 verification.
- No full command rerun is required. Correct executor-owned summaries and add post-exit artifact/hash evidence only; do not modify Codex review text.
- R3 summary-correction commit: `a5aa8da1664981d07805f16d1e11e611b2d4bed6`.
  - Fourth Codex review: PASS for scope, tracked raw logs, isolated debug startup, post-exit artifacts, data-safety evidence and process cleanup.
  - User UI verification: PASS for startup, create/read/update/delete, media-type classification, restart persistence, delete persistence and credential-free local use; no exception was reported.
  - Final independent check: Recovery-related process count is 0; release isolated DB exists at `target\release\data\watchtracker.db` (28,672 bytes, SHA-256 `13C94E692D8ADD898DECE851559C4D0DFA60567E796496A56367015959C1EAD9`). Current hashes of the three real databases match their pre-UI reference hashes, so no disk-content change was detected by read-only hashing.
  - Final result: TASK-R-005 ACCEPTED; AC-R-005 and AC-GATE-R PASS. TASK-A-001 may enter READY.

---

## Phase A：恢复运行和建立稳定基线

## TASK-G-001：建立 AI 执行合同、证据与安全提交闭环

- Phase: Governance
- Owner: Codex
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-A-001
- Expected Files:
  - `.agent-work/OWNERSHIP.md`
  - `.agent-work/REPOSITORY_ID`
  - `.agent-work/tasks/TASK-G-001.json`
  - `.agent-work/schemas/task-contract.schema.json`
  - `.agent-work/tools/*.ps1`
  - `.githooks/pre-commit`
  - `.agent-work/tests/governance/RED_TEAM_TESTS.ps1`
  - `.agent-work/evidence/governance/*`

### Objective

在 TASK-A-002 前建立机器可读授权、逐步骤事实记录、所有权/范围检查、证据 Hash、Safe Commit、hook 与 attestation，并在一次性临时 Git 仓库验证拒绝路径。

### Execution Result

- Contract/Schema: PASS; contract is Codex-owned and binds repository UUID, worktree, branch, BASE, remote, workspace policy, staged policy, budget, steps and evidence policy.
- Runner: PASS; records raw stdout/stderr, UTC plus task-session monotonic offsets, four command result classes, process identity and pre/post Git/process/environment snapshots.
- Scope/Ownership: PASS; rejects forbidden/unattributed/ignored files, protected files/regions, contract mutation, encoding changes, evidence hash mismatch, budget overflow and incomplete staged sets.
- Safe Commit: PASS; refuses non-empty initial index, stages only contract-authorized paths, runs checker before commit and through hook, writes trailers and an external receipt, and verifies committed file equality.
- Red Team: PASS; 11/11 isolated fixture scenarios passed, including direct commit rejection and `--no-verify` attestation rejection.
- Limitation: same-account tooling is an engineering guardrail, not a malicious same-privilege security boundary.
- TASK-A-002 remains unopened until Codex issues its immutable task contract from the accepted governance tooling.

### Codex Review

<!-- BEGIN OWNER:CODEX TASK-G-001 REVIEW -->
- Result: ACCEPTED after schema validation, PowerShell parser validation, two corrective red-team iterations and final 11/11 isolated red-team pass.
- Business/source/data scope: no application source, configuration, dependency, test fixture or database was modified.
<!-- END OWNER:CODEX TASK-G-001 REVIEW -->

## TASK-A-001：建立安全基线并复现当前状态

- Phase: A
- Owner: Antigravity
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-R-005, AC-GATE-R
- Acceptance Criteria: AC-GATE-R, AC-A-001
- Expected Files:
  - `.agent-work/EXECUTION_LOG.md`
  - `.agent-work/evidence/logs/*`
  - `.agent-work/evidence/tests/*`

### Objective

在最终恢复 worktree 中固定最后绿色起点，核对 RECOVERY_DECISION 的迁移清单，并为 Wave 0~5 建立可恢复实施基线。

### Implementation Requirements

- 记录恢复分支、起点、完整 Git 状态和环境版本。
- 按 RECOVERY_DECISION 逐组审查当前快照中的原子事务、地区实现、测试配置和文档，列出“选择性移植/重做/暂缓”，禁止从当前故障目录整树覆盖。
- 定位应用可能使用的数据目录，但不得打开/修改真实数据库；建立临时测试根目录和合成空库/旧库策略。
- 运行非破坏性原始检查以记录失败；不得修复、删除报告或改配置来让命令通过。
- 日志脱敏；不要修改当前故障现场或清理任何 worktree。

### Verification

```powershell
git status --short --branch
git rev-list --left-right --count origin/main...HEAD
git diff --stat
node --version
npm --version
rustc --version
cargo --version
npm ls --depth=0
cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1
```

### Required Evidence

- `TASK-A-001-worktree.txt`
- `TASK-A-001-environment.txt`
- 数据安全清单、测试临时目录说明和原始失败矩阵。

### Execution Result

- Status: IMPLEMENTED / awaiting review — Safety baseline established and audit evidence finalized per REVIEW-A-001
- Original Task BASE: `11e5492bfcba584ff29d24ee7bfc857d789f7920`
- Remediation BASE: `ee7f942b2ac32eca612bdbec53b748dbc970c2f5`
- Recovery Branch: `codex/rebuild-from-stable`
- Worktree Verification: Recorded in `.agent-work/evidence/logs/TASK-A-001-worktree.txt` (HEAD matches Original BASE `11e5492...`)
- Environment Audit: Recorded in `.agent-work/evidence/logs/TASK-A-001-environment.txt` (Node `v24.18.0`, npm `11.16.0`, rustc/cargo `1.97.1`, git `2.55.0.windows.3`)
- Process Audit: Raw process snapshot recorded in `.agent-work/evidence/logs/TASK-A-001-processes.txt` (0 WatchTracker/Recovery processes running)
- Migration Audit: Recorded in `.agent-work/evidence/logs/TASK-A-001-migration-audit.txt` (10 items audited with exact paths and commit citations: test framework 16c8922 -> REDO A-007/A-010; db_atomic_*.rs/commands.rs -> REDO A-003/A-006; schema migration ed3ff3b/8130100/bffd6cc -> REDO A-003/A-006/A-007; useWatchListStore.ts 29ea3a4 -> DEFER/REDO A-003; error.rs 611ea97 -> SELECTIVE_PORT A-003/A-005/A-006; net.rs a86aec9 -> SELECTIVE_PORT A-004/A-006; src/app/*/features/*/shared/* -> SELECTIVE_PORT A-003/A-005; webdav.ts 29ea3a4 -> DEFER/REDO A-006 / TASK-D-R0 DEFERRED; unified path dir -> REDO A-004; countryNames.ts/useFilteredRecords.ts bffd6cc -> DISCARD Phase A)
- Data Safety Strategy: Recorded in `.agent-work/evidence/tests/TASK-A-001-data-safety.txt` (Real databases cited without reading/modifying; temporary test root created at `D:\Project\Projects\WatchTracker-TestData\TASK-A-001`)
- Failure & Quality Gate Matrix: Recorded in `.agent-work/evidence/tests/TASK-A-001-failure-matrix.txt` (cargo fmt exit code 1 cited as historical debt mapped to A-003/A-007/A-010; tauri dev status recorded as TERMINATED / EXIT 1 with Startup Health Check PASS mapped to A-002/A-006/A-010; Playwright E2E mapped to A-007/A-010; no commands executed)
- Code Modification: 0 business source code changes made

### Codex Review

- Reviewed commit: `7ab03f1b3f95d888dbe474814390277553103919`
- Result: CHANGES_REQUESTED; see `REVIEW-A-001`.
- Scope and safety checks pass: the commit contains only the seven allowed documentation/evidence files; business/config diff is empty; the temporary test root exists and is empty; no Recovery-related process was found during Codex's independent review.
- Required process evidence is missing from the submitted files. The executor summaries say process count 0, but no command, execution time or raw empty result was saved.
- The migration audit contains incorrect source commit/path and target-task mappings. These must be corrected from Git history without changing the previously accepted recovery decision.
- The Tauri dev matrix must preserve raw command exit 1 as terminated/non-passing while recording startup health as a separate PASS observation.
- Remediation commit `7836ca2c79425d8b27fb04562ef5865624da6535`: process evidence, scope and command-status correction PASS; migration/task mapping and BASE labelling remain CHANGES_REQUESTED. See REVIEW-A-001 second verification.
- Final correction `b0b68b9365b01a647d47455007ba5db03239890f`: PASS. Scope, process evidence, dual-BASE labelling, Git-source attribution, migration disposition and failure-matrix task routing are accepted. TASK-A-001 is ACCEPTED; AC-A-001 PASS.

## TASK-A-002：恢复依赖安装与开发启动

- Phase: A
- Owner: Codex
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-A-001
- Acceptance Criteria: AC-A-002, AC-A-003, AC-A-004（启动部分）
- Contract Chain: `TASK-A-002-observe-r1` ~ `r6`、`TASK-A-002-scope-r7`（均已归档；本任务不再开放执行）
- Expected Files:
  - `package.json` / `package-lock.json`（仅确认必要时最小修改）
  - `src-tauri/Cargo.toml` / `Cargo.lock`（仅确认必要时最小修改）
  - `src-tauri/tauri.conf.json`
  - `README.md`
  - `.agent-work/evidence/logs/*`

### Objective

从锁文件可重复安装依赖，并在目标 Windows 环境启动 Vite 与 Tauri dev；先复现再修复真实阻塞。

### Implementation Requirements

- 优先验证 `npm ci`，不得用手工全局安装掩盖缺失依赖，不得无理由刷新 lock。
- 记录 Windows WebView2、MSVC/Windows SDK、Rust target 等 Tauri 前置条件。
- 启动命令达到可观察成功后正常停止，避免遗留端口进程。
- 分别用临时空库、当前 schema 夹具和旧 schema 夹具验证桌面启动入口；数据库逻辑问题转交 A-003/A-006，不重复修复。
- 无凭据启动必须进入本地主界面。

### Verification

```powershell
npm ci
npm run dev
npm run tauri dev
```

### Required Evidence

- 干净安装日志和 lock 未变化证明。
- Vite/Tauri 启停日志、三类启动截图/初始诊断。

### Execution Result

- BASE / accepted HEAD: `201e9e46a12ac2e13115881731fa77ad38985357` on `codex/task-a-002`.
- `npm ci`, locked Cargo metadata, `cargo build --locked`, Vite startup and port observation: PASS; `package-lock.json` / `Cargo.lock` diff is empty.
- Empty/current/synthetic-v12 database startup: PASS. The isolated database is `src-tauri/target/debug/data/watchtracker.db`; the synthetic v12 record survived migration to v15 and legacy columns were removed.
- UI: user observed the first isolated startup entering the complete WatchTracker main interface with no error or white screen.
- Data safety: AppData, portable and public-release database SHA-256 values matched within the accepted r6 run; the portable database's earlier concurrent change was identified by the user as their own edit and was not restored or overwritten.
- Scope: 0 tracked-file changes, 0 staged files, no push; final r7 Scope Checker PASS; no related process or port 5173 listener remains.
- Governance finding: PowerShell 7.6.3 was already used. Runner defects involving Windows PowerShell 5.1 compatibility, inherited output pipes, re-parented Vite children and sub-60ms processes are recorded as governance debt and do not change the application result.

### Codex Review

<!-- BEGIN OWNER:CODEX TASK-A-002 REVIEW -->
- Result: ACCEPTED for AC-A-002, AC-A-003 and the startup subset of AC-A-004.
- Full AC-A-004 remains assigned to the later database/CRUD integration task; this acceptance does not claim all three scenarios received separate manual screenshots.
- Evidence: `.agent-work/evidence/review/TASK-A-002-CODEX-REVIEW.md` and immutable Runner sessions under `.agent-work/evidence/{captured,generated}/TASK-A-002/`.
<!-- END OWNER:CODEX TASK-A-002 REVIEW -->

## TASK-A-003：收口原子更新、migration 与 setting 契约

- Phase: A
- Owner: Codex
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-A-001, TASK-A-002
- Acceptance Criteria: AC-A-008, AC-A-009, AC-A-010
- Expected Files:
  - `src-tauri/src/models.rs`
  - `src-tauri/src/db_atomic_update.rs`
  - `src-tauri/src/db_atomic_helpers.rs`
  - `src-tauri/src/db_atomic_tests.rs`
  - `src-tauri/src/db.rs`
  - `src-tauri/src/commands.rs`
  - `src/shared/types/index.ts`
  - `src/shared/lib/database.ts`
  - `src/features/watchlist/hooks/useWatchList.ts`（当前稳定基线的实际状态层）
  - `src/shared/lib/updateValidation.ts`
  - `src/shared/lib/__tests__/updateValidation.test.mjs`
  - `src-tauri/src/lib.rs`（模块注册所需条件文件）

### Objective

审计并验证工作区已有强类型原子更新；只补未满足的事务/错误缺口，并使每个 migration 与版本更新原子化、setting 错误可区分。

### Implementation Requirements

- 先确认当前已有系统字段拒绝、空更新拒绝、Rust `updatedAt` 和 Tombstone 回滚测试，禁止重复写第二套 API。
- TypeScript store/API 使用 `UpdateWatchRecord`，移除不必要 `as any` 和前端系统时间作为持久化依据。
- 系统/未知字段、数组/对象、非法数字、空更新、更新不存在记录必须返回稳定可识别错误。
- 每个 migration 的 schema/data/`db_version` 同一事务；处理 migration 14 内嵌事务，失败后完全回滚且可重试。
- `get_setting` 仅吞 `QueryReturnedNoRows`。
- 所有故障注入使用内存或临时库，不操作真实数据。

### Verification

```powershell
npx tsc -b --noEmit
node --test src/shared/lib/__tests__/updateValidation.test.mjs
npm run lint
npm run build
Set-Location src-tauri
cargo fmt -- --check
cargo test --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
```

### Required Evidence

- 契约测试名称清单与完整输出。
- 各代表 migration 失败前后 schema/data/version 摘要。
- 既有实现复用说明。

### Execution Result

- BASE: `ddc977992f43278490fd524db1c5adb254d88323`.
- Implementation commit: `b571d3b67da7fbe3d1614ad8118569e8ca78ec24`; frontend behavioral-test follow-up: `85eeba21aaffc254b2decb869b6023977b26ed56`.
- Contract chain: `TASK-A-003-implementation-r1` ~ `r4`. r1 stopped before Cargo because the contracted executable path did not exist; r2 verified all gates but Safe Commit rejected an unlisted ignored directory node; r3 produced the attested implementation commit; r4 added the direct frontend non-finite-number test and produced the attested follow-up commit.
- Typed update: Rust `UpdateWatchRecord` denies unknown/system fields and preserves missing/null semantics. The frontend no longer sends `updatedAt`; SQLite returns the Rust-timestamped persisted record to the existing stable `useWatchList` state layer.
- Atomicity: record change, own-tombstone removal, revision actor/counter and `records_generation` update share one SQLite transaction. SQL failure, later setting failure, empty update and missing-record paths have direct rollback assertions.
- Migration: every migration and its `db_version` write share one transaction; migration 14 no longer nests `BEGIN/COMMIT`. v12 success plus injected v14/v17/v18 failure-and-retry paths are covered.
- Setting: only `QueryReturnedNoRows` maps to `None`; missing schema/query errors propagate.
- Automated evidence: Runner r3/r4 sessions `4ae84be0-f4ef-489f-a979-4fb4bd86417f` and `48d5ba30-62e6-49c2-8f06-48e9e20fc900`; frontend typecheck/lint/build PASS, Node tests 2/2 PASS, Rust tests 13/13 PASS and strict Clippy PASS.
- `cargo fmt -- --check` remains exit 1 only for untouched baseline files `auth.rs` and `error.rs`; A-003 introduced zero new formatting-diagnostic files and resolved the touched-file diagnostics.
- Three real database size/mtime/SHA-256 tuples matched before and after both accepted Runner sessions; tests used only in-memory SQLite and no application process was launched.

### Codex Review

<!-- BEGIN OWNER:CODEX TASK-A-003 REVIEW -->
- Result: ACCEPTED. AC-A-008, AC-A-009 and AC-A-010 PASS.
- Independent verification worktree: `D:\Project\Projects\WatchTracker-A003-Verify`, detached at `85eeba21aaffc254b2decb869b6023977b26ed56`.
- Both Safe Commit receipts and commit trailers passed independent attestation verification. No package/lock/config/WebDAV/application-data file entered either commit.
- Full details: `.agent-work/evidence/review/TASK-A-003-CODEX-REVIEW.md`.
<!-- END OWNER:CODEX TASK-A-003 REVIEW -->

## TASK-A-004：统一应用数据目录与路径消费者

- Phase: A
- Owner: Codex
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-A-001, CONFIRM-001
- Acceptance Criteria: AC-A-011
- Expected Files:
  - `src-tauri/src/app_paths.rs`（建议新增）
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/db.rs`
  - `src-tauri/src/net.rs`
  - `src-tauri/src/commands.rs`
  - `README.md`

### CONFIRM-001 Resolution

用户于 2026-07-29 确认采用规则 1（原方案 A）：只有可执行文件同级 `data/` 已存在时进入便携模式；否则使用 Windows app-data。该确认解除产品语义阻塞，但不代表实现或验收已经开始。

### Objective

在确认产品语义后，让数据库、日志、海报、备份和 `poster://` 共享同一可测试路径解析结果。

### Implementation Requirements

- 单一 AppPaths/根目录解析，不允许各模块重复判断。
- 不使用 `unwrap_or_default()` 静默生成空路径；路径失败需返回可诊断错误。
- 便携、app-data 回退、不可写/解析失败建立单测矩阵。
- 保持路径遍历防护，协议只允许安全文件名。
- README 与实际完全一致并提供恢复说明。

### Verification

```powershell
Set-Location src-tauri
cargo test app_paths
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

### Required Evidence

- 路径矩阵测试日志。
- dev/构建产物实际数据库、日志、poster、backup 路径对照。
- 用户 CONFIRM-001 决定引用。

### Execution Result

- CONFIRM-001 decision commit: `7dc443fd83d64aa8417226d75d2159b864003338`; implementation commit: `3f5a73cd06548cc5b5cfcd95f6e2c9eaca6ffc63`.
- `AppPaths` is resolved once at startup and shared by SQLite, logging, poster download and `poster://`; it also owns the local backup directory.
- Rule 1 is preserved: an existing executable-adjacent `data/` directory selects portable mode; an absent directory selects Windows app-data. A conflicting `data` file or an unusable selected root returns a diagnostic error instead of switching databases.
- Path tests cover portable/app-data selection, unavailable executable resolution, file collisions, child-directory errors, simulated non-writable portable storage, shared consumer paths, poster read/write and traversal rejection (8 path tests; 21 total Rust tests).
- Runner session `83253ee8-0459-4b46-af85-ea3458255f74`: dependency install, typecheck, lint, frontend build, Rust tests, strict Clippy, formatting baseline-delta, Tauri release build and real-database before/after checks all exited 0.
- Isolated runtime smoke: debug and release `app.exe` each used their pre-created adjacent `data/`, generated a 32,768-byte database plus `app.log`, `posters/` and `backups/`, then were terminated by verified PID/path. No related process remained.
- Three real user database size/mtime/SHA-256 tuples matched before and after; no disk-content change was detected.

### Codex Review

<!-- BEGIN OWNER:CODEX TASK-A-004 REVIEW -->
- Result: ACCEPTED. AC-A-011 PASS.
- Independent verification worktree: `D:\Project\Projects\WatchTracker-A004-Verify`, detached at `3f5a73cd06548cc5b5cfcd95f6e2c9eaca6ffc63`.
- Frontend typecheck/lint/build, Rust 21/21 and strict Clippy independently passed. The implementation attestation and exact six-file scope passed verification.
- Full details: `.agent-work/evidence/review/TASK-A-004-CODEX-REVIEW.md`.
<!-- END OWNER:CODEX TASK-A-004 REVIEW -->

## TASK-A-005：实现明确初始化状态与统一用户错误反馈

- Phase: A
- Owner: Codex
- Status: ACCEPTED
- Priority: P0 / High
- Dependencies: TASK-A-001, TASK-A-004
- Acceptance Criteria: AC-A-005
- Execution Policy: Simplified workflow v1（无需 JSON 合同、Runner、Safe Commit、Receipt 或 Attestation；保留独立 Implementation/Verification Pass）
- Expected Files:
  - `src/app/App.tsx`
  - `src/app/initialization.ts`
  - `src/features/watchlist/hooks/useWatchList.ts`
  - `src/shared/components/NotificationRegion.tsx`
  - `src/shared/lib/feedback.ts`
  - `src/features/watchlist/components/RecordForm.tsx`
  - `src/features/settings/components/SettingsModal.tsx`
  - `src/shared/lib/__tests__/feedback.test.mjs`
  - `src/shared/lib/__tests__/initialization.test.mjs`

### Objective

加载失败不再伪装空列表，所有关键异步操作失败都有一致、可访问、可重试的用户反馈和日志。

### Implementation Requirements

- 明确 `loading/ready/error`，error 页面含说明和重试入口。
- 统一通知机制覆盖新增、编辑、删除、导入、恢复、同步、设置写入和批量补全；避免只 console。
- 保留现有乐观更新回滚；错误反馈不得泄漏凭据/SQL。
- 网络海报的非关键失败可以降级提示，不应阻塞本地保存。
- 补初始化失败/重试和写入失败 Playwright/Vitest。

### Verification

```powershell
npm ci
npx tsc -b --noEmit
npm run lint
npm run build
node --test src/shared/lib/__tests__/feedback.test.mjs src/shared/lib/__tests__/initialization.test.mjs
Set-Location src-tauri
cargo test --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
```

### Required Evidence

- Node 原生测试、前端/Rust 门禁日志。
- 真实 Tauri error/retry 和统一通知截图或交互记录。
- 脱敏应用日志。

### Execution Result

ACCEPTED — implementation `96e682a` plus failure-feedback follow-ups `fb3149c` and `739ee2e`. Loading/ready/error, retry, unified accessible notifications, category-only logging and non-blocking poster failure are implemented. Detached frontend gates, Node 9/9, Rust 21/21 and strict Clippy passed; browser error/retry and isolated real-Tauri success-notification checks passed with unchanged real-database tuples and zero residual processes.

### Codex Review

<!-- BEGIN OWNER:CODEX TASK-A-005 REVIEW -->
- Result: ACCEPTED. AC-A-005 PASS.
- Independent verification worktree: `D:\Project\Projects\WatchTracker-A005-Verify`, detached at `739ee2e`.
- Failure/retry never rendered the normal empty state; the isolated Tauri app reached ready state and showed `记录已添加。` after an isolated write.
- Full details: `.agent-work/evidence/review/TASK-A-005-CODEX-REVIEW.md`.
<!-- END OWNER:CODEX TASK-A-005 REVIEW -->

## TASK-A-006：验证并修复数据库升级、核心 CRUD 与离线流程

- Phase: A
- Owner: Codex
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-A-002, TASK-A-003, TASK-A-004, TASK-A-005
- Acceptance Criteria: AC-A-004, AC-A-006, AC-A-007
- Execution Policy: Simplified workflow v1（独立 Implementation/Verification Pass；业务代码必须有隔离复现证据）
- Expected Files:
  - `src/features/watchlist/hooks/useWatchList.ts`
  - `src/shared/lib/database.ts`
  - `src/shared/lib/importValidation.ts`
  - `src/shared/lib/webdav.ts`
  - `src/features/settings/components/SettingsModal.tsx`
  - `src/shared/lib/__tests__/*.test.mjs`
  - `src-tauri/src/commands.rs`
  - `src-tauri/src/db.rs`
  - `src-tauri/src/db_atomic_crud.rs`
  - `src-tauri/src/db_atomic_tests.rs`
  - `src-tauri/src/lib.rs`
  - `.agent-work/evidence/review/TASK-A-006-CODEX-REVIEW.md`
- Conditional Files:
  - `src/app/App.tsx` — only if a real Tauri integration failure proves the page boundary must change.
  - `src/shared/types/index.ts` — only if a reproduced import/schema compatibility defect requires a type correction.

### Objective

用临时 SQLite/真实 Tauri 流程完成首次、已有、升级库和核心 CRUD/设置/导入恢复同步安全闭环。

### Implementation Requirements

- 构造可审计的空库、当前库、代表性旧库和单条兼容脏数据夹具；不得使用真实活动数据库执行 migration 或故障注入。
- 在真实 Tauri IPC 上完成加载、新增、编辑、删除、重启持久化和组合筛选。
- 设置、导入、导出、备份、恢复和 WebDAV 失败不得破坏本地数据；验证 `originCountry` 往返。
- 无 TMDB/WebDAV 凭据和网络失败时本地 CRUD 正常。
- 只修复复现到的最小缺口，不实施 outbox、主动拉取、目标隔离等 DEFERRED 功能。

### Verification

```powershell
npm ci
npx tsc -b --noEmit
npm run lint
npm run build
node --test src/shared/lib/__tests__/*.test.mjs
Set-Location src-tauri
cargo test --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
```

另在预创建 executable-adjacent `data/` 的隔离目录中执行真实 Tauri 首次/当前/升级启动、CRUD、重启持久化、组合筛选和无凭据离线验证；失败后核对 SQLite checksum、行数与 schema/version。

### Required Evidence

- 四类数据库夹具说明、前后 checksum/行数/schema 摘要。
- CRUD 重启、离线和失败回滚操作日志及截图。
- 使用路径和恢复方法。

### Execution Result

ACCEPTED — implementation `20df1f5` makes local insert/delete/replace state atomic and preserves imported compatibility fields. A detached verification worktree passed typecheck, lint, frontend build, Node 14/14, Rust 29/29, strict Clippy and release build. Real isolated empty/current/v12/dirty databases passed startup, migration, CRUD, lock/filter, settings, export/import, deletion and restart checks without credentials. The three active user database content hashes remained unchanged. See `.agent-work/evidence/review/TASK-A-006-CODEX-REVIEW.md`.

## TASK-A-007：补齐稳定基线自动化回归矩阵

- Phase: A
- Owner: Codex
- Status: ACCEPTED
- Priority: P0 / High
- Dependencies: TASK-A-003, TASK-A-005, TASK-A-006
- Acceptance Criteria: AC-A-005~010, AC-A-013, AC-A-014
- Execution Policy: Simplified workflow v1（测试基础设施 Implementation Pass + 独立 Verification Pass；不得借测试任务修改业务行为）
- Expected Files:
  - `package.json`
  - `package-lock.json`
  - `playwright.config.ts`
  - `src-tauri/src/db_atomic_tests.rs`
  - `src-tauri/src/db.rs` 测试模块或专用测试模块
  - `src-tauri/src/auth.rs`（仅关闭既有 `cargo fmt` 空白债务，不得改变凭据逻辑）
  - `src-tauri/src/error.rs`（仅关闭既有 `cargo fmt` 空白债务，不得改变错误语义）
  - `src/shared/lib/__tests__/*.test.mjs`
  - `tests/fixtures/mockIpc.ts`
  - `tests/*.spec.ts`

### Objective

把 REQUEST 7.1 的稳定基线场景转为直接、可重复的自动化断言，同时保留真实桌面冒烟层。

### Implementation Requirements

- 明确覆盖 7.1 的十项：系统字段、空更新、非法值、Rust 时间、全量回滚、不存在记录 Tombstone、migration 回滚、setting 错误、初始化失败、统一路径。
- Node 原生测试继续作为 `npm test` 的单元测试入口；不为统一命令而引入 Vitest。
- Playwright mock 必须匹配当前 IPC DTO、返回值和错误语义；未知命令必须失败，不能因宽松 fallback 产生假通过。
- 初始化失败页面必须自动断言错误提示、重试入口、正常空状态不出现，以及重试后恢复。
- 不用 `skip/only`，不降低 lint/clippy。
- 生成目录保持隔离且不进入提交。

### Verification

```powershell
npm run typecheck
npm run lint
npm run test
npm run build
npx playwright test
Set-Location src-tauri
cargo fmt -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --locked
```

### Required Evidence

- 需求 7.1 到测试名称的映射表。
- 全部命令日志和测试数量摘要。

### Execution Result

ACCEPTED — implementation `8412d4f` establishes `npm test` and isolated Playwright gates, a strict current-DTO IPC mock, direct initialization error/retry UI assertions, and closes the inherited rustfmt-only debt in `auth.rs`/`error.rs`. Detached verification passed typecheck, lint, Node 14/14, build, Playwright 3/3, `cargo fmt`, strict Clippy, and Rust 29/29. REQUEST 7.1 all ten scenarios are mapped in `.agent-work/evidence/review/TASK-A-007-CODEX-REVIEW.md`.

## TASK-A-008：同步 README、原子 API 文档、CI 与产物治理

- Phase: A
- Owner: Codex
- Status: ACCEPTED
- Priority: P0 / High
- Dependencies: TASK-A-002, TASK-A-003, TASK-A-004, TASK-A-006, TASK-A-007
- Acceptance Criteria: AC-A-012, AC-A-016
- Execution Policy: Simplified workflow v1（文档/CI/产物治理 Implementation Pass + 独立 Verification Pass；禁止业务源码修改）
- Expected Files:
  - `README.md`
  - `docs/REFACTOR_ATOMIC_API.md`
  - `.github/workflows/*`
  - `.gitignore`
  - `WatchTracker-Portable.exe`（仅从 Git 跟踪和任务 worktree 移除；历史提交及外部发布副本可恢复）
  - `playwright-report/`（从 Git 跟踪中移除）
  - `dist-build/`（从 Git 跟踪中移除或明确非本地产物策略）
  - `.agent-work/evidence/review/TASK-A-008-CODEX-REVIEW.md`

### Objective

使用户/开发文档与真实实现一致，建立自动质量门禁，并清除仓库中的本地测试/构建产物跟踪。

### Implementation Requirements

- README 覆盖精确版本/前置、`npm ci`、Vite/Tauri dev、全部检查、build、数据目录、日志/海报/备份、离线/无凭据行为。
- 原子 API 文档覆盖当前 DTO/命令、generation、commitId、事务不变量、错误、stale、安全重试、恢复及无分布式事务限制。
- CI 使用锁文件，覆盖 Node-native frontend tests、Playwright 与 Rust 强制命令；Tauri Windows build 分 job，不能把未运行写成通过。
- 移除跟踪的 `playwright-report/`、`test-results/` 和本地构建产物并更新 ignore；不删除用户源文件/需求文档。
- 审计根目录历史一次性说明/脚本，保留有价值文档或在获得明确依据后处理，禁止擅自清理。

### Verification

```powershell
git ls-files playwright-report test-results dist-build src-tauri/target
git check-ignore -v playwright-report/index.html test-results/example.txt dist/example.js
npm run typecheck
npm run lint
npm run test
npm run build
npx playwright test
Set-Location src-tauri
cargo fmt -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --locked
```

### Required Evidence

- README 命令逐条复核记录。
- API 文档到代码命令/DTO 对照表。
- CI 配置检查和最终 tracked/ignored 产物清单。

### Execution Result

ACCEPTED — implementation `e44ff53` adds the current README, atomic local-data API guide and three-job CI, removes the tracked 15,181,312-byte root release binary, and adds precise report/build ignore rules. Detached verification passed YAML lint, typecheck, lint, Node 14/14, build, Playwright 3/3, rustfmt, strict Clippy and Rust 29/29. No listed local artifact remains tracked; unimplemented commitId/stale/distributed-transaction behavior is explicitly documented as a limitation. See `.agent-work/evidence/review/TASK-A-008-CODEX-REVIEW.md`.

## TASK-A-009：生成并冒烟 Windows 可交付产物

- Phase: A
- Owner: Codex
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-A-002, TASK-A-004, TASK-A-006, TASK-A-007, TASK-A-008
- Acceptance Criteria: AC-A-015
- Execution Policy: Simplified workflow v1（Windows 交付产物 Implementation Pass + 独立 Verification Pass；真实用户数据库前后 Hash/大小/mtime 必须一致）
- Expected Files:
  - `.agent-work/evidence/builds/*`
  - `.agent-work/evidence/logs/*`
  - `.agent-work/evidence/screenshots/*`
  - `.agent-work/evidence/review/TASK-A-009-CODEX-REVIEW.md`

### Objective

生成 Windows Tauri 构建产物并在独立临时数据目录完成最小桌面冒烟，区分代码与签名/安装器环境问题。

### Implementation Requirements

- 运行完整 `npm run tauri build`，不复制旧产物冒充本轮结果。
- 记录 exe/installer 路径、hash、大小和生成时间；产物保持 Git ignored。
- 启动产物，验证主界面、数据目录、日志、海报、CRUD、重启持久化和无凭据本地可用。
- 所有自动启动必须使用预创建 executable-adjacent `data/` 的任务专用产物副本；禁止启动会回退到真实 AppData 的原始 `target/release/app.exe`。
- 自动化验证前后记录三处真实用户数据库的 SHA-256、大小和 mtime；任一变化立即停止并判定失败。
- 如果失败，保存原始错误、环境探测和最小复现；不得因环境问题推断代码通过。

### Verification

```powershell
npm run tauri build
Get-ChildItem src-tauri/target/release -Recurse -File | Select-Object FullName,Length,LastWriteTime
```

### Required Evidence

- Tauri build 完整日志。
- 产物清单/hash、启动截图、应用日志、冒烟步骤记录。

### Execution Result

ACCEPTED — implementation `b44d6db` and clean detached Verification Pass both built EXE/MSI/NSIS successfully. The implementation Release EXE passed isolated real-window CRUD, movie-to-series classification, restart persistence, user-confirmed delete, delete-after-restart and no-credential local use; the independently rebuilt EXE also rendered from a second fresh portable data root. Seven actual-window JPEG screenshots, raw logs, artifact manifests and exact real-database comparisons are under `.agent-work/evidence/`; see `.agent-work/evidence/review/TASK-A-009-CODEX-REVIEW.md`. Artifacts are unsigned and the two builds are not byte-for-byte reproducible. TASK-A-010 was opened only after this acceptance and has since been independently accepted.

## TASK-A-010：执行阶段 A 全量门禁并提交验收材料

- Phase: A
- Owner: Codex
- Status: ACCEPTED
- Priority: P0 / Critical
- Dependencies: TASK-A-007, TASK-A-008, TASK-A-009
- Acceptance Criteria: AC-A-001~017, AC-GATE-001
- Execution Policy: Simplified workflow v1（最终门禁 Implementation Pass + 干净 detached Verification Pass；九项命令顺序执行并保留原始退出码）
- Expected Files:
  - `.agent-work/TASKS.md`
  - `.agent-work/EXECUTION_LOG.md`
  - `.agent-work/ACCEPTANCE_CRITERIA.md`
  - `.agent-work/ACCEPTANCE_REPORT_BASELINE.md`
  - `.agent-work/evidence/**/*`
  - `.agent-work/evidence/review/TASK-A-010-CODEX-REVIEW.md`

### Objective

在最终工作区执行全部强制门禁、整理可追溯证据并交给 Codex 独立验收；不得自行宣布 Gate A 通过。

### Implementation Requirements

- 所有命令从明确工作目录运行，记录退出码；失败不得覆盖或删除，修复后追加新日志。
- 重复真实桌面三类启动、CRUD 重启、离线和构建产物冒烟。
- 桌面与 Release 冒烟只能使用预创建 executable-adjacent `data/` 的 A-010 专用副本；真实用户数据库必须保存前后 SHA-256、大小和 UTC mtime 并完全一致。
- 更新任务为 IMPLEMENTED，绝不标 ACCEPTED；不填写 PASS baseline 报告。
- 最终 Git 状态列出所有改动与残余风险。

### Verification

```powershell
npm run build
npm run typecheck
npm run lint
npm run test
npx playwright test
npm run tauri build
Set-Location src-tauri
cargo fmt -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

### Required Evidence

- 九项命令日志、真实桌面/产物冒烟证据、最终 Git 状态。
- AC-A-001~016 证据索引和明确未解决风险。

### Execution Result

IMPLEMENTED — all nine commands completed sequentially with recorded exit code `0`: frontend build/typecheck/lint/Node 14/14/Playwright 3/3, Tauri build, rustfmt, strict Clippy, and Rust 29/29. The first Clippy orchestration attempt lost its controlling session before a trustworthy exit code was captured; its raw partial log is retained, and a separate second attempt completed naturally with exit `0`.

The A-010 Release executable was copied into three task-only portable roots. Empty/current/upgrade startup passed. The current fixture passed Create/Read, rename, movie-to-series reclassification, restart persistence, user-confirmed Delete and delete-after-restart. SQLite final checks show `db_version=18`, record counts `0/2/2`, and no legacy `category`/`sortOrder` columns. All three real user database SHA-256/length/UTC-mtime tuples match the pre-test snapshot, and the final related-process count is zero.

Evidence is under `.agent-work/evidence/{builds,logs,screenshots,tests}/TASK-A-010/`. This is an Implementation result only; AC-A-017, AC-GATE-001 and the baseline report remain pending independent detached verification.

### Codex Review

<!-- BEGIN OWNER:CODEX TASK-A-010 REVIEW -->
- Result: ACCEPTED. AC-A-017 and AC-GATE-001 PASS.
- Reviewed implementation: `64e9a533c98713026d1f60be562bc3e0fb55fccc`.
- Independent worktree: clean detached `D:\Project\Projects\WatchTracker-A010-Verify` at the reviewed implementation commit. Locked install and all nine required commands exited `0`; frontend tests passed 14/14, Playwright 3/3 and Rust 29/29.
- A separately rebuilt Release EXE launched from a new portable root, rendered the real empty WatchTracker main interface, wrote only its adjacent synthetic data root and exited without a residual process. The three real database hash/length/mtime tuples remained unchanged.
- Full review: `.agent-work/evidence/review/TASK-A-010-CODEX-REVIEW.md`; final baseline report: `.agent-work/ACCEPTANCE_REPORT_BASELINE.md`.
- Gate A now permits a separately authorized Phase B task to be opened; no Phase B task was automatically started.
<!-- END OWNER:CODEX TASK-A-010 REVIEW -->

---

## Phase B：地区动态化专项（Gate A 已 PASS；TASK-B-001/B-002 已验收）

## TASK-B-001：收口地区规范化与聚合领域规则

- Phase: B
- Owner: Codex
- Status: ACCEPTED
- Priority: P1 / High
- Dependencies: AC-GATE-001（PASS）
- Acceptance Criteria: AC-B-001, AC-B-002, AC-B-004
- Authorization Base: `main@d7b5f2cd7ceca95f26e000115d9d3bceac463cc8`
- Execution Policy: Codex simplified workflow; Implementation Pass may end at `IMPLEMENTED` only, followed by an independent Verification Pass.
- Expected Files:
  - `src/shared/lib/countryNames.ts`
  - `src/shared/lib/classification.ts`
  - `src/shared/lib/__tests__/classification.test.mjs`

### Objective

从保留的恢复现场选择性迁移地区纯函数原型，修正 UK/GB、占位值、未知地区、固定顺序和最终代码 tie-break，在当前稳定主线上形成唯一领域规则源。

### Implementation Requirements

- 先对照稳定主线的旧固定标签逻辑和保留现场 `codex/current-recovery-snapshot@10ee559` 中的 `normalizeCountryCodes/regionsOf/aggregateRegions` 原型；不得整体复制旧工作区，也不得新建第二套解析器。
- 旧原型只能选择性迁移：必须修正其 `UK` 处理顺序、错误的优先地区顺序、缺失的未知地区哨兵、缺失的最终代码 tie-break，以及与当前 Node 原生测试入口不兼容的问题。
- 以 `regionCodesOf` 作为唯一 ISO/未知领域入口；现有 `regionsOf` 在 B-002 接线前只允许作为调用 `regionCodesOf` 的旧中文按钮兼容包装，不得保留独立解析逻辑或让当前固定地区计数回归。
- 严格按 originCountry 优先、旧标签回退、未知兜底。
- 过滤 N/A、NA、NULL、UNKNOWN 等；`UK -> GB`；保留其他格式有效两位代码。
- 固定顺序 `CN,HK,TW,US,JP,KR,GB`；其余数量/名称/代码排序；未知最后。
- 多国和重复值按需求计数。
- B-001 只实现纯领域规则和单元测试，不接线动态 UI、TMDB 往返或 DEFERRED 功能。

### Verification

```powershell
node --test src/shared/lib/__tests__/classification.test.mjs
npm run test
npm run typecheck
npm run lint
```

### Required Evidence

- FR-01/02/04 到 Node 单元测试名称的映射和完整日志。
- 保留现场原型的选择性迁移/修正说明。

### Execution Result

ACCEPTED — Implementation `b70aa24` was reviewed from clean detached HEAD. Independent install/audit, region tests 12/12, complete Node tests 26/26, typecheck, lint, build, baseline Playwright 3/3 and additional boundary checks 3/3 all passed. AC-B-001 is PASS; the B-001 domain portions of AC-B-002 and AC-B-004 are verified, while their UI/combined-filter portions remain NOT RUN for later Phase B tasks. Review: `.agent-work/evidence/review/TASK-B-001-CODEX-REVIEW.md`. B-002 through B-005 remain blocked until separately authorized.

## TASK-B-002：完成动态地区选项、筛选状态与界面行为

- Phase: B
- Owner: Codex
- Status: ACCEPTED
- Priority: P1 / High
- Dependencies: Gate A PASS (`AC-GATE-001`), TASK-B-001 ACCEPTED
- BASE: `b6f30912e5c4f592d8abb7cd2c73a00bdeaa4e8d` (`origin/main` at authorization)
- Acceptance Criteria:
  - `AC-B-002`：仅承担剩余 UI 显示与筛选部分；B-001 已验收的领域显示规则不重复实现。
  - `AC-B-003`：承担任意 records 集合新增、编辑、删除或整体替换后，基于新 records/mediaType/status 重算动态选项、数量与失效选择的行为；真实本地导入、恢复和 WebDAV 同步的端到端验证不在本任务范围内。
  - `AC-B-004`：仅承担组合筛选 UI 部分；B-001 已验收的聚合与排序领域规则不重复实现。
- Execution Policy: Codex simplified workflow; Implementation Pass may end at `IMPLEMENTED` only, followed by an independent Verification Pass. This authorization does not include AC-B-007 or any later Phase B task.
- Expected Files:
  - `src/app/App.tsx`
  - `src/shared/lib/classification.ts`
  - `src/shared/lib/filtering.ts`
  - `src/shared/lib/__tests__/filtering.test.mjs`
  - `src/features/watchlist/components/StatsBar.tsx`
  - `tests/regions.spec.ts`
  - `tests/fixtures/mockIpc.ts`
  - `.agent-work/evidence/tests/TASK-B-002/*`
  - `.agent-work/TASKS.md` — 仅允许更新 TASK-B-002 的 Status、Execution Result 和 Implementation 记录。
  - `.agent-work/OWNERSHIP.md` — 仅允许更新 TASK-B-002 当前阶段状态。
  - `.agent-work/EXECUTION_LOG.md` — 仅允许追加 TASK-B-002 Implementation Pass 的事实摘要。
- Conditional Files:
  - `src/features/settings/components/SettingsModal.tsx` — 仅允许修改地区来源说明文字；不得修改设置行为、导入、恢复、同步或 TMDB 实现。
- Forbidden Changes:
  - 数据库、schema、migration 和 Rust 业务代码。
  - `package.json`、`package-lock.json`、Vitest、Testing Library 或任何新依赖/测试框架。
  - TMDB 搜索或映射、WebDAV、导入、恢复实现、用户数据清洗。
  - TASK-B-003~TASK-B-005 实现、DEFERRED 功能、无关格式化或组件重构。
  - 若实现需要任何其他业务文件，必须停止并请求 Codex 重新签发合同，不得自行扩权。

### Objective

在不创建第二套国家解析或排序实现的前提下，将 B-001 的 `CountryCode`/`RegionOption` 领域规则接入当前筛选 UI：地区选项只随 records/mediaType/status 动态变化，失效选择立即按 `all` 渲染并随后永久清理，同时保持布局与可访问性。

### Implementation Requirements

- 内部地区筛选状态必须使用 `CountryCode | 'all'`；显示使用 `RegionOption.label`，筛选和 React key 使用 `RegionOption.code`。
- options 只能由 records 经 mediaType/status 预筛选后调用 B-001 聚合规则生成；search、rating、lock、sort、activeRegion 均不得改变选项集合或数量。
- App 必须 memoize 地区 scope/options；StatsBar 接收已经生成的 `RegionOption[]`，不得对每个地区重复扫描全部 records。
- 不通过 include-0 或类似方式保留失效选项。当前地区消失时，当前渲染必须立即按 `all` 处理，实际 state 随后清理为 `all`；该地区以后重新出现时不得自动复活。
- 再次点击当前地区切换为 `all`；空 options 不渲染地区栏。
- 未知哨兵和未映射 ISO code 必须能够显示、选择和筛选；不得创建第二套国家解析、名称映射、聚合或排序实现。
- 多地区布局使用 wrap 或横向滚动，不遮挡其他控件；保留明确选中态和 `aria-pressed`。
- `SettingsModal.tsx` 如需修改，只能将说明文字改为 originCountry 主源、contentTags 仅旧数据回退。
- 任意 records 集合发生新增、编辑、删除或整体替换时，地区 UI 必须根据新的 records/mediaType/status 重新计算；可通过受控 records 替换直接验证该反应性。
- 真实本地导入、恢复和 WebDAV 同步的端到端验证留给 TASK-B-003 实现和 TASK-B-004 综合验证；TASK-B-002 不得修改导入、恢复或 WebDAV 代码。
- 沿用 Node 原生测试和现有 Playwright，不引入新测试框架或依赖。

### Verification

```powershell
node --test src/shared/lib/__tests__/filtering.test.mjs
npm run test
npm run typecheck
npm run lint
npm run build
npx playwright test
```

### Required Evidence

- Node 原生纯函数测试：mediaType/status scope；search/lock/sort/activeRegion 不影响计数；多国、未知、未映射代码；组合筛选；失效地区回退。
- Playwright：动态按钮与数量；CN/HK/TW；GB/UK；多国、未知、未映射代码；再次点击取消；状态变化后的失效选择清理；空数据无地区栏；大量地区布局；`aria-pressed`。
- 完整命令日志、测试名称到 AC-B-002/003/004 的映射，以及大量地区布局截图或 trace。

### Execution Result

ACCEPTED — Implementation `0f15a840b6246479e6890d8de551e69f5ca4d27c` was independently reviewed from clean detached `D:\Project\Projects\WatchTracker-B002-Verify`. Scope matched the final contract; fresh `npm ci` reported audit 0, targeted Node tests passed 6/6, the complete Node suite passed 32/32, typecheck/lint/build passed, and Playwright passed 8/8. The verification worktree remained clean and no related process remained. AC-B-002 is PASS; TASK-B-002 portions of AC-B-003/004 are verified while their deferred import/sync and final matrix portions remain open. Review: `.agent-work/evidence/review/TASK-B-002-CODEX-REVIEW.md`. This does not authorize TASK-B-003 or later work.

## TASK-B-003：保证 TMDB、表单及数据往返兼容

- Phase: B
- Owner: Codex
- Status: ACCEPTED
- Priority: P1 / High
- Dependencies: AC-GATE-001 PASS, TASK-B-001 ACCEPTED, TASK-B-002 ACCEPTED
- BASE: `6202f85d86a6e0b8611e6135cec479306a8768fc` (`codex/phase-b-integration` at authorization)
- Acceptance Criteria: AC-B-005, AC-B-006 only; neither criterion may be marked PASS by the Implementation Pass.
- Execution Policy: Codex simplified workflow. The Implementation Pass may update TASK-B-003 to `IMPLEMENTED` at most; only an independent Verification Pass from a clean HEAD/worktree may mark it `ACCEPTED` or update AC-B-005/006 results.
- Expected Files:
  - `src/shared/lib/classification.ts`
  - `src/features/settings/components/SettingsModal.tsx`
  - `src/features/watchlist/components/Header.tsx` — 仅允许给现有设置按钮增加 `aria-label="设置"` 与 `title="设置"`；不得修改按钮行为、布局、样式、图标、事件处理或其他 Header 控件。
  - `src/shared/lib/__tests__/classification.test.mjs`
  - `src/shared/lib/__tests__/importValidation.test.mjs`
  - `tests/b003-roundtrip.spec.ts`（唯一允许新增的测试文件）
  - `tests/fixtures/mockIpc.ts`
  - `.agent-work/evidence/tests/TASK-B-003/*`
  - `.agent-work/TASKS.md` — 仅允许更新 TASK-B-003 的 Status、Execution Result 和 Implementation 记录。
  - `.agent-work/OWNERSHIP.md` — 仅允许更新 TASK-B-003 当前阶段状态。
  - `.agent-work/EXECUTION_LOG.md` — 仅允许追加 TASK-B-003 Implementation Pass 的事实摘要。
- Conditional Files（Implementation Pass 无权自行激活或修改）:
  - `src/features/watchlist/components/RecordForm.tsx` — 条件诊断用于判断现有电影、剧集、季或编辑保存分支是否仍丢失/截断规范化 `originCountry` 或覆盖自定义标签。
  - `src/shared/lib/importValidation.ts` — 条件诊断用于判断 `normalizeImportedRecord(s)` 是否改写或丢失 `originCountry`/自定义标签。
  - `src/shared/lib/webdav.ts` — 条件诊断用于判断现有 parse/merge/GET/PUT payload 边界是否改写或丢失 `originCountry`/自定义标签。
  - `src/features/watchlist/hooks/useWatchList.ts` — 条件诊断用于判断 payload 正确时同步合并或冲突恢复的 hook 边界是否仍丢失上述字段。
  - 任一诊断失败若证明需要上述文件，必须保存测试名、完整失败输出和退出码，不得修改该文件，立即停止，保持 TASK-B-003 `READY`，并请求合同签发者另行提交修订，将明确路径提升为 Expected File。诊断失败既不是修改授权，也不得作为继续执行的理由。
- Forbidden Changes:
  - TASK-B-004、TASK-B-005、AC-B-007/008、Gate B 或最终报告的实现/验收；B-004/B-005 状态必须保持 `BLOCKED`。
  - 地区筛选 UI、`src/app/App.tsx`、`StatsBar.tsx`、`filtering.ts`、`countryNames.ts`，或重新实现/重构 B-001/B-002 已验收逻辑。
  - 数据库 schema、migration、真实数据清洗，以及任何 Rust 业务代码。若现有 IPC 无法满足 AC，只记录证据并停止，请求重新签发，不得自行扩权。
  - `package.json`、`package-lock.json`、依赖、测试框架、构建配置和生成产物。
  - TMDB 搜索接口/交互、凭据行为、WebDAV 协议扩展、同步算法重构、顺便重构/格式化/修复无关问题。
  - 接触、读取、启动、复制、哈希或清洗真实用户数据库；使用真实 TMDB/WebDAV 凭据或外部 WebDAV 服务。
  - 使用或移植 `codex/phase-b-complete`、`dc8308f`、`0f44b76` 的提交或未提交修改；不得 cherry-pick、merge、复制整文件或将其作为 BASE。
  - push、创建 PR、合并到 `main`。
- Change Budget:
  - 当前 Implementation Pass 的业务修改预算最多为 3 个 Expected Files；其中 `Header.tsx` 最多只能产生现有设置按钮的 `aria-label="设置"` 与 `title="设置"` 两项可访问名称变更。Conditional Files 的修改预算为 0；只有后续合同修订提交明确提升后，才能重新计算预算并继续。
  - 测试/夹具仅限上列 4 个路径，其中只允许新增 `tests/b003-roundtrip.spec.ts`；非治理、非证据 diff 总变更不超过 500 行（增删合计）。
  - 不允许新增生产模块、重命名/移动文件、批量格式化或扩大公共 API；超预算必须停止并提交合同变更请求。

### Objective

基于 BASE 的真实结构完成小范围兼容性闭环：电影 `production_countries` 与剧集 `origin_country` 经 B-001 规范化规则完整写入 `originCountry`；表单新增/更新和设置页批量元数据更新保留用户自定义标签，只清理可由现有国家标签/别名映射明确识别的旧系统地区标签；本地 JSON 导入/导出、WebDAV payload 合并/下载及冲突恢复不丢字段；旧标签记录、UK/GB、CN/HK/TW、多国与未映射有效代码保持兼容。BASE 不存在 `tmdbMapper.ts`、`SettingsToolsTab.tsx` 或 `useWatchListStore.ts`，不得按旧合同虚构这些入口。

### Implementation Requirements

- `classifyTmdb` 必须复用 `normalizeCountryCodes`，对电影/剧集来源数组执行 trim、大小写、UK→GB、去重和有效代码过滤，并完整保存规范化代码；不得创建第二套国家解析器。
- `mergeContentTags` 只清理 `countryCodeOfLabel` 能明确识别的旧系统地区标签及既有系统分类标签，保留其他用户自定义标签；TMDB 未映射有效代码只进入 `originCountry`，不得伪造中文标签。
- RecordForm 的新增、更新、电影、剧集和季路径，以及 SettingsModal 的批量元数据更新，必须使用同一分类/标签合并规则，不得以 TMDB 结果整体覆盖用户自定义标签。
- 本地 JSON 导出后再导入、WebDAV schema v2 与旧数组 payload 的 GET/merge/PUT、云端导入和冲突记录恢复均须保持 `originCountry` 与自定义标签。mock 证据只能证明 mock 边界，不得表述为真实桌面、真实网络或真实 WebDAV 服务已验证。
- B-003 只覆盖 AC-B-005/006 的定向兼容性证据；地区完整 E2E 矩阵、布局/筛选回归和最终综合验收留给 B-004/B-005。

### Execution Stages and Verification

#### A. Preflight

从 `D:\Project\Projects\WatchTracker-B003` 依次执行并保存输出/退出码：

```powershell
git status --short --branch
$workspaceChanges = git status --porcelain=v1 --untracked-files=all
$workspaceChanges
if ($workspaceChanges) { exit 1 }
git rev-parse HEAD
git merge-base --is-ancestor 6202f85d86a6e0b8611e6135cec479306a8768fc HEAD
git diff --quiet
git diff --cached --quiet
$taskResidual = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (($_.ExecutablePath -like 'D:\Project\Projects\WatchTracker-B003\*') -or ($_.CommandLine -match '(vite|playwright).*(4177|WatchTracker-B003)')) } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine
$taskResidual; if ($taskResidual) { exit 1 }
$port4177 = Get-NetTCPConnection -LocalPort 4177 -State Listen -ErrorAction SilentlyContinue
$port4177; if ($port4177) { exit 1 }
npm ci
```

- HEAD 必须是最新 TASK-B-003 合同提交且上述 BASE 必须是其祖先；`$workspaceChanges` 必须为空，否则机械返回非零并立即停止。若发现工作区/暂存区/untracked 内容、与本任务相关的残留进程/4177 监听、Git 条件不符或 `npm ci` 非零，不得进入实现。
- `npm ci` 整个 Implementation Pass 只执行一次；成功日志同时作为 Final verification 的锁文件安装证据，最终阶段不得重复安装。

#### B. Expected implementation

- 先新增/更新 Expected Files 中明确列出的测试/夹具，再仅修改三个 Expected business files：`src/shared/lib/classification.ts`、`src/features/settings/components/SettingsModal.tsx` 与受上述两属性限制的 `src/features/watchlist/components/Header.tsx`。本阶段不得修改任何 Conditional File。
- Expected Files 实现完成后，只运行以下针对 Expected Files 的最小测试；任一失败立即停止并按普通 Expected implementation 失败处理，不得借此激活 Conditional Files：

```powershell
node --test --test-name-pattern="B003 expected:" src/shared/lib/__tests__/classification.test.mjs
npx playwright test tests/b003-roundtrip.spec.ts --grep "@expected-settings-modal"
```

##### Authorized recovery from the recorded Expected Playwright failure

- 已记录失败：`.agent-work/evidence/tests/TASK-B-003/03-expected-settings-modal.stdout.txt`，exit `1`。页面正常加载，但 `getByRole('button', { name: '设置' })` 在进入 SettingsModal 之前超时；快照中的设置按钮为无名称 button。该失败不是 SettingsModal 业务逻辑失败，不是 Conditional File 激活依据，只归因于现有 Header 设置按钮缺少可访问名称。
- 本修订提交允许原 Implementation Pass 从该失败点恢复，是 Preflight 干净工作区门禁的单次、定向延续例外；当前已授权但未提交的 B-003 实现、测试和证据必须原样保留，不得 clean、stash、reset、覆盖或纳入本合同提交。不得重复 `npm ci`。
- 恢复前只读确认本任务相关残留进程为 `0` 且端口 `4177` 监听为 `0`；任一不为 `0` 立即停止。随后只能对现有 Header 设置按钮增加 `aria-label="设置"` 与 `title="设置"`，再执行：

```powershell
npx playwright test tests/b003-roundtrip.spec.ts --grep "@expected-settings-modal"
```

- 重跑通过后才可进入 C. Conditional diagnostics；重跑失败则保存完整输出和退出码并立即停止。首次 exit `1` 不得跳过、删除、覆盖或改写，最终报告必须同时列出首次失败与修正后重跑结果。

#### C. Conditional diagnostics

- 只有 B 阶段三个 Expected business files 已按合同完成且最小测试全部通过后，才能依次运行以下最小诊断，用于回答“在 `classification.ts` 和 `SettingsModal.tsx` 已修正后，RecordForm/importValidation/webdav/useWatchList 是否仍然丢字段？”：

```powershell
node --test --test-name-pattern="B003 conditional: import normalization" src/shared/lib/__tests__/importValidation.test.mjs
npx playwright test tests/b003-roundtrip.spec.ts --grep "@conditional-record-form"
npx playwright test tests/b003-roundtrip.spec.ts --grep "@conditional-webdav-payload"
npx playwright test tests/b003-roundtrip.spec.ts --grep "@conditional-watchlist-boundary"
```

- 每项仅判断对应 Conditional File 是否必要。任一非零或断言证明需要条件文件时，保存测试名、完整失败输出和退出码，立即停止；不得修改条件文件、不得继续其他诊断/实现/最终验证，TASK-B-003 保持 `READY`，请求合同签发者以新修订提交把该路径提升为 Expected File。
- 若失败原因不能唯一归属于某个 Conditional File，同样停止并报告，不得自行推断权限。只有全部条件诊断为零且没有条件文件需求，才可进入 Final verification。

#### D. Final verification

Install prerequisite:

- 引用本次 Preflight 唯一一次 `npm ci` 成功日志；Final verification 不重复运行 `npm ci`。

实现与全部条件诊断完成后，Final verification 的实际命令必须从以下第一项开始重新按固定顺序执行：

```powershell
node --test src/shared/lib/__tests__/classification.test.mjs
node --test src/shared/lib/__tests__/importValidation.test.mjs
npm run test
npm run typecheck
npm run lint
npm run build
npx playwright test tests/b003-roundtrip.spec.ts
npx playwright test
npm run tauri build
git diff --check
```

- 任一实际执行命令非零立即停止，不得执行后续命令。Final verification 失败不得激活 Conditional Files；如失败指向条件文件，只保存完整日志并请求新合同修订。
- `git diff --check` 成功后，重复 Preflight 中的 `$taskResidual` 与 `$port4177` 查询作为最终两项只读清理门禁；任一有结果即按非零失败处理。查询必须排除当前 PowerShell PID，禁止误杀或广泛终止用户进程。

### Runtime, Database and Credential Boundary

- B-003 固定只运行 Node 测试、Playwright 浏览器 mock、前端构建与 `npm run tauri build`。不得启动 Tauri、`app.exe` 或任何桌面产物；Tauri build 只能证明构建成功。
- 不得创建、打开、枚举、复制、哈希或访问任何 SQLite 数据库或真实用户数据目录；不得连接真实或本地 WebDAV 服务，不得读取真实凭据。真实桌面、真实数据目录隔离和最终冒烟全部留给 TASK-B-005。
- Preflight 和最终收尾只查询与本工作树或端口 `4177` 相关的进程/监听。记录本任务启动的 Node/Vite/Playwright/Cargo 子进程 PID；命令结束后确认这些 PID 已退出且端口 `4177` 无监听。禁止启动 app，禁止按进程名广泛终止用户进程。

### Required Evidence

- 测试名到 AC-B-005/006 具体步骤的映射；电影/剧集/季、新增/更新、UK→GB、CN/HK/TW、多国、重复、非法值、未映射有效代码的输入与精确输出。
- 自定义标签与可识别旧系统地区标签的 before/after 表，证明只清理明确地区标签且非地区标签不被覆盖或误删。
- 本地 JSON export→import、WebDAV schema v2 与旧数组 payload、同步 merge/PUT/GET、冲突恢复的脱敏字段级 before/after；全部属于 Playwright mock IPC/payload 边界证据，不得表述为真实 WebDAV 或真实桌面证据。
- 证据等级必须明确：Node 只证明纯函数/导入规范化；Playwright mock 只证明浏览器 UI 与 mock IPC/payload 边界；Tauri build 只证明构建成功。任何一项均不得宣称真实桌面、真实数据库或真实 WebDAV 已验证。
- Preflight、Expected implementation 最小测试、Conditional diagnostics 和 Final verification 的完整日志/退出码、Git diff/name-status、变更预算核对、条件诊断结论、任务 PID/4177 端口最终清理结果，以及未启动 app、未创建/访问数据库、未读取凭据或连接 WebDAV 的边界声明。

### Stop-on-failure Rules

- Preflight、Expected implementation 最小测试、Conditional diagnostics 或 Final verification 任一命令/断言失败，立即停止对应阶段及全部后续工作，保留完整输出与退出码；不得用后续成功覆盖失败，不得写 AC PASS。
- 条件诊断或最终验证指向 Conditional File 时，TASK-B-003 必须保持 `READY`，不得修改该文件或标记 `IMPLEMENTED`，只请求合同签发者提交明确提升路径的新合同修订。
- 需要未列出文件、超过变更预算、需要 Rust/schema/migration/依赖修改，或发现现有 IPC 无法实现 AC 时，只记录最小复现与阻塞并停止，请求重新签发合同。
- 发现工作树含任务外修改、任何数据库/用户数据/真实凭据可能被访问、任何 WebDAV 服务可能被连接、app 可能被启动或任务进程无法确认退出时，立即停止；不得 reset、clean、stash 或覆盖现场。

### Execution Result

ACCEPTED — Implementation `72fa529` plus the conflict-restoration regression `c7a332e` were independently reviewed from clean detached `D:\Project\Projects\WatchTracker-B003-Verify`. Fresh `npm ci` reported audit 0; classification passed 15/15, import 4/4, the complete Node suite 36/36, targeted B-003 Playwright 8/8 and full Playwright 16/16. Typecheck, lint, frontend build, Windows Tauri EXE/MSI/NSIS build and `git diff --check` passed. No related process, port 4177 listener or worktree change remained. AC-B-005 and AC-B-006 PASS within their documented mock/build evidence boundaries. Review: `.agent-work/evidence/review/TASK-B-003-CODEX-REVIEW.md`. TASK-B-004/B-005 remain blocked until separately authorized.

## TASK-B-004：建立地区专项单元、组件与 E2E 矩阵

- Phase: B
- Owner: Codex
- Status: ACCEPTED
- Priority: P1 / High
- Dependencies: AC-GATE-001 PASS, TASK-B-001 ACCEPTED, TASK-B-002 ACCEPTED, TASK-B-003 ACCEPTED
- BASE: `db6f1ad` (`codex/phase-b-integration` after independent B-003 acceptance)
- Acceptance Criteria: AC-B-001~007
- Execution Policy: Codex simplified workflow. The Implementation Pass may mark this task `IMPLEMENTED` only; acceptance requires a clean detached Verification Pass. Existing accepted B-001/B-003 tests are the starting point and must not be duplicated without a demonstrated coverage gap.
- Expected Files:
  - `src/shared/lib/__tests__/classification.test.mjs`
  - `src/shared/lib/__tests__/filtering.test.mjs`
  - `src/shared/lib/__tests__/importValidation.test.mjs`
  - `tests/regions.spec.ts`
  - `tests/b003-roundtrip.spec.ts`
  - `tests/fixtures/mockIpc.ts`
  - `.agent-work/TASKS.md`（仅本任务状态与 Execution Result）
  - `.agent-work/OWNERSHIP.md`（仅当前分配）
  - `.agent-work/EXECUTION_LOG.md`（仅追加实施摘要）
  - `.agent-work/evidence/tests/TASK-B-004/*`
- Forbidden Changes:
  - 任何生产源码、Rust、数据库、依赖、构建配置或 B-005/最终报告。
  - 新建与 `tests/regions.spec.ts` 重复的 `tests/region.spec.ts`。
  - merge、cherry-pick、复制或使用 `codex/phase-b-complete`、`dc8308f`、`0f44b76`、`c7d4e0e` 及其 worktree 内容。
  - 真实数据库、真实凭据、真实 WebDAV/TMDB 服务或桌面应用；这些边界保留给 B-005。

### Objective

自动覆盖 REQUEST 7.2/7.3 全部地区场景并证明现有筛选无回归。

### Implementation Requirements

- 先建立 REQUEST 7.2/7.3 到现有测试名称的矩阵；只有发现明确缺口时才新增最小测试。
- 单元矩阵必须覆盖常见代码、多国、重复、UK、旧中文标签、未知、未映射两位代码、source priority、聚合/稳定排序和自定义标签保护。
- E2E 矩阵必须覆盖实际选项集合、CN/HK/TW、GB/UK、多国、未知、media/status/search/lock 组合、失效选择、空数据、换行/可访问性、增改删、整体替换、导入、同步和冲突恢复。
- 明确证明 search、lock、排序和 active region 不改变基础地区计数；评分字段不属于当前 UI 筛选器，不得虚构评分筛选。
- mock IPC 与真实 DTO 一致；不以 mock 替代最终桌面冒烟。

### Verification

```powershell
npm run test
npx playwright test
npm run typecheck
npm run lint
npm run build
```

### Required Evidence

- REQUEST 7.2/7.3 到测试名称映射，以及已发现缺口和新增断言说明。
- Node/Playwright 完整结果摘要；失败时保留 trace，成功时复用现有大量地区布局截图，不重复提交相同截图。

### Execution Result

ACCEPTED — Test-only implementation `c07b985` was independently reviewed from clean detached `D:\Project\Projects\WatchTracker-B004-Verify`. The first verification attempt stopped after Node 36/36 because `npm ci` had been orchestrated in the wrong worktree and local `@playwright/test` was absent; after installing in the actual verification worktree, the complete sequence restarted and passed Node 36/36, Playwright 16/16, typecheck, lint, build and diff check. Postflight found zero related processes, zero port-4177 listeners and a clean worktree. The diff contains no production, fixture, dependency or quarantined-line content. AC-B-003, AC-B-004 and AC-B-007 PASS. Review: `.agent-work/evidence/review/TASK-B-004-CODEX-REVIEW.md`. B-005 remains blocked until separately authorized.

## TASK-B-005：执行地区全量回归并提交验收材料

- Phase: B
- Owner: Codex
- Status: ACCEPTED
- Priority: P1 / Critical
- Dependencies: AC-GATE-001 PASS, TASK-B-001~TASK-B-004 ACCEPTED
- BASE: `62cdd53` (`codex/phase-b-integration` after independent B-004 acceptance)
- Acceptance Criteria: AC-B-008
- Execution Policy: Codex Implementation Pass may collect evidence and mark this task `IMPLEMENTED` only. A separate clean Verification Pass must review the committed evidence, rerun mandatory checks, complete the region report and decide Gate B.
- Expected Files:
  - `.agent-work/TASKS.md`
  - `.agent-work/OWNERSHIP.md`
  - `.agent-work/EXECUTION_LOG.md`
  - `.agent-work/evidence/tests/TASK-B-005/*`
  - `.agent-work/evidence/builds/TASK-B-005/*`
  - `.agent-work/evidence/screenshots/TASK-B-005/*`
- Forbidden Changes:
  - 任何产品源码、测试、依赖、配置、README、地区报告 PASS 结论、Gate B 或最终综合报告。
  - 使用或迁移 `codex/phase-b-complete` 隔离线的任何内容。
  - 读取、复制、哈希、迁移或启动真实用户数据库和凭据；所有桌面验证必须使用新建隔离便携目录。
  - push、PR 或合并 `main`。

### Objective

执行地区专项和全项目回归，整理证据交给 Codex 独立验收；不得自行填写 PASS 报告。AC-FINAL-001 在 B-005 验收、最终 PR 检查和 AC-GATE-B 完成后由 Codex 单独处理。

### Implementation Requirements

- 执行全部前端强制命令和相关 Rust/真实桌面回归。
- 从本任务新构建的 release EXE 复制到独立目录，预创建相邻空 `data/` 后启动；只进行无凭据、无外部网络的启动、添加地区记录、地区选项/筛选和退出冒烟。
- 核对大量地区布局、选中态、动态消失、设置页入口和无现有筛选回归；自动化已覆盖的细节不重复手工穷举。
- 最终任务只标 IMPLEMENTED，等待 Codex 生成地区及综合报告。

### Verification

```powershell
npm run build
npm run typecheck
npm run lint
npm run test
npx playwright test
npm run tauri build
Set-Location src-tauri
cargo fmt -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --locked
```

### Required Evidence

- 全部命令、退出码和测试数量摘要；构建产物路径、大小与 SHA-256。
- 隔离便携目录的绝对路径、启动前后进程清理、空库启动和地区记录/筛选的真实窗口截图。
- 明确声明未访问真实数据库、凭据、TMDB 或 WebDAV；桌面冒烟不扩大为真实外部服务验证。

### Required Evidence

- 全量命令日志、地区场景截图/trace、最终 Git 状态和 AC-B 证据索引。

### Execution Result

ACCEPTED — Implementation `0ee2cae` was reviewed from clean detached `D:\Project\Projects\WatchTracker-B005-Verify`. A fresh `npm ci` reported audit 0; frontend build/typecheck/lint passed; Node passed 36/36; Playwright passed 16/16; Rust fmt/clippy/test passed with 29/29 tests; Windows Tauri EXE/MSI/NSIS build and `git diff --check` passed. A second newly built EXE was copied to a different fresh portable directory and independently repeated empty startup, creation of a `法国` record, immediate `法国 1` option/filter behavior and clean exit. Related process and port-4177 counts were zero; both implementation and verifier data stayed inside their new adjacent `data/` directories. AC-B-008 and `.agent-work/ACCEPTANCE_REPORT_REGION.md` are PASS. Review: `.agent-work/evidence/review/TASK-B-005-CODEX-REVIEW.md`. This acceptance does not mark Gate B or the comprehensive report PASS; the unique final PR and remote CI remain pending.

---

## 路线图任务（按当前 `main` 重新归类）

> 审计基线：2026-08-02，`main@b23f27a` 及后续当前工作区。旧的 `TASK-D-R0`~`TASK-D-R3` 四个优先级大包已废止，改为“领域 + 独立编号”。`IMPLEMENTED` 表示已实现并通过本地验收；`PARTIALLY_IMPLEMENTED` 表示已交付部分边界但任务仍有剩余；`SPECIFIED` 表示业务规则已足以进入技术设计；`NEEDS-DESIGN` 表示只有路线图方向，尚不能直接实施。

| 任务 | 优先级 | 分类 | 状态 | 原路线图归属 |
| --- | --- | --- | --- | --- |
| `TASK-D-DATA-001` | R0 | 数据安全 | IMPLEMENTED | R0 元数据补全 |
| `TASK-D-DATA-002` | R0 | 数据完整性 | IMPLEMENTED | R1 数据库加固，提升为 R0并纳入 V18/V19 兼容 |
| `TASK-D-DATA-003` | R0 | 数据正确性 | IMPLEMENTED | 国家解析与平台字段保护 |
| `TASK-D-DATA-004` | R0 | 数据恢复 | IMPLEMENTED | R3 自动备份，提升为 R0 |
| `TASK-D-SYNC-001` | R0 | 同步一致性 | IMPLEMENTED | R0 冲突与版本记录 |
| `TASK-D-SYNC-002` | R0 | 同步可靠性 | IMPLEMENTED | 持久 outbox、主动拉取与退避已实现 |
| `TASK-D-SYNC-001-R2` | R0 | 同步恢复与增量落盘 | IMPLEMENTED | 版本暂存、发布意图与伪冲突修复 |
| `TASK-D-SYNC-003` | R0 | 同步隔离 | IMPLEMENTED | R0 WebDAV 目标隔离、安全切换与 V18 迁移已实现 |
| `TASK-D-SEC-001` | R0 | 凭据安全 | IMPLEMENTED | Windows Credential Manager、逐项迁移和 IPC 收紧已完成 |
| `TASK-D-HISTORY-001` | R1 | 观看历史 | IMPLEMENTED | 逐集完成时间、V18 功能迁移与同步 V4 已实现 |
| `TASK-D-DISCOVERY-001` | R1 | 内容发现 | IMPLEMENTED | R1 今晚看什么；可解释会话队列已实现 |
| `TASK-D-IMPORT-001` | R1 | 数据交换 | NEEDS-DESIGN | 用户于 2026-08-05 明确暂缓；不进入当前排期 |
| `TASK-D-NET-001` | R1 | 网络安全 | IMPLEMENTED | 端点独立限额、原子海报缓存、安全清理、跨平台协议 URL 与界面维护已实现 |
| `TASK-D-UX-004` | R1 | 可访问性 | IMPLEMENTED | 三个主弹窗已统一语义、焦点管理、Escape、焦点恢复和滚动锁定 |
| `TASK-D-UX-001` | R2 | 检索体验 | IMPLEMENTED | 统一高级查询与本机保存视图已实现并通过完整回归 |
| `TASK-D-UX-001-R1` | R2 | 检索体验 | IMPLEMENTED | 保存视图下拉化，高级面板、计数和摘要去重完成 |
| `TASK-D-UX-001-R2` | R2 | 检索体验 | IMPLEMENTED | 八区主工具栏、单一同步入口、更多操作和响应式地区收敛已实现 |
| `TASK-D-UX-002` | R2 | 追剧体验 | NEEDS-DESIGN | USER-PAUSED；当前个人管理定位与基础条件不足，不进入当前排期 |
| `TASK-D-UX-003` | R2 | 内容组织 | IMPLEMENTED | 扁平多对多收藏集、手工排序、TMDB 建议、本地 V3 与 WebDAV V5 已实现 |
| `TASK-D-UX-003-R1` | R2 | 系列补全 | IMPLEMENTED | 本地系列识别、持久 TMDB 身份、缓存、完整季原子补充、年代排序、影视宇宙和表单归组已实现 |
| `TASK-D-UX-003-R2` | R1 | 收藏集补全 | IMPLEMENTED | 收藏集发现、候选资格、缺失季/电影、旧 IMDb 复用与真实便携数据验收已完成 |
| `TASK-D-UX-003-R3` | R1 | 建议准确性 | IMPLEMENTED | TMDB 单季资格、任意收藏集覆盖去重、持久忽略与恢复入口已实现 |
| `TASK-D-ARCH-001` | R2 | 工程架构 | NEEDS-DESIGN | R2 跨语言类型生成 |
| `TASK-D-ARCH-002` | R2 | 工程架构 | NEEDS-DESIGN | R2 模块拆分 |
| `TASK-D-LINK-001` | R3 | 外部集成 | NEEDS-DESIGN | R3 外部链接 |
| `TASK-D-RELEASE-001` | R3 | 发布与数据防护 | NEEDS-DESIGN | 正式发布的数据库隔离、审计、签名与分阶段放量 |
| `TASK-D-HISTORY-002` | R3 | 多观看会话 | NEEDS-DESIGN | 重看与多轮观看历史；固定为路线图最后一项 |

### TASK-D-DATA-001：“一键补全缺失元数据”安全重构

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R0
- Business Source: `.agent-work/REQUEST.md` 9.3
- Scope: TMDB 全支持字段补缺、缺失 TMDB 身份条件补全、批量预览、电影/剧集/具体季识别、多候选人工选择、无数据字段持久记忆、逐条结果、取消/重试和同步一致性。
- Implementation: `batchMetadata.ts` 负责类型/季身份、TMDB 匹配、字段级补丁、写入前二次缺失检查，以及按记录 ID、IMDb ID 和字段保存的无数据状态；Settings 对多个候选要求用户选择，提供预览确认、安全停止、逐条结果和失败重试。普通字段继续调用 `useWatchList.updateRecord`；电影和明确分季记录的缺失 TMDB 身份由 Rust `complete_missing_tmdb_identity` 校验 revision、IMDb、锁定、已有身份和全库重复后只填空值。无数据状态使用 V18 `settings.batch_metadata_no_data_v1`，IMDb 变化时失效。
- Acceptance: Node 纯函数覆盖全支持字段、无覆盖、电影/剧集/季、远端空值、类型错配、多候选和无数据状态失效；Playwright mock 覆盖预览零写入、候选选择前零详情/零写入、无数据字段不重复请求、多季不同集数、部分失败重试、取消零写入、多国家/自定义标签及自动同步调度。
- Safety: 自动化仅使用 Tauri IPC mock；实现和验证未读取或写入真实便携版数据库。

### TASK-D-DATA-002：V18/V19 兼容与领域约束加固

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R0
- Scope: 高版本数据库显式拒绝或兼容迁移、V18/V19 策略、明确 UPSERT、导入/全量替换/部分更新统一校验。
- Implemented Compatibility: V18 是唯一运行格式；V19 打开前使用 SQLite backup API 创建并校验快照，然后在单一事务中恢复 21 个 camelCase 列名及 V18 版本标记；失败整体回滚并阻止读写。V20+ 在任何 schema 写入前明确拒绝。界面显示版本专用错误或一次性成功提示。
- Acceptance Evidence: Rust 临时文件库覆盖 V19 成功、故障触发器回滚/备份保留及 V20 源文件逐字节不变；Playwright mock 覆盖 V20 不读取 records/settings 和 V19 成功提示只显示一次。
- Implemented Domain Boundary: records 与 settings 已移除 `INSERT OR REPLACE`；records 使用 `ON CONFLICT(id) DO UPDATE`，不会隐式删除再插入。本地新增严格校验名称、媒体类型与数值范围，时间/修订字段由 Rust 生成；部分更新只验证本次变更并允许修复旧脏行；导入/同步替换兼容规范化旧媒体类型、空文本和旧数值，重复 ID 在删除前整批拒绝，锁定本地记录继续优先保留。
- Final Acceptance: Rust 临时库验证 UPSERT 不触发 DELETE、系统字段所有权、非法新增零副作用、旧脏行无关字段可修改、名称/媒体类型约束、导入兼容规范化、重复 ID 回滚、锁定保留，以及此前 V19/V20 版本矩阵；前端使用 Rust 返回的持久化新增记录，避免时间/修订状态漂移。

### TASK-D-DATA-003：国家解析统一与平台字段保护

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R0
- Business Source: `.agent-work/REQUEST.md` 9.4
- Problem: `App.handleSave` 和 `RecordForm` 三条 TMDB 路径使用 `includes('CN')/includes('中国')`；前者会在普通保存时清空已有平台，后者重复了脆弱判断。“中国香港”“中国台湾”旧值也会因包含“中国”而被误判为中国大陆。
- Scope: 统一精确国家解析；集中平台推测与名称规范化；普通保存不再改写平台；电影、剧集、具体季和批量补全只在本地平台缺失时写入推测值，CN 只抑制推测值，不清空已有值。
- Implementation Plan:
  1. 在 `classification.ts` 或相邻共享模块增加基于 `normalizeCountryCodes` 的具名国家谓词，以及纯函数形式的平台推测规范化入口。
  2. 删除 `App.handleSave` 中按国家强制设置 `data.platform = ''` 的逻辑，确保新增、编辑和无关字段更新保留用户值。
  3. 将 `RecordForm` 的电影、剧集、具体季三处分支和 `batchMetadata.ts` 接入同一共享函数；移除所有国家子串判断和重复的平台别名分支。
  4. 保持 `regionCodesForTopFilter(...).slice(0, 1)` 不变；“顶部只看第一个国家”与“是否包含 CN 时抑制自动平台推测”分别测试，不混用语义。
  5. 增补 Node 纯函数测试和 Playwright 用户路径测试，再执行完整前后端回归、生产构建和便携版安全部署。
- Compatibility: 无 schema/migration；读取兼容 ISO、旧中文名称、别名、小写、空白及中英文逗号；不批量改写国家或平台，不恢复无可靠来源的历史丢失值。
- Acceptance:
  - `CN` 精确命中；`HK`、`TW`、`ACN`、`CND` 不命中；`cn`、`中国大陆` 和合法多国值按规范化结果工作。
  - 保存含 CN 的已有记录时，手工平台及无关字段修改后的平台保持不变；HK/TW 不再被中国大陆规则误伤。
  - TMDB 返回 CN 时不自动填入推测平台，但不会覆盖已有平台；非 CN 仅在平台缺失时填入并沿用 CBS/Apple TV+ 规范化。
  - 源码中不再存在业务层 `originCountry.includes('CN')` 或 `includes('中国')`；批量补全继续满足“只填缺失字段”。
  - typecheck、lint、Node、Playwright、Rust、生产构建全部通过；便携版由干净提交构建，部署前后数据库哈希、V18 版本和记录数一致。
- Safety: 自动化只使用 mock/临时数据；真实便携数据库只做部署前后只读校验，不运行清洗、迁移或测试。
- Implementation: `classification.ts` 新增精确国家谓词与平台推测纯函数；`App.handleSave` 不再改写平台；RecordForm 的电影、剧集、具体季和 `batchMetadata.ts` 已统一接入该函数。顶部筛选仍只读取第一个国家，平台推测则按完整国家列表判断是否包含 CN。
- Acceptance Evidence: Node 56/56 覆盖 CN/HK/TW、旧中文名称、非法子串、平台别名、批量 CN 抑制及 TMDB 缺失/零/异常单集时长；Playwright 29/29 覆盖普通保存保留用户平台、CN 表单补全不推测平台、HK/TW 正常填入 Apple TV+，以及电影不混写单集时长、剧集缺失时长保持空值；typecheck、lint、生产构建、Rust fmt/clippy 和 36/36 Rust tests 全部通过。源码扫描确认业务层不再存在 `originCountry.includes('CN')` 或 `includes('中国')`。
- Follow-up Fix: 便携版日志定位到 RecordForm 在 TMDB 不提供剧集时长时发送 `episodeRuntime: 0`，与 DATA-002 的正数领域约束冲突。电影、剧集和具体季现复用 `positiveEpisodeRuntimeOf`：电影不写单集时长，剧集仅在远端提供正数时更新，否则保留原值/null；IPC mock 会拒绝零值，Rust 命令日志会记录安全的字段级拒绝原因。

### TASK-D-DATA-004：高风险操作自动恢复点

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R0
- Scope: 在导入、同步全量落盘、migration 和批量写入前创建可验证恢复点，并提供轮转、容量、恢复预览与失败回退。
- Implementation: Rust 使用 SQLite backup API 在统一 `backups/` 目录生成完整数据库恢复点，经临时文件、`integrity_check`、数据库版本、记录数和 SHA-256 校验后原子落盘，同时保存本地清单。全量导入、WebDAV 全量落盘、V19 migration、实际将写入至少 2 条的批量元数据补全，以及恢复操作本身均先创建恢复点；创建失败会阻止对应高风险写入。
- Lifecycle: 自动恢复点保留最近 10 个并受 500MB 软容量约束；用户标记“保留”的恢复点不计入 10 个上限且绝不自动删除，但仍计入容量提示。启动时只清理本功能遗留的临时文件。设置页可刷新、查看原因/版本/条数/大小/校验状态、保留、删除、打开目录，并在确认当前与目标条数后恢复。
- Restore Safety: 仅允许恢复当前 V18 且 SHA/完整性校验通过的恢复点；恢复前创建 `pre-restore` 点，通过 SQLite backup 写回活动连接并再次校验。写回或校验失败时从 `pre-restore` 回退。V19 migration 点只用于迁移故障的文件级回退，不允许由 V18 界面直接恢复。
- Acceptance Evidence: Rust 临时数据库覆盖完整状态恢复、损坏拒绝且当前库不变、10 个自动点加保留点轮转、保留/删除、快照失败阻断写入和临时文件清理；Playwright mock 覆盖批量补全先快照、导入/同步原因接线及导入后恢复与 `pre-restore` 创建。全部自动化不读取或写入真实便携版数据库。

### TASK-D-SYNC-001：同步冲突、版本域与条件提交

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R0
- Scope: 在现有 schema v2 时间戳合并之上设计版本域、条件提交、过期重拉和可解释冲突；评估 ETag、Lamport、`expectedGeneration` 与原子 SyncCommit 的最小组合。
- Current Basis: 已有 Tombstone、锁定保留、冲突历史和本地 generation；这些不等于远端 compare-and-swap。
- Approved Design: `docs/SYNC_CONSISTENCY_DESIGN.md` 已由用户批准。使用独立 `records-v3.json`、ETag 条件写入/首次 `If-None-Match: *`、最多 3 次 412 重拉、完整本地三方基线、字段级合并、持久未解决冲突，以及 Rust `get_sync_snapshot`/`commit_sync_result(expectedGeneration)` 原子边界；数据库保持 V18。坚果云兼容修复将强 ETag 映射到 HTTP `If-Match`、弱 ETag 映射到 WebDAV `If`。
- Confirmed Decisions: 不同字段自动合并，同字段和删除/编辑冲突由用户选择；无合法条件 ETag 时禁止上传；其他同步设备必须升级到 v3，旧 v2 文件只首次迁移或显式导入。
- Implementation: `syncMerge.ts` 提供不依赖墙上时钟的三方字段合并、删除语义和冲突冻结；`webdav.ts` 使用独立 v3 资源、ETag 条件 PUT、最多三次 412 重拉、commitId 验证、v2 首次迁移及旧客户端变化阻断。GET 返回规范强 ETag 时使用 HTTP `If-Match`；弱、缺失或未加引号的验证器先经受限 `PROPFIND Depth: 0` 获取 `DAV:getetag`，再使用 RFC 4918 WebDAV `If`。连续三次 412 时比较脱敏验证器指纹：指纹变化才是 `remote_busy`，同一指纹持续被拒绝则停止自动重试并报告 `conditional_validator_rejected`。Rust 提供稳定设备 UUID、结构化 WebDAV 响应、条件头白名单、脱敏条件指纹日志、同步快照、`expectedGeneration` CAS、恢复点和单事务 SyncCommit/冲突解决。设置页显示具体冲突字段并提供本机/云端或保留/删除选择。
- Acceptance Evidence: Node 纯函数覆盖不同时钟、不同字段、同字段、删除/编辑、锁定、未知 schema、畸形 tombstone、冲突冻结和系统字段差异；Rust 临时库覆盖条件头、稳定设备 ID、原子提交、过期 generation 零副作用、注入失败整体回滚、恢复点保留及冲突选择；Playwright mock 覆盖 v2→v3、首次条件创建、强/弱 ETag、412 重试/上限、PUT 无 ETag 的 commitId 验证、本地并发修改 CAS、无合法 ETag 阻断、未来 schema 拒绝、旧客户端变化检测/显式导入和冲突 UI。真实 WebDAV 与正式数据库均未用于测试。
- Boundary: 未实现持久化 outbox、启动/聚焦/周期主动拉取或 WebDAV 目标隔离；分别由 `TASK-D-SYNC-002/003` 跟踪。

### TASK-D-SYNC-002：持久化 outbox 与主动拉取

- Phase: DEFERRED
- Owner: Unassigned
- Status: IMPLEMENTED
- Priority: R0
- Scope: 持久化 dirty/outbox、崩溃恢复补跑、暂停/恢复语义，以及启动、窗口聚焦、网络恢复和可配置周期拉取。
- Current Basis: 当前仅有写入后内存 debounce 和单进程 in-flight 串行化；退出会丢失定时意图，没有无本地修改时的主动发现。
- Dependency: 与 `TASK-D-SYNC-001` 共用幂等提交、重试和冲突语义，但可分阶段交付。
- Approved Design: `docs/SYNC_RELIABILITY_DESIGN.md` 使用单槽 generation 高水位 outbox；所有本地记录事务原子入队，只有成功的 `commit_sync_result(expectedGeneration)` 才能原子确认。暂停状态和退避持久化，暂停不删除任务且允许手动同步；编辑 debounce 与默认 15 分钟的主动拉取周期分离。
- Trigger Model: 启动、窗口重新聚焦、页面重新可见、网络恢复和周期到期进入同一串行协调器；运行中触发只请求基于最新 SQLite 状态再跑一次，不复用旧 snapshot，也不阻塞应用退出。
- Failure Model: 网络/5xx/remote busy 持久退避，`stale_local_snapshot` 快速重读，认证和安全门禁停止自动重试；outbox 无过期时间，通知按错误码去重。
- Boundary: 保持 V18；不实施 WebDAV target ID、账号/URL 切换迁移、凭据保护或后台常驻服务，这些仍由 `TASK-D-SYNC-003`、`TASK-D-SEC-001` 及后续任务跟踪。
- Implementation: `sync_outbox_v1` 以 generation 高水位合并本地写入，`sync_scheduler_v1` 持久保存暂停、失败、next attempt 和最近远端检查；Rust 本地写事务原子入队，SyncCommit 按 `expectedGeneration` 原子确认。前端单一协调器接入编辑 debounce、启动、focus/visibility、online、独立周期和手动触发，并实现串行化、退避和通知去重。纯 clean pull 不创建恢复点或递增 generation。
- Acceptance Evidence: Rust 临时库覆盖 outbox 与记录/代数同事务、注入失败回滚、连续更新合并、过期 CAS 保留、成功/非确认提交、暂停/失败持久化、畸形 outbox 阻断、恢复点还原重新入队及 clean pull 无写放大；Node 覆盖拉取周期、失败分类、退避/抖动、聚焦冷却和时钟回拨；Playwright mock 覆盖 pending 跨重载、暂停恢复、focus 拉取远端-only 修改、503 持久退避和 401 阻断。真实 WebDAV 与正式数据库未用于测试。

### TASK-D-SYNC-001-R2：版本暂存、发布恢复与按 ID 增量落盘

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R0
- Problem: 远端 PUT 已成功但本地 SyncCommit 失败时，旧实现没有可恢复的发布凭据；下一轮可能在无 baseline 情况下把本机和刚上传的云端数据当作整条记录冲突。记录数组顺序变化还会触发 1,000 余条全量重写。
- Approved Design: `docs/SYNC_STAGING_DESIGN.md`。所有本地记录事务同时维护按记录 ID 合并的 `sync_staging_v1`；PUT 前先持久化 `sync_publish_intent_v1`（commitId、前序 commitId、generation、包含的暂存项和 payload SHA-256）；每轮同步固定为 Pull → Merge → 必要时 Push → 本地 Commit。
- Implementation: SQLite 继续保持 V18，两份新状态以版本化 JSON 保存于 `settings`。启动或任何同步触发都先 GET 云端；远端 commitId 与 payload 指纹匹配发布意图时，先确认此前上传，再由同一 SyncCommit 清理对应暂存项。SyncCommit 按记录 ID 计算 upsert/delete，不再因数组排序差异全量替换。
- Legacy Repair: 仅当远端 writerId、本机 deviceId、记录 revActor/rev 递增关系和当前远端候选逐项吻合时，自动移除历史遗留的 `base = null` 整条记录伪冲突；任何证据不足仍保留给用户选择。
- Status/UI: 顶部和设置页区分未发布暂存、发布确认恢复、冲突与普通 outbox，不把“远端已写、本地待确认”显示成同步完成。
- Acceptance Evidence: Rust 临时库验证 CRUD 与暂存同事务、连续编辑按 ID 合并、匹配或被新远端版本取代的发布意图清理，以及 records 数组换序零业务写入；Playwright mock 验证发布意图先于 PUT、匹配 commit 与 payload 指纹后恢复且不重复 PUT、同设备历史伪冲突安全转回上传、未加引号 ETag 的 `PROPFIND + WebDAV If`、固定验证器拒绝与真实变化分流。完整门禁为 Node 68/68、Playwright 50/50、Rust 59/59、typecheck、lint、build、fmt 和 clippy 全部通过；未连接真实 WebDAV，未写真实便携版数据库。

### TASK-D-SYNC-003：WebDAV 目标隔离与安全切换

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R0
- Scope: 为 URL/账号组合建立稳定 target ID，隔离凭据、未来 baseline/ETag/outbox 状态，并设计切换确认、首次拉取和旧全局 setting 迁移。
- Current Basis: 当前 URL、凭据、代理和同步频率保存在全局 setting，尚没有 per-target 同步状态。
- Draft Design: `docs/SYNC_TARGET_ISOLATION_DESIGN.md`。推荐使用规范化 URL＋保留大小写的用户名生成 SHA-256 target ID；密码轮换不改变 target。凭据、baseline、ETag、冲突、outbox、scheduler、staging 与 publish intent 按 target 使用独立 settings 行，records、Tombstone、generation 和 device ID 保持全局。
- Safety Boundary: snapshot、prepare intent、commit 和调度写入增加 target ID＋epoch CAS；切换前只读探测，确认后才激活。旧 target 的 pending/冲突/发布意图冻结保留，切回时按该 baseline 重建离线期间差异。新已有远端无共同 baseline 时，同 ID 差异必须进入冲突，禁止默认覆盖。
- Migration: 首次升级先创建恢复点，再在单一 SQLite 事务中迁移全部旧全局同步键；验证成功后才删除旧键。解密或迁移失败保持旧状态并以 `target_migration_required` 阻断上传。数据库继续保持 V18。
- Confirmed Decisions: 用户已确认多个 target 代表同一本地影视库的不同同步端点；第一版只允许断开并保留 target，不提供永久删除 target 状态。任务可按专项设计进入实施。
- Implementation: URL＋用户名经 Rust 规范化后生成 SHA-256 target ID；凭据、baseline、ETag、冲突、last commit、v2 fingerprint、outbox、scheduler、staging 与 publish intent 已迁入 `sync_target::<id>::…`。快照、发布意图、提交、失败调度、暂停和冲突选择使用 target ID＋epoch CAS；切换前执行零写入只读探测，确认后激活并立即 Pull → Merge → Push。切回目标会按其 baseline 重建差异，断开只冻结并保留状态。
- Migration/Evidence: 旧全局键在 `target-migration` 恢复点后以单一 V18 事务迁移；旧凭据无法解密时本地库仍可读取，上传保持阻断并允许用户重输凭据完成迁移。门禁通过 Rust 62/62、Node 68/68、Playwright 52/52、typecheck、lint、生产 build 与 rustfmt；测试只使用临时 SQLite 和 mock WebDAV，未连接真实远端。

### TASK-D-SEC-001：Windows 凭据保护与旧格式迁移

- Phase: IMPLEMENTATION
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R0
- Scope: 使用 Windows 原生受保护存储保存 WebDAV/TMDB 凭据，迁移 `portable:v1` 和 `machine_bound:v1`，并提供机器变化后的可诊断恢复流程。
- Current Basis: 当前 AES-GCM 密钥由 machine UID 与固定 salt 派生；`portable:v1` 仍可直接 Base64 还原。
- Security Gate: 不在日志、导出、同步载荷或错误通知中暴露凭据；迁移成功后才删除旧值。
- Approved Design: `docs/SECURE_CREDENTIAL_STORAGE_DESIGN.md`。使用当前 Windows 用户的 Credential Manager `CRED_TYPE_GENERIC`＋`CRED_PERSIST_LOCAL_MACHINE`；数据库仅保存 `wincred:v1`，TargetName 由固定逻辑 ID 派生。WebDAV/TMDB 已保存秘密不再返回 React，Rust 网络命令内部读取。
- Migration Boundary: 以不含秘密的逐项写前日志协调 Credential Manager 与 SQLite；先 CredWrite＋CredRead 回读验证，再以 V18 事务替换旧值。失败只阻断对应 secret 功能，本地记录与其他 target 可用。迁移不创建会复制弱格式秘密的普通全库恢复点。
- Implementation: 新增带版本信封与逻辑 ID 校验的 Win32 SecretStore，缓冲使用 zeroize；旧 `portable:v1` / `machine_bound:v1` 在首次使用时以不含秘密的写前日志逐项迁移，只有 CredWrite＋CredRead 回读成功后才把 V18 setting 切为 `wincred:v1`。迁移失败只阻断对应服务，本地记录仍可使用。
- IPC/UI: 删除通用 `encrypt` / `decrypt` 命令；已保存 WebDAV 密码与 TMDB Key 不再进入 React 或日常请求 DTO。设置页显示 Windows 保护、换机重输和历史备份风险，第一版不自动删除恢复点或外部副本。
- Acceptance Evidence: fake store 与临时 SQLite 验证逻辑项隔离、信封不可交换、失败保留旧值、迁移日志不含秘密及引用缺失不回退；日常同步 E2E 验证 IPC 不含用户名/密码。完整门禁为 Rust 66/66、Node 68/68、Playwright 53/53、typecheck、lint、build、rustfmt 和 clippy 全部通过；未写真实用户 Credential Manager，未修改真实便携数据库。

### TASK-D-HISTORY-001：逐集完成时间与完结状态

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R1
- Business Source: `.agent-work/REQUEST.md` 9.5
- Scope: 下一集语义、单集完成三态、跳集空时间、最后一集完结、幂等历史、旧进度兼容、migration、导入导出与同步边界。
- Required Design: `records.nextEpisode` 与独立 `episode_completions`；下一集更新和完成事件同事务；旧 `progress` 不自动推断；回退不删除历史。
- First-Version Boundary: 下一集选择、三态、跳集、完结和旧数据显式启用；不含观看时长、批量补历史、跨季聚合和历史编辑。
- Approved Design: `docs/EPISODE_HISTORY_DESIGN.md`。使用 `episodeTrackingEnabled + nextEpisode` 消除未启用/已完结的 NULL 歧义，并新增 `episode_completions`。数据库主版本保持 V18，使用独立功能 marker 幂等迁移；旧 `progress` 原样保留。
- Atomic/Sync Boundary: 启用、推进、跳集、完结和后退均使用目的限定 Rust transaction，同步更新完成事件、record revision、generation、staging 和 outbox。WebDAV payload 升级到 V4；V3 可读，首次 V4 PUT 需确认，旧客户端遇到 V4 安全停止。
- Implementation: 新增 V18 幂等功能迁移和迁移前恢复点；Rust 目的限定命令原子处理启用、推进、跳集、完结、后退、stale revision、总集数冲突及删除级联。卡片提供下一集选择与只读三态历史；已看条目不再开放普通启用/回退入口，只有已记录条目发现新增集数时可“继续追更”，并保留历史与原完结日期。本地 V2 信封完整导入导出 records 与完成事件，旧数组导入保留匹配历史。
- Sync/Compatibility: V3 继续可读并视为空历史；存在逐集状态时经用户确认安全升级 V4。完成事件使用确定性 ID 和三方合并，空时间可被已知时间补全，不同非空时间由用户选择本机或云端；V5+ 和旧客户端不兼容场景保持零 PUT。
- Acceptance Evidence: Rust 72/72、Node 70/70、Playwright 58/58、typecheck、lint、build、rustfmt 与 Clippy 全部通过。新增覆盖已看未启用记录的双层阻断、完结只读展示及新增集续追并保留历史/原完结日期。测试仅使用临时 SQLite 与 mock WebDAV，未读写真实便携数据库或真实 WebDAV。

### TASK-D-DISCOVERY-001：“今晚看什么”队列

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R1
- Scope: 基于未看状态、兴趣、评分、时长、平台和题材生成可解释候选，支持组合筛选、本轮排除、无重复刷新和只读查看；第一版队列仅存在于当前观看概览会话。
- Current Basis: 数据字段和待看价值算法已存在，但没有产品化队列规则与验收标准。
- Approved Design: `docs/DISCOVERY_QUEUE_DESIGN.md`。用户确认锁定条目参与、在看不混入、剧集按单集时长、第一版不跨重启持久化，并提供时长/类型/平台/仅已完结筛选、本轮不重复、本轮跳过和只读查看。
- Scoring Boundary: 新增独立的 100 分可解释 discovery 分数，兴趣等级为最大权重，IMDb、完结、喜爱题材和常看平台为辅助项；不得修改主列表现有 `calculateWatchValue` 排序。
- Data Boundary: 第一版全部使用 React 会话内状态，不新增 V18 schema/setting，不调用业务写 IPC，不提升 generation 或 outbox，也不改变 WebDAV V4。
- Acceptance: 已看/在看实时排除、锁定可推荐、单次时长与估算标记、组合筛选、稳定排序、理由分项、本轮跳过/不重复/重置和零写入均需由 Node 与 Playwright 覆盖。
- Implementation: 新增独立 discovery 纯函数，提供资格分层、电影整部/剧集单集时长、默认估算来源、完结语义、动态选项、四类组合筛选、兴趣主导的 100 分分项、最多三条理由和确定性平局排序。Dashboard 使用会话内 seen/skipped 状态实现换一个、本轮跳过、重新浏览、关闭重置、准确空状态和只读摘要；锁定只展示标记，不影响候选。
- Display Compatibility: 列表卡片、海报墙与观看概览统一通过纯展示函数隐藏中国大陆分集内容末尾冗余的“第一季 / 第 1 季 / Season 1”；第二季、官方上/下部、非大陆内容及数据库原始标题保持不变，季身份、补全、同步和导出不受影响。
- Watching Progress Display: 观看概览按媒体语义展示进度；电影读取 `movieProgress/movieDuration`，显示已观看时间、总时长和百分比，剧集优先显示逐集记录的下一集并回退到旧 `progress`。该修订只读、不推断也不回写进度。
- Acceptance Evidence: Node 85/85、Playwright 63/63、Rust 72/72、typecheck、lint、生产 build、rustfmt 与 Clippy 全部通过。专项浏览器验收确认所有推荐交互零业务写 IPC，并验证首季展示和电影进度展示均不重写存储值；测试未读取或写入正式便携数据库或真实 WebDAV。

### TASK-D-IMPORT-001：Trakt 专项导入导出

- Phase: DEFERRED
- Owner: Unassigned
- Status: NEEDS-DESIGN
- Priority: R1
- Scheduling: USER-PAUSED（2026-08-05）。当前没有实际使用需求，不进行专项设计或实施；只有用户以后明确恢复时才重新进入排期。
- Scope: Trakt schema 映射、电影/剧集/季身份匹配、重复与冲突策略、预览、部分失败报告和往返测试。
- Current Basis: 已有通用 JSON 导入导出与清洗；不能把通用导入直接视为 Trakt 兼容。

### TASK-D-NET-001：网络响应与海报缓存安全

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R1
- Scope: 响应体/海报大小限制、MIME 校验、临时文件原子重命名、并发限制、缓存容量与孤立文件清理。
- Current Basis: 海报路径已限制在单文件名和统一目录，但下载仍把完整响应直接写入最终文件。
- Approved Design: `docs/NETWORK_POSTER_CACHE_SECURITY_DESIGN.md`。TMDB JSON、海报和 WebDAV 响应分开设限；海报采用路径白名单、流式硬上限、MIME＋签名校验、同目录临时文件原子发布、4 路并发和无索引缓存清理。用户已确认自动清理绝不删除仍被条目引用的海报、失败时使用占位图和手动重试、搜索缩略图也统一经过 Rust 并移除 WebView 对 TMDB 图片的直连权限。任务可进入实施。
- Implementation: Rust 为 TMDB JSON、海报、WebDAV GET/PROPFIND 与 PUT 分别执行 4/10/64/1/64 MiB 上限及独立超时。海报只接受严格 TMDB 文件路径和 JPEG/PNG/WebP 实际签名，使用同目录唯一 `.part`、写入刷新和最终重命名；全局最多 4 路、同文件串行并在锁后复检。`poster://` 同样拒绝超限或无效缓存。
- Cache/UI Boundary: 启动和下载后执行 500 MiB 软上限、400 MiB 回收目标，只按旧到新删除未引用缓存；当前 records 引用的 `w342` 与 `w92` 派生文件及未完成临时下载不自动删除，超过 24 小时的残留 `.part` 才回收。设置页提供统计、未引用清理和二次确认全部清空。海报墙失败后显示占位/手动重试，搜索 `w92_` 与正式 `w342` 缓存隔离；WebView CSP 已移除 TMDB 图片直连。提交 `6aeb8c4` 改由 Tauri `convertFileSrc` 生成 Windows/Android 与 macOS/Linux 各自正确的自定义协议 URL，修复 Windows 全部海报无法显示的回归。
- Acceptance Evidence: 初始专项通过 Rust 75/75、Node 85/85、Playwright 64/64、typecheck、lint、生产 build、rustfmt 与严格 Clippy。协议修订随后通过 Node 93/93、Rust 75/75、typecheck、lint、生产前端 build、无 bundle Tauri Release build、rustfmt 与严格 Clippy；Playwright 海报专项两项均执行且无断言失败，但当前 Windows runner 在 Vite 子进程退出阶段超时。修订后的便携 EXE 已由提交 `6aeb8c4` 构建并替换，正式 `data` 目录和数据库未修改。全部自动测试使用临时目录和 mock IPC，未访问真实 TMDB/WebDAV。

### TASK-D-UX-004：完整弹窗可访问性

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R1
- Scheduling: 2026-08-09 已完成设计、实施与验收。
- Scope: 为 RecordForm、Settings、Dashboard 统一补齐 dialog 语义、标题关联、焦点陷阱、初始焦点、Escape 和焦点恢复。
- Current Basis: 三个弹窗已有 Escape 关闭，但未形成完整可访问弹窗契约。
- Approved Design: `docs/ACCESSIBLE_DIALOG_DESIGN.md`。使用共享 Hook 和顶层弹窗栈，统一初始焦点、Tab/Shift+Tab 循环、Escape、焦点恢复及引用计数滚动锁定；不修改视觉布局、业务数据或同步协议。
- Implementation: 新增 `useAccessibleDialog`，并接入 RecordForm、SettingsModal 与 Dashboard；三个弹窗均具备 `role="dialog"`、`aria-modal`、可见标题关联和明确初始焦点。Settings 批量任务期间 Escape 仍只请求安全停止。
- Acceptance Evidence: Node 93/93、Playwright 68/68、Rust 75/75、typecheck、lint、生产 build、rustfmt 与严格 Clippy 全部通过。浏览器回归覆盖 dialog 名称、初始焦点、双向焦点循环、Escape 关闭、触发器焦点恢复和页面滚动锁定。

### TASK-D-UX-001：高级筛选与保存视图

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R2
- Scheduling: 2026-08-09 已完成设计、实施与验收。
- Scope: 多条件筛选表达式、命名视图、持久化、失效字段迁移和与现有顶部筛选的组合语义。
- Current Basis: 已有搜索、媒体类型、状态、地区和锁定筛选。
- Approved Design: `docs/ADVANCED_FILTER_SAVED_VIEWS_DESIGN.md`。使用同字段 OR、跨字段 AND 的统一查询模型，保留顶部快捷单选，新增结构化高级筛选面板；保存视图包含搜索、查询、排序和显示模式，写入本机 settings，不修改 V18、不进入 WebDAV。
- Confirmed Decisions: 第一版不加入日期、时长、缺失字段和 NOT；视图仅本机；默认启动“全部记录”，允许明确指定一个启动视图；不自动恢复临时筛选。
- Implementation: 已实现统一 `WatchlistQueryV1`、结构化高级面板、顶部快捷筛选、活动条件摘要、准确空状态和本机保存视图。视图支持另存为、显式更新、dirty 状态、删除后保留临时条件、20 个上限及明确启动视图；无效动态条件保持可见且不放宽查询。
- Data Boundary: 仅复用现有 settings 键 `watchlist_saved_views_v1` 与 `watchlist_startup_view_id_v1`；不升级 V18、不修改 records、不同步 WebDAV、不产生 outbox。V20 或 V19 转换失败时兼容检查优先，零 setting 读取。
- Acceptance Evidence: Node 100/100、Playwright 72/72、Rust 75/75、typecheck、lint、生产 build、rustfmt 与严格 Clippy 全部通过；新增回归覆盖组合查询、第一国家、未知地区、范围、保存/更新/启动、写入失败、未来 schema、安全边界、焦点与 360 px 无横向溢出。

### TASK-D-UX-001-R1：高级筛选界面去重修订

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R2
- Scheduling: COMPLETED（2026-08-09）。下一项为 `TASK-D-UX-003`。
- Scope: 删除永久保存视图栏，将保存视图收进顶部下拉框；高级面板只保留平台、题材、内容标签、上映年份、个人评分和 IMDb 评分，顶部快捷筛选继续作为媒体类型、状态、地区和锁定的唯一编辑入口。
- Approved Plan: `docs/ADVANCED_FILTER_UI_REFINEMENT_PLAN.md`。高级计数与摘要只覆盖六类低频条件；保存视图继续捕获完整查询、搜索、排序和显示模式；不改变 `WatchlistQueryV1` 或持久化格式。
- Data Boundary: 纯 UI/派生状态修订，不升级 V18、不修改 records/settings schema、不进入 WebDAV/outbox。
- Implementation: 已删除永久保存视图栏并新增顶部 Portal 弹出面板；高级面板、计数、摘要和选择性清除只处理六类低频条件。无结果重置只清查询并保留排序和显示模式。
- Acceptance Evidence: Node 101/101、Playwright 72/72、Rust 75/75、typecheck、lint、生产 build、rustfmt 与严格 Clippy 全部通过；回归覆盖界面去重、保存视图、360 px、零匹配地区可见性与 records/outbox 数据边界。

### TASK-D-UX-001-R2：顶部工具栏与快捷筛选收敛

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R2
- Scheduling: COMPLETED（2026-08-09）；下一项为 `TASK-D-UX-003`。
- Visual Basis: 用户确认沿用此前效果方案的顶部结构；效果图只作为工具栏与筛选层级参考，不包含卡片、海报或元数据展示改版。
- Scope: 第一行固定为品牌、保存视图、搜索、高级筛选、排序、单一同步入口、设置和“更多”；锁定筛选移至第二行末尾；添加记录、列表/海报切换和数据看板进入“更多”。媒体类型、状态、地区仍为第二行快捷筛选，高级条件摘要仅在存在条件时出现。
- Sync Contract: 合并原有同步入口，但不合并或改写同步业务逻辑。同步按钮按正常、暂停/待处理、失败/冲突和同步中显示状态；打开面板不得触发网络请求，只有显式操作才可同步、暂停/恢复或打开设置。
- Region Contract: 桌面默认优先展示 7 个地区，活动地区即使当前为零匹配也必须提升为可见；其余收进“更多地区”，“未知地区”始终可访问。屏幕变窄时减少直接展示数量，不压缩文字；第一国家匹配语义保持不变。
- Responsive/Accessibility: 1200 px 桌面宽度主工具栏保持单行；760 px 以下允许工具栏内部横向滚动但页面本身不得横向溢出；弹出层使用 Portal，并具备可访问名称、展开状态、Escape、外部点击和焦点返回。
- Data Boundary: 纯 UI 与派生状态改造；不升级 V18，不修改 records、settings schema、`WatchlistQueryV1`、保存视图格式、WebDAV/outbox 或同步状态机。
- Approved Plan & Checklist: `docs/TOP_TOOLBAR_REFINEMENT_PLAN.md`。
- Implementation: Header 已收敛为品牌、保存视图、搜索、高级筛选、排序、状态化同步、设置和更多八区；“更多”承载添加、显示模式和数据看板，并提供安全的 `Ctrl+N`。同步面板展示待发布、冲突和最近成功，打开面板零网络/零业务写入，显式“打开同步设置”直接进入云端同步页。锁定筛选移至第二行，地区按 7/4/2/1 响应式直接展示，活动地区优先提升，其余经 Portal 菜单访问。
- Data Boundary Evidence: 未修改 Rust、V18、records/settings schema、`WatchlistQueryV1`、保存视图格式或同步状态机；专项 mock 验证只打开同步、更多和地区菜单不产生 WebDAV 请求或业务写 IPC。
- Acceptance Evidence: Node 105/105、Rust 75/75、typecheck、lint、生产 build、rustfmt 与严格 Clippy 全部通过；Playwright 完整 75/75 均执行且无断言失败。当前 Windows runner 在全部用例完成后仍因 Vite 子进程未退出触发外层超时，未发现测试服务器或业务断言失败。Git 提交码与便携 EXE 哈希由源码完成后的独立交付报告记录。

### TASK-D-UX-002：订阅与播出提醒

- Phase: DEFERRED
- Owner: Unassigned
- Status: NEEDS-DESIGN
- Priority: R2
- Scheduling: USER-PAUSED（2026-08-09）。当前定位为个人影视管理工具，尚不具备可靠逐集日程源、后台刷新、系统通知、时区/延期处理和程序未运行时调度条件；现阶段不进行设计或实施，只有用户以后明确恢复时才重新进入排期。
- Scope: 下集播出、剧集完结和即将上映提醒的数据刷新、通知权限、去重、时区与离线行为。
- Current Basis: 已有 TMDB 元数据入口，但没有播出日程持久化或系统通知流程。
- Future Entry Point: 若以后恢复，优先验证“打开软件时只读展示近期可能更新条目”的轻量方案和数据质量；在证明可靠后，才评估 Windows 通知与后台提醒。

### TASK-D-UX-003：系列 / 收藏集

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R2
- Scope: 多对多收藏集模型、手工排序、自动/手工归组、导入导出和同步冲突语义。
- Current Basis: 当前媒体分类和文本标签不能表达稳定的多维集合关系。
- Approved Design: `docs/COLLECTIONS_DESIGN.md`。用户于 2026-08-09 确认概念图及五项推荐决策：第一版采用扁平多对多收藏集、用户确认后的 TMDB 稳定标识建议、“更多”菜单内收藏集中心、删除集合永不删除记录，以及 WebDAV V5 跨设备同步。
- Implementation: 保持数据库主版本 V18，以 `collections_schema_version=1` 增加集合、成员和两类 tombstone；Rust 目的限定命令在同一事务中维护 revision、generation、staging V2 与 outbox。收藏集中心支持创建、编辑、删除、片库批量加入、移除和确定顺序；RecordForm 可调整归属，列表及海报墙显示精简标记。TMDB 只生成基于 IMDb→TMDB 稳定标识的只读建议，显式确认后写入。
- Data Exchange: 完整本地备份升级为 V3；V2/旧数组导入保留仍有效的收藏集关系。WebDAV payload 升级为 V5，继续复用 `records-v3.json`、ETag 条件提交、target 隔离、publish intent 与 CAS；V3/V4 读取为空集合，首次 V5 发布必须确认，V6+ 明确拒绝。
- Safety: 删除收藏集不删除 records；删除 record 同事务生成成员 tombstone；恢复点校验同时执行 `integrity_check` 与 `foreign_key_check`。360 px 详情采用上下布局且页面无横向溢出。
- Acceptance Evidence: Node 108/108、Rust 78/78、typecheck、lint、生产 build、rustfmt 与严格 Clippy 全部通过；Playwright 78 项均执行，新增收藏集创建/加入/排序/安全删除、零隐式写入和 360 px 专项通过。Windows runner 在报告完成后仍存在既有 Vite 子进程不自动退出问题，外层命令会超时。

### TASK-D-UX-003-R1：系列识别、完整季补充与归组体验重构

- Phase: IMPLEMENTATION
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R2
- Scope: 先以本地证据确认多季作品，再按需读取 TMDB 全部季并原子补充缺少季；电影、衍生剧和特别篇通过显式确认关联；收藏集按年代展示与排序；RecordForm 收敛归组入口。
- Approved Design: `docs/SERIES_DISCOVERY_COMPLETION_DESIGN.md`。用户确认使用推荐方案，并补充成员标题末尾显示年代、按从老到新排列，以及解决编辑表单收藏集平铺混乱的问题。
- Safety: 所有扫描与预览零业务写入；新增季只填充新记录且不覆盖已有记录；锁定记录不自动写身份；缓存仅本地；批量创建使用 Rust 单事务并在提交前复查重复。
- Implementation: V18 以 `tmdb_identity_schema_version=1` 和 `collections_schema_version=2` 持久化 TMDB 身份、收藏集类型与排序模式；本地发现按 IMDb 去重、4 路并发、显示进度且可停止，成功/无结果缓存分别为 30/7 天。确认的 TMDB 剧集可一次查看全部季，已存在季禁用，已播常规缺失季默认选择，第 0 季默认隐藏；Rust `create_missing_seasons` 在一个事务中创建记录、成员、revision、generation、staging 与 outbox，并按 parent ID + season number 二次去重。影视宇宙通过显式搜索确认关联电影或衍生剧。
- Data Exchange: 完整本地备份已升级为 V4，并兼容 V3；WebDAV 已升级为 V6，V5 安全补默认集合语义，V7+ 拒绝且零 PUT，首次 V6 发布需确认；派生缓存不参与交换。
- UX: 成员标题显示年代；chronological 从老到新且未知最后，manual 保留上下排序。RecordForm 下部仅摘要最多两个归组，并通过可搜索管理器调整关系。
- Acceptance Evidence: Node 113/113、Rust 79/79、typecheck、lint、生产 build、rustfmt 与严格 Clippy 全部通过。收藏集 Playwright 专项 3 项均执行且无失败，其中包括完整创建/加入/排序/安全删除、只读打开和 360 px；Windows runner 在报告后仍有既有 Vite 子进程不自动退出，外层命令超时。

### TASK-D-UX-003-R2：收藏集发现、缺失条目与元数据补充重构

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R1
- Approved Design: `docs/COLLECTION_DISCOVERY_REWORK_DESIGN.md`。用户要求修正全库 350 项误扫描、已有系列重复建议、中文季数拆组、手工系列无法检查缺失内容、影视宇宙功能互斥、记录内无法新建收藏集，以及自动补充季元数据不完整。
- Data Boundary: 数据库主版本继续为 V18；扫描和预览零业务写入；旧数据不在启动时自动整理；新记录只填 TMDB 可用字段，已有记录只填缺失字段。
- Implementation Progress: 已实现中文季数归一与冲突拒绝、统一季/电影元数据映射、全局扫描入口、规范化 TMDB 身份去重、已有集合差异过滤、多个 TMDB 匹配人工选择、四类收藏集创建、手工系列按需来源绑定、电视剧缺失季、电影合集缺失电影、清单 7 天/电影详情 30 天缓存与强制刷新、影视宇宙多父剧选择和既有系列双重归属、记录内收藏集草稿，以及建议应用/记录内创建/缺失内容创建的 Rust 原子命令。电影合集现按 TMDB + IMDb 双身份区分当前成员、片库复用、真正缺失、冲突和无法确认，并由 `complete_movie_collection` 单事务补旧身份、复用成员或创建记录，写入时全片库复核并在冲突时整批回滚。2026-08-13 收尾修订把电影合集/电视剧系列的详情级资格校验前移到歧义判断之前：独立电影、只有一部已上映作品的伪合集、完整单季剧、已覆盖、已忽略和身份冲突候选不再要求人工选择；过滤后只剩一个有效候选时直接生成只读建议。2026-08-18 修正《人生七年》旧条目被分类为“纪录片”时的重复创建：IMDb 作为作品级身份跨本地媒体分类复用，明确 `tv/tv-season` 身份则显示冲突；前端预览与 Rust 原子提交双层执行同一保护，复用时只补缺失 TMDB 身份且保留“纪录片”分类。
- Acceptance Evidence: Node 123/123、Rust 86/86（单线程避免既有恢复点测试临时目录碰撞）、typecheck、lint、rustfmt、严格 Clippy 与生产 build 通过。新增旧电影 IMDb 复用与缺失身份补全、片库记录复用、TMDB/IMDb 冲突整批回滚，以及电视剧共享 IMDb 不参与电影去重测试。收藏集 Playwright 6/6 均运行至完成且未报告用例失败；Windows runner 仍被既有 Vite 子进程退出问题拖住。
- 2026-08-13 Qualification Evidence: Node 136/136、typecheck、lint、生产 build 与 `git diff --check` 通过；收藏集 Playwright 17/17 均运行至完成且未报告用例失败，覆盖独立电影过滤、完整单季过滤、唯一有效来源直达建议、多个有效来源只读选择及已有集合网络前排除。Playwright 报告完成后 Vite 子进程仍不自动退出，外层命令因此超时；没有把该超时记为测试通过本身。
- 2026-08-18 Legacy Documentary Evidence: Node 138/138、Rust 90/90、typecheck、lint、生产 build、rustfmt 与 `git diff --check` 通过；《人生七年》专项 Playwright 1/1 报告 `ok`，验证同 IMDb 的旧“纪录片”记录不会新增副本，而是保留分类、补齐 movie/TMDB 身份并加入现有电影系列。报告后仍需中止既有不退出的 Vite 子进程。
- Portable Acceptance: 2026-08-18 用户使用提交 `0ae00cc` 对应便携版完成真实片库复测，确认《大时代》候选资格与《人生七年》旧纪录片 IMDb 复用均无问题；`WT-COLLECTION-PORTABLE-001` 验收完成，本任务转为 `IMPLEMENTED`。

### TASK-D-UX-003-R3：收藏集建议资格、覆盖去重与持久忽略

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R1
- Objective: 只有能够产生真实归组、身份绑定或缺失内容补充的候选才进入建议区；TMDB 已确认的完整单季剧、已经被任意收藏集覆盖的候选和用户明确忽略的候选均不得重复出现。
- Eligibility: 电视剧按 TMDB `seasons` 中 `season_number > 0`、具有有效首播日期且不晚于当前日期的常规季判断；第 0 季、特别篇、未播季不参与。单一已播季且本地已经拥有时排除；全部已播季均已存在时排除；TMDB 请求失败或季数据缺失不得误判为单季。
- Coverage: 建立 record ID 到收藏集的反向索引。单条候选已经属于任意收藏集，或候选全部成员已经被同一个集合覆盖时，不再建议创建独立集合；已有同源电视剧系列仍可进入定向缺失季检查，但影视宇宙不得被静默改绑为子剧来源。
- Dismissal: 每条建议提供“应用”和“不再推荐”。用户决定保存在 V18 `settings.collection_suggestion_dismissals_v1`，优先使用稳定 TMDB source key，没有稳定身份时使用本地候选指纹；关闭、重启和重新扫描后继续生效。派生 TMDB 缓存不得承担用户决定。
- Recovery UX: 收藏集中心显示“已忽略建议（N）”，支持查看名称、类型和忽略时间、单项恢复及全部恢复。恢复后重新扫描，不直接修改记录或收藏集。
- Scan Summary: 扫描结果区分可处理、完整单季/已完整、已有集合覆盖、用户忽略、歧义和 TMDB 无法确认；默认只显示可操作建议。
- Data Boundary: 不提升数据库主版本、不升级 WebDAV schema；忽略状态第一阶段为当前设备本地设置。扫描、过滤、忽略与恢复均不得修改 records、collections、members、generation、staging 或 outbox。
- Acceptance: 覆盖单季、特别篇、未来季、已播缺失季、完整多季、TMDB 失败、持久忽略/恢复，以及《罪恶黑名单：救赎》已经属于《罪恶黑名单》后不再独立推荐的回归用例。
- Implementation: 本地单条标题候选不再未经 TMDB 验证直接进入结果；稳定/IMDb 电视剧候选按已播常规季做最终资格检查。建议展示前按成员反向索引过滤任意集合覆盖，并以 SQLite settings 持久保存用户忽略决定；界面提供逐项忽略、已忽略列表、逐项/全部恢复及六类扫描统计。
- Acceptance Evidence: Node 132/132、typecheck、lint 与生产 build 通过。收藏集 Playwright 原有 10 项与新增“任意收藏集覆盖”“TMDB 单季排除”“持久忽略/恢复”共 13/13 通过；Windows runner 仍在报告完成后被既有 Vite 子进程退出问题拖住，3 项 R3 专项均明确报告 `ok`。
- Portable Regression: `docs/COLLECTION_PORTABLE_ACCEPTANCE_TEST.md` 的同一真实便携用例同时覆盖本任务的单季资格、任意集合覆盖去重、持久忽略和恢复入口。

### TASK-D-ARCH-001：跨语言类型生成

- Phase: COMPLETED
- Owner: Codex
- Status: IMPLEMENTED
- Priority: R2
- Scope: 选择 Rust 或独立 schema 作为单一事实源，生成 TypeScript/DTO/字段白名单并在 CI 检查漂移。
- Current Basis: 当前 Rust DTO、TypeScript 类型、SQL 列和更新映射由多处手工维护。
- Approved Design: `docs/CROSS_LANGUAGE_CONTRACTS_DESIGN.md`。
- Implementation: 以 `contracts/watch-record.schema.json` 作为记录 IPC 契约的唯一手写来源，通过零新增依赖的 Node 脚本生成 TypeScript 与 Rust 的 `WatchRecord`、`UpdateWatchRecord`、枚举值域和更新字段清单；Rust 保留既有 `Patch<T>` 三态语义。`npm test` 前置执行只读漂移检查，并核对契约可更新字段与原子 SQL 更新映射。
- Data Boundary: 数据库保持 V18；不修改 Tauri 命令、JSON 字段名、SQL schema、同步 payload 或业务校验。收藏集、逐集历史及同步 envelope 留待各领域发生结构变化时分批迁移。
- Acceptance Evidence: 契约漂移检查通过；Node 142/142、Rust 90/90、typecheck、lint、生产 build、rustfmt、严格 Clippy 与 `git diff --check` 全部通过。

### TASK-D-ARCH-002：同步模块和大型组件拆分

- Phase: IMPLEMENTATION
- Owner: Codex
- Status: IN_PROGRESS
- Priority: R2
- Scope: 分离同步领域、存储、传输和应用服务，并拆分 RecordForm/SettingsModal；先锁定行为测试再做结构迁移。
- Current Basis: `webdav.ts` 与大型表单组件职责密集，但当前 `useWatchList` 是稳定主链路，Zustand 不作为默认目标。
- Approved Design: `docs/SYNC_COMPONENT_MODULARIZATION_DESIGN.md`。用户于 2026-08-22 确认按四批迁移：行为基线与纯函数、WebDAV 传输与一次同步服务、自动协调器与记录仓储 hook、Settings/RecordForm UI 拆分。保持所有公共入口、V18、同步协议、IPC 和界面行为不变；下一步实施 Batch A。
- Batch A: 已完成 ETag/payload/错误映射与 RecordForm 模型纯函数提取；PROPFIND 保留原生 DOMParser，组件保留函数式更新。验收为 Node 151/151、相关 Playwright 46/46、Rust 90/90、typecheck、lint、生产 build、rustfmt、严格 Clippy 与 `git diff --check` 全部通过。下一步为 Batch B，尚未开始。
- Batch B: 已完成 WebDAV transport、凭据门面、条件验证基础设施、一次同步 service 和 legacy import service 拆分；`shared/lib/webdav.ts` 仅保留约 58 行兼容门面，旧动态导入路径与全部公共出口保持不变。验收为 Node 154/154、相关 Playwright 46/46、Rust 90/90、typecheck、lint、生产 build、rustfmt、严格 Clippy 与 `git diff --check` 全部通过，未连接真实 WebDAV。下一步为 Batch C，尚未开始。

### TASK-D-LINK-001：可播放来源与外部链接

- Phase: DEFERRED
- Owner: Unassigned
- Status: NEEDS-DESIGN
- Priority: R3
- Scope: 每条记录保存多个平台/本地来源，提供 URL/协议校验、平台模板、排序和一键打开。
- Current Basis: 当前卡片只基于 IMDb ID 打开 IMDb 页面，尚无通用来源模型。

### TASK-D-RELEASE-001：正式发布与数据格式防误修改

- Phase: DEFERRED
- Owner: Unassigned
- Status: NEEDS-DESIGN
- Priority: R3
- Product Decision: WatchTracker 不采用完整 Event Sourcing；继续以当前记录模型、目的限定命令、事务、恢复点和轻量审计保障可恢复性。
- Recommended Combination:
  1. 保持 Rust 为唯一业务写入者，每类写入继续使用目的限定命令；
  2. 增加正式的 `data_format_epoch`，所有正式版启动时必须先检查兼容性；
  3. 旧 EXE 与活动数据库彻底隔离，旧程序不得直接打开需要更高 epoch 或能力标记的数据库；
  4. migration 前使用 SQLite Backup API 建立并校验快照；
  5. 所有业务写入继续保证 records、逐集历史、revision、staging/outbox 在同一事务提交；
  6. 增加轻量审计表，至少记录操作类型、程序版本、Git commit、数据格式版本及操作前后哈希；
  7. 启用 SQLite foreign keys、defensive mode，并在兼容性验证后尽量关闭 trusted schema；
  8. 本地保留多代恢复点，并允许用户选择一个应用数据目录之外的外部备份目录；
  9. Windows 正式安装包、便携包及自动更新产物统一签名并验证发布者；
  10. 发布采用少量用户/设备验证后逐步放量，出现迁移或数据完整性异常时停止扩大范围；
  11. 每个正式包明确显示产品版本、Git commit 和数据格式版本。
- Required Design: 明确 epoch 与现有 `db_version`/功能 marker 的职责、旧 EXE 隔离方式、启动拒绝与只读恢复流程、审计哈希范围和保留周期、外部备份失败语义、证书/自动更新信任链、灰度指标及回滚边界。
- Acceptance Boundary: 必须使用临时数据库与独立发布目录验证旧包零写入拒绝、migration 快照可还原、审计事务回滚、SQLite 安全开关兼容性、签名校验和分阶段发布停止条件；不得用活动用户数据库做故障注入。

### TASK-D-HISTORY-002：多观看会话与重看历史

- Phase: DEFERRED
- Owner: Unassigned
- Status: NEEDS-DESIGN
- Priority: R3
- Roadmap Position: 本任务固定为当前未来路线图的最后一项；在正式发布数据防护与现有逐集历史稳定前不实施。
- Scope: 同一条目支持多次开始、暂停和完成观看；每次观看拥有独立会话、开始/完成时间、逐集完成归属和可选备注，并能区分首次观看、重看及仍在进行的会话。
- Current Basis: `TASK-D-HISTORY-001` 只维护一组条目级 `startDate/endDate` 和逐集完成事件，不表达多轮观看，也不允许把“继续追更”误当作重看。
- Required Design: 会话身份与当前活动会话约束、既有完成事件迁移、条目汇总状态、逐集事件归属、重看交互、删除/合并规则、导入导出、WebDAV schema 升级和同一会话的同步冲突策略。
- Migration Boundary: 不从现有单一完成时间或逐集历史猜测过去观看次数；旧数据只能保留为明确的历史基线，是否建立首个会话必须采用可解释且可撤销的迁移方案。
- Dependency: 应在 `TASK-D-RELEASE-001` 的 `data_format_epoch`、旧 EXE 隔离、迁移快照和审计边界落地后再设计实施。

## 已移出 DEFERRED

### MAINTENANCE-CI：持续集成维护

- Phase: MAINTENANCE
- Owner: Unassigned
- Status: IMPLEMENTED
- Former Priority: R1
- Evidence: `.github/workflows/ci.yml` 在普通 branch push 与 pull request 上运行 typecheck、lint、Node tests、前端 build、Playwright，以及 Windows `cargo fmt/clippy/test`；普通 push/PR 不执行 Windows Tauri bundle。只有推送 `v*` 标签并且前端、Playwright 与 Rust 门禁全部通过后，才构建 `app.exe`、MSI 和 NSIS setup，保留 Actions artifact，并自动创建带生成式 Release Notes 的 GitHub Release、上传三类发布文件。
- Scope: 后续只维护 action/runtime 版本、缓存、最小权限、失败诊断、tag 发布和构建稳定性；新增门禁另开任务。发布资产只由 `v*` 标签触发，普通代码提交和 PR 不应产生安装包或 Release。
- Local Bundle Diagnostic（2026-08-20）: 本地受限构建已确认在 Rust Release EXE 成功后，由 WiX `light.exe` 的 ICE01～ICE09 无法访问 Windows Installer 服务而失败；`msiserver` 注册与运行状态正常，相同 WiX 输入在非隔离权限下可成功链接，因此不是源码或 MSI 模板损坏。后续维护项为让 `build:portable` 只生成并校验单文件 EXE，MSI/NSIS 保持由 `v*` tag 的 GitHub Actions Windows Runner 构建。实施前不得把旧安装包误认作当次产物，也不得以跳过 ICE 校验代替正确构建权限。完整记录：`docs/WINDOWS_BUNDLE_DIAGNOSTIC.md`。
