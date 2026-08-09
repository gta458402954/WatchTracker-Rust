import { useState } from 'react';
import type { SavedWatchlistViewV1 } from '../../../shared/lib/savedViews';

interface SavedViewBarProps {
  views: SavedWatchlistViewV1[];
  activeViewId: string | null;
  startupViewId: string | null;
  dirty: boolean;
  onSelectAll: () => void;
  onSelect: (view: SavedWatchlistViewV1) => void;
  onCreate: (name: string) => Promise<void>;
  onUpdate: () => Promise<void>;
  onDelete: () => Promise<void>;
  onToggleStartup: () => Promise<void>;
}

export default function SavedViewBar({ views, activeViewId, startupViewId, dirty, onSelectAll, onSelect, onCreate, onUpdate, onDelete, onToggleStartup }: SavedViewBarProps) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const active = views.find(view => view.id === activeViewId) ?? null;

  async function submit() {
    try {
      await onCreate(name);
      setName('');
      setNaming(false);
    } catch {
      // The owner already reports the persistence/validation failure and the
      // form remains open so the user can correct the name or retry.
    }
  }

  return <div aria-label="保存视图" className="border-b border-gray-100 bg-white px-4 py-2">
    <div className="mx-auto flex max-w-5xl items-center gap-2 overflow-x-auto scrollbar-none">
      <button type="button" aria-pressed={!activeViewId && !dirty} onClick={onSelectAll} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold ${!activeViewId && !dirty ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-500'}`}>全部记录</button>
      {views.map(view => <button key={view.id} type="button" aria-pressed={activeViewId === view.id} onClick={() => onSelect(view)} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold ${activeViewId === view.id ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-500'}`}>{startupViewId === view.id ? '★ ' : ''}{view.name}{activeViewId === view.id && dirty ? ' · 已修改' : ''}</button>)}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {naming ? <form className="flex items-center gap-2" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <input autoFocus aria-label="视图名称" maxLength={30} value={name} onChange={event => setName(event.target.value)} className="h-8 w-36 rounded-lg border border-indigo-200 px-2 text-xs" placeholder="视图名称" />
          <button type="submit" className="text-xs font-bold text-indigo-600">保存</button>
          <button type="button" onClick={() => { setNaming(false); setName(''); }} className="text-xs text-gray-400">取消</button>
        </form> : <button type="button" onClick={() => setNaming(true)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-bold text-gray-600">另存为</button>}
        {active && dirty && <button type="button" onClick={() => void onUpdate()} className="text-xs font-bold text-indigo-600">更新</button>}
        {active && <button type="button" onClick={() => void onToggleStartup()} className="text-xs font-bold text-amber-600">{startupViewId === active.id ? '取消启动' : '设为启动'}</button>}
        {active && <button type="button" onClick={() => void onDelete()} className="text-xs font-bold text-red-500">删除</button>}
      </div>
    </div>
  </div>;
}
