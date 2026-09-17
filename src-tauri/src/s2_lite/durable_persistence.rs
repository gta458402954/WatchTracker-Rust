//! Production SQLite persistence for the frozen S2 Lite v1 core.
//!
//! Protocol structs remain the in-memory source of truth. SQLite JSON BLOBs use
//! a persistence-specific, versioned envelope and a strict canonical payload:
//! missing default-sensitive fields and unknown fields at any nesting depth are
//! rejected before the value is admitted to the frozen core. Generation columns
//! are independently bound as canonical decimal TEXT for atomic comparisons.
//! Prepared object bytes are removed from metadata and stored in dedicated BLOB
//! columns without parsing or rewriting.

use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use super::activation_cutover::ActivationCutoverStateV1;
use super::canonical::{validate_canonical_uuid_v4, validate_commit_ref, ProtocolError, Result};
use super::causal::decode_frozen_wire_commit_v1;
use super::immutable_publish::{
    restart_durable_activation_publish_v1, restart_durable_publish_v1,
    validate_prepared_activation_intent_v1, validate_prepared_intent_v1,
    validate_published_activation_receipt_v1, validate_published_receipt_v1,
    ImmutableObjectRemoteV1, PreparedActivationIntentStoreV1, PreparedActivationIntentV1,
    PreparedIntentStoreV1, PreparedIntentV1, PublishedActivationReceiptV1,
    RecoverActivationIntentResultV1, RecoverPreparedIntentResultV1, RemotePublishedReceiptV1,
};
use super::materialized_projection::MaterializedProjectionStateV1;
use super::migration_orchestration::{
    create_migration_root_safety_state_v1, merge_migration_root_cutover_state_v1,
    reconcile_migration_state_v1, validate_attempt_transition, ActivationCutoverStateStoreV1,
    MigrationRootFatalV1, MigrationRootSafetyStateV1, MigrationStateStoreV1, MigrationStateV1,
    MigrationStatusV1, PublishExclusiveResultV1,
};
use super::remote_discovery::DiscoveryStateV1;
use super::types::CommitRef;

const STORE_FAILURE: ProtocolError = ProtocolError("S2_DURABLE_PERSISTENCE_FAILURE");
const STORE_CORRUPTION: ProtocolError = ProtocolError("S2_DURABLE_STATE_CORRUPTION");
const ROOT_MISMATCH: ProtocolError = ProtocolError("MIGRATION_ROOT_BINDING_MISMATCH");
const SCHEMA_VERSION: &str = "1";
const PERSISTENCE_FORMAT_VERSION: u8 = 1;

/// Result of an ordinary root-bound publication admission. A transport result
/// is intentionally not a receipt and carries no publication authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OrdinaryPublishExclusiveResultV1<T> {
    Executed(T),
    RejectedRootFrozen,
}

/// Local-only desktop bookkeeping. Frozen root safety, discovery, activation,
/// and receipts intentionally live in their established authoritative tables.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopRootStateV1 {
    pub state_version: u8,
    pub physical_root_id: String,
    pub local_writer_id: String,
    pub next_writer_sequence: u64,
    pub writer_head: Option<CommitRef>,
    pub lifecycle_generation: u64,
    pub materialized_projection_generation: Option<u64>,
    pub business_applied_projection_generation: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutboundBatchMutationV1 {
    pub entity_kind: String,
    pub entity_id: String,
    pub captured_last_generation: i64,
    pub local_mutation_id: String,
}

/// Local recovery binding for one ordinary commit. It references the durable
/// prepared intent and authoritative receipt; it never copies receipt facts.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutboundBatchV1 {
    pub state_version: u8,
    pub batch_id: String,
    pub physical_root_id: String,
    pub captured_local_generation: i64,
    pub mutations: Vec<OutboundBatchMutationV1>,
    pub base_frontier: Vec<CommitRef>,
    pub writer_id: String,
    pub writer_sequence: u64,
    pub previous_writer_ref: Option<CommitRef>,
    pub prepared_intent_path: String,
    pub prepared_intent_fingerprint: String,
    pub bookkeeping_completed: bool,
    pub bookkeeping_generation: u64,
}

/// Rebuildable cache binding frozen replay output to the exact durable inputs
/// used to derive it. It is never receipt, safety, or discovery authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableMaterializedProjectionV1 {
    pub projection_version: u8,
    pub physical_root_id: String,
    pub projection_generation: u64,
    pub source_discovery_generation: u64,
    pub source_root_safety_generation: u64,
    pub replay_input_fingerprint: String,
    pub business_projection_applied_generation: Option<u64>,
    pub state: MaterializedProjectionStateV1,
}

/// Local bookkeeping result for one complete overlay-aware business projection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BusinessProjectionTransactionResultV1 {
    Applied,
    AlreadyApplied,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistenceEnvelopeRefV1<'a, T> {
    persistence_version: u8,
    payload: &'a T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistenceEnvelopeValueV1 {
    persistence_version: u8,
    payload: Value,
}

/// Private local proof created only after an exact GET against one physical
/// remote root. Raw wire/durable receipts have no conversion into this type.
#[derive(Clone, Debug, Eq, PartialEq)]
struct RootBoundPublishedReceiptV1 {
    physical_root_id: String,
    receipt: RemotePublishedReceiptV1,
}

