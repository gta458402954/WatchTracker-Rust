# WatchTracker：AI 协作流程

本文是本项目的 AI 协作操作手册。项目保留必要的任务、测试和验收记录，但从 `TASK-A-005` 起不再要求普通业务任务维护密码学提交证明链。

## 0. 当前执行模式与规则边界

- `TASK-A-004` 及以前已经开始的任务按各自既有合同、Runner、Safe Commit、Receipt 和独立验收规则完成。
- 从 `TASK-A-005` 起采用本文的简化流程。若旧 prompt、`.agent-work/tasks/*.json` 或历史治理说明与本节冲突，以本节为准。
- Antigravity 保持 `PAUSED / OPTIONAL`；未得到用户明确恢复授权前，后续任务由 Codex 执行。
- Codex 将工作分为 Implementation Pass 和 Verification Pass。Implementation Pass 可以实现和提交，但不能自行标记 `ACCEPTED`；Verification Pass 必须从已提交的干净 HEAD 或独立 worktree重新审查并运行必要验证。

### 0.1 `TASK-A-005` 起的简化流程

```text
确认依赖与工作区
→ 在独立任务分支/worktree 实施
→ 运行任务列出的验证
→ 按明确文件列表正常提交
→ 在干净 HEAD/独立 worktree 复验
→ ACCEPTED 或 CHANGES_REQUESTED
```

普通任务不再强制创建或使用 JSON 执行合同、Runner、Safe Commit、Receipt、Attestation、工具 Hash 或治理红队复测。

### 0.2 不可简化的安全底线

- 开始前检查 Git 状态，不覆盖、清除或重复实现已有修改。
- 禁止对真实用户数据库原地运行迁移、导入、恢复或破坏性测试；使用临时数据库或只读复制后的副本。
- 不在日志、截图或提交中保存凭据和不必要的个人数据。
- 禁止 `git add .`、`git add -A` 和 `git commit -a`；只暂存本任务逐项核对过的文件。
- 阶段 A 未经验收通过前，阶段 B 不得进入 `READY`；DEFERRED 本轮不得实施。
- 涉及路径、数据库或发布产物的高风险任务仍需隔离目录、前后 Hash 或真实产物冒烟证据。

## 1. 推荐配置

### Codex

- 模型：GPT-5.6 Sol
- 默认 Reasoning：Medium
- 以下情况临时使用 High：
  - 数据库迁移、导入、恢复或同步安全审查；
  - 跨前端、Rust 和数据库的疑难问题；
  - Antigravity 对同一问题连续两次修复失败；
  - 阶段发布前的最终深度验收。

普通文档整理、状态更新和报告汇总也可以使用 GPT-5.6 Terra Medium。

### Antigravity

- 当前状态：`PAUSED / OPTIONAL`。
- 恢复前必须由用户明确确认服务可用，并由 Codex 重新签发具体任务合同。

## 2. 角色边界

### 用户

- 维护 `.agent-work/REQUEST.md`；
- 决定业务范围和重大需求歧义；
- 审批方案；
- 决定是否接受环境限制或残余风险。

### Codex

- 检查实际代码库和现有未提交修改；
- 生成项目分析、实施方案、验收标准和任务；
- 在 Implementation Pass 中按 `TASKS.md` 的明确范围实施，在独立 Verification Pass 中重新运行测试并审查提交；
- 提出具体整改意见；
- 生成阶段验收报告和最终综合验收报告。

Codex 可以实施业务代码，但不能在 Implementation Pass 中自行宣布验收通过，也不能仅凭任何执行摘要宣布通过。

### Antigravity

当前暂停。以下边界仅在用户恢复 Antigravity 后适用：

- 只执行分配给自己的 `READY` 或 `CHANGES_REQUESTED` 任务；
- 修改代码、运行命令、保存证据；
- 记录真实执行结果和剩余风险；
- 根据 Codex 的审查意见整改。

Antigravity 不得改变原始需求、降低验收标准或自行把任务标记为 `ACCEPTED`。

## 3. 协作文件

