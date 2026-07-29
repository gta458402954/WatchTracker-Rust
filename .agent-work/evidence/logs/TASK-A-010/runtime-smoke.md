# TASK-A-010 runtime smoke

- Runtime root: `D:\Project\Projects\WatchTracker-A010-Runtime-20260730`
- Executable under test: the A-010 Release `app.exe` copied separately into `empty`, `current`, and `upgrade` directories.
- Launch method: exact-path `Start-Process`, followed by PID and `ExecutablePath` verification before Computer Use interaction.
- Empty fixture: PASS; main window rendered with zero records and no startup error.
- Current fixture: PASS; two seed records loaded. A third isolated record was created, renamed, reclassified from movie to series, retained after restart, deleted after user confirmation, and remained absent after a second restart.
- Offline use: PASS; startup and local CRUD succeeded without TMDB or WebDAV credentials.
- Upgrade fixture: PASS; the v12-marker/current-schema fixture loaded both records and migrated to database version 18.
- Final SQLite facts: empty `0` records, current `2`, upgrade `2`; all three databases report `db_version=18`; `category` and `sortOrder` are absent after migration.
- Final related process count: `0`.
- Screenshots: `01-empty-startup.jpg` through `08-upgrade-startup.jpg`.
- Application logs: `runtime-empty-app.log`, `runtime-current-app.log`, and `runtime-upgrade-app.log`.

The runtime databases are synthetic copies or newly generated files under the task-specific runtime root. No real user database was used by these executables.
