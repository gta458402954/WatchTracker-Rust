# TASK-B-004 Codex review

- Date: 2026-08-01
- Reviewed implementation: `c07b985`
- Verification worktree: `D:\Project\Projects\WatchTracker-B004-Verify` (detached, clean)
- Verdict: `ACCEPTED`

## Scope review

- The implementation descends from canonical integration contract `9255c8f` and accepted B-003.
- Product behavior was already covered by B-001~B-003; B-004 changed no production file.
- The only executable change extends canonical `tests/regions.spec.ts` with option-set invariance checks for search, sorting, lock cycling and active-region selection.
- No duplicate `tests/region.spec.ts`, mock-fixture change, dependency change or quarantined-line content was introduced.
- `matrix.md` maps every REQUEST 7.2/7.3 item to a committed test and correctly treats rating as a sortable record field, not a nonexistent filter.

## Independent verification

The first attempt ran Node 36/36 but stopped before Playwright because dependency installation had accidentally occurred in the main worktree instead of the detached verification worktree. This was a verification orchestration error, not a product result. After `npm ci` was run in the correct directory, the fixed sequence restarted from the beginning.

| Check | Result |
|---|---|
| `npm ci` in verification worktree | PASS; 267 packages, audit 0 |
| `npm run test` | PASS; 36/36 |
| `npx playwright test` | PASS; 16/16 |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS; 608 modules |
| `git diff --check` | PASS |
| residual process / port 4177 | PASS; 0 / 0 |
| verification worktree | clean detached HEAD |

## Acceptance disposition

- AC-B-003: PASS.
- AC-B-004: PASS.
- AC-B-007: PASS.
- TASK-B-004: ACCEPTED.
- B-005 full regression, Rust checks, real isolated desktop/data verification, region report and Gate B remain outside this review.
