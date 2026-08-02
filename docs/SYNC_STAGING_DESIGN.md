# TASK-D-SYNC-001-R2：版本暂存与发布恢复设计

> 状态：IMPLEMENTED  
> 日期：2026-08-02  
> 数据库：继续使用 V18；新增状态全部存入 `settings` 的版本化 JSON  
> 安全边界：自动化只使用临时 SQLite 与 mock WebDAV

## 1. 要解决的问题

旧流程虽然具备 ETag 条件写入和 generation CAS，但 PUT 与本地 SyncCommit 横跨云端和 SQLite，无法成为一个原子事务。若 PUT 已成功、随后本地提交失败，本机不会保存“哪一版已经发出”的可靠证据；下一轮在缺少 baseline 时可能把本机记录与自己刚上传的云端记录识别成整条冲突。

此外，云端与本地记录数组仅排序不同也会被视为业务变化，导致同步全量删除/重写所有记录，产生长时间日志和不必要的恢复点。

## 2. 已定同步时序

每次启动、手动同步、编辑防抖、聚焦、网络恢复和周期触发均进入同一串行协调器，并遵循：

```text
读取 SQLite 快照
  → GET 云端 records-v3.json
  → 按记录 ID 三方合并
  → 无需上传：原子提交本地增量与同步状态
  → 需要上传：先持久化发布意图
      → ETag 条件 PUT
      → 验证 commitId
      → 原子提交本地增量、baseline、冲突和暂存确认
```

自动同步不是“只上传”。所有触发都必须先获得当前云端版本，不能直接用旧内存快照覆盖云端。

## 3. V18 版本暂存

`sync_staging_v1` 按记录 ID 保存尚未被一次成功协调确认的本地变化：

- `operation`：`upsert` 或 `delete`；
- `base`：首次进入暂存时该 ID 的共同 baseline；
- `local`：最新本地版本，删除为 `null`；
- `firstGeneration` / `lastGeneration`：首次与最近一次本地事务代数。

新增、更新、删除、整体替换和冲突选择都在修改 records/tombstones、提升 generation 和 outbox 的同一个 SQLite 事务内更新暂存。相同 ID 的连续编辑只保留最新本地值和 generation 高水位，不形成逐次编辑队列。

## 4. 持久发布意图

任何 PUT 前必须先写入 `sync_publish_intent_v1`：

- 新 payload 的 `commitId`；
- 前序远端 `commitId`；
- 本轮 `expectedGeneration`；
- 本轮包含的暂存 ID 与各自 generation；
- 规范化 payload 的 SHA-256；
- 创建时间。

下一轮 GET 若同时匹配 commitId 与 payload 指纹，即可证明此前 PUT 已到达云端。协调器以该远端版本为确认版本，不再重复 PUT；本地 SyncCommit 成功后才删除发布意图和本轮包含且未被后续编辑替代的暂存项。网络等待期间产生的新 generation 永远不会被旧意图清除。

## 5. 按 ID 增量提交

Rust SyncCommit 把本地和合并结果转换为 ID 映射，只对内容实际变化的 ID 执行 UPSERT，只删除合并结果中消失且未锁定的 ID。Tombstone 同样按 ID 比较。仅数组顺序变化时：

- 不改 records；
- 不提升 records generation；
- 不创建同步恢复点；
- 只更新必要的同步确认状态。

## 6. 历史伪冲突迁移

历史版本已产生的 `base = null`、`fields = ["record"]` 冲突只在全部条件成立时自动移除：

1. 云端 payload 的 `writerId` 等于本机稳定 device ID；
2. 冲突同时保存本机与云端候选；
3. 本机候选 `revActor` 等于本机 device ID；
4. 本机 `rev` 严格大于云端候选 `rev`；
5. 当前云端该 ID 的内容与冲突中保存的云端候选完全一致。

任一条件不成立都继续冻结该 ID并交给用户选择。迁移只处理可证明源于本机失败窗口的伪冲突，不泛化为“本机版本总是覆盖云端”。

## 7. 状态与失败语义

界面区分：

- 有暂存项：存在尚未确认发布的本地记录；
- 有发布意图：正在恢复或确认一次可能已到达云端的 PUT；
- 有冲突：候选被持久保存，等待明确选择；
- 普通 outbox：存在需要协调的 generation。

缺少合法 ETag、未知远端 schema、认证失败和 412 重试上限继续沿用原安全门禁，绝不降级为无条件 PUT。

## 8. 验收结果

- Rust：59/59。覆盖暂存与 CRUD 同事务、连续编辑合并、发布意图恢复或被新确认版本取代、generation 隔离和数组换序零业务写入。
- Node：68/68。
- Playwright：49/49。新增发布意图先落盘、匹配远端版本不重复 PUT和严格同设备伪冲突迁移。
- typecheck、lint、生产 build、Rust fmt 与 clippy 全部通过。
- 未连接真实 WebDAV；未修改真实便携版数据库。

下一项路线图任务仍为 `TASK-D-SYNC-003`：WebDAV 目标隔离与安全切换。
