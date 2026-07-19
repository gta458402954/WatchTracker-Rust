# WatchTracker Development Log

## 2026-06-07 — 功能增强与 TMDB 体验优化

### 功能增强
- **新增按“上映年份”排序**：在主界面排序下拉菜单中补充了按 `releaseYear` 排序的逻辑。
- **完善记录编辑表单**：在 `RecordForm.tsx` 中补齐了“删除”按钮，解决了在海报墙模式下点击海报进入编辑时无法删除当前（例如重复）记录的问题。

### TMDB API 优化 (net.rs & RecordForm.tsx)
- **全局混合搜索 (Multi Search)**：后端的 `search_tmdb` 接口由严格区分 `movie/tv` 改为统一调用 `/3/search/multi` 端点。解决了“当前分类与真实媒体类型不符时完全搜不到”的问题（例如在电影分类下搜属于剧集的动漫）。
- **结果可视化**：前端搜索下拉列表现根据接口返回的 `media_type` 自动添加 `[电影]`（蓝） 或 `[剧集]`（绿） 小标签。点击项时动态传入真实的 `media_type` 获取详情。
- **Bearer Token 自动兼容**：修改了后端的鉴权逻辑。自动识别用户输入的是传统的 32 位 API Key 还是最新的 API Read Access Token (JWT)。如果是长 Token，自动采用最新的 `Authorization: Bearer` 鉴权头，修复了因直接拼接 URL 导致的 401 Unauthorized 报错问题。
- **规范化 Header**：为所有向 TMDB 发起的请求统一添加了 `accept: application/json`。

### 运维与发布
- 合并了便携版数据库中的“动画”分类至“电影”下。
- 编译并替换了 `D:\Project\WatchTracker-Rust-Portable\WatchTracker.exe` 产物。


## 2026-05-20 — Bug 修复发布

### 修复内容

**#5 replace_all_records 事务保护（db.rs）**
- 问题：同步时先清空表再批量插入，中途出错数据全量丢失且无法回滚
- 修复：用 `BEGIN TRANSACTION / COMMIT / ROLLBACK` 包裹整个操作，任何一步失败均回滚

**#6 rename_category sortOrder 丢失（db.rs）**
- 问题：重命名分类时 `sortOrder` 被硬编码为 `0`，原有排序顺序丢失
- 修复：先查出原分类的 `sortOrder`，重命名时携带原值

**#8 hasCreds() 缺 await（App.tsx）**
- 问题：`handleQuickSync` 中 `if (!hasCreds())` 未加 `await`，`Promise` 对象永远 truthy，同步错误提示永远不触发
- 修复：改为 `if (!(await hasCreds()))`

### 构建

- 编译命令：`npm run tauri build` ✓
- 编译产物：`src-tauri\target\release\app.exe`
- 替换目标：`D:\Project\WatchTracker-Rust-Portable\WatchTracker.exe` ✓
- 安装包：`bundle/msi` + `bundle/nsis`（可选分发版本）
