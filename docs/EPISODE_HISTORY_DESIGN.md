# TASK-D-HISTORY-001：逐集完成时间与完结状态专项设计

> 状态：DRAFT，等待用户确认后实施
> 日期：2026-08-02
> 数据库主版本：继续使用 V18；新增独立、幂等的 `episode_history_schema_version=1` 功能迁移
> 依赖：现有 Rust 原子写入、恢复点、sync payload V3、target 级同步状态与记录级 revision

## 1. 目标与第一版边界

为具有有效 `totalEpisodes` 的剧集类条目增加结构化“下一集待看”和逐集完成历史。用户把下一集从 K 调到 K+1 时，第 K 集只记录一次精确完成时间；跨集跳转时，中间集记为已完成但时间未知；选择完结时记录最后一集并更新整条记录状态。

第一版包括：

1. 显式启用逐集记录并选择初始下一集；不猜测旧 `progress`。
2. 下一集 1..N、完结、前进、跳集和向后调整。
3. 单集完成三态：无记录、已完成但时间未知、已完成且时间已知。
4. 逐集状态和记录更新的 Rust/SQLite 原子事务。
5. 完整数据库恢复、本地 JSON 导入导出和 WebDAV 同步。
6. 同步冲突中心处理下一集冲突与极少数完成时间冲突。

第一版不包括：观看时长、同一集多次观看、跨季聚合、批量补历史、手工编辑/删除完成时间、日历视图、Trakt 映射或 TMDB 分集播出日程。现有 `progress` 保留为旧自由文本展示与兼容字段，新功能不继续写它。

## 2. 领域语义

### 2.1 适用对象

只有同时满足以下条件的记录可以启用：

- `totalEpisodes` 是正整数；
- `mediaType` 是剧集类：`剧集`、`综艺`，或经现有统一分类规则确认的分集型 `纪录片` / `动画`；
- 记录未锁定。

电影即使误填 `totalEpisodes` 也不得直接启用。`totalEpisodes` 后续变小且小于当前 `nextEpisode` 或已有最大完成集时，停止逐集推进并显示 `episode_total_mismatch`，由用户先修正总集数；不得截断历史。

### 2.2 状态表示

单独的启用状态用于消除 `NULL` 歧义：

| `episodeTrackingEnabled` | `nextEpisode` | 含义 |
|---|---:|---|
| false | NULL | 未启用，旧记录默认状态 |
| true | 1..N | 已启用，数值是下一集待看 |
| true | NULL | 已启用且已完结 |

非法组合（未启用但有下一集、下一集越界）在 Rust 写入时拒绝；加载旧数据时只报告兼容问题，不自动制造历史。

`episode_completions` 行存在即表示该集已完成：

- 没有行：尚未记录为完成；
- 有行且 `completedAt IS NULL`：已完成，但时间未知；
- 有行且 `completedAt` 非空：已完成，时间已知。

不得使用空字符串、零或“未知”替代 `NULL`。

### 2.3 转换规则

设当前下一集为 K，用户选择的新下一集为 M，总集数为 N：

- 首次启用：只保存所选下一集，不生成任何完成记录；状态改为“在看”，`startDate` 为空时写入当前本地日期。
- M = K：幂等空操作，不改时间、revision 或同步 outbox。
- M = K+1：为第 K 集插入完成时间 `now`。
- M > K+1：为 K..M-2 插入 `completedAt = NULL`；为 M-1 插入 `completedAt = now`。
- M < K：只把下一集退回 M，不删除或修改任何已有完成记录。
- 从 K 选择“完结”：为 K..N-1 插入空时间，为 N 插入 `now`；`nextEpisode = NULL`、`status = 已看`，仅当 `endDate` 为空时写入当前本地日期。
- 从已完结退回 M：恢复 `nextEpisode = M`、`status = 在看`，保留全部单集历史和原 `endDate`。第一版不把退回操作解释为撤销历史，也不删除曾经的整剧完成日期。

若待写集已经存在：已有非空完成时间永远保留；本次转换边界上的最后一集若原来只有空时间，可以升级为本次 `now`，因为用户此刻明确完成了该集；跳过区间里的空时间仍保持为空。实现使用带条件的 UPSERT，仅允许 `NULL → 非空`，绝不允许非空时间被另一次点击或重试覆盖，从而同时满足信息补全与幂等。

