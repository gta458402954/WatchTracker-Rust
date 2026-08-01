import React, { useState, useEffect, useRef } from 'react';
import { WatchRecord, Status, MediaType } from '../../../shared/types';
import { STATUSES, PLATFORMS, getEmptyRecord, parseTimeToSeconds, formatMovieTime } from '../../../shared/lib/constants';
import { downloadPosterAsync, getSettingAsync, safeDecrypt, searchTmdbAsync, getTmdbDetailAsync } from '../../../shared/lib/database';
import { classifyTmdb, mediaTypeOf, mergeContentTags, TmdbMedia, TmdbSeason } from '../../../shared/lib/classification';
import { publicFailureMessage, reportOperationFailure, type NoticeTone } from '../../../shared/lib/feedback';

interface RecordFormProps {
  record?: WatchRecord | null;
  onSave: (data: Omit<WatchRecord, 'id' | 'createdAt'>) => Promise<boolean | void> | boolean | void;
  onDelete?: (id: string) => void;
  onClose: () => void;
  onNotify?: (tone: NoticeTone, message: string) => void;
}

const isAlwaysEpisodic = (mediaType: MediaType | null | undefined) => mediaType === '剧集' || mediaType === '综艺';

function smartProgress(raw: string): string {
  if (!raw) return '';
  const t = raw.trim();
  if (!t) return '';

  // 完 / w / 0 → 完结
  if (['完', 'wan', 'w'].includes(t.toLowerCase())) return '完结';
  if (t === '在看') return '在看';
  if (t === '0') return '完结';

  // S01 / S1E02 等季+集格式直接保留
  if (/^S\d+E\d+$/i.test(t)) return t.toUpperCase();
  // S01 / S1 季格式
  if (/^S\d+$/i.test(t)) return t.toUpperCase();
  // E05 / E5 集格式
  if (/^E\d+$/i.test(t)) return t.toUpperCase();

  // 纯数字 → 第X集
  if (/^\d+$/.test(t)) return `第${parseInt(t, 10)}集`;

  // 第X集 / X集
  if (/^第?\d+集?$/.test(t)) {
    const num = t.match(/\d+/)?.[0];
    return num ? `第${num}集` : t;
  }

  // 已经包含了第/完/在看，直接返回
  return t;
}

