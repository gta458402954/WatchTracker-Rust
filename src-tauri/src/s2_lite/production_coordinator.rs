//! Rust-only production scheduling boundary for S2 Lite.
//!
//! This module deliberately does not define wire, migration, discovery, or
//! publication semantics.  It reloads the durable lifecycle route between
//! bounded steps and delegates each operation to its approved owner.

use std::sync::Mutex;
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use rusqlite::Connection;

use super::bootstrap_execution::{
    execute_production_activation_with_webdav_v1, execute_production_bootstrap_with_webdav_v1,
    ActivationExecutionResultV1, BootstrapExecutionResultV1,
};
use super::canonical::{ProtocolError, Result};
use super::desktop_lifecycle::{
    route_desktop_sync_v1, run_desktop_s2_sync_execution_v1, DesktopS2LifecycleResultV1,
    DesktopS2RootBindingV1, DesktopSyncRouteV1,
};
use super::durable_persistence::{
    MigrationAdmissionInputV1, MigrationAdmissionResultV1, SqliteS2LiteStoreV1, TargetRootBindingV1,
};
use super::migration_admission::capture_production_legacy_snapshot_v1;
use super::migration_orchestration::MigrationStateStoreV1;
use super::outbound_freeze::{freeze_active_outbound_v1, OutboundFreezeResultV1};
use super::outbound_publish::{
    publish_frozen_outbound_batch_with_webdav_v1, OutboundPublishResultV1,
};
use super::root_coordinator::RootExecutionCoordinatorV1;
use super::target_root_binding::{
    load_historical_target_root_binding_v1, resolve_active_target_root_binding_v1,
};
use super::webdav_adapter::{webdav_root_v1, WebDavRootV1, WebDavS2ConfigV1, WebDavS2RemoteV1};
use super::{immutable_publish::ImmutableObjectRemoteV1, remote_discovery::DiscoveryBudgetsV1};

const COORDINATOR_FAILURE: ProtocolError = ProtocolError("S2_PRODUCTION_COORDINATOR_FAILURE");
const DEFAULT_PHASE_STEP_BUDGET: u8 = 4;
const BOUND_ROUTE_CAPTURE_RETRIES: u8 = 3;

/// Exact durable binding selected with a lifecycle route.  The coordinator
/// never derives a second root: migration routes use their frozen historical
/// binding and ordinary routes use the approved active-binding resolver.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundCoordinatorRouteV1 {
    pub route: DesktopSyncRouteV1,
    pub binding: TargetRootBindingV1,
    pub historical_migration: bool,
    /// Present only when the router atomically completed the historical
    /// migration while capturing this decision.  The route binding remains
    /// the current normal-S2 authority; this field is solely the explicit
    /// handoff needed to reject an A->B continuation in one invocation.
    pub finalized_historical_binding: Option<TargetRootBindingV1>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProductionCoordinatorResultV1 {
    LegacyS1Required,
    Success,
    Pending,
    RemoteIndeterminate,
    RemoteAuthOrCapabilityBlocked,
    Conflicts,
    TargetChanged,
    ReadOnlyFrozen,
    InternalFailure,
}

fn diagnostic_now_v1() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn active_target_v1(conn: &Mutex<Connection>) -> Result<(String, u64)> {
    let guard = conn.lock().map_err(|_| COORDINATOR_FAILURE)?;
    crate::sync_targets::active_target(&guard)
        .map_err(|_| COORDINATOR_FAILURE)?
        .ok_or(COORDINATOR_FAILURE)
}

fn active_epoch_is_current_v1(
    conn: &Mutex<Connection>,
    target_id: &str,
    target_epoch: u64,
) -> bool {
    active_target_v1(conn)
        .map(|current| current.0 == target_id && current.1 == target_epoch)
        .unwrap_or(false)
}

/// Re-routes from SQLite and returns the exact binding which was authoritative
/// before routing.  Capturing a source-owner binding before the router runs is
/// important: the router may atomically finalize and retire that owner.
fn historical_target_binding_v1(
    conn: &Mutex<Connection>,
    execution: &super::durable_persistence::MigrationExecutionBindingV1,
) -> Result<TargetRootBindingV1> {
    let binding =
        load_historical_target_root_binding_v1(conn, &execution.target_id, execution.target_epoch)?
            .ok_or(COORDINATOR_FAILURE)?;
    if binding.physical_root_id != execution.physical_root_id {
        return Err(COORDINATOR_FAILURE);
    }
    Ok(binding)
}

fn binding_is_current_active_v1(conn: &Mutex<Connection>, binding: &TargetRootBindingV1) -> bool {
    active_epoch_is_current_v1(conn, &binding.target_id, binding.target_epoch)
}

