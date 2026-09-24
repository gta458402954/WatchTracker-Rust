//! Production execution and recovery for already-admitted bootstrap work.
//!
//! This is deliberately a narrow adapter around the frozen migration
//! orchestrator. It neither plans migration nor advances into activation: once
//! Stage B is durable, activation remains a later lifecycle responsibility.

use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;

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
    Ok(no_network_result(next.status).unwrap_or(BootstrapExecutionResultV1::Progressed))
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
        .unwrap()
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
        assert_eq!(run(&fixture), BootstrapExecutionResultV1::Progressed);
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
}
