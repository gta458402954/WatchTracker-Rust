# 项目分析

> 分析时间：2026-07-26（Australia/Perth）  
> 分析基线：`main` / `29ea3a4`，相对 `origin/main` 超前 17 个提交，工作区有大量未提交修改。  
> 本文只记录静态检查、环境探测和规划结论；没有把历史测试结果继承为本轮 PASS，也没有修改业务代码。

## 0. 2026-07-27 恢复策略复核

GitHub 远端 `main` 已核对为 `6fcbb1e0ae851c554c905676ee9164bfb3ea303e`，用户确认与最后可运行版本相关。当前本地 HEAD `29ea3a4` 是其后第 17 个提交，当前未提交层又覆盖 31 个受控文件。远端稳定候选到当前工作区累计约 72 个文件、6889 行新增、2101 行删除。

这改变了原方案“直接在当前脏工作区补缺口”的默认路径。当前工作区仍有大量可复用实现和测试，但必须先作为故障现场保全；实际恢复应执行 `.agent-work/RECOVERY_REBUILD_PLAN.md`：

1. 快照当前完整现场、旧可运行产物和用户数据；
2. 在独立 worktree 验证 `6fcbb1e`；
3. 在独立 worktree 验证干净的 `29ea3a4`；
4. 必要时在 17 个提交中 bisect；
5. 从最后绿色提交建立 `codex/rebuild-from-stable`，按需求选择性迁移；
6. Gate R 通过前，本文原 Phase A/B 任务都不得直接实施。

原有静态缺口分析继续有效，但只作为迁移目标和验收输入，不再表示必须在当前目录原地修复。

## 1. 当前项目概况

WatchTracker 是 Windows 桌面影视记录应用，React 19 + TypeScript + Vite 前端通过 Tauri 2 IPC 调用 Rust 后端，数据保存在 SQLite，并包含 TMDB 元数据、海报、本地导入导出/恢复及 WebDAV 同步。

当前优先级必须严格分三道门：

1. Gate R：完成现场快照、双基线验证、必要的故障定位并选定最后绿色恢复基线。
2. 阶段 A（P0）：在恢复分支上实现可安装、可启动、可迁移、可 CRUD、可构建的稳定基线，并完成独立验收。
3. 阶段 B（P1）：阶段 A 经 Codex 验收通过后，才允许继续地区动态化并进入 READY。

`.agent-work/REQUEST.md` 第 9 节路线图全部归入 DEFERRED，本轮禁止实施。

## 2. Git 与工作区状态

- 分支：`main`，HEAD `29ea3a4`，`origin/main...HEAD = 0/17`（本地超前 17，无落后）。
- 已修改的受控文件：31 个；`git diff --stat` 为约 1907 行新增、914 行删除。
- 未跟踪内容包含整个 `.agent-work/`、`REMAINING_ISSUES.md`、`docs/REFACTOR_ATOMIC_API.md`、`src/shared/lib/countryNames.ts`、`tests/payload.spec.ts` 以及若干历史实施说明。
- 现有修改横跨 Rust 原子事务、同步/导入、前端 store、设置页、地区分类、测试配置和 Playwright mock；这些都是用户工作区数据，不得 reset、checkout、覆盖或从头重写。
- `dist-build/` 与 `playwright-report/index.html` 当前已被 Git 跟踪，而 `.gitignore` 尚未忽略二者；与 BR-05.7 的产物治理要求冲突。
- 多个文件提示下一次 Git 写入可能由 LF 转为 CRLF；实施时应避免无关整文件格式化造成噪声差异。

## 3. 技术栈与本机环境

| 范畴 | 当前配置/探测结果 |
|---|---|
| 前端 | React 19.2、TypeScript 6、Vite 8、Tailwind CSS 3、Zustand 5 |
| 桌面端 | Tauri 2.11，`@tauri-apps/cli` 锁定/安装版本存在小版本漂移（lock 安装为 2.11.2） |
| 后端 | Rust 2021，Cargo manifest 最低 Rust `1.77.2` |
| 数据库 | rusqlite 0.32，bundled SQLite |
| 网络 | reqwest 0.12，TMDB、WebDAV，native-tls-vendored |
| 测试 | Vitest 4、Playwright 1.62、Rust 单元测试 |
| 当前 Node/npm | Node `v24.18.0`、npm `11.16.0` |
| 当前 Rust/Cargo | `rustc 1.97.1`、`cargo 1.97.1` |
| 依赖静态探测 | `npm ls --depth=0` 成功；`cargo metadata --no-deps` 成功 |