fn load_bound_coordinator_route_inner_v1(
    conn: &Mutex<Connection>,
    mut before_route: impl FnMut(),
) -> Result<BoundCoordinatorRouteV1> {
    for _ in 0..BOUND_ROUTE_CAPTURE_RETRIES {
        let before = SqliteS2LiteStoreV1::load_migration_source_execution_binding_v1(conn)?;
        before_route();
        let route = route_desktop_sync_v1(conn)?;
        let after = SqliteS2LiteStoreV1::load_migration_source_execution_binding_v1(conn)?;

        match (before.as_ref(), after.as_ref(), route) {
            // Migration publication/finalization must always use the exact
            // historical binding held by the unchanged source owner.
            (
                Some(before),
                Some(after),
                DesktopSyncRouteV1::ResumeBootstrap | DesktopSyncRouteV1::ResumeActivation,
            ) if before == after => {
                return Ok(BoundCoordinatorRouteV1 {
                    route,
                    binding: historical_target_binding_v1(conn, after)?,
                    historical_migration: true,
                    finalized_historical_binding: None,
                });
            }
            // The router can finalize ActivationVerified and retire the
            // owner in one transaction. Bind EnterNormalS2 to the *current*
            // active authority, retaining A only as handoff evidence.
            (Some(before), None, DesktopSyncRouteV1::EnterNormalS2) => {
                let binding = {
                    let (target_id, target_epoch) = active_target_v1(conn)?;
                    resolve_active_target_root_binding_v1(conn, &target_id, target_epoch)?.binding
                };
                if route_desktop_sync_v1(conn)? == DesktopSyncRouteV1::EnterNormalS2
                    && SqliteS2LiteStoreV1::load_migration_source_execution_binding_v1(conn)?
                        .is_none()
                    && binding_is_current_active_v1(conn, &binding)
                {
                    return Ok(BoundCoordinatorRouteV1 {
                        route,
                        binding,
                        historical_migration: false,
                        finalized_historical_binding: Some(historical_target_binding_v1(
                            conn, before,
                        )?),
                    });
                }
            }
            // No owned migration means this is an active-target route. Route
            // again after resolving the binding, so a route from B can never
            // be returned with A's earlier binding.
            (
                None,
                None,
                DesktopSyncRouteV1::ContinueLegacyS1
                | DesktopSyncRouteV1::EnterNormalS2
                | DesktopSyncRouteV1::ReadOnlyFrozen,
            ) => {
                let binding = {
                    let (target_id, target_epoch) = active_target_v1(conn)?;
                    resolve_active_target_root_binding_v1(conn, &target_id, target_epoch)?.binding
                };
                if route_desktop_sync_v1(conn)? == route
                    && SqliteS2LiteStoreV1::load_migration_source_execution_binding_v1(conn)?
                        .is_none()
                    && binding_is_current_active_v1(conn, &binding)
                {
                    return Ok(BoundCoordinatorRouteV1 {
                        route,
                        binding,
                        historical_migration: false,
                        finalized_historical_binding: None,
                    });
                }
            }
            // A fatal root may be historical even if a phase transition raced
            // us. It is safe only when its source-owner binding is unchanged.
            (Some(before), Some(after), DesktopSyncRouteV1::ReadOnlyFrozen) if before == after => {
                return Ok(BoundCoordinatorRouteV1 {
                    route,
                    binding: historical_target_binding_v1(conn, after)?,
                    historical_migration: true,
                    finalized_historical_binding: None,
                });
            }
            _ => {}
        }
    }
    Err(COORDINATOR_FAILURE)
}

pub fn load_bound_coordinator_route_v1(
    conn: &Mutex<Connection>,
) -> Result<BoundCoordinatorRouteV1> {
    load_bound_coordinator_route_inner_v1(conn, || {})
}

#[cfg(test)]
fn load_bound_coordinator_route_with_before_route_v1(
    conn: &Mutex<Connection>,
    before_route: impl FnMut(),
) -> Result<BoundCoordinatorRouteV1> {
    load_bound_coordinator_route_inner_v1(conn, before_route)
}

/// Rust owns all migration-admission identity values.  4C1 does not call this
/// from `ContinueLegacyS1`; 4C2 will provide the explicit S1 bridge.
pub fn admit_migration_from_production_coordinator_v1(
    conn: &Mutex<Connection>,
) -> Result<MigrationAdmissionResultV1> {
    // This database-wide strict lookup is the retry path. It validates the
    // stored execution/binding before exposing it and deliberately precedes
    // any UUID allocation, including after an active-target switch.
    if let Some(execution_binding) =
        SqliteS2LiteStoreV1::load_migration_source_execution_binding_v1(conn)?
    {
        let mut store = SqliteS2LiteStoreV1::open(conn, &execution_binding.physical_root_id)?;
        let state = MigrationStateStoreV1::load(&mut store, &execution_binding.physical_root_id)?
            .ok_or(COORDINATOR_FAILURE)?;
        if state.migration_id != execution_binding.migration_id {
            return Err(COORDINATOR_FAILURE);
        }
        return Ok(MigrationAdmissionResultV1 {
            execution_binding,
            state,
            attached_existing: true,
        });
    }
    let (target_id, target_epoch) = active_target_v1(conn)?;
    let binding = resolve_active_target_root_binding_v1(conn, &target_id, target_epoch)?.binding;
    let mut store = SqliteS2LiteStoreV1::open(conn, &binding.physical_root_id)?;
    store.admit_and_capture_migration_with_input_factory_v1(
        &binding,
        capture_production_legacy_snapshot_v1,
        || MigrationAdmissionInputV1 {
            target_binding: binding.clone(),
            migration_id: uuid::Uuid::new_v4().to_string(),
            migration_writer_id: uuid::Uuid::new_v4().to_string(),
            created_at: diagnostic_now_v1(),
        },
    )
}

fn webdav_remote_for_binding_v1(
    conn: &Mutex<Connection>,
    paths: &crate::app_paths::AppPaths,
    binding: &TargetRootBindingV1,
) -> Result<Option<WebDavS2RemoteV1>> {
    let Some(credentials) = ({
        let mut guard = conn.lock().map_err(|_| COORDINATOR_FAILURE)?;
        crate::sync_targets::historical_request_credentials(&mut guard, paths, &binding.target_id)
            .map_err(|_| COORDINATOR_FAILURE)?
    }) else {
        return Ok(None);
    };
    let root = webdav_root_v1(&credentials.0, &credentials.1).map_err(|_| COORDINATOR_FAILURE)?;
    if root.canonical_url != binding.canonical_url
        || root.normalized_account != binding.normalized_account
        || root.physical_root_id != binding.physical_root_id
    {
        return Err(COORDINATOR_FAILURE);
    }
    WebDavS2RemoteV1::new(WebDavS2ConfigV1 {
        root: WebDavRootV1 {
            canonical_url: binding.canonical_url.clone(),
            normalized_account: binding.normalized_account.clone(),
            physical_root_id: binding.physical_root_id.clone(),
        },
        username: credentials.1,
        password: credentials.2.to_string(),
        proxy: None,
        timeout: Duration::from_secs(30),
    })
    .map(Some)
    .map_err(|_| COORDINATOR_FAILURE)
}

