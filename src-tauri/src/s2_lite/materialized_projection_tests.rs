use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::canonical::sha256_hex;
use super::durable_persistence::{DurableMaterializedProjectionV1, SqliteS2LiteStoreV1};
use super::materialized_projection::{
    rebuild_materialized_projection_v1, resolve_ordinary_causal_base_v1,
    MaterializedProjectionStateV1, MaterializedProjectionStatusV1, OrdinaryCausalBaseResolutionV1,
};
use super::migration_orchestration::create_migration_root_safety_state_v1;
use super::ordinary_mutation::OrdinaryCausalBaseV1;
use super::remote_discovery::{
    create_discovery_state_v1, DiscoveryStateV1, VerifiedFingerprintEvidenceV1,
    VerifiedRemoteObjectV1,
};

const ROOT: &str = "s2-root-v1:materialized-projection-test";

fn causal_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../contracts/s2-lite/v1/causal-golden-v1.json"
    ))
    .expect("valid shared causal fixture")
}

fn fixture_commit(case_name: &str, commit_id: &str) -> Value {
    causal_fixture()["cases"]
        .as_array()
        .expect("fixture cases")
        .iter()
        .find(|case| case["name"] == case_name)
        .and_then(|case| case["objects"].as_array())
        .and_then(|objects| {
            objects
                .iter()
                .find(|object| object["commitId"] == commit_id)
        })
        .cloned()
        .expect("fixture commit")
}

fn raw_commit(mut commit: Value, make_root_commit: bool) -> Vec<u8> {
    let object = commit.as_object_mut().expect("commit object");
    object.remove("contentHash");
    if make_root_commit {
        object.insert("basisClock".to_string(), Value::Array(vec![]));
        object
            .get_mut("mutations")
            .and_then(Value::as_array_mut)
            .expect("commit mutations")
            .iter_mut()
            .for_each(|mutation| {
                mutation["baseFrontier"] = Value::Array(vec![]);
            });
    }
    serde_json::to_vec(&commit).expect("serialize raw commit")
}

fn exact_bytes_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn discovery_with_commits(commits: &[(&str, Vec<u8>)]) -> DiscoveryStateV1 {
    let mut state = create_discovery_state_v1();
    state.verified_objects = commits
        .iter()
        .map(|(path, bytes)| VerifiedRemoteObjectV1 {
            path: (*path).to_string(),
            kind: "commit".to_string(),
            exact_bytes_hash: sha256_hex(bytes),
            exact_bytes_hex: exact_bytes_hex(bytes),
            content_hash: sha256_hex(bytes),
            commit_ref: None,
            activation_id: None,
            fingerprint_evidence: VerifiedFingerprintEvidenceV1::Missing,
        })
        .collect();
    state
}

fn projection(
    state: &MaterializedProjectionStateV1,
    projection_generation: u64,
    source_discovery_generation: u64,
    source_root_safety_generation: u64,
) -> DurableMaterializedProjectionV1 {
    DurableMaterializedProjectionV1 {
        projection_version: 1,
        physical_root_id: ROOT.to_string(),
        projection_generation,
        source_discovery_generation,
        source_root_safety_generation,
        replay_input_fingerprint: state.replay_input_fingerprint.clone(),
        business_projection_applied_generation: None,
        state: state.clone(),
    }
}

#[test]
fn materialized_projection_live_entity_materializes_correctly() {
    let bytes = raw_commit(
        fixture_commit(
            "single-writer-seq-1-3",
            "20000000-0000-4000-8000-000000000001",
        ),
        false,
    );
    let state = rebuild_materialized_projection_v1(&discovery_with_commits(&[(
        "commits/live.json",
        bytes,
    )]))
    .unwrap();

    let key = json!(["collection", "c"]);
    let entity = state
        .entities
        .iter()
        .find(|entity| entity.entity_key == key)
        .expect("live entity in projection");
    assert_eq!(entity.semantic_state.as_ref().unwrap()["state"], "live");
    assert!(!entity.conflict);
    assert!(matches!(
        resolve_ordinary_causal_base_v1(&state, &key).unwrap(),
        OrdinaryCausalBaseResolutionV1::Ready {
            causal_base: OrdinaryCausalBaseV1::Live(_),
            ..
        }
    ));
}

#[test]
fn materialized_projection_tombstone_materializes_correctly() {
    let bytes = raw_commit(
        fixture_commit("live-tombstone", "20000000-0000-4000-8000-000000000010"),
        true,
    );
    let state = rebuild_materialized_projection_v1(&discovery_with_commits(&[(
        "commits/tombstone.json",
        bytes,
    )]))
    .unwrap();

    let key = json!(["collection", "c"]);
    let entity = state
        .entities
        .iter()
        .find(|entity| entity.entity_key == key)
        .expect("tombstone entity in projection");
    assert_eq!(
        entity.semantic_state.as_ref().unwrap()["state"],
        "tombstone"
    );
    assert!(entity.business_value.is_none());
    assert!(!entity.conflict);
    assert!(matches!(
        resolve_ordinary_causal_base_v1(&state, &key).unwrap(),
        OrdinaryCausalBaseResolutionV1::Ready {
            causal_base: OrdinaryCausalBaseV1::Tombstone,
            ..
        }
    ));
}