上述只证明工具和已安装依赖可被识别，不证明从锁文件干净安装、Tauri dev、完整测试或打包通过。本规划阶段未运行这些验收命令。

## 4. 项目结构与职责

- `src/app/App.tsx`：初始化、页面级状态、筛选和弹窗编排。
- `src/store/useWatchListStore.ts`：Zustand 记录状态、乐观 CRUD、导入与同步调度。
- `src/shared/lib/database.ts`：类型化 Tauri IPC 入口。
- `src/shared/lib/webdav.ts`：WebDAV 传输、同步快照/提交和冲突处理。
- `src/shared/lib/classification.ts`、`countryNames.ts`：媒体类型、地区规范化、旧标签回退、动态统计和 TMDB 分类。
- `src/features/watchlist/components/StatsBar.tsx`：影视类型、状态和地区筛选 UI。
- `src-tauri/src/db.rs`：数据目录选择、建表、migration、基础 records/settings 访问。
- `src-tauri/src/db_atomic_*.rs`：记录 CRUD、导入、恢复、同步提交的事务入口。
- `src-tauri/src/lib.rs`：Tauri 启动、日志、`poster://` 协议和命令注册。
- `tests/fixtures/mockIpc.ts`：浏览器 E2E 的内存 IPC 模拟，并非真实 SQLite/Tauri 验证。

仓库没有 `.github/workflows`，当前不存在 CI。

## 5. 与阶段 A 相关的现有实现

### 5.1 已有但必须重新验证的成果

- 原子命令已经注册：同步快照、原子删除、更新、恢复、同步提交和导入。
- 当前未提交代码已有强类型 `UpdateWatchRecord`、Rust 事务内生成 `updated_at`、空更新拒绝、未知/系统字段反序列化拒绝、非法类型拒绝以及旧 Tombstone 回滚直接测试。
- generation、commitId、stale snapshot、同步/导入事务及故障注入测试已有较大覆盖。
- Zustand store 已取代旧 Hook 状态主链路；Playwright mock 已接入原子命令。
- Vitest/ESLint 已配置忽略常见生成目录。

这些只能视为“待复核的既有实现”。`REMAINING_ISSUES.md` 和 `walkthrough.md` 中的历史通过结论不能代替当前环境独立验收。

### 5.2 当前可确认的缺口

- `App.tsx` 只有 `loading: boolean`；初始化异常仅 `console.error`，随后会进入正常空列表 UI，无 error 状态和重试入口。
- 删除、表单保存、设置保存、批量补全等多处异步失败仍以抛错/console 为主，没有统一用户可见反馈。
- `setup_db` 先运行 migration，再单独写 `db_version`；不满足“每个 migration 的结构/数据/version 同一事务”。migration 14 还在内部手写 `BEGIN/COMMIT`，重构时需避免嵌套事务。
- `db::get_setting` 使用 `.ok()` 吞掉全部 `query_row` 错误，无法区分 setting 不存在与查询失败。
- 数据库、日志、海报下载和 `poster://` 各自重复解析路径；`unwrap_or_default()` 可能把路径错误静默变成空路径。
- README 声称记录与设置保存在程序同级 `data/`，实际代码仅在该目录预先存在时选择便携目录，否则回退系统 app-data；规则不一致。
- `insert_record`/`set_setting` 仍用 `INSERT OR REPLACE`。REQUEST 路线图将长期 UPSERT 加固列为 R1，但阶段 A 原子失败语义相关的写入必须审查，不能借机扩展为全库领域重写。
- Playwright 现有 CRUD 测试运行在 mock IPC 上，不能替代真实 Tauri/SQLite、首次启动、升级和构建产物冒烟。
- README 未完整说明精确前置条件、`npm run dev`、typecheck/lint/test、数据目录回退、日志/海报/备份路径和无凭据行为。
- `docs/REFACTOR_ATOMIC_API.md` 仍描述已弃用 IPC，缺少现有 DTO、generation、commitId、事务不变量、错误和恢复语义。
- 构建/测试产物治理和 CI 均未达到需求。

## 6. 与阶段 B 相关的既有实现与缺口