| 文件 | 负责人 | 作用 |
|---|---|---|
| `.agent-work/REQUEST.md` | 用户 | 本次需求、范围和完成定义 |
| `.agent-work/PROJECT_ANALYSIS.md` | Codex | 当前架构、已有实现、风险和运行方式 |
| `.agent-work/SOLUTION.md` | Codex | 完整技术方案 |
| `.agent-work/ACCEPTANCE_CRITERIA.md` | Codex | 可执行、可判断的验收标准 |
| `.agent-work/TASKS.md` | Codex 主导 | 任务定义、依赖和状态交接 |
| `.agent-work/EXECUTION_LOG.md` | 当前执行者 | 修改文件、执行命令、退出码和结果 |
| `.agent-work/REVIEW_FEEDBACK.md` | Codex | 审查问题和整改要求 |
| `.agent-work/ACCEPTANCE_REPORT_BASELINE.md` | Codex | 阶段 A：稳定基线验收报告 |
| `.agent-work/ACCEPTANCE_REPORT_REGION.md` | Codex | 阶段 B：地区专项验收报告 |
| `.agent-work/ACCEPTANCE_REPORT.md` | Codex | 最终综合验收报告 |
| `.agent-work/evidence/` | 当前执行者 | 必要的构建、测试、日志和截图证据 |

## 4. 开始前检查

正式执行前应确认：

1. `.agent-work/REQUEST.md` 已经是当前版本；
2. 当前 Git 分支和工作区状态已经记录；
3. 已有未提交修改属于用户数据，不得覆盖或清除；
4. 最好建立一个可恢复的 Git 提交或备份点；
5. 真实用户数据库已经备份；
6. 后续迁移、恢复、导入和同步测试使用临时数据库或真实数据库副本；
7. 不在日志和证据中保存 TMDB/WebDAV 凭据及不必要的个人数据。

## 5. 总体状态流

```text
用户确认需求
    ↓
Codex 分析并生成方案、验收标准和任务
    ↓
用户审核方案
    ↓
Antigravity 实施阶段 A：恢复稳定基线
    ↓
Codex 独立验收阶段 A
    ├─ 不通过 → Antigravity 整改 → Codex 复验
    └─ 通过   → 生成稳定基线报告
                    ↓
Antigravity 实施阶段 B：地区动态化
    ↓
Codex 独立验收阶段 B
    ├─ 不通过 → Antigravity 整改 → Codex 复验
    └─ 通过   → 生成地区专项报告
                    ↓
Codex 生成最终综合验收报告
```

阶段 A 未通过前，不得将阶段 B 标记为完成，也不得实施 `.agent-work/REQUEST.md` 第 9 节中的后续路线图功能。

### 当前故障场景的 Recovery 前置门禁

当前项目存在“GitHub 最后可运行版本、其后17个本地提交、再叠加大量未提交修改”三层状态，因此在上述常规流程前增加：

```text
保全当前现场、旧产物和用户数据
→ 独立验证 origin/main@6fcbb1e
→ 独立验证干净 29ea3a4
→ 必要时 bisect 17 个提交
→ Codex 填写 RECOVERY_DECISION.md
→ 从最后绿色提交建立 codex/rebuild-from-stable
→ Gate R
→ 常规阶段 A
```

完整规则位于 `.agent-work/RECOVERY_REBUILD_PLAN.md`。Gate R 通过前，不得直接执行阶段 A/B 的业务修改。

## 6. 第一步：用户确认原始需求

检查 `.agent-work/REQUEST.md`，重点确认：

- 当前目标和优先级；
- P0 稳定基线要求；
- 地区专项规则；
- 明确不在当前范围内的功能；
- 测试要求；
- 两阶段完成定义。

如果仍有业务歧义，应先修改 `REQUEST.md`，不要让执行者自行猜测。

## 7. 第二步：Codex 生成方案和任务

在 Codex 中发送：

```text
请完整读取 .agent-work/prompts/CODEX_PLAN.md，并严格按照其中的要求执行。

原始需求位于 .agent-work/REQUEST.md。

请先检查当前 Git 状态和已有未提交实现，再分析整个项目。不得覆盖、清除或重复实现现有修改。

请将任务明确分为：
- 阶段 A：恢复运行和建立稳定基线；
- 阶段 B：地区动态化专项；
- DEFERRED：后续路线图，本轮禁止实施。

阶段 A 未被 Codex 验收为通过前，阶段 B 任务不得进入 READY。

本阶段不要修改业务代码。完成后向我汇报：
1. 当前项目和工作区状态；
2. 需求理解；
3. 实施方案；
4. 主要风险；
5. 需要用户确认的问题；
6. 阶段 A 和阶段 B 的任务数量及依赖。
```

