import {
  canonicalCollectionNameV1,
  canonicalJcsBytes,
  hasBoundaryS2Whitespace,
  INT64_MAX,
  normalizeCollectionNameV1,
  parseInt64DecimalString,
  sha256Hex,
  S2ProtocolValidationError,
  unicodeScalarLength,
  validateCanonicalDate,
  validateCanonicalTimestamp,
  validateFloat64,
  validateEntityKey,
  validateSafeInteger,
  validateUnicodeScalarString,
} from './canonical.ts';
import type { EntityKey, EntityType, JsonValue } from './types.ts';

const SYSTEM_METADATA_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'rev', 'revActor']);

export const BUSINESS_FIELD_ORDER: Readonly<Record<EntityType, readonly string[]>> = {
  record: [
    'originalName', 'chineseName', 'progress', 'totalEpisodes', 'episodeTrackingEnabled',
    'nextEpisode', 'movieProgress', 'movieDuration', 'releaseYear', 'posterPath', 'status',
    'platform', 'rating', 'startDate', 'endDate', 'notes', 'imdbId', 'isLocked', 'genres',
    'originCountry', 'imdbRating', 'tmdbStatus', 'interestLevel', 'episodeRuntime', 'mediaType',
    'contentTags', 'tmdbMediaKind', 'tmdbId', 'tmdbParentId', 'tmdbSeasonNumber',
    'seriesRecordKind',
  ],
  'episode-completion': ['recordId', 'episodeNumber', 'completedAt'],
  collection: ['name', 'normalizedName', 'description', 'sourceKind', 'sourceKey', 'collectionKind', 'orderMode'],
  'collection-member': ['collectionId', 'recordId', 'position', 'sourceKind'],
};

const RECORD_FIELDS = [
  'id', 'originalName', 'chineseName', 'progress', 'totalEpisodes', 'episodeTrackingEnabled',
  'nextEpisode', 'movieProgress', 'movieDuration', 'releaseYear', 'posterPath', 'status',
  'platform', 'rating', 'startDate', 'endDate', 'notes', 'createdAt', 'updatedAt', 'imdbId',
  'isLocked', 'genres', 'originCountry', 'imdbRating', 'tmdbStatus', 'interestLevel',
  'episodeRuntime', 'mediaType', 'contentTags', 'tmdbMediaKind', 'tmdbId', 'tmdbParentId',
  'tmdbSeasonNumber', 'seriesRecordKind', 'rev', 'revActor',
] as const;
const EPISODE_FIELDS = ['id', 'recordId', 'episodeNumber', 'completedAt', 'createdAt', 'updatedAt', 'rev', 'revActor'] as const;
const COLLECTION_FIELDS = [
  'id', 'name', 'normalizedName', 'description', 'sourceKind', 'sourceKey', 'collectionKind',
  'orderMode', 'createdAt', 'updatedAt', 'rev', 'revActor',
] as const;
const MEMBER_FIELDS = [
  'id', 'collectionId', 'recordId', 'position', 'sourceKind', 'createdAt', 'updatedAt', 'rev', 'revActor',
] as const;

function invalid(code: string): never {
  throw new S2ProtocolValidationError(code);
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('invalid_entity_value');
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    invalid('invalid_entity_fields');
  }
}

function requiredString(value: unknown, maximum: number, allowEmpty: boolean, preserveWhitespace = false): string {
  validateUnicodeScalarString(value);
  const length = unicodeScalarLength(value);
  if ((!allowEmpty && length === 0) || length > maximum || (!preserveWhitespace && hasBoundaryS2Whitespace(value))) {
    invalid('invalid_string');
  }
  return value;
}

function id(value: unknown): string {
  return requiredString(value, 512, false);
}

function nullable<T>(value: unknown, validate: (item: unknown) => T): T | null {
  return value === null ? null : validate(value);
}

function exactEnum(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid('invalid_enum');
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid('invalid_boolean');
  return value;
}

function timestamp(value: unknown): string {
  validateCanonicalTimestamp(value);
  return value;
}

function date(value: unknown): string {
  validateCanonicalDate(value);
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum = 2_147_483_647): number {
  validateSafeInteger(value, minimum, maximum);
  return value;
}

function int64(value: unknown, minimum: bigint): string {
  parseInt64DecimalString(value, minimum, INT64_MAX);
  return value as string;
}

