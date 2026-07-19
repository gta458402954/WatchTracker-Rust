# WatchTracker 代码优化建议

> 审查时间：2026-05-20  
> 审查范围：全项目（Tauri 2 + React/TypeScript）  
> 说明：仅建议，未做任何修改

---

## 🔴 安全问题（优先处理）

### #1 WebDAV 密码加密强度不足
- **文件**：`src-tauri/src/auth.rs`
- **问题**：密码存储使用 Base64 编码，这不是加密，任何人拿到配置文件即可还原明文密码。
- **建议**：改用 `tauri-plugin-stronghold`（基于 IOTA Stronghold）或 AES-256-GCM 加密存储，或使用系统 Keychain（macOS Keychain / Windows Credential Manager）。

### #2 密码通过 IPC 明文传递
- **文件**：`src/utils/webdav.ts`
- **问题**：WebDAV 密码在前后端 IPC 调用中以明文字符串传递。
- **建议**：密钥操作尽量在 Rust 端完成，前端只传必要的非敏感参数。

### #3 CSP 完全禁用
- **文件**：`src-tauri/tauri.conf.json`
- **问题**：`"csp": null` 意味着完全没有内容安全策略，XSS 风险敞开。
- **建议**：配置最小化 CSP，例如 `"default-src 'self'; script-src 'self'"`。

---

## 🟠 逻辑 / 正确性问题

### #4 `update_record` 实际执行的是 INSERT
- **文件**：`src-tauri/src/commands.rs`
- **问题**：`update_record` 命令内部调用了 `insert_record`（底层是 `INSERT OR REPLACE`），并非真正的 UPDATE。会删除原行再插入新行，导致 `rowid` 变化，且性能不如 `UPDATE SET`。
- **建议**：实现独立的 `UPDATE ... SET ... WHERE id = ?` SQL 语句。

### #5 `replace_all_records` 无事务保护（数据安全）
- **文件**：`src-tauri/src/db.rs`
- **问题**：同步写入时先清空表再批量插入，若中途出错，数据全部丢失且无法回滚。
- **建议**：用 `BEGIN TRANSACTION / COMMIT / ROLLBACK` 包裹整个操作。

### #6 `rename_category` 重命名后 sortOrder 被清零
- **文件**：`src-tauri/src/db.rs`
- **问题**：重命名分类时，`sortOrder` 被硬编码为 `0`，原有排序顺序丢失。
- **建议**：先查出原始 `sortOrder`，再带原值执行 UPDATE，或在 UPDATE 语句中不更新 `sortOrder` 字段。

### #7 `hasCreds` 空字符串误判
- **文件**：`src/utils/webdav.ts`
- **问题**：`hasCreds()` 只判断字段是否存在，不判断是否为空字符串，`{ username: "", password: "" }` 会被误判为"已配置"。
- **建议**：改为 `username?.trim() && password?.trim()` 才视为有效凭据。

### #8 `hasCreds()` 缺 `await`（功能 Bug）⚠️ 最高优先
- **文件**：`src/App.tsx` 第 66 行附近
- **问题**：`if (!hasCreds())` 未加 `await`，`hasCreds` 是异步函数，此处拿到的是 `Promise` 对象，永远为 truthy，导致同步错误提示永远不触发。
- **建议**：改为 `if (!(await hasCreds()))`。

---

## 🟡 性能问题

### #9 `StatsBar` 未用 `useMemo`
- **文件**：`src/components/StatsBar.tsx`
- **问题**：统计数据（总数、各状态计数等）在每次渲染时全量遍历 records，没有缓存。
- **建议**：用 `useMemo(() => computeStats(records), [records])` 包裹统计逻辑。

### #10 `getEpisodeOptions` 每次渲染重新生成大数组
- **文件**：`src/components/RecordCard.tsx`
- **问题**：`getEpisodeOptions` 函数生成较大的选项数组，每次渲染均重新执行，无缓存。
- **建议**：用 `useMemo` 或提取为模块级常量（若参数固定）。

