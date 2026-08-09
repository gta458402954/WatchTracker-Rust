# TASK-D-UX-003：系列 / 收藏集专项设计

> 状态：IMPLEMENTED（2026-08-09）
> 设计日期：2026-08-09
> 数据库主版本：继续使用 V18；新增独立、幂等的 `collections_schema_version=1` 功能迁移
> 依赖：Rust 原子写入、恢复点、target 级 WebDAV 同步、持久化 outbox / staging、同步 payload V4

## 1. 目标与第一版边界

为 WatchTracker 增加独立的“系列 / 收藏集”领域，使一条影视记录可以同时属于多个集合，并支持人工整理、稳定排序和经用户确认的 TMDB 归组建议。收藏集是用户维护的业务数据，不再复用 `contentTags`、媒体类型或保存视图。

第一版包括：

1. 创建、重命名、说明和删除扁平收藏集；名称在本地库内规范化后唯一。
2. 记录与收藏集的多对多关系；同一记录可加入多个集合。
3. 从记录编辑页和收藏集中心添加、移除成员，并提供明确的手工排序。
4. 基于稳定 TMDB 标识生成归组建议，预览后由用户确认；不进行标题模糊匹配或后台静默写入。
5. 完整 SQLite 恢复、本地 JSON V3 导入导出和 WebDAV V5 同步。
6. 收藏集、成员关系、删除标记、generation、staging 和 outbox 的 Rust 单事务写入。

第一版不包括：嵌套收藏集、动态智能收藏集、公开分享、协同权限、用户上传封面、自动抓取整个系列中尚未入库的作品、跨库合并、Trakt 映射或多套独立本地片库。收藏集不改变记录的状态、进度、评分、锁定或排序算法。

## 2. 产品语义

### 2.1 收藏集不是标签或保存视图

- `contentTags` 继续表示记录自身的主题标签，不承担集合身份。
- 保存视图是本机查询快照，不是同步的业务实体。
- 收藏集具有稳定 ID、名称、说明、成员和顺序，并进入备份与 WebDAV。
- 同名但不同来源的集合容易造成误选，因此第一版不允许规范化后的重名；用户可用后缀区分。

名称规则：去除首尾空白、连续空白折叠为一个、1～80 个 Unicode 字符；用于唯一性比较的 `normalizedName` 使用 Rust Unicode 小写规范化。说明允许为空，最多 500 个字符。空名称、控制字符和仅空白名称由 Rust 拒绝。

### 2.2 扁平多对多模型

一个收藏集可以没有成员；删除最后一个成员不会自动删除收藏集。一条记录可以属于零个或多个收藏集。重复加入同一集合是幂等操作，不制造第二条成员关系，也不提升 revision/generation。

删除收藏集只删除集合与其成员关系，绝不删除任何影视记录。删除影视记录时，其收藏集成员关系在同一事务中级联删除并生成同步删除标记；收藏集本身保留。导入或同步后不得存在指向缺失记录或缺失集合的成员关系。

记录的 `isLocked` 仍只保护记录内容与删除，不阻止用户整理收藏集成员关系；收藏集操作不会修改该记录的 revision。界面应明确“移动收藏集不会修改条目内容”。

### 2.3 封面与汇总

第一版不保存独立收藏集封面。收藏集封面按手工顺序选择第一个具有有效海报的成员；没有海报时显示统一占位图。成员数量、已看数量和进度均为只读派生值，不写入数据库，不进入同步，也不影响“今晚看什么”。

## 3. V18 数据模型与功能迁移

继续保持 `settings.db_version = 18`，新增 `collections_schema_version = 1`。迁移前创建 `reason=collections-migration` 的恢复点；恢复点创建或校验失败时，不执行迁移。迁移必须通过表、列、索引和 marker 检查实现幂等，任何一步失败都回滚。

