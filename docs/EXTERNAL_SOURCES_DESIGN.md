# TASK-D-LINK-001：可播放来源与外部链接专项设计

> 状态：SPECIFIED / USER-PAUSED（2026-08-22；保留设计，暂不实施）
> 设计日期：2026-08-22
> 数据库主版本：继续使用 V18；新增独立、幂等的 `record_sources_schema_version=1` 功能迁移
> 依赖：Rust 目的限定写入、恢复点、持久化 outbox / staging、WebDAV payload V6、本地备份 V4

## 1. 目标与第一版边界

为每条影视记录增加多个可操作来源，让用户可以保存正版播放页、资料页、私人媒体服务地址，以及此设备上的媒体文件或目录，并从卡片安全打开。来源是独立领域实体，不复用现有 `platform` 文本，也不把地址数组塞进 `WatchRecord`。

第一版包括：

1. 一条记录拥有多个来源，并分别维护“在线来源”和“此设备来源”的顺序。
2. 在线来源支持预置平台和自定义 HTTPS 地址；用户可选择跨设备同步或仅此设备保存。
3. 此设备来源支持本地媒体文件和目录，永远不进入 WebDAV 或普通 JSON 导出。
4. 新增、编辑、删除、排序全部由 Rust 目的限定命令完成；同步来源变化与 generation、staging、outbox 同事务提交。
5. 打开前由 Rust 重新读取已保存实体并校验类型、协议、主机或规范化路径；React 不能提交任意地址要求系统打开。
6. 卡片提供紧凑的主来源入口和完整来源菜单，记录表单提供管理界面。
7. 本地备份升级为 V5，WebDAV 按需升级为 V7；旧格式继续安全读取，未来格式拒绝且零写入。

第一版不包括：在线播放器内嵌、DRM 绕过、平台账号或播放进度抓取、资源可用性后台探测、自动搜索盗版来源、自定义命令、任意 URI scheme、网络共享路径、快捷方式、可执行文件、来源跨记录批量复制，以及从 `platform` 文本自动生成并持久化链接。

现有 IMDb 标签继续作为基于 `imdbId` 的派生资料入口，不迁移成用户来源，也不参与排序或同步。后续可以用同样方式派生 TMDB 资料入口；派生入口不是业务数据。

## 2. 领域模型与隐私边界

统一实体名为 `RecordSource`：

```ts
type RecordSourceKind = 'web' | 'file' | 'directory';
type RecordSourceScope = 'synced' | 'device';

interface RecordSource {
  id: string;
  recordId: string;
  kind: RecordSourceKind;
  scope: RecordSourceScope;
  label: string;
  locator: string;
  platformKey: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  rev: number;
  revActor: string;
}
```

固定规则：

- `web` 可以是 `synced` 或 `device`；`file` / `directory` 必须是 `device`。
- `synced` 来源会进入本地 V5 导出和 WebDAV V7；`device` 来源只存在于当前 SQLite 和完整恢复点。
- 在线和此设备来源是两个排序分区。`sortOrder` 只在同一 `recordId + scope` 内有意义，避免某台设备独有路径改变其他设备的在线排序。
- `platformKey` 只是受控模板标识，不代替实际 URL。平台改域名时可以升级验证规则，不静默改写用户保存的地址。
- `platform` 仍是筛选和元数据展示字段，不与来源互相覆盖。用户的平台文字可能是“Netflix”，但并不代表已有可打开的 Netflix 来源。
- 锁定记录禁止新增、编辑、删除和排序来源；读取与打开仍允许。记录删除必须级联删除来源，同步侧以父记录 tombstone 覆盖整棵来源子树。

对用户明确说明隐私：同步在线来源会上传完整 URL。带私人服务器地址、访问参数或不希望跨设备传播的链接必须选择“仅此设备”。URL 中的用户名、密码和明显凭据参数不允许保存；本地路径从不进入遥测、通知正文、普通日志、WebDAV 或 JSON 导出。

## 3. V18 数据模型与功能迁移

继续保留 `settings.db_version = 18`，新增幂等功能迁移：