fn map_lifecycle_result_v1(result: DesktopS2LifecycleResultV1) -> ProductionCoordinatorResultV1 {
    match result {
        DesktopS2LifecycleResultV1::SuccessSynced | DesktopS2LifecycleResultV1::SuccessNoOp => {
            ProductionCoordinatorResultV1::Success
        }
        DesktopS2LifecycleResultV1::PendingRemoteIndeterminate => {
            ProductionCoordinatorResultV1::RemoteIndeterminate
        }
        DesktopS2LifecycleResultV1::PendingDiscoveryDependencies
        | DesktopS2LifecycleResultV1::CancelledAtSafeBoundary => {
            ProductionCoordinatorResultV1::Pending
        }
        DesktopS2LifecycleResultV1::RemoteAuthOrCapabilityBlocked => {
            ProductionCoordinatorResultV1::RemoteAuthOrCapabilityBlocked
        }
        DesktopS2LifecycleResultV1::ActiveWithConflicts => ProductionCoordinatorResultV1::Conflicts,
        DesktopS2LifecycleResultV1::RootFrozen => ProductionCoordinatorResultV1::ReadOnlyFrozen,
        DesktopS2LifecycleResultV1::TargetChanged => ProductionCoordinatorResultV1::TargetChanged,
        DesktopS2LifecycleResultV1::LocalDurableCorruption
        | DesktopS2LifecycleResultV1::InternalFailure => {
            ProductionCoordinatorResultV1::InternalFailure
        }
    }
}

fn map_outbound_publish_v1(result: OutboundPublishResultV1) -> ProductionCoordinatorResultV1 {
    match result {
        OutboundPublishResultV1::AlreadyPublished | OutboundPublishResultV1::Published => {
            ProductionCoordinatorResultV1::Success
        }
        OutboundPublishResultV1::Pending => ProductionCoordinatorResultV1::RemoteIndeterminate,
        OutboundPublishResultV1::AuthOrCapabilityBlocked => {
            ProductionCoordinatorResultV1::RemoteAuthOrCapabilityBlocked
        }
        OutboundPublishResultV1::RootFrozen => ProductionCoordinatorResultV1::ReadOnlyFrozen,
    }
}

fn map_bootstrap_result_v1(
    result: BootstrapExecutionResultV1,
) -> Option<ProductionCoordinatorResultV1> {
    match result {
        BootstrapExecutionResultV1::Progressed | BootstrapExecutionResultV1::BootstrapComplete => {
            None
        }
        BootstrapExecutionResultV1::ActivationDeferred | BootstrapExecutionResultV1::Pending => {
            Some(ProductionCoordinatorResultV1::Pending)
        }
        BootstrapExecutionResultV1::RemoteIndeterminate => {
            Some(ProductionCoordinatorResultV1::RemoteIndeterminate)
        }
        BootstrapExecutionResultV1::RemoteAuthOrCapabilityBlocked => {
            Some(ProductionCoordinatorResultV1::RemoteAuthOrCapabilityBlocked)
        }
        BootstrapExecutionResultV1::RootFrozen => {
            Some(ProductionCoordinatorResultV1::ReadOnlyFrozen)
        }
    }
}

fn map_activation_result_v1(
    result: ActivationExecutionResultV1,
) -> Option<ProductionCoordinatorResultV1> {
    match result {
        ActivationExecutionResultV1::Progressed
        | ActivationExecutionResultV1::ActivationVerified => None,
        ActivationExecutionResultV1::AlreadyVerifiedRemotely
        | ActivationExecutionResultV1::Pending => Some(ProductionCoordinatorResultV1::Pending),
        ActivationExecutionResultV1::RemoteIndeterminate => {
            Some(ProductionCoordinatorResultV1::RemoteIndeterminate)
        }
        ActivationExecutionResultV1::RemoteAuthOrCapabilityBlocked => {
            Some(ProductionCoordinatorResultV1::RemoteAuthOrCapabilityBlocked)
        }
        ActivationExecutionResultV1::RootFrozen => {
            Some(ProductionCoordinatorResultV1::ReadOnlyFrozen)
        }
    }
}

fn run_one_normal_s2_cycle_v1(
    conn: &Mutex<Connection>,
    paths: &crate::app_paths::AppPaths,
    coordinator: &RootExecutionCoordinatorV1,
    binding: &TargetRootBindingV1,
    budgets: &DiscoveryBudgetsV1,
    diagnostic_time: &str,
) -> Result<ProductionCoordinatorResultV1> {
    let Some(mut remote) = webdav_remote_for_binding_v1(conn, paths, binding)? else {
        return Ok(ProductionCoordinatorResultV1::Pending);
    };
    let lifecycle_binding = DesktopS2RootBindingV1 {
        target_id: binding.target_id.clone(),
        target_epoch: binding.target_epoch,
        physical_root_id: binding.physical_root_id.clone(),
        canonical_url: binding.canonical_url.clone(),
        account: binding.normalized_account.clone(),
        remote_identity: remote.execution_context_identity(),
    };
    // Discovery/replay and all older durable work complete before the only
    // possible successor freeze.  The established runner owns recovery.
    let prior = run_desktop_s2_sync_execution_v1(
        conn,
        coordinator,
        &lifecycle_binding,
        &mut remote,
        || active_epoch_is_current_v1(conn, &binding.target_id, binding.target_epoch),
        || false,
        None,
        budgets,
        diagnostic_time,
    )?;
    let mapped = map_lifecycle_result_v1(prior);
    if !matches!(mapped, ProductionCoordinatorResultV1::Success) {
        return Ok(mapped);
    }
    // `freeze_active_outbound_v1` is zero-network. It can only run after the
    // recovery pass above; publication consumes precisely the frozen batch.
    match freeze_active_outbound_v1(
        conn,
        &binding.target_id,
        binding.target_epoch,
        diagnostic_time,
    )? {
        OutboundFreezeResultV1::Frozen { batch, .. } => Ok(map_outbound_publish_v1(
            publish_frozen_outbound_batch_with_webdav_v1(
                conn,
                paths,
                coordinator,
                &batch,
                diagnostic_time,
            )?,
        )),
        OutboundFreezeResultV1::NoSemanticMutation => Ok(ProductionCoordinatorResultV1::Success),
        OutboundFreezeResultV1::ExistingPendingOutbound => {
            Ok(ProductionCoordinatorResultV1::Pending)
        }
        OutboundFreezeResultV1::TargetChanged => Ok(ProductionCoordinatorResultV1::TargetChanged),
        OutboundFreezeResultV1::Blocked | OutboundFreezeResultV1::BlockedStaleEntityBases => {
            Ok(ProductionCoordinatorResultV1::Conflicts)
        }
    }
}

