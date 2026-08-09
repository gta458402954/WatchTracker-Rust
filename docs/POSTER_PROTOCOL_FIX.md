# 海报协议 URL 修复方案（`caec49b` 回归，Windows 显形）

> 状态：已实施并通过代码门禁，待 Git 提交、便携版替换与 Windows 实机确认。
> 关联提交：`caec49b`（安全网络响应与海报缓存）、`fd7f93d`（安全设计文档）。

## 0. 结论

`SafePosterImage.tsx` 手工拼接了 `poster://localhost/...`。Tauri v2 的自定义协议在 Windows/Android WebView 中应转换为 `http://poster.localhost/...`，在 macOS/Linux 中才使用 `poster://localhost/...`。因此 Windows 便携版无法正确加载这个地址，请求通常不会进入 Rust 的 `poster` 协议处理器。

旧版 `PosterWall` 在本地地址加载失败后会直接加载 TMDB 图片；`caec49b` 为避免前端绕过受控下载而移除了该兜底，于是原有 URL 问题暴露为“全部海报无法显示”。这不是数据库或缓存丢失：当前数据库仍有 996 个海报路径，便携版仍有 528 张有效 JPEG，约 25.9 MB。

修复应使用 Tauri 官方 `convertFileSrc(cacheFileName, 'poster')`，但只向它传递已经规范化的缓存文件名，不传绝对磁盘路径。这样 Windows 会得到 `http://poster.localhost/<encoded-file-name>`，其他平台得到 `poster://localhost/<encoded-file-name>`，现有 Rust 处理器继续只接受 posters 目录中的单个文件名。

## 1. 设计原则

1. 保持 Rust 为海报缓存的唯一网络下载者和文件读取者。
2. 不恢复前端 TMDB 直链兜底。
3. 不把 posters 绝对目录暴露给前端，不新增 `posters_dir` 命令。
4. 不扩大协议处理器的输入范围；继续只接受一个安全文件名。
5. 前端与 Rust 共用同一命名规则的测试向量，防止 `w92`/`w342` 命名漂移。
6. 缓存缺失是正常的首次加载路径，不应为每个 404 写高等级日志。

## 2. 对原方案的修正

原方案提出“先获取 posters 绝对目录，再把绝对路径交给 `convertFileSrc`，最后让 Rust 解码并验证绝对路径”。这不需要，也不建议实施：

- `convertFileSrc` 的第二个参数支持自定义协议；第一个参数会被编码为该协议 URL 的 path，并不要求必须是绝对路径。
- 直接传 `abc.jpg` 会在 Windows 生成 `http://poster.localhost/abc.jpg`，正好匹配现有 handler 的单文件名模型。
- 传绝对路径会扩大 Rust handler 的解析和安全审计面，引入盘符、UNC、百分号二次解码、分隔符和大小写等 Windows 边界。
- 新增 `posters_dir` IPC 只为构造 URL 服务，没有业务价值，还泄露本地数据目录结构。
- 原示例中的 `Component::Normal` 校验会拒绝 Windows 绝对路径本身包含的 `Prefix` 和 `RootDir`，与“接受绝对路径”的目标矛盾。

因此以下内容从实施范围中移除：

- `AppPaths::poster_file_from_request`；
- `commands::posters_dir` 及前端 `getPostersDir()`；
- 绝对路径的 URL 编码/解码；
- 为这次 URL 修复重构整个协议 handler。

## 3. 改动文件总览

| 文件 | 改动 |
|---|---|
| `src/shared/lib/posterSource.ts` | 新增同步、纯前端的缓存命名与协议 URL 生成器 |
| `src/features/watchlist/components/SafePosterImage.tsx` | 使用 `posterSource`，删除手拼协议 URL |
| `src-tauri/src/poster_cache.rs` | 修正 `w92` 引用集合并补充命名/清理测试 |
| `src/shared/lib/__tests__/posterSource.test.mjs` | 验证 Windows、非 Windows URL 与文件名编码 |
| `tests/fixtures/mockIpc.ts` | 为浏览器测试补齐 `convertFileSrc` mock（若组件 E2E 需要） |
| `tests/poster-cache.spec.ts` | 验证组件状态流；不冒充真实 Tauri 协议集成测试 |

`src-tauri/src/app_paths.rs`、`commands.rs` 和协议 handler 原则上无需改变。

## 4. 前端实现

### 4.1 新增 `posterSource.ts`

