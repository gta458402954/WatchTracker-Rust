import React from 'react';
import { WatchRecord, Status } from '../types';
import { STATUS_CONFIG, formatMovieProgress } from '../utils/constants';

interface RecordCardProps {
  record: WatchRecord;
  onEdit: (record: WatchRecord) => void;
  onDelete: (id: string) => void;
  onStatusChange: (id: string, status: Status) => void;
  onProgressChange?: (id: string, progress: string) => void;  // 新增：进度更新回调
  getEmoji?: (category: string) => string;  // 获取分类 emoji
}

export default function RecordCard({ record, onEdit, onDelete, onStatusChange, onProgressChange, getEmoji }: RecordCardProps) {
  const statusConf = STATUS_CONFIG[record.status];

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
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-semibold text-gray-900 truncate">
              {record.chineseName || record.originalName}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
              {getEmoji ? getEmoji(record.category) : record.category}
              {record.releaseYear && ` · ${record.releaseYear}`}
            </span>
          </div>
          {record.originalName && record.chineseName && (
            <p className="text-xs text-gray-400 mt-0.5 truncate">{record.originalName}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
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
        </div>
      </div>

      {/* Status & Progress */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={record.status}
          onChange={e => onStatusChange(record.id, e.target.value as Status)}
          className={`text-xs px-2 py-0.5 rounded-full border font-medium cursor-pointer outline-none ${statusConf.bg} ${statusConf.color}`}
        >
          {(['在看', '未看', '已看'] as Status[]).map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        {/* 电影时长显示 (红圈位置) */}
        {record.category === '电影' && record.movieDuration && (
          <span className="text-xs text-gray-400">
            {Math.round(record.movieDuration / 60)} min
          </span>
        )}

        {episodeOptions.length > 0 ? (
          <select
            value={currentEpisode?.toString() || ''}
            onChange={handleEpisodeChange}
            className="text-xs px-2 py-0.5 bg-orange-50 text-orange-600 border border-orange-100 rounded-full cursor-pointer outline-none"
          >
            <option value="">选择集数</option>
            {episodeOptions.map(ep => (
              <option key={ep} value={ep.toString()}>第{ep}集</option>
            ))}
          </select>
        ) : record.category === '电影' && record.movieProgress !== null ? (
          <button
            onClick={() => onEdit(record)}
            className="text-xs px-2 py-0.5 bg-purple-50 text-purple-600 border border-purple-100 rounded-full cursor-pointer hover:bg-purple-100 transition-colors"
            title="点击编辑电影进度"
          >
            {formatMovieProgress(record.movieProgress, record.movieDuration)}
          </button>
        ) : progressDisplay && (
          <span className="text-xs px-2 py-0.5 bg-orange-50 text-orange-600 border border-orange-100 rounded-full">
            {progressDisplay}
          </span>
        )}
        {record.platform && (
          <span className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 border border-indigo-100 rounded-full">
            {record.platform}
          </span>
        )}
      </div>

      {/* Rating */}
      <div className="flex items-center justify-between text-sm">
        <div className="text-amber-500 text-sm tracking-wider">
          {record.rating !== null
            ? <>{'★'.repeat(record.rating)}<span className="text-gray-300">{'★'.repeat(5 - record.rating)}</span></>
            : <span className="text-gray-300 text-xs">暂未评分</span>
          }
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
