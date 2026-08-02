import { useCallback, useState, useEffect, useRef } from 'react';
import { UpdateWatchRecord, WatchRecord } from '../../../shared/types';
import {
  saveCreds, clearCreds, syncToWebDAV, loadFromWebDAV, getCreds, clearResolvedSyncConflicts, clearSyncConflicts, type SyncConflict,
} from '../../../shared/lib/webdav';
import { getSettingAsync, setSettingAsync, safeEncrypt, safeDecrypt, vacuumDbAsync, searchTmdbAsync, getTmdbDetailAsync } from '../../../shared/lib/database';
import { MEDIA_TYPES, mediaTypeOf, regionsOf, type TmdbMedia } from '../../../shared/lib/classification';
import {
  BATCH_METADATA_FIELD_LABELS,
  buildBatchMetadataPatch,
  isBatchMetadataCandidate,
  remoteIdentityKey,
  retainMissingMetadataPatch,
  selectTmdbMatch,
  type BatchMetadataField,
} from '../../../shared/lib/batchMetadata';
import { notifyOperationFailure, reportOperationFailure, type NoticeTone } from '../../../shared/lib/feedback';
import { normalizeImportedRecords } from '../../../shared/lib/importValidation';

interface SettingsModalProps {
  onClose: () => void;
  records: WatchRecord[];
  onImport: (records: WatchRecord[]) => void | Promise<void>;
  onSync?: () => Promise<{ ok: boolean; error?: string; conflictCount?: number }>;
  onRestoreConflict?: (record: WatchRecord) => Promise<void>;
  onUpdateRecord: (id: string, updates: UpdateWatchRecord) => Promise<void>;
  syncInterval: number;
  onSyncIntervalChange: (val: number) => void;
  onNotify?: (tone: NoticeTone, message: string) => void;
}

type BatchPhase = 'idle' | 'planning' | 'preview' | 'applying' | 'done';
type BatchPlanStatus = 'ready' | 'skipped' | 'failed';

interface BatchPlanRow {
  recordId: string;
  recordName: string;
  status: BatchPlanStatus;
  updates: UpdateWatchRecord;
  fields: BatchMetadataField[];
  remoteIdentity?: string;
  reason?: string;
}

interface BatchApplyResult {
  plan: BatchPlanRow;
  status: 'updated' | 'skipped' | 'failed';
  reason?: string;
}

