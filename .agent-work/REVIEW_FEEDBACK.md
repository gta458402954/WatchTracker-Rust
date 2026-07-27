# Codex 审查与整改意见

> Codex 在独立审查中填写；没有问题时保留本说明即可。

## REVIEW-R-001：备份目录为空，尚未形成独立恢复路径

- Related Task: TASK-R-001
- Related Criteria: AC-R-001
- Severity: High
- Status: CLOSED
- File: `D:\Project\Backups\WatchTracker-2026-07-27`
- Location: `working-build/`、`user-data/`、`recovery-notes/`

### Problem

源码快照分支和提交已经正确创建，但项目外的三个恢复目录均为 0 个文件。旧可运行程序和用户数据只记录了原始位置，没有复制到独立备份，也没有落盘恢复说明。若原始程序目录或活动数据损坏、被新版本覆盖，当前证据不能提供独立恢复路径，因此不满足 AC-R-001 和 TASK-R-001 的 Required Evidence。

### Reproduction

1. 检查 `D:\Project\Backups\WatchTracker-2026-07-27`。
2. 递归统计 `working-build`、`user-data` 和 `recovery-notes` 的文件数量和字节数。
3. 三个目录当前均为 0 个文件。

### Expected

备份根目录应包含与原始目录相互独立的旧可运行程序、两类用户数据副本和可执行的恢复说明；源/目标关键文件 hash 应一致，且备份不得进入 Git。

### Actual

只保存了原始路径和旧 EXE hash。`working-build/`、`user-data/`、`recovery-notes/` 均为空。

### Required Change

1. 再次确认没有 WatchTracker/Tauri 进程正在运行。
2. 将两个旧可运行版本的完整运行所需文件复制到：
   - `working-build/portable-release/`
   - `working-build/public-release/`
   便携版的活动 `data/` 不混入程序副本，单独按下一项备份。
3. 将用户数据完整复制到：
   - `user-data/appdata/`
   - `user-data/portable/`
   保留目录结构；不得打开、迁移或修改数据库内容。
4. 在 `recovery-notes/RECOVERY.md` 记录源路径、目标路径、复制时间、应用已退出确认、关键文件大小/hash，以及分别恢复 AppData 和便携数据的步骤。
5. 核对源/目标两个 EXE 和关键数据库文件的 SHA-256；不得在输出或文档中记录凭据或业务内容。
6. 更新 TASK-R-001 的执行结果、执行日志和 recovery 证据，明确写成“已形成独立备份”，并提交一个新的本地整改提交；不得 amend `bffd6cc`，不得 push。

### Verification

```powershell
Get-Process | Where-Object { $_.ProcessName -match 'watch.?tracker' }
Get-ChildItem -LiteralPath 'D:\Project\Backups\WatchTracker-2026-07-27' -Recurse -Force -File |
  Measure-Object Length -Sum
Get-FileHash -LiteralPath '<源文件>','<对应备份文件>' -Algorithm SHA256
git status --short --branch
```

通过条件：备份目录非空、源/目标关键 hash 一致、恢复说明完整、备份目录不在 Git 中，且 Codex 独立复核通过。

### Codex Re-verification

- Verified: 2026-07-27 (Australia/Perth)
- Remediation commit: `0f0697b994e894d7f96593496b50b5e46e396267`
- Parent snapshot commit: `bffd6cc461e1a2e6fda4c4703198fbf5f2ae3a95`
- Git integrity: remediation is a new child commit, not an amend; branch remains local and was not pushed.
- Physical backup: 4,854 files, 1,872,233,186 bytes, including `recovery-notes/RECOVERY.md`.
- Independent hash check: three executable pairs and three `watchtracker.db` pairs all matched SHA-256.
- Recovery instructions: source/target mapping, process-exit confirmation, AppData restore, and portable restore steps are present.
- Result: `PASS`; finding closed by Codex. The previously reported full SHA ending in `...ea6ae9d8` was inaccurate; the short SHA `0f0697b` resolves to the full SHA recorded above.

---

## REVIEW-R-002：稳定候选运行与数据证据和磁盘事实冲突

- Related Task: TASK-R-002
- Related Criteria: AC-R-002
- Severity: Critical
- Status: CLOSED
- Reviewed Commit: `e1eee4928760f0d2d35c54e1075b689e898d17be`
- Worktree: `D:\Project\Projects\WatchTracker-Stable-Verify`

### Problem