```sql
CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalizedName TEXT NOT NULL UNIQUE,
  description TEXT NULL,
  sourceKind TEXT NOT NULL DEFAULT 'manual'
    CHECK (sourceKind IN ('manual', 'tmdb-movie-collection', 'tmdb-tv-show')),
  sourceKey TEXT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  revActor TEXT NOT NULL DEFAULT '',
  UNIQUE(sourceKind, sourceKey)
);

CREATE TABLE collection_members (
  id TEXT PRIMARY KEY,
  collectionId TEXT NOT NULL,
  recordId TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  sourceKind TEXT NOT NULL DEFAULT 'manual'
    CHECK (sourceKind IN ('manual', 'tmdb')),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  revActor TEXT NOT NULL DEFAULT '',
  UNIQUE(collectionId, recordId),
  FOREIGN KEY(collectionId) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY(recordId) REFERENCES records(id) ON DELETE CASCADE
);

CREATE INDEX collection_members_order
  ON collection_members(collectionId, position, id);
CREATE INDEX collection_members_record
  ON collection_members(recordId, collectionId);

CREATE TABLE collection_tombstones (
  id TEXT PRIMARY KEY,
  deletedAt TEXT NOT NULL,
  rev INTEGER NOT NULL,
  revActor TEXT NOT NULL
);

CREATE TABLE collection_member_tombstones (
  id TEXT PRIMARY KEY,
  collectionId TEXT NOT NULL,
  recordId TEXT NOT NULL,
  deletedAt TEXT NOT NULL,
  rev INTEGER NOT NULL,
  revActor TEXT NOT NULL
);
```

`sourceKey` 使用带命名空间的稳定值，例如 `tmdb:movie-collection:10` 或 `tmdb:tv-show:1399`；手工集合为 `NULL`。成员 ID 使用确定性 SHA-256：`sha256("collection-member:v1\0" + collectionId + "\0" + recordId)`，保证不同设备对同一关系得到相同逻辑 ID。

成员位置使用非负整数。新增成员默认排在末尾；手工重排由 Rust 在单事务中将最终顺序规范化为 `0, 1024, 2048...`，只更新位置实际变化的成员。显示时始终以 `(position, id)` 排序，位置碰撞也能得到确定结果。

完成迁移后写入：

```text
collections_schema_version = 1
required_app_features_v1 += collections-v1
```

旧 EXE 不理解新增关系表和同步 V5，因此迁移后的活动数据库不得再与旧便携版交替使用；正式的程序隔离仍由 `TASK-D-RELEASE-001` 完善。

## 4. Rust 目的限定命令与事务

React 不直接拼装多表写入。新增以下目的限定命令：

```text
get_collections()
get_collection_detail(collectionId)
get_record_collections(recordId)
create_collection(name, description, expectedNameAvailable)
update_collection(collectionId, patch, expectedRev)
delete_collection(collectionId, expectedRev)
add_collection_members(collectionId, recordIds, sourceKind, expectedCollectionRev)
remove_collection_member(collectionId, recordId, expectedMemberRev)
reorder_collection_members(collectionId, orderedRecordIds, expectedCollectionRev)
apply_collection_suggestions(proposal, expectedRevisions)
```

每个写命令必须在一个 SQLite transaction 中：

1. 校验 ID、名称、引用、重复项、长度、revision 和最终成员排列；
2. 写集合、成员或删除标记，更新各实体 `updatedAt/rev/revActor`；
3. 更新通用 `recordsGeneration`；
4. 写入扩展后的实体 staging，并提升当前 target outbox；
5. commit 后返回数据库中的规范化实体。

任一步失败都回滚全部变化。`expectedRev` 防止长时间打开的编辑面板覆盖另一操作；返回 `stale_collection` 或 `stale_collection_member` 后，界面重新加载并要求用户重试。重复加入、提交相同名称/说明、提交相同最终顺序均为零写入幂等操作。

删除集合时，在同一事务中为集合及全部现存成员生成 tombstone。删除记录时扩展现有原子删除命令，为其全部成员关系生成 member tombstone 后再删除记录。不能仅依赖外键级联，否则另一设备无法知道关系是被明确删除。

## 5. 界面设计

### 5.1 收藏集中心

“更多”菜单增加“系列与收藏集”，打开独立全尺寸 dialog。它不增加顶部常驻按钮，避免再次挤压工具栏。

桌面采用左侧集合列表、右侧详情；760 px 以下改为列表与详情两级导航，页面本身不得横向溢出。集合列表显示封面、名称、成员数和已看数，支持名称搜索、新建、重命名和删除。详情显示说明、只读汇总和按手工顺序排列的成员。

成员支持：

- 从现有片库搜索并批量加入；
- 从集合移除，但不删除影视记录；
- 拖放排序，并提供键盘可用的“上移 / 下移 / 移到开头 / 移到末尾”；
- 点击成员打开现有记录编辑页；关闭编辑页后返回原集合和滚动位置。

删除集合必须二次确认，并明确显示“将删除 X 个归组关系，不会删除影视记录”。

### 5.2 记录入口

RecordForm 增加“所属收藏集”多选区，支持加入现有集合和就地新建。保存记录内容与调整成员关系必须由一个 Rust 编排命令或两个具有明确失败恢复的目的限定事务完成；第一版推荐记录保存成功后再提交集合变化，若第二步失败则保留记录保存并明确提示“条目已保存，收藏集更新失败”，不得伪装为全部失败。

