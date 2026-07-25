import { useState, useEffect } from 'react';
import { MediaType, Status, WatchRecord } from '../../../shared/types';
import {
  saveCreds, clearCreds, syncToWebDAV, loadFromWebDAV, hasCreds, clearResolvedSyncConflicts, clearSyncConflicts, type SyncConflict,
} from '../../../shared/lib/webdav';
import { getSettingAsync, setSettingAsync, safeEncrypt, safeDecrypt, vacuumDbAsync, searchTmdbAsync, getTmdbDetailAsync, updateRecord as updateRecordDb } from '../../../shared/lib/database';
import { classifyTmdb, errorMessage, MEDIA_TYPES, mediaTypeOf, mergeContentTags, regionsOf, TmdbMedia } from '../../../shared/lib/classification';

interface SettingsModalProps {
  onClose: () => void;
  records: WatchRecord[];
  onImport: (records: WatchRecord[]) => void | Promise<void>;
  onSync?: () => Promise<{ ok: boolean; error?: string; conflictCount?: number }>;
  onRestoreConflict?: (record: WatchRecord) => Promise<void>;
  onRefresh?: () => unknown | Promise<unknown>;
  syncInterval: number;
  onSyncIntervalChange: (val: number) => void;
}

const VALID_STATUSES: readonly Status[] = ['在看', '未看', '已看'];

