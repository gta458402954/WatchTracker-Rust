# TASK-A-009 Release Smoke Verification

- Branch: `codex/task-a-009`
- Build BASE: `b5c9afd`
- Build command: `npm run tauri build`
- Build result: exit `0`, 132,313 ms, 2026-07-29T15:46:58.0524463Z through 2026-07-29T15:49:10.3655687Z.
- Raw build output: `tauri-build.log`.
- Isolated runtime: `D:\Project\Projects\WatchTracker-A009-Smoke\app.exe` with a pre-created adjacent `data\` directory.
- Runtime copy SHA-256 matched the post-build release EXE: `78BC6F76EE003888E62725E8BC84F47784DA13CDF0B95DD382E4D4777D963513`.

## Final artifacts

| Artifact | Bytes | SHA-256 | Signature |
| --- | ---: | --- | --- |
| `src-tauri/target/release/app.exe` | 15,351,296 | `78BC6F76EE003888E62725E8BC84F47784DA13CDF0B95DD382E4D4777D963513` | NotSigned |
| `src-tauri/target/release/bundle/msi/WatchTracker_1.10.0_x64_en-US.msi` | 5,693,440 | `7CF1D33F1B59A5BCB71947AFC62BFA9FE6EAB4834EC345AEC7D38249804FB739` | NotSigned |
| `src-tauri/target/release/bundle/nsis/WatchTracker_1.10.0_x64-setup.exe` | 3,993,101 | `8ED410C0561B21CABBCE242FA5D406D17C5C8C0305E94795BC789A517D3D4E54` | NotSigned |

All hashes were collected after the build command exited. All three paths are ignored by `src-tauri/.gitignore`; no binary was staged. Signing is not configured in this local build, so `NotSigned` is recorded as a delivery caveat rather than silently treated as signed.

## Real desktop smoke

1. The initial generic desktop-control `launch_app` request did not create a process or window. Exact-path PowerShell 7.6.3 `Start-Process`, with the isolated directory as the working directory, launched the correct executable. PID and executable path were checked before interaction.
2. `01-startup.jpg`: main UI rendered with an empty list and all type/status counts at zero.
3. `02-created.jpg`: created `A009 发布冒烟记录` as a movie; UI showed the success notification and Movie 1.
4. `03-updated-and-reclassified.jpg`: renamed it to `A009 发布冒烟记录（已修改）` and changed type to Series; UI showed Movie 0 / Series 1.
5. `04-after-restart.jpg`: after a clean close and exact-path restart, the modified name and Series classification persisted.
6. With user confirmation at action time, the isolated test record was deleted. `05-deleted.jpg` shows the deletion notification and all counters at zero.
7. `06-empty-after-delete-restart.jpg`: after a second clean close/restart, the list remained empty.

The isolated SQLite database ends with `records = 0`. Its `settings` table contains only `db_version`, `records_generation`, and `sync_tombstones`; no TMDB or WebDAV credential was configured. The UI and local CRUD worked without credentials. The application log contains no `panic`, `Database error`, `no such column`, startup failure, TMDB, WebDAV, or generic error match.

## Path, process and data boundary

- `isolated-app.log` records every startup with portable root `D:\Project\Projects\WatchTracker-A009-Smoke\data`, including the exact database, posters and backups paths.
- The isolated directory contains `watchtracker.db`, `app.log`, `posters\`, and `backups\`.
- TASK-A-009 related process count was zero before execution and zero after final close.
- For all three real user databases, final SHA-256, byte length and UTC mtime exactly match the pre-test snapshot. This establishes that no disk-content or recorded-mtime change was detected during this task.

## Result

Implementation evidence supports AC-A-015, subject to an independent Verification Pass. The implementation pass does not mark the task accepted.
