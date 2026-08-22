# TASK-D-ARCH-002：同步模块和大型组件拆分设计

> 状态：APPROVED
> 日期：2026-08-22
> 前置任务：`TASK-D-ARCH-001`（已实现）
> 数据边界：纯结构迁移；不修改 V18、WebDAV schema、同步状态机、IPC、设置键或界面行为
> 用户确认：2026-08-22，批准按 Batch A～D 分批实施

## 1. 目标

把当前集中在少数大文件中的职责拆成可独立理解、测试和替换的模块，同时保留现有业务入口和行为：

- `webdav.ts`：639 行，混合凭据门面、传输、ETag 条件写入、payload 升级、三方合并协调和旧格式导入。
- `useWatchList.ts`：341 行，混合记录 CRUD、React 状态、自动同步调度、重试、事件监听和通知去重。
- `RecordForm.tsx`：934 行，混合表单状态、TMDB 搜索与映射、时间输入、收藏集草稿和全部 JSX。
- `SettingsModal.tsx`：1899 行，混合五个页签、WebDAV 配置、导入导出、恢复点、海报缓存和批量元数据补全。

本任务的完成标准不是机械减少行数，而是让领域规则、外部副作用和视图渲染拥有明确依赖方向，并能分别测试。

## 2. 不做事项

- 不引入 Zustand、Redux 或新的状态框架。
- 不更换 `useWatchList` 作为 `App` 的记录主入口。
- 不改变 `syncToWebDAV`、`hasCreds` 等现有公共 API 的调用语义。
- 不改变自动同步触发条件、退避算法、冲突冻结、ETag 重试次数或错误文案。
- 不改变 `records-v3.json`、WebDAV V3～V6 兼容规则、target ID/epoch、outbox、staging 或 publish intent。
- 不把 TypeScript 协调逻辑迁入 Rust，也不新建后台常驻服务。
- 不改变表单字段、默认值、校验、TMDB 映射、收藏集草稿提交时机或设置页签布局。
- 不顺带实施可播放来源、发布 epoch、多观看会话或其他后续路线图能力。

## 3. 必须保持的行为契约

### 3.1 同步

1. 打开同步菜单或设置页不产生网络请求和业务写入。
2. 自动同步仍在启动、本地写入防抖、窗口聚焦、网络恢复、周期到期、重试和恢复暂停时触发。
3. 同一时间只运行一个同步；运行中收到新请求只安排一次后续重跑。
4. 每次协调先读取当前 target 与本地快照；target ID/epoch 变化必须拒绝旧请求。
5. 远端存在时必须使用强 ETag `If-Match` 或 WebDAV `If`；无安全验证器时禁止上传。
6. 412 最多按现有上限重新拉取、合并和提交；同一拒绝条件持续出现后停止。
7. 上传前写 publish intent，确认时继续使用 `expectedGeneration` CAS；网络等待期间的新本地修改不得被覆盖。
8. 旧 `records.json` 默认只读，变化后只能经显式导入进入冲突中心。
9. V7+ 明确拒绝且零 PUT；V3～V6 的升级确认规则不变。
10. 自动失败通知按安全错误码去重，原始秘密和内部错误不进入 UI。

### 3.2 记录主链路

1. Rust 仍是记录、逐集历史和同步状态的唯一持久写入者。
2. CRUD 成功后 React 列表立即采用 Rust 返回值，不自行构造 revision。
3. 本地写入继续提升 outbox，并按用户配置防抖安排同步。
4. 导入、数据库恢复和同步成功后继续从 Rust 重新加载完整记录。
5. 组件卸载必须清理 timeout、interval、focus、online 和 visibility 监听。

### 3.3 RecordForm

1. 新建和编辑字段、空值表现、媒体类型切换及时间解析结果不变。
2. TMDB 搜索、剧集/季选择、平台推断和海报后台下载语义不变。
3. 已维护字段不得因拆分被 TMDB 静默覆盖。
4. 收藏集选择和草稿只在保存记录时一起提交；关闭管理器不产生业务写入。
5. 外层及收藏集管理弹窗继续满足焦点、Escape、遮罩关闭和焦点恢复契约。

### 3.4 SettingsModal

1. 五个页签、初始页签和现有可访问名称不变。
2. 连接新 WebDAV 目标前仍先只读 probe，并在用户确认后激活。
3. 导入、恢复、清缓存、VACUUM 和批量补全继续采用当前确认及恢复点边界。
4. 批量元数据扫描/预览为只读，应用时逐项复核，只补缺失字段。
5. 页签组件不得在单纯挂载时重复执行原本只运行一次的 IPC。

## 4. 目标依赖方向

