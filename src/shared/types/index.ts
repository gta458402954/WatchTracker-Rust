// Category 改为动态类型，由 useCategories 管理
export type Category = string;

export type Status = '在看' | '未看' | '已看';

export interface WatchRecord {
  id: string;
  originalName: string;
  chineseName: string;
  progress: string;
  totalEpisodes: number | null;  // 总集数，电视剧/综艺专用
  movieProgress: number | null;  // 电影当前观看秒数
  movieDuration: number | null;  // 电影总时长秒数
  releaseYear: string | null;    // 发布年份
  posterPath: string | null;     // 海报路径 (TMDB)
  status: Status;
  platform: string;
  rating: number | null;
  startDate: string;
  endDate: string;
  category: Category;
  notes: string;
  createdAt: string;
  imdbId: string | null;
  isLocked?: boolean;
  sortOrder?: number;
  genres?: string | null;
  originCountry?: string | null;
  imdbRating?: number | null;
  tmdbStatus?: string | null;
  interestLevel?: number | null;
  episodeRuntime?: number | null;
}

export type SortField = 'chineseName' | 'status' | 'rating' | 'startDate' | 'endDate' | 'createdAt' | 'watchValue';
export type SortOrder = 'asc' | 'desc';
