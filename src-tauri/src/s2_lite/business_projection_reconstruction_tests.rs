use std::{path::Path, sync::Mutex};

use rusqlite::Connection;
use serde_json::{json, Value};

use super::{
    business_projection::apply_complete_projection_v1,
    canonical::sha256_hex,
    durable_persistence::{
        DesktopRootStateV1, DurableMaterializedProjectionV1, SqliteS2LiteStoreV1,
    },
    materialized_projection::rebuild_materialized_projection_v1,
    migration_orchestration::{
        capture_legacy_snapshot_v1, create_migration_state_v1, plan_captured_migration_v1,
        retain_captured_snapshot_v1, LegacySnapshotEntryV1,
    },
    remote_discovery::{
        create_discovery_state_v1, DiscoveryStateV1, VerifiedFingerprintEvidenceV1,
        VerifiedRemoteObjectV1,
    },
    types::{BootstrapEntity, LegacySemanticAdapterV1},
};

const ROOT: &str = "root://business-reconstruction";
const WRITER: &str = "71000000-0000-4000-8000-000000000001";
const CREATED: &str = "2026-10-06T00:00:00.000Z";

struct Adapter;
impl LegacySemanticAdapterV1 for Adapter {
    fn adapt_live_entity(&self, kind: &str, value: &Value) -> Result<BootstrapEntity, String> {
        Ok(BootstrapEntity {
            entity_type: kind.into(),
            entity_key: match kind {
                "collection-member" => json!([kind, value["collectionId"], value["recordId"]]),
                "episode-completion" => json!([kind, value["recordId"], value["episodeNumber"]]),
                _ => json!([kind, value["id"]]),
            },
            value: value.clone(),
        })
    }
}

fn record(id: &str) -> Value {
    json!({"id":id,"originalName":id,"chineseName":"","progress":"","totalEpisodes":6,"episodeTrackingEnabled":true,"nextEpisode":1,"movieProgress":null,"movieDuration":null,"releaseYear":null,"posterPath":null,"status":"未看","platform":"","rating":null,"startDate":null,"endDate":null,"notes":"verified","createdAt":CREATED,"updatedAt":null,"imdbId":null,"isLocked":false,"genres":null,"originCountry":null,"imdbRating":null,"tmdbStatus":null,"interestLevel":null,"episodeRuntime":null,"mediaType":"剧集","contentTags":null,"tmdbMediaKind":null,"tmdbId":null,"tmdbParentId":null,"tmdbSeasonNumber":null,"seriesRecordKind":null,"rev":"9007199254740993","revActor":"verified-origin"})
}

fn discovery_from_entries(entries: Vec<LegacySnapshotEntryV1>) -> DiscoveryStateV1 {
    let initial = create_migration_state_v1(
        "70000000-0000-4000-8000-000000000001",
        ROOT,
        WRITER,
        CREATED,
        "legacy-bootstrap",
    )
    .unwrap();
    let snapshot = capture_legacy_snapshot_v1(&entries, &Adapter).unwrap();
    let captured = retain_captured_snapshot_v1(&initial, &snapshot).unwrap();
    let planned = plan_captured_migration_v1(&captured).unwrap();
    assert_eq!(planned.stage_a.len(), 1);
    let mut discovery = create_discovery_state_v1();
    for task in planned.stage_a.iter().chain(&planned.stage_b) {
        let intent = &task.intent;
        discovery.verified_objects.push(VerifiedRemoteObjectV1 {
            path: intent.remote_path.clone(),
            kind: "commit".into(),
            exact_bytes_hash: sha256_hex(&intent.exact_bytes),
            exact_bytes_hex: intent
                .exact_bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            content_hash: intent.content_hash.clone(),
            commit_ref: Some(intent.commit_ref.clone()),
            activation_id: None,
            fingerprint_evidence: VerifiedFingerprintEvidenceV1::Missing,
        });
    }
    discovery
}

fn bootstrap_discovery() -> DiscoveryStateV1 {
    let discovery = discovery_from_entries(
        (0..3)
            .map(|index| LegacySnapshotEntryV1 {
                entity_type: "record".into(),
                value: record(&format!("record-{index}")),
            })
            .collect(),
    );
    assert_eq!(discovery.verified_objects.len(), 1); // one A, zero B
    discovery
}

