# Antigravity：整改指令

完整读取 `.agent-work/REVIEW_FEEDBACK.md`、`TASKS.md`、`ACCEPTANCE_CRITERIA.md`、`SOLUTION.md` 和 `EXECUTION_LOG.md`。

只处理 `CHANGES_REQUESTED` 任务对应的 `OPEN` 审查意见：

1. 先复现问题并确定根因。
2. 实施范围最小但完整的修复。
3. 添加必要的回归测试。
4. 不得删除、跳过或放宽测试规避问题。
5. 运行指定验证和受影响模块的完整测试。
6. 保存新证据，并向执行日志追加整改记录；不得覆盖旧记录。
7. 将已处理意见改为 `RESOLVED_BY_IMPLEMENTATION`。
8. 将任务重新改为 `IMPLEMENTED`，等待 Codex 复验。

若审查意见与代码事实或需求冲突，不得直接忽略；保留 `CHANGES_REQUESTED`，记录证据并交由 Codex 或用户决定。
