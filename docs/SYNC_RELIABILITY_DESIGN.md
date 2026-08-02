# TASK-D-SYNC-002：持久化 outbox 与主动拉取专项设计

> 状态：已设计，待实施
>
> 基线：`main@180d5d5`，数据库运行格式保持 V18
>
> 依赖：`TASK-D-SYNC-001` 已实现的 schema v3、强 ETag、三方合并、冲突冻结与 `expectedGeneration` CAS
>
> 范围：本地修改的持久同步意图、崩溃恢复、自动同步暂停/恢复、启动/聚焦/网络恢复/周期主动拉取、失败分类与退避
>
> 不在本任务：WebDAV 目标隔离（`TASK-D-SYNC-003`）、凭据存储迁移（`TASK-D-SEC-001`）、后台常驻服务或系统托盘

## 1. 目标与不变量

1. 本地 SQLite 写入成功后，即使程序在 debounce 或网络请求完成前退出，下次启动仍必须知道有修改尚未被同步确认。
2. 网络请求不得成为本地业务事务的一部分。离线、认证失败或远端故障不能回滚已经成功的本地编辑。
3. outbox 只能在一次 schema v3 同步完成并由 `expectedGeneration` 原子提交后确认；开始请求、PUT 成功或前端收到响应均不能提前清除。
4. 自动同步暂停只阻止自动触发，不删除待同步状态，不阻止本地编辑，也不阻止用户点击“立即同步”。
5. 主动拉取必须在没有本地修改时仍能发现其他设备的提交，同时继续遵守 `TASK-D-SYNC-001` 的 ETag、三方合并、冲突冻结和本地 CAS。
6. 所有自动触发共享一个串行协调器。启动、编辑、聚焦、网络恢复和周期计时可以合并意图，但不能产生并行 GET/PUT。
7. 定时器只是唤醒手段，SQLite 中的 outbox 与调度状态才是事实来源。异常退出后不依赖内存 timer 恢复。
8. V18 仍是唯一运行数据库格式。新增状态优先保存到 `settings`，不升级到 V19。

## 2. 当前实现审计

当前 `useWatchList` 在新增、更新或删除后启动一个内存 `setTimeout`，延迟由 `sync_interval` 控制；同一进程内用 Promise ref 串行化同步。该实现存在以下缺口：

- 本地 CRUD 事务没有持久记录“待同步”，程序退出会丢失 debounce 意图。
- 导入、恢复、冲突选择等记录变更入口没有统一的 durable dirty 契约。
- 暂停状态仅存在 React state，重启后丢失；暂停时尚未发送的意图也没有可查看状态。
- 没有启动、窗口重新聚焦、网络恢复或周期 GET，因此另一个设备的修改只有在本机再次编辑或手动同步后才能出现。
- 失败后没有统一分类和退避；频繁编辑或聚焦可能重复提示同一错误。
- `sync_interval` 当前含义是“编辑后的防抖秒数”，不能同时承担分钟级主动拉取周期。

已有 schema v3 协调器可以安全重复执行：GET 使用强 ETag，PUT 使用条件请求，本地提交使用 generation CAS。因此本任务不新建另一套同步协议，只负责可靠地产生、保存和执行同步意图。

## 3. 推荐模型：单槽、可合并 outbox

远端同步单位是完整的 `records-v3.json`，不是逐条记录 API。传统的“一次编辑一条任务”会产生大量可被后续全量快照覆盖的重复任务，因此采用一个持久化的 coalescing outbox。

`settings.sync_outbox_v1` 保存：

```json
{
  "version": 1,
  "pending": true,
  "dirtyGeneration": 42,
  "reasons": ["record-update", "metadata-batch"],
  "firstQueuedAt": "2026-08-02T08:00:00.000Z",
  "lastQueuedAt": "2026-08-02T08:03:00.000Z"
}
```

- `pending` 表示至少有一代本地业务修改尚未被一次成功协调确认。
- `dirtyGeneration` 是入队事务完成后的最高 `records_generation`。后续修改覆盖该高水位，不追加重复网络任务。
- `reasons` 只用于用户状态和诊断，去重后最多保留 8 项；它不决定合并或重试语义。
- 时间只用于展示和 debounce，不用于判断跨设备因果。
- 没有凭据、处于暂停或长期离线时，outbox 仍保留，不设过期时间。

