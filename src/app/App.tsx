import { lazy, Suspense, useState, useMemo, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WatchRecord, MediaType, Status } from '../shared/types';
import { useWatchList } from '../features/watchlist/hooks/useWatchList';
import StatsBar from '../features/watchlist/components/StatsBar';
import RecordForm from '../features/watchlist/components/RecordForm';
import SettingsModal from '../features/settings/components/SettingsModal';
import { hasCreds } from '../shared/lib/webdav';
import { calculateWatchValue } from '../shared/lib/analytics';
import { hasRegion, mediaTypeOf, RegionTag } from '../shared/lib/classification';

// New Split Components
import Header from '../features/watchlist/components/Header';
import ListView from '../features/watchlist/components/ListView';
import PosterWall from '../features/watchlist/components/PosterWall';

type FilterStatus = Status | 'all';
type RegionFilter = 'all' | RegionTag;

const Dashboard = lazy(() => import('../features/dashboard/components/Dashboard'));

function localDateString(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

export default function App() {
  const [syncInterval, setSyncInterval] = useState(30);
  const {
    records, loadRecords, addRecord, updateRecord, deleteRecord, replaceRecords, syncNow, restoreRecord,
    isSyncPaused, toggleSyncPause
  } = useWatchList(syncInterval);

  const [activeMediaType, setActiveMediaType] = useState<MediaType | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [activeRegion, setActiveRegion] = useState<RegionFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingRecord, setEditingRecord] = useState<WatchRecord | null>(null);
  const [sortBy, setSortBy] = useState<'createdAt' | 'endDate' | 'rating' | 'releaseYear' | 'watchValue'>('createdAt');
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
        await loadRecords();
      } catch (e) {
        console.error('[App] 加载数据失败:', e);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [loadRecords]);

  // 手动同步到坚果云 WebDAV
  async function handleQuickSync() {
    if (!(await hasCreds())) {
      setSyncMsg('⚙️ 请先在设置里配置坚果云账号');
      setTimeout(() => setSyncMsg(''), 3000);
      return;
    }
    setSyncing(true);
    setSyncMsg('');
    try {
      const result = await syncNow();
      if (result.ok) {
        setSyncMsg('✅ 已同步');
        setLastSync(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      } else {
        setSyncMsg(`❌ ${result.error ?? '同步失败'}`);
      }
    } catch (error) {
      setSyncMsg(`❌ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(''), 3000);
    }
  }

  const filtered = useMemo(() => {
    return records
      .filter(r => {
        if (activeMediaType !== 'all' && mediaTypeOf(r) !== activeMediaType) return false;
        if (filterStatus !== 'all' && r.status !== filterStatus) return false;
        if (activeRegion !== 'all' && !hasRegion(r, activeRegion)) return false;
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
          return (b.releaseYear || '').localeCompare(a.releaseYear || '', undefined, { numeric: true });
        }
        if (sortBy === 'endDate') {
          if (!a.endDate && !b.endDate) return 0;
          if (!a.endDate) return 1;
          if (!b.endDate) return -1;
          return b.endDate.localeCompare(a.endDate);
        }
        if (sortBy === 'watchValue') {
          const valA = calculateWatchValue(a, records);
          const valB = calculateWatchValue(b, records);
          return valB - valA;
        }
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      });
  }, [records, activeMediaType, filterStatus, activeRegion, searchText, sortBy, lockFilter]);


  function handleEdit(record: WatchRecord) {
    setEditingRecord(record);
    setShowForm(true);
  }

  async function handleSave(data: Omit<WatchRecord, 'id' | 'createdAt'>) {
    const today = localDateString();
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
        updates.startDate = localDateString();
      }
    }
    if (status === '已看') {
      if (record && !record.endDate) {
        updates.endDate = localDateString();
      }
      if (record) {
        const episodic = Boolean(record.totalEpisodes) || ['剧集', '综艺'].includes(mediaTypeOf(record));
        if (!episodic && record.movieDuration) updates.movieProgress = record.movieDuration;
        if (episodic) updates.progress = record.totalEpisodes ? '第' + record.totalEpisodes + '集' : '完结';
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
        updates.startDate = localDateString();
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

      {/* Stats and media type tabs */}
      <StatsBar
        records={records}
        activeMediaType={activeMediaType}
        onMediaTypeChange={(type) => { setActiveMediaType(type); setActiveRegion('all'); }}
        filterStatus={filterStatus}
        onFilterStatusChange={setFilterStatus}
        activeRegion={activeRegion}
        onRegionChange={(region) => setActiveRegion(region as RegionFilter)}
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
            <ListView
              filtered={filtered}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onLockToggle={handleLockToggle}
              onStatusChange={handleStatusChange}
              onProgressChange={handleProgressChange}
            />
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
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={handleCloseForm}
        />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal
          records={records}
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
        <Suspense fallback={<div className="fixed inset-0 z-50 grid place-items-center bg-[#0b1020] text-sm font-semibold text-slate-300">正在加载看板...</div>}>
          <Dashboard
            records={records}
            onClose={() => setShowDashboard(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