```ts
import { convertFileSrc } from '@tauri-apps/api/core';

export type PosterSize = 'w92' | 'w342';

export function posterCacheName(posterPath: string, size: PosterSize): string {
  const name = posterPath.replace(/^\//, '');
  return size === 'w92' ? `w92_${name}` : name;
}

export function posterSource(
  posterPath: string,
  size: PosterSize,
  revision: number,
): string {
  const source = convertFileSrc(posterCacheName(posterPath, size), 'poster');
  return `${source}?v=${revision}`;
}
```

这里保持同步计算，不需要 `useEffect`、目录 IPC、Promise 缓存或加载占位状态。`posterPath` 在进入数据库和 Rust 下载命令时已经受 `normalized_file_name` 约束；前端仍应把 `posterCacheName` 视为显示辅助函数，而不是安全边界，真正的安全边界继续在 Rust。

### 4.2 修改 `SafePosterImage.tsx`

```tsx
import { posterSource } from '../../../shared/lib/posterSource';

const source = useMemo(
  () => posterSource(posterPath, size, revision),
  [posterPath, revision, size],
);
```

删除组件内部的 `cacheName` 和手拼的 `poster://localhost/...`。下载、缓存命中、revision 刷新以及失败重试状态保持不变。

revision 查询参数继续保留，用于下载成功后绕过 WebView 图片缓存。Rust handler 使用 `request.uri().path()`，查询参数不会进入文件名校验。

## 5. Rust 协议处理器

本次不改变输入模型。现有流程已经满足要求：

1. 从 `request.uri().path()` 取得 URL path；
2. 去掉开头 `/`；
3. `AppPaths::poster_file` 只接受单个普通文件名，拒绝目录、绝对路径和 `..`；
4. `read_valid` 校验大小和 JPEG/PNG/WebP 文件签名；
5. 返回真实 MIME。

可以单独做一个低风险的可观测性增强，但不作为修复海报显示的前置条件：

- 非法路径返回 400 时记录 `warn`，但不要记录未经处理的完整用户输入；
- 文件存在但签名无效时记录错误码和安全文件名；
- 普通缓存未命中 404 不逐张记 `warn`，因为它会正常触发受控下载，海报墙首次打开可能产生数百条预期 404；
- 下载失败继续由前端 `reportOperationFailure` 记录标准错误码。

不需要为了 `<img>` 增加 422 状态。浏览器只把非成功响应视为图片加载失败，404 与 422 对 UI 没有区别，诊断应依靠结构化日志或缓存统计。

## 6. `w92` 缓存引用修复

当前 `referenced_file_names` 只将 `w342` 文件纳入引用集合，因此同一条目对应的 `w92_` 文件会被当作 orphan。若产品定义为“条目只要仍引用这个 posterPath，其派生尺寸都不得被自动删除”，应同时加入两种尺寸：

```rust
pub fn referenced_file_names(records: &[WatchRecord]) -> HashSet<String> {
    let mut names = HashSet::new();
    for record in records {
        let Some(path) = record.poster_path.as_deref() else {
            continue;
        };
        for size in ["w342", "w92"] {
            if let Ok(name) = normalized_file_name(path, size) {
                names.insert(name);
            }
        }
    }
    names
}
```

需要明确：这只保护“数据库条目仍引用”的 `w92` 文件。仅出现在一次 TMDB 搜索结果、从未保存到条目的缩略图仍属于可清理缓存，这是正确行为。

现有 `automatic_style_cleanup_preserves_referenced_posters` 测试也要调整：

- `kept.jpg` 和 `w92_kept.jpg` 都应保留；
- 增加 `orphan.jpg` 与 `w92_orphan.jpg`，两者都应删除；
- `referenced_count` 从 1 改为 2。

## 7. 测试计划

### 7.1 前端单元测试

项目当前使用 Node `node:test`，不是 Vitest。新增 `posterSource.test.mjs`，通过 Tauri 的 `mockConvertFileSrc` 或等价 mock 验证：

- Windows：`posterCacheName('/abc.jpg', 'w342')` → `abc.jpg`，URL 以 `http://poster.localhost/abc.jpg` 开头；
- Windows：`w92` → `http://poster.localhost/w92_abc.jpg`；
- 使用真实 TMDB 风格的安全文件名锁定编码契约：`posterCacheName('/2baf1e.jpg', 'w92')` → `w92_2baf1e.jpg`，生成 URL 的 path 必须原样包含 `w92_2baf1e.jpg`；
- macOS/Linux：URL 以 `poster://localhost/` 开头；
- revision 只进入查询参数；
- 测试向量与 Rust `normalized_file_name` 的预期一致。

测试结束必须恢复全局 mock，避免污染其他 `node:test` 用例。

