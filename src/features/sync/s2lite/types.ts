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
