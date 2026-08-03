/** WebDAV schema v3 synchronization with conditional writes and three-way merging. */
import { invoke } from '@tauri-apps/api/core';
import type { WatchRecord } from '../types';
import {
  commitSyncResult,
  activateSyncTarget,
  disconnectSyncTarget,
  getActiveSyncConnection,
  getSettingAsync,
  setSettingAsync,
  getSyncSnapshot,
  prepareSyncPublishIntent,
} from './database';
import {
  emptySyncPayload,
  mergeEpisodeCompletions,
  mergeSyncStates,
  parseSyncPayloadV3,
  syncValuesEqual,
  type SyncConflictV3,
  type SyncMergeSide,
  type SyncPayloadV3,
  type SyncTombstoneV3,
} from './syncMerge';

const DEFAULT_WEBDAV_BASE_URL = 'https://dav.jianguoyun.com/dav/%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA/';
const V3_RESOURCE = 'records-v3.json';
const LEGACY_RESOURCE = 'records.json';
const MAX_PRECONDITION_RETRIES = 3;

export interface WebDAVCreds { username: string; password?: string; url?: string; targetId?: string; targetEpoch?: number; credentialAvailable?: boolean; }
interface LegacyTombstone { id: string; deletedAt: string; }
interface LegacyPayload { schemaVersion: 2; updatedAt: string; records: WatchRecord[]; tombstones: LegacyTombstone[]; }
interface WebDavResponse { status: number; body: unknown | null; etag: string | null; text: string | null; }
interface ConditionalValidator { etag: string; header: 'if-match' | 'dav-if'; }
export interface SyncResult {
  ok: boolean;
  error?: string;
  records?: WatchRecord[];
  conflictCount?: number;
  conflicts?: SyncConflictV3[];
  staleLocal?: boolean;
  legacyImported?: boolean;
}
export type SyncConflict = SyncConflictV3;

export function normalizeSyncTargetUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid_sync_target_url');
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return `${url.toString().replace(/\/+$/, '')}/`;
}

export function syncFailureMessage(error?: string): string | null {
  switch (error) {
    case 'conditional_write_unsupported':
      return '服务器未提供安全条件写入能力，已禁止上传；本地数据没有被覆盖。';
    case 'conditional_validator_rejected':
      return '服务器持续拒绝同一个安全写入条件，已停止重试；本地数据没有被覆盖。';
    case 'remote_busy':
      return '云端数据持续变化，请稍后重试。';
    case 'stale_local_snapshot':
      return '同步期间出现新的本地修改，本次未覆盖本地数据，请再次同步。';
    case 'stale_sync_target':
      return '同步期间云端目标已切换，旧请求已被拒绝；两个目标的数据均未被覆盖。';
    case 'target_migration_required':
      return '旧版 WebDAV 凭据无法安全迁移，请重新输入账号后再同步。';
    case 'unsupported_remote_schema':
      return '云端数据版本高于当前程序，已停止同步且未写入。';
    case 'legacy_remote_changed':
      return '检测到旧版程序仍在写入 records.json；请升级其他设备后再显式导入旧数据。';
    case 'episode_sync_upgrade_required':
      return '逐集历史尚未获准升级云端同步格式；本地数据已保留。';
    case 'episode_completion_conflict':
      return '两端为同一集记录了不同完成时间，已停止上传以避免覆盖。';
    default:
      return null;
  }
}

export async function saveCreds(creds: WebDAVCreds & { password: string }) {
  await activateSyncTarget({ url: creds.url || DEFAULT_WEBDAV_BASE_URL, username: creds.username, password: creds.password });
}

export async function getCreds(): Promise<WebDAVCreds | null> {
  try {
    const active = await getActiveSyncConnection();
    return active?.credentialAvailable ? { ...active } : null;
  } catch (error) {
    const message = String(error);
    if (['target_migration_required', 'credential_reentry_required', 'credential_missing', 'credential_store_unavailable', 'credential_store_unsupported']
      .some(code => message.includes(code))) return null;
    throw error;
  }
}

export async function clearCreds() { await disconnectSyncTarget(); }
export async function hasCreds(): Promise<boolean> { return !!(await getCreds()); }