export default function SettingsModal({
  onClose, records, onImport, onSync, onRestoreConflict, onUpdateRecord,
  syncInterval, onSyncIntervalChange, onNotify
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'basic' | 'sync' | 'categories' | 'tools'>('basic');

  // WebDAV 状态
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [webdavUrl, setWebdavUrl] = useState('https://dav.jianguoyun.com/dav/影视追踪/');
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
  const [batchPhase, setBatchPhase] = useState<BatchPhase>('idle');
  const [batchStatus, setBatchStatus] = useState('');
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchPlan, setBatchPlan] = useState<BatchPlanRow[]>([]);
  const [batchResults, setBatchResults] = useState<BatchApplyResult[]>([]);
  const batchCancelRef = useRef(false);
  const recordsRef = useRef(records);
  const batchSyncing = batchPhase === 'planning' || batchPhase === 'applying';

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  const showFailure = useCallback((
    scope: string,
    action: string,
    error: unknown,
    setStatus?: (message: string) => void,
  ) => {
    const message = notifyOperationFailure(scope, action, error, onNotify ?? (() => undefined));
    setStatus?.(`❌ ${message}`);
  }, [onNotify]);

  const showSuccess = useCallback((message: string) => {
    onNotify?.('success', message);
  }, [onNotify]);

  // 初始化加载设置
  useEffect(() => {
    async function loadInitial() {
      try {
        const creds = await getCreds();
        setSaved(!!creds);
        if (creds?.url) setWebdavUrl(creds.url);

        const encryptedTmdb = await getSettingAsync('tmdb_api_key');
        if (encryptedTmdb) {
          const decrypted = await safeDecrypt(encryptedTmdb);
          if (decrypted === '__ERR_DECRYPT_VERSION_MISMATCH__' || decrypted === '__ERR_DECRYPT_FAILED__') {
            setTmdbSaved(false);
            onNotify?.('warning', 'TMDB 密钥格式已过期，请重新保存。');
          } else if (decrypted) {
            setTmdbKey(decrypted);
            setTmdbSaved(true);
          }
        }

        const savedProxy = await getSettingAsync('network_proxy');
        if (savedProxy) setProxy(savedProxy);
      } catch (error) {
        showFailure('Settings.Initialize', '读取设置', error, setSyncStatus);
      }
    }
    void loadInitial();
  }, [onNotify, showFailure]);

  useEffect(() => {
    let cancelled = false;
    clearResolvedSyncConflicts(records)
      .then(conflicts => { if (!cancelled) setSyncConflicts(conflicts); })
      .catch(error => showFailure('Settings.LoadConflicts', '读取同步冲突', error));
    return () => { cancelled = true; };
  }, [records, showFailure]);

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
      showSuccess('TMDB 密钥已保存。');
      setTimeout(() => setSyncStatus(''), 2000);
    } catch (error) {
      showFailure('Settings.SaveTmdbKey', '保存 TMDB 密钥', error, setSyncStatus);
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
      showSuccess('TMDB 密钥已清除。');
      setTimeout(() => setSyncStatus(''), 2000);
    } catch (error) {
      showFailure('Settings.ClearTmdbKey', '清除 TMDB 密钥', error, setSyncStatus);
    }
  }

  // 保存代理设置
  async function handleSaveProxy() {
    try {
      await setSettingAsync('network_proxy', proxy.trim());
      setSyncStatus('✅ 代理设置已更新');
      showSuccess('代理设置已更新。');
    } catch (error) {
      showFailure('Settings.SaveProxy', '保存代理设置', error, setSyncStatus);
    }
    setTimeout(() => setSyncStatus(''), 2000);
  }

  // 保存 WebDAV 账号密码
  async function handleSave() {
    if (!username.trim() || !password.trim() || !webdavUrl.trim()) return;
    try {
      await saveCreds({ username: username.trim(), password: password.trim(), url: webdavUrl.trim() });
      setSaved(true);
      setSyncStatus('✅ 凭据已保存');
      showSuccess('WebDAV 凭据已保存。');
    } catch (error) {
      showFailure('Settings.SaveWebDav', '保存 WebDAV 凭据', error, setSyncStatus);
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
      showSuccess('WebDAV 凭据已清除。');
    } catch (error) {
      showFailure('Settings.ClearWebDav', '清除 WebDAV 凭据', error, setSyncStatus);
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
        showSuccess('WebDAV 同步完成。');
      } else {
        showFailure('Settings.SyncWebDav', 'WebDAV 同步', result.error, setSyncStatus);
      }
    } catch (error) {
      showFailure('Settings.SyncWebDav', 'WebDAV 同步', error, setSyncStatus);
    }
    setTimeout(() => setSyncStatus(''), 3000);
  }

  async function handleRestoreConflict(conflict: SyncConflict) {
    if (!onRestoreConflict) return;
    if (!confirm(`确定恢复「${conflict.discarded.chineseName}」的被覆盖版本吗？恢复后会在下次同步时上传。`)) return;
    try {
      await onRestoreConflict(conflict.discarded);
      const remaining = syncConflicts.filter(item => item !== conflict);
      await clearSyncConflicts();
      if (remaining.length) {
        await setSettingAsync('sync_conflicts', JSON.stringify(remaining));
      }
      setSyncConflicts(remaining);
      showSuccess('冲突记录已恢复。');
    } catch (error) {
      showFailure('Settings.RestoreConflict', '恢复冲突记录', error);
    }
  }

  async function handleClearConflicts() {
    if (!confirm('确定清空全部冲突记录吗？此操作不会删除任何影视条目。')) return;
    try {
      await clearSyncConflicts();
      setSyncConflicts([]);
      showSuccess('同步冲突记录已清空。');
    } catch (error) {
      showFailure('Settings.ClearConflicts', '清空同步冲突', error);
    }
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
          showSuccess('云端记录已导入。');
        } else {
          showFailure('Settings.ImportWebDav', '从云端导入', response.error, setImportStatus);
        }
      } catch (error) {
        showFailure('Settings.ImportWebDav', '从云端导入', error, setImportStatus);
      }
      setTimeout(() => setImportStatus(''), 3000);
    }
  }

  // 保存同步频率
  async function handleSaveInterval() {
    try {
      await setSettingAsync('sync_interval', localInterval.toString());
      onSyncIntervalChange(localInterval);
      setSyncStatus('✅ 自动同步频率已更新');
      showSuccess('自动同步频率已更新。');
    } catch (error) {
      showFailure('Settings.SaveSyncInterval', '保存同步频率', error, setSyncStatus);
    }
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
          const completeData = normalizeImportedRecords(parsed);
          await onImport(completeData);
          showSuccess(`已导入 ${completeData.length} 条本地记录。`);
        } catch (error) {
          showFailure('Settings.ImportLocal', '导入本地文件', error, setImportStatus);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  // 快捷键退出
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (batchSyncing) {
        batchCancelRef.current = true;
        setBatchStatus('正在安全停止批量任务...');
      } else {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [batchSyncing, onClose]);

  // 数据库整理优化
  async function handleVacuum() {
    setVacuumStatus('正在压缩数据库...');
    try {
      await vacuumDbAsync();
      setVacuumStatus('✅ 数据库压缩完成');
      showSuccess('数据库压缩完成。');
    } catch (error) {
      showFailure('Settings.Vacuum', '压缩数据库', error, setVacuumStatus);
    }
    setTimeout(() => setVacuumStatus(''), 3000);
  }

  async function searchTmdbWithRetry(imdbId: string): Promise<TmdbMedia[]> {
    let lastError: unknown = new Error('TMDB search failed');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (batchCancelRef.current) throw new Error('Batch cancelled');
      const response = await searchTmdbAsync({ apiKey: tmdbKey.trim(), query: imdbId, language: 'zh-CN' });
      if (response.success) return response.results ?? [];
      lastError = new Error(response.error || 'TMDB search failed');
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
    throw lastError;
  }

  async function getTmdbDetailWithRetry(id: number, mediaType: 'movie' | 'tv'): Promise<TmdbMedia> {
    let lastError: unknown = new Error('TMDB detail failed');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (batchCancelRef.current) throw new Error('Batch cancelled');
      const response = await getTmdbDetailAsync({ apiKey: tmdbKey.trim(), id, mediaType, language: 'zh-CN' });
      if (response.success && response.data) return response.data;
      lastError = new Error(response.error || 'TMDB detail failed');
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
    throw lastError;
  }

  // 第一步只读取远端并生成预览，不写数据库。
  async function handlePrepareBatch() {
    const targets = records.filter(isBatchMetadataCandidate);
    if (!tmdbKey.trim()) {
      setBatchStatus('❌ 请先配置 TMDB API Key');
      onNotify?.('warning', '请先配置 TMDB API Key。');
      return;
    }
    if (targets.length === 0) {
      setBatchStatus('🎉 所有未锁定且带 IMDb 编号的记录均无可补字段。');
      setTimeout(() => setBatchStatus(''), 3000);
      return;
    }

    batchCancelRef.current = false;
    setBatchPhase('planning');
    setBatchPlan([]);
    setBatchResults([]);
    setBatchTotal(targets.length);
    setBatchProgress(0);
    setBatchStatus('正在分析缺失字段，不会写入数据库...');
    const rows: BatchPlanRow[] = [];
    const searchCache = new Map<string, TmdbMedia[]>();
    const detailCache = new Map<string, TmdbMedia>();

    for (let index = 0; index < targets.length; index++) {
      if (batchCancelRef.current) break;
      const record = targets[index];
      setBatchProgress(index + 1);
      setBatchStatus('正在分析: ' + record.chineseName);
      try {
        const imdbId = record.imdbId!.trim();
        let searchResults = searchCache.get(imdbId);
        if (!searchResults) {
          searchResults = await searchTmdbWithRetry(imdbId);
          searchCache.set(imdbId, searchResults);
        }

        const matchResult = selectTmdbMatch(record, searchResults);
        if (!matchResult.ok) {
          rows.push({
            recordId: record.id, recordName: record.chineseName, status: 'skipped',
            updates: {}, fields: [], reason: matchResult.reason,
          });
          setBatchPlan([...rows]);
          continue;
        }

        const detailKey = `${matchResult.match.type}:${matchResult.match.id}`;
        let detail = detailCache.get(detailKey);
        if (!detail) {
          detail = await getTmdbDetailWithRetry(matchResult.match.id, matchResult.match.type);
          detailCache.set(detailKey, detail);
        }
        const patch = buildBatchMetadataPatch(record, detail, matchResult.match.type);
        rows.push({
          recordId: record.id,
          recordName: record.chineseName,
          status: patch.fields.length ? 'ready' : 'skipped',
          updates: patch.updates,
          fields: patch.fields,
          remoteIdentity: remoteIdentityKey(matchResult.match, patch.seasonNumber),
          reason: patch.fields.length ? undefined : 'TMDB 没有返回可用于缺失字段的有效值',
        });
      } catch (error) {
        if (batchCancelRef.current) break;
        reportOperationFailure('Settings.BatchMetadataRecord', error);
        rows.push({
          recordId: record.id, recordName: record.chineseName, status: 'failed',
          updates: {}, fields: [], reason: 'TMDB 查询失败，可重新分析',
        });
      }
      setBatchPlan([...rows]);
      if (index + 1 < targets.length) await new Promise(resolve => setTimeout(resolve, 200));
    }

    setBatchPlan(rows);
    setBatchPhase('preview');
    const ready = rows.filter(row => row.status === 'ready').length;
    const failed = rows.filter(row => row.status === 'failed').length;
    setBatchStatus(batchCancelRef.current
      ? `分析已取消；已完成 ${rows.length} / ${targets.length} 条，可检查已生成的预览。`
      : `分析完成：可更新 ${ready} 条，跳过/失败 ${rows.length - ready} 条${failed ? `（失败 ${failed} 条）` : ''}。`);
  }

  async function handleApplyBatch(plans?: BatchPlanRow[]) {
    const selected = plans ?? batchPlan.filter(row => row.status === 'ready');
    if (!selected.length) {
      setBatchStatus('没有可写入的字段。');
      return;
    }

    batchCancelRef.current = false;
    setBatchPhase('applying');
    setBatchProgress(0);
    setBatchTotal(selected.length);
    setBatchStatus('正在安全写入已确认的字段...');
    const retriedIds = new Set(selected.map(plan => plan.recordId));
    const results: BatchApplyResult[] = plans
      ? batchResults.filter(result => !retriedIds.has(result.plan.recordId))
      : [];

    for (let index = 0; index < selected.length; index++) {
      if (batchCancelRef.current) break;
      const plan = selected[index];
      setBatchProgress(index + 1);
      setBatchStatus('正在写入: ' + plan.recordName);
      const current = recordsRef.current.find(record => record.id === plan.recordId);
      if (!current || current.isLocked) {
        results.push({ plan, status: 'skipped', reason: current ? '记录已锁定' : '记录已不存在' });
        setBatchResults([...results]);
        continue;
      }

      const safePatch = retainMissingMetadataPatch(current, plan.updates);
      if (!safePatch.fields.length) {
        results.push({ plan, status: 'skipped', reason: '预览后字段已被其他操作补全' });
        setBatchResults([...results]);
        continue;
      }

      try {
        await onUpdateRecord(plan.recordId, safePatch.updates);
        results.push({ plan: { ...plan, fields: safePatch.fields, updates: safePatch.updates }, status: 'updated' });
      } catch (error) {
        reportOperationFailure('Settings.BatchMetadataWrite', error);
        results.push({ plan, status: 'failed', reason: '数据库写入失败，可重试此条' });
      }
      setBatchResults([...results]);
    }

    if (batchCancelRef.current) {
      const completedIds = new Set(results.map(result => result.plan.recordId));
      for (const plan of selected) {
        if (!completedIds.has(plan.recordId)) {
          results.push({ plan, status: 'skipped', reason: '用户取消，未写入' });
        }
      }
    }
    setBatchResults(results);
    setBatchPhase('done');
    const updated = results.filter(result => result.status === 'updated').length;
    const failed = results.filter(result => result.status === 'failed').length;
    const skipped = results.filter(result => result.status === 'skipped').length;
    setBatchStatus(`${batchCancelRef.current ? '补全已停止' : '补全结束'}：已更新 ${updated} 条，跳过 ${skipped} 条，失败 ${failed} 条。`);
    if (failed) onNotify?.('warning', `批量补全有 ${failed} 条写入失败，可单独重试。`);
    else if (updated) showSuccess(`已安全补全 ${updated} 条记录。`);
  }

  function handleCancelBatch() {
    batchCancelRef.current = true;
    setBatchStatus(batchPhase === 'planning' ? '正在停止分析...' : '将在当前记录写入完成后停止...');
  }

  function resetBatch() {
    batchCancelRef.current = false;
    setBatchPhase('idle');
    setBatchPlan([]);
    setBatchResults([]);
    setBatchProgress(0);
    setBatchTotal(0);
    setBatchStatus('');
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
            onClick={batchSyncing ? handleCancelBatch : onClose}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-gray-200 hover:bg-gray-50 text-sm font-bold text-gray-700 transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            {batchSyncing ? '安全停止任务' : '返回主页'}
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
                      <h4 className="font-bold text-gray-800">WebDAV 同步</h4>
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
                    <input
                      type="text"
                      placeholder="WebDAV 服务器地址"
                      value={webdavUrl}
                      onChange={(e) => setWebdavUrl(e.target.value)}
                      className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <input
                        type="text"
                        placeholder="用户名"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                      />
                      <input
                        type="password"
                        placeholder="WebDAV 密码 / 应用密码"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                      />
                    </div>
                    <p className="text-[10px] text-gray-400">
                      💡 默认使用坚果云。若使用自定义 WebDAV 服务，请确保填入完整的文件夹 URL（例如：https://dav.example.com/dav/影视追踪/）。
                    </p>
                    <button
                      onClick={handleSave}
                      className="py-2.5 px-6 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors disabled:opacity-50"
                      disabled={!username.trim() || !password.trim() || !webdavUrl.trim()}
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
                        <span className="text-sm text-gray-700 font-medium">已配置 WebDAV ({webdavUrl})，数据变动后会自动同步</span>
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
                <p className="text-xs text-gray-400 mt-1">内容类型用于主列表筛选；地区以 originCountry 国家代码为主，内容标签仅为旧数据回退和自定义主题。</p>
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
                    <p className="text-[11px] text-gray-400">顶部地区筛选只读取每条记录的第一个国家代码；旧中文地区标签仅在国家代码缺失时回退使用。</p>
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
                <p className="mt-1 text-xs leading-6 text-amber-800">“纪录片”现在是独立内容类型，请在编辑页的“内容类型”中选择。TMDB 自动填充会更新 originCountry 和可识别的标准地区标签，同时保留你手工添加的其他主题标签。</p>
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
                    <p className="text-[11px] text-gray-400">先分析并预览；确认后只写仍然缺失的字段，不覆盖已有数据</p>
                  </div>
                </div>
                <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4 text-xs leading-5 text-emerald-800">
                  电影只补电影时长；剧集和具体季只补单集时长与总集数。媒体类型、已有题材、国家、评分、状态和自定义标签不会被静默修改。
                </div>
                {(batchPhase === 'idle' || batchPhase === 'done') && (
                  <button
                    onClick={handlePrepareBatch}
                    disabled={!tmdbSaved}
                    className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:bg-gray-200 text-white text-sm font-bold transition-colors flex items-center justify-center gap-2 shadow-sm"
                    title={!tmdbSaved ? "请先在【基础配置】中设置 TMDB 密钥" : ""}
                  >
                    🔎 分析并预览缺失字段
                  </button>
                )}
                {batchSyncing && batchTotal > 0 && (
                  <div className="mt-3 space-y-2">
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div className="bg-amber-500 h-2 rounded-full transition-all duration-300" style={{ width: `${(batchProgress / batchTotal) * 100}%` }}></div>
                    </div>
                    <p className="text-[10px] text-center text-gray-400">进度：{batchProgress} / {batchTotal}</p>
                    <button
                      onClick={handleCancelBatch}
                      className="w-full rounded-xl border border-gray-200 py-2 text-xs font-bold text-gray-600 hover:bg-gray-50"
                    >
                      安全停止
                    </button>
                  </div>
                )}
                {batchStatus && <p className="text-xs text-center text-amber-600 font-bold mt-1">{batchStatus}</p>}

                {batchPhase === 'preview' && (
                  <div aria-label="元数据补全预览" className="space-y-3 rounded-2xl border border-gray-200 bg-gray-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <h5 className="text-sm font-black text-gray-800">写入预览</h5>
                      <span className="text-[10px] text-gray-500">确认时会再次检查字段是否仍缺失</span>
                    </div>
                    <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                      {batchPlan.map(row => (
                        <div key={row.recordId} className="rounded-xl border border-gray-100 bg-white px-3 py-2">
                          <div className="flex items-start justify-between gap-3">
                            <p className="min-w-0 truncate text-xs font-bold text-gray-800">{row.recordName}</p>
                            <span className={`shrink-0 text-[10px] font-bold ${row.status === 'ready' ? 'text-emerald-600' : row.status === 'failed' ? 'text-red-500' : 'text-gray-400'}`}>
                              {row.status === 'ready' ? '可更新' : row.status === 'failed' ? '失败' : '跳过'}
                            </span>
                          </div>
                          <p className="mt-1 text-[10px] text-gray-500">
                            {row.fields.length
                              ? row.fields.map(field => BATCH_METADATA_FIELD_LABELS[field]).join('、')
                              : row.reason}
                          </p>
                          {row.remoteIdentity && <p className="mt-1 font-mono text-[9px] text-gray-300">{row.remoteIdentity}</p>}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => void handleApplyBatch()}
                        disabled={!batchPlan.some(row => row.status === 'ready')}
                        className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:bg-gray-300"
                      >
                        确认写入 {batchPlan.filter(row => row.status === 'ready').length} 条
                      </button>
                      <button onClick={resetBatch} className="rounded-xl border border-gray-200 px-4 py-2.5 text-xs font-bold text-gray-600 hover:bg-white">
                        取消
                      </button>
                    </div>
                    {batchPlan.some(row => row.status === 'failed') && (
                      <button
                        onClick={() => void handlePrepareBatch()}
                        className="w-full rounded-xl border border-red-200 bg-white py-2 text-xs font-bold text-red-600 hover:bg-red-50"
                      >
                        重新分析全部候选
                      </button>
                    )}
                  </div>
                )}

                {batchPhase === 'done' && batchResults.length > 0 && (
                  <div aria-label="元数据补全结果" className="space-y-3 rounded-2xl border border-gray-200 bg-gray-50 p-4">
                    <h5 className="text-sm font-black text-gray-800">逐条结果</h5>
                    <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                      {batchResults.map(result => (
                        <div key={result.plan.recordId} className="flex items-start justify-between gap-3 rounded-xl bg-white px-3 py-2 text-xs">
                          <div className="min-w-0">
                            <p className="truncate font-bold text-gray-800">{result.plan.recordName}</p>
                            <p className="mt-1 text-[10px] text-gray-500">
                              {result.status === 'updated'
                                ? result.plan.fields.map(field => BATCH_METADATA_FIELD_LABELS[field]).join('、')
                                : result.reason}
                            </p>
                          </div>
                          <span className={`shrink-0 text-[10px] font-bold ${result.status === 'updated' ? 'text-emerald-600' : result.status === 'failed' ? 'text-red-500' : 'text-gray-400'}`}>
                            {result.status === 'updated' ? '已更新' : result.status === 'failed' ? '失败' : '已跳过'}
                          </span>
                        </div>
                      ))}
                    </div>
                    {batchResults.some(result => result.status === 'failed') && (
                      <button
                        onClick={() => void handleApplyBatch(batchResults.filter(result => result.status === 'failed').map(result => result.plan))}
                        className="w-full rounded-xl border border-red-200 bg-white py-2 text-xs font-bold text-red-600 hover:bg-red-50"
                      >
                        重试失败项
                      </button>
                    )}
                    <button onClick={resetBatch} className="w-full rounded-xl border border-gray-200 bg-white py-2 text-xs font-bold text-gray-600 hover:bg-gray-50">
                      清除结果
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
