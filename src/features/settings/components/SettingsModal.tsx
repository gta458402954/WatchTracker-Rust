import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WatchRecord } from '../../../shared/types';
import {
  saveCreds, clearCreds, syncToWebDAV, loadFromWebDAV, hasCreds,
} from '../../../shared/lib/webdav';
import type { CategoryItem } from '../../categories/hooks/useCategories';
import { getSettingAsync, setSettingAsync, safeEncrypt, safeDecrypt, vacuumDbAsync } from '../../../shared/lib/database';

interface SettingsModalProps {
  onClose: () => void;
  records: WatchRecord[];
  categories: CategoryItem[];
  onAddCategory: (name: string, emoji: string) => boolean;
  onUpdateCategory: (oldName: string, newName: string, newEmoji: string) => boolean | Promise<boolean>;
  onDeleteCategory: (name: string) => void;
  onImport: (records: WatchRecord[]) => void;
  onRefresh?: () => any;
  syncInterval: number;
  onSyncIntervalChange: (val: number) => void;
}

export default function SettingsModal({ 
  onClose, records, categories, onAddCategory, onUpdateCategory, onDeleteCategory, onImport, onRefresh,
  syncInterval, onSyncIntervalChange
}: SettingsModalProps) {
  // WebDAV 状态
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [importStatus, setImportStatus] = useState<string>('');

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

  async function handleClearTmdbKey() {
    await setSettingAsync('tmdb_api_key', '');
    setTmdbKey('');
    setTmdbSaved(false);
    setCatMsg('TMDB 密钥已清除');
    setTimeout(() => setCatMsg(''), 2000);
  }

  // 保存代理设置
  async function handleSaveProxy() {
    await setSettingAsync('network_proxy', proxy.trim());
    setCatMsg('✅ 代理设置已更新');
    setTimeout(() => setCatMsg(''), 2000);
  }

  // WebDAV 操作
  function handleSave() {
    if (!username.trim() || !password.trim()) return;
    saveCreds({ username: username.trim(), password: password.trim() });
    setSaved(true);
    setSyncStatus('✅ 凭据已保存');
    setTimeout(() => setSyncStatus(''), 3000);
  }

  function handleClear() {
    clearCreds();
    setUsername('');
    setPassword('');
    setSaved(false);
    setSyncStatus('凭据已清除');
    setTimeout(() => setSyncStatus(''), 3000);
  }

  async function handleSync() {
    setSyncStatus('⏳ 同步中...');
    try {
      const result = await syncToWebDAV(records);
      if (result.ok) setSyncStatus('✅ 同步成功');
      else setSyncStatus(`❌ 同步失败: ${result.error}`);
    } catch (e: any) {
      setSyncStatus(`❌ 出错: ${e.message}`);
    }
    setTimeout(() => setSyncStatus(''), 3000);
  }

  // 自动同步频率
  async function handleSaveInterval() {
    await setSettingAsync('sync_interval', localInterval.toString());
    onSyncIntervalChange(localInterval);
    setSyncStatus('✅ 自动同步频率已更新');
    setTimeout(() => setSyncStatus(''), 3000);
  }

  // 数据库压缩
  async function handleVacuum() {
    setVacuumStatus('⏳ 正在压缩数据库...');
    try {
      await vacuumDbAsync();
      setVacuumStatus('✅ 数据库压缩完成');
    } catch (e: any) {
      setVacuumStatus(`❌ 压缩失败: ${e.message || e}`);
    }
    setTimeout(() => setVacuumStatus(''), 3000);
  }

  // 批量同步元数据
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

          // 针对 IMDb ID 的精确查找，如果有返回，且位于 tv_results / movie_results
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
    setBatchStatus(`✅ 同步完成！成功: ${success}, 失败: ${fail}`);
    if (onRefresh) {
      await onRefresh();
    }
    setTimeout(() => setBatchStatus(''), 5000);
  }

  // 分类管理逻辑
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

  function handleStartEdit(cat: CategoryItem) {
    setEditingCat(cat.name);
    setEditCatName(cat.name);
    setEditCatEmoji(cat.emoji);
  }

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

  function handleDeleteCategory(name: string) {
    const usedCount = records.filter(r => r.category === name).length;
    if (usedCount > 0) {
      setCatMsg(`⚠️ 该分类已被 ${usedCount} 条记录使用，无法删除`);
      setTimeout(() => setCatMsg(''), 3000);
      return;
    }
    if (confirm(`确定删除分类「${name}」吗？`)) {
      onDeleteCategory(name);
      setCatMsg('✅ 已删除');
      setTimeout(() => setCatMsg(''), 2000);
    }
  }

  // 导入导出逻辑
  async function handleImport() {
    if (confirm('导入将覆盖当前所有本地数据，确定吗？')) {
      setImportStatus('⏳ 下载并解密中...');
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

  function handleExport() {
    const data = JSON.stringify(records, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `影视追踪_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto font-sans">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">⚙️ 设置</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 flex flex-col gap-5">
          {/* 网络代理 */}
          <div className="bg-gray-50 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">🌐</span>
              <h3 className="font-semibold text-gray-800">网络代理 (可选)</h3>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              如果无法连接 TMDB，请设置本地代理地址（如 http://127.0.0.1:7890）。
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="http://127.0.0.1:7890"
                value={proxy}
                onChange={(e) => setProxy(e.target.value)}
                className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                onClick={handleSaveProxy}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
              >
                保存
              </button>
            </div>
          </div>

          {/* TMDB API Key */}
          <div className="bg-gray-50 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">🔍</span>
              <h3 className="font-semibold text-gray-800">影视元数据配置</h3>
              {tmdbSaved && (
                <span className="ml-auto text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded-full">
                  已配置
                </span>
              )}
            </div>

            {!tmdbSaved ? (
              <>
                <div className="space-y-2 mb-3">
                  <input
                    type="password"
                    placeholder="TMDB API KEY (V3)"
                    value={tmdbKey}
                    onChange={(e) => setTmdbKey(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <p className="text-[10px] text-gray-400">
                    💡 密钥将被安全加密存储在本地
                  </p>
                </div>
                <button
                  onClick={handleSaveTmdbKey}
                  className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors disabled:opacity-50"
                  disabled={!tmdbKey.trim()}
                >
                  保存密钥
                </button>
              </>
            ) : (
              <div className="flex items-center justify-between bg-white rounded-xl p-3">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-sm text-gray-700">已保存 TMDB 密钥</span>
                </div>
                <button
                  onClick={handleClearTmdbKey}
                  className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                >
                  清除
                </button>
              </div>
            )}
          </div>

          {/* 坚果云 WebDAV 同步 */}
          <div className="bg-gray-50 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">☁️</span>
              <h3 className="font-semibold text-gray-800">坚果云 WebDAV</h3>
              {saved && (
                <span className="ml-auto text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded-full">
                  已配置
                </span>
              )}
            </div>

            {!saved ? (
              <>
                <div className="space-y-2 mb-3">
                  <input
                    type="text"
                    placeholder="坚果云用户名（邮箱）"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <input
                    type="password"
                    placeholder="应用密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <button
                  onClick={handleSave}
                  className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors disabled:opacity-50"
                  disabled={!username.trim() || !password.trim()}
                >
                  保存凭据
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between bg-white rounded-xl p-3 mb-3">
                  <span className="text-sm text-gray-700">已保存坚果云账号</span>
                  <button
                    onClick={handleClear}
                    className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                  >
                    清除
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleSync}
                    className="flex-1 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors"
                  >
                    ☁️ 同步到云端
                  </button>
                  <button
                    onClick={handleImport}
                    className="flex-1 py-2 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-medium transition-colors"
                  >
                    📥 从云端导入
                  </button>
                </div>
              </>
            )}
            {syncStatus && <p className="text-sm text-center mt-2 text-gray-600">{syncStatus}</p>}
            {importStatus && <p className="text-sm text-center mt-2 text-gray-600">{importStatus}</p>}
          </div>

          {/* 自动同步设置 */}
          <div className="bg-gray-50 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">⏱️</span>
              <h3 className="font-semibold text-gray-800">自动同步设置</h3>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">同步频率 (防抖时间)</span>
                <span className="text-sm font-bold text-indigo-600">{localInterval} 秒</span>
              </div>
              <input
                type="range" min="5" max="300" step="5"
                value={localInterval}
                onChange={(e) => setLocalInterval(parseInt(e.target.value, 10))}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
              />
              <button
                onClick={handleSaveInterval}
                className="w-full py-2 rounded-xl bg-white border border-gray-200 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                💾 应用同步频率
              </button>
            </div>
          </div>

          {/* 手动导入导出 */}
          <div className="bg-gray-50 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">📁</span>
              <h3 className="font-semibold text-gray-800">本地文件导入导出</h3>
            </div>
            <div className="flex gap-2">
              <button onClick={handleImportLocal} className="flex-1 py-2 rounded-xl border border-gray-300 text-sm text-gray-600 hover:bg-gray-100 transition-colors">📤 导入 JSON</button>
              <button onClick={handleExport} className="flex-1 py-2 rounded-xl border border-gray-300 text-sm text-gray-600 hover:bg-gray-100 transition-colors">📥 导出 JSON</button>
            </div>
          </div>

          {/* 分类管理 */}
          <div className="bg-gray-50 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">📂</span>
              <h3 className="font-semibold text-gray-800">分类管理</h3>
            </div>
            <div className="flex gap-2 mb-3">
              <input type="text" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder="分类名称" className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <input type="text" value={newCatEmoji} onChange={(e) => setNewCatEmoji(e.target.value)} placeholder="图标" className="w-16 px-2 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-center" />
              <button onClick={handleAddCategory} className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors">添加</button>
            </div>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {categories.map(cat => (
                <div key={cat.name} className="flex items-center gap-2 bg-white rounded-xl p-2 shadow-sm">
                  {editingCat === cat.name ? (
                    <>
                      <input type="text" value={editCatName} onChange={(e) => setEditCatName(e.target.value)} className="flex-1 px-2 py-1 text-xs border rounded focus:ring-1 focus:ring-indigo-500" />
                      <input type="text" value={editCatEmoji} onChange={(e) => setEditCatEmoji(e.target.value)} className="w-10 px-1 py-1 text-xs border rounded text-center" />
                      <button onClick={handleSaveEdit} className="px-2 py-1 bg-green-600 text-white text-[10px] rounded">保存</button>
                      <button onClick={() => setEditingCat(null)} className="px-2 py-1 bg-gray-200 text-gray-600 text-[10px] rounded">取消</button>
                    </>
                  ) : (
                    <>
                      <span className="w-6 text-center">{cat.emoji}</span>
                      <span className="flex-1 text-xs text-gray-700">{cat.name}</span>
                      <button onClick={() => handleStartEdit(cat)} className="p-1 text-gray-400 hover:text-indigo-600"><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg></button>
                      <button onClick={() => handleDeleteCategory(cat.name)} className="p-1 text-gray-400 hover:text-red-500"><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button>
                    </>
                  )}
                </div>
              ))}
            </div>
            {catMsg && <p className="text-xs text-center mt-2 text-gray-500">{catMsg}</p>}
          </div>

          {/* 高级维护 */}
          <div className="bg-gray-50 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">🛠️</span>
              <h3 className="font-semibold text-gray-800">高级维护</h3>
            </div>
            <button onClick={handleVacuum} className="w-full py-2 rounded-xl border border-gray-300 text-sm text-gray-600 hover:bg-gray-100 transition-colors flex items-center justify-center gap-2 mb-3">🧹 立即压缩数据库</button>
            {vacuumStatus && <p className="text-xs text-center mb-3 text-gray-500">{vacuumStatus}</p>}

            <button 
              onClick={handleBatchSync} 
              disabled={batchSyncing || !tmdbSaved}
              className="w-full py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              title={!tmdbSaved ? "请先配置 TMDB 密钥" : "自动为老数据补充类型、国家、评分等缺失信息"}
            >
              {batchSyncing ? '⏳ 正在同步...' : '✨ 一键补全缺失元数据'}
            </button>
            {batchSyncing && batchTotal > 0 && (
              <div className="mt-2">
                <div className="w-full bg-gray-200 rounded-full h-1.5 mb-1">
                  <div className="bg-amber-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${(batchProgress / batchTotal) * 100}%` }}></div>
                </div>
                <p className="text-xs text-center text-gray-500">{batchProgress} / {batchTotal}</p>
              </div>
            )}
            {batchStatus && <p className="text-xs text-center mt-2 text-amber-600 font-medium">{batchStatus}</p>}
          </div>
        </div>

        <div className="px-6 pb-6">
          <button onClick={onClose} className="w-full py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">关闭</button>
        </div>
      </div>
    </div>
  );
}
