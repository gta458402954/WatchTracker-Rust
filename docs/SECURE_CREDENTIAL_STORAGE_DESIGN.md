# TASK-D-SEC-001：Windows 凭据保护与旧格式迁移专项设计

> 状态：DRAFT，等待用户确认后实施
> 日期：2026-08-02
> 数据库：继续使用 V18；秘密本体移出 SQLite
> 依赖：`TASK-D-SYNC-003` 已实现的 WebDAV target ID 与目标级命名空间

## 1. 目标与边界

当前 WebDAV 密码和 TMDB API Key 仍以 `portable:v1:…` 或 `machine_bound:v1:…` 字符串存在 SQLite。前者只是 Base64，后者由 machine UID 与固定 salt 派生 AES-GCM 密钥；数据库、旧备份或便携目录被复制时仍包含可离线分析的秘密材料，换机或 Windows 身份变化时也只有通用解密失败。

本任务要保证：

1. WebDAV 密码与 TMDB Key 的秘密本体不再写入 SQLite、恢复点、日志或前端状态。
2. 已保存秘密由当前 Windows 用户的 Credential Manager 保护；数据库只保存非秘密引用标记。
3. `portable:v1` 与 `machine_bound:v1` 可逐项、可恢复、幂等迁移；某一项失败不影响本地影视数据和其他凭据。
4. 已保存密码不再通过 Tauri IPC 返回 React，再由 React 回传 Rust。
5. 机器或 Windows 用户变化、凭据被手工删除、存储不可用和旧格式损坏必须有不同的安全状态。

不在本任务：跨机器同步秘密、云端密钥托管、Windows Hello 交互、永久删除 WebDAV target、轮换远端服务密码，或保护同一 Windows 用户权限下已控制本进程的恶意软件。

## 2. 选型与威胁模型