function validateRecord(value: Record<string, unknown>): void {
  exactFields(value, RECORD_FIELDS);
  id(value.id);
  const originalName = requiredString(value.originalName, 4096, true);
  const chineseName = requiredString(value.chineseName, 4096, true);
  if (originalName === '' && chineseName === '') invalid('record_title_required');
  requiredString(value.progress, 4096, true);
  const totalEpisodes = nullable(value.totalEpisodes, item => safeInteger(item, 1));
  const tracking = bool(value.episodeTrackingEnabled);
  const nextEpisode = nullable(value.nextEpisode, item => safeInteger(item, 1));
  if (nextEpisode !== null && (!tracking || totalEpisodes === null || nextEpisode > totalEpisodes)) {
    invalid('invalid_next_episode');
  }
  const movieProgress = nullable(value.movieProgress, item => safeInteger(item, 0));
  const movieDuration = nullable(value.movieDuration, item => safeInteger(item, 1));
  if (movieProgress !== null && movieDuration !== null && movieProgress > movieDuration) {
    invalid('invalid_movie_progress');
  }
  nullable(value.releaseYear, item => {
    if (typeof item !== 'string' || !/^[0-9]{4}$/.test(item) || item === '0000') invalid('invalid_release_year');
    return item;
  });
  nullable(value.posterPath, item => requiredString(item, 8192, false));
  exactEnum(value.status, ['已看', '在看', '未看']);
  requiredString(value.platform, 1024, true);
  nullable(value.rating, item => safeInteger(item, 1, 10));
  const startDate = nullable(value.startDate, date);
  const endDate = nullable(value.endDate, date);
  if (startDate !== null && endDate !== null && startDate > endDate) invalid('invalid_date_range');
  requiredString(value.notes, 1_048_576, true, true);
  timestamp(value.createdAt);
  nullable(value.updatedAt, timestamp);
  nullable(value.imdbId, item => {
    if (typeof item !== 'string' || !/^tt[0-9]{1,18}$/.test(item)) invalid('invalid_imdb_id');
    return item;
  });
  nullable(value.isLocked, bool);
  nullable(value.genres, item => requiredString(item, 16_384, false));
  nullable(value.originCountry, item => requiredString(item, 1024, false));
  nullable(value.imdbRating, item => {
    validateFloat64(item, 0, 10);
    return item;
  });
  nullable(value.tmdbStatus, item => requiredString(item, 1024, false));
  nullable(value.interestLevel, item => safeInteger(item, 1, 5));
  nullable(value.episodeRuntime, item => safeInteger(item, 1));
  exactEnum(value.mediaType, ['电影', '剧集', '纪录片', '综艺', '动画']);
  nullable(value.contentTags, item => requiredString(item, 16_384, false));
  const mediaKind = nullable(value.tmdbMediaKind, item => exactEnum(item, ['movie', 'tv', 'tv-season']));
  const tmdbId = nullable(value.tmdbId, item => int64(item, 1n));
  const parentId = nullable(value.tmdbParentId, item => int64(item, 1n));
  const season = nullable(value.tmdbSeasonNumber, item => safeInteger(item, 0));
  const recordKind = nullable(value.seriesRecordKind, item => exactEnum(item, ['season', 'whole-series', 'single-work']));
  const emptyIdentity = mediaKind === null && tmdbId === null && parentId === null && season === null && recordKind === null;
  const movie = mediaKind === 'movie' && tmdbId !== null && parentId === null && season === null && recordKind === 'single-work';
  const tv = mediaKind === 'tv' && tmdbId !== null && parentId === null && season === null && recordKind === 'whole-series';
  const tvSeason = mediaKind === 'tv-season' && tmdbId !== null && parentId !== null && season !== null && season > 0 && recordKind === 'season';
  if (!(emptyIdentity || movie || tv || tvSeason)) invalid('invalid_tmdb_tuple');
  int64(value.rev, 0n);
  requiredString(value.revActor, 512, true, true);
}

function validateEpisode(value: Record<string, unknown>): void {
  exactFields(value, EPISODE_FIELDS);
  if (typeof value.id !== 'string' || !/^[0-9a-f]{64}$/.test(value.id)) invalid('invalid_episode_id');
  id(value.recordId);
  safeInteger(value.episodeNumber, 1);
  nullable(value.completedAt, timestamp);
  timestamp(value.createdAt);
  timestamp(value.updatedAt);
  int64(value.rev, 0n);
  requiredString(value.revActor, 512, true, true);
}

function validateCollection(value: Record<string, unknown>): void {
  exactFields(value, COLLECTION_FIELDS);
  id(value.id);
  if (typeof value.name !== 'string' || canonicalCollectionNameV1(value.name) !== value.name) {
    invalid('invalid_collection_name');
  }
  if (value.normalizedName !== normalizeCollectionNameV1(value.name)) invalid('invalid_normalized_name');
  nullable(value.description, item => {
    const text = requiredString(item, 500, false);
    if ([...text].some(character => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    })) invalid('invalid_collection_description');
    return text;
  });
  const sourceKind = exactEnum(value.sourceKind, ['manual', 'tmdb-movie-collection', 'tmdb-tv-show']);
  const sourceKey = nullable(value.sourceKey, item => requiredString(item, 2048, false));
  const collectionKind = exactEnum(value.collectionKind, ['manual', 'tv-series', 'movie-series', 'universe']);
  const orderMode = exactEnum(value.orderMode, ['manual', 'chronological']);
  if (sourceKind === 'manual' && sourceKey !== null) invalid('invalid_collection_source');
  if (sourceKind !== 'manual' && sourceKey === null) invalid('invalid_collection_source');
  if (sourceKind === 'tmdb-tv-show' && (collectionKind !== 'tv-series' || orderMode !== 'chronological')) {
    invalid('invalid_collection_source');
  }
  if (sourceKind === 'tmdb-movie-collection' && (collectionKind !== 'movie-series' || orderMode !== 'chronological')) {
    invalid('invalid_collection_source');
  }
  timestamp(value.createdAt);
  timestamp(value.updatedAt);
  int64(value.rev, 0n);
  requiredString(value.revActor, 512, true, true);
}

