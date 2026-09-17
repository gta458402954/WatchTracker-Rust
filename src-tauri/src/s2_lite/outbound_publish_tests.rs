use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

use base64::Engine;
use rusqlite::Connection;

use super::durable_persistence::{OutboundBatchMutationV1, OutboundBatchV1, SqliteS2LiteStoreV1};
use super::immutable_publish::{
    prepare_commit_intent_v1, ImmutableObjectRemoteV1, RemoteExactGetResultV1, RemotePutResultV1,
};
use super::outbound_publish::{
    publish_frozen_outbound_batch_with_factory_v1, HistoricalWebDavCredentialsV1,
    OutboundPublishResultV1,
};
use super::root_coordinator::RootExecutionCoordinatorV1;
use super::target_root_binding::resolve_active_target_root_authority_v1;
use crate::sync_staging::{get_staging, set_staging, StagedRecord, SyncStaging};
use crate::sync_targets::{self, SyncTarget, SyncTargetRegistry};

const TIME: &str = "2026-09-17T00:00:00.000Z";

struct RemoteState {
    objects: BTreeMap<String, Vec<u8>>,
    get_results: VecDeque<RemoteExactGetResultV1>,
    put_result: RemotePutResultV1,
    put_calls: usize,
    puts: Vec<(String, Vec<u8>)>,
}

impl Default for RemoteState {
    fn default() -> Self {
        Self {
            objects: BTreeMap::new(),
            get_results: VecDeque::new(),
            put_result: RemotePutResultV1::Success,
            put_calls: 0,
            puts: vec![],
        }
    }
}

struct FakeRemote {
    root: String,
    state: Arc<Mutex<RemoteState>>,
}

impl ImmutableObjectRemoteV1 for FakeRemote {
    fn physical_root_id(&self) -> Option<&str> {
        Some(&self.root)
    }

    fn execution_context_identity(&self) -> u64 {
        11
    }

    fn get_exact(&mut self, path: &str) -> RemoteExactGetResultV1 {
        let mut state = self.state.lock().unwrap();
        state.get_results.pop_front().unwrap_or_else(|| {
            state.objects.get(path).cloned().map_or(
                RemoteExactGetResultV1::DefinitelyAbsent,
                RemoteExactGetResultV1::DefinitelyPresent,
            )
        })
    }