function legacyPayload(data: unknown): LegacyPayload {
  if (Array.isArray(data)) return { schemaVersion: 2, updatedAt: '', records: data as WatchRecord[], tombstones: [] };
  if (!data || typeof data !== 'object') throw new Error('invalid_remote_payload');
  const value = data as Omit<Partial<LegacyPayload>, 'schemaVersion'> & { schemaVersion?: number };
  if (typeof value.schemaVersion === 'number' && value.schemaVersion > 3) throw new Error('unsupported_remote_schema');
  if (value.schemaVersion === 3) throw new Error('unexpected_v3_legacy_resource');
  if (!Array.isArray(value.records)) throw new Error('invalid_remote_payload');
  return {
    schemaVersion: 2,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    records: value.records,
    tombstones: Array.isArray(value.tombstones) ? value.tombstones : [],
  };
}

function sideOfPayload(payload: Pick<SyncPayloadV3, 'records' | 'tombstones'>): SyncMergeSide {
  return { records: payload.records, tombstones: payload.tombstones };
}

function sideOfLegacy(payload: LegacyPayload): SyncMergeSide {
  return {
    records: payload.records,
    tombstones: payload.tombstones.map((item): SyncTombstoneV3 => ({
      ...item,
      rev: 0,
      revActor: 'legacy-v2',
    })),
  };
}

function entityTagKind(value: string | null | undefined): 'strong' | 'weak' | null {
  if (!value) return null;
  const weak = value.startsWith('W/');
  const quoted = weak ? value.slice(2) : value;
  if (quoted.length < 3 || !quoted.startsWith('"') || !quoted.endsWith('"')) return null;
  if ([...quoted.slice(1, -1)].some(character => {
    const code = character.charCodeAt(0);
    return character === '"' || code < 32 || code === 127;
  })) return null;
  return weak ? 'weak' : 'strong';
}

function normalizedEntityTag(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (entityTagKind(trimmed)) return trimmed;
  const weak = trimmed.startsWith('W/');
  const opaque = weak ? trimmed.slice(2) : trimmed;
  if (!opaque || [...opaque].some(character => {
    const code = character.charCodeAt(0);
    return character === '"' || code < 32 || code === 127;
  })) return null;
  return `${weak ? 'W/' : ''}"${opaque}"`;
}

function strongEtag(value: string | null | undefined): value is string {
  return entityTagKind(value) === 'strong';
}

function entityTag(value: string | null | undefined): value is string {
  return entityTagKind(value) !== null;
}

function successful(status: number) { return status >= 200 && status < 300; }

async function contentFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function webdavRequest(
  method: 'MKCOL' | 'PUT' | 'GET' | 'PROPFIND',
  creds: WebDAVCreds,
  proxy: string | null,
  resource: string,
  body: string | null = null,
  ifMatch: string | null = null,
  ifNoneMatch: string | null = null,
  ifDavEtag: string | null = null,
): Promise<WebDavResponse> {
  const baseUrl = creds.url?.endsWith('/') ? creds.url : `${creds.url}/`;
  const url = method === 'MKCOL' ? baseUrl : `${baseUrl}${resource}`;
  if (creds.password !== undefined) {
    return invoke('probe_webdav_request', { request: {
      method, url, username: creds.username, password: creds.password, proxy, body,
      ifMatch, ifNoneMatch, ifDavEtag,
    } });
  }
  if (!creds.targetId || creds.targetEpoch === undefined) throw new Error('credential_missing');
  return invoke('webdav_request', { request: {
    targetId: creds.targetId, targetEpoch: creds.targetEpoch, method, url, proxy, body,
    ifMatch, ifNoneMatch, ifDavEtag,
  } });
}

export interface SyncTargetProbe { kind: 'empty' | 'v3' | 'legacy'; recordCount: number; revision: number | null; }

/** Read-only target check. It intentionally never creates a folder or uploads data. */
export async function probeSyncTarget(creds: WebDAVCreds): Promise<SyncTargetProbe> {
  const proxy = await getSettingAsync('network_proxy');
  const v3 = await webdavRequest('GET', creds, proxy, V3_RESOURCE);
  if (v3.status === 200) {
    const payload = parseSyncPayloadV3(v3.body);
    return { kind: 'v3', recordCount: payload.records.length, revision: payload.revision };
  }
  if (v3.status !== 404) throw new Error(`HTTP Error: ${v3.status}`);
  const legacy = await webdavRequest('GET', creds, proxy, LEGACY_RESOURCE);
  if (legacy.status === 200) {
    const payload = legacyPayload(legacy.body);
    return { kind: 'legacy', recordCount: payload.records.length, revision: null };
  }
  if (legacy.status === 404) return { kind: 'empty', recordCount: 0, revision: null };
  throw new Error(`HTTP Error: ${legacy.status}`);
}

