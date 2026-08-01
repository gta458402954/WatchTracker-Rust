# AI 协作文件所有权

本文件及正式任务状态由 Codex 管理。`.agent-work/tasks/*.json`、Schema、Runner、
Receipt 和 Attestation 是 `TASK-A-004` 及以前任务的历史治理记录；从 `TASK-A-005`
起不再是普通任务的执行前置条件。

## `TASK-A-004` 及以前的权威顺序

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
- `.agent-work/ACCEPTANCE_REPORT_REGION.md`
- `.agent-work/ACCEPTANCE_REPORT.md`
- Markdown 中 `OWNER:CODEX` 标记区域
- 正式任务状态与验收结论

## Executor-owned

> Antigravity remains paused. From `TASK-A-005`, “Executor” means the Codex
> Implementation Pass working within the file scope in `TASKS.md`. The subsequent
> Verification Pass uses a clean HEAD or independent worktree and does not treat the
> implementation summary as acceptance evidence.

- `TASKS.md` 明确列出的业务源码和测试区域
- 任务必要的测试日志、截图和脱敏诊断
- `EXECUTION_LOG.md` 中该任务的实施摘要

## Shared, append-only

- `.agent-work/TASKS.md` 的 `Execution Result` 执行者区域
- `.agent-work/EXECUTION_LOG.md` 中对应任务的实施区域

共享文件只修改对应任务区域。Expected File 不代表允许整文件重写；BOM、行尾、
文件模式和非目标区域仍受保护。

## `TASK-A-005` 起的提交规则

- 任务 worktree 开始时应为空；发现已有修改时先识别所有者和范围，不得 reset、restore、覆盖或清理。
- 禁止 `git add .`、`git add -A`、`git commit -a`；只按明确路径暂存并在提交前复核 staged diff。
- 允许正常 `git commit`，不要求 JSON 合同、Safe Commit、Receipt 或 Attestation。
- 提交必须包含单一任务的相关改动；业务实现与独立验收结论不得伪装成同一步完成。
- Verification Pass 必须检查提交范围、运行必要测试，并将结论记录为 `ACCEPTED` 或 `CHANGES_REQUESTED`。
- 涉及真实数据、凭据、外部发布或不可逆操作时，仍需用户明确授权。

## Current Phase B assignment

- `TASK-B-001`: Owner `Codex`; Status `ACCEPTED`; implementation `b70aa24` passed an independent clean detached Verification Pass.
- `TASK-B-002`: Owner `Codex`; Status `ACCEPTED`; implementation `0f15a84` passed an independent clean detached Verification Pass.
- `TASK-B-003`: Owner `Codex`; Status `IMPLEMENTED`; BASE `6202f85d86a6e0b8611e6135cec479306a8768fc`; branch/worktree `codex/task-b-003` / `D:\Project\Projects\WatchTracker-B003`. The Implementation Pass is complete and awaits an independent Verification Pass; AC-B-005/006 remain NOT RUN.
- `TASK-B-004`~`TASK-B-005`: not authorized for implementation; remain `BLOCKED` until their dependencies are accepted and Codex separately reassigns them.
- Antigravity remains paused. Future Phase B Implementation Passes may update their task to `IMPLEMENTED` at most; only an independent Verification Pass may mark a task `ACCEPTED`.

## Phase B integration ownership

- Canonical integration branch: `codex/phase-b-integration`, created from accepted TASK-B-002 review `d56686193a3c48af540ab98887f27ac8ab11f0cb`.
- `codex/phase-b-complete` and its worktrees are quarantined reference material only; no commit or uncommitted hunk from them has authority to enter the integration branch without a later task contract and independent review.
- Each remaining B task receives its own task branch/worktree from the latest accepted integration HEAD. Its implementation and review commits remain separate, and only an `ACCEPTED` task may advance the integration branch.
- No Phase B branch is merged to `main` before TASK-B-005, AC-B-001~008, the region report and AC-GATE-B are complete. Push/PR/merge still require the normal user-authorized external workflow.