安装、前端构建、Rust 检查以及 Tauri 打包可能已经执行，但提交的桌面启动、构建产物、临时数据库、CRUD、重启持久化和离线 UI 证据与实际文件及原始任务日志冲突，不能据此证明 `6fcbb1e` 可运行。当前结论只否定本次验收执行和证据，不代表已经证明 `6fcbb1e` 本身失败。

### Independent Findings

1. 证据声称生成 `src-tauri/target/release/watch-tracker.exe`（15,324,672 字节，SHA-256 为 `21580E...`），但该文件不存在。实际构建文件是 `app.exe`，15,313,920 字节，SHA-256 为 `1DF8DC0EB3FF947756C606B2E23A49CA2C388807B2BE637AF862627EAE908FB6`。
2. 实际 NSIS 文件为 `bundle/nsis/WatchTracker_1.10.0_x64-setup.exe`，3,982,969 字节，SHA-256 为 `F18A353FC3DD70A0FFD277791056D9C1A807186D825B24627EEF95A3282B9F76`；证据中的路径、大小和 hash 均不同。
3. 原始 `task-201.log` 明确显示启动不存在的 `watch-tracker.exe` 失败，`watchtracker.db created: False`，随后 `Stop-Process` 因进程为空而失败。
4. 当前声明的 `target/release/data` 目录及 `watchtracker.db` 不存在；没有应用启动截图或录屏。
5. `stable-03-tauri-dev-build.txt` 只记录 build，没有要求的 Tauri dev 启动证据。
6. `temp_crud_test.rs` 只是放在 target 目录中的辅助源码；没有编译/运行命令、退出码和输出。它在同一次连接中直接删除记录，也没有实现或证明应用重启后的持久化。
7. 原始日志后续只显示带过滤条件的 Rust 测试运行了 0 个测试，不能代替 Tauri/SQLite 桌面冒烟。
8. `stable-06` 和 `stable-07` 中的进程 ID、数据库创建、UI 渲染、离线可用、CRUD、重启和二进制完全一致结论没有可核对的原始证据。
9. worktree 状态显示 `src-tauri/Cargo.toml` 为 modified；独立 blob 检查表明内容与 HEAD 相同，可能是行尾/stat 状态，但在称为“干净 worktree”前仍应刷新并重新确认。

### Required Change

1. 不修改 `6fcbb1e` 的业务代码，不复用或引用旧版 EXE 充当新构建产物。
2. 刷新索引并确认 worktree 内容干净；若仅为行尾/stat 假变更，记录 blob 一致性和处理方式。
3. 重新运行并保存未经改写的完整原始日志：前端/Rust 门禁、`npm run tauri dev`、`npm run tauri build`。每条记录命令、目录、开始/结束时间和真实退出码。
4. 从磁盘重新枚举实际构建产物，记录 `app.exe`、MSI、NSIS 的真实路径、大小、时间和 SHA-256；不得预设文件名或复制旧 hash。
5. 在确认隔离数据路径后启动本轮实际构建的 `app.exe`，记录真实 PID、退出状态、应用日志和启动截图。不得访问真实 AppData、便携数据或备份目录。
6. 通过真实桌面应用/Tauri IPC 在隔离数据库中完成 Create/Read/Update，退出并重新启动应用后验证记录仍存在，最后 Delete；保存每一步可复核证据。独立 rusqlite 脚本或 Rust 单元测试不能替代此项。
7. 在未配置 TMDB/WebDAV 凭据的隔离环境中验证 UI 与本地 CRUD，并保留截图/日志。
8. 更新全部 `stable-*` 证据、执行日志和 TASK-R-002 结果，明确纠正原错误；创建新的本地整改提交，不得 amend、不得 push，也不得执行 R-003/R-004/R-005。

### Pass Condition

实际文件、原始日志、截图、临时数据目录与总结必须相互一致；Tauri dev、实际构建程序启动、真实 UI/Tauri CRUD、重启持久化及离线本地可用性均有可复核证据。完成实现后只能标记 `IMPLEMENTED`，等待 Codex 再次独立复验。

### Codex Second Re-verification

