import { useState, useMemo, useEffect } from 'react';
import { KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { invoke } from '@tauri-apps/api/core';
import { WatchRecord, Category, Status } from '../shared/types';
import { useWatchList } from '../features/watchlist/hooks/useWatchList';
import { useCategories } from '../features/categories/hooks/useCategories';
import StatsBar from '../features/watchlist/components/StatsBar';
import RecordForm from '../features/watchlist/components/RecordForm';
import SettingsModal from '../features/settings/components/SettingsModal';
import Dashboard from '../features/dashboard/components/Dashboard';
import { hasCreds } from '../shared/lib/webdav';
import { calculateWatchValue } from '../shared/lib/analytics';

// New Split Components
import Header from '../features/watchlist/components/Header';
import ListView from '../features/watchlist/components/ListView';
import PosterWall from '../features/watchlist/components/PosterWall';

type FilterStatus = Status | 'all';

export default function App() {
  const [syncInterval, setSyncInterval] = useState(30);
  const { 
    records, loadRecords, addRecord, updateRecord, deleteRecord, replaceRecords, reorderRecords, syncNow, restoreRecord,
    isSyncPaused, toggleSyncPause 
  } = useWatchList(syncInterval);
  
  const { categories, loadCategories, addCategory, updateCategory, deleteCategory, getEmoji } = useCategories();
  
  const [activeCategory, setActiveCategory] = useState<Category | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [searchText, setSearchText] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingRecord, setEditingRecord] = useState<WatchRecord | null>(null);
  const [sortBy, setSortBy] = useState<'createdAt' | 'startDate' | 'rating' | 'releaseYear' | 'watchValue' | 'custom'>('createdAt');
  const [showSettings, setShowSettings] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [lockFilter, setLockFilter] = useState<'all' | 'locked' | 'unlocked'>('all');
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
        const credsOk = await hasCreds();
        setHasWebDAVCreds(credsOk);
        const savedInterval = await invoke<string | null>('get_setting', { key: 'sync_interval' });
        if (savedInterval) {
          setSyncInterval(parseInt(savedInterval, 10));
        }
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
    if (!(await hasCreds())) {
      setSyncMsg('⚙️ 请先在设置里配置坚果云账号');
      setTimeout(() => setSyncMsg(''), 3000);
      return;
    }
    setSyncing(true);
    setSyncMsg('');
    const result = await syncNow();
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
        if (lockFilter === 'locked' && !r.isLocked) return false;
        if (lockFilter === 'unlocked' && r.isLocked) return false;
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
        if (sortBy === 'releaseYear') {
          return (b.releaseYear || '0') > (a.releaseYear || '0') ? 1 : -1;
        }
        if (sortBy === 'startDate') {
          return (b.startDate || '0') > (a.startDate || '0') ? 1 : -1;
        }
        if (sortBy === 'watchValue') {
          const valA = calculateWatchValue(a, records);
          const valB = calculateWatchValue(b, records);
          return valB - valA;
        }
        if (sortBy === 'custom') {
          return (a.sortOrder || 0) - (b.sortOrder || 0);
        }
        return (b.createdAt || '') > (a.createdAt || '') ? 1 : -1;
      });
  }, [records, activeCategory, filterStatus, searchText, sortBy, lockFilter]);

  // 排序必须基于完整记录集，否则筛选后的局部顺序会与未筛选记录发生冲突。
  const canReorder =
    sortBy === 'custom' &&
    activeCategory === 'all' &&
    filterStatus === 'all' &&
    lockFilter === 'all' &&
    searchText.trim() === '';

  function handleEdit(record: WatchRecord) {
    setEditingRecord(record);
    setShowForm(true);
  }

  async function handleSave(data: Omit<WatchRecord, 'id' | 'createdAt'>) {
    const today = new Date().toISOString().split('T')[0];
    if (data.status === '在看' && !data.startDate) data.startDate = today;
    if (data.status === '已看' && !data.endDate) data.endDate = today;
    if (data.originCountry && (data.originCountry.includes('CN') || data.originCountry.includes('中国'))) {
      data.platform = '';
    }

    if (editingRecord) {
      if (data.imdbId) {
        const duplicate = records.find(r => r.imdbId === data.imdbId && r.id !== editingRecord.id);
        if (duplicate) {
          if (!window.confirm(`检测到已有相同 IMDb ID (${data.imdbId}) 的记录：【${duplicate.chineseName}】。\n是否继续修改？`)) {
            return false;
          }
        }
      }
      await updateRecord(editingRecord.id, data);
    } else {
      if (data.imdbId) {
        const duplicate = records.find(r => r.imdbId === data.imdbId);
        if (duplicate) {
          if (!window.confirm(`检测到已有相同 IMDb ID (${data.imdbId}) 的记录：【${duplicate.chineseName}】。\n是否继续添加？`)) {
            return false;
          }
        }
      }
      await addRecord(data);
    }
    setEditingRecord(null);
    return true;
  }

  function handleCloseForm() {
    setShowForm(false);
    setEditingRecord(null);
  }

  async function handleDelete(id: string) {
    if (confirm('确定要删除这条记录吗？')) {
      await deleteRecord(id);
    }
  }

  async function handleImport(imported: WatchRecord[]) {
    await replaceRecords(imported);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragEnd(event: DragEndEvent) {
    if (!canReorder) return;
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = filtered.findIndex((r) => r.id === active.id);
      const newIndex = filtered.findIndex((r) => r.id === over.id);
      const newFiltered = arrayMove(filtered, oldIndex, newIndex);
      const newIds = newFiltered.map(r => r.id);
      reorderRecords(newIds);
    }
  }

  async function handleLockToggle(id: string) {
    const r = records.find(r => r.id === id);
    if (r) {
      await updateRecord(id, { isLocked: !r.isLocked });
    }
  }

  async function handleStatusChange(id: string, status: Status) {
    const record = records.find(r => r.id === id);
    const updates: Partial<WatchRecord> = { status };
    
    if (status === '在看') {
      if (record && !record.startDate) {
        updates.startDate = new Date().toISOString().slice(0, 10);
      }
    }
    if (status === '已看') {
      if (record && !record.endDate) {
        updates.endDate = new Date().toISOString().slice(0, 10);
      }
      if (record && (record.category === '电影' || record.category === '纪录片' || record.category === '动画') && record.movieDuration) {
        updates.movieProgress = record.movieDuration;
      }
      if (record && !(record.category === '电影' || record.category === '纪录片' || record.category === '动画')) {
        updates.progress = record.totalEpisodes ? `第${record.totalEpisodes}集` : '完结';
      }
    }
    await updateRecord(id, updates);
  }

  async function handleProgressChange(id: string, progress: string) {
    const record = records.find(r => r.id === id);
    const updates: Partial<WatchRecord> = { progress };
    if (record && record.status === '未看') {
      updates.status = '在看';
      if (!record.startDate) {
        updates.startDate = new Date().toISOString().slice(0, 10);
      }
    }
    await updateRecord(id, updates);
  }

  return (
    <div className="h-screen overflow-hidden bg-gray-50 flex flex-col">
      {/* Top Header Bar */}
      <Header
        searchText={searchText}
        onSearchChange={setSearchText}
        sortBy={sortBy}
        onSortByChange={setSortBy}
        lockFilter={lockFilter}
        onLockFilterChange={setLockFilter}
        hasWebDAVCreds={hasWebDAVCreds}
        syncing={syncing}
        syncMsg={syncMsg}
        onQuickSync={handleQuickSync}
        isSyncPaused={isSyncPaused}
        onToggleSyncPause={toggleSyncPause}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onShowDashboard={() => setShowDashboard(true)}
        onShowSettings={() => setShowSettings(true)}
        onShowForm={() => setShowForm(true)}
      />

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

      {/* Content Main Area */}
      <main className="custom-scrollbar min-h-0 max-w-5xl mx-auto w-full flex-1 overflow-y-auto px-4 pb-8 mt-4">
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
          <>
            {sortBy === 'custom' && !canReorder && (
              <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                清除分类、状态、锁定和搜索筛选后，才可调整自定义排序。
              </p>
            )}
            <ListView
              filtered={filtered}
              sensors={sensors}
              onDragEnd={handleDragEnd}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onLockToggle={handleLockToggle}
              onStatusChange={handleStatusChange}
              onProgressChange={handleProgressChange}
              getEmoji={getEmoji}
              canReorder={canReorder}
            />
          </>
        ) : (
          <PosterWall
            filtered={filtered}
            onEdit={handleEdit}
          />
        )}
      </main>

      {/* Form Modal */}
      {showForm && (
        <RecordForm
          record={editingRecord}
          categories={categories}
          onSave={handleSave}
          onDelete={handleDelete}
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
          onSync={syncNow}
          onRestoreConflict={restoreRecord}
          onRefresh={loadRecords}
          syncInterval={syncInterval}
          onSyncIntervalChange={setSyncInterval}
        />
      )}

      {/* Dashboard Modal */}
      {showDashboard && (
        <Dashboard
          records={records}
          onClose={() => setShowDashboard(false)}
        />
      )}
    </div>
  );
}
