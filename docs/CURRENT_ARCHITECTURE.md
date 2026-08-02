# WatchTracker 当前架构

> 更新时间：2026-08-02（Australia/Perth）
> 权威源码：本仓库 `main`；正式便携版的精确构建提交号显示在应用顶部栏
> 本文描述当前可构建实现，不把历史故障快照或路线图能力写成现有功能。

## 1. 当前结论

- 前端使用 React Hook `useWatchList` 管理记录状态；当前没有 Zustand 依赖或 `src/store/useWatchListStore.ts`。
- SQLite schema 当前为 V18，records 表使用 `createdAt`、`originalName`、`revActor` 等 camelCase 列名。
- 本地新增、更新、删除和全量替换由 Rust/SQLite 事务实现，并在同一事务中维护 Tombstone 与 `records_generation`。
- WebDAV 当前使用 schema v2、时间戳合并和简单 Tombstone；没有完整接入 `expectedGeneration`、`SyncCommit`、ETag compare-and-swap、持久化 outbox 或主动拉取。
- 数据根目录由单一 `AppPaths` 解析，数据库、日志、海报和备份共享同一个结果。
- 前端初始化明确区分 `loading | ready | error`；读取失败不会伪装成空列表，并提供重试入口。

## 2. 运行时数据流

### 启动

```text
Tauri setup
→ AppPaths 选择并验证数据根目录
→ 日志初始化
→ 打开 SQLite
→ 在事务中执行必要 migration
→ 注册 Tauri state/IPC
→ React 读取凭据、同步间隔和 records
→ ready 或可重试 error
```

### 本地写入

```text
React UI
→ useWatchList action
→ typed Tauri IPC
→ Rust DTO/数值校验
→ SQLite transaction(record + tombstone + generation)
→ 返回持久化结果
→ 更新 React state
→ 可选调度 WebDAV 同步
```

本地 SQLite 提交与 WebDAV 请求不是一个分布式事务。网络失败不得回滚已经成功的本地写入，也不得清空本地列表。

## 3. 主要模块

| 模块 | 当前职责 |
| --- | --- |
| `src/app/App.tsx` | 初始化状态、页面编排、筛选、通知和弹窗 |
| `src/app/initialization.ts` | 可重试初始化及同步间隔解析 |
| `src/features/watchlist/hooks/useWatchList.ts` | 当前记录状态层、CRUD 与同步调度 |
| `src/shared/lib/database.ts` | TypeScript 到 Tauri 的类型化 IPC |
| `src/shared/lib/webdav.ts` | schema v2 载荷、时间戳合并、Tombstone 和 WebDAV 传输 |
| `src/shared/lib/classification.ts` | 媒体类型和地区规范化 |
| `src/shared/lib/filtering.ts` | 地区选项、组合筛选及失效选择处理 |
| `src-tauri/src/app_paths.rs` | 统一数据根目录、可写性和子目录验证 |
| `src-tauri/src/db.rs` | V18 schema、migration 和基础 records/settings 访问 |
| `src-tauri/src/db_atomic_crud.rs` | 原子新增、删除和全量替换 |
| `src-tauri/src/db_atomic_update.rs` | 强类型原子部分更新 |
| `src-tauri/src/db_atomic_helpers.rs` | generation 与 Tombstone helper |

## 4. 数据库兼容性

当前程序只支持 V18 camelCase schema。历史分支 `WatchTracker-GitHub-Source` 曾加入 V19 migration，把 21 个列名改为 snake_case。V19 程序可自动升级 V18 数据库，但当前 V18 程序不能读取已升级的 V19 数据库。

在完成双向兼容或正式迁移前：

1. 不要让 V18 与 V19 程序交替打开同一个活动数据库。
2. migration、导入、恢复和同步测试只能使用临时数据库或独立副本。
3. 升级 schema 前必须备份整个数据根目录，并验证失败回滚和旧程序处理策略。
4. 后续实现应在打开数据库时显式拒绝高于程序支持范围的 `db_version`，避免以普通 SQL 错误代替版本不兼容提示。

## 5. 当前同步边界

已经实现：

- WebDAV schema v2 与旧数组载荷兼容；
- 基于 `updatedAt`/删除时间的双端合并；
- 删除 Tombstone、锁定记录保留和冲突历史；
- 本地记录写入事务及失败回滚；
- 网络失败与本地 SQLite 状态隔离。

尚未实现：

- Zustand 状态主链路；
- WebDAV schema v3/Lamport 版本域；
- ETag 条件写入和过期重拉；
- `expectedGeneration` compare-and-swap；
- 原子 `SyncSnapshot`/`SyncCommit` IPC；
- 持久化 dirty/outbox、启动或窗口聚焦主动拉取；
- WebDAV 账号/URL 切换时的同步元数据隔离。

这些能力保留在路线图中，应从已验证不变量和测试逐项重新实现，不应整体复制历史故障快照。

路线图已按领域拆分，不再使用旧的 `TASK-D-R0`~`TASK-D-R3` 优先级大包。同步相关能力分别由 `TASK-D-SYNC-001`（冲突/版本/条件提交）、`TASK-D-SYNC-002`（持久化 outbox/主动拉取）和 `TASK-D-SYNC-003`（目标隔离）跟踪；状态层模块拆分属于独立的 `TASK-D-ARCH-002`，不默认要求引入 Zustand。

与当前便携版数据安全直接相关的 `TASK-D-DATA-001`（批量元数据补全安全重构）已经实现：先预览、只补缺失字段、区分电影/剧集/具体季，并通过正常记录 action 写入。下一项 R0 数据任务是 `TASK-D-DATA-002`（V18/V19 兼容与领域约束），之后是 `TASK-D-DATA-003`（高风险操作自动恢复点）。完整清单和状态以 `.agent-work/TASKS.md` 为准。

## 6. 当前验证状态

2026-08-02 对当前工作区执行：

```text
npm run typecheck  PASS
npm run lint       PASS
npm run test       PASS（36/36）
```

完整发布仍应运行 README 中列出的前端、Playwright、Rust 和 Windows Tauri 构建门禁。
