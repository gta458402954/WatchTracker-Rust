use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::activation_cutover::{
    create_activation_cutover_state_v1, recover_activation_cutover_v1, ActivationCutoverStateV1,
    ActivationFingerprintConsistencyV1, VerifiedActivationEvidenceV1,
};
use super::canonical::sha256_hex;
use super::durable_persistence::{
    persistence_schema_version, LegacyS1PublishAdmissionV1, OrdinaryPublishExclusiveResultV1,
    SqliteS2LiteStoreV1, VersionedDiscoveryStateV1, S2_LITE_PERSISTENCE_SCHEMA_VERSION,
};
use super::immutable_publish::{
    ImmutableObjectRemoteV1, PreparedActivationIntentStoreV1, PreparedIntentStoreV1,
    PublishedActivationReceiptV1, RemoteExactGetResultV1, RemotePublishedReceiptV1,
    RemotePutResultV1,
};
use super::migration_orchestration::{
    capture_legacy_snapshot_v1, create_migration_root_execution_capability_v1,
    create_migration_state_v1, create_new_root_migration_handoff_v1,
    freeze_old_root_for_new_root_handoff_v1, merge_migration_root_cutover_state_v1,
    plan_captured_migration_v1, retain_captured_snapshot_v1, start_or_attach_migration_v1,
    LegacySnapshotEntryV1, MigrationRootFatalV1, MigrationStateStoreV1, MigrationStateV1,
    MigrationStatusV1, PublishExclusiveResultV1,
};
use super::remote_discovery::{create_discovery_state_v1, ObservedCandidateV1, RootFatalSignalV1};
use super::types::{BootstrapEntity, LegacySemanticAdapterV1};

const TIMESTAMP: &str = "2026-09-13T00:00:00.000Z";
const ROOT_A: &str = "root://durable-a";
const ROOT_B: &str = "root://durable-b";
const MIGRATION_A: &str = "70000000-0000-4000-8000-000000000001";
const MIGRATION_B: &str = "70000000-0000-4000-8000-000000000002";
const WRITER_A: &str = "71000000-0000-4000-8000-000000000001";
const WRITER_B: &str = "71000000-0000-4000-8000-000000000002";

struct TempDatabase {
    path: PathBuf,
}

