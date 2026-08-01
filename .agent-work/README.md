# AI 协作工作区

本目录用于 Codex 与 Antigravity 通过文件进行可审计的协作。

## 角色

- 用户：维护 `REQUEST.md`，决定业务范围和需求歧义。
- Codex：分析项目、制定方案、拆解任务、审查实现并生成最终验收报告。
- Antigravity（Gemini 3.6 Flash）：实施任务、运行验证并保存证据。

## 文件所有权

| 文件 | 主要维护者 | 用途 |
|---|---|---|
| `REQUEST.md` | 用户 | 原始需求和范围 |
| `RECOVERY_REBUILD_PLAN.md` | Codex | 当前故障场景的双基线恢复方案 |
| `RECOVERY_DECISION.md` | Codex | 双基线结果、故障定位和最终基线选择 |
| `PROJECT_ANALYSIS.md` | Codex | 当前项目分析 |
| `SOLUTION.md` | Codex | 完整实施方案 |
| `ACCEPTANCE_CRITERIA.md` | Codex | 可验证验收标准 |
| `TASKS.md` | Codex 主导 | 任务定义和状态交接 |
| `EXECUTION_LOG.md` | Antigravity | 实际修改、命令和结果 |
| `REVIEW_FEEDBACK.md` | Codex | 审查问题和整改要求 |
| `ACCEPTANCE_REPORT_BASELINE.md` | Codex | 阶段 A：稳定基线验收报告 |
| `ACCEPTANCE_REPORT_REGION.md` | Codex | 阶段 B：地区专项验收报告 |
| `ACCEPTANCE_REPORT.md` | Codex | 最终独立验收报告 |
| `evidence/` | Antigravity | 构建、测试、截图和日志证据 |

## 工作流程

1. 用户填写 `REQUEST.md`。
2. 当前故障场景先执行 `RECOVERY_REBUILD_PLAN.md` 的 Recovery Phase。
3. Codex 在 `RECOVERY_DECISION.md` 选择最后绿色恢复基线；Gate R 通过后才开放阶段 A。
4. Antigravity 使用 `prompts/ANTIGRAVITY_EXECUTE.md` 执行 `READY` 任务。
5. Codex 使用 `prompts/CODEX_REVIEW.md` 独立复核。
6. 如需整改，Antigravity 使用 `prompts/ANTIGRAVITY_REWORK.md`。
7. 阶段 A 通过后，Codex 生成 `ACCEPTANCE_REPORT_BASELINE.md`。
8. 阶段 B 通过后，Codex 生成 `ACCEPTANCE_REPORT_REGION.md`。
9. 全部通过后，Codex 使用 `prompts/CODEX_FINAL_REPORT.md` 生成综合报告。

## 任务状态

```text
DRAFT -> READY -> IN_PROGRESS -> IMPLEMENTED -> REVIEWING -> ACCEPTED
                                      ^              |
                                      |              v
                                      +--- CHANGES_REQUESTED
```

任务无法继续时使用 `BLOCKED`。只有 Codex 可以将任务标记为 `ACCEPTED`。

## 验收结果

- `PASS`：Codex 已独立验证通过。
- `FAIL`：验证失败。
- `NOT RUN`：尚未执行验证。
- `BLOCKED`：因环境或外部条件无法验证。
- `NOT APPLICABLE`：确认不适用。

`NOT RUN` 和 `BLOCKED` 不得计作 `PASS`。