function davEtagFromPropfind(text: string | null): string | null {
  if (!text) return null;
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) return null;
  for (const element of Array.from(document.getElementsByTagNameNS('*', 'getetag'))) {
    const value = element.textContent?.trim() ?? '';
    const normalized = normalizedEntityTag(value);
    if (normalized) return normalized;
  }
  return null;
}

async function conditionalValidatorForResource(
  response: WebDavResponse,
  creds: WebDAVCreds,
  proxy: string | null,
  resource: string,
): Promise<ConditionalValidator> {
  const rawResponseEtag = response.etag?.trim() ?? null;
  const responseEtag = normalizedEntityTag(rawResponseEtag);
  if (rawResponseEtag && entityTagKind(rawResponseEtag) === 'strong') {
    return { etag: rawResponseEtag, header: 'if-match' };
  }
  const properties = await webdavRequest('PROPFIND', creds, proxy, resource);
  const propertyEtag = successful(properties.status) ? davEtagFromPropfind(properties.text) : null;
  if (propertyEtag) return { etag: propertyEtag, header: 'dav-if' };
  if (responseEtag) return { etag: responseEtag, header: 'dav-if' };
  throw new Error('conditional_write_unsupported');
}

function payloadForCommit(
  current: SyncPayloadV3,
  remote: SyncMergeSide,
  episodeCompletions: import('../types').EpisodeCompletion[],
  deviceId: string,
  now: string,
): SyncPayloadV3 {
  const useV4 = current.schemaVersion === 4 || episodeCompletions.length > 0
    || remote.records.some(record => record.episodeTrackingEnabled);
  return {
    schemaVersion: useV4 ? 4 : 3,
    documentId: current.documentId,
    revision: current.revision + 1,
    commitId: crypto.randomUUID(),
    parentCommitId: current.commitId || null,
    writerId: deviceId,
    committedAt: now,
    records: remote.records,
    tombstones: remote.tombstones,
    ...(useV4 ? { episodeCompletions } : {}),
  };
}

function syncError(error: unknown): SyncResult {
  const message = String(error);
  if (message.includes('stale_local_snapshot')) {
    return { ok: false, error: 'stale_local_snapshot', staleLocal: true };
  }
  if (message.includes('unsupported_remote_schema')) return { ok: false, error: 'unsupported_remote_schema' };
  if (message.includes('conditional_write_unsupported')) return { ok: false, error: 'conditional_write_unsupported' };
  if (message.includes('conditional_validator_rejected')) return { ok: false, error: 'conditional_validator_rejected' };
  if (message.includes('Invalid WebDAV entity tag')) return { ok: false, error: 'conditional_write_unsupported' };
  if (message.includes('legacy_remote_changed')) return { ok: false, error: 'legacy_remote_changed' };
  if (message.includes('episode_completion_conflict')) return { ok: false, error: 'episode_completion_conflict' };
  if (message.includes('episode_sync_upgrade_required')) return { ok: false, error: 'episode_sync_upgrade_required' };
  return { ok: false, error: message };
}

