# TASK-D-SYNC-001：同步一致性专项设计

> 状态：已实现
>
> 基线：`main@df1e175e`，数据库运行格式保持 V18
>
> 范围：同步冲突、版本域、条件提交、过期重拉和原子本地落盘
> 不在本任务：持久化 outbox/主动拉取（`TASK-D-SYNC-002`）、WebDAV 目标切换隔离（`TASK-D-SYNC-003`）

## 1. 目标与不可破坏的不变量

1. 任意客户端不得用“GET 后无条件 PUT”覆盖 GET 之后由另一客户端提交的新状态。
2. `updatedAt` 只用于展示和旧数据兼容，不再作为跨设备并发的唯一裁决依据；设备时钟错误不能造成静默丢数据。
3. 同一条记录的不同字段在能够证明两边基于同一基线修改时自动三方合并；同一字段的不同修改不得静默丢弃任一版本。
4. 删除与并发编辑必须保留可恢复信息；锁定记录不得被远端自动覆盖或删除。
5. 远端提交和本地落盘无法组成一个跨网络事务，因此必须保证任一阶段失败后仍可重试、可解释且不丢失本地新修改。
6. 同步全量落盘继续复用 `TASK-D-DATA-004` 恢复点；本地 records、tombstones、同步基线和 generation 必须在一个 SQLite 事务中提交。
7. V18 仍是唯一运行数据库格式。本任务优先使用 `settings` 中的版本化状态，不引入 V19 或更高 schema。

## 2. 当前实现审计

当前 `src/shared/lib/webdav.ts` 的流程是 GET `records.json`、按 `updatedAt` 合并、无条件 PUT，再分别写 tombstones、成功时间和冲突历史，最后由前端调用全量替换。现有基础包括 schema v2、旧数组兼容、tombstone、50 条冲突历史、锁定记录保护、Rust 原子 CRUD、`records_generation`、记录级 `rev/revActor` 和同步前恢复点。

仍存在以下一致性缺口：

- GET 与 PUT 之间存在 lost update 窗口；Rust 网络层不返回 ETag，也不能发送 `If-Match` / `If-None-Match`。
- `sync_last_success_at` 与记录时间戳依赖不同设备的墙上时钟，无法可靠证明先后或并发。
- `rev` 只在单库内递增，`revActor` 默认是字符串 `local`，二者目前不是跨设备版本域。
- `revisionRef` 只保护当前 React 进程；重启后丢失，也不能代替数据库中的 `records_generation`。
- PUT 成功后，本地 records、tombstones、成功基线和冲突历史分多步写入；中途失败会形成不一致组合。
- schema v2 的旧客户端仍会无条件写 `records.json`，不能与新条件提交客户端安全混写同一资源。

## 3. 推荐协议：独立 schema v3 资源

新客户端使用 `records-v3.json`，避免旧客户端把 v3 文档重新写成 v2。建议载荷：

```json
{
  "schemaVersion": 3,
  "documentId": "uuid",
  "revision": 12,
  "commitId": "uuid",
  "parentCommitId": "uuid-or-null",
  "writerId": "stable-local-uuid",
  "committedAt": "2026-08-02T00:00:00.000Z",
  "records": [],
  "tombstones": []
}
```

- `revision` 是远端文档的逻辑代数，仅在基于当前 ETag 成功提交时加一；它不单独承担互斥。
- `commitId/parentCommitId` 用于识别提交链、重试和诊断。
- `writerId` 是保存在本地 settings 的随机 UUID，用于来源展示和版本记账，不包含机器 UID 或凭据。
- 记录继续携带 `rev/revActor`，但并发判断以“本地同步基线 + 当前本地 + 当前远端”的三方比较为准。
- tombstone 在 v3 中补充逻辑版本和 actor；旧 `deletedAt` 仅保留作展示与 v2 导入兼容。

本地新增版本化 settings：

- `sync_device_id_v1`：稳定设备 UUID。
- `sync_v3_baseline`：最近一次本地成功提交所对应的完整规范化 v3 基线；用于字段级三方合并。
- `sync_v3_remote_etag`：诊断/快速路径使用，提交前仍以本次 GET 返回值为准。
- `sync_v3_conflicts`：未解决冲突，保存 base/local/remote、冲突字段和删除状态。
- `sync_v3_last_commit`：最近确认提交的 revision/commitId/时间。
- `sync_v2_source_fingerprint`：首次迁移时旧文件的 ETag 或内容 SHA，用于发现旧客户端后续仍在写入。

`sync_last_success_at` 和 schema v2 冲突历史只作为旧版本兼容数据，不再参与 v3 并发判定。

## 4. WebDAV 条件提交契约

Rust 网络边界改为结构化响应，至少返回 `status`、`body`、`etag`，并允许白名单请求头：

