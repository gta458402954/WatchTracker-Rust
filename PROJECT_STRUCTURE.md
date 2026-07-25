# WatchTracker 项目结构

WatchTracker 是 React 19 + TypeScript + Vite + TailwindCSS 前端与 Tauri 2 + Rust + SQLite 后端组成的便携桌面应用。

## 目录

```text
WatchTracker-GitHub-Source/
├── src/
│   ├── app/App.tsx
│   ├── features/
│   │   ├── dashboard/components/Dashboard.tsx
│   │   ├── settings/components/SettingsModal.tsx
│   │   └── watchlist/
│   │       ├── components/
│   │       └── hooks/useWatchList.ts
│   ├── shared/
│   │   ├── components/ErrorBoundary.tsx
│   │   ├── lib/
│   │   │   ├── analytics.ts
│   │   │   ├── classification.ts
│   │   │   ├── constants.ts
│   │   │   ├── database.ts
│   │   │   └── webdav.ts
│   │   └── types/index.ts
│   ├── index.css
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   │   ├── auth.rs
│   │   ├── commands.rs
│   │   ├── db.rs
│   │   ├── lib.rs
│   │   ├── main.rs
│   │   ├── models.rs
│   │   └── net.rs
│   ├── capabilities/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── docs/
├── index.html
├── package.json
└── vite.config.ts
```

## 模块职责

- `src/app/App.tsx`：应用级弹窗、筛选、排序和页面布局。
- `features/watchlist`：记录表单、卡片、列表、海报墙及 CRUD/同步调度。
- `features/dashboard`：时间范围统计、完成趋势、推荐与题材分布。
- `features/settings`：TMDB、代理、WebDAV、冲突恢复、备份和数据库工具。
- `shared/lib/classification.ts`：媒体类型、地区标签和 TMDB 分类的唯一规则来源。
- `shared/lib/database.ts`：前端到 Tauri 命令的类型化调用。
- `shared/lib/webdav.ts`：凭据读写、墓碑删除、双端合并和冲突历史。
- `src-tauri/src/db.rs`：SQLite 建表、迁移、读写、全量替换和回归测试。
- `src-tauri/src/net.rs`：TMDB、海报下载和 HTTP 客户端。

## 数据约定

- `mediaType` 是业务分类的主字段：电影、剧集、纪录片、综艺、动画。
- `genres` 保存 TMDB 题材；`contentTags` 保存地区及用户自定义标签。
- 电影进度与总时长以秒存储；剧集单集时长以分钟存储。
- `updatedAt` 是 WebDAV 合并判断依据，删除通过墓碑同步。

## 验证命令

```powershell
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run tauri build
```

构建产物位于 `src-tauri/target/release/app.exe`，发布时复制为便携目录中的 `watch-tracker.exe`。