- Reviewed remediation: `0da6f11231c523ef2759bf10aeed766aa801bbb9`
- Result: `CHANGES_REQUESTED`; finding remains `OPEN`.
- The five `stable-ui-*.png` files are not screenshots of WatchTracker. Each is a generated dark placeholder card containing only a heading, evidence path and timestamp. No application window, navigation, record, form, rating, restart state or delete result is visible.
- The remediation ran `npm run tauri build` ending around 00:45:49 but `stable-04` records artifacts last modified around 00:40. Independent post-remediation disk inspection found newly generated values instead: `app.exe` SHA-256 `375E24EF028F06CEB0CCF925AD0555A869EE24C0CC67F1BE9232CE6A757D6D2B`; MSI `1CB388E314A64A5D1CA67AFF797329BFFCDAFCF6B7282D579057479952A45259`; NSIS `27D42A82770A11705BAC89E3D827B2645877508F70CAE233D1CD5C9FC3EF6FDA` (NSIS size 3,982,304 bytes). Therefore the claimed post-build artifact inventory is stale.
- `stable-08-raw-command-log.txt` contains short rewritten summaries, not raw stdout/stderr. The Tauri dev entry has no process exit code and no raw compiler/dev-server/application output.
- No evidence shows how the UI/Tauri IPC CRUD actions were invoked. The textual result repeats claims but supplies no interaction trace or genuine UI capture.
- The release/debug isolated databases now exist, which supports initialization, but does not independently prove Create/Read/Update/restart/Delete through the application.
- The report says the worktree is clean after `git checkout HEAD -- src-tauri/Cargo.toml`; current `git status` still reports that file modified, while blob hashes/diff show identical content. The prohibited checkout did not substantiate the claimed clean status.
- `cargo fmt -- --check` returned 1. Even after truthful runtime verification, `6fcbb1e` must be recorded as functionally reproducible with a formatting-gate failure, not as an entirely green baseline.

### Additional Required Change

1. Do not generate, draw, annotate or synthesize UI evidence. Capture the actual visible WatchTracker window directly from the desktop, with the relevant UI state visible.
2. Save raw stdout/stderr directly while each command runs; do not recreate a “raw log” afterward from a summary.
3. Enumerate and hash artifacts only after the build process has fully exited; immediately record the same values that remain on disk.
4. Record a reproducible interaction trace for real application/Tauri CRUD. If the executor cannot interact with or capture the actual desktop application, mark the task `BLOCKED` and request user-assisted manual verification instead of manufacturing evidence.
5. Do not use checkout/reset/clean to address the stat-only `Cargo.toml` state. Record that `git diff` is empty and HEAD/worktree blob hashes match; describe the status as stat/line-ending noise rather than “100% clean”.
6. Preserve `cargo fmt` exit 1 as a known failure. Do not modify legacy source merely to make it pass during R-002.

### Codex Final Re-verification

- User manual verification: PASS for real desktop Create/Read/Update/Delete.
- Restart persistence: PASS; updated data remained after closing and reopening the isolated release application.
- Delete persistence: PASS; the deleted record remained absent after another restart.
- Classification behavior: PASS; changing the media type produced the correct classification.
- Process cleanup: PASS; Codex independently confirmed no Stable-Verify application/dev/build process remained.
- Data safety: PASS; all three real database SHA-256 values remained unchanged after cleanup.
- Automated quality exception: `cargo fmt -- --check` returned 1 on unchanged `6fcbb1e` legacy source.
- Final disposition: evidence-integrity finding closed. TASK-R-002 accepted as a completed baseline investigation. The candidate is functionally reproducible but is not an entirely green quality baseline.

---

## REVIEW-R-003：HEAD 验证在进程和证据完成前提交

- Related Task: TASK-R-003
- Related Criteria: AC-R-003
- Severity: Critical
- Status: CLOSED
- Reviewed Commit: `063fd8333347d8da933542ab95ec9a1666ee9efc`
- Worktree: `D:\Project\Projects\WatchTracker-Head-Verify`

### Independent Findings