function validateMember(value: Record<string, unknown>): void {
  exactFields(value, MEMBER_FIELDS);
  if (typeof value.id !== 'string' || !/^[0-9a-f]{64}$/.test(value.id)) invalid('invalid_member_id');
  id(value.collectionId);
  id(value.recordId);
  int64(value.position, 0n);
  exactEnum(value.sourceKind, ['manual', 'tmdb']);
  timestamp(value.createdAt);
  timestamp(value.updatedAt);
  int64(value.rev, 0n);
  requiredString(value.revActor, 512, true, true);
}

export function validateNativeSemanticValue(entityType: EntityType, input: unknown): void {
  const value = asObject(input);
  if (entityType === 'record') validateRecord(value);
  else if (entityType === 'episode-completion') validateEpisode(value);
  else if (entityType === 'collection') validateCollection(value);
  else if (entityType === 'collection-member') validateMember(value);
  else invalid('invalid_entity_type');
}

export async function deterministicEntityIdV1(
  domain: 'episode-completion:v1' | 'collection-member:v1',
  components: readonly (string | number)[],
): Promise<string> {
  const encoded = components.map(component => String(component)).join('\0');
  const bytes = new TextEncoder().encode(`${domain}\0${encoded}`);
  return sha256Hex(bytes);
}

export async function validateNativeEntity(entityKey: EntityKey, input: unknown): Promise<void> {
  validateEntityKey(entityKey);
  const entityType = entityKey[0];
  validateNativeSemanticValue(entityType, input);
  const value = input as Record<string, unknown>;
  if (entityType === 'record' || entityType === 'collection') {
    if (value.id !== entityKey[1]) invalid('entity_key_mismatch');
  } else if (entityType === 'episode-completion') {
    if (value.recordId !== entityKey[1] || value.episodeNumber !== entityKey[2]) invalid('entity_key_mismatch');
    const expected = await deterministicEntityIdV1('episode-completion:v1', [entityKey[1], entityKey[2]]);
    if (value.id !== expected) invalid('entity_key_mismatch');
  } else {
    if (value.collectionId !== entityKey[1] || value.recordId !== entityKey[2]) invalid('entity_key_mismatch');
    const expected = await deterministicEntityIdV1('collection-member:v1', [entityKey[1], entityKey[2]]);
    if (value.id !== expected) invalid('entity_key_mismatch');
  }
}

export function canonicalSemanticValue(input: unknown): { [key: string]: JsonValue } {
  const value = asObject(input);
  const result: { [key: string]: JsonValue } = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!SYSTEM_METADATA_FIELDS.has(field)) result[field] = fieldValue as JsonValue;
  }
  // Exercise the JCS domain now so unsupported host values cannot enter a semantic core later.
  canonicalJcsBytes(result);
  return result;
}

export async function validateNativeTombstone(entityKey: EntityKey, input: unknown): Promise<void> {
  validateEntityKey(entityKey);
  const value = asObject(input);
  const entityType = entityKey[0];
  const fields = entityType === 'record' || entityType === 'collection'
    ? ['id', 'deletedAt', 'rev', 'revActor']
    : entityType === 'episode-completion'
      ? ['id', 'recordId', 'episodeNumber', 'deletedAt', 'rev', 'revActor']
      : ['id', 'collectionId', 'recordId', 'deletedAt', 'rev', 'revActor'];
  exactFields(value, fields);
  id(value.id);
  timestamp(value.deletedAt);
  int64(value.rev, 0n);
  requiredString(value.revActor, 512, true, true);
  if (entityType === 'record' || entityType === 'collection') {
    if (value.id !== entityKey[1]) invalid('entity_key_mismatch');
  } else if (entityType === 'episode-completion') {
    if (value.recordId !== entityKey[1] || value.episodeNumber !== entityKey[2]) invalid('entity_key_mismatch');
    safeInteger(value.episodeNumber, 1);
    const expected = await deterministicEntityIdV1('episode-completion:v1', [entityKey[1], entityKey[2]]);
    if (value.id !== expected) invalid('entity_key_mismatch');
  } else {
    if (value.collectionId !== entityKey[1] || value.recordId !== entityKey[2]) invalid('entity_key_mismatch');
    const expected = await deterministicEntityIdV1('collection-member:v1', [entityKey[1], entityKey[2]]);
    if (value.id !== expected) invalid('entity_key_mismatch');
  }
}