    fn put_exact(&mut self, path: &str, bytes: &[u8], _: bool) -> RemotePutResultV1 {
        let mut state = self.state.lock().unwrap();
        state.put_calls += 1;
        state.puts.push((path.to_string(), bytes.to_vec()));
        state.objects.insert(path.to_string(), bytes.to_vec());
        state.put_result
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

fn target(url: &str, username: &str) -> SyncTarget {
    let normalized_url = sync_targets::normalize_url(url).unwrap();
    SyncTarget {
        id: sync_targets::target_id(&normalized_url, username),
        normalized_url,
        username: username.into(),
        created_at: TIME.into(),
        last_activated_at: TIME.into(),
    }
}

fn set_registry(conn: &Mutex<Connection>, targets: Vec<SyncTarget>, active: &str, epoch: u64) {
    let registry = SyncTargetRegistry {
        version: 1,
        active_target_id: Some(active.to_string()),
        target_epoch: epoch,
        targets,
    };
    conn.lock()
        .unwrap()
        .execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [
                sync_targets::REGISTRY_KEY,
                &serde_json::to_string(&registry).unwrap(),
            ],
        )
        .unwrap();
}

fn setup() -> (
    Mutex<Connection>,
    OutboundBatchV1,
    super::immutable_publish::PreparedIntentV1,
) {
    let raw = Connection::open_in_memory().unwrap();
    crate::db::setup_db(&raw).unwrap();
    let conn = Mutex::new(raw);
    let historical = target("https://dav.example.test/root/", "Alice");
    set_registry(&conn, vec![historical.clone()], &historical.id, 1);
    let authority = resolve_active_target_root_authority_v1(&conn, &historical.id, 1).unwrap();
    let intent = prepared();
    let commit = super::causal::decode_frozen_wire_commit_v1(&intent.exact_bytes).unwrap();
    let batch = OutboundBatchV1 {
        state_version: 1,
        batch_id: "30000000-0000-4000-8000-000000000001".into(),
        target_id: historical.id,
        target_epoch: 1,
        physical_root_id: authority.binding.physical_root_id.clone(),
        projection_generation: 1,
        source_discovery_generation: 0,
        source_root_safety_generation: 0,
        captured_local_generation: 7,
        mutations: vec![OutboundBatchMutationV1 {
            entity_kind: "record".into(),
            entity_id: "record-1".into(),
            entity_key: serde_json::json!(["record", "record-1"]),
            captured_last_generation: 7,
            local_mutation_id: "30000000-0000-4000-8000-000000000002".into(),
        }],
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
    let mut store = SqliteS2LiteStoreV1::open(&conn, &batch.physical_root_id).unwrap();
    store
        .persist_outbound_batch_with_intent(&batch, &intent)
        .unwrap();
    (conn, batch, intent)
}

fn credentials(batch: &OutboundBatchV1) -> HistoricalWebDavCredentialsV1 {
    HistoricalWebDavCredentialsV1 {
        canonical_url: "https://dav.example.test/root/".into(),
        username: "Alice".into(),
        password: format!("historical:{}", batch.target_epoch),
    }
}

fn publish(
    conn: &Mutex<Connection>,
    coordinator: &RootExecutionCoordinatorV1,
    batch: &OutboundBatchV1,
    state: Arc<Mutex<RemoteState>>,
) -> OutboundPublishResultV1 {
    publish_frozen_outbound_batch_with_factory_v1(
        conn,
        coordinator,
        batch,
        |_| Ok(Some(credentials(batch))),
        |binding, _| {
            Ok(FakeRemote {
                root: binding.physical_root_id.clone(),
                state,
            })
        },
        TIME,
    )
    .unwrap()
}

#[test]
fn existing_receipt_short_circuits_with_zero_put_and_unchanged_writer_head() {
    let (conn, batch, intent) = setup();
    let state = Arc::new(Mutex::new(RemoteState::default()));
    state
        .lock()
        .unwrap()
        .objects
        .insert(intent.remote_path.clone(), intent.exact_bytes.clone());
    let mut store = SqliteS2LiteStoreV1::open(&conn, &batch.physical_root_id).unwrap();
    let mut remote = FakeRemote {
        root: batch.physical_root_id.clone(),
        state: state.clone(),
    };
    store
        .verify_and_persist_commit_receipt(&intent, &mut remote, TIME)
        .unwrap();
    let before = store.load_desktop_root_state().unwrap();
    let result = publish(
        &conn,
        &RootExecutionCoordinatorV1::default(),
        &batch,
        state.clone(),
    );
    let after = SqliteS2LiteStoreV1::open(&conn, &batch.physical_root_id)
        .unwrap()
        .load_desktop_root_state()
        .unwrap();
    assert_eq!(result, OutboundPublishResultV1::AlreadyPublished);
    assert_eq!(state.lock().unwrap().put_calls, 0);
    assert_eq!(before, after);
}

#[test]
fn exact_existing_and_definitely_absent_both_persist_only_verified_receipts() {
    let (exact_conn, exact_batch, exact_intent) = setup();
    let exact_state = Arc::new(Mutex::new(RemoteState::default()));
    exact_state.lock().unwrap().objects.insert(
        exact_intent.remote_path.clone(),
        exact_intent.exact_bytes.clone(),
    );
    assert_eq!(
        publish(
            &exact_conn,
            &RootExecutionCoordinatorV1::default(),
            &exact_batch,
            exact_state.clone()
        ),
        OutboundPublishResultV1::Published
    );
    assert_eq!(exact_state.lock().unwrap().put_calls, 0);

    let (absent_conn, absent_batch, absent_intent) = setup();
    let absent_state = Arc::new(Mutex::new(RemoteState::default()));
    let staged = SyncStaging {
        version: 2,
        entries: vec![StagedRecord {
            entity_kind: "record".into(),
            id: "staged-record".into(),
            operation: "upsert".into(),
            base: None,
            local: Some(serde_json::json!({"id":"staged-record"})),
            first_generation: 4,
            last_generation: 4,
            delete_descriptor: None,
        }],
    };
    set_staging(&absent_conn.lock().unwrap(), &staged).unwrap();
    let before_staging = get_staging(&absent_conn.lock().unwrap()).unwrap();
    let before_root = SqliteS2LiteStoreV1::open(&absent_conn, &absent_batch.physical_root_id)
        .unwrap()
        .load_desktop_root_state()
        .unwrap();
    assert_eq!(
        publish(
            &absent_conn,
            &RootExecutionCoordinatorV1::default(),
            &absent_batch,
            absent_state.clone()
        ),
        OutboundPublishResultV1::Published
    );
    let remote = absent_state.lock().unwrap();
    assert_eq!(remote.put_calls, 1);
    assert_eq!(
        remote.puts,
        vec![(absent_intent.remote_path.clone(), absent_intent.exact_bytes)]
    );
    drop(remote);
    assert!(
        SqliteS2LiteStoreV1::open(&absent_conn, &absent_batch.physical_root_id)
            .unwrap()
            .load_published_receipt(&absent_batch.prepared_intent_path)
            .unwrap()
            .is_some()
    );
    assert_eq!(
        get_staging(&absent_conn.lock().unwrap()).unwrap(),
        before_staging
    );
    assert_eq!(
        SqliteS2LiteStoreV1::open(&absent_conn, &absent_batch.physical_root_id)
            .unwrap()
            .load_desktop_root_state()
            .unwrap(),
        before_root
    );
}

#[test]
fn response_loss_restart_verifies_exact_object_without_a_duplicate_put() {
    let (conn, batch, intent) = setup();
    let coordinator = RootExecutionCoordinatorV1::default();
    let state = Arc::new(Mutex::new(RemoteState {
        get_results: VecDeque::from([
            RemoteExactGetResultV1::DefinitelyAbsent,
            RemoteExactGetResultV1::Indeterminate,
        ]),
        ..Default::default()
    }));
    assert_eq!(
        publish(&conn, &coordinator, &batch, state.clone()),
        OutboundPublishResultV1::Pending
    );
    assert_eq!(state.lock().unwrap().put_calls, 1);
    assert_eq!(
        publish(&conn, &coordinator, &batch, state.clone()),
        OutboundPublishResultV1::Published
    );
    let state = state.lock().unwrap();
    assert_eq!(state.put_calls, 1);
    assert_eq!(state.puts, vec![(intent.remote_path, intent.exact_bytes)]);
}

#[test]
fn indeterminate_get_is_pending_while_mismatch_and_root_frozen_make_zero_put() {
    let (indeterminate_conn, indeterminate_batch, _) = setup();
    let indeterminate_state = Arc::new(Mutex::new(RemoteState {
        get_results: VecDeque::from([RemoteExactGetResultV1::Indeterminate]),
        ..Default::default()
    }));
    assert_eq!(
        publish(
            &indeterminate_conn,
            &RootExecutionCoordinatorV1::default(),
            &indeterminate_batch,
            indeterminate_state.clone()
        ),
        OutboundPublishResultV1::Pending
    );
    assert_eq!(indeterminate_state.lock().unwrap().put_calls, 0);

    let (mismatch_conn, mismatch_batch, _) = setup();
    let mismatch_state = Arc::new(Mutex::new(RemoteState::default()));
    mismatch_state.lock().unwrap().objects.insert(
        mismatch_batch.prepared_intent_path.clone(),
        b"different".to_vec(),
    );
    assert_eq!(
        publish(
            &mismatch_conn,
            &RootExecutionCoordinatorV1::default(),
            &mismatch_batch,
            mismatch_state.clone()
        ),
        OutboundPublishResultV1::RootFrozen
    );
    assert_eq!(mismatch_state.lock().unwrap().put_calls, 0);

    let (frozen_conn, frozen_batch, _) = setup();
    let mut store =
        SqliteS2LiteStoreV1::open(&frozen_conn, &frozen_batch.physical_root_id).unwrap();
    super::migration_orchestration::MigrationStateStoreV1::persist_root_fatal(
        &mut store,
        &frozen_batch.physical_root_id,
        "S2_TEST_ROOT_FROZEN",
    )
    .unwrap();
    let frozen_state = Arc::new(Mutex::new(RemoteState::default()));
    assert_eq!(
        publish(
            &frozen_conn,
            &RootExecutionCoordinatorV1::default(),
            &frozen_batch,
            frozen_state.clone()
        ),
        OutboundPublishResultV1::RootFrozen
    );
    assert_eq!(frozen_state.lock().unwrap().put_calls, 0);
}

#[test]
fn historical_binding_survives_active_switch_and_unavailable_credentials_do_not_retarget() {
    let (conn, batch, _) = setup();
    let historical = target("https://dav.example.test/root/", "Alice");
    let active = target("https://dav.example.test/other/", "Bob");
    set_registry(&conn, vec![historical, active.clone()], &active.id, 2);
    let state = Arc::new(Mutex::new(RemoteState::default()));
    let used_target = Arc::new(Mutex::new(None));
    let used_target_copy = used_target.clone();
    let result = publish_frozen_outbound_batch_with_factory_v1(
        &conn,
        &RootExecutionCoordinatorV1::default(),
        &batch,
        |_| Ok(Some(credentials(&batch))),
        |binding, _| {
            *used_target_copy.lock().unwrap() = Some(binding.target_id.clone());
            Ok(FakeRemote {
                root: binding.physical_root_id.clone(),
                state: state.clone(),
            })
        },
        TIME,
    )
    .unwrap();
    assert_eq!(result, OutboundPublishResultV1::Published);
    assert_eq!(*used_target.lock().unwrap(), Some(batch.target_id.clone()));

    let (unavailable_conn, unavailable_batch, _) = setup();
    let factory_called = Arc::new(Mutex::new(false));
    let factory_called_copy = factory_called.clone();
    let result = publish_frozen_outbound_batch_with_factory_v1::<FakeRemote, _, _>(
        &unavailable_conn,
        &RootExecutionCoordinatorV1::default(),
        &unavailable_batch,
        |_| Ok(None),
        move |_, _| {
            *factory_called_copy.lock().unwrap() = true;
            unreachable!("credentials must gate remote construction")
        },
        TIME,
    )
    .unwrap();
    assert_eq!(result, OutboundPublishResultV1::Pending);
    assert!(!*factory_called.lock().unwrap());
}

#[test]
fn concurrent_same_root_callers_publish_the_frozen_intent_once() {
    let (conn, batch, _) = setup();
    let conn = Arc::new(conn);
    let batch = Arc::new(batch);
    let coordinator = Arc::new(RootExecutionCoordinatorV1::default());
    let state = Arc::new(Mutex::new(RemoteState::default()));
    let barrier = Arc::new(Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let conn = conn.clone();
            let batch = batch.clone();
            let coordinator = coordinator.clone();
            let state = state.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                publish(conn.as_ref(), coordinator.as_ref(), batch.as_ref(), state)
            })
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert!(results.contains(&OutboundPublishResultV1::Published));
    assert!(results.contains(&OutboundPublishResultV1::AlreadyPublished));
    assert_eq!(state.lock().unwrap().put_calls, 1);
}
