import {
  canonicalizeJcs,
  compareEntityKeyV1,
  S2ProtocolValidationError,
  validateCanonicalUuidV4,
  validateCommitRef,
} from './canonical.ts';
import {
  BUSINESS_FIELD_ORDER,
  canonicalSemanticValue,
  validateNativeEntity,
  validateNativeTombstone,
} from './semanticProfile.ts';
import type { CommitMutationV1, CommitRef, EntityKey, EntityType, JsonValue } from './types.ts';

export interface LocalRecordV1 {
  id: string; originalName: string; chineseName: string; progress: string;
  totalEpisodes: number | null; episodeTrackingEnabled: boolean; nextEpisode: number | null;
  movieProgress: number | null; movieDuration: number | null; releaseYear: string | null;
  posterPath: string | null; status: string; platform: string; rating: number | null;
  startDate: string | null; endDate: string | null; notes: string; createdAt: string;
  updatedAt: string | null; imdbId: string | null; isLocked: boolean | null;
  genres: string | null; originCountry: string | null; imdbRating: number | null;
  tmdbStatus: string | null; interestLevel: number | null; episodeRuntime: number | null;
  mediaType: string; contentTags: string | null; tmdbMediaKind: string | null;
  tmdbId: bigint | null; tmdbParentId: bigint | null; tmdbSeasonNumber: number | null;
  seriesRecordKind: string | null; rev: bigint; revActor: string;
}

export interface LocalCollectionV1 {
  id: string; name: string; normalizedName: string; description: string | null;
  sourceKind: string; sourceKey: string | null; collectionKind: string; orderMode: string;
  createdAt: string; updatedAt: string; rev: bigint; revActor: string;
}

export interface LocalCollectionMemberV1 {
  id: string; collectionId: string; recordId: string; position: bigint; sourceKind: string;
  createdAt: string; updatedAt: string; rev: bigint; revActor: string;
}

export interface LocalEpisodeCompletionV1 {
  id: string; recordId: string; episodeNumber: number; completedAt: string | null;
  createdAt: string; updatedAt: string; rev: bigint; revActor: string;
}

export type LocalEntityValueV1 =
  | { entityType: 'record'; value: LocalRecordV1 }
  | { entityType: 'collection'; value: LocalCollectionV1 }
  | { entityType: 'collection-member'; value: LocalCollectionMemberV1 }
  | { entityType: 'episode-completion'; value: LocalEpisodeCompletionV1 };

type SimpleDeleteDescriptorV1 = Readonly<{
  id: string; deletedAt: string; rev: bigint; revActor: string;
}>;

export type DeleteDescriptorV1 =
  | ({ entityType: 'record' } & SimpleDeleteDescriptorV1)
  | ({ entityType: 'collection' } & SimpleDeleteDescriptorV1)
  | ({ entityType: 'collection-member'; collectionId: string; recordId: string } & SimpleDeleteDescriptorV1)
  | ({ entityType: 'episode-completion'; recordId: string; episodeNumber: number } & SimpleDeleteDescriptorV1);

export type OrdinaryPayloadV1 =
  | { operation: 'upsert'; entity: LocalEntityValueV1 }
  | { operation: 'tombstone'; deleteDescriptor: DeleteDescriptorV1 };

/** `value` is the business-only CanonicalSemanticValue emitted by the reducer. */
export type OrdinaryCausalBaseV1 =
  | { state: 'absent' }
  | { state: 'tombstone' }
  | { state: 'live'; value: { [key: string]: JsonValue } };

export interface OrdinaryMutationRequestV1 {
  localMutationId: string;
  payload: OrdinaryPayloadV1;
  causalBase: OrdinaryCausalBaseV1;
  baseFrontier: CommitRef[];
}

function invalid(code: string): never {
  throw new S2ProtocolValidationError(code);
}

function decimal(value: bigint): string {
  return value.toString(10);
}

function optionalFiniteFloat64(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return invalid('invalid_float64');
  return value;
}

function recordWire(value: LocalRecordV1): { [key: string]: JsonValue } {
  return {
    id: value.id, originalName: value.originalName, chineseName: value.chineseName,
    progress: value.progress, totalEpisodes: value.totalEpisodes,
    episodeTrackingEnabled: value.episodeTrackingEnabled, nextEpisode: value.nextEpisode,
    movieProgress: value.movieProgress, movieDuration: value.movieDuration,
    releaseYear: value.releaseYear, posterPath: value.posterPath, status: value.status,
    platform: value.platform, rating: value.rating, startDate: value.startDate,
    endDate: value.endDate, notes: value.notes, createdAt: value.createdAt,
    updatedAt: value.updatedAt, imdbId: value.imdbId, isLocked: value.isLocked,
    genres: value.genres, originCountry: value.originCountry,
    imdbRating: optionalFiniteFloat64(value.imdbRating),
    tmdbStatus: value.tmdbStatus, interestLevel: value.interestLevel,
    episodeRuntime: value.episodeRuntime, mediaType: value.mediaType,
    contentTags: value.contentTags, tmdbMediaKind: value.tmdbMediaKind,
    tmdbId: value.tmdbId === null ? null : decimal(value.tmdbId),
    tmdbParentId: value.tmdbParentId === null ? null : decimal(value.tmdbParentId),
    tmdbSeasonNumber: value.tmdbSeasonNumber, seriesRecordKind: value.seriesRecordKind,
    rev: decimal(value.rev), revActor: value.revActor,
  };
}

function entityKey(entity: LocalEntityValueV1): EntityKey {
  switch (entity.entityType) {
    case 'record': return ['record', entity.value.id];
    case 'collection': return ['collection', entity.value.id];
    case 'collection-member': return ['collection-member', entity.value.collectionId, entity.value.recordId];
    case 'episode-completion': return ['episode-completion', entity.value.recordId, entity.value.episodeNumber];
  }
}

