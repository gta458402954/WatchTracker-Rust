export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

declare const writerSeqBrand: unique symbol;
declare const int64DecimalBrand: unique symbol;
export type WriterSeqDecimalString = string & { readonly [writerSeqBrand]: true };
export type Int64DecimalString = string & { readonly [int64DecimalBrand]: true };

export type EntityType = 'record' | 'episode-completion' | 'collection' | 'collection-member';
export type EntityKey =
  | readonly ['record', string]
  | readonly ['episode-completion', string, number]
  | readonly ['collection', string]
  | readonly ['collection-member', string, string];

export interface CommitDot {
  writerId: string;
  writerSeq: WriterSeqDecimalString;
  commitId: string;
}

export interface CommitRef extends CommitDot {
  contentHash: string;
}

export type CanonicalSemanticState =
  | { state: 'live'; value: { [key: string]: JsonValue } }
  | { state: 'tombstone' };

export type EntityConflictKind =
  | 'live-tombstone'
  | 'locked-concurrent'
  | 'different-base'
  | 'overlapping-field'
  | 'derived-domain';

export interface EntityConflictAlternativeInput {
  ref: CommitRef;
  semanticState: CanonicalSemanticState;
  changedFields: readonly string[];
  baseFrontier: readonly CommitRef[];
}

export interface EntityConflictCore {
  domain: 'watchtracker-s2-lite-entity-conflict-v1';
  entityKey: EntityKey;
  conflictKind: EntityConflictKind;
  frontierDots: CommitDot[];
  conflictFields: string[];
  semanticAlternatives: Array<{
    dot: CommitDot;
    semanticState: CanonicalSemanticState;
  }>;
}

export type RelationConflictKind =
  | 'collection-deleted-member-live'
  | 'record-deleted-member-live'
  | 'record-deleted-episode-live'
  | 'episode-exceeds-total';

export type SemanticRelationFacts =
  | {
    collectionId: string;
    recordId: string;
    collectionState: 'tombstone';
    memberState: 'live';
  }
  | {
    collectionId: string;
    recordId: string;
    recordState: 'tombstone';
    memberState: 'live';
  }
  | {
    recordId: string;
    episodeNumber: number;
    recordState: 'tombstone';
    episodeState: 'live';
  }
  | {
    recordId: string;
    episodeNumber: number;
    totalEpisodes: number;
  };

export interface RelationParticipant {
  entityKey: EntityKey;
  provenanceFrontier: readonly CommitRef[];
}

export interface RelationConflictCore {
  domain: 'watchtracker-s2-lite-relation-conflict-v1';
  relationKind: RelationConflictKind;
  entityKeys: EntityKey[];
  versionRefs: CommitRef[];
  semanticRelationFacts: SemanticRelationFacts;
}

export interface BootstrapEntity {
  entityType: EntityType;
  entityKey: EntityKey;
  value: { [key: string]: JsonValue };
}

export interface BootstrapPlan {
  stageAOrderedMutations: BootstrapEntity[];
  stageAChunks: BootstrapEntity[][];
  stageBOrderedMutations: BootstrapEntity[];
  stageBChunks: BootstrapEntity[][];
}

export interface LegacySemanticAdapterV1 {
  adaptLiveEntity(entityType: EntityType, legacyValue: unknown): Promise<BootstrapEntity>;
}

export type CommitKind = 'mutation' | 'resolution' | 'bootstrap';
export type MutationOperation = 'upsert' | 'tombstone';

export interface CommitMutationV1 {
  localMutationId: string;
  entityType: EntityType;
  entityKey: EntityKey;
  operation: MutationOperation;
  value: { [key: string]: JsonValue };
  baseFrontier: CommitRef[];
  changedFields: string[];
}

export interface CommitSourceV1 {
  type: 'native' | 'manual-resolution' | 'legacy-bootstrap' | 'new-root-bootstrap';
}

export interface CommitV1 {
  protocol: 'watchtracker-s2-lite';
  protocolVersion: 1;
  s2SemanticProfileVersion: 1;
  requiredFeatures: string[];
  writerId: string;
  writerSeq: WriterSeqDecimalString;
  commitId: string;
  contentHash: string;
  previousWriterCommit: CommitRef | null;
  basisClock: CommitRef[];
  commitKind: CommitKind;
  createdAt: string;
  source: CommitSourceV1;
  resolves: string[];
  mutations: CommitMutationV1[];
}

export type HistoricalValidityState = 'PENDING' | 'VALID' | 'INVALID';

export interface HistoricalValidity {
  state: HistoricalValidityState;
  error?: string;
}

export interface EntityVersionV1 {
  entityKey: EntityKey;
  operation: MutationOperation;
  fullValue: { [key: string]: JsonValue };
  semanticState: CanonicalSemanticState;
  canonicalSemanticValue: { [key: string]: JsonValue } | null;
  changedFields: string[];
  baseFrontier: CommitRef[];
  commitRef: CommitRef;
  commitDot: CommitDot;
  causalBasis: CommitRef[];
}

export interface MetadataVariantV1 {
  commitRef: CommitRef;
  metadata: { [key: string]: JsonValue };
}

export type MaterializedEntityV1 =
  | { state: 'Absent' }
  | {
    state: 'Resolved';
    semanticState: CanonicalSemanticState;
    businessValue: { [key: string]: JsonValue } | null;
    provenanceFrontier: CommitRef[];
    metadataVariants: MetadataVariantV1[];
  }
  | {
    state: 'Conflict';
    conflictId: string;
    conflictKind: EntityConflictKind;
    entityKey: EntityKey;
    frontier: CommitRef[];
    conflictFields: string[];
    semanticAlternatives: EntityConflictCore['semanticAlternatives'];
  };

export interface WriterForkV1 {
  writerId: string;
  writerSeq: WriterSeqDecimalString;
  alternatives: CommitRef[];
  safeWriterFrontier: WriterSeqDecimalString;
}

export interface RelationConflictV1 {
  relationConflictId: string;
  core: RelationConflictCore;
}

export interface RelationDetectionV1 {
  conflicts: RelationConflictV1[];
  blockedByEntityConflict: EntityKey[];
}

export interface DuplicateDiagnosticV1 {
  kind:
    | 'duplicate-collection-normalized-name'
    | 'duplicate-collection-source'
    | 'duplicate-record-external-identity';
  value: JsonValue;
  entityKeys: EntityKey[];
}

export interface VerifiedReplayV1 {
  validity: Array<{ commitRef: CommitRef; validity: HistoricalValidity }>;
  forks: WriterForkV1[];
  unsafeCommitRefs: CommitRef[];
  forensicVersions: EntityVersionV1[];
  versions: EntityVersionV1[];
  frontiers: Array<{ entityKey: EntityKey; frontier: CommitRef[] }>;
  materialized: Array<{ entityKey: EntityKey; value: MaterializedEntityV1 }>;
  relations: RelationDetectionV1;
  duplicateDiagnostics: DuplicateDiagnosticV1[];
}