以下成功事务必须在修改 records/tombstones、递增 generation 的同一 SQLite 事务中更新 outbox：新增、编辑、删除、批量元数据写入、导入/本地恢复、冲突选择，以及其他会改变待发布业务状态的入口。事务回滚时 outbox 也必须回滚。

恢复点还原会替换整库，不能直接复用备份中可能过期的 outbox。还原并通过完整性检查后，必须在返回成功前提升 generation 并写入 `recovery-restore` pending；如果这一步失败，按现有恢复协议还原 pre-restore 数据库，不能向界面报告成功。

远端拉取造成的本地替换和同步基线更新不得重新入队，否则会形成永久回声。代码层应区分 `mark_local_records_mutated_and_enqueue(reason)` 与同步协调器内部的 generation 更新，禁止靠前端补写 setting。

从没有 `sync_outbox_v1` 的旧版本首次启动时执行保守初始化：若当前 records/tombstones 与已确认 baseline（排除仍被冻结的冲突 ID）不能证明相同，则创建 `upgrade-bootstrap` pending；若 baseline 不存在或两边相同，也仍由首次启动主动拉取完成一次安全协调。该迁移只允许多一次幂等同步，不能漏掉升级前最后一次未发送的编辑。

## 4. 原子确认规则

扩展现有 `commit_sync_result`，在 records、tombstones、baseline、conflicts、ETag 和 generation 的同一事务中确认 outbox：

1. 同步开始时通过 `get_sync_snapshot` 取得 `expectedGeneration` 和当时的 outbox。
2. 网络阶段不修改或清除 outbox。
3. `commit_sync_result` 仍先比较当前 generation；不相等时返回 `stale_local_snapshot`，所有状态零写入，outbox 保留最新高水位。
4. generation 相等且本地提交成功时，如果 `pending && dirtyGeneration <= expectedGeneration`，将 outbox 置为非 pending；否则保持。
5. 同步冲突本身不要求 outbox 永久 pending：无冲突部分已经协调，冲突候选由 `sync_v3_conflicts` 持久保存和冻结。用户解决冲突时会形成新的本地事务并重新入队。
6. 远端 PUT 成功但本地 commit 失败时不得确认 outbox；下一轮依靠 commitId/ETag 重新协调。

该规则保证网络等待期间出现的新编辑不会被旧请求错误确认，也不需要跨 SQLite/WebDAV 分布式事务。

## 5. 持久调度状态

`settings.sync_scheduler_v1` 保存自动调度所需的最小状态：

```json
{
  "version": 1,
  "paused": false,
  "consecutiveFailures": 0,
  "nextAttemptAt": null,
  "lastAttemptAt": null,
  "lastSuccessAt": null,
  "lastErrorCode": null,
  "lastRemoteCheckAt": null
}
```

- `paused` 必须持久化。暂停期间允许继续入队，但不安排自动网络请求。
- `nextAttemptAt` 用于跨重启延续退避；前端 timer 到期后必须重新读取状态，不能直接假定可以执行。
- `lastRemoteCheckAt` 只在一次远端读取并完成本地协调后更新，用于计算主动拉取是否到期。
- 不持久化“已出队”任务。可选的 `inFlight` 只能用于诊断，不能改变确认语义；程序在网络阶段崩溃时 outbox 天然仍为 pending。
- JSON 解析失败必须以安全默认值恢复调度，但不能把损坏 outbox 当作空任务。outbox 损坏应阻止自动确认并提示修复。

推荐增加 Rust 类型化 IPC：

- `get_sync_runtime_state`：返回 outbox、调度状态、冲突数和最近提交摘要。
- `set_auto_sync_paused(paused)`：事务性持久化暂停状态。
- `record_sync_failure(code, nextAttemptAt)`：更新失败计数和安全错误码，不保存凭据、URL 或远端正文。
- 成功状态、远端检查时间和 outbox 确认由 `commit_sync_result` 原子写入，不由前端分步拼接。

## 6. 单一协调器与触发来源

新增独立 `syncCoordinator`，`useWatchList` 只订阅状态、请求调度和在提交后刷新 records，不再自己维护业务级同步 timer。

触发规则：