`now` 由 Rust 在事务开始时生成一次 RFC 3339 UTC 时间，所有本次插入共享这个一致时刻；界面按系统本地时区显示。`endDate` 继续沿用现有本地 `YYYY-MM-DD` 语义。

## 3. V18 数据模型与功能迁移

继续保留 `settings.db_version = 18`，避免触发已存在的 V19→V18兼容转换。逐集能力使用独立功能版本，且 migration 必须在单一 SQLite 事务内幂等执行：

```sql
ALTER TABLE records ADD COLUMN episodeTrackingEnabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE records ADD COLUMN nextEpisode INTEGER NULL;

CREATE TABLE episode_completions (
  id TEXT PRIMARY KEY,
  recordId TEXT NOT NULL,
  episodeNumber INTEGER NOT NULL CHECK (episodeNumber > 0),
  completedAt TEXT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  revActor TEXT NOT NULL DEFAULT '',
  UNIQUE(recordId, episodeNumber),
  FOREIGN KEY(recordId) REFERENCES records(id) ON DELETE CASCADE
);

CREATE INDEX episode_completions_record_episode
  ON episode_completions(recordId, episodeNumber);
```

完成后写 `settings.episode_history_schema_version = 1`。迁移前创建 `reason=episode-history-migration` 的恢复点；恢复点失败则不执行 migration。字段存在但 marker 未写、表存在但索引缺失等中断状态必须通过 `PRAGMA table_info` / `sqlite_master` 检查后安全补齐，不能重复 `ALTER`。

完成事件 ID 使用确定性 SHA-256：`sha256("episode-completion:v1\0" + recordId + "\0" + episodeNumber)`。它不依赖设备或时间，因此两台设备离线记录同一集时会合并到同一逻辑实体。`recordId + episodeNumber` 唯一约束是最终数据库防线。

本方案属于 V18 的受控加法扩展。升级后的数据库不得再由 `8302c43` 及更早便携版交替打开，因为旧版全量替换不理解新字段。新版在设置中记录 `required_app_features_v1 = ["episode-history-v1"]` 并显示说明；正式发布前保留可恢复的旧 EXE 和迁移前恢复点。

## 4. Rust 原子命令

React 不再组合“更新记录 + 插入历史”多次调用。新增目的限定命令：

```text
get_episode_tracking(recordId)
enable_episode_tracking(recordId, initialNextEpisode, expectedRev)
set_next_episode(recordId, nextEpisode | completed, expectedRev)
```

`set_next_episode` 在一个 SQLite transaction 中完成：

1. 读取记录并检查锁定、类型、总集数、启用状态和 `expectedRev`；
2. 计算转换计划和单一 `now`；
3. 插入缺失完成事件；只对本次边界集执行 `completedAt IS NULL` 条件下的 `NULL → now` 升级；
4. 更新 `nextEpisode`、必要的 `status/endDate/startDate`、记录 `updatedAt/rev/revActor`；
5. 更新逐集 staging、records generation、target outbox 与自动同步调度；
6. commit 后返回最新记录、完成事件增量和是否为幂等空操作。

任何 SQL、校验、generation、staging 或 outbox 步骤失败都回滚全部变化。`expectedRev` 防止用户打开菜单后另一操作已推进进度；失败返回 `stale_episode_progress` 并重新加载，不盲目重试旧选择。

锁定记录禁止启用和推进。删除记录由外键级联删除当前完成行，但同步侧必须把父记录 tombstone 当作整个逐集子树的删除边界。

## 5. 界面方案

### 5.1 首次启用

满足适用条件但尚未启用的卡片显示“启用逐集记录”。点击后弹出轻量面板，明确说明旧进度不会自动转换，并要求用户选择“下一集从第几集开始”。默认建议：

- 旧 `progress` 为空：第 1 集；
- 旧 `progress` 非空：不根据文本预选集数，要求用户明确选择。

确认前预览“不会补造此前集数的完成时间”。启用本身不产生完成事件。

### 5.2 日常操作

启用后卡片下拉框标签明确为“下一集”：第 1 集至第 N 集，最后一项“完结”。选择后立即执行原子命令，不再写自由文本 `progress`。成功通知显示本次新增多少条已完成记录、其中多少条时间未知；失败恢复下拉框到服务器返回值。

