# 阶段 A：稳定基线验收报告

> 仅由 Codex 在独立验证后填写。未验证项目不得标记为通过。

## 1. 验收结论

`PASS`

## 2. 验收基线

- 验收日期：2026-07-30
- Git 分支：`codex/task-a-010`
- 验收对象：`64e9a533c98713026d1f60be562bc3e0fb55fccc`
- 独立验证：`D:\Project\Projects\WatchTracker-A010-Verify`，detached HEAD，业务内容干净
- 目标 Windows 环境：Windows x64；Node 24.18.0、npm 11.16.0、Rust/Cargo 1.97.1、Git 2.55.0.windows.3

## 3. 原始问题与复现结果

- 远端稳定基线 `6fcbb1e` 可构建运行，但本地 17 个提交后的 `29ea3a4` 存在 TypeScript 构建失败和过期 Playwright 回归；该坏基线已在恢复阶段独立复现并接受为调查结果。
- 原工作层还包含大量未提交修改、未跟踪文件、历史格式债务、错误截图/摘要和真实数据路径回退风险，不能作为可信继续开发基线。
- R-004 将 build 首坏提交定位为 `29ea3a4`，恢复路线因此从 `6fcbb1e` 重建，而不是整体合并坏工作层。

## 4. 修复内容

- A-001/A-002 建立可追溯环境、依赖和隔离启动基线。
- A-003 收口数据库原子更新、migration 和 setting 错误契约；A-004 统一便携/AppData 数据路径。
- A-005 建立初始化 loading/ready/error 三态、重试及统一错误反馈；A-006 完成本地 CRUD、导入恢复、锁定和离线安全流程。
- A-007 恢复前端与 Rust 全部门禁，移除 `auth.rs`/`error.rs` 的纯格式债务；A-008 完成 README、CI 和仓库产物治理。
- A-009 生成 Windows Release 产物并完成真实隔离 UI 冒烟；A-010 重跑全量门禁并提交本报告。

## 5. 环境与依赖验证

- 两个 A-010 pass 均从锁文件执行 `npm ci`；复验工作树固定在被审查提交并 detached。
- `npm ci` 继续报告既有 1 low / 3 high audit 项；本阶段未擅自升级依赖。
- 三处真实用户数据库在 A-010 前后及独立验证后，SHA-256、大小和 UTC mtime 全部一致，未检测到磁盘内容变化。

## 6. 启动与界面验证

- Implementation：本次 Release EXE 从三个预创建相邻 `data/` 的隔离副本启动，空库、当前库、升级库均进入真实 WatchTracker 主界面，无白屏和启动错误。
- Current fixture：新增、读取、重命名、电影改剧集、分类计数、重启持久化、用户确认删除、删除后重启均通过；无 TMDB/WebDAV 凭据时本地功能可用。
- Verification：第二次独立构建的 EXE 从全新 `D:\Project\Projects\WatchTracker-A010-Verify-Smoke` 启动，显示正常空状态并仅写入相邻便携数据目录。

## 7. 数据库与核心流程验证

- Rust 29/29 覆盖路径、原子 CRUD、Tombstone/generation、锁定记录、错误行容错、migration 原子回滚/重试、setting 缺失与查询失败区分。
- A-010 最终隔离 SQLite 状态：empty/current/upgrade 版本均为 18，记录数分别 0/2/2；升级库两条记录完整，合成旧列 `category`/`sortOrder` 已移除。
- 测试记录删除后数据库和重启界面均不再出现；两条初始合成记录保持不变。

## 8. 构建产物及冒烟测试

- Implementation：EXE 15,351,296 bytes；MSI 5,693,440 bytes；NSIS 3,994,856 bytes。
- Verification：EXE 15,351,296 bytes；MSI 5,693,440 bytes；NSIS 3,992,857 bytes。
- 两轮构建均自然退出 0 并生成完整 bundle；第二次 EXE 通过独立启动冒烟。
- 三项产物均 `NotSigned`；两轮 Hash 不同，因此不声明 byte-for-byte reproducible。

## 9. 命令与结果

