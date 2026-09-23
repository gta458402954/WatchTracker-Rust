use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::db_atomic_helpers::set_setting_tx;
use base64::Engine;
use rusqlite::Connection;

use super::desktop_lifecycle::{
    run_desktop_s2_sync_execution_v1, DesktopS2LifecycleResultV1, DesktopS2RootBindingV1,
};
use super::durable_persistence::{
    DesktopRootStateV1, MigrationExecutionBindingV1, OutboundBatchMutationV1, OutboundBatchV1,
    SqliteS2LiteStoreV1,
};
use super::immutable_publish::{
    prepare_activation_intent_v1, prepare_commit_intent_v1, ImmutableObjectRemoteV1,
    PreparedActivationIntentStoreV1, PreparedIntentStoreV1, RemoteExactGetResultV1,
    RemotePutResultV1,
};
use super::migration_orchestration::MigrationStateStoreV1;
use super::remote_discovery::{
    DirectoryListResultV1, DiscoveryBudgetsV1, DiscoveryExactGetResultV1, DiscoveryRemoteV1,
};
use super::root_coordinator::RootExecutionCoordinatorV1;
use super::target_root_binding::resolve_active_target_root_binding_v1;
use crate::sync_targets::{self, SyncTarget, SyncTargetRegistry, REGISTRY_KEY};

const ROOT: &str = "s2-root-v1:lifecycle-test";
const VERIFIED_AT: &str = "2026-09-08T05:00:00.000Z";

struct FakeRemote {
    objects: BTreeMap<String, Vec<u8>>,
    listings: BTreeMap<String, Vec<String>>,
    put_calls: usize,
    root_id: String,
}

impl Default for FakeRemote {
    fn default() -> Self {
        Self {
            objects: BTreeMap::new(),
            listings: BTreeMap::new(),
            put_calls: 0,
            root_id: ROOT.to_string(),
        }
    }
}

impl ImmutableObjectRemoteV1 for FakeRemote {
    fn physical_root_id(&self) -> Option<&str> {
        Some(&self.root_id)
    }
    fn execution_context_identity(&self) -> u64 {
        7
    }
    fn get_exact(&mut self, path: &str) -> RemoteExactGetResultV1 {
        self.objects.get(path).cloned().map_or(
            RemoteExactGetResultV1::DefinitelyAbsent,
            RemoteExactGetResultV1::DefinitelyPresent,
        )
    }
    fn put_exact(&mut self, path: &str, bytes: &[u8], _: bool) -> RemotePutResultV1 {
        self.put_calls += 1;
        self.objects.insert(path.to_string(), bytes.to_vec());
        RemotePutResultV1::Indeterminate
    }
}

impl DiscoveryRemoteV1 for FakeRemote {
    fn list_directory(&mut self, path: &str) -> DirectoryListResultV1 {
        DirectoryListResultV1::Entries(self.listings.get(path).cloned().unwrap_or_default())
    }
    fn get_exact(&mut self, path: &str) -> DiscoveryExactGetResultV1 {
        match ImmutableObjectRemoteV1::get_exact(self, path) {
            RemoteExactGetResultV1::DefinitelyPresent(bytes) => {
                DiscoveryExactGetResultV1::DefinitelyPresent(bytes)
            }
            RemoteExactGetResultV1::DefinitelyAbsent => DiscoveryExactGetResultV1::DefinitelyAbsent,
            RemoteExactGetResultV1::Indeterminate => DiscoveryExactGetResultV1::Indeterminate,
            RemoteExactGetResultV1::AuthOrCapabilityFailure => {
                DiscoveryExactGetResultV1::AuthOrCapabilityFailure
            }
        }
    }
}

fn connection() -> Mutex<Connection> {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .unwrap();
    Mutex::new(conn)
}

fn binding() -> DesktopS2RootBindingV1 {
    DesktopS2RootBindingV1 {
        target_id: "target".into(),
        target_epoch: 1,
        physical_root_id: ROOT.into(),
        canonical_url: "https://dav.example.test/root/".into(),
        account: "Alice".into(),
        remote_identity: 7,
    }
}

fn activate_target(conn: &Mutex<Connection>, url: &str, username: &str, epoch: u64) -> SyncTarget {
    let normalized_url = sync_targets::normalize_url(url).unwrap();
    let target = SyncTarget {
        id: sync_targets::target_id(&normalized_url, username),
        normalized_url,
        username: username.to_string(),
        created_at: VERIFIED_AT.to_string(),
        last_activated_at: VERIFIED_AT.to_string(),
    };
    set_setting_tx(
        &conn.lock().unwrap(),
        REGISTRY_KEY,
        &serde_json::to_string(&SyncTargetRegistry {
            version: 1,
            active_target_id: Some(target.id.clone()),
            target_epoch: epoch,
            targets: vec![target.clone()],
        })
        .unwrap(),
    )
    .unwrap();
    target
}