工作区已有 `countryNames.ts`、地区纯函数、动态 StatsBar、筛选接线和 Vitest 用例，属于必须保留的部分实现。静态检查发现：

- 已实现：按逗号/全角逗号拆分、trim/大写/去重、`originCountry` 优先、旧 `contentTags` 回退、多国分别计数、未映射两位代码显示自身、TMDB 多国代码保留的基础逻辑。
- `UK` 当前会先命中“两位字母”分支而保留为 `UK`，不会规范化成 `GB`。
- `NA` 当前会被当作有效两位代码保留，但需求明确要求其作为无效占位符过滤。
- 没有“未知地区”哨兵、显示、统计或筛选。
- 固定顺序当前为 `CN, US, JP, KR, GB, HK, TW`，需求是 `CN, HK, TW, US, JP, KR, GB`。
- 同数量、同显示名时缺少按国家代码最终排序。
- StatsBar 通过 `includeCodes` 把已失效选择保留为 0 数量可见项，与“数据更新后清除无效选择并恢复全部地区”冲突。
- 当前只在切换影视类型时主动清除地区；切换状态或增删改/导入/同步使地区消失时不会清除。
- 地区基础统计正确地只取 mediaType/status 范围，但缺少针对 search、lock、rating、sort 和当前地区不影响统计的完整自动化断言。
- 地区项较多时内层容器没有明确 wrap/横向滚动策略；需做可访问性和布局验证。
- 设置页文案仍把内容标签描述为地区主来源，与 `originCountry` 优先规则不一致。
- 没有地区专项 Playwright 流程，也没有新增/编辑/删除/导入/同步后动态更新的 E2E 证据。

因此阶段 B 不是“已完成”，只能标记为“存在未提交的部分实现，受 Gate A 阻塞”。

## 7. 构建、启动与测试入口

计划使用的标准命令：

```powershell
npm ci
npm run dev
npm run tauri dev
npm run typecheck
npm run lint
npm run test
npm run build
npx playwright test
npm run tauri build
Set-Location src-tauri
cargo fmt -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

持续运行的 dev 命令必须记录成功监听/窗口启动证据后正常停止。数据库迁移、导入、恢复、同步和破坏性测试只能使用临时数据库、夹具或独立副本。

## 8. 主要约束与风险

1. 未提交改动范围大且相互交织，后续实施必须按文件/函数审计差异，禁止用旧版本覆盖当前实现。
2. 当前分支直接在 `main` 且超前远端 17 个提交；在任何高风险验证前需要可恢复基线，但本阶段不创建提交或改分支。
3. 真实数据路径语义尚未确认；错误选择会导致用户误以为数据丢失，或在安装目录写入失败。
4. migration 事务化涉及多个历史 schema，必须用多版本夹具和故障注入验证，不能对真实数据库直接试验。
5. mock IPC E2E 可能掩盖 Rust/Tauri/SQLite 集成问题；必须补真实桌面冒烟。
6. Tauri build 的安装器依赖、WebView2、Windows SDK 或签名问题需区分环境与代码问题并保留日志。
7. 地区代码表并非完整 ISO 清单；需求允许格式有效但未映射代码兜底显示，因此不可用“不在字典”作为删除条件。
8. 已跟踪本地产物的清理会改变仓库内容；应只在明确任务中执行并保留 Git 可恢复性。

## 9. 需要用户确认

### CONFIRM-001：应用数据目录的目标产品语义（已确认）

请选择一种明确规则：

- A（建议）：只有可执行文件同级 `data/` 已存在时进入便携模式；否则使用 Windows app-data。README 明确两种模式及切换/恢复方法。
- B：始终优先创建并使用可执行文件同级 `data/`；只有目录不可写时才回退 app-data。

当前 README 描述接近 B，实际代码是 A。该选择会影响数据库、日志、海报、备份和 `poster://` 的统一实现及打包产物冒烟预期。

- Resolution（2026-07-29，用户确认）：采用规则 A。只有可执行文件同级 `data/` 已存在时进入便携模式；否则使用 Windows app-data。
- Consequence：`TASK-A-004` 的产品语义阻塞解除；`TASK-A-009` 的构建产物冒烟按同一规则验收。

其余需求已足以规划。默认只使用合成旧库夹具和临时数据库；如果用户希望额外以真实用户库副本做兼容验收，需要另行提供源路径并授权只读复制，执行者仍必须先备份并记录恢复方法。
