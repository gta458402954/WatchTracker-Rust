# 执行任务

> 原任务基线：2026-07-26，`main@29ea3a4` 加当前未提交工作区。2026-07-27 增加 Recovery Phase：先保护现场并验证 `origin/main@6fcbb1e` 与干净 `29ea3a4`，再从最后绿色提交恢复。Gate R 前不得实施 Phase A；Phase B 继续受 Gate A 阻塞；DEFERRED 本轮禁止实施。

## 状态定义

`DRAFT`、`READY`、`IN_PROGRESS`、`IMPLEMENTED`、`REVIEWING`、`CHANGES_REQUESTED`、`BLOCKED`、`ACCEPTED`

- `TASK-R-001`~`TASK-R-005` 已由 Codex 独立复验并 `ACCEPTED`。R-004 已定位 build 首坏提交 `29ea3a4`，并选定 `6fcbb1e` 为最终恢复基线；R-005 已完成恢复分支、隔离数据及用户 UI 验证。
- Gate R 与 Gate A 均已 PASS；`TASK-A-001`~`TASK-A-010` 均已由 Codex 独立验收。`TASK-B-001` 已单独签发；其余 Phase B 任务尚未开放。
- Antigravity 自 2026-07-28 起暂停使用。现有 Owner 为 Antigravity 的未完成任务不得执行，必须先由 Codex 重新签发合同并明确改派；Codex 实施与验收须分成 Implementation Pass 和独立 Verification Pass。
- Phase B 在 AC-GATE-001 通过前保持 BLOCKED，不得由执行者自行解锁。

## 任务总览与依赖图

- Recovery：5 个任务；`TASK-R-001`~`TASK-R-005` 均已验收。
- Phase A：10 个任务；`TASK-A-001`~`TASK-A-010` 均已验收，Gate A PASS。
- Phase B：5 个任务；Gate A 前置条件已满足，`TASK-B-001` 已转 `READY`，`TASK-B-002`~`TASK-B-005` 继续等待依赖和单独签发。
- DEFERRED：4 个路线图包及 1 个已细化的逐集完成时间任务；本轮禁止实施，不计入 A/B 数量。

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
Gate A ─ B-001 ─┬─ B-002 ─┐                         │
                └─ B-003 ─┴─ B-004 ─ B-005 ─ Gate B
