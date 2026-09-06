import {
  canonicalJcsBytes,
  canonicalizeJcs,
  compareCommitDotV1,
  compareCommitRefV1,
  compareEntityKeyV1,
  sha256Hex,
  S2ProtocolValidationError,
  validateCommitRef,
  validateEntityKey,
  validateSafeInteger,
} from './canonical.ts';
import { BUSINESS_FIELD_ORDER } from './semanticProfile.ts';
import type {
  CanonicalSemanticState,
  CommitDot,
  CommitRef,
  EntityConflictAlternativeInput,
  EntityConflictCore,
  EntityConflictKind,
  EntityKey,
  JsonValue,
  RelationConflictCore,
  RelationConflictKind,
  RelationParticipant,
  SemanticRelationFacts,
} from './types.ts';

function invalid(code: string): never {
  throw new S2ProtocolValidationError(code);
}

function dotOf(ref: CommitRef): CommitDot {
  return { writerId: ref.writerId, writerSeq: ref.writerSeq, commitId: ref.commitId };
}

function sameDot(a: CommitDot, b: CommitDot): boolean {
  return compareCommitDotV1(a, b) === 0;
}

function validateSemanticState(entityKey: EntityKey, state: CanonicalSemanticState): void {
  const value = state as unknown as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(',');
  if (value.state === 'tombstone') {
    if (keys !== 'state') invalid('invalid_semantic_state');
    return;
  }
  if (value.state !== 'live' || keys !== 'state,value'
    || value.value === null || typeof value.value !== 'object' || Array.isArray(value.value)) {
    invalid('invalid_semantic_state');
  }
  const actualFields = Object.keys(value.value as Record<string, unknown>).sort();
  const expectedFields = [...BUSINESS_FIELD_ORDER[entityKey[0]]].sort();
  if (actualFields.length !== expectedFields.length
    || actualFields.some((field, index) => field !== expectedFields[index])) {
    invalid('invalid_semantic_state');
  }
  canonicalJcsBytes(value.value as JsonValue);
}

function semanticValueAt(state: CanonicalSemanticState, field: string): JsonValue | undefined {
  return state.state === 'live' ? state.value[field] : undefined;
}

function differentLiveField(alternatives: readonly EntityConflictAlternativeInput[], field: string): boolean {
  const live = alternatives.filter(alternative => alternative.semanticState.state === 'live');
  if (live.length < 2) return false;
  const first = canonicalizeJcs(semanticValueAt(live[0]!.semanticState, field) as JsonValue);
  return live.slice(1).some(alternative => (
    canonicalizeJcs(semanticValueAt(alternative.semanticState, field) as JsonValue) !== first
  ));
}

