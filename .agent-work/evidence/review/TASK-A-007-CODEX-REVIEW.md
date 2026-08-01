# TASK-A-007 Codex Independent Review

## Decision

- Task: `TASK-A-007`
- Result: `ACCEPTED`
- Documentation BASE: `2e7756710c24b456759049b10263ff4bb9726dd0`
- Task authorization commits: `77f9c24`, `e80b0ad`
- Implementation commit: `8412d4f`
- Implementation worktree: `D:\Project\Projects\WatchTracker-A007`
- Independent verification worktree: `D:\Project\Projects\WatchTracker-A007-Verify` (detached at `8412d4f`)

## Scope review

The implementation commit contains exactly seven authorized files:

- `package.json` and `package-lock.json`: add `typecheck`, Node-native `test`, Playwright `test:e2e`, and `@playwright/test` 1.62.0.
- `playwright.config.ts`: isolated port 4177, one Chromium worker, no retries/`only`, list reporter, and output under the system temporary directory.
- `tests/fixtures/mockIpc.ts`: strict current Tauri IPC mock. Known commands validate their exact argument keys; unknown commands fail instead of returning a permissive value.
- `tests/baseline.spec.ts`: normal empty state, persistent initialization failure/error/retry, and create/update/delete against current IPC DTOs.
- `src-tauri/src/auth.rs` and `src-tauri/src/error.rs`: rustfmt-only removal of trailing whitespace. Their executable logic and error text are unchanged.

No application UI behavior, database schema, migration, runtime path, credential behavior, WebDAV behavior, or user data was modified.

## REQUEST 7.1 mapping

| # | Required scenario | Direct automated evidence |
| ---: | --- | --- |
| 1 | Reject system fields | `update_payload_rejects_unknown_system_and_invalid_value_types` rejects `id`, `createdAt`, `updatedAt`, `rev`, `revActor`, and unknown fields. |
| 2 | Empty update has no side effects | `empty_update_is_rejected_without_side_effects` asserts record state, Tombstone, and generation remain unchanged. |
| 3 | Reject invalid numbers/arrays/objects/unknown fields | The Rust payload test rejects arrays, objects, strings, and unknown fields; Node `rejects every non-finite numeric update` covers NaN and both infinities. |
| 4 | Rust owns `updatedAt` | System-field deserialization rejects frontend `updatedAt`; `update_uses_rust_time_and_commits_record_tombstone_and_generation_together` asserts the persisted transaction time changes. |
| 5 | SQL/setting failure fully rolls back | `record_sql_failure_leaves_all_atomic_state_unchanged` and `setting_failure_rolls_back_record_tombstone_and_generation` assert record, Tombstone, generation, and setting state. |
| 6 | Missing record preserves Tombstone | `missing_record_preserves_existing_tombstone_and_generation`. |
| 7 | Migration rollback/retry | `migration_version_write_failure_rolls_back_schema_and_can_retry`, `v17_migration_is_atomic_and_retryable`, and `v18_migration_is_atomic_and_retryable`; A-003/A-006 also cover empty/current/v12 paths. |
| 8 | Missing setting differs from query failure | `get_setting_only_maps_missing_rows_to_none`; file-database settings reopen is covered by `settings_round_trip_survives_reopen_on_file_database`. |
| 9 | Initialization failure is not an empty list and can retry | Node initialization propagation/retry tests plus Playwright `initialization failure shows an error, not empty data, and retry recovers`. The fixture remains failed across React development double effects until the test explicitly releases it. |
| 10 | Unified database/log/poster/backup/protocol paths | Eight `app_paths::tests::*` assertions plus the accepted A-004 debug/release real-runtime evidence. |

## Independent command results

All commands were rerun from the detached verification worktree.

| Command | Result |
| --- | --- |
| `npm ci` | exit 0; 260 packages; existing audit inventory 1 low and 3 high |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test` | exit 0; Node 14/14 passed |
| `npm run build` | exit 0; Vite transformed 606 modules |
| `npx playwright test` | exit 0; Chromium 3/3 passed |
| `cargo fmt -- --check` | exit 0 |
| `cargo clippy --all-targets --all-features --locked -- -D warnings` | exit 0 |
| `cargo test --locked` | exit 0; Rust 29/29 passed |

The first implementation-worktree Playwright attempt passed 2/3 and exposed a fixture issue: React development mode invoked initialization twice, consuming a one-shot failure before the assertion. The mock was corrected to maintain the injected failure until the test explicitly releases it. The subsequent implementation run and the clean independent run both passed 3/3. No product code was changed in response.

`cargo test` emitted the already-observed localized Windows linker stdout notice about creating import-library files. Strict Clippy with `-D warnings` exited 0, and no lint level was relaxed.

## Process, data, and artifact boundary

- Playwright used `127.0.0.1:4177` with `reuseExistingServer: false`; after verification there was no listener on port 4177.
- Playwright output was routed to `%TEMP%\watchtracker-playwright-a007`, so no `playwright-report/` or `test-results/` directory entered either worktree.
- Both implementation and verification worktrees were clean after their respective phases.
- Relevant residual process count was zero.
- Rust tests used in-memory or dedicated temporary databases. No WatchTracker desktop application was launched.
- Final active user database size/mtime/SHA-256 tuples remained equal to their accepted references; no disk-content change was detected:
  - AppData: 622,592 bytes; `BF96F204F9B73E2C30CE6C6DFCFA5F1D2FA9C5D1BB89D3BF245797B716893CF7`
  - Portable: 1,277,952 bytes; `52E6B56CF062CFF35902ABF859AEC0A065C6CBBD6D73AE8200F1C811BCAA6B80`
  - Public release: 36,864 bytes; `D466C6649851DF8023E79FD595B180B066266F2FD153BFEF8CAAAE11F0EC82DE`

## Acceptance conclusions

- `AC-A-005` through `AC-A-010`: regression matrix present and passing; the underlying feature acceptances remain supported by their earlier independent real-runtime evidence.
- `AC-A-013`: PASS. The required frontend scripts now exist and typecheck, lint, Node tests, build, and Playwright all exit 0.
- `AC-A-014`: PASS. Format check, strict Clippy, and Rust tests all exit 0; the inherited rustfmt debt is closed.
- `TASK-A-007`: ACCEPTED.

This result does not open or accept `TASK-A-008`, and does not replace the real desktop smoke layer already recorded for A-004 through A-006.
