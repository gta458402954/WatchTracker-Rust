import { useCallback, useState, useEffect, useRef } from 'react';
import { UpdateWatchRecord, WatchRecord } from '../../../shared/types';
import {
  saveCreds, clearCreds, syncToWebDAV, loadFromWebDAV, getCreds, probeSyncTarget, normalizeSyncTargetUrl, clearResolvedSyncConflicts, importLegacyChangesToConflictCenter, syncFailureMessage, type SyncConflict,
} from '../../../shared/lib/webdav';
import {
  createRecoveryPoint,
  clearTmdbCredential,
  deleteRecoveryPoint,
  getSettingAsync,
  getSyncSnapshot,
  getSyncTargets,
  getTmdbDetailAsync,
  getTmdbCredentialStatus,
  listRecoveryPoints,
  openBackupDirectory,
  restoreRecoveryPoint,
  resolveSyncConflict,
  saveTmdbCredential,
  searchTmdbAsync,
  setRecoveryPointRetained,
  setSettingAsync,
  vacuumDbAsync,
  type RecoveryPoint,
  type RecoveryPointList,
  type SyncRuntimeState,
  type SyncTargetRegistry,
} from '../../../shared/lib/database';
import { MEDIA_TYPES, mediaTypeOf, regionsOf, type TmdbMedia } from '../../../shared/lib/classification';
import {
  BATCH_METADATA_STATE_KEY,
  BATCH_METADATA_FIELD_LABELS,
  buildBatchMetadataPatch,
  isBatchMetadataCandidate,
  missingBatchMetadataFields,
  noDataFieldsForRecord,
  parseBatchMetadataNoDataState,
  pruneBatchMetadataNoDataState,
  recordNoDataFields,
  remoteIdentityKey,
  retainMissingMetadataPatch,
  selectBatchMetadataPatch,
  selectTmdbMatch,
  tmdbTypeHintOf,
  type BatchMetadataField,
  type BatchMetadataNoDataState,
  type TmdbMatch,
} from '../../../shared/lib/batchMetadata';
import { notifyOperationFailure, reportOperationFailure, type NoticeTone } from '../../../shared/lib/feedback';
import { normalizeImportedRecords } from '../../../shared/lib/importValidation';

interface SettingsModalProps {
  onClose: () => void;
  records: WatchRecord[];
  onImport: (records: WatchRecord[]) => void | Promise<void>;
  onSync?: () => Promise<{ ok: boolean; error?: string; conflictCount?: number }>;
  onUpdateRecord: (id: string, updates: UpdateWatchRecord) => Promise<void>;
  onDatabaseRestored: () => Promise<WatchRecord[]>;
  syncInterval: number;
  onSyncIntervalChange: (val: number) => void;
  pullIntervalMinutes: number;
  onPullIntervalChange: (val: number) => void;
  syncRuntime: SyncRuntimeState | null;
  onNotify?: (tone: NoticeTone, message: string) => void;
}

type BatchPhase = 'idle' | 'planning' | 'preview' | 'applying' | 'done';
type BatchPlanStatus = 'ready' | 'choice' | 'skipped' | 'failed';

interface BatchCandidate {
  match: TmdbMatch;
  label: string;
}

interface BatchPlanRow {
  recordId: string;
  recordName: string;
  status: BatchPlanStatus;
  updates: UpdateWatchRecord;
  fields: BatchMetadataField[];
  noDataFields?: BatchMetadataField[];
  candidates?: BatchCandidate[];
  remoteIdentity?: string;
  reason?: string;
}

interface BatchApplyResult {
  plan: BatchPlanRow;
  status: 'updated' | 'skipped' | 'failed';
  reason?: string;
}

const RECOVERY_REASON_LABELS: Record<RecoveryPoint['reason'], string> = {
  import: '全量导入前',
  sync: '同步落盘前',
  'batch-metadata': '批量补全前',
  migration: '数据库迁移前',
  'target-migration': '同步目标迁移前',
  'pre-restore': '恢复操作前',
};

