//! Durable authority for mapping SyncTarget epochs to frozen S2 Lite roots.
//!
//! This module deliberately has no remote operation. It resolves only the
//! registry target, frozen WebDAV root identity, immutable local binding, and
//! root-scoped writer authority needed by a later lifecycle checkpoint.

use std::sync::Mutex;

use rusqlite::Connection;

use super::canonical::{ProtocolError, Result};
use super::durable_persistence::{DesktopRootStateV1, SqliteS2LiteStoreV1, TargetRootBindingV1};
use super::webdav_adapter::webdav_root_v1;

const TARGET_BINDING_FAILURE: ProtocolError = ProtocolError("S2_TARGET_ROOT_BINDING_FAILURE");

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetRootAuthorityV1 {
    pub binding: TargetRootBindingV1,
    pub writer_state: DesktopRootStateV1,
}

/// Immutable active target/root authority without ordinary writer allocation.
/// Migration admission uses this form so a future migration writer is not
/// pre-empted by a random desktop writer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundTargetRootV1 {
    pub binding: TargetRootBindingV1,
}

fn active_target_snapshot_v1(
    conn: &Mutex<Connection>,
    target_id: &str,
    target_epoch: u64,
) -> Result<(String, String)> {
    let guard = conn.lock().map_err(|_| TARGET_BINDING_FAILURE)?;
    let registry = crate::sync_targets::registry(&guard).map_err(|_| TARGET_BINDING_FAILURE)?;
    let registry = registry.ok_or(TARGET_BINDING_FAILURE)?;
    if registry.active_target_id.as_deref() != Some(target_id)
        || registry.target_epoch != target_epoch
    {
        return Err(TARGET_BINDING_FAILURE);
    }
    let target = registry
        .targets
        .iter()
        .find(|target| target.id == target_id)
        .ok_or(TARGET_BINDING_FAILURE)?;
    Ok((target.normalized_url.clone(), target.username.clone()))
}

/// Resolves active target authority only through frozen `webdav_root_v1`, then
/// claims or verifies its immutable durable binding.  It intentionally does
/// not initialize desktop writer state.
pub fn resolve_active_target_root_binding_v1(
    conn: &Mutex<Connection>,
    target_id: &str,
    target_epoch: u64,
) -> Result<BoundTargetRootV1> {
    let (url, username) = active_target_snapshot_v1(conn, target_id, target_epoch)?;
    let root = webdav_root_v1(&url, &username).map_err(|_| TARGET_BINDING_FAILURE)?;
    let candidate = TargetRootBindingV1 {
        binding_version: 1,
        target_id: target_id.to_string(),
        target_epoch,
        canonical_url: root.canonical_url,
        normalized_account: root.normalized_account,
        physical_root_id: root.physical_root_id,
    };
    let mut store = SqliteS2LiteStoreV1::open(conn, &candidate.physical_root_id)?;
    let binding = store.bind_target_root_v1(&candidate)?;

    // The active registry may have changed while the durable transaction was
    // running. The immutable row is still useful historical evidence, but this
    // call must not hand a stale target to a new lifecycle execution.
    let _ = active_target_snapshot_v1(conn, target_id, target_epoch)?;
    Ok(BoundTargetRootV1 { binding })
}

/// Established normal S2 lifecycle entry point.  It preserves writer-bearing
/// behavior by resolving the binding first and only then initializing ordinary
/// desktop writer authority.
pub fn resolve_active_target_root_authority_v1(
    conn: &Mutex<Connection>,
    target_id: &str,
    target_epoch: u64,
) -> Result<TargetRootAuthorityV1> {
    let bound = resolve_active_target_root_binding_v1(conn, target_id, target_epoch)?;
    let mut store = SqliteS2LiteStoreV1::open(conn, &bound.binding.physical_root_id)?;
    let writer_state = store.initialize_desktop_writer_v1()?;
    Ok(TargetRootAuthorityV1 {
        binding: bound.binding,
        writer_state,
    })
}

