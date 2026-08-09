export type Status = '在看' | '未看' | '已看';
export type MediaType = '电影' | '剧集' | '纪录片' | '综艺' | '动画';

export interface WatchRecord {
  id: string;
  originalName: string;
  chineseName: string;
  progress: string;
  totalEpisodes: number | null;  // 总集数，电视剧/综艺专用
  episodeTrackingEnabled?: boolean;
  nextEpisode?: number | null;
  movieProgress: number | null;  // 电影当前观看秒数
  movieDuration: number | null;  // 电影总时长秒数
  releaseYear: string | null;    // 发布年份
  posterPath: string | null;     // 海报路径 (TMDB)
  status: Status;
  platform: string;
  rating: number | null;
  startDate: string;
  endDate: string;
  notes: string;
  createdAt: string;
  updatedAt?: string | null;
  imdbId: string | null;
  isLocked?: boolean;

  genres?: string | null;
  originCountry?: string | null;
  imdbRating?: number | null;
  tmdbStatus?: string | null;
  interestLevel?: number | null;
  episodeRuntime?: number | null;
  mediaType: MediaType;
  contentTags?: string | null;
  tmdbMediaKind?: 'movie' | 'tv' | 'tv-season' | null;
  tmdbId?: number | null;
  tmdbParentId?: number | null;
  tmdbSeasonNumber?: number | null;
  seriesRecordKind?: 'season' | 'whole-series' | 'single-work' | null;
  rev?: number;
  revActor?: string;
}

export interface EpisodeCompletion {
  id: string;
  recordId: string;
  episodeNumber: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  rev: number;
  revActor: string;
}

export type CollectionSourceKind = 'manual' | 'tmdb-movie-collection' | 'tmdb-tv-show';
export interface WatchCollection {
  id: string;
  name: string;
  normalizedName: string;
  description: string | null;
  sourceKind: CollectionSourceKind;
  sourceKey: string | null;
  collectionKind: 'manual' | 'tv-series' | 'movie-series' | 'universe';
  orderMode: 'manual' | 'chronological';
  createdAt: string;
  updatedAt: string;
  rev: number;
  revActor: string;
}

export interface CollectionMember {
  id: string;
  collectionId: string;
  recordId: string;
  position: number;
  sourceKind: 'manual' | 'tmdb';
  createdAt: string;
  updatedAt: string;
  rev: number;
  revActor: string;
}

export interface CollectionTombstone { id: string; deletedAt: string; rev: number; revActor: string }
export interface CollectionMemberTombstone extends CollectionTombstone { collectionId: string; recordId: string }

export type UpdateWatchRecord = Partial<Pick<WatchRecord,
  | 'originalName'
  | 'chineseName'
  | 'progress'
  | 'status'
  | 'platform'
  | 'notes'
  | 'mediaType'
>> & {
  totalEpisodes?: number | null;
  movieProgress?: number | null;
  movieDuration?: number | null;
  releaseYear?: string | null;
  posterPath?: string | null;
  rating?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  imdbId?: string | null;
  isLocked?: boolean | null;
  genres?: string | null;
  originCountry?: string | null;
  imdbRating?: number | null;
  tmdbStatus?: string | null;
  interestLevel?: number | null;
  episodeRuntime?: number | null;
  contentTags?: string | null;
  tmdbMediaKind?: WatchRecord['tmdbMediaKind'];
  tmdbId?: number | null;
  tmdbParentId?: number | null;
  tmdbSeasonNumber?: number | null;
  seriesRecordKind?: WatchRecord['seriesRecordKind'];
};