Codex 应填写：

- `PROJECT_ANALYSIS.md`；
- `SOLUTION.md`；
- `ACCEPTANCE_CRITERIA.md`；
- `TASKS.md`。

### 任务要求

每项任务至少包含：

- 唯一编号，例如 `TASK-A-001`、`TASK-B-001`；
- Phase：`A`、`B` 或 `DEFERRED`；
- Owner：当前授权执行者；`TASK-A-005` 起默认为 `Codex`；
- Status；
- Priority；
- 依赖任务；
- 对应验收标准；
- 预计修改文件；
- 实施要求；
- 验证命令；
- 所需证据。

只有阶段 A 中依赖满足的任务可以先标记为 `READY`。阶段 B 初始状态应为 `DRAFT` 或 `BLOCKED_BY_GATE_A`。

## 8. 第三步：用户审核方案

用户重点检查：

1. `SOLUTION.md` 是否忠实于需求；
2. 是否把后续路线图错误纳入当前范围；
3. 是否保护真实用户数据；
4. `ACCEPTANCE_CRITERIA.md` 是否可以实际验证；
5. `TASKS.md` 是否明确区分阶段 A 和阶段 B；
6. 是否计划覆盖用户已有未提交修改。

需要修改时，在 Codex 中发送：

```text
请根据以下意见修订方案、验收标准和任务：

1. [填写意见]
2. [填写意见]

只修改 .agent-work 中的规划文档，不修改业务代码。修改后列出所有变化。
```

方案确认后再交给 Antigravity。

## 9. 历史流程：Antigravity 实施阶段 A

> 本节至第 11 节仅用于解释 `TASK-A-004` 及以前的历史记录。从 `TASK-A-005` 起使用第 0 节简化流程。

在 Antigravity 中发送：

```text
请完整读取 .agent-work/prompts/ANTIGRAVITY_EXECUTE.md，并严格按照其中的规则执行。

本轮只执行 .agent-work/TASKS.md 中：
- Phase 为 A；
- Owner 为 Antigravity；
- Status 为 READY；
- 所有依赖已满足的任务。

不要实施阶段 B 或 DEFERRED 任务。

必须先检查 Git 状态和现有未提交实现。不得覆盖用户修改，不得直接操作真实用户数据库。数据库迁移、导入、恢复和同步测试只能使用临时数据库、测试夹具或独立副本。

逐项实施、测试和保存证据，并更新：
- .agent-work/TASKS.md
- .agent-work/EXECUTION_LOG.md
- .agent-work/evidence/

完成的任务标记为 IMPLEMENTED，不得标记为 ACCEPTED。

本轮完成后汇报：
1. 已实施任务；
2. 修改文件；
3. 执行命令和结果；
4. 证据位置；
5. 阻塞和剩余风险；
6. 是否已经可以交给 Codex 验收阶段 A。
```

## 10. 第五步：Codex 验收阶段 A

在 Codex 中发送：

```text
Antigravity 已完成阶段 A 实施。

请完整读取 .agent-work/prompts/CODEX_REVIEW.md，并只审查 Phase A 中状态为 IMPLEMENTED 的任务。

你必须独立检查代码差异、执行日志和 evidence，并实际运行必要的前端、Rust、Tauri、数据库和核心流程验证。不得直接相信 Antigravity 的自报结果。

特别检查：
- Windows/Tauri 是否真正可以启动，而不只是 Vite 页面打开；
- 首次数据库、已有数据库副本和升级副本是否安全；
- 核心增删改查及重启持久化；
- 缺少 TMDB/WebDAV 凭据或网络失败时的本地可用性；
- 构建产物是否可以生成和启动；
- README 是否与实际命令和数据目录一致；
- 是否存在数据破坏风险或覆盖用户修改。

发现问题时更新 REVIEW_FEEDBACK.md，并将对应任务标记为 CHANGES_REQUESTED。完全通过时才能标记为 ACCEPTED。

如果阶段 A 全部通过，填写 .agent-work/ACCEPTANCE_REPORT_BASELINE.md；否则不要生成通过结论。
```

