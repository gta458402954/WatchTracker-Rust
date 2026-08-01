# Codex：最终验收报告指令

生成报告前确认所有必须任务均为 `ACCEPTED`，所有必须验收标准均有独立验证结果，必要构建和测试成功，并且没有未解决的高严重度问题。

阶段 A 完成时填写 `.agent-work/ACCEPTANCE_REPORT_BASELINE.md`；阶段 B 完成时填写 `.agent-work/ACCEPTANCE_REPORT_REGION.md`。每份阶段报告只能记录该阶段实际完成的独立验证。

两个阶段均完成后，填写 `.agent-work/ACCEPTANCE_REPORT.md` 作为综合报告，记录：

- Gate R 的双基线验证、最终恢复基线和 `RECOVERY_DECISION.md` 结论
- 验收日期、Git 分支、提交和工作区状态
- 原始需求、验收范围和范围外内容
- 实施及文件变更摘要
- 每项任务最终状态
- 每项验收标准结果、验证方式和证据
- Codex 独立运行的命令和结果
- 自动化测试与人工验证结果
- 安全、兼容性和回归检查
- 未解决问题、环境限制和残余风险
- 证据索引和最终建议
- 两份阶段报告的结论及其文件位置

验收项只能使用 `PASS`、`FAIL`、`NOT RUN`、`BLOCKED` 或 `NOT APPLICABLE`。最终结论只能是 `PASS`、`CONDITIONAL PASS`、`FAIL` 或 `BLOCKED`。

不得把 `NOT RUN`、`BLOCKED` 或缺少证据的项目算作 `PASS`。
