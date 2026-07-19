import { useEffect, useState } from 'react';
import { WatchRecord } from '../../../shared/types';
import {
  calculateTotalRuntime,
  getPlatformDistribution,
  getGenreDistribution,
  getEraDistribution
} from '../../../shared/lib/analytics';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer,
  Cell, Radar, RadarChart, PolarGrid, PolarAngleAxis,
  LineChart, Line
} from 'recharts';

interface DashboardProps {
  onClose: () => void;
  records: WatchRecord[];
}

const COLORS = ['#10B981', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899', '#06B6D4', '#F97316'];

const getCategoryEmoji = (category: string) => {
  const defaults: Record<string, string> = {
    "电影": "🎬",
    "纪录片": "🌍",
    "动画": "🦄",
    "美剧": "🇺🇸",
    "英剧": "🇬🇧",
    "日剧": "🇯🇵",
    "韩剧": "🇰🇷",
    "国产剧": "🇨🇳",
    "港剧": "🇭🇰",
    "台剧": "🇹🇼",
    "综艺": "🎭",
  };
  return defaults[category] || "🎬";
};

export default function Dashboard({ onClose, records }: DashboardProps) {
  const [totalStats, setTotalStats] = useState<any>(null);
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [genres, setGenres] = useState<any[]>([]);
  const [eras, setEras] = useState<any[]>([]);
  const [topRatedShow, setTopRatedShow] = useState<WatchRecord | null>(null);
  const [recentActivity, setRecentActivity] = useState<WatchRecord[]>([]);

  useEffect(() => {
    // 计算统计指标
    const runtime = calculateTotalRuntime(records);
    
    const total = records.length;
    const watched = records.filter(r => r.status === '已看').length;
    const unwatched = records.filter(r => r.status === '未看').length;
    const completionRate = total > 0 ? Math.round((watched / total) * 100) : 0;

    setTotalStats({
      total,
      watched,
      unwatched,
      completionRate,
      runtime
    });

    setPlatforms(getPlatformDistribution(records));
    setGenres(getGenreDistribution(records));
    setEras(getEraDistribution(records));

    // 计算最佳资产 (殿堂神作)
    const watchedShows = records.filter(r => r.status === '已看');
    const ratedShows = watchedShows.filter(r => r.rating !== null && r.rating !== undefined);
    
    if (ratedShows.length > 0) {
      // 按照评分降序，完结时间或创建时间降序排序
      const sortedRated = [...ratedShows].sort((a, b) => {
        const ratingDiff = (b.rating || 0) - (a.rating || 0);
        if (ratingDiff !== 0) return ratingDiff;
        const timeA = a.endDate || a.createdAt || '';
        const timeB = b.endDate || b.createdAt || '';
        return timeB.localeCompare(timeA);
      });
      setTopRatedShow(sortedRated[0]);
    } else {
      setTopRatedShow(null);
    }

    // 获取最近看完的 4 条记录
    const sortedWatched = [...watchedShows].sort((a, b) => {
      const timeA = a.endDate || a.createdAt || '';
      const timeB = b.endDate || b.createdAt || '';
      return timeB.localeCompare(timeA);
    });
    setRecentActivity(sortedWatched.slice(0, 4));

    // ESC 键退出
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [records, onClose]);

  if (!totalStats) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col p-4 sm:p-6 bg-[#0B1120] text-gray-300 font-sans overflow-hidden">
      {/* 背景光晕 */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-[#0B1120] to-[#0B1120] pointer-events-none"></div>
      
      {/* 顶部栏 */}
      <div className="flex items-center justify-between mb-6 shrink-0 relative z-10">
        <div className="flex items-center gap-3 select-none">
          <span className="text-4xl">📊</span>
          <div>
            <h2 className="text-2xl font-black text-white tracking-wider uppercase">影视投资看板</h2>
            <p className="text-xs text-gray-500 font-mono">Watch Asset Dashboard</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* 滚动区域 */}
      <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-6 relative z-10">
        
        {/* 数据指标卡片 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 select-none">
          {/* 卡片 1: 总库存 */}
          <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-4 relative overflow-hidden shadow-lg backdrop-blur-sm">
            <div className="absolute top-0 right-0 p-4 opacity-10 text-4xl">📉</div>
            <p className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-1">总库存量</p>
            <h3 className="text-2xl font-black text-white">{totalStats.total} <span className="text-xs text-gray-400 font-normal">部</span></h3>
            <p className="text-[10px] text-gray-400 mt-2">
              已看 <span className="text-green-400 font-bold">{totalStats.watched}</span> 未看 <span className="text-blue-400 font-bold">{totalStats.unwatched}</span>
            </p>
          </div>

          {/* 卡片 2: 变现率 */}
          <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-4 relative overflow-hidden shadow-lg backdrop-blur-sm">
            <div className="absolute top-0 right-0 p-4 opacity-10 text-4xl">🎯</div>
            <p className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-1">库存变现率</p>
            <h3 className="text-2xl font-black text-white">{totalStats.completionRate} <span className="text-xs text-gray-400 font-normal">%</span></h3>
            <div className="w-full bg-gray-800 h-1.5 rounded-full mt-3 overflow-hidden">
              <div className="bg-emerald-500 h-full rounded-full" style={{ width: `${totalStats.completionRate}%` }}></div>
            </div>
          </div>

          {/* 卡片 3: 总时长 */}
          <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-4 relative overflow-hidden shadow-lg backdrop-blur-sm">
            <div className="absolute top-0 right-0 p-4 opacity-10 text-4xl">⌛</div>
            <p className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-1">已变现总时长</p>
            <h3 className="text-2xl font-black text-amber-500">{totalStats.runtime.days} <span className="text-xs text-gray-400 font-normal text-white">天</span> {totalStats.runtime.hours} <span className="text-xs text-gray-400 font-normal text-white">小时</span></h3>
            <p className="text-[10px] text-gray-400 mt-2">总计约 {Math.round(totalStats.runtime.totalMinutes / 60).toLocaleString()} 小时</p>
          </div>

          {/* 卡片 4: 殿堂神作 */}
          <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-4 relative overflow-hidden shadow-lg backdrop-blur-sm animate-fade-in">
            <div className="absolute top-0 right-0 p-4 opacity-10 text-4xl">🏆</div>
            <p className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-1">殿堂神作</p>
            <h3 className="text-lg font-bold text-white truncate" title={topRatedShow?.chineseName || '暂无评分'}>
              {topRatedShow?.chineseName || '暂无评分'}
            </h3>
            <p className="text-[10px] text-gray-400 mt-2">
              {topRatedShow ? `个人评分 ⭐ ${topRatedShow.rating}.0` : '期待你的第一个打分'}
            </p>
          </div>
        </div>

        {/* 图表展示区 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 厂牌持仓 Top 10 */}
          <div className="bg-gray-900/40 border border-gray-800 rounded-2xl p-5 shadow-lg backdrop-blur-sm">
            <h4 className="text-sm font-bold text-white mb-4 flex items-center gap-2 select-none">
              <span className="w-1.5 h-3 bg-blue-500 rounded-full"></span> 厂牌来源持仓 (TOP 10)
            </h4>
            <div className="h-[300px] w-full select-none">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  layout="vertical"
                  data={platforms}
                  margin={{ top: 10, right: 10, left: 40, bottom: 5 }}
                >
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="name"
                    stroke="#9CA3AF"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <RechartsTooltip 
                    cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }}
                    contentStyle={{ backgroundColor: '#1F2937', borderColor: '#374151', borderRadius: '8px', color: '#FFF' }}
                  />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={14}>
                    {platforms.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 题材基因雷达 */}
          <div className="bg-gray-900/40 border border-gray-800 rounded-2xl p-5 shadow-lg backdrop-blur-sm">
            <h4 className="text-sm font-bold text-white mb-4 flex items-center gap-2 select-none">
              <span className="w-1.5 h-3 bg-purple-500 rounded-full"></span> 题材基因雷达
            </h4>
            <div className="h-[300px] w-full flex items-center justify-center select-none">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart cx="50%" cy="50%" outerRadius="70%" data={genres}>
                  <PolarGrid stroke="#374151" />
                  <PolarAngleAxis dataKey="name" stroke="#9CA3AF" fontSize={11} />
                  <Radar
                    name="数量"
                    dataKey="value"
                    stroke="#8B5CF6"
                    fill="#8B5CF6"
                    fillOpacity={0.3}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* 年代资产分布 */}
        <div className="bg-gray-900/40 border border-gray-800 rounded-2xl p-5 shadow-lg backdrop-blur-sm">
          <h4 className="text-sm font-bold text-white mb-4 flex items-center gap-2 select-none">
            <span className="w-1.5 h-3 bg-emerald-500 rounded-full"></span> 年代资产分布
          </h4>
          <div className="h-[200px] w-full select-none">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={eras} margin={{ top: 10, right: 20, left: -20, bottom: 5 }}>
                <XAxis dataKey="name" stroke="#9CA3AF" fontSize={11} tickLine={false} />
                <YAxis stroke="#9CA3AF" fontSize={11} tickLine={false} />
                <RechartsTooltip 
                  contentStyle={{ backgroundColor: '#1F2937', borderColor: '#374151', borderRadius: '8px', color: '#FFF' }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#10B981"
                  strokeWidth={3}
                  dot={{ fill: '#10B981', r: 4, strokeWidth: 0 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* 近期动态板块 */}
        <div className="bg-gray-900/40 border border-gray-800 rounded-2xl p-5 shadow-lg backdrop-blur-sm">
          <h4 className="text-sm font-bold text-white mb-4 flex items-center gap-2 select-none">
            <span className="w-1.5 h-3 bg-indigo-500 rounded-full"></span> ⚡ 近期动态
          </h4>
          {recentActivity.length === 0 ? (
            <div className="text-center py-6 text-xs text-gray-500 select-none">
              暂无近期已看影视记录
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {recentActivity.map(item => {
                const watchDate = item.endDate || item.startDate || item.createdAt || '';
                const displayDate = watchDate ? watchDate.slice(5, 10) || watchDate : '未知时间';
                return (
                  <div key={item.id} className="bg-gray-950/40 border border-gray-800/80 rounded-xl p-3.5 flex flex-col justify-between hover:border-indigo-500/50 transition-colors shadow-inner">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span className="text-lg select-none shrink-0">{getCategoryEmoji(item.category)}</span>
                      <div className="min-w-0">
                        <h5 className="text-sm font-semibold text-white truncate" title={item.chineseName}>{item.chineseName}</h5>
                        <p className="text-[10px] text-gray-500 mt-1 font-mono">{displayDate} 看完</p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-gray-900/60 pt-2.5">
                      <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">{item.category}</span>
                      <span className="text-xs text-amber-500 font-bold">
                        {item.rating ? '★'.repeat(item.rating) : '未打分'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