| 命令 | 退出码 | 结果 | 证据 |
|---|---:|---|---|
| `npm run build` | 0 | PASS，606 modules | `review/TASK-A-010/01-npm-build.*` |
| `npm run typecheck` | 0 | PASS | `review/TASK-A-010/02-typecheck.*` |
| `npm run lint` | 0 | PASS | `review/TASK-A-010/03-lint.*` |
| `npm run test` | 0 | PASS，14/14 | `review/TASK-A-010/04-node-test.*` |
| `npx playwright test` | 0 | PASS，3/3 | `review/TASK-A-010/05-playwright.*` |
| `npm run tauri build` | 0 | PASS，EXE/MSI/NSIS | `review/TASK-A-010/06-tauri-build.*` |
| `cargo fmt -- --check` | 0 | PASS | `review/TASK-A-010/07-cargo-fmt.*` |
| `cargo clippy --all-targets --all-features -- -D warnings` | 0 | PASS | `review/TASK-A-010/08-cargo-clippy.*` |
| `cargo test` | 0 | PASS，29/29 | `review/TASK-A-010/09-cargo-test.*` |

## 10. 未解决问题、环境限制与风险

- npm audit 仍有 1 low / 3 high；需要单独依赖升级任务评估，不能在最终门禁中顺手修改。
- Windows 产物未签名；发布前需要代码签名与发布流程授权。
- 构建功能可重复但二进制 Hash 不可重复；NSIS 大小也有差异，未建立 reproducible-build 保证。
- GitHub Actions 工作流已在仓库中，但当前分支尚未 push，因此不声称存在本次提交的远端 CI 结果。
- Windows 工具链会输出本地化 linker import-library 信息；它没有使 strict Clippy 失败，但仍保留在原始日志中。
- `Cargo.toml` 在 Windows worktree 中显示 stat/EOL 噪声，内容 blob 与 HEAD 相同，未纳入提交。

## 11. 证据索引

- A-001：`.agent-work/TASKS.md` 中闭合的 REVIEW-A-001 与 `.agent-work/EXECUTION_LOG.md`。
- A-002~A-009：`.agent-work/evidence/review/TASK-A-002-CODEX-REVIEW.md` 至 `TASK-A-009-CODEX-REVIEW.md`。
- A-010 Implementation：`.agent-work/evidence/{builds,logs,screenshots,tests}/TASK-A-010/`。
- A-010 Verification：`.agent-work/evidence/review/TASK-A-010/` 与 `.agent-work/evidence/review/TASK-A-010-CODEX-REVIEW.md`。
- 验收条目：`.agent-work/ACCEPTANCE_CRITERIA.md` 中 AC-A-001~017 和 AC-GATE-001。

## 12. 最终建议

阶段 A 验收结论为 PASS，恢复后的 Windows 应用已达到当前定义的稳定基线。Gate A 的前置条件已满足，可以由 Owner 单独签发 Phase B；本结论不自动授权或启动任何 Phase B 业务修改。

## 13. Gate A 后残余收尾（2026-08-01）

- npm 锁文件已在不改变 `package.json` 声明范围的前提下更新，干净安装后的 `npm audit` 从 1 low / 3 high 降为 0。
- Vite ESM 配置已移除对 `__dirname` 的依赖，Vite 8.2.0 的原生配置加载兼容警告已消失；前端、Playwright、Rust 与两轮 Tauri Release 构建均通过。
- `Cargo.toml` 内容一致的 stat/EOL 噪声已通过索引刷新消除，没有重写或提交该文件。
- 两轮受控打包再次证明功能构建可重复，但 EXE/MSI/NSIS 哈希均不同，NSIS 大小相差 323 字节；字节级可复现仍不是当前保证。
- 三项 Windows 产物仍为 `NotSigned`，签名需要 Owner 提供代码签名证书及发布授权；远端 CI 仍需经授权 push/PR 后才能产生结果。
- 完整证据见 `.agent-work/evidence/review/RESIDUAL-HARDENING.md`。Phase B 与 DEFERRED 均未启动。