```text
React views
  ├─ feature hooks/controllers
  │    ├─ application services
  │    │    ├─ pure domain functions
  │    │    └─ transport/storage ports
  │    └─ existing Tauri database facade
  └─ shared presentational components

webdav transport ──> Tauri invoke
sync application service ──> transport + database facade + merge domain
useWatchList ──> record repository facade + sync coordinator hook
```

依赖只能向下。纯领域模块不得导入 React、Tauri `invoke`、DOM 或数据库 facade；传输层不得决定合并和 UI 文案；页签视图不得直接实现同步重试算法。

## 5. 目标目录与职责

### 5.1 同步领域

```text
src/features/sync/
  domain/
    syncErrors.ts              安全错误码归一和用户文案映射
    syncPayload.ts             legacy/V3～V6 解析、side 转换和 payload 构造
    entityTags.ts              ETag 规范化、强弱判断和安全候选选择
  infrastructure/
    webdavTransport.ts         GET/PUT/MKCOL/PROPFIND 与 probe 请求适配
    syncCredentials.ts         active target 凭据门面与 URL 规范化
  services/
    syncService.ts             一次显式同步的拉取、合并、条件提交和确认
    legacyImportService.ts     旧资源只读加载和显式冲突导入
  hooks/
    useSyncCoordinator.ts      自动触发、单飞、重跑、退避、计时器和事件监听
  index.ts                     稳定公共出口
```

`src/shared/lib/webdav.ts` 在迁移期间保留为兼容门面，只从新模块重导出现有 API；调用方不得在同一批次被迫整体改名。

现有 `syncMerge.ts`、`collectionSync.ts` 和 `syncScheduling.ts` 已是纯函数模块，本任务不重写其算法。迁移后可移动到 `features/sync/domain`，但第一批只允许通过重导出改变位置，避免算法与路径同时变化。

### 5.2 记录主链路

```text
src/features/watchlist/hooks/
  useWatchList.ts              组合 records 状态与同步协调器，保持原返回接口
  useRecordRepository.ts       加载、CRUD、逐集修改、导入后重载

src/features/sync/hooks/
  useSyncCoordinator.ts        所有自动同步计时与运行态
```

`useRecordRepository` 只接收 `onLocalWrite` 回调，不知道 WebDAV、退避或凭据。`useSyncCoordinator` 不直接修改记录数组，只通过 `reloadRecords` 回调要求主链路从 Rust 重载。

### 5.3 RecordForm

```text
src/features/watchlist/record-form/
  recordFormModel.ts           初始值、媒体切换、进度和时间转换纯函数
  useTmdbRecordSearch.ts       搜索状态、结果选择和季选择协调
  TmdbSearchSection.tsx        搜索与结果视图
  RecordDetailsFields.tsx      类型、名称、状态、评分和元数据字段
  PlaybackFields.tsx           电影时间或分集进度字段
  CollectionMembership.tsx    收藏集摘要、管理器和草稿编辑
```

`RecordForm.tsx` 保留 dialog、提交、删除和各 section 的组合。TMDB 映射继续复用 `classification.ts` 与 `tmdbRecordMapping.ts`，不在 hook 中复制规则。

### 5.4 SettingsModal

```text
src/features/settings/
  components/
    SettingsModal.tsx          dialog、页签导航、共享通知和组合
    tabs/
      BasicSettingsTab.tsx     TMDB 凭据与网络代理
      SyncSettingsTab.tsx      WebDAV 目标、同步、冲突和调度间隔
      CategoriesTab.tsx        内容类型、地区和标签说明
      ToolsTab.tsx             工具页组合
      AboutTab.tsx             构建信息
    tools/
      ImportExportPanel.tsx
      RecoveryPointsPanel.tsx
      PosterCachePanel.tsx
      DatabaseMaintenancePanel.tsx
      BatchMetadataPanel.tsx
  hooks/
    useSettingsBootstrap.ts    一次性读取设置、凭据状态和目标注册表
    useSyncSettings.ts         目标 probe/激活/断开/手动同步/冲突处理
    useRecoveryPoints.ts
    usePosterCache.ts
    useBatchMetadata.ts        扫描、歧义选择、预览、应用和无数据记忆
```

设置页签以最小 props 接收状态和命令。不得把一个 1899 行组件转换成一个同等规模的“万能 hook”。批量元数据流程允许单独 hook 较大，但其纯规划继续留在 `batchMetadata.ts`。

## 6. 分批实施

### Batch A：行为基线与纯函数提取

- 为 ETag、payload 构造、安全错误码、RecordForm 初始值/媒体切换补充 Node 单元测试；PROPFIND 继续使用浏览器原生 DOMParser，并由同步浏览器专项覆盖。
- 为设置页签切换和只读挂载补充 Playwright 断言，记录关键 IPC 调用数量。
- 提取 `entityTags.ts`、`syncPayload.ts`、`syncErrors.ts` 和 `recordFormModel.ts`。
- 只移动纯逻辑；公共入口和 JSX 暂不变化。

