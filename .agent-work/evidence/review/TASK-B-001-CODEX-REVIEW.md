# TASK-B-001 Codex review

- Date: 2026-08-01
- Authorization base: `d7b5f2cd7ceca95f26e000115d9d3bceac463cc8`
- Reviewed implementation: `b70aa24`
- Verification worktree: `D:\Project\Projects\WatchTracker-B001-Verify` (detached, clean committed HEAD)
- Verdict: `ACCEPTED`

## Scope and design review

- Added `countryNames.ts`, updated `classification.ts`, and added `classification.test.mjs`; no unauthorized business file changed.
- `regionCodesOf` is the sole ISO/unknown extraction path. Legacy `regionsOf` delegates to it and only maps recognized codes back to the existing fixed Chinese buttons.
- Alias mapping runs before generic two-letter validation, so `UK` becomes `GB`; placeholders cannot leak into region options.
- The unknown sentinel is not a valid ISO alpha-2 value. Unmapped valid codes remain visible as uppercase codes.
- Aggregation deduplicates within each record, allows one record to contribute to multiple countries, honors `CN,HK,TW,US,JP,KR,GB`, then count/name/code, and places unknown last.
- The archived recovery implementation was selectively migrated and corrected rather than copied wholesale.

## Independent commands

| Command | Result |
|---|---|
| `npm ci` | PASS; audit 0 |
| `node --test src/shared/lib/__tests__/classification.test.mjs` | PASS; 12/12 |
| `npm run test` | PASS; 26/26 |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS; 607 modules |
| `npx playwright test` | PASS; 3/3 |
| corrected read-only boundary command | PASS; 3/3 |

An earlier form of the last command failed during JavaScript parsing because its JSON string was incorrectly escaped through PowerShell. It did not run application code or modify files; the corrected equivalent command is the result used above.

## Acceptance disposition

- AC-B-001: PASS.
- AC-B-002: B-001 domain names/unmapped/unknown portion verified; UI evidence remains for B-002/B-004, so the overall criterion is not marked PASS yet.
- AC-B-004: B-001 aggregation and stable-order portion verified; combined-filter and region E2E evidence remain for B-002/B-004, so the overall criterion is not marked PASS yet.
- TASK-B-001: ACCEPTED. This does not authorize TASK-B-002, TASK-B-003, TASK-B-004, TASK-B-005 or DEFERRED work.