fn persist_projection(path: &Path, discovery: &DiscoveryStateV1) {
    with_store(path, |store, _| {
        assert!(store
            .compare_and_swap_discovery_state(None, discovery)
            .unwrap());
        let state = rebuild_materialized_projection_v1(discovery).unwrap();
        let projection = DurableMaterializedProjectionV1 {
            projection_version: 1,
            physical_root_id: ROOT.into(),
            projection_generation: 0,
            source_discovery_generation: 0,
            source_root_safety_generation: 0,
            replay_input_fingerprint: state.replay_input_fingerprint.clone(),
            business_projection_applied_generation: None,
            state,
        };
        assert!(store
            .compare_and_swap_materialized_projection(None, &projection)
            .unwrap());
        store
            .persist_desktop_root_state(&DesktopRootStateV1 {
                state_version: 1,
                physical_root_id: ROOT.into(),
                local_writer_id: WRITER.into(),
                next_writer_sequence: 2,
                writer_head: None,
                lifecycle_generation: 0,
                materialized_projection_generation: Some(0),
                business_applied_projection_generation: None,
            })
            .unwrap();
    });
}

fn database_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("s2-reconstruct-{}.sqlite", uuid::Uuid::new_v4()))
}

fn rows(conn: &Mutex<Connection>) -> Vec<Value> {
    (0..3)
        .map(|index| {
            serde_json::to_value(
                crate::db::get_record(&conn.lock().unwrap(), &format!("record-{index}"))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap()
        })
        .collect()
}

#[test]
fn reconstruction_restart_and_reapply_have_no_identity_timestamp_or_semantic_drift() {
    let path = database_path();
    let discovery = bootstrap_discovery();
    persist_projection(&path, &discovery); // close SQLite before business application
    let expected = with_store(&path, |store, conn| {
        apply_complete_projection_v1(store, 0).unwrap();
        rows(conn)
    });
    with_store(&path, |store, conn| {
        assert_eq!(
            apply_complete_projection_v1(store, 0).unwrap().0,
            super::durable_persistence::BusinessProjectionTransactionResultV1::AlreadyApplied
        );
        let mut projection = store.load_materialized_projection().unwrap().unwrap();
        let original = projection.state.clone();
        projection.projection_generation = 1;
        projection.business_projection_applied_generation = None;
        projection.state = rebuild_materialized_projection_v1(&discovery).unwrap();
        assert_eq!(projection.state, original);
        assert!(store
            .compare_and_swap_materialized_projection(Some(0), &projection)
            .unwrap());
        store.update_materialized_projection_generation(1).unwrap();
        apply_complete_projection_v1(store, 1).unwrap();
        assert_eq!(rows(conn), expected);
        assert_eq!(
            store
                .load_desktop_root_state()
                .unwrap()
                .unwrap()
                .business_applied_projection_generation,
            Some(1)
        );
    });
    std::fs::remove_file(path).unwrap();
}

#[test]
fn inconsistent_missing_or_overlapping_metadata_rolls_back_generation_after_restart() {
    for damage in [
        "identity",
        "missing-created",
        "missing-all",
        "semantic-overlap",
        "frontier",
        "semantic-state",
        "malformed-reference",
    ] {
        let path = database_path();
        persist_projection(&path, &bootstrap_discovery());
        with_store(&path, |store, _| {
            let mut projection = store.load_materialized_projection().unwrap().unwrap();
            let entity = &mut projection.state.entities[1]; // record 0 would otherwise be applied first
            match damage {
                "identity" => entity.metadata_variants[0].metadata["id"] = json!("wrong-record"),
                "missing-created" => {
                    entity.metadata_variants[0]
                        .metadata
                        .as_object_mut()
                        .unwrap()
                        .remove("createdAt");
                }
                "missing-all" => entity.metadata_variants.clear(),
                "semantic-overlap" => {
                    entity.metadata_variants[0].metadata["notes"] = json!("invented")
                }
                "frontier" => {
                    entity.metadata_variants[0].commit_ref.commit_id =
                        "70000000-0000-4000-8000-000000000099".into()
                }
                "semantic-state" => {
                    entity.business_value.as_mut().unwrap()["notes"] = json!("inconsistent")
                }
                "malformed-reference" => {
                    let mut malformed = entity.metadata_variants[0].clone();
                    malformed.commit_ref.writer_seq = "not-a-sequence".into();
                    entity.metadata_variants.push(malformed);
                }
                _ => unreachable!(),
            }
            assert!(store
                .compare_and_swap_materialized_projection(Some(0), &projection)
                .unwrap());
            assert_eq!(
                apply_complete_projection_v1(store, 0).unwrap_err().0,
                "projector_verified_evidence_invalid"
            );
        });
        with_store(&path, |store, conn| {
            assert!(crate::db::get_record(&conn.lock().unwrap(), "record-0")
                .unwrap()
                .is_none());
            assert_eq!(
                store
                    .load_materialized_projection()
                    .unwrap()
                    .unwrap()
                    .business_projection_applied_generation,
                None
            );
            assert_eq!(
                store
                    .load_desktop_root_state()
                    .unwrap()
                    .unwrap()
                    .business_applied_projection_generation,
                None
            );
            assert!(apply_complete_projection_v1(store, 0).is_err());
        });
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn frozen_bootstrap_all_entity_types_reconstruct_exact_metadata_and_int64_scalars() {
    let path = database_path();
    let member_id = sha256_hex(b"collection-member:v1\0collection\0record-0");
    let episode_id = sha256_hex(b"episode-completion:v1\0record-0\x001");
    let mut remote_record = record("record-0");
    remote_record["tmdbMediaKind"] = json!("tv");
    remote_record["tmdbId"] = json!("9007199254740993");
    remote_record["seriesRecordKind"] = json!("whole-series");
    remote_record["imdbRating"] = json!(2.3307731538713474_f64);
    let collection = json!({"id":"collection","name":"Collection","normalizedName":"collection","description":null,"sourceKind":"manual","sourceKey":null,"collectionKind":"manual","orderMode":"manual","createdAt":CREATED,"updatedAt":CREATED,"rev":"9223372036854775807","revActor":"verified-origin"});
    let member = json!({"id":member_id,"collectionId":"collection","recordId":"record-0","position":"9007199254740993","sourceKind":"manual","createdAt":CREATED,"updatedAt":CREATED,"rev":"1","revActor":"verified-origin"});
    let episode = json!({"id":episode_id,"recordId":"record-0","episodeNumber":1,"completedAt":null,"createdAt":CREATED,"updatedAt":CREATED,"rev":"2","revActor":"verified-origin"});
    let entries = [
        ("record", remote_record),
        ("collection", collection.clone()),
        ("collection-member", member.clone()),
        ("episode-completion", episode.clone()),
    ]
    .into_iter()
    .map(|(kind, value)| LegacySnapshotEntryV1 {
        entity_type: kind.into(),
        value,
    })
    .collect();
    let discovery = discovery_from_entries(entries);
    assert_eq!(discovery.verified_objects.len(), 2); // real Stage A -> B
    persist_projection(&path, &discovery);
    with_store(&path, |store, conn| {
        // Existing row metadata must not override the verified origin.
        let mut stale_record = record("record-0");
        stale_record["rev"] = json!(0);
        stale_record["createdAt"] = json!("2020-01-01T00:00:00.000Z");
        crate::db::insert_record(
            &conn.lock().unwrap(),
            serde_json::from_value(stale_record).unwrap(),
        )
        .unwrap();
        for (kind, mut full) in [
            ("collection", collection),
            ("collection-member", member),
            ("episode-completion", episode),
        ] {
            full["createdAt"] = json!("2020-01-01T00:00:00.000Z");
            full["rev"] = json!(0);
            if kind == "collection-member" {
                full["position"] = json!(0);
            }
            let conn = conn.lock().unwrap();
            match kind {
                "collection" => super::business_projection::remote_upsert_collection_no_stage_tx(
                    &conn,
                    &serde_json::from_value(full).unwrap(),
                )
                .unwrap(),
                "collection-member" => {
                    super::business_projection::remote_upsert_member_no_stage_tx(
                        &conn,
                        &serde_json::from_value(full).unwrap(),
                    )
                    .unwrap()
                }
                "episode-completion" => {
                    super::business_projection::remote_upsert_episode_completion_no_stage_tx(
                        &conn,
                        &serde_json::from_value(full).unwrap(),
                    )
                    .unwrap()
                }
                _ => unreachable!(),
            }
        }
        let before = store.load_materialized_projection().unwrap().unwrap().state;
        apply_complete_projection_v1(store, 0).unwrap();
        assert_eq!(
            store.load_materialized_projection().unwrap().unwrap().state,
            before
        );
        let conn = conn.lock().unwrap();
        let record = crate::db::get_record(&conn, "record-0").unwrap().unwrap();
        assert_eq!(record.tmdb_id, Some(9007199254740993));
        assert_eq!(
            record.imdb_rating.unwrap().to_bits(),
            2.3307731538713474_f64.to_bits()
        );
        let collection = &crate::collections::all(&conn).unwrap()[0];
        assert_eq!(collection.created_at, CREATED);
        assert_eq!(collection.rev, i64::MAX);
        let member = &crate::collections::all_members(&conn).unwrap()[0];
        assert_eq!(member.id, member_id);
        assert_eq!(member.created_at, CREATED);
        assert_eq!(member.position, 9007199254740993);
        let episode = &crate::episode_history::completions(&conn, "record-0").unwrap()[0];
        assert_eq!(episode.id, episode_id);
        assert_eq!(episode.created_at, CREATED);
        assert_eq!(episode.completed_at, None);
        assert!(crate::sync_staging::get_staging(&conn)
            .unwrap()
            .entries
            .is_empty());
    });
    std::fs::remove_file(path).unwrap();
}

fn verified_object(bytes: &[u8]) -> VerifiedRemoteObjectV1 {
    let commit = super::causal::decode_frozen_wire_commit_v1(bytes).unwrap();
    let reference = commit.commit_ref();
    VerifiedRemoteObjectV1 {
        path: super::immutable_publish::build_commit_remote_path_v1(&reference).unwrap(),
        kind: "commit".into(),
        exact_bytes_hash: sha256_hex(bytes),
        exact_bytes_hex: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
        content_hash: reference.content_hash.clone(),
        commit_ref: Some(reference),
        activation_id: None,
        fingerprint_evidence: VerifiedFingerprintEvidenceV1::Missing,
    }
}

fn golden_commit(case_name: &str, commit_id: &str, root: bool) -> Vec<u8> {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../contracts/s2-lite/v1/causal-golden-v1.json"
    ))
    .unwrap();
    let case = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == case_name)
        .unwrap();
    let mut wire = case["objects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|object| object["commitId"] == commit_id)
        .unwrap()
        .clone();
    wire.as_object_mut().unwrap().remove("contentHash");
    if root {
        wire["basisClock"] = json!([]);
        for mutation in wire["mutations"].as_array_mut().unwrap() {
            mutation["baseFrontier"] = json!([]);
        }
    }
    serde_json::to_vec(&wire).unwrap()
}

#[test]
fn frozen_tombstone_and_conflict_apply_after_sqlite_restart_without_live_decode() {
    for conflict in [false, true] {
        let path = database_path();
        let mut discovery = create_discovery_state_v1();
        discovery
            .verified_objects
            .push(verified_object(&golden_commit(
                "live-tombstone",
                "20000000-0000-4000-8000-000000000010",
                true,
            )));
        if conflict {
            discovery
                .verified_objects
                .push(verified_object(&golden_commit(
                    "single-writer-seq-1-3",
                    "20000000-0000-4000-8000-000000000001",
                    false,
                )));
        }
        persist_projection(&path, &discovery);
        with_store(&path, |_, conn| {
            let local = json!({"id":"c","name":"Local","normalizedName":"local","description":null,"sourceKind":"manual","sourceKey":null,"collectionKind":"manual","orderMode":"manual","createdAt":CREATED,"updatedAt":CREATED,"rev":7,"revActor":"local"});
            super::business_projection::remote_upsert_collection_no_stage_tx(
                &conn.lock().unwrap(),
                &serde_json::from_value(local).unwrap(),
            )
            .unwrap();
        });
        with_store(&path, |store, conn| {
            let before = store.load_materialized_projection().unwrap().unwrap().state;
            assert!(before
                .entities
                .iter()
                .all(|entity| entity.business_value.is_none()));
            let report = apply_complete_projection_v1(store, 0).unwrap().1.unwrap();
            assert_eq!(
                report.outcomes,
                vec![if conflict {
                    super::business_projection::BusinessProjectionOutcomeV1::ConflictPreserved
                } else {
                    super::business_projection::BusinessProjectionOutcomeV1::AppliedRemoteTombstone
                }]
            );
            let local = crate::collections::all(&conn.lock().unwrap()).unwrap();
            if conflict {
                assert_eq!(local[0].name, "Local");
            } else {
                assert!(local.is_empty());
            }
            assert_eq!(
                store.load_materialized_projection().unwrap().unwrap().state,
                before
            );
        });
        with_store(&path, |store, _| {
            assert_eq!(
                apply_complete_projection_v1(store, 0).unwrap().0,
                super::durable_persistence::BusinessProjectionTransactionResultV1::AlreadyApplied
            );
            assert_eq!(
                store
                    .load_materialized_projection()
                    .unwrap()
                    .unwrap()
                    .state
                    .entities[0]
                    .conflict,
                conflict
            );
        });
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn identical_semantics_retain_all_metadata_and_choose_one_coherent_verified_variant() {
    let mut discovery = bootstrap_discovery();
    let first = &discovery.verified_objects[0];
    let bytes = first
        .exact_bytes_hex
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect::<Vec<_>>();
    let mut other: Value = serde_json::from_slice(&bytes).unwrap();
    other["writerId"] = json!("71000000-0000-4000-8000-000000000002");
    other["commitId"] = json!("72000000-0000-4000-8000-000000000002");
    for mutation in other["mutations"].as_array_mut().unwrap() {
        mutation["value"]["createdAt"] = json!("2026-10-05T00:00:00.000Z");
        mutation["value"]["updatedAt"] = json!(CREATED);
        mutation["value"]["rev"] = json!("3");
        mutation["value"]["revActor"] = json!("other-origin");
    }
    discovery
        .verified_objects
        .push(verified_object(&serde_json::to_vec(&other).unwrap()));
    let canonical = rebuild_materialized_projection_v1(&discovery).unwrap();
    discovery.verified_objects.reverse();
    assert_eq!(
        rebuild_materialized_projection_v1(&discovery).unwrap(),
        canonical
    );
    assert!(canonical
        .entities
        .iter()
        .all(|entity| !entity.conflict && entity.metadata_variants.len() == 2));
    let path = database_path();
    persist_projection(&path, &discovery);
    with_store(&path, |store, conn| {
        apply_complete_projection_v1(store, 0).unwrap();
        for value in rows(conn) {
            assert_eq!(value["createdAt"], CREATED);
            assert_eq!(value["updatedAt"], Value::Null);
            assert_eq!(value["rev"], json!(9007199254740993_i64));
            assert_eq!(value["revActor"], "verified-origin");
        }
        assert_eq!(
            store.load_materialized_projection().unwrap().unwrap().state,
            canonical
        );
    });
    std::fs::remove_file(path).unwrap();
}

#[test]
fn local_staged_overlay_preserves_full_row_and_durable_basis_after_reconstruction() {
    let path = database_path();
    persist_projection(&path, &bootstrap_discovery());
    with_store(&path, |_, conn| {
        let mut local = record("record-1");
        local["rev"] = json!(5);
        local["notes"] = json!("local overlay");
        local["createdAt"] = json!("2020-01-01T00:00:00.000Z");
        crate::db::insert_record(
            &conn.lock().unwrap(),
            serde_json::from_value(local.clone()).unwrap(),
        )
        .unwrap();
        crate::sync_staging::set_staging(
            &conn.lock().unwrap(),
            &crate::sync_staging::SyncStaging {
                version: 3,
                entries: vec![crate::sync_staging::StagedRecord {
                    entity_kind: "record".into(),
                    id: "record-1".into(),
                    operation: "upsert".into(),
                    base: None,
                    local: Some(local),
                    first_generation: 1,
                    last_generation: 1,
                    delete_descriptor: None,
                    causal_anchor: crate::sync_staging::StagedCausalAnchorV1::Unavailable {
                        reason: "test-first-edit".into(),
                    },
                }],
            },
        )
        .unwrap();
    });
    with_store(&path, |store, conn| {
        let staging = crate::sync_staging::get_staging(&conn.lock().unwrap()).unwrap();
        apply_complete_projection_v1(store, 0).unwrap();
        let row = crate::db::get_record(&conn.lock().unwrap(), "record-1")
            .unwrap()
            .unwrap();
        assert_eq!(row.notes, "local overlay");
        assert_eq!(row.created_at, "2020-01-01T00:00:00.000Z");
        assert_eq!(row.rev, 5);
        assert_eq!(
            crate::sync_staging::get_staging(&conn.lock().unwrap()).unwrap(),
            staging
        );
        assert_eq!(
            crate::db::get_record(&conn.lock().unwrap(), "record-0")
                .unwrap()
                .unwrap()
                .notes,
            "verified"
        );
    });
    std::fs::remove_file(path).unwrap();
}

fn with_store<T>(
    path: &Path,
    operation: impl FnOnce(&mut SqliteS2LiteStoreV1<'_>, &Mutex<Connection>) -> T,
) -> T {
    let conn = Connection::open(path).unwrap();
    crate::db::setup_db(&conn).unwrap();
    let conn = Mutex::new(conn);
    let mut store = SqliteS2LiteStoreV1::open(&conn, ROOT).unwrap();
    operation(&mut store, &conn)
}

#[test]
fn migrated_three_record_bootstrap_reconstructs_real_sqlite_business_rows() {
    let path = std::env::temp_dir().join(format!("s2-reconstruct-{}.sqlite", uuid::Uuid::new_v4()));
    with_store(&path, |store, _| {
        let discovery = bootstrap_discovery();
        assert!(store
            .compare_and_swap_discovery_state(None, &discovery)
            .unwrap());
        let state = rebuild_materialized_projection_v1(&discovery).unwrap();
        assert!(state.entities.iter().all(|entity| entity
            .business_value
            .as_ref()
            .unwrap()
            .get("id")
            .is_none()));
        let projection = DurableMaterializedProjectionV1 {
            projection_version: 1,
            physical_root_id: ROOT.into(),
            projection_generation: 0,
            source_discovery_generation: 0,
            source_root_safety_generation: 0,
            replay_input_fingerprint: state.replay_input_fingerprint.clone(),
            business_projection_applied_generation: None,
            state,
        };
        assert!(store
            .compare_and_swap_materialized_projection(None, &projection)
            .unwrap());
        store
            .persist_desktop_root_state(&DesktopRootStateV1 {
                state_version: 1,
                physical_root_id: ROOT.into(),
                local_writer_id: WRITER.into(),
                next_writer_sequence: 2,
                writer_head: None,
                lifecycle_generation: 0,
                materialized_projection_generation: Some(0),
                business_applied_projection_generation: None,
            })
            .unwrap();
        apply_complete_projection_v1(store, 0).unwrap();
    });
    with_store(&path, |store, conn| {
        for index in 0..3 {
            let id = format!("record-{index}");
            let row = crate::db::get_record(&conn.lock().unwrap(), &id)
                .unwrap()
                .unwrap();
            assert_eq!(row.id, id);
            assert_eq!(row.created_at, CREATED);
            assert_eq!(row.notes, "verified");
            assert_eq!(row.rev, 9007199254740993);
            assert_eq!(row.rev_actor, "verified-origin");
        }
        assert_eq!(
            store
                .load_desktop_root_state()
                .unwrap()
                .unwrap()
                .business_applied_projection_generation,
            Some(0)
        );
    });
    std::fs::remove_file(path).unwrap();
}