export default function RecordForm({ record, onSave, onDelete, onClose, onNotify }: RecordFormProps) {
  const [form, setForm] = useState<Omit<WatchRecord, 'id' | 'createdAt'>>(
    record
      ? {
          originalName: record.originalName,
          chineseName: record.chineseName,
          progress: record.progress,
          totalEpisodes: record.totalEpisodes,
          movieProgress: record.movieProgress,
          movieDuration: record.movieDuration,
          releaseYear: record.releaseYear,
          posterPath: record.posterPath,
          status: record.status,
          platform: record.platform,
          rating: record.rating,
          startDate: record.startDate,
          endDate: record.endDate,
          notes: record.notes,
          imdbId: record.imdbId || null,
          genres: record.genres || null,
          originCountry: record.originCountry || null,
          imdbRating: record.imdbRating || null,
          tmdbStatus: record.tmdbStatus || null,
          interestLevel: record.interestLevel || null,
          episodeRuntime: record.episodeRuntime || null,
          mediaType: mediaTypeOf(record),
          contentTags: record.contentTags || null,
        }
      : getEmptyRecord()
  );

  // 电影时间输入状态（秒）
  const [movieProgressStr, setMovieProgressStr] = useState(() => record?.movieProgress != null ? formatMovieTime(record.movieProgress) : '');
  const [movieDurationStr, setMovieDurationStr] = useState(() => record?.movieDuration != null ? formatMovieTime(record.movieDuration) : '');

  const [startYearOnly, setStartYearOnly] = useState(
    !!record?.startDate && /^\d{4}$/.test(record.startDate)
  );
  const [endYearOnly, setEndYearOnly] = useState(
    !!record?.endDate && /^\d{4}$/.test(record.endDate)
  );

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: currentYear - 1950 + 1 }, (_, i) => currentYear - i);

  // TMDB 搜索相关状态
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<TmdbMedia[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  function downloadPosterInBackground(poster: string) {
    void downloadPosterAsync(poster).catch(error => {
      reportOperationFailure('RecordForm.DownloadPoster', error);
      onNotify?.('warning', '元数据已保留，但海报下载失败，可以稍后重试。');
    });
  }
  const [showResults, setShowResults] = useState(false);
  const [seasons, setSeasons] = useState<TmdbSeason[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<TmdbMedia | null>(null);
  const isEpisodic = isAlwaysEpisodic(form.mediaType) || Boolean(form.totalEpisodes);

  // 获取解密后的 TMDB API Key
  async function getTMDBApiKey() {
    const encrypted = await getSettingAsync('tmdb_api_key');
    if (!encrypted) return null;
    try {
      const decrypted = await safeDecrypt(encrypted);
      if (decrypted === '__ERR_DECRYPT_VERSION_MISMATCH__' || decrypted === '__ERR_DECRYPT_FAILED__') {
        onNotify?.('warning', 'TMDB 密钥格式已过期，请在设置中重新保存。');
        return null;
      }
      return decrypted;
    } catch (error) {
      reportOperationFailure('RecordForm.DecryptTmdbKey', error);
      onNotify?.('warning', 'TMDB 密钥无法读取，请在设置中重新保存。');
      return null;
    }
  }

  async function handleTMDBSearch() {
    let query = form.imdbId || form.chineseName || form.originalName;
    if (!query) return;

    query = query
      .replace(/第\s*\d+\s*季/g, '')
      .replace(/Season\s*\d+/gi, '')
      .replace(/第\s*[一二三四五六七八九十]+\s*季/g, '')
      .trim();

    const apiKey = await getTMDBApiKey();
    if (!apiKey) {
      setSearchError('请先在设置中配置 TMDB API KEY');
      setShowResults(true);
      return;
    }

    setIsSearching(true);
    setShowResults(true);
    setSearchError(null);
    setSeasons([]);
    setSelectedSeries(null);

    try {
      const result = await searchTmdbAsync({ apiKey, query, language: 'zh-CN' });
      if (!result.success) {
        setSearchError(publicFailureMessage('搜索 TMDB'));
        return;
      }
      setSearchResults(result.results ?? []);
    } catch (error) {
      reportOperationFailure('RecordForm.SearchTmdb', error);
      setSearchError(publicFailureMessage('搜索 TMDB'));
    } finally {
      setIsSearching(false);
    }
  }
  async function handleSelectResult(item: TmdbMedia) {
    const API_KEY = await getTMDBApiKey();
    if (!API_KEY) return;

    const type = item.media_type || (isEpisodic ? 'tv' : 'movie');
    const isSeason = type === 'tv_season';
    const isEpisode = type === 'tv_episode';
    const isTV = type === 'tv' || isSeason || isEpisode;
    const fetchId = isSeason || isEpisode ? item.show_id : item.id;
    const fetchType: 'movie' | 'tv' = isTV ? 'tv' : 'movie';
    if (fetchId == null) {
      setSearchError('TMDB 结果缺少 ID');
      return;
    }

    try {
      setSearchError(null);
      const result = await getTmdbDetailAsync({
        apiKey: API_KEY,
        id: fetchId,
        mediaType: fetchType,
        language: 'zh-CN'
      });

      if (!result.success || !result.data) {
        setSearchError(publicFailureMessage('获取 TMDB 详情'));
        return;
      }
      const detail = result.data;

      if (isSeason || isEpisode) {
        const targetSeason = detail.seasons?.find((s: TmdbSeason) => s.season_number === item.season_number) || item;
        const seriesName = detail.name || detail.title;
        const seriesOriginalName = detail.original_name || detail.original_title;
        const year = targetSeason.air_date ? targetSeason.air_date.split('-')[0] : (detail.first_air_date?.split('-')[0] || null);
        const poster = targetSeason.poster_path || detail.poster_path || null;

        if (poster) downloadPosterInBackground(poster);

        const query = form.imdbId || form.chineseName || form.originalName || '';

        const classification = classifyTmdb(detail, isTV, form.mediaType);
        const originCountry = classification.originCountry;
        let networkName = detail.networks?.[0]?.name || detail.production_companies?.[0]?.name;
        if (originCountry && (originCountry.includes('CN') || originCountry.includes('中国'))) {
          networkName = '';
        } else {
          if (networkName === 'CBS All Access') networkName = 'CBS';
          if (networkName && /^Apple\s*Tv/i.test(networkName)) networkName = 'Apple TV+';
        }
        const genres = classification.genres;

        const updates: Partial<typeof form> = {
          chineseName: `${seriesName} ${targetSeason.name || `第 ${targetSeason.season_number} 季`}`,
          originalName: `${seriesOriginalName} Season ${targetSeason.season_number}`,
          totalEpisodes: targetSeason.episode_count || null,
          releaseYear: year,
          posterPath: poster,
          imdbId: query.startsWith('tt') ? query : (detail.external_ids?.imdb_id || detail.imdb_id || form.imdbId),
          genres,
          originCountry,
          imdbRating: detail.vote_average || null,
          tmdbStatus: detail.status || null,
          episodeRuntime: detail.episode_run_time?.[0] || detail.runtime || 0,
          mediaType: classification.mediaType,
          contentTags: mergeContentTags(form.contentTags, classification.contentTags),
        };

        if (networkName && (!form.platform || form.platform.trim() === '')) {
          updates.platform = networkName;
        }

        if (isEpisode && item.episode_number) {
          updates.progress = `S${String(item.season_number).padStart(2, '0')}E${String(item.episode_number).padStart(2, '0')}`;
        }

        setForm(prev => ({
          ...prev,
          ...updates
        }));
        setShowResults(false);
        return;
      }

      if (isTV && detail.seasons && detail.seasons.length > 0) {
        // 如果是电视剧且有多季，展示季节选择
        setSelectedSeries(detail);
        setSeasons(detail.seasons.filter((s: TmdbSeason) => (s.season_number ?? 0) > 0)); // 过滤掉第 0 季（通常是花絮）
        return;
      }

      // 提取年份与海报
      const dateStr = detail.release_date || detail.first_air_date || '';
      const year = dateStr.split('-')[0] || null;
      const poster = detail.poster_path || item.poster_path || null;

      // 触发后台下载海报
      if (poster) downloadPosterInBackground(poster);

      const classification = classifyTmdb(detail, isTV, form.mediaType);
      const originCountry = classification.originCountry;
      let networkName = detail.networks?.[0]?.name || detail.production_companies?.[0]?.name;
      if (originCountry && (originCountry.includes('CN') || originCountry.includes('中国'))) {
        networkName = '';
      } else {
        if (networkName === 'CBS All Access') networkName = 'CBS';
        if (networkName && /^Apple\s*Tv/i.test(networkName)) networkName = 'Apple TV+';
      }
      const genres = classification.genres;

      // 电影或单季剧集直接填充
      const updates: Partial<typeof form> = {
        chineseName: detail.name || detail.title || item.name || item.title || form.chineseName,
        originalName: detail.original_name || detail.original_title || item.original_name || item.original_title || form.originalName,
        releaseYear: year,
        posterPath: poster,
        genres,
        originCountry,
        imdbRating: detail.vote_average || null,
        tmdbStatus: detail.status || null,
        episodeRuntime: detail.episode_run_time?.[0] || detail.runtime || 0,
          mediaType: classification.mediaType,
          contentTags: mergeContentTags(form.contentTags, classification.contentTags),
      };

      if (networkName && (!form.platform || form.platform.trim() === '')) {
        updates.platform = networkName;
      }

      if (isTV) {
        updates.totalEpisodes = detail.number_of_episodes || null;
      } else {
        updates.movieDuration = detail.runtime ? detail.runtime * 60 : null;
        setMovieDurationStr(updates.movieDuration != null ? formatMovieTime(updates.movieDuration) : '');
      }

      if (detail.external_ids?.imdb_id) {
        updates.imdbId = detail.external_ids.imdb_id;
      } else if (detail.imdb_id) {
        updates.imdbId = detail.imdb_id;
      }

      setForm(prev => ({ ...prev, ...updates }));
      setShowResults(false);
    } catch (error) {
      reportOperationFailure('RecordForm.SelectTmdbResult', error);
      setSearchError(publicFailureMessage('读取 TMDB 详情'));
      onNotify?.('error', publicFailureMessage('读取 TMDB 详情'));
    }
  }

  async function handleSelectSeason(season: TmdbSeason) {
    if (!selectedSeries) return;

    const seriesName = selectedSeries.name || selectedSeries.title;
    const seriesOriginalName = selectedSeries.original_name || selectedSeries.original_title;
    const year = season.air_date ? season.air_date.split('-')[0] : (selectedSeries.first_air_date?.split('-')[0] || null);
    const poster = season.poster_path || selectedSeries.poster_path || null;

    // 触发后台下载海报
    if (poster) downloadPosterInBackground(poster);

    const classification = classifyTmdb(selectedSeries, true, form.mediaType);
    const originCountry = classification.originCountry;
    let networkName = selectedSeries.networks?.[0]?.name || selectedSeries.production_companies?.[0]?.name;
    if (originCountry && (originCountry.includes('CN') || originCountry.includes('中国'))) {
      networkName = '';
    } else {
      if (networkName === 'CBS All Access') networkName = 'CBS';
      if (networkName && /^Apple\s*Tv/i.test(networkName)) networkName = 'Apple TV+';
    }
    const genres = classification.genres;

    setForm(prev => ({
      ...prev,
      chineseName: `${seriesName} ${season.name || `第 ${season.season_number} 季`}`,
      originalName: `${seriesOriginalName} Season ${season.season_number}`,
      totalEpisodes: season.episode_count || null,
      releaseYear: year,
      posterPath: poster,
      imdbId: selectedSeries.external_ids?.imdb_id || selectedSeries.imdb_id || prev.imdbId,
      genres,
      originCountry,
      imdbRating: selectedSeries.vote_average || null,
      tmdbStatus: selectedSeries.status || null,
      episodeRuntime: selectedSeries.episode_run_time?.[0] || selectedSeries.runtime || 0,
      mediaType: classification.mediaType,
      contentTags: mergeContentTags(form.contentTags, classification.contentTags),
      ...(networkName && (!prev.platform || prev.platform.trim() === '') ? { platform: networkName } : {}),
    }));
    setShowResults(false);
    setSeasons([]);
    setSelectedSeries(null);
  }

  const progressRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  function set<K extends keyof typeof form>(key: K, value: typeof form[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function handleMediaTypeChange(mediaType: MediaType) {
    const episodic = isAlwaysEpisodic(mediaType) || (mediaType !== '电影' && isEpisodic);
    setForm(prev => ({
      ...prev,
      mediaType,
      ...(episodic
        ? { movieProgress: null, movieDuration: null }
        : { progress: '', totalEpisodes: null }),
    }));
    if (episodic) {
      setMovieProgressStr('');
      setMovieDurationStr('');
    }
  }

  function handleProgressChange(e: React.ChangeEvent<HTMLInputElement>) {
    set('progress', e.target.value);
  }

  function handleProgressBlur() {
    const resolved = smartProgress(form.progress);
    if (resolved !== form.progress) {
      set('progress', resolved);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.chineseName.trim() && !form.originalName.trim()) return;
    const result = await onSave(form);
    if (result !== false) {
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">
            {record ? '编辑记录' : '添加新记录'}
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">内容类型</label>
              <select value={form.mediaType || '电影'} onChange={event => handleMediaTypeChange(event.target.value as MediaType)} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400">
                {(['电影', '剧集', '纪录片', '综艺', '动画'] as MediaType[]).map(type => <option key={type} value={type}>{type}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">内容标签</label>
              <input value={form.contentTags || ''} onChange={event => set('contentTags', event.target.value)} placeholder="如：韩国" className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
            </div>
          </div>

          {/* Names */}
          <div className="grid grid-cols-2 gap-3">
            <div className="relative col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">中文名 <span className="text-red-400">*</span></label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={form.chineseName}
                  onChange={e => set('chineseName', e.target.value)}
                  placeholder="请输入中文名称"
                  className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
                  required
                />
                <button
                  type="button"
                  onClick={handleTMDBSearch}
                  disabled={isSearching || (!form.chineseName && !form.originalName)}
                  className="px-3 py-2 bg-indigo-50 text-indigo-600 rounded-xl text-xs font-semibold hover:bg-indigo-100 disabled:opacity-50 transition-colors flex items-center gap-1"
                >
                  {isSearching ? '搜索中...' : '🔍 自动填充'}
                </button>
              </div>

              {/* Search Results Dropdown */}
              {showResults && (
                <div className="absolute z-[60] left-0 right-0 top-full mt-1 bg-white border border-gray-100 shadow-xl rounded-2xl max-h-60 overflow-y-auto p-1">
                  <div className="flex items-center justify-between p-2 border-b border-gray-50">
                    <div className="flex items-center gap-2">
                      {seasons.length > 0 && (
                        <button
                          type="button"
                          onClick={() => { setSeasons([]); setSelectedSeries(null); }}
                          className="p-1 hover:bg-gray-100 rounded-full text-indigo-600"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                        </button>
                      )}
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                        {seasons.length > 0 ? `选择季节 (${selectedSeries?.name})` : '搜索结果 (TMDB)'}
                      </span>
                    </div>
                    <button type="button" onClick={() => setShowResults(false)} className="text-gray-400 hover:text-gray-600">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>

                  {/* 季节列表 */}
                  {seasons.length > 0 ? (
                    seasons.map(s => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => handleSelectSeason(s)}
                        className="w-full flex items-center justify-between p-3 hover:bg-indigo-50 rounded-xl transition-colors text-left"
                      >
                        <div className="flex flex-col">
                          <span className="text-sm font-bold text-gray-900">{s.name || `第 ${s.season_number} 季`}</span>
                          <span className="text-xs text-gray-400">{s.air_date?.split('-')[0] || '未知年份'} · {s.episode_count} 集</span>
                        </div>
                        <svg className="w-4 h-4 text-indigo-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                      </button>
                    ))
                  ) : (searchResults.length === 0 && !isSearching) || searchError ? (
                    <div className={`p-4 text-center text-sm ${searchError ? 'text-red-500' : 'text-gray-400'}`}>
                      {searchError ? (
                        <div className="flex flex-col gap-1">
                          <span className="font-bold">❌ 搜索出错</span>
                          <span className="text-xs opacity-80 break-all">
                            {searchError.includes('error sending request') || searchError.includes('connection')
                              ? '网络连接失败，请检查网络设置或代理'
                              : searchError}
                          </span>
                        </div>
                      ) : (
                        '未找到相关影视'
                      )}
                    </div>
                  ) : (
                    /* 初始搜索结果列表 */
                    searchResults.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleSelectResult(item)}
                        className="w-full flex items-start gap-3 p-2 hover:bg-indigo-50 rounded-xl transition-colors text-left"
                      >
                        {item.poster_path ? (
                          <img src={`https://image.tmdb.org/t/p/w92${item.poster_path}`} alt="" className="w-10 h-14 object-cover rounded-md flex-shrink-0" />
                        ) : (
                          <div className="w-10 h-14 bg-gray-100 rounded-md flex-shrink-0 flex items-center justify-center text-xs text-gray-400">无图</div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-bold text-gray-900 truncate">
                            {item.media_type === 'movie' && <span className="text-[10px] bg-blue-100 text-blue-600 px-1 py-0.5 rounded mr-1">电影</span>}
                            {item.media_type === 'tv' && <span className="text-[10px] bg-green-100 text-green-600 px-1 py-0.5 rounded mr-1">剧集</span>}
                            {item.title || item.name}
                          </div>
                          <div className="text-xs text-gray-400 truncate">{item.original_title || item.original_name}</div>
                          <div className="text-[10px] text-gray-400 mt-1">
                            {item.release_date || item.first_air_date || '未知日期'}
                            {(item.vote_average ?? 0) > 0 && ` · ⭐ ${item.vote_average?.toFixed(1)}`}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">原文名</label>
              <input
                type="text"
                value={form.originalName}
                onChange={e => set('originalName', e.target.value)}
                placeholder="英文 / 原名"
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">发布年份</label>
              <input
                type="text"
                value={form.releaseYear || ''}
                onChange={e => set('releaseYear', e.target.value || null)}
                placeholder="如 2024"
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
              />
            </div>
          </div>

          {/* Status & Progress & Total Episodes */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">观看状态</label>
              <select
                value={form.status}
                onChange={e => {
                  const newStatus = e.target.value as Status;
                  set('status', newStatus);

                  // 如果是电影且改为“已看”，自动填满进度
                  if (!isEpisodic && newStatus === '已看' && form.movieDuration) {
                    set('movieProgress', form.movieDuration);
                    setMovieProgressStr(formatMovieTime(form.movieDuration));
                  }

                  // 如果是电视剧且改为“已看”，自动填充最后一集
                  if (isEpisodic && newStatus === '已看') {
                    if (form.totalEpisodes) {
                      set('progress', `第${form.totalEpisodes}集`);
                    } else {
                      set('progress', '完结');
                    }
                  }
                }}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition bg-white"
              >
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* IMDb ID */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">IMDb ID</label>
              <input
                type="text"
                value={form.imdbId || ''}
                onChange={e => set('imdbId', e.target.value || null)}
                placeholder="如 tt0111161"
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
              />
            </div>

            {isEpisodic && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  进度
                  <span className="ml-1.5 text-xs text-gray-400 font-normal">（智能识别）</span>
                </label>
                <input
                  ref={progressRef}
                  type="text"
                  value={form.progress}
                  onChange={handleProgressChange}
                  onBlur={handleProgressBlur}
                  placeholder="如 S01、12、完"
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
                />
              </div>
            )}
          </div>

          {/* Total Episodes - 仅电视剧/综艺显示 */}
          {isEpisodic && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                总集数
                <span className="ml-1.5 text-xs text-gray-400 font-normal">（可选）</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  value={form.totalEpisodes ?? ''}
                  onChange={e => set('totalEpisodes', e.target.value ? parseInt(e.target.value, 10) : null)}
                  placeholder="如 12"
                  className="w-32 px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
                />
                <span className="text-sm text-gray-400">集</span>
                {form.totalEpisodes && (
                  <span className="text-xs text-indigo-600 bg-indigo-50 px-2 py-1 rounded-full">
                    {form.progress ? `${form.progress} / ${form.totalEpisodes} 集` : `共 ${form.totalEpisodes} 集`}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Movie Time Input - 仅电影显示 */}
          {!isEpisodic && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                {/* 当前看到 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    当前看到
                    <span className="ml-1.5 text-xs text-gray-400 font-normal">（可选）</span>
                  </label>
                  <input
                    type="text"
                    value={movieProgressStr}
                    onChange={e => {
                      const val = e.target.value;
                      setMovieProgressStr(val);
                      const seconds = parseTimeToSeconds(val);
                      set('movieProgress', seconds);
                    }}
                    placeholder="如 1h 30m 45s"
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
                  />
                </div>
                {/* 电影总时长 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    电影总时长
                    <span className="ml-1.5 text-xs text-gray-400 font-normal">（可选）</span>
                  </label>
                  <input
                    type="text"
                    value={movieDurationStr}
                    onChange={e => {
                      const val = e.target.value;
                      setMovieDurationStr(val);
                      const seconds = parseTimeToSeconds(val);
                      set('movieDuration', seconds);
                    }}
                    placeholder="如 2h 30m"
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
                  />
                </div>
              </div>
              {/* 进度预览 */}
              {form.movieProgress !== null && (
                <div className="text-xs text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-xl inline-flex items-center self-start">
                  已看：{formatMovieTime(form.movieProgress)}
                  {form.movieDuration && form.movieDuration > 0 && (
                    <span className="ml-2 text-indigo-400">
                      / {formatMovieTime(form.movieDuration)}
                      &nbsp;({Math.round((form.movieProgress / form.movieDuration) * 100)}%)
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Platform */}
          {isEpisodic && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">平台</label>
              <input
                type="text"
                value={form.platform}
                onChange={e => set('platform', e.target.value)}
                placeholder="Netflix / 爱奇艺 / B站..."
                list="platform-list"
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
              />
              <datalist id="platform-list">
                {PLATFORMS.map(p => <option key={p} value={p} />)}
              </datalist>
            </div>
          )}

          {/* Rating / Interest Level */}
          {form.status === '未看' ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">期待值 (Watch Value)</label>
              <div className="flex gap-2 items-center">
                {[1, 2, 3, 4, 5].map(star => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => set('interestLevel', form.interestLevel === star ? null : star)}
                    className={`text-2xl transition-transform hover:scale-110 ${
                      form.interestLevel != null && star <= (form.interestLevel ?? 0)
                        ? 'text-rose-400'
                        : 'text-gray-200 hover:text-rose-300'
                    }`}
                  >
                    ❤
                  </button>
                ))}
                {form.interestLevel != null && (
                  <span className="text-sm text-gray-400 ml-1">
                    {['', '随便看看', '有点兴趣', '值得一看', '非常期待', '必看神作'][form.interestLevel ?? 0]}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">评分</label>
              <div className="flex gap-1.5 items-center flex-wrap">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(star => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => set('rating', form.rating === star ? null : star)}
                    className={`text-xl transition-transform hover:scale-110 ${
                      form.rating != null && star <= (form.rating ?? 0)
                        ? 'text-amber-400'
                        : 'text-gray-200 hover:text-amber-300'
                    }`}
                  >
                    ★
                  </button>
                ))}
                {form.rating != null && (
                  <span className="text-xs text-gray-500 ml-1.5 font-medium bg-gray-50 border border-gray-150 px-2 py-0.5 rounded-md">
                    {['', '很差 (1/10)', '差 (2/10)', '较差 (3/10)', '一般 (4/10)', '还行 (5/10)', '较好 (6/10)', '好 (7/10)', '很好 (8/10)', '超棒 (9/10)', '神作 (10/10)'][form.rating ?? 0]}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-gray-700">开始时间</label>
                <label className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={startYearOnly}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setStartYearOnly(checked);
                      if (checked) {
                        const yr = form.startDate ? form.startDate.slice(0, 4) : new Date().getFullYear().toString();
                        set('startDate', yr);
                      } else {
                        const dateVal = form.startDate && /^\d{4}$/.test(form.startDate) ? `${form.startDate}-01-01` : '';
                        set('startDate', dateVal);
                      }
                    }}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 w-3 h-3"
                  />
                  仅选年份
                </label>
              </div>
              {startYearOnly ? (
                <select
                  value={form.startDate || ''}
                  onChange={e => set('startDate', e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition bg-white"
                >
                  <option value="">选择年份</option>
                  {years.map(y => (
                    <option key={y} value={y.toString()}>{y}年</option>
                  ))}
                </select>
              ) : (
                <input
                  type="date"
                  value={form.startDate}
                  onChange={e => set('startDate', e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
                />
              )}
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-gray-700">结束时间</label>
                <label className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={endYearOnly}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setEndYearOnly(checked);
                      if (checked) {
                        const yr = form.endDate ? form.endDate.slice(0, 4) : new Date().getFullYear().toString();
                        set('endDate', yr);
                      } else {
                        const dateVal = form.endDate && /^\d{4}$/.test(form.endDate) ? `${form.endDate}-01-01` : '';
                        set('endDate', dateVal);
                      }
                    }}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 w-3 h-3"
                  />
                  仅选年份
                </label>
              </div>
              {endYearOnly ? (
                <select
                  value={form.endDate || ''}
                  onChange={e => set('endDate', e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition bg-white"
                >
                  <option value="">选择年份</option>
                  {years.map(y => (
                    <option key={y} value={y.toString()}>{y}年</option>
                  ))}
                </select>
              ) : (
                <input
                  type="date"
                  value={form.endDate}
                  onChange={e => set('endDate', e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
                />
              )}
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
            <textarea
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="随便写点什么..."
              rows={2}
              className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition resize-none"
            />
          </div>

          {/* Buttons */}
          <div className="flex gap-3 pt-2">
            {record && onDelete && (
              <button
                type="button"
                onClick={() => { onDelete(record.id); onClose(); }}
                className="px-4 py-2.5 rounded-xl border border-red-200 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
              >
                删除
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors shadow-sm"
            >
              {record ? '保存修改' : '添加记录'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