门禁：Node、typecheck、lint、build、同步相关 Playwright、Rust 全部通过。

### Batch B：同步传输与一次同步服务

- 提取 `webdavTransport.ts` 和 `syncCredentials.ts`。
- 把 `syncToWebDAV` 主流程迁入 `syncService.ts`，通过显式依赖对象调用 transport/database。
- 保留 `webdav.ts` 兼容门面，并验证现有动态导入路径继续工作。
- 迁移旧资源读取与显式导入服务。

门禁重点：条件写入、弱/强 ETag、412 重试、target 切换、V7 拒绝、publish intent、CAS 和 legacy 零隐式 PUT。

### Batch C：协调器与记录仓储 hook

- 提取 `useSyncCoordinator`，保持触发、计时和通知去重完全一致。
- 提取 `useRecordRepository`，让 CRUD 与同步调度只通过 `onLocalWrite`/`reloadRecords` 连接。
- `useWatchList` 变为薄组合层，但返回字段和 `App.tsx` 接线不变。

门禁重点：启动、焦点、online、周期、暂停/恢复、单飞重跑、卸载清理和写后防抖。

### Batch D：大型 UI 拆分

- 先拆 Settings 五个页签，再拆 Tools 内五个独立面板。
- 将副作用流程迁入领域 hook，页签仅渲染和触发命令。
- 再拆 RecordForm 的纯模型、TMDB hook、字段 section 和收藏集管理器。
- 每移动一个页签或 section 即运行对应专项，不进行一次性整文件重写。

门禁重点：DOM 入口、可访问名称、焦点、Escape、确认框、错误文案、360 px 布局及零隐式写入。

## 7. 测试计划

### Node

- `entityTags`：带/不带引号、弱 ETag、控制字符、候选选择和无效值；PROPFIND XML 解析由现有浏览器同步专项覆盖。
- `syncPayload`：legacy、V3～V6、V7+、逐集历史和收藏集升级边界。
- `syncErrors`：稳定错误码、HTTP 分类和安全文案。
- `recordFormModel`：新建/编辑初值、媒体切换、进度规范化和时间解析。
- 继续执行现有 merge、collection sync、scheduling、batch metadata 测试。

### Playwright

- 现有 `b003-roundtrip.spec.ts`、`sync-reliability.spec.ts`、`sync-target-isolation.spec.ts` 和 `episode-history.spec.ts` 全量保持。
- 新增模块边界回归：兼容门面与新 service 返回一致结果。
- Settings 五页签可访问、切换不重复 bootstrap、只读打开零网络/零业务写入。
- RecordForm 新建、编辑、TMDB 电影、TMDB 季、媒体切换、收藏集草稿和取消不写入。
- 360 px 下两个 dialog 均无页面级横向溢出。

### Rust

本任务不修改 Rust 业务代码，但仍执行全部 Rust 测试、rustfmt 和严格 Clippy，防止前端 facade 调整遗漏 IPC 契约。

## 8. 完成门禁

- `npm run contracts:check`
- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- 同步、设置和表单相关 Playwright 专项及完整回归
- `cargo test`
- `cargo fmt --check`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `git diff --check`

## 9. 完成定义

1. `webdav.ts` 只保留兼容重导出，不再实现传输或合并协调。
2. `useWatchList` 是薄组合层，记录仓储与同步协调器可分别测试。
3. `SettingsModal` 只负责 dialog、页签和组合，各业务页签/工具面板独立。
4. `RecordForm` 只负责 dialog、提交和 section 组合，TMDB 与收藏集流程有独立边界。
5. 不存在循环依赖；纯领域模块不导入 React、Tauri 或数据库 facade。
6. 所有既有公共入口、IPC、数据格式、业务结果、错误安全和可访问行为保持不变。
7. 全部门禁通过，且每个批次可单独回退，不依赖一次性大提交。

## 10. 风险控制

- 每批使用独立 Git 提交，不将路径迁移、算法修改和 UI 调整混在同一提交。
- 对共享状态采用显式 props/返回类型，不引入隐式模块单例。
- 禁止以 snapshot 大面积更新代替关键业务断言。
- 发现现有行为缺陷时先记录独立修订任务；除非它阻塞拆分，不在本任务中顺手修复。
- 若完整 Playwright 再次出现报告完成后 Vite 子进程不退出，必须分别记录用例结果和进程退出结果，不把外层超时描述成正常退出。

## 11. 实施进度

### Batch A（2026-08-22）：已完成