#[test]
fn materialized_projection_causally_proven_absent_is_absent() {
    let state = rebuild_materialized_projection_v1(&create_discovery_state_v1()).unwrap();
    let resolution =
        resolve_ordinary_causal_base_v1(&state, &json!(["record", "missing"])).unwrap();

    assert!(matches!(
        state.status,
        MaterializedProjectionStatusV1::Complete
    ));
    assert!(state.entities.is_empty());
    assert!(matches!(
        resolution,
        OrdinaryCausalBaseResolutionV1::Ready {
            causal_base: OrdinaryCausalBaseV1::Absent,
            base_frontier,
            ..
        } if base_frontier.is_empty()
    ));
}

#[test]
fn materialized_projection_pending_history_is_not_absent() {
    let bytes = raw_commit(
        fixture_commit(
            "missing-dependency-pending",
            "20000000-0000-4000-8000-000000000004",
        ),
        false,
    );
    let state = rebuild_materialized_projection_v1(&discovery_with_commits(&[(
        "commits/pending.json",
        bytes,
    )]))
    .unwrap();
    let resolution = resolve_ordinary_causal_base_v1(&state, &json!(["collection", "c"])).unwrap();

    assert!(matches!(
        state.status,
        MaterializedProjectionStatusV1::PendingDependencies { .. }
    ));
    assert!(matches!(
        resolution,
        OrdinaryCausalBaseResolutionV1::PendingDependencies
    ));
    assert!(!matches!(
        resolution,
        OrdinaryCausalBaseResolutionV1::Ready {
            causal_base: OrdinaryCausalBaseV1::Absent,
            ..
        }
    ));
}

#[test]
fn materialized_projection_conflict_is_preserved_as_conflict_blocked() {
    let live = raw_commit(
        fixture_commit(
            "single-writer-seq-1-3",
            "20000000-0000-4000-8000-000000000001",
        ),
        false,
    );
    let tombstone = raw_commit(
        fixture_commit("live-tombstone", "20000000-0000-4000-8000-000000000010"),
        true,
    );
    let state = rebuild_materialized_projection_v1(&discovery_with_commits(&[
        ("commits/a-live.json", live),
        ("commits/b-tombstone.json", tombstone),
    ]))
    .unwrap();

    let key = json!(["collection", "c"]);
    let entity = state
        .entities
        .iter()
        .find(|entity| entity.entity_key == key)
        .expect("conflict entity in projection");
    assert!(entity.semantic_state.is_none());
    assert!(entity.business_value.is_none());
    assert!(entity.conflict);
    assert!(matches!(
        resolve_ordinary_causal_base_v1(&state, &key).unwrap(),
        OrdinaryCausalBaseResolutionV1::ConflictBlocked
    ));
}

#[test]
fn materialized_projection_fingerprint_is_deterministic_for_same_verified_history() {
    let bytes = raw_commit(
        fixture_commit(
            "single-writer-seq-1-3",
            "20000000-0000-4000-8000-000000000001",
        ),
        false,
    );
    let discovery = discovery_with_commits(&[("commits/live.json", bytes)]);
    let first = rebuild_materialized_projection_v1(&discovery).unwrap();
    let second = rebuild_materialized_projection_v1(&discovery).unwrap();

    assert_eq!(
        first.replay_input_fingerprint,
        second.replay_input_fingerprint
    );
    assert_eq!(first, second);
}

#[test]
fn materialized_projection_binds_discovery_and_root_safety_generations() {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::setup_db(&conn).unwrap();
    let conn = Mutex::new(conn);
    let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
    let discovery = create_discovery_state_v1();
    assert!(store
        .compare_and_swap_discovery_state(None, &discovery)
        .unwrap());
    let state = rebuild_materialized_projection_v1(&discovery).unwrap();

    let initial = projection(&state, 1, 0, 0);
    assert!(store
        .compare_and_swap_materialized_projection(None, &initial)
        .unwrap());

    assert!(store
        .compare_and_swap_discovery_state(Some(0), &create_discovery_state_v1())
        .unwrap());
    let stale_discovery = projection(&state, 2, 0, 0);
    assert!(!store
        .compare_and_swap_materialized_projection(Some(1), &stale_discovery)
        .unwrap());

    let mut safety = create_migration_root_safety_state_v1(ROOT);
    safety.generation = 1;
    assert!(store.compare_and_swap_root_safety(0, &safety).unwrap());

    let stale_root_safety = projection(&state, 2, 1, 0);
    assert!(!store
        .compare_and_swap_materialized_projection(Some(1), &stale_root_safety)
        .unwrap());

    let current = projection(&state, 2, 1, 1);
    assert!(store
        .compare_and_swap_materialized_projection(Some(1), &current)
        .unwrap());
    let stored = store.load_materialized_projection().unwrap().unwrap();
    assert_eq!(stored.source_discovery_generation, 1);
    assert_eq!(stored.source_root_safety_generation, 1);
}