```sql
CREATE TABLE record_sources (
  id TEXT PRIMARY KEY,
  recordId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'file', 'directory')),
  scope TEXT NOT NULL CHECK (scope IN ('synced', 'device')),
  label TEXT NOT NULL,
  locator TEXT NOT NULL,
  platformKey TEXT NULL,
  sortOrder INTEGER NOT NULL CHECK (sortOrder >= 0),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  revActor TEXT NOT NULL DEFAULT '',
  CHECK (kind = 'web' OR scope = 'device'),
  CHECK (kind = 'web' OR platformKey IS NULL),
  FOREIGN KEY(recordId) REFERENCES records(id) ON DELETE CASCADE
);

CREATE INDEX record_sources_record_scope_order
  ON record_sources(recordId, scope, sortOrder, id);

CREATE TABLE record_source_tombstones (
  id TEXT PRIMARY KEY,
  recordId TEXT NOT NULL,
  deletedAt TEXT NOT NULL,
  rev INTEGER NOT NULL,
  revActor TEXT NOT NULL
);
```

完成后写入：

- `record_sources_schema_version = 1`；
- `required_app_features_v1` 增加 `record-sources-v1`。

迁移前建立 `reason=record-sources-migration` 的验证恢复点；恢复点失败则不迁移。迁移检查表、列、索引和 marker，允许在异常中断后幂等补齐。初始表为空，不从 IMDb、TMDB 或 `platform` 猜测来源。

来源 ID 使用 UUID v4。在线来源另存 Rust 计算的临时规范键用于同记录查重，不把该键暴露为协议字段；首版可以用唯一索引或事务内查询保证同一记录、同一 scope 下没有重复的规范 URL。编辑 URL 保留来源 ID，从而让排序、同步和冲突仍指向同一实体。

同步删除只为 `scope=synced` 写 tombstone；设备来源删除是纯本地删除。父记录删除时不需要逐项上传 tombstone，父记录 tombstone 已定义删除整个来源子树；若只删除单个同步来源则写 `record_source_tombstones`。

## 4. 地址规范化与安全校验

### 4.1 在线来源

保存和每次打开时都由 Rust 使用同一验证器执行：

1. 去除首尾空白，解析为绝对 URL；只接受小写规范后的 `https`。
2. 必须有 DNS 主机名；拒绝用户名、密码、空主机、控制字符、反斜杠混淆和超长地址。
3. 拒绝 IP literal、`localhost`、`.local`、单标签主机以及解析语义明显属于本机/私网的地址作为 `synced` 来源。私人媒体服务可保存为 `device`，但仍必须使用 HTTPS 和合法主机。
4. 默认端口归一化，主机转小写/IDNA；保留 path、query 和 fragment 的语义，不重排 query，不跟随重定向，也不在保存时发网络请求。
5. 拒绝常见秘密载荷：URL userinfo，以及键名匹配 `token`、`access_token`、`auth`、`api_key`、`apikey`、`signature`、`sig` 的 query。此规则是防误传底线，不承诺识别所有秘密。
6. 预置平台必须同时通过平台 host 规则；例如 Netflix 模板不能保存到拼写相似的第三方域名。自定义来源不使用平台图标或可信标记。

长度上限：完整 URL 2048 个 Unicode scalar，标签 1～40 个字符；标签去首尾空白、折叠连续空白并拒绝控制字符。平台模板目录是代码内静态配置，首批包括 IMDb、TMDB、Netflix、Disney+、Prime Video、Apple TV、YouTube、哔哩哔哩、腾讯视频、优酷、爱奇艺，以及“自定义 HTTPS”。模板只提供名称、图标语义、示例和允许 host，不根据标题猜测具体播放页。

### 4.2 本地文件与目录

本地选择必须使用 Tauri 文件/目录选择器返回的路径，界面不提供自由文本粘贴。保存和打开均由 Rust：

- 转换为绝对规范路径并确认目标存在；文件必须是普通文件，目录必须是目录。
- 第一版拒绝 UNC、设备路径、网络映射语义、符号链接 / junction 最终指向网络位置，以及 `.lnk`、`.url` 等间接目标。
- 文件使用扩展名 allowlist：`mp4`、`mkv`、`avi`、`mov`、`wmv`、`webm`、`m4v`、`mpg`、`mpeg`、`ts`、`m2ts`、`flv`、`mp3`、`m4a`、`aac`、`flac`、`wav`、`ogg`、`opus`。
- 明确拒绝可执行、安装、脚本、注册表和快捷方式类型；未知扩展不允许用“仍然打开”绕过。
- 路径最多 1024 个字符。数据库保存规范绝对路径，但所有用户可见错误和普通日志只显示文件名或经截断的目录尾部，不输出完整路径。

