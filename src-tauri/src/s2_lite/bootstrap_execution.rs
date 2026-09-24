//! Production execution and recovery for already-admitted bootstrap work.
//!
//! This is deliberately a narrow adapter around the frozen migration
//! orchestrator. It neither plans migration nor advances into activation: once
//! Stage B is durable, activation remains a later lifecycle responsibility.

use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;

use super::activation_cutover::ActivationFingerprintConsistencyV1;
use super::canonical::{ProtocolError, Result};
use super::durable_persistence::{
    MigrationExecutionBindingV1, SqliteS2LiteStoreV1, TargetRootBindingV1,
};
use super::immutable_publish::ImmutableObjectRemoteV1;
use super::migration_orchestration::{
    create_migration_root_execution_capability_v1, execute_migration_step_v1,
    start_or_attach_migration_v1, MigrationStateStoreV1, MigrationStatusV1,
};
use super::outbound_publish::HistoricalWebDavCredentialsV1;
use super::root_coordinator::RootExecutionCoordinatorV1;
use super::target_root_binding::load_historical_target_root_binding_v1;
use super::webdav_adapter::{webdav_root_v1, WebDavRootV1, WebDavS2ConfigV1, WebDavS2RemoteV1};

const BOOTSTRAP_EXECUTION_FAILURE: ProtocolError = ProtocolError("S2_BOOTSTRAP_EXECUTION_FAILURE");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BootstrapExecutionResultV1 {
    Progressed,
    BootstrapComplete,
    ActivationDeferred,
    Pending,
    RootFrozen,
}

/// Production result for the activation-publication checkpoint. This endpoint
/// deliberately stops at an attached, verified activation receipt; migration
/// completion and the normal-writer handoff belong to 4B2.2.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivationExecutionResultV1 {
    Progressed,
    ActivationVerified,
    AlreadyVerifiedRemotely,
    Pending,
    RootFrozen,
}

fn freeze_root(
    store: &mut SqliteS2LiteStoreV1<'_>,
    root_id: &str,
    code: &str,
) -> Result<BootstrapExecutionResultV1> {
    let _ = MigrationStateStoreV1::persist_root_fatal(store, root_id, code)?;
    Ok(BootstrapExecutionResultV1::RootFrozen)
}

fn binding_matches_execution(
    execution: &MigrationExecutionBindingV1,
    target: &TargetRootBindingV1,
) -> bool {
    execution.target_id == target.target_id
        && execution.target_epoch == target.target_epoch
        && execution.physical_root_id == target.physical_root_id
}

fn no_network_result(status: MigrationStatusV1) -> Option<BootstrapExecutionResultV1> {
    match status {
        MigrationStatusV1::RootFrozen => Some(BootstrapExecutionResultV1::RootFrozen),
        // Stage B completion is the explicit 4B1 terminal boundary.
        MigrationStatusV1::StageBComplete => Some(BootstrapExecutionResultV1::BootstrapComplete),
        MigrationStatusV1::ActivationPublishing
        | MigrationStatusV1::ActivationVerified
        | MigrationStatusV1::MigrationComplete => {
            Some(BootstrapExecutionResultV1::ActivationDeferred)
        }
        _ => None,
    }
}

/// A migration-state generation is a CAS/versioning detail, not publication
/// progress. The production wrapper exposes progress only when a bootstrap
/// stage or one of its task receipts changed durably.
fn bootstrap_semantics_advanced(
    before: &super::migration_orchestration::MigrationStateV1,
    after: &super::migration_orchestration::MigrationStateV1,
) -> bool {
    before.status != after.status
        || before.stage_a != after.stage_a
        || before.stage_b != after.stage_b
}

fn activation_semantics_advanced(
    before: &super::migration_orchestration::MigrationStateV1,
    after: &super::migration_orchestration::MigrationStateV1,
) -> bool {
    before.status != after.status
        || before.activation_receipt != after.activation_receipt
        || before.activation_receipt_root_id != after.activation_receipt_root_id
}

