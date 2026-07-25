/** WebDAV 同步：按记录时间合并，兼容旧版 JSON 数组。 */
import { getSettingAsync, setSettingAsync, safeEncrypt, safeDecrypt } from './database';
import { WatchRecord } from '../types';
import { invoke } from '@tauri-apps/api/core';

const DEFAULT_WEBDAV_BASE_URL = 'https://dav.jianguoyun.com/dav/%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA/';
const TOMBSTONES_KEY = 'sync_tombstones';
const CONFLICTS_KEY = 'sync_conflicts';
const LAST_SUCCESSFUL_SYNC_KEY = 'sync_last_success_at';
const CONFLICT_HISTORY_VERSION_KEY = 'sync_conflict_history_version';
const CONFLICT_HISTORY_VERSION = '2';

export interface WebDAVCreds { username: string; password: string; url?: string; }
interface Tombstone { id: string; deletedAt: string; }
interface SyncPayload { schemaVersion: 2; updatedAt: string; records: WatchRecord[]; tombstones: Tombstone[]; }
export interface SyncResult { ok: boolean; error?: string; records?: WatchRecord[]; conflictCount?: number; }
export interface SyncConflict { id: string; kept: 'local' | 'remote'; at: string; discarded: WatchRecord; }

/** 按键名规范化对象，避免云端 JSON 字段顺序不同造成伪冲突。 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}
function recordsEqual(left: WatchRecord, right: WatchRecord) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}
function conflictKey(conflict: SyncConflict) {
  return `${conflict.id}:${conflict.kept}:${JSON.stringify(stableValue(conflict.discarded))}`;
}
function mergeConflictHistory(incoming: SyncConflict[], existing: SyncConflict[]) {
  const known = new Set<string>();
  return [...incoming, ...existing].filter(conflict => {
    const key = conflictKey(conflict);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  }).slice(0, 50);
}

export async function saveCreds(creds: WebDAVCreds) {
  const encrypted = await safeEncrypt(`${creds.username}:${creds.password}`, 'webdav_creds');
  await setSettingAsync('webdav_creds', encrypted);
  if (creds.url) await setSettingAsync('webdav_url', creds.url);
}
export async function getCreds(): Promise<WebDAVCreds | null> {
  const stored = await getSettingAsync('webdav_creds');
  if (!stored) return null;
  const url = await getSettingAsync('webdav_url') || DEFAULT_WEBDAV_BASE_URL;
  try {
    const decrypted = await safeDecrypt(stored);
    if (!decrypted || decrypted.startsWith('__ERR_DECRYPT')) return null;
    const separator = decrypted.indexOf(':');
    return separator < 0 ? null : { username: decrypted.slice(0, separator), password: decrypted.slice(separator + 1), url };
  } catch { return null; }
}
export async function clearCreds() { await setSettingAsync('webdav_creds', ''); }
export async function hasCreds(): Promise<boolean> { return !!(await getCreds()); }

function parsePayload(data: unknown): SyncPayload {
  if (Array.isArray(data)) return { schemaVersion: 2, updatedAt: '', records: data as WatchRecord[], tombstones: [] };
  if (data && typeof data === 'object') {
    const value = data as Partial<SyncPayload>;
    return { schemaVersion: 2, updatedAt: value.updatedAt ?? '', records: Array.isArray(value.records) ? value.records : [], tombstones: Array.isArray(value.tombstones) ? value.tombstones : [] };
  }
  return { schemaVersion: 2, updatedAt: '', records: [], tombstones: [] };
}
function timeOf(record: WatchRecord) { const time = Date.parse(record.updatedAt || record.createdAt || ''); return Number.isNaN(time) ? 0 : time; }
function timeOfDeletion(tombstone: Tombstone) { const time = Date.parse(tombstone.deletedAt); return Number.isNaN(time) ? 0 : time; }
async function getTombstones(): Promise<Tombstone[]> {
  try {
    const value: unknown = JSON.parse((await getSettingAsync(TOMBSTONES_KEY)) || '[]');
    return Array.isArray(value) ? value as Tombstone[] : [];
  } catch { return []; }
}
async function setTombstones(tombstones: Tombstone[]) { await setSettingAsync(TOMBSTONES_KEY, JSON.stringify(tombstones)); }

/** 删除墓碑会在下一次同步时上传，防止另一设备将已删记录重新带回。 */
export async function markRecordDeleted(id: string) {
  const tombstones = (await getTombstones()).filter(item => item.id !== id);
  tombstones.push({ id, deletedAt: new Date().toISOString() });
  await setTombstones(tombstones);
}
async function clearDeletion(id: string) { const tombstones = (await getTombstones()).filter(item => item.id !== id); await setTombstones(tombstones); }

/**
 * 仅当本机与云端都在上次成功同步后修改同一条记录时，才生成冲突备份。
 * 单端正常更新会遇到云端旧版本，但那是待上传的更新，不是冲突。
 */
