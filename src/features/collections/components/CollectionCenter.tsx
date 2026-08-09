import { useEffect, useMemo, useRef, useState } from 'react';
import type { CollectionMember, WatchCollection, WatchRecord } from '../../../shared/types';
import { displayTitlesOf } from '../../../shared/lib/displayTitle';
import { useAccessibleDialog } from '../../../shared/lib/useAccessibleDialog';
import SafePosterImage from '../../watchlist/components/SafePosterImage';
import { getTmdbDetailAsync, searchTmdbAsync } from '../../../shared/lib/database';

interface Props {
  records: WatchRecord[];
  collections: WatchCollection[];
  members: CollectionMember[];
  onCreate: (name: string, description: string | null) => Promise<WatchCollection>;
  onUpdate: (collection: WatchCollection, name: string, description: string | null) => Promise<WatchCollection>;
  onDelete: (collection: WatchCollection) => Promise<void>;
  onAddMembers: (collection: WatchCollection, recordIds: string[]) => Promise<void>;
  onRemoveMember: (member: CollectionMember) => Promise<void>;
  onReorder: (collection: WatchCollection, recordIds: string[]) => Promise<void>;
  onApplySuggestion: (name: string, sourceKind: 'tmdb-movie-collection' | 'tmdb-tv-show', sourceKey: string, recordIds: string[]) => Promise<void>;
  onEditRecord: (record: WatchRecord) => void;
  onClose: () => void;
  onNotify: (tone: 'success' | 'warning' | 'error' | 'info', message: string) => void;
}