/// Executes at most one frozen bootstrap orchestration step using the exact
/// historical target/root binding. The production factory is intentionally
/// injected so deterministic tests can use a local fake remote without
/// duplicating bootstrap behavior.
pub fn execute_production_bootstrap_with_factory_v1<R, L, F>(
    conn: &Mutex<Connection>,
    coordinator: &RootExecutionCoordinatorV1,
    mut load_historical_credentials: L,
    build_remote: F,
    verified_at_diagnostic: &str,
) -> Result<BootstrapExecutionResultV1>
where
    R: ImmutableObjectRemoteV1,
    L: FnMut(&TargetRootBindingV1) -> Result<Option<HistoricalWebDavCredentialsV1>>,
    F: FnOnce(&TargetRootBindingV1, HistoricalWebDavCredentialsV1) -> Result<R>,
{
    let Some(execution) = SqliteS2LiteStoreV1::load_migration_source_execution_binding_v1(conn)?
    else {
        return Err(BOOTSTRAP_EXECUTION_FAILURE);
    };
    let root_id = execution.physical_root_id.clone();
    let target =
        load_historical_target_root_binding_v1(conn, &execution.target_id, execution.target_epoch)?;
    let Some(target) = target else {
        let mut store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
        return freeze_root(
            &mut store,
            &root_id,
            "S2_BOOTSTRAP_HISTORICAL_BINDING_MISSING",
        );
    };
    if !binding_matches_execution(&execution, &target) {
        let mut store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
        return freeze_root(
            &mut store,
            &root_id,
            "S2_BOOTSTRAP_HISTORICAL_BINDING_MISMATCH",
        );
    }

    let mut preflight = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let migration = MigrationStateStoreV1::load(&mut preflight, &root_id)?
        .ok_or(BOOTSTRAP_EXECUTION_FAILURE)?;
    if migration.migration_id != execution.migration_id {
        return freeze_root(
            &mut preflight,
            &root_id,
            "S2_BOOTSTRAP_MIGRATION_BINDING_MISMATCH",
        );
    }
    if let Some(result) = no_network_result(migration.status) {
        return Ok(result);
    }

    let Some(credentials) = load_historical_credentials(&target)? else {
        return Ok(BootstrapExecutionResultV1::Pending);
    };
    let root = webdav_root_v1(&credentials.canonical_url, &credentials.username)
        .map_err(|_| BOOTSTRAP_EXECUTION_FAILURE)?;
    if root.canonical_url != target.canonical_url
        || root.normalized_account != target.normalized_account
        || root.physical_root_id != root_id
    {
        return freeze_root(
            &mut preflight,
            &root_id,
            "S2_BOOTSTRAP_HISTORICAL_CREDENTIAL_BINDING_MISMATCH",
        );
    }
    let mut remote = build_remote(&target, credentials)?;
    if remote.physical_root_id() != Some(root_id.as_str()) {
        return freeze_root(
            &mut preflight,
            &root_id,
            "S2_BOOTSTRAP_REMOTE_ROOT_MISMATCH",
        );
    }

    let _guard = coordinator.acquire_blocking(&root_id)?;
    // Every mutable trait view is a root-bound handle over the same SQLite
    // authority. `execute_migration_step_v1` retains the only publication gate.
    let mut migration_store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let durable = MigrationStateStoreV1::load(&mut migration_store, &root_id)?
        .ok_or(BOOTSTRAP_EXECUTION_FAILURE)?;
    if durable.migration_id != execution.migration_id {
        return freeze_root(
            &mut migration_store,
            &root_id,
            "S2_BOOTSTRAP_DURABLE_MIGRATION_MISMATCH",
        );
    }
    if let Some(result) = no_network_result(durable.status) {
        return Ok(result);
    }
    let attachment = start_or_attach_migration_v1(&durable, &mut migration_store)?;
    let capability =
        create_migration_root_execution_capability_v1(&attachment, &remote, &migration_store)?;
    let mut intent_store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let mut receipt_store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let mut activation_intent_store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let mut activation_receipt_store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let next = execute_migration_step_v1(
        &durable,
        &capability,
        &mut remote,
        &mut migration_store,
        &mut intent_store,
        &mut receipt_store,
        &mut activation_intent_store,
        &mut activation_receipt_store,
        verified_at_diagnostic,
    )?;
    if let Some(result) = no_network_result(next.status) {
        return Ok(result);
    }
    Ok(if bootstrap_semantics_advanced(&durable, &next) {
        BootstrapExecutionResultV1::Progressed
    } else {
        BootstrapExecutionResultV1::Pending
    })
}

/// Executes at most one production activation recovery step for the migration
/// bound to the database-wide historical source owner. It never performs the
/// later local completion/cutover bookkeeping.
pub fn execute_production_activation_with_factory_v1<R, L, F>(
    conn: &Mutex<Connection>,
    coordinator: &RootExecutionCoordinatorV1,
    mut load_historical_credentials: L,
    build_remote: F,
    verified_at_diagnostic: &str,
) -> Result<ActivationExecutionResultV1>
where
    R: ImmutableObjectRemoteV1,
    L: FnMut(&TargetRootBindingV1) -> Result<Option<HistoricalWebDavCredentialsV1>>,
    F: FnOnce(&TargetRootBindingV1, HistoricalWebDavCredentialsV1) -> Result<R>,
{
    let Some(execution) = SqliteS2LiteStoreV1::load_migration_source_execution_binding_v1(conn)?
    else {
        return Err(BOOTSTRAP_EXECUTION_FAILURE);
    };
    let root_id = execution.physical_root_id.clone();
    let target =
        load_historical_target_root_binding_v1(conn, &execution.target_id, execution.target_epoch)?;
    let Some(target) = target else {
        let mut store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
        freeze_root(
            &mut store,
            &root_id,
            "S2_ACTIVATION_HISTORICAL_BINDING_MISSING",
        )?;
        return Ok(ActivationExecutionResultV1::RootFrozen);
    };
    if !binding_matches_execution(&execution, &target) {
        let mut store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
        freeze_root(
            &mut store,
            &root_id,
            "S2_ACTIVATION_HISTORICAL_BINDING_MISMATCH",
        )?;
        return Ok(ActivationExecutionResultV1::RootFrozen);
    }

    let mut preflight = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let migration = MigrationStateStoreV1::load(&mut preflight, &root_id)?
        .ok_or(BOOTSTRAP_EXECUTION_FAILURE)?;
    if migration.migration_id != execution.migration_id {
        freeze_root(
            &mut preflight,
            &root_id,
            "S2_ACTIVATION_MIGRATION_BINDING_MISMATCH",
        )?;
        return Ok(ActivationExecutionResultV1::RootFrozen);
    }
    if migration.status == MigrationStatusV1::RootFrozen {
        return Ok(ActivationExecutionResultV1::RootFrozen);
    }
    if matches!(
        migration.status,
        MigrationStatusV1::ActivationVerified | MigrationStatusV1::MigrationComplete
    ) {
        return Ok(ActivationExecutionResultV1::ActivationVerified);
    }
    if !matches!(
        migration.status,
        MigrationStatusV1::StageBComplete | MigrationStatusV1::ActivationPublishing
    ) {
        return Ok(ActivationExecutionResultV1::Pending);
    }
    let safety = MigrationStateStoreV1::load_root_safety(&mut preflight, &root_id)?;
    if !safety.root_fatal_signals.is_empty() {
        return Ok(ActivationExecutionResultV1::RootFrozen);
    }
    let expected_fingerprint = migration
        .snapshot
        .as_ref()
        .ok_or(BOOTSTRAP_EXECUTION_FAILURE)?
        .legacy_fingerprint
        .clone();
    match &safety.cutover_state.fingerprint_consistency {
        ActivationFingerprintConsistencyV1::NoEvidence => {}
        ActivationFingerprintConsistencyV1::Consistent { legacy_fingerprint }
            if legacy_fingerprint.as_ref() == Some(&expected_fingerprint) =>
        {
            return Ok(ActivationExecutionResultV1::AlreadyVerifiedRemotely);
        }
        ActivationFingerprintConsistencyV1::Consistent { .. }
        | ActivationFingerprintConsistencyV1::Conflict => {
            freeze_root(
                &mut preflight,
                &root_id,
                "S2_ACTIVATION_VERIFIED_FINGERPRINT_MISMATCH",
            )?;
            return Ok(ActivationExecutionResultV1::RootFrozen);
        }
    }

    let Some(credentials) = load_historical_credentials(&target)? else {
        return Ok(ActivationExecutionResultV1::Pending);
    };
    let root = webdav_root_v1(&credentials.canonical_url, &credentials.username)
        .map_err(|_| BOOTSTRAP_EXECUTION_FAILURE)?;
    if root.canonical_url != target.canonical_url
        || root.normalized_account != target.normalized_account
        || root.physical_root_id != root_id
    {
        freeze_root(
            &mut preflight,
            &root_id,
            "S2_ACTIVATION_HISTORICAL_CREDENTIAL_BINDING_MISMATCH",
        )?;
        return Ok(ActivationExecutionResultV1::RootFrozen);
    }
    let mut remote = build_remote(&target, credentials)?;
    if remote.physical_root_id() != Some(root_id.as_str()) {
        freeze_root(
            &mut preflight,
            &root_id,
            "S2_ACTIVATION_REMOTE_ROOT_MISMATCH",
        )?;
        return Ok(ActivationExecutionResultV1::RootFrozen);
    }

    let _guard = coordinator.acquire_blocking(&root_id)?;
    let mut migration_store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let durable = MigrationStateStoreV1::load(&mut migration_store, &root_id)?
        .ok_or(BOOTSTRAP_EXECUTION_FAILURE)?;
    if durable.migration_id != execution.migration_id {
        freeze_root(
            &mut migration_store,
            &root_id,
            "S2_ACTIVATION_DURABLE_MIGRATION_MISMATCH",
        )?;
        return Ok(ActivationExecutionResultV1::RootFrozen);
    }
    if durable.status == MigrationStatusV1::RootFrozen {
        return Ok(ActivationExecutionResultV1::RootFrozen);
    }
    if matches!(
        durable.status,
        MigrationStatusV1::ActivationVerified | MigrationStatusV1::MigrationComplete
    ) {
        return Ok(ActivationExecutionResultV1::ActivationVerified);
    }
    if !matches!(
        durable.status,
        MigrationStatusV1::StageBComplete | MigrationStatusV1::ActivationPublishing
    ) {
        return Ok(ActivationExecutionResultV1::Pending);
    }
    let attachment = start_or_attach_migration_v1(&durable, &mut migration_store)?;
    let capability =
        create_migration_root_execution_capability_v1(&attachment, &remote, &migration_store)?;
    let mut intent_store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let mut receipt_store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let mut activation_intent_store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let mut activation_receipt_store = SqliteS2LiteStoreV1::open(conn, &root_id)?;
    let next = execute_migration_step_v1(
        &durable,
        &capability,
        &mut remote,
        &mut migration_store,
        &mut intent_store,
        &mut receipt_store,
        &mut activation_intent_store,
        &mut activation_receipt_store,
        verified_at_diagnostic,
    )?;
    if next.status == MigrationStatusV1::RootFrozen {
        return Ok(ActivationExecutionResultV1::RootFrozen);
    }
    if next.status == MigrationStatusV1::ActivationVerified {
        return Ok(ActivationExecutionResultV1::ActivationVerified);
    }
    Ok(if activation_semantics_advanced(&durable, &next) {
        ActivationExecutionResultV1::Progressed
    } else {
        ActivationExecutionResultV1::Pending
    })
}