路径在保存后可能移动或离线。读取来源列表不检查磁盘；用户点击时才检查。失效目标返回 `source_target_missing` 并提供“重新定位”或“删除来源”，不自动搜索磁盘，也不改变记录状态。

## 5. Rust 命令与原子边界

新增目的限定命令：

```text
list_record_sources(recordId)
create_record_source(recordId, draft, expectedRecordRev)
update_record_source(sourceId, patch, expectedSourceRev, expectedRecordRev)
delete_record_source(sourceId, expectedSourceRev, expectedRecordRev)
reorder_record_sources(recordId, scope, orderedIds, expectedRecordRev)
open_record_source(sourceId)
```

写命令在单一 SQLite transaction 中：

1. 读取父记录并校验存在、锁定和 `expectedRecordRev`；
2. 规范化并验证来源，检查重复、scope 和平台模板；
3. 写来源或 tombstone，连续重排为 `0..N-1`；
4. 对同步来源更新来源自己的 revision，并更新来源 staging、generation 和 target outbox；不修改父记录的业务字段、`updatedAt` 或 revision；
5. 对设备来源不推进父记录 revision 或同步 generation，只更新来源自己的 revision；
6. commit 后返回规范化实体和最新父记录版本。

任一校验、SQL、staging 或 outbox 步骤失败均整体回滚。排序提交必须精确包含该 scope 当前全部 ID；重复、缺失、多余或 stale revision 均零写入。幂等重排不推进 revision。

`open_record_source(sourceId)` 是只读命令：它从数据库读取实体，重新执行当前验证器，再调用系统默认处理程序。命令不接受 locator；React 无法用开发者工具绕过校验打开任意字符串。打开失败不修改最近使用时间、记录状态、revision 或 outbox。为了关闭旧旁路，卡片 IMDb 入口也改为一个只接受合法 IMDb ID 的 Rust 命令，前端 capability 移除通用 `shell:allow-open`。

稳定错误码：

- `source_not_found`
- `source_record_locked`
- `source_stale`
- `source_duplicate`
- `source_invalid_kind`
- `source_invalid_scope`
- `source_invalid_label`
- `source_invalid_url`
- `source_insecure_scheme`
- `source_host_not_allowed`
- `source_secret_in_url`
- `source_invalid_path`
- `source_target_missing`
- `source_file_type_not_allowed`
- `source_open_failed`
- `source_sync_upgrade_required`

## 6. 界面与交互

### 6.1 卡片

- 有用户来源时显示“来源”按钮；按钮正文使用当前 scope 内排序第一的可用名称，但不在列表渲染阶段访问网络或磁盘。
- 单击按钮打开菜单，分为“在线来源”“此设备”“资料入口”三组。每项显示平台/类型、同步状态和失效提示；资料入口包含现有 IMDb 派生入口。
- 只有一个用户来源时，主按钮仍先展示菜单，不把单击直接变成外部跳转，避免误触；菜单项点击才执行打开。
- 打开失败在卡片内显示可恢复错误，不用 `console.error` 作为唯一反馈。
- 锁定记录仍可打开，但菜单不显示编辑、删除或排序动作。

### 6.2 记录表单

RecordForm 增加“可播放来源与链接”区块：

- “添加在线来源”先选平台模板，再粘贴 URL、填写标签并选择“跨设备同步 / 仅此设备”。保存前展示规范化 host 和隐私说明，不请求该地址。
- “添加本地文件”“添加目录”调用选择器；选择后展示文件名或目录尾部，不默认暴露完整绝对路径。
- 两个 scope 分区独立拖动或上移/下移；窄屏和键盘用户必须有非拖拽排序按钮。
- 修改记录其他字段与来源写入是两个明确提交域。关闭尚未保存的来源编辑器要提示，但不能因普通表单保存失败而留下半条来源。
- 记录锁定、stale、目标丢失、URL 被拒绝和平台 host 不匹配都有具体反馈。

首版不提供自动“可用/不可用”探测。未点击的来源不产生网络流量；因此离线时仍可管理和排序来源，只有打开动作可能由系统返回失败。

