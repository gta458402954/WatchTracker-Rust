# Residual hardening review

- Date: 2026-08-01
- Branch: `codex/residual-hardening`
- Base: `39e8faa`
- Scope: close the explicit residuals recorded after Gate A without starting Phase B or DEFERRED work.

## Resolved locally

- Ran `npm audit fix --package-lock-only`; `package.json` and its declared ranges were unchanged.
- A fresh `npm ci` followed by `npm audit` reports `0 vulnerabilities` (previously 1 low and 3 high).
- Updated the Vite ESM config to derive the project root from `import.meta.url`; Vite 8.2.0 no longer warns that `__dirname` is incompatible with the planned native config loader.
- Cleared the content-identical `src-tauri/Cargo.toml` stat/EOL worktree noise with `git update-index --refresh`. The worktree and HEAD blob IDs both remained `abfc222ba249ee1cd6f6aab4fe551d60fbd8c467`; the file was not rewritten or staged.

## Verification

| Command | Result |
|---|---|
| `npm ci` | PASS |
| `npm audit` | PASS, 0 vulnerabilities |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS, 14/14 |
| `npm run build` | PASS, 606 modules; no Vite config-loader warning |
| `npx playwright test` | PASS, 3/3 |
| `cargo fmt -- --check` | PASS |
| `cargo clippy --all-targets --all-features --locked -- -D warnings` | PASS |
| `cargo test --locked` | PASS, 29/29 |
| `npm run tauri build` (two consecutive runs) | PASS twice; EXE/MSI/NSIS produced both times |

## Controlled build comparison

| Artifact | Run 1 length / SHA-256 | Run 2 length / SHA-256 |
|---|---|---|
| Release EXE | 15,352,320 / `7E2E8C1BEDFE6B63128B8A04BECD0945E9F32BF7F3F005D0139A97BFF28B25F6` | 15,352,320 / `FE971E97273A9219A1EF1A77EAAA3F8EEBE60CE4653899E1BF79F1051BBCEA12` |
| MSI | 5,693,440 / `9F3982430C0C87F7B0E3B1AB6AD1380C05F8E303A23D2BB4506079AF639304F8` | 5,693,440 / `3E492D474D0D3D989B7C9D7B94CCB88C5E2DF416CDBB62D810B4D7FC0660DE00` |
| NSIS | 3,993,883 / `A23827EAC99A719F17889CC7C2BA699B1226028E6903648282555E3CEF7271C8` | 3,993,560 / `BEA0BD7E81E0FE4646FEBD18FA47D05968BB98DCB8E14FCCC56D8BB21B479F36` |

All three second-run artifacts report `NotSigned`. The two builds prove functional repeatability but disprove byte-for-byte reproducibility under the current Windows/Tauri bundle toolchain. No current product requirement promises deterministic installers, so this remains a release-engineering limitation rather than a Gate A regression.

The localized MSVC line `正在创建库 ...` is normal linker stdout surfaced by Rust's `linker_messages` warning. Strict Clippy still exits 0. It was intentionally not hidden by disabling warnings globally.

## External follow-up

- Artifact signing needs an approved code-signing certificate, secret handling and release identity. Those inputs are not present, so no signing configuration was invented.
- The workflow is locally present and all equivalent local gates pass. A GitHub Actions run still requires an authorized push or pull request; none was performed.
- Phase B and DEFERRED remain untouched.
