# AI 协作文件所有权

本文件、`.agent-work/REPOSITORY_ID`、`.agent-work/tasks/*.json` 和
`.agent-work/schemas/*` 由 Codex 管理。执行者只能读取，不能通过修改合同、Schema、
预算、BASE、失败策略或受保护区域扩大权限。

## 权威顺序

- stdout/stderr 内容：`evidence/raw` 原始日志。
- 退出码、单调持续时间、终止原因：Runner 生成的 step manifest。
- 进程身份与父子关系：Runner 生成的 process manifest。
- 文件大小与 SHA-256：Evidence Manifest。
- `evidence/summary`：由脚本从 manifest 生成，不是第二套事实来源。
- `executor-notes.md`：非权威备注；发生冲突时不得覆盖上述事实。

## Reviewer-owned

- `.agent-work/OWNERSHIP.md`
- `.agent-work/REPOSITORY_ID`
- `.agent-work/tasks/*.json`
- `.agent-work/schemas/*`
- `.agent-work/REVIEW_FEEDBACK.md`
- `.agent-work/ACCEPTANCE_CRITERIA.md`
- Markdown 中 `OWNER:CODEX` 标记区域
- 正式任务状态与验收结论

## Executor-owned

- 合同授权的业务源码和测试区域
- `.agent-work/evidence/raw/<task-id>/`（只允许 Runner 创建，执行者不得手改）
- `.agent-work/evidence/generated/<task-id>/`（只允许工具生成）
- 合同指定的 `executor-notes.md`

## Shared, append-only

- `.agent-work/TASKS.md` 的 `Execution Result` 执行者区域
- `.agent-work/EXECUTION_LOG.md` 的 `Antigravity Execution` 区域

共享文件必须使用合同中的唯一锚点限制可编辑区域。Expected File 不代表允许整文件
重写；BOM、行尾、文件模式和非目标区域仍受保护。

## 提交规则

- 执行 worktree 开始时暂存区必须为空；工具不得 reset、restore 或清理用户暂存区。
- 禁止 `git add .`、`git add -A`、`git commit -a` 和直接 `git commit`。
- 执行提交只能通过 `SAFE_COMMIT.ps1`。
- 没有合同 Hash trailer 和 Safe Commit receipt 的执行提交自动失去验收资格。
- Hook 和脚本是同权限环境下的工程护栏，不构成针对恶意同权限主体的安全边界。
