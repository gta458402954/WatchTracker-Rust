# 恢复基线决策记录

> 结论日期：2026-07-27（Australia/Perth）
> 决策人：Codex
> TASK-R-004：`ACCEPTED`
> 更新：TASK-R-005 已完成恢复分支复验及隔离 Release UI 验证，Codex 已将 AC-GATE-R 标记为 PASS，并仅开放 TASK-A-001。

## 1. 当前现场快照

- Snapshot branch：`codex/current-recovery-snapshot`
- 原始故障现场 HEAD：`29ea3a4fc82eeb5e0bcfda58d3f23fd97ed44006`
- WIP snapshot commit：`bffd6cc461e1a2e6fda4c4703198fbf5f2ae3a95`
- 备份整改 commit：`0f0697b994e894d7f96593496b50b5e46e396267`
- R-003 最终记录 commit：`cebde478dae2fa1d49d63d912da7e5987f719596`
- 物理备份：`D:\Project\Backups\WatchTracker-2026-07-27`，4,854 个文件，1,872,233,186 字节。
- 恢复说明：`D:\Project\Backups\WatchTracker-2026-07-27\recovery-notes\RECOVERY.md`
- 便携旧程序：`watch-tracker.exe`，SHA-256 `21580EE5F51414967733D0F8F83A6A9061FFD97EDE6229256FA07C74B0D08741`
- 公开发布旧程序：`WatchTracker.exe`，SHA-256 `FFA6B9F9AFBB7B579A8492ED411F0B3ED9DE9335BAC60349D7CBCCEC6B12EC89`
- 用户数据备份：`user-data/appdata`、`user-data/portable`、`user-data/public-release-data`；三组源/备份数据库 SHA-256 均已由 Codex 独立核对一致。
- 恢复验证：`PASS`（AC-R-001）。快照和物理备份只用于恢复与参考，不代表生产代码通过门禁。

## 2. GitHub 稳定候选结果

- Commit：`6fcbb1e0ae851c554c905676ee9164bfb3ea303e`
- Worktree：`D:\Project\Projects\WatchTracker-Stable-Verify`
- 环境：Node.js `v24.18.0`、npm `11.16.0`、rustc/cargo `1.97.1`、Git `2.55.0.windows.3`
- 依赖安装：`npm ci`，PASS。
- 前端门禁：`npm run lint`、`npm run build`，PASS。
- Rust：`cargo test` 与严格 `cargo clippy` PASS；`cargo fmt -- --check` 退出码 1，为未修改历史源码的格式差异。
- Tauri：dev 可启动；release `app.exe`、MSI、NSIS 可构建。最终核对的 release `app.exe` SHA-256 为 `375E24EF028F06CEB0CCF925AD0555A869EE24C0CC67F1BE9232CE6A757D6D2B`。
- 临时数据：用户通过真实桌面应用完成 Create/Read/Update/Delete；重启后更新仍存在；删除并再次重启后记录仍不存在；修改类型后分类正确。
- 数据安全：三个真实数据库测试前后 SHA-256 均一致；验证结束后无相关残留进程。
- 与旧二进制差异：新构建二进制 hash 不同，已验证的启动、CRUD、持久化、删除持久化和类型分类行为一致；未把未测试功能推断为完全一致。
- 结论：功能可复现且具有当前最完整的桌面证据；已知唯一基线门禁债务为历史 Rust 格式检查失败。
- 证据：`stable-*` 证据、`REVIEW_FEEDBACK.md#REVIEW-R-002`、用户手工验收记录。

## 3. 干净本地 HEAD 结果

- Commit：`29ea3a4fc82eeb5e0bcfda58d3f23fd97ed44006`
- Worktree：`D:\Project\Projects\WatchTracker-Head-Verify`
- 依赖安装、npm lint、Vitest、Rust test/clippy/fmt：PASS。
- TypeScript/typecheck：FAIL，退出码 2。
- 前端 build：FAIL，退出码 2。
- Playwright：FAIL，4/4 测试失败。
- Tauri dev：一次运行曾启动 debug 应用但遗留进程；整改重跑又被 5173 端口占用阻塞。所有遗留进程随后已清零。
- Tauri build：FAIL；beforeBuildCommand 被 TypeScript 错误阻断，没有 release EXE/MSI/NSIS。
- 临时数据 CRUD/重启：没有可验收的 release 产物，未通过。
- 当前 WIP 快照层：在 `cebde47` 上重新执行 `npm run build` 仍退出 2；错误缩减为 `RegionFilter` 未导出，以及 import handler 的 `WatchRecord[]`/`SyncPayload` 参数不兼容，说明未提交层没有形成可用修复基线。
- 结论：故障已存在于 17 个本地提交内；当前快照虽修复部分编译错误，但仍不可构建。
- 证据：`head-*` 证据、`REVIEW_FEEDBACK.md#REVIEW-R-003`、`bisect-R-004-reproduction.txt`。

## 4. Bisect 结果

