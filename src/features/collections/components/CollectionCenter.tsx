import { useEffect, useMemo, useRef, useState } from 'react';
import type { CollectionMember, WatchCollection, WatchRecord } from '../../../shared/types';
import { displayTitlesOf } from '../../../shared/lib/displayTitle';
import { useAccessibleDialog } from '../../../shared/lib/useAccessibleDialog';
import SafePosterImage from '../../watchlist/components/SafePosterImage';
import { getTmdbDetailAsync, searchTmdbAsync } from '../../../shared/lib/database';
import type { TmdbMedia, TmdbSeason } from '../../../shared/lib/classification';
import { getEmptyRecord } from '../../../shared/lib/constants';
import { chronologicalRecords, defaultMissingSeasonNumbers, locallyKnownSeries, readIdentityCache, seasonNumberOf, writeIdentityCache } from '../lib/seriesDiscovery';

interface Props {
  records: WatchRecord[];
  collections: WatchCollection[];
  members: CollectionMember[];
  onCreate: (name: string, description: string | null, collectionKind?: WatchCollection['collectionKind']) => Promise<WatchCollection>;
  onUpdate: (collection: WatchCollection, name: string, description: string | null) => Promise<WatchCollection>;
  onSetOrderMode: (collection: WatchCollection, mode: WatchCollection['orderMode']) => Promise<WatchCollection>;
  onDelete: (collection: WatchCollection) => Promise<void>;
  onAddMembers: (collection: WatchCollection, recordIds: string[]) => Promise<void>;
  onRemoveMember: (member: CollectionMember) => Promise<void>;
  onReorder: (collection: WatchCollection, recordIds: string[]) => Promise<void>;
  onApplySuggestion: (name: string, sourceKind: 'tmdb-movie-collection' | 'tmdb-tv-show', sourceKey: string, recordIds: string[]) => Promise<void>;
  onCreateMissingSeasons: (collection: WatchCollection, records: WatchRecord[]) => Promise<void>;
  onEditRecord: (record: WatchRecord) => void;
  onClose: () => void;
  onNotify: (tone: 'success' | 'warning' | 'error' | 'info', message: string) => void;
}

interface CollectionSuggestion { name: string; sourceKind: 'manual' | 'tmdb-movie-collection' | 'tmdb-tv-show'; sourceKey: string; recordIds: string[] }

function errorText(error: unknown): string {
  const value = String(error);
  if (value.includes('collection_name_duplicate')) return '已经存在同名收藏集。';
  if (value.includes('stale_collection')) return '收藏集已在其他操作中更新，请重新尝试。';
  if (value.includes('stale_collection_member')) return '成员关系已变化，请重新尝试。';
  return '收藏集操作失败，请稍后重试。';
}