/// Local proof that an activation receipt came from verification against one
/// physical remote root.
#[derive(Clone, Debug, Eq, PartialEq)]
struct RootBoundPublishedActivationReceiptV1 {
    physical_root_id: String,
    receipt: PublishedActivationReceiptV1,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedPublishedReceiptV1<T> {
    physical_root_id: String,
    receipt: T,
}

pub(crate) fn migrate_schema(conn: &Connection) -> rusqlite::Result<()> {
    let existing = conn
        .query_row(
            "SELECT value FROM settings WHERE key='s2_lite_persistence_schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if existing
        .as_deref()
        .is_some_and(|value| value != SCHEMA_VERSION)
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let transaction = conn.unchecked_transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS s2_lite_root_authority_v1 (
            root_id TEXT PRIMARY KEY NOT NULL CHECK(length(root_id) > 0),
            authority_generation TEXT NOT NULL,
            state_json BLOB NOT NULL CHECK(typeof(state_json) = 'blob')
         );
         CREATE TABLE IF NOT EXISTS s2_lite_migration_v1 (
            root_id TEXT PRIMARY KEY NOT NULL,
            migration_id TEXT NOT NULL,
            migration_generation TEXT NOT NULL,
            state_json BLOB NOT NULL CHECK(typeof(state_json) = 'blob'),
            FOREIGN KEY(root_id) REFERENCES s2_lite_root_authority_v1(root_id) ON DELETE RESTRICT
         );
         CREATE TABLE IF NOT EXISTS s2_lite_discovery_v1 (
            root_id TEXT PRIMARY KEY NOT NULL,
            storage_generation TEXT NOT NULL,
            state_json BLOB NOT NULL CHECK(typeof(state_json) = 'blob'),
            FOREIGN KEY(root_id) REFERENCES s2_lite_root_authority_v1(root_id) ON DELETE RESTRICT
         );
         CREATE TABLE IF NOT EXISTS s2_lite_prepared_intent_v1 (
            root_id TEXT NOT NULL,
            intent_kind TEXT NOT NULL CHECK(intent_kind IN ('commit', 'activation')),
            remote_path TEXT NOT NULL,
            intent_fingerprint TEXT NOT NULL,
            metadata_json BLOB NOT NULL CHECK(typeof(metadata_json) = 'blob'),
            exact_bytes BLOB NOT NULL CHECK(typeof(exact_bytes) = 'blob'),
            PRIMARY KEY(root_id, intent_kind, remote_path),
            FOREIGN KEY(root_id) REFERENCES s2_lite_root_authority_v1(root_id) ON DELETE RESTRICT
         );
         CREATE TABLE IF NOT EXISTS s2_lite_published_receipt_v1 (
            root_id TEXT NOT NULL,
            receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('commit', 'activation')),
            remote_path TEXT NOT NULL,
            receipt_json BLOB NOT NULL CHECK(typeof(receipt_json) = 'blob'),
            PRIMARY KEY(root_id, receipt_kind, remote_path),
            FOREIGN KEY(root_id, receipt_kind, remote_path)
              REFERENCES s2_lite_prepared_intent_v1(root_id, intent_kind, remote_path)
              ON DELETE RESTRICT
         );
         CREATE TABLE IF NOT EXISTS s2_lite_desktop_root_state_v1 (
            root_id TEXT PRIMARY KEY NOT NULL,
            state_json BLOB NOT NULL CHECK(typeof(state_json) = 'blob'),
            FOREIGN KEY(root_id) REFERENCES s2_lite_root_authority_v1(root_id) ON DELETE RESTRICT
         );
         CREATE TABLE IF NOT EXISTS s2_lite_outbound_batch_v1 (
            root_id TEXT PRIMARY KEY NOT NULL,
            batch_id TEXT NOT NULL UNIQUE,
            intent_path TEXT NOT NULL,
            intent_fingerprint TEXT NOT NULL,
            state_json BLOB NOT NULL CHECK(typeof(state_json) = 'blob'),
            FOREIGN KEY(root_id) REFERENCES s2_lite_root_authority_v1(root_id) ON DELETE RESTRICT
         );
         CREATE TABLE IF NOT EXISTS s2_lite_materialized_projection_v1 (
            root_id TEXT PRIMARY KEY NOT NULL,
            projection_generation TEXT NOT NULL,
            state_json BLOB NOT NULL CHECK(typeof(state_json) = 'blob'),
            FOREIGN KEY(root_id) REFERENCES s2_lite_root_authority_v1(root_id) ON DELETE RESTRICT
         );
         INSERT INTO settings(key, value) VALUES('s2_lite_persistence_schema_version', '1')
           ON CONFLICT(key) DO NOTHING;",
    )?;
    transaction.commit()
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(&PersistenceEnvelopeRefV1 {
        persistence_version: PERSISTENCE_FORMAT_VERSION,
        payload: value,
    })
    .map_err(|_| STORE_CORRUPTION)
}

fn decode<T: DeserializeOwned + Serialize>(bytes: &[u8]) -> Result<T> {
    let envelope: PersistenceEnvelopeValueV1 =
        serde_json::from_slice(bytes).map_err(|_| STORE_CORRUPTION)?;
    if envelope.persistence_version != PERSISTENCE_FORMAT_VERSION {
        return Err(STORE_CORRUPTION);
    }

    // Deserialize through a Value so the original durable representation is
    // retained. Comparing it with the frozen type's serialization catches both
    // unknown nested fields (which permissive core structs might ignore) and
    // omitted fields supplied by core serde defaults. This is intentionally a
    // persistence boundary check; frozen wire/core serde behavior is unchanged.
    let value: T =
        serde_json::from_value(envelope.payload.clone()).map_err(|_| STORE_CORRUPTION)?;
    let canonical_payload = serde_json::to_value(&value).map_err(|_| STORE_CORRUPTION)?;
    if canonical_payload != envelope.payload {
        return Err(STORE_CORRUPTION);
    }
    Ok(value)
}

fn database<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|_| STORE_FAILURE)
}

fn canonical_generation(value: &str) -> Result<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(STORE_CORRUPTION);
    }
    value.parse().map_err(|_| STORE_CORRUPTION)
}

fn valid_outbound_entity_kind(value: &str) -> bool {
    matches!(
        value,
        "record" | "collection" | "collection-member" | "episode-completion"
    )
}

fn validate_desktop_root_state(state: &DesktopRootStateV1, root_id: &str) -> Result<()> {
    if state.state_version != 1
        || state.physical_root_id != root_id
        || validate_canonical_uuid_v4(&state.local_writer_id).is_err()
        || state
            .writer_head
            .as_ref()
            .is_some_and(|value| validate_commit_ref(value).is_err())
        || state
            .business_applied_projection_generation
            .zip(state.materialized_projection_generation)
            .is_some_and(|(applied, materialized)| applied > materialized)
    {
        return Err(STORE_CORRUPTION);
    }
    Ok(())
}

fn validate_outbound_batch(batch: &OutboundBatchV1, root_id: &str) -> Result<()> {
    if batch.state_version != 1
        || batch.physical_root_id != root_id
        || validate_canonical_uuid_v4(&batch.batch_id).is_err()
        || validate_canonical_uuid_v4(&batch.writer_id).is_err()
        || batch.captured_local_generation < 0
        || batch.prepared_intent_path.is_empty()
        || batch.prepared_intent_fingerprint.is_empty()
        || batch
            .previous_writer_ref
            .as_ref()
            .is_some_and(|value| validate_commit_ref(value).is_err())
        || batch
            .base_frontier
            .iter()
            .any(|value| validate_commit_ref(value).is_err())
        || batch.mutations.is_empty()
        || batch.mutations.iter().any(|mutation| {
            !valid_outbound_entity_kind(&mutation.entity_kind)
                || mutation.entity_id.is_empty()
                || mutation.captured_last_generation < 0
                || validate_canonical_uuid_v4(&mutation.local_mutation_id).is_err()
        })
    {
        return Err(STORE_CORRUPTION);
    }
    Ok(())
}

fn validate_materialized_projection(
    projection: &DurableMaterializedProjectionV1,
    root_id: &str,
) -> Result<()> {
    if projection.projection_version != 1
        || projection.physical_root_id != root_id
        || projection.state.state_version != 1
        || projection.replay_input_fingerprint != projection.state.replay_input_fingerprint
        || projection.replay_input_fingerprint.len() != 64
        || !projection
            .replay_input_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || projection
            .business_projection_applied_generation
            .is_some_and(|value| value > projection.projection_generation)
    {
        return Err(STORE_CORRUPTION);
    }
    Ok(())
}

fn ensure_root_authority(conn: &Connection, root_id: &str) -> Result<()> {
    if root_id.is_empty() {
        return Err(ROOT_MISMATCH);
    }
    let state = create_migration_root_safety_state_v1(root_id);
    database(conn.execute(
        "INSERT INTO s2_lite_root_authority_v1(root_id, authority_generation, state_json)
         VALUES(?1, '0', ?2) ON CONFLICT(root_id) DO NOTHING",
        params![root_id, encode(&state)?],
    ))?;
    Ok(())
}

