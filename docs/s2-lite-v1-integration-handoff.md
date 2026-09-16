# WatchTracker S2 Lite v1 Integration Handoff

## Approved checkpoints

| Phase | Full commit SHA |
| --- | --- |
| Phase 0 — Protocol foundation | `6d68d5fd0e4f4a72b27f01e270d5b4ddad9222fa` |
| Phase 1 — Causal reducer | `435c98cb083397d8adce4da23865ca5a5c8782a5` |
| Phase 2 — Immutable publish | `773450ef61f237f3650b9cc9c8dccad28ae51244` |
| Phase 3A/3B — Discovery and audit | `98bfe12496070f0d0909c52298c4548861a17c06` |
| Phase 3C — Activation and cutover | `2e0545bc854e54ef59fc48e458a121741c7e63f1` |
| Phase 3D — Migration orchestration | `1d75ba5e2b524a7bedb8cc3d1d710e3ff9c287b8` |

The Phase 3D SHA is the approved S2 Lite v1 core protocol checkpoint and the exact base of `feat/s2-lite-v1-integration`.

## Frozen protocol surfaces

The cross-language contract root is `contracts/s2-lite/v1/`, containing:

- `activation-cutover-golden-v1.json`
- `causal-golden-v1.json`
- `conflict-golden-v1.json`
- `discovery-golden-v1.json`
- `float-roundtrip-conflict-v1.jcs`
- `jcs-oracle-v1.json`
- `migration-golden-v1.json`
- `ordinary-mutation-semantic-golden-v1.json`
- `publish-golden-v1.json`
- `raw-wire-json-v1.json`

The TypeScript protocol implementation is under `src/features/sync/s2lite/`. The Rust protocol implementation is under `src-tauri/src/s2_lite/`.

The frozen v1 surface includes semantic profiles and scalar/JCS rules; the ordinary-mutation producer profile in `docs/s2-lite-v1-ordinary-mutation-semantic-profile.md`; entity, conflict, commit, reducer, and materialization semantics; bootstrap ordering; immutable exact-byte publishing and recovery; discovery, audit, and fork behavior; activation and legacy cutover; migration orchestration; root safety authority; and frozen-root/new-root handoff behavior. Any protocol-visible semantic change requires an explicit protocol version and protocol review. Integration work must not reinterpret these rules.

## Integration work still required

- Production durable persistence for protocol state, intents, receipts, discovery progress, cutover, migration, and root authority.
- Production WebDAV adapter with exact-byte operations and fail-closed capability/error mapping.
- Desktop sync lifecycle integration.
- Startup and crash-recovery wiring.
- Migration orchestration wiring.
- Diagnostics and conflict surfaces.
- Android/Kotlin implementation with the same frozen contracts.
- Real Jianguoyun interoperability and failure-injection tests.

## Non-negotiable safety boundaries

- Never use an unconditional overwrite as a publication or recovery shortcut.
- Publish immutable objects only through the frozen `PreparedIntent` and exact-byte verification path.
- Keep all durable authority, cutover, fatal, and migration operations bound to the physical root.
- Preserve fatal and freeze state monotonically; stale state cannot make a root safer.
- Permanently disable legacy PUT after activation has been observed.
- Never select a winner among concurrent activations.
- Never repair or resume mutation publishing on an old root after `ROOT_FROZEN`; use the frozen new-root handoff.
- Do not bypass `PreparedIntent`, cutover `Ready`, root execution capabilities, or exclusive publish admission in adapters or lifecycle wiring.

If integration exposes an implementation bug, fix the integration. If an adapter cannot preserve a required capability, fail closed or adapt the transport. If the frozen rules themselves are contradictory, stop and label the issue `PROTOCOL_FREEZE_BLOCKER` rather than changing protocol behavior inside an integration change.