// This deliberately-private seam owns no authority.  In particular, route
// capture, historical binding selection, root safety, and phase budgeting all
// remain in the coordinator loop below.  It exists solely so module tests can
// observe a primitive which has made real durable progress before the next
// authoritative SQLite re-route.
trait CoordinatorPrimitiveDispatchV1 {
    fn execute_bootstrap(
        &self,
        conn: &Mutex<Connection>,
        paths: &crate::app_paths::AppPaths,
        coordinator: &RootExecutionCoordinatorV1,
        diagnostic_time: &str,
    ) -> Result<BootstrapExecutionResultV1>;

    fn execute_activation(
        &self,
        conn: &Mutex<Connection>,
        paths: &crate::app_paths::AppPaths,
        coordinator: &RootExecutionCoordinatorV1,
        diagnostic_time: &str,
    ) -> Result<ActivationExecutionResultV1>;

    fn execute_normal_s2(
        &self,
        conn: &Mutex<Connection>,
        paths: &crate::app_paths::AppPaths,
        coordinator: &RootExecutionCoordinatorV1,
        binding: &TargetRootBindingV1,
        budgets: &DiscoveryBudgetsV1,
        diagnostic_time: &str,
    ) -> Result<ProductionCoordinatorResultV1>;
}

#[derive(Default)]
struct ProductionCoordinatorPrimitiveDispatchV1;

impl CoordinatorPrimitiveDispatchV1 for ProductionCoordinatorPrimitiveDispatchV1 {
    fn execute_bootstrap(
        &self,
        conn: &Mutex<Connection>,
        paths: &crate::app_paths::AppPaths,
        coordinator: &RootExecutionCoordinatorV1,
        diagnostic_time: &str,
    ) -> Result<BootstrapExecutionResultV1> {
        execute_production_bootstrap_with_webdav_v1(conn, paths, coordinator, diagnostic_time)
    }

    fn execute_activation(
        &self,
        conn: &Mutex<Connection>,
        paths: &crate::app_paths::AppPaths,
        coordinator: &RootExecutionCoordinatorV1,
        diagnostic_time: &str,
    ) -> Result<ActivationExecutionResultV1> {
        execute_production_activation_with_webdav_v1(conn, paths, coordinator, diagnostic_time)
    }

    fn execute_normal_s2(
        &self,
        conn: &Mutex<Connection>,
        paths: &crate::app_paths::AppPaths,
        coordinator: &RootExecutionCoordinatorV1,
        binding: &TargetRootBindingV1,
        budgets: &DiscoveryBudgetsV1,
        diagnostic_time: &str,
    ) -> Result<ProductionCoordinatorResultV1> {
        run_one_normal_s2_cycle_v1(conn, paths, coordinator, binding, budgets, diagnostic_time)
    }
}

fn run_production_sync_coordinator_step_with_dispatch_v1<D: CoordinatorPrimitiveDispatchV1>(
    conn: &Mutex<Connection>,
    paths: &crate::app_paths::AppPaths,
    coordinator: &RootExecutionCoordinatorV1,
    budgets: &DiscoveryBudgetsV1,
    phase_step_budget: u8,
    dispatch: &D,
) -> Result<ProductionCoordinatorResultV1> {
    for _ in 0..phase_step_budget {
        let bound = load_bound_coordinator_route_v1(conn)?;
        if bound
            .finalized_historical_binding
            .as_ref()
            .is_some_and(|historical| {
                historical.target_id != bound.binding.target_id
                    || historical.target_epoch != bound.binding.target_epoch
                    || historical.physical_root_id != bound.binding.physical_root_id
            })
        {
            return Ok(ProductionCoordinatorResultV1::TargetChanged);
        }
        if bound.historical_migration
            && !active_epoch_is_current_v1(
                conn,
                &bound.binding.target_id,
                bound.binding.target_epoch,
            )
            && bound.route == DesktopSyncRouteV1::EnterNormalS2
        {
            return Ok(ProductionCoordinatorResultV1::TargetChanged);
        }
        match bound.route {
            DesktopSyncRouteV1::ContinueLegacyS1 => {
                return Ok(ProductionCoordinatorResultV1::LegacyS1Required)
            }
            DesktopSyncRouteV1::ReadOnlyFrozen => {
                return Ok(ProductionCoordinatorResultV1::ReadOnlyFrozen)
            }
            DesktopSyncRouteV1::ResumeBootstrap => {
                match map_bootstrap_result_v1(dispatch.execute_bootstrap(
                    conn,
                    paths,
                    coordinator,
                    &diagnostic_now_v1(),
                )?) {
                    None => continue,
                    Some(result) => return Ok(result),
                }
            }
            DesktopSyncRouteV1::ResumeActivation => {
                match map_activation_result_v1(dispatch.execute_activation(
                    conn,
                    paths,
                    coordinator,
                    &diagnostic_now_v1(),
                )?) {
                    None => continue,
                    Some(result) => return Ok(result),
                }
            }
            DesktopSyncRouteV1::EnterNormalS2 => {
                return dispatch.execute_normal_s2(
                    conn,
                    paths,
                    coordinator,
                    &bound.binding,
                    budgets,
                    &diagnostic_now_v1(),
                )
            }
        }
    }
    Ok(ProductionCoordinatorResultV1::Pending)
}

