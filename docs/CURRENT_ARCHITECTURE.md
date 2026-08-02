# WatchTracker 当前架构

> 更新时间：2026-08-02（Australia/Perth）
> 权威源码：本仓库 `main`；正式便携版的精确构建提交号显示在应用顶部栏
> 本文描述当前可构建实现，不把历史故障快照或路线图能力写成现有功能。

## 1. 当前结论

- 前端使用 React Hook `useWatchList` 管理记录状态；当前没有 Zustand 依赖或 `src/store/useWatchListStore.ts`。
- SQLite schema 当前为 V18，records 表使用 `createdAt`、`originalName`、`revActor` 等 camelCase 列名。
- 本地新增、更新、删除和全量替换由 Rust/SQLite 事务实现，并在同一事务中维护 Tombstone 与 `records_generation`。
- WebDAV 当前使用独立 schema v3、ETag 条件写入、三方字段合并、原子 `SyncCommit`、持久 outbox 和主动拉取。
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
→ React 读取凭据、编辑防抖、主动拉取周期、records 与持久同步状态
→ ready 或可重试 error
→ 未暂停时按 pending 状态补跑或主动检查云端
```

### 本地写入

```text
React UI
→ useWatchList action
→ typed Tauri IPC
→ Rust DTO/数值校验
→ SQLite transaction(record + tombstone + generation)
→ 同事务提升 sync_outbox_v1 高水位
→ 返回持久化结果
→ 更新 React state
→ 单一协调器合并 debounce/启动/聚焦/online/周期触发
```

本地 SQLite 提交与 WebDAV 请求不是一个分布式事务。网络失败不得回滚已经成功的本地写入，也不得清空本地列表。

## 3. 主要模块

| 模块 | 当前职责 |
| --- | --- |
| `src/app/App.tsx` | 初始化状态、页面编排、筛选、通知和弹窗 |
| `src/app/initialization.ts` | 可重试初始化及同步间隔解析 |
| `src/features/watchlist/hooks/useWatchList.ts` | 当前记录状态层、CRUD 与同步调度 |
| `src/shared/lib/database.ts` | TypeScript 到 Tauri 的类型化 IPC |
| `src/shared/lib/webdav.ts` | schema v3 条件同步、v2 首次迁移、Tombstone 和 WebDAV 传输 |
| `src/shared/lib/syncMerge.ts` | 基于共同 baseline 的纯函数三方合并与冲突冻结 |
| `src/shared/lib/syncScheduling.ts` | 主动拉取到期、失败分类和持久退避纯函数 |
| `src/shared/lib/classification.ts` | 媒体类型和地区规范化 |
| `src/shared/lib/filtering.ts` | 地区选项、组合筛选及失效选择处理 |
| `src-tauri/src/app_paths.rs` | 统一数据根目录、可写性和子目录验证 |
| `src-tauri/src/db.rs` | V18 schema、migration 和基础 records/settings 访问 |
| `src-tauri/src/db_atomic_crud.rs` | 原子新增、删除和全量替换 |
| `src-tauri/src/db_atomic_update.rs` | 强类型原子部分更新 |
| `src-tauri/src/db_atomic_helpers.rs` | generation 与 Tombstone helper |
| `src-tauri/src/record_validation.rs` | 本地严格写入、部分更新及导入/同步兼容规范化的统一领域规则 |

## 4. 数据库兼容性

当前程序以 V18 camelCase schema 为唯一运行格式。历史分支 `WatchTracker-GitHub-Source` 曾加入 V19 migration，把 21 个列名改为 snake_case。当前程序打开已知 V19 时，先用 SQLite backup API 在同一数据根目录的 `backups/` 创建并校验一致快照，再在单一事务中把 21 个列名和版本标记恢复到 V18；失败会回滚并阻止数据库读写。转换成功后界面只提示一次。

版本边界：

1. V18 正常打开；V19 自动备份并转换为 V18；V20 及更高未知版本明确拒绝，且不执行建表、migration 或备份。
2. 不要让当前程序与历史 V19 程序交替打开同一个活动数据库，否则历史程序可能再次升级列名。
3. migration、导入、恢复和同步测试只能使用临时数据库或独立副本。
4. 未知更高版本不得推测字段或自动降级；应使用支持该版本的程序先导出或提供明确迁移规格。

数据库写入边界统一保留 V18：records 使用明确的 `ON CONFLICT(id) DO UPDATE`，不再依靠删除再插入语义。本地新增严格校验至少一个名称、固定媒体类型和数值范围，并由 Rust 写入 `updatedAt`、`rev`、`revActor`；部分更新只验证被修改字段，因此旧脏行仍可逐步修复。导入和同步全量替换采用兼容模式规范化空文本、旧媒体类型和无效旧数值，重复 ID 会在删除现有记录前使整批失败，锁定记录仍保留本地版本。

## 5. 当前同步边界

已经实现：

- 独立 `records-v3.json`、ETag 条件写入和 412 重拉：GET 返回规范强 ETag 时使用 HTTP `If-Match`；弱、缺失或未加引号的验证器先以 `PROPFIND Depth: 0` 读取 `DAV:getetag`，再使用 WebDAV `If`；首次创建使用 `If-None-Match: *`，仍无合法验证器才禁止上传；连续三次 412 只有在验证器指纹确实变化时才报告 `remote_busy`，固定指纹被拒绝则停止自动重试并保留本地数据；
- 共同 baseline 三方字段合并、删除 Tombstone、锁定保护和持久冲突中心；
- `get_sync_snapshot`、`commit_sync_result(expectedGeneration)`、恢复点和本地原子落盘；
- 旧数组/schema v2 首次迁移、旧客户端后续写入检测和显式冲突导入；
- 网络失败与本地 SQLite 状态隔离。
- generation 高水位持久 outbox，所有本地业务写事务原子入队；
- 按记录 ID 合并的 V18 `sync_staging_v1` 版本暂存，以及 PUT 前持久化的 `sync_publish_intent_v1`；远端已写而本地确认失败时可按 commitId 与 payload 指纹恢复，不重复上传；
- 启动、聚焦/可见、网络恢复和独立周期主动拉取，暂停/退避跨重启保留；
- 每轮固定先拉取再合并，clean pull 不创建恢复点或递增 records generation；
- SyncCommit 按记录 ID 计算 upsert/delete，数组顺序变化不会触发全量记录重写；严格同设备证据成立时可迁移旧 `base = null` 伪冲突。

尚未实现：

- Zustand 状态主链路；
- WebDAV 账号/URL 切换时的同步元数据隔离。

这些能力保留在路线图中，应从已验证不变量和测试逐项重新实现，不应整体复制历史故障快照。

路线图已按领域拆分，不再使用旧的 `TASK-D-R0`~`TASK-D-R3` 优先级大包。同步相关能力分别由 `TASK-D-SYNC-001`（冲突/版本/条件提交）、`TASK-D-SYNC-002`（持久化 outbox/主动拉取）和 `TASK-D-SYNC-003`（目标隔离）跟踪；状态层模块拆分属于独立的 `TASK-D-ARCH-002`，不默认要求引入 Zustand。

`TASK-D-DATA-001`~`004`、`TASK-D-SYNC-001`~`003` 与同步修订 `TASK-D-SYNC-001-R2` 已经实现。同步使用独立 `records-v3.json` 和 ETag 条件提交（强 ETag 走 HTTP `If-Match`，弱 ETag 走 WebDAV `If`）：不同字段按本地共同基线三方合并，同字段、删除/编辑和锁定差异进入持久冲突中心；Rust 以 `expectedGeneration` 和单事务 SyncCommit 防止网络等待期间的新本地修改被覆盖。所有本地业务写入同时提升当前目标的持久 outbox，并维护按 ID 合并的版本暂存；PUT 前写入可恢复发布意图。自动协调器在启动、聚焦、网络恢复和周期到期时始终先拉取，再合并并按需上传；本地提交只写变化的记录。

WebDAV URL＋保留大小写的用户名经规范化后生成 SHA-256 target ID。凭据、baseline、ETag、冲突、last commit、旧版指纹、outbox、scheduler、staging 与 publish intent 均按 `sync_target::<id>::…` 隔离；records、Tombstone、generation 和 device ID 继续全局共用。切换前只有只读探测，确认激活会提升 target epoch 并立即 Pull → Merge → Push；切换期间完成的旧请求无法通过 target ID＋epoch CAS 提交到新目标。断开和切换只冻结旧目标状态，切回时按旧 baseline 重建离线差异。旧全局同步键先创建 `target-migration` 恢复点，再以一个 SQLite 事务迁入目标命名空间。数据库仍为 V18，高风险落盘继续先创建恢复点。

下一项 R0 路线图任务 `TASK-D-SEC-001` 已形成 `docs/SECURE_CREDENTIAL_STORAGE_DESIGN.md` 草案：计划把 WebDAV/TMDB 秘密本体迁入当前 Windows 用户的 Credential Manager，SQLite 仅保留固定引用标记，并移除已保存秘密往返 React 的通用解密 IPC。该设计等待用户确认后实施。完整清单和状态以 `.agent-work/TASKS.md` 为准。

## 6. 当前验证状态

2026-08-02 对当前工作区执行：

```text
npm run typecheck  PASS
npm run lint       PASS
npm run test       PASS（68/68）
npx playwright test PASS（50/50）
npm run build      PASS
cargo fmt/clippy   PASS
cargo test --locked PASS（59/59）
```

便携版发布仍须从干净 Git 提交运行 Windows Tauri 构建，并在替换前后只读校验真实数据库。