- 隔离目录：`D:\Project\Projects\WatchTracker-Bisect`
- 判据：每个候选提交先执行 `npm ci`，再执行无真实数据副作用的 `npm run build`；退出码 0 为 good，非 0 为 bad。
- Good boundary：`38873240923c8efe145a3e16cd28065634417a0e`
- First bad commit：`29ea3a4fc82eeb5e0bcfda58d3f23fd97ed44006`
- 二分检查点：`8130100` good、`ac26566` good、`16c8922` good、`3887324` good；`29ea3a4` bad。
- 首坏提交主题：一次提交同时加入 Rust 原子事务模块并迁移前端数据库、WebDAV 和 Zustand 写入路径；14 个文件，新增 660 行、删除 43 行。
- 首坏复现：在 `29ea3a4` 执行 `npm ci` 后运行 `npm run build`，TypeScript 退出码 2。错误包括 Zustand store 缺失类型/函数导入、设置组件调用签名不匹配、WebDAV 不允许的 enum 语法和多个未使用符号。
- 父提交复现：同样命令在 `3887324` 退出码 0。
- 证据：`bisect-R-004-log.txt`、`bisect-R-004-reproduction.txt`。

### 4.1 “最后构建通过”不等于“最终绿色基线”

- `3887324`：typecheck/build PASS，但 ESLint FAIL（Playwright fixture 8 个 error），Vitest FAIL（误收集 Playwright spec）。
- `93b8f7c`：typecheck/lint/Vitest/build 与 `cargo test` PASS；但 `cargo fmt -- --check` 退出 1，严格 clippy 退出 101（`type_complexity`、`useless_conversion`）。它也没有经过真实桌面 CRUD/重启验收。
- 因此 `3887324` 只能称为 build-bisect 的 good boundary；不能称为完整绿色恢复基线。

## 5. 最终基线选择

- Selected commit：`6fcbb1e0ae851c554c905676ee9164bfb3ea303e`
- Recovery branch：`codex/rebuild-from-stable`
- Recovery worktree：`D:\Project\Projects\WatchTracker-Recovery`
- 选择理由：它是当前唯一同时具备干净源码构建、Tauri release 产物、真实桌面 CRUD/重启验证和真实数据不变证明的候选。后续提交虽包含有价值实现，但已出现渐进式质量门禁问题，并最终在 `29ea3a4` 形成编译阻断。
- 不选择 `3887324`：它只通过 build 判据，lint/Vitest 已失败，不能作为完整绿色起点。
- 不选择 `93b8f7c`：它缺少桌面运行证据，且严格 Rust clippy 失败。
- 不选择当前快照：仍有两个 TypeScript 编译错误，且同时混合原子事务、同步、地区和测试变更。
- 已知限制：`6fcbb1e` 的 `cargo fmt -- --check` 历史失败必须在恢复基线记录为已知债务；不得在 R-005 中假称全绿，也不得把格式化和业务迁移混为同一提交。

## 6. 改动处置

| 改动组 | 处置 | 依据 | 迁移波次 |
|---|---|---|---|
| 测试框架 | 重做 | `16c8922` 的配置使 ESLint 检查 fixture 报错，并让 Vitest误收集 Playwright spec；只迁移所需配置和测试意图 | Wave 0 |
| UI/组件重构 | 选择性重做，其余暂缓 | `eda30dc`、`3ae5bf4` 可作参考，但不为恢复运行整体搬运架构重构 | Wave 1/3，按需求切片 |
| Rust typed error / 网络缓存 | 选择性重做 | 有价值但需逐项测试；网络缓存曾触发严格 clippy `type_complexity` | Wave 1/4 |
| Zustand | 暂缓，必要时重做 | `29ea3a4` 的主要编译错误集中在 store 迁移；只有能证明解决统一写入口/StrictMode 时才引入 | Wave 3 |
| 数据库列名/迁移 | 重做 | schema/IPC 翻译风险高；需旧 schema、事务回滚和幂等测试后逐步迁移 | Wave 2 |
| 原子 CRUD | 重做，不 cherry-pick `29ea3a4` | Rust 测试和实现可作参考，但首坏提交同时改动过多且前端接线不完整 | Wave 3 |
| 导入/恢复 | 重做 | 从原子本地 CRUD 绿色基础上再实现；复用不变量和测试，不整块覆盖 | Wave 4 |
| WebDAV 同步 | 暂缓后重做 | 多个高耦合提交涉及 tombstone、generation、锁定记录和远端写入，必须独立验收 | Wave 4 |
| 路径/交付治理 | 重做 | 统一数据根目录、文档、CI 和可交付构建，避免覆盖旧产物 | Wave 5 |
| 地区动态化 | 暂缓 | 当前快照实现和测试仅作参考；Gate A 前不得实施 | Wave 6 |
| `.agent-work` 协作文档与恢复证据 | 保留 | 属于恢复治理记录，不进入生产源码迁移 | 持续维护 |

迁移原则：不得整体 cherry-pick `29ea3a4` 或把 `bffd6cc` 的业务源码整树覆盖到恢复分支；每个切片必须对应 REQUEST/AC，先有测试，再做最小实现，并单独提交和验收。

## 7. Gate R 结论

- AC-R-004：`PASS`。
- TASK-R-004：`ACCEPTED`。
- 故障层级：17 个已提交改动；build 首坏提交为 `29ea3a4`，当前未提交层仍未修复完成。
- 最终恢复基线：`6fcbb1e`。
- TASK-R-005：`ACCEPTED`。恢复分支、独立 worktree、自动证据、隔离数据路径和用户 Release UI 验证均已完成复核。
- AC-GATE-R：`PASS`。`TASK-A-001` 已开放为 `READY`；后续 Phase A/B 任务仍须遵守各自依赖和验收门禁。