fn activation_bytes(activation_id: &str, legacy_fingerprint: Option<&str>) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "activationId": activation_id,
        "legacyFingerprint": legacy_fingerprint,
        "protocol": "watchtracker-s2-lite",
        "protocolVersion": 1,
        "requiredFeatures": [],
        "s2SemanticProfileVersion": 1,
    }))
    .unwrap()
}

fn prepared() -> super::immutable_publish::PreparedIntentV1 {
    let fixture: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/s2-lite/v1/publish-golden-v1.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            fixture["preparedIntent"]["exactBytesBase64"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
    prepare_commit_intent_v1(
        &bytes,
        fixture["preparedIntent"]["createdLocallyAtDiagnostic"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn restart_recovers_durable_intent_before_any_successor_publication() {
    let conn = connection();
    let coordinator = RootExecutionCoordinatorV1::default();
    let intent = prepared();
    let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
    PreparedIntentStoreV1::persist(&mut store, &intent).unwrap();
    let mut remote = FakeRemote::default();
    remote
        .objects
        .insert(intent.remote_path.clone(), intent.exact_bytes.clone());
    let result = run_desktop_s2_sync_execution_v1(
        &conn,
        &coordinator,
        &binding(),
        &mut remote,
        || true,
        || false,
        None,
        &DiscoveryBudgetsV1::default(),
        VERIFIED_AT,
    )
    .unwrap();
    assert_eq!(result, DesktopS2LifecycleResultV1::SuccessNoOp);
    let store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
    assert!(store
        .load_published_receipt(&intent.remote_path)
        .unwrap()
        .is_some());
    assert_eq!(remote.put_calls, 0);
}

#[test]
fn target_change_and_safe_cancellation_happen_before_network_work() {
    let conn = connection();
    let coordinator = RootExecutionCoordinatorV1::default();
    let mut remote = FakeRemote::default();
    assert_eq!(
        run_desktop_s2_sync_execution_v1(
            &conn,
            &coordinator,
            &binding(),
            &mut remote,
            || false,
            || false,
            None,
            &DiscoveryBudgetsV1::default(),
            VERIFIED_AT
        )
        .unwrap(),
        DesktopS2LifecycleResultV1::TargetChanged
    );
    assert_eq!(
        run_desktop_s2_sync_execution_v1(
            &conn,
            &coordinator,
            &binding(),
            &mut remote,
            || true,
            || true,
            None,
            &DiscoveryBudgetsV1::default(),
            VERIFIED_AT
        )
        .unwrap(),
        DesktopS2LifecycleResultV1::CancelledAtSafeBoundary
    );
    assert_eq!(remote.put_calls, 0);
}

#[test]
fn lost_put_response_is_verified_and_receipted_before_restart_bookkeeping() {
    let conn = connection();
    let coordinator = RootExecutionCoordinatorV1::default();
    let intent = prepared();
    let mut remote = FakeRemote::default();
    let result = run_desktop_s2_sync_execution_v1(
        &conn,
        &coordinator,
        &binding(),
        &mut remote,
        || true,
        || false,
        Some(intent.clone()),
        &DiscoveryBudgetsV1::default(),
        VERIFIED_AT,
    )
    .unwrap();
    assert_eq!(result, DesktopS2LifecycleResultV1::SuccessSynced);
    let store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
    assert!(store
        .load_prepared_intent(&intent.remote_path)
        .unwrap()
        .is_some());
    assert!(store
        .load_published_receipt(&intent.remote_path)
        .unwrap()
        .is_some());
    assert_eq!(remote.put_calls, 1);
}

#[test]
fn root_fatal_latch_blocks_new_publication_but_keeps_discovery_read_only() {
    let conn = connection();
    let coordinator = RootExecutionCoordinatorV1::default();
    let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
    super::migration_orchestration::MigrationStateStoreV1::persist_root_fatal(
        &mut store,
        ROOT,
        "SYNC_ROOT_FROZEN_CORRUPTION",
    )
    .unwrap();
    let mut remote = FakeRemote::default();
    let result = run_desktop_s2_sync_execution_v1(
        &conn,
        &coordinator,
        &binding(),
        &mut remote,
        || true,
        || false,
        Some(prepared()),
        &DiscoveryBudgetsV1::default(),
        VERIFIED_AT,
    )
    .unwrap();
    assert_eq!(result, DesktopS2LifecycleResultV1::RootFrozen);
    assert_eq!(remote.put_calls, 0);
}

#[test]
fn root_fatal_latch_blocks_retry_of_an_already_prepared_intent() {
    let conn = connection();
    let coordinator = RootExecutionCoordinatorV1::default();
    let intent = prepared();
    let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
    PreparedIntentStoreV1::persist(&mut store, &intent).unwrap();
    super::migration_orchestration::MigrationStateStoreV1::persist_root_fatal(
        &mut store,
        ROOT,
        "SYNC_ROOT_FROZEN_CORRUPTION",
    )
    .unwrap();
    let mut remote = FakeRemote::default();
    let result = run_desktop_s2_sync_execution_v1(
        &conn,
        &coordinator,
        &binding(),
        &mut remote,
        || true,
        || false,
        None,
        &DiscoveryBudgetsV1::default(),
        VERIFIED_AT,
    )
    .unwrap();
    assert_eq!(result, DesktopS2LifecycleResultV1::RootFrozen);
    assert_eq!(remote.put_calls, 0);
    assert!(SqliteS2LiteStoreV1::open(&conn, ROOT)
        .unwrap()
        .load_prepared_intent(&intent.remote_path)
        .unwrap()
        .is_some());
}

#[test]
fn local_batch_and_exact_intent_are_durably_bound_before_publication() {
    let conn = connection();
    let intent = prepared();
    let commit = super::causal::decode_frozen_wire_commit_v1(&intent.exact_bytes).unwrap();
    let batch = OutboundBatchV1 {
        state_version: 1,
        batch_id: "30000000-0000-4000-8000-000000000001".into(),
        physical_root_id: ROOT.into(),
        captured_local_generation: 7,
        mutations: vec![OutboundBatchMutationV1 {
            entity_kind: "episode-completion".into(),
            entity_id: "completion".into(),
            entity_key: serde_json::json!(["episode-completion", "record", 1]),
            captured_last_generation: 7,
            local_mutation_id: "30000000-0000-4000-8000-000000000002".into(),
        }],
        target_id: "target".into(),
        target_epoch: 1,
        projection_generation: 1,
        source_discovery_generation: 1,
        source_root_safety_generation: 0,
        basis_clock: commit.basis_clock.clone(),
        writer_id: commit.writer_id.clone(),
        writer_sequence: commit.writer_seq.parse().unwrap(),
        previous_writer_ref: commit.previous_writer_commit.clone(),
        commit_ref: commit.commit_ref(),
        prepared_intent_path: intent.remote_path.clone(),
        prepared_intent_fingerprint: intent.intent_fingerprint.clone(),
        state: "frozen".into(),
        bookkeeping_completed: false,
        bookkeeping_generation: 0,
    };
    let root_state = DesktopRootStateV1 {
        state_version: 1,
        physical_root_id: ROOT.into(),
        local_writer_id: commit.writer_id,
        next_writer_sequence: batch.writer_sequence + 1,
        writer_head: batch.previous_writer_ref.clone(),
        lifecycle_generation: 0,
        materialized_projection_generation: None,
        business_applied_projection_generation: None,
    };
    let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
    store.persist_desktop_root_state(&root_state).unwrap();
    store
        .persist_outbound_batch_with_intent(&batch, &intent)
        .unwrap();
    assert_eq!(store.load_desktop_root_state().unwrap(), Some(root_state));
    assert_eq!(store.load_unfinished_outbound_batch().unwrap(), Some(batch));
    assert!(store
        .load_prepared_intent(&intent.remote_path)
        .unwrap()
        .is_some());
}

#[test]
fn verified_third_party_activation_latches_cutover_and_blocks_s1_without_a_local_intent() {
    let conn = connection();
    let coordinator = RootExecutionCoordinatorV1::default();
    let activation_id = "10000000-0000-4000-8000-000000000001";
    let bytes = serde_json::to_vec(&serde_json::json!({
        "activationId": activation_id,
        "legacyFingerprint": null,
        "protocol": "watchtracker-s2-lite",
        "protocolVersion": 1,
        "requiredFeatures": [],
        "s2SemanticProfileVersion": 1,
    }))
    .unwrap();
    let path = format!(
        "activations/{activation_id}--{}.json",
        super::canonical::sha256_hex(&bytes)
    );
    let mut remote = FakeRemote::default();
    remote
        .listings
        .insert("activations/".to_string(), vec![path.clone()]);
    remote.objects.insert(path, bytes);
    let _ = run_desktop_s2_sync_execution_v1(
        &conn,
        &coordinator,
        &binding(),
        &mut remote,
        || true,
        || false,
        None,
        &DiscoveryBudgetsV1::default(),
        VERIFIED_AT,
    )
    .unwrap();
    let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
    let safety = MigrationStateStoreV1::load_root_safety(&mut store, ROOT).unwrap();
    assert!(safety.cutover_state.remote_s2_activated);
    let mut puts = 0;
    assert_eq!(
        store
            .run_legacy_s1_publish_exclusive(ROOT, || {
                puts += 1;
                Ok(())
            })
            .unwrap(),
        super::durable_persistence::LegacyS1PublishAdmissionV1::RejectedActivation
    );
    assert_eq!(puts, 0);

    remote.listings.clear();
    remote.objects.clear();
    let _ = run_desktop_s2_sync_execution_v1(
        &conn,
        &coordinator,
        &binding(),
        &mut remote,
        || true,
        || false,
        None,
        &DiscoveryBudgetsV1::default(),
        VERIFIED_AT,
    )
    .unwrap();
    let mut restarted = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
    assert!(
        MigrationStateStoreV1::load_root_safety(&mut restarted, ROOT)
            .unwrap()
            .cutover_state
            .remote_s2_activated
    );
}

#[test]
fn local_activation_intent_alone_does_not_latch_cutover() {
    let conn = connection();
    let activation_id = "10000000-0000-4000-8000-000000000001";
    let bytes = activation_bytes(activation_id, None);
    let intent = prepare_activation_intent_v1(activation_id, &bytes, VERIFIED_AT).unwrap();
    let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
    PreparedActivationIntentStoreV1::persist(&mut store, &intent).unwrap();
    assert!(
        !MigrationStateStoreV1::load_root_safety(&mut store, ROOT)
            .unwrap()
            .cutover_state
            .remote_s2_activated
    );
}

#[test]
fn historical_migration_fingerprint_controls_discovered_activation_compatibility() {
    for (captured, discovered, compatible) in [
        (None, None, true),
        (Some("a".repeat(64)), Some("a".repeat(64)), true),
        (None, Some("a".repeat(64)), false),
        (Some("a".repeat(64)), Some("b".repeat(64)), false),
    ] {
        let conn = connection();
        let target = activate_target(&conn, "https://dav.example.test/migration/", "alice", 1);
        let bound = resolve_active_target_root_binding_v1(&conn, &target.id, 1).unwrap();
        let root = bound.binding.physical_root_id.clone();
        let mut store = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
        store
            .bind_migration_execution_v1(&MigrationExecutionBindingV1 {
                binding_version: 1,
                physical_root_id: root.clone(),
                target_id: target.id.clone(),
                target_epoch: 1,
                captured_records_generation: 0,
                legacy_fingerprint: captured.clone(),
                migration_id: "20000000-0000-4000-8000-000000000001".into(),
            })
            .unwrap();
        // The active target may move after migration admission; cutover must
        // continue to use the immutable A/1 binding above.
        let _target_b = activate_target(&conn, "https://dav.example.test/other/", "bob", 2);
        let activation_id = "10000000-0000-4000-8000-000000000001";
        let bytes = activation_bytes(activation_id, discovered.as_deref());
        let path = format!(
            "activations/{activation_id}--{}.json",
            super::canonical::sha256_hex(&bytes)
        );
        let mut remote = FakeRemote {
            root_id: root.clone(),
            ..Default::default()
        };
        remote
            .listings
            .insert("activations/".to_string(), vec![path.clone()]);
        remote.objects.insert(path, bytes);
        let lifecycle_binding = DesktopS2RootBindingV1 {
            target_id: target.id.clone(),
            target_epoch: 1,
            physical_root_id: root.clone(),
            canonical_url: bound.binding.canonical_url,
            account: bound.binding.normalized_account,
            remote_identity: 7,
        };
        let result = run_desktop_s2_sync_execution_v1(
            &conn,
            &RootExecutionCoordinatorV1::default(),
            &lifecycle_binding,
            &mut remote,
            || true,
            || false,
            None,
            &DiscoveryBudgetsV1::default(),
            VERIFIED_AT,
        )
        .unwrap();
        let safety = MigrationStateStoreV1::load_root_safety(&mut store, &root).unwrap();
        assert_eq!(
            safety.root_fatal_signals.is_empty(),
            compatible,
            "captured={captured:?}, discovered={discovered:?}"
        );
        assert!(safety.cutover_state.remote_s2_activated);
        assert_eq!(
            result == DesktopS2LifecycleResultV1::RootFrozen,
            !compatible
        );
    }
}