### #11 排序比较函数不稳定
- **文件**：`src/App.tsx`
- **问题**：比较函数只返回 `1` / `-1`，对相等值不返回 `0`；空值 fallback 用字符串 `'0'` 而非数字 `0`，在数字排序场景下有隐患。
- **建议**：补全 `return 0` 分支，空值 fallback 改为对应类型的零值（数字用 `0`，字符串用 `''`）。

### #12 常用过滤字段缺数据库索引
- **文件**：`src-tauri/src/db.rs`
- **问题**：`status`、`category`、`createdAt` 等字段经常用于过滤和排序，但表结构中没有对应索引。
- **建议**：在建表或迁移脚本中添加：
  ```sql
  CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
  CREATE INDEX IF NOT EXISTS idx_records_category ON records(category);
  CREATE INDEX IF NOT EXISTS idx_records_created ON records(createdAt);
  ```

---

## 🔵 可维护性问题

### #13 `isTVCategory` 用字符串包含判断类型（脆弱）
- **文件**：`src/components/RecordForm.tsx`
- **问题**：通过判断分类名是否包含特定字符串来区分"电视"类型，用户自建分类名稍有不同就会误判。
- **建议**：在类型系统或数据库中给分类增加 `type: 'movie' | 'tv'` 字段，用结构化数据判断，而非字符串匹配。

### #14 残留 Electron 遗留依赖
- **文件**：`package.json`
- **问题**：`@electron/rebuild` 仍在依赖列表中，项目已迁移至 Tauri，此依赖完全多余。
- **建议**：`npm uninstall @electron/rebuild` 并从 `package.json` 中移除。

### #15 `initDatabase` 是空函数残留
- **文件**：`src/utils/database.ts`
- **问题**：`initDatabase` 函数体为空，是 Electron 时代遗留的噪音代码，对 Tauri 版本没有任何作用。
- **建议**：删除该函数及所有调用处，或补充实际初始化逻辑（如果仍有需要）。

### #16 硬编码中文分类名 `'电影'`
- **文件**：`src/components/RecordCard.tsx`
- **问题**：`record.category === '电影'` 直接硬编码中文字符串做类型判断，国际化或分类名调整时容易遗漏。
- **建议**：同 #13，用结构化的类型字段替代字符串匹配；或至少提取为具名常量 `const MOVIE_CATEGORY = '电影'`。

### #17 WebDAV URL 硬编码坚果云
- **文件**：`src/utils/webdav.ts`
- **问题**：WebDAV 服务地址硬编码为坚果云域名，无法支持其他 WebDAV 服务（Nextcloud、Box 等）。
- **建议**：将 URL 作为用户可配置的字段存储，在设置界面暴露输入框，默认值可填坚果云地址。

### #18 导入/导出按钮图标语义相反
- **文件**：`src/components/SettingsModal.tsx`
- **问题**：导入按钮显示 📤（向上箭头 = 导出），导出按钮显示 📥（向下箭头 = 导入），图标与功能语义完全颠倒。
- **建议**：交换两处图标：导入用 📥，导出用 📤。

---

## 优先级速查

| 优先级 | 条目 | 理由 |
|--------|------|------|
| 🚨 立即修 | #8 缺 await | 功能 Bug，sync 提示完全失效 |
| 🚨 立即修 | #5 缺事务 | 同步时数据可能全量丢失 |
| 🚨 立即修 | #6 sortOrder=0 | 重命名分类后排序被破坏 |
| ⚠️ 近期修 | #4 update 语义 | 性能损耗 + 逻辑不清晰 |
| ⚠️ 近期修 | #7 hasCreds 空串 | 空配置误判导致静默失败 |
| ⚠️ 近期修 | #13 isTVCategory | 用户自建分类时必现误判 |
| 📌 按需修 | #1 #2 #3 | 安全加固，视威胁模型决定 |
| 🧹 顺手修 | #14 #15 #18 | 清洁度，改动极小 |
