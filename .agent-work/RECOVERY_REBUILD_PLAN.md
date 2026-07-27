# WatchTracker 恢复重建方案 V2

> 方案日期：2026-07-27（Australia/Perth）  
> GitHub 稳定候选：`origin/main@6fcbb1e0ae851c554c905676ee9164bfb3ea303e`  
> 本地已提交候选：`29ea3a4fc82eeb5e0bcfda58d3f23fd97ed44006`  
> 当前工作区：本地 HEAD 之上仍有大量未提交修改  
> 本方案只设计恢复路径；执行前不得 reset、checkout、clean、覆盖当前工作区或操作真实用户数据库。

## 1. 决策结论

不再把“直接修复当前脏工作区”作为默认路径。采用“保全现场、双基线验证、故障定位、从最后绿色基线选择性迁移”的恢复策略：

1. 当前目录只作为故障现场、实现参考和测试来源保留。
2. 在独立 Git worktree 中验证 GitHub `6fcbb1e` 是否能从源码干净构建和运行。
3. 在另一个独立 worktree 中验证不含未提交修改的本地 `29ea3a4`。
4. 根据两个结果决定：
   - `6fcbb1e` 通过、`29ea3a4` 失败：定位 17 个提交中的首个故障，最终从稳定提交重建；
   - 两者都通过：故障位于当前未提交修改，只重放必要的未提交变更；
   - `6fcbb1e` 也失败：先恢复工具链/构建环境，不迁移功能；
   - 两者都失败但表现不同：分别记录，不把两个问题混成一个修复任务。
5. 只有恢复门禁 Gate R 通过后，原 Phase A 才能进入实施；Phase B 地区专项继续受 Gate A 阻塞。

## 2. 已确认事实

- GitHub 默认分支为 `main`，远端 HEAD 是 `6fcbb1e`。
- 本地 HEAD 是 `29ea3a4`，相对 GitHub 稳定候选超前 17 个提交。
- 这 17 个提交同时包含 WebDAV、数据库列名迁移、错误类型、Zustand、组件拆分、Rust 合并、Playwright 和原子事务等高耦合变化。
- 远端稳定候选到当前工作区的累计差异约为 72 个文件、6889 行新增、2101 行删除；当前未提交层本身约有 31 个受控文件变化、1907 行新增、914 行删除。
- 当前未提交代码包含有价值的原子事务、回滚测试、地区实现和 E2E mock，不能删除，但也不能未经验证直接作为恢复基线。
- 旧编译产物仍能运行，只能作为用户可见行为的 Golden Baseline；必须另行证明对应源码在当前环境能够重现构建。

## 3. 恢复工作区拓扑

推荐保留四个逻辑区域：

```text
D:\Project\Projects\WatchTracker-GitHub-Source
  当前故障现场；只读参考，完成快照前禁止继续业务修改

D:\Project\Projects\WatchTracker-Stable-Verify
  origin/main@6fcbb1e；只用于稳定源码复现

D:\Project\Projects\WatchTracker-Head-Verify
  29ea3a4；只用于验证17个已提交改动，不包含当前未提交层

D:\Project\Projects\WatchTracker-Recovery
  最终恢复分支；从决策选出的最后绿色提交建立
```

分支建议：

```text
codex/current-recovery-snapshot   当前完整现场的本地快照分支，不推送
codex/rebuild-from-stable         最终恢复实施分支
```

验证 worktree 可以使用 detached HEAD，避免生成无意义分支。所有 worktree 使用各自的 `node_modules` 和 Rust target，避免缓存污染验证结果。

## 4. Phase R0：保全现场与数据

### 4.1 当前源码快照

快照必须覆盖：

- 本地 17 个提交；
- 受控文件的未提交差异；
- 未跟踪源码、测试、文档和 `.agent-work`；
- 当前 Git 状态、远端、分支、HEAD、diff stat 和文件清单；
- 当前工具链版本。

推荐方式是创建仅保存在本机的 `codex/current-recovery-snapshot` 分支并做一次明确标记为 WIP/Recovery Snapshot 的提交。该提交只用于恢复，不代表代码通过，也不得推送为发布版本。

