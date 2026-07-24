import { useEffect, useMemo, useState } from 'react';
import { WatchRecord } from '../../../shared/types';
import { calculateWatchValue, getGenreDistribution } from '../../../shared/lib/analytics';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface DashboardProps { onClose: () => void; records: WatchRecord[]; }
type DateRange = 'week' | 'month' | 'year' | 'all';
const RANGE_LABELS: Record<DateRange, string> = { week: '本周', month: '近 30 天', year: '近一年', all: '全部' };

function recordDate(record: WatchRecord) { return new Date(record.endDate || record.createdAt); }
function estimatedMinutes(record: WatchRecord) {
  if (['电影', '纪录片', '动画'].includes(record.category)) return Math.ceil((record.movieDuration || 120 * 60) / 60);
  return record.episodeRuntime || 45;
}
function formatDuration(minutes: number) { return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60 ? `${minutes % 60} 分` : ''}` : `${minutes} 分`; }

export default function Dashboard({ onClose, records }: DashboardProps) {
  const [range, setRange] = useState<DateRange>('all');
  const [tonightMinutes, setTonightMinutes] = useState<30 | 60 | 120 | 0>(120);
  const [recommendationIndex, setRecommendationIndex] = useState(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const scopedRecords = useMemo(() => {
    if (range === 'all') return records;
    const start = new Date();
    if (range === 'week') start.setDate(start.getDate() - 6);
    if (range === 'month') start.setDate(start.getDate() - 29);
    if (range === 'year') start.setFullYear(start.getFullYear() - 1);
    return records.filter(record => recordDate(record) >= start);
  }, [records, range]);

  const summary = useMemo(() => {
    const completed = scopedRecords.filter(record => record.status === '已看');
    const watching = scopedRecords.filter(record => record.status === '在看');
    const pending = scopedRecords.filter(record => record.status === '未看');
    const minutes = completed.reduce((total, record) => total + estimatedMinutes(record), 0);
    return { completed, watching, pending, minutes, completionRate: scopedRecords.length ? Math.round(completed.length / scopedRecords.length * 100) : 0 };
  }, [scopedRecords]);

  const candidates = useMemo(() => records.filter(record => record.status === '未看' && !record.isLocked && (!tonightMinutes || estimatedMinutes(record) <= tonightMinutes))
    .sort((a, b) => calculateWatchValue(b, records) - calculateWatchValue(a, records)), [records, tonightMinutes]);
  const recommendation = candidates.length ? candidates[recommendationIndex % candidates.length] : null;

  const trend = useMemo(() => {
    const count = range === 'week' ? 7 : range === 'month' ? 5 : 12;
    const buckets = Array.from({ length: count }, () => ({ name: '', value: 0, start: new Date() }));
    buckets.forEach((bucket, index) => {
      const date = new Date();
      if (range === 'week') date.setDate(date.getDate() - (count - 1 - index));
      else if (range === 'month') date.setDate(date.getDate() - (count - 1 - index) * 7);
      else date.setMonth(date.getMonth() - (count - 1 - index));
      bucket.start = date;
      bucket.name = range === 'week' ? `${date.getMonth() + 1}/${date.getDate()}` : range === 'month' ? `第 ${index + 1} 周` : `${date.getMonth() + 1} 月`;
    });
    summary.completed.forEach(record => {
      const date = recordDate(record);
      let index = -1;
      if (range === 'week') index = Math.floor((date.getTime() - buckets[0].start.getTime()) / 86_400_000);
      else if (range === 'month') index = Math.floor((date.getTime() - buckets[0].start.getTime()) / (7 * 86_400_000));
      else index = (date.getFullYear() - buckets[0].start.getFullYear()) * 12 + date.getMonth() - buckets[0].start.getMonth();
      if (index >= 0 && index < buckets.length) buckets[index].value++;
    });
    return buckets.map(({ name, value }) => ({ name, value }));
  }, [range, summary.completed]);

  const recentCompleted = useMemo(() => [...summary.completed].sort((a, b) => recordDate(b).getTime() - recordDate(a).getTime()).slice(0, 3), [summary.completed]);
  const genres = useMemo(() => getGenreDistribution(scopedRecords).slice(0, 5), [scopedRecords]);

  return <div className="fixed inset-0 z-50 flex flex-col bg-[#0b1020] p-5 text-slate-200 sm:p-7 overflow-hidden">
    <header className="relative z-10 flex shrink-0 items-center justify-between border-b border-slate-800 pb-5">
      <div><p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-400">WatchTracker</p><h2 className="mt-1 text-2xl font-black text-white">观看概览</h2></div>
      <div className="flex items-center gap-3"><div className="hidden rounded-xl bg-slate-900 p-1 sm:flex">{(Object.keys(RANGE_LABELS) as DateRange[]).map(item => <button key={item} onClick={() => setRange(item)} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${range === item ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-white'}`}>{RANGE_LABELS[item]}</button>)}</div><button onClick={onClose} className="rounded-xl bg-slate-800 p-2 text-slate-400 hover:bg-slate-700 hover:text-white" aria-label="关闭"><svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18 18 6M6 6l12 12" /></svg></button></div>
    </header>
    <div className="relative z-10 mt-4 flex gap-2 overflow-x-auto pb-1 sm:hidden">{(Object.keys(RANGE_LABELS) as DateRange[]).map(item => <button key={item} onClick={() => setRange(item)} className={`shrink-0 rounded-lg px-3 py-2 text-xs font-bold ${range === item ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-400'}`}>{RANGE_LABELS[item]}</button>)}</div>
    <main className="custom-scrollbar relative z-10 mt-5 flex-1 overflow-y-auto pr-2">
      <section className="rounded-2xl border border-indigo-500/30 bg-gradient-to-r from-indigo-950 to-slate-900 p-5">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center"><div><p className="text-xs font-bold text-indigo-300">今晚看什么</p><h3 className="mt-1 text-xl font-black text-white">{recommendation?.chineseName || '暂无符合条件的待看作品'}</h3><p className="mt-2 text-sm text-slate-400">{recommendation ? `${recommendation.category} · 约 ${formatDuration(estimatedMinutes(recommendation))} · ${recommendation.tmdbStatus === 'Ended' ? '已完结' : '待探索'} · 待看价值 ${calculateWatchValue(recommendation, records)}` : '试试放宽时长限制，或添加新的待看记录。'}</p></div><div className="flex flex-wrap items-center gap-2">{([30,60,120,0] as const).map(minutes => <button key={minutes} onClick={() => { setTonightMinutes(minutes); setRecommendationIndex(0); }} className={`rounded-lg px-3 py-2 text-xs font-bold ${tonightMinutes === minutes ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-300'}`}>{minutes || '不限'}</button>)}<button onClick={() => setRecommendationIndex(value => value + 1)} disabled={!recommendation} className="rounded-lg bg-white/10 px-3 py-2 text-xs font-bold text-white hover:bg-white/20 disabled:opacity-40">换一个</button></div></div>
      </section>
      <section className="mt-5 grid gap-4 md:grid-cols-3"><article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5"><p className="text-xs font-bold text-slate-500">本期完成</p><p className="mt-2 text-3xl font-black text-white">{summary.completed.length}<span className="ml-1 text-sm font-medium text-slate-400">部</span></p><p className="mt-2 text-sm text-slate-400">观看约 {formatDuration(summary.minutes)}</p></article><article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5"><p className="text-xs font-bold text-slate-500">待看清单</p><p className="mt-2 text-3xl font-black text-white">{summary.pending.length}<span className="ml-1 text-sm font-medium text-slate-400">部</span></p><p className="mt-2 text-sm text-slate-400">在看 {summary.watching.length} 部</p></article><article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5"><p className="text-xs font-bold text-slate-500">本期完成率</p><p className="mt-2 text-3xl font-black text-emerald-400">{summary.completionRate}%</p><div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-emerald-400" style={{ width: `${summary.completionRate}%` }}/></div></article></section>
      <section className="mt-5 grid gap-5 lg:grid-cols-[1.35fr_0.65fr]"><article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5"><div className="flex items-center justify-between"><h3 className="font-bold text-white">完成趋势</h3><span className="text-xs text-slate-500">{range === 'week' ? '按日' : range === 'month' ? '按周' : '按月'}</span></div><div className="mt-4 h-52"><ResponsiveContainer width="100%" height="100%"><BarChart data={trend}><XAxis dataKey="name" tickLine={false} axisLine={false} stroke="#64748b" fontSize={11}/><YAxis allowDecimals={false} tickLine={false} axisLine={false} stroke="#64748b" fontSize={11}/><Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '10px' }}/><Bar dataKey="value" fill="#818cf8" radius={[5,5,0,0]}/></BarChart></ResponsiveContainer></div></article><article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5"><h3 className="font-bold text-white">正在观看</h3><div className="mt-3 space-y-3">{summary.watching.length ? summary.watching.slice(0,3).map(record => <div key={record.id} className="rounded-xl bg-slate-800/70 p-3"><p className="truncate text-sm font-bold text-white">{record.chineseName}</p><p className="mt-1 text-xs text-slate-400">{record.progress || '尚未记录进度'}{record.totalEpisodes ? ` / ${record.totalEpisodes} 集` : ''}</p></div>) : <p className="py-8 text-center text-sm text-slate-500">暂无正在观看的项目</p>}</div></article></section>
      <section className="mt-5 grid gap-5 pb-5 lg:grid-cols-2"><article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5"><h3 className="font-bold text-white">最近完成</h3><div className="mt-3 divide-y divide-slate-800">{recentCompleted.length ? recentCompleted.map(record => <div key={record.id} className="flex items-center justify-between py-3"><div><p className="text-sm font-semibold text-white">{record.chineseName}</p><p className="mt-1 text-xs text-slate-500">{record.category} · {record.endDate || record.createdAt.slice(0,10)}</p></div><span className="text-sm font-bold text-amber-400">{record.rating ? `★ ${record.rating}` : '未评分'}</span></div>) : <p className="py-8 text-center text-sm text-slate-500">当前范围内暂无完成记录</p>}</div></article><article className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5"><h3 className="font-bold text-white">常看题材</h3><div className="mt-4 space-y-3">{genres.map(genre => <div key={genre.name}><div className="mb-1 flex justify-between text-xs"><span className="text-slate-300">{genre.name}</span><span className="text-slate-500">{genre.value} 部</span></div><div className="h-2 rounded-full bg-slate-800"><div className="h-full rounded-full bg-violet-400" style={{ width: `${genres[0] ? genre.value / genres[0].value * 100 : 0}%` }}/></div></div>)}</div></article></section>
    </main>
  </div>;
}