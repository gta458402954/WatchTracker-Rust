# TASK-D-ARCH-001：跨语言记录契约生成

> 状态：IMPLEMENTED（2026-08-21）

## 目标

消除 `WatchRecord`、`UpdateWatchRecord`、记录枚举和值域在 Rust 与 TypeScript 之间的手工重复维护，并让字段或更新映射漂移在常规测试阶段直接失败。

## 单一事实源

`contracts/watch-record.schema.json` 是记录 IPC 契约的唯一手写来源，描述：

- JSON/camelCase 字段名与 Rust/snake_case 字段名；
- Rust 与 TypeScript 标量类型；
- 可空、前端可选和 serde 默认语义；
- `UpdateWatchRecord` 的普通可选与 `Patch<T>` 缺失/空值/有值三态；
- 状态、媒体类型和 TMDB 身份枚举值；
- 允许进入原子更新命令的字段集合。

`scripts/generate-contracts.mjs` 生成：

- `src/shared/types/watchRecord.generated.ts`；
- `src-tauri/src/watch_record_generated.rs`。

生成文件提交到 Git，供 TypeScript 和 Cargo 在没有额外工具或网络的环境中直接构建。生成文件不得手工编辑。

## 漂移门禁

- `npm run contracts:generate` 更新生成文件。
- `npm run contracts:check` 以只读方式重建并逐字比较生成结果。
- 检查同时核对 Rust 原子更新 SQL 映射与契约中的可更新字段，任何缺失或额外字段都会失败。
- `npm test` 首先执行契约检查，因此现有 CI 的 Node 测试门禁会自动覆盖契约漂移。

## 边界

本任务只生成核心记录 IPC DTO、枚举和值域及更新字段清单。收藏集、逐集历史和同步 envelope 仍由各自领域维护；在它们下一次发生跨语言结构变更时，可按相同 schema 机制逐域迁移，不在本任务中一次性重写。

数据库继续保持 V18，JSON 字段名、Tauri 命令、SQL schema、同步格式和业务校验均不改变。前端对部分数据库可空字段的既有收窄（例如表单中的空字符串）作为显式 `tsNullable` 兼容规则保留。

## 修改流程

1. 只编辑 `contracts/watch-record.schema.json`。
2. 运行 `npm run contracts:generate`。
3. 若字段可更新，同步实现 `db_atomic_update.rs` 的 SQL 映射。
4. 运行 `npm test`、typecheck、lint、build、Rust test/fmt/clippy。