- 已存在资源：强 ETag 以 HTTP `If-Match` 提交；服务器只提供规范弱 ETag 时，以 WebDAV `If: ([W/"…"])` 提交。两种条件失败均必须返回 412，并进入重拉重算。
- 首次创建：PUT 必须携带 `If-None-Match: *`。
- 412：表示资源已变化，不落本地合并结果；重新 GET、重新三方合并并重试，建议最多 3 次。
- 连续 3 次 412：停止并提示“云端数据持续变化，请稍后重试”，不进行无条件覆盖。
- GET/PUT 响应缺少 ETag 时，先以受限的 `PROPFIND Depth: 0` 读取标准 `DAV:getetag`。强 ETag 使用 HTTP `If-Match`；规范弱 ETag 使用 RFC 4918 WebDAV `If` 条件。GET/PROPFIND 均没有合法实体标签时进入安全只读模式，允许下载和预览，不允许自动 PUT。
- PUT 成功但响应未返回新 ETag：立即 GET 验证 `commitId`，以验证响应的 ETag/内容作为新基线。

依据：WebDAV RFC 4918 明确指出时间戳不如 ETag 适合避免 lost update；HTTP RFC 9110 规定 `If-Match` 不满足时应以 412 阻止状态变更。实现不采用 WebDAV LOCK，因为部署差异、锁续期和崩溃后的锁恢复会扩大本任务复杂度。

## 5. 本地原子边界

新增两个 Rust IPC，不让前端自行拼接数据库状态：

### `get_sync_snapshot`

在同一数据库锁下返回：

- `records`
- `tombstones`
- `recordsGeneration`
- `baseline`
- `deviceId`
- 当前未解决冲突摘要

### `commit_sync_result`

输入 `expectedGeneration`、合并后 records/tombstones、基线、远端 commit 信息和冲突；在事务开始时比较数据库 `records_generation`：

- 不相等：返回 `stale_local_snapshot`，不写任何本地状态；本地新编辑保留，安排下一次同步。
- 相等：先创建 `sync` 恢复点，再在一个 SQLite 事务中提交 records、tombstones、baseline、冲突和 generation。
- 任一步失败：整体回滚；远端若已提交，下一次同步按远端 commitId 重新协调。

远端 PUT 必须在 `commit_sync_result` 之前完成。本地 generation 在网络等待期间变化时，远端提交可能不含最新本地修改，但本地提交会被 CAS 拒绝，因此最新修改不会被远端结果覆盖，下一轮仍可上传。

## 6. 三方合并规则

对每条 ID 比较 `base`、`local`、`remote`：

| 本地相对 base | 远端相对 base | 结果 |
| --- | --- | --- |
| 未变 | 未变 | 保持 |
| 已变 | 未变 | 采用本地 |
| 未变 | 已变 | 采用远端 |
| 新增 | 不存在 | 采用本地新增 |
| 不存在 | 新增 | 采用远端新增 |
| 两边同值变化 | 两边同值变化 | 采用该值，不记冲突 |
| 两边修改不同字段 | 两边修改不同字段 | 自动字段级合并，生成新逻辑版本 |
| 两边修改同一字段且值不同 | 并发 | 生成待用户处理冲突 |
| 一边删除、另一边未变 | 单边删除 | 传播删除 |
| 一边删除、另一边编辑/新增 | 并发 | 生成“删除或保留”冲突，不静默删除 |

系统字段 `updatedAt/rev/revActor` 不作为普通业务字段产生冲突；合并完成后由 Rust 统一生成。`createdAt/id` 不允许两边改写。数组/逗号文本仍按完整字段比较，第一版不做集合级智能合并。

## 7. 已确认的冲突交互方案

采用“安全部分同步”：

1. 无冲突记录照常同步。
2. 冲突记录在远端暂时保持当前远端版本，本地暂时保持当前本地版本；两边内容与共同 base 均写入本地冲突项。
   未解决冲突的 ID 会被冻结，不参与自动发布；后续发现新的远端候选时更新冲突详情，但不会覆盖本地候选。
3. 设置页显示具体冲突字段，而不是只显示整条“被覆盖版本”。用户逐条选择“采用本地”“采用云端”；删除冲突显示“保留条目”“确认删除”。
4. 解决操作本身是正常本地事务，会递增 generation；下一次同步用条件提交发布选择结果。
5. 锁定记录永不被远端自动覆盖或删除；出现差异时保持本地并要求用户选择，不把“锁定”当作绕过 ETag 的强制上传权限。
6. 未解决冲突不自动过期；已解决审计记录最多保留最近 50 条，可手工清空。

## 8. v2 与旧客户端兼容

