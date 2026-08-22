# Windows 本地打包诊断与发布边界

> 记录日期：2026-08-20
> 适用版本：WatchTracker 1.10.2 及当前 Tauri 2 / WiX 3.14.1 构建链

## 结论

本地受限构建环境中的 MSI 失败不是 WatchTracker 源码、WiX 安装、生成的 `main.wxs` 或 Windows Installer 注册损坏。失败发生在 WiX `light.exe` 链接阶段执行 ICE 校验时：普通受限进程无法访问 Windows Installer 服务。

便携 EXE 在 MSI 阶段之前已经完成 Release 编译，因此出现该错误不代表 `src-tauri/target/release/app.exe` 无效。不过正式交付前仍必须核对构建提交、文件哈希和程序内显示的 Git commit，不能仅凭文件存在判断成功。

## 2026-08-20 诊断证据

1. Tauri Release 编译成功并明确报告 `Built application at: ...\app.exe`。
2. `candle.exe` 成功把 `main.wxs` 编译为 `main.wixobj`。
3. `light.exe` 在 ICE01～ICE09 阶段返回 `LGHT0217` / `LGHT0216`，底层消息为 `The Windows Installer Service could not be accessed`，最终 Win32 错误为 `0x643`。
4. `msiserver` 的只读检查结果正常：状态 `Running`、启动类型 `Manual`、服务账户 `LocalSystem`、映像为 `C:\Windows\System32\msiexec.exe /V`。
5. 在非隔离权限下运行完全相同的 `light.exe` 输入后成功生成诊断 MSI，只报告非阻塞 ICE 警告。这证明同一份 WiX 对象可以链接，差异来自进程权限/隔离上下文。

## 当前成因

`src-tauri/tauri.conf.json` 当前设置 `bundle.targets = "all"`，而 `scripts/build-portable.mjs` 调用完整的 `tauri build`。所以一次“便携版”构建实际依次尝试：

1. 前端生产构建；
2. Rust Release EXE；
3. MSI；
4. NSIS（若此前阶段未失败）。

在受限本地环境中，步骤 2 成功后步骤 3 的 ICE 校验失败，导致整个命令返回非零；NSIS 也可能因此没有机会执行。

## 后续修改方案

- 本地 `build:portable` 只负责从干净 Git 提交构建单文件 EXE，不触发 MSI 或 NSIS。
- 便携构建继续注入完整 Git commit 和提交时间，并在复制前验证工作树干净、源文件哈希和内嵌提交。
- 正式 MSI/NSIS 继续由推送 `v*` 标签后触发的 GitHub Actions Windows Runner 构建、保存 artifact 并发布到 GitHub Release。
- 若确实需要本机安装包，必须在允许访问 Windows Installer 服务的非隔离构建上下文运行；不通过跳过 ICE 校验来掩盖环境问题。
- 在上述脚本调整实施前，本地完整 `tauri build` 的 MSI 失败应按本记录诊断，但不能把存在的旧 MSI/NSIS 文件误认为本次构建产物。

## 非目标

- 不重新注册或重装 Windows Installer；现有诊断不支持这是系统安装损坏。
- 不修改 V18 数据库、便携数据目录或同步格式。
- 不降低 GitHub tag 发布对 EXE、MSI 和 NSIS 三类资产的要求。