impl TempDatabase {
    fn new(name: &str) -> Self {
        Self {
            path: std::env::temp_dir().join(format!(
                "watchtracker-s2-lite-{name}-{}.db",
                uuid::Uuid::new_v4()
            )),
        }
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

fn with_store<T>(
    path: &Path,
    root_id: &str,
    operation: impl FnOnce(&mut SqliteS2LiteStoreV1<'_>, &Mutex<Connection>) -> T,
) -> T {
    let connection = Connection::open(path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    crate::db::setup_db(&connection).unwrap();
    let connection = Mutex::new(connection);
    let mut store = SqliteS2LiteStoreV1::open(&connection, root_id).unwrap();
    operation(&mut store, &connection)
}

fn record(index: usize) -> BootstrapEntity {
    let id = format!("record-{index:04}");
    BootstrapEntity {
        entity_type: "record".to_string(),
        entity_key: json!(["record", id]),
        value: json!({
            "id": id, "originalName": format!("Record {index}"), "chineseName": "",
            "progress": "", "totalEpisodes": 1, "episodeTrackingEnabled": false,
            "nextEpisode": null, "movieProgress": null, "movieDuration": null,
            "releaseYear": null, "posterPath": null, "status": "未看", "platform": "",
            "rating": null, "startDate": null, "endDate": null, "notes": "",
            "createdAt": TIMESTAMP, "updatedAt": null, "imdbId": null, "isLocked": null,
            "genres": null, "originCountry": null, "imdbRating": null, "tmdbStatus": null,
            "interestLevel": null, "episodeRuntime": null, "mediaType": "剧集",
            "contentTags": null, "tmdbMediaKind": null, "tmdbId": null,
            "tmdbParentId": null, "tmdbSeasonNumber": null, "seriesRecordKind": null,
            "rev": "0", "revActor": ""
        }),
    }
}

fn collection() -> BootstrapEntity {
    BootstrapEntity {
        entity_type: "collection".to_string(),
        entity_key: json!(["collection", "collection-0000"]),
        value: json!({
            "id": "collection-0000", "name": "Collection", "normalizedName": "collection",
            "description": null, "sourceKind": "manual", "sourceKey": null,
            "collectionKind": "manual", "orderMode": "manual", "createdAt": TIMESTAMP,
            "updatedAt": TIMESTAMP, "rev": "0", "revActor": ""
        }),
    }
}

fn deterministic_id(domain: &str, components: &[String]) -> String {
    let mut bytes = domain.as_bytes().to_vec();
    for component in components {
        bytes.push(0);
        bytes.extend_from_slice(component.as_bytes());
    }
    sha256_hex(&bytes)
}

fn member(index: usize) -> BootstrapEntity {
    let collection_id = "collection-0000".to_string();
    let record_id = format!("record-{index:04}");
    BootstrapEntity {
        entity_type: "collection-member".to_string(),
        entity_key: json!(["collection-member", collection_id, record_id]),
        value: json!({
            "id": deterministic_id("collection-member:v1", &[collection_id.clone(), record_id.clone()]),
            "collectionId": collection_id, "recordId": record_id, "position": index.to_string(),
            "sourceKind": "manual", "createdAt": TIMESTAMP, "updatedAt": TIMESTAMP,
            "rev": "0", "revActor": ""
        }),
    }
}

struct IdentityAdapter;

struct RootOnlyRemote {
    root_id: String,
    identity: u64,
    exact_objects: BTreeMap<String, Vec<u8>>,
}

impl ImmutableObjectRemoteV1 for RootOnlyRemote {
    fn execution_context_identity(&self) -> u64 {
        self.identity
    }

    fn physical_root_id(&self) -> Option<&str> {
        Some(&self.root_id)
    }

    fn get_exact(&mut self, remote_path: &str) -> RemoteExactGetResultV1 {
        self.exact_objects
            .get(remote_path)
            .cloned()
            .map_or(RemoteExactGetResultV1::DefinitelyAbsent, |bytes| {
                RemoteExactGetResultV1::DefinitelyPresent(bytes)
            })
    }

    fn put_exact(
        &mut self,
        _remote_path: &str,
        _exact_bytes: &[u8],
        _if_none_match_star: bool,
    ) -> RemotePutResultV1 {
        panic!("not used by persistence provenance test")
    }
}

impl LegacySemanticAdapterV1 for IdentityAdapter {
    fn adapt_live_entity(
        &self,
        entity_type: &str,
        legacy_value: &Value,
    ) -> std::result::Result<BootstrapEntity, String> {
        let entity: BootstrapEntity =
            serde_json::from_value(legacy_value.clone()).map_err(|error| error.to_string())?;
        if entity.entity_type != entity_type {
            return Err("type mismatch".to_string());
        }
        Ok(entity)
    }
}

fn migration_states(
    root_id: &str,
    migration_id: &str,
    writer_id: &str,
    entity_count: usize,
) -> (MigrationStateV1, MigrationStateV1, MigrationStateV1) {
    let initial = create_migration_state_v1(
        migration_id,
        root_id,
        writer_id,
        TIMESTAMP,
        "legacy-bootstrap",
    )
    .unwrap();
    let mut entities = (0..entity_count).map(record).collect::<Vec<_>>();
    entities.push(collection());
    entities.extend((0..entity_count).map(member));
    let entries = entities
        .iter()
        .map(|entity| LegacySnapshotEntryV1 {
            entity_type: entity.entity_type.clone(),
            value: serde_json::to_value(entity).unwrap(),
        })
        .collect::<Vec<_>>();
    let snapshot = capture_legacy_snapshot_v1(&entries, &IdentityAdapter).unwrap();
    let mut captured = retain_captured_snapshot_v1(&initial, &snapshot).unwrap();
    captured.generation = 1;
    let mut planned = plan_captured_migration_v1(&captured).unwrap();
    planned.generation = 2;
    (initial, captured, planned)
}

fn commit_receipt(
    task: &super::migration_orchestration::MigrationCommitTaskV1,
) -> RemotePublishedReceiptV1 {
    RemotePublishedReceiptV1 {
        receipt_version: 1,
        remote_path: task.intent.remote_path.clone(),
        content_hash: task.intent.content_hash.clone(),
        commit_ref: task.intent.commit_ref.clone(),
        prepared_intent_fingerprint: task.intent.intent_fingerprint.clone(),
        verified_exact_bytes_hash: task.intent.content_hash.clone(),
        verified_at_diagnostic: TIMESTAMP.to_string(),
    }
}

fn activation_receipt(state: &MigrationStateV1) -> PublishedActivationReceiptV1 {
    let intent = state.activation_intent.as_ref().unwrap();
    PublishedActivationReceiptV1 {
        receipt_version: 1,
        remote_path: intent.remote_path.clone(),
        content_hash: intent.content_hash.clone(),
        activation_id: intent.activation_id.clone(),
        prepared_intent_fingerprint: intent.intent_fingerprint.clone(),
        verified_exact_bytes_hash: intent.content_hash.clone(),
        verified_at_diagnostic: TIMESTAMP.to_string(),
    }
}

fn persist_commit_receipt(
    store: &mut SqliteS2LiteStoreV1<'_>,
    root_id: &str,
    receipt: &RemotePublishedReceiptV1,
) -> super::canonical::Result<()> {
    let intent = store.load_prepared_intent(&receipt.remote_path)?.ok_or(
        super::canonical::ProtocolError("S2_DURABLE_STATE_CORRUPTION"),
    )?;
    let mut remote = RootOnlyRemote {
        root_id: root_id.to_string(),
        identity: 1,
        exact_objects: BTreeMap::from([(intent.remote_path.clone(), intent.exact_bytes.clone())]),
    };
    let result = store.verify_and_persist_commit_receipt(
        &intent,
        &mut remote,
        &receipt.verified_at_diagnostic,
    )?;
    if result
        != super::immutable_publish::RecoverPreparedIntentResultV1::AlreadyPublishedExact(
            receipt.clone(),
        )
    {
        return Err(super::canonical::ProtocolError(
            "S2_DURABLE_STATE_CORRUPTION",
        ));
    }
    Ok(())
}

fn persist_activation_receipt(
    store: &mut SqliteS2LiteStoreV1<'_>,
    root_id: &str,
    receipt: &PublishedActivationReceiptV1,
) -> super::canonical::Result<()> {
    let intent = store
        .load_prepared_activation_intent(&receipt.remote_path)?
        .ok_or(super::canonical::ProtocolError(
            "S2_DURABLE_STATE_CORRUPTION",
        ))?;
    let mut remote = RootOnlyRemote {
        root_id: root_id.to_string(),
        identity: 1,
        exact_objects: BTreeMap::from([(intent.remote_path.clone(), intent.exact_bytes.clone())]),
    };
    let result = store.verify_and_persist_activation_receipt(
        &intent,
        &mut remote,
        &receipt.verified_at_diagnostic,
    )?;
    if result
        != super::immutable_publish::RecoverActivationIntentResultV1::AlreadyPublishedExact(
            receipt.clone(),
        )
    {
        return Err(super::canonical::ProtocolError(
            "S2_DURABLE_STATE_CORRUPTION",
        ));
    }
    Ok(())
}

fn canonical_cutover(state: &MigrationStateV1, evidence_path: &str) -> ActivationCutoverStateV1 {
    let intent = state.activation_intent.as_ref().unwrap();
    let incoming = ActivationCutoverStateV1 {
        state_version: 1,
        remote_s2_activated: true,
        verified_activation_evidence: vec![VerifiedActivationEvidenceV1 {
            path: evidence_path.to_string(),
            activation_id: intent.activation_id.clone(),
            content_hash: intent.content_hash.clone(),
            exact_bytes_hash: intent.content_hash.clone(),
            legacy_fingerprint: Some(state.snapshot.as_ref().unwrap().legacy_fingerprint.clone()),
        }],
        fingerprint_consistency: ActivationFingerprintConsistencyV1::NoEvidence,
        root_fatal_signals: vec![],
    };
    merge_migration_root_cutover_state_v1(&create_activation_cutover_state_v1(), &incoming).unwrap()
}

fn persist_transition(
    store: &mut SqliteS2LiteStoreV1<'_>,
    prior: &MigrationStateV1,
    next: &MigrationStateV1,
) {
    assert!(store
        .compare_and_swap(&prior.root_id, &prior.migration_id, prior.generation, next,)
        .unwrap());
}

fn load_migration(path: &Path, root_id: &str) -> MigrationStateV1 {
    with_store(path, root_id, |store, _| {
        store.load(root_id).unwrap().unwrap()
    })
}

fn read_blob(path: &Path, table: &str, column: &str, root_id: &str) -> Vec<u8> {
    let connection = Connection::open(path).unwrap();
    connection
        .query_row(
            &format!("SELECT {column} FROM {table} WHERE root_id=?1"),
            [root_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn write_blob(path: &Path, table: &str, column: &str, root_id: &str, value: &Value) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute(
            &format!("UPDATE {table} SET {column}=?2 WHERE root_id=?1"),
            params![root_id, serde_json::to_vec(value).unwrap()],
        )
        .unwrap();
}

fn assert_corruption<T>(result: super::canonical::Result<T>) {
    assert_eq!(result.err().unwrap().0, "S2_DURABLE_STATE_CORRUPTION");
}

#[test]
fn schema_uses_existing_database_migration_path() {
    let database = TempDatabase::new("schema");
    with_store(&database.path, ROOT_A, |store, connection| {
        assert_eq!(store.root_id(), ROOT_A);
        let connection = connection.lock().unwrap();
        assert_eq!(
            persistence_schema_version(&connection).unwrap().as_deref(),
            Some(S2_LITE_PERSISTENCE_SCHEMA_VERSION)
        );
        let db_version: String = connection
            .query_row(
                "SELECT value FROM settings WHERE key='db_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(db_version, crate::db::CURRENT_DB_VERSION.to_string());
    });
}

#[test]
fn discovery_fatal_commit_latches_root_authority_before_second_connection_admission() {
    let database = TempDatabase::new("discovery-fatal-publication-admission");
    let connection_a = Connection::open(&database.path).unwrap();
    crate::db::setup_db(&connection_a).unwrap();
    let connection_b = Connection::open(&database.path).unwrap();
    connection_b
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    let connection_a = Mutex::new(connection_a);
    let connection_b = Mutex::new(connection_b);
    let mut discovery_writer = SqliteS2LiteStoreV1::open(&connection_a, ROOT_A).unwrap();
    let mut publisher = SqliteS2LiteStoreV1::open(&connection_b, ROOT_A).unwrap();
    let (_, _, planned) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    let intent = planned.stage_a[0].intent.clone();
    PreparedIntentStoreV1::persist(&mut publisher, &intent).unwrap();
    let mut fatal_discovery = create_discovery_state_v1();
    fatal_discovery.root_fatal_signals.push(RootFatalSignalV1 {
        code: "DISCOVERY_WRITER_FORK".into(),
        path: "writers/fork.json".into(),
        writer_id: Some("writer-a".into()),
        writer_seq: Some("1".into()),
        safe_writer_frontier: None,
    });
    assert!(discovery_writer
        .compare_and_swap_discovery_state(None, &fatal_discovery)
        .unwrap());
    let mut s2_put_calls = 0;
    assert_eq!(
        publisher
            .run_ordinary_publish_exclusive(ROOT_A, &intent, || {
                s2_put_calls += 1;
                Ok(())
            })
            .unwrap(),
        OrdinaryPublishExclusiveResultV1::RejectedRootFrozen
    );
    assert_eq!(s2_put_calls, 0);
    assert_eq!(
        publisher
            .load_root_safety(ROOT_A)
            .unwrap()
            .root_fatal_signals,
        vec![MigrationRootFatalV1 {
            code: "DISCOVERY_WRITER_FORK".into()
        }]
    );
}

#[test]
fn legacy_s1_admission_rejects_activation_or_fatal_from_a_second_connection() {
    let database = TempDatabase::new("legacy-s1-publication-admission");
    let connection_a = Connection::open(&database.path).unwrap();
    crate::db::setup_db(&connection_a).unwrap();
    let connection_b = Connection::open(&database.path).unwrap();
    connection_b
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    let connection_a = Mutex::new(connection_a);
    let connection_b = Mutex::new(connection_b);
    let (_, _, planned) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    let mut authority_writer = SqliteS2LiteStoreV1::open(&connection_a, ROOT_A).unwrap();
    authority_writer
        .persist_cutover_state(
            ROOT_A,
            &canonical_cutover(&planned, "activations/race.json"),
        )
        .unwrap();
    let mut publisher = SqliteS2LiteStoreV1::open(&connection_b, ROOT_A).unwrap();
    let mut activation_puts = 0;
    assert_eq!(
        publisher
            .run_legacy_s1_publish_exclusive(ROOT_A, || {
                activation_puts += 1;
                Ok(())
            })
            .unwrap(),
        LegacyS1PublishAdmissionV1::RejectedActivation
    );
    assert_eq!(activation_puts, 0);

    authority_writer
        .persist_root_fatal(ROOT_A, "S1_FATAL_WINS")
        .unwrap();
    let mut fatal_puts = 0;
    assert_eq!(
        publisher
            .run_legacy_s1_publish_exclusive(ROOT_A, || {
                fatal_puts += 1;
                Ok(())
            })
            .unwrap(),
        LegacyS1PublishAdmissionV1::RejectedRootFrozen
    );
    assert_eq!(fatal_puts, 0);
}

#[test]
fn restart_roundtrips_exact_intents_receipts_and_all_migration_crash_states() {
    let database = TempDatabase::new("restart");
    let (initial, captured, planned) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 257);
    assert!(planned.stage_a.len() > 1);
    assert!(planned.stage_b.len() > 1);

    with_store(&database.path, ROOT_A, |store, _| {
        assert_eq!(store.claim_or_load(&initial).unwrap(), initial);
    });
    assert_eq!(load_migration(&database.path, ROOT_A), initial);

    with_store(&database.path, ROOT_A, |store, _| {
        persist_transition(store, &initial, &captured);
    });
    let reloaded_captured = load_migration(&database.path, ROOT_A);
    assert_eq!(reloaded_captured, captured);
    assert_eq!(
        reloaded_captured
            .snapshot
            .as_ref()
            .unwrap()
            .legacy_fingerprint,
        captured.snapshot.as_ref().unwrap().legacy_fingerprint
    );

    with_store(&database.path, ROOT_A, |store, _| {
        persist_transition(store, &captured, &planned);
        PreparedActivationIntentStoreV1::persist(
            store,
            planned.activation_intent.as_ref().unwrap(),
        )
        .unwrap();
        PreparedIntentStoreV1::persist(store, &planned.stage_a[0].intent).unwrap();
    });
    assert_eq!(load_migration(&database.path, ROOT_A), planned);
    with_store(&database.path, ROOT_A, |store, connection| {
        let intent = store
            .load_prepared_intent(&planned.stage_a[0].intent.remote_path)
            .unwrap()
            .unwrap();
        assert_eq!(intent.exact_bytes, planned.stage_a[0].intent.exact_bytes);
        assert!(store
            .load_published_receipt(&intent.remote_path)
            .unwrap()
            .is_none());
        // No PUT yet and PUT-outcome-unknown/no-receipt intentionally have the
        // same durable recovery state: retained exact intent, absent receipt.
        let connection = connection.lock().unwrap();
        let (storage_type, bytes): (String, Vec<u8>) = connection
            .query_row(
                "SELECT typeof(exact_bytes), exact_bytes FROM s2_lite_prepared_intent_v1
                 WHERE root_id=?1 AND intent_kind='commit' AND remote_path=?2",
                rusqlite::params![ROOT_A, intent.remote_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(storage_type, "blob");
        assert_eq!(bytes, planned.stage_a[0].intent.exact_bytes);
    });

    let mut partial_a = planned.clone();
    let first_a_receipt = commit_receipt(&partial_a.stage_a[0]);
    partial_a.stage_a[0].receipt = Some(first_a_receipt.clone());
    partial_a.stage_a[0].receipt_root_id = Some(ROOT_A.to_string());
    partial_a.status = MigrationStatusV1::StageAPublishing;
    partial_a.generation = 3;
    with_store(&database.path, ROOT_A, |store, _| {
        persist_commit_receipt(store, ROOT_A, &first_a_receipt).unwrap();
        persist_transition(store, &planned, &partial_a);
    });
    assert_eq!(load_migration(&database.path, ROOT_A), partial_a);

    let mut partial_b = partial_a.clone();
    for task in &mut partial_b.stage_a {
        if task.receipt.is_none() {
            let receipt = commit_receipt(task);
            with_store(&database.path, ROOT_A, |store, _| {
                PreparedIntentStoreV1::persist(store, &task.intent).unwrap();
                persist_commit_receipt(store, ROOT_A, &receipt).unwrap();
            });
            task.receipt = Some(receipt);
            task.receipt_root_id = Some(ROOT_A.to_string());
        }
    }
    let first_b_receipt = commit_receipt(&partial_b.stage_b[0]);
    with_store(&database.path, ROOT_A, |store, _| {
        PreparedIntentStoreV1::persist(store, &partial_b.stage_b[0].intent).unwrap();
        persist_commit_receipt(store, ROOT_A, &first_b_receipt).unwrap();
    });
    partial_b.stage_b[0].receipt = Some(first_b_receipt);
    partial_b.stage_b[0].receipt_root_id = Some(ROOT_A.to_string());
    partial_b.status = MigrationStatusV1::StageBPublishing;
    partial_b.generation = 4;
    with_store(&database.path, ROOT_A, |store, _| {
        persist_transition(store, &partial_a, &partial_b);
    });
    assert_eq!(load_migration(&database.path, ROOT_A), partial_b);

    let mut activation_verified = partial_b.clone();
    for task in &mut activation_verified.stage_b {
        if task.receipt.is_none() {
            let receipt = commit_receipt(task);
            with_store(&database.path, ROOT_A, |store, _| {
                PreparedIntentStoreV1::persist(store, &task.intent).unwrap();
                persist_commit_receipt(store, ROOT_A, &receipt).unwrap();
            });
            task.receipt = Some(receipt);
            task.receipt_root_id = Some(ROOT_A.to_string());
        }
    }
    let activation_receipt = activation_receipt(&activation_verified);
    with_store(&database.path, ROOT_A, |store, _| {
        persist_activation_receipt(store, ROOT_A, &activation_receipt).unwrap();
    });
    activation_verified.activation_receipt = Some(activation_receipt.clone());
    activation_verified.activation_receipt_root_id = Some(ROOT_A.to_string());
    activation_verified.status = MigrationStatusV1::ActivationVerified;
    activation_verified.generation = 5;
    with_store(&database.path, ROOT_A, |store, _| {
        persist_transition(store, &partial_b, &activation_verified);
    });
    assert_eq!(load_migration(&database.path, ROOT_A), activation_verified);
    with_store(&database.path, ROOT_A, |store, _| {
        assert_eq!(
            store
                .load_published_activation_receipt(
                    &activation_verified
                        .activation_intent
                        .as_ref()
                        .unwrap()
                        .remote_path,
                )
                .unwrap(),
            Some(activation_receipt)
        );
        assert_eq!(
            store
                .load_prepared_activation_intent(
                    &activation_verified
                        .activation_intent
                        .as_ref()
                        .unwrap()
                        .remote_path,
                )
                .unwrap(),
            activation_verified.activation_intent
        );
    });
}

#[test]
fn discovery_audit_progress_cutover_and_fatal_survive_restart_monotonically() {
    let database = TempDatabase::new("discovery-cutover");
    let (_, _, planned) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    let mut discovery = create_discovery_state_v1();
    let commit_ref = &planned.stage_a[0].intent.commit_ref;
    discovery.observed_writers = vec![commit_ref.writer_id.clone()];
    discovery.observed_segments = vec![format!(
        "writers/{}/segments/00000000000000",
        commit_ref.writer_id
    )];
    discovery.observed_candidates = vec![ObservedCandidateV1::Commit {
        path: planned.stage_a[0].intent.remote_path.clone(),
        writer_id: commit_ref.writer_id.clone(),
        segment_name: "00000000000000".to_string(),
        writer_seq: commit_ref.writer_seq.clone(),
        commit_id: commit_ref.commit_id.clone(),
        content_hash: commit_ref.content_hash.clone(),
    }];
    discovery.known_gaps = vec![planned.stage_a[0].intent.remote_path.clone()];
    discovery.targeted_queue = vec![planned.stage_a[0].intent.commit_ref.clone()];
    discovery.historical_closed_segments = vec![format!(
        "writers/{}/segments/00000000000000",
        planned.stage_a[0].intent.commit_ref.writer_id
    )];
    discovery.historical_audit_cursor.last_writer_id =
        Some(planned.stage_a[0].intent.commit_ref.writer_id.clone());
    discovery
        .historical_audit_cursor
        .last_segment_by_writer
        .insert(
            planned.stage_a[0].intent.commit_ref.writer_id.clone(),
            Some("00000000000000".to_string()),
        );

    with_store(&database.path, ROOT_A, |store, _| {
        assert!(store
            .compare_and_swap_discovery_state(None, &discovery)
            .unwrap());
    });
    let VersionedDiscoveryStateV1 {
        storage_generation,
        state,
    } = with_store(&database.path, ROOT_A, |store, _| {
        store.load_discovery_state().unwrap().unwrap()
    });
    assert_eq!(storage_generation, 0);
    assert_eq!(state, discovery);

    let mut advanced = discovery.clone();
    advanced.last_round_indeterminate = true;
    with_store(&database.path, ROOT_A, |store, _| {
        assert!(store
            .compare_and_swap_discovery_state(Some(0), &advanced)
            .unwrap());
        assert!(!store
            .compare_and_swap_discovery_state(Some(0), &discovery)
            .unwrap());
    });
    let durable = with_store(&database.path, ROOT_A, |store, _| {
        store.load_discovery_state().unwrap().unwrap()
    });
    assert_eq!(durable.storage_generation, 1);
    assert_eq!(durable.state, advanced);

    let cutover = canonical_cutover(&planned, "activations/durable.json");
    with_store(&database.path, ROOT_A, |store, _| {
        store.persist_cutover_state(ROOT_A, &cutover).unwrap();
        store
            .persist_cutover_state(ROOT_A, &create_activation_cutover_state_v1())
            .unwrap();
    });
    let safety = with_store(&database.path, ROOT_A, |store, _| {
        store.load_root_safety(ROOT_A).unwrap()
    });
    assert!(safety.cutover_state.remote_s2_activated);
    assert_eq!(safety.cutover_state, cutover);
    assert_eq!(
        recover_activation_cutover_v1(&create_discovery_state_v1(), Some(&safety.cutover_state))
            .diagnostic_state(),
        Some(cutover)
    );

    with_store(&database.path, ROOT_B, |store, _| {
        assert!(store.load(ROOT_B).unwrap().is_none());
        assert!(store
            .persist_root_fatal(ROOT_B, "SYNC_ROOT_FROZEN_CORRUPTION")
            .unwrap()
            .is_none());
    });
    let (initial_b, _, _) = migration_states(ROOT_B, MIGRATION_B, WRITER_B, 1);
    with_store(&database.path, ROOT_B, |store, _| {
        let claimed = store.claim_or_load(&initial_b).unwrap();
        assert_eq!(claimed.status, MigrationStatusV1::RootFrozen);
        assert_eq!(
            claimed.root_fatal_signals,
            vec![MigrationRootFatalV1 {
                code: "SYNC_ROOT_FROZEN_CORRUPTION".to_string()
            }]
        );
    });
}

#[test]
fn real_sqlite_generation_cas_rejects_stale_migration_and_root_safety_writers() {
    let database = TempDatabase::new("cas");
    let (initial, captured, planned) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    let connection_a = Connection::open(&database.path).unwrap();
    connection_a
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    crate::db::setup_db(&connection_a).unwrap();
    let connection_b = Connection::open(&database.path).unwrap();
    connection_b
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    let connection_a = Mutex::new(connection_a);
    let connection_b = Mutex::new(connection_b);
    let mut writer_a = SqliteS2LiteStoreV1::open(&connection_a, ROOT_A).unwrap();
    let mut writer_b = SqliteS2LiteStoreV1::open(&connection_b, ROOT_A).unwrap();

    writer_a.claim_or_load(&initial).unwrap();
    let reader_a = writer_a.load(ROOT_A).unwrap().unwrap();
    let reader_b = writer_b.load(ROOT_A).unwrap().unwrap();
    assert!(writer_a
        .compare_and_swap(ROOT_A, MIGRATION_A, reader_a.generation, &captured,)
        .unwrap());
    let mut stale_frozen = reader_b;
    stale_frozen.generation = 1;
    stale_frozen.status = MigrationStatusV1::RootFrozen;
    stale_frozen.root_fatal_signals = vec![MigrationRootFatalV1 {
        code: "SYNC_ROOT_FROZEN_CORRUPTION".to_string(),
    }];
    assert!(!writer_b
        .compare_and_swap(ROOT_A, MIGRATION_A, 0, &stale_frozen)
        .unwrap());
    assert_eq!(writer_b.load(ROOT_A).unwrap(), Some(captured.clone()));

    let safety_a = writer_a.load_root_safety(ROOT_A).unwrap();
    let safety_b = writer_b.load_root_safety(ROOT_A).unwrap();
    let mut activated = safety_a;
    activated.generation = 1;
    activated.cutover_state = canonical_cutover(&planned, "activations/cas.json");
    assert!(writer_a
        .compare_and_swap_root_safety(0, &activated)
        .unwrap());
    let mut stale = safety_b;
    stale.generation = 1;
    stale.root_fatal_signals = vec![MigrationRootFatalV1 {
        code: "SYNC_ROOT_FROZEN_CORRUPTION".to_string(),
    }];
    assert!(!writer_b.compare_and_swap_root_safety(0, &stale).unwrap());
    assert_eq!(writer_b.load_root_safety(ROOT_A).unwrap(), activated);
    let connection = connection_a.lock().unwrap();
    let storage_types: (String, String) = connection
        .query_row(
            "SELECT typeof(r.authority_generation), typeof(m.migration_generation)
             FROM s2_lite_root_authority_v1 r
             JOIN s2_lite_migration_v1 m ON m.root_id=r.root_id
             WHERE r.root_id=?1",
            [ROOT_A],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(storage_types, ("text".to_string(), "text".to_string()));
}

#[test]
fn new_root_handoff_state_is_durable_without_reopening_the_frozen_old_root() {
    let database = TempDatabase::new("new-root-handoff");
    let (_, captured_a, _) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    let frozen = freeze_old_root_for_new_root_handoff_v1(
        &captured_a,
        &["SYNC_ROOT_FROZEN_CORRUPTION".to_string()],
    )
    .unwrap();
    let mut handoff =
        create_new_root_migration_handoff_v1(&frozen, MIGRATION_B, ROOT_B, WRITER_B, TIMESTAMP)
            .unwrap();
    handoff.generation = 1;
    let initial_b = create_migration_state_v1(
        MIGRATION_B,
        ROOT_B,
        WRITER_B,
        TIMESTAMP,
        "new-root-bootstrap",
    )
    .unwrap();
    with_store(&database.path, ROOT_B, |store, _| {
        store.claim_or_load(&initial_b).unwrap();
        persist_transition(store, &initial_b, &handoff);
    });
    let reloaded = load_migration(&database.path, ROOT_B);
    assert_eq!(reloaded, handoff);
    let preservation = reloaded.preservation_handoff.unwrap();
    assert_eq!(preservation.old_root_id, ROOT_A);
    assert_eq!(
        preservation.fatal_codes,
        vec!["SYNC_ROOT_FROZEN_CORRUPTION"]
    );
}

#[test]
fn physical_roots_isolate_authority_migration_cutover_intents_and_receipts() {
    let database = TempDatabase::new("root-isolation");
    let (initial_a, _, planned_a) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    let (initial_b, _, planned_b) = migration_states(ROOT_B, MIGRATION_B, WRITER_B, 1);
    with_store(&database.path, ROOT_A, |store, _| {
        store.claim_or_load(&initial_a).unwrap();
        store
            .persist_cutover_state(ROOT_A, &canonical_cutover(&planned_a, "activations/a.json"))
            .unwrap();
        PreparedIntentStoreV1::persist(store, &planned_a.stage_a[0].intent).unwrap();
        persist_commit_receipt(store, ROOT_A, &commit_receipt(&planned_a.stage_a[0])).unwrap();
        assert_eq!(
            store
                .persist_root_fatal(ROOT_B, "CROSS_ROOT")
                .unwrap_err()
                .0,
            "MIGRATION_ROOT_BINDING_MISMATCH"
        );
    });
    with_store(&database.path, ROOT_B, |store, _| {
        store.claim_or_load(&initial_b).unwrap();
        store
            .persist_root_fatal(ROOT_B, "SYNC_ROOT_FROZEN_CORRUPTION")
            .unwrap();
        PreparedIntentStoreV1::persist(store, &planned_b.stage_a[0].intent).unwrap();
        persist_commit_receipt(store, ROOT_B, &commit_receipt(&planned_b.stage_a[0])).unwrap();
    });
    with_store(&database.path, ROOT_A, |store, _| {
        let safety = store.load_root_safety(ROOT_A).unwrap();
        assert!(safety.cutover_state.remote_s2_activated);
        assert!(safety.root_fatal_signals.is_empty());
        assert_eq!(store.load(ROOT_A).unwrap(), Some(initial_a));
        assert!(store
            .load_prepared_intent(&planned_b.stage_a[0].intent.remote_path)
            .unwrap()
            .is_none());
        assert!(store
            .load_published_receipt(&planned_b.stage_a[0].intent.remote_path)
            .unwrap()
            .is_none());
    });
    with_store(&database.path, ROOT_B, |store, _| {
        let safety = store.load_root_safety(ROOT_B).unwrap();
        assert!(!safety.cutover_state.remote_s2_activated);
        assert_eq!(
            safety.root_fatal_signals[0].code,
            "SYNC_ROOT_FROZEN_CORRUPTION"
        );
        assert_eq!(
            store.load(ROOT_B).unwrap().unwrap().status,
            MigrationStatusV1::RootFrozen
        );
        assert!(store
            .load_prepared_intent(&planned_a.stage_a[0].intent.remote_path)
            .unwrap()
            .is_none());
    });
}

#[test]
fn receipts_and_fatal_facts_cannot_be_replaced_by_stale_values() {
    let database = TempDatabase::new("monotonic");
    let (_, _, planned) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    let task = &planned.stage_a[0];
    let receipt = commit_receipt(task);
    with_store(&database.path, ROOT_A, |store, _| {
        PreparedIntentStoreV1::persist(store, &task.intent).unwrap();
        persist_commit_receipt(store, ROOT_A, &receipt).unwrap();
        let mut replacement = receipt.clone();
        replacement.verified_at_diagnostic = "2026-09-13T00:00:01.000Z".to_string();
        assert_eq!(
            persist_commit_receipt(store, ROOT_A, &replacement)
                .unwrap_err()
                .0,
            "S2_DURABLE_STATE_CORRUPTION"
        );
        assert_eq!(
            store
                .load_published_receipt(&task.intent.remote_path)
                .unwrap(),
            Some(receipt.clone())
        );

        store
            .persist_root_fatal(ROOT_A, "SYNC_ROOT_FROZEN_CORRUPTION")
            .unwrap();
        let before = store.load_root_safety(ROOT_A).unwrap();
        store
            .persist_cutover_state(ROOT_A, &create_activation_cutover_state_v1())
            .unwrap();
        assert_eq!(store.load_root_safety(ROOT_A).unwrap(), before);
    });
}

#[test]
fn discovery_persistence_rejects_every_missing_field_unknown_fields_and_future_version() {
    let database = TempDatabase::new("strict-discovery");
    let discovery = create_discovery_state_v1();
    with_store(&database.path, ROOT_A, |store, _| {
        assert!(store
            .compare_and_swap_discovery_state(None, &discovery)
            .unwrap());
    });
    let original: Value = serde_json::from_slice(&read_blob(
        &database.path,
        "s2_lite_discovery_v1",
        "state_json",
        ROOT_A,
    ))
    .unwrap();
    assert_eq!(original["persistenceVersion"], 1);

    let required_fields = [
        "stateVersion",
        "observedActivations",
        "observedWriters",
        "observedSegments",
        "observedCandidates",
        "verifiedObjects",
        "knownGaps",
        "targetedQueue",
        "historicalClosedSegments",
        "historicalAuditCursor",
        "gapSegmentCursorByWriter",
        "reverificationQueue",
        "terminalCandidatePaths",
        "exactWorkScheduler",
        "lastRoundScheduledLists",
        "lastRoundScheduledGets",
        "rootFatalSignals",
        "lastRoundIndeterminate",
    ];
    for field in required_fields {
        let mut damaged = original.clone();
        assert!(damaged["payload"]
            .as_object_mut()
            .unwrap()
            .remove(field)
            .is_some());
        write_blob(
            &database.path,
            "s2_lite_discovery_v1",
            "state_json",
            ROOT_A,
            &damaged,
        );
        with_store(&database.path, ROOT_A, |store, _| {
            assert_corruption(store.load_discovery_state());
        });
    }

    let mut unknown = original.clone();
    unknown["payload"]["unknownDurableFact"] = json!(true);
    write_blob(
        &database.path,
        "s2_lite_discovery_v1",
        "state_json",
        ROOT_A,
        &unknown,
    );
    with_store(&database.path, ROOT_A, |store, _| {
        assert_corruption(store.load_discovery_state());
    });

    let mut future = original.clone();
    future["persistenceVersion"] = json!(2);
    write_blob(
        &database.path,
        "s2_lite_discovery_v1",
        "state_json",
        ROOT_A,
        &future,
    );
    with_store(&database.path, ROOT_A, |store, _| {
        assert_corruption(store.load_discovery_state());
    });

    write_blob(
        &database.path,
        "s2_lite_discovery_v1",
        "state_json",
        ROOT_A,
        &original,
    );
    with_store(&database.path, ROOT_A, |store, _| {
        assert_eq!(
            store.load_discovery_state().unwrap().unwrap().state,
            discovery
        );
    });
    with_store(&database.path, ROOT_B, |store, _| {
        assert!(store.load_discovery_state().unwrap().is_none());
    });
}

#[test]
fn root_safety_persistence_is_recursively_strict_and_corruption_is_not_absence() {
    let database = TempDatabase::new("strict-root-safety");
    let (_, _, planned) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    with_store(&database.path, ROOT_A, |store, _| {
        store
            .persist_cutover_state(ROOT_A, &canonical_cutover(&planned, "activations/a.json"))
            .unwrap();
    });
    let original: Value = serde_json::from_slice(&read_blob(
        &database.path,
        "s2_lite_root_authority_v1",
        "state_json",
        ROOT_A,
    ))
    .unwrap();

    let mut missing = original.clone();
    missing["payload"]
        .as_object_mut()
        .unwrap()
        .remove("rootFatalSignals");
    write_blob(
        &database.path,
        "s2_lite_root_authority_v1",
        "state_json",
        ROOT_A,
        &missing,
    );
    with_store(&database.path, ROOT_A, |store, _| {
        assert_corruption(store.load_root_safety(ROOT_A));
    });

    let mut unknown_cutover = original.clone();
    unknown_cutover["payload"]["cutoverState"]["unknownNestedField"] = json!(true);
    write_blob(
        &database.path,
        "s2_lite_root_authority_v1",
        "state_json",
        ROOT_A,
        &unknown_cutover,
    );
    with_store(&database.path, ROOT_A, |store, _| {
        assert_corruption(store.load_root_safety(ROOT_A));
    });

    let mut unknown_evidence = original.clone();
    unknown_evidence["payload"]["cutoverState"]["verifiedActivationEvidence"][0]
        ["unknownEvidenceField"] = json!(true);
    write_blob(
        &database.path,
        "s2_lite_root_authority_v1",
        "state_json",
        ROOT_A,
        &unknown_evidence,
    );
    with_store(&database.path, ROOT_A, |store, _| {
        assert_corruption(store.load_root_safety(ROOT_A));
    });

    let mut unknown_envelope = original.clone();
    unknown_envelope["unknownEnvelopeField"] = json!(true);
    write_blob(
        &database.path,
        "s2_lite_root_authority_v1",
        "state_json",
        ROOT_A,
        &unknown_envelope,
    );
    with_store(&database.path, ROOT_A, |store, _| {
        assert_corruption(store.load_root_safety(ROOT_A));
    });

    write_blob(
        &database.path,
        "s2_lite_root_authority_v1",
        "state_json",
        ROOT_A,
        &original,
    );
    with_store(&database.path, ROOT_A, |store, _| {
        assert!(
            store
                .load_root_safety(ROOT_A)
                .unwrap()
                .cutover_state
                .remote_s2_activated
        );
    });
}

#[test]
fn every_json_blob_uses_the_strict_persistence_envelope() {
    let database = TempDatabase::new("strict-all-blobs");
    let (initial, _, planned) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    let task = &planned.stage_a[0];
    with_store(&database.path, ROOT_A, |store, _| {
        store.claim_or_load(&initial).unwrap();
        store
            .compare_and_swap_discovery_state(None, &create_discovery_state_v1())
            .unwrap();
        PreparedIntentStoreV1::persist(store, &task.intent).unwrap();
        persist_commit_receipt(store, ROOT_A, &commit_receipt(task)).unwrap();
    });

    for (table, column) in [
        ("s2_lite_root_authority_v1", "state_json"),
        ("s2_lite_migration_v1", "state_json"),
        ("s2_lite_discovery_v1", "state_json"),
        ("s2_lite_prepared_intent_v1", "metadata_json"),
        ("s2_lite_published_receipt_v1", "receipt_json"),
    ] {
        let value: Value =
            serde_json::from_slice(&read_blob(&database.path, table, column, ROOT_A)).unwrap();
        assert_eq!(value["persistenceVersion"], 1, "{table}.{column}");
        assert!(value.get("payload").is_some(), "{table}.{column}");
        assert_eq!(value.as_object().unwrap().len(), 2, "{table}.{column}");
    }

    let mut corrupt_intent: Value = serde_json::from_slice(&read_blob(
        &database.path,
        "s2_lite_prepared_intent_v1",
        "metadata_json",
        ROOT_A,
    ))
    .unwrap();
    corrupt_intent["payload"]["commitRef"]["unknownNestedField"] = json!(true);
    write_blob(
        &database.path,
        "s2_lite_prepared_intent_v1",
        "metadata_json",
        ROOT_A,
        &corrupt_intent,
    );
    with_store(&database.path, ROOT_A, |store, _| {
        assert_corruption(store.load_prepared_intent(&task.intent.remote_path));
    });
}

#[test]
fn migration_cas_propagates_freeze_to_root_authority_and_cannot_reopen_publish() {
    let database = TempDatabase::new("cas-freeze-monotonic");
    let (initial, _, _) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    with_store(&database.path, ROOT_A, |store, _| {
        store.claim_or_load(&initial).unwrap();
        let mut frozen = initial.clone();
        frozen.generation = 1;
        frozen.status = MigrationStatusV1::RootFrozen;
        frozen.root_fatal_signals = vec![MigrationRootFatalV1 {
            code: "SYNC_ROOT_FROZEN_CORRUPTION".to_string(),
        }];
        assert!(store
            .compare_and_swap(ROOT_A, MIGRATION_A, 0, &frozen)
            .unwrap());
    });

    with_store(&database.path, ROOT_A, |store, _| {
        let frozen = store.load(ROOT_A).unwrap().unwrap();
        let safety = store.load_root_safety(ROOT_A).unwrap();
        assert_eq!(frozen.status, MigrationStatusV1::RootFrozen);
        assert_eq!(frozen.root_fatal_signals, safety.root_fatal_signals);

        let mut weakened = frozen.clone();
        weakened.generation = 2;
        weakened.status = MigrationStatusV1::NotStarted;
        weakened.root_fatal_signals.clear();
        assert_corruption(store.compare_and_swap(ROOT_A, MIGRATION_A, 1, &weakened));
        assert_eq!(store.load(ROOT_A).unwrap().unwrap(), frozen);
        assert_eq!(store.load_root_safety(ROOT_A).unwrap(), safety);

        let mut executed = false;
        let admission = store
            .run_publish_exclusive(ROOT_A, MIGRATION_A, 1, None, || {
                executed = true;
                Ok(())
            })
            .unwrap();
        assert!(!executed);
        assert!(matches!(admission, PublishExclusiveResultV1::Rejected(_)));
    });
}

#[test]
fn migration_and_root_freeze_updates_roll_back_as_one_sqlite_transaction() {
    let database = TempDatabase::new("cas-freeze-rollback");
    let (initial, _, _) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    with_store(&database.path, ROOT_A, |store, connection| {
        store.claim_or_load(&initial).unwrap();
        connection
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_migration_update
                 BEFORE UPDATE ON s2_lite_migration_v1
                 BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;",
            )
            .unwrap();
    });
    let mut frozen = initial.clone();
    frozen.generation = 1;
    frozen.status = MigrationStatusV1::RootFrozen;
    frozen.root_fatal_signals = vec![MigrationRootFatalV1 {
        code: "SYNC_ROOT_FROZEN_CORRUPTION".to_string(),
    }];
    with_store(&database.path, ROOT_A, |store, _| {
        assert_eq!(
            store
                .compare_and_swap(ROOT_A, MIGRATION_A, 0, &frozen)
                .unwrap_err()
                .0,
            "S2_DURABLE_PERSISTENCE_FAILURE"
        );
    });
    with_store(&database.path, ROOT_A, |store, connection| {
        assert_eq!(store.load(ROOT_A).unwrap(), Some(initial));
        assert!(store
            .load_root_safety(ROOT_A)
            .unwrap()
            .root_fatal_signals
            .is_empty());
        connection
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_migration_update")
            .unwrap();
    });
}

#[test]
fn receipts_are_bound_to_the_physical_root_for_commit_and_activation() {
    let database = TempDatabase::new("receipt-root-provenance");
    let (initial_a, _, planned) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    let (initial_b, _, _) = migration_states(ROOT_B, MIGRATION_B, WRITER_B, 1);
    let commit_intent = &planned.stage_a[0].intent;
    let commit = commit_receipt(&planned.stage_a[0]);
    let activation_intent = planned.activation_intent.as_ref().unwrap();
    let activation = activation_receipt(&planned);

    let mut remote_a = RootOnlyRemote {
        root_id: ROOT_A.to_string(),
        identity: 101,
        exact_objects: BTreeMap::from([
            (
                commit_intent.remote_path.clone(),
                commit_intent.exact_bytes.clone(),
            ),
            (
                activation_intent.remote_path.clone(),
                activation_intent.exact_bytes.clone(),
            ),
        ]),
    };
    with_store(&database.path, ROOT_A, |store, _| {
        let attachment = start_or_attach_migration_v1(&initial_a, store).unwrap();
        let _capability =
            create_migration_root_execution_capability_v1(&attachment, &remote_a, store).unwrap();
        PreparedIntentStoreV1::persist(store, commit_intent).unwrap();
        PreparedActivationIntentStoreV1::persist(store, activation_intent).unwrap();
        assert!(matches!(
            store
                .verify_and_persist_commit_receipt(commit_intent, &mut remote_a, TIMESTAMP)
                .unwrap(),
            super::immutable_publish::RecoverPreparedIntentResultV1::AlreadyPublishedExact(_)
        ));
        assert!(matches!(
            store
                .verify_and_persist_activation_receipt(activation_intent, &mut remote_a, TIMESTAMP,)
                .unwrap(),
            super::immutable_publish::RecoverActivationIntentResultV1::AlreadyPublishedExact(_)
        ));
    });
    let (loaded_a_commit, loaded_a_activation) = with_store(&database.path, ROOT_A, |store, _| {
        (
            store
                .load_published_receipt(&commit.remote_path)
                .unwrap()
                .unwrap(),
            store
                .load_published_activation_receipt(&activation.remote_path)
                .unwrap()
                .unwrap(),
        )
    });
    with_store(&database.path, ROOT_B, |store, _| {
        store.claim_or_load(&initial_b).unwrap();
        PreparedIntentStoreV1::persist(store, commit_intent).unwrap();
        PreparedActivationIntentStoreV1::persist(store, activation_intent).unwrap();
    });
    let mut remote_b = RootOnlyRemote {
        root_id: ROOT_B.to_string(),
        identity: 202,
        exact_objects: BTreeMap::new(),
    };
    with_store(&database.path, ROOT_B, |store, _| {
        let attachment = start_or_attach_migration_v1(&initial_b, store).unwrap();
        let _capability =
            create_migration_root_execution_capability_v1(&attachment, &remote_b, store).unwrap();
        // The loaded A values cannot be supplied to any persistence constructor.
        // With no B object, controlled verification creates no trusted receipt.
        assert_eq!(loaded_a_commit, commit);
        assert_eq!(loaded_a_activation, activation);
        assert_eq!(
            store
                .verify_and_persist_commit_receipt(commit_intent, &mut remote_b, TIMESTAMP)
                .unwrap(),
            super::immutable_publish::RecoverPreparedIntentResultV1::RetryPublishExact
        );
        assert_eq!(
            store
                .verify_and_persist_activation_receipt(activation_intent, &mut remote_b, TIMESTAMP,)
                .unwrap(),
            super::immutable_publish::RecoverActivationIntentResultV1::RetryPublishExact
        );
        assert!(store
            .load_published_receipt(&commit.remote_path)
            .unwrap()
            .is_none());
        assert!(store
            .load_published_activation_receipt(&activation.remote_path)
            .unwrap()
            .is_none());
    });

    remote_b.exact_objects.insert(
        commit_intent.remote_path.clone(),
        commit_intent.exact_bytes.clone(),
    );
    remote_b.exact_objects.insert(
        activation_intent.remote_path.clone(),
        activation_intent.exact_bytes.clone(),
    );
    with_store(&database.path, ROOT_B, |store, _| {
        assert!(matches!(
            store
                .verify_and_persist_commit_receipt(commit_intent, &mut remote_b, TIMESTAMP)
                .unwrap(),
            super::immutable_publish::RecoverPreparedIntentResultV1::AlreadyPublishedExact(_)
        ));
        assert!(matches!(
            store
                .verify_and_persist_activation_receipt(activation_intent, &mut remote_b, TIMESTAMP,)
                .unwrap(),
            super::immutable_publish::RecoverActivationIntentResultV1::AlreadyPublishedExact(_)
        ));
        assert_eq!(
            store.load_published_receipt(&commit.remote_path).unwrap(),
            Some(commit.clone())
        );
        assert_eq!(
            store
                .load_published_activation_receipt(&activation.remote_path)
                .unwrap(),
            Some(activation.clone())
        );
    });
    with_store(&database.path, ROOT_A, |store, _| {
        assert_eq!(
            store.load_published_receipt(&commit.remote_path).unwrap(),
            Some(commit)
        );
        assert_eq!(
            store
                .load_published_activation_receipt(&activation.remote_path)
                .unwrap(),
            Some(activation)
        );
    });
}

#[test]
fn nonempty_or_malformed_intent_metadata_exact_bytes_is_never_hidden() {
    let database = TempDatabase::new("intent-metadata-corruption");
    let (_, _, planned) = migration_states(ROOT_A, MIGRATION_A, WRITER_A, 1);
    let commit = &planned.stage_a[0].intent;
    let activation = planned.activation_intent.as_ref().unwrap();
    with_store(&database.path, ROOT_A, |store, _| {
        PreparedIntentStoreV1::persist(store, commit).unwrap();
        PreparedActivationIntentStoreV1::persist(store, activation).unwrap();
    });

    for (kind, remote_path) in [
        ("commit", commit.remote_path.as_str()),
        ("activation", activation.remote_path.as_str()),
    ] {
        let connection = Connection::open(&database.path).unwrap();
        let original: Vec<u8> = connection
            .query_row(
                "SELECT metadata_json FROM s2_lite_prepared_intent_v1
                 WHERE root_id=?1 AND intent_kind=?2 AND remote_path=?3",
                params![ROOT_A, kind, remote_path],
                |row| row.get(0),
            )
            .unwrap();
        let mut nonempty: Value = serde_json::from_slice(&original).unwrap();
        nonempty["payload"]["exactBytes"] = json!([1, 2, 3]);
        let nonempty_bytes = serde_json::to_vec(&nonempty).unwrap();
        connection
            .execute(
                "UPDATE s2_lite_prepared_intent_v1 SET metadata_json=?4
                 WHERE root_id=?1 AND intent_kind=?2 AND remote_path=?3",
                params![ROOT_A, kind, remote_path, nonempty_bytes],
            )
            .unwrap();
        drop(connection);
        with_store(&database.path, ROOT_A, |store, _| {
            if kind == "commit" {
                assert_corruption(store.load_prepared_intent(remote_path));
            } else {
                assert_corruption(store.load_prepared_activation_intent(remote_path));
            }
        });
        let connection = Connection::open(&database.path).unwrap();
        let retained_corruption: Vec<u8> = connection
            .query_row(
                "SELECT metadata_json FROM s2_lite_prepared_intent_v1
                 WHERE root_id=?1 AND intent_kind=?2 AND remote_path=?3",
                params![ROOT_A, kind, remote_path],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained_corruption, nonempty_bytes);
        drop(connection);

        let mut malformed: Value = serde_json::from_slice(&original).unwrap();
        malformed["payload"]
            .as_object_mut()
            .unwrap()
            .remove("contentHash");
        let malformed_bytes = serde_json::to_vec(&malformed).unwrap();
        let connection = Connection::open(&database.path).unwrap();
        connection
            .execute(
                "UPDATE s2_lite_prepared_intent_v1 SET metadata_json=?4
                 WHERE root_id=?1 AND intent_kind=?2 AND remote_path=?3",
                params![ROOT_A, kind, remote_path, malformed_bytes],
            )
            .unwrap();
        drop(connection);
        with_store(&database.path, ROOT_A, |store, _| {
            if kind == "commit" {
                assert_corruption(store.load_prepared_intent(remote_path));
            } else {
                assert_corruption(store.load_prepared_activation_intent(remote_path));
            }
        });

        let connection = Connection::open(&database.path).unwrap();
        connection
            .execute(
                "UPDATE s2_lite_prepared_intent_v1 SET metadata_json=?4
                 WHERE root_id=?1 AND intent_kind=?2 AND remote_path=?3",
                params![ROOT_A, kind, remote_path, original],
            )
            .unwrap();
    }
    with_store(&database.path, ROOT_A, |store, _| {
        assert_eq!(
            store.load_prepared_intent(&commit.remote_path).unwrap(),
            Some(commit.clone())
        );
        assert_eq!(
            store
                .load_prepared_activation_intent(&activation.remote_path)
                .unwrap(),
            Some(activation.clone())
        );
    });
}