fn load_root_safety_from(
    conn: &Connection,
    root_id: &str,
) -> Result<Option<MigrationRootSafetyStateV1>> {
    let row = database(
        conn.query_row(
            "SELECT authority_generation, state_json
             FROM s2_lite_root_authority_v1 WHERE root_id=?1",
            [root_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
        )
        .optional(),
    )?;
    let Some((generation, bytes)) = row else {
        return Ok(None);
    };
    let state: MigrationRootSafetyStateV1 = decode(&bytes)?;
    let normalized_cutover = merge_migration_root_cutover_state_v1(
        &super::activation_cutover::create_activation_cutover_state_v1(),
        &state.cutover_state,
    )?;
    if state.state_version != 1
        || state.root_id != root_id
        || state.generation != canonical_generation(&generation)?
        || normalized_cutover != state.cutover_state
        || !strictly_sorted_unique(
            state
                .root_fatal_signals
                .iter()
                .map(|fatal| fatal.code.as_str()),
        )
        || state.cutover_state.root_fatal_signals.iter().any(|fatal| {
            !state
                .root_fatal_signals
                .iter()
                .any(|root_fatal| root_fatal.code == fatal.code)
        })
    {
        return Err(STORE_CORRUPTION);
    }
    Ok(Some(state))
}

fn strictly_sorted_unique<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut prior: Option<&str> = None;
    for value in values {
        if value.is_empty() || prior.is_some_and(|prior| prior >= value) {
            return false;
        }
        prior = Some(value);
    }
    true
}

fn save_root_safety(conn: &Connection, state: &MigrationRootSafetyStateV1) -> Result<()> {
    let changed = database(conn.execute(
        "UPDATE s2_lite_root_authority_v1
         SET authority_generation=?2, state_json=?3 WHERE root_id=?1",
        params![state.root_id, state.generation.to_string(), encode(state)?],
    ))?;
    if changed != 1 {
        return Err(STORE_FAILURE);
    }
    Ok(())
}