function mergeSyncState(local: WatchRecord[], remote: SyncPayload, localTombstones: Tombstone[], lastSuccessfulSyncAt: string | null) {
  const records = new Map<string, WatchRecord>();
  const tombstones = new Map<string, Tombstone>();
  const conflicts: SyncConflict[] = [];
  const lastSync = Date.parse(lastSuccessfulSyncAt || '');
  const hasSyncBaseline = !Number.isNaN(lastSync);
  for (const tombstone of [...remote.tombstones, ...localTombstones]) {
    const previous = tombstones.get(tombstone.id);
    if (!previous || timeOfDeletion(tombstone) > timeOfDeletion(previous)) tombstones.set(tombstone.id, tombstone);
  }
  for (const record of remote.records) records.set(record.id, record);
  for (const record of local) {
    const previous = records.get(record.id);
    if (!previous) { records.set(record.id, record); continue; }
    const localWins = record.isLocked || timeOf(record) >= timeOf(previous);
    const changedOnBothSides = hasSyncBaseline && timeOf(record) > lastSync && timeOf(previous) > lastSync;
    if (!recordsEqual(record, previous) && changedOnBothSides) {
      conflicts.push({ id: record.id, kept: localWins ? 'local' : 'remote', at: new Date().toISOString(), discarded: localWins ? previous : record });
    }
    if (localWins) records.set(record.id, record);
  }
  for (const [id, tombstone] of tombstones) {
    const record = records.get(id);
    if (record && (record.isLocked || timeOf(record) > timeOfDeletion(tombstone))) { tombstones.delete(id); continue; }
    records.delete(id);
  }
  return { records: [...records.values()], tombstones: [...tombstones.values()], conflicts };
}

async function webdavRequest(method: 'MKCOL' | 'PUT' | 'GET', creds: WebDAVCreds, proxy: string | null, body?: string) {
  const baseUrl = creds.url?.endsWith('/') ? creds.url : `${creds.url}/`;
  const url = method === 'MKCOL' ? baseUrl : `${baseUrl}records.json`;
  return invoke('webdav_request', { method, url, username: creds.username, password: creds.password, proxy, body });
}

/** 合并本机与云端数据，再写回云端。冲突仅记录真正的双端并发修改。 */
export async function syncToWebDAV(localRecords: WatchRecord[]): Promise<SyncResult> {
  const creds = await getCreds();
  if (!creds) return { ok: false, error: '未配置凭据' };
  const proxy = await getSettingAsync('network_proxy');
  try {
    try { await webdavRequest('MKCOL', creds, proxy); } catch { /* 已存在时忽略 */ }
    let remote = parsePayload([]);
    try { remote = parsePayload(await webdavRequest('GET', creds, proxy)); } catch (error) { if (!String(error).includes('404')) throw error; }
    const merged = mergeSyncState(localRecords, remote, await getTombstones(), await getSettingAsync(LAST_SUCCESSFUL_SYNC_KEY));
    const payload: SyncPayload = { schemaVersion: 2, updatedAt: new Date().toISOString(), records: merged.records, tombstones: merged.tombstones };
    await webdavRequest('PUT', creds, proxy, JSON.stringify(payload));
    await setTombstones(merged.tombstones);
    await setSettingAsync(LAST_SUCCESSFUL_SYNC_KEY, payload.updatedAt);
    if (merged.conflicts.length) {
      const old = JSON.parse((await getSettingAsync(CONFLICTS_KEY)) || '[]') as SyncConflict[];
      await setSettingAsync(CONFLICTS_KEY, JSON.stringify(mergeConflictHistory(merged.conflicts, old)));
    }
    return { ok: true, records: merged.records, conflictCount: merged.conflicts.length };
  } catch (error) { return { ok: false, error: String(error) }; }
}

export async function loadFromWebDAV(): Promise<{ ok: boolean; data?: WatchRecord[]; error?: string }> {
  const creds = await getCreds();
  if (!creds) return { ok: false, error: '未配置凭据' };
  try { return { ok: true, data: parsePayload(await webdavRequest('GET', creds, await getSettingAsync('network_proxy'))).records }; }
  catch (error) { return { ok: false, error: String(error).includes('404') ? '云端暂无数据' : String(error) }; }
}
export async function getSyncConflicts(): Promise<SyncConflict[]> {
  try {
    const value: unknown = JSON.parse((await getSettingAsync(CONFLICTS_KEY)) || '[]');
    return Array.isArray(value) ? value as SyncConflict[] : [];
  } catch { return []; }
}
export async function clearSyncConflicts() { await setSettingAsync(CONFLICTS_KEY, '[]'); }
/** 清除已与当前记录完全相同的旧冲突备份，保留真实差异以便恢复。 */
export async function clearResolvedSyncConflicts(records: WatchRecord[]): Promise<SyncConflict[]> {
  // 旧版本会把单端待上传更新错误写为冲突；此客户端只有一个数据源，可安全清理该历史。
  if ((await getSettingAsync(CONFLICT_HISTORY_VERSION_KEY)) !== CONFLICT_HISTORY_VERSION) {
    await setSettingAsync(CONFLICTS_KEY, '[]');
    await setSettingAsync(CONFLICT_HISTORY_VERSION_KEY, CONFLICT_HISTORY_VERSION);
    return [];
  }
  const currentById = new Map(records.map(record => [record.id, record]));
  const conflicts = await getSyncConflicts();
  const remaining = conflicts.filter(conflict => {
    const current = currentById.get(conflict.id);
    return !current || !recordsEqual(current, conflict.discarded);
  });
  if (remaining.length !== conflicts.length) await setSettingAsync(CONFLICTS_KEY, JSON.stringify(remaining));
  return remaining;
}
export async function clearRecordDeletion(id: string) { await clearDeletion(id); }