function normalizeImportedRecord(value: unknown, index: number): WatchRecord {
  if (!value || typeof value !== 'object') throw new Error('第 ' + (index + 1) + ' 条记录格式无效');
  const source = value as Record<string, unknown>;
  const text = (key: string, fallback = '') => typeof source[key] === 'string' ? source[key] as string : fallback;
  const nullableText = (key: string) => typeof source[key] === 'string' && source[key] !== '' ? source[key] as string : null;
  const nullableNumber = (key: string) => typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] as number : null;
  const requestedType = nullableText('mediaType');
  const mediaType = requestedType && MEDIA_TYPES.includes(requestedType as MediaType)
    ? requestedType as MediaType
    : '电影';
  const requestedStatus = text('status', '已看');
  const status = VALID_STATUSES.includes(requestedStatus as Status) ? requestedStatus as Status : '已看';
  return {
    id: text('id', 'imported-' + Date.now() + '-' + index),
    originalName: text('originalName'),
    chineseName: text('chineseName'),
    progress: text('progress'),
    totalEpisodes: nullableNumber('totalEpisodes'),
    movieProgress: nullableNumber('movieProgress'),
    movieDuration: nullableNumber('movieDuration'),
    releaseYear: source.releaseYear == null ? null : String(source.releaseYear),
    posterPath: nullableText('posterPath'),
    status,
    platform: text('platform'),
    rating: nullableNumber('rating'),
    startDate: text('startDate'),
    endDate: text('endDate'),
    notes: text('notes'),
    createdAt: text('createdAt', new Date().toISOString()),
    updatedAt: nullableText('updatedAt'),
    imdbId: nullableText('imdbId'),
    isLocked: source.isLocked === true,
    genres: nullableText('genres'),
    originCountry: nullableText('originCountry'),
    imdbRating: nullableNumber('imdbRating'),
    tmdbStatus: nullableText('tmdbStatus'),
    interestLevel: nullableNumber('interestLevel'),
    episodeRuntime: nullableNumber('episodeRuntime'),
    mediaType,
    contentTags: nullableText('contentTags'),
  };
}
export default function SettingsModal({
  onClose, records, onImport, onSync, onRestoreConflict, onRefresh,
  syncInterval, onSyncIntervalChange
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'basic' | 'sync' | 'categories' | 'tools'>('basic');

  // WebDAV 状态
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [importStatus, setImportStatus] = useState<string>('');
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);

  // 自动同步频率状态
  const [localInterval, setLocalInterval] = useState(syncInterval);

  // 代理设置状态
  const [proxy, setProxy] = useState('');

  // TMDB 状态
  const [tmdbKey, setTmdbKey] = useState('');
  const [tmdbSaved, setTmdbSaved] = useState(false);

  const [vacuumStatus, setVacuumStatus] = useState<string>('');

  // 批量同步状态
  const [batchSyncing, setBatchSyncing] = useState(false);
  const [batchStatus, setBatchStatus] = useState('');
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);

  // 初始化加载设置
  useEffect(() => {
    async function loadInitial() {
      // 1. 检查 WebDAV 状态
      const webdavSaved = await hasCreds();
      setSaved(webdavSaved);

      // 2. 加载 TMDB Key
      const encryptedTmdb = await getSettingAsync('tmdb_api_key');
      if (encryptedTmdb) {
        try {
          const decrypted = await safeDecrypt(encryptedTmdb);
          if (decrypted === '__ERR_DECRYPT_VERSION_MISMATCH__' || decrypted === '__ERR_DECRYPT_FAILED__') {
            console.warn('[Settings] Legacy TMDB Key detected, reset required.');
            setTmdbSaved(false);
          } else if (decrypted) {
            setTmdbKey(decrypted);
            setTmdbSaved(true);
          }
        } catch (e) {
          console.error('[Settings] Failed to decrypt TMDB Key:', e);
        }
      }

      // 3. 加载代理设置
      const savedProxy = await getSettingAsync('network_proxy');
      if (savedProxy) setProxy(savedProxy);
    }
    loadInitial();
  }, []);

  useEffect(() => {
    let cancelled = false;
    clearResolvedSyncConflicts(records)
      .then(conflicts => { if (!cancelled) setSyncConflicts(conflicts); })
      .catch(error => console.error('[Settings] Failed to load sync conflicts:', error));
    return () => { cancelled = true; };
  }, [records]);

  // 保存 TMDB 密钥
  async function handleSaveTmdbKey() {
    if (!tmdbKey.trim()) return;
    try {
      // 存储前先清空旧值，确保触发更新
      await setSettingAsync('tmdb_api_key', '');
      const encrypted = await safeEncrypt(tmdbKey.trim(), 'tmdb_api_key');
      await setSettingAsync('tmdb_api_key', encrypted);
      setTmdbSaved(true);
      setSyncStatus('✅ TMDB 密钥已保存');
      setTimeout(() => setSyncStatus(''), 2000);
    } catch (e) {
      console.error('[Settings] Failed to save TMDB Key:', e);
      setSyncStatus('❌ 保存失败');
    }
  }

  // 清除 TMDB 密钥
  async function handleClearTmdbKey() {
    if (!confirm('确定清除已保存的 TMDB 密钥吗？')) return;
    try {
      await setSettingAsync('tmdb_api_key', '');
      setTmdbKey('');
      setTmdbSaved(false);
      setSyncStatus('🧹 TMDB 密钥已清除');
      setTimeout(() => setSyncStatus(''), 2000);
    } catch (e) {
      alert('清除失败: ' + e);
    }
  }

  // 保存代理设置
  async function handleSaveProxy() {
    await setSettingAsync('network_proxy', proxy.trim());
    setSyncStatus('✅ 代理设置已更新');
    setTimeout(() => setSyncStatus(''), 2000);
  }

  // 保存 WebDAV 账号密码
  async function handleSave() {
    if (!username.trim() || !password.trim()) return;
    try {
      await saveCreds({ username: username.trim(), password: password.trim() });
      setSaved(true);
      setSyncStatus('✅ 凭据已保存');
    } catch (error) {
      setSyncStatus('❌ 保存失败: ' + errorMessage(error));
    }
    setTimeout(() => setSyncStatus(''), 3000);
  }

  // 清除云端连接
  async function handleClear() {
    try {
      await clearCreds();
      setUsername('');
      setPassword('');
      setSaved(false);
      setSyncStatus('🧹 凭据已清除');
    } catch (error) {
      setSyncStatus('❌ 清除失败: ' + errorMessage(error));
    }
    setTimeout(() => setSyncStatus(''), 3000);
  }

  // 同步到云端
  async function handleSync() {
    setSyncStatus('正在同步...');
    try {
      const result = onSync ? await onSync() : await syncToWebDAV(records);
      if (result.ok) {
        setSyncConflicts(await clearResolvedSyncConflicts(records));
        setSyncStatus(result.conflictCount ? `✅ 同步成功，已自动合并 ${result.conflictCount} 处冲突` : '✅ 同步成功');
      } else setSyncStatus(`❌ 同步失败: ${result.error}`);
    } catch (error) {
      setSyncStatus('❌ 出错: ' + errorMessage(error));
    }
    setTimeout(() => setSyncStatus(''), 3000);
  }

  async function handleRestoreConflict(conflict: SyncConflict) {
    if (!onRestoreConflict) return;
    if (!confirm(`确定恢复「${conflict.discarded.chineseName}」的被覆盖版本吗？恢复后会在下次同步时上传。`)) return;
    await onRestoreConflict(conflict.discarded);
    const remaining = syncConflicts.filter(item => item !== conflict);
    await clearSyncConflicts();
    // 保留未处理的记录。
    if (remaining.length) {
      await setSettingAsync('sync_conflicts', JSON.stringify(remaining));
    }
    setSyncConflicts(remaining);
  }

  async function handleClearConflicts() {
    if (!confirm('确定清空全部冲突记录吗？此操作不会删除任何影视条目。')) return;
    await clearSyncConflicts();
    setSyncConflicts([]);
  }

  // 从云端导入
  async function handleImport() {
    if (confirm('导入将替换未锁定的本地数据；已锁定记录会保留。确定吗？')) {
      setImportStatus('正在从云端下载数据...');
      try {
        const response = await loadFromWebDAV();
        if (response.ok && Array.isArray(response.data)) {
          await onImport(response.data as WatchRecord[]);
          setImportStatus('✅ 导入成功');
        } else {
          setImportStatus(`❌ 导入失败: ${response.error || '请检查账号密码'}`);
        }
      } catch (error) {
        setImportStatus('❌ 出错: ' + errorMessage(error));
      }
      setTimeout(() => setImportStatus(''), 3000);
    }
  }

  // 保存同步频率
  async function handleSaveInterval() {
    await setSettingAsync('sync_interval', localInterval.toString());
    onSyncIntervalChange(localInterval);
    setSyncStatus('✅ 自动同步频率已更新');
    setTimeout(() => setSyncStatus(''), 3000);
  }

  // 备份文件导出
  function handleExport() {
    const data = JSON.stringify(records, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `影视追踪_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // 本地文件导入
  function handleImportLocal() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = event => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          if (typeof reader.result !== 'string') throw new Error('无法读取文件内容');
          const parsed: unknown = JSON.parse(reader.result);
          if (!Array.isArray(parsed)) throw new Error('无效的 JSON 格式');
          const completeData = parsed.map(normalizeImportedRecord);
          await onImport(completeData);
          alert('成功导入 ' + completeData.length + ' 条记录');
        } catch (error) {
          alert('导入失败: ' + errorMessage(error));
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  // 快捷键退出
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // 数据库整理优化
  async function handleVacuum() {
    setVacuumStatus('正在压缩数据库...');
    try {
      await vacuumDbAsync();
      setVacuumStatus('✅ 数据库压缩完成');
    } catch (error) {
      setVacuumStatus('❌ 压缩失败: ' + errorMessage(error));
    }
    setTimeout(() => setVacuumStatus(''), 3000);
  }

  // 自动补全缺失字段
  async function handleBatchSync() {
    const targets = records.filter(record =>
      record.imdbId && !record.isLocked &&
      (!record.genres || record.episodeRuntime == null || !record.originCountry || record.contentTags == null),
    );
    if (!tmdbKey.trim()) {
      setBatchStatus('❌ 请先配置 TMDB API Key');
      return;
    }
    if (targets.length === 0) {
      setBatchStatus('🎉 所有带 IMDb 编号的记录均已包含完整元数据！');
      setTimeout(() => setBatchStatus(''), 3000);
      return;
    }
    if (!confirm('发现 ' + targets.length + ' 条缺失部分元数据的记录。是否开始批量同步？\n\n注意：期间请保持网络畅通。')) return;

    setBatchSyncing(true);
    setBatchTotal(targets.length);
    setBatchProgress(0);
    setBatchStatus('正在连接 TMDB...');
    let success = 0;
    let fail = 0;
    const tmdbCache = new Map<string, Partial<WatchRecord>>();

    for (let index = 0; index < targets.length; index++) {
      const record = targets[index];
      setBatchProgress(index + 1);
      setBatchStatus('正在同步: ' + record.chineseName);
      try {
        let updates = record.imdbId ? tmdbCache.get(record.imdbId) : undefined;
        if (!updates && record.imdbId) {
          const search = await searchTmdbAsync({ apiKey: tmdbKey.trim(), query: record.imdbId, language: 'zh-CN' });
          const expectedType = record.totalEpisodes || ['剧集', '综艺'].includes(mediaTypeOf(record)) ? 'tv' : 'movie';
          const item = search.results?.find(result => result.media_type === expectedType)
            ?? search.results?.find(result => result.media_type === 'movie' || result.media_type === 'tv');
          if (item?.id != null) {
            const tmdbType: 'movie' | 'tv' = item.media_type === 'tv' ? 'tv' : 'movie';
            const detailResult = await getTmdbDetailAsync({ apiKey: tmdbKey.trim(), id: item.id, mediaType: tmdbType, language: 'zh-CN' });
            if (detailResult.success && detailResult.data) {
              const detail: TmdbMedia = detailResult.data;
              const classification = classifyTmdb(detail, tmdbType === 'tv', mediaTypeOf(record));
              updates = {
                genres: classification.genres,
                originCountry: classification.originCountry,
                imdbRating: detail.vote_average ?? null,
                tmdbStatus: detail.status ?? null,
                episodeRuntime: detail.episode_run_time?.[0] ?? detail.runtime ?? null,
                mediaType: classification.mediaType,
                contentTags: classification.contentTags,
              };
              tmdbCache.set(record.imdbId, updates);
            }
          }
        }
        if (updates) {
          await updateRecordDb(record.id, {
            ...updates,
            contentTags: mergeContentTags(record.contentTags, updates.contentTags || ''),
          });
          success++;
        } else {
          fail++;
        }
      } catch (error) {
        console.error('[Settings] Failed to sync record', record.chineseName, error);
        fail++;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    setBatchSyncing(false);
    setBatchStatus('🎉 同步完成！成功: ' + success + ', 失败: ' + fail);
    await onRefresh?.();
    setTimeout(() => setBatchStatus(''), 5000);
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-gray-50 text-gray-800 font-sans overflow-hidden animate-fade-in animate-duration-200">
      {/* 左侧导航栏 */}
      <div className="w-64 bg-white border-r border-gray-200 flex flex-col justify-between shrink-0 select-none">
        <div>
          {/* 头部标题 */}
          <div className="px-6 py-8 border-b border-gray-100">
            <h2 className="text-xl font-black text-gray-900 flex items-center gap-2">
              <span>⚙️</span> 设置中心
            </h2>
            <p className="text-[10px] text-gray-400 font-mono mt-1 uppercase tracking-wider">System Settings</p>
          </div>

          {/* 导航菜单 */}
          <nav className="p-4 space-y-1">
            <button
              onClick={() => setActiveTab('basic')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-colors ${
                activeTab === 'basic'
                  ? 'bg-indigo-50 text-indigo-700 font-bold'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <span className="text-lg">🌐</span> 基础配置
            </button>
            <button
              onClick={() => setActiveTab('sync')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-colors ${
                activeTab === 'sync'
                  ? 'bg-indigo-50 text-indigo-700 font-bold'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <span className="text-lg">☁️</span> 云端同步
            </button>
            <button
              onClick={() => setActiveTab('categories')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-colors ${
                activeTab === 'categories'
                  ? 'bg-indigo-50 text-indigo-700 font-bold'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <span className="text-lg">🏷️</span> 类型与标签
            </button>
            <button
              onClick={() => setActiveTab('tools')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-colors ${
                activeTab === 'tools'
                  ? 'bg-indigo-50 text-indigo-700 font-bold'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <span className="text-lg">🛠️</span> 系统工具
            </button>
          </nav>
        </div>

        {/* 侧边栏底部返回 */}
        <div className="p-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-gray-200 hover:bg-gray-50 text-sm font-bold text-gray-700 transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            返回主页
          </button>
        </div>
      </div>

      {/* 右侧核心内容区 */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-gray-50/50 p-6 pr-4 sm:p-10 sm:pr-6 md:p-12 md:pr-8 custom-scrollbar">
        <div className="max-w-3xl mx-auto space-y-8">
          {/* Tab 1: 基础配置 */}
          {activeTab === 'basic' && (
            <div className="space-y-6 animate-fade-in animate-duration-200">
              <div>
                <h3 className="text-2xl font-black text-gray-900">🌐 基础配置</h3>
                <p className="text-xs text-gray-400 mt-1">配置核心服务密钥以及本地代理网络环境</p>
              </div>

              {/* TMDB API Key */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center justify-between border-b border-gray-50 pb-4">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl">🔍</span>
                    <div>
                      <h4 className="font-bold text-gray-800">影视元数据配置</h4>
                      <p className="text-[11px] text-gray-400">调用 TMDB 接口以获取影片海报、年份及详情信息</p>
                    </div>
                  </div>
                  {tmdbSaved && (
                    <span className="text-xs px-2.5 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded-full font-semibold">
                      已配置
                    </span>
                  )}
                </div>

                {!tmdbSaved ? (
                  <div className="space-y-3">
                    <input
                      type="password"
                      placeholder="输入 TMDB API KEY (V3)"
                      value={tmdbKey}
                      onChange={(e) => setTmdbKey(e.target.value)}
                      className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    />
                    <p className="text-[10px] text-gray-400">
                      💡 密钥将以便携兼容格式保存在本地 data 目录，请妥善保护该目录。可以在 TMDB 官网的个人设置中申请获取该 API 密钥。
                    </p>
                    <button
                      onClick={handleSaveTmdbKey}
                      className="py-2.5 px-6 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors disabled:opacity-50"
                      disabled={!tmdbKey.trim()}
                    >
                      保存密钥
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between bg-gray-50 rounded-2xl p-4">
                    <div className="flex items-center gap-2">
                      <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-sm text-gray-700 font-medium">已配置 TMDB API 密钥</span>
                    </div>
                    <button
                      onClick={handleClearTmdbKey}
                      className="text-xs text-red-500 hover:underline font-bold transition-all"
                    >
                      清除并重置
                    </button>
                  </div>
                )}
              </div>

              {/* Network Proxy */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center gap-2.5 border-b border-gray-50 pb-4">
                  <span className="text-2xl">🌐</span>
                  <div>
                    <h4 className="font-bold text-gray-800">网络代理 (可选)</h4>
                    <p className="text-[11px] text-gray-400">若你在获取 TMDB 元数据时遇到网络问题，请配置代理服务</p>
                  </div>
                </div>
                <p className="text-xs text-gray-500">
                  支持 HTTP / SOCKS 代理格式。例如：`http://127.0.0.1:7890`。若无网络墙阻拦，请保持为空。
                </p>
                <div className="flex gap-3">
                  <input
                    type="text"
                    placeholder="http://127.0.0.1:7890"
                    value={proxy}
                    onChange={(e) => setProxy(e.target.value)}
                    className="flex-1 px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                  />
                  <button
                    onClick={handleSaveProxy}
                    className="px-6 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 transition-colors"
                  >
                    保存代理
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: 云端同步 */}
          {activeTab === 'sync' && (
            <div className="space-y-6 animate-fade-in animate-duration-200">
              <div>
                <h3 className="text-2xl font-black text-gray-900">☁️ 云端同步</h3>
                <p className="text-xs text-gray-400 mt-1">通过 HTTPS 与坚果云等 WebDAV 服务同步影视记录</p>
              </div>

              {/* WebDAV Settings */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center justify-between border-b border-gray-50 pb-4">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl">☁️</span>
                    <div>
                      <h4 className="font-bold text-gray-800">坚果云 WebDAV 同步</h4>
                      <p className="text-[11px] text-gray-400">用于备份或同步影视记录数据</p>
                    </div>
                  </div>
                  {saved && (
                    <span className="text-xs px-2.5 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded-full font-semibold">
                      已配置
                    </span>
                  )}
                </div>

                {!saved ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <input
                        type="text"
                        placeholder="坚果云用户名（邮箱）"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                      />
                      <input
                        type="password"
                        placeholder="坚果云 WebDAV 应用密码"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                      />
                    </div>
                    <p className="text-[10px] text-gray-400">
                      💡 请在坚果云个人账号后台的「安全选项」中开通 WebDAV，并生成专用的「应用密码」填入。
                    </p>
                    <button
                      onClick={handleSave}
                      className="py-2.5 px-6 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors disabled:opacity-50"
                      disabled={!username.trim() || !password.trim()}
                    >
                      保存凭据
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between bg-gray-50 rounded-2xl p-4">
                      <div className="flex items-center gap-2">
                        <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="text-sm text-gray-700 font-medium">已配置坚果云 WebDAV，数据变动后会按设定间隔同步</span>
                      </div>
                      <button
                        onClick={handleClear}
                        className="text-xs text-red-500 hover:underline font-bold transition-all"
                      >
                        断开连接
                      </button>
                    </div>
                    <div className="flex gap-3">
                      <button
                        onClick={handleSync}
                        className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors shadow-sm"
                      >
                        ☁️ 立即同步到云端
                      </button>
                      <button
                        onClick={handleImport}
                        className="flex-1 py-2.5 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-semibold transition-colors shadow-sm"
                      >
                        📥 从云端导入覆盖
                      </button>
                    </div>
                  </div>
                )}
                {syncStatus && <p className="text-xs text-center text-indigo-600 font-medium mt-1">{syncStatus}</p>}
                {importStatus && <p className="text-xs text-center text-green-600 font-medium mt-1">{importStatus}</p>}
              </div>

              {/* Conflict history */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center justify-between border-b border-gray-50 pb-4">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl">⚖️</span>
                    <div>
                      <h4 className="font-bold text-gray-800">同步冲突记录</h4>
                      <p className="text-[11px] text-gray-400">自动合并时被覆盖的旧版本会暂存于此，可按需恢复</p>
                    </div>
                  </div>
                  {syncConflicts.length > 0 && <button onClick={handleClearConflicts} className="text-xs text-red-500 hover:underline font-bold">清空记录</button>}
                </div>
                {syncConflicts.length === 0 ? (
                  <p className="py-4 text-center text-sm text-gray-400">暂无同步冲突记录</p>
                ) : (
                  <div className="space-y-3 max-h-64 overflow-y-auto pr-1 custom-scrollbar">
                    {syncConflicts.map((conflict, index) => (
                      <div key={`${conflict.id}-${conflict.at}-${index}`} className="rounded-2xl border border-amber-100 bg-amber-50/50 p-4 flex items-center gap-3">
                        <span className="text-xl">⚠️</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-gray-800">{conflict.discarded.chineseName || '未命名条目'}</p>
                          <p className="text-[11px] text-gray-500">保留了{conflict.kept === 'local' ? '本机' : '云端'}版本 · {new Date(conflict.at).toLocaleString('zh-CN')}</p>
                        </div>
                        <button onClick={() => handleRestoreConflict(conflict)} disabled={!onRestoreConflict} className="shrink-0 rounded-xl bg-amber-500 px-3 py-2 text-xs font-bold text-white hover:bg-amber-600 disabled:bg-gray-300">恢复此版本</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>              {/* Auto Sync Settings */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center gap-2.5 border-b border-gray-50 pb-4">
                  <span className="text-2xl">⏱️</span>
                  <div>
                    <h4 className="font-bold text-gray-800">自动同步防抖频率</h4>
                    <p className="text-[11px] text-gray-400">修改操作后，在后台自动上传至坚果云的防抖延迟时长</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-sm select-none">
                    <span className="text-gray-500 font-medium">自动同步防抖间隔</span>
                    <span className="text-base font-black text-indigo-600">{localInterval} 秒</span>
                  </div>
                  <input
                    type="range" min="5" max="300" step="5"
                    value={localInterval}
                    onChange={(e) => setLocalInterval(parseInt(e.target.value, 10))}
                    className="w-full h-2 bg-gray-100 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                  />
                  <button
                    onClick={handleSaveInterval}
                    className="py-2 px-5 rounded-xl bg-white border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition-colors shadow-sm"
                  >
                    💾 应用同步频率
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Tab 3: 类型与标签 */}
          {activeTab === 'categories' && (
            <div className="space-y-6 animate-fade-in animate-duration-200">
              <div>
                <h3 className="text-2xl font-black text-gray-900">🏷️ 类型与标签</h3>
                <p className="text-xs text-gray-400 mt-1">内容类型用于主列表筛选；地区与主题通过内容标签识别。TMDB 自动填充地区标签，也可在编辑记录时手动补充。</p>
              </div>

              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center gap-2.5 border-b border-gray-50 pb-4">
                  <span className="text-2xl">🎞️</span>
                  <div>
                    <h4 className="font-bold text-gray-800">固定内容类型</h4>
                    <p className="text-[11px] text-gray-400">类型是统一结构，不能自行新增或重命名，避免电影、纪录片与剧集混用。</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {MEDIA_TYPES.map(type => {
                    const count = records.filter(record => mediaTypeOf(record) === type).length;
                    return <div key={type} className="rounded-2xl border border-indigo-100 bg-indigo-50/50 px-4 py-3">
                      <p className="text-sm font-bold text-indigo-700">{type}</p>
                      <p className="mt-1 text-xs text-gray-500">{count} 部记录</p>
                    </div>;
                  })}
                </div>
              </div>

              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center gap-2.5 border-b border-gray-50 pb-4">
                  <span className="text-2xl">🌐</span>
                  <div>
                    <h4 className="font-bold text-gray-800">标准地区标签</h4>
                    <p className="text-[11px] text-gray-400">用于顶部地区筛选。旧“美剧、韩剧”等数据已自动映射为对应地区标签。</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(['美国', '韩国', '日本', '英国', '中国大陆', '中国香港', '中国台湾'] as const).map(tag => {
                    const count = records.filter(record => regionsOf(record).includes(tag)).length;
                    return <span key={tag} className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm font-semibold text-gray-600">{tag} <b className="ml-1 text-indigo-600">{count}</b></span>;
                  })}
                </div>
              </div>

              <div className="rounded-3xl border border-amber-100 bg-amber-50/60 p-5">
                <h4 className="font-bold text-amber-900">如何维护内容标签</h4>
                <p className="mt-1 text-xs leading-6 text-amber-800">“纪录片”现在是独立内容类型，请在编辑页的“内容类型”中选择。内容标签用于地区和其他主题，可用英文逗号分隔，例如“韩国, 律政”；TMDB 自动填充会更新标准地区标签，并保留你手工添加的其他标签。</p>
              </div>
            </div>
          )}
          {/* Tab 4: 系统工具 */}
          {activeTab === 'tools' && (
            <div className="space-y-6 animate-fade-in animate-duration-200">
              <div>
                <h3 className="text-2xl font-black text-gray-900">🛠️ 系统工具</h3>
                <p className="text-xs text-gray-400 mt-1">本地数据维护、高级清理、以及缺失的元数据同步补全</p>
              </div>

              {/* Local File Backup */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center gap-2.5 border-b border-gray-50 pb-4">
                  <span className="text-2xl">📁</span>
                  <div>
                    <h4 className="font-bold text-gray-800">本地文件导入与导出</h4>
                    <p className="text-[11px] text-gray-400">导出或读取本地备份的 watchtracker_backup.json 文件</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={handleImportLocal}
                    className="flex-1 py-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-sm font-semibold text-gray-600 transition-colors shadow-sm"
                  >
                    📤 导入本地 JSON
                  </button>
                  <button
                    onClick={handleExport}
                    className="flex-1 py-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-sm font-semibold text-gray-600 transition-colors shadow-sm"
                  >
                    📥 导出备份 JSON
                  </button>
                </div>
              </div>

              {/* Database Maintenance */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center gap-2.5 border-b border-gray-50 pb-4">
                  <span className="text-2xl">🧹</span>
                  <div>
                    <h4 className="font-bold text-gray-800">数据库维护与体积优化</h4>
                    <p className="text-[11px] text-gray-400">对本地 SQLite 数据库进行整理优化，提高运行速度</p>
                  </div>
                </div>
                <button
                  onClick={handleVacuum}
                  className="w-full py-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-sm font-semibold text-gray-600 transition-colors shadow-sm flex items-center justify-center gap-2"
                >
                  🧹 立即运行 SQLite 数据库压缩 (VACUUM)
                </button>
                {vacuumStatus && <p className="text-xs text-center text-gray-500 font-medium mt-1">{vacuumStatus}</p>}
              </div>

              {/* Batch Metadata Sync */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center gap-2.5 border-b border-gray-50 pb-4">
                  <span className="text-2xl">✨</span>
                  <div>
                    <h4 className="font-bold text-gray-800">一键补全缺失元数据</h4>
                    <p className="text-[11px] text-gray-400">调用 TMDB 自动补全数据库中老数据缺失的流派、国家、集数等信息</p>
                  </div>
                </div>
                <button
                  onClick={handleBatchSync}
                  disabled={batchSyncing || !tmdbSaved}
                  className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:bg-gray-200 text-white text-sm font-bold transition-colors flex items-center justify-center gap-2 shadow-sm"
                  title={!tmdbSaved ? "请先在【基础配置】中设置 TMDB 密钥" : ""}
                >
                  {batchSyncing ? '⏳ 正在同步更新中...' : '✨ 立即一键补全缺失字段'}
                </button>
                {batchSyncing && batchTotal > 0 && (
                  <div className="mt-3 space-y-2">
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div className="bg-amber-500 h-2 rounded-full transition-all duration-300" style={{ width: `${(batchProgress / batchTotal) * 100}%` }}></div>
                    </div>
                    <p className="text-[10px] text-center text-gray-400">进度：{batchProgress} / {batchTotal}</p>
                  </div>
                )}
                {batchStatus && <p className="text-xs text-center text-amber-600 font-bold mt-1">{batchStatus}</p>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
