# TASK-A-008 Codex Independent Review

## Decision

- Task: `TASK-A-008`
- Result: `ACCEPTED`
- BASE: `aa59ccb8b088d4b702f8e087f0796f732c54b37e`
- Authorization commit: `777e978`
- Implementation commit: `e44ff53`
- Implementation worktree: `D:\Project\Projects\WatchTracker-A008`
- Independent verification worktree: `D:\Project\Projects\WatchTracker-A008-Verify` (detached at `e44ff53`)
- Acceptance criteria: `AC-A-012 PASS`, `AC-A-016 PASS`

## Scope and repository review

The implementation commit contains exactly five authorized paths:

- `.github/workflows/ci.yml` added.
- `.gitignore` updated with build/test report and root installer rules.
- `README.md` replaced with the verified development, quality-gate, data-path, offline, build, backup, and recovery instructions.
- `docs/REFACTOR_ATOMIC_API.md` added from the current registered commands and tested transaction implementation.
- `WatchTracker-Portable.exe` removed from Git tracking and the task worktree.

The removed binary was 15,181,312 bytes with pre-removal SHA-256 `A9CB04AEDB93AC9D5D1E7E161EFF111835ECE25EE67CBCFAE2AFC7F0CCDF24D8`. It remains recoverable from Git commit `53a541c` (`git cat-file` independently returned 15,181,312 bytes) and from external release copies. No user source document, database, credential, or external release file was deleted.

No application source, dependency, lockfile, database schema, migration, or runtime behavior changed.

## README command review

The README now distinguishes a full Tauri desktop launch from a Vite-only frontend server and contains these reproducible commands:

1. `npm ci`
2. `npm run tauri dev`
3. `npm run dev`
4. `npx playwright install chromium`
5. `npm run typecheck`
6. `npm run lint`
7. `npm run test`
8. `npm run build`
9. `npx playwright test`
10. `cargo fmt -- --check`
11. `cargo clippy --all-targets --all-features --locked -- -D warnings`
12. `cargo test --locked`
13. `npm run tauri build`

It records the accepted Windows tool versions, lockfile policy, actual `app.exe`/MSI/NSIS locations, portable-mode precondition, `%APPDATA%\com.watchtracker.desktop`, unified database/log/poster/backup paths, no-silent-fallback behavior, offline operation, credential boundary, and safe mode-switch/recovery procedure.

`npm ci` and every non-desktop quality command were rerun in the clean verification worktree. `npm run tauri dev` and the executable path behavior were already independently accepted in A-004/A-006; `npm run tauri build` was independently accepted in A-006 and is the explicit subject of A-009. A-008 did not launch a desktop application or manufacture a second release artifact.

## Atomic API to code comparison

The new document matches the five record commands registered in `src-tauri/src/lib.rs` and called by `src/shared/lib/database.ts`:

| Registered command | Documented | Key implementation |
| --- | --- | --- |
| `get_all_records` | yes | `commands.rs` / `db.rs` |
| `insert_record` | yes | `db_atomic_crud::insert_record_atomic` |
| `update_record` | yes | `db_atomic_update::update_record_atomic` |
| `delete_record` | yes | `db_atomic_crud::delete_record_atomic` |
| `replace_all_records` | yes | `db_atomic_crud::replace_all_records_atomic` |

The document lists every allowed `UpdateWatchRecord` field and explicitly rejects `id`, `createdAt`, `updatedAt`, `rev`, `revActor`, unknown fields, invalid scalar shapes, and non-finite frontend numbers. It describes the exact insert/update/delete/replace transaction members, generation/revision/Tombstone meanings, rollback and retry behavior, and the SQLite/WebDAV boundary.

It also explicitly records capabilities that do **not** exist: no public commitId, expected-generation compare-and-swap, stale-snapshot error, persistent outbox, exactly-once delivery, or distributed SQLite/WebDAV transaction. Thus it does not revive obsolete IPC or claim roadmap behavior as implemented.

## CI review

The workflow uses official current major actions verified from their upstream repositories on 2026-07-29:

- `actions/checkout@v6`
- `actions/setup-node@v6` with Node 24 and npm cache
- `actions/upload-artifact@v7` with `if-no-files-found: error`

Jobs are separated as follows:

- Ubuntu frontend: locked install, Playwright Chromium installation, typecheck, lint, Node tests, build, and Playwright.
- Windows Rust: rustfmt, strict locked Clippy, and locked tests.
- Windows bundle: depends on both previous jobs, performs locked install and `npm run tauri build`, then requires `app.exe`, MSI, and NSIS files before upload.

`npx --yes yaml-lint .github/workflows/ci.yml` exited 0. All workflow commands were also executed locally where applicable. The workflow has not been pushed, so no GitHub-hosted run is claimed; the first remote CI run remains observable only after a future authorized push.

## Independent command results

| Command | Result |
| --- | --- |
| `npm ci` | exit 0; 260 packages; existing audit inventory 1 low and 3 high |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test` | exit 0; Node 14/14 |
| `npm run build` | exit 0; 606 modules |
| `npx playwright test` | exit 0; Chromium 3/3 |
| `cargo fmt -- --check` | exit 0 |
| `cargo clippy --all-targets --all-features --locked -- -D warnings` | exit 0 |
| `cargo test --locked` | exit 0; Rust 29/29 |
| `npx --yes yaml-lint .github/workflows/ci.yml` | exit 0 |

The localized Windows linker import-library message remains informational stdout during `cargo test`; strict Clippy exited 0.

## Artifact governance

`git ls-files playwright-report test-results dist-build dist src-tauri/target WatchTracker-Portable.exe` returned no paths in the verification commit.

`git check-ignore -v` proved rules for:

- `playwright-report/`
- `test-results/`
- `blob-report/`
- `dist/`
- `dist-build/`
- `src-tauri/target/`
- root `WatchTracker-Portable.exe`
- root `*.msi`
- root `*-setup.exe`

Playwright outputs remain under the system temporary directory. Existing root/history/architecture documents were audited and preserved; none was deleted merely because it was old.

## Data and process boundary

- No desktop application or database command was run.
- No listener remained on Playwright port 4177 and no A-008-related Node/Cargo/app process remained after verification.
- The active AppData, portable, and public-release database size/mtime/SHA-256 tuples remained equal to the accepted A-007 references; no disk-content change was detected.
- Both implementation and verification worktrees were clean at their completed checkpoints.

## Final conclusion

The README and atomic API guide now match the accepted implementation, the CI definition contains real mandatory jobs without skipped-success claims, and tracked local build/test artifacts have been removed with precise ignore coverage. `TASK-A-008` is accepted. This does not open or accept A-009 and does not claim a remote CI run before push.
