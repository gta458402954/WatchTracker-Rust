import type { MediaType, UpdateWatchRecord, WatchRecord } from '../types/index.ts';
import { classifyTmdb, mediaTypeOf, type TmdbMedia } from './classification.ts';

export type TmdbEntityType = 'movie' | 'tv';
export type BatchMetadataField = keyof Pick<UpdateWatchRecord,
  | 'genres'
  | 'originCountry'
  | 'contentTags'
  | 'imdbRating'
  | 'tmdbStatus'
  | 'movieDuration'
  | 'episodeRuntime'
  | 'totalEpisodes'
>;

export interface TmdbMatch {
  id: number;
  type: TmdbEntityType;
}

export type TmdbMatchResult =
  | { ok: true; match: TmdbMatch }
  | { ok: false; reason: string };

export interface BatchMetadataPatch {
  updates: UpdateWatchRecord;
  fields: BatchMetadataField[];
  seasonNumber: number | null;
}

export const BATCH_METADATA_FIELD_LABELS: Record<BatchMetadataField, string> = {
  genres: '题材',
  originCountry: '国家',
  contentTags: '地区标签',
  imdbRating: 'TMDB 评分',
  tmdbStatus: 'TMDB 状态',
  movieDuration: '电影时长',
  episodeRuntime: '单集时长',
  totalEpisodes: '总集数',
};

function isMissingText(value: string | null | undefined): boolean {
  return !value?.trim();
}

function isPositiveNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isEpisodicType(type: MediaType): boolean {
  return type === '剧集' || type === '综艺';
}

export function seasonNumberOf(record: Pick<WatchRecord, 'originalName' | 'chineseName' | 'progress'>): number | null {
  const candidates = [
    record.originalName.match(/\bSeason\s+(\d+)\b/i),
    record.chineseName.match(/第\s*(\d+)\s*季/),
    record.progress.match(/\bS(\d{1,3})E\d{1,4}\b/i),
  ];
  for (const match of candidates) {
    const value = match?.[1] ? Number.parseInt(match[1], 10) : 0;
    if (value > 0) return value;
  }
  return null;
}

export function tmdbTypeHintOf(record: WatchRecord): TmdbEntityType | null {
  const type = mediaTypeOf(record);
  if (type === '电影') return 'movie';
  if (isEpisodicType(type)) return 'tv';

  if (
    isPositiveNumber(record.totalEpisodes)
    || isPositiveNumber(record.episodeRuntime)
    || seasonNumberOf(record) != null
    || /\bS\d{1,3}E\d{1,4}\b/i.test(record.progress)
  ) return 'tv';
  if (isPositiveNumber(record.movieDuration) || isPositiveNumber(record.movieProgress)) return 'movie';
  return null;
}

export function isBatchMetadataCandidate(record: WatchRecord): boolean {
  if (!record.imdbId?.trim() || record.isLocked) return false;

  const commonMissing = isMissingText(record.genres)
    || isMissingText(record.originCountry)
    || isMissingText(record.contentTags)
    || !isPositiveNumber(record.imdbRating)
    || isMissingText(record.tmdbStatus);
  const hint = tmdbTypeHintOf(record);
  if (hint === 'movie') return commonMissing || !isPositiveNumber(record.movieDuration);
  if (hint === 'tv') {
    return commonMissing
      || !isPositiveNumber(record.episodeRuntime)
      || !isPositiveNumber(record.totalEpisodes);
  }
  return commonMissing
    || !isPositiveNumber(record.movieDuration)
    || !isPositiveNumber(record.episodeRuntime)
    || !isPositiveNumber(record.totalEpisodes);
}

export function selectTmdbMatch(record: WatchRecord, results: TmdbMedia[]): TmdbMatchResult {
  const eligible = results.flatMap(result => {
    if (!isPositiveNumber(result.id) || (result.media_type !== 'movie' && result.media_type !== 'tv')) return [];
    return [{ id: result.id, type: result.media_type } satisfies TmdbMatch];
  });
  const hint = tmdbTypeHintOf(record);

  if (hint) {
    const match = eligible.find(candidate => candidate.type === hint);
    return match
      ? { ok: true, match }
      : { ok: false, reason: `TMDB 没有返回匹配的${hint === 'movie' ? '电影' : '剧集'}结果` };
  }

  if (eligible.length !== 1) {
    return { ok: false, reason: eligible.length === 0 ? 'TMDB 没有返回可用结果' : '媒体类型不明确且 TMDB 返回多个候选' };
  }
  return { ok: true, match: eligible[0] };
}

export function buildBatchMetadataPatch(
  record: WatchRecord,
  detail: TmdbMedia,
  tmdbType: TmdbEntityType,
): BatchMetadataPatch {
  const updates: UpdateWatchRecord = {};
  const classification = classifyTmdb(detail, tmdbType === 'tv', mediaTypeOf(record));
  const seasonNumber = tmdbType === 'tv' ? seasonNumberOf(record) : null;

  if (isMissingText(record.genres) && !isMissingText(classification.genres)) {
    updates.genres = classification.genres;
  }
  if (isMissingText(record.originCountry) && !isMissingText(classification.originCountry)) {
    updates.originCountry = classification.originCountry;
  }
  if (isMissingText(record.contentTags) && !isMissingText(classification.contentTags)) {
    updates.contentTags = classification.contentTags;
  }
  if (!isPositiveNumber(record.imdbRating) && isPositiveNumber(detail.vote_average)) {
    updates.imdbRating = detail.vote_average;
  }
  if (isMissingText(record.tmdbStatus) && !isMissingText(detail.status)) {
    updates.tmdbStatus = detail.status?.trim();
  }

  if (tmdbType === 'movie') {
    if (!isPositiveNumber(record.movieDuration) && isPositiveNumber(detail.runtime)) {
      updates.movieDuration = Math.round(detail.runtime * 60);
    }
  } else {
    const runtime = detail.episode_run_time?.find(isPositiveNumber) ?? detail.runtime;
    if (!isPositiveNumber(record.episodeRuntime) && isPositiveNumber(runtime)) {
      updates.episodeRuntime = Math.round(runtime);
    }

    const episodeCount = seasonNumber == null
      ? detail.number_of_episodes
      : detail.seasons?.find(season => season.season_number === seasonNumber)?.episode_count;
    if (!isPositiveNumber(record.totalEpisodes) && isPositiveNumber(episodeCount)) {
      updates.totalEpisodes = Math.round(episodeCount);
    }
  }

  return {
    updates,
    fields: Object.keys(updates) as BatchMetadataField[],
    seasonNumber,
  };
}

export function retainMissingMetadataPatch(
  current: WatchRecord,
  planned: UpdateWatchRecord,
): BatchMetadataPatch {
  const updates: UpdateWatchRecord = {};
  const textFields = ['genres', 'originCountry', 'contentTags', 'tmdbStatus'] as const;
  const numberFields = ['imdbRating', 'movieDuration', 'episodeRuntime', 'totalEpisodes'] as const;

  for (const field of textFields) {
    const value = planned[field];
    if (isMissingText(current[field]) && !isMissingText(value)) updates[field] = value;
  }
  for (const field of numberFields) {
    const value = planned[field];
    if (!isPositiveNumber(current[field]) && isPositiveNumber(value)) updates[field] = value;
  }

  return {
    updates,
    fields: Object.keys(updates) as BatchMetadataField[],
    seasonNumber: seasonNumberOf(current),
  };
}

export function remoteIdentityKey(match: TmdbMatch, seasonNumber: number | null): string {
  return `${match.type}:${match.id}:${seasonNumber == null ? 'series' : `season-${seasonNumber}`}`;
}