```

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

## Phase B：地区动态化专项（Gate A 已 PASS；TASK-B-001 已单独签发）

## TASK-B-001：收口地区规范化与聚合领域规则

- Phase: B
- Owner: Codex
- Status: READY
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

READY — User authorized the recommended Phase B sequence on 2026-08-01. Gate A is PASS; protected remote `main@d7b5f2c` and GitHub Actions run `30695201620` are green. Codex reassigned the task from paused Antigravity and audited the archived region prototype before implementation. No business source was changed during authorization.

## TASK-B-002：完成动态地区选项、筛选状态与界面行为

- Phase: B
- Owner: Antigravity
- Status: BLOCKED
- Priority: P1 / High
- Dependencies: AC-GATE-001, TASK-B-001
- Acceptance Criteria: AC-B-003, AC-B-004, AC-B-007
- Expected Files:
  - `src/app/App.tsx`
  - `src/shared/hooks/useFilteredRecords.ts`
  - `src/features/watchlist/components/StatsBar.tsx`
  - `src/features/settings/components/SettingsCategoriesTab.tsx`
  - 相关组件/Hook 测试

### Objective

让地区选项只随 records/mediaType/status 动态变化，清理失效选择，并保持布局与可访问性。

### Implementation Requirements

- 计数输入不受 search/rating/lock/sort/activeRegion 影响。
- 不通过 include 0 强行保留失效选项；数据或 scope 变化后自动回 `all`。
- 再次点击当前地区取消选择；空数据不显示地区列表。
- 多地区布局 wrap 或横滚，不遮挡其他控件；保留 `aria-pressed` 和可辨选中态。
- 设置页文案改为 originCountry 主源、contentTags 仅旧数据回退。
- 使用 memoized 纯聚合，避免一次渲染内重复全量扫描。

### Verification

```powershell
npm run test
npm run typecheck
npm run lint
npx playwright test
```

### Required Evidence

- 选项基础范围/失效状态测试。
- 大量地区、选中态和布局截图。

### Execution Result

Blocked by Gate A

## TASK-B-003：保证 TMDB、表单及数据往返兼容

- Phase: B
- Owner: Antigravity
- Status: BLOCKED
- Priority: P1 / High
- Dependencies: AC-GATE-001, TASK-B-001
- Acceptance Criteria: AC-B-005, AC-B-006
- Expected Files:
  - `src/shared/lib/classification.ts`
  - `src/shared/lib/tmdbMapper.ts`
  - `src/features/watchlist/components/RecordForm.tsx`
  - `src/features/settings/components/SettingsToolsTab.tsx`
  - `src/store/useWatchListStore.ts`
  - `src/shared/lib/webdav.ts`
  - 相关测试

### Objective

确保电影/剧集 TMDB 多国代码完整保存，自动地区标签不误删用户标签，旧记录经导入/恢复/同步仍遵守同一分类规则。

### Implementation Requirements

- 不修改 TMDB 搜索接口/交互。
- 新增和更新完整保留 TMDB 返回代码并规范化；未映射代码不必注入中文 contentTags。
- 只移除明确识别的旧系统地区标签，保留其他用户自定义标签。
- 导入/导出/备份恢复/WebDAV payload 往返不丢 `originCountry`。
- 不执行数据库地区迁移或清洗用户标签。

### Verification

```powershell
npm run test -- src/shared/lib/__tests__/tmdbMapper.test.ts src/shared/lib/__tests__/classification.test.ts src/shared/lib/__tests__/webdav.test.ts
npm run typecheck
```

### Required Evidence

- 多国/自定义标签前后样例和测试日志。
- 导入恢复同步往返校验摘要。

### Execution Result

Blocked by Gate A

## TASK-B-004：建立地区专项单元、组件与 E2E 矩阵

- Phase: B
- Owner: Antigravity
- Status: BLOCKED
- Priority: P1 / High
- Dependencies: AC-GATE-001, TASK-B-001, TASK-B-002, TASK-B-003
- Acceptance Criteria: AC-B-001~007
- Expected Files:
  - `src/shared/lib/__tests__/*`
  - `tests/fixtures/mockIpc.ts`
  - `tests/region.spec.ts`（建议新增）

### Objective

自动覆盖 REQUEST 7.2/7.3 全部地区场景并证明现有筛选无回归。

### Implementation Requirements

- 夹具含常见代码、多国、重复、UK、旧中文标签、未知和未映射两位代码。
- E2E 覆盖实际选项集合、CN/HK/TW、GB/UK、多国、未知、组合筛选、增改删及导入/同步动态更新。
- 明确断言评分/搜索/锁定/排序/current region 不改变基础地区计数。
- mock IPC 与真实 DTO 一致；不以 mock 替代最终桌面冒烟。

### Verification

```powershell
npm run test
npx playwright test
npm run typecheck
npm run lint
```

### Required Evidence

- REQUEST 7.2/7.3 到测试名称映射。
- Vitest/Playwright 完整日志、截图或 trace。

### Execution Result

Blocked by Gate A

## TASK-B-005：执行地区全量回归并提交验收材料

- Phase: B
- Owner: Antigravity
- Status: BLOCKED
- Priority: P1 / Critical
- Dependencies: AC-GATE-001, TASK-B-004
- Acceptance Criteria: AC-B-008, AC-FINAL-001
- Expected Files:
  - `.agent-work/TASKS.md`
  - `.agent-work/EXECUTION_LOG.md`
  - `.agent-work/evidence/**/*`

### Objective

执行地区专项和全项目回归，整理证据交给 Codex 独立验收；不得自行填写 PASS 报告。

### Implementation Requirements

- 执行全部前端强制命令和相关 Rust/真实桌面回归。
- 人工核对大量地区布局、选中态、动态消失、设置页统计和无现有筛选回归。
- 最终任务只标 IMPLEMENTED，等待 Codex 生成地区及综合报告。

### Verification

```powershell
npm run build
npm run typecheck
npm run lint
npm run test
npx playwright test
Set-Location src-tauri
cargo fmt -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

