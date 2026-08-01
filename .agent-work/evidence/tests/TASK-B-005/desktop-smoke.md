# TASK-B-005 isolated desktop smoke

Date: 2026-08-01

Source EXE: `D:\Project\Projects\WatchTracker-B005\src-tauri\target\release\app.exe`

Portable copy: `D:\Project\Projects\WatchTracker-B005-Smoke\WatchTracker-B005.exe`

Isolated data root: `D:\Project\Projects\WatchTracker-B005-Smoke\data`

## Boundary and result

1. Confirmed the smoke directory did not exist, then created it and an empty adjacent `data/`.
2. Copied the EXE built by this task; no installer was executed.
3. Confirmed no process was using the copied EXE before launch.
4. Launched the copied EXE and observed a zero-record empty startup.
5. Added `法国测试影片` with content tag `法国` and no credentials or external metadata lookup.
6. Observed the immediate dynamic option `法国 1`, activated it, and confirmed the matching record remained visible.
7. Closed the app with Alt+F4 and confirmed no process remained for the copied EXE.

The isolated run created only:

- `data/watchtracker.db` (32,768 bytes)
- `data/app.log` (476 bytes at postflight)
- empty application-managed `data/backups/` and `data/posters/` directories

No real user database or user data directory was opened, enumerated, copied or hashed. No real credential was read. No TMDB or WebDAV endpoint was contacted, so this evidence claims only local real-window/database-boundary behavior, not external-service integration.

## Screenshots

- `01-empty-startup.jpg`: newly isolated empty database startup.
- `02-region-option-created.jpg`: saved record and immediate `法国 1` dynamic option.
- `03-france-filter-active.jpg`: France filter active with the matching record still visible.
