# WatchTracker

WatchTracker 是一款基于 **Rust (Tauri)** 和 **React** 构建的轻量级、高性能影视观看追踪应用。它专注于提供极致的便携式体验，支持全自动元数据填充和多端同步。

## ✨ 核心特性

- **可选择的便携模式**：只有程序同级已经存在 `data/` 目录时，记录与设置才保存在该目录；否则使用系统应用数据目录。凭据采用便携兼容编码，请妥善保护数据目录。
- **智能元数据填充**：集成 TMDB API，一键自动获取影视剧封面、年份、总集数等信息。
- **WebDAV 云同步**：通过 HTTPS 与坚果云等 WebDAV 服务同步，支持时间戳合并、删除墓碑和冲突恢复。
- **数据库维护**：内置数据库压缩（VACUUM）工具。
- **网络适配**：支持手动配置网络代理，解决部分环境下的网络连接问题。

## 🛠️ 技术栈

- **前端**：React, TypeScript, Tailwind CSS, Vite
- **后端**：Rust, Tauri v2
- **数据库**：SQLite (rusqlite)

## 🚀 快速开始

### 开发环境准备
1. 安装 [Node.js](https://nodejs.org/) (建议 v20+)
2. 安装 [Rust](https://www.rust-lang.org/) 环境
3. 安装 Tauri 依赖（参考 [Tauri 官网指南](https://tauri.app/start/prerequisites/)）

### 运行与编译
```bash
# 安装依赖
npm install

# 启动开发模式
npm run tauri dev

# 编译生产版本 (便携版)
npm run tauri build
```

## 💾 数据目录与恢复

应用启动时只解析一次数据根目录，数据库、日志、海报和本地备份共享该结果：

| 内容 | 相对数据根目录的位置 |
| --- | --- |
| SQLite 数据库 | `watchtracker.db` |
| 应用日志 | `app.log` |
| 海报缓存与 `poster://` | `posters/` |
| 本地备份目录 | `backups/` |

- **便携模式**：启动前，在可执行文件旁手工创建 `data/` 目录。应用不会为了启用便携模式而自动创建这个目录。
- **系统模式**：可执行文件旁没有 `data/` 目录时，使用操作系统为 `com.watchtracker.desktop` 分配的应用数据目录。
- 如果可执行文件旁的 `data` 是普通文件，或者选定根目录及其 `posters/`、`backups/` 无法创建，应用会报告路径错误并停止启动，不会静默切换到另一份数据库。

恢复数据前请完全退出 WatchTracker，并备份目标目录。恢复同一种模式时，将已备份的 `watchtracker.db`、`posters/` 和需要的 `backups/` 放回同一数据根目录；不要同时保留两份不确定来源的数据库。若要从系统模式切换到便携模式，请先退出应用，在程序旁创建 `data/`，再把系统数据目录中的内容复制进去后启动。


## 📁 项目结构

```text
src/
├── app/                 # 应用装配与页面级样式
├── features/            # 按业务域组织的界面与状态逻辑
│   ├── dashboard/
│   ├── settings/
│   └── watchlist/
└── shared/              # 跨业务域复用的组件、类型和基础设施
    ├── components/
    ├── lib/
    └── types/

src-tauri/               # Tauri / Rust 后端
public/                  # 静态资源
docs/                    # 架构说明与历史记录
```
## 📄 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。

---
*Created by Mark*