如果用户不允许创建快照提交，则必须使用可验证的完整目录副本和二进制 patch/未跟踪文件清单；在确认副本可读之前不得进入下一步。

### 4.2 可运行产物与真实数据

- 完整保留仍能运行的旧产物、同目录依赖和配置。
- 记录产物路径、大小、SHA-256、修改时间和已知功能表现。
- 完全退出应用后才能复制 SQLite 数据及相关 sidecar 文件。
- 真实用户数据备份与源码 worktree 分离保存，不加入 Git。
- 后续验证只能使用合成数据、临时数据库或真实数据的独立副本。
- 不得让两个版本同时打开同一数据库或数据目录。

## 5. Phase R1：验证 GitHub 稳定源码

### 5.1 创建干净验证环境

从 `origin/main@6fcbb1e` 创建独立 worktree。不得复制当前 `node_modules`、`target`、`dist`、配置或测试产物。

稳定候选的 `package.json` 没有 `typecheck`、`test` 和 Playwright 脚本，因此基线验证只能运行该提交实际存在的命令，不能因为缺少后加脚本而判定失败。

### 5.2 验证顺序

```powershell
npm ci
npm run lint
npm run build

Set-Location src-tauri
cargo fmt -- --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

然后回到项目根目录验证：

```powershell
npm run tauri dev
npm run tauri build
```

若稳定提交当年没有满足当前更严格的 fmt/clippy 标准，应区分“源码无法运行”与“新增质量门禁未满足”。稳定门禁的核心是：锁文件安装、前端构建、Rust 编译、Tauri 启动、测试数据 CRUD、重启持久化和构建产物启动。

### 5.3 Golden Baseline 行为记录

使用临时数据验证并记录：

- 首次启动；
- 加载现有数据库副本；
- 新增、查看、编辑、删除；
- 重启持久化；
- 搜索、类型、状态、评分、锁定和排序；
- 设置读取保存；
- 无 TMDB/WebDAV 凭据时的本地可用性；
- 数据库、日志和海报实际路径；
- 导入、导出、备份、恢复和 WebDAV 的已知安全边界。

旧二进制与稳定源码构建产物应使用同一套测试数据副本和步骤比较。差异必须记录，不能默认二者完全对应。

## 6. Phase R2：验证干净本地 HEAD

从 `29ea3a4` 创建独立 worktree，不应用当前未提交差异。

运行该提交实际具备的完整门禁：

```powershell
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
npx playwright test
npm run tauri dev
npm run tauri build

Set-Location src-tauri
cargo fmt -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

浏览器 mock E2E 通过不等于 Tauri/SQLite 通过。必须重复稳定基线的真实桌面和临时数据库冒烟步骤。

## 7. Phase R3：决策与故障定位

### 7.1 决策矩阵

| `6fcbb1e` | `29ea3a4` | 结论 | 后续路径 |
|---|---|---|---|
| 通过 | 通过 | 17 个提交本身可运行，故障主要位于当前未提交层 | 从 `29ea3a4` 建恢复分支，按主题小批重放未提交修改 |
| 通过 | 失败 | 已提交演进中引入回归 | 在 17 个提交中 bisect，最终从最后绿色提交重建 |
| 失败 | 未执行/失败 | 稳定源码受当前工具链或环境影响 | 只修构建环境/最小兼容，不迁移功能 |
| 通过 | 环境阻塞 | 无法判断本地 HEAD | 解决同一环境阻塞后重试，不提前选基线 |

### 7.2 Bisect 策略

如果 `29ea3a4` 失败：

1. 先选择稳定、无真实数据副作用且能自动判断的命令作为 bisect 判据，例如 `npm run build` 或 `cargo test`。
2. 对只能人工判断的 Tauri 启动/CRUD 故障，使用手动二分；17 个提交最多约 5 次二分即可定位首个坏提交。
3. 每个候选提交使用独立/清洁依赖和临时数据目录，避免旧缓存改变结果。
4. 记录首个失败提交、失败表现、依赖提交和最小差异。
5. 首个坏提交之后的提交不能整体判废；按需求价值和依赖关系选择性移植。

