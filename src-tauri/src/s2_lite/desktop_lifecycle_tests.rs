use std::sync::Mutex;
use std::{collections::BTreeMap, fs, path::PathBuf};

use crate::db_atomic_helpers::set_setting_tx;
use base64::Engine;
use rusqlite::Connection;

use super::desktop_lifecycle::{
    route_desktop_sync_v1, route_desktop_sync_with_before_normal_admission_v1,
    run_desktop_s2_sync_execution_v1, DesktopS2LifecycleResultV1, DesktopS2RootBindingV1,
    DesktopSyncRouteV1,
};
use super::durable_persistence::{
    migration_execution_identity_v1, DesktopRootStateV1, IncompatibleActivationFreezeFaultV1,
    MigrationExecutionBindingV1, MigrationFinalizationFaultV1, MigrationFinalizationResultV1,
    OrdinaryPublishExclusiveResultV1, OutboundBatchMutationV1, OutboundBatchV1,
    SqliteS2LiteStoreV1, VersionedDiscoveryStateV1,
};
use super::immutable_publish::{
    prepare_activation_intent_v1, prepare_commit_intent_v1, ImmutableObjectRemoteV1,
    PreparedActivationIntentStoreV1, PreparedIntentStoreV1, PublishedActivationReceiptStoreV1,
    PublishedActivationReceiptV1, PublishedReceiptStoreV1, RemoteExactGetResultV1,
    RemotePublishedReceiptV1, RemotePutResultV1,
};
use super::migration_admission::admit_and_capture_migration_v1;
use super::migration_orchestration::{
    create_activation_publication_execution_capability_v1,
    create_migration_root_execution_capability_v1, execute_migration_step_v1,
    start_or_attach_migration_v1, MigrationStateStoreV1, MigrationStatusV1,
};
use super::remote_discovery::{
    create_discovery_state_v1, DirectoryListResultV1, DiscoveryBudgetsV1,
    DiscoveryExactGetResultV1, DiscoveryRemoteV1, VerifiedFingerprintEvidenceV1,
    VerifiedRemoteObjectV1,
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

#[derive(Default)]
struct ReceiptSinkV1;

impl PublishedReceiptStoreV1 for ReceiptSinkV1 {
    fn persist(&mut self, _: &RemotePublishedReceiptV1) -> super::canonical::Result<()> {
        Ok(())
    }
}

impl PublishedActivationReceiptStoreV1 for ReceiptSinkV1 {
    fn persist(&mut self, _: &PublishedActivationReceiptV1) -> super::canonical::Result<()> {
        Ok(())
    }
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

fn router_connection() -> Mutex<Connection> {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::setup_db(&conn).unwrap();
    Mutex::new(conn)
}

struct TempDatabase {
    path: PathBuf,
}

impl TempDatabase {
    fn new(name: &str) -> Self {
        Self {
            path: std::env::temp_dir().join(format!(
                "watchtracker-desktop-lifecycle-{name}-{}.db",
                uuid::Uuid::new_v4()
            )),
        }
    }

    fn connection(&self) -> Mutex<Connection> {
        let conn = Connection::open(&self.path).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::setup_db(&conn).unwrap();
        Mutex::new(conn)
    }
}

impl Drop for TempDatabase {
    fn drop(&mut self) {
        for path in [
            self.path.clone(),
            PathBuf::from(format!("{}-wal", self.path.display())),
            PathBuf::from(format!("{}-shm", self.path.display())),
        ] {
            let _ = fs::remove_file(path);
        }
    }
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

fn bind_incompatible_migration_and_discovery(
    conn: &Mutex<Connection>,
) -> (String, VersionedDiscoveryStateV1) {
    let target = activate_target(conn, "https://dav.example.test/migration/", "alice", 1);
    let bound = resolve_active_target_root_binding_v1(conn, &target.id, 1).unwrap();
    let root = bound.binding.physical_root_id;
    let migration_id = "20000000-0000-4000-8000-000000000001";
    let writer_id = "30000000-0000-4000-8000-000000000001";
    let mut store = SqliteS2LiteStoreV1::open(conn, &root).unwrap();
    store
        .bind_migration_execution_v1(&MigrationExecutionBindingV1 {
            binding_version: 1,
            physical_root_id: root.clone(),
            target_id: target.id,
            target_epoch: 1,
            captured_records_generation: 0,
            legacy_fingerprint: Some("a".repeat(64)),
            migration_id: migration_id.into(),
        })
        .unwrap();
    let migration = super::migration_orchestration::create_migration_state_v1(
        migration_id,
        &root,
        writer_id,
        VERIFIED_AT,
        "legacy-bootstrap",
    )
    .unwrap();
    MigrationStateStoreV1::claim_or_load(&mut store, &migration).unwrap();

    let activation_id = "10000000-0000-4000-8000-000000000001";
    let bytes = activation_bytes(activation_id, Some(&"b".repeat(64)));
    let hash = super::canonical::sha256_hex(&bytes);
    let mut discovery = create_discovery_state_v1();
    discovery.verified_objects.push(VerifiedRemoteObjectV1 {
        path: format!("activations/{activation_id}--{hash}.json"),
        kind: "activation".into(),
        exact_bytes_hash: hash.clone(),
        exact_bytes_hex: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
        content_hash: hash,
        commit_ref: None,
        activation_id: Some(activation_id.into()),
        fingerprint_evidence: VerifiedFingerprintEvidenceV1::Value {
            value: "b".repeat(64),
        },
    });
    assert!(store
        .compare_and_swap_discovery_state(None, &discovery)
        .unwrap());
    let discovery = store.load_discovery_state().unwrap().unwrap();
    (root, discovery)
}

fn admit_router_migration(conn: &Mutex<Connection>) -> (SyncTarget, String) {
    let target = activate_target(conn, "https://dav.example.test/router-a/", "alice", 1);
    let admitted = admit_and_capture_migration_v1(
        conn,
        &target.id,
        1,
        "40000000-0000-4000-8000-000000000001",
        "41000000-0000-4000-8000-000000000001",
        VERIFIED_AT,
    )
    .unwrap();
    (target, admitted.execution_binding.physical_root_id)
}

fn latch_compatible_router_activation(conn: &Mutex<Connection>) -> String {
    let target = activate_target(conn, "https://dav.example.test/router-normal/", "alice", 1);
    let bound = resolve_active_target_root_binding_v1(conn, &target.id, 1).unwrap();
    let activation_id = "50000000-0000-4000-8000-000000000001";
    let bytes = activation_bytes(activation_id, None);
    let hash = super::canonical::sha256_hex(&bytes);
    let mut discovery = create_discovery_state_v1();
    discovery.verified_objects.push(VerifiedRemoteObjectV1 {
        path: format!("activations/{activation_id}--{hash}.json"),
        kind: "activation".into(),
        exact_bytes_hash: hash.clone(),
        exact_bytes_hex: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
        content_hash: hash,
        commit_ref: None,
        activation_id: Some(activation_id.into()),
        fingerprint_evidence: VerifiedFingerprintEvidenceV1::Null,
    });
    let cutover = super::activation_cutover::recover_activation_cutover_v1(&discovery, None)
        .diagnostic_state()
        .unwrap();
    let mut store = SqliteS2LiteStoreV1::open(conn, &bound.binding.physical_root_id).unwrap();
    MigrationStateStoreV1::persist_cutover_state(
        &mut store,
        &bound.binding.physical_root_id,
        &cutover,
    )
    .unwrap();
    bound.binding.physical_root_id
}

/// Drives an empty, durably admitted bootstrap through verified activation,
/// without entering the local-only finalization transaction.
fn verified_router_migration(conn: &Mutex<Connection>) -> (String, String) {
    let (_target, root) = admit_router_migration(conn);
    let mut remote = FakeRemote {
        root_id: root.clone(),
        ..Default::default()
    };
    let mut state = {
        let mut store = SqliteS2LiteStoreV1::open(conn, &root).unwrap();
        MigrationStateStoreV1::load(&mut store, &root)
            .unwrap()
            .unwrap()
    };
    loop {
        if state.status == MigrationStatusV1::ActivationVerified {
            let mut store = SqliteS2LiteStoreV1::open(conn, &root).unwrap();
            if MigrationStateStoreV1::load_root_safety(&mut store, &root)
                .unwrap()
                .cutover_state
                .remote_s2_activated
            {
                break;
            }
        }
        let mut migration_store = SqliteS2LiteStoreV1::open(conn, &root).unwrap();
        let attachment = start_or_attach_migration_v1(&state, &mut migration_store).unwrap();
        let capability = if state.status == MigrationStatusV1::ActivationPublishing {
            let expected_execution_identity = migration_execution_identity_v1(
                &migration_store
                    .load_migration_execution_binding_v1()
                    .unwrap()
                    .unwrap(),
            );
            create_activation_publication_execution_capability_v1(
                &attachment,
                &remote,
                &migration_store,
                expected_execution_identity,
            )
            .unwrap()
        } else {
            create_migration_root_execution_capability_v1(&attachment, &remote, &migration_store)
                .unwrap()
        };
        let mut intent_store = SqliteS2LiteStoreV1::open(conn, &root).unwrap();
        let mut activation_intent_store = SqliteS2LiteStoreV1::open(conn, &root).unwrap();
        let mut commit_receipts = ReceiptSinkV1;
        let mut activation_receipts = ReceiptSinkV1;
        state = execute_migration_step_v1(
            &state,
            &capability,
            &mut remote,
            &mut migration_store,
            &mut intent_store,
            &mut commit_receipts,
            &mut activation_intent_store,
            &mut activation_receipts,
            VERIFIED_AT,
        )
        .unwrap_or_else(|error| panic!("migration state {:?}: {error:?}", state.status));
    }
    (root, state.writer_id)
}

/// Drives an empty, durably admitted bootstrap through activation. Empty is
/// still a valid migration: the frozen handoff must seed the migration writer
/// with a null head and sequence one rather than allocate a random writer.
fn complete_router_migration(conn: &Mutex<Connection>) -> (String, String) {
    let (root, writer_id) = verified_router_migration(conn);
    let mut store = SqliteS2LiteStoreV1::open(conn, &root).unwrap();
    assert_eq!(
        store.finalize_verified_migration_v1().unwrap(),
        MigrationFinalizationResultV1::Finalized
    );
    (root, writer_id)
}

fn assert_verified_finalization_is_unchanged(conn: &Mutex<Connection>, root: &str) {
    let mut store = SqliteS2LiteStoreV1::open(conn, root).unwrap();
    let migration = MigrationStateStoreV1::load(&mut store, root)
        .unwrap()
        .unwrap();
    assert_eq!(migration.status, MigrationStatusV1::ActivationVerified);
    assert!(store.migration_source_protected_v1().unwrap());
    assert!(store.load_desktop_root_state().unwrap().is_none());
    assert!(
        MigrationStateStoreV1::load_root_safety(&mut store, root)
            .unwrap()
            .cutover_state
            .remote_s2_activated
    );
    let mut puts = 0;
    assert_eq!(
        store
            .run_legacy_s1_publish_exclusive(root, || {
                puts += 1;
                Ok(())
            })
            .unwrap(),
        super::durable_persistence::LegacyS1PublishAdmissionV1::RejectedMigrationSourceProtected
    );
    assert_eq!(puts, 0);

    let guard = conn.lock().unwrap();
    let owner_count: i64 = guard
        .query_row(
            "SELECT COUNT(*) FROM s2_lite_migration_source_owner_v1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let guard_count: i64 = guard
        .query_row(
            "SELECT COUNT(*) FROM s2_lite_migration_source_guard_v1 WHERE root_id=?1",
            [root],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!((owner_count, guard_count), (1, 1));
}

#[test]
fn finalization_faults_rollback_every_cutover_authority_fact() {
    for (name, fault) in [
        (
            "after-migration-complete",
            MigrationFinalizationFaultV1::MigrationCompletePersisted,
        ),
        (
            "after-writer-handoff",
            MigrationFinalizationFaultV1::WriterHandoffPersisted,
        ),
        (
            "after-source-retirement",
            MigrationFinalizationFaultV1::SourceRetired,
        ),
    ] {
        let database = TempDatabase::new(name);
        let connection = database.connection();
        let (root, _) = verified_router_migration(&connection);
        let mut store = SqliteS2LiteStoreV1::open(&connection, &root).unwrap();
        assert!(store
            .finalize_verified_migration_with_injected_fault_v1(fault)
            .is_err());
        // A separate connection proves that no intermediate write became
        // durable before the failed BEGIN IMMEDIATE transaction was dropped.
        let restarted = database.connection();
        assert_verified_finalization_is_unchanged(&restarted, &root);
    }
}

#[test]
fn finalization_rejects_canonical_but_different_source_generation() {
    let database = TempDatabase::new("finalization-source-generation-mismatch");
    let connection = database.connection();
    let (root, _) = verified_router_migration(&connection);
    let mut store = SqliteS2LiteStoreV1::open(&connection, &root).unwrap();
    let before_migration: Vec<u8> = connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT state_json FROM s2_lite_migration_v1 WHERE root_id=?1",
            [&root],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE s2_lite_migration_source_guard_v1
             SET captured_records_generation='1' WHERE root_id=?1",
            [&root],
        )
        .unwrap();

    assert!(store.finalize_verified_migration_v1().is_err());
    let guard = connection.lock().unwrap();
    let after_migration: Vec<u8> = guard
        .query_row(
            "SELECT state_json FROM s2_lite_migration_v1 WHERE root_id=?1",
            [&root],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after_migration, before_migration);
    let owner_count: i64 = guard
        .query_row(
            "SELECT COUNT(*) FROM s2_lite_migration_source_owner_v1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let guard_count: i64 = guard
        .query_row(
            "SELECT COUNT(*) FROM s2_lite_migration_source_guard_v1 WHERE root_id=?1",
            [&root],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!((owner_count, guard_count), (1, 1));
    assert_eq!(
        guard
            .query_row(
                "SELECT COUNT(*) FROM s2_lite_desktop_root_state_v1 WHERE root_id=?1",
                [&root],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    drop(guard);
    // Restart intentionally rejects the inconsistent source authority instead
    // of treating it as absent or silently refreshing its generation.
    let restarted = Mutex::new(Connection::open(&database.path).unwrap());
    assert!(SqliteS2LiteStoreV1::open(&restarted, &root).is_err());
}

#[test]
fn finalization_retires_source_protection_but_s2_cutover_still_blocks_s1_after_restart() {
    let database = TempDatabase::new("finalization-post-retirement-s1");
    let connection_a = database.connection();
    let (root, writer_id) = verified_router_migration(&connection_a);
    let mut finalizer = SqliteS2LiteStoreV1::open(&connection_a, &root).unwrap();
    assert_eq!(
        finalizer.finalize_verified_migration_v1().unwrap(),
        MigrationFinalizationResultV1::Finalized
    );
    let writer = finalizer.load_desktop_root_state().unwrap().unwrap();
    assert_eq!(writer.local_writer_id, writer_id);
    assert!(!finalizer.migration_source_protected_v1().unwrap());
    assert!(
        MigrationStateStoreV1::load_root_safety(&mut finalizer, &root)
            .unwrap()
            .cutover_state
            .remote_s2_activated
    );
    for connection in [database.connection(), database.connection()] {
        let mut store = SqliteS2LiteStoreV1::open(&connection, &root).unwrap();
        let mut puts = 0;
        assert_eq!(
            store
                .run_legacy_s1_publish_exclusive(&root, || {
                    puts += 1;
                    Ok(())
                })
                .unwrap(),
            super::durable_persistence::LegacyS1PublishAdmissionV1::RejectedActivation
        );
        assert_eq!(puts, 0);
    }
}

#[test]
fn fatal_before_finalization_keeps_verified_migration_and_source_protection() {
    let database = TempDatabase::new("finalization-fatal-first");
    let connection_a = database.connection();
    let (root, _) = verified_router_migration(&connection_a);
    let connection_b = database.connection();
    let mut fatal_authority = SqliteS2LiteStoreV1::open(&connection_b, &root).unwrap();
    MigrationStateStoreV1::persist_root_fatal(
        &mut fatal_authority,
        &root,
        "SYNC_ROOT_FROZEN_FINALIZATION_FIRST",
    )
    .unwrap();
    let mut finalizer = SqliteS2LiteStoreV1::open(&connection_a, &root).unwrap();
    assert_eq!(
        finalizer.finalize_verified_migration_v1().unwrap(),
        MigrationFinalizationResultV1::ReadOnlyFrozen
    );
    let restarted = database.connection();
    let mut restarted_store = SqliteS2LiteStoreV1::open(&restarted, &root).unwrap();
    assert_eq!(
        MigrationStateStoreV1::load(&mut restarted_store, &root)
            .unwrap()
            .unwrap()
            .status,
        MigrationStatusV1::RootFrozen
    );
    assert!(restarted_store.load_desktop_root_state().unwrap().is_none());
    assert!(restarted_store.migration_source_protected_v1().unwrap());
    let mut puts = 0;
    assert_eq!(
        restarted_store
            .run_legacy_s1_publish_exclusive(&root, || {
                puts += 1;
                Ok(())
            })
            .unwrap(),
        super::durable_persistence::LegacyS1PublishAdmissionV1::RejectedRootFrozen
    );
    assert_eq!(puts, 0);
}

#[test]
fn finalization_then_fatal_preserves_exact_handoff_and_blocks_normal_publication() {
    let database = TempDatabase::new("finalization-before-fatal");
    let connection_a = database.connection();
    let (root, writer_id) = verified_router_migration(&connection_a);
    let mut finalizer = SqliteS2LiteStoreV1::open(&connection_a, &root).unwrap();
    assert_eq!(
        finalizer.finalize_verified_migration_v1().unwrap(),
        MigrationFinalizationResultV1::Finalized
    );
    let writer = finalizer.load_desktop_root_state().unwrap().unwrap();
    assert_eq!(
        (
            writer.local_writer_id,
            writer.writer_head,
            writer.next_writer_sequence
        ),
        (writer_id, None, 1,)
    );
    let intent = prepared();
    PreparedIntentStoreV1::persist(&mut finalizer, &intent).unwrap();
    let connection_b = database.connection();
    let mut fatal_authority = SqliteS2LiteStoreV1::open(&connection_b, &root).unwrap();
    MigrationStateStoreV1::persist_root_fatal(
        &mut fatal_authority,
        &root,
        "SYNC_ROOT_FROZEN_AFTER_FINALIZATION",
    )
    .unwrap();
    let restarted_router = database.connection();
    assert_eq!(
        route_desktop_sync_v1(&restarted_router).unwrap(),
        DesktopSyncRouteV1::ReadOnlyFrozen
    );
    let restarted_publisher = database.connection();
    let mut publisher = SqliteS2LiteStoreV1::open(&restarted_publisher, &root).unwrap();
    let mut puts = 0;
    assert_eq!(
        publisher
            .run_ordinary_publish_exclusive(&root, &intent, || {
                puts += 1;
                Ok(())
            })
            .unwrap(),
        OrdinaryPublishExclusiveResultV1::RejectedRootFrozen
    );
    assert_eq!(puts, 0);
}

#[test]
fn independent_finalizers_converge_on_one_exact_completed_state() {
    let database = TempDatabase::new("duplicate-finalizers");
    let connection_a = database.connection();
    let (root, writer_id) = verified_router_migration(&connection_a);
    let connection_b = database.connection();

    let mut first = SqliteS2LiteStoreV1::open(&connection_a, &root).unwrap();
    assert_eq!(
        first.finalize_verified_migration_v1().unwrap(),
        MigrationFinalizationResultV1::Finalized
    );
    let first_writer = first.load_desktop_root_state().unwrap().unwrap();
    let mut second = SqliteS2LiteStoreV1::open(&connection_b, &root).unwrap();
    assert_eq!(
        second.finalize_verified_migration_v1().unwrap(),
        MigrationFinalizationResultV1::AlreadyFinalized
    );
    assert_eq!(
        second.load_desktop_root_state().unwrap(),
        Some(first_writer)
    );
    assert_eq!(
        second
            .load_desktop_root_state()
            .unwrap()
            .unwrap()
            .local_writer_id,
        writer_id
    );
    assert!(!second.migration_source_protected_v1().unwrap());
    let restarted_connection = database.connection();
    let mut restarted = SqliteS2LiteStoreV1::open(&restarted_connection, &root).unwrap();
    assert_eq!(
        restarted.finalize_verified_migration_v1().unwrap(),
        MigrationFinalizationResultV1::AlreadyFinalized
    );
}

#[test]
fn finalization_requires_an_exact_existing_writer_seed_and_never_repairs_mismatch() {
    let database = TempDatabase::new("finalization-writer-seed-mismatch");
    let connection = database.connection();
    let (root, migration_writer_id) = verified_router_migration(&connection);
    let mismatched = DesktopRootStateV1 {
        state_version: 1,
        physical_root_id: root.clone(),
        local_writer_id: migration_writer_id,
        next_writer_sequence: 2,
        writer_head: None,
        lifecycle_generation: 0,
        materialized_projection_generation: None,
        business_applied_projection_generation: None,
    };
    let mut store = SqliteS2LiteStoreV1::open(&connection, &root).unwrap();
    store.persist_desktop_root_state(&mismatched).unwrap();
    assert!(store.finalize_verified_migration_v1().is_err());
    assert_eq!(store.load_desktop_root_state().unwrap(), Some(mismatched));
    assert_eq!(
        MigrationStateStoreV1::load(&mut store, &root)
            .unwrap()
            .unwrap()
            .status,
        MigrationStatusV1::ActivationVerified
    );
    assert!(store.migration_source_protected_v1().unwrap());
}

#[test]
fn finalization_accepts_an_exact_existing_writer_seed_without_replacing_it() {
    let database = TempDatabase::new("finalization-writer-seed-exact");
    let connection = database.connection();
    let (root, migration_writer_id) = verified_router_migration(&connection);
    let exact = DesktopRootStateV1 {
        state_version: 1,
        physical_root_id: root.clone(),
        local_writer_id: migration_writer_id,
        next_writer_sequence: 1,
        writer_head: None,
        lifecycle_generation: 0,
        materialized_projection_generation: None,
        business_applied_projection_generation: None,
    };
    let mut store = SqliteS2LiteStoreV1::open(&connection, &root).unwrap();
    store.persist_desktop_root_state(&exact).unwrap();
    assert_eq!(
        store.finalize_verified_migration_v1().unwrap(),
        MigrationFinalizationResultV1::Finalized
    );
    assert_eq!(store.load_desktop_root_state().unwrap(), Some(exact));
}

#[test]
fn completed_state_writer_corruption_fails_closed_without_replacement() {
    let database = TempDatabase::new("completed-writer-corruption");
    let connection = database.connection();
    let (root, _) = complete_router_migration(&connection);
    let mut store = SqliteS2LiteStoreV1::open(&connection, &root).unwrap();
    let corrupted = DesktopRootStateV1 {
        state_version: 1,
        physical_root_id: root.clone(),
        local_writer_id: "42000000-0000-4000-8000-000000000001".into(),
        next_writer_sequence: 1,
        writer_head: None,
        lifecycle_generation: 0,
        materialized_projection_generation: None,
        business_applied_projection_generation: None,
    };
    store.persist_desktop_root_state(&corrupted).unwrap();
    assert!(store.finalize_verified_migration_v1().is_err());
    assert_eq!(store.load_desktop_root_state().unwrap(), Some(corrupted));
}

#[test]
fn completed_route_validates_writer_handoff_without_repairing_corruption() {
    #[derive(Clone, Copy)]
    enum Corruption {
        Missing,
        HigherSequence,
        LowerSequence,
        WrongWriter,
        WrongHead,
    }

    for (name, corruption) in [
        ("missing", Corruption::Missing),
        ("higher-sequence", Corruption::HigherSequence),
        ("lower-sequence", Corruption::LowerSequence),
        ("wrong-writer", Corruption::WrongWriter),
        ("wrong-head", Corruption::WrongHead),
    ] {
        let database = TempDatabase::new(&format!("completed-route-{name}"));
        let connection = database.connection();
        let (root, _) = complete_router_migration(&connection);
        let mut store = SqliteS2LiteStoreV1::open(&connection, &root).unwrap();
        let mut corrupted = store.load_desktop_root_state().unwrap().unwrap();
        let mut raw_corruption = None;
        match corruption {
            Corruption::Missing => {
                connection
                    .lock()
                    .unwrap()
                    .execute(
                        "DELETE FROM s2_lite_desktop_root_state_v1 WHERE root_id=?1",
                        [&root],
                    )
                    .unwrap();
            }
            Corruption::HigherSequence => {
                corrupted.next_writer_sequence += 1;
                store.persist_desktop_root_state(&corrupted).unwrap();
            }
            Corruption::LowerSequence => {
                let bytes: Vec<u8> = connection
                    .lock()
                    .unwrap()
                    .query_row(
                        "SELECT state_json FROM s2_lite_desktop_root_state_v1 WHERE root_id=?1",
                        [&root],
                        |row| row.get(0),
                    )
                    .unwrap();
                let mut envelope: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                envelope["payload"]["nextWriterSequence"] = serde_json::json!(0);
                let bytes = serde_json::to_vec(&envelope).unwrap();
                connection
                    .lock()
                    .unwrap()
                    .execute(
                        "UPDATE s2_lite_desktop_root_state_v1 SET state_json=?1 WHERE root_id=?2",
                        rusqlite::params![bytes, root],
                    )
                    .unwrap();
                raw_corruption = Some(
                    connection
                        .lock()
                        .unwrap()
                        .query_row(
                            "SELECT state_json FROM s2_lite_desktop_root_state_v1 WHERE root_id=?1",
                            [&root],
                            |row| row.get::<_, Vec<u8>>(0),
                        )
                        .unwrap(),
                );
            }
            Corruption::WrongWriter => {
                corrupted.local_writer_id = "42000000-0000-4000-8000-000000000001".into();
                store.persist_desktop_root_state(&corrupted).unwrap();
            }
            Corruption::WrongHead => {
                corrupted.writer_head = Some(super::types::CommitRef {
                    writer_id: corrupted.local_writer_id.clone(),
                    writer_seq: "1".into(),
                    commit_id: "43000000-0000-4000-8000-000000000001".into(),
                    content_hash: "a".repeat(64),
                });
                store.persist_desktop_root_state(&corrupted).unwrap();
            }
        }
        assert!(route_desktop_sync_v1(&connection).is_err());
        if matches!(corruption, Corruption::Missing) {
            assert!(store.load_desktop_root_state().unwrap().is_none());
        } else if let Some(raw_corruption) = raw_corruption {
            assert_eq!(
                connection
                    .lock()
                    .unwrap()
                    .query_row(
                        "SELECT state_json FROM s2_lite_desktop_root_state_v1 WHERE root_id=?1",
                        [&root],
                        |row| row.get::<_, Vec<u8>>(0),
                    )
                    .unwrap(),
                raw_corruption
            );
        } else {
            assert_eq!(store.load_desktop_root_state().unwrap(), Some(corrupted));
        }
    }
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

#[test]
fn incompatible_activation_freeze_rolls_back_at_every_internal_boundary() {
    for fault in [
        IncompatibleActivationFreezeFaultV1::AfterCutoverMerge,
        IncompatibleActivationFreezeFaultV1::AfterRootFatalWrite,
        IncompatibleActivationFreezeFaultV1::BeforeCommit,
    ] {
        let conn = connection();
        let (root, discovery) = bind_incompatible_migration_and_discovery(&conn);
        let mut store = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
        let safety_before = MigrationStateStoreV1::load_root_safety(&mut store, &root).unwrap();
        let migration_before = MigrationStateStoreV1::load(&mut store, &root).unwrap();

        assert!(store
            .persist_incompatible_activation_freeze_with_fault_v1(&root, &discovery, fault)
            .is_err());

        assert_eq!(
            MigrationStateStoreV1::load_root_safety(&mut store, &root).unwrap(),
            safety_before,
            "fault={fault:?} must not commit cutover or root fatal"
        );
        assert_eq!(
            MigrationStateStoreV1::load(&mut store, &root).unwrap(),
            migration_before,
            "fault={fault:?} must not commit a migration fatal mirror"
        );
    }
}

#[test]
fn incompatible_activation_freeze_is_atomic_and_blocks_second_connection_ordinary_publish() {
    let database = TempDatabase::new("atomic-incompatible-activation");
    let connection_a = database.connection();
    let (root, discovery) = bind_incompatible_migration_and_discovery(&connection_a);
    let connection_b = database.connection();
    let intent = prepared();
    let mut publisher = SqliteS2LiteStoreV1::open(&connection_b, &root).unwrap();
    PreparedIntentStoreV1::persist(&mut publisher, &intent).unwrap();

    let mut authority = SqliteS2LiteStoreV1::open(&connection_a, &root).unwrap();
    authority
        .persist_incompatible_activation_freeze_v1(&root, &discovery)
        .unwrap();
    let safety = MigrationStateStoreV1::load_root_safety(&mut authority, &root).unwrap();
    assert!(safety.cutover_state.remote_s2_activated);
    assert!(safety
        .root_fatal_signals
        .iter()
        .any(|fatal| fatal.code == "SYNC_ROOT_FROZEN_LEGACY_CHANGE"));
    let migration = MigrationStateStoreV1::load(&mut authority, &root)
        .unwrap()
        .unwrap();
    assert!(migration
        .root_fatal_signals
        .iter()
        .any(|fatal| fatal.code == "SYNC_ROOT_FROZEN_LEGACY_CHANGE"));
    let safety_after_first = safety.clone();
    authority
        .persist_incompatible_activation_freeze_v1(&root, &discovery)
        .unwrap();
    assert_eq!(
        MigrationStateStoreV1::load_root_safety(&mut authority, &root).unwrap(),
        safety_after_first,
        "the same incompatible observation is monotonic and idempotent"
    );

    let mut put_calls = 0;
    assert_eq!(
        publisher
            .run_ordinary_publish_exclusive(&root, &intent, || {
                put_calls += 1;
                Ok(())
            })
            .unwrap(),
        super::durable_persistence::OrdinaryPublishExclusiveResultV1::RejectedRootFrozen
    );
    assert_eq!(put_calls, 0);
    assert!(publisher.load_desktop_root_state().unwrap().is_none());

    let restarted_connection = database.connection();
    let mut restarted = SqliteS2LiteStoreV1::open(&restarted_connection, &root).unwrap();
    let mut restart_put_calls = 0;
    assert_eq!(
        restarted
            .run_ordinary_publish_exclusive(&root, &intent, || {
                restart_put_calls += 1;
                Ok(())
            })
            .unwrap(),
        super::durable_persistence::OrdinaryPublishExclusiveResultV1::RejectedRootFrozen
    );
    assert_eq!(restart_put_calls, 0);
    assert!(
        MigrationStateStoreV1::load_root_safety(&mut restarted, &root)
            .unwrap()
            .root_fatal_signals
            .iter()
            .any(|fatal| fatal.code == "SYNC_ROOT_FROZEN_LEGACY_CHANGE")
    );
}

#[test]
fn durable_router_maps_every_migration_status_without_legacy_fallback_after_cutover() {
    use super::migration_orchestration::MigrationStatusV1;

    for (status, expected) in [
        (
            MigrationStatusV1::NotStarted,
            DesktopSyncRouteV1::ContinueLegacyS1,
        ),
        (
            MigrationStatusV1::LegacySnapshotCaptured,
            DesktopSyncRouteV1::ResumeBootstrap,
        ),
        (
            MigrationStatusV1::BootstrapPlanned,
            DesktopSyncRouteV1::ResumeBootstrap,
        ),
        (
            MigrationStatusV1::StageAPublishing,
            DesktopSyncRouteV1::ResumeBootstrap,
        ),
        (
            MigrationStatusV1::StageAComplete,
            DesktopSyncRouteV1::ResumeBootstrap,
        ),
        (
            MigrationStatusV1::StageBPublishing,
            DesktopSyncRouteV1::ResumeBootstrap,
        ),
        (
            MigrationStatusV1::StageBComplete,
            DesktopSyncRouteV1::ResumeActivation,
        ),
        (
            MigrationStatusV1::ActivationPublishing,
            DesktopSyncRouteV1::ResumeActivation,
        ),
        (
            MigrationStatusV1::RootFrozen,
            DesktopSyncRouteV1::ReadOnlyFrozen,
        ),
    ] {
        assert_eq!(
            super::desktop_lifecycle::route_migration_status_v1(status, false).unwrap(),
            expected
        );
    }
    for status in [
        MigrationStatusV1::NotStarted,
        MigrationStatusV1::LegacySnapshotCaptured,
        MigrationStatusV1::BootstrapPlanned,
        MigrationStatusV1::StageAPublishing,
        MigrationStatusV1::StageAComplete,
        MigrationStatusV1::StageBPublishing,
        MigrationStatusV1::StageBComplete,
        MigrationStatusV1::ActivationPublishing,
        MigrationStatusV1::ActivationVerified,
    ] {
        assert_eq!(
            super::desktop_lifecycle::route_migration_status_v1(status, true).unwrap(),
            DesktopSyncRouteV1::ResumeActivation,
            "verified activation must never reopen legacy S1 for {status:?}"
        );
    }
    assert_eq!(
        super::desktop_lifecycle::route_migration_status_v1(
            MigrationStatusV1::MigrationComplete,
            true,
        )
        .unwrap(),
        DesktopSyncRouteV1::EnterNormalS2
    );
    assert!(super::desktop_lifecycle::route_migration_status_v1(
        MigrationStatusV1::ActivationVerified,
        false,
    )
    .is_err());
    assert!(super::desktop_lifecycle::route_migration_status_v1(
        MigrationStatusV1::MigrationComplete,
        false,
    )
    .is_err());
}

#[test]
fn durable_router_is_restart_deterministic_and_preserves_historical_migration_target() {
    let pristine = router_connection();
    let target = activate_target(
        &pristine,
        "https://dav.example.test/router-legacy/",
        "alice",
        1,
    );
    assert_eq!(
        route_desktop_sync_v1(&pristine).unwrap(),
        DesktopSyncRouteV1::ContinueLegacyS1
    );
    let bound = resolve_active_target_root_binding_v1(&pristine, &target.id, 1).unwrap();
    let mut pristine_store =
        SqliteS2LiteStoreV1::open(&pristine, &bound.binding.physical_root_id).unwrap();
    assert!(pristine_store.load_desktop_root_state().unwrap().is_none());
    assert_eq!(
        route_desktop_sync_v1(&pristine).unwrap(),
        DesktopSyncRouteV1::ContinueLegacyS1
    );

    let conn = router_connection();
    let (_target_a, historical_root) = admit_router_migration(&conn);
    assert_eq!(
        route_desktop_sync_v1(&conn).unwrap(),
        DesktopSyncRouteV1::ResumeActivation
    );
    let mut historical = SqliteS2LiteStoreV1::open(&conn, &historical_root).unwrap();
    assert!(historical.load_desktop_root_state().unwrap().is_none());

    let target_b = activate_target(&conn, "https://dav.example.test/router-b/", "bob", 2);
    assert_eq!(
        route_desktop_sync_v1(&conn).unwrap(),
        DesktopSyncRouteV1::ResumeActivation,
        "the source owner must route historical A rather than starting B"
    );
    assert!(
        SqliteS2LiteStoreV1::load_target_root_binding_v1(&conn, &target_b.id, 2)
            .unwrap()
            .is_none()
    );
    assert!(historical.load_desktop_root_state().unwrap().is_none());
}

#[test]
fn durable_router_latched_activation_initializes_writer_only_for_normal_s2_and_fatal_wins() {
    let conn = router_connection();
    let root = latch_compatible_router_activation(&conn);
    let mut store = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
    assert!(store.load_desktop_root_state().unwrap().is_none());
    assert_eq!(
        route_desktop_sync_v1(&conn).unwrap(),
        DesktopSyncRouteV1::EnterNormalS2
    );
    let writer = store.load_desktop_root_state().unwrap().unwrap();
    assert_eq!(writer.next_writer_sequence, 1);
    // A restart and a listing omission cannot erase the durable cutover route.
    assert_eq!(
        route_desktop_sync_v1(&conn).unwrap(),
        DesktopSyncRouteV1::EnterNormalS2
    );
    assert_eq!(store.load_desktop_root_state().unwrap(), Some(writer));
    // A later active epoch for the same frozen root cannot reopen S1.
    let _same_root_new_epoch =
        activate_target(&conn, "https://dav.example.test/router-normal/", "alice", 2);
    assert_eq!(
        route_desktop_sync_v1(&conn).unwrap(),
        DesktopSyncRouteV1::EnterNormalS2
    );

    MigrationStateStoreV1::persist_root_fatal(&mut store, &root, "SYNC_ROOT_FROZEN_ROUTER_TEST")
        .unwrap();
    assert_eq!(
        route_desktop_sync_v1(&conn).unwrap(),
        DesktopSyncRouteV1::ReadOnlyFrozen,
        "root fatal must win even when activation remains latched"
    );
}

#[test]
fn atomic_normal_route_fatal_first_creates_no_writer() {
    let database = TempDatabase::new("normal-route-fatal-first");
    let connection_a = database.connection();
    let root = latch_compatible_router_activation(&connection_a);
    let connection_b = database.connection();

    assert_eq!(
        route_desktop_sync_with_before_normal_admission_v1(&connection_a, || {
            let mut authority = SqliteS2LiteStoreV1::open(&connection_b, &root)?;
            MigrationStateStoreV1::persist_root_fatal(
                &mut authority,
                &root,
                "SYNC_ROOT_FROZEN_NORMAL_ROUTE_RACE",
            )?;
            Ok(())
        })
        .unwrap(),
        DesktopSyncRouteV1::ReadOnlyFrozen
    );
    let mut store = SqliteS2LiteStoreV1::open(&connection_a, &root).unwrap();
    assert!(store.load_desktop_root_state().unwrap().is_none());
    assert!(MigrationStateStoreV1::load_root_safety(&mut store, &root)
        .unwrap()
        .root_fatal_signals
        .iter()
        .any(|fatal| fatal.code == "SYNC_ROOT_FROZEN_NORMAL_ROUTE_RACE"));
}

#[test]
fn normal_route_admission_then_fatal_keeps_writer_but_blocks_publication() {
    let database = TempDatabase::new("normal-route-admission-first");
    let connection_a = database.connection();
    let root = latch_compatible_router_activation(&connection_a);
    assert_eq!(
        route_desktop_sync_v1(&connection_a).unwrap(),
        DesktopSyncRouteV1::EnterNormalS2
    );
    let writer = SqliteS2LiteStoreV1::open(&connection_a, &root)
        .unwrap()
        .load_desktop_root_state()
        .unwrap()
        .unwrap();

    let connection_b = database.connection();
    let mut authority = SqliteS2LiteStoreV1::open(&connection_b, &root).unwrap();
    MigrationStateStoreV1::persist_root_fatal(
        &mut authority,
        &root,
        "SYNC_ROOT_FROZEN_AFTER_NORMAL_ADMISSION",
    )
    .unwrap();

    let intent = prepared();
    let mut publisher = SqliteS2LiteStoreV1::open(&connection_a, &root).unwrap();
    PreparedIntentStoreV1::persist(&mut publisher, &intent).unwrap();
    let mut puts = 0;
    assert_eq!(
        publisher
            .run_ordinary_publish_exclusive(&root, &intent, || {
                puts += 1;
                Ok(())
            })
            .unwrap(),
        OrdinaryPublishExclusiveResultV1::RejectedRootFrozen
    );
    assert_eq!(puts, 0);
    assert_eq!(publisher.load_desktop_root_state().unwrap(), Some(writer));
}

#[test]
fn completed_migration_normal_admission_installs_its_writer_seed_exactly() {
    let conn = router_connection();
    let (root, migration_writer_id) = complete_router_migration(&conn);
    assert_eq!(
        route_desktop_sync_v1(&conn).unwrap(),
        DesktopSyncRouteV1::EnterNormalS2
    );
    let mut store = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
    assert!(!store.migration_source_protected_v1().unwrap());
    assert_eq!(
        MigrationStateStoreV1::load(&mut store, &root)
            .unwrap()
            .unwrap()
            .status,
        MigrationStatusV1::MigrationComplete
    );
    let writer = store.load_desktop_root_state().unwrap().unwrap();
    assert_eq!(writer.local_writer_id, migration_writer_id);
    assert_eq!(writer.writer_head, None);
    assert_eq!(writer.next_writer_sequence, 1);
}

#[test]
fn router_finalization_reloads_completed_no_owner_authority_before_normal_admission() {
    let conn = router_connection();
    let (root, migration_writer_id) = verified_router_migration(&conn);
    assert_eq!(
        route_desktop_sync_v1(&conn).unwrap(),
        DesktopSyncRouteV1::EnterNormalS2
    );
    let mut store = SqliteS2LiteStoreV1::open(&conn, &root).unwrap();
    assert!(!store.migration_source_protected_v1().unwrap());
    assert_eq!(
        MigrationStateStoreV1::load(&mut store, &root)
            .unwrap()
            .unwrap()
            .status,
        MigrationStatusV1::MigrationComplete
    );
    assert_eq!(
        store
            .load_desktop_root_state()
            .unwrap()
            .unwrap()
            .local_writer_id,
        migration_writer_id
    );
}

#[test]
fn completed_migration_fatal_before_normal_admission_installs_no_writer() {
    let database = TempDatabase::new("completed-migration-fatal-first");
    let connection_a = database.connection();
    let (root, _) = complete_router_migration(&connection_a);
    let connection_b = database.connection();
    assert_eq!(
        route_desktop_sync_with_before_normal_admission_v1(&connection_a, || {
            let mut authority = SqliteS2LiteStoreV1::open(&connection_b, &root)?;
            MigrationStateStoreV1::persist_root_fatal(
                &mut authority,
                &root,
                "SYNC_ROOT_FROZEN_MIGRATION_NORMAL_ROUTE_RACE",
            )?;
            Ok(())
        })
        .unwrap(),
        DesktopSyncRouteV1::ReadOnlyFrozen
    );
    // Finalization established the frozen migration writer atomically before
    // this later fatal won normal-route admission; the fatal must block
    // publication but cannot erase already-established writer authority.
    assert!(SqliteS2LiteStoreV1::open(&connection_a, &root)
        .unwrap()
        .load_desktop_root_state()
        .unwrap()
        .is_some());
}

#[test]
fn restart_with_a_fatal_normal_root_never_initializes_a_writer() {
    let database = TempDatabase::new("normal-route-fatal-restart");
    let connection_a = database.connection();
    let root = latch_compatible_router_activation(&connection_a);
    let connection_b = database.connection();
    let mut authority = SqliteS2LiteStoreV1::open(&connection_b, &root).unwrap();
    MigrationStateStoreV1::persist_root_fatal(
        &mut authority,
        &root,
        "SYNC_ROOT_FROZEN_NORMAL_ROUTE_RESTART",
    )
    .unwrap();

    let restarted = database.connection();
    assert_eq!(
        route_desktop_sync_v1(&restarted).unwrap(),
        DesktopSyncRouteV1::ReadOnlyFrozen
    );
    assert!(SqliteS2LiteStoreV1::open(&restarted, &root)
        .unwrap()
        .load_desktop_root_state()
        .unwrap()
        .is_none());
}

#[test]
fn durable_router_corrupt_owned_migration_fails_closed() {
    let conn = router_connection();
    let (_target, root) = admit_router_migration(&conn);
    conn.lock()
        .unwrap()
        .execute(
            "UPDATE s2_lite_migration_v1 SET state_json=?1 WHERE root_id=?2",
            rusqlite::params![b"not-a-persistence-envelope".to_vec(), root],
        )
        .unwrap();
    assert!(route_desktop_sync_v1(&conn).is_err());
}

#[test]
fn durable_router_legacy_result_does_not_bypass_later_sqlite_s1_admission() {
    let database = TempDatabase::new("router-legacy-s1-race");
    let connection_a = database.connection();
    let target = activate_target(
        &connection_a,
        "https://dav.example.test/router-s1-race/",
        "alice",
        1,
    );
    assert_eq!(
        route_desktop_sync_v1(&connection_a).unwrap(),
        DesktopSyncRouteV1::ContinueLegacyS1
    );
    let bound = resolve_active_target_root_binding_v1(&connection_a, &target.id, 1).unwrap();

    let connection_b = database.connection();
    let mut authority =
        SqliteS2LiteStoreV1::open(&connection_b, &bound.binding.physical_root_id).unwrap();
    MigrationStateStoreV1::persist_root_fatal(
        &mut authority,
        &bound.binding.physical_root_id,
        "SYNC_ROOT_FROZEN_ROUTER_RACE",
    )
    .unwrap();

    let mut stale_router =
        SqliteS2LiteStoreV1::open(&connection_a, &bound.binding.physical_root_id).unwrap();
    let mut put_calls = 0;
    assert_eq!(
        stale_router
            .run_legacy_s1_publish_exclusive(&bound.binding.physical_root_id, || {
                put_calls += 1;
                Ok(())
            })
            .unwrap(),
        super::durable_persistence::LegacyS1PublishAdmissionV1::RejectedRootFrozen
    );
    assert_eq!(put_calls, 0);
}
