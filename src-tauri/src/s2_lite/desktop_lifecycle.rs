//! Desktop ordering layer for one root-bound S2 Lite sync execution.
//!
//! This module deliberately delegates protocol meaning to the frozen publish,
//! discovery, and durable-store components. It owns only process-local
//! scheduling, target binding, and the order in which those components run.

use std::sync::Mutex;

use rusqlite::Connection;

use super::business_projection::apply_complete_projection_v1;
use super::canonical::Result;
use super::durable_persistence::{
    DesktopRootStateV1, DurableMaterializedProjectionV1, OrdinaryPublishExclusiveResultV1,
    SqliteS2LiteStoreV1,
};
use super::immutable_publish::{
    persist_prepared_intent_before_publish_v1, publish_persisted_intent_v1,
    ImmutableObjectRemoteV1, PreparedIntentV1, RecoverPreparedIntentResultV1,
};
use super::materialized_projection::{
    rebuild_materialized_projection_v1, MaterializedProjectionStatusV1,
};
use super::migration_orchestration::MigrationStateStoreV1;
use super::remote_discovery::{
    create_discovery_state_v1, run_discovery_round_v1, validate_production_activation_body_v1,
    DiscoveryBudgetsV1, DiscoveryRemoteV1,
};
use super::root_coordinator::RootExecutionCoordinatorV1;
use super::{
    activation_cutover::{recover_activation_cutover_v1, ActivationFingerprintConsistencyV1},
    canonical::ProtocolError,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesktopS2RootBindingV1 {
    pub target_id: String,
    pub target_epoch: u64,
    pub physical_root_id: String,
    pub canonical_url: String,
    pub account: String,
    pub remote_identity: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesktopS2LifecycleResultV1 {
    SuccessSynced,
    SuccessNoOp,
    PendingRemoteIndeterminate,
    RemoteAuthOrCapabilityBlocked,
    PendingDiscoveryDependencies,
    ActiveWithConflicts,
    RootFrozen,
    LocalDurableCorruption,
    TargetChanged,
    CancelledAtSafeBoundary,
    InternalFailure,
}

fn map_publish_result(result: RecoverPreparedIntentResultV1) -> DesktopS2LifecycleResultV1 {
    match result {
        RecoverPreparedIntentResultV1::AlreadyPublishedExact(_) => {
            DesktopS2LifecycleResultV1::SuccessSynced
        }
        RecoverPreparedIntentResultV1::RetryPublishExact
        | RecoverPreparedIntentResultV1::RemoteIndeterminate => {
            DesktopS2LifecycleResultV1::PendingRemoteIndeterminate
        }
        RecoverPreparedIntentResultV1::AuthOrCapabilityFailure => {
            DesktopS2LifecycleResultV1::RemoteAuthOrCapabilityBlocked
        }
        RecoverPreparedIntentResultV1::CorruptionMismatch(_) => {
            DesktopS2LifecycleResultV1::RootFrozen
        }
    }
}

fn recover_discovered_activation_cutover_v1(
    store: &mut SqliteS2LiteStoreV1<'_>,
    root_id: &str,
    discovery: &super::remote_discovery::DiscoveryStateV1,
) -> Result<bool> {
    let safety = MigrationStateStoreV1::load_root_safety(store, root_id)?;
    let recovery = recover_activation_cutover_v1(discovery, Some(&safety.cutover_state));
    let cutover = recovery
        .diagnostic_state()
        .ok_or(ProtocolError("activation_cutover_recovery_not_ready"))?;
    // The historical migration binding, rather than mutable business rows or
    // current target state, is the only local fingerprint authority.
    if let Some(binding) = store.load_migration_execution_binding_v1()? {
        if cutover.remote_s2_activated {
            let compatible = matches!(
                &cutover.fingerprint_consistency,
                ActivationFingerprintConsistencyV1::Consistent { legacy_fingerprint }
                    if *legacy_fingerprint == binding.legacy_fingerprint
            );
            if !compatible {
                MigrationStateStoreV1::persist_cutover_state(store, root_id, &cutover)?;
                let _ = MigrationStateStoreV1::persist_root_fatal(
                    store,
                    root_id,
                    "SYNC_ROOT_FROZEN_LEGACY_CHANGE",
                )?;
                return Ok(true);
            }
        }
    }
    MigrationStateStoreV1::persist_cutover_state(store, root_id, &cutover)?;
    Ok(!MigrationStateStoreV1::load_root_safety(store, root_id)?
        .root_fatal_signals
        .is_empty())
}

/// Runs one bounded execution. `new_ordinary_intent` is optional because this
/// layer does not create protocol bytes itself; an upstream local mutation
/// pipeline may supply one already-prepared frozen intent. Existing durable
/// intents are always recovered before that optional successor is admitted.
#[allow(clippy::too_many_arguments)] // Explicit collaborators make authority boundaries visible.
pub fn run_desktop_s2_sync_execution_v1<R, E, C>(
    conn: &Mutex<Connection>,
    coordinator: &RootExecutionCoordinatorV1,
    binding: &DesktopS2RootBindingV1,
    remote: &mut R,
    target_epoch_is_current: E,
    cancel_at_safe_boundary: C,
    new_ordinary_intent: Option<PreparedIntentV1>,
    budgets: &DiscoveryBudgetsV1,
    verified_at_diagnostic: &str,
) -> Result<DesktopS2LifecycleResultV1>
where
    R: ImmutableObjectRemoteV1 + DiscoveryRemoteV1,
    E: Fn() -> bool,
    C: Fn() -> bool,
{
    if !target_epoch_is_current() {
        return Ok(DesktopS2LifecycleResultV1::TargetChanged);
    }
    if remote.physical_root_id() != Some(binding.physical_root_id.as_str())
        || remote.execution_context_identity() != binding.remote_identity
    {
        return Ok(DesktopS2LifecycleResultV1::InternalFailure);
    }
    let _guard = coordinator.acquire_blocking(&binding.physical_root_id)?;
    if !target_epoch_is_current() {
        return Ok(DesktopS2LifecycleResultV1::TargetChanged);
    }
    if cancel_at_safe_boundary() {
        return Ok(DesktopS2LifecycleResultV1::CancelledAtSafeBoundary);
    }

    let mut store = SqliteS2LiteStoreV1::open(conn, &binding.physical_root_id)?;
    if store.load_desktop_root_state()?.is_none() {
        store.persist_desktop_root_state(&DesktopRootStateV1 {
            state_version: 1,
            physical_root_id: binding.physical_root_id.clone(),
            local_writer_id: uuid::Uuid::new_v4().to_string(),
            next_writer_sequence: 1,
            writer_head: None,
            lifecycle_generation: 0,
            materialized_projection_generation: None,
            business_applied_projection_generation: None,
        })?;
    }
    let safety = MigrationStateStoreV1::load_root_safety(&mut store, &binding.physical_root_id)?;
    let root_frozen = !safety.root_fatal_signals.is_empty();

    // The expected CAS generation belongs to the exact state used to run the
    // network round. Re-reading after I/O would incorrectly permit replacing
    // a newer observation made by another execution.
    let persisted_discovery = store.load_discovery_state()?;
    let expected_discovery_generation = persisted_discovery
        .as_ref()
        .map(|value| value.storage_generation);
    let prior = persisted_discovery
        .map(|value| value.state)
        .unwrap_or_else(create_discovery_state_v1);
    let next = run_discovery_round_v1(
        &prior,
        remote,
        &mut validate_production_activation_body_v1,
        budgets,
    )?;
    if !store.compare_and_swap_discovery_state(expected_discovery_generation, &next)? {
        return Ok(DesktopS2LifecycleResultV1::PendingDiscoveryDependencies);
    }
    let committed_discovery = store
        .load_discovery_state()?
        .ok_or(ProtocolError("discovery_state_missing_after_cas"))?;
    let cutover_frozen = recover_discovered_activation_cutover_v1(
        &mut store,
        &binding.physical_root_id,
        &committed_discovery.state,
    )?;
    let safety = MigrationStateStoreV1::load_root_safety(&mut store, &binding.physical_root_id)?;
    if root_frozen || cutover_frozen || !safety.root_fatal_signals.is_empty() {
        return Ok(DesktopS2LifecycleResultV1::RootFrozen);
    }
    // A receipt may have survived a process crash after remote verification
    // and before local bookkeeping. This has no remote collaborator and is
    // safe to run before considering any pending recovery or successor work.
    let _ = store.complete_verified_outbound_batch()?;
    if next.last_round_indeterminate {
        return Ok(DesktopS2LifecycleResultV1::PendingDiscoveryDependencies);
    }
    // Rebuild only from the just-committed exact verified facts. The cache is
    // CAS-bound to both discovery and root safety, so an older complete replay
    // cannot leak into a newer publication attempt.
    let replay = rebuild_materialized_projection_v1(&committed_discovery.state)?;
    let expected_projection = store
        .load_materialized_projection()?
        .map(|value| value.projection_generation);
    let projection_generation = expected_projection.map_or(0, |value| value + 1);
    let projection = DurableMaterializedProjectionV1 {
        projection_version: 1,
        physical_root_id: binding.physical_root_id.clone(),
        projection_generation,
        source_discovery_generation: committed_discovery.storage_generation,
        source_root_safety_generation: safety.generation,
        replay_input_fingerprint: replay.replay_input_fingerprint.clone(),
        business_projection_applied_generation: None,
        state: replay,
    };
    if !store.compare_and_swap_materialized_projection(expected_projection, &projection)? {
        return Ok(DesktopS2LifecycleResultV1::PendingDiscoveryDependencies);
    }
    store.update_materialized_projection_generation(projection_generation)?;
    match projection.state.status {
        MaterializedProjectionStatusV1::Complete => {}
        MaterializedProjectionStatusV1::PendingDependencies { .. } => {
            return Ok(DesktopS2LifecycleResultV1::PendingDiscoveryDependencies)
        }
        MaterializedProjectionStatusV1::Fatal { .. } => {
            let _ = MigrationStateStoreV1::persist_root_fatal(
                &mut store,
                &binding.physical_root_id,
                "S2_REPLAY_FATAL",
            )?;
            return Ok(DesktopS2LifecycleResultV1::RootFrozen);
        }
    }
    if apply_complete_projection_v1(&mut store, projection_generation).is_err() {
        return Ok(DesktopS2LifecycleResultV1::InternalFailure);
    }

    // A frozen root may be observed read-only above, but it must never retry a
    // prepared publication. Recovery of an existing intent remains ahead of a
    // successor once the root is known safe.
    for intent in store.list_prepared_unreceipted_intents()? {
        if cancel_at_safe_boundary() {
            return Ok(DesktopS2LifecycleResultV1::CancelledAtSafeBoundary);
        }
        let persisted = persist_prepared_intent_before_publish_v1(&intent, &mut store)?;
        let recovered = match store.run_ordinary_publish_exclusive(
            &binding.physical_root_id,
            &intent,
            || publish_persisted_intent_v1(&persisted, remote, verified_at_diagnostic),
        )? {
            OrdinaryPublishExclusiveResultV1::Executed(value) => value,
            OrdinaryPublishExclusiveResultV1::RejectedRootFrozen => {
                return Ok(DesktopS2LifecycleResultV1::RootFrozen)
            }
        };
        if matches!(
            recovered,
            RecoverPreparedIntentResultV1::AlreadyPublishedExact(_)
        ) {
            let _ =
                store.verify_and_persist_commit_receipt(&intent, remote, verified_at_diagnostic)?;
            let _ = store.complete_verified_outbound_batch()?;
        }
        let mapped = map_publish_result(recovered);
        if mapped != DesktopS2LifecycleResultV1::SuccessSynced {
            return Ok(mapped);
        }
    }
    if new_ordinary_intent.is_none() {
        return Ok(DesktopS2LifecycleResultV1::SuccessNoOp);
    }
    if !target_epoch_is_current() {
        return Ok(DesktopS2LifecycleResultV1::TargetChanged);
    }
    if cancel_at_safe_boundary() {
        return Ok(DesktopS2LifecycleResultV1::CancelledAtSafeBoundary);
    }
    let intent = new_ordinary_intent.expect("checked above");
    let persisted = persist_prepared_intent_before_publish_v1(&intent, &mut store)?;
    let result =
        match store.run_ordinary_publish_exclusive(&binding.physical_root_id, &intent, || {
            publish_persisted_intent_v1(&persisted, remote, verified_at_diagnostic)
        })? {
            OrdinaryPublishExclusiveResultV1::Executed(value) => value,
            OrdinaryPublishExclusiveResultV1::RejectedRootFrozen => {
                return Ok(DesktopS2LifecycleResultV1::RootFrozen)
            }
        };
    if matches!(
        result,
        RecoverPreparedIntentResultV1::AlreadyPublishedExact(_)
    ) {
        let _ = store.verify_and_persist_commit_receipt(&intent, remote, verified_at_diagnostic)?;
        let _ = store.complete_verified_outbound_batch()?;
    }
    Ok(map_publish_result(result))
}