## 7. 本地导入导出与恢复

普通 JSON 导出升级为 V5：

```json
{
  "formatVersion": 5,
  "exportedAt": "RFC3339",
  "records": [],
  "episodeCompletions": [],
  "collections": [],
  "collectionMembers": [],
  "recordSources": []
}
```

`recordSources` 只包含 `kind=web + scope=synced`。导出页面明确显示“此设备来源未导出 N 项”；完整 SQLite 恢复点仍包含所有来源。首版不增加含绝对路径的可携 JSON 导出，避免误分享设备路径。

导入 V5 前验证父引用、ID、kind/scope、标签、URL、平台 host、顺序、时间和重复；任一非法行使整个预览失败。导入应用时，records、逐集历史、收藏集和同步来源在一个 Rust transaction 中替换，并先创建 `reason=import` 恢复点。当前设备来源按 `recordId` 保留；若父记录被导入删除则级联删除。预览必须列出保留的设备来源数量，不能把 V5 中缺少设备来源解释为清空。

V1～V4 文件继续按现有规则读取并视为“不含可同步来源”：匹配记录的已有来源默认保留；被导入删除的父记录仍连同来源删除。V6+ 本地格式拒绝且零写入。

恢复点是完整 SQLite 快照，天然包含设备来源。恢复校验增加来源外键、类型/scope CHECK、同步来源 URL 重验和每分区顺序完整性；恢复后的目标缺失只在点击时提示，不使数据库恢复失败。

## 8. WebDAV 同步 V7

远端文件名继续使用 `records-v3.json`，payload 增加：

```ts
interface SyncPayloadV7 extends SyncPayloadV6 {
  schemaVersion: 7;
  recordSources: RecordSource[];
  recordSourceTombstones: RecordSourceTombstone[];
}
```

只序列化同步 HTTPS 来源及其 tombstone。V3～V6 读取为空来源基线；只有首次创建/导入同步来源时才要求用户确认升级到 V7。只有设备来源的数据库继续发布最小兼容 V3～V6，不触发升级。V7 客户端接受 V3～V7；V8+ 拒绝且零 PUT。旧 V6 客户端遇到 V7 已按未来版本规则停止同步，不能覆盖来源。

来源与 records、逐集历史、收藏集共用一次 snapshot、baseline、staging、publish intent、payload fingerprint、条件 PUT 和本地 commit。数组按 `recordId + scope + sortOrder + id` 稳定排序，纯数组顺序变化不得产生业务写入。

合并规则：

- 不同来源 ID 独立合并；同一规范 URL 的并发新增使用字典序较小的 ID 作为稳定存活实体并为另一 ID 生成 tombstone；标签或排序不一致仍进入可解释冲突，不静默任选一端。
- 同一 ID 的 label、locator、platformKey、sortOrder 或 scope 从共同 baseline 被两端不同修改时进入 `record-source-field` 冲突，不按时间戳覆盖。
- 删除与另一端编辑进入 `record-source-delete-edit`，由用户选择删除或保留。
- 父记录删除与来源新增/编辑沿用父记录 `delete-edit`；选择删除即删除整个来源子树，选择保留则合并合法来源。
- 设备来源不进入 baseline、冲突中心或远端 payload；远端同 ID 也不得覆盖本机设备来源，创建时两类 ID 必须全库唯一。
- 冲突解决结果通过 Rust SyncCommit 与 records、来源、tombstone、generation、staging 和 outbox 同事务落盘。

## 9. 实施批次

### Batch A：领域、迁移与安全打开边界

1. 新增来源共享类型、纯验证模型和 Node 测试。
2. 实现 V18 幂等功能迁移、恢复点、表约束与 Rust CRUD/排序测试。
3. 实现只按来源 ID 打开的 Rust 命令、本地路径 allowlist 和平台 host 校验。
4. 把 IMDb 打开迁移到目的限定 Rust 命令，移除前端通用 shell open capability。

Batch A 不修改导入格式或 WebDAV；来源仅在临时数据库中通过命令验证，不向真实用户库执行故障注入。

### Batch B：卡片与记录表单

1. 增加来源列表 hook、管理区块、文件/目录选择器和两个排序分区。
2. 卡片增加来源菜单、派生资料入口、错误反馈和锁定语义。
3. 增加键盘、焦点恢复、Escape、360px 和零隐式写入验收。