export function conflictFieldsV1(
  entityKey: EntityKey,
  conflictKind: EntityConflictKind,
  alternatives: readonly EntityConflictAlternativeInput[],
): string[] {
  if (conflictKind === 'live-tombstone') return ['$existence'];
  if (conflictKind === 'different-base') return ['$base'];
  if (conflictKind === 'derived-domain') return ['$domain'];
  const fieldOrder = BUSINESS_FIELD_ORDER[entityKey[0]];
  if (conflictKind === 'locked-concurrent') {
    if (entityKey[0] !== 'record') invalid('locked_conflict_requires_record');
    return ['isLocked', ...fieldOrder.filter(field => field !== 'isLocked' && differentLiveField(alternatives, field))];
  }
  const counts = new Map<string, number>();
  for (const alternative of alternatives) {
    for (const field of new Set(alternative.changedFields)) counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  return fieldOrder.filter(field => (counts.get(field) ?? 0) >= 2);
}

export function buildEntityConflictCoreV1(
  entityKey: EntityKey,
  conflictKind: EntityConflictKind,
  inputAlternatives: readonly EntityConflictAlternativeInput[],
): EntityConflictCore {
  validateEntityKey(entityKey);
  if (inputAlternatives.length < 2) invalid('conflict_requires_multiple_alternatives');
  const alternatives = [...inputAlternatives];
  alternatives.forEach(alternative => {
    validateCommitRef(alternative.ref);
    validateSemanticState(entityKey, alternative.semanticState);
    alternative.baseFrontier.forEach(validateCommitRef);
  });
  alternatives.sort((a, b) => compareCommitDotV1(a.ref, b.ref));
  for (let index = 1; index < alternatives.length; index += 1) {
    if (sameDot(alternatives[index - 1]!.ref, alternatives[index]!.ref)) invalid('duplicate_or_forked_dot');
  }
  const frontierDots = alternatives.map(alternative => dotOf(alternative.ref));
  return {
    domain: 'watchtracker-s2-lite-entity-conflict-v1',
    entityKey,
    conflictKind,
    frontierDots,
    conflictFields: conflictFieldsV1(entityKey, conflictKind, alternatives),
    semanticAlternatives: alternatives.map((alternative, index) => ({
      dot: frontierDots[index]!,
      semanticState: alternative.semanticState,
    })),
  };
}

export async function entityConflictIdV1(core: EntityConflictCore): Promise<string> {
  return sha256Hex(canonicalJcsBytes(core as unknown as JsonValue));
}

function exactRefKey(ref: CommitRef): string {
  return `${ref.writerId}\0${ref.writerSeq}\0${ref.commitId}\0${ref.contentHash}`;
}

function validateRelationFacts(kind: RelationConflictKind, input: SemanticRelationFacts): void {
  const facts = input as unknown as Record<string, unknown>;
  const keys = Object.keys(facts).sort().join(',');
  if (kind === 'collection-deleted-member-live') {
    if (keys !== 'collectionId,collectionState,memberState,recordId'
      || facts.collectionState !== 'tombstone' || facts.memberState !== 'live') invalid('invalid_relation_facts');
  } else if (kind === 'record-deleted-member-live') {
    if (keys !== 'collectionId,memberState,recordId,recordState'
      || facts.recordState !== 'tombstone' || facts.memberState !== 'live') invalid('invalid_relation_facts');
  } else if (kind === 'record-deleted-episode-live') {
    if (keys !== 'episodeNumber,episodeState,recordId,recordState'
      || facts.recordState !== 'tombstone' || facts.episodeState !== 'live') invalid('invalid_relation_facts');
    validateSafeInteger(facts.episodeNumber, 1, 2_147_483_647);
  } else {
    if (keys !== 'episodeNumber,recordId,totalEpisodes') invalid('invalid_relation_facts');
    validateSafeInteger(facts.episodeNumber, 1, 2_147_483_647);
    validateSafeInteger(facts.totalEpisodes, 1, 2_147_483_647);
    if ((facts.episodeNumber as number) <= (facts.totalEpisodes as number)) invalid('relation_not_conflicting');
  }
  if (typeof facts.recordId !== 'string') invalid('invalid_relation_facts');
  if ('collectionId' in facts && typeof facts.collectionId !== 'string') invalid('invalid_relation_facts');
}

function expectedRelationEntityKeys(
  kind: RelationConflictKind,
  facts: SemanticRelationFacts,
): EntityKey[] {
  const relation = facts as unknown as Record<string, string | number>;
  if (kind === 'collection-deleted-member-live') {
    return [
      ['collection', relation.collectionId as string],
      ['collection-member', relation.collectionId as string, relation.recordId as string],
    ];
  }
  if (kind === 'record-deleted-member-live') {
    return [
      ['record', relation.recordId as string],
      ['collection-member', relation.collectionId as string, relation.recordId as string],
    ];
  }
  return [
    ['record', relation.recordId as string],
    ['episode-completion', relation.recordId as string, relation.episodeNumber as number],
  ];
}

export function buildRelationConflictCoreV1(
  relationKind: RelationConflictKind,
  semanticRelationFacts: SemanticRelationFacts,
  participants: readonly RelationParticipant[],
): RelationConflictCore {
  if (participants.length !== 2) invalid('invalid_relation_participants');
  participants.forEach(participant => validateEntityKey(participant.entityKey));
  validateRelationFacts(relationKind, semanticRelationFacts);
  const entityKeys = participants.map(participant => participant.entityKey).sort(compareEntityKeyV1);
  if (compareEntityKeyV1(entityKeys[0]!, entityKeys[1]!) === 0) invalid('invalid_relation_participants');
  const expectedKeys = expectedRelationEntityKeys(relationKind, semanticRelationFacts).sort(compareEntityKeyV1);
  if (entityKeys.some((key, index) => compareEntityKeyV1(key, expectedKeys[index]!) !== 0)) {
    invalid('invalid_relation_participants');
  }
  const refs = new Map<string, CommitRef>();
  for (const participant of participants) {
    if (participant.provenanceFrontier.length === 0) invalid('empty_relation_provenance');
    for (const ref of participant.provenanceFrontier) {
      validateCommitRef(ref);
      refs.set(exactRefKey(ref), ref);
    }
  }
  const versionRefs = [...refs.values()].sort(compareCommitRefV1);
  return {
    domain: 'watchtracker-s2-lite-relation-conflict-v1',
    relationKind,
    entityKeys,
    versionRefs,
    semanticRelationFacts,
  };
}

export async function relationConflictIdV1(core: RelationConflictCore): Promise<string> {
  return sha256Hex(canonicalJcsBytes(core as unknown as JsonValue));
}

export const CANONICAL_TOMBSTONE_STATE = Object.freeze({ state: 'tombstone' } as const);
