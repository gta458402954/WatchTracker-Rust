# WatchTracker 原子本地数据 API

本文描述当前已注册、已测试的 Tauri/SQLite 数据接口。它不把路线图能力写成现有功能，也不沿用旧快照中已经废弃的 IPC 名称。

## 1. 权威实现位置

- Tauri 命令注册：`src-tauri/src/lib.rs`
- IPC 命令入口：`src-tauri/src/commands.rs`
- 数据模型与更新 DTO：`src-tauri/src/models.rs`
- 原子新增/删除/全量替换：`src-tauri/src/db_atomic_crud.rs`
- 原子部分更新：`src-tauri/src/db_atomic_update.rs`
- generation 与 Tombstone helper：`src-tauri/src/db_atomic_helpers.rs`
- TypeScript 调用：`src/shared/lib/database.ts`
- 事务和失败回滚测试：`src-tauri/src/db_atomic_tests.rs`

## 2. 当前记录命令

| Tauri 命令 | TypeScript 调用 | 参数 | 成功返回 |
| --- | --- | --- | --- |
| `get_all_records` | `getAllRecordsAsync()` | 无 | `WatchRecord[]` |
| `insert_record` | `insertRecord(record)` | `{ r: WatchRecord }` | `void` |
| `update_record` | `updateRecord(id, updates)` | `{ id, updates, actorId? }` | 持久化后的 `WatchRecord` |
| `delete_record` | `deleteRecord(id)` | `{ id }` | `void` |
| `replace_all_records` | `replaceAllRecords(records)` | `{ records: WatchRecord[] }` | `void` |

Tauri 将 JavaScript 的 `actorId` 映射到 Rust `actor_id`。当前 TypeScript 客户端不传该字段，Rust 使用 `local`；测试或未来可信调用方可以提供非空 actor ID。

设置命令 `get_setting`、`set_setting` 和 `vacuum_db` 仍单独存在，不属于记录 CRUD 的同一事务。

## 3. `UpdateWatchRecord` 契约

更新 DTO 使用 `camelCase` 并启用 `deny_unknown_fields`。允许字段为：

```text
originalName chineseName progress totalEpisodes movieProgress movieDuration
releaseYear posterPath status platform rating startDate endDate notes imdbId
isLocked genres originCountry imdbRating tmdbStatus interestLevel episodeRuntime
mediaType contentTags
```

禁止客户端更新：

```text
id createdAt updatedAt rev revActor
```

也禁止未知字段、数组/对象替代标量、错误标量类型和非有限前端数字。

字段有两种更新语义：

- 必填/非空字符串字段采用 `Option<T>`：缺失表示不更新。
- 可空字段采用 `Patch<T>`：缺失表示不更新，JSON `null` 表示写入 SQL `NULL`，具体值表示更新。

空对象会返回可识别错误 `Empty update payload`，且不会推进 generation 或更改记录。

## 4. SQLite 事务不变量

每次本地记录写入只提交一个 SQLite 事务：

### 新增

1. 插入完整记录。
2. 删除同 ID 的旧 Tombstone（若存在）。
3. `records_generation` 加一。
4. 一次性提交。

### 更新

1. 校验 DTO 和 actor。
2. 更新允许字段。
3. 由 Rust 在事务内生成 `updatedAt`。
4. `rev = COALESCE(rev, 0) + 1` 并写入 `revActor`。
5. 删除同 ID Tombstone（若存在）。
6. `records_generation` 加一并读取持久化记录。
7. 一次性提交。

更新不存在记录会失败，既有 Tombstone 和 generation 保持不变。

### 删除

1. 删除存在的记录；不存在时失败。
2. 以 Rust UTC 时间写入/替换同 ID Tombstone。
3. `records_generation` 加一。
4. 一次性提交。

### 全量替换

1. 保留本地锁定记录。
2. 替换其余记录。
3. `records_generation` 只加一次。
4. 一次性提交。

任一步骤的 SQL、Tombstone 序列化或 setting 写入失败都会回滚该事务。直接测试覆盖记录 SQL 失败、generation 写入失败、导入中途失败和 migration version 写入失败。

## 5. Generation、Revision 与 Tombstone

- `records_generation` 保存在 `settings`，是本地记录集合的单调 `i64` 版本；缺失按 `0` 读取，非法、负数或溢出会报错。
- `rev`/`revActor` 是单记录修订元数据；当前本地更新自增 `rev`。
- `sync_tombstones` 是 JSON 数组，每项包含 `id` 和 `deletedAt`。删除记录创建 Tombstone，重新新增或更新同 ID 记录会移除旧 Tombstone。
- generation 当前没有独立的公开 IPC，也不是跨设备全局版本号。

## 6. 错误、重试和恢复

Rust 错误通过 `AppError` 返回，包括数据库、网络、IO、并发和通用错误。前端向用户显示通用操作反馈，并只记录错误类别；测试和诊断不能把凭据或原始敏感错误写入提交。

安全重试规则：

- DTO 校验、空更新、记录不存在以及事务回滚后可以修正输入再重试。
- migration 失败会连同 `db_version` 回滚；移除故障后可重新运行。
- 客户端收到成功前不应自行假定本地写入成功；失败后应重新读取当前记录/generation，而不是复用旧内存快照覆盖数据库。
- 导入/恢复使用 `replace_all_records` 时，失败不会留下部分替换。

## 7. 当前没有实现的并发协议

以下概念不是当前记录 IPC 的一部分：

- `commitId` 返回值或提交查询命令；
- 客户端提交 `expectedGeneration` 的 compare-and-swap；
- 服务端 `stale snapshot` 专用错误；
- 持久化 outbox/dirty 队列；
- 跨 SQLite 与 WebDAV 的分布式事务。

因此 generation 只能帮助本地诊断和后续设计，当前客户端不能依靠它阻止另一个进程/设备基于旧快照提交。多设备冲突、主动拉取和目标隔离仍属于 DEFERRED 路线图。

## 8. WebDAV 边界

SQLite 事务在本地提交时结束。随后的 WebDAV GET/PUT 是独立网络操作，无法与 SQLite 原子提交：

```text
local SQLite commit
→ debounce / manual sync
→ read remote payload
→ merge records and tombstones
→ WebDAV PUT
```

网络失败不得回滚、删除或伪装成本地 SQLite 提交失败；它只表示远端尚未确认。反过来，远端 PUT 成功也不能证明后续本地替换一定成功。当前应用使用时间戳、修订字段、Tombstone 和冲突记录降低风险，但不声称提供 exactly-once 或分布式事务保证。

## 9. 验证命令

```powershell
npm run typecheck
npm run lint
npm run test
npx playwright test
Set-Location src-tauri
cargo fmt -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --locked
```

关键断言及 REQUEST 7.1 映射见 `.agent-work/evidence/review/TASK-A-007-CODEX-REVIEW.md`。