### Required Evidence

- 全量命令日志、地区场景截图/trace、最终 Git 状态和 AC-B 证据索引。

### Execution Result

Blocked by Gate A

---

## DEFERRED：后续路线图（本轮禁止实施）

## TASK-D-R0：同步与凭据安全路线图包

- Phase: DEFERRED
- Owner: Unassigned
- Status: BLOCKED
- Priority: Future R0
- Dependencies: Gate A, Gate B, 新的用户专项需求与验收标准
- Scope: 同步冲突/版本记录、持久化 dirty/outbox、主动拉取、WebDAV 目标隔离、Windows 凭据安全迁移。
- Prohibition: 本轮不得实施、不得以阶段 A 修复名义扩展。

## TASK-D-R1：核心体验与长期加固路线图包

- Phase: DEFERRED
- Owner: Unassigned
- Status: BLOCKED
- Priority: Future R1
- Dependencies: Gate A, Gate B, 新的用户专项需求与验收标准
- Scope: 逐集完成时间/观看历史、今晚看什么、Trakt、长期领域约束、网络/海报长期安全、持续集成后续演进。
- Prohibition: 除本轮明确要求的最小 CI/数据安全修复外，不实施产品能力。

## TASK-D-R1-001：逐集完成时间与完结状态

- Phase: DEFERRED
- Owner: Unassigned
- Status: BLOCKED
- Priority: Future R1
- Dependencies: Gate A, Gate B, 专项数据模型与验收标准
- Business Source: `.agent-work/REQUEST.md` 9.3
- Scope: 下一集语义、单集完成三态、跳集空时间、最后一集完结、幂等历史、旧进度兼容、migration、导入导出与同步边界。
- Current Model Finding: 当前只有自由文本 `progress` 与 `totalEpisodes`；历史 `watch_logs` 表在 v13 migration 中被删除，不能直接复用为现行能力。
- Required Future Design:
  - `records.nextEpisode` 与独立 `episode_completions` 数据模型、可空 `completedAt`、唯一约束和向前 migration；
  - 下一集更新与上一集完成事件的原子事务；
  - 旧 `progress` 保持原样，并通过用户显式选择起始下一集启用新模型；
  - 三态约束：无行＝未记录完成；有行且时间为空＝已完成但时间未记录；有行且时间非空＝已完成且时间已知；
  - 跳集为中间集插入空时间完成记录、为目标前一集插入当前时间，不为未跨过的集预创建行；
  - 重复、回退、跳集空值、离线、导入恢复和同步冲突测试；
  - 单元、Rust/SQLite 集成和真实 Tauri UI 验收标准。
- Confirmed First-Version Boundary: 下一集选择、单集完成三态、跳集空时间、完结、旧数据显式启用；不含观看时长、批量补历史、跨季聚合和历史编辑。
- Prohibition: 本轮不得实施，不得并入阶段 A/B 或以稳定性修复名义提前修改 schema。

## TASK-D-R2：高级功能与架构路线图包

- Phase: DEFERRED
- Owner: Unassigned
- Status: BLOCKED
- Priority: Future R2
- Dependencies: Gate A, Gate B, 新的用户专项需求与验收标准
- Scope: 高级筛选/保存视图、订阅提醒、系列收藏、跨语言类型生成、同步/组件拆分、完整弹窗可访问性。
- Prohibition: 本轮不得实施。

## TASK-D-R3：便利性与恢复路线图包

- Phase: DEFERRED
- Owner: Unassigned
- Status: BLOCKED
- Priority: Future R3
- Dependencies: Gate A, Gate B, 新的用户专项需求与验收标准
- Scope: 可播放来源/外部链接、自动备份与恢复点。
- Prohibition: 本轮不得实施。