列表卡片最多显示两个收藏集 chip 和“+N”；海报墙只显示一个紧凑标记，避免元数据过载。点击 chip 打开收藏集中心。没有收藏集的记录不显示空占位。

### 5.3 自动归组建议

收藏集中心提供显式“从 TMDB 查找建议”。扫描范围和行为：

1. 只处理具有 IMDb ID、且能得到唯一 TMDB 详情匹配的记录；无 IMDb ID 的旧数据只能手工归组。
2. 电影只接受 TMDB `belongs_to_collection.id`；分季剧集只接受明确的 `show_id`。不使用标题、年份或中文译名模糊匹配。
3. 先生成只读预览，按“新建集合、加入已有集合、名称更新建议、无法判定”分组。
4. 用户可逐项或全选确认；未确认前零业务写入、零 generation、零 outbox。
5. 已有手工集合不被自动重命名、删除、重排或移出成员；TMDB 刷新只提出新增或改名建议。
6. 同一 sourceKey 已对应集合时复用该集合，不因官方名称变化创建重复项。

在 RecordForm 使用 TMDB 填充单条记录时，可显示相同来源的非阻塞建议，但默认不勾选。自动扫描使用现有网络限额、取消和失败报告规则，不因部分查询失败阻止其他建议预览。

## 6. 本地导入、导出与恢复

本地完整备份升级为：

```json
{
  "formatVersion": 3,
  "exportedAt": "RFC3339",
  "records": [],
  "episodeCompletions": [],
  "collections": [],
  "collectionMembers": []
}
```

V3 导入先预览并完整验证：集合和成员 ID、名称唯一性、引用完整性、成员唯一键、position、时间、revision 和确定性成员 ID。任一非法实体使整个导入失败；替换 records、逐集历史、集合和成员必须在同一 Rust transaction 中完成，并预先创建 `import` 恢复点。

V2 或旧 records-only 文件不含收藏集：默认保留现有收藏集和仍指向导入后存活记录的成员，自动移除悬空成员，但不删除变空的收藏集。预览必须显示将保留、移除和变空的数量，不能把缺失的 `collections` 字段解释为清空命令。

SQLite 恢复点天然包含新增表、marker、tombstone、baseline、staging 和 outbox。恢复校验增加 `foreign_key_check`、集合名称唯一性、成员唯一性和悬空引用检查。

## 7. WebDAV V5 与冲突语义

远端文件名暂时继续使用 `records-v3.json`，payload 按需升级：

```ts
interface SyncPayloadV5 extends Omit<SyncPayloadV4, 'schemaVersion'> {
  schemaVersion: 5;
  collections: Collection[];
  collectionMembers: CollectionMember[];
  collectionTombstones: CollectionTombstone[];
  collectionMemberTombstones: CollectionMemberTombstone[];
}
```

新客户端读取 V3/V4 时视为没有收藏集；首次需要发布收藏集数据时，明确确认“云端格式将升级为 V5，旧版本将停止同步”。V4 客户端遇到 V5 必须保持当前 `unsupported_remote_schema` 行为并零 PUT。

现有单一 publish intent、ETag 条件提交、target baseline、CAS、恢复提交和 outbox 扩展到全部实体。staging 从只描述 record 的 V1 升级为带 `entityKind` 的 V2：`record | collection | collection-member | episode-completion`。旧 staging V1 可无损读取为 `record`，迁移不得丢失待发布项。

### 7.1 集合合并

- 单侧创建、修改或删除按三方基线传播。
- 名称、说明和来源字段采用字段级三方合并；两侧改不同字段自动合并。
- 两侧修改同一字段为不同值进入 `collection-edit-edit` 冲突。
- 删除对方未改的集合时删除生效；删除与对方编辑或成员变更进入 `collection-delete-edit`。
- 两台设备创建相同 sourceKey 但不同 UUID 时，以 sourceKey 识别同一逻辑集合，进入“合并重复集合”选择，不能并存后依靠名称猜测。

### 7.2 成员合并与排序

- 确定性 member ID 使两端加入同一关系可幂等合并。
- 单侧加入、移除或排序按三方基线传播。
- 一端移除、另一端未改：移除生效；移除与另一端排序/编辑：进入 `collection-member-delete-edit`。
- 两端把同一成员移动到不同 position：进入 `collection-member-order`，用户选择本机或云端顺序。
- 不同成员的排序修改可以自动合并；position 相同按 ID 稳定显示，并在下一次用户手工排序时规范化。
- 解决集合删除时选择删除，会删除其全部成员；选择保留，则保留已合并且引用有效的成员。

