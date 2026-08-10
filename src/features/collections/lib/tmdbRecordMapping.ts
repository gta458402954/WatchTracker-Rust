import type { WatchRecord } from '../../../shared/types/index.ts';
import {
  classifyTmdb,
  inferPlatformFromTmdb,
  mergeContentTags,
  positiveEpisodeRuntimeOf,
  type TmdbMedia,
  type TmdbSeason,
} from '../../../shared/lib/classification.ts';

function missingText(value: string | null | undefined): boolean {
  return !value?.trim();
}

export function seasonRecordMetadata(
  series: TmdbMedia,
  season: TmdbSeason,
  existing?: Partial<WatchRecord>,
): Partial<WatchRecord> {
  const seriesName = series.name || series.title || existing?.chineseName || '';
  const originalName = series.original_name || series.original_title || seriesName;
  const classification = classifyTmdb(series, true, existing?.mediaType);
  const platform = inferPlatformFromTmdb(
    classification.originCountry,
    series.networks?.[0]?.name || series.production_companies?.[0]?.name,
  );
  const runtime = positiveEpisodeRuntimeOf(series);
  const next: Partial<WatchRecord> = {
    chineseName: `${seriesName} ${season.name || `第 ${season.season_number} 季`}`.trim(),
    originalName: `${originalName} Season ${season.season_number}`.trim(),
    releaseYear: season.air_date?.slice(0, 4) || null,
    posterPath: season.poster_path || series.poster_path || null,
    totalEpisodes: season.episode_count || null,
    imdbId: series.external_ids?.imdb_id || series.imdb_id || existing?.imdbId || null,
    imdbRating: series.vote_average || null,
    tmdbStatus: series.status || null,
    mediaType: classification.mediaType,
    tmdbMediaKind: 'tv-season',
    tmdbId: season.id ?? null,
    tmdbParentId: series.id ?? null,
    tmdbSeasonNumber: season.season_number ?? null,
    seriesRecordKind: 'season',
  };
  if (missingText(existing?.genres) && classification.genres) next.genres = classification.genres;
  if (missingText(existing?.originCountry) && classification.originCountry) next.originCountry = classification.originCountry;
  if (classification.contentTags) next.contentTags = mergeContentTags(existing?.contentTags, classification.contentTags);
  if (missingText(existing?.platform) && platform) next.platform = platform;
  if (existing?.episodeRuntime == null && runtime !== null) next.episodeRuntime = runtime;
  return next;
}