fn load_migration_from(conn: &Connection, root_id: &str) -> Result<Option<MigrationStateV1>> {
    let row = database(
        conn.query_row(
            "SELECT migration_id, migration_generation, state_json
             FROM s2_lite_migration_v1 WHERE root_id=?1",
            [root_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional(),
    )?;
    let Some((migration_id, generation, bytes)) = row else {
        return Ok(None);
    };
    let stored: MigrationStateV1 = decode(&bytes)?;
    let state = reconcile_migration_state_v1(&stored).map_err(|_| STORE_CORRUPTION)?;
    if state != stored
        || state.root_id != root_id
        || state.migration_id != migration_id
        || state.generation != canonical_generation(&generation)?
    {
        return Err(STORE_CORRUPTION);
    }
    Ok(Some(state))
}

fn insert_migration(conn: &Connection, state: &MigrationStateV1) -> Result<()> {
    database(conn.execute(
        "INSERT INTO s2_lite_migration_v1(
            root_id, migration_id, migration_generation, state_json
         ) VALUES(?1, ?2, ?3, ?4)",
        params![
            state.root_id,
            state.migration_id,
            state.generation.to_string(),
            encode(state)?,
        ],
    ))?;
    Ok(())
}

fn save_migration(conn: &Connection, state: &MigrationStateV1) -> Result<()> {
    let changed = database(conn.execute(
        "UPDATE s2_lite_migration_v1 SET migration_id=?2,
         migration_generation=?3, state_json=?4 WHERE root_id=?1",
        params![
            state.root_id,
            state.migration_id,
            state.generation.to_string(),
            encode(state)?,
        ],
    ))?;
    if changed != 1 {
        return Err(STORE_FAILURE);
    }
    Ok(())
}

fn add_fatal(state: &mut MigrationStateV1, code: &str) -> Result<bool> {
    if state
        .root_fatal_signals
        .iter()
        .any(|fatal| fatal.code == code)
    {
        return Ok(false);
    }
    state.generation = state.generation.checked_add(1).ok_or(STORE_CORRUPTION)?;
    state.status = MigrationStatusV1::RootFrozen;
    state.root_fatal_signals.push(MigrationRootFatalV1 {
        code: code.to_string(),
    });
    state
        .root_fatal_signals
        .sort_by(|left, right| left.code.cmp(&right.code));
    Ok(true)
}

fn inherit_root_fatals_on_claim(
    state: &mut MigrationStateV1,
    root_fatals: &[MigrationRootFatalV1],
) -> Result<()> {
    let mut codes = state
        .root_fatal_signals
        .iter()
        .map(|fatal| fatal.code.clone())
        .chain(root_fatals.iter().map(|fatal| fatal.code.clone()))
        .collect::<Vec<_>>();
    codes.sort();
    codes.dedup();
    if codes.len() != state.root_fatal_signals.len() {
        state.generation = state.generation.checked_add(1).ok_or(STORE_CORRUPTION)?;
        state.status = MigrationStatusV1::RootFrozen;
        state.root_fatal_signals = codes
            .into_iter()
            .map(|code| MigrationRootFatalV1 { code })
            .collect();
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VersionedDiscoveryStateV1 {
    pub storage_generation: u64,
    pub state: DiscoveryStateV1,
}

/// SQLite-backed S2 Lite state bound to one physical remote root.
///
/// Every clone shares the application's existing connection mutex. This lets the
/// separate frozen store traits participate in one root-scoped SQLite authority.
#[derive(Clone, Copy)]
pub struct SqliteS2LiteStoreV1<'a> {
    conn: &'a Mutex<Connection>,
    root_id: &'a str,
}

impl<'a> SqliteS2LiteStoreV1<'a> {
    pub fn open(conn: &'a Mutex<Connection>, root_id: &'a str) -> Result<Self> {
        if root_id.is_empty() {
            return Err(ROOT_MISMATCH);
        }
        {
            let guard = conn.lock().map_err(|_| STORE_FAILURE)?;
            database(migrate_schema(&guard))?;
        }
        Ok(Self { conn, root_id })
    }

    pub fn root_id(&self) -> &str {
        self.root_id
    }

    pub fn load_desktop_root_state(&mut self) -> Result<Option<DesktopRootStateV1>> {
        let conn = self.connection()?;
        let bytes = database(
            conn.query_row(
                "SELECT state_json FROM s2_lite_desktop_root_state_v1 WHERE root_id=?1",
                [self.root_id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional(),
        )?;
        bytes
            .map(|bytes| {
                let state: DesktopRootStateV1 = decode(&bytes)?;
                validate_desktop_root_state(&state, self.root_id)?;
                Ok(state)
            })
            .transpose()
    }

    pub fn load_materialized_projection(
        &mut self,
    ) -> Result<Option<DurableMaterializedProjectionV1>> {
        let conn = self.connection()?;
        let row = database(
            conn.query_row(
                "SELECT projection_generation, state_json FROM s2_lite_materialized_projection_v1 WHERE root_id=?1",
                [self.root_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional(),
        )?;
        row.map(|(generation, bytes)| {
            let projection: DurableMaterializedProjectionV1 = decode(&bytes)?;
            if projection.projection_generation != canonical_generation(&generation)? {
                return Err(STORE_CORRUPTION);
            }
            validate_materialized_projection(&projection, self.root_id)?;
            Ok(projection)
        })
        .transpose()
    }

    /// CAS persists only a replay made against the still-current discovery and
    /// root-safety generations. A stale complete cache can never authorize a
    /// later outbound freeze.
    pub fn compare_and_swap_materialized_projection(
        &mut self,
        expected_projection_generation: Option<u64>,
        projection: &DurableMaterializedProjectionV1,
    ) -> Result<bool> {
        validate_materialized_projection(projection, self.root_id)?;
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure_root_authority(&transaction, self.root_id)?;
        let safety = load_root_safety_from(&transaction, self.root_id)?.ok_or(STORE_CORRUPTION)?;
        if safety.generation != projection.source_root_safety_generation {
            return Ok(false);
        }
        let discovery = database(
            transaction
                .query_row(
                    "SELECT storage_generation FROM s2_lite_discovery_v1 WHERE root_id=?1",
                    [self.root_id],
                    |row| row.get::<_, String>(0),
                )
                .optional(),
        )?
        .map(|value| canonical_generation(&value))
        .transpose()?;
        if discovery != Some(projection.source_discovery_generation) {
            return Ok(false);
        }
        let current = database(
            transaction
                .query_row(
                    "SELECT projection_generation FROM s2_lite_materialized_projection_v1 WHERE root_id=?1",
                    [self.root_id],
                    |row| row.get::<_, String>(0),
                )
                .optional(),
        )?
        .map(|value| canonical_generation(&value))
        .transpose()?;
        if current != expected_projection_generation {
            return Ok(false);
        }
        database(transaction.execute(
            "INSERT INTO s2_lite_materialized_projection_v1(root_id, projection_generation, state_json)
             VALUES(?1, ?2, ?3) ON CONFLICT(root_id) DO UPDATE SET
             projection_generation=excluded.projection_generation, state_json=excluded.state_json",
            params![self.root_id, projection.projection_generation.to_string(), encode(projection)?],
        ))?;
        database(transaction.commit())?;
        Ok(true)
    }

    pub fn persist_desktop_root_state(&mut self, state: &DesktopRootStateV1) -> Result<()> {
        validate_desktop_root_state(state, self.root_id)?;
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure_root_authority(&transaction, self.root_id)?;
        database(transaction.execute(
            "INSERT INTO s2_lite_desktop_root_state_v1(root_id, state_json) VALUES(?1, ?2)
             ON CONFLICT(root_id) DO UPDATE SET state_json=excluded.state_json",
            params![self.root_id, encode(state)?],
        ))?;
        database(transaction.commit())?;
        Ok(())
    }

    /// Runs the local business projector under the same root-bound immediate
    /// transaction that validates its exact durable projection inputs. Advancing
    /// `businessAppliedProjectionGeneration` means fully processed locally; it
    /// never asserts equality between business tables and canonical replay.
    pub(crate) fn run_business_projection_transaction<T>(
        &mut self,
        expected_projection_generation: u64,
        apply: impl FnOnce(&Connection, &DurableMaterializedProjectionV1) -> Result<T>,
    ) -> Result<(BusinessProjectionTransactionResultV1, Option<T>)> {
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure_root_authority(&transaction, self.root_id)?;
        let safety = load_root_safety_from(&transaction, self.root_id)?.ok_or(STORE_CORRUPTION)?;
        if !safety.root_fatal_signals.is_empty() {
            return Err(ROOT_MISMATCH);
        }
        let discovery_generation = database(transaction.query_row(
            "SELECT storage_generation FROM s2_lite_discovery_v1 WHERE root_id=?1",
            [self.root_id],
            |row| row.get::<_, String>(0),
        ))?;
        let projection_row = database(transaction.query_row(
            "SELECT projection_generation, state_json FROM s2_lite_materialized_projection_v1 WHERE root_id=?1",
            [self.root_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
        ))?;
        let (stored_generation, bytes) = projection_row;
        let mut projection: DurableMaterializedProjectionV1 = decode(&bytes)?;
        if canonical_generation(&stored_generation)? != expected_projection_generation
            || projection.projection_generation != expected_projection_generation
            || projection.source_discovery_generation
                != canonical_generation(&discovery_generation)?
            || projection.source_root_safety_generation != safety.generation
        {
            return Err(STORE_CORRUPTION);
        }
        validate_materialized_projection(&projection, self.root_id)?;
        if !matches!(
            projection.state.status,
            super::materialized_projection::MaterializedProjectionStatusV1::Complete
        ) {
            return Err(STORE_CORRUPTION);
        }
        let root_bytes = database(transaction.query_row(
            "SELECT state_json FROM s2_lite_desktop_root_state_v1 WHERE root_id=?1",
            [self.root_id],
            |row| row.get::<_, Vec<u8>>(0),
        ))?;
        let mut root_state: DesktopRootStateV1 = decode(&root_bytes)?;
        validate_desktop_root_state(&root_state, self.root_id)?;
        if root_state.materialized_projection_generation != Some(expected_projection_generation) {
            return Err(STORE_CORRUPTION);
        }
        if root_state.business_applied_projection_generation == Some(expected_projection_generation)
        {
            database(transaction.commit())?;
            return Ok((BusinessProjectionTransactionResultV1::AlreadyApplied, None));
        }
        let output = apply(&transaction, &projection)?;
        root_state.business_applied_projection_generation = Some(expected_projection_generation);
        validate_desktop_root_state(&root_state, self.root_id)?;
        projection.business_projection_applied_generation = Some(expected_projection_generation);
        validate_materialized_projection(&projection, self.root_id)?;
        database(transaction.execute(
            "UPDATE s2_lite_desktop_root_state_v1 SET state_json=?2 WHERE root_id=?1",
            params![self.root_id, encode(&root_state)?],
        ))?;
        database(transaction.execute(
            "UPDATE s2_lite_materialized_projection_v1 SET state_json=?2 WHERE root_id=?1 AND projection_generation=?3",
            params![self.root_id, encode(&projection)?, expected_projection_generation.to_string()],
        ))?;
        database(transaction.commit())?;
        Ok((BusinessProjectionTransactionResultV1::Applied, Some(output)))
    }

    pub fn load_unfinished_outbound_batch(&mut self) -> Result<Option<OutboundBatchV1>> {
        let conn = self.connection()?;
        let bytes = database(
            conn.query_row(
                "SELECT state_json FROM s2_lite_outbound_batch_v1 WHERE root_id=?1",
                [self.root_id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional(),
        )?;
        bytes
            .map(|bytes| {
                let batch: OutboundBatchV1 = decode(&bytes)?;
                validate_outbound_batch(&batch, self.root_id)?;
                if batch.bookkeeping_completed {
                    return Ok(None);
                }
                Ok(Some(batch))
            })
            .transpose()
            .map(Option::flatten)
    }

    /// Binds a local batch and its immutable bytes in one SQLite transaction.
    /// Neither record is externally publishable until this returns successfully.
    pub fn persist_outbound_batch_with_intent(
        &mut self,
        batch: &OutboundBatchV1,
        intent: &PreparedIntentV1,
    ) -> Result<()> {
        validate_outbound_batch(batch, self.root_id)?;
        validate_prepared_intent_v1(intent)?;
        if batch.prepared_intent_path != intent.remote_path
            || batch.prepared_intent_fingerprint != intent.intent_fingerprint
            || batch.writer_id != intent.commit_ref.writer_id
            || batch.writer_sequence.to_string() != intent.commit_ref.writer_seq
        {
            return Err(STORE_CORRUPTION);
        }
        let frozen_commit = decode_frozen_wire_commit_v1(&intent.exact_bytes)?;
        if batch.previous_writer_ref != frozen_commit.previous_writer_commit {
            return Err(STORE_CORRUPTION);
        }
        let mut metadata = intent.clone();
        let exact_bytes = std::mem::take(&mut metadata.exact_bytes);
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure_root_authority(&transaction, self.root_id)?;
        let safety = load_root_safety_from(&transaction, self.root_id)?.ok_or(STORE_CORRUPTION)?;
        if !safety.root_fatal_signals.is_empty() {
            return Err(ProtocolError("ROOT_FROZEN"));
        }
        let existing = database(
            transaction
                .query_row(
                    "SELECT state_json FROM s2_lite_outbound_batch_v1 WHERE root_id=?1",
                    [self.root_id],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional(),
        )?;
        if let Some(bytes) = existing {
            let existing: OutboundBatchV1 = decode(&bytes)?;
            validate_outbound_batch(&existing, self.root_id)?;
            if !existing.bookkeeping_completed {
                return Err(STORE_CORRUPTION);
            }
        }
        persist_intent_parts(
            &transaction,
            self.root_id,
            "commit",
            &intent.remote_path,
            &intent.intent_fingerprint,
            &metadata,
            &exact_bytes,
        )?;
        database(transaction.execute(
            "INSERT INTO s2_lite_outbound_batch_v1(root_id, batch_id, intent_path, intent_fingerprint, state_json)
             VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(root_id) DO UPDATE SET
               batch_id=excluded.batch_id,
               intent_path=excluded.intent_path,
               intent_fingerprint=excluded.intent_fingerprint,
               state_json=excluded.state_json",
            params![
                self.root_id,
                batch.batch_id,
                batch.prepared_intent_path,
                batch.prepared_intent_fingerprint,
                encode(batch)?
            ],
        ))?;
        database(transaction.commit())?;
        Ok(())
    }

    pub fn mark_outbound_batch_bookkeeping_complete(
        &mut self,
        batch: &OutboundBatchV1,
    ) -> Result<()> {
        validate_outbound_batch(batch, self.root_id)?;
        let mut completed = batch.clone();
        completed.bookkeeping_completed = true;
        completed.bookkeeping_generation = completed
            .bookkeeping_generation
            .checked_add(1)
            .ok_or(STORE_CORRUPTION)?;
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let changed = database(transaction.execute(
            "UPDATE s2_lite_outbound_batch_v1 SET state_json=?3
             WHERE root_id=?1 AND batch_id=?2 AND state_json=?4",
            params![
                self.root_id,
                batch.batch_id,
                encode(&completed)?,
                encode(batch)?
            ],
        ))?;
        if changed > 1 {
            return Err(STORE_CORRUPTION);
        }
        database(transaction.commit())?;
        Ok(())
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| STORE_FAILURE)
    }

    fn require_root(&self, root_id: &str) -> Result<()> {
        if root_id != self.root_id {
            return Err(ROOT_MISMATCH);
        }
        Ok(())
    }

    pub fn load_discovery_state(&self) -> Result<Option<VersionedDiscoveryStateV1>> {
        let conn = self.connection()?;
        let row = database(
            conn.query_row(
                "SELECT storage_generation, state_json FROM s2_lite_discovery_v1
                 WHERE root_id=?1",
                [self.root_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional(),
        )?;
        let Some((generation, bytes)) = row else {
            return Ok(None);
        };
        let state: DiscoveryStateV1 = decode(&bytes)?;
        if state.state_version != 1 {
            return Err(STORE_CORRUPTION);
        }
        Ok(Some(VersionedDiscoveryStateV1 {
            storage_generation: canonical_generation(&generation)?,
            state,
        }))
    }

    pub fn compare_and_swap_discovery_state(
        &mut self,
        expected_generation: Option<u64>,
        state: &DiscoveryStateV1,
    ) -> Result<bool> {
        if state.state_version != 1 {
            return Err(STORE_CORRUPTION);
        }
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure_root_authority(&transaction, self.root_id)?;
        let current = database(
            transaction
                .query_row(
                    "SELECT storage_generation FROM s2_lite_discovery_v1 WHERE root_id=?1",
                    [self.root_id],
                    |row| row.get::<_, String>(0),
                )
                .optional(),
        )?
        .map(|value| canonical_generation(&value))
        .transpose()?;
        if current != expected_generation {
            return Ok(false);
        }
        let next = current.map_or(Ok(0), |value| value.checked_add(1).ok_or(STORE_CORRUPTION))?;
        database(transaction.execute(
            "INSERT INTO s2_lite_discovery_v1(root_id, storage_generation, state_json)
             VALUES(?1, ?2, ?3) ON CONFLICT(root_id) DO UPDATE SET
             storage_generation=excluded.storage_generation, state_json=excluded.state_json",
            params![self.root_id, next.to_string(), encode(state)?],
        ))?;
        database(transaction.commit())?;
        Ok(true)
    }

    pub fn compare_and_swap_root_safety(
        &mut self,
        expected_generation: u64,
        requested: &MigrationRootSafetyStateV1,
    ) -> Result<bool> {
        self.require_root(&requested.root_id)?;
        if requested.state_version != 1
            || requested.generation != expected_generation.checked_add(1).ok_or(STORE_CORRUPTION)?
        {
            return Err(STORE_CORRUPTION);
        }
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure_root_authority(&transaction, self.root_id)?;
        let current = load_root_safety_from(&transaction, self.root_id)?.ok_or(STORE_CORRUPTION)?;
        if current.generation != expected_generation {
            return Ok(false);
        }
        let merged_cutover = merge_migration_root_cutover_state_v1(
            &current.cutover_state,
            &requested.cutover_state,
        )?;
        if merged_cutover != requested.cutover_state
            || current.root_fatal_signals.iter().any(|fatal| {
                !requested
                    .root_fatal_signals
                    .iter()
                    .any(|next| next.code == fatal.code)
            })
            || !strictly_sorted_unique(
                requested
                    .root_fatal_signals
                    .iter()
                    .map(|fatal| fatal.code.as_str()),
            )
            || requested
                .cutover_state
                .root_fatal_signals
                .iter()
                .any(|fatal| {
                    !requested
                        .root_fatal_signals
                        .iter()
                        .any(|root_fatal| root_fatal.code == fatal.code)
                })
        {
            return Err(STORE_CORRUPTION);
        }
        save_root_safety(&transaction, requested)?;
        if let Some(mut migration) = load_migration_from(&transaction, self.root_id)? {
            let mut changed = false;
            for fatal in &requested.root_fatal_signals {
                changed |= add_fatal(&mut migration, &fatal.code)?;
            }
            if changed {
                save_migration(&transaction, &migration)?;
            }
        }
        database(transaction.commit())?;
        Ok(true)
    }

    pub fn load_prepared_intent(&self, remote_path: &str) -> Result<Option<PreparedIntentV1>> {
        let conn = self.connection()?;
        load_commit_intent_from(&conn, self.root_id, remote_path)
    }

    pub fn load_published_receipt(
        &self,
        remote_path: &str,
    ) -> Result<Option<RemotePublishedReceiptV1>> {
        let conn = self.connection()?;
        load_commit_receipt_from(&conn, self.root_id, remote_path)
    }

    pub fn load_prepared_activation_intent(
        &self,
        remote_path: &str,
    ) -> Result<Option<PreparedActivationIntentV1>> {
        let conn = self.connection()?;
        load_activation_intent_from(&conn, self.root_id, remote_path)
    }

    pub fn load_published_activation_receipt(
        &self,
        remote_path: &str,
    ) -> Result<Option<PublishedActivationReceiptV1>> {
        let conn = self.connection()?;
        load_activation_receipt_from(&conn, self.root_id, remote_path)
    }

    /// Performs a fresh exact GET against this store's physical root. Only an
    /// exact match can create and persist the private trusted receipt.
    ///
    /// ```compile_fail
    /// use app_lib::s2_lite::durable_persistence::SqliteS2LiteStoreV1;
    /// use app_lib::s2_lite::immutable_publish::RemotePublishedReceiptV1;
    /// fn resign(store: &mut SqliteS2LiteStoreV1<'_>, loaded: RemotePublishedReceiptV1) {
    ///     store.persist_root_bound_receipt(&loaded).unwrap();
    /// }
    /// ```
    pub fn verify_and_persist_commit_receipt<R: ImmutableObjectRemoteV1>(
        &mut self,
        intent: &PreparedIntentV1,
        remote: &mut R,
        verified_at_diagnostic: &str,
    ) -> Result<RecoverPreparedIntentResultV1> {
        if remote.physical_root_id() != Some(self.root_id) {
            return Err(ROOT_MISMATCH);
        }
        let durable = self
            .load_prepared_intent(&intent.remote_path)?
            .ok_or(STORE_CORRUPTION)?;
        if durable != *intent {
            return Err(STORE_CORRUPTION);
        }
        let result = restart_durable_publish_v1(intent, None, remote, verified_at_diagnostic)?;
        if let RecoverPreparedIntentResultV1::AlreadyPublishedExact(receipt) = &result {
            self.persist_root_bound_receipt(&RootBoundPublishedReceiptV1 {
                physical_root_id: self.root_id.to_string(),
                receipt: receipt.clone(),
            })?;
        }
        Ok(result)
    }

    /// Activation equivalent of `verify_and_persist_commit_receipt`.
    ///
    /// ```compile_fail
    /// use app_lib::s2_lite::durable_persistence::SqliteS2LiteStoreV1;
    /// use app_lib::s2_lite::immutable_publish::PublishedActivationReceiptV1;
    /// fn resign(store: &mut SqliteS2LiteStoreV1<'_>, loaded: PublishedActivationReceiptV1) {
    ///     store.persist_root_bound_activation_receipt(&loaded).unwrap();
    /// }
    /// ```
    pub fn verify_and_persist_activation_receipt<R: ImmutableObjectRemoteV1>(
        &mut self,
        intent: &PreparedActivationIntentV1,
        remote: &mut R,
        verified_at_diagnostic: &str,
    ) -> Result<RecoverActivationIntentResultV1> {
        if remote.physical_root_id() != Some(self.root_id) {
            return Err(ROOT_MISMATCH);
        }
        let durable = self
            .load_prepared_activation_intent(&intent.remote_path)?
            .ok_or(STORE_CORRUPTION)?;
        if durable != *intent {
            return Err(STORE_CORRUPTION);
        }
        let result =
            restart_durable_activation_publish_v1(intent, None, remote, verified_at_diagnostic)?;
        if let RecoverActivationIntentResultV1::AlreadyPublishedExact(receipt) = &result {
            self.persist_root_bound_activation_receipt(&RootBoundPublishedActivationReceiptV1 {
                physical_root_id: self.root_id.to_string(),
                receipt: receipt.clone(),
            })?;
        }
        Ok(result)
    }

    fn persist_root_bound_receipt(&mut self, bound: &RootBoundPublishedReceiptV1) -> Result<()> {
        if bound.physical_root_id != self.root_id {
            return Err(ROOT_MISMATCH);
        }
        let receipt = &bound.receipt;
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let intent = load_commit_intent_from(&transaction, self.root_id, &receipt.remote_path)?
            .ok_or(STORE_CORRUPTION)?;
        validate_published_receipt_v1(receipt, &intent)?;
        let persisted = PersistedPublishedReceiptV1 {
            physical_root_id: self.root_id.to_string(),
            receipt: receipt.clone(),
        };
        database(transaction.execute(
            "INSERT INTO s2_lite_published_receipt_v1(
                root_id, receipt_kind, remote_path, receipt_json
             ) VALUES(?1, 'commit', ?2, ?3)
             ON CONFLICT(root_id, receipt_kind, remote_path) DO NOTHING",
            params![self.root_id, receipt.remote_path, encode(&persisted)?],
        ))?;
        let retained = load_commit_receipt_from(&transaction, self.root_id, &receipt.remote_path)?
            .ok_or(STORE_FAILURE)?;
        if retained != *receipt {
            return Err(STORE_CORRUPTION);
        }
        database(transaction.commit())?;
        Ok(())
    }

    fn persist_root_bound_activation_receipt(
        &mut self,
        bound: &RootBoundPublishedActivationReceiptV1,
    ) -> Result<()> {
        if bound.physical_root_id != self.root_id {
            return Err(ROOT_MISMATCH);
        }
        let receipt = &bound.receipt;
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let intent = load_activation_intent_from(&transaction, self.root_id, &receipt.remote_path)?
            .ok_or(STORE_CORRUPTION)?;
        validate_published_activation_receipt_v1(receipt, &intent)?;
        let persisted = PersistedPublishedReceiptV1 {
            physical_root_id: self.root_id.to_string(),
            receipt: receipt.clone(),
        };
        database(transaction.execute(
            "INSERT INTO s2_lite_published_receipt_v1(
                root_id, receipt_kind, remote_path, receipt_json
             ) VALUES(?1, 'activation', ?2, ?3)
             ON CONFLICT(root_id, receipt_kind, remote_path) DO NOTHING",
            params![self.root_id, receipt.remote_path, encode(&persisted)?],
        ))?;
        let retained =
            load_activation_receipt_from(&transaction, self.root_id, &receipt.remote_path)?
                .ok_or(STORE_FAILURE)?;
        if retained != *receipt {
            return Err(STORE_CORRUPTION);
        }
        database(transaction.commit())?;
        Ok(())
    }
}

fn load_intent_parts(
    conn: &Connection,
    root_id: &str,
    kind: &str,
    remote_path: &str,
) -> Result<Option<IntentParts>> {
    database(
        conn.query_row(
            "SELECT intent_fingerprint, metadata_json, exact_bytes
             FROM s2_lite_prepared_intent_v1
             WHERE root_id=?1 AND intent_kind=?2 AND remote_path=?3",
            params![root_id, kind, remote_path],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional(),
    )
}

type IntentParts = (String, Vec<u8>, Vec<u8>);

fn load_commit_intent_from(
    conn: &Connection,
    root_id: &str,
    remote_path: &str,
) -> Result<Option<PreparedIntentV1>> {
    let Some((fingerprint, metadata, exact_bytes)) =
        load_intent_parts(conn, root_id, "commit", remote_path)?
    else {
        return Ok(None);
    };
    let mut intent: PreparedIntentV1 = decode(&metadata)?;
    if !intent.exact_bytes.is_empty() {
        return Err(STORE_CORRUPTION);
    }
    intent.exact_bytes = exact_bytes;
    if intent.remote_path != remote_path
        || intent.intent_fingerprint != fingerprint
        || validate_prepared_intent_v1(&intent).is_err()
    {
        return Err(STORE_CORRUPTION);
    }
    Ok(Some(intent))
}

fn load_activation_intent_from(
    conn: &Connection,
    root_id: &str,
    remote_path: &str,
) -> Result<Option<PreparedActivationIntentV1>> {
    let Some((fingerprint, metadata, exact_bytes)) =
        load_intent_parts(conn, root_id, "activation", remote_path)?
    else {
        return Ok(None);
    };
    let mut intent: PreparedActivationIntentV1 = decode(&metadata)?;
    if !intent.exact_bytes.is_empty() {
        return Err(STORE_CORRUPTION);
    }
    intent.exact_bytes = exact_bytes;
    if intent.remote_path != remote_path
        || intent.intent_fingerprint != fingerprint
        || validate_prepared_activation_intent_v1(&intent).is_err()
    {
        return Err(STORE_CORRUPTION);
    }
    Ok(Some(intent))
}

fn persist_intent_parts<T: Serialize>(
    conn: &Connection,
    root_id: &str,
    kind: &str,
    remote_path: &str,
    fingerprint: &str,
    metadata: &T,
    exact_bytes: &[u8],
) -> Result<()> {
    ensure_root_authority(conn, root_id)?;
    database(conn.execute(
        "INSERT INTO s2_lite_prepared_intent_v1(
            root_id, intent_kind, remote_path, intent_fingerprint, metadata_json, exact_bytes
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(root_id, intent_kind, remote_path) DO NOTHING",
        params![
            root_id,
            kind,
            remote_path,
            fingerprint,
            encode(metadata)?,
            exact_bytes,
        ],
    ))?;
    Ok(())
}

fn load_receipt_bytes(
    conn: &Connection,
    root_id: &str,
    kind: &str,
    remote_path: &str,
) -> Result<Option<Vec<u8>>> {
    database(
        conn.query_row(
            "SELECT receipt_json FROM s2_lite_published_receipt_v1
             WHERE root_id=?1 AND receipt_kind=?2 AND remote_path=?3",
            params![root_id, kind, remote_path],
            |row| row.get(0),
        )
        .optional(),
    )
}

fn load_commit_receipt_from(
    conn: &Connection,
    root_id: &str,
    remote_path: &str,
) -> Result<Option<RemotePublishedReceiptV1>> {
    let Some(bytes) = load_receipt_bytes(conn, root_id, "commit", remote_path)? else {
        return Ok(None);
    };
    let persisted: PersistedPublishedReceiptV1<RemotePublishedReceiptV1> = decode(&bytes)?;
    if persisted.physical_root_id != root_id {
        return Err(ROOT_MISMATCH);
    }
    let receipt = persisted.receipt;
    let intent = load_commit_intent_from(conn, root_id, remote_path)?.ok_or(STORE_CORRUPTION)?;
    validate_published_receipt_v1(&receipt, &intent).map_err(|_| STORE_CORRUPTION)?;
    Ok(Some(receipt))
}

fn load_activation_receipt_from(
    conn: &Connection,
    root_id: &str,
    remote_path: &str,
) -> Result<Option<PublishedActivationReceiptV1>> {
    let Some(bytes) = load_receipt_bytes(conn, root_id, "activation", remote_path)? else {
        return Ok(None);
    };
    let persisted: PersistedPublishedReceiptV1<PublishedActivationReceiptV1> = decode(&bytes)?;
    if persisted.physical_root_id != root_id {
        return Err(ROOT_MISMATCH);
    }
    let receipt = persisted.receipt;
    let intent =
        load_activation_intent_from(conn, root_id, remote_path)?.ok_or(STORE_CORRUPTION)?;
    validate_published_activation_receipt_v1(&receipt, &intent).map_err(|_| STORE_CORRUPTION)?;
    Ok(Some(receipt))
}

impl MigrationStateStoreV1 for SqliteS2LiteStoreV1<'_> {
    fn authority_identity(&self) -> u64 {
        self.conn as *const Mutex<Connection> as usize as u64
    }

    fn claim_or_load(&mut self, candidate: &MigrationStateV1) -> Result<MigrationStateV1> {
        self.require_root(&candidate.root_id)?;
        let reconciled = reconcile_migration_state_v1(candidate)?;
        if reconciled != *candidate {
            return Err(STORE_CORRUPTION);
        }
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure_root_authority(&transaction, self.root_id)?;
        if let Some(existing) = load_migration_from(&transaction, self.root_id)? {
            database(transaction.commit())?;
            return Ok(existing);
        }
        let safety = load_root_safety_from(&transaction, self.root_id)?.ok_or(STORE_CORRUPTION)?;
        let mut claimed = reconciled;
        inherit_root_fatals_on_claim(&mut claimed, &safety.root_fatal_signals)?;
        insert_migration(&transaction, &claimed)?;
        database(transaction.commit())?;
        Ok(claimed)
    }

    fn load(&mut self, root_id: &str) -> Result<Option<MigrationStateV1>> {
        self.require_root(root_id)?;
        let conn = self.connection()?;
        load_migration_from(&conn, root_id)
    }

    fn compare_and_swap(
        &mut self,
        root_id: &str,
        migration_id: &str,
        expected_generation: u64,
        next: &MigrationStateV1,
    ) -> Result<bool> {
        self.require_root(root_id)?;
        let reconciled = reconcile_migration_state_v1(next)?;
        if reconciled != *next {
            return Err(STORE_CORRUPTION);
        }
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let mut safety = load_root_safety_from(&transaction, root_id)?.ok_or(STORE_CORRUPTION)?;
        let current = load_migration_from(&transaction, root_id)?.ok_or(ROOT_MISMATCH)?;
        if current.migration_id != migration_id || current.generation != expected_generation {
            return Ok(false);
        }
        validate_attempt_transition(&current, &reconciled)?;
        if reconciled.generation != expected_generation.checked_add(1).ok_or(STORE_CORRUPTION)? {
            return Err(STORE_CORRUPTION);
        }

        let preserves = |required: &[MigrationRootFatalV1]| {
            required.iter().all(|fatal| {
                reconciled
                    .root_fatal_signals
                    .iter()
                    .any(|next| next.code == fatal.code)
            })
        };
        if (current.status == MigrationStatusV1::RootFrozen
            && reconciled.status != MigrationStatusV1::RootFrozen)
            || !preserves(&current.root_fatal_signals)
            || !preserves(&safety.root_fatal_signals)
            || (reconciled.status == MigrationStatusV1::RootFrozen
                && reconciled.root_fatal_signals.is_empty())
            || (!reconciled.root_fatal_signals.is_empty()
                && reconciled.status != MigrationStatusV1::RootFrozen)
        {
            return Err(STORE_CORRUPTION);
        }

        let mut authoritative_codes = safety
            .root_fatal_signals
            .iter()
            .map(|fatal| fatal.code.clone())
            .chain(
                reconciled
                    .root_fatal_signals
                    .iter()
                    .map(|fatal| fatal.code.clone()),
            )
            .collect::<Vec<_>>();
        authoritative_codes.sort();
        authoritative_codes.dedup();
        let authoritative_fatals = authoritative_codes
            .into_iter()
            .map(|code| MigrationRootFatalV1 { code })
            .collect::<Vec<_>>();
        if safety.root_fatal_signals != authoritative_fatals {
            safety.generation = safety.generation.checked_add(1).ok_or(STORE_CORRUPTION)?;
            safety.root_fatal_signals = authoritative_fatals;
            save_root_safety(&transaction, &safety)?;
        }
        save_migration(&transaction, &reconciled)?;
        database(transaction.commit())?;
        Ok(true)
    }

    fn load_root_safety(&mut self, root_id: &str) -> Result<MigrationRootSafetyStateV1> {
        self.require_root(root_id)?;
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure_root_authority(&transaction, root_id)?;
        let state = load_root_safety_from(&transaction, root_id)?.ok_or(STORE_CORRUPTION)?;
        database(transaction.commit())?;
        Ok(state)
    }

    fn load_cutover_state(&mut self, root_id: &str) -> Result<Option<ActivationCutoverStateV1>> {
        Ok(Some(self.load_root_safety(root_id)?.cutover_state))
    }

    fn persist_cutover_state(
        &mut self,
        root_id: &str,
        incoming: &ActivationCutoverStateV1,
    ) -> Result<()> {
        self.require_root(root_id)?;
        if incoming.state_version != 1 {
            return Err(STORE_CORRUPTION);
        }
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure_root_authority(&transaction, root_id)?;
        let mut safety = load_root_safety_from(&transaction, root_id)?.ok_or(STORE_CORRUPTION)?;
        let merged = merge_migration_root_cutover_state_v1(&safety.cutover_state, incoming)?;
        let mut fatal_codes = safety
            .root_fatal_signals
            .iter()
            .map(|fatal| fatal.code.clone())
            .chain(
                merged
                    .root_fatal_signals
                    .iter()
                    .map(|fatal| fatal.code.clone()),
            )
            .collect::<Vec<_>>();
        fatal_codes.sort();
        fatal_codes.dedup();
        let next_fatals = fatal_codes
            .into_iter()
            .map(|code| MigrationRootFatalV1 { code })
            .collect::<Vec<_>>();
        if safety.cutover_state != merged || safety.root_fatal_signals != next_fatals {
            safety.generation = safety.generation.checked_add(1).ok_or(STORE_CORRUPTION)?;
            safety.cutover_state = merged;
            safety.root_fatal_signals = next_fatals;
            save_root_safety(&transaction, &safety)?;
        }
        if let Some(mut migration) = load_migration_from(&transaction, root_id)? {
            let mut changed = false;
            for fatal in &safety.root_fatal_signals {
                changed |= add_fatal(&mut migration, &fatal.code)?;
            }
            if changed {
                save_migration(&transaction, &migration)?;
            }
        }
        database(transaction.commit())?;
        Ok(())
    }

    fn persist_root_fatal(
        &mut self,
        root_id: &str,
        code: &str,
    ) -> Result<Option<MigrationStateV1>> {
        self.require_root(root_id)?;
        if code.is_empty() {
            return Err(STORE_CORRUPTION);
        }
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        ensure_root_authority(&transaction, root_id)?;
        let mut safety = load_root_safety_from(&transaction, root_id)?.ok_or(STORE_CORRUPTION)?;
        if !safety
            .root_fatal_signals
            .iter()
            .any(|fatal| fatal.code == code)
        {
            safety.generation = safety.generation.checked_add(1).ok_or(STORE_CORRUPTION)?;
            safety.root_fatal_signals.push(MigrationRootFatalV1 {
                code: code.to_string(),
            });
            safety
                .root_fatal_signals
                .sort_by(|left, right| left.code.cmp(&right.code));
            save_root_safety(&transaction, &safety)?;
        }
        let mut migration = load_migration_from(&transaction, root_id)?;
        if let Some(state) = migration.as_mut() {
            if add_fatal(state, code)? {
                save_migration(&transaction, state)?;
            }
        }
        database(transaction.commit())?;
        Ok(migration)
    }

    fn run_publish_exclusive<T, F: FnOnce() -> Result<T>>(
        &mut self,
        root_id: &str,
        migration_id: &str,
        expected_generation: u64,
        operation: F,
    ) -> Result<PublishExclusiveResultV1<T>> {
        self.require_root(root_id)?;
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        let safety = load_root_safety_from(&transaction, root_id)?.ok_or(ROOT_MISMATCH)?;
        let mut migration = load_migration_from(&transaction, root_id)?.ok_or(ROOT_MISMATCH)?;
        let mut changed = false;
        for fatal in &safety.root_fatal_signals {
            changed |= add_fatal(&mut migration, &fatal.code)?;
        }
        if changed {
            save_migration(&transaction, &migration)?;
        }
        if migration.migration_id != migration_id
            || migration.generation != expected_generation
            || migration.status == MigrationStatusV1::RootFrozen
            || !migration.root_fatal_signals.is_empty()
        {
            database(transaction.commit())?;
            return Ok(PublishExclusiveResultV1::Rejected(Box::new(migration)));
        }
        let value = operation()?;
        database(transaction.commit())?;
        Ok(PublishExclusiveResultV1::Executed(value))
    }
}

impl ActivationCutoverStateStoreV1 for SqliteS2LiteStoreV1<'_> {
    fn authority_identity(&self) -> u64 {
        MigrationStateStoreV1::authority_identity(self)
    }

    fn load(&mut self) -> Result<Option<ActivationCutoverStateV1>> {
        MigrationStateStoreV1::load_cutover_state(self, self.root_id)
    }

    fn persist(&mut self, state: &ActivationCutoverStateV1) -> Result<()> {
        let root_id = self.root_id.to_string();
        MigrationStateStoreV1::persist_cutover_state(self, &root_id, state)
    }
}

impl PreparedIntentStoreV1 for SqliteS2LiteStoreV1<'_> {
    fn persist(&mut self, intent: &PreparedIntentV1) -> Result<()> {
        validate_prepared_intent_v1(intent)?;
        let mut metadata = intent.clone();
        let exact_bytes = std::mem::take(&mut metadata.exact_bytes);
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        persist_intent_parts(
            &transaction,
            self.root_id,
            "commit",
            &intent.remote_path,
            &intent.intent_fingerprint,
            &metadata,
            &exact_bytes,
        )?;
        let retained = load_commit_intent_from(&transaction, self.root_id, &intent.remote_path)?
            .ok_or(STORE_FAILURE)?;
        if retained != *intent {
            return Err(STORE_CORRUPTION);
        }
        database(transaction.commit())?;
        Ok(())
    }
}

impl PreparedActivationIntentStoreV1 for SqliteS2LiteStoreV1<'_> {
    fn persist(&mut self, intent: &PreparedActivationIntentV1) -> Result<()> {
        validate_prepared_activation_intent_v1(intent)?;
        let mut metadata = intent.clone();
        let exact_bytes = std::mem::take(&mut metadata.exact_bytes);
        let mut conn = self.connection()?;
        let transaction = database(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        persist_intent_parts(
            &transaction,
            self.root_id,
            "activation",
            &intent.remote_path,
            &intent.intent_fingerprint,
            &metadata,
            &exact_bytes,
        )?;
        let retained =
            load_activation_intent_from(&transaction, self.root_id, &intent.remote_path)?
                .ok_or(STORE_FAILURE)?;
        if retained != *intent {
            return Err(STORE_CORRUPTION);
        }
        database(transaction.commit())?;
        Ok(())
    }
}

pub fn persistence_schema_version(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM settings WHERE key='s2_lite_persistence_schema_version'",
        [],
        |row| row.get(0),
    )
    .optional()
}

pub const S2_LITE_PERSISTENCE_SCHEMA_VERSION: &str = SCHEMA_VERSION;
