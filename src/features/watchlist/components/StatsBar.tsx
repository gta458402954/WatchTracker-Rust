import { MediaType, Status, WatchRecord } from '../../../shared/types';
import { STATUS_CONFIG } from '../../../shared/lib/constants';
import { mediaTypeOf, type RegionOption } from '../../../shared/lib/classification';
import type { RegionFilter } from '../../../shared/lib/countryNames';

interface StatsBarProps {
  records: WatchRecord[];
  regionOptions: RegionOption[];
  activeMediaType: MediaType | 'all';
  onMediaTypeChange: (mediaType: MediaType | 'all') => void;
  filterStatus: Status | 'all';
  onFilterStatusChange: (status: Status | 'all') => void;
  activeRegion: RegionFilter;
  onRegionChange: (region: RegionFilter) => void;
  lastSync?: string | null;
  isSyncing?: boolean;
}

export default function StatsBar({ records, regionOptions, activeMediaType, onMediaTypeChange, filterStatus, onFilterStatusChange, activeRegion, onRegionChange, lastSync, isSyncing }: StatsBarProps) {
  const visible = records.filter(record => activeMediaType === 'all' || mediaTypeOf(record) === activeMediaType);

  return <div className="border-b border-gray-100 bg-white">
    <div className="scrollbar-none flex gap-1 overflow-x-auto px-4 pt-4">
      {(['all', '电影', '剧集', '纪录片', '综艺', '动画'] as const).map(type => {
        const count = type === 'all' ? records.length : records.filter(record => mediaTypeOf(record) === type).length;
        const label = type === 'all' ? '全部' : type;
        return <button key={type} onClick={() => onMediaTypeChange(type)} className={`shrink-0 rounded-t-xl border-b-2 px-3 py-2 text-sm font-medium ${activeMediaType === type ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-transparent text-gray-400 hover:bg-gray-50 hover:text-gray-600'}`}>{label} {count}</button>;
      })}
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      {(['all', '在看', '未看', '已看'] as const).map(status => {
        const config = status === 'all' ? { label: '全部', color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-200' } : STATUS_CONFIG[status];
        const count = visible.filter(record => status === 'all' || record.status === status).length;
        return <button key={status} onClick={() => onFilterStatusChange(status)} className={`flex items-center gap-1.5 ${filterStatus === status ? '' : 'opacity-60'}`}><span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${config.bg} ${config.color}`}>{config.label}</span><span className="text-sm font-bold text-gray-700">{count}</span></button>;
      })}
      {regionOptions.length > 0 && <div aria-label="地区筛选" className="flex min-w-0 flex-wrap items-center gap-2 border-l border-gray-200 pl-4">
        <span className="font-medium text-gray-400">地区</span>
        {regionOptions.map(({ code, label, count }) => <button key={code} type="button" aria-pressed={activeRegion === code} onClick={() => onRegionChange(activeRegion === code ? 'all' : code)} className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors ${activeRegion === code ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-white text-gray-500 hover:border-indigo-200 hover:text-indigo-600'}`}>{label} <b>{count}</b></button>)}
      </div>}
      {(lastSync || isSyncing) && <span className="ml-auto text-xs text-gray-400">{isSyncing ? '正在同步…' : `上次同步：${lastSync}`}</span>}
    </div>
  </div>;
}