export default function CollectionCenter(props: Props) {
  const { records, collections, members, onClose, onNotify } = props;
  const [selectedId, setSelectedId] = useState<string | null>(collections[0]?.id ?? null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [newCollectionKind, setNewCollectionKind] = useState<WatchCollection['collectionKind']>('manual');
  const [recordSearch, setRecordSearch] = useState('');
  const [selectedRecords, setSelectedRecords] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });
  const cancelScanRef = useRef(false);
  const [suggestions, setSuggestions] = useState<CollectionSuggestion[]>([]);
  const [seasonDetail, setSeasonDetail] = useState<TmdbMedia | null>(null);
  const [selectedSeasonNumbers, setSelectedSeasonNumbers] = useState<Set<number>>(() => new Set());
  const [showSpecials, setShowSpecials] = useState(false);
  const [linkingRelated, setLinkingRelated] = useState(false);
  const [relatedSearch, setRelatedSearch] = useState('');
  const [relatedResults, setRelatedResults] = useState<TmdbMedia[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useAccessibleDialog<HTMLDivElement>({ onEscape: onClose, initialFocusRef: closeRef });

  useEffect(() => {
    if (selectedId === null || collections.some(item => item.id === selectedId)) return;
    // The selected entity can disappear after a confirmed delete or remote refresh.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId(collections[0]?.id ?? null);
  }, [collections, selectedId]);

  const selected = collections.find(item => item.id === selectedId) ?? null;
  const recordById = useMemo(() => new Map(records.map(record => [record.id, record])), [records]);
  const selectedMembers = useMemo(() => {
    const values = members.filter(member => member.collectionId === selectedId);
    const collection = collections.find(item => item.id === selectedId);
    if (collection?.orderMode !== 'chronological') return values.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const orderedRecords = chronologicalRecords(values.map(member => recordById.get(member.recordId)).filter(Boolean) as WatchRecord[]);
    const rank = new Map(orderedRecords.map((record, index) => [record.id, index]));
    return values.sort((left, right) => (rank.get(left.recordId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.recordId) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id));
  }, [collections, members, recordById, selectedId]);
  const memberRecordIds = new Set(selectedMembers.map(item => item.recordId));
  const availableRecords = records.filter(record => {
    if (memberRecordIds.has(record.id)) return false;
    const text = `${record.chineseName} ${record.originalName}`.toLowerCase();
    return !recordSearch.trim() || text.includes(recordSearch.trim().toLowerCase());
  });
  const visibleCollections = collections.filter(item => item.name.toLowerCase().includes(search.trim().toLowerCase()));
  const watchedCount = selectedMembers.filter(item => recordById.get(item.recordId)?.status === '已看').length;

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    try {
      await action();
      onNotify('success', success);
    } catch (error) {
      onNotify('error', errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const value = await props.onCreate(name, description || null, newCollectionKind);
      setSelectedId(value.id);
      setCreating(false); setName(''); setDescription(''); setNewCollectionKind('manual');
      onNotify('success', '收藏集已创建。');
    } catch (error) { onNotify('error', errorText(error)); }
    finally { setBusy(false); }
  }

  function startEdit() {
    if (!selected) return;
    setName(selected.name); setDescription(selected.description ?? ''); setEditing(true);
  }

  async function saveEdit() {
    if (!selected || !name.trim()) return;
    await run(async () => {
      const value = await props.onUpdate(selected, name, description || null);
      setSelectedId(value.id); setEditing(false);
    }, '收藏集已更新。');
  }

  async function deleteSelected() {
    if (!selected) return;
    if (!confirm(`确定删除“${selected.name}”吗？\n\n将删除 ${selectedMembers.length} 个归组关系，不会删除任何影视记录。`)) return;
    await run(async () => { await props.onDelete(selected); }, '收藏集已删除，影视记录均已保留。');
  }

  async function addSelectedRecords() {
    if (!selected || selectedRecords.size === 0) return;
    await run(async () => {
      await props.onAddMembers(selected, [...selectedRecords]);
      setSelectedRecords(new Set()); setAdding(false); setRecordSearch('');
    }, `已加入 ${selectedRecords.size} 条记录。`);
  }

  async function scanSuggestions() {
    cancelScanRef.current = false;
    setScanning(true);
    const grouped = new Map<string, CollectionSuggestion>();
    let failures = 0;
    for (const candidate of locallyKnownSeries(records)) {
      grouped.set(`local:${candidate.key}`, { name: candidate.name, sourceKind: 'manual', sourceKey: `local:${candidate.key}`, recordIds: candidate.recordIds });
    }
    const byImdb = new Map<string, WatchRecord[]>();
    for (const record of records.filter(item => item.imdbId)) {
      const key = record.imdbId!.trim().toLowerCase();
      byImdb.set(key, [...(byImdb.get(key) ?? []), record]);
    }
    const entries = [...byImdb.entries()];
    setScanProgress({ done: 0, total: entries.length });
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        if (cancelScanRef.current) return;
        const [imdbId, matchingRecords] = entries[cursor++];
      try {
        const cached = readIdentityCache<{ searchResult: Awaited<ReturnType<typeof searchTmdbAsync>>; detail: Awaited<ReturnType<typeof getTmdbDetailAsync>> | null }>(imdbId);
        const searchResult = cached?.searchResult ?? await searchTmdbAsync({ query: imdbId, language: 'zh-CN' });
        const match = searchResult.results?.find(item => item.id != null && item.media_type && ['movie', 'tv', 'tv_season'].includes(item.media_type));
        if (!match?.id && !match?.show_id) { writeIdentityCache(imdbId, { searchResult, detail: null }, false); failures += 1; continue; }
        const isTv = match.media_type !== 'movie';
        const id = match.media_type === 'tv_season' ? match.show_id : match.id;
        if (id == null) { failures += 1; continue; }
        const detailResult = cached?.detail ?? await getTmdbDetailAsync({ id, mediaType: isTv ? 'tv' : 'movie', language: 'zh-CN' });
        writeIdentityCache(imdbId, { searchResult, detail: detailResult }, true);
        const detail = detailResult.data;
        const sourceId = isTv ? id : detail?.belongs_to_collection?.id;
        const sourceKind = isTv ? 'tmdb-tv-show' as const : 'tmdb-movie-collection' as const;
        const sourceName = isTv ? (detail?.name || detail?.title) : detail?.belongs_to_collection?.name;
        if (sourceId == null || !sourceName) continue;
        const sourceKey = isTv ? `tmdb:tv-show:${sourceId}` : `tmdb:movie-collection:${sourceId}`;
        const current = grouped.get(sourceKey) ?? { name: sourceName, sourceKind, sourceKey, recordIds: [] };
        for (const record of matchingRecords) if (!current.recordIds.includes(record.id)) current.recordIds.push(record.id);
        grouped.set(sourceKey, current);
      } catch { failures += 1; }
        finally { completed += 1; setScanProgress(current => ({ ...current, done: current.done + 1 })); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
    const found = [...grouped.values()].filter(item => item.recordIds.length > 0);
    setSuggestions(found);
    setScanning(false);
    if (cancelScanRef.current) onNotify('info', `已停止发现系列；保留已完成的 ${completed} 项只读结果。`);
    else onNotify(found.length ? 'info' : 'warning', found.length ? `找到 ${found.length} 组 TMDB 归组建议，请确认后应用。${failures ? ` ${failures} 条未能判定。` : ''}` : '没有找到可可靠归组的 TMDB 建议。');
  }

  async function applySuggestion(suggestion: CollectionSuggestion) {
    await run(async () => {
      if (suggestion.sourceKind === 'manual') {
        let collection = collections.find(item => item.normalizedName === suggestion.name.trim().toLowerCase());
        if (!collection) collection = await props.onCreate(suggestion.name, null);
        await props.onAddMembers(collection, suggestion.recordIds);
      } else {
        await props.onApplySuggestion(suggestion.name, suggestion.sourceKind, suggestion.sourceKey, suggestion.recordIds);
      }
      setSuggestions(current => current.filter(item => item.sourceKey !== suggestion.sourceKey));
    }, `已应用“${suggestion.name}”归组建议。`);
  }

  async function inspectMissingSeasons() {
    if (!selected?.sourceKey?.startsWith('tmdb:tv-show:')) return;
    const id = Number(selected.sourceKey.slice('tmdb:tv-show:'.length));
    if (!Number.isInteger(id) || id <= 0) return;
    setBusy(true);
    try {
      const result = await getTmdbDetailAsync({ id, mediaType: 'tv', language: 'zh-CN' });
      if (!result.success || !result.data?.seasons) throw new Error('missing seasons');
      const existing = new Set(selectedMembers.map(member => recordById.get(member.recordId)).filter(Boolean).map(record => (record as WatchRecord).tmdbSeasonNumber ?? seasonNumberOf(record as WatchRecord)).filter((value): value is number => value != null));
      setSeasonDetail(result.data);
      setSelectedSeasonNumbers(new Set(defaultMissingSeasonNumbers(result.data.seasons, existing)));
      setShowSpecials(false);
    } catch (error) {
      console.warn('[CollectionCenter] could not inspect missing seasons', error instanceof Error ? error.name : 'unknown');
      onNotify('error', '读取 TMDB 全部季失败，请稍后重试。');
    } finally { setBusy(false); }
  }

  async function createSelectedSeasons() {
    if (!selected || !seasonDetail?.seasons || selectedSeasonNumbers.size === 0) return;
    const now = new Date().toISOString();
    const seriesName = seasonDetail.name || seasonDetail.title || selected.name;
    const originalName = seasonDetail.original_name || seasonDetail.original_title || seriesName;
    const recordsToCreate = seasonDetail.seasons.filter(season => selectedSeasonNumbers.has(season.season_number ?? -1)).map(season => ({
      ...getEmptyRecord(),
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      chineseName: `${seriesName} ${season.name || `第 ${season.season_number} 季`}`,
      originalName: `${originalName} Season ${season.season_number}`,
      releaseYear: season.air_date?.slice(0, 4) || null,
      posterPath: season.poster_path || seasonDetail.poster_path || null,
      totalEpisodes: season.episode_count || null,
      imdbId: seasonDetail.external_ids?.imdb_id || seasonDetail.imdb_id || null,
      imdbRating: seasonDetail.vote_average || null,
      tmdbStatus: seasonDetail.status || null,
      mediaType: '剧集' as const,
      tmdbMediaKind: 'tv-season' as const,
      tmdbId: season.id ?? null,
      tmdbParentId: seasonDetail.id ?? null,
      tmdbSeasonNumber: season.season_number ?? null,
      seriesRecordKind: 'season' as const,
    }));
    setBusy(true);
    try {
      await props.onCreateMissingSeasons(selected, recordsToCreate);
      setSeasonDetail(null);
      onNotify('success', `已补充 ${recordsToCreate.length} 个缺少的季，已有条目未被覆盖。`);
    } catch (error) {
      onNotify('error', errorText(error));
    } finally { setBusy(false); }
  }

  async function searchRelatedWorks() {
    const query = relatedSearch.trim();
    if (!query) return;
    setBusy(true);
    try {
      const result = await searchTmdbAsync({ query, language: 'zh-CN' });
      setRelatedResults((result.results ?? []).filter(item => item.id != null && ['movie', 'tv'].includes(item.media_type ?? '')).slice(0, 20));
    } catch { onNotify('error', '搜索相关作品失败，请稍后重试。'); }
    finally { setBusy(false); }
  }

  async function linkRelatedWork(item: TmdbMedia) {
    if (!selected || item.id == null || !['movie', 'tv'].includes(item.media_type ?? '')) return;
    setBusy(true);
    try {
      const kind = item.media_type as 'movie' | 'tv';
      const detailResult = await getTmdbDetailAsync({ id: item.id, mediaType: kind, language: 'zh-CN' });
      if (!detailResult.success || !detailResult.data) throw new Error('missing detail');
      const detail = detailResult.data;
      const now = new Date().toISOString();
      const name = detail.name || detail.title || item.name || item.title || '未命名作品';
      const original = detail.original_name || detail.original_title || item.original_name || item.original_title || name;
      const releaseDate = detail.release_date || detail.first_air_date || item.release_date || item.first_air_date;
      const record: WatchRecord = {
        ...getEmptyRecord(), id: crypto.randomUUID(), createdAt: now, updatedAt: now,
        chineseName: name, originalName: original, releaseYear: releaseDate?.slice(0, 4) || null,
        posterPath: detail.poster_path || item.poster_path || null,
        imdbId: detail.external_ids?.imdb_id || detail.imdb_id || null,
        imdbRating: detail.vote_average || null, tmdbStatus: detail.status || null,
        mediaType: kind === 'movie' ? '电影' : '剧集',
        tmdbMediaKind: kind,
        tmdbId: detail.id ?? item.id,
        tmdbParentId: null,
        tmdbSeasonNumber: null,
        seriesRecordKind: kind === 'movie' ? 'single-work' : 'whole-series',
        totalEpisodes: kind === 'tv' ? detail.number_of_episodes || null : null,
        movieDuration: kind === 'movie' && detail.runtime ? detail.runtime * 60 : null,
      };
      await props.onCreateMissingSeasons(selected, [record]);
      setRelatedResults(current => current.filter(result => result.id !== item.id || result.media_type !== item.media_type));
      onNotify('success', `已将“${name}”作为相关作品加入片库和当前影视宇宙。`);
    } catch { onNotify('error', '关联相关作品失败；片库与收藏集均未更改。'); }
    finally { setBusy(false); }
  }

  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/35 p-3 sm:p-6">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="collections-title" tabIndex={-1} className="flex h-[min(900px,94vh)] w-full max-w-7xl overflow-hidden rounded-[28px] bg-white shadow-2xl">
      <aside className={`${selected && 'max-md:hidden'} flex w-full flex-col border-r border-gray-100 bg-gray-50/70 md:w-[31%]`}>
        <div className="border-b border-gray-100 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 id="collections-title" className="text-2xl font-black text-gray-900">系列与收藏集</h2>
            <button ref={closeRef} onClick={onClose} aria-label="关闭收藏集中心" className="rounded-xl px-3 py-2 text-xl text-gray-400 hover:bg-white">×</button>
          </div>
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索收藏集" className="mt-4 w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-indigo-400" />
          <button onClick={() => { setCreating(true); setName(''); setDescription(''); setNewCollectionKind('manual'); }} className="mt-3 w-full rounded-xl border border-indigo-200 bg-white py-2.5 text-sm font-bold text-indigo-600 hover:bg-indigo-50">＋ 新建收藏集</button>
          {creating && <div className="mt-3 space-y-2 rounded-2xl border border-indigo-100 bg-white p-3">
            <input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder="收藏集名称" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            <textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={500} placeholder="说明（可选）" className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            <select value={newCollectionKind} onChange={event => setNewCollectionKind(event.target.value as WatchCollection['collectionKind'])} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"><option value="manual">普通收藏集（手工排序）</option><option value="universe">影视宇宙（年代排序，可关联相关作品）</option></select>
            <div className="flex gap-2"><button disabled={busy || !name.trim()} onClick={() => void create()} className="flex-1 rounded-lg bg-indigo-600 py-2 text-xs font-bold text-white disabled:bg-gray-300">创建</button><button onClick={() => setCreating(false)} className="rounded-lg border px-3 text-xs">取消</button></div>
          </div>}
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {visibleCollections.map(collection => {
            const items = members.filter(item => item.collectionId === collection.id);
            const posters = items.map(item => recordById.get(item.recordId)).filter(Boolean).slice(0, 3) as WatchRecord[];
            return <button key={collection.id} onClick={() => setSelectedId(collection.id)} className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left ${selectedId === collection.id ? 'border-indigo-300 bg-indigo-50' : 'border-gray-100 bg-white hover:border-gray-200'}`}>
              <div className="flex h-14 w-20 overflow-hidden rounded-lg bg-gray-100">{posters.length ? posters.map(record => <SafePosterImage key={record.id} posterPath={record.posterPath || ''} alt="" compact className="h-full min-w-0 flex-1 object-cover" />) : <span className="m-auto text-2xl">🎞️</span>}</div>
              <div className="min-w-0"><p className="truncate text-sm font-bold text-gray-800">{collection.name}</p><p className="mt-1 text-xs text-gray-400">{items.length} 部</p></div>
            </button>;
          })}
          {!visibleCollections.length && <p className="py-10 text-center text-sm text-gray-400">尚无匹配的收藏集</p>}
        </div>
      </aside>

      <main className={`${!selected && 'max-md:hidden'} flex min-w-0 flex-1 flex-col bg-white`}>
        {!selected ? <div className="m-auto text-center"><p className="text-5xl">🎬</p><p className="mt-4 font-bold text-gray-700">创建第一个收藏集</p><p className="mt-1 text-sm text-gray-400">按系列、导演或个人主题整理片库</p></div> : <>
          <div className="border-b border-gray-100 p-5 sm:p-7">
            <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <button onClick={() => setSelectedId(null)} className="mb-3 text-xs font-bold text-indigo-600 md:hidden">← 返回收藏集</button>
                {editing ? <div className="space-y-2"><input value={name} onChange={event => setName(event.target.value)} maxLength={80} className="w-full rounded-xl border px-3 py-2 text-xl font-black" /><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={500} className="w-full resize-none rounded-xl border px-3 py-2 text-sm" /><div className="flex gap-2"><button disabled={busy || !name.trim()} onClick={() => void saveEdit()} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white">保存</button><button onClick={() => setEditing(false)} className="rounded-lg border px-4 text-xs">取消</button></div></div> : <><h3 className="truncate text-3xl font-black text-gray-900">{selected.name}</h3><p className="mt-2 text-sm text-gray-500">{selected.description || '尚未添加说明'}</p></>}
                <div className="mt-4 flex flex-wrap gap-2 text-xs"><span className="rounded-lg border px-3 py-1.5">🎬 {selectedMembers.length} 部作品</span><span className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-1.5 text-emerald-700">✓ 已看 {watchedCount}</span><span className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-1.5 text-amber-700">○ 未看 {selectedMembers.length - watchedCount}</span></div>
              </div>
              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:flex-wrap sm:justify-end"><button onClick={() => setAdding(true)} className="rounded-xl bg-indigo-600 px-3 py-2.5 text-sm font-bold text-white sm:px-4">＋ 从片库添加</button>{selected.sourceKey?.startsWith('tmdb:tv-show:') ? <button disabled={busy} onClick={() => void inspectMissingSeasons()} className="rounded-xl border border-indigo-100 px-3 py-2 text-sm font-semibold text-indigo-600 disabled:opacity-50">检查缺失季</button> : selected.collectionKind === 'universe' ? <button disabled={busy} onClick={() => setLinkingRelated(true)} className="rounded-xl border border-indigo-100 px-3 py-2 text-sm font-semibold text-indigo-600 disabled:opacity-50">关联相关作品</button> : <button onClick={() => scanning ? (cancelScanRef.current = true) : void scanSuggestions()} className="rounded-xl border border-indigo-100 px-3 py-2 text-sm font-semibold text-indigo-600">{scanning ? `停止 ${scanProgress.done}/${scanProgress.total}` : `发现系列${suggestions.length ? ` ${suggestions.length}` : ''}`}</button>}<button onClick={startEdit} className="rounded-xl border px-3 py-2 text-sm">编辑</button><button onClick={() => void deleteSelected()} className="rounded-xl border border-red-100 px-3 py-2 text-sm text-red-500">删除</button><button onClick={onClose} aria-label="关闭收藏集中心" className="hidden rounded-xl px-3 py-2 text-xl text-gray-400 md:block">×</button></div>
            </div>
            {suggestions.length > 0 && <div className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-3"><p className="text-xs font-bold text-indigo-800">TMDB 只读建议 · 确认前不会修改数据</p><div className="mt-2 flex flex-wrap gap-2">{suggestions.map(item => <button key={item.sourceKey} disabled={busy} onClick={() => void applySuggestion(item)} className="rounded-xl border border-indigo-200 bg-white px-3 py-2 text-left text-xs text-indigo-700"><b>{item.name}</b><span className="ml-2 text-indigo-400">{item.recordIds.length} 部 · 应用</span></button>)}</div></div>}
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-5 sm:p-7">
            {selectedMembers.map((member, index) => {
              const record = recordById.get(member.recordId);
              if (!record) return null;
              const titles = displayTitlesOf(record);
              return <div key={member.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-100 p-3 hover:border-gray-200">
                <span className="text-gray-300" aria-hidden="true">⠿</span><span className="w-6 text-sm font-bold text-gray-500">{index + 1}</span>
                <SafePosterImage posterPath={record.posterPath || ''} alt="" compact className="h-16 w-11 rounded-lg object-cover" />
                <button onClick={() => props.onEditRecord(record)} className="min-w-[7rem] flex-1 text-left"><p className="truncate font-bold text-gray-800">{titles.primary}{record.releaseYear ? ` · ${record.releaseYear.slice(0, 4)}` : ''}</p><p className="mt-1 truncate text-xs text-gray-400">{titles.secondary || record.mediaType}</p></button>
                <span className={`rounded-full px-3 py-1 text-xs font-bold ${record.status === '已看' ? 'bg-emerald-50 text-emerald-700' : record.status === '在看' ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500'}`}>{record.status}</span>
                <div className="ml-auto flex">{selected.orderMode !== 'chronological' && <><button disabled={busy || index === 0} onClick={() => { const next = selectedMembers.map(item => item.recordId); [next[index - 1], next[index]] = [next[index], next[index - 1]]; void run(() => props.onReorder(selected, next), '成员顺序已更新。'); }} aria-label={`上移 ${titles.primary}`} className="rounded-lg px-2 py-1 text-gray-400 disabled:opacity-20">↑</button><button disabled={busy || index === selectedMembers.length - 1} onClick={() => { const next = selectedMembers.map(item => item.recordId); [next[index], next[index + 1]] = [next[index + 1], next[index]]; void run(() => props.onReorder(selected, next), '成员顺序已更新。'); }} aria-label={`下移 ${titles.primary}`} className="rounded-lg px-2 py-1 text-gray-400 disabled:opacity-20">↓</button></>}<button disabled={busy} onClick={() => void run(() => props.onRemoveMember(member), '已从收藏集移除，影视记录仍保留。')} aria-label={`从收藏集移除 ${titles.primary}`} className="rounded-lg px-2 py-1 text-red-400 hover:bg-red-50">×</button></div>
              </div>;
            })}
            {!selectedMembers.length && <div className="py-20 text-center"><p className="text-4xl">🎞️</p><p className="mt-3 font-bold text-gray-600">这个收藏集还是空的</p><button onClick={() => setAdding(true)} className="mt-4 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white">从片库添加</button></div>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-5 py-4 text-xs text-gray-400 sm:px-7"><span>ⓘ {selected.orderMode === 'chronological' ? '当前按年代从老到新排列，未知年份排在最后' : '当前为手工顺序，可使用上下按钮调整'} · 删除收藏集不会删除影视记录</span>{selected.orderMode !== 'chronological' && <button disabled={busy} onClick={() => void run(() => props.onSetOrderMode(selected, 'chronological').then(() => undefined), '已改为按年代从老到新排列。')} className="rounded-lg border border-indigo-100 px-3 py-1.5 font-bold text-indigo-600">按年代排列</button>}</div>
        </>}
      </main>
    </div>

    {adding && selected && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/35 p-4"><div role="dialog" aria-modal="true" aria-label="从片库添加" className="flex max-h-[80vh] w-full max-w-xl flex-col rounded-3xl bg-white p-5 shadow-2xl">
      <div className="flex items-center justify-between"><h3 className="text-xl font-black">从片库添加</h3><button onClick={() => setAdding(false)} className="text-xl text-gray-400">×</button></div>
      <input autoFocus value={recordSearch} onChange={event => setRecordSearch(event.target.value)} placeholder="搜索片名" className="mt-4 rounded-xl border px-4 py-2.5 text-sm" />
      <div className="mt-3 flex-1 space-y-1 overflow-y-auto">{availableRecords.map(record => <label key={record.id} className="flex cursor-pointer items-center gap-3 rounded-xl p-2 hover:bg-gray-50"><input type="checkbox" checked={selectedRecords.has(record.id)} onChange={event => setSelectedRecords(current => { const next = new Set(current); if (event.target.checked) next.add(record.id); else next.delete(record.id); return next; })} /><SafePosterImage posterPath={record.posterPath || ''} alt="" compact className="h-12 w-8 rounded object-cover" /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{displayTitlesOf(record).primary}</span><span className="text-xs text-gray-400">{record.status}</span></label>)}</div>
      <div className="mt-4 flex items-center justify-between border-t pt-4"><span className="text-xs text-gray-500">已选择 {selectedRecords.size} 条</span><div className="flex gap-2"><button onClick={() => setAdding(false)} className="rounded-xl border px-4 py-2 text-sm">取消</button><button disabled={busy || !selectedRecords.size} onClick={() => void addSelectedRecords()} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white disabled:bg-gray-300">加入收藏集</button></div></div>
    </div></div>}
    {seasonDetail?.seasons && selected && <div className="fixed inset-0 z-[105] flex items-center justify-center bg-slate-900/45 p-4"><div role="dialog" aria-modal="true" aria-label="检查缺失季" className="flex max-h-[86vh] w-full max-w-2xl flex-col rounded-3xl bg-white p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><div><h3 className="text-xl font-black text-gray-900">查看 TMDB 全部季</h3><p className="mt-1 text-xs text-gray-400">只会新增勾选的缺少季，不覆盖片库已有条目</p></div><button onClick={() => setSeasonDetail(null)} className="text-xl text-gray-400">×</button></div>
      <label className="mt-4 flex items-center gap-2 text-xs text-gray-500"><input type="checkbox" checked={showSpecials} onChange={event => setShowSpecials(event.target.checked)} />显示第 0 季 / 特别篇（默认不选）</label>
      <div className="mt-3 flex-1 space-y-2 overflow-y-auto">{seasonDetail.seasons.filter(season => showSpecials || (season.season_number ?? 0) > 0).map((season: TmdbSeason) => {
        const number = season.season_number ?? 0;
        const existing = selectedMembers.some(member => { const record = recordById.get(member.recordId); return record ? (record.tmdbSeasonNumber ?? seasonNumberOf(record)) === number : false; });
        const checked = selectedSeasonNumbers.has(number);
        const future = !!season.air_date && new Date(`${season.air_date}T00:00:00Z`) > new Date();
        return <label key={season.id ?? number} className={`flex items-center gap-3 rounded-2xl border p-3 ${existing ? 'bg-gray-50 opacity-60' : 'cursor-pointer hover:border-indigo-200'}`}><input type="checkbox" disabled={existing} checked={checked} onChange={() => setSelectedSeasonNumbers(current => { const next = new Set(current); if (checked) next.delete(number); else next.add(number); return next; })} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-gray-800">{season.name || `第 ${number} 季`} · {season.air_date?.slice(0, 4) || '年份未知'}</p><p className="mt-1 text-xs text-gray-400">{season.episode_count ?? '未知'} 集{existing ? ' · 已在片库' : future ? ' · 尚未播出' : !season.air_date ? ' · 播出日期未知' : ''}</p></div></label>;
      })}</div>
      <div className="mt-4 flex items-center justify-between border-t pt-4"><span className="text-xs text-gray-500">已选择 {selectedSeasonNumbers.size} 季</span><div className="flex gap-2"><button onClick={() => setSeasonDetail(null)} className="rounded-xl border px-4 py-2 text-sm">取消</button><button disabled={busy || selectedSeasonNumbers.size === 0} onClick={() => void createSelectedSeasons()} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white disabled:bg-gray-300">补充到片库</button></div></div>
    </div></div>}
    {linkingRelated && selected && <div className="fixed inset-0 z-[105] flex items-center justify-center bg-slate-900/45 p-4"><div role="dialog" aria-modal="true" aria-label="关联相关作品" className="flex max-h-[82vh] w-full max-w-xl flex-col rounded-3xl bg-white p-5 shadow-2xl">
      <div className="flex items-start justify-between"><div><h3 className="text-xl font-black">关联相关作品</h3><p className="mt-1 text-xs text-gray-400">搜索电影、衍生剧或特别篇；只有点击加入后才会写入</p></div><button onClick={() => setLinkingRelated(false)} className="text-xl text-gray-400">×</button></div>
      <div className="mt-4 flex gap-2"><input autoFocus value={relatedSearch} onChange={event => setRelatedSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void searchRelatedWorks(); } }} placeholder="输入片名" className="min-w-0 flex-1 rounded-xl border px-4 py-2.5 text-sm" /><button disabled={busy || !relatedSearch.trim()} onClick={() => void searchRelatedWorks()} className="rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white disabled:bg-gray-300">搜索</button></div>
      <div className="mt-3 flex-1 space-y-2 overflow-y-auto">{relatedResults.map(item => <div key={`${item.media_type}:${item.id}`} className="flex items-center gap-3 rounded-2xl border p-3"><SafePosterImage posterPath={item.poster_path || ''} alt="" compact className="h-16 w-11 rounded-lg object-cover" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{item.name || item.title}</p><p className="mt-1 truncate text-xs text-gray-400">{item.media_type === 'movie' ? '电影' : '剧集'} · {(item.release_date || item.first_air_date)?.slice(0, 4) || '年份未知'}</p></div><button disabled={busy} onClick={() => void linkRelatedWork(item)} className="rounded-xl border border-indigo-200 px-3 py-2 text-xs font-bold text-indigo-600">加入</button></div>)}{!relatedResults.length && <p className="py-10 text-center text-sm text-gray-400">搜索后在这里选择需要关联的作品</p>}</div>
    </div></div>}
  </div>;
}