卡片进度比例使用已确定完成的集数数量 / N，而不是把 `nextEpisode` 直接当作已看数量。历史三态在第一版提供只读列表：集号、完成状态、本地显示时间；时间未知显示“已完成 · 时间未记录”。

已完结记录允许选择“重新设为在看并指定下一集”，但文案必须说明不会删除历史。总集数冲突、记录锁定和旧客户端不兼容均使用固定可诊断文案。

## 6. WebDAV 同步 V4

逐集历史不能塞进当前 record 数组后假装仍是 V3。远端 `records-v3.json` 文件名暂时不变以复用现有安全条件写入与 target 状态，但 payload 升级为：

```ts
interface SyncPayloadV4 extends Omit<SyncPayloadV3, 'schemaVersion'> {
  schemaVersion: 4;
  episodeCompletions: EpisodeCompletion[];
}
```

新客户端接受 V3 和 V4：V3 解析为没有逐集历史的只读基线；在首次启用逐集记录或首次需要发布逐集数据时，设置页明确确认“云端同步将升级到 V4，旧版本将停止同步”。确认后下一次安全条件 PUT 写 V4。当前 V3 客户端遇到 V4 已会返回 `unsupported_remote_schema` 并禁止 PUT，因此不会静默抹掉历史。

target 级 baseline、staging、publish intent、payload fingerprint 和 commit 恢复全部扩展到完成事件。逐集变化必须与 record 变化共用一个 publish intent 和一次条件 PUT，不能先后上传两份不一致状态。

### 6.1 完成事件合并

完成事件是只增不改的单值实体：

- 单侧存在：传播该行；
- 两侧均为空时间：合并；
- 一侧为空、一侧有时间：有时间者胜出；
- 两侧是相同时间：合并；
- 两侧有不同非空时间：进入 `episode-completion-time` 冲突，用户选择本机或云端，不能按墙上时钟自动决定。

合并后 `createdAt` 取最早合法值，`updatedAt/rev/revActor` 由合并提交生成。第一版没有单集删除，因此不增加 completion tombstone；未来若开放历史编辑/删除，必须升级协议再加入 tombstone，不能用“缺行”表达删除。

### 6.2 父记录冲突和删除

`nextEpisode` 是普通业务字段：两端从同一 baseline 改成不同值时进入 record 字段冲突，不取最大值，因为向后调整是合法操作。解决 record 冲突时必须连同两端完成事件子树显示差异：

- 采用某端记录值不删除另一端已存在的、无时间冲突的完成事件；
- 不同非空完成时间仍单独选择；
- 父记录删除与另一端推进构成 `delete-edit`，保持现有显式选择；选择删除时级联删除全部完成行，选择保留时保留合并后的子树；
- 锁定的本地记录也冻结其逐集子树，远端变化进入冲突中心。

## 7. 导入、导出与恢复

本地导出从纯 records 数组升级为版本化信封：

```json
{
  "formatVersion": 2,
  "exportedAt": "RFC3339",
  "records": [],
  "episodeCompletions": []
}
```

`episodeTrackingEnabled` 和 `nextEpisode` 随 records 导出，完成事件单列。导入必须先验证引用、唯一键、正集号、RFC 3339 时间、总集数边界和 event ID；任一非法行使整个预览失败，不能部分吞掉历史。

导入行为：

- formatVersion 2：作为完整快照预览，records 与完成事件在一个 Rust transaction 中替换；开始前创建 `import` 恢复点。
- 旧 records 数组 / formatVersion 1：明确标记“不含逐集历史”。匹配 record ID 的本地逐集状态默认保留；被导入结果删除的父记录会连同历史删除。界面必须展示保留/删除数量，不能把缺失历史解释为清空命令。
- 导出到旧格式只允许显式选择“仅导出基础记录”，并警告逐集历史不会包含。

恢复点是 SQLite 完整快照，天然包含新增列、表、marker、同步 baseline/staging/outbox。恢复校验增加逐集表行数、外键检查和唯一性检查；恢复到迁移前 V18 数据库后，下次启动可重新执行功能迁移，且不会凭旧 `progress` 造历史。

## 8. 兼容与失败状态

稳定错误码：