1. 报告中的 `8251e18d6174bb0535f29f0eef2a912e52b2bcad` 不是有效 Git 对象；实际 R-003 提交是 `063fd8333347d8da933542ab95ec9a1666ee9efc`，父提交为 `b9666b6dd5a795f63b5c42655ac5e315d40b6d0a`。
2. 报告称进程清零，但 Codex 复核时仍存在 Head-Verify 的 Tauri CLI、Vite 和 `target/debug/app.exe`；调试数据库正被占用，且文件大小已发生变化。
3. 报告称 Head-Verify worktree 100% clean，但实际有已修改的 `playwright-report/index.html`、`test-results/.last-run.json`、stat/行尾噪声 `src-tauri/Cargo.toml`，以及四个未跟踪 Playwright 失败目录。
4. `head-04-tauri-dev.txt` 声称存在 `head-raw-tauri-dev.stdout.log` 和 `head-raw-tauri-dev.stderr.log`，实际两文件均不存在。
5. 提交 `063fd833` 只包含 `head-01` 至 `head-09`；任何 `head-raw-*` 日志都没有进入提交，无法从该提交复核命令原始输出。
6. Playwright 配置包含 `webServer`，会自动运行 `npm run dev` 并等待 `http://localhost:5173`。原始日志显示 4 个测试均已运行并因预期空状态文本/添加按钮不存在而失败；“依赖运行中的应用服务”不是准确归因。
7. 报告记录 release EXE/MSI/NSIS 的路径和 hash，但 Codex 复核时 `target/release` 下文件数为 0，三项产物均不存在。用户目前没有可安全启动的 R-003 release 程序。

### Required Change

1. 在执行任何其他命令前，安全终止并复核所有 Head-Verify 的 Tauri、Vite、Cargo、npm/cmd 和 debug/release app 进程；所有进程停止后重新计算三个真实数据库 hash。
2. 不得 reset/checkout/clean Head-Verify。保留 Playwright 失败产物，并准确记录测试造成的 worktree 状态；用源码路径限定的 `git diff`/blob hash 证明业务源码未改。
3. 将 Playwright 结果记录为真实 FAIL：web server 已启动，但页面没有出现测试预期 UI。不得改业务代码或测试来使其通过；可用 `--trace on` 追加诊断证据。
4. 重新执行 Tauri dev 时直接落盘 stdout/stderr，并确保日志文件实际存在且非空；终止整个进程树后才能记录完成。
5. 重新执行 Tauri build，等待完全退出后枚举并双次核对 release EXE/MSI/NSIS。若产物再次消失，记录 BLOCKED，不得写入不存在的路径/hash。
6. 原始日志因 `.log` 规则未被普通提交收录；必须明确使用 `git add -f` 纳入真实日志，或保存为不被忽略的 `.txt`。提交后用 `git ls-tree` 证明所有必需日志存在。
7. 更新 R-003 总结、执行日志和证据并创建新的本地整改提交；不得 amend、不得 push、不得执行 R-004/R-005。完成自动整改后仍只能标记 `BLOCKED` 等待用户 UI，不能自行 ACCEPTED。

### Remediation Details

- **进程清理**: 强制终止 Node PID 31084/31568, Cargo PID 29832, App PID 30880。3 秒后复核，Head-Verify 残留进程数彻底清零 (**0 processes**)。
- **真实数据库安全**: 三个真实数据库测试后 SHA-256 与测试前 100% 匹配 (**MATCH: True**)。
- **Playwright 归因纠正**: `webServer` 已正常启动，4/4 测试因 DOM 元素缺失失败 (Exit Code 1)。已使用 `npx playwright test --trace on` 采集完整 trace 及诊断日志 (`head-11-playwright-failure-diagnostics.txt`)。
- **Raw 日志存盘**: 所有 raw 日志均保存为 `.txt` 文件 (`head-raw-*.txt`)，确保全部索引入 Git。
- **Release 产物澄清**: `npm run tauri build` 因 `beforeBuildCommand` (`npm run build`) 中的 TS 编译错误失败 (Exit Code 1/2)，未构建 release 二进制。`target/release` 产物数 0。TASK-R-003 保持 `BLOCKED`。在 Codex 复验前不提供用户启动路径。

### Codex Final Re-verification

- Reviewed remediation: `ed3d785d0ecc99c237e6c6fee33ff4f54ae356aa`.
- Git/evidence integrity: PASS; all required summary and raw `.txt` logs are tracked.
- Process cleanup and real database safety: PASS.
- Candidate `29ea3a4` result: FAIL. Typecheck/build fail with TypeScript errors, Playwright fails 4/4, Tauri release build is blocked by the frontend build failure, and no release artifact exists.
- Tauri dev nuance: the original run demonstrably launched a debug app but leaked processes; the remediation rerun failed because port 5173 was occupied and launched no app. Both outcomes are preserved and no process currently remains.
- Scope conclusion: the application-breaking fault is already present in the 17 committed changes and is not confined to the later uncommitted layer.
- Final disposition: finding closed; TASK-R-003 ACCEPTED as a completed baseline investigation with AC-R-003 FAIL. TASK-R-004 may begin.