- 新增 `features/sync/domain/entityTags.ts`、`syncPayload.ts` 和 `syncErrors.ts`，提取 ETag 安全规则、同步 payload/legacy 转换和稳定错误映射。
- PROPFIND XML 继续使用浏览器原生 `DOMParser`；纯领域层只选择已由传输边界提取的候选值，避免引入自制 XML 解析器。
- 新增 `recordFormModel.ts`，提取表单初值、媒体类型切换、进度规范化和电影时间转换；组件继续使用函数式状态更新。
- `webdav.ts` 与 `RecordForm.tsx` 保持现有公共入口和 UI 行为，尚未进入传输/service、协调器或 JSX 拆分。
- 验收：Node 151/151、同步与表单相关 Playwright 46/46、Rust 90/90、typecheck、lint、生产 build、rustfmt、严格 Clippy 与 `git diff --check` 全部通过。

### Batch B（2026-08-22）：已完成

- 新增 `webdavTransport.ts` 与 `syncCredentials.ts`，分别承载 Rust WebDAV 命令适配和 target 凭据门面。
- 新增 `conditionalWebdav.ts`，集中浏览器原生 PROPFIND/ETag 条件验证与内容指纹；同步和 legacy 服务不互相依赖。
- 新增 `syncService.ts`，迁移一次同步的拉取、合并、条件提交、publish intent、CAS 确认和重试；数据库、transport、时钟、UUID 与用户确认均可显式注入。
- 新增 `legacyImportService.ts`，迁移只读 probe/load、旧资源显式导入和冲突查询。
- `shared/lib/webdav.ts` 缩为约 58 行兼容门面，旧导出和动态导入路径保持不变；生产确认函数由门面显式注入，service 不依赖 React、window 或 DOM。
- 验收：Node 154/154、同步与表单相关 Playwright 46/46、Rust 90/90、typecheck、lint、生产 build、rustfmt、严格 Clippy 与 `git diff --check` 全部通过；未连接真实 WebDAV。

### Batch C（2026-08-22）：已完成

- 新增 `features/sync/hooks/useSyncCoordinator.ts`，承载自动同步启动、focus/visibility/online 触发、周期拉取、暂停/恢复、单飞重跑、退避、通知去重和卸载清理；同步成功后的记录刷新通过 `reloadRecords` 回调完成。
- 新增 `features/watchlist/hooks/useRecordRepository.ts`，承载记录加载、CRUD、逐集修改、导入替换和 Rust 返回值回填；本地写入只通过 `onLocalWrite` 回调通知协调器。
- `useWatchList.ts` 缩为组合层，`App.tsx` 使用的导出签名、返回字段和接线保持不变；未引入 Zustand，未修改 V18、IPC、同步 payload、WebDAV 或 UI。
- 验收：Node 154/154、同步与记录相关 Playwright 47/47（其中 `sync-reliability` 6/6，含新增 online 回归）、Rust 90/90、typecheck、lint、生产 build、rustfmt、严格 Clippy 与 `git diff --check` 全部通过；未连接真实服务或真实部署数据。下一步为 Batch D。

### Batch D（2026-08-22）：已完成

- RecordForm：新增 `useTmdbRecordSearch.ts`，承载 TMDB 搜索、详情/季选择、字段映射和后台海报下载；新增 `CollectionMembership.tsx`，承载收藏集摘要、管理器和保存前草稿，原 `RecordForm` 公共 props、dialog 入口、字段文案、收藏集草稿提交时机保持不变。
- Settings：新增 `useSettingsBootstrap.ts`，承载一次性设置/凭据/目标注册表/冲突读取；`useSyncSettings` 承载目标探测、激活、同步、冲突和间隔流程，`useRecoveryPoints` 承载恢复点生命周期，`usePosterCache` 与数据库维护 hook 承载维护命令，`useImportExport` 承载本地/云端导入导出，`useBatchMetadata` 承载批量预览、候选、取消和安全写入。五个页签及 Tools 面板均为显式 props 视图，SettingsModal 仅保留 dialog/tab/composition；旧 Basic 不可达 JSX 已删除，未改变 IPC 或同步语义。
- RecordForm：新增 `useTmdbRecordSearch.ts`、`TmdbSearchSection.tsx`、`RecordDetailsFields.tsx`、`PlaybackFields.tsx` 和 `CollectionMembership.tsx`；外层仅保留 dialog、提交、删除及 section 组合。
- 新增边界验收：Settings bootstrap 只执行一次且页签切换无业务写入；RecordForm 收藏集管理器取消/ Escape 恢复焦点且零写入；Settings/RecordForm 360px 无页面级横向溢出。
- 验收：Node 154/154；完整 Playwright 97/97（含新增 ARCH-002 专项）；Rust 90/90；typecheck、lint、生产 build、rustfmt、严格 Clippy 与 `git diff --check` 全部通过。未连接真实服务或真实部署数据。