/** Conditional v3 sync. Every upload is protected by HTTP/WebDAV entity-tag conditions. */
export async function syncToWebDAV(_ignoredRecords?: WatchRecord[]): Promise<SyncResult> {
  void _ignoredRecords;
  const creds = await getCreds();
  if (!creds) return { ok: false, error: '未配置凭据' };
  const proxy = await getSettingAsync('network_proxy');
  try {
    const folder = await webdavRequest('MKCOL', creds, proxy, V3_RESOURCE);
    if (!successful(folder.status) && folder.status !== 405) throw new Error(`HTTP Error: ${folder.status}`);
    const snapshot = await getSyncSnapshot();
    if (snapshot.targetId && (creds.targetId !== snapshot.targetId || creds.targetEpoch !== snapshot.targetEpoch)) {
      throw new Error('stale_sync_target');
    }
    const localSide: SyncMergeSide = { records: snapshot.records, tombstones: snapshot.tombstones };
    const rejectedValidatorFingerprints: string[] = [];

    for (let attempt = 0; attempt < MAX_PRECONDITION_RETRIES; attempt++) {
      const v3Response = await webdavRequest('GET', creds, proxy, V3_RESOURCE);
      let remotePayload: SyncPayloadV3;
      let baseSide: SyncMergeSide;
      let remoteSide: SyncMergeSide;
      let validator: ConditionalValidator | null = null;
      let creating = false;
      let legacyImported = false;
      let legacyFingerprint = snapshot.v2SourceFingerprint;

      if (v3Response.status === 200) {
        validator = await conditionalValidatorForResource(v3Response, creds, proxy, V3_RESOURCE);
        remotePayload = parseSyncPayloadV3(v3Response.body);
        remoteSide = sideOfPayload(remotePayload);
        const recoverablePublishedIntent = snapshot.publishIntent?.commitId === remotePayload.commitId
          && snapshot.publishIntent.payloadFingerprint === await contentFingerprint(remotePayload);
        const sameDeviceBootstrap = !snapshot.baseline && remotePayload.writerId === snapshot.deviceId;
        baseSide = snapshot.baseline
          ? sideOfPayload(parseSyncPayloadV3(snapshot.baseline))
          : (recoverablePublishedIntent || sameDeviceBootstrap ? remoteSide : { records: [], tombstones: [] });
        const legacyResponse = await webdavRequest('GET', creds, proxy, LEGACY_RESOURCE);
        if (legacyResponse.status === 200) {
          const currentFingerprint = legacyResponse.etag || await contentFingerprint(legacyResponse.body);
          if (snapshot.v2SourceFingerprint && snapshot.v2SourceFingerprint !== currentFingerprint) {
            throw new Error('legacy_remote_changed');
          }
          legacyFingerprint = currentFingerprint;
        } else if (legacyResponse.status === 404) {
          legacyFingerprint = 'missing';
        }
      } else if (v3Response.status === 404) {
        creating = true;
        const legacyResponse = await webdavRequest('GET', creds, proxy, LEGACY_RESOURCE);
        const now = new Date().toISOString();
        remotePayload = emptySyncPayload(snapshot.deviceId, now);
        if (legacyResponse.status === 200) {
          const legacy = legacyPayload(legacyResponse.body);
          remoteSide = sideOfLegacy(legacy);
          baseSide = snapshot.baseline ? sideOfPayload(parseSyncPayloadV3(snapshot.baseline)) : remoteSide;
          legacyFingerprint = legacyResponse.etag || await contentFingerprint(legacyResponse.body);
          legacyImported = true;
        } else if (legacyResponse.status === 404) {
          remoteSide = { records: [], tombstones: [] };
          baseSide = snapshot.baseline ? sideOfPayload(parseSyncPayloadV3(snapshot.baseline)) : remoteSide;
          legacyFingerprint = 'missing';
        } else {
          throw new Error(`HTTP Error: ${legacyResponse.status}`);
        }
      } else {
        throw new Error(`HTTP Error: ${v3Response.status}`);
      }

      const now = new Date().toISOString();
      const activeConflicts = snapshot.conflicts.filter(conflict => {
        if (conflict.base || remotePayload.writerId !== snapshot.deviceId
          || !conflict.local || !conflict.remote
          || conflict.local.revActor !== snapshot.deviceId
          || (conflict.local.rev ?? 0) <= (conflict.remote.rev ?? 0)) return true;
        const currentRemote = remoteSide.records.find(record => record.id === conflict.id);
        return !currentRemote || !syncValuesEqual(currentRemote, conflict.remote);
      });
      const merged = mergeSyncStates(
        baseSide, localSide, remoteSide, snapshot.deviceId, now, activeConflicts,
      );
      const baselinePayload = snapshot.baseline ? parseSyncPayloadV3(snapshot.baseline) : null;
      const mergedCompletions = mergeEpisodeCompletions(
        baselinePayload?.episodeCompletions ?? [],
        snapshot.episodeCompletions,
        remotePayload.episodeCompletions ?? [],
        (localCompletion, remoteCompletion) => {
          const record = snapshot.records.find(item => item.id === localCompletion.recordId)
            ?? remotePayload.records.find(item => item.id === localCompletion.recordId);
          const title = record?.chineseName || record?.originalName || localCompletion.recordId;
          return window.confirm(
            `「${title}」第 ${localCompletion.episodeNumber} 集在本机和云端记录了不同的完成时间。\n\n`
            + `本机：${localCompletion.completedAt ?? '时间未知'}\n`
            + `云端：${remoteCompletion.completedAt ?? '时间未知'}\n\n`
            + '确定：采用本机；取消：采用云端。',
          ) ? 'local' : 'remote';
        },
      );
      const localRecordIds = new Set(merged.local.records.map(record => record.id));
      const remoteRecordIds = new Set(merged.remote.records.map(record => record.id));
      const localCompletions = mergedCompletions.filter(item => localRecordIds.has(item.recordId));
      const remoteCompletions = mergedCompletions.filter(item => remoteRecordIds.has(item.recordId));
      const remoteChanged = !syncValuesEqual(merged.remote, remoteSide)
        || !syncValuesEqual(remoteCompletions, remotePayload.episodeCompletions ?? []);
      let confirmedPayload = remotePayload;
      let confirmedEtag = validator?.etag ?? null;

      if (creating || remoteChanged) {
        const nextPayload = payloadForCommit(remotePayload, merged.remote, remoteCompletions, snapshot.deviceId, now);
        if (remotePayload.schemaVersion === 3 && nextPayload.schemaVersion === 4
          && await getSettingAsync('sync_v4_upgrade_confirmed') !== '1') {
          if (!window.confirm('逐集历史需要把云端同步格式升级到 V4。旧版程序将安全停止同步，所有设备都需要更新到支持 V4 的版本。是否继续？')) {
            throw new Error('episode_sync_upgrade_required');
          }
          await setSettingAsync('sync_v4_upgrade_confirmed', '1');
        }
        await prepareSyncPublishIntent({
          targetId: snapshot.targetId,
          targetEpoch: snapshot.targetEpoch,
          commitId: nextPayload.commitId,
          previousCommitId: remotePayload.commitId || null,
          expectedGeneration: snapshot.recordsGeneration,
          payloadFingerprint: await contentFingerprint(nextPayload),
        });
        const put = await webdavRequest(
          'PUT', creds, proxy, V3_RESOURCE, JSON.stringify(nextPayload),
          !creating && validator?.header === 'if-match' ? validator.etag : null,
          creating ? '*' : null,
          !creating && validator?.header === 'dav-if' ? validator.etag : null,
        );
        if (put.status === 412) {
          rejectedValidatorFingerprints.push(await contentFingerprint({
            mode: creating ? 'if-none-match' : validator?.header,
            etag: creating ? '*' : validator?.etag,
          }));
          continue;
        }
        if (!successful(put.status)) throw new Error(`HTTP Error: ${put.status}`);
        confirmedPayload = nextPayload;
        confirmedEtag = put.etag;
        if (!strongEtag(confirmedEtag)) {
          const verification = await webdavRequest('GET', creds, proxy, V3_RESOURCE);
          if (verification.status !== 200) throw new Error('conditional_write_unsupported');
          const verified = parseSyncPayloadV3(verification.body);
          if (verified.commitId !== nextPayload.commitId) continue;
          confirmedPayload = verified;
          confirmedEtag = (await conditionalValidatorForResource(verification, creds, proxy, V3_RESOURCE)).etag;
        }
      }

      if (!entityTag(confirmedEtag)) throw new Error('conditional_write_unsupported');
      await commitSyncResult({
        targetId: snapshot.targetId,
        targetEpoch: snapshot.targetEpoch,
        expectedGeneration: snapshot.recordsGeneration,
        records: merged.local.records,
        tombstones: merged.local.tombstones,
        episodeCompletions: localCompletions,
        baseline: confirmedPayload,
        conflicts: merged.conflicts,
        remoteEtag: confirmedEtag,
        lastCommit: {
          revision: confirmedPayload.revision,
          commitId: confirmedPayload.commitId,
          committedAt: confirmedPayload.committedAt,
        },
        v2SourceFingerprint: legacyFingerprint,
        acknowledgeOutbox: true,
      });
      return {
        ok: true,
        records: merged.local.records,
        conflicts: merged.conflicts,
        conflictCount: merged.conflicts.length,
        legacyImported,
      };
    }
    if (rejectedValidatorFingerprints.length === MAX_PRECONDITION_RETRIES
      && new Set(rejectedValidatorFingerprints).size === 1) {
      return { ok: false, error: 'conditional_validator_rejected' };
    }
    return { ok: false, error: 'remote_busy' };
  } catch (error) {
    return syncError(error);
  }
}