## 11. 第六步：整改循环

Codex 提出问题后，在 Antigravity 中发送：

```text
请完整读取 .agent-work/prompts/ANTIGRAVITY_REWORK.md。

本轮只处理 .agent-work/REVIEW_FEEDBACK.md 中状态为 OPEN、且对应任务状态为 CHANGES_REQUESTED 的问题。

先复现问题，再确认根因，实施最小且完整的修复，添加回归测试，运行指定验证并保存新证据。不得删除、跳过或放宽测试来规避问题。

完成后把审查意见标记为 RESOLVED_BY_IMPLEMENTATION，把任务重新标记为 IMPLEMENTED，等待 Codex 复验。
```

随后重新执行对应阶段的 Codex 验收指令。循环直至：

- 全部必须项通过；或
- 出现真实环境阻塞并由用户决定后续处理。

## 12. 第七步：开放并实施阶段 B

只有 `.agent-work/ACCEPTANCE_REPORT_BASELINE.md` 的最终结论为 `PASS`，或用户明确接受 `CONDITIONAL PASS` 的条件后，Codex 才能把阶段 B 中依赖满足的任务改为 `READY`。

先让 Codex 执行：

```text
阶段 A 已通过验收。请重新检查阶段 B 的依赖和当前代码状态，将可以开始的地区动态化任务标记为 READY。

如果阶段 A 的实现改变了原方案，请同步更新 SOLUTION.md、ACCEPTANCE_CRITERIA.md 和 TASKS.md，但不得降低原始需求标准，也不得扩大范围。
```

然后在 Antigravity 中执行：

```text
请完整读取 .agent-work/prompts/ANTIGRAVITY_EXECUTE.md。

本轮只执行 Phase 为 B、Owner 为 Antigravity、Status 为 READY 且依赖已满足的任务。不要实施 DEFERRED 路线图功能。

严格按照地区代码规范化、旧标签回退、动态统计、固定排序、多国作品、未知地区、TMDB 标签保护和测试要求实施。

完成后保存证据，更新 EXECUTION_LOG.md 和 TASKS.md，并将完成的任务标记为 IMPLEMENTED，等待 Codex 独立验收。
```

## 13. 第八步：Codex 验收阶段 B

在 Codex 中发送：

```text
Antigravity 已完成阶段 B 实施。

请完整读取 .agent-work/prompts/CODEX_REVIEW.md，只审查 Phase B 中状态为 IMPLEMENTED 的任务。

除常规代码审查外，必须独立验证：
- originCountry 优先和 contentTags 回退；
- UK 到 GB 的兼容；
- CN、HK、TW 独立统计和筛选；
- 多国作品去重计数和多地区命中；
- 未知地区；
- 两位兜底代码；
- 地区选项只受影视类型和观看状态影响；
- 固定优先地区和其余地区排序；
- 新增、编辑、删除、导入和同步后的动态更新；
- 用户自定义 contentTags 不被误删；
- 现有筛选功能和界面无回归。

独立运行验收标准要求的单元测试、Playwright、构建和适用的 Rust 检查。

发现问题时写入 REVIEW_FEEDBACK.md 并标记 CHANGES_REQUESTED；完全通过时标记 ACCEPTED，并填写 .agent-work/ACCEPTANCE_REPORT_REGION.md。
```

如有问题，继续使用第 11 节的整改循环。

## 14. 第九步：生成最终综合验收报告

阶段 A 和阶段 B 都完成后，在 Codex 中发送：