### 7.3 基线选择记录

Codex 必须生成 `.agent-work/RECOVERY_DECISION.md`，至少包含：

- 两个基线的提交号、环境和完整结果；
- 旧二进制与源码构建产物的行为差异；
- 首个坏提交（如适用）；
- 最终选中的恢复基线；
- 放弃直接修当前工作区或选择该路径的证据；
- 计划保留、重做、暂缓的改动清单。

没有该记录不得通过 Gate R。

## 8. Phase R4：建立最终恢复分支

最终恢复分支 `codex/rebuild-from-stable` 从决策选出的最后绿色提交创建，而不是固定假设必须从 `6fcbb1e` 开始。

建立后立即重复该提交的绿色门禁，并创建“恢复基线”提交或标签。之后每个迁移波次都必须满足：

```text
开始前绿色
→ 一个逻辑切片
→ 相关单测
→ 全量静态检查/构建
→ 必要的真实桌面冒烟
→ Codex 审查
→ 独立提交
```

失败时只回退当前波次，不回退已经验收的绿色波次。

## 9. 选择性迁移原则

### 9.1 不按提交数量追求“全部找回”

迁移依据是当前 `REQUEST.md`，不是“本地已有代码都必须进入新分支”。以下变化默认不自动移植：

- 仅为重构而重构的大组件拆分；
- 与当前验收无关的架构抽象；
- 没有测试证明价值的性能调整；
- 会扩大当前范围的路线图能力；
- 构建产物、测试报告和一次性脚本。

### 9.2 使用现有代码的方式

优先顺序：

1. 先阅读当前实现和测试，提炼行为与不变量；
2. 能安全 cherry-pick 的单一、低耦合提交可以单独移植；
3. 高耦合提交使用路径级/函数级人工移植，不整体 cherry-pick；
4. 测试可以先移植为失败测试，再实现最小生产代码；
5. 每次移植必须能明确指出对应需求和验收标准。

## 10. 建议迁移波次

### Wave 0：恢复测试与诊断能力

- 加入必要的 Vitest/Playwright/类型检查配置，但不改变业务行为。
- 建立 Golden Baseline CRUD、启动和数据路径记录。
- 保证测试 mock 不替代真实 Tauri/SQLite 冒烟。

### Wave 1：启动、错误状态和文档真实性

- 明确 `loading/ready/error` 和重试；
- 建立最小统一用户错误反馈；
- 校正文档、数据目录说明和日志脱敏；
- 不在此波次迁移 Zustand、同步或数据库架构。

### Wave 2：数据库迁移和设置错误语义

- 每个 migration 与 `db_version` 同一事务；
- `get_setting` 只把 NoRows 当作无值；
- 建立旧 schema、失败回滚和安全重试夹具；
- 不直接对真实用户数据库试验。

### Wave 3：原子本地 CRUD 垂直切片

- 先实现/移植 Rust typed DTO、系统字段保护、Rust 时间戳和原子 update/delete/restore；
- 再接入前端唯一写入入口；
- 每个 CRUD 独立通过 record/Tombstone/generation 回滚测试和真实桌面冒烟；
- Zustand 只有在证明可解决 StrictMode/统一入口且迁移成本可控时才引入，不作为预设目标。

### Wave 4：导入、恢复与同步提交

- 先导入/恢复事务，再同步快照/提交；
- generation、commitId 和 payload hash 按不变量逐项移植；
- WebDAV PUT 与本地 SQLite 的非分布式事务限制必须记录；
- dirty/outbox、主动拉取、目标隔离仍属 DEFERRED，不借机实施。

### Wave 5：路径统一、可交付构建和仓库治理

- 在用户确认便携模式语义后统一 DB、日志、海报、备份和协议路径；
- 更新 README、原子 API 文档、CI 和 `.gitignore`；
- 生成 Windows 产物并用独立临时数据冒烟；
- 完成原 Phase A 全量验收。

### Wave 6：地区动态化专项