当前 Rust `normalized_file_name` 只允许 ASCII 字母、数字、`-`、`_` 和受支持的图片扩展名，因此 `convertFileSrc` 对现有缓存文件名的编码结果实际上不改变 path 内容，handler 能精确命中磁盘文件。如果未来允许空格、中文或其他非 ASCII 字符，必须把“URL path 解码一次 → 重新执行统一文件名安全校验 → 再访问缓存”作为一次独立协议升级，不能只放宽前端命名或依赖 WebView 的隐式解码。

### 7.2 Rust 单元测试

- 保留并扩展 `normalized_file_name` 的合法/非法输入测试；
- 验证 w342 与 w92 使用独立命名空间；
- 验证自动清理同时保留条目引用的两种尺寸；
- 验证未被任何条目引用的两种尺寸均可删除；
- `AppPaths::poster_file` 继续覆盖绝对路径、嵌套路径、`..` 和分隔符攻击。

不需要为了本次修复新增“绝对路径 handler”测试，因为修复后的协议仍只传文件名。

### 7.3 Playwright 的边界

普通 Playwright 在浏览器/Vite 环境运行，不能真实注册或请求 Tauri Rust 自定义协议。因此不能把 Chromium 中 mock 出来的 `naturalWidth > 0` 当作 Windows 协议集成验证。

Playwright 可以验证：

- `SafePosterImage` 首次失败后只触发一次 `download_poster`；
- 下载成功后 revision 改变并重试；
- 下载失败进入“无图/重试海报”状态；
- `mockIpc.ts` 的 `convertFileSrc` 返回平台相符的可预测测试 URL。

真实协议必须由 Windows 便携版冒烟测试覆盖。

### 7.4 Windows 便携版验收

1. 使用包含现有 `data/posters` 的便携目录启动新版；
2. 打开海报墙，抽查现有缓存立即显示，不应先访问网络；
3. 抽查一个尚无本地文件但有 `posterPath` 的条目，确认 Rust 下载后自动显示；
4. 断网启动，确认已有缓存仍可显示，缺失缓存进入可重试状态；
5. 搜索 TMDB，确认 w92 缩略图显示；
6. 执行“清理未引用缓存”，确认已有条目对应的 w342/w92 保留，搜索后未保存的孤立缩略图可被删除；
7. 查看 `app.log`，确认没有因正常缓存未命中产生海量警告。

### 7.5 Android 可选冒烟（非本次交付门禁）

Tauri 在 Android 上也使用 `http://poster.localhost/...` 形态，`convertFileSrc` 会统一处理，不需要增加平台分支。若后续同步更新 Android 项目，可额外验证已有缓存显示、缺图下载和 w92 搜索缩略图；本次 Windows 便携版修复不以 Android 构建或设备测试为阻塞条件。

## 8. 验证顺序与门禁

1. `npm test`；
2. `npm run typecheck`；
3. `npm run lint`；
4. 确认不是在旧产物上增量判断结果，执行 `npm run build` 重新生成 `dist/`；构建后检查 `dist/` 不再包含手拼的 `poster://localhost/`；
5. `cargo fmt --check`；
6. `cargo clippy --locked -- -D warnings`；
7. `cargo test --locked`；
8. 生产 Tauri build；
9. 在现有便携数据副本上完成 Windows 冒烟测试；
10. 确认 Git 工作区只包含本任务文件后提交，再替换便携版。

当前 `dist/` 仍可能包含修复前构建出的 `poster://localhost/` 字符串；它只是旧构建产物，不影响根因判断。实施时必须由新源码完成一次干净的生产构建并核对产物，不能直接复用现有 `dist/`。

## 9. 回滚与数据安全

- 本任务不迁移 SQLite、不修改 `posterPath`、不批量重下海报。
- 替换 EXE 前继续保留当前可执行文件备份。
- 若新版本仍有问题，回滚 EXE 即可；数据库和 posters 目录无需回滚。
- 禁止以“清空全部海报”作为修复或验收步骤。
- 不恢复 `https://image.tmdb.org` 到前端 CSP；所有新下载继续经过 Rust 的大小、类型、超时和临时文件校验。

## 10. 范围外后续项

- `download_poster` 每次完成后全量扫描缓存执行 `enforce_capacity` 的性能优化；
- `PosterDownloadState.locks` 中已完成文件锁的回收；
- 为真实 Tauri WebView 建立自动化 Windows 冒烟测试基础设施；
- 海报多尺寸策略（是否长期保留全部 w92）如将来调整，应作为独立缓存策略任务处理。