| 触发来源 | 推荐行为 |
| --- | --- |
| 本地写入 | 事务已入 outbox；按现有 `sync_interval` 做 5–300 秒 debounce |
| 程序启动完成 | 有凭据且未暂停：pending 立即补跑；否则在短暂启动延迟后主动检查远端 |
| 窗口重新聚焦/页面重新可见 | 距最近远端检查超过 30 秒才触发，防止 Alt-Tab 风暴 |
| 浏览器 `online` 事件 | 只作为网络恢复提示；立即重读持久状态并尝试，不把 `navigator.onLine` 当作远端可用证明 |
| 周期检查 | 使用独立的分钟级 `sync_pull_interval_minutes`，默认 15 分钟；建议选项为关闭、5、15、30、60 分钟 |
| 用户立即同步 | 绕过暂停、debounce 和 `nextAttemptAt`，但不能绕过强 ETag、未知 schema 等安全门禁 |
| 恢复自动同步 | 有 pending 时立即补跑；否则立即主动拉取一次 |

协调器在任意时刻最多执行一个 `syncToWebDAV`。运行中到达的新触发只设置内存 `rerunRequested`；当前轮结束后重新读取 SQLite 状态，按最新 generation、暂停和退避决定是否再执行。不得复用旧 snapshot 直接重试。

程序关闭时无需等待网络请求完成，也不得为“尽量同步”阻塞退出；可靠性由未提前确认的 outbox 保证。

## 7. 失败分类、退避与通知

自动重试采用带约 ±20% 抖动的阶梯：10 秒、30 秒、2 分钟、5 分钟、15 分钟，之后保持最多 15 分钟。测试使用注入时钟和固定抖动，避免等待真实时间。

| 分类 | 例子 | 自动行为 |
| --- | --- | --- |
| 可重试 | 断网、超时、HTTP 408/429/5xx、`remote_busy`、远端成功后本地确认失败 | outbox 保留，记录退避并重试 |
| 本地并发 | `stale_local_snapshot` | 不增加故障噪声；重新读取最新 generation，短延迟补跑 |
| 需要用户处理 | 401/403、无凭据、`conditional_write_unsupported`、`unsupported_remote_schema`、`legacy_remote_changed` | outbox 保留；停止自动重试，等待凭据/配置变化或用户手动操作 |
| 正常冲突 | 同字段或删除/编辑冲突 | 本轮可成功；显示冲突数，等待用户选择，选择后重新入队 |

后台失败通知按错误码去重，同一错误在状态未变化时不反复弹出。设置页始终显示待同步、暂停、退避到期时间、最近成功和阻断原因；手动同步仍返回即时、明确的结果。

认证错误不得自动清除凭据。日志只记录错误分类、HTTP 状态、触发来源、attempt 和 generation，不记录用户名、密码、Authorization、完整 URL 查询参数或远端载荷。

## 8. 暂停、凭据和配置变化

1. “暂停自动同步”同时暂停编辑 debounce 与主动拉取；outbox、冲突和退避状态全部保留。
2. 用户仍可手动同步。手动成功后正常确认 outbox，但不自动取消暂停。
3. 重启后保持暂停，顶部状态栏应明确显示“自动同步已暂停”，而不是显示正在同步。
4. 清除凭据不会清除 outbox。重新保存有效凭据后，若未暂停则立即触发；若暂停则只更新状态。
5. 修改代理、URL 或账号后的目标安全切换属于 `TASK-D-SYNC-003`。在该任务实施前，本任务不得自行清空 baseline/ETag/outbox；现有目标变更入口需继续提示其全局影响。
6. 主动拉取周期与编辑 debounce 分开保存和展示，避免把 30 秒误解释为每 30 秒持续访问 WebDAV。

## 9. 崩溃与异常场景

- 本地事务成功、timer 前退出：outbox 已持久化；下次启动补跑。
- 网络 GET/PUT 前退出：outbox 未确认；下次重试。
- PUT 已成功但响应丢失或进程退出：outbox 未确认；v3 commitId 与条件 GET 负责在下一轮识别远端状态。
- 远端同步成功、本地 `commit_sync_result` 回滚：records、baseline、调度成功状态和 outbox 确认全部回滚；下一轮重新协调。
- clean 状态主动拉取中退出：没有本地任务可丢；下次启动重新检查。
- 暂停期间连续修改：只提升 dirtyGeneration 并合并 reasons，不产生 N 个任务。
- 系统时间回拨：可能影响展示和定时等待，但不能清除 outbox或裁决数据版本；发现 `nextAttemptAt` 明显异常时允许立即重新评估。