/// Production WebDAV entry point. Historical credentials are resolved only
/// from the migration binding's target; the active target is never consulted.
pub fn execute_production_bootstrap_with_webdav_v1(
    conn: &Mutex<Connection>,
    paths: &crate::app_paths::AppPaths,
    coordinator: &RootExecutionCoordinatorV1,
    verified_at_diagnostic: &str,
) -> Result<BootstrapExecutionResultV1> {
    execute_production_bootstrap_with_factory_v1(
        conn,
        coordinator,
        |target| {
            let mut guard = conn.lock().map_err(|_| BOOTSTRAP_EXECUTION_FAILURE)?;
            let credentials = crate::sync_targets::historical_request_credentials(
                &mut guard,
                paths,
                &target.target_id,
            )
            .map_err(|_| BOOTSTRAP_EXECUTION_FAILURE)?;
            Ok(credentials.map(|(canonical_url, username, password)| {
                HistoricalWebDavCredentialsV1 {
                    canonical_url,
                    username,
                    password: password.to_string(),
                }
            }))
        },
        |target, credentials| {
            WebDavS2RemoteV1::new(WebDavS2ConfigV1 {
                root: WebDavRootV1 {
                    canonical_url: target.canonical_url.clone(),
                    normalized_account: target.normalized_account.clone(),
                    physical_root_id: target.physical_root_id.clone(),
                },
                username: credentials.username,
                password: credentials.password,
                proxy: None,
                timeout: Duration::from_secs(30),
            })
            .map_err(|_| BOOTSTRAP_EXECUTION_FAILURE)
        },
        verified_at_diagnostic,
    )
}

