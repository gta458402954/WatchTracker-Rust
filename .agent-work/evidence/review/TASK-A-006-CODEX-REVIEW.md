# TASK-A-006 Codex Independent Review

## Decision

- Task: `TASK-A-006`
- Result: `ACCEPTED`
- Acceptance criteria: `AC-A-004 PASS`, `AC-A-006 PASS`, `AC-A-007 PASS`
- Implementation BASE: `98990e09cb9d6ac7621595f7b61ef32d0f4f82ea`
- Implementation commit: `20df1f51b1a48acd22a600179d3a4c343ca0f54c`
- Implementation worktree: `D:\Project\Projects\WatchTracker-A006`
- Independent verification worktree: `D:\Project\Projects\WatchTracker-A006-Verify` (detached at `20df1f5`)
- Isolated runtime root: `D:\Project\Projects\WatchTracker-A006-Runtime-20260729`

## Scope and implementation review

The implementation commit contains exactly ten authorized files (360 insertions, 112 deletions). It does not change dependencies, lockfiles, Tauri configuration, WebDAV transport, credentials, or user databases.

- Rust insert/delete/replace operations now update records, tombstones, and `records_generation` in one SQLite transaction.
- Replacement preserves locked records and increments the generation once.
- The frontend no longer performs a second, non-atomic tombstone mutation after local CRUD.
- Import normalization preserves `originCountry`, `contentTags`, `releaseYear`, `rev`, and `revActor`, with deterministic fallbacks for older payloads.
- Automated tests cover success and rollback for insert/delete/replace, dirty-row handling, import normalization, and settings reopening.

## Independent automated verification

All commands below were rerun from the detached verification worktree at `20df1f5`.

| Command | Result |
| --- | --- |
| `npm ci` | exit 0; existing audit inventory: 1 low and 3 high |
| `npx tsc -b --noEmit` | exit 0 |
| `npm run lint` | exit 0 |
| `node --test src/shared/lib/__tests__/*.test.mjs` | exit 0; 14/14 passed |
| `npm run build` | exit 0; 606 modules transformed |
| `cargo test --locked` | exit 0; 29/29 passed |
| `cargo clippy --all-targets --all-features --locked -- -D warnings` | exit 0 |
| `npm run tauri build` | exit 0 |

The localized linker message printed to stdout during Rust commands was informational; it did not change the zero exit codes or strict-Clippy result.

Release artifacts were read after the build process exited:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `src-tauri\target\release\app.exe` | 15,351,296 | `EC4C1015D60DEC20A4D0C859468C7AF5033455104416F8C816C49F822E08DC06` |
| `src-tauri\target\release\bundle\msi\WatchTracker_1.10.0_x64_en-US.msi` | 5,693,440 | `D4182B21647D38C0875A740402A27FB49EEF195EA3FA5669ECCFC6826FB18314` |
| `src-tauri\target\release\bundle\nsis\WatchTracker_1.10.0_x64-setup.exe` | 3,993,044 | `E5717E574A95F0CDEAE67C5B309D6E2C38F3878472ED1BB86B29A41C8804791D` |

## Isolated real-Tauri verification

Four executable-adjacent `data/` fixtures were used. No active user database was supplied to the application.

### Empty database

- The actual desktop main interface opened without an error, white screen, or infinite loading state.
- Movie and series counts were zero and the normal empty-state UI was shown.

### Current database and CRUD

- Two UTF-8 seed records loaded with the expected movie/series, watched/watching, US/KR, and lock states.
- Media-type, status, and region combinations filtered correctly.
- A test movie was created with Japan and science-fiction tags; Japan immediately appeared in the region UI.
- Locking hid edit/delete controls and disabled status mutation; unlocking restored them.
- The record was renamed to `A006 原子测试电影（已修改）`; restart preserved the edit and all three records.
- Settings reopened after restart with the seeded sync interval `45`; no TMDB or WebDAV credentials were configured.
- Local export produced a three-record JSON document whose records retained `originCountry`, revision fields, and other expected fields.
- Importing that exported document through the real file dialog reported `已导入 3 条本地记录。`; the database retained US/KR origins and the locked record.
- With user authorization, the exact test record was deleted through the UI. SQLite then contained two records, generation `6`, and a tombstone for ID `3a43f78b-e668-4472-80ff-facc52735280` at `2026-07-29T15:07:02.106Z`.
- A final restart still contained only the two seed records. The deleted test record did not return.