- `episode_tracking_not_enabled`
- `episode_tracking_unsupported_media`
- `episode_total_missing`
- `episode_total_mismatch`
- `episode_out_of_range`
- `episode_record_locked`
- `stale_episode_progress`
- `episode_history_corrupt`
- `episode_history_migration_failed`
- `episode_sync_upgrade_required`

失败只阻断逐集动作或需要它的同步。记录列表、编辑、TMDB 和其他本地功能继续可用。功能 migration 失败必须回滚并保持迁移前数据库；同步 V4 未确认、远端版本过高或完成时间冲突时不得 PUT。

`totalEpisodes` 从空值补全后只让功能变得可启用，不自动启用。普通记录编辑不得修改 `episodeTrackingEnabled/nextEpisode`；它们只能由目的限定 Rust 命令更新。批量元数据补全若改变总集数，不得截断完成事件或移动下一集。

## 9. 实施顺序

1. 增加 V18 功能迁移、模型、约束、确定性 event ID 和恢复点理由。
2. 实现只读查询、显式启用和原子 `set_next_episode`，接入 generation/staging/outbox。
3. 替换卡片旧集数下拉框，增加启用面板、只读历史和错误状态。
4. 扩展本地导入导出与恢复校验；继续兼容旧 records-only 文件。
5. 实现 sync payload V4、V3 读取兼容、升级确认、完成事件 merge/conflict 和发布恢复。
6. 补齐 mock、临时 SQLite、Node merge 和 Playwright 验收，更新架构文档。
7. 从干净 Git 提交构建便携版，停止旧程序，备份旧 EXE，并在部署前后核验真实数据库；迁移由用户首次启动新版触发。

## 10. 验收矩阵

### Rust / 临时 SQLite

- V18 无功能表、迁移中断和已完成迁移均可幂等启动；`db_version` 始终为 18。
- 首次启用不生成历史；K→K+1、跳集、完结、后退和完结后退严格符合规则。
- 重复选择、重试和确定性 event ID 不覆盖首次非空时间、不产生重复行。
- 记录更新、完成行、generation、staging 和 outbox 任一注入失败均整体回滚。
- 锁定、非法类型、缺总集数、越界、总集数缩小和 stale revision 均零写入。
- 删除级联、导入替换、恢复点恢复和外键检查保持 records/历史一致。

### Node / 同步纯函数

- V3 读取为空历史；V4 完整解析；V5+ 拒绝且零 PUT。
- 单侧事件、NULL/时间、相同时间和不同时间分别按规则合并。
- `nextEpisode` 并发不同值进入字段冲突，不按最大值覆盖。
- record 删除/推进、锁定记录、target 切换、staging 和 publish intent 恢复覆盖逐集子树。
- 数组顺序变化不产生业务写入，payload fingerprint 对完成事件使用稳定排序。

### Playwright

- 旧 progress 非空时启用必须明确选初始下一集；不自动推断历史。
- 卡片显示“下一集”，第 N 集后是完结；跳集结果区分时间未知和精确时间。
- 完结更新已看/endDate，退回在看但保留历史与 endDate。
- 总集数冲突、锁定、失败回滚和 stale 更新有明确反馈。
- V4 首次上传需要确认；取消时零 PUT；旧客户端不兼容提示清晰。
- 本地 V2 导入导出往返无损；旧文件导入明确显示历史保留边界。

### 真实便携版门禁

自动测试不读取或写入真实便携数据库和真实 WebDAV。部署前后只读核验 V18、记录数、完整性和哈希；复制阶段只替换 EXE。用户首次启动后再核验 `episode_history_schema_version=1`、原 records 数量不变和功能表初始为空，随后由用户手工确认一条测试记录的启用/推进行为。

## 11. 待确认决策

推荐按本文方案实施，需确认以下三点：

1. 为区分“未启用”和“已完结”，除 `nextEpisode` 外增加 `episodeTrackingEnabled`；旧 `progress` 原样保留，不再由新下拉框更新。
2. 数据库主版本继续标记 V18，使用 `episode_history_schema_version=1` 做受控功能迁移；升级后的数据库不再与旧便携版交替使用。
3. WebDAV payload 升级为 V4，并在首次发布前明确确认；旧客户端将安全停止同步，必须更新到支持 V4 的版本。