采用 Windows Credential Manager 的 `CRED_TYPE_GENERIC` 和 `CRED_PERSIST_LOCAL_MACHINE`。Microsoft 对新 Windows 开发的建议顺序是优先使用 Credential Manager；`CredWriteW` 会为当前登录令牌的用户创建或替换凭据。`CRED_PERSIST_LOCAL_MACHINE` 表示同一用户在本机后续登录会话可见，不向其他用户开放，也不承诺跨机器漫游。参考：[Handling Passwords](https://learn.microsoft.com/en-us/windows/win32/secbp/handling-passwords)、[CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)、[CREDENTIALW persistence](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)。

不采用“DPAPI 密文继续放 SQLite”作为主方案。DPAPI 默认也绑定当前用户和机器并提供完整性保护，但数据库和所有历史副本仍会携带密文材料；Credential Manager 更符合密码存储语义。`CRYPTPROTECT_LOCAL_MACHINE` 会允许本机任意用户解密，因此明确禁止使用该标志。参考：[CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)。

本方案防护：便携数据库或普通恢复点泄露、日志/错误意外暴露、其他 Windows 用户直接读取秘密、旧 `portable:v1` 的明文等价存储。它不防护：管理员或同一用户上下文中的恶意进程、运行时内存抓取、键盘记录、远端服务泄露，以及用户主动复制秘密。

## 3. 逻辑标识与数据库表示

Credential Manager TargetName 只能由 Rust 根据固定规则生成，不接受数据库或前端传入任意 TargetName：

```text
WatchTracker/v1/webdav/<64 位 target ID>
WatchTracker/v1/tmdb/default
```

WebDAV target ID 已由规范化 URL＋保留大小写用户名生成；密码轮换仍覆盖同一 Credential Manager 项。CredentialBlob 使用 UTF-8 JSON 信封，包含 `version`、`kind`、`logicalId` 和 `secret`，读取时校验信封与派生逻辑 ID 一致，防止不同项之间复制混用。秘密限制为 1~2048 UTF-8 字节，写入和读取缓冲使用 `zeroize` 尽快清零。

SQLite 只保存固定标记，不保存 TargetName：

```text
sync_target::<id>::credentials = wincred:v1
tmdb_api_key                   = wincred:v1
credential_migration_v1        = <不含秘密的迁移日志，完成后删除>
credential_security_state_v1   = <版本、完成时间、历史备份提示>
```

固定标记加派生名称避免被篡改的数据库诱导应用读取当前用户凭据库中的任意其他项目。V18 `settings` 足以保存这些状态，不增加表或数据库版本。

## 4. Rust 边界与 IPC 收紧

新增内部 `SecretStore` 接口，生产实现使用 Win32 `CredWriteW` / `CredReadW` / `CredDeleteW`，测试实现使用进程内 fake store。Win32 绑定只在 `cfg(windows)` 编译；非 Windows 生产调用返回 `credential_store_unsupported`。

删除通用 Tauri `encrypt` / `decrypt` 命令，改为目的限定接口：

- `save_tmdb_credential(secret)`、`get_tmdb_credential_status()`、`clear_tmdb_credential()`；
- `activate_sync_target` 在 Rust 内直接写入 WebDAV password；
- `get_active_sync_connection` 只返回 target ID、epoch、URL、用户名和可用状态，不返回 password；
- 日常 `webdav_request` 只携带 target ID＋epoch，Rust 校验上下文后从凭据库取 password 并发起请求；
- 切换前只读探测使用单独 `probe_sync_target`，临时 password 只在一次 Rust 命令内存在，不保存、不返回；
- TMDB 搜索和详情命令不再接收 `apiKey`，由 Rust 内部读取固定逻辑项。

前端保存成功后立即清空密码/API Key 输入状态。请求 DTO、mock 快照、错误对象和日志字段不得出现秘密值；日志最多记录逻辑类型、target ID 短指纹和稳定错误码。

## 5. 迁移协议

Credential Manager 与 SQLite 不能组成一个原子事务，因此使用不含秘密的写前迁移日志，而不是假装跨系统原子：

1. 枚举所有 `sync_target::<id>::credentials` 和 `tmdb_api_key`。已经是 `wincred:v1` 的项目只验证引用，不重复迁移。
2. SQLite 单事务写入 `credential_migration_v1`，记录每项逻辑 ID、源格式、源值 SHA-256 指纹和阶段 `planned`；源值保持原样。
3. 在内存中解析 `portable:v1` 或解密 `machine_bound:v1`。WebDAV 信封中的用户名必须与 target 注册表一致。
4. `CredWriteW` 写入派生 TargetName，随后 `CredReadW` 回读并以常量时间比较完整信封；成功后将该项标为 `vault_verified`。
5. SQLite 单事务把对应源值替换为 `wincred:v1`，将该项标为 `db_switched`。只有已经回读验证的项目才允许替换旧值。
6. 再次按数据库引用读取全部新项；成功后删除已完成日志项。全部结束后写 `credential_security_state_v1`。

崩溃恢复：

- `planned`：旧值仍在，重新解析并覆盖写同一 TargetName；
- `vault_verified`：先回读验证，再执行数据库切换；
- `db_switched`：以派生 TargetName 验证；存在即完成，不存在则进入 `credential_missing`，绝不回退猜测；
- 写入凭据库后、SQLite 切换前产生的重复项不是数据丢失，重试覆盖同名项即可。

此迁移不创建普通全库恢复点，因为它会额外复制 `portable:v1` 等弱格式秘密。迁移日志和“先验证、后替换”本身是回滚边界；数据库事务失败时旧值仍存在。该例外必须写入架构文档。

## 6. 失败状态与用户恢复

稳定错误状态：

- `credential_reentry_required`：旧 `machine_bound:v1` 因机器/用户变化无法解密；
- `credential_legacy_corrupt`：Base64、AES-GCM 或信封格式损坏；
- `credential_store_unavailable`：Windows Credential Manager 暂时不可用；
- `credential_write_unverified`：写入后无法回读或内容不一致，数据库旧值保留；
- `credential_missing`：数据库为 `wincred:v1`，但派生项已被外部删除；
- `credential_store_unsupported`：非 Windows 生产环境。

失败只阻断依赖该秘密的动作：单个 WebDAV target 不能同步或 TMDB 不能查询；本地记录、其他 target 和无需秘密的功能继续工作。用户重新输入后直接写同一派生项并替换引用，不需要重建 target 或覆盖已有同步状态。

设置页显示每项“受 Windows 保护 / 需要重新输入 / 凭据缺失 / 暂时不可用”，不显示秘密、密文或 Win32 原始错误。诊断日志保留稳定代码和已脱敏 Windows error 分类。

## 7. 历史备份边界

迁移只清除当前活动数据库中的旧值。迁移前的恢复点、手工数据库副本或旧便携目录可能仍含 `portable:v1` / `machine_bound:v1`：

- 成功迁移后记录迁移时间，并在设置页明确提示历史备份风险；
- 提供“清理迁移前自动恢复点”操作，先列出数量和时间范围，用户确认后只删除未保留的自动恢复点；
- retained 恢复点、应用外手工备份和旧便携目录不自动删除；
- 不宣称 SSD/文件系统删除等于物理安全擦除；若曾使用 `portable:v1`，建议用户轮换 WebDAV password 与 TMDB Key。

第一版不自动删除任何历史恢复点，避免凭据迁移扩大成不可恢复的数据删除。

## 8. 实施顺序

1. 引入最小 Win32 Credential Manager 绑定、`SecretStore` 接口、信封和 fake store。
2. 实现派生 TargetName、引用标记、稳定错误与缓冲清零。
3. 实现逐项迁移日志和崩溃恢复；保持 V18。
4. WebDAV 存储、读取、探测和网络请求改为 Rust 内部取密钥。
5. TMDB 保存、状态和请求改为 Rust 内部取密钥。
6. 移除通用 IPC `encrypt` / `decrypt` 及前端解密路径。
7. 设置页增加安全状态、重新输入说明和历史备份风险提示。
8. 完成 fake store、临时 SQLite 和 mock 网络验收后再部署便携版。

## 9. 验收矩阵

### Rust / fake SecretStore / 临时 SQLite

- TargetName 只能由合法逻辑 ID 派生；数据库篡改不能读取任意凭据项。
- WebDAV A/B 和 TMDB 三类秘密严格隔离，密码轮换覆盖同一项。
- `portable:v1`、`machine_bound:v1`、空值、损坏值和用户名不一致分别处理。
- 每个迁移阶段注入崩溃或 SQLite/CredWrite/CredRead 失败，重启后幂等恢复。
- 只有回读验证成功才替换旧值；失败时数据库旧值逐字节不变。
- `wincred:v1` 项缺失不回退、不创建空秘密、不影响本地记录。
- V18、records、Tombstone、generation 和全部同步状态迁移前后不变。
- 清除、轮换和部分迁移不误删其他 target 的凭据。

### 静态契约 / TypeScript

- 已保存 WebDAV/TMDB 读取 DTO 不含 password、apiKey、ciphertext 或 Credential Manager TargetName。
- Tauri handler 不再注册通用 `encrypt` / `decrypt`。
- 日常 WebDAV/TMDB 请求只传逻辑上下文，不传已保存秘密。
- 前端保存完成立即清空输入，固定错误文案不拼接原始 Win32 消息。

### Playwright / mock SecretStore 与 mock 网络

- 旧凭据自动迁移后同步和 TMDB 查询正常，前端从未收到秘密。
- 某一 target 需要重输时其他 target 和本地列表仍正常。
- 凭据库项被删除后显示“需要重新输入”，零 WebDAV PUT、零 TMDB 请求。
- 新 target 探测的临时 password 只出现在一次 probe 调用，确认前不持久化。
- 密码轮换不创建新 target；失败写入不覆盖可用旧项。
- 历史备份提示不自动删除 retained 或应用外文件。

### Windows 手工门禁

自动化默认不得写用户真实 Credential Manager。另设显式环境开关，以随机测试 TargetName 完成 `CredWriteW → CredReadW → CredDeleteW`，finally 强制清理；不使用真实 WebDAV/TMDB secret，不读取或枚举 WatchTracker 以外项目。

真实便携数据库仅在部署前后做只读 V18、记录数、完整性和哈希核验。首次正式迁移由用户启动新版触发，不在打包测试中操作真实凭据。

## 10. 待确认方案

推荐按本文方案实施，尤其确认以下边界：

1. 使用 Windows Credential Manager 保存秘密本体，数据库仅保留 `wincred:v1`；因此便携程序文件和数据库可以移动，但已保存密码不会随之迁移，换机后需要重新输入。
2. 第一版只提示历史备份可能含旧秘密，不自动删除任何恢复点；后续可单独实现经用户确认的“清理迁移前自动恢复点”。