1. 当 `records-v3.json` 不存在时，新客户端只读加载 `records.json`（旧数组或 schema v2），以它作为初始 base，并用 `If-None-Match: *` 创建 v3 文件。
2. 创建 v3 后只读写 `records-v3.json`，不再回写 v2 文件，避免旧客户端直接破坏 v3 提交链。
3. 所有参与同步的设备应升级到支持 v3 的版本。旧客户端可继续修改 v2 文件，但这些变化不会自动进入 v3；新客户端检测到旧文件 ETag 后续变化时给出明确警告，不静默混合。
4. 用户可选择显式“再次导入旧版云端数据”，该操作走三方预览和冲突流程，不直接覆盖 v3。
5. 未知的 schemaVersion > 3 必须只读拒绝，不能按空数据解析或降级写回。

## 9. 失败状态与用户提示

- `remote_precondition_failed`：内部重拉重试，不立即制造冲突。
- `remote_busy`：3 次 412 后提示稍后重试。
- `conditional_write_unsupported`：服务器无可用于 HTTP/WebDAV 条件写入的合法 ETag；禁止上传，说明数据仍在本地。
- `stale_local_snapshot`：同步期间本地有新修改；不覆盖本地，自动安排下一轮。
- `local_commit_failed_after_remote_success`：提示云端已安全提交、本地尚未确认；下轮重新协调。
- `unsupported_remote_schema`：远端版本过高，零写入阻断。
- 网络、认证或 JSON 失败继续使用用户安全消息；日志不得记录凭据、Authorization 或完整远端载荷。

## 10. 实施拆分

1. 先实现并测试纯函数三方合并、冲突 DTO、v2→v3 只读转换和未知版本拒绝。
2. 扩展 Rust WebDAV 请求为结构化响应和条件头白名单，覆盖 404/200/201/204/412、强/弱/缺失 ETag。
3. 实现 `get_sync_snapshot` / `commit_sync_result` 与 `expectedGeneration` CAS；保持 V18，所有测试使用临时库。
4. 将 `useWatchList` 改为单一同步协调器，移除前端分步 `setSetting + replaceAllRecords` 落盘。
5. 更新设置页冲突中心和服务器能力提示。
6. 接入 DATA-004 恢复点，完成全回归后按干净 Git 提交构建便携版。

## 11. 验收矩阵

- 两客户端从同一 base 修改不同记录、同记录不同字段、同记录同字段。
- 编辑/编辑、删除/未变、删除/编辑、删除/锁定、双方同值修改。
- 本地时钟快/慢一天不影响因果和冲突结果。
- GET 后另一客户端先 PUT：首次客户端收到 412，重拉后无丢失合并。
- 首次创建竞态：只有一个 `If-None-Match: *` 成功，另一端重拉。
- 网络在 GET、PUT 前、PUT 响应丢失、本地 commit 前后分别失败。
- 同步等待期间发生本地 CRUD：`expectedGeneration` 拒绝过期落盘。
- 强 ETag、弱 ETag、无 ETag、持续 412、404、401/403、无效 JSON、schema > 3。
- v2 数组、v2 对象首次迁移；v3 建立后旧文件变化警告。
- 冲突选择、锁定保护、恢复点创建失败、SQLite commit 注入失败。
- 自动化只用 mock WebDAV 和临时数据库；真实远端与正式数据库不用于测试。

## 12. 用户确认记录

用户于 2026-08-02 确认全部采用推荐方案：

1. 不同字段自动合并；同字段或删除/编辑冲突由用户选择。
2. WebDAV 缺少可用于 HTTP `If-Match` 或 WebDAV `If` 的合法 ETag 时禁止上传，不提供无条件 PUT 降级。
3. v3 使用独立 `records-v3.json`，其他同步设备需要升级；旧 v2 文件只在首次迁移或用户显式导入时读取。

以上三项不再是实施阶段的开放问题。若后续需要改变，必须先更新本设计和兼容/测试矩阵。

## 13. 实施结果

2026-08-02 已按本设计完成 schema v3 条件同步。实现包含纯函数三方合并、冲突冻结、独立 `records-v3.json`、ETag 条件写入、三次 412 重拉、PUT 后 commitId 验证、稳定设备 UUID、Rust `get_sync_snapshot`/`commit_sync_result`、本地 generation CAS、同步恢复点、原子冲突选择、旧版文件变化检测和显式冲突导入。针对坚果云兼容性，已增加受限 `PROPFIND Depth: 0` 的 `DAV:getetag` 回退，并将强 ETag 映射到 HTTP `If-Match`、弱 ETag 映射到 RFC 4918 WebDAV `If`；安全门禁和零无条件 PUT 要求不变。数据库继续保持 V18。

`TASK-D-SYNC-002` 的持久化 outbox、异常退出后重试、启动/聚焦/周期主动拉取，以及 `TASK-D-SYNC-003` 的目标命名空间隔离均未混入本任务。