/// Production WebDAV activation entry point. Credentials are resolved from
/// the migration's historical target only; a later active-target switch is
/// never authority to retarget the frozen activation.
pub fn execute_production_activation_with_webdav_v1(
    conn: &Mutex<Connection>,
    paths: &crate::app_paths::AppPaths,
    coordinator: &RootExecutionCoordinatorV1,
    verified_at_diagnostic: &str,
) -> Result<ActivationExecutionResultV1> {
    execute_production_activation_with_factory_v1(
        conn,
        coordinator,
        |target| {
            let mut guard = conn.lock().map_err(|_| BOOTSTRAP_EXECUTION_FAILURE)?;
            let credentials = crate::sync_targets::historical_request_credentials(
                &mut guard,
                paths,
                &target.target_id,
            )
            .map_err(|_| BOOTSTRAP_EXECUTION_FAILURE)?;
            Ok(credentials.map(|(canonical_url, username, password)| {
                HistoricalWebDavCredentialsV1 {
                    canonical_url,
                    username,
                    password: password.to_string(),
                }
            }))
        },
        |target, credentials| {
            WebDavS2RemoteV1::new(WebDavS2ConfigV1 {
                root: WebDavRootV1 {
                    canonical_url: target.canonical_url.clone(),
                    normalized_account: target.normalized_account.clone(),
                    physical_root_id: target.physical_root_id.clone(),
                },
                username: credentials.username,
                password: credentials.password,
                proxy: None,
                timeout: Duration::from_secs(30),
            })
            .map_err(|_| BOOTSTRAP_EXECUTION_FAILURE)
        },
        verified_at_diagnostic,
    )
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, VecDeque};
    use std::sync::{Arc, Mutex};

    use rusqlite::Connection;

    use super::*;
    use crate::db_atomic_helpers::set_setting_tx;
    use crate::s2_lite::immutable_publish::{RemoteExactGetResultV1, RemotePutResultV1};
    use crate::s2_lite::migration_admission::admit_and_capture_migration_v1;
    use crate::sync_targets::{self, SyncTarget, SyncTargetRegistry, REGISTRY_KEY};

    const CREATED: &str = "2026-09-24T00:00:00.000Z";
    const MIGRATION: &str = "90000000-0000-4000-8000-000000000001";
    const WRITER: &str = "91000000-0000-4000-8000-000000000001";

    #[derive(Default)]
    struct FakeState {
        objects: BTreeMap<String, Vec<u8>>,
        scripted_gets: VecDeque<RemoteExactGetResultV1>,
        get_calls: usize,
        put_calls: usize,
    }

    #[derive(Clone)]
    struct FakeRemote {
        root_id: String,
        state: Arc<Mutex<FakeState>>,
    }

    impl ImmutableObjectRemoteV1 for FakeRemote {
        fn physical_root_id(&self) -> Option<&str> {
            Some(&self.root_id)
        }

        fn execution_context_identity(&self) -> u64 {
            401
        }

        fn get_exact(&mut self, path: &str) -> RemoteExactGetResultV1 {
            let mut state = self.state.lock().unwrap();
            state.get_calls += 1;
            state.scripted_gets.pop_front().unwrap_or_else(|| {
                state.objects.get(path).cloned().map_or(
                    RemoteExactGetResultV1::DefinitelyAbsent,
                    RemoteExactGetResultV1::DefinitelyPresent,
                )
            })
        }

        fn put_exact(&mut self, path: &str, bytes: &[u8], _: bool) -> RemotePutResultV1 {
            let mut state = self.state.lock().unwrap();
            state.put_calls += 1;
            state.objects.insert(path.to_string(), bytes.to_vec());
            RemotePutResultV1::Indeterminate
        }
    }

    struct Fixture {
        conn: Mutex<Connection>,
        root_id: String,
        target_a: String,
        remote_state: Arc<Mutex<FakeState>>,
    }

    fn activate(conn: &Mutex<Connection>, url: &str, username: &str, epoch: u64) -> String {
        let normalized_url = sync_targets::normalize_url(url).unwrap();
        let id = sync_targets::target_id(&normalized_url, username);
        let target = SyncTarget {
            id: id.clone(),
            normalized_url,
            username: username.to_string(),
            created_at: CREATED.to_string(),
            last_activated_at: CREATED.to_string(),
        };
        set_setting_tx(
            &conn.lock().unwrap(),
            REGISTRY_KEY,
            &serde_json::to_string(&SyncTargetRegistry {
                version: 1,
                active_target_id: Some(id.clone()),
                target_epoch: epoch,
                targets: vec![target],
            })
            .unwrap(),
        )
        .unwrap();
        id
    }

    fn fixture() -> Fixture {
        fixture_from_connection(Mutex::new(Connection::open_in_memory().unwrap()))
    }

    fn fixture_from_connection(conn: Mutex<Connection>) -> Fixture {
        crate::db::setup_db(&conn.lock().unwrap()).unwrap();
        let target_a = activate(&conn, "https://dav.example.test/a/", "alice", 1);
        crate::db::insert_record(
            &conn.lock().unwrap(),
            crate::models::WatchRecord {
                id: "record-1".into(),
                original_name: "Original".into(),
                chinese_name: "".into(),
                progress: "".into(),
                total_episodes: Some(1),
                episode_tracking_enabled: false,
                next_episode: None,
                movie_progress: None,
                movie_duration: None,
                release_year: None,
                poster_path: None,
                status: crate::models::RecordStatus::Unwatched,
                platform: "".into(),
                rating: None,
                start_date: None,
                end_date: None,
                notes: "".into(),
                created_at: CREATED.into(),
                updated_at: None,
                imdb_id: None,
                is_locked: None,
                genres: None,
                origin_country: None,
                imdb_rating: None,
                tmdb_status: None,
                interest_level: None,
                episode_runtime: None,
                media_type: "剧集".into(),
                content_tags: None,
                tmdb_media_kind: None,
                tmdb_id: None,
                tmdb_parent_id: None,
                tmdb_season_number: None,
                series_record_kind: None,
                rev: 0,
                rev_actor: "".into(),
            },
        )
        .unwrap();
        let episode_id =
            crate::s2_lite::canonical::sha256_hex(b"episode-completion:v1\x00record-1\x001");
        conn.lock()
            .unwrap()
            .execute(
                "INSERT INTO episode_completions(
                     id, recordId, episodeNumber, completedAt, createdAt,
                     updatedAt, rev, revActor
                 ) VALUES(?1, 'record-1', 1, NULL, ?2, ?2, 0, '')",
                rusqlite::params![episode_id, CREATED],
            )
            .unwrap();
        let admitted =
            admit_and_capture_migration_v1(&conn, &target_a, 1, MIGRATION, WRITER, CREATED)
                .unwrap();
        Fixture {
            conn,
            root_id: admitted.execution_binding.physical_root_id,
            target_a,
            remote_state: Arc::new(Mutex::new(FakeState::default())),
        }
    }

    fn fixture_with_second_connection() -> (Fixture, Mutex<Connection>) {
        let path = std::env::temp_dir().join(format!(
            "watchtracker-bootstrap-production-{}.db",
            uuid::Uuid::new_v4()
        ));
        let fixture = fixture_from_connection(Mutex::new(Connection::open(&path).unwrap()));
        let second = Connection::open(path).unwrap();
        second.pragma_update(None, "foreign_keys", "ON").unwrap();
        (fixture, Mutex::new(second))
    }

    fn task(fixture: &Fixture) -> super::super::migration_orchestration::MigrationCommitTaskV1 {
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id).unwrap();
        let state = MigrationStateStoreV1::load(&mut store, &fixture.root_id)
            .unwrap()
            .unwrap();
        state.stage_a[0].clone()
    }

    fn run(fixture: &Fixture) -> BootstrapExecutionResultV1 {
        run_result(fixture).unwrap()
    }

    fn run_result(fixture: &Fixture) -> Result<BootstrapExecutionResultV1> {
        let fake = FakeRemote {
            root_id: fixture.root_id.clone(),
            state: fixture.remote_state.clone(),
        };
        execute_production_bootstrap_with_factory_v1(
            &fixture.conn,
            &RootExecutionCoordinatorV1::default(),
            |binding| {
                assert_eq!(binding.target_id, fixture.target_a);
                Ok(Some(HistoricalWebDavCredentialsV1 {
                    canonical_url: binding.canonical_url.clone(),
                    username: binding.normalized_account.clone(),
                    password: "historical-a".into(),
                }))
            },
            |_, _| Ok(fake),
            CREATED,
        )
    }

    fn activation_state(
        fixture: &Fixture,
    ) -> super::super::migration_orchestration::MigrationStateV1 {
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id).unwrap();
        MigrationStateStoreV1::load(&mut store, &fixture.root_id)
            .unwrap()
            .unwrap()
    }

    fn migration_fingerprint(fixture: &Fixture) -> String {
        activation_state(fixture)
            .snapshot
            .unwrap()
            .legacy_fingerprint
    }

    fn complete_stage_b(fixture: &Fixture) {
        assert_eq!(run(fixture), BootstrapExecutionResultV1::Progressed);
        assert_eq!(run(fixture), BootstrapExecutionResultV1::Progressed);
        assert_eq!(run(fixture), BootstrapExecutionResultV1::BootstrapComplete);
        assert_eq!(
            activation_state(fixture).status,
            MigrationStatusV1::StageBComplete
        );
    }

    fn run_activation(fixture: &Fixture) -> ActivationExecutionResultV1 {
        run_activation_result(fixture).unwrap()
    }

    fn run_activation_result(fixture: &Fixture) -> Result<ActivationExecutionResultV1> {
        let fake = FakeRemote {
            root_id: fixture.root_id.clone(),
            state: fixture.remote_state.clone(),
        };
        execute_production_activation_with_factory_v1(
            &fixture.conn,
            &RootExecutionCoordinatorV1::default(),
            |binding| {
                assert_eq!(binding.target_id, fixture.target_a);
                Ok(Some(HistoricalWebDavCredentialsV1 {
                    canonical_url: binding.canonical_url.clone(),
                    username: binding.normalized_account.clone(),
                    password: "historical-a".into(),
                }))
            },
            |_, _| Ok(fake),
            CREATED,
        )
    }

    /// Reproduces the precise crash boundary after the exact prepared intent
    /// and its verified receipt have committed, but before migration-state CAS
    /// attaches that receipt to the Stage A task.
    fn persist_receipt_before_task_state_cas(
        fixture: &Fixture,
    ) -> super::super::migration_orchestration::MigrationCommitTaskV1 {
        fixture
            .remote_state
            .lock()
            .unwrap()
            .scripted_gets
            .push_back(RemoteExactGetResultV1::Indeterminate);
        assert_eq!(run(fixture), BootstrapExecutionResultV1::Progressed);
        let task = task(fixture);
        assert!(task.receipt.is_none());
        let mut remote = FakeRemote {
            root_id: fixture.root_id.clone(),
            state: fixture.remote_state.clone(),
        };
        remote.state.lock().unwrap().objects.insert(
            task.intent.remote_path.clone(),
            task.intent.exact_bytes.clone(),
        );
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id).unwrap();
        assert!(matches!(
            store
                .verify_and_persist_commit_receipt(&task.intent, &mut remote, CREATED)
                .unwrap(),
            super::super::immutable_publish::RecoverPreparedIntentResultV1::AlreadyPublishedExact(
                _
            )
        ));
        assert!(store
            .load_published_receipt(&task.intent.remote_path)
            .unwrap()
            .is_some());
        let mut migration_store =
            SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id).unwrap();
        let state = MigrationStateStoreV1::load(&mut migration_store, &fixture.root_id)
            .unwrap()
            .unwrap();
        assert!(state.stage_a[0].receipt.is_none());
        task
    }

    #[test]
    fn exact_bootstrap_recovery_publishes_once_receipts_then_advances() {
        let fixture = fixture();
        let task = task(&fixture);
        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Progressed);
        let store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id).unwrap();
        assert!(store
            .load_published_receipt(&task.intent.remote_path)
            .unwrap()
            .is_some());
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 1);
        // Stage A completes before Stage B is admitted. A restart must not
        // republish that completed Stage A task.
        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Progressed);
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 1);
        assert_eq!(run(&fixture), BootstrapExecutionResultV1::BootstrapComplete);
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 2);
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id).unwrap();
        let state = MigrationStateStoreV1::load(&mut store, &fixture.root_id)
            .unwrap()
            .unwrap();
        assert_eq!(state.status, MigrationStatusV1::StageBComplete);
        assert!(state.stage_a.iter().all(|task| task.receipt.is_some()));
        assert!(state.stage_b.iter().all(|task| task.receipt.is_some()));
        assert!(store
            .load_published_activation_receipt(
                &state.activation_intent.as_ref().unwrap().remote_path,
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn preexisting_exact_object_receipts_with_zero_put() {
        let fixture = fixture();
        let task = task(&fixture);
        fixture.remote_state.lock().unwrap().objects.insert(
            task.intent.remote_path.clone(),
            task.intent.exact_bytes.clone(),
        );
        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Progressed);
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 0);
        assert!(SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id)
            .unwrap()
            .load_published_receipt(&task.intent.remote_path)
            .unwrap()
            .is_some());
    }

    #[test]
    fn sqlite_receipt_store_accepts_a_verified_bootstrap_intent() {
        let fixture = fixture();
        let task = task(&fixture);
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id).unwrap();
        super::super::immutable_publish::PreparedIntentStoreV1::persist(&mut store, &task.intent)
            .unwrap();
        let mut remote = FakeRemote {
            root_id: fixture.root_id.clone(),
            state: fixture.remote_state.clone(),
        };
        remote.state.lock().unwrap().objects.insert(
            task.intent.remote_path.clone(),
            task.intent.exact_bytes.clone(),
        );
        assert!(matches!(
            store
                .verify_and_persist_commit_receipt(&task.intent, &mut remote, CREATED)
                .unwrap(),
            super::super::immutable_publish::RecoverPreparedIntentResultV1::AlreadyPublishedExact(
                _
            )
        ));
    }

    #[test]
    fn uncertain_get_and_response_loss_never_duplicate_a_bootstrap_put() {
        let fixture = fixture();
        fixture
            .remote_state
            .lock()
            .unwrap()
            .scripted_gets
            .push_back(RemoteExactGetResultV1::Indeterminate);
        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Progressed);
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 0);

        let task = task(&fixture);
        let mut state = fixture.remote_state.lock().unwrap();
        state
            .scripted_gets
            .push_back(RemoteExactGetResultV1::DefinitelyAbsent);
        state
            .scripted_gets
            .push_back(RemoteExactGetResultV1::Indeterminate);
        drop(state);
        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Pending);
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 1);
        assert!(SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id)
            .unwrap()
            .load_published_receipt(&task.intent.remote_path)
            .unwrap()
            .is_none());
        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Progressed);
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 1);
    }

    #[test]
    fn durable_receipt_before_state_cas_survives_absent_restart_without_network() {
        let fixture = fixture();
        let task = persist_receipt_before_task_state_cas(&fixture);
        let mut remote = fixture.remote_state.lock().unwrap();
        remote.objects.clear();
        remote
            .scripted_gets
            .push_back(RemoteExactGetResultV1::DefinitelyAbsent);
        remote.get_calls = 0;
        remote.put_calls = 0;
        drop(remote);

        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Progressed);
        let remote = fixture.remote_state.lock().unwrap();
        assert_eq!(remote.get_calls, 0);
        assert_eq!(remote.put_calls, 0);
        drop(remote);
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id).unwrap();
        let state = MigrationStateStoreV1::load(&mut store, &fixture.root_id)
            .unwrap()
            .unwrap();
        assert_eq!(state.status, MigrationStatusV1::StageAComplete);
        assert_eq!(
            state.stage_a[0].receipt.as_ref(),
            store
                .load_published_receipt(&task.intent.remote_path)
                .unwrap()
                .as_ref()
        );
    }

    #[test]
    fn durable_receipt_before_state_cas_survives_indeterminate_restart_without_network() {
        let fixture = fixture();
        let task = persist_receipt_before_task_state_cas(&fixture);
        let mut remote = fixture.remote_state.lock().unwrap();
        remote
            .scripted_gets
            .push_back(RemoteExactGetResultV1::Indeterminate);
        remote.get_calls = 0;
        remote.put_calls = 0;
        drop(remote);

        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Progressed);
        let remote = fixture.remote_state.lock().unwrap();
        assert_eq!(remote.get_calls, 0);
        assert_eq!(remote.put_calls, 0);
        drop(remote);
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id).unwrap();
        let state = MigrationStateStoreV1::load(&mut store, &fixture.root_id)
            .unwrap()
            .unwrap();
        assert_eq!(state.status, MigrationStatusV1::StageAComplete);
        assert_eq!(
            state.stage_a[0].receipt.as_ref(),
            store
                .load_published_receipt(&task.intent.remote_path)
                .unwrap()
                .as_ref()
        );
    }

    #[test]
    fn corrupted_durable_receipt_fails_closed_before_network_recovery() {
        let fixture = fixture();
        fixture
            .remote_state
            .lock()
            .unwrap()
            .scripted_gets
            .push_back(RemoteExactGetResultV1::Indeterminate);
        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Progressed);
        let task = task(&fixture);
        fixture
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO s2_lite_published_receipt_v1(
                     root_id, receipt_kind, remote_path, receipt_json
                 ) VALUES(?1, 'commit', ?2, ?3)",
                rusqlite::params![
                    fixture.root_id,
                    task.intent.remote_path,
                    b"corrupt".to_vec()
                ],
            )
            .unwrap();
        let mut remote = fixture.remote_state.lock().unwrap();
        remote.get_calls = 0;
        remote.put_calls = 0;
        drop(remote);

        assert!(run_result(&fixture).is_err());
        let remote = fixture.remote_state.lock().unwrap();
        assert_eq!(remote.get_calls, 0);
        assert_eq!(remote.put_calls, 0);
    }

    #[test]
    fn indeterminate_without_receipt_or_semantic_advance_is_pending() {
        let fixture = fixture();
        fixture
            .remote_state
            .lock()
            .unwrap()
            .scripted_gets
            .push_back(RemoteExactGetResultV1::Indeterminate);
        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Progressed);
        let before = task(&fixture);
        let mut remote = fixture.remote_state.lock().unwrap();
        remote
            .scripted_gets
            .push_back(RemoteExactGetResultV1::Indeterminate);
        remote.put_calls = 0;
        drop(remote);

        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Pending);
        let after = task(&fixture);
        assert_eq!(after.receipt, None);
        assert_eq!(after, before);
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 0);
    }

    #[test]
    fn mismatch_or_second_connection_fatal_make_zero_puts() {
        let mismatch_fixture = fixture();
        let task = task(&mismatch_fixture);
        mismatch_fixture
            .remote_state
            .lock()
            .unwrap()
            .objects
            .insert(task.intent.remote_path.clone(), b"wrong".to_vec());
        assert_eq!(
            run(&mismatch_fixture),
            BootstrapExecutionResultV1::RootFrozen
        );
        assert_eq!(mismatch_fixture.remote_state.lock().unwrap().put_calls, 0);

        let (fixture, second_connection) = fixture_with_second_connection();
        let mut second = SqliteS2LiteStoreV1::open(&second_connection, &fixture.root_id).unwrap();
        MigrationStateStoreV1::persist_root_fatal(
            &mut second,
            &fixture.root_id,
            "SYNC_ROOT_FROZEN_SECOND_CONNECTION",
        )
        .unwrap();
        assert_eq!(run(&fixture), BootstrapExecutionResultV1::RootFrozen);
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 0);
    }

    #[test]
    fn target_switch_and_missing_historical_credentials_never_retarget() {
        let fixture = fixture();
        let target_b = activate(&fixture.conn, "https://dav.example.test/b/", "bob", 2);
        let fake = FakeRemote {
            root_id: fixture.root_id.clone(),
            state: fixture.remote_state.clone(),
        };
        assert_eq!(
            execute_production_bootstrap_with_factory_v1(
                &fixture.conn,
                &RootExecutionCoordinatorV1::default(),
                |binding| {
                    assert_eq!(binding.target_id, fixture.target_a);
                    assert_ne!(binding.target_id, target_b);
                    Ok(None)
                },
                |_, _| Ok(fake),
                CREATED,
            )
            .unwrap(),
            BootstrapExecutionResultV1::Pending
        );
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 0);
    }

    #[test]
    fn activation_freezes_before_network_and_response_loss_recovers_exactly() {
        let fixture = fixture();
        complete_stage_b(&fixture);
        let puts_before = fixture.remote_state.lock().unwrap().put_calls;
        assert_eq!(
            run_activation(&fixture),
            ActivationExecutionResultV1::Progressed
        );
        let state = activation_state(&fixture);
        assert_eq!(state.status, MigrationStatusV1::ActivationPublishing);
        let intent = state.activation_intent.unwrap();
        assert!(SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id)
            .unwrap()
            .load_prepared_activation_intent(&intent.remote_path)
            .unwrap()
            .is_none());

        let mut remote = fixture.remote_state.lock().unwrap();
        remote
            .scripted_gets
            .push_back(RemoteExactGetResultV1::DefinitelyAbsent);
        remote
            .scripted_gets
            .push_back(RemoteExactGetResultV1::Indeterminate);
        drop(remote);
        assert_eq!(
            run_activation(&fixture),
            ActivationExecutionResultV1::Pending
        );
        let store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id).unwrap();
        let frozen = store
            .load_prepared_activation_intent(&intent.remote_path)
            .unwrap()
            .unwrap();
        assert_eq!(frozen, intent);
        assert_eq!(
            fixture.remote_state.lock().unwrap().put_calls,
            puts_before + 1
        );

        assert_eq!(
            run_activation(&fixture),
            ActivationExecutionResultV1::ActivationVerified
        );
        assert_eq!(
            fixture.remote_state.lock().unwrap().put_calls,
            puts_before + 1
        );
        let state = activation_state(&fixture);
        assert_eq!(state.status, MigrationStatusV1::ActivationVerified);
        assert_eq!(state.activation_intent.unwrap(), frozen);
        assert!(state.activation_receipt.is_some());
    }

    #[test]
    fn activation_incomplete_or_indeterminate_is_pending_without_put() {
        let fixture = fixture();
        assert_eq!(
            run_activation(&fixture),
            ActivationExecutionResultV1::Pending
        );
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 0);
        complete_stage_b(&fixture);
        assert_eq!(
            run_activation(&fixture),
            ActivationExecutionResultV1::Progressed
        );
        fixture
            .remote_state
            .lock()
            .unwrap()
            .scripted_gets
            .push_back(RemoteExactGetResultV1::Indeterminate);
        let puts_before = fixture.remote_state.lock().unwrap().put_calls;
        assert_eq!(
            run_activation(&fixture),
            ActivationExecutionResultV1::Pending
        );
        let state = activation_state(&fixture);
        assert_eq!(state.status, MigrationStatusV1::ActivationPublishing);
        assert!(state.activation_receipt.is_none());
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, puts_before);
    }

    #[test]
    fn activation_exact_existing_and_mismatch_have_no_replacement_put() {
        let exact = fixture();
        complete_stage_b(&exact);
        assert_eq!(
            run_activation(&exact),
            ActivationExecutionResultV1::Progressed
        );
        let intent = activation_state(&exact).activation_intent.unwrap();
        exact
            .remote_state
            .lock()
            .unwrap()
            .objects
            .insert(intent.remote_path.clone(), intent.exact_bytes.clone());
        let puts_before = exact.remote_state.lock().unwrap().put_calls;
        assert_eq!(
            run_activation(&exact),
            ActivationExecutionResultV1::ActivationVerified
        );
        assert_eq!(exact.remote_state.lock().unwrap().put_calls, puts_before);

        let mismatch = fixture();
        complete_stage_b(&mismatch);
        assert_eq!(
            run_activation(&mismatch),
            ActivationExecutionResultV1::Progressed
        );
        let intent = activation_state(&mismatch).activation_intent.unwrap();
        mismatch
            .remote_state
            .lock()
            .unwrap()
            .objects
            .insert(intent.remote_path, b"wrong activation".to_vec());
        let puts_before = mismatch.remote_state.lock().unwrap().put_calls;
        assert_eq!(
            run_activation(&mismatch),
            ActivationExecutionResultV1::RootFrozen
        );
        assert_eq!(mismatch.remote_state.lock().unwrap().put_calls, puts_before);
    }

    #[test]
    fn activation_durable_receipt_crash_reuses_receipt_before_any_network() {
        let fixture = fixture();
        complete_stage_b(&fixture);
        assert_eq!(
            run_activation(&fixture),
            ActivationExecutionResultV1::Progressed
        );
        let intent = activation_state(&fixture).activation_intent.unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&fixture.conn, &fixture.root_id).unwrap();
        super::super::immutable_publish::PreparedActivationIntentStoreV1::persist(
            &mut store, &intent,
        )
        .unwrap();
        let mut remote = FakeRemote {
            root_id: fixture.root_id.clone(),
            state: fixture.remote_state.clone(),
        };
        remote
            .state
            .lock()
            .unwrap()
            .objects
            .insert(intent.remote_path.clone(), intent.exact_bytes.clone());
        assert!(matches!(
            store
                .verify_and_persist_activation_receipt(&intent, &mut remote, CREATED)
                .unwrap(),
            super::super::immutable_publish::RecoverActivationIntentResultV1::AlreadyPublishedExact(
                _
            )
        ));
        assert!(activation_state(&fixture).activation_receipt.is_none());
        let mut remote = fixture.remote_state.lock().unwrap();
        remote.objects.clear();
        remote
            .scripted_gets
            .push_back(RemoteExactGetResultV1::DefinitelyAbsent);
        remote.get_calls = 0;
        remote.put_calls = 0;
        drop(remote);

        assert_eq!(
            run_activation(&fixture),
            ActivationExecutionResultV1::ActivationVerified
        );
        let remote = fixture.remote_state.lock().unwrap();
        assert_eq!(remote.get_calls, 0);
        assert_eq!(remote.put_calls, 0);
        assert!(activation_state(&fixture).activation_receipt.is_some());
    }

    #[test]
    fn verified_third_party_activation_skips_local_put_but_incompatible_evidence_freezes() {
        let compatible = fixture();
        complete_stage_b(&compatible);
        let fingerprint = migration_fingerprint(&compatible);
        let mut cutover = super::super::activation_cutover::create_activation_cutover_state_v1();
        cutover.remote_s2_activated = true;
        cutover.verified_activation_evidence.push(
            super::super::activation_cutover::VerifiedActivationEvidenceV1 {
                path: "activations/third-party.json".into(),
                activation_id: "92000000-0000-4000-8000-000000000001".into(),
                content_hash: "a".repeat(64),
                exact_bytes_hash: "a".repeat(64),
                legacy_fingerprint: Some(fingerprint.clone()),
            },
        );
        cutover.fingerprint_consistency = ActivationFingerprintConsistencyV1::Consistent {
            legacy_fingerprint: Some(fingerprint),
        };
        let mut store = SqliteS2LiteStoreV1::open(&compatible.conn, &compatible.root_id).unwrap();
        MigrationStateStoreV1::persist_cutover_state(&mut store, &compatible.root_id, &cutover)
            .unwrap();
        assert_eq!(
            run_activation(&compatible),
            ActivationExecutionResultV1::AlreadyVerifiedRemotely
        );
        assert_eq!(compatible.remote_state.lock().unwrap().put_calls, 2);

        let incompatible = fixture();
        complete_stage_b(&incompatible);
        let mut cutover = super::super::activation_cutover::create_activation_cutover_state_v1();
        cutover.remote_s2_activated = true;
        cutover.verified_activation_evidence.push(
            super::super::activation_cutover::VerifiedActivationEvidenceV1 {
                path: "activations/incompatible.json".into(),
                activation_id: "93000000-0000-4000-8000-000000000001".into(),
                content_hash: "b".repeat(64),
                exact_bytes_hash: "b".repeat(64),
                legacy_fingerprint: Some("f".repeat(64)),
            },
        );
        cutover.fingerprint_consistency = ActivationFingerprintConsistencyV1::Consistent {
            legacy_fingerprint: Some("f".repeat(64)),
        };
        let mut store =
            SqliteS2LiteStoreV1::open(&incompatible.conn, &incompatible.root_id).unwrap();
        MigrationStateStoreV1::persist_cutover_state(&mut store, &incompatible.root_id, &cutover)
            .unwrap();
        assert_eq!(
            run_activation(&incompatible),
            ActivationExecutionResultV1::RootFrozen
        );
        assert_eq!(incompatible.remote_state.lock().unwrap().put_calls, 2);
    }

    #[test]
    fn activation_historical_target_and_fatal_first_never_put() {
        let fixture = fixture();
        complete_stage_b(&fixture);
        let target_b = activate(&fixture.conn, "https://dav.example.test/b/", "bob", 2);
        let fake = FakeRemote {
            root_id: fixture.root_id.clone(),
            state: fixture.remote_state.clone(),
        };
        assert_eq!(
            execute_production_activation_with_factory_v1(
                &fixture.conn,
                &RootExecutionCoordinatorV1::default(),
                |binding| {
                    assert_eq!(binding.target_id, fixture.target_a);
                    assert_ne!(binding.target_id, target_b);
                    Ok(None)
                },
                |_, _| Ok(fake),
                CREATED,
            )
            .unwrap(),
            ActivationExecutionResultV1::Pending
        );
        assert_eq!(fixture.remote_state.lock().unwrap().put_calls, 2);

        let (fatal, second) = fixture_with_second_connection();
        complete_stage_b(&fatal);
        assert_eq!(
            run_activation(&fatal),
            ActivationExecutionResultV1::Progressed
        );
        let mut store = SqliteS2LiteStoreV1::open(&second, &fatal.root_id).unwrap();
        MigrationStateStoreV1::persist_root_fatal(
            &mut store,
            &fatal.root_id,
            "SYNC_ROOT_FROZEN_SECOND_CONNECTION",
        )
        .unwrap();
        assert_eq!(
            run_activation(&fatal),
            ActivationExecutionResultV1::RootFrozen
        );
        assert_eq!(fatal.remote_state.lock().unwrap().put_calls, 2);
    }

    #[test]
    fn corrupted_durable_activation_receipt_fails_before_network_recovery() {
        let fixture = fixture();
        complete_stage_b(&fixture);
        assert_eq!(
            run_activation(&fixture),
            ActivationExecutionResultV1::Progressed
        );
        fixture
            .remote_state
            .lock()
            .unwrap()
            .scripted_gets
            .push_back(RemoteExactGetResultV1::Indeterminate);
        assert_eq!(
            run_activation(&fixture),
            ActivationExecutionResultV1::Pending
        );
        let intent = activation_state(&fixture).activation_intent.unwrap();
        fixture
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO s2_lite_published_receipt_v1(
                     root_id, receipt_kind, remote_path, receipt_json
                 ) VALUES(?1, 'activation', ?2, ?3)",
                rusqlite::params![
                    fixture.root_id,
                    intent.remote_path,
                    b"corrupt activation receipt".to_vec()
                ],
            )
            .unwrap();
        let mut remote = fixture.remote_state.lock().unwrap();
        remote.get_calls = 0;
        remote.put_calls = 0;
        drop(remote);

        assert!(run_activation_result(&fixture).is_err());
        let remote = fixture.remote_state.lock().unwrap();
        assert_eq!(remote.get_calls, 0);
        assert_eq!(remote.put_calls, 0);
    }
}
