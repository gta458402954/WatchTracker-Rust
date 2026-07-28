# TASK-A-004 Codex Review

- Task: `TASK-A-004`
- Decision commit: `7dc443fd83d64aa8417226d75d2159b864003338`
- Implementation commit: `3f5a73cd06548cc5b5cfcd95f6e2c9eaca6ffc63`
- Execution worktree: `D:\Project\Projects\WatchTracker-A004`
- Independent verification worktree: `D:\Project\Projects\WatchTracker-A004-Verify`
- Result: `ACCEPTED`

## Product decision and scope

The user selected CONFIRM-001 rule 1 on 2026-07-29: portable mode is enabled only when a `data/` directory already exists beside the executable; otherwise WatchTracker uses Windows app-data. The implementation does not create an executable-adjacent `data/` merely to enable portable mode.

The implementation commit contains exactly six authorized files: the new path module, four Rust consumers and README. It does not change dependencies, lock files, database schema, Tauri configuration, WebDAV behavior, credentials, frontend behavior or user data.

## Path contract

- Startup resolves one `AppPaths` value and manages it as application state.
- Database, log, posters and backups derive from the same root.
- Poster download and `poster://` use the same poster path resolver.
- A pre-existing adjacent `data/` directory selects portable mode.
- A missing adjacent `data/` directory selects app-data without creating the portable directory.
- A conflicting `data` file, unusable selected root or invalid child path produces a diagnostic startup error rather than silently selecting another database.
- `poster://` accepts one normal file name and rejects empty, absolute, nested and parent-traversal paths.

## Automated verification

Accepted Runner session: `83253ee8-0459-4b46-af85-ea3458255f74`.

- npm locked install: exit 0.
- TypeScript typecheck: exit 0.
- ESLint: exit 0.
- Vite production build: exit 0.
- Rust: 21 passed, 0 failed, including 8 path tests.
- Strict Clippy: exit 0.
- Tauri release build: exit 0.
- Formatting delta: no new diagnostic file; only inherited untouched `auth.rs` and `error.rs` remain in the full check.

The eight path tests directly cover portable selection, app-data fallback, unavailable executable resolution, a conflicting portable path, an invalid app-data root, invalid child directories, simulated non-writable portable storage without fallback, poster fixture write/read and traversal rejection.

## Isolated runtime verification

Before each launch, the corresponding target-adjacent `data/` directory was created explicitly, matching rule 1.

- Debug `app.exe`, PID 18236: generated `target/debug/data/watchtracker.db` (32,768 bytes), `app.log`, `posters/` and `backups/`.
- Release `app.exe`, PID 25320: generated `target/release/data/watchtracker.db` (32,768 bytes), `app.log`, `posters/` and `backups/`.

Both application logs identify portable mode and list the same root-derived database, poster and backup paths. Each process identity was checked by executable path before termination; no related process remained.

The AppData, portable-release and public-release user database size, mtime and SHA-256 tuples matched before and after. This establishes that no disk-content change was detected; it does not claim that external processes never opened those files.

## Independent review

From the detached verification worktree, locked dependency installation, typecheck, lint, frontend build, all 21 Rust tests and strict Clippy passed. The Safe Commit trailer and receipt passed attestation verification, and the commit file set matches the six authorized paths.