Batch B 完成后本地/设备来源可用，但 WebDAV 仍不得序列化新实体。

### Batch C：导入、同步与完整回归

1. 本地备份升级 V5，兼容 V1～V4并拒绝 V6+。
2. WebDAV 升级 V7，接入 staging、publish intent、冲突中心和目标隔离。
3. 更新架构文档、mock IPC、便携版验收用例并执行完整门禁。

每批独立提交；只有前一批门禁通过后进入下一批。真实便携替换、真实数据库迁移和真实 WebDAV 验证另行由用户明确授权。

## 10. 验收矩阵

### Rust / 临时 SQLite

- 无表、中断迁移和已完成迁移均可幂等启动；主版本保持 V18，初始来源为空。
- CRUD、两个分区排序、重复、锁定、stale、父删除级联及任一步故障回滚符合规则。
- 同步来源自身 revision、generation、staging、outbox 同事务，且不推进父记录 revision；设备来源不改变同步状态。
- HTTPS、IDNA、userinfo、秘密 query、伪造平台 host、私网 host、超长值和控制字符覆盖拒绝边界。
- 本地文件/目录、目标移动、UNC、链接、未知扩展和可执行类型覆盖 allowlist。
- `open_record_source` 不接受 locator；数据库内容被篡改后打开仍重新校验并拒绝。
- 前端 capability 不再允许直接调用通用 shell open。

### Node / 同步纯函数

- V3～V6 读取为空来源；V7 完整往返；V8+ 拒绝且零 PUT。
- 设备来源永不进入 payload、fingerprint、baseline 或冲突。
- 单侧新增、相同修改、字段冲突、删除/编辑、父删除及规范 URL 重复合并符合规则。
- 稳定排序不因数组输入顺序变化产生新 fingerprint 或业务写入。
- V1～V4 导入保留已有来源；V5 只替换同步来源并保留父记录仍存在的设备来源。

### Playwright

- 在线模板、自定义 HTTPS、本地文件和目录创建流程都有确认前零写入测试。
- `http`、危险 scheme、错误平台 host、含凭据 URL 和危险文件类型给出准确反馈且零写入。
- 卡片菜单按三组显示；点击才打开，展开、排序、取消、Escape 和页签切换均不打开目标、不写业务数据。
- 锁定记录可打开但不能管理；stale 排序重新加载而不覆盖。
- V7 首次上传显式确认，取消保持零 PUT；只新增设备来源不触发升级。
- V5 导入预览说明设备来源保留，非法来源整批拒绝。
- 360px 下标签截断、菜单、管理区和非拖拽排序全部可达。

### 便携版门禁

自动化只使用 mock IPC、临时 SQLite、临时文件和本机临时 HTTPS 测试地址；不打开真实浏览器页面、不访问真实流媒体、真实 WebDAV 或真实用户数据库。构建完成后在全新隔离便携目录验证空库启动、一个临时 HTTPS 来源、一个临时媒体文件、目标删除提示和进程清理。替换用户便携版前必须另行备份旧 EXE 与数据库，并由用户确认迁移窗口。

## 11. 推荐决策与暂停状态

如未来恢复本任务，建议按以下默认方案重新确认后实施：

1. 在线来源允许“跨设备同步”或“仅此设备”；本地文件/目录强制仅此设备。
2. 第一版只允许 HTTPS 和媒体文件 allowlist，不开放 HTTP、自定义协议、网络共享、快捷方式或“仍然打开”。
3. 卡片始终先展开来源菜单，再由用户点击具体来源，避免单击误跳转。
4. 数据库保持 V18，以 `record_sources_schema_version=1` 迁移；本地备份升 V5，WebDAV 仅在出现同步来源时升 V7。
5. 按 Batch A（安全领域）→ Batch B（UI）→ Batch C（导入同步）实施，每批独立提交和验收。

用户于 2026-08-22 明确要求暂不实施。本设计只作为未来恢复时的技术基线；当前不得开始 Batch A、修改业务代码、执行数据库迁移、升级导入/WebDAV 格式或替换便携版。只有用户以后明确恢复本任务并确认届时仍适用的安全与兼容决策，才重新进入实施排期。