记录删除与另一端新增/移动其成员关系属于父子删除冲突，沿用记录 `delete-edit` 的显式选择。选择删除记录时关系一起删除；选择保留记录时再合并关系。任何合并结果出现悬空引用都不得落盘或 PUT。

## 8. 兼容与失败状态

稳定错误码至少包括：

- `collection_name_required`
- `collection_name_duplicate`
- `collection_not_found`
- `collection_member_not_found`
- `collection_reference_invalid`
- `collection_order_invalid`
- `stale_collection`
- `stale_collection_member`
- `collections_migration_failed`
- `collections_import_invalid`
- `collections_sync_upgrade_required`
- `collection_sync_conflict`

收藏集功能 migration 失败时回滚且主记录列表仍可读；收藏集入口显示不可用原因。远端 V5 未确认、版本更高、条件提交失败或存在未解决冲突时不得 PUT。TMDB 建议失败只影响建议，不影响手工收藏集和记录编辑。

## 9. 实施顺序

1. 增加 V18 功能迁移、Rust/TypeScript 模型、确定性 ID、校验和恢复点理由。
2. 实现集合/成员查询与原子 CRUD、删除标记、排序、generation、staging V2 和 outbox。
3. 实现收藏集中心、记录多选入口、卡片 chip、响应式与可访问交互。
4. 扩展 TMDB DTO和查询，完成只读建议、批量预览和显式应用。
5. 将本地备份升级到 V3，并保留 V2/旧数组的非破坏导入语义。
6. 实现 WebDAV V5、V3/V4 读取、升级确认、实体合并和冲突中心。
7. 完成 Node、Rust、Playwright、构建与迁移回归；更新架构和路线图。
8. 从干净 Git 提交构建便携 EXE；替换前备份旧 EXE，并在程序退出时核验正式数据库哈希。

## 10. 验收矩阵

### Rust / 临时 SQLite

- 全新 V18、已有数据、迁移中断和已迁移状态均可幂等启动，`db_version` 始终为 18。
- 名称规范化唯一、长度、引用、重复成员和非法顺序均由 Rust 拒绝且零写入。
- 创建、编辑、加入、移除、重排和删除与 generation/staging/outbox 同事务；故障注入全部回滚。
- 重复加入、相同编辑和相同排序为幂等零写入。
- 删除集合不删除 records；删除 record 生成成员 tombstone 且无悬空引用。
- V3 导入完整替换；V2/旧数组保留合法集合关系；恢复点可还原所有实体和同步状态。

### Node / 同步纯函数

- V3/V4 读取为空收藏集；V5 完整解析；V6+ 拒绝且零 PUT。
- 集合不同字段自动合并、同字段冲突、删除/编辑冲突和 sourceKey 重复均符合规则。
- 成员加入、移除、并发排序、父记录删除和集合删除覆盖所有三方组合。
- staging V1 无损升级为 record 实体；V2 稳定排序和 fingerprint 不因数组顺序变化产生伪写入。
- 任何悬空引用、重复关系或非法 tombstone 阻止本地提交和远端 PUT。

### Playwright

- “更多”菜单可进入收藏集中心，不增加顶部常驻按钮。
- 新建、重名提示、重命名、说明、空集合和删除确认清楚可用。
- 批量加入、重复加入、移除不删记录、拖放及键盘排序结果一致。
- RecordForm 多选和卡片 chip 正确；760 px/360 px 无页面横向溢出。
- TMDB 建议在确认前零写入，无 IMDb、歧义和部分失败有明确说明。
- V5 首次升级、冲突选择、失败回滚和陈旧 revision 有明确反馈。

## 11. 已确认的产品决策

用户于 2026-08-09 确认概念图和完整设计，以下五项推荐方案全部通过：

1. 第一版仅扁平收藏集，不做嵌套和智能动态集合。
2. TMDB 只提供预览建议，用户明确确认后才写入；不做后台静默归组。
3. 收藏集中心放在“更多”菜单，顶部不增加常驻按钮；卡片只显示少量 chip。
4. 删除收藏集永不删除影视记录；记录锁定不限制收藏集归组。
5. 收藏集作为跨设备业务数据进入 WebDAV V5，首次发布前明确确认升级。

任务已按上述核心数据、安全和交互边界实施，并在 `.agent-work/TASKS.md` 记录验收结果。发布便携 EXE 仍需在用户明确要求后，从干净且已提交的 Git 工作区单独执行。