/// Runs a bounded coordinator step.  Every phase re-enters through the
/// authoritative SQLite router; no in-memory route is trusted after a durable
/// primitive has run.
pub fn run_production_sync_coordinator_step_with_budget_v1(
    conn: &Mutex<Connection>,
    paths: &crate::app_paths::AppPaths,
    coordinator: &RootExecutionCoordinatorV1,
    budgets: &DiscoveryBudgetsV1,
    phase_step_budget: u8,
) -> Result<ProductionCoordinatorResultV1> {
    run_production_sync_coordinator_step_with_dispatch_v1(
        conn,
        paths,
        coordinator,
        budgets,
        phase_step_budget,
        &ProductionCoordinatorPrimitiveDispatchV1,
    )
}

pub fn run_production_sync_coordinator_step_v1(
    conn: &Mutex<Connection>,
    paths: &crate::app_paths::AppPaths,
    coordinator: &RootExecutionCoordinatorV1,
    budgets: &DiscoveryBudgetsV1,
) -> Result<ProductionCoordinatorResultV1> {
    run_production_sync_coordinator_step_with_budget_v1(
        conn,
        paths,
        coordinator,
        budgets,
        DEFAULT_PHASE_STEP_BUDGET,
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use rusqlite::Connection;

    use super::*;
    use crate::db_atomic_helpers::set_setting_tx;
    use crate::s2_lite::activation_cutover::{
        create_activation_cutover_state_v1, ActivationFingerprintConsistencyV1,
        VerifiedActivationEvidenceV1,
    };
    use crate::s2_lite::migration_admission::admit_and_capture_migration_v1;
    use crate::s2_lite::migration_orchestration::MigrationStateStoreV1;
    use crate::sync_targets::{self, SyncTarget, SyncTargetRegistry, REGISTRY_KEY};

    const TIME: &str = "2026-09-26T00:00:00.000Z";

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum ObservedPrimitiveV1 {
        Bootstrap,
        Activation,
        Normal,
    }

    type AfterPrimitiveHookV1 = Box<dyn FnOnce(&Mutex<Connection>) + Send>;

    /// A module-local observer only. Every result comes from the production
    /// primitive; the optional one-shot hook runs strictly after that call so
    /// the next coordinator invocation must obtain its route from SQLite.
    struct ObservingProductionDispatchV1 {
        observed: Mutex<Vec<ObservedPrimitiveV1>>,
        after_call: Mutex<Option<AfterPrimitiveHookV1>>,
    }

    impl ObservingProductionDispatchV1 {
        fn new(after_call: Option<AfterPrimitiveHookV1>) -> Self {
            Self {
                observed: Mutex::new(Vec::new()),
                after_call: Mutex::new(after_call),
            }
        }

        fn observe(&self, primitive: ObservedPrimitiveV1, conn: &Mutex<Connection>) {
            self.observed.lock().unwrap().push(primitive);
            if let Some(hook) = self.after_call.lock().unwrap().take() {
                hook(conn);
            }
        }

        fn observed(&self) -> Vec<ObservedPrimitiveV1> {
            self.observed.lock().unwrap().clone()
        }
    }

    impl CoordinatorPrimitiveDispatchV1 for ObservingProductionDispatchV1 {
        fn execute_bootstrap(
            &self,
            conn: &Mutex<Connection>,
            paths: &crate::app_paths::AppPaths,
            coordinator: &RootExecutionCoordinatorV1,
            diagnostic_time: &str,
        ) -> Result<BootstrapExecutionResultV1> {
            let result = execute_production_bootstrap_with_webdav_v1(
                conn,
                paths,
                coordinator,
                diagnostic_time,
            );
            self.observe(ObservedPrimitiveV1::Bootstrap, conn);
            result
        }

        fn execute_activation(
            &self,
            conn: &Mutex<Connection>,
            paths: &crate::app_paths::AppPaths,
            coordinator: &RootExecutionCoordinatorV1,
            diagnostic_time: &str,
        ) -> Result<ActivationExecutionResultV1> {
            let result = execute_production_activation_with_webdav_v1(
                conn,
                paths,
                coordinator,
                diagnostic_time,
            );
            self.observe(ObservedPrimitiveV1::Activation, conn);
            result
        }

        fn execute_normal_s2(
            &self,
            conn: &Mutex<Connection>,
            paths: &crate::app_paths::AppPaths,
            coordinator: &RootExecutionCoordinatorV1,
            binding: &TargetRootBindingV1,
            budgets: &DiscoveryBudgetsV1,
            diagnostic_time: &str,
        ) -> Result<ProductionCoordinatorResultV1> {
            let result = run_one_normal_s2_cycle_v1(
                conn,
                paths,
                coordinator,
                binding,
                budgets,
                diagnostic_time,
            );
            self.observe(ObservedPrimitiveV1::Normal, conn);
            result
        }
    }

    fn connection() -> Mutex<Connection> {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::setup_db(&conn).unwrap();
        Mutex::new(conn)
    }

    fn target(url: &str, username: &str) -> SyncTarget {
        let normalized_url = sync_targets::normalize_url(url).unwrap();
        SyncTarget {
            id: sync_targets::target_id(&normalized_url, username),
            normalized_url,
            username: username.to_string(),
            created_at: TIME.to_string(),
            last_activated_at: TIME.to_string(),
        }
    }

    fn set_active(
        conn: &Mutex<Connection>,
        active: &SyncTarget,
        targets: Vec<SyncTarget>,
        epoch: u64,
    ) {
        set_setting_tx(
            &conn.lock().unwrap(),
            REGISTRY_KEY,
            &serde_json::to_string(&SyncTargetRegistry {
                version: 1,
                active_target_id: Some(active.id.clone()),
                target_epoch: epoch,
                targets,
            })
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn bound_route_uses_active_binding_and_budget_exhaustion_is_resumable() {
        let conn = connection();
        let active = target("https://dav.example.test/a/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        let bound = load_bound_coordinator_route_v1(&conn).unwrap();
        assert_eq!(bound.route, DesktopSyncRouteV1::ContinueLegacyS1);
        assert_eq!(bound.binding.target_id, active.id);
        assert!(!bound.historical_migration);

        let paths = crate::app_paths::AppPaths::resolve_from(None, &std::env::temp_dir()).unwrap();
        assert_eq!(
            run_production_sync_coordinator_step_with_budget_v1(
                &conn,
                &paths,
                &RootExecutionCoordinatorV1::default(),
                &DiscoveryBudgetsV1::default(),
                0,
            )
            .unwrap(),
            ProductionCoordinatorResultV1::Pending
        );
    }

    #[test]
    fn durable_fatal_wins_the_next_coordinator_reroute() {
        let conn = connection();
        let active = target("https://dav.example.test/fatal/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        let bound = resolve_active_target_root_binding_v1(&conn, &active.id, 1).unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, &bound.binding.physical_root_id).unwrap();
        MigrationStateStoreV1::persist_root_fatal(
            &mut store,
            &bound.binding.physical_root_id,
            "TEST_FATAL",
        )
        .unwrap();
        assert_eq!(
            load_bound_coordinator_route_v1(&conn).unwrap().route,
            DesktopSyncRouteV1::ReadOnlyFrozen
        );
    }

    #[test]
    fn admitted_historical_migration_keeps_a_binding_after_active_target_switch() {
        let conn = connection();
        let first = target("https://dav.example.test/a/", "alice");
        set_active(&conn, &first, vec![first.clone()], 1);
        let admitted = admit_and_capture_migration_v1(
            &conn,
            &first.id,
            1,
            "90000000-0000-4000-8000-000000000001",
            "90000000-0000-4000-8000-000000000002",
            TIME,
        )
        .unwrap();
        let second = target("https://dav.example.test/b/", "bob");
        set_active(&conn, &second, vec![first.clone(), second.clone()], 2);
        let bound = load_bound_coordinator_route_v1(&conn).unwrap();
        assert!(bound.historical_migration);
        assert_eq!(bound.binding.target_id, first.id);
        assert_eq!(bound.binding.target_epoch, 1);
        assert_eq!(
            bound.binding.physical_root_id,
            admitted.execution_binding.physical_root_id
        );
        // An empty captured source reaches the approved Stage-B/activation
        // boundary immediately; the important coordinator invariant is that
        // this route remains bound to A, never the newly active B.
        assert_eq!(bound.route, DesktopSyncRouteV1::ResumeActivation);
    }

    #[test]
    fn lost_response_retry_reuses_the_exact_durable_migration_identity() {
        let conn = connection();
        let active = target("https://dav.example.test/retry/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        let first = admit_migration_from_production_coordinator_v1(&conn).unwrap();
        // The first return is deliberately discarded, modelling a crash after
        // SQLite commit and before the caller receives its response.
        let retry = admit_migration_from_production_coordinator_v1(&conn).unwrap();
        assert!(!first.attached_existing);
        assert!(retry.attached_existing);
        assert_eq!(retry.execution_binding, first.execution_binding);
        assert_eq!(retry.state, first.state);
        assert_eq!(
            load_bound_coordinator_route_v1(&conn).unwrap().route,
            DesktopSyncRouteV1::ResumeActivation
        );
    }

    #[test]
    fn concurrent_coordinator_admission_converges_on_one_identity() {
        let conn = Arc::new(connection());
        let active = target("https://dav.example.test/concurrent/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        let first_conn = Arc::clone(&conn);
        let second_conn = Arc::clone(&conn);
        let first =
            std::thread::spawn(move || admit_migration_from_production_coordinator_v1(&first_conn));
        let second = std::thread::spawn(move || {
            admit_migration_from_production_coordinator_v1(&second_conn)
        });
        let first = first.join().unwrap().unwrap();
        let second = second.join().unwrap().unwrap();
        assert_eq!(first.execution_binding, second.execution_binding);
        assert_ne!(first.attached_existing, second.attached_existing);
    }

    #[test]
    fn corrupt_existing_authority_is_not_treated_as_a_retry() {
        let conn = connection();
        let active = target("https://dav.example.test/corrupt/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        let admitted = admit_migration_from_production_coordinator_v1(&conn).unwrap();
        conn.lock()
            .unwrap()
            .execute(
                "DELETE FROM s2_lite_migration_v1 WHERE root_id=?1",
                [&admitted.execution_binding.physical_root_id],
            )
            .unwrap();
        assert!(admit_migration_from_production_coordinator_v1(&conn).is_err());
    }

    #[test]
    fn active_target_switch_during_capture_never_mixes_route_and_old_binding() {
        let conn = connection();
        let first = target("https://dav.example.test/route-a/", "alice");
        let second = target("https://dav.example.test/route-b/", "bob");
        set_active(&conn, &first, vec![first.clone(), second.clone()], 1);
        let bound = load_bound_coordinator_route_with_before_route_v1(&conn, || {
            set_active(&conn, &second, vec![first.clone(), second.clone()], 2);
        })
        .unwrap();
        assert_eq!(bound.route, DesktopSyncRouteV1::ContinueLegacyS1);
        assert_eq!(bound.binding.target_id, second.id);
        assert_eq!(bound.binding.target_epoch, 2);
        assert!(binding_is_current_active_v1(&conn, &bound.binding));
    }

    #[test]
    fn migration_admission_during_capture_retries_into_its_historical_route() {
        let conn = connection();
        let active = target("https://dav.example.test/route-migration/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        let mut admitted = false;
        let bound = load_bound_coordinator_route_with_before_route_v1(&conn, || {
            if !admitted {
                admitted = true;
                admit_and_capture_migration_v1(
                    &conn,
                    &active.id,
                    1,
                    "91000000-0000-4000-8000-000000000001",
                    "91000000-0000-4000-8000-000000000002",
                    TIME,
                )
                .unwrap();
            }
        })
        .unwrap();
        assert!(bound.historical_migration);
        assert_eq!(bound.binding.target_id, active.id);
        assert_eq!(bound.binding.target_epoch, 1);
        assert_eq!(bound.route, DesktopSyncRouteV1::ResumeActivation);
    }

    #[test]
    fn fatal_during_capture_returns_a_coherent_frozen_route() {
        let conn = connection();
        let active = target("https://dav.example.test/route-fatal/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        let bound = resolve_active_target_root_binding_v1(&conn, &active.id, 1).unwrap();
        let root_id = bound.binding.physical_root_id.clone();
        let captured = load_bound_coordinator_route_with_before_route_v1(&conn, || {
            let mut store = SqliteS2LiteStoreV1::open(&conn, &root_id).unwrap();
            MigrationStateStoreV1::persist_root_fatal(&mut store, &root_id, "CAPTURE_FATAL")
                .unwrap();
        })
        .unwrap();
        assert_eq!(captured.route, DesktopSyncRouteV1::ReadOnlyFrozen);
        assert_eq!(captured.binding.physical_root_id, root_id);
        assert!(binding_is_current_active_v1(&conn, &captured.binding));
    }

    #[test]
    fn typed_execution_classifications_are_not_collapsed_to_pending() {
        assert_eq!(
            map_lifecycle_result_v1(DesktopS2LifecycleResultV1::SuccessNoOp),
            ProductionCoordinatorResultV1::Success
        );
        assert_eq!(
            map_lifecycle_result_v1(DesktopS2LifecycleResultV1::PendingRemoteIndeterminate),
            ProductionCoordinatorResultV1::RemoteIndeterminate
        );
        assert_eq!(
            map_lifecycle_result_v1(DesktopS2LifecycleResultV1::PendingDiscoveryDependencies),
            ProductionCoordinatorResultV1::Pending
        );
        assert_eq!(
            map_lifecycle_result_v1(DesktopS2LifecycleResultV1::ActiveWithConflicts),
            ProductionCoordinatorResultV1::Conflicts
        );
        assert_eq!(
            map_lifecycle_result_v1(DesktopS2LifecycleResultV1::TargetChanged),
            ProductionCoordinatorResultV1::TargetChanged
        );
        assert_eq!(
            map_lifecycle_result_v1(DesktopS2LifecycleResultV1::RootFrozen),
            ProductionCoordinatorResultV1::ReadOnlyFrozen
        );
        assert_eq!(
            map_bootstrap_result_v1(BootstrapExecutionResultV1::RemoteIndeterminate),
            Some(ProductionCoordinatorResultV1::RemoteIndeterminate)
        );
        assert_eq!(
            map_bootstrap_result_v1(BootstrapExecutionResultV1::RemoteAuthOrCapabilityBlocked),
            Some(ProductionCoordinatorResultV1::RemoteAuthOrCapabilityBlocked)
        );
        assert_eq!(
            map_activation_result_v1(ActivationExecutionResultV1::RemoteIndeterminate),
            Some(ProductionCoordinatorResultV1::RemoteIndeterminate)
        );
        assert_eq!(
            map_activation_result_v1(ActivationExecutionResultV1::RemoteAuthOrCapabilityBlocked),
            Some(ProductionCoordinatorResultV1::RemoteAuthOrCapabilityBlocked)
        );
    }

    #[test]
    fn production_entrypoint_returns_legacy_and_frozen_terminals_without_remote_work() {
        let conn = connection();
        let active = target("https://dav.example.test/coordinator-entry/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        let paths = crate::app_paths::AppPaths::resolve_from(None, &std::env::temp_dir()).unwrap();
        assert_eq!(
            run_production_sync_coordinator_step_with_budget_v1(
                &conn,
                &paths,
                &RootExecutionCoordinatorV1::default(),
                &DiscoveryBudgetsV1::default(),
                1,
            )
            .unwrap(),
            ProductionCoordinatorResultV1::LegacyS1Required
        );

        let bound = resolve_active_target_root_binding_v1(&conn, &active.id, 1).unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, &bound.binding.physical_root_id).unwrap();
        MigrationStateStoreV1::persist_root_fatal(
            &mut store,
            &bound.binding.physical_root_id,
            "COORDINATOR_ENTRY_FATAL",
        )
        .unwrap();
        assert_eq!(
            run_production_sync_coordinator_step_with_budget_v1(
                &conn,
                &paths,
                &RootExecutionCoordinatorV1::default(),
                &DiscoveryBudgetsV1::default(),
                1,
            )
            .unwrap(),
            ProductionCoordinatorResultV1::ReadOnlyFrozen
        );
    }

    #[test]
    fn positive_budget_pending_keeps_durable_migration_resumable() {
        let conn = connection();
        let active = target("https://dav.example.test/coordinator-budget/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        let admitted = admit_migration_from_production_coordinator_v1(&conn).unwrap();
        let paths = crate::app_paths::AppPaths::resolve_from(None, &std::env::temp_dir()).unwrap();
        // The admitted empty source is at the activation boundary. With no
        // credential, the real production wrapper is locally resumable; the
        // positive budget is consumed without manufacturing a fatal state.
        assert_eq!(
            run_production_sync_coordinator_step_with_budget_v1(
                &conn,
                &paths,
                &RootExecutionCoordinatorV1::default(),
                &DiscoveryBudgetsV1::default(),
                1,
            )
            .unwrap(),
            ProductionCoordinatorResultV1::Pending
        );
        let resumed = admit_migration_from_production_coordinator_v1(&conn).unwrap();
        assert_eq!(resumed.execution_binding, admitted.execution_binding);
        assert_eq!(
            load_bound_coordinator_route_v1(&conn).unwrap().route,
            DesktopSyncRouteV1::ResumeActivation
        );
    }

    #[test]
    fn production_dispatch_forwards_the_existing_activation_primitive() {
        let conn = connection();
        let active = target("https://dav.example.test/dispatch-forward/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        admit_migration_from_production_coordinator_v1(&conn).unwrap();
        let paths = crate::app_paths::AppPaths::resolve_from(None, &std::env::temp_dir()).unwrap();
        let coordinator = RootExecutionCoordinatorV1::default();
        let production = ProductionCoordinatorPrimitiveDispatchV1;

        assert_eq!(
            production
                .execute_activation(&conn, &paths, &coordinator, TIME)
                .unwrap(),
            execute_production_activation_with_webdav_v1(&conn, &paths, &coordinator, TIME)
                .unwrap()
        );
    }

    #[test]
    fn test_dispatch_cannot_select_the_durable_legacy_route_or_consume_budget() {
        let conn = connection();
        let active = target("https://dav.example.test/dispatch-route/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        let paths = crate::app_paths::AppPaths::resolve_from(None, &std::env::temp_dir()).unwrap();
        let dispatch = ObservingProductionDispatchV1::new(None);

        assert_eq!(
            run_production_sync_coordinator_step_with_dispatch_v1(
                &conn,
                &paths,
                &RootExecutionCoordinatorV1::default(),
                &DiscoveryBudgetsV1::default(),
                1,
                &dispatch,
            )
            .unwrap(),
            ProductionCoordinatorResultV1::LegacyS1Required
        );
        assert!(dispatch.observed().is_empty());

        assert_eq!(
            run_production_sync_coordinator_step_with_dispatch_v1(
                &conn,
                &paths,
                &RootExecutionCoordinatorV1::default(),
                &DiscoveryBudgetsV1::default(),
                0,
                &dispatch,
            )
            .unwrap(),
            ProductionCoordinatorResultV1::Pending
        );
        assert!(dispatch.observed().is_empty());
    }

    #[test]
    fn post_primitive_hook_is_one_shot_and_next_reroute_reads_its_durable_state() {
        let conn = connection();
        let active = target("https://dav.example.test/dispatch-hook/", "alice");
        set_active(&conn, &active, vec![active.clone()], 1);
        admit_migration_from_production_coordinator_v1(&conn).unwrap();
        let paths = crate::app_paths::AppPaths::resolve_from(None, &std::env::temp_dir()).unwrap();
        let root_id = resolve_active_target_root_binding_v1(&conn, &active.id, 1)
            .unwrap()
            .binding
            .physical_root_id;
        // Make the *real* production activation primitive adopt an already
        // verified compatible activation. This mutates migration authority
        // durably without a remote credential or test-injected result.
        {
            let mut store = SqliteS2LiteStoreV1::open(&conn, &root_id).unwrap();
            let migration = MigrationStateStoreV1::load(&mut store, &root_id)
                .unwrap()
                .unwrap();
            let fingerprint = migration.snapshot.unwrap().legacy_fingerprint;
            let mut cutover = create_activation_cutover_state_v1();
            cutover.remote_s2_activated = true;
            cutover
                .verified_activation_evidence
                .push(VerifiedActivationEvidenceV1 {
                    path: "activations/dispatch-hook.json".to_string(),
                    activation_id: "96000000-0000-4000-8000-000000000001".to_string(),
                    content_hash: "d".repeat(64),
                    exact_bytes_hash: "d".repeat(64),
                    legacy_fingerprint: Some(fingerprint.clone()),
                });
            cutover.fingerprint_consistency = ActivationFingerprintConsistencyV1::Consistent {
                legacy_fingerprint: Some(fingerprint),
            };
            MigrationStateStoreV1::persist_cutover_state(&mut store, &root_id, &cutover).unwrap();
        }
        let hook_root_id = root_id.clone();
        let dispatch = ObservingProductionDispatchV1::new(Some(Box::new(move |conn| {
            let mut store = SqliteS2LiteStoreV1::open(conn, &hook_root_id).unwrap();
            MigrationStateStoreV1::persist_root_fatal(&mut store, &hook_root_id, "HOOK_FATAL")
                .unwrap();
        })));

        // The real activation primitive first adopts the compatible verified
        // activation in SQLite. Only after it returns does the hook durably
        // freeze the root; the observer cannot manufacture a route or result.
        assert_eq!(
            run_production_sync_coordinator_step_with_dispatch_v1(
                &conn,
                &paths,
                &RootExecutionCoordinatorV1::default(),
                &DiscoveryBudgetsV1::default(),
                1,
                &dispatch,
            )
            .unwrap(),
            ProductionCoordinatorResultV1::Pending
        );
        assert_eq!(dispatch.observed(), vec![ObservedPrimitiveV1::Activation]);
        assert_eq!(
            run_production_sync_coordinator_step_with_dispatch_v1(
                &conn,
                &paths,
                &RootExecutionCoordinatorV1::default(),
                &DiscoveryBudgetsV1::default(),
                1,
                &dispatch,
            )
            .unwrap(),
            ProductionCoordinatorResultV1::ReadOnlyFrozen
        );
        assert_eq!(dispatch.observed(), vec![ObservedPrimitiveV1::Activation]);
        assert_eq!(
            load_bound_coordinator_route_v1(&conn)
                .unwrap()
                .binding
                .physical_root_id,
            root_id
        );
    }
}