- 仅在 Gate A 通过后开放；
- 从当前工作区选择性移植 `countryNames.ts`、分类纯函数、UI 接线和测试；
- 修正 UK/GB、NA、未知地区、固定顺序、失效选择和 E2E 缺口；
- 完成 Gate B 和最终综合验收。

## 11. 17 个提交的处理策略

| 变化组 | 相关提交示例 | 默认处理 |
|---|---|---|
| 筛选/组件拆分 | `eda30dc`、`3ae5bf4` | 只移植当前需求需要的部分，不因“代码更漂亮”整体迁移 |
| WebDAV 一致性 | `def114e`、`f608fc6`、`2098324`、`56cc62b` | 高风险；在 Wave 4 按不变量人工移植并单独验收 |
| SQLite 列名和 IPC 翻译 | `ed3ff3b`、`8130100` | 先验证是否为后续必要依赖；如果不是，不迁移 schema 风险 |
| Rust 错误/网络 | `7b0ddb4`、`a86aec9` | 只移植能改善当前验收且测试充分的最小部分 |
| Zustand | `4bdfa92`、`ac26566`、`93b8f7c` | 不预设必须迁移；以 StrictMode、统一入口和回归证据决定 |
| 测试框架 | `16c8922` | 优先移植测试能力，但先确保不改变生产行为 |
| 原子 DTO/事务 | `3887324`、`29ea3a4` | Wave 3/4 分解为垂直切片，不整体带入 |

## 12. 分支与提交规则

- 不在 `main` 直接继续开发。
- 不对当前故障现场执行 hard reset、checkout 覆盖或广泛 clean。
- 每个波次使用独立、可描述的提交；不要把测试框架、schema、UI 和同步混在一个提交。
- 每个提交消息标明需求/任务编号。
- 只有 Gate A/B 验收完成后才考虑合并或推送；本方案不授权推送、PR 或发布。

## 13. 数据安全与回滚

- 旧可运行程序继续作为应急版本，不被新构建覆盖。
- 新旧版本不能共享活动数据库。
- 每个数据库测试记录临时路径、schema/version、前后行数和必要 hash。
- 迁移失败必须回滚；不允许通过删除数据库“修复”。
- 每个迁移波次的回滚单位是该波次独立提交。
- 真实用户数据只在用户另行授权后以副本验证，并先建立恢复备份。

## 14. Gate R 完成定义

只有以下全部满足，原 Phase A 才能开放：

1. 当前源码、未提交文件、可运行旧产物和用户数据均有独立、可验证的恢复路径。
2. GitHub `6fcbb1e` 已在干净 worktree 从源码验证并记录结果。
3. 本地 `29ea3a4` 已在干净 worktree验证并记录结果，或有明确且可复核的环境阻塞。
4. 若 `29ea3a4` 失败，已定位首个坏提交或形成足以选择最后绿色提交的证据。
5. `.agent-work/RECOVERY_DECISION.md` 已由 Codex 审查通过。
6. 最终恢复分支从最后绿色提交创建，并重复通过基线门禁。
7. 当前 Phase A/B 任务已重新映射到迁移波次，未把 DEFERRED 能力混入。

## 15. 最终交付结构

```text
.agent-work/
├── RECOVERY_REBUILD_PLAN.md       本方案
├── RECOVERY_DECISION.md           双基线结果与最终基线选择
├── PROJECT_ANALYSIS.md            项目事实和缺口
├── SOLUTION.md                    Gate R 后的目标架构方案
├── ACCEPTANCE_CRITERIA.md         Gate R/A/B 验收标准
├── TASKS.md                       Recovery、Phase A、Phase B 任务
├── evidence/recovery/             双基线、bisect 和快照证据
├── ACCEPTANCE_REPORT_BASELINE.md  阶段 A 报告
├── ACCEPTANCE_REPORT_REGION.md    阶段 B 报告
└── ACCEPTANCE_REPORT.md           综合报告
```

本恢复方案优先保证“每一步都能回到最后绿色状态”。成功标准不是把所有旧改动搬回来，而是在不损失用户数据的前提下，重新得到可从源码构建、可运行、可测试、可解释的 WatchTracker。
