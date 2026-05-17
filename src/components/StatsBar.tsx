import { Category, Status, WatchRecord } from '../types';
import { STATUS_CONFIG } from '../utils/constants';
import type { CategoryItem } from '../hooks/useCategories';

interface StatsBarProps {
  records: WatchRecord[];
  categories: CategoryItem[];
  activeCategory: Category | 'all';
  onCategoryChange: (cat: Category | 'all') => void;
  filterStatus: Status | 'all';
  onFilterStatusChange: (status: Status | 'all') => void;
  lastSync?: string | null;
  isSyncing?: boolean;
}

export default function StatsBar({ 
  records, 
  categories, 
  activeCategory, 
  onCategoryChange,
  filterStatus,
  onFilterStatusChange,
  lastSync,
  isSyncing
}: StatsBarProps) {
  const statusCount = (status: Status | 'all') =>
    records.filter(r => {
      const catMatch = activeCategory === 'all' || r.category === activeCategory;
      const statusMatch = status === 'all' || r.status === status;
      return catMatch && statusMatch;
    }).length;

  return (
    <div className="bg-white border-b border-gray-100">
      {/* Category Tabs */}
      <div className="flex overflow-x-auto scrollbar-none px-4 gap-1 pt-4">
        <button
          onClick={() => onCategoryChange('all')}
          title={`全部 (${records.length})`}
          className={`flex-shrink-0 px-3 py-2 rounded-t-xl text-sm font-medium transition-colors border-b-2 ${
            activeCategory === 'all'
              ? 'text-indigo-700 border-indigo-600 bg-indigo-50'
              : 'text-gray-400 border-transparent hover:text-gray-600 hover:bg-gray-50'
          }`}
        >
          全部
        </button>
        {categories.map(cat => {
          const count = records.filter(r => r.category === cat.name).length;
          return (
            <button
              key={cat.name}
              onClick={() => onCategoryChange(cat.name)}
              title={`${cat.name} (${count})`}
              className={`flex-shrink-0 px-3 py-2 rounded-t-xl text-sm font-medium transition-colors border-b-2 ${
                activeCategory === cat.name
                  ? 'text-indigo-700 border-indigo-600 bg-indigo-50'
                  : 'text-gray-400 border-transparent hover:text-gray-600 hover:bg-gray-50'
              }`}
            >
              {cat.name}
            </button>
          );
        })}
      </div>

      {/* Status Stats & Filter */}
      <div className="flex gap-4 px-4 py-3">
        {(['all', '在看', '未看', '已看'] as const).map(s => {
          const isAll = s === 'all';
          const conf = isAll 
            ? { label: '全部', color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-200' }
            : STATUS_CONFIG[s as Status];
          const count = statusCount(s);
          const active = filterStatus === s;
          
          return (
            <button
              key={s}
              onClick={() => onFilterStatusChange(s)}
              className={`flex items-center gap-1.5 hover:opacity-80 transition-opacity ${active ? 'opacity-100' : 'opacity-60'}`}
            >
              <span className={`text-xs px-2.5 py-0.5 rounded-full border font-semibold transition-all ${conf.bg} ${conf.color} ${active ? 'ring-2 ring-offset-1 ring-indigo-200 shadow-sm' : ''}`}>
                {conf.label}
              </span>
              <span className={`text-sm font-bold transition-colors ${active ? 'text-gray-900' : 'text-gray-400'}`}>
                {count}
              </span>
            </button>
          );
        })}

        {/* Sync Status */}
        {(lastSync || isSyncing) && (
          <div className="ml-auto flex items-center gap-2 text-[10px] text-gray-400">
            {isSyncing ? (
              <div className="flex items-center gap-1.5 text-indigo-500 animate-pulse">
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span className="font-medium">正在同步...</span>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <svg className="w-3 h-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span>上次同步: {lastSync}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
