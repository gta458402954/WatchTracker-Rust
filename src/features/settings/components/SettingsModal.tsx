import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WatchRecord } from '../../../shared/types';
import {
  saveCreds, clearCreds, syncToWebDAV, loadFromWebDAV, hasCreds, clearResolvedSyncConflicts, clearSyncConflicts, type SyncConflict,
} from '../../../shared/lib/webdav';
import type { CategoryItem } from '../../categories/hooks/useCategories';
import { getSettingAsync, setSettingAsync, safeEncrypt, safeDecrypt, vacuumDbAsync } from '../../../shared/lib/database';

const POPULAR_EMOJIS = ['🎬', '📺', '🎭', '🍿', '🌍', '👾', '🦄', '🇺🇸', '🇬🇧', '🇯🇵', '🇰🇷', '🇨🇳', '🇭🇰', '🇹🇼', '🏷️'];

const isEmoji = (str: string) => {
  if (!str) return false;
  const wordRegex = /[\u4e00-\u9fa5a-zA-Z0-9]/;
  return !wordRegex.test(str);
};

const getBgColor = (name: string) => {
  const colors = [
    'bg-red-50 text-red-600 border-red-100',
    'bg-amber-50 text-amber-600 border-amber-100',
    'bg-emerald-50 text-emerald-600 border-emerald-100',
    'bg-blue-50 text-blue-600 border-blue-100',
    'bg-indigo-50 text-indigo-600 border-indigo-100',
    'bg-purple-50 text-purple-600 border-purple-100',
    'bg-rose-50 text-rose-600 border-rose-100',
    'bg-sky-50 text-sky-600 border-sky-100',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  return colors[index];
};

interface SettingsModalProps {
  onClose: () => void;
  records: WatchRecord[];
  categories: CategoryItem[];
  onAddCategory: (name: string, emoji: string) => boolean;
  onUpdateCategory: (oldName: string, newName: string, newEmoji: string) => boolean | Promise<boolean>;
  onDeleteCategory: (name: string) => void;
  onImport: (records: WatchRecord[]) => void;
  onSync?: () => Promise<{ ok: boolean; error?: string; conflictCount?: number }>;
  onRestoreConflict?: (record: WatchRecord) => Promise<void>;
  onRefresh?: () => any;
  syncInterval: number;
  onSyncIntervalChange: (val: number) => void;
}

export default function SettingsModal({ 
  onClose, records, categories, onAddCategory, onUpdateCategory, onDeleteCategory, onImport, onSync, onRestoreConflict, onRefresh,
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

  // 分类管理状态
  const [newCatName, setNewCatName] = useState('');
  const [newCatEmoji, setNewCatEmoji] = useState('');
  const [editingCat, setEditingCat] = useState<string | null>(null);
  const [editCatName, setEditCatName] = useState('');
  const [editCatEmoji, setEditCatEmoji] = useState('');
  const [catMsg, setCatMsg] = useState('');
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

      setSyncConflicts(await clearResolvedSyncConflicts(records));

      // 3. 加载代理设置
      const savedProxy = await getSettingAsync('network_proxy');
      if (savedProxy) setProxy(savedProxy);
    }
    loadInitial();
  }, []);

  // 保存 TMDB 密钥
  async function handleSaveTmdbKey() {
    if (!tmdbKey.trim()) return;
    try {
      // 存储前先清空旧值，确保触发更新
      await setSettingAsync('tmdb_api_key', '');
      const encrypted = await safeEncrypt(tmdbKey.trim(), 'tmdb_api_key');
      await setSettingAsync('tmdb_api_key', encrypted);
      setTmdbSaved(true);
      setCatMsg('✅ TMDB 密钥已保存');
      setTimeout(() => setCatMsg(''), 2000);
    } catch (e) {
      console.error('[Settings] Failed to save TMDB Key:', e);
      setCatMsg('❌ 保存失败');
    }
  }

  // 清除 TMDB 密钥
  async function handleClearTmdbKey() {
    if (!confirm('确定清除已保存的 TMDB 密钥吗？')) return;
    try {
      await setSettingAsync('tmdb_api_key', '');
      setTmdbKey('');
      setTmdbSaved(false);
      setCatMsg('🧹 TMDB 密钥已清除');
      setTimeout(() => setCatMsg(''), 2000);
    } catch (e) {
      alert('清除失败: ' + e);
    }
  }

  // 保存代理设置
  async function handleSaveProxy() {
    await setSettingAsync('network_proxy', proxy.trim());
    setCatMsg('✅ 代理设置已更新');
    setTimeout(() => setCatMsg(''), 2000);
  }

  // 保存 WebDAV 账号密码
  function handleSave() {
    if (!username.trim() || !password.trim()) return;
    saveCreds({ username: username.trim(), password: password.trim() });
    setSaved(true);
    setSyncStatus('✅ 凭据已保存');
    setTimeout(() => setSyncStatus(''), 3000);
  }

  // 清除云端连接
  function handleClear() {
    clearCreds();
    setUsername('');
    setPassword('');
    setSaved(false);
    setSyncStatus('🧹 凭据已清除');
    setTimeout(() => setSyncStatus(''), 3000);
  }

  // 同步到云端
  async function handleSync() {
    setSyncStatus('正在同步...');
    try {
      const result = onSync ? await onSync() : await syncToWebDAV(records);
      if (result.ok) setSyncStatus(result.conflictCount ? `✅ 同步成功，已自动合并  处冲突` : '✅ 同步成功');
      else setSyncStatus(`❌ 同步失败: ${result.error}`);
    } catch (e: any) {
      setSyncStatus(`❌ 出错: ${e.message}`);
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
  }  // 从云端导入
  async function handleImport() {
    if (confirm('导入将覆盖当前所有本地数据，确定吗？')) {
      setImportStatus('下载并解密中...');
      try {
        const response = await loadFromWebDAV();
        if (response.ok && Array.isArray(response.data)) {
          onImport(response.data as WatchRecord[]);
          setImportStatus('✅ 导入成功');
        } else {
          setImportStatus(`❌ 导入失败: ${response.error || '请检查账号密码'}`);
        }
      } catch (e: any) {
        setImportStatus(`❌ 出错: ${e.message}`);
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
  }

  // 本地文件导入
  async function handleImportLocal() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e: any) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (e: any) => {
        try {
          const data = JSON.parse(e.target.result);
          if (!Array.isArray(data)) throw new Error('无效的 JSON 格式');
          
          const completeData: WatchRecord[] = data.map((item: any, index: number) => ({
            id: item.id || `imported-${Date.now()}-${index}`,
            originalName: item.originalName || '',
            chineseName: item.chineseName || '',
            progress: item.progress || '',
            totalEpisodes: typeof item.totalEpisodes === 'number' ? item.totalEpisodes : null,
            movieProgress: typeof item.movieProgress === 'number' ? item.movieProgress : null,
            movieDuration: typeof item.movieDuration === 'number' ? item.movieDuration : null,
            releaseYear: item.releaseYear ? String(item.releaseYear) : null,
            posterPath: item.posterPath ? String(item.posterPath) : null,
            status: (item.status === '在看' || item.status === '未看' || item.status === '已看') ? item.status : '已看',
            platform: item.platform || '',
            rating: typeof item.rating === 'number' ? item.rating : null,
            startDate: item.startDate || '',
            endDate: item.endDate || '',
            category: item.category || '电影',
            notes: item.notes || '',
            createdAt: item.createdAt || new Date().toISOString(),
            imdbId: item.imdbId || null,
          }));

          onImport(completeData);
          alert(`成功导入 ${completeData.length} 条记录`);
        } catch (err: any) {
          alert('导入失败: ' + err.message);
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

  // 分类管理操作
  function handleAddCategory() {
    if (!newCatName.trim()) {
      setCatMsg('请输入分类名称');
      return;
    }
    if (onAddCategory(newCatName, newCatEmoji)) {
      setNewCatName('');
      setNewCatEmoji('');
      setCatMsg('✅ 添加成功');
    } else {
      setCatMsg('❌ 分类已存在');
    }
    setTimeout(() => setCatMsg(''), 2000);
  }

  // 开始编辑分类
  function handleStartEdit(cat: CategoryItem) {
    setEditingCat(cat.name);
    setEditCatName(cat.name);
    setEditCatEmoji(cat.emoji);
  }

  // 保存编辑
  function handleSaveEdit() {
    if (!editCatName.trim()) {
      setCatMsg('请输入分类名称');
      return;
    }
    if (onUpdateCategory(editingCat!, editCatName, editCatEmoji)) {
      setEditingCat(null);
      setCatMsg('✅ 保存成功');
    } else {
      setCatMsg('❌ 分类名称已存在');
    }
    setTimeout(() => setCatMsg(''), 2000);
  }

  // 删除分类
  function handleDeleteCategory(name: string) {
    const usedCount = records.filter(r => r.category === name).length;
    if (usedCount > 0) {
      setCatMsg(`⚠️ 该分类已有 ${usedCount} 条记录使用，无法删除`);
      setTimeout(() => setCatMsg(''), 3000);
      return;
    }
    if (confirm(`确定删除分类「${name}」吗？`)) {
      onDeleteCategory(name);
      setCatMsg('✅ 已删除');
      setTimeout(() => setCatMsg(''), 2000);
    }
  }

  // 数据库整理优化
  async function handleVacuum() {
    setVacuumStatus('正在压缩数据库...');
    try {
      await vacuumDbAsync();
      setVacuumStatus('✅ 数据库压缩完成');
    } catch (e: any) {
      setVacuumStatus(`❌ 压缩失败: ${e.message || e}`);
    }
    setTimeout(() => setVacuumStatus(''), 3000);
  }

  // 自动补全缺失字段
  async function handleBatchSync() {
    const targets = records.filter(r => r.imdbId && !r.isLocked && (!r.genres || r.episodeRuntime === null));
    if (targets.length === 0) {
      setBatchStatus('🎉 所有带 IMDb 编号的记录均已包含完整元数据！');
      setTimeout(() => setBatchStatus(''), 3000);
      return;
    }
    
    if (!confirm(`发现 ${targets.length} 条缺失部分元数据的老记录。是否开始批量同步？\n\n注意：期间请保持网络畅通。`)) return;

    setBatchSyncing(true);
    setBatchTotal(targets.length);
    setBatchProgress(0);
    setBatchStatus('正在连接 TMDB...');

    let success = 0;
    let fail = 0;
    const tmdbCache = new Map<string, any>();

    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      setBatchProgress(i + 1);
      setBatchStatus(`正在同步: ${r.chineseName}`);
      
      try {
        const searchMediaType = (r.category === '电影' || r.category === '纪录片' || r.category === '动画') ? 'movie' : 'tv';
        
        let updates: any = null;
        if (r.imdbId && tmdbCache.has(r.imdbId)) {
          updates = tmdbCache.get(r.imdbId);
        } else {
          const result = await invoke<any>('search_tmdb', {
            apiKey: tmdbKey,
            query: r.imdbId,
            mediaType: searchMediaType,
            proxy,
            language: 'zh-CN'
          });

          const resultsArray = result.tv_results || result.movie_results || result.results || [];
          const item = resultsArray[0];

          if (item) {
            const detail = await invoke<any>('get_tmdb_detail', {
              apiKey: tmdbKey,
              id: item.id,
              mediaType: searchMediaType,
              proxy,
              language: 'zh-CN'
            });

            const genresStr = detail.genres?.map((g: any) => g.name).join(', ');
            const genres = genresStr ? genresStr : '未知';
            const originCountry = detail.origin_country?.join(', ') || null;
            updates = {
              genres,
              originCountry,
              imdbRating: detail.vote_average || null,
              tmdbStatus: detail.status || null,
              episodeRuntime: detail.episode_run_time?.[0] || detail.runtime || 0,
            };
            
            if (r.imdbId) {
              tmdbCache.set(r.imdbId, updates);
            }
          }
        }

        if (updates) {
          await invoke('update_record', { id: r.id, updates });
          success++;
        } else {
          fail++;
        }
      } catch (e) {
        console.error('Failed to sync record', r.chineseName, e);
        fail++;
      }
      
      // 适度延时避免请求过频
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    setBatchSyncing(false);
    setBatchStatus(`🎉 同步完成！成功: ${success}, 失败: ${fail}`);
    if (onRefresh) {
      await onRefresh();
    }
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
              <span className="text-lg">🏷️</span> 分类维护
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
                      💡 密钥将被安全加密存储在本地。可以在 TMDB 官网的个人设置中申请获取该 API 密钥。
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
                      <span className="text-sm text-gray-700 font-medium">已成功挂载加密的 TMDB API 密钥</span>
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
                <p className="text-xs text-gray-400 mt-1">支持与坚果云等 WebDAV 服务端进行加密数据同步</p>
              </div>

              {/* WebDAV Settings */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center justify-between border-b border-gray-50 pb-4">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl">☁️</span>
                    <div>
                      <h4 className="font-bold text-gray-800">坚果云 WebDAV 同步</h4>
                      <p className="text-[11px] text-gray-400">用于备份或多端同步 watchtracker.db 数据</p>
                    </div>
                  </div>
                  {saved && (
                    <span className="text-xs px-2.5 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded-full font-semibold">
                      已连接
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
                      验证并保存凭据
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between bg-gray-50 rounded-2xl p-4">
                      <div className="flex items-center gap-2">
                        <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="text-sm text-gray-700 font-medium">已绑定坚果云 WebDAV 服务，数据在变动时会自动同步</span>
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

          {/* Tab 3: 分类维护 */}
          {activeTab === 'categories' && (
            <div className="space-y-6 animate-fade-in animate-duration-200">
              <div>
                <h3 className="text-2xl font-black text-gray-900">🏷️ 分类维护</h3>
                <p className="text-xs text-gray-400 mt-1">管理你的影视类型维度标签以及关联的 Emoji 图标</p>
              </div>

              {/* Add Category */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center gap-2.5 border-b border-gray-50 pb-4">
                  <span className="text-2xl">➕</span>
                  <div>
                    <h4 className="font-bold text-gray-800">添加新分类</h4>
                    <p className="text-[11px] text-gray-400">输入自定义的影视类别，可选配一个专属表情图标</p>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <input
                      type="text"
                      value={newCatName}
                      onChange={(e) => setNewCatName(e.target.value)}
                      placeholder="分类名称 (如：科幻剧)"
                      className="flex-1 px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    />
                    <input
                      type="text"
                      value={newCatEmoji}
                      onChange={(e) => setNewCatEmoji(e.target.value)}
                      placeholder="图标 (如 🎬)"
                      className="w-24 px-2 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-center transition-all"
                    />
                    <button
                      onClick={handleAddCategory}
                      className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
                    >
                      添加分类
                    </button>
                  </div>

                  {/* Preset Emojis Selector */}
                  <div className="flex flex-wrap gap-1.5 pt-1.5 items-center">
                    <span className="text-[11px] font-bold text-gray-400 mr-1 select-none">快捷图标:</span>
                    {POPULAR_EMOJIS.map(em => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => setNewCatEmoji(em)}
                        className={`w-7 h-7 flex items-center justify-center rounded-lg border text-sm hover:bg-indigo-50 hover:border-indigo-200 transition-all select-none ${
                          newCatEmoji === em ? 'bg-indigo-50 border-indigo-300 scale-105 shadow-sm' : 'bg-gray-50 border-gray-150'
                        }`}
                      >
                        {em}
                      </button>
                    ))}
                    {newCatEmoji && (
                      <button
                        type="button"
                        onClick={() => setNewCatEmoji('')}
                        className="text-[10px] text-gray-400 hover:text-red-500 font-bold ml-1 transition-colors"
                      >
                        清除选择
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Categories list */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <h4 className="font-bold text-gray-800 border-b border-gray-50 pb-3">已有分类列表</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-h-[420px] overflow-y-auto pr-1 custom-scrollbar">
                  {categories.map(cat => (
                    <div key={cat.name} className="flex items-center gap-3.5 bg-gray-50 border border-gray-100 rounded-2xl p-4 hover:border-indigo-100 hover:bg-white hover:shadow-sm transition-all duration-200">
                      {editingCat === cat.name ? (
                        <div className="flex flex-col gap-2.5 w-full">
                          <div className="flex gap-2 items-center">
                            <input
                              type="text"
                              value={editCatName}
                              onChange={(e) => setEditCatName(e.target.value)}
                              className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all outline-none"
                            />
                            <input
                              type="text"
                              value={editCatEmoji}
                              onChange={(e) => setEditCatEmoji(e.target.value)}
                              placeholder="Emoji"
                              className="w-16 px-2 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-center transition-all outline-none"
                            />
                            <button onClick={handleSaveEdit} className="px-3.5 py-2 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-xl shadow-sm transition-colors">保存</button>
                            <button onClick={() => setEditingCat(null)} className="px-3.5 py-2 bg-gray-250 hover:bg-gray-300 text-gray-700 text-xs font-bold rounded-xl transition-colors">取消</button>
                          </div>
                          
                          {/* Edit Preset Emojis Selector */}
                          <div className="flex flex-wrap gap-1 items-center">
                            {POPULAR_EMOJIS.map(em => (
                              <button
                                key={em}
                                type="button"
                                onClick={() => setEditCatEmoji(em)}
                                className={`w-6 h-6 flex items-center justify-center rounded border text-xs hover:bg-indigo-50 hover:border-indigo-200 transition-all select-none ${
                                  editCatEmoji === em ? 'bg-indigo-50 border-indigo-300 scale-105' : 'bg-white border-gray-150'
                                }`}
                              >
                                {em}
                              </button>
                            ))}
                            {editCatEmoji && (
                              <button
                                type="button"
                                onClick={() => setEditCatEmoji('')}
                                className="text-[10px] text-gray-400 hover:text-red-500 font-bold ml-1 transition-colors"
                              >
                                清除
                              </button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <>
                          {isEmoji(cat.emoji) ? (
                            <span className="w-10 h-10 flex items-center justify-center rounded-2xl bg-white shadow-sm border border-gray-100 text-xl select-none shrink-0 transition-transform hover:scale-105">
                              {cat.emoji}
                            </span>
                          ) : (
                            <span className={`w-10 h-10 flex items-center justify-center rounded-2xl border text-sm font-bold select-none shrink-0 transition-transform hover:scale-105 ${getBgColor(cat.name)}`}>
                              {cat.name.charAt(0)}
                            </span>
                          )}
                          <span className="flex-1 text-sm font-semibold text-gray-700 select-none">{cat.name}</span>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => handleStartEdit(cat)}
                              className="p-1.5 rounded-lg hover:bg-white text-gray-400 hover:text-indigo-600 border border-transparent hover:border-gray-100 transition-all shadow-none hover:shadow-sm"
                              title="编辑"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => handleDeleteCategory(cat.name)}
                              className="p-1.5 rounded-lg hover:bg-white text-gray-400 hover:text-red-500 border border-transparent hover:border-gray-100 transition-all shadow-none hover:shadow-sm"
                              title="删除"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {catMsg && <p className="text-xs text-center text-gray-500 font-medium mt-1">{catMsg}</p>}
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
