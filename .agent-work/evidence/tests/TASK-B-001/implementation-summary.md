# TASK-B-001 Implementation evidence

- Date: 2026-08-01
- Base: protected `main@d7b5f2cd7ceca95f26e000115d9d3bceac463cc8`
- Branch: `codex/task-b-001`
- Pass: Codex Implementation Pass; this document does not assert acceptance.

## Requirement-to-test mapping

| Requirement | Node test coverage |
|---|---|
| FR-01 normalization | trim/case/two comma forms/dedup/fallback code; placeholders and malformed values; `UK -> GB`; CN/HK/TW and legacy labels |
| FR-02 source/display | origin priority; legacy-label fallback; explicit unknown sentinel; unmapped code display; legacy fixed-button compatibility wrapper |
| FR-04 aggregation/order | per-record dedup and multi-country counts; exact preferred order/count/unknown-last; final code tie-break |

## Commands and outcomes

| Command | Outcome |
|---|---|
| `npm ci` | PASS; 267 packages installed; audit 0 vulnerabilities |
| `node --test src/shared/lib/__tests__/classification.test.mjs` | PASS; 12/12 |
| `npm run test` | PASS; 26/26 total |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS; Vite 8.2.0; 607 modules |
| `npx playwright test` | PASS; 3/3 baseline scenarios |

## Scope review

- Business files are limited to `countryNames.ts`, `classification.ts` and `classification.test.mjs`.
- The preserved recovery prototype was inspected but not copied wholesale.
- `regionCodesOf` owns all ISO/unknown extraction. Legacy `regionsOf` delegates to it and contains no second parser.
- No dependency, lockfile, database, schema, UI wiring, TMDB, import/export, WebDAV or DEFERRED behavior changed.
