import type { MediaType, WatchRecord } from '../types';

export const MEDIA_TYPES: readonly MediaType[] = ['电影', '剧集', '纪录片', '综艺', '动画'];

export const REGION_TAGS = ['美国', '韩国', '日本', '英国', '中国大陆', '中国香港', '中国台湾'] as const;
export type RegionTag = (typeof REGION_TAGS)[number];

const COUNTRY_LABELS: Record<string, RegionTag> = {
  US: '美国',
  KR: '韩国',
  JP: '日本',
  GB: '英国',
  CN: '中国大陆',
  HK: '中国香港',
  TW: '中国台湾',
};

const SPECIAL_MEDIA_TYPES: readonly MediaType[] = ['纪录片', '综艺', '动画'];

export interface TmdbGenre {
  name?: string;
}

export interface TmdbProductionCountry {
  iso_3166_1?: string;
}

export interface TmdbSeason {
  id?: number;
  name?: string;
  season_number?: number;
  episode_count?: number;
  air_date?: string | null;
  poster_path?: string | null;
}

export interface TmdbMedia {
  id?: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  imdb_id?: string;
  vote_average?: number;
  poster_path?: string | null;
  media_type?: 'movie' | 'tv' | 'tv_season' | 'tv_episode';
  show_id?: number;
  season_number?: number;
  episode_number?: number;
  episode_count?: number;
  air_date?: string | null;
  networks?: Array<{ name?: string }>;
  production_companies?: Array<{ name?: string }>;
  external_ids?: { imdb_id?: string };
  runtime?: number;
  episode_run_time?: number[];
  number_of_episodes?: number;
  status?: string;
  genres?: TmdbGenre[];
  origin_country?: string[];
  production_countries?: TmdbProductionCountry[];
  seasons?: TmdbSeason[];
}

export interface TmdbSearchResponse {
  success?: boolean;
  results?: TmdbMedia[];
  data?: TmdbMedia;
  error?: string;
}

export function mediaTypeOf(record: Pick<WatchRecord, 'mediaType'>): MediaType {
  return MEDIA_TYPES.includes(record.mediaType) ? record.mediaType : '电影';
}

export function contentTagsOf(record: Pick<WatchRecord, 'contentTags'>): string[] {
  return record.contentTags?.split(',').map(tag => tag.trim()).filter(Boolean) ?? [];
}

export function regionsOf(record: Pick<WatchRecord, 'contentTags'>): RegionTag[] {
  return contentTagsOf(record).filter((tag): tag is RegionTag => REGION_TAGS.includes(tag as RegionTag));
}

export function hasRegion(record: Pick<WatchRecord, 'contentTags'>, region: RegionTag): boolean {
  return regionsOf(record).includes(region);
}

export function mergeContentTags(existing: string | null | undefined, tmdbRegions: string): string {
  const customTags = (existing ?? '').split(',').map(tag => tag.trim()).filter(tag =>
    tag && tag !== '纪录片' && !REGION_TAGS.includes(tag as RegionTag),
  );
  const regions = tmdbRegions.split(',').map(tag => tag.trim()).filter(Boolean);
  return [...new Set([...customTags, ...regions])].join(',');
}

export function classifyTmdb(
  detail: TmdbMedia,
  isTV: boolean,
  preferredType?: MediaType | null,
): { mediaType: MediaType; contentTags: string; originCountry: string | null; genres: string | null } {
  const countryCodes = isTV
    ? detail.origin_country ?? []
    : detail.production_countries?.map(country => country.iso_3166_1).filter((code): code is string => Boolean(code)) ?? [];
  const regions = countryCodes.map(code => COUNTRY_LABELS[code]).filter((region): region is RegionTag => Boolean(region));
  const genreNames = detail.genres?.map(genre => genre.name?.trim()).filter((name): name is string => Boolean(name)) ?? [];
  const isDocumentary = genreNames.some(name => name === 'Documentary' || name === '纪录片');

  let mediaType: MediaType;
  if (isDocumentary) {
    mediaType = '纪录片';
  } else if (preferredType && SPECIAL_MEDIA_TYPES.includes(preferredType)) {
    mediaType = preferredType;
  } else {
    mediaType = isTV ? '剧集' : '电影';
  }

  return {
    mediaType,
    contentTags: [...new Set(regions)].join(','),
    originCountry: countryCodes.join(', ') || null,
    genres: genreNames.join(',') || null,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
