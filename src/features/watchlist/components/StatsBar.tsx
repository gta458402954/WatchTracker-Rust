import { MediaType, Status, WatchRecord } from '../../../shared/types';
import { STATUS_CONFIG } from '../../../shared/lib/constants';

interface StatsBarProps {
  records: WatchRecord[];
  activeCategory: MediaType | 'all';
  onCategoryChange: (category: MediaType | 'all') => void;
  filterStatus: Status | 'all';
  onFilterStatusChange: (status: Status | 'all') => void;
  activeRegion: string | 'all';
  onRegionChange: (region: string | 'all') => void;
  lastSync?: string | null;
  isSyncing?: boolean;
}

const mediaTypeOf = (record: WatchRecord): MediaType => record.mediaType || (record.category === '综艺' ? '综艺' : record.category === '动画' ? '动画' : record.category === '电影' || record.category === '纪录片' ? '电影' : '剧集');
const REGION_ORDER = ['美国', '韩国', '日本', '英国', '中国大陆', '中国香港', '中国台湾'] as const;
const LEGACY_REGION_BY_CATEGORY: Record<string, string> = {
  美剧: '美国',
  韩剧: '韩国',
  日剧: '日本',
  英剧: '英国',
  国产剧: '中国大陆',
  港剧: '中国香港',
  台剧: '中国台湾',
};

function regionsOf(record: WatchRecord) {
  const tags = record.contentTags?.split(',').map(tag => tag.trim()).filter(Boolean) ?? [];
  const regions = tags.filter(tag => REGION_ORDER.includes(tag as typeof REGION_ORDER[number]));
  return regions.length > 0 ? regions : (LEGACY_REGION_BY_CATEGORY[record.category] ? [LEGACY_REGION_BY_CATEGORY[record.category]] : []);
}

export default function StatsBar({ records, activeCategory, onCategoryChange, filterStatus, onFilterStatusChange, activeRegion, onRegionChange, lastSync, isSyncing }: StatsBarProps) {
  const visible = records.filter(record => activeCategory === 'all' || mediaTypeOf(record) === activeCategory);
  const regionCounts = REGION_ORDER.map(region => ({
    region,
    count: visible.filter(record => (filterStatus === 'all' || record.status === filterStatus) && regionsOf(record).includes(region)).length,
  })).filter(item => item.count > 0);

  return <div className="border-b border-gray-100 bg-white">
    <div className="scrollbar-none flex gap-1 overflow-x-auto px-4 pt-4">
      {(['all', '电影', '剧集', '综艺', '动画'] as const).map(type => {
        const count = type === 'all' ? records.length : records.filter(record => mediaTypeOf(record) === type).length;
        const label = type === 'all' ? '全部' : type;
        return <button key={type} onClick={() => onCategoryChange(type)} className={`shrink-0 rounded-t-xl border-b-2 px-3 py-2 text-sm font-medium ${activeCategory === type ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-transparent text-gray-400 hover:bg-gray-50 hover:text-gray-600'}`}>{label} {count}</button>;
      })}
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      {(['all', '在看', '未看', '已看'] as const).map(status => {
        const config = status === 'all' ? { label: '全部', color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-200' } : STATUS_CONFIG[status];
        const count = visible.filter(record => status === 'all' || record.status === status).length;
        return <button key={status} onClick={() => onFilterStatusChange(status)} className={`flex items-center gap-1.5 ${filterStatus === status ? '' : 'opacity-60'}`}><span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${config.bg} ${config.color}`}>{config.label}</span><span className="text-sm font-bold text-gray-700">{count}</span></button>;
      })}
      {regionCounts.length > 0 && <div className="flex items-center gap-2 border-l border-gray-200 pl-4">
        <span className="font-medium text-gray-400">地区</span>
        {regionCounts.map(({ region, count }) => <button key={region} type="button" aria-pressed={activeRegion === region} onClick={() => onRegionChange(activeRegion === region ? 'all' : region)} className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors ${activeRegion === region ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-white text-gray-500 hover:border-indigo-200 hover:text-indigo-600'}`}>{region} <b>{count}</b></button>)}
      </div>}
      {(lastSync || isSyncing) && <span className="ml-auto text-xs text-gray-400">{isSyncing ? '正在同步…' : `上次同步：${lastSync}`}</span>}
    </div>
  </div>;
}