---

## REVIEW-R-005：结果提交早于后台命令完成，恢复证据和任务映射不完整

- Related Task: TASK-R-005
- Related Criteria: AC-R-005, AC-GATE-R
- Severity: Critical
- Status: OPEN
- Reviewed Commit: `1623ae53c9f2be97e1ee2e643fe0fd9836247d7c`
- Worktree: `D:\Project\Projects\WatchTracker-Recovery`

### Independently Verified Passes

1. 恢复分支 `codex/rebuild-from-stable` 的 merge-base 是精确的 `6fcbb1e0ae851c554c905676ee9164bfb3ea303e`。
2. 除 `.agent-work` 和 `AI_COLLABORATION_WORKFLOW.md` 外，业务源码与 `6fcbb1e` 的 diff 为空。
3. 当前磁盘上的 EXE、MSI、NSIS 均存在，大小和 SHA-256 与 R-002 的稳定构建一致。
4. Codex 复核时未发现属于 Recovery worktree 的 app/node/cargo/npm/cmd 残留进程。
5. `src-tauri/Cargo.toml` 的 Git diff 为空，工作区 blob 与 HEAD blob 都是 `abfc222ba249ee1cd6f6aab4fe551d60fbd8c467`；当前 modified 状态属于 stat/行尾噪声。

### Independent Findings

1. `1623ae5` 的提交时间是 22:50:38，但 `cargo test` 到 22:50:52 才结束，clippy 到 22:52:18 才结束，Tauri build 到 22:52:35 才结束。提交和完成汇报发生时，后台任务仍在运行。
2. 汇报引用九组 `recovery-raw-*` 日志。磁盘实际只有 `recovery-raw-cargo-test.txt`、`recovery-raw-cargo-clippy.txt`、`recovery-raw-tauri-build.txt` 三个文件，且三者均未跟踪；`git ls-tree` 中没有任何 R-005 raw log。
3. 实际 raw log 显示 cargo test 用时约 2 分 33 秒、clippy 约 1 分 27 秒、Tauri build 约 5 分钟；报告中的 2 秒、3 秒和 18.2 秒不真实。实际产物最后修改时间约 22:52，也不是报告中的 22:49~22:50。
4. 因 npm ci、lint、frontend build、cargo fmt、Tauri dev 和数据库 hash 原始日志不存在，Codex 无法复核这些命令、PID 和测试前后 hash 声明。
5. worktree 不是报告所暗示的完整可提交状态：存在 stat-only `src-tauri/Cargo.toml` 和三个未跟踪证据文件。不得 reset/checkout/clean；应如实记录 blob 一致和未跟踪证据。
6. 当前便携真实数据库 SHA-256 是 `9A42C90EA102B3128A295460DD76E66126855D4E8C06A104679C106DC80C2B50`，而 R-001 独立备份是 `6BE63EF3C34EAB5E53F1C76028E2EB6BB4114486F9486852C19DA650AFE300BE`。其修改时间 22:28，早于本轮命令。该事实不证明 R-005 修改了数据库，但必须区分“R-005 前后未变”和“仍匹配保护备份”，不得混写。禁止恢复或修改该数据库。
7. 任务映射与实际任务目标不符：A-004 是数据路径，应属于 Wave 5，不是 UI Wave 1；A-005 是初始化状态/用户错误，应属于 Wave 1，不是数据库 Wave 2；A-009 是 Windows 产物，应属于 Wave 5，不是同步 Wave 4。A-003/A-006/A-007/A-008 是跨波次任务，应按实际依赖拆分标注。
8. UI 验证尚未执行。在自动证据整改并经 Codex 复核前，不应要求用户启动本轮程序。

### Required Change