/** Read-only remote preview/import. Never performs PUT. */
export async function loadFromWebDAV(): Promise<{ ok: boolean; data?: WatchRecord[]; error?: string }> {
  const creds = await getCreds();
  if (!creds) return { ok: false, error: '未配置凭据' };
  const proxy = await getSettingAsync('network_proxy');
  try {
    const v3 = await webdavRequest('GET', creds, proxy, V3_RESOURCE);
    if (v3.status === 200) return { ok: true, data: parseSyncPayloadV3(v3.body).records };
    if (v3.status !== 404) return { ok: false, error: `HTTP Error: ${v3.status}` };
    const legacy = await webdavRequest('GET', creds, proxy, LEGACY_RESOURCE);
    if (legacy.status === 200) return { ok: true, data: legacyPayload(legacy.body).records };
    return { ok: false, error: legacy.status === 404 ? '云端暂无数据' : `HTTP Error: ${legacy.status}` };
  } catch (error) { return { ok: false, error: String(error) }; }
}

/**
 * Read a changed legacy records.json into the conflict center. It never writes remote data and
 * never replaces a local record automatically.
 */
export async function importLegacyChangesToConflictCenter(): Promise<SyncResult> {
  const creds = await getCreds();
  if (!creds) return { ok: false, error: '未配置凭据' };
  const proxy = await getSettingAsync('network_proxy');
  try {
    const snapshot = await getSyncSnapshot();
    const v3Response = await webdavRequest('GET', creds, proxy, V3_RESOURCE);
    if (v3Response.status !== 200) throw new Error(`HTTP Error: ${v3Response.status}`);
    const v3Etag = (await conditionalValidatorForResource(v3Response, creds, proxy, V3_RESOURCE)).etag;
    const v3 = parseSyncPayloadV3(v3Response.body);
    const legacyResponse = await webdavRequest('GET', creds, proxy, LEGACY_RESOURCE);
    if (legacyResponse.status !== 200) throw new Error(`HTTP Error: ${legacyResponse.status}`);
    const legacy = legacyPayload(legacyResponse.body);
    const fingerprint = legacyResponse.etag || await contentFingerprint(legacyResponse.body);
    const localRecords = new Map(snapshot.records.map(record => [record.id, record]));
    const localTombstones = new Set(snapshot.tombstones.map(item => item.id));
    const baseRecords = new Map((snapshot.baseline?.records ?? []).map(record => [record.id, record]));
    const v3Records = new Map(v3.records.map(record => [record.id, record]));
    const legacyTombstones = new Set(legacy.tombstones.map(item => item.id));
    const imported: SyncConflictV3[] = [];
    const detectedAt = new Date().toISOString();
    for (const legacyRecord of legacy.records) {
      const currentRemote = v3Records.get(legacyRecord.id);
      if (currentRemote && syncValuesEqual(currentRemote, legacyRecord)) continue;
      const local = localRecords.get(legacyRecord.id) ?? null;
      imported.push({
        id: legacyRecord.id,
        kind: local?.isLocked ? 'locked' : 'edit-edit',
        fields: ['legacy-import'],
        base: baseRecords.get(legacyRecord.id) ?? null,
        local,
        remote: legacyRecord,
        localDeleted: localTombstones.has(legacyRecord.id),
        remoteDeleted: false,
        detectedAt,
      });
    }
    for (const id of legacyTombstones) {
      const local = localRecords.get(id) ?? null;
      if (!local && !v3Records.has(id)) continue;
      imported.push({
        id,
        kind: local?.isLocked ? 'locked' : 'delete-edit',
        fields: [],
        base: baseRecords.get(id) ?? null,
        local,
        remote: null,
        localDeleted: localTombstones.has(id),
        remoteDeleted: true,
        detectedAt,
      });
    }
    const byId = new Map(snapshot.conflicts.map(conflict => [conflict.id, conflict]));
    for (const conflict of imported) byId.set(conflict.id, conflict);
    const conflicts = [...byId.values()];
    await commitSyncResult({
      targetId: snapshot.targetId,
      targetEpoch: snapshot.targetEpoch,
      expectedGeneration: snapshot.recordsGeneration,
      records: snapshot.records,
      tombstones: snapshot.tombstones,
      episodeCompletions: snapshot.episodeCompletions,
      baseline: v3,
      conflicts,
      remoteEtag: v3Etag,
      lastCommit: { revision: v3.revision, commitId: v3.commitId, committedAt: v3.committedAt },
      v2SourceFingerprint: fingerprint,
      acknowledgeOutbox: false,
    });
    return { ok: true, records: snapshot.records, conflicts, conflictCount: imported.length };
  } catch (error) { return syncError(error); }
}

export async function getSyncConflicts(): Promise<SyncConflictV3[]> {
  return (await getSyncSnapshot()).conflicts;
}

export async function clearResolvedSyncConflicts(_records: WatchRecord[]): Promise<SyncConflictV3[]> {
  void _records;
  return getSyncConflicts();
}
