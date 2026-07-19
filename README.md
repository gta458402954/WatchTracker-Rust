# WatchTracker

WatchTracker 是一款基于 **Rust (Tauri)** 和 **React** 构建的轻量级、高性能影视观看追踪应用。它专注于提供极致的便携式体验，支持全自动元数据填充和多端同步。

## ✨ 核心特性

- **真·便携化设计**：所有数据（记录、设置、密钥）均加密存储在程序同级的 `data/` 目录下，随盘即走，即插即用。
- **智能元数据填充**：集成 TMDB API，一键自动获取影视剧封面、年份、总集数等信息。
- **WebDAV 云同步**：支持坚果云等 WebDAV 服务，确保多设备间的数据安全与一致。
- **高级数据库维护**：内置数据库压缩（VACUUM）与搜索索引优化，万级数据搜索瞬时响应。
- **网络适配**：支持手动配置网络代理，解决部分环境下的网络连接问题。

## 🛠️ 技术栈

- **前端**：React, TypeScript, Tailwind CSS, Vite
- **后端**：Rust, Tauri v2
- **数据库**：SQLite (rusqlite)

## 🚀 快速开始

### 开发环境准备
1. 安装 [Node.js](https://nodejs.org/) (建议 v20+)
2. 安装 [Rust](https://www.rust-lang.org/) 环境
3. 安装 Tauri 依赖（参考 [Tauri 官网指南](https://tauri.app/v1/guides/getting-started/prerequisites)）

### 运行与编译
```bash
# 安装依赖
npm install

# 启动开发模式
npm run tauri dev

# 编译生产版本 (便携版)
npm run tauri build
```


## 📁 项目结构

```text
src/
├── app/                 # 应用装配与页面级样式
├── features/            # 按业务域组织的界面与状态逻辑
│   ├── categories/
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