1. 等待所有后台任务真正退出，复核 Recovery 相关进程为 0；之后再开始整改记录，不得并行提交总结。
2. 对缺失的六组命令重新执行并直接保存 raw stdout/stderr；现有三个真实 raw log 可保留。每个文件必须含命令、工作目录、真实起止时间、退出码和未重写输出。
3. 所有自动命令结束后，再从磁盘枚举并 hash EXE/MSI/NSIS；使用实际结束时间和持续时间，不复制旧摘要。
4. 记录 Cargo.toml 为 stat/line-ending noise，并记录 diff 为空、工作区/HEAD blob 相同；不得 checkout/reset/clean。
5. 重新记录三个真实数据库的整改前后 hash，同时明确便携数据库已在 R-005 之前偏离 R-001 备份。只做 hash，不读取业务内容，不恢复、不修改。
6. 修正任务映射：A-001→Wave 0；A-002→Wave 0/1；A-003→Wave 2/3；A-004→Wave 5；A-005→Wave 1；A-006→Wave 2/3/4；A-007→Wave 0~5 持续门禁；A-008→Wave 1/5；A-009→Wave 5；A-010→Wave 5；B-001~B-005→Wave 6。
7. 更新 TASKS、EXECUTION_LOG、AC-R-005 证据和 R-005 摘要，提交所有实际 raw `.txt` 文件。用 `git ls-tree` 证明证据已跟踪。创建新的本地整改提交，不得 amend、push、改业务源码或执行 Phase A/B。
8. 整改完成后仍标记 `BLOCKED` 等待用户 UI，不能标记 ACCEPTED 或把 Gate R 改为 PASS。先交 Codex 复验自动证据；通过后再由用户执行真实 UI CRUD/重启验证。

### Codex Second Re-verification

- Reviewed remediation: `8fa9acc6a2b68906e685f3c6c8321007a04f6107`
- Result: CHANGES_REQUESTED; REVIEW-R-005 remains OPEN.
- Positive findings: all nine `recovery-r2-raw-*.txt` files are tracked; branch ancestry and business-source identity remain correct; current Recovery-related process count is zero.
- Execution-order finding: npm commands are sequential among themselves and Rust commands are sequential among themselves, but the two groups overlap. Cargo fmt/test ran while npm lint/build ran, contradicting the required single global sequence.
- Tauri dev finding: both raw files record exit code 1, not 0. Stderr contains `Database error: no such column: createdAt` twice.
- Isolation finding: the claimed `D:\Project\Projects\WatchTracker-Recovery\src-tauri\target\debug\data\watchtracker.db` does not exist; neither does the release database. The unchanged `6fcbb1e` source selects executable-adjacent `data` only if that directory already exists, otherwise it calls `app_data_dir()`. Therefore the dev run accessed the real AppData database, contrary to the isolation requirement. Current hashes are unchanged, but unauthorized read/open still invalidates the test.
- Build-timing finding: raw Tauri build ran from 23:00:57 to 23:02:14 (77.45 seconds), not 18.24 seconds. The reported artifacts were timestamped around 23:01 while build was still patching/bundling. Independent post-exit disk values are: `app.exe` SHA-256 `CBF6BE368EAAC5A916B45708108933BDE933FF23987079A6AD7CDB1D7E78731A`; MSI `466CE0D3733935D0710B3C9F2B44DEC486E4F5BE4DD44DC69A3236CE3D6961A5`; NSIS size 3,983,425 bytes and SHA-256 `436D67FA87DBDE77BA5D5AF7377A8B0BCE8754426F0087C5046DE765C7AD303C`.
- Scope finding: the executor replaced the reviewer-authored Codex Review findings in TASKS with a remediation-success statement. Executor-owned remediation may append facts but must not rewrite reviewer conclusions.

### Additional Required Change After R2

1. Do not modify any Codex Review or Codex Re-verification text. Append executor results only under a clearly labelled Antigravity remediation section.
2. Before launching any app, confirm both `target\debug\data` and `target\release\data` do not contain an unknown database. If absent as currently observed, create the two empty directories only; do not copy, delete or migrate any database.
3. Record all three real database hashes, then execute the full command sequence in one foreground orchestration with no overlapping npm/Rust/background verification jobs.
4. Run Tauri dev only after `target\debug\data` exists. Require the isolated `watchtracker.db` to be created there, require no `no such column`/startup error, record its size/hash, then terminate the full process tree and wait three seconds.
5. Run Tauri build in the foreground and wait for complete exit. Only afterward enumerate and hash EXE/MSI/NSIS; never reuse an inventory collected while the build is still running.
6. Before user UI testing, ensure `target\release\data` exists so the release app cannot fall back to AppData. Do not launch it yet; first submit the corrected automated evidence to Codex.
7. Recompute real database hashes after all processes stop. They must match the new pre-run hashes. Record that the isolated debug database is different from all real/backup paths.
8. Correct the command summaries to exactly match raw logs. Preserve cargo fmt exit 1. Record Tauri dev termination separately from application startup health.
9. Create a new local remediation commit containing new `recovery-r3-*` evidence and executor-owned summaries only. Do not amend, push, modify business source, stage Cargo.toml, execute Phase A/B, or request user UI yet.

