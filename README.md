# WatchTracker

WatchTracker 是一款基于 React、TypeScript、Rust 和 Tauri 2 的 Windows 影视观看追踪应用。核心列表、设置、导入导出和 SQLite 数据库可完全离线使用；TMDB 元数据和 WebDAV 同步是可选能力。

## 功能概览

- 电影、剧集、纪录片、综艺和动画记录管理。
- 状态、地区、评分、搜索、锁定和排序筛选。
- JSON 导入导出与本地 SQLite 持久化。
- 可选 TMDB 元数据、海报下载和 WebDAV 同步。
- 安全的批量元数据补全：先预览，只写仍缺失的字段，区分电影、剧集和具体季，并提供逐条结果与失败重试。
- 可选择的便携模式，以及统一的数据库、日志、海报和备份目录。

## 当前实现基线

- 当前权威源码为本仓库 `main`；正式便携版的精确构建提交号显示在应用顶部栏。
- 前端记录状态使用 `src/features/watchlist/hooks/useWatchList.ts`；当前没有引入 Zustand。
- SQLite schema 为 V18，records 表使用 camelCase 列名。
- WebDAV 使用 schema v2、时间戳合并和简单 Tombstone；ETag、`expectedGeneration`、原子 `SyncCommit`、持久化 outbox 和主动拉取仍属于路线图。
- 本地 CRUD/全量替换已通过 Rust/SQLite 事务维护记录、Tombstone 和 `records_generation`。

完整架构和已实现/未实现边界见 [docs/CURRENT_ARCHITECTURE.md](docs/CURRENT_ARCHITECTURE.md)。

## 已验证开发环境

当前 Windows 基线已使用以下版本完成独立验证：

- Windows 11 x64
- Node.js `24.18.0`
- npm `11.16.0`
- Rust / Cargo `1.97.1`
- Git `2.55.0.windows.3`

建议使用 Node.js 24 LTS 与当前 stable Rust。构建 Tauri 前还需要安装 [Tauri 2 Windows prerequisites](https://v2.tauri.app/start/prerequisites/) 中列出的 Microsoft C++ Build Tools 和 WebView2。仓库提交了 `package-lock.json` 与 `src-tauri/Cargo.lock`；安装和 CI 必须使用锁文件。

## 安装和运行

```powershell
git clone https://github.com/gta458402954/WatchTracker-Rust.git
Set-Location WatchTracker-Rust
npm ci
```

启动完整桌面应用：

```powershell
npm run tauri dev
```

仅启动 Vite 前端服务器：

```powershell
npm run dev
```

单独的 Vite 页面没有真实 Tauri IPC，主要用于前端构建和由 Playwright 注入严格 mock 的自动化测试；验证真实数据库必须使用 Tauri 或隔离构建产物。

## 强制质量门禁

首次运行 Playwright 前安装 Chromium：

```powershell
npx playwright install chromium
```

前端门禁：

```powershell
npm run typecheck
npm run lint
npm run test
npm run build
npx playwright test
```

Rust 门禁：

```powershell
Set-Location src-tauri
cargo fmt -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --locked
Set-Location ..
```

`npm run test` 使用 Node 原生测试；Playwright 使用隔离端口并把临时输出写入系统临时目录。不得用跳过、`only` 或降低 Clippy 警告等级来使门禁通过。

## Windows 构建

正式便携版必须从已提交且干净的 Git 工作区构建：

```powershell
npm run build:portable
```

该命令在存在未提交修改时会拒绝打包，并把当前 Git 短提交号注入应用顶部栏。这样可以直接从运行中的程序确认可执行文件对应的源码提交。普通开发验证仍可使用 `npm run tauri build`，但不得把它生成的文件当作正式便携版发布。

成功后检查实际生成的文件，而不是依赖历史文件名：

```text
src-tauri/target/release/app.exe
src-tauri/target/release/bundle/msi/*.msi
src-tauri/target/release/bundle/nsis/*-setup.exe
```

仓库不跟踪本地 `.exe`、安装包、`dist/`、`dist-build/`、测试报告或 Rust `target/`。正式发布产物应由经过门禁的 CI run 或专门发布流程保存。

## 数据目录

应用启动时只解析一次数据根目录；数据库、日志、海报协议和本地备份共享同一个 `AppPaths` 结果。

| 内容 | 数据根目录中的位置 |
| --- | --- |
| SQLite 数据库 | `watchtracker.db` |
| 应用日志 | `app.log` |
| 海报缓存与 `poster://` | `posters/` |
| 本地备份 | `backups/` |

数据根目录选择规则：

1. **便携模式**：只有启动前已在可执行文件旁创建 `data/` 目录，应用才使用该目录。
2. **系统模式**：可执行文件旁没有 `data/` 时，Windows 使用 `%APPDATA%\com.watchtracker.desktop`。
3. 如果已选择的目录不可写，或 `data`、`posters`、`backups` 被普通文件占用，启动会报告错误；应用不会静默切换到另一份数据库。

不要仅为了测试在真实发布程序旁临时创建或删除 `data/`。迁移、导入、恢复和故障注入必须使用隔离目录或数据库副本。

## 离线与凭据

- 不配置 TMDB API Key 或 WebDAV 凭据时，启动、CRUD、筛选、设置和本地导入导出仍可使用。
- TMDB 查询、海报下载和 WebDAV 同步在缺少凭据或网络失败时不可用，但不得清空本地列表。
- WebDAV 凭据不应写入日志、测试夹具、截图或 Git。便携数据目录本身仍应视为敏感数据并妥善保护。

## 备份与恢复

恢复前完全退出 WatchTracker，并备份整个当前数据根目录。恢复同一种模式时，应把 `watchtracker.db`、`posters/` 和需要的 `backups/` 放回同一根目录。

从系统模式切换到便携模式：

1. 退出 WatchTracker。
2. 在目标可执行文件旁创建 `data/`。
3. 把 `%APPDATA%\com.watchtracker.desktop` 中需要的数据复制到新 `data/`。
4. 确认复制完成后再启动。

不要在应用运行时覆盖数据库，也不要同时保留来源不明的两份活动数据库。

当前程序只支持 V18 camelCase 数据库。不要用包含 V19 snake_case migration 的历史实验程序打开同一活动数据库后再切回当前程序；这会造成版本不兼容。任何 schema 升级都应先备份整个数据根目录，并只在数据库副本上验证。

## 项目结构

```text
src/                     React/TypeScript 前端
src-tauri/               Rust/Tauri 后端与 SQLite
tests/                   Playwright 页面回归
docs/                    架构、API 和历史文档
.github/workflows/       GitHub Actions 门禁
.agent-work/             需求、任务和验收记录
```

当前架构见 [docs/CURRENT_ARCHITECTURE.md](docs/CURRENT_ARCHITECTURE.md)；原子本地 CRUD 和同步边界详见 [docs/REFACTOR_ATOMIC_API.md](docs/REFACTOR_ATOMIC_API.md)。

## 开源协议

本项目采用 [MIT License](LICENSE)。
