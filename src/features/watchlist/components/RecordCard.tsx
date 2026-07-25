import React from 'react';
import { WatchRecord, Status } from '../../../shared/types';
import { STATUS_CONFIG, formatMovieProgress } from '../../../shared/lib/constants';
import { open } from '@tauri-apps/plugin-shell';

const translateGenre = (genre: string): string => {
  const mapping: Record<string, string> = {
    // 电视剧类型 (TV Show Genres)
    "Sci-Fi & Fantasy": "科幻/奇幻",
    "Action & Adventure": "动作/冒险",
    "War & Politics": "战争/政治",
    "Reality": "真人秀",
    "Soap": "肥皂剧",
    "Talk": "脱口秀",
    
    // 电影及通用类型 (Movie & Common Genres)
    "Science Fiction": "科幻",
    "Fantasy": "奇幻",
    "Action": "动作",
    "Adventure": "冒险",
    "Drama": "剧情",
    "Comedy": "喜剧",
    "Thriller": "惊悚",
    "Horror": "恐怖",
    "Mystery": "悬疑",
    "Crime": "犯罪",
    "Documentary": "纪录片",
    "Animation": "动画",
    "Family": "家庭",
    "History": "历史",
    "Music": "音乐",
    "Romance": "爱情",
    "TV Movie": "电视电影",
    "War": "战争",
    "Western": "西部",
  };
  return mapping[genre] || genre;
};

interface RecordCardProps {
  record: WatchRecord;
  onEdit: (record: WatchRecord) => void;
  onDelete: (id: string) => void;
  onStatusChange: (id: string, status: Status) => void;
  onProgressChange?: (id: string, progress: string) => void;  // 新增：进度更新回调
  onLockToggle?: (id: string) => void;
  getEmoji?: (category: string) => string;  // 获取分类 emoji
}

