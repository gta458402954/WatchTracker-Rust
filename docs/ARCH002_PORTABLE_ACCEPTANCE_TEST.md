# ARCH-002 Batch A/B 便携包验收测试用例

> 用例编号：`WT-ARCH002-PORTABLE-001`
> 适用范围：ARCH-002 Batch A、Batch B；Windows 便携 EXE 交付
> 测试类型：构建证据 + 隔离运行验收
> 原则：不连接真实 WebDAV，不对真实部署数据库做写入

## 目的

确认 Batch A/B 的模块拆分不会改变本地记录、表单模型、同步服务兼容入口和便携包运行边界，并确认待替换 EXE 确实来自已提交的源码。

## 前置条件

1. 在 `WatchTracker-Main` 工作区执行 `git status --short`，结果为空；记录 `git rev-parse HEAD`。
2. 关闭所有 WatchTracker 进程。不要在真实部署目录旁创建或删除 `data`，也不要使用真实 WebDAV 凭据。
3. 准备一个全新隔离目录，例如 `D:\Project\Projects\WatchTracker-ARCH002-Smoke-<commit>`，并预先创建其 `data` 子目录。
4. 若要替换现有部署，先记录旧 EXE 的 SHA-256、文件大小和修改时间，并将旧 EXE 复制到带时间戳的备份文件；真实 `data` 目录只允许做替换前后哈希对比。

## 执行步骤与预期结果

### A. 源码和自动化门禁

| 步骤 | 操作 | 预期结果 |
| --- | --- | --- |
| A1 | `npm test` | contracts 检查及 Node 测试全部通过；包含 `entityTags`、`syncPayload`、`syncErrors`、`recordFormModel` 和同步门面边界测试 |
| A2 | `npm run typecheck; npm run lint; npm run build` | 三项均以 0 退出 |
| A3 | 执行同步/表单相关 Playwright 专项 | 既有同步、episode history、target isolation 和表单专项通过；设置页只读挂载不产生网络或业务写入 |
| A4 | `cargo test`、`cargo fmt --check`、严格 `cargo clippy` | Rust 门禁全部通过；本批不应有 Rust 业务行为变化 |

### B. 便携构建证据

| 步骤 | 操作 | 预期结果 |
| --- | --- | --- |
| B1 | 在干净提交上运行 `npm run build:portable` | 构建输出中的 Release EXE 成功生成；记录命令退出码和日志 |
| B2 | 对 `src-tauri\target\release\app.exe` 执行 `Get-FileHash -Algorithm SHA256`，并记录大小、修改时间 | EXE 哈希和构建提交可追溯；不得使用旧目录中残留的 EXE 作为结果 |
| B3 | 检查 About/构建信息中的 Git commit（或构建注入证据） | 显示的完整 commit 等于 A1 记录的 `HEAD` |
| B4 | 若完整 `tauri build` 在 EXE 生成后因 WiX `light.exe`/Windows Installer ICE 失败 | 将 MSI/NSIS 失败单独记录为环境结果；只在 B2/B3 证据齐全时判定“便携 EXE 构建通过”。不得把旧 MSI/NSIS 当成本次产物。详见 `WINDOWS_BUNDLE_DIAGNOSTIC.md` |

### C. 隔离运行和 Batch A/B 烟测

1. 将 B2 的 EXE 复制到隔离目录，确认复制前后 SHA-256 相同；从该目录启动，不启动真实部署 EXE。
2. 新建一条本地记录，分别验证电影/剧集媒体类型切换、时间或进度字段保存；关闭并重启后记录仍存在。预期：表单模型的空值、进度规范化和媒体切换结果稳定。
3. 打开同步设置/菜单但不配置或提交 WebDAV 凭据。预期：页面可打开，不发生网络请求、远端写入或本地业务写入；应用保持可用。
4. 在不连接 WebDAV 的情况下退出应用，记录隔离 `data` 目录中由本次测试产生的文件；不得出现真实部署数据库路径或真实凭据。
5. 通过兼容入口触发一次无凭据同步错误（若界面提供该路径）。预期：显示稳定、安全的错误文案，不泄露 URL、密码或内部异常；不产生 PUT。

### D. 替换验证（可选部署动作）

1. 再次确认真实部署 EXE 没有运行，并确认待替换路径是预先核对过的精确绝对路径。
2. 将旧 EXE 复制为可恢复备份，再把 B2 EXE 复制到临时文件，校验哈希后替换目标文件。
3. 对替换后的目标执行 SHA-256；预期与 B2 完全一致。
4. 对真实 `data` 目录只做替换前后文件清单/哈希对比；预期无变化。不要用真实数据库启动该 EXE 进行烟测，C 部分已经覆盖隔离运行。

## 通过标准

- A1～A4 全部通过，或明确记录与本批无关的环境性失败。
- B2 的 EXE 哈希、文件路径和 Git commit 三者一致可追溯。
- C 部分隔离数据可创建、保存并重启读取，且无真实 WebDAV/真实部署数据库访问。
- 若执行 D，替换后 EXE 哈希与构建产物一致，旧 EXE 有可恢复备份，真实 `data` 前后哈希不变。

## 证据记录模板

```text
用例：WT-ARCH002-PORTABLE-001
日期/环境：
源码 HEAD：
build:portable 退出码：
EXE 路径：
EXE SHA-256：
EXE 大小/修改时间：
About/注入 commit：
Node/TypeScript/Lint/Build：
Playwright：
Rust：
隔离 data 路径及结果：
真实部署旧 EXE 哈希（如执行 D）：
备份路径（如执行 D）：
替换后 EXE 哈希（如执行 D）：
真实 data 前后哈希：
结论：PASS / FAIL（附环境性失败说明）
```
