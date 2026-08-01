import { lazy, Suspense, useCallback, useState, useMemo, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WatchRecord, MediaType, Status } from '../shared/types';
import { useWatchList } from '../features/watchlist/hooks/useWatchList';
import StatsBar from '../features/watchlist/components/StatsBar';
import RecordForm from '../features/watchlist/components/RecordForm';
import SettingsModal from '../features/settings/components/SettingsModal';
import { hasCreds } from '../shared/lib/webdav';
import { calculateWatchValue } from '../shared/lib/analytics';
import { mediaTypeOf } from '../shared/lib/classification';
import type { RegionFilter } from '../shared/lib/countryNames';
import { effectiveRegionOf, filterRecords, regionOptionsForScope } from '../shared/lib/filtering';
import { initializeApp } from './initialization';
import NotificationRegion, { useNotifications } from '../shared/components/NotificationRegion';
import { notifyOperationFailure, publicFailureMessage, reportOperationFailure } from '../shared/lib/feedback';

// New Split Components
import Header from '../features/watchlist/components/Header';
import ListView from '../features/watchlist/components/ListView';
import PosterWall from '../features/watchlist/components/PosterWall';

type FilterStatus = Status | 'all';
type InitializationState = 'loading' | 'ready' | 'error';

const Dashboard = lazy(() => import('../features/dashboard/components/Dashboard'));

function localDateString(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

export default function App() {
  const [syncInterval, setSyncInterval] = useState(30);
  const { notices, notify, dismiss } = useNotifications();
  const handleBackgroundError = useCallback((message: string) => {
    notify('warning', message);
  }, [notify]);
  const {
    records, loadRecords, addRecord, updateRecord, deleteRecord, replaceRecords, syncNow, restoreRecord,
    isSyncPaused, toggleSyncPause
  } = useWatchList(syncInterval, handleBackgroundError);

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
  const [initializationState, setInitializationState] = useState<InitializationState>('loading');
  const [viewMode, setViewMode] = useState<'list' | 'poster'>('list');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [hasWebDAVCreds, setHasWebDAVCreds] = useState(false);

  const loadInitialState = useCallback(async () => {
    try {
      const result = await initializeApp({
        readCredentials: hasCreds,
        readSyncInterval: () => invoke<string | null>('get_setting', { key: 'sync_interval' }),
        readRecords: loadRecords,
      });
      setHasWebDAVCreds(result.hasWebDAVCredentials);
      setSyncInterval(result.syncInterval);
      setInitializationState('ready');
    } catch (error) {
      reportOperationFailure('App.Initialize', error);
      setInitializationState('error');
    }
  }, [loadRecords]);

  const retryInitialization = useCallback(() => {
    setInitializationState('loading');
    void loadInitialState();
  }, [loadInitialState]);

  useEffect(() => {
    // Initialization crosses the Tauri IPC boundary; all state updates occur
    // after the awaited reads complete.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInitialState();
  }, [loadInitialState]);

  // 手动同步到坚果云 WebDAV
  async function handleQuickSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      if (!(await hasCreds())) {
        const message = '请先在设置里配置 WebDAV 账号。';
        setSyncMsg(`⚙️ ${message}`);
        notify('warning', message);
        return;
      }
      const result = await syncNow();
      if (result.ok) {
        setSyncMsg('✅ 已同步');
        notify('success', '同步完成。');
        setLastSync(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      } else {
        const message = publicFailureMessage('同步');
        setSyncMsg(`❌ ${message}`);
        notify('error', message);
      }
    } catch (error) {
      reportOperationFailure('App.QuickSync', error);
      const message = publicFailureMessage('同步');
      setSyncMsg(`❌ ${message}`);
      notify('error', message);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(''), 3000);
    }
  }

  const regionOptions = useMemo(
    () => regionOptionsForScope(records, activeMediaType, filterStatus),
    [records, activeMediaType, filterStatus],
  );
  const effectiveRegion = effectiveRegionOf(activeRegion, regionOptions);

  useEffect(() => {
    if (activeRegion !== effectiveRegion) {
      // effectiveRegion already makes this render safe; persist the cleanup after render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveRegion(effectiveRegion);
    }
  }, [activeRegion, effectiveRegion]);

  const filtered = useMemo(() => {
    return filterRecords(records, {
      mediaType: activeMediaType,
      status: filterStatus,
      region: effectiveRegion,
      searchText,
      lock: lockFilter,
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
  }, [records, activeMediaType, filterStatus, effectiveRegion, searchText, sortBy, lockFilter]);


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

    try {
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
        notify('success', '记录已更新。');
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
        notify('success', '记录已添加。');
      }
      setEditingRecord(null);
      return true;
    } catch (error) {
      notifyOperationFailure('App.SaveRecord', editingRecord ? '更新记录' : '添加记录', error, notify);
      return false;
    }
  }

  function handleCloseForm() {
    setShowForm(false);
    setEditingRecord(null);
  }

  async function handleDelete(id: string) {
    if (confirm('确定要删除这条记录吗？')) {
      try {
        await deleteRecord(id);
        notify('success', '记录已删除。');
      } catch (error) {
        reportOperationFailure('App.DeleteRecord', error);
        notify('error', publicFailureMessage('删除记录'));
      }
    }
  }

  async function handleImport(imported: WatchRecord[]) {
    await replaceRecords(imported);
  }

  async function handleLockToggle(id: string) {
    const r = records.find(r => r.id === id);
    if (r) {
      try {
        await updateRecord(id, { isLocked: !r.isLocked });
      } catch (error) {
        reportOperationFailure('App.ToggleLock', error);
        notify('error', publicFailureMessage('更新锁定状态'));
      }
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
    try {
      await updateRecord(id, updates);
    } catch (error) {
      reportOperationFailure('App.ChangeStatus', error);
      notify('error', publicFailureMessage('更新观看状态'));
    }
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
    try {
      await updateRecord(id, updates);
    } catch (error) {
      reportOperationFailure('App.ChangeProgress', error);
      notify('error', publicFailureMessage('更新进度'));
    }
  }

  return (
    <div className="h-screen overflow-hidden bg-gray-50 flex flex-col">
      <NotificationRegion notices={notices} onDismiss={dismiss} />
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
        regionOptions={regionOptions}
        activeMediaType={activeMediaType}
        onMediaTypeChange={setActiveMediaType}
        filterStatus={filterStatus}
        onFilterStatusChange={setFilterStatus}
        activeRegion={effectiveRegion}
        onRegionChange={setActiveRegion}
        lastSync={lastSync}
        isSyncing={syncing}
      />

      {/* Content Main Area */}
      <main className="custom-scrollbar min-h-0 max-w-5xl mx-auto w-full flex-1 overflow-y-auto px-4 pb-8 mt-4">
        {initializationState === 'loading' ? (
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
        ) : initializationState === 'error' ? (
          <div className="mx-auto mt-16 max-w-lg rounded-3xl border border-red-100 bg-white p-8 text-center shadow-sm" role="alert">
            <span className="mb-4 block text-5xl" aria-hidden="true">⚠️</span>
            <h1 className="text-xl font-black text-gray-900">无法读取本地数据</h1>
            <p className="mt-2 text-sm leading-6 text-gray-500">当前列表没有被当作空数据处理。请确认数据目录可用后重试。</p>
            <button
              type="button"
              onClick={retryInitialization}
              className="mt-6 rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-bold text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              重试加载
            </button>
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
          onNotify={notify}
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
          onNotify={notify}
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