interface CollectionSuggestion { name: string; sourceKind: 'tmdb-movie-collection' | 'tmdb-tv-show'; sourceKey: string; recordIds: string[] }

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
  const [recordSearch, setRecordSearch] = useState('');
  const [selectedRecords, setSelectedRecords] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [suggestions, setSuggestions] = useState<CollectionSuggestion[]>([]);
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
  const selectedMembers = useMemo(() => members
    .filter(member => member.collectionId === selectedId)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)), [members, selectedId]);
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
      const value = await props.onCreate(name, description || null);
      setSelectedId(value.id);
      setCreating(false); setName(''); setDescription('');
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

  async function move(member: CollectionMember, offset: -1 | 1) {
    if (!selected) return;
    const index = selectedMembers.findIndex(item => item.id === member.id);
    const target = index + offset;
    if (target < 0 || target >= selectedMembers.length) return;
    const next = selectedMembers.map(item => item.recordId);
    [next[index], next[target]] = [next[target], next[index]];
    await run(() => props.onReorder(selected, next), '成员顺序已更新。');
  }

  async function scanSuggestions() {
    setScanning(true);
    const grouped = new Map<string, CollectionSuggestion>();
    let failures = 0;
    for (const record of records.filter(item => item.imdbId)) {
      try {
        const searchResult = await searchTmdbAsync({ query: record.imdbId as string, language: 'zh-CN' });
        const match = searchResult.results?.find(item => item.id != null && item.media_type && ['movie', 'tv', 'tv_season'].includes(item.media_type));
        if (!match?.id && !match?.show_id) { failures += 1; continue; }
        const isTv = match.media_type !== 'movie';
        const id = match.media_type === 'tv_season' ? match.show_id : match.id;
        if (id == null) { failures += 1; continue; }
        const detailResult = await getTmdbDetailAsync({ id, mediaType: isTv ? 'tv' : 'movie', language: 'zh-CN' });
        const detail = detailResult.data;
        const sourceId = isTv ? id : detail?.belongs_to_collection?.id;
        const sourceKind = isTv ? 'tmdb-tv-show' as const : 'tmdb-movie-collection' as const;
        const sourceName = isTv ? (detail?.name || detail?.title) : detail?.belongs_to_collection?.name;
        if (sourceId == null || !sourceName) continue;
        const sourceKey = isTv ? `tmdb:tv-show:${sourceId}` : `tmdb:movie-collection:${sourceId}`;
        const current = grouped.get(sourceKey) ?? { name: sourceName, sourceKind, sourceKey, recordIds: [] };
        if (!current.recordIds.includes(record.id)) current.recordIds.push(record.id);
        grouped.set(sourceKey, current);
      } catch { failures += 1; }
    }
    const found = [...grouped.values()].filter(item => item.recordIds.length > 0);
    setSuggestions(found);
    setScanning(false);
    onNotify(found.length ? 'info' : 'warning', found.length ? `找到 ${found.length} 组 TMDB 归组建议，请确认后应用。${failures ? ` ${failures} 条未能判定。` : ''}` : '没有找到可可靠归组的 TMDB 建议。');
  }

  async function applySuggestion(suggestion: CollectionSuggestion) {
    await run(async () => {
      await props.onApplySuggestion(suggestion.name, suggestion.sourceKind, suggestion.sourceKey, suggestion.recordIds);
      setSuggestions(current => current.filter(item => item.sourceKey !== suggestion.sourceKey));
    }, `已应用“${suggestion.name}”归组建议。`);
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
          <button onClick={() => { setCreating(true); setName(''); setDescription(''); }} className="mt-3 w-full rounded-xl border border-indigo-200 bg-white py-2.5 text-sm font-bold text-indigo-600 hover:bg-indigo-50">＋ 新建收藏集</button>
          {creating && <div className="mt-3 space-y-2 rounded-2xl border border-indigo-100 bg-white p-3">
            <input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder="收藏集名称" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            <textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={500} placeholder="说明（可选）" className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm" />
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
              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:flex-wrap sm:justify-end"><button onClick={() => setAdding(true)} className="rounded-xl bg-indigo-600 px-3 py-2.5 text-sm font-bold text-white sm:px-4">＋ 从片库添加</button><button disabled={scanning} onClick={() => void scanSuggestions()} className="rounded-xl border border-indigo-100 px-3 py-2 text-sm font-semibold text-indigo-600 disabled:opacity-50">{scanning ? '正在扫描…' : `TMDB 归组建议${suggestions.length ? ` ${suggestions.length}` : ''}`}</button><button onClick={startEdit} className="rounded-xl border px-3 py-2 text-sm">编辑</button><button onClick={() => void deleteSelected()} className="rounded-xl border border-red-100 px-3 py-2 text-sm text-red-500">删除</button><button onClick={onClose} aria-label="关闭收藏集中心" className="hidden rounded-xl px-3 py-2 text-xl text-gray-400 md:block">×</button></div>
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
                <button onClick={() => props.onEditRecord(record)} className="min-w-[7rem] flex-1 text-left"><p className="truncate font-bold text-gray-800">{titles.primary}</p><p className="mt-1 truncate text-xs text-gray-400">{titles.secondary || record.releaseYear || record.mediaType}</p></button>
                <span className={`rounded-full px-3 py-1 text-xs font-bold ${record.status === '已看' ? 'bg-emerald-50 text-emerald-700' : record.status === '在看' ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500'}`}>{record.status}</span>
                <div className="ml-auto flex"><button disabled={busy || index === 0} onClick={() => void move(member, -1)} aria-label={`上移 ${titles.primary}`} className="rounded-lg px-2 py-1 text-gray-400 hover:bg-gray-50 disabled:opacity-20">↑</button><button disabled={busy || index === selectedMembers.length - 1} onClick={() => void move(member, 1)} aria-label={`下移 ${titles.primary}`} className="rounded-lg px-2 py-1 text-gray-400 hover:bg-gray-50 disabled:opacity-20">↓</button><button disabled={busy} onClick={() => void run(() => props.onRemoveMember(member), '已从收藏集移除，影视记录仍保留。')} aria-label={`从收藏集移除 ${titles.primary}`} className="rounded-lg px-2 py-1 text-red-400 hover:bg-red-50">×</button></div>
              </div>;
            })}
            {!selectedMembers.length && <div className="py-20 text-center"><p className="text-4xl">🎞️</p><p className="mt-3 font-bold text-gray-600">这个收藏集还是空的</p><button onClick={() => setAdding(true)} className="mt-4 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white">从片库添加</button></div>}
          </div>
          <div className="border-t border-gray-100 px-5 py-4 text-xs text-gray-400 sm:px-7">ⓘ 使用上下按钮调整顺序 · 删除收藏集不会删除影视记录</div>
        </>}
      </main>
    </div>

    {adding && selected && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/35 p-4"><div role="dialog" aria-modal="true" aria-label="从片库添加" className="flex max-h-[80vh] w-full max-w-xl flex-col rounded-3xl bg-white p-5 shadow-2xl">
      <div className="flex items-center justify-between"><h3 className="text-xl font-black">从片库添加</h3><button onClick={() => setAdding(false)} className="text-xl text-gray-400">×</button></div>
      <input autoFocus value={recordSearch} onChange={event => setRecordSearch(event.target.value)} placeholder="搜索片名" className="mt-4 rounded-xl border px-4 py-2.5 text-sm" />
      <div className="mt-3 flex-1 space-y-1 overflow-y-auto">{availableRecords.map(record => <label key={record.id} className="flex cursor-pointer items-center gap-3 rounded-xl p-2 hover:bg-gray-50"><input type="checkbox" checked={selectedRecords.has(record.id)} onChange={event => setSelectedRecords(current => { const next = new Set(current); if (event.target.checked) next.add(record.id); else next.delete(record.id); return next; })} /><SafePosterImage posterPath={record.posterPath || ''} alt="" compact className="h-12 w-8 rounded object-cover" /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{displayTitlesOf(record).primary}</span><span className="text-xs text-gray-400">{record.status}</span></label>)}</div>
      <div className="mt-4 flex items-center justify-between border-t pt-4"><span className="text-xs text-gray-500">已选择 {selectedRecords.size} 条</span><div className="flex gap-2"><button onClick={() => setAdding(false)} className="rounded-xl border px-4 py-2 text-sm">取消</button><button disabled={busy || !selectedRecords.size} onClick={() => void addSelectedRecords()} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white disabled:bg-gray-300">加入收藏集</button></div></div>
    </div></div>}
  </div>;
}