## 10. 实施拆分

1. 先实现 Rust outbox/scheduler DTO、解析与事务 helper，并把所有本地记录变更入口接入原子入队。
2. 扩展 `get_sync_snapshot` / `commit_sync_result`，实现 generation 约束下的 outbox 原子确认和成功调度状态。
3. 实现纯 TypeScript 调度状态机：触发合并、串行化、退避、暂停和注入时钟。
4. 将 `useWatchList` 的内存 debounce 迁移到 `syncCoordinator`，接入启动、Tauri 窗口聚焦、visibility、online 和周期触发。
5. 更新顶部状态栏与设置页，分开展示编辑 debounce、主动拉取周期、pending、暂停、最近成功和阻断原因。
6. 补齐临时 SQLite、mock WebDAV 和 fake-clock 回归；不得使用真实 WebDAV 或正式数据库做自动化测试。
7. 更新架构文档后，从干净 Git 提交构建便携版，并只读核验正式 V18 数据库前后不变。

## 11. 验收矩阵

### Rust / 临时数据库

- add/update/delete/import/restore/conflict resolution 与 generation、outbox 在同一事务提交。
- 任一业务事务注入失败时 records、tombstone、generation 和 outbox 全部回滚。
- 连续 N 次编辑只保留一个 pending outbox，dirtyGeneration 为最高代数。
- 同步成功只确认 `dirtyGeneration <= expectedGeneration` 的意图。
- 网络等待期间新编辑导致 CAS 失败，outbox 保持最新 pending。
- 同步 commit 注入失败时 baseline、scheduler success 和 outbox 确认整体回滚。
- 暂停、失败次数、nextAttempt 和重启恢复均能从 settings 还原；畸形 outbox 不被当作空。
- 首次升级能把相对 baseline 的本地差异转成 `upgrade-bootstrap` pending；无 baseline 时启动协调仍会执行。
- 恢复点还原成功后使用新 generation/pending，不继承备份中的“已同步”假象；入队失败时恢复整体失败并回到 pre-restore。

### TypeScript / 调度纯函数

- 各触发来源的优先级、合并、30 秒聚焦冷却和独立周期计算。
- 暂停阻止自动触发但手动同步可运行；恢复按 pending 决定补跑或拉取。
- 阶梯退避、最大值、固定抖动、时间回拨和成功后清零。
- `stale_local_snapshot` 快速重读，401/403 等阻断状态不循环重试。
- in-flight 期间多个触发最多形成一次基于最新持久状态的后续运行。

### Playwright / mock IPC 与 WebDAV

- 编辑后关闭并重新挂载应用，pending 仍在且启动补跑。
- clean 启动、窗口聚焦、online 和周期到期能发现远端-only 修改。
- Alt-Tab/visibility 重复事件不会产生并行或高频 GET。
- 连续本地编辑被 debounce 合并；同步中再编辑不会被旧轮确认。
- 暂停跨重启保持，暂停期间无自动请求，手动同步可用，恢复立即执行正确动作。
- 断网/5xx 按 fake clock 退避，成功后清零；401/403 不自动轰炸服务器或通知。
- 冲突成功进入冲突中心，解决后重新入队并发布。
- 无强 ETag、未来 schema、旧客户端写入仍保持 SYNC-001 的零不安全 PUT 约束。

自动化测试只使用临时数据库、mock WebDAV 和注入时钟。真实便携版数据库只允许部署前后只读完整性、版本、数量和哈希检查。

## 12. 已定推荐方案

本设计采用以下默认方案，可直接进入实施：

1. 使用单槽 generation 高水位 outbox，不保存逐条记录 payload 或每次编辑任务。
2. 暂停只影响自动触发，保留 outbox，并允许手动同步。
3. 编辑 debounce 继续使用现有 5–300 秒设置；主动拉取使用独立分钟级设置，默认 15 分钟。
4. 启动、聚焦、网络恢复和周期检查均进入同一个串行协调器。
5. 可重试错误持久退避；安全/认证阻断等待用户处理；通知按错误码去重。
6. 保持数据库 V18，并为后续 `TASK-D-SYNC-003` 的 per-target 迁移保留版本化 JSON 状态边界。
