use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type EntityKey = Value;
pub type WriterSeqDecimalString = String;
pub type Int64DecimalString = String;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitDot {
    pub writer_id: String,
    pub writer_seq: WriterSeqDecimalString,
    pub commit_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRef {
    pub writer_id: String,
    pub writer_seq: WriterSeqDecimalString,
    pub commit_id: String,
    pub content_hash: String,
}

impl CommitRef {
    pub fn dot(&self) -> CommitDot {
        CommitDot {
            writer_id: self.writer_id.clone(),
            writer_seq: self.writer_seq.clone(),
            commit_id: self.commit_id.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntityConflictKind {
    LiveTombstone,
    LockedConcurrent,
    DifferentBase,
    OverlappingField,
    DerivedDomain,
}

impl EntityConflictKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LiveTombstone => "live-tombstone",
            Self::LockedConcurrent => "locked-concurrent",
            Self::DifferentBase => "different-base",
            Self::OverlappingField => "overlapping-field",
            Self::DerivedDomain => "derived-domain",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "live-tombstone" => Some(Self::LiveTombstone),
            "locked-concurrent" => Some(Self::LockedConcurrent),
            "different-base" => Some(Self::DifferentBase),
            "overlapping-field" => Some(Self::OverlappingField),
            "derived-domain" => Some(Self::DerivedDomain),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct EntityConflictAlternativeInput {
    pub commit_ref: CommitRef,
    pub semantic_state: Value,
    pub changed_fields: Vec<String>,
    pub base_frontier: Vec<CommitRef>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticAlternative {
    pub dot: CommitDot,
    pub semantic_state: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityConflictCore {
    pub domain: &'static str,
    pub entity_key: EntityKey,
    pub conflict_kind: &'static str,
    pub frontier_dots: Vec<CommitDot>,
    pub conflict_fields: Vec<String>,
    pub semantic_alternatives: Vec<SemanticAlternative>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RelationConflictKind {
    CollectionDeletedMemberLive,
    RecordDeletedMemberLive,
    RecordDeletedEpisodeLive,
    EpisodeExceedsTotal,
}

impl RelationConflictKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CollectionDeletedMemberLive => "collection-deleted-member-live",
            Self::RecordDeletedMemberLive => "record-deleted-member-live",
            Self::RecordDeletedEpisodeLive => "record-deleted-episode-live",
            Self::EpisodeExceedsTotal => "episode-exceeds-total",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "collection-deleted-member-live" => Some(Self::CollectionDeletedMemberLive),
            "record-deleted-member-live" => Some(Self::RecordDeletedMemberLive),
            "record-deleted-episode-live" => Some(Self::RecordDeletedEpisodeLive),
            "episode-exceeds-total" => Some(Self::EpisodeExceedsTotal),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RelationParticipant {
    pub entity_key: EntityKey,
    pub provenance_frontier: Vec<CommitRef>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationConflictCore {
    pub domain: &'static str,
    pub relation_kind: &'static str,
    pub entity_keys: Vec<EntityKey>,
    pub version_refs: Vec<CommitRef>,
    pub semantic_relation_facts: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapEntity {
    pub entity_type: String,
    pub entity_key: EntityKey,
    pub value: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BootstrapPlan {
    pub stage_a_ordered_mutations: Vec<BootstrapEntity>,
    pub stage_a_chunks: Vec<Vec<BootstrapEntity>>,
    pub stage_b_ordered_mutations: Vec<BootstrapEntity>,
    pub stage_b_chunks: Vec<Vec<BootstrapEntity>>,
}

pub trait LegacySemanticAdapterV1 {
    fn adapt_live_entity(
        &self,
        entity_type: &str,
        legacy_value: &Value,
    ) -> std::result::Result<BootstrapEntity, String>;
}