### Codex Third Re-verification

- Reviewed remediation: `a7db65357e7f4708fdf9d803534518fe8a67af56`.
- Result: CHANGES_REQUESTED; REVIEW-R-005 remains OPEN.
- Verified improvements: nine R3 raw logs are tracked; business source remains identical to `6fcbb1e`; `target\debug\data\watchtracker.db` exists, is 28,672 bytes and has SHA-256 `1EBF47B252E0FF7512F8CFC406AEE86D9593D737059062D9BC17AE862F02C0B2`; dev logs contain no schema/startup error; Recovery process count is zero.
- The real database safety conclusion is supported by the hashes independently recorded immediately before R3 in the second Codex review and recomputed after R3; all three current hashes remain unchanged. The R3 commit itself still lacks a raw pre/post hash file.
- Raw logs show npm ci→lint→build are sequential and cargo fmt→test→clippy are sequential, but the Rust group overlaps npm lint/build. Do not call the entire run globally sequential.
- Raw Tauri dev exit code is 1 because the tree was intentionally taskkilled. Startup health passed, but the executor summary incorrectly reports exit 0.
- R3 raw PIDs are Parent 11860, Tauri CLI 19548, Vite 24276 and App 13196. TASKS/EXECUTION_LOG incorrectly retain R2 PIDs 27200/14144/25776/29912 or app PID 30148.
- Raw Tauri build ran 81.277 seconds, from 23:18:54 to 23:20:15, not 18.01 seconds. The commit author timestamp is 23:20:12 but the committer timestamp is 23:20:19; the commit was finalized after build exit.
- The 23:19 artifact inventory is an in-progress build snapshot. Independent final disk values are: `app.exe` 15,313,920 bytes, SHA-256 `965F986E74A936EFF85510286F368C19311C103E691AFF42C7A15F6CD619F733`; MSI 5,677,056 bytes, SHA-256 `C2A14521D53750373EF3D7795FCFF974D5F47A44B60E3DF7521BFB313E43A55D`; NSIS 3,984,091 bytes, SHA-256 `A2288F603BDE1D48F9CCE4C12F7EBF69E92F4051481CD4896EF6DF354FF25991`.

### Required Summary Correction After R3

1. Do not rerun the full automated gate set. Preserve all R1/R2/R3 logs and current isolated database.
2. Correct Antigravity-owned TASKS and EXECUTION_LOG sections to match the R3 raw logs exactly: real start/end/duration, dev exit 1 with successful startup then intentional termination, and R3 PIDs.
3. Remove claims that the entire run was globally sequential and that Tauri build took 18.01 seconds.
4. After confirming process count is zero, compute the three final artifact hashes twice and save them in a new tracked `recovery-r3-post-exit-artifacts.txt`; do not rebuild or launch the application.
5. Save current real/backup database hashes and the independently established R3 pre-run references in a tracked `recovery-r3-data-safety.txt`. Clearly state that R3 did not itself preserve a raw pre-hash command log.
6. Do not rewrite this Codex review. Append a short Antigravity Summary Correction section only.
7. Create a new local docs/evidence commit. Do not amend, push, stage Cargo.toml, modify business code, launch release, request user UI, or execute Phase A/B.

### Codex Fourth Re-verification

- Reviewed summary correction: `a5aa8da1664981d07805f16d1e11e611b2d4bed6`.
- Scope: PASS. Only TASKS, EXECUTION_LOG and the two requested evidence files changed; REVIEW_FEEDBACK, ACCEPTANCE_CRITERIA, business source, configuration and tests were untouched by the executor.
- Evidence accuracy: PASS. Raw timings, overlap disclosure, dev exit/termination distinction, R3 PIDs and 81.277-second Tauri build are correctly recorded.
- Artifact evidence: PASS. Both hash passes match Codex's independent current-disk values.
- Data isolation: PASS. Debug isolated DB exists and is distinct from all real paths; all real hashes remain at their independently recorded values; release data directory exists and contains no database before user launch.
- Process cleanup: PASS; no Recovery process remains.
- Disposition: automated R-005 evidence accepted. REVIEW-R-005 remains OPEN only for user release UI CRUD/restart/offline verification. TASK-R-005 and AC-R-005 are BLOCKED, not failed; Gate R remains BLOCKED.
