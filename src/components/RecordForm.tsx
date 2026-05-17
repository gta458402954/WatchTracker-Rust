import React, { useState, useEffect, useRef } from 'react';
import { WatchRecord, Category, Status } from '../types';
import { STATUSES, PLATFORMS, getEmptyRecord, parseTimeToSeconds, formatMovieTime } from '../utils/constants';
import type { CategoryItem } from '../hooks/useCategories';
import { downloadPosterAsync, getSettingAsync, safeDecrypt, searchTmdbAsync, getTmdbDetailAsync } from '../utils/database';

interface RecordFormProps {
  record?: WatchRecord | null;
  categories: CategoryItem[];
  onSave: (data: Omit<WatchRecord, 'id' | 'createdAt'>) => void;
  onClose: () => void;
}

const isTVCategory = (cat: Category) =>
  ['美剧', '英剧', '日剧', '韩剧', '国产剧', '港剧', '台剧', '综艺', '泰剧', '纪录片', '动画'].some(k => cat.includes(k));

const isMovieCategory = (cat: Category) =>
  !isTVCategory(cat);

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

export default function RecordForm({ record, categories, onSave, onClose }: RecordFormProps) {
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
          category: record.category,
          notes: record.notes,
        }
      : getEmptyRecord()
  );

  // 电影时间输入状态（秒）
  const [movieProgressStr, setMovieProgressStr] = useState('');
  const [movieDurationStr, setMovieDurationStr] = useState('');

  // TMDB 搜索相关状态
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [seasons, setSeasons] = useState<any[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<any | null>(null);

  // 初始化时间输入框显示
  useEffect(() => {
    setMovieProgressStr(form.movieProgress !== null ? formatMovieTime(form.movieProgress) : '');
    setMovieDurationStr(form.movieDuration !== null ? formatMovieTime(form.movieDuration) : '');
  }, [form.movieProgress, form.movieDuration]);

  // 获取解密后的 TMDB API Key
  async function getTMDBApiKey() {
    const encrypted = await getSettingAsync('tmdb_api_key');
    if (!encrypted) return null;
    try {
      const decrypted = await safeDecrypt(encrypted);
      if (decrypted === '__ERR_DECRYPT_VERSION_MISMATCH__' || decrypted === '__ERR_DECRYPT_FAILED__') {
        console.warn('[TMDB] API Key unavailable (decryption failed).');
        return null;
      }
      return decrypted;
    } catch (e) {
      console.error('[TMDB] Decryption failed:', e);
      return null;
    }
  }

  async function handleTMDBSearch() {
    let query = form.chineseName || form.originalName;
    if (!query) return;

    // 智能清洗搜索词：去掉“第x季”、“Season x”等干扰词，因为 TMDB 搜索剧集名时不带季节
    query = query
      .replace(/第\s*\d+\s*季/g, '')
      .replace(/Season\s*\d+/gi, '')
      .replace(/第\s*[一二三四五六七八九十]+\s*季/g, '')
      .trim();

    const API_KEY = await getTMDBApiKey();
    if (!API_KEY) {
      setSearchError('请先在设置中配置 TMDB API KEY');
      setShowResults(true);
      return;
    }

    setIsSearching(true);
    setShowResults(true);
    setSearchError(null);
    setSeasons([]);
    setSelectedSeries(null);
    const isTV = isTVCategory(form.category);
    const type = isTV ? 'tv' : 'movie';

    try {
      console.log(`[TMDB] Searching ${type} for: ${query}`);
      const result = await searchTmdbAsync({
        apiKey: API_KEY,
        query,
        mediaType: type,
        language: 'zh-CN'
      });

      if (!result.success) {
        setSearchError(result.error || '搜索失败');
        return;
      }

      setSearchResults(result.results || []);
    } catch (err: any) {
      setSearchError(err?.toString() || '未知搜索错误');
    } finally {
      setIsSearching(false);
    }
  }

  async function handleSelectResult(item: any) {
    const API_KEY = await getTMDBApiKey();
    if (!API_KEY) return;

    const isTV = isTVCategory(form.category);

    try {
      setSearchError(null);
      const type = isTV ? 'tv' : 'movie';
      const result = await getTmdbDetailAsync({
        apiKey: API_KEY,
        id: item.id,
        mediaType: type,
        language: 'zh-CN'
      });

      if (!result.success || !result.data) {
        setSearchError(result.error || '获取详情失败');
        return;
      }
      const detail = result.data;

      if (isTV && detail.seasons && detail.seasons.length > 0) {
        // 如果是电视剧且有多季，展示季节选择
        setSelectedSeries(detail);
        setSeasons(detail.seasons.filter((s: any) => s.season_number > 0)); // 过滤掉第 0 季（通常是花絮）
        return;
      }

      // 提取年份与海报
      const dateStr = detail.release_date || detail.first_air_date || '';
      const year = dateStr.split('-')[0] || null;
      const poster = detail.poster_path || item.poster_path || null;

      // 触发后台下载海报
      if (poster) downloadPosterAsync(poster);

      // 电影或单季剧集直接填充
      const updates: Partial<typeof form> = {
        chineseName: detail.name || detail.title || item.name || item.title || form.chineseName,
        originalName: detail.original_name || detail.original_title || item.original_name || item.original_title || form.originalName,
        releaseYear: year,
        posterPath: poster,
      };

      if (isTV) {
        updates.totalEpisodes = detail.number_of_episodes || null;
      } else {
        updates.movieDuration = detail.runtime ? detail.runtime * 60 : null;
      }

      setForm(prev => ({ ...prev, ...updates }));
      setShowResults(false);
    } catch (err) {
      console.error('[TMDB] Detail error:', err);
    }
  }

  async function handleSelectSeason(season: any) {
    if (!selectedSeries) return;

    const seriesName = selectedSeries.name || selectedSeries.title;
    const seriesOriginalName = selectedSeries.original_name || selectedSeries.original_title;
    const year = season.air_date ? season.air_date.split('-')[0] : (selectedSeries.first_air_date?.split('-')[0] || null);
    const poster = season.poster_path || selectedSeries.poster_path || null;

    // 触发后台下载海报
    if (poster) downloadPosterAsync(poster);

    setForm(prev => ({
      ...prev,
      chineseName: `${seriesName} ${season.name || `第 ${season.season_number} 季`}`,
      originalName: `${seriesOriginalName} Season ${season.season_number}`,
      totalEpisodes: season.episode_count || null,
      releaseYear: year,
      posterPath: poster,
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

  function handleProgressChange(e: React.ChangeEvent<HTMLInputElement>) {
    set('progress', e.target.value);
  }

  function handleProgressBlur() {
    const resolved = smartProgress(form.progress);
    if (resolved !== form.progress) {
      set('progress', resolved);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.chineseName.trim() && !form.originalName.trim()) return;
    onSave(form);
    onClose();
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
          {/* Category */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">分类</label>
            <div className="flex gap-2 flex-wrap">
              {categories.map(cat => (
                <button
                  key={cat.name}
                  type="button"
                  onClick={() => {
                    set('category', cat.name);
                    set('progress', '');
                    set('movieProgress', null);
                    set('movieDuration', null);
                    setMovieProgressStr('');
                    setMovieDurationStr('');
                  }}
                  className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors border ${
                    form.category === cat.name
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  {cat.name}
                </button>
              ))}
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
                          <div className="text-sm font-bold text-gray-900 truncate">{item.title || item.name}</div>
                          <div className="text-xs text-gray-400 truncate">{item.original_title || item.original_name}</div>
                          <div className="text-[10px] text-gray-400 mt-1">
                            {item.release_date || item.first_air_date || '未知日期'}
                            {item.vote_average > 0 && ` · ⭐ ${item.vote_average.toFixed(1)}`}
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
                  if (isMovieCategory(form.category) && newStatus === '已看' && form.movieDuration) {
                    set('movieProgress', form.movieDuration);
                    setMovieProgressStr(formatMovieTime(form.movieDuration));
                  }

                  // 如果是电视剧且改为“已看”，自动填充最后一集
                  if (!isMovieCategory(form.category) && newStatus === '已看') {
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
            {!isMovieCategory(form.category) && (
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
                  placeholder={isTVCategory(form.category) ? '如 S01、12、完' : '如 完结、在看'}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
                />
              </div>
            )}
          </div>

          {/* Total Episodes - 仅电视剧/综艺显示 */}
          {isTVCategory(form.category) && (
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
          {isMovieCategory(form.category) && (
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

          {/* Quick progress hint - Optional, keeping for clarity if needed, or remove completely */}
          {/* Platform */}
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

          {/* Rating */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">评分</label>
            <div className="flex gap-2 items-center">
              {[1, 2, 3, 4, 5].map(star => (
                <button
                  key={star}
                  type="button"
                  onClick={() => set('rating', form.rating === star ? null : star)}
                  className={`text-2xl transition-transform hover:scale-110 ${
                    form.rating !== null && star <= form.rating
                      ? 'text-amber-400'
                      : 'text-gray-200 hover:text-amber-300'
                  }`}
                >
                  ★
                </button>
              ))}
              {form.rating !== null && (
                <span className="text-sm text-gray-400 ml-1">
                  {['', '一般', '还行', '不错', '很好', '极好'][form.rating]}
                </span>
              )}
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">开始时间</label>
              <input
                type="date"
                value={form.startDate}
                onChange={e => set('startDate', e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">结束时间</label>
              <input
                type="date"
                value={form.endDate}
                onChange={e => set('endDate', e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
              />
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