function entityWire(entity: LocalEntityValueV1): { [key: string]: JsonValue } {
  switch (entity.entityType) {
    case 'record': return recordWire(entity.value);
    case 'collection': return {
      id: entity.value.id, name: entity.value.name, normalizedName: entity.value.normalizedName,
      description: entity.value.description, sourceKind: entity.value.sourceKind, sourceKey: entity.value.sourceKey,
      collectionKind: entity.value.collectionKind, orderMode: entity.value.orderMode,
      createdAt: entity.value.createdAt, updatedAt: entity.value.updatedAt,
      rev: decimal(entity.value.rev), revActor: entity.value.revActor,
    };
    case 'collection-member': return {
      id: entity.value.id, collectionId: entity.value.collectionId, recordId: entity.value.recordId,
      position: decimal(entity.value.position), sourceKind: entity.value.sourceKind,
      createdAt: entity.value.createdAt, updatedAt: entity.value.updatedAt,
      rev: decimal(entity.value.rev), revActor: entity.value.revActor,
    };
    case 'episode-completion': return {
      id: entity.value.id, recordId: entity.value.recordId, episodeNumber: entity.value.episodeNumber,
      completedAt: entity.value.completedAt, createdAt: entity.value.createdAt,
      updatedAt: entity.value.updatedAt, rev: decimal(entity.value.rev), revActor: entity.value.revActor,
    };
  }
}

function deleteKey(value: DeleteDescriptorV1): EntityKey {
  switch (value.entityType) {
    case 'record': return ['record', value.id];
    case 'collection': return ['collection', value.id];
    case 'collection-member': return ['collection-member', value.collectionId, value.recordId];
    case 'episode-completion': return ['episode-completion', value.recordId, value.episodeNumber];
  }
}

function deleteWire(value: DeleteDescriptorV1): { [key: string]: JsonValue } {
  const common = { id: value.id, deletedAt: value.deletedAt, rev: decimal(value.rev), revActor: value.revActor };
  switch (value.entityType) {
    case 'record':
    case 'collection': return common;
    case 'collection-member': return { id: value.id, collectionId: value.collectionId, recordId: value.recordId,
      deletedAt: value.deletedAt, rev: decimal(value.rev), revActor: value.revActor };
    case 'episode-completion': return { id: value.id, recordId: value.recordId, episodeNumber: value.episodeNumber,
      deletedAt: value.deletedAt, rev: decimal(value.rev), revActor: value.revActor };
  }
}

function payloadKey(payload: OrdinaryPayloadV1): EntityKey {
  return payload.operation === 'upsert' ? entityKey(payload.entity) : deleteKey(payload.deleteDescriptor);
}

function changedFields(
  entityType: EntityType,
  next: { [key: string]: JsonValue },
  base: OrdinaryCausalBaseV1,
): string[] {
  const order = BUSINESS_FIELD_ORDER[entityType];
  if (base.state !== 'live') return [...order];
  const fields = Object.keys(base.value);
  if (fields.length !== order.length || order.some(field => !Object.hasOwn(base.value, field))) {
    return invalid('invalid_ordinary_causal_base');
  }
  return order.filter(field => canonicalizeJcs(base.value[field]!) !== canonicalizeJcs(next[field]!));
}

/** Maps one already-coalesced change. `null` is the required metadata-only/no-op result. */
export async function mapOrdinaryMutationV1(
  request: Readonly<OrdinaryMutationRequestV1>,
): Promise<CommitMutationV1 | null> {
  validateCanonicalUuidV4(request.localMutationId);
  for (const reference of request.baseFrontier) validateCommitRef(reference);
  if (request.payload.operation === 'upsert') {
    const { entity } = request.payload;
    const key = entityKey(entity);
    const value = entityWire(entity);
    await validateNativeEntity(key, value);
    const semantic = canonicalSemanticValue(value);
    const changed = changedFields(entity.entityType, semantic, request.causalBase);
    if (changed.length === 0) return null;
    return { localMutationId: request.localMutationId, entityType: entity.entityType, entityKey: key,
      operation: 'upsert', value, baseFrontier: [...request.baseFrontier], changedFields: changed };
  }
  const descriptor = request.payload.deleteDescriptor;
  const key = deleteKey(descriptor);
  const value = deleteWire(descriptor);
  await validateNativeTombstone(key, value);
  return { localMutationId: request.localMutationId, entityType: descriptor.entityType, entityKey: key,
    operation: 'tombstone', value, baseFrontier: [...request.baseFrontier], changedFields: ['$tombstone'] };
}

export function sortOrdinaryMutationsV1(mutations: CommitMutationV1[]): void {
  mutations.sort((left, right) => compareEntityKeyV1(left.entityKey, right.entityKey));
  for (let index = 1; index < mutations.length; index += 1) {
    if (compareEntityKeyV1(mutations[index - 1]!.entityKey, mutations[index]!.entityKey) === 0) {
      invalid('duplicate_entity_key');
    }
  }
}

/** Last pre-freeze payload for an EntityKey wins. UUID allocation happens after this function. */
export function coalesceOrdinaryPayloadsV1(payloads: readonly OrdinaryPayloadV1[]): OrdinaryPayloadV1[] {
  const retained: OrdinaryPayloadV1[] = [];
  for (const payload of payloads) {
    const key = payloadKey(payload);
    const index = retained.findIndex(candidate => compareEntityKeyV1(payloadKey(candidate), key) === 0);
    if (index < 0) retained.push(payload);
    else retained[index] = payload;
  }
  retained.sort((left, right) => compareEntityKeyV1(payloadKey(left), payloadKey(right)));
  return retained;
}
