//! Exact publication and recovery for one already-frozen ordinary intent.
//!
//! This module deliberately owns neither staging acknowledgement nor writer
//! head advancement. Its sole durable success fact is a verified receipt for
//! the exact bytes previously frozen into an `OutboundBatchV1`.

use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;

use super::canonical::{ProtocolError, Result};
use super::durable_persistence::{
    OrdinaryPublishExclusiveResultV1, OutboundBatchV1, SqliteS2LiteStoreV1, TargetRootBindingV1,
};
use super::immutable_publish::{
    persist_prepared_intent_before_publish_v1, publish_persisted_intent_v1,
    ImmutableObjectRemoteV1, RecoverPreparedIntentResultV1,
};
use super::migration_orchestration::MigrationStateStoreV1;
use super::root_coordinator::RootExecutionCoordinatorV1;
use super::target_root_binding::load_historical_target_root_binding_v1;
use super::webdav_adapter::{webdav_root_v1, WebDavRootV1, WebDavS2ConfigV1, WebDavS2RemoteV1};

const OUTBOUND_PUBLISH_FAILURE: ProtocolError = ProtocolError("S2_OUTBOUND_PUBLISH_FAILURE");

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoricalWebDavCredentialsV1 {
    pub canonical_url: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboundPublishResultV1 {
    AlreadyPublished,
    Published,
    Pending,
    AuthOrCapabilityBlocked,
    RootFrozen,
}

fn batch_matches_binding(batch: &OutboundBatchV1, binding: &TargetRootBindingV1) -> bool {
    batch.target_id == binding.target_id
        && batch.target_epoch == binding.target_epoch
        && batch.physical_root_id == binding.physical_root_id
}

fn freeze_root(
    store: &mut SqliteS2LiteStoreV1<'_>,
    root_id: &str,
    code: &str,
) -> Result<OutboundPublishResultV1> {
    let _ = MigrationStateStoreV1::persist_root_fatal(store, root_id, code)?;
    Ok(OutboundPublishResultV1::RootFrozen)
}

/// Publishes no more than the exact intent already bound to `batch`. The
/// credentials and remote are constructed from the immutable historical
/// binding, never from the currently active target.
pub fn publish_frozen_outbound_batch_with_factory_v1<R, L, F>(
    conn: &Mutex<Connection>,
    coordinator: &RootExecutionCoordinatorV1,
    batch: &OutboundBatchV1,
    mut load_historical_credentials: L,
    build_remote: F,
    verified_at_diagnostic: &str,
) -> Result<OutboundPublishResultV1>
where
    R: ImmutableObjectRemoteV1,
    L: FnMut(&TargetRootBindingV1) -> Result<Option<HistoricalWebDavCredentialsV1>>,
    F: FnOnce(&TargetRootBindingV1, HistoricalWebDavCredentialsV1) -> Result<R>,
{
    let binding =
        load_historical_target_root_binding_v1(conn, &batch.target_id, batch.target_epoch)?;
    let Some(binding) = binding else {
        let mut store = SqliteS2LiteStoreV1::open(conn, &batch.physical_root_id)?;
        return freeze_root(
            &mut store,
            &batch.physical_root_id,
            "S2_OUTBOUND_HISTORICAL_BINDING_MISSING",
        );
    };
    if !batch_matches_binding(batch, &binding) {
        let mut store = SqliteS2LiteStoreV1::open(conn, &batch.physical_root_id)?;
        return freeze_root(
            &mut store,
            &batch.physical_root_id,
            "S2_OUTBOUND_BATCH_BINDING_MISMATCH",
        );
    }
    let Some(credentials) = load_historical_credentials(&binding)? else {
        return Ok(OutboundPublishResultV1::Pending);
    };
    let root = webdav_root_v1(&credentials.canonical_url, &credentials.username)
        .map_err(|_| OUTBOUND_PUBLISH_FAILURE)?;
    if root.canonical_url != binding.canonical_url
        || root.normalized_account != binding.normalized_account
        || root.physical_root_id != binding.physical_root_id
    {
        let mut store = SqliteS2LiteStoreV1::open(conn, &batch.physical_root_id)?;
        return freeze_root(
            &mut store,
            &batch.physical_root_id,
            "S2_OUTBOUND_HISTORICAL_CREDENTIAL_BINDING_MISMATCH",
        );
    }
    let mut remote = build_remote(&binding, credentials)?;
    if remote.physical_root_id() != Some(binding.physical_root_id.as_str()) {
        let mut store = SqliteS2LiteStoreV1::open(conn, &batch.physical_root_id)?;
        return freeze_root(
            &mut store,
            &batch.physical_root_id,
            "S2_OUTBOUND_REMOTE_ROOT_MISMATCH",
        );
    }

    let _guard = coordinator.acquire_blocking(&binding.physical_root_id)?;
    let mut store = SqliteS2LiteStoreV1::open(conn, &binding.physical_root_id)?;
    let durable_batch = store.load_unfinished_outbound_batch()?;
    if durable_batch.as_ref() != Some(batch) {
        return freeze_root(
            &mut store,
            &binding.physical_root_id,
            "S2_OUTBOUND_DURABLE_BATCH_MISMATCH",
        );
    }
    let intent = store
        .load_prepared_intent(&batch.prepared_intent_path)?
        .ok_or(OUTBOUND_PUBLISH_FAILURE)?;
    if intent.intent_fingerprint != batch.prepared_intent_fingerprint
        || intent.remote_path != batch.prepared_intent_path
        || intent.commit_ref != batch.commit_ref
    {
        return freeze_root(
            &mut store,
            &binding.physical_root_id,
            "S2_OUTBOUND_DURABLE_INTENT_MISMATCH",
        );
    }
    if store.load_published_receipt(&intent.remote_path)?.is_some() {
        return Ok(OutboundPublishResultV1::AlreadyPublished);
    }

    let persisted = persist_prepared_intent_before_publish_v1(&intent, &mut store)?;
    let recovered =
        match store.run_ordinary_publish_exclusive(&binding.physical_root_id, &intent, || {
            publish_persisted_intent_v1(&persisted, &mut remote, verified_at_diagnostic)
        })? {
            OrdinaryPublishExclusiveResultV1::Executed(value) => value,
            OrdinaryPublishExclusiveResultV1::RejectedRootFrozen => {
                return Ok(OutboundPublishResultV1::RootFrozen)
            }
        };
    match recovered {
        RecoverPreparedIntentResultV1::AlreadyPublishedExact(_) => {
            match store.verify_and_persist_commit_receipt(
                &intent,
                &mut remote,
                verified_at_diagnostic,
            )? {
                RecoverPreparedIntentResultV1::AlreadyPublishedExact(_) => {
                    Ok(OutboundPublishResultV1::Published)
                }
                RecoverPreparedIntentResultV1::CorruptionMismatch(_) => freeze_root(
                    &mut store,
                    &binding.physical_root_id,
                    "REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH",
                ),
                RecoverPreparedIntentResultV1::RemoteIndeterminate
                | RecoverPreparedIntentResultV1::RetryPublishExact => {
                    Ok(OutboundPublishResultV1::Pending)
                }
                RecoverPreparedIntentResultV1::AuthOrCapabilityFailure => {
                    Ok(OutboundPublishResultV1::AuthOrCapabilityBlocked)
                }
            }
        }
        RecoverPreparedIntentResultV1::CorruptionMismatch(_) => freeze_root(
            &mut store,
            &binding.physical_root_id,
            "REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH",
        ),
        RecoverPreparedIntentResultV1::RemoteIndeterminate
        | RecoverPreparedIntentResultV1::RetryPublishExact => Ok(OutboundPublishResultV1::Pending),
        RecoverPreparedIntentResultV1::AuthOrCapabilityFailure => {
            Ok(OutboundPublishResultV1::AuthOrCapabilityBlocked)
        }
    }
}

/// Production WebDAV construction for the historical binding. Tests use the
/// factory entry point above so they can deterministically control remote
/// outcomes without a network.
pub fn publish_frozen_outbound_batch_with_webdav_v1(
    conn: &Mutex<Connection>,
    paths: &crate::app_paths::AppPaths,
    coordinator: &RootExecutionCoordinatorV1,
    batch: &OutboundBatchV1,
    verified_at_diagnostic: &str,
) -> Result<OutboundPublishResultV1> {
    publish_frozen_outbound_batch_with_factory_v1(
        conn,
        coordinator,
        batch,
        |binding| {
            let mut guard = conn.lock().map_err(|_| OUTBOUND_PUBLISH_FAILURE)?;
            let credentials = crate::sync_targets::historical_request_credentials(
                &mut guard,
                paths,
                &binding.target_id,
            )
            .map_err(|_| OUTBOUND_PUBLISH_FAILURE)?;
            Ok(credentials.map(|(canonical_url, username, password)| {
                HistoricalWebDavCredentialsV1 {
                    canonical_url,
                    username,
                    password: password.to_string(),
                }
            }))
        },
        |binding, credentials| {
            WebDavS2RemoteV1::new(WebDavS2ConfigV1 {
                root: WebDavRootV1 {
                    canonical_url: binding.canonical_url.clone(),
                    normalized_account: binding.normalized_account.clone(),
                    physical_root_id: binding.physical_root_id.clone(),
                },
                username: credentials.username,
                password: credentials.password,
                proxy: None,
                timeout: Duration::from_secs(30),
            })
            .map_err(|_| OUTBOUND_PUBLISH_FAILURE)
        },
        verified_at_diagnostic,
    )
}