### Legacy database

- A synthetic v12 database with one UTF-8 record opened in the real UI and preserved the record's name, series/watching classification, and Korea region.
- After migration, `db_version` was 18, the record count remained one, legacy `category`/`sortOrder` columns were absent, and revision columns were present.
- A second launch displayed the same migrated record.

### Dirty record

- A database containing one valid row and one deliberately invalid-status row entered the main interface normally.
- The valid row remained usable; the incompatible row was skipped instead of crashing or blanking the entire list.
- The physical invalid row remained on disk, documenting the compatibility strategy as non-destructive skipping rather than silent deletion.

## Offline, failure, and data-safety conclusions

- Local startup, CRUD, settings, export, and import worked without TMDB or WebDAV credentials.
- A-005 independently demonstrated visible, generic feedback for injected import/restore/sync failures. A-006 transaction tests prove that a failed replacement does not partially overwrite records, tombstones, or generation state.
- No live WebDAV target was written and no credential was requested; advanced synchronization remains outside this task.
- The three active user database size/mtime/SHA-256 tuples matched their accepted pre-test references at the final check; no disk-content change was detected:
  - AppData: 622,592 bytes; `BF96F204F9B73E2C30CE6C6DFCFA5F1D2FA9C5D1BB89D3BF245797B716893CF7`
  - Portable: 1,277,952 bytes; `52E6B56CF062CFF35902ABF859AEC0A065C6CBBD6D73AE8200F1C811BCAA6B80`
  - Public release: 36,864 bytes; `D466C6649851DF8023E79FD595B180B066266F2FD153BFEF8CAAAE11F0EC82DE`
- No A-006 application process remained after verification.

## OneDrive launch incident

The first automation request used the desktop-control launch interface with the literal copied path ending in generic `app.exe`. That request produced no WatchTracker process, database, log, or window. At the same time, Windows created `OneDrive.App.exe` PID 13232 from `C:\Users\markp\AppData\Local\Microsoft\OneDrive\OneDrive.App.exe`, and the desktop-control app catalog identifies OneDrive Photos with process keys including `app`.

The high-confidence explanation is an app-catalog name collision: the launch interface resolved the generic basename/process key `app` to the registered OneDrive application instead of treating the unregistered executable path as authoritative. This is a tooling-resolution defect, not WatchTracker database fallback. A later exact-path `Start-Process` created WatchTracker PID 9884 and immediately produced the expected isolated database and log.

Mitigation for future verification:

1. Do not use the desktop-control `launch_app` operation for a generic copied `app.exe`.
2. Start it with `Start-Process -FilePath <absolute-path> -PassThru`.
3. Before interacting, verify PID, creation time, and exact `ExecutablePath`, then require the expected isolated database/log and WatchTracker window.
4. Treat a launch without those checks as invalid evidence and do not send UI input.

The OneDrive process was not terminated because it is a user application outside the task scope.

## Repository observations and limitations

- `src-tauri/src/auth.rs` and `src-tauri/src/error.rs` retain pre-existing/stat-only working-tree noise in the implementation worktree; their working-byte hashes equal `HEAD`, `git diff` is empty, and they were not included in the implementation commit.
- The verification worktree similarly reports stat-only `src-tauri/Cargo.toml` noise with an empty diff.
- UI observations were performed through desktop control and are summarized here; no synthetic screenshot or placeholder image is claimed as application evidence.
- The isolated runtime directory is retained for inspection. It is not tracked by Git and contains no active user database.

## Final conclusion

The three required acceptance criteria are satisfied by independent automated tests, real isolated desktop flows, post-restart SQLite inspection, and unchanged active-database content hashes. `TASK-A-006` is accepted. This conclusion does not open or accept `TASK-A-007`.
