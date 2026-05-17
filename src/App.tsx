import { useState, useMemo, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WatchRecord, Category, Status } from './types/index';
import { useWatchList } from './hooks/useWatchList';
import { useCategories } from './hooks/useCategories';
import RecordCard from './components/RecordCard';
import RecordForm from './components/RecordForm';
import StatsBar from './components/StatsBar';
import SettingsModal from './components/SettingsModal';
import { syncToWebDAV, hasCreds } from './utils/webdav';

type FilterStatus = Status | 'all';

export default function App() {
  const [syncInterval, setSyncInterval] = useState(30);
  const { 
    records, loadRecords, addRecord, updateRecord, deleteRecord, replaceRecords,
    isSyncPaused, toggleSyncPause 
  } = useWatchList(syncInterval);
  const { categories, loadCategories, addCategory, updateCategory, deleteCategory, getEmoji } = useCategories();
  const [activeCategory, setActiveCategory] = useState<Category | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [searchText, setSearchText] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingRecord, setEditingRecord] = useState<WatchRecord | null>(null);
  const [sortBy, setSortBy] = useState<'createdAt' | 'startDate' | 'rating'>('createdAt');
  const [showSettings, setShowSettings] = useState(false);
  const [hideWatched, setHideWatched] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'list' | 'poster'>('list');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [hasWebDAVCreds, setHasWebDAVCreds] = useState(false);

  // 初始化并加载数据
  useEffect(() => {
    async function init() {
      try {
        setLoading(true);
        // 检查 WebDAV 状态
        const credsOk = await hasCreds();
        setHasWebDAVCreds(credsOk);
        // 加载同步间隔设置
        const savedInterval = await invoke<string | null>('get_setting', { key: 'sync_interval' });
        if (savedInterval) {
          setSyncInterval(parseInt(savedInterval, 10));
        }

        // 不需要 initDatabase()，因为入口 main.tsx 已经等它完成了
        await Promise.all([
          loadCategories(),
          loadRecords()
        ]);
      } catch (e) {
        console.error('[App] 加载数据失败:', e);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [loadCategories, loadRecords]);

  // 手动同步到坚果云 WebDAV
  async function handleQuickSync() {
    if (!hasCreds()) {
      setSyncMsg('⚙️ 请先在设置里配置坚果云账号');
      setTimeout(() => setSyncMsg(''), 3000);
      return;
    }
    setSyncing(true);
    setSyncMsg('');
    const result = await syncToWebDAV(records);
    setSyncing(false);
    if (result.ok) {
      setSyncMsg('✅ 已同步');
      setLastSync(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    } else {
      setSyncMsg(`❌ ${result.error ?? '同步失败'}`);
    }
    setTimeout(() => setSyncMsg(''), 3000);
  }

  const filtered = useMemo(() => {
    return records
      .filter(r => {
        if (activeCategory !== 'all' && r.category !== activeCategory) return false;
        if (filterStatus !== 'all' && r.status !== filterStatus) return false;
        if (hideWatched && r.status === '已看') return false;
        if (searchText) {
          const q = searchText.toLowerCase();
          return (
            r.chineseName.toLowerCase().includes(q) ||
            r.originalName.toLowerCase().includes(q) ||
            r.platform.toLowerCase().includes(q) ||
            r.notes.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'rating') {
          return (b.rating ?? -1) - (a.rating ?? -1);
        }
        if (sortBy === 'startDate') {
          return (b.startDate || '0') > (a.startDate || '0') ? 1 : -1;
        }
        return (b.createdAt || '') > (a.createdAt || '') ? 1 : -1;
      });
  }, [records, activeCategory, filterStatus, searchText, sortBy, hideWatched]);

  function handleEdit(record: WatchRecord) {
    setEditingRecord(record);
    setShowForm(true);
  }

  function handleSave(data: Omit<WatchRecord, 'id' | 'createdAt'>) {
    if (editingRecord) {
      updateRecord(editingRecord.id, data);
    } else {
      addRecord(data);
    }
    setEditingRecord(null);
  }

  function handleCloseForm() {
    setShowForm(false);
    setEditingRecord(null);
  }

  function handleDelete(id: string) {
    if (confirm('确定要删除这条记录吗？')) {
      deleteRecord(id);
    }
  }

  async function handleImport(imported: WatchRecord[]) {
    await replaceRecords(imported);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Top Bar */}
      <header className="bg-white border-b border-gray-100 sticky top-0 z-40 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🎬</span>
            <h1 className="text-lg font-bold text-gray-900 hidden sm:block">影视追踪</h1>
          </div>

          {/* Search */}
          <div className="flex-1 relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="搜索电影、剧集..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              className="w-full pl-9 pr-3 h-9 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition bg-gray-50"
            />
          </div>

          {/* Sort */}
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as typeof sortBy)}
            className="h-9 text-sm px-3 rounded-xl border border-gray-200 outline-none bg-white text-gray-600 cursor-pointer focus:border-indigo-400"
          >
            <option value="createdAt">最新添加</option>
            <option value="startDate">开始时间</option>
            <option value="rating">评分</option>
          </select>

          {/* Hide watched toggle */}
          <button
            onClick={() => setHideWatched(v => !v)}
            title={hideWatched ? '显示已看' : '隐藏已看'}
            className={`h-9 px-3 flex items-center gap-1.5 rounded-xl border text-sm transition-colors ${
              hideWatched
                ? 'bg-indigo-100 border-indigo-300 text-indigo-700'
                : 'border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            <span className="hidden sm:inline">{hideWatched ? '已看' : '全部'}</span>
          </button>

          {/* Sync Button */}
          {hasWebDAVCreds && (
            <div className="relative">
              <button
                onClick={handleQuickSync}
                disabled={syncing}
                title="手动同步到坚果云"
                className="h-9 px-3 flex items-center gap-1.5 rounded-xl border border-gray-200 text-gray-500 text-sm hover:bg-gray-50 hover:text-gray-700 transition-colors disabled:opacity-50"
              >
                {syncing ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 100 10z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h10a4 4 0 001.8-7.6A7 7 0 005.1 10.4 4 4 0 003 15z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11v6m-3-3l3-3 3 3" />
                  </svg>
                )}
              </button>
              {syncMsg && (
                <div className="absolute top-11 right-0 z-50 whitespace-nowrap bg-gray-800 text-white text-xs px-2.5 py-1.5 rounded-lg shadow-lg">
                  {syncMsg}
                </div>
              )}
            </div>
          )}

          {/* Sync Pause Toggle */}
          {hasWebDAVCreds && (
            <button
              onClick={toggleSyncPause}
              title={isSyncPaused ? '已暂停自动同步，点击恢复' : '正在自动同步，点击暂停'}
              className={`h-9 px-3 flex items-center gap-1.5 rounded-xl border transition-colors ${
                isSyncPaused 
                  ? 'bg-amber-50 border-amber-200 text-amber-600' 
                  : 'bg-green-50 border-green-200 text-green-600'
              }`}
            >
              {isSyncPaused ? (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v4m4-4v4m-9-4h18c1.1 0 2 .9 2 2v6c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-6c0-1.1.9-2 2-2z" /></svg>
                  <span className="text-xs font-bold hidden md:block">已暂停</span>
                </>
              ) : (
                <>
                  <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                  <span className="text-xs font-bold hidden md:block">同步中</span>
                </>
              )}
            </button>
          )}

          {/* View Mode Toggle */}
          <button
            onClick={() => setViewMode(v => v === 'list' ? 'poster' : 'list')}
            title={viewMode === 'list' ? '切换至海报墙' : '切换至列表'}
            className={`h-9 px-3 flex items-center gap-1.5 rounded-xl border transition-colors ${
              viewMode === 'poster'
                ? 'bg-indigo-100 border-indigo-300 text-indigo-700'
                : 'border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
          >
            {viewMode === 'list' ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
            )}
          </button>

          {/* Settings */}
          <button
            onClick={() => setShowSettings(true)}
            className="h-9 px-3 flex items-center gap-1.5 rounded-xl border border-gray-200 text-gray-500 text-sm hover:bg-gray-50 hover:text-gray-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {/* Add Button */}
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 px-4 h-9 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span className="hidden sm:inline">添加</span>
          </button>
        </div>
      </header>

      {/* Stats & Category Tabs */}
      <StatsBar
        records={records}
        categories={categories}
        activeCategory={activeCategory}
        onCategoryChange={setActiveCategory}
        filterStatus={filterStatus}
        onFilterStatusChange={setFilterStatus}
        lastSync={lastSync}
        isSyncing={syncing}
      />

      {/* Content */}
      <main className="max-w-5xl mx-auto w-full px-4 pb-8 flex-1 mt-4">
        {loading ? (
          <div className="space-y-8 animate-pulse">
            {[1, 2].map(group => (
              <div key={group}>
                <div className="h-6 w-24 bg-gray-200 rounded-full mb-4" />
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-32 bg-gray-100 rounded-2xl" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <span className="text-5xl mb-4">🎭</span>
            <p className="text-base font-medium">
              {searchText ? '没有找到匹配的记录' : '还没有记录，快去添加吧！'}
            </p>
            {!searchText && (
              <button
                onClick={() => setShowForm(true)}
                className="mt-4 px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors"
              >
                添加第一条记录
              </button>
            )}
          </div>
        ) : viewMode === 'list' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map(record => (
              <RecordCard
                key={record.id}
                record={record}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onStatusChange={(id, status) => {
                  const record = records.find(r => r.id === id);
                  const updates: Partial<WatchRecord> = { status };
                  
                  // 状态改为"在看"时，自动填充开始时间
                  if (status === '在看') {
                    if (record && !record.startDate) {
                      updates.startDate = new Date().toISOString().slice(0, 10);
                    }
                  }
                  // 状态改为"已看"时
                  if (status === '已看') {
                    // 自动填充结束时间
                    if (record && !record.endDate) {
                      updates.endDate = new Date().toISOString().slice(0, 10);
                    }
                    // 如果是电影，自动填满进度
                    if (record && (record.category === '电影' || record.category === '纪录片' || record.category === '动画') && record.movieDuration) {
                      updates.movieProgress = record.movieDuration;
                    }
                    // 如果是电视剧，自动填入最后一集
                    if (record && !(record.category === '电影' || record.category === '纪录片' || record.category === '动画')) {
                      updates.progress = record.totalEpisodes ? `第${record.totalEpisodes}集` : '完结';
                    }
                  }
                  updateRecord(id, updates);
                }}
                onProgressChange={(id, progress) => {
                  const record = records.find(r => r.id === id);
                  const updates: Partial<WatchRecord> = { progress };
                  if (record && record.status === '未看') {
                    updates.status = '在看';
                    if (!record.startDate) {
                      updates.startDate = new Date().toISOString().slice(0, 10);
                    }
                  }
                  updateRecord(id, updates);
                }}
                getEmoji={getEmoji}
              />
            ))}
          </div>
        ) : (
          /* Poster Wall View */
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filtered.map(record => (
              <div 
                key={record.id}
                onClick={() => handleEdit(record)}
                className="group relative aspect-[2/3] bg-gray-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-xl transition-all cursor-pointer hover:-translate-y-1"
              >
                {record.posterPath ? (
                  <img 
                    src={`poster://${record.posterPath.replace(/^\//, '')}`} 
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      if (!target.src.includes('tmdb.org')) {
                        target.src = `https://image.tmdb.org/t/p/w342${record.posterPath}`;
                      }
                    }}
                    alt={record.chineseName}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center bg-gradient-to-br from-gray-100 to-gray-200">
                    <span className="text-3xl mb-2">🎬</span>
                    <span className="text-xs font-bold text-gray-500 line-clamp-3">{record.chineseName}</span>
                  </div>
                )}
                
                {/* Overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
                  <div className="text-white">
                    <div className="text-xs font-bold truncate">{record.chineseName}</div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] bg-white/20 px-1.5 py-0.5 rounded backdrop-blur-md">
                        {record.releaseYear || '未知'}
                      </span>
                      <span className="text-amber-400 text-[10px] font-bold">
                        ⭐ {record.rating || '-'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Status Badge */}
                <div className="absolute top-2 right-2">
                   <div className={`text-[10px] px-2 py-0.5 rounded-full font-bold backdrop-blur-md border border-white/20 shadow-sm ${
                     record.status === '在看' ? 'bg-blue-500/80 text-white' : 
                     record.status === '已看' ? 'bg-green-500/80 text-white' : 
                     'bg-gray-500/80 text-white'
                   }`}>
                     {record.status}
                   </div>
                </div>

                {/* Progress Mini Bar (for TV) */}
                {record.totalEpisodes && record.progress && (
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
                    {(() => {
                      const match = record.progress.match(/\d+/);
                      if (match) {
                        const current = parseInt(match[0]);
                        const percent = Math.min((current / record.totalEpisodes) * 100, 100);
                        return <div className="h-full bg-indigo-500" style={{ width: `${percent}%` }} />;
                      }
                      return null;
                    })()}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Form Modal */}
      {showForm && (
        <RecordForm
          record={editingRecord}
          categories={categories}
          onSave={handleSave}
          onClose={handleCloseForm}
        />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal
          records={records}
          categories={categories}
          onAddCategory={addCategory}
          onUpdateCategory={updateCategory}
          onDeleteCategory={deleteCategory}
          onClose={async () => {
            setShowSettings(false);
            const credsOk = await hasCreds();
            setHasWebDAVCreds(credsOk);
          }}
          onImport={handleImport}
          syncInterval={syncInterval}
          onSyncIntervalChange={setSyncInterval}
        />
      )}
    </div>
  );
}
