use crate::app_paths::AppPaths;
use crate::auth;
use crate::db_atomic_helpers::{get_setting_tx, set_setting_tx};
use crate::error::AppError;
use crate::recovery_points;
use crate::s2_lite::webdav_adapter::webdav_root_v1;
use chrono::Utc;
use reqwest::Url;
use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const REGISTRY_KEY: &str = "sync_targets_v1";

const LEGACY_SCOPED_KEYS: &[(&str, &str)] = &[
    ("webdav_creds", "credentials"),
    ("sync_v3_baseline", "baseline_v3"),
    ("sync_v3_remote_etag", "remote_etag"),
    ("sync_v3_conflicts", "conflicts_v3"),
    ("sync_v3_last_commit", "last_commit_v3"),
    ("sync_v2_source_fingerprint", "v2_source_fingerprint"),
    ("sync_outbox_v1", "outbox_v1"),
    ("sync_scheduler_v1", "scheduler_v1"),
    ("sync_staging_v1", "staging_v1"),
    ("sync_publish_intent_v1", "publish_intent_v1"),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncTarget {
    pub id: String,
    pub normalized_url: String,
    pub username: String,
    pub created_at: String,
    pub last_activated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncTargetRegistry {
    pub version: u8,
    pub active_target_id: Option<String>,
    pub target_epoch: u64,
    #[serde(default)]
    pub targets: Vec<SyncTarget>,
}

impl Default for SyncTargetRegistry {
    fn default() -> Self {
        Self {
            version: 1,
            active_target_id: None,
            target_epoch: 0,
            targets: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivateTargetInput {
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSyncConnection {
    pub target_id: String,
    pub target_epoch: u64,
    pub url: String,
    pub username: String,
    pub credential_available: bool,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::General(message.into())
}

pub fn normalize_url(raw: &str) -> Result<String, AppError> {
    let mut url = Url::parse(raw.trim()).map_err(|_| invalid("invalid_sync_target_url"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid("invalid_sync_target_url"));
    }
    url.set_query(None);
    url.set_fragment(None);
    url.set_username("")
        .map_err(|_| invalid("invalid_sync_target_url"))?;
    url.set_password(None)
        .map_err(|_| invalid("invalid_sync_target_url"))?;
    if (url.scheme() == "http" && url.port() == Some(80))
        || (url.scheme() == "https" && url.port() == Some(443))
    {
        url.set_port(None)
            .map_err(|_| invalid("invalid_sync_target_url"))?;
    }
    // Work on the serialized URL so an already percent-encoded Unicode path is
    // not encoded a second time by set_path.
    let serialized = url.to_string();
    Ok(format!("{}/", serialized.trim_end_matches('/')))
}

pub fn target_id(normalized_url: &str, username: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"watchtracker-target-v1\n");
    digest.update(normalized_url.as_bytes());
    digest.update(b"\n");
    digest.update(username.trim().as_bytes());
    format!("{:x}", digest.finalize())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TargetRootTransitionV1 {
    FirstTarget,
    RootChanged,
    SameRoot,
}

impl TargetRootTransitionV1 {
    fn pauses_automatic_sync(self) -> bool {
        !matches!(self, Self::SameRoot)
    }
}

fn target_root_transition_v1(
    registry: &SyncTargetRegistry,
    candidate_url: &str,
    candidate_username: &str,
) -> Result<TargetRootTransitionV1, AppError> {
    let candidate_physical_root_id = webdav_root_v1(candidate_url, candidate_username)
        .map_err(|_| invalid("invalid_sync_target_root"))?
        .physical_root_id;
    let active_physical_root_id = registry
        .active_target_id
        .as_ref()
        .map(|active_id| {
            let active = registry
                .targets
                .iter()
                .find(|target| &target.id == active_id)
                .ok_or_else(|| invalid("invalid_sync_target_registry"))?;
            webdav_root_v1(&active.normalized_url, &active.username)
                .map(|root| root.physical_root_id)
                .map_err(|_| invalid("invalid_sync_target_root"))
        })
        .transpose()?;
    Ok(match active_physical_root_id {
        None => TargetRootTransitionV1::FirstTarget,
        Some(active_physical_root_id) if active_physical_root_id == candidate_physical_root_id => {
            TargetRootTransitionV1::SameRoot
        }
        Some(_) => TargetRootTransitionV1::RootChanged,
    })
}

/// Make the newly active target and its automatic-execution policy visible as
/// one durable fact.  A caller must never observe a changed physical root
/// while the scheduler still carries the prior root's enabled state.
fn persist_target_activation_v1(
    transaction: &Transaction<'_>,
    registry: &SyncTargetRegistry,
    target_id: &str,
    transition: TargetRootTransitionV1,
) -> Result<(), AppError> {
    save_registry(transaction, registry)?;
    if transition.pauses_automatic_sync() {
        crate::sync_state::pause_scheduler_for_root_change_tx(transaction, target_id)?;
    }
    Ok(())
}

pub fn scoped_key(target_id: &str, suffix: &str) -> String {
    format!("sync_target::{target_id}::{suffix}")
}

pub fn registry(conn: &Connection) -> Result<Option<SyncTargetRegistry>, AppError> {
    let Some(raw) = get_setting_tx(conn, REGISTRY_KEY)? else {
        return Ok(None);
    };
    let registry: SyncTargetRegistry = serde_json::from_str(&raw)
        .map_err(|error| invalid(format!("invalid_sync_target_registry:{error}")))?;
    let unique_ids: HashSet<_> = registry
        .targets
        .iter()
        .map(|target| target.id.as_str())
        .collect();
    let invalid_target = registry.targets.iter().any(|target| {
        target.id.len() != 64
            || !target
                .id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || normalize_url(&target.normalized_url)
                .map_or(true, |normalized| normalized != target.normalized_url)
            || target_id(&target.normalized_url, &target.username) != target.id
    });
    if registry.version != 1
        || unique_ids.len() != registry.targets.len()
        || invalid_target
        || registry
            .active_target_id
            .as_ref()
            .is_some_and(|id| !registry.targets.iter().any(|target| &target.id == id))
    {
        return Err(invalid("invalid_sync_target_registry"));
    }
    Ok(Some(registry))
}

fn save_registry(conn: &Connection, registry: &SyncTargetRegistry) -> Result<(), AppError> {
    let raw = serde_json::to_string(registry).map_err(|error| invalid(error.to_string()))?;
    set_setting_tx(conn, REGISTRY_KEY, &raw)?;
    Ok(())
}

pub fn active_target(conn: &Connection) -> Result<Option<(String, u64)>, AppError> {
    let Some(registry) = registry(conn)? else {
        return Ok(None);
    };
    Ok(registry
        .active_target_id
        .map(|id| (id, registry.target_epoch)))
}

pub fn registry_exists_without_active_target(conn: &Connection) -> Result<bool, AppError> {
    Ok(registry(conn)?.is_some_and(|registry| registry.active_target_id.is_none()))
}

pub fn active_key(conn: &Connection, legacy_key: &str, suffix: &str) -> Result<String, AppError> {
    Ok(match active_target(conn)? {
        Some((id, _)) => scoped_key(&id, suffix),
        None => legacy_key.to_string(),
    })
}

pub fn verify_context(
    conn: &Connection,
    target_id: Option<&str>,
    target_epoch: Option<u64>,
) -> Result<(), AppError> {
    match registry(conn)? {
        None => Ok(()),
        Some(registry) => {
            let matches = registry.active_target_id.as_deref() == target_id
                && registry.active_target_id.is_some()
                && target_epoch == Some(registry.target_epoch);
            if matches {
                Ok(())
            } else {
                Err(invalid("stale_sync_target"))
            }
        }
    }
}

pub fn ensure_migrated(
    conn: &mut Connection,
    paths: &AppPaths,
) -> Result<SyncTargetRegistry, AppError> {
    if let Some(existing) = registry(conn)? {
        return Ok(existing);
    }
    let legacy_creds = get_setting_tx(conn, "webdav_creds")?.filter(|value| !value.is_empty());
    if legacy_creds.is_none() {
        let empty = SyncTargetRegistry::default();
        save_registry(conn, &empty)?;
        return Ok(empty);
    }
    let encrypted = legacy_creds.unwrap();
    let decrypted = auth::decrypt(&encrypted).map_err(|_| invalid("target_migration_required"))?;
    let separator = decrypted
        .find(':')
        .ok_or_else(|| invalid("target_migration_required"))?;
    let username = decrypted[..separator].trim().to_string();
    if username.is_empty() {
        return Err(invalid("target_migration_required"));
    }
    let url = normalize_url(&get_setting_tx(conn, "webdav_url")?.unwrap_or_else(|| {
        "https://dav.jianguoyun.com/dav/%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA/".into()
    }))?;
    let id = target_id(&url, &username);
    recovery_points::create(conn, paths, "target-migration")?;
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let target = SyncTarget {
        id: id.clone(),
        normalized_url: url,
        username,
        created_at: now.clone(),
        last_activated_at: now,
    };
    let registry = SyncTargetRegistry {
        version: 1,
        active_target_id: Some(id.clone()),
        target_epoch: 1,
        targets: vec![target],
    };
    let transaction = conn.transaction()?;
    for (legacy, suffix) in LEGACY_SCOPED_KEYS {
        if let Some(value) = get_setting_tx(&transaction, legacy)? {
            set_setting_tx(&transaction, &scoped_key(&id, suffix), &value)?;
        }
    }
    save_registry(&transaction, &registry)?;
    for (legacy, _) in LEGACY_SCOPED_KEYS {
        transaction.execute("DELETE FROM settings WHERE key = ?1", [legacy])?;
    }
    transaction.execute("DELETE FROM settings WHERE key = 'webdav_url'", [])?;
    // Validate the exact value before making deletion of legacy keys durable.
    let stored =
        self::registry(&transaction)?.ok_or_else(|| invalid("target_migration_required"))?;
    if stored != registry {
        return Err(invalid("target_migration_required"));
    }
    transaction.commit()?;
    Ok(registry)
}

pub fn activate(
    conn: &mut Connection,
    paths: &AppPaths,
    input: ActivateTargetInput,
) -> Result<SyncTargetRegistry, AppError> {
    let url = normalize_url(&input.url)?;
    let username = input.username.trim().to_string();
    if username.is_empty() || input.password.is_empty() {
        return Err(invalid("invalid_sync_target_credentials"));
    }
    let (mut registry, transition) = match ensure_migrated(conn, paths) {
        Ok(registry) => {
            let transition = target_root_transition_v1(&registry, &url, &username)?;
            (registry, transition)
        }
        Err(error) if error.to_string().contains("target_migration_required") => {
            let replacement = migrate_with_replacement_credentials(conn, paths, &url, &username)?;
            (replacement.registry, replacement.transition)
        }
        Err(error) => return Err(error),
    };
    let id = target_id(&url, &username);
    let switching = registry.active_target_id.as_deref() != Some(&id);
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let transaction = conn.transaction()?;
    crate::secret_store::save_setting_secret(
        &transaction,
        &scoped_key(&id, "credentials"),
        &crate::secret_store::LogicalSecret::WebDav(id.clone()),
        &username,
        &input.password,
    )?;
    if let Some(target) = registry.targets.iter_mut().find(|target| target.id == id) {
        target.normalized_url = url;
        target.username = username;
        target.last_activated_at = now;
    } else {
        registry.targets.push(SyncTarget {
            id: id.clone(),
            normalized_url: url,
            username,
            created_at: now.clone(),
            last_activated_at: now,
        });
    }
    if switching {
        registry.target_epoch = registry
            .target_epoch
            .checked_add(1)
            .ok_or_else(|| invalid("sync_target_epoch_overflow"))?;
        registry.active_target_id = Some(id.clone());
    }
    persist_target_activation_v1(&transaction, &registry, &id, transition)?;
    if switching {
        let generation = get_setting_generation(&transaction)?;
        let staging =
            crate::sync_staging::rebuild_from_current_for_target(&transaction, generation, &id)?;
        if !staging.entries.is_empty() {
            let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let mut outbox = crate::db_atomic_helpers::get_sync_outbox(&transaction)?
                .unwrap_or_else(|| crate::db_atomic_helpers::SyncOutbox::clean(generation));
            if !outbox.pending {
                outbox.first_queued_at = Some(now.clone());
            }
            outbox.pending = true;
            outbox.dirty_generation = generation;
            outbox.last_queued_at = Some(now);
            if !outbox
                .reasons
                .iter()
                .any(|reason| reason == "target-reactivation")
            {
                outbox.reasons.push("target-reactivation".into());
            }
            crate::db_atomic_helpers::set_sync_outbox(&transaction, &outbox)?;
        }
    }
    transaction.commit()?;
    Ok(registry)
}

struct ReplacementMigrationV1 {
    registry: SyncTargetRegistry,
    transition: TargetRootTransitionV1,
}

fn migrate_with_replacement_credentials(
    conn: &mut Connection,
    paths: &AppPaths,
    url: &str,
    username: &str,
) -> Result<ReplacementMigrationV1, AppError> {
    // A corrupt legacy credential has no authoritative historical account/root
    // identity. The supplied replacement is therefore always a fail-safe root
    // transition, never a post-write inferred same-root refresh.
    webdav_root_v1(url, username).map_err(|_| invalid("invalid_sync_target_root"))?;
    recovery_points::create(conn, paths, "target-migration")?;
    let id = target_id(url, username);
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let registry = SyncTargetRegistry {
        version: 1,
        active_target_id: Some(id.clone()),
        target_epoch: 1,
        targets: vec![SyncTarget {
            id: id.clone(),
            normalized_url: url.to_string(),
            username: username.to_string(),
            created_at: now.clone(),
            last_activated_at: now,
        }],
    };
    let transaction = conn.transaction()?;
    for (legacy, suffix) in LEGACY_SCOPED_KEYS {
        if *legacy == "webdav_creds" {
            continue;
        }
        if let Some(value) = get_setting_tx(&transaction, legacy)? {
            set_setting_tx(&transaction, &scoped_key(&id, suffix), &value)?;
        }
    }
    persist_target_activation_v1(
        &transaction,
        &registry,
        &id,
        TargetRootTransitionV1::RootChanged,
    )?;
    for (legacy, _) in LEGACY_SCOPED_KEYS {
        transaction.execute("DELETE FROM settings WHERE key = ?1", [legacy])?;
    }
    transaction.execute("DELETE FROM settings WHERE key = 'webdav_url'", [])?;
    transaction.commit()?;
    Ok(ReplacementMigrationV1 {
        registry,
        transition: TargetRootTransitionV1::RootChanged,
    })
}

fn get_setting_generation(conn: &Connection) -> Result<i64, AppError> {
    crate::db_atomic_helpers::get_records_generation(conn)
}

pub fn disconnect(conn: &mut Connection, paths: &AppPaths) -> Result<SyncTargetRegistry, AppError> {
    let mut registry = ensure_migrated(conn, paths)?;
    if registry.active_target_id.is_some() {
        registry.active_target_id = None;
        registry.target_epoch = registry
            .target_epoch
            .checked_add(1)
            .ok_or_else(|| invalid("sync_target_epoch_overflow"))?;
        save_registry(conn, &registry)?;
    }
    Ok(registry)
}

pub fn credentials(
    conn: &mut Connection,
    paths: &AppPaths,
) -> Result<Option<ActiveSyncConnection>, AppError> {
    let registry = ensure_migrated(conn, paths)?;
    let Some(id) = registry.active_target_id.as_ref() else {
        return Ok(None);
    };
    let target = registry
        .targets
        .iter()
        .find(|target| &target.id == id)
        .ok_or_else(|| invalid("invalid_sync_target_registry"))?;
    let available = resolve_target_secret(conn, target)?.is_some();
    Ok(Some(ActiveSyncConnection {
        target_id: id.clone(),
        target_epoch: registry.target_epoch,
        url: target.normalized_url.clone(),
        username: target.username.clone(),
        credential_available: available,
    }))
}

fn resolve_target_secret(
    conn: &Connection,
    target: &SyncTarget,
) -> Result<Option<zeroize::Zeroizing<String>>, AppError> {
    let username = target.username.clone();
    crate::secret_store::resolve_or_migrate(
        conn,
        &scoped_key(&target.id, "credentials"),
        &crate::secret_store::LogicalSecret::WebDav(target.id.clone()),
        &target.username,
        move |legacy| {
            let separator = legacy
                .find(':')
                .ok_or_else(|| invalid("credential_legacy_corrupt"))?;
            if legacy[..separator] != username {
                return Err(invalid("credential_legacy_corrupt"));
            }
            Ok(legacy[separator + 1..].to_string())
        },
    )
}

pub fn active_request_credentials(
    conn: &mut Connection,
    paths: &AppPaths,
    target_id: &str,
    target_epoch: u64,
) -> Result<(String, String, zeroize::Zeroizing<String>), AppError> {
    ensure_migrated(conn, paths)?;
    verify_context(conn, Some(target_id), Some(target_epoch))?;
    let registry = registry(conn)?.ok_or_else(|| invalid("invalid_sync_target_registry"))?;
    let target = registry
        .targets
        .iter()
        .find(|target| target.id == target_id)
        .ok_or_else(|| invalid("invalid_sync_target_registry"))?;
    let password =
        resolve_target_secret(conn, target)?.ok_or_else(|| invalid("credential_missing"))?;
    Ok((
        target.normalized_url.clone(),
        target.username.clone(),
        password,
    ))
}

/// Retrieves credentials for a historically bound target without consulting
/// the active target or its epoch. Callers must still validate their immutable
/// target/root binding before using this material for recovery.
pub fn historical_request_credentials(
    conn: &mut Connection,
    paths: &AppPaths,
    target_id: &str,
) -> Result<Option<(String, String, zeroize::Zeroizing<String>)>, AppError> {
    let registry = ensure_migrated(conn, paths)?;
    let Some(target) = registry
        .targets
        .iter()
        .find(|target| target.id == target_id)
    else {
        return Ok(None);
    };
    let Some(password) = resolve_target_secret(conn, target)? else {
        return Ok(None);
    };
    Ok(Some((
        target.normalized_url.clone(),
        target.username.clone(),
        password,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_paths::AppPaths;
    use crate::db;
    use crate::db_atomic_helpers::{
        get_setting_tx, get_sync_outbox, set_setting_tx, set_sync_outbox, SyncOutbox,
    };
    use crate::sync_state::SyncSchedulerState;

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn
    }

    fn target(id_char: char) -> SyncTarget {
        let normalized_url = format!("https://{id_char}.example/dav/");
        let username = id_char.to_string();
        SyncTarget {
            id: target_id(&normalized_url, &username),
            normalized_url,
            username,
            created_at: "now".into(),
            last_activated_at: "now".into(),
        }
    }

    #[test]
    fn target_identity_normalizes_transport_noise_but_preserves_path_and_username_case() {
        let url = normalize_url(" HTTPS://Example.COM:443/Dav/Movies///?token=x#part ").unwrap();
        assert_eq!(url, "https://example.com/Dav/Movies/");
        assert_eq!(
            target_id(&url, "User"),
            target_id("https://example.com/Dav/Movies/", "User")
        );
        assert_ne!(target_id(&url, "User"), target_id(&url, "user"));
        assert_eq!(
            normalize_url("https://example.com/dav/%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA/").unwrap(),
            "https://example.com/dav/%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA/"
        );
    }

    #[test]
    fn physical_root_change_uses_frozen_webdav_identity() {
        let a = target('a');
        let registry = SyncTargetRegistry {
            version: 1,
            active_target_id: Some(a.id.clone()),
            target_epoch: 1,
            targets: vec![a.clone()],
        };

        // A first target has no prior root and must begin paused.
        assert_eq!(
            target_root_transition_v1(
                &SyncTargetRegistry::default(),
                &a.normalized_url,
                &a.username,
            )
            .unwrap(),
            TargetRootTransitionV1::FirstTarget
        );
        // Re-saving the exact frozen root preserves its current preference.
        assert_eq!(
            target_root_transition_v1(&registry, &a.normalized_url, &a.username).unwrap(),
            TargetRootTransitionV1::SameRoot
        );
        // Both path and account identity participate through webdav_root_v1.
        assert_eq!(
            target_root_transition_v1(&registry, "https://a.example/dav/other-root/", &a.username,)
                .unwrap(),
            TargetRootTransitionV1::RootChanged
        );
        assert_eq!(
            target_root_transition_v1(&registry, &a.normalized_url, "other-account").unwrap(),
            TargetRootTransitionV1::RootChanged
        );
    }

    #[test]
    fn changed_root_persists_paused_scheduler_with_target_activation() {
        let mut conn = connection();
        let a = target('a');
        let b = target('b');
        let active_a = SyncTargetRegistry {
            version: 1,
            active_target_id: Some(a.id.clone()),
            target_epoch: 1,
            targets: vec![a.clone(), b.clone()],
        };
        save_registry(&conn, &active_a).unwrap();

        let enabled = SyncSchedulerState {
            next_attempt_at: Some("2026-10-01T00:00:00Z".into()),
            ..SyncSchedulerState::default()
        };
        set_setting_tx(
            &conn,
            &scoped_key(&b.id, "scheduler_v1"),
            &serde_json::to_string(&enabled).unwrap(),
        )
        .unwrap();

        let changed_b = SyncTargetRegistry {
            active_target_id: Some(b.id.clone()),
            target_epoch: 2,
            ..active_a.clone()
        };
        let transaction = conn.transaction().unwrap();
        persist_target_activation_v1(
            &transaction,
            &changed_b,
            &b.id,
            TargetRootTransitionV1::RootChanged,
        )
        .unwrap();

        // The transaction contains both facts before it can be committed.
        assert_eq!(
            super::registry(&transaction).unwrap(),
            Some(changed_b.clone())
        );
        let raw = get_setting_tx(&transaction, &scoped_key(&b.id, "scheduler_v1"))
            .unwrap()
            .unwrap();
        let persisted: SyncSchedulerState = serde_json::from_str(&raw).unwrap();
        assert!(persisted.paused);
        assert_eq!(persisted.next_attempt_at, None);
        transaction.commit().unwrap();

        let raw = get_setting_tx(&conn, &scoped_key(&b.id, "scheduler_v1"))
            .unwrap()
            .unwrap();
        assert!(
            serde_json::from_str::<SyncSchedulerState>(&raw)
                .unwrap()
                .paused
        );
    }

    #[test]
    fn first_target_activation_persists_automatic_sync_off() {
        let mut conn = connection();
        let a = target('a');
        let first_registry = SyncTargetRegistry {
            version: 1,
            active_target_id: Some(a.id.clone()),
            target_epoch: 1,
            targets: vec![a.clone()],
        };
        assert_eq!(
            target_root_transition_v1(
                &SyncTargetRegistry::default(),
                &a.normalized_url,
                &a.username,
            )
            .unwrap(),
            TargetRootTransitionV1::FirstTarget
        );

        let transaction = conn.transaction().unwrap();
        persist_target_activation_v1(
            &transaction,
            &first_registry,
            &a.id,
            TargetRootTransitionV1::FirstTarget,
        )
        .unwrap();
        transaction.commit().unwrap();

        let raw = get_setting_tx(&conn, &scoped_key(&a.id, "scheduler_v1"))
            .unwrap()
            .unwrap();
        assert!(
            serde_json::from_str::<SyncSchedulerState>(&raw)
                .unwrap()
                .paused
        );
    }

    #[test]
    fn same_root_credential_refresh_preserves_enabled_or_disabled_scheduler_preference() {
        for paused in [false, true] {
            let mut conn = connection();
            let a = target('a');
            let registry = SyncTargetRegistry {
                version: 1,
                active_target_id: Some(a.id.clone()),
                target_epoch: 1,
                targets: vec![a.clone()],
            };
            save_registry(&conn, &registry).unwrap();
            let scheduler = SyncSchedulerState {
                paused,
                ..SyncSchedulerState::default()
            };
            set_setting_tx(
                &conn,
                &scoped_key(&a.id, "scheduler_v1"),
                &serde_json::to_string(&scheduler).unwrap(),
            )
            .unwrap();

            assert_eq!(
                target_root_transition_v1(&registry, &a.normalized_url, &a.username).unwrap(),
                TargetRootTransitionV1::SameRoot
            );
            let transaction = conn.transaction().unwrap();
            persist_target_activation_v1(
                &transaction,
                &registry,
                &a.id,
                TargetRootTransitionV1::SameRoot,
            )
            .unwrap();
            transaction.commit().unwrap();

            let raw = get_setting_tx(&conn, &scoped_key(&a.id, "scheduler_v1"))
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<SyncSchedulerState>(&raw)
                    .unwrap()
                    .paused,
                paused
            );
        }
    }

    #[test]
    fn corrupt_legacy_replacement_is_durably_paused_before_becoming_active() {
        let root = std::env::temp_dir().join(format!(
            "watchtracker-target-replacement-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let paths = AppPaths::resolve_from(None, &root).unwrap();
        let mut conn = Connection::open(paths.database()).unwrap();
        db::setup_db(&conn).unwrap();
        set_setting_tx(&conn, "webdav_creds", "corrupt-legacy-credentials").unwrap();
        set_setting_tx(&conn, "webdav_url", "https://legacy.example/dav/old-root/").unwrap();
        let legacy_scheduler = SyncSchedulerState {
            next_attempt_at: Some("2026-10-01T00:00:00Z".into()),
            ..SyncSchedulerState::default()
        };
        set_setting_tx(
            &conn,
            "sync_scheduler_v1",
            &serde_json::to_string(&legacy_scheduler).unwrap(),
        )
        .unwrap();

        assert!(ensure_migrated(&mut conn, &paths)
            .unwrap_err()
            .to_string()
            .contains("target_migration_required"));

        let replacement = migrate_with_replacement_credentials(
            &mut conn,
            &paths,
            "https://replacement.example/dav/new-root/",
            "replacement-user",
        )
        .unwrap();
        assert_eq!(replacement.transition, TargetRootTransitionV1::RootChanged);
        let id = replacement.registry.active_target_id.clone().unwrap();
        assert_eq!(
            super::registry(&conn).unwrap(),
            Some(replacement.registry.clone())
        );
        let raw = get_setting_tx(&conn, &scoped_key(&id, "scheduler_v1"))
            .unwrap()
            .unwrap();
        let scheduler: SyncSchedulerState = serde_json::from_str(&raw).unwrap();
        assert!(scheduler.paused);
        assert_eq!(scheduler.next_attempt_at, None);
        assert_eq!(get_setting_tx(&conn, "sync_scheduler_v1").unwrap(), None);

        drop(conn);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn target_scoped_outboxes_are_isolated_and_epoch_rejects_old_work() {
        let conn = connection();
        let a = target('a');
        let b = target('b');
        save_registry(
            &conn,
            &SyncTargetRegistry {
                version: 1,
                active_target_id: Some(a.id.clone()),
                target_epoch: 4,
                targets: vec![a.clone(), b.clone()],
            },
        )
        .unwrap();
        let mut a_outbox = SyncOutbox::clean(7);
        a_outbox.pending = true;
        set_sync_outbox(&conn, &a_outbox).unwrap();
        assert!(get_sync_outbox(&conn).unwrap().unwrap().pending);
        verify_context(&conn, Some(&a.id), Some(4)).unwrap();

        save_registry(
            &conn,
            &SyncTargetRegistry {
                version: 1,
                active_target_id: Some(b.id.clone()),
                target_epoch: 5,
                targets: vec![a.clone(), b.clone()],
            },
        )
        .unwrap();
        assert!(get_sync_outbox(&conn).unwrap().is_none());
        assert!(verify_context(&conn, Some(&a.id), Some(4))
            .unwrap_err()
            .to_string()
            .contains("stale_sync_target"));
        let mut b_outbox = SyncOutbox::clean(9);
        b_outbox.pending = true;
        b_outbox.reasons.push("b-only".into());
        set_sync_outbox(&conn, &b_outbox).unwrap();

        save_registry(
            &conn,
            &SyncTargetRegistry {
                version: 1,
                active_target_id: Some(a.id.clone()),
                target_epoch: 6,
                targets: vec![a.clone(), b],
            },
        )
        .unwrap();
        let restored_a = get_sync_outbox(&conn).unwrap().unwrap();
        assert!(restored_a.pending);
        assert!(!restored_a.reasons.iter().any(|reason| reason == "b-only"));

        let targets = registry(&conn).unwrap().unwrap().targets;
        save_registry(
            &conn,
            &SyncTargetRegistry {
                version: 1,
                active_target_id: None,
                target_epoch: 7,
                targets,
            },
        )
        .unwrap();
        assert!(verify_context(&conn, Some(&a.id), Some(6))
            .unwrap_err()
            .to_string()
            .contains("stale_sync_target"));
    }

    #[test]
    fn legacy_global_state_migrates_atomically_without_changing_v18() {
        let root = std::env::temp_dir().join(format!(
            "watchtracker-target-migration-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let paths = AppPaths::resolve_from(None, &root).unwrap();
        let mut conn = Connection::open(paths.database()).unwrap();
        db::setup_db(&conn).unwrap();
        let encrypted = auth::encrypt("LegacyUser:secret", "webdav_creds").unwrap();
        set_setting_tx(&conn, "webdav_creds", &encrypted).unwrap();
        set_setting_tx(&conn, "webdav_url", "https://example.test/dav/Movies/").unwrap();
        set_setting_tx(&conn, "sync_v3_remote_etag", "\"legacy-etag\"").unwrap();
        set_setting_tx(&conn, "sync_v3_conflicts", "[]").unwrap();

        let migrated = ensure_migrated(&mut conn, &paths).unwrap();
        let id = migrated.active_target_id.unwrap();
        assert_eq!(migrated.target_epoch, 1);
        assert_eq!(get_setting_tx(&conn, "webdav_creds").unwrap(), None);
        assert_eq!(get_setting_tx(&conn, "sync_v3_remote_etag").unwrap(), None);
        assert_eq!(
            get_setting_tx(&conn, &scoped_key(&id, "remote_etag"))
                .unwrap()
                .as_deref(),
            Some("\"legacy-etag\"")
        );
        assert_eq!(
            get_setting_tx(&conn, "db_version").unwrap().as_deref(),
            Some("18")
        );
        assert!(crate::recovery_points::list(&paths)
            .unwrap()
            .points
            .iter()
            .any(|point| point.reason == "target-migration"));
        drop(conn);
        let _ = std::fs::remove_dir_all(root);
    }
}
