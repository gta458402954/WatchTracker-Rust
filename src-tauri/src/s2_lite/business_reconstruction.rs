//! Local typed-row adapter over frozen semantic payload + replay metadata.
//! Neither the semantic value nor any wire/projection input hash is rewritten.

use serde_json::Value;

use super::{
    canonical::{
        compare_commit_ref_v1, parse_int64_decimal, validate_commit_ref, ProtocolError, Result,
    },
    materialized_projection::MaterializedProjectionEntityV1,
    semantic::validate_native_entity,
};

const INVALID: ProtocolError = ProtocolError("projector_verified_evidence_invalid");

/// Construct a *local adapter value*, never a replacement frozen businessValue.
/// Identical semantic frontiers can have multiple diagnostic metadata variants.
/// Use one coherent verified variant in canonical CommitRef order for local row
/// metadata; keep every variant in the cache. This does not select a semantic
/// winner, resolve a conflict, or add metadata to a causal semantic basis.
pub(crate) fn reconstruct_local_business_value_v1(
    entity: &MaterializedProjectionEntityV1,
) -> Result<Value> {
    let semantic = entity.business_value.as_ref().ok_or(INVALID)?;
    if entity.conflict
        || entity
            .semantic_state
            .as_ref()
            .and_then(|state| state.get("state"))
            .and_then(Value::as_str)
            != Some("live")
        || entity
            .semantic_state
            .as_ref()
            .and_then(|state| state.get("value"))
            != Some(semantic)
        || entity.metadata_variants.is_empty()
    {
        return Err(INVALID);
    }
    // The frozen comparator assumes validated references. Reject malformed
    // durable evidence before sorting, rather than panicking inside it.
    if entity
        .frontier
        .iter()
        .chain(
            entity
                .metadata_variants
                .iter()
                .map(|variant| &variant.commit_ref),
        )
        .any(|reference| validate_commit_ref(reference).is_err())
    {
        return Err(INVALID);
    }
    let mut variants = entity.metadata_variants.iter().collect::<Vec<_>>();
    variants.sort_by(|a, b| compare_commit_ref_v1(&a.commit_ref, &b.commit_ref));
    let mut frontier = entity.frontier.iter().collect::<Vec<_>>();
    frontier.sort_by(|a, b| compare_commit_ref_v1(a, b));
    if frontier.len() != variants.len()
        || frontier
            .iter()
            .zip(&variants)
            .any(|(reference, variant)| **reference != variant.commit_ref)
        || frontier.windows(2).any(|pair| pair[0] == pair[1])
    {
        return Err(INVALID);
    }
    let mut selected = None;
    for variant in variants {
        let mut full = semantic.as_object().ok_or(INVALID)?.clone();
        let metadata = variant.metadata.as_object().ok_or(INVALID)?;
        if metadata.len() != 5
            || ["id", "createdAt", "updatedAt", "rev", "revActor"]
                .iter()
                .any(|field| !metadata.contains_key(*field))
        {
            return Err(INVALID);
        }
        for (field, value) in metadata {
            if full.insert(field.clone(), value.clone()).is_some() {
                return Err(INVALID);
            }
        }
        let full = Value::Object(full);
        // All variants must be valid for this exact key + semantic payload;
        // an invalid later variant cannot be hidden by the representative.
        validate_native_entity(&entity.entity_key, &full).map_err(|_| INVALID)?;
        if selected.is_none() {
            selected = Some(full);
        }
    }
    let mut local = selected.ok_or(INVALID)?;
    // Frozen INT64s are decimal strings. The SQLite model stores i64s; parse
    // exactly, without a floating point intermediate or defaulting metadata.
    for field in ["rev", "position", "tmdbId", "tmdbParentId"] {
        if let Some(value) = local.get_mut(field) {
            if !value.is_null() {
                let integer = parse_int64_decimal(value.as_str().ok_or(INVALID)?, 0, i64::MAX)
                    .map_err(|_| INVALID)?;
                *value = Value::from(integer);
            }
        }
    }
    Ok(local)
}