```text
请完整读取 .agent-work/prompts/CODEX_FINAL_REPORT.md。

重新检查：
- .agent-work/REQUEST.md
- .agent-work/ACCEPTANCE_CRITERIA.md
- .agent-work/TASKS.md
- .agent-work/EXECUTION_LOG.md
- .agent-work/REVIEW_FEEDBACK.md
- .agent-work/ACCEPTANCE_REPORT_BASELINE.md
- .agent-work/ACCEPTANCE_REPORT_REGION.md
- .agent-work/evidence/
- 当前代码、Git 状态和实际测试结果

只有经过 Codex 独立验证的项目才能标记为 PASS。不得把 NOT RUN、BLOCKED 或缺少证据的项目算作 PASS。

在 .agent-work/ACCEPTANCE_REPORT.md 生成最终综合验收报告，汇总两个阶段的结论、代码变更、命令结果、证据、未解决问题、环境限制、残余风险和最终建议。
```

## 15. 任务状态规则

```text
DRAFT
READY
IN_PROGRESS
IMPLEMENTED
REVIEWING
CHANGES_REQUESTED
BLOCKED
ACCEPTED
```

状态权限：

- Codex Implementation Pass：设置 `IN_PROGRESS`、`IMPLEMENTED` 或 `BLOCKED`，不得设置 `ACCEPTED`；
- Codex Verification Pass：设置 `REVIEWING`、`CHANGES_REQUESTED` 或 `ACCEPTED`；
- Antigravity：暂停；恢复后仍只能设置 `IN_PROGRESS`、`IMPLEMENTED` 或 `BLOCKED`；
- 用户：决定重大阻塞、范围变化和有条件通过是否可接受。

任何任务从 `CHANGES_REQUESTED` 返回后，都必须重新经过 `IMPLEMENTED -> REVIEWING -> ACCEPTED`，不能直接标记为通过。

## 16. 证据规则

证据保存到：

```text
.agent-work/evidence/builds/
.agent-work/evidence/tests/
.agent-work/evidence/screenshots/
.agent-work/evidence/logs/
```

建议命名：

```text
TASK-A-001-npm-build.txt
TASK-A-003-cargo-test.txt
TASK-A-005-tauri-build.txt
TASK-B-002-vitest.txt
TASK-B-004-playwright.png
```

每份证据应能对应到任务编号和验收标准。只写“测试通过”而没有命令、退出码或输出，不构成充分证据。

## 17. 验收结果规则

单项验收结果：

- `PASS`：Codex 已独立验证通过；
- `FAIL`：实际结果不符合预期；
- `NOT RUN`：没有执行；
- `BLOCKED`：受环境或外部条件限制；
- `NOT APPLICABLE`：经确认不适用。

报告最终结论：

- `PASS`：所有强制标准均通过；
- `CONDITIONAL PASS`：核心标准通过，但存在用户明确接受的非阻断限制；
- `FAIL`：至少一个强制标准失败；
- `BLOCKED`：关键验收因环境或外部条件无法完成。

## 18. 当前项目要求执行的主要命令

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

长时间运行的开发服务器需要启动、观察结果并正常停止，不能因命令需要持续运行就直接标记为失败。构建或测试产生的缓存和报告不得冒充源代码成果。

## 19. 阻塞处理

遇到阻塞时，执行者必须记录：

- 阻塞任务；
- 复现步骤；
- 实际错误；
- 已尝试的方法；
- 是否属于代码、环境、权限、凭据或外部服务问题；
- 继续工作所需的输入；
- 是否存在安全的替代验证方式。

不得因为工作困难、运行时间较长或测试失败而降低需求标准。需要用户授权扩大范围、操作真实数据、使用外部凭据或改变业务行为时，必须停止并请求用户决定。

## 20. 最简操作清单

日常使用时只需记住：

```text
1. 用户确认 REQUEST.md
2. Codex 执行 CODEX_PLAN.md
3. 用户审核方案
4. Antigravity 执行阶段 A
5. Codex 验收阶段 A
6. Antigravity 按 REVIEW_FEEDBACK.md 整改
7. Codex 复验并生成 BASELINE 报告
8. Antigravity 执行阶段 B
9. Codex 验收阶段 B
10. 整改和复验直至通过
11. Codex 生成 REGION 报告
12. Codex 生成最终 ACCEPTANCE_REPORT.md
```

任何时候都以 `.agent-work/REQUEST.md` 为业务范围来源，以 `.agent-work/ACCEPTANCE_CRITERIA.md` 为验收依据，以实际代码、命令结果和证据为最终事实来源。