const SYNC_FIELD_LABELS: Record<string, string> = {
  originalName: '原名', chineseName: '中文名', progress: '进度', totalEpisodes: '总集数',
  status: '状态', platform: '平台', rating: '个人评分', startDate: '开始日期', endDate: '完成日期',
  notes: '备注', movieProgress: '电影进度', movieDuration: '电影时长', releaseYear: '年份',
  posterPath: '海报', imdbId: 'IMDb 编号', isLocked: '锁定状态', genres: '题材',
  originCountry: '国家/地区', imdbRating: 'IMDb 评分', tmdbStatus: 'TMDB 状态',
  interestLevel: '兴趣等级', episodeRuntime: '单集时长', mediaType: '内容类型',
  contentTags: '内容标签', record: '整条记录', 'legacy-import': '旧版数据差异',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SettingsModal({
  onClose, records, onImport, onSync, onUpdateRecord, onDatabaseRestored,
  syncInterval, onSyncIntervalChange, pullIntervalMinutes, onPullIntervalChange, syncRuntime, onNotify
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'basic' | 'sync' | 'categories' | 'tools'>('basic');

  // WebDAV 状态
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [webdavUrl, setWebdavUrl] = useState('https://dav.jianguoyun.com/dav/影视追踪/');
  const [saved, setSaved] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetRegistry, setTargetRegistry] = useState<SyncTargetRegistry | null>(null);
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [importStatus, setImportStatus] = useState<string>('');
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);

  // 自动同步频率状态
  const [localInterval, setLocalInterval] = useState(syncInterval);
  const [localPullInterval, setLocalPullInterval] = useState(pullIntervalMinutes);

  // 代理设置状态
  const [proxy, setProxy] = useState('');

  // TMDB 状态
  const [tmdbKey, setTmdbKey] = useState('');
  const [tmdbSaved, setTmdbSaved] = useState(false);

  const [vacuumStatus, setVacuumStatus] = useState<string>('');
  const [recoveryPoints, setRecoveryPoints] = useState<RecoveryPointList | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const [recoveryBusyId, setRecoveryBusyId] = useState<string | null>(null);

  // 批量同步状态
  const [batchPhase, setBatchPhase] = useState<BatchPhase>('idle');
  const [batchStatus, setBatchStatus] = useState('');
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchPlan, setBatchPlan] = useState<BatchPlanRow[]>([]);
  const [batchResults, setBatchResults] = useState<BatchApplyResult[]>([]);
  const [batchNoDataState, setBatchNoDataState] = useState<BatchMetadataNoDataState>({ version: 1, records: {} });
  const [batchChoosingId, setBatchChoosingId] = useState<string | null>(null);
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
        if (creds?.url) {
          setWebdavUrl(creds.url);
          setUsername(creds.username);
        }
        try {
          setTargetRegistry(await getSyncTargets());
        } catch (error) {
          if (String(error).includes('target_migration_required')) {
            setSyncStatus('⚠️ 旧版 WebDAV 凭据无法安全迁移，请重新输入账号后连接；本地数据仍可正常使用。');
          } else throw error;
        }

        const tmdbStatus = await getTmdbCredentialStatus();
        setTmdbSaved(tmdbStatus.available);
        if (tmdbStatus.state === 'reentry-required') onNotify?.('warning', 'TMDB 密钥需要在当前 Windows 用户下重新输入。');

        const savedProxy = await getSettingAsync('network_proxy');
        if (savedProxy) setProxy(savedProxy);

        const noDataState = pruneBatchMetadataNoDataState(
          parseBatchMetadataNoDataState(await getSettingAsync(BATCH_METADATA_STATE_KEY)),
          recordsRef.current,
        );
        setBatchNoDataState(noDataState);
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

  const refreshRecoveryPoints = useCallback(async () => {
    try {
      setRecoveryPoints(await listRecoveryPoints());
    } catch (error) {
      showFailure('Settings.ListRecoveryPoints', '读取自动恢复点', error, setRecoveryStatus);
    }
  }, [showFailure]);

  function handleOpenToolsTab() {
    setActiveTab('tools');
    void refreshRecoveryPoints();
  }

  // 保存 TMDB 密钥
  async function handleSaveTmdbKey() {
    if (!tmdbKey.trim()) return;
    try {
      // 存储前先清空旧值，确保触发更新
      await saveTmdbCredential(tmdbKey.trim());
      setTmdbKey('');
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
      await clearTmdbCredential();
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
      const normalizedUrl = normalizeSyncTargetUrl(webdavUrl);
      const current = await getCreds();
      const activeDescriptor = targetRegistry?.targets.find(target => target.id === targetRegistry.activeTargetId);
      const identityChanged = !current
        || activeDescriptor?.username !== username.trim()
        || activeDescriptor?.normalizedUrl !== normalizedUrl;
      if (identityChanged) {
        setSyncStatus('正在只读检查目标...');
        const probe = await probeSyncTarget({ username: username.trim(), password, url: normalizedUrl });
        const description = probe.kind === 'empty'
          ? '目标中暂无同步文件，将在激活后以安全条件创建并上传本机数据。'
          : `目标包含 ${probe.recordCount} 条记录${probe.revision == null ? '' : `，修订 ${probe.revision}`}。激活后将先拉取、合并，再按需上传。`;
        if (!confirm(`${description}\n\n确认切换到此 WebDAV 目标吗？旧目标的待上传数据和冲突会保留。`)) {
          setSyncStatus('已取消切换，当前目标未改变。');
          return;
        }
      }
      await saveCreds({ username: username.trim(), password: password.trim(), url: normalizedUrl });
      setSaved(true);
      setEditingTarget(false);
      setPassword('');
      setTargetRegistry(await getSyncTargets());
      setSyncStatus('目标已激活，正在执行首次拉取与合并...');
      const result = onSync ? await onSync() : await syncToWebDAV(records);
      if (!result.ok) {
        const safeMessage = syncFailureMessage(result.error);
        setSyncStatus(`⚠️ 目标已保存；首次同步未完成。${safeMessage || '请稍后重试。'}`);
        onNotify?.('warning', safeMessage || '目标已保存，但首次同步未完成。');
      } else {
        setSyncStatus(result.conflictCount ? `⚠️ 目标已激活，有 ${result.conflictCount} 项冲突等待选择` : '✅ 目标已激活并完成首次同步');
        showSuccess('WebDAV 目标已激活并完成首次同步。');
      }
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
      setEditingTarget(false);
      setTargetRegistry(await getSyncTargets());
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
        setSyncStatus(result.conflictCount ? `⚠️ 云端核对完成，有 ${result.conflictCount} 项冲突等待选择` : '✅ 同步成功');
        showSuccess('WebDAV 同步完成。');
      } else {
        const safeMessage = syncFailureMessage(result.error);
        if (safeMessage) {
          setSyncStatus(`⚠️ ${safeMessage}`);
          onNotify?.('warning', safeMessage);
        } else showFailure('Settings.SyncWebDav', 'WebDAV 同步', result.error, setSyncStatus);
      }
    } catch (error) {
      showFailure('Settings.SyncWebDav', 'WebDAV 同步', error, setSyncStatus);
    }
    setTimeout(() => setSyncStatus(''), 3000);
  }

  async function handleResolveConflict(conflict: SyncConflict, resolution: 'local' | 'remote' | 'keep' | 'delete') {
    const title = conflict.local?.chineseName || conflict.remote?.chineseName || '未命名条目';
    const action = resolution === 'local' ? '采用本机版本'
      : resolution === 'remote' ? '采用云端版本'
        : resolution === 'keep' ? '保留条目' : '确认删除';
    if (!confirm(`确定对「${title}」${action}吗？选择结果将在下次同步时发布。`)) return;
    try {
      const snapshot = await getSyncSnapshot();
      await resolveSyncConflict(conflict.id, resolution, snapshot.targetId, snapshot.targetEpoch);
      await onDatabaseRestored();
      setSyncConflicts(await clearResolvedSyncConflicts([]));
      showSuccess('同步冲突已解决，选择结果会在下次同步时发布。');
    } catch (error) {
      showFailure('Settings.ResolveConflict', '解决同步冲突', error);
    }
  }

  async function handleImportLegacyChanges() {
    if (!confirm('此操作只会把旧版 records.json 的差异加入冲突中心，不会直接覆盖本机或 v3 云端数据。继续吗？')) return;
    setSyncStatus('正在读取旧版云端数据...');
    try {
      const result = await importLegacyChangesToConflictCenter();
      if (!result.ok) {
        showFailure('Settings.ImportLegacySync', '读取旧版云端数据', result.error, setSyncStatus);
        return;
      }
      setSyncConflicts(await clearResolvedSyncConflicts([]));
      setSyncStatus(result.conflictCount
        ? `⚠️ 已加入 ${result.conflictCount} 项旧版差异，请在冲突中心选择。`
        : '✅ 旧版云端数据与 v3 无差异。');
    } catch (error) {
      showFailure('Settings.ImportLegacySync', '读取旧版云端数据', error, setSyncStatus);
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
      const response = await searchTmdbAsync({ query: imdbId, language: 'zh-CN' });
      if (response.success) return response.results ?? [];
      lastError = new Error(response.error || 'TMDB search failed');
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
    throw lastError;
  }

  async function handleSavePullInterval() {
    try {
      await setSettingAsync('sync_pull_interval_minutes', localPullInterval.toString());
      onPullIntervalChange(localPullInterval);
      setSyncStatus('✅ 主动拉取周期已更新');
      showSuccess('主动拉取周期已更新。');
    } catch (error) {
      showFailure('Settings.SavePullInterval', '保存主动拉取周期', error, setSyncStatus);
    }
    setTimeout(() => setSyncStatus(''), 3000);
  }

  async function handleToggleRecoveryRetention(point: RecoveryPoint) {
    setRecoveryBusyId(point.id);
    try {
      await setRecoveryPointRetained(point.id, !point.retained);
      setRecoveryStatus(point.retained ? '已取消手工保留。' : '已标记为手工保留，不会自动轮转删除。');
      await refreshRecoveryPoints();
    } catch (error) {
      showFailure('Settings.RetainRecoveryPoint', '更新恢复点保留状态', error, setRecoveryStatus);
    } finally {
      setRecoveryBusyId(null);
    }
  }

  async function handleDeleteRecoveryPoint(point: RecoveryPoint) {
    if (!confirm(`确定删除 ${new Date(point.createdAt).toLocaleString('zh-CN')} 的恢复点吗？此文件删除后无法恢复。`)) return;
    setRecoveryBusyId(point.id);
    try {
      await deleteRecoveryPoint(point.id);
      setRecoveryStatus('恢复点已删除。');
      await refreshRecoveryPoints();
    } catch (error) {
      showFailure('Settings.DeleteRecoveryPoint', '删除恢复点', error, setRecoveryStatus);
    } finally {
      setRecoveryBusyId(null);
    }
  }

  async function handleRestoreRecoveryPoint(point: RecoveryPoint) {
    const preview = [
      `恢复点：${new Date(point.createdAt).toLocaleString('zh-CN')}（${RECOVERY_REASON_LABELS[point.reason]}）`,
      `数据库版本：当前 V18 → 快照 V${point.databaseVersion}`,
      `记录数量：当前 ${records.length} → 快照 ${point.recordCount}`,
      '',
      '恢复会替换整个本地数据库；程序会先自动保存当前数据库。确定继续吗？',
    ].join('\n');
    if (!confirm(preview)) return;
    setRecoveryBusyId(point.id);
    setRecoveryStatus('正在验证并恢复数据库...');
    try {
      const result = await restoreRecoveryPoint(point.id);
      await onDatabaseRestored();
      await refreshRecoveryPoints();
      setRecoveryStatus(`✅ 已恢复 ${result.recordCount} 条记录；恢复前状态也已保存。`);
      showSuccess('数据库恢复完成。');
    } catch (error) {
      showFailure('Settings.RestoreRecoveryPoint', '恢复数据库', error, setRecoveryStatus);
    } finally {
      setRecoveryBusyId(null);
    }
  }

  async function getTmdbDetailWithRetry(id: number, mediaType: 'movie' | 'tv'): Promise<TmdbMedia> {
    let lastError: unknown = new Error('TMDB detail failed');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (batchCancelRef.current) throw new Error('Batch cancelled');
      const response = await getTmdbDetailAsync({ id, mediaType, language: 'zh-CN' });
      if (response.success && response.data) return response.data;
      lastError = new Error(response.error || 'TMDB detail failed');
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
    throw lastError;
  }

  function batchCandidateLabel(result: TmdbMedia, match: TmdbMatch): string {
    const name = result.title || result.name || result.original_title || result.original_name || `TMDB #${match.id}`;
    const year = (result.release_date || result.first_air_date || '').split('-')[0];
    return `${name}${year ? ` (${year})` : ''} · ${match.type === 'movie' ? '电影' : '剧集'} · #${match.id}`;
  }

  async function handleSelectBatchCandidate(row: BatchPlanRow, match: TmdbMatch) {
    const record = recordsRef.current.find(item => item.id === row.recordId);
    if (!record) return;
    setBatchChoosingId(row.recordId);
    setBatchStatus(`正在读取所选条目：${row.recordName}`);
    try {
      const detail = await getTmdbDetailWithRetry(match.id, match.type);
      let noDataState = pruneBatchMetadataNoDataState(
        parseBatchMetadataNoDataState(await getSettingAsync(BATCH_METADATA_STATE_KEY)),
        recordsRef.current,
      );
      const priorNoData = noDataFieldsForRecord(noDataState, record);
      const allowedFields = new Set(
        missingBatchMetadataFields(record, match.type).filter(field => !priorNoData.has(field)),
      );
      const patch = selectBatchMetadataPatch(buildBatchMetadataPatch(record, detail, match.type), allowedFields);
      const noDataFields = [...allowedFields].filter(field => !patch.fields.includes(field));
      noDataState = recordNoDataFields(noDataState, record, noDataFields);
      await setSettingAsync(BATCH_METADATA_STATE_KEY, JSON.stringify(noDataState));
      setBatchNoDataState(noDataState);
      setBatchPlan(current => current.map(item => item.recordId === row.recordId ? {
        ...item,
        status: patch.fields.length ? 'ready' : 'skipped',
        updates: patch.updates,
        fields: patch.fields,
        noDataFields,
        candidates: undefined,
        remoteIdentity: remoteIdentityKey(match, patch.seasonNumber),
        reason: patch.fields.length ? undefined : '所选 TMDB 条目没有可用于缺失字段的有效值，已记为无需再查',
      } : item));
      setBatchStatus(patch.fields.length ? '已生成所选条目的写入预览。' : '所选条目没有可补字段。');
    } catch (error) {
      reportOperationFailure('Settings.BatchMetadataChoose', error);
      setBatchStatus('❌ 读取所选 TMDB 条目失败，请重试选择。');
    } finally {
      setBatchChoosingId(null);
    }
  }

  // 第一步只读取远端并生成预览，不写数据库。
  async function handlePrepareBatch() {
    if (!tmdbSaved) {
      setBatchStatus('❌ 请先配置 TMDB API Key');
      onNotify?.('warning', '请先配置 TMDB API Key。');
      return;
    }
    let noDataState = pruneBatchMetadataNoDataState(
      parseBatchMetadataNoDataState(await getSettingAsync(BATCH_METADATA_STATE_KEY)),
      records,
    );
    const targets = records.filter(record => isBatchMetadataCandidate(record, noDataFieldsForRecord(noDataState, record)));
    if (targets.length === 0) {
      setBatchNoDataState(noDataState);
      await setSettingAsync(BATCH_METADATA_STATE_KEY, JSON.stringify(noDataState));
      setBatchStatus('🎉 所有未锁定且带 IMDb 编号的记录均无可补字段，或缺失字段已确认 TMDB 无数据。');
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
          const candidates = matchResult.candidates?.map(match => {
            const result = searchResults.find(item => item.id === match.id && item.media_type === match.type);
            return { match, label: result ? batchCandidateLabel(result, match) : `TMDB #${match.id}` };
          });
          const hint = tmdbTypeHintOf(record);
          const priorNoData = noDataFieldsForRecord(noDataState, record);
          const remainingFields = missingBatchMetadataFields(record, hint).filter(field => !priorNoData.has(field));
          const definitiveNoMatch = hint != null && !searchResults.some(result => result.media_type === hint && result.id);
          const noDataFields = definitiveNoMatch ? remainingFields : [];
          noDataState = recordNoDataFields(noDataState, record, noDataFields);
          rows.push({
            recordId: record.id, recordName: record.chineseName || record.originalName || '未命名条目',
            status: candidates?.length ? 'choice' : 'skipped',
            updates: {}, fields: [], noDataFields, candidates,
            reason: noDataFields.length ? `${matchResult.reason}；缺失字段已记为无需再查` : matchResult.reason,
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
        const priorNoData = noDataFieldsForRecord(noDataState, record);
        const missingFields = missingBatchMetadataFields(record, matchResult.match.type);
        const allowedFields = new Set(missingFields.filter(field => !priorNoData.has(field)));
        const patch = selectBatchMetadataPatch(
          buildBatchMetadataPatch(record, detail, matchResult.match.type),
          allowedFields,
        );
        const noDataFields = [...allowedFields].filter(field => !patch.fields.includes(field));
        noDataState = recordNoDataFields(noDataState, record, noDataFields);
        rows.push({
          recordId: record.id,
          recordName: record.chineseName || record.originalName || '未命名条目',
          status: patch.fields.length ? 'ready' : 'skipped',
          updates: patch.updates,
          fields: patch.fields,
          noDataFields,
          remoteIdentity: remoteIdentityKey(matchResult.match, patch.seasonNumber),
          reason: patch.fields.length ? undefined : 'TMDB 没有返回可用于缺失字段的有效值，已记为无需再查',
        });
      } catch (error) {
        if (batchCancelRef.current) break;
        reportOperationFailure('Settings.BatchMetadataRecord', error);
        rows.push({
          recordId: record.id, recordName: record.chineseName || record.originalName || '未命名条目', status: 'failed',
          updates: {}, fields: [], reason: 'TMDB 查询失败，可重新分析',
        });
      }
      setBatchPlan([...rows]);
      if (index + 1 < targets.length) await new Promise(resolve => setTimeout(resolve, 200));
    }

    try {
      await setSettingAsync(BATCH_METADATA_STATE_KEY, JSON.stringify(noDataState));
      setBatchNoDataState(noDataState);
    } catch (error) {
      reportOperationFailure('Settings.BatchMetadataNoDataState', error);
      onNotify?.('warning', '补全预览已生成，但“TMDB 无数据”状态保存失败，下次可能再次查询。');
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

    const actionableCount = selected.filter(plan => {
      const current = recordsRef.current.find(record => record.id === plan.recordId);
      return current && !current.isLocked && retainMissingMetadataPatch(current, plan.updates).fields.length > 0;
    }).length;
    if (actionableCount >= 2) {
      setBatchStatus('正在创建批量写入前恢复点...');
      try {
        await createRecoveryPoint('batch-metadata');
      } catch (error) {
        showFailure('Settings.BatchMetadataRecoveryPoint', '创建批量写入前恢复点', error, setBatchStatus);
        return;
      }
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

  async function handleClearBatchNoDataState() {
    if (!confirm('确定清除全部“TMDB 无数据”记忆吗？清除后，下次分析会重新查询这些缺失字段。')) return;
    try {
      const emptyState: BatchMetadataNoDataState = { version: 1, records: {} };
      await setSettingAsync(BATCH_METADATA_STATE_KEY, JSON.stringify(emptyState));
      setBatchNoDataState(emptyState);
      setBatchStatus('✅ 已清除 TMDB 无数据记忆。');
    } catch (error) {
      showFailure('Settings.ClearBatchMetadataNoDataState', '清除 TMDB 无数据记忆', error, setBatchStatus);
    }
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
              onClick={handleOpenToolsTab}
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
                      受 Windows 保护
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
                      💡 密钥保存在当前 Windows 用户的凭据管理器中，不会写入 data 目录；移动到其他电脑或 Windows 用户后需要重新输入。可以在 TMDB 官网的个人设置中申请。
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
                      <span className="text-sm text-gray-700 font-medium">TMDB API 密钥已受 Windows 保护</span>
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
                      受 Windows 保护
                    </span>
                  )}
                </div>

                {targetRegistry && targetRegistry.targets.length > 0 && (
                  <div className="rounded-2xl border border-gray-100 bg-gray-50 p-3 space-y-2">
                    <p className="text-[11px] font-bold text-gray-500">已保存目标（共用本地影视库，远端状态相互隔离）</p>
                    {targetRegistry.targets.map(target => (
                      <div key={target.id} className="flex items-center justify-between text-xs text-gray-600">
                        <span className="truncate">{target.username} · {target.normalizedUrl}</span>
                        <span className={`ml-2 shrink-0 rounded-full px-2 py-0.5 ${target.id === targetRegistry.activeTargetId ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}`}>
                          {target.id === targetRegistry.activeTargetId ? '当前' : target.id.slice(0, 8)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {!saved || editingTarget ? (
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
                      {saved ? '只读检查并更新目标' : '只读检查并连接'}
                    </button>
                    {saved && (
                      <button onClick={() => { setEditingTarget(false); setPassword(''); }} className="ml-3 py-2.5 px-4 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600">
                        取消
                      </button>
                    )}
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
                      <div className="shrink-0">
                        <button onClick={() => setEditingTarget(true)} className="mr-4 text-xs text-indigo-600 hover:underline font-bold transition-all">
                          切换 / 更新凭据
                        </button>
                        <button onClick={handleClear} className="text-xs text-red-500 hover:underline font-bold transition-all">
                          断开并保留状态
                        </button>
                      </div>
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
                <button
                  onClick={() => void handleImportLegacyChanges()}
                  className="w-full rounded-xl border border-amber-200 bg-amber-50 py-2 text-xs font-bold text-amber-700 hover:bg-amber-100"
                >
                  检查并导入旧版 records.json 差异
                </button>
              </div>

              {/* Conflict history */}
              <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center justify-between border-b border-gray-50 pb-4">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl">⚖️</span>
                    <div>
                      <h4 className="font-bold text-gray-800">待处理同步冲突</h4>
                      <p className="text-[11px] text-gray-400">不同字段会自动合并；同字段或删除冲突需要明确选择</p>
                    </div>
                  </div>
                </div>
                {syncConflicts.length === 0 ? (
                  <p className="py-4 text-center text-sm text-gray-400">暂无同步冲突记录</p>
                ) : (
                  <div className="space-y-3 max-h-64 overflow-y-auto pr-1 custom-scrollbar">
                    {syncConflicts.map((conflict, index) => (
                      <div key={`${conflict.id}-${conflict.detectedAt}-${index}`} className="rounded-2xl border border-amber-100 bg-amber-50/50 p-4 space-y-3">
                        <div className="flex items-center gap-3">
                        <span className="text-xl">⚠️</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-gray-800">{conflict.local?.chineseName || conflict.remote?.chineseName || '未命名条目'}</p>
                          <p className="text-[11px] text-gray-500">
                            {conflict.kind === 'delete-edit' ? '删除与编辑发生冲突'
                              : conflict.kind === 'locked' ? '锁定条目与云端版本不同'
                                : `双方修改了相同字段：${conflict.fields.map(field => SYNC_FIELD_LABELS[field] || field).join('、')}`}
                            {' · '}{new Date(conflict.detectedAt).toLocaleString('zh-CN')}
                          </p>
                          <p className="mt-1 truncate text-[10px] text-gray-500">
                            本机：{conflict.local?.chineseName || (conflict.localDeleted ? '已删除' : '无记录')}
                            {' / '}云端：{conflict.remote?.chineseName || (conflict.remoteDeleted ? '已删除' : '无记录')}
                          </p>
                        </div>
                        </div>
                        <div className="flex justify-end gap-2">
                          {conflict.kind === 'delete-edit' ? <>
                            <button onClick={() => void handleResolveConflict(conflict, 'keep')} className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-700">保留条目</button>
                            <button onClick={() => void handleResolveConflict(conflict, 'delete')} className="rounded-xl bg-red-500 px-3 py-2 text-xs font-bold text-white hover:bg-red-600">确认删除</button>
                          </> : <>
                            <button onClick={() => void handleResolveConflict(conflict, 'local')} disabled={!conflict.local} className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-700 disabled:bg-gray-300">采用本机</button>
                            <button onClick={() => void handleResolveConflict(conflict, 'remote')} disabled={!conflict.remote} className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:bg-gray-300">采用云端</button>
                          </>}
                        </div>
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
                  <div className="border-t border-gray-100 pt-4 space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-500 font-medium">主动检查云端</span>
                      <select
                        value={localPullInterval}
                        onChange={event => setLocalPullInterval(Number.parseInt(event.target.value, 10))}
                        className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700"
                      >
                        <option value={0}>关闭周期检查</option>
                        <option value={5}>每 5 分钟</option>
                        <option value={15}>每 15 分钟</option>
                        <option value={30}>每 30 分钟</option>
                        <option value={60}>每 60 分钟</option>
                      </select>
                    </div>
                    <p className="text-[11px] leading-5 text-gray-400">
                      启动、重新聚焦和网络恢复仍会检查云端；暂停自动同步时所有自动检查都会停止。
                    </p>
                    <button
                      onClick={handleSavePullInterval}
                      className="py-2 px-5 rounded-xl bg-white border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition-colors shadow-sm"
                    >
                      💾 应用主动拉取周期
                    </button>
                  </div>
                  {syncRuntime && (
                    <div data-testid="sync-runtime-status" className="rounded-2xl bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500">
                      <div>{syncRuntime.scheduler.paused ? '自动同步已暂停'
                        : syncRuntime.conflictCount > 0 ? `${syncRuntime.conflictCount} 项冲突等待处理`
                          : syncRuntime.publishPending ? '正在恢复未完成的云端发布'
                            : syncRuntime.stagedCount > 0 ? `${syncRuntime.stagedCount} 项本地版本等待上传`
                              : syncRuntime.outbox.pending ? '有本地修改等待同步'
                                : '本机与云端已核对'}</div>
                      {syncRuntime.scheduler.lastSuccessAt && <div>最近成功：{new Date(syncRuntime.scheduler.lastSuccessAt).toLocaleString('zh-CN')}</div>}
                      {syncRuntime.scheduler.nextAttemptAt && <div>下次重试：{new Date(syncRuntime.scheduler.nextAttemptAt).toLocaleString('zh-CN')}</div>}
                      {syncRuntime.scheduler.lastErrorCode && <div>当前状态：{syncRuntime.scheduler.lastErrorCode}</div>}
                    </div>
                  )}
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

              {/* Automatic Recovery Points */}
              <div aria-label="自动恢复点" className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                <div className="flex items-center justify-between gap-3 border-b border-gray-50 pb-4">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl">🛟</span>
                    <div>
                      <h4 className="font-bold text-gray-800">高风险操作自动恢复点</h4>
                      <p className="text-[11px] text-gray-400">导入、同步全量落盘、两条以上批量补全及恢复前自动保存完整 SQLite 状态</p>
                    </div>
                  </div>
                  <button
                    onClick={() => void refreshRecoveryPoints()}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-[11px] font-bold text-gray-500 hover:bg-gray-50"
                  >
                    刷新
                  </button>
                </div>

                {recoveryPoints && (
                  <div className="flex items-center justify-between text-[11px] text-gray-500">
                    <span>{recoveryPoints.points.length} 个恢复点 · {formatBytes(recoveryPoints.totalBytes)}</span>
                    <span>自动保留最近 10 个 · 上限 {formatBytes(recoveryPoints.capacityBytes)}</span>
                  </div>
                )}
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[11px] leading-5 text-amber-800">
                  🔐 新凭据仅保存在当前 Windows 用户的凭据管理器中。迁移前创建的恢复点、手工数据库副本或旧便携目录仍可能含旧格式凭据；程序不会自动删除这些文件，必要时请轮换 WebDAV 密码和 TMDB Key。
                </div>
                {recoveryPoints?.capacityExceeded && (
                  <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    手工保留的恢复点使总容量超过上限；程序不会自动删除手工保留项，请按需清理。
                  </p>
                )}

                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {recoveryPoints?.points.map(point => (
                    <div
                      key={point.id}
                      aria-label={`恢复点 ${RECOVERY_REASON_LABELS[point.reason]}`}
                      className="rounded-2xl border border-gray-100 bg-gray-50 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-gray-800">
                            {new Date(point.createdAt).toLocaleString('zh-CN')} · {RECOVERY_REASON_LABELS[point.reason]}
                          </p>
                          <p className="mt-1 text-[10px] text-gray-500">
                            V{point.databaseVersion} · {point.recordCount} 条 · {formatBytes(point.sizeBytes)} · {point.integrityOk ? '校验正常' : '校验失败'}
                            {point.retained && ' · 已手工保留'}
                          </p>
                        </div>
                        <span className={`shrink-0 text-[10px] font-bold ${point.integrityOk ? 'text-emerald-600' : 'text-red-500'}`}>
                          {!point.integrityOk ? '不可用' : point.databaseVersion === 18 ? '可恢复' : '仅供迁移回退'}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          onClick={() => void handleRestoreRecoveryPoint(point)}
                          disabled={!point.integrityOk || point.databaseVersion !== 18 || recoveryBusyId !== null}
                          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-indigo-700 disabled:bg-gray-300"
                        >
                          恢复
                        </button>
                        <button
                          onClick={() => void handleToggleRecoveryRetention(point)}
                          disabled={recoveryBusyId !== null}
                          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[10px] font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                        >
                          {point.retained ? '取消保留' : '手工保留'}
                        </button>
                        <button
                          onClick={() => void handleDeleteRecoveryPoint(point)}
                          disabled={recoveryBusyId !== null}
                          className="rounded-lg border border-red-100 bg-white px-3 py-1.5 text-[10px] font-bold text-red-500 hover:bg-red-50 disabled:opacity-50"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                  {recoveryPoints && recoveryPoints.points.length === 0 && (
                    <p className="py-5 text-center text-xs text-gray-400">尚无自动恢复点；首次高风险操作前会自动创建。</p>
                  )}
                </div>

                <button
                  onClick={() => void openBackupDirectory().catch(error => showFailure('Settings.OpenBackupDirectory', '打开备份目录', error, setRecoveryStatus))}
                  className="w-full rounded-xl border border-gray-200 py-2 text-xs font-bold text-gray-600 hover:bg-gray-50"
                >
                  打开 backups 目录
                </button>
                {recoveryStatus && <p className="text-center text-xs font-medium text-indigo-600">{recoveryStatus}</p>}
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
                  检查 TMDB 可提供的名称、年份、海报、平台、分类、国家、评分、状态及片长/集数等字段，只填空值且绝不覆盖已有内容。TMDB 已确认没有的数据会按“条目 + IMDb 编号 + 字段”记住，下次不再重复查询；IMDb 编号变化后会重新检查。
                  {Object.keys(batchNoDataState.records).length > 0 && ` 当前已记住 ${Object.keys(batchNoDataState.records).length} 个条目的无数据状态。`}
                </div>
                {Object.keys(batchNoDataState.records).length > 0 && (batchPhase === 'idle' || batchPhase === 'done') && (
                  <button
                    onClick={() => void handleClearBatchNoDataState()}
                    className="w-full rounded-xl border border-gray-200 py-2 text-xs font-bold text-gray-500 hover:bg-gray-50"
                  >
                    清除 TMDB 无数据记忆并允许重新检查
                  </button>
                )}
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
                            <span className={`shrink-0 text-[10px] font-bold ${row.status === 'ready' ? 'text-emerald-600' : row.status === 'choice' ? 'text-amber-600' : row.status === 'failed' ? 'text-red-500' : 'text-gray-400'}`}>
                              {row.status === 'ready' ? '可更新' : row.status === 'choice' ? '待选择' : row.status === 'failed' ? '失败' : '跳过'}
                            </span>
                          </div>
                          <p className="mt-1 text-[10px] text-gray-500">
                            {row.fields.length
                              ? row.fields.map(field => BATCH_METADATA_FIELD_LABELS[field]).join('、')
                              : row.reason}
                          </p>
                          {row.noDataFields && row.noDataFields.length > 0 && (
                            <p className="mt-1 text-[10px] text-amber-600">TMDB 无数据：{row.noDataFields.map(field => BATCH_METADATA_FIELD_LABELS[field]).join('、')}（下次不再查询）</p>
                          )}
                          {row.status === 'choice' && row.candidates && (
                            <div className="mt-2 space-y-1.5">
                              {row.candidates.map(candidate => (
                                <button
                                  key={`${candidate.match.type}:${candidate.match.id}`}
                                  onClick={() => void handleSelectBatchCandidate(row, candidate.match)}
                                  disabled={batchChoosingId === row.recordId}
                                  className="block w-full rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-left text-[10px] font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                                >
                                  {batchChoosingId === row.recordId ? '正在读取所选条目…' : candidate.label}
                                </button>
                              ))}
                            </div>
                          )}
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