export default function RecordCard({ record, onEdit, onDelete, onStatusChange, onProgressChange, onLockToggle, getEmoji }: RecordCardProps) {
  const statusConf = STATUS_CONFIG[record.status];
  const detailTags = (record.mediaType || record.category) === '电影' ? record.genres : (record.contentTags || record.genres);


  // 计算显示的进度文本
  const getProgressDisplay = () => {
    if (!record.progress) return null;
    if (!record.totalEpisodes) return record.progress;

    // 完结/在看 时显示为 "完结 (24集)" 格式
    if (record.progress === '完结' || record.progress === '在看') {
      return `${record.progress} (${record.totalEpisodes}集)`;
    }
    // 其他进度显示为 "第12集 / 24集" 格式
    return `${record.progress} / ${record.totalEpisodes}集`;
  };

  const progressDisplay = getProgressDisplay();

  // 生成集数选项（用于下拉选择）
  const getEpisodeOptions = (): number[] => {
    if (!record.totalEpisodes || record.totalEpisodes <= 0) return [];
    return Array.from({ length: record.totalEpisodes }, (_, i) => i + 1);
  };

  // 从进度文本中提取当前集数
  const getCurrentEpisode = (): number | null => {
    if (!record.progress) return null;
    // 匹配 "第X集" 或纯数字
    const match = record.progress.match(/第?(\d+)集?/);
    if (match) return parseInt(match[1], 10);
    return null;
  };

  const episodeOptions = getEpisodeOptions();
  const currentEpisode = getCurrentEpisode();

  // 处理集数变更
  const handleEpisodeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value) {
      onProgressChange?.(record.id, `第${value}集`);
    }
  };

  return (
    <div className="relative flex flex-col gap-3 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="mb-2">
            <div className="text-base font-semibold text-gray-900 truncate leading-tight" title={record.chineseName || record.originalName}>
              {record.chineseName || record.originalName}
            </div>
            {record.originalName && record.chineseName && (
              <div className="text-xs text-gray-400 truncate mt-0.5" title={record.originalName}>
                {record.originalName}
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
              {record.mediaType || (getEmoji ? getEmoji(record.category) : record.category)}
              {record.releaseYear && ` · ${record.releaseYear}`}
            </span>
            {detailTags && (() => {
              const genresList = detailTags.split(',').map(g => translateGenre(g.trim())).filter(g => g && g !== '未知' && g !== '未知类型');
              const hasOthers = genresList.some(g => g !== '剧情');
              const displayList = hasOthers ? genresList.filter(g => g !== '剧情') : genresList;
              const displayStr = displayList.slice(0, 2).join(',');
              
              return displayStr ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-50 text-slate-500 border border-slate-200 truncate max-w-[120px]" title={detailTags}>
                  {displayStr}
                </span>
              ) : null;
            })()}
            {record.imdbId && (
              <a
                href={`https://www.imdb.com/title/${record.imdbId}/`}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] px-1.5 py-0.5 rounded bg-[#f5c518] text-black font-black hover:bg-[#e2b616] transition-colors shadow-sm cursor-pointer"
                title="View on IMDb"
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  try {
                    await open(`https://www.imdb.com/title/${record.imdbId}/`);
                  } catch (err) {
                    console.error("Failed to open URL", err);
                  }
                }}
              >
                IMDb {record.imdbRating ? ` ${record.imdbRating.toFixed(1)}` : ''}
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onLockToggle?.(record.id)}
            className={`p-1.5 rounded-lg transition-colors ${
              record.isLocked 
                ? 'text-amber-500 hover:bg-amber-50 hover:text-amber-600' 
                : 'text-gray-300 hover:bg-gray-100 hover:text-gray-500'
            }`}
            title={record.isLocked ? "点击解锁条目" : "点击锁定条目"}
          >
            {record.isLocked ? (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
              </svg>
            )}
          </button>
          {!record.isLocked && (
            <>
              <button
                onClick={() => onEdit(record)}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                title="编辑"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                onClick={() => onDelete(record.id)}
                className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                title="删除"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Status & Progress */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={record.status}
          onChange={e => onStatusChange(record.id, e.target.value as Status)}
          disabled={record.isLocked}
          className={`text-xs px-2 py-0.5 rounded-full border font-medium cursor-pointer outline-none ${statusConf.bg} ${statusConf.color} ${record.isLocked ? 'opacity-70 cursor-not-allowed' : ''}`}
        >
          {(['在看', '未看', '已看'] as Status[]).map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        {/* 电影时长显示 (红圈位置) */}
        {(record.mediaType || record.category) === '电影' && record.movieDuration && (
          <span className="text-xs text-gray-400">
            {Math.round(record.movieDuration / 60)} min
          </span>
        )}

        {episodeOptions.length > 0 ? (
          <select
            value={currentEpisode?.toString() || ''}
            onChange={handleEpisodeChange}
            disabled={record.isLocked}
            className={`text-xs px-2 py-0.5 bg-orange-50 text-orange-600 border border-orange-100 rounded-full cursor-pointer outline-none ${record.isLocked ? 'opacity-70 cursor-not-allowed' : ''}`}
          >
            <option value="">选择集数</option>
            {episodeOptions.map(ep => (
              <option key={ep} value={ep.toString()}>第{ep}集</option>
            ))}
          </select>
        ) : (record.mediaType || record.category) === '电影' && record.movieProgress !== null ? (
          <button
            onClick={() => !record.isLocked && onEdit(record)}
            disabled={record.isLocked}
            className={`text-xs px-2 py-0.5 bg-purple-50 text-purple-600 border border-purple-100 rounded-full cursor-pointer transition-colors ${record.isLocked ? 'opacity-70 cursor-not-allowed' : 'hover:bg-purple-100'}`}
            title={record.isLocked ? "条目已锁定，无法编辑" : "点击编辑电影进度"}
          >
            {formatMovieProgress(record.movieProgress, record.movieDuration)}
          </button>
        ) : progressDisplay && (
          <span className="text-xs px-2 py-0.5 bg-orange-50 text-orange-600 border border-orange-100 rounded-full">
            {progressDisplay}
          </span>
        )}
        {record.platform && (record.mediaType || record.category) !== '电影' && (
          <span className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 border border-indigo-100 rounded-full">
            {record.platform}
          </span>
        )}
      </div>

      {/* Rating */}
      <div className="flex items-center justify-between text-sm select-none">
        <div className="flex items-center gap-1 font-medium">
          {record.rating !== null ? (
            <>
              <span className="text-amber-500 text-sm">★</span>
              <span className="font-bold text-amber-600 text-sm">{record.rating}</span>
              <span className="text-gray-400 text-xs">/10</span>
            </>
          ) : (
            <span className="text-gray-300 text-xs">暂未评分</span>
          )}
        </div>
        <div className="text-xs text-gray-400 flex items-center gap-1">
          {record.startDate && <span>▶ {record.startDate}</span>}
          {record.endDate && <span>⏹ {record.endDate}</span>}
        </div>
      </div>

      {/* Notes */}
      {record.notes && (
        <p className="text-xs text-gray-500 border-t pt-2 mt-1 line-clamp-2">{record.notes}</p>
      )}
    </div>
  );
}
