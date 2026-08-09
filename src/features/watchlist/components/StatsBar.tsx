import { MediaType, Status, WatchRecord } from '../../../shared/types';
import { STATUS_CONFIG } from '../../../shared/lib/constants';
import { mediaTypeOf, type RegionOption } from '../../../shared/lib/classification';
import type { RegionFilter } from '../../../shared/lib/countryNames';

interface StatsBarProps {
  records: WatchRecord[];
  regionOptions: RegionOption[];
  activeMediaTypes: MediaType[];
  onMediaTypeChange: (mediaType: MediaType | 'all') => void;
  filterStatuses: Status[];
  onFilterStatusChange: (status: Status | 'all') => void;
  activeRegions: RegionFilter[];
  onRegionChange: (region: RegionFilter) => void;
  lastSync?: string | null;
  isSyncing?: boolean;
}

export default function StatsBar({ records, regionOptions, activeMediaTypes, onMediaTypeChange, filterStatuses, onFilterStatusChange, activeRegions, onRegionChange, lastSync, isSyncing }: StatsBarProps) {
  const visible = records.filter(record => activeMediaTypes.length === 0 || activeMediaTypes.includes(mediaTypeOf(record)));

  return <div className="border-b border-gray-100 bg-white">
    <div className="scrollbar-none flex gap-1 overflow-x-auto px-4 pt-4">
      {(['all', '电影', '剧集', '纪录片', '综艺', '动画'] as const).map(type => {
        const count = type === 'all' ? records.length : records.filter(record => mediaTypeOf(record) === type).length;
        const label = type === 'all' ? '全部' : type;
        const selected = type === 'all' ? activeMediaTypes.length === 0 : activeMediaTypes.includes(type);
        return <button key={type} aria-pressed={selected} onClick={() => onMediaTypeChange(type)} className={`shrink-0 rounded-t-xl border-b-2 px-3 py-2 text-sm font-medium ${selected ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-transparent text-gray-400 hover:bg-gray-50 hover:text-gray-600'}`}>{label} {count}</button>;
      })}
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      {(['all', '在看', '未看', '已看'] as const).map(status => {
        const config = status === 'all' ? { label: '全部', color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-200' } : STATUS_CONFIG[status];
        const count = visible.filter(record => status === 'all' || record.status === status).length;
        const selected = status === 'all' ? filterStatuses.length === 0 : filterStatuses.includes(status);
        return <button key={status} aria-pressed={selected} onClick={() => onFilterStatusChange(status)} className={`flex items-center gap-1.5 ${selected ? '' : 'opacity-60'}`}><span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${config.bg} ${config.color}`}>{config.label}</span><span className="text-sm font-bold text-gray-700">{count}</span></button>;
      })}
      {regionOptions.length > 0 && <div aria-label="地区筛选" className="flex min-w-0 flex-wrap items-center gap-2 border-l border-gray-200 pl-4">
        <span className="font-medium text-gray-400">地区</span>
        {regionOptions.map(({ code, label, count }) => { const selected = activeRegions.includes(code); return <button key={code} type="button" aria-pressed={selected} onClick={() => onRegionChange(selected && activeRegions.length === 1 ? 'all' : code)} className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors ${selected ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-white text-gray-500 hover:border-indigo-200 hover:text-indigo-600'}`}>{label} <b>{count}</b></button>; })}
      </div>}
      {(lastSync || isSyncing) && <span className="ml-auto text-xs text-gray-400">{isSyncing ? '正在同步…' : `上次同步：${lastSync}`}</span>}
    </div>
  </div>;
}