/// Historical recovery lookup. It never checks the active target and never
/// derives a replacement root, so a missing future credential cannot retarget
/// frozen work.
pub fn load_historical_target_root_binding_v1(
    conn: &Mutex<Connection>,
    target_id: &str,
    target_epoch: u64,
) -> Result<Option<TargetRootBindingV1>> {
    SqliteS2LiteStoreV1::load_target_root_binding_v1(conn, target_id, target_epoch)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use rusqlite::Connection;

    use super::super::durable_persistence::{
        completed_migration_writer_seed, MigrationExecutionBindingV1,
    };
    use super::super::immutable_publish::{PreparedIntentV1, RemotePublishedReceiptV1};
    use super::super::migration_orchestration::{
        MigrationCommitTaskV1, MigrationStateV1, MigrationStatusV1,
    };
    use super::super::types::CommitRef;
    use super::*;
    use crate::sync_targets::{self, SyncTarget, SyncTargetRegistry};

    const CREATED: &str = "2026-09-17T00:00:00.000Z";

    fn connection() -> Mutex<Connection> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        Mutex::new(conn)
    }

    fn target(url: &str, username: &str) -> SyncTarget {
        let normalized_url = sync_targets::normalize_url(url).unwrap();
        SyncTarget {
            id: sync_targets::target_id(&normalized_url, username),
            normalized_url,
            username: username.to_string(),
            created_at: CREATED.into(),
            last_activated_at: CREATED.into(),
        }
    }

    fn set_registry(conn: &Mutex<Connection>, target: SyncTarget, epoch: u64) {
        let registry = SyncTargetRegistry {
            version: 1,
            active_target_id: Some(target.id.clone()),
            target_epoch: epoch,
            targets: vec![target],
        };
        conn.lock()
            .unwrap()
            .execute(
                "INSERT INTO settings(key, value) VALUES(?1, ?2)",
                [
                    sync_targets::REGISTRY_KEY,
                    &serde_json::to_string(&registry).unwrap(),
                ],
            )
            .unwrap();
    }

    fn replace_registry(conn: &Mutex<Connection>, target: SyncTarget, epoch: u64) {
        let registry = SyncTargetRegistry {
            version: 1,
            active_target_id: Some(target.id.clone()),
            target_epoch: epoch,
            targets: vec![target],
        };
        conn.lock()
            .unwrap()
            .execute(
                "UPDATE settings SET value=?2 WHERE key=?1",
                [
                    sync_targets::REGISTRY_KEY,
                    &serde_json::to_string(&registry).unwrap(),
                ],
            )
            .unwrap();
    }

    #[test]
    fn first_use_creates_binding_and_writer_starts_at_one() {
        let conn = connection();
        let target = target("https://dav.example.test/root/", " Alice ");
        set_registry(&conn, target.clone(), 1);
        let authority = resolve_active_target_root_authority_v1(&conn, &target.id, 1).unwrap();
        assert_eq!(authority.binding.binding_version, 1);
        assert_eq!(authority.binding.normalized_account, "Alice");
        assert_eq!(authority.writer_state.next_writer_sequence, 1);
        assert!(authority.writer_state.writer_head.is_none());
    }

    #[test]
    fn binding_only_uses_frozen_root_and_does_not_allocate_a_writer() {
        let conn = connection();
        let target = target("HTTPS://dav.example.test/root", " Alice ");
        set_registry(&conn, target.clone(), 1);
        let bound = resolve_active_target_root_binding_v1(&conn, &target.id, 1).unwrap();
        assert_eq!(
            resolve_active_target_root_binding_v1(&conn, &target.id, 1).unwrap(),
            bound
        );
        let frozen = webdav_root_v1(&target.normalized_url, &target.username).unwrap();
        assert_eq!(bound.binding.canonical_url, frozen.canonical_url);
        assert_eq!(bound.binding.normalized_account, frozen.normalized_account);
        assert_eq!(bound.binding.physical_root_id, frozen.physical_root_id);
        let mut store = SqliteS2LiteStoreV1::open(&conn, &bound.binding.physical_root_id).unwrap();
        assert_eq!(store.load_desktop_root_state().unwrap(), None);

        let authority = resolve_active_target_root_authority_v1(&conn, &target.id, 1).unwrap();
        assert_eq!(authority.binding, bound.binding);
        assert_eq!(
            store.load_desktop_root_state().unwrap(),
            Some(authority.writer_state)
        );
    }

    #[test]
    fn binding_only_rejects_a_stale_epoch() {
        let conn = connection();
        let target = target("https://dav.example.test/root/", "Alice");
        set_registry(&conn, target.clone(), 1);
        assert!(resolve_active_target_root_binding_v1(&conn, &target.id, 2).is_err());
    }

    fn execution_binding(bound: &BoundTargetRootV1) -> MigrationExecutionBindingV1 {
        MigrationExecutionBindingV1 {
            binding_version: 1,
            physical_root_id: bound.binding.physical_root_id.clone(),
            target_id: bound.binding.target_id.clone(),
            target_epoch: bound.binding.target_epoch,
            captured_records_generation: 41,
            legacy_fingerprint: Some("a".repeat(64)),
            migration_id: "30000000-0000-4000-8000-000000000001".into(),
        }
    }

    #[test]
    fn migration_execution_binding_is_immutable_exact_and_credential_free() {
        let conn = connection();
        let target = target("https://dav.example.test/root/", "Alice");
        set_registry(&conn, target.clone(), 1);
        let bound = resolve_active_target_root_binding_v1(&conn, &target.id, 1).unwrap();
        let candidate = execution_binding(&bound);
        let mut store = SqliteS2LiteStoreV1::open(&conn, &bound.binding.physical_root_id).unwrap();
        assert_eq!(
            store.bind_migration_execution_v1(&candidate).unwrap(),
            candidate
        );
        assert_eq!(
            store.bind_migration_execution_v1(&candidate).unwrap(),
            candidate
        );
        let mut restarted =
            SqliteS2LiteStoreV1::open(&conn, &bound.binding.physical_root_id).unwrap();
        assert_eq!(
            restarted.load_migration_execution_binding_v1().unwrap(),
            Some(candidate.clone())
        );
        let stored: Vec<u8> = conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT state_json FROM s2_lite_migration_execution_binding_v1 WHERE root_id=?1",
                [&bound.binding.physical_root_id],
                |row| row.get(0),
            )
            .unwrap();
        let rendered = String::from_utf8(stored).unwrap();
        assert!(!rendered.contains("password"));
        assert!(!rendered.contains("secret"));

        let mut changed_target = candidate.clone();
        changed_target.target_id = "b".repeat(64);
        assert!(restarted
            .bind_migration_execution_v1(&changed_target)
            .is_err());
        let mut changed_epoch = candidate.clone();
        changed_epoch.target_epoch += 1;
        assert!(restarted
            .bind_migration_execution_v1(&changed_epoch)
            .is_err());
        let mut changed_root = candidate.clone();
        changed_root.physical_root_id = "s2-root-v1:other".into();
        assert!(restarted
            .bind_migration_execution_v1(&changed_root)
            .is_err());
        let mut changed_generation = candidate.clone();
        changed_generation.captured_records_generation += 1;
        assert!(restarted
            .bind_migration_execution_v1(&changed_generation)
            .is_err());
        let mut changed_fingerprint = candidate.clone();
        changed_fingerprint.legacy_fingerprint = Some("b".repeat(64));
        assert!(restarted
            .bind_migration_execution_v1(&changed_fingerprint)
            .is_err());
        let mut changed_migration = candidate.clone();
        changed_migration.migration_id = "30000000-0000-4000-8000-000000000002".into();
        assert!(restarted
            .bind_migration_execution_v1(&changed_migration)
            .is_err());
        conn.lock()
            .unwrap()
            .execute(
                "UPDATE s2_lite_migration_execution_binding_v1 SET state_json=?2 WHERE root_id=?1",
                rusqlite::params![
                    &bound.binding.physical_root_id,
                    b"not-a-persistence-envelope".to_vec()
                ],
            )
            .unwrap();
        assert!(restarted.load_migration_execution_binding_v1().is_err());
    }

    #[test]
    fn migration_execution_binding_preserves_a_null_fingerprint_exactly() {
        let conn = connection();
        let target = target("https://dav.example.test/root/", "Alice");
        set_registry(&conn, target.clone(), 1);
        let bound = resolve_active_target_root_binding_v1(&conn, &target.id, 1).unwrap();
        let mut candidate = execution_binding(&bound);
        candidate.legacy_fingerprint = None;
        let mut store = SqliteS2LiteStoreV1::open(&conn, &bound.binding.physical_root_id).unwrap();
        assert_eq!(
            store.bind_migration_execution_v1(&candidate).unwrap(),
            candidate
        );
        assert_eq!(
            store
                .load_migration_execution_binding_v1()
                .unwrap()
                .unwrap()
                .legacy_fingerprint,
            None
        );
        assert_eq!(store.load_desktop_root_state().unwrap(), None);
    }

    #[test]
    fn same_target_epoch_reuses_exact_binding_and_writer() {
        let conn = connection();
        let target = target("https://dav.example.test/root/", "Alice");
        set_registry(&conn, target.clone(), 1);
        let first = resolve_active_target_root_authority_v1(&conn, &target.id, 1).unwrap();
        let second = resolve_active_target_root_authority_v1(&conn, &target.id, 1).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn newer_epoch_for_the_same_target_creates_a_new_binding_and_reuses_writer() {
        let conn = connection();
        let target = target("https://dav.example.test/root/", "Alice");
        set_registry(&conn, target.clone(), 1);
        let first = resolve_active_target_root_authority_v1(&conn, &target.id, 1).unwrap();
        replace_registry(&conn, target.clone(), 2);
        let second = resolve_active_target_root_authority_v1(&conn, &target.id, 2).unwrap();
        assert_eq!(
            first.binding.physical_root_id,
            second.binding.physical_root_id
        );
        assert_eq!(
            first.writer_state.local_writer_id,
            second.writer_state.local_writer_id
        );
        assert_eq!(
            load_historical_target_root_binding_v1(&conn, &target.id, 1).unwrap(),
            Some(first.binding),
        );
    }

    #[test]
    fn same_target_epoch_mismatch_fails_closed() {
        let conn = connection();
        let target = target("https://dav.example.test/root/", "Alice");
        set_registry(&conn, target.clone(), 1);
        let authority = resolve_active_target_root_authority_v1(&conn, &target.id, 1).unwrap();
        let mut store = SqliteS2LiteStoreV1::open(&conn, "s2-root-v1:other").unwrap();
        let mismatch = TargetRootBindingV1 {
            physical_root_id: "s2-root-v1:other".into(),
            ..authority.binding
        };
        assert!(store.bind_target_root_v1(&mismatch).is_err());
    }

    #[test]
    fn newer_epoch_and_different_target_can_share_a_physical_root() {
        let conn = connection();
        let first = target("https://dav.example.test/root", "Alice");
        set_registry(&conn, first.clone(), 1);
        let initial = resolve_active_target_root_authority_v1(&conn, &first.id, 1).unwrap();
        // The durable layer does not make target id a root identity. Use a
        // second immutable target id with the same frozen root to cover the
        // cross-target recovery case that registry activation can create.
        let mut store =
            SqliteS2LiteStoreV1::open(&conn, &initial.binding.physical_root_id).unwrap();
        let later_binding = store
            .bind_target_root_v1(&TargetRootBindingV1 {
                binding_version: 1,
                target_id: "b".repeat(64),
                target_epoch: 2,
                canonical_url: initial.binding.canonical_url.clone(),
                normalized_account: initial.binding.normalized_account.clone(),
                physical_root_id: initial.binding.physical_root_id.clone(),
            })
            .unwrap();
        let later = store.initialize_desktop_writer_v1().unwrap();
        assert_eq!(
            initial.binding.physical_root_id,
            later_binding.physical_root_id
        );
        assert_eq!(initial.writer_state.local_writer_id, later.local_writer_id);
    }

    #[test]
    fn frozen_root_normalization_controls_account_and_url_identity() {
        let conn = connection();
        let first = target("HTTPS://dav.example.test/root", " Alice ");
        set_registry(&conn, first.clone(), 1);
        let one = resolve_active_target_root_authority_v1(&conn, &first.id, 1).unwrap();
        let same = webdav_root_v1("https://dav.example.test/root/", "Alice").unwrap();
        assert_eq!(one.binding.physical_root_id, same.physical_root_id);
        let case_distinct = webdav_root_v1("https://dav.example.test/root/", "alice").unwrap();
        assert_ne!(one.binding.physical_root_id, case_distinct.physical_root_id);
    }

    #[test]
    fn historical_binding_survives_active_target_switch() {
        let conn = connection();
        let first = target("https://dav.example.test/one/", "Alice");
        set_registry(&conn, first.clone(), 1);
        let one = resolve_active_target_root_authority_v1(&conn, &first.id, 1).unwrap();
        let second = target("https://dav.example.test/two/", "Bob");
        replace_registry(&conn, second.clone(), 2);
        resolve_active_target_root_authority_v1(&conn, &second.id, 2).unwrap();
        assert_eq!(
            load_historical_target_root_binding_v1(&conn, &first.id, 1).unwrap(),
            Some(one.binding),
        );
    }

    #[test]
    fn caller_cannot_supply_a_wrong_root_as_authority() {
        let conn = connection();
        let target = target("https://dav.example.test/root/", "Alice");
        set_registry(&conn, target.clone(), 1);
        let authority = resolve_active_target_root_authority_v1(&conn, &target.id, 1).unwrap();
        assert_eq!(
            authority.binding.physical_root_id,
            webdav_root_v1(&target.normalized_url, &target.username)
                .unwrap()
                .physical_root_id
        );
        assert_ne!(authority.binding.physical_root_id, "caller-controlled-root");
    }

    #[test]
    fn no_migration_writer_is_allocated_once_and_different_roots_differ() {
        let conn = connection();
        let one = target("https://dav.example.test/one/", "Alice");
        set_registry(&conn, one.clone(), 1);
        let one_first = resolve_active_target_root_authority_v1(&conn, &one.id, 1).unwrap();
        let one_second = resolve_active_target_root_authority_v1(&conn, &one.id, 1).unwrap();
        let two = target("https://dav.example.test/two/", "Alice");
        replace_registry(&conn, two.clone(), 2);
        let other = resolve_active_target_root_authority_v1(&conn, &two.id, 2).unwrap();
        assert_eq!(
            one_first.writer_state.local_writer_id,
            one_second.writer_state.local_writer_id
        );
        assert_ne!(
            one_first.writer_state.local_writer_id,
            other.writer_state.local_writer_id
        );
    }

    #[test]
    fn completed_migration_writer_is_seeded_from_its_final_verified_commit() {
        let writer_id = "10000000-0000-4000-8000-000000000001".to_string();
        let commit = CommitRef {
            writer_id: writer_id.clone(),
            writer_seq: "7".into(),
            commit_id: "20000000-0000-4000-8000-000000000001".into(),
            content_hash: "a".repeat(64),
        };
        let intent = PreparedIntentV1 {
            intent_version: 1,
            object_kind: "commit".into(),
            remote_path: "commits/x.json".into(),
            exact_bytes: vec![],
            content_hash: commit.content_hash.clone(),
            commit_ref: commit.clone(),
            intent_fingerprint: "b".repeat(64),
            created_locally_at_diagnostic: CREATED.into(),
        };
        let receipt = RemotePublishedReceiptV1 {
            receipt_version: 1,
            remote_path: intent.remote_path.clone(),
            content_hash: intent.content_hash.clone(),
            commit_ref: commit.clone(),
            prepared_intent_fingerprint: intent.intent_fingerprint.clone(),
            verified_exact_bytes_hash: "c".repeat(64),
            verified_at_diagnostic: CREATED.into(),
        };
        let root = "s2-root-v1:migration-test";
        let state = MigrationStateV1 {
            state_version: 1,
            generation: 1,
            migration_id: "30000000-0000-4000-8000-000000000001".into(),
            root_id: root.into(),
            source_type: "legacy-bootstrap".into(),
            writer_id: writer_id.clone(),
            created_at: CREATED.into(),
            status: MigrationStatusV1::MigrationComplete,
            snapshot: None,
            stage_a: vec![],
            stage_b: vec![MigrationCommitTaskV1 {
                stage: "B".into(),
                chunk_index: 0,
                root_id: root.into(),
                intent,
                receipt: Some(receipt),
                receipt_root_id: Some(root.into()),
            }],
            activation_intent: None,
            activation_intent_root_id: None,
            activation_receipt: None,
            activation_receipt_root_id: None,
            root_fatal_signals: vec![],
            preservation_handoff: None,
        };
        assert_eq!(
            completed_migration_writer_seed(&state, root).unwrap(),
            Some((writer_id, Some(commit), 8)),
        );
    }
}
