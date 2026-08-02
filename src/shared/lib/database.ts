import { invoke } from '@tauri-apps/api/core';
import { UpdateWatchRecord, WatchRecord } from '../types';
import { errorMessage, TmdbMedia, TmdbSearchResponse } from './classification';
import { assertValidUpdateNumbers } from './updateValidation';
import type { SyncConflictV3, SyncPayloadV3, SyncTombstoneV3 } from './syncMerge';

export async function getAllRecordsAsync(): Promise<WatchRecord[]> {
  return invoke('get_all_records');
}

export async function insertRecord(record: WatchRecord): Promise<WatchRecord> {
  return invoke<WatchRecord>('insert_record', { r: record });
}

export async function updateRecord(id: string, updates: UpdateWatchRecord): Promise<WatchRecord> {
  assertValidUpdateNumbers(updates);
  return invoke<WatchRecord>('update_record', { id, updates });
}

export async function deleteRecord(id: string): Promise<void> {
  await invoke('delete_record', { id });
}

export type RecoveryReason = 'import' | 'sync' | 'batch-metadata' | 'migration' | 'target-migration' | 'pre-restore';

export interface RecoveryPoint {
  id: string;
  createdAt: string;
  reason: RecoveryReason;
  databaseVersion: number;
  recordCount: number;
  sizeBytes: number;
  sha256: string;
  retained: boolean;
  integrityOk: boolean;
}

export interface RecoveryPointList {
  points: RecoveryPoint[];
  totalBytes: number;
  capacityBytes: number;
  capacityExceeded: boolean;
}

export interface RecoveryResult {
  preRestorePointId: string;
  recordCount: number;
}

export async function replaceAllRecords(records: WatchRecord[], reason: 'import' | 'sync'): Promise<void> {
  return invoke('replace_all_records', { records, reason });
}

export interface SyncSnapshot {
  targetId: string | null;
  targetEpoch: number | null;
  records: WatchRecord[];
  tombstones: SyncTombstoneV3[];
  recordsGeneration: number;
  baseline: SyncPayloadV3 | null;
  deviceId: string;
  conflicts: SyncConflictV3[];
  remoteEtag: string | null;
  lastCommit: unknown | null;
  v2SourceFingerprint: string | null;
  outbox: SyncOutboxState;
  scheduler: SyncSchedulerState;
  staging: SyncStagingState;
  publishIntent: SyncPublishIntent | null;
}

export interface StagedRecordState {
  id: string;
  operation: 'upsert' | 'delete';
  base: WatchRecord | null;
  local: WatchRecord | null;
  firstGeneration: number;
  lastGeneration: number;
}

export interface SyncStagingState {
  version: 1;
  entries: StagedRecordState[];
}

export interface SyncPublishIntent {
  version: 1;
  commitId: string;
  previousCommitId: string | null;
  expectedGeneration: number;
  includedEntries: Array<{ id: string; lastGeneration: number }>;
  payloadFingerprint: string;
  createdAt: string;
}

export interface SyncOutboxState {
  version: 1;
  pending: boolean;
  dirtyGeneration: number;
  reasons: string[];
  firstQueuedAt: string | null;
  lastQueuedAt: string | null;
}

export interface SyncSchedulerState {
  version: 1;
  paused: boolean;
  consecutiveFailures: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastRemoteCheckAt: string | null;
}

export interface SyncRuntimeState {
  targetId: string | null;
  targetEpoch: number | null;
  outbox: SyncOutboxState;
  scheduler: SyncSchedulerState;
  conflictCount: number;
  lastCommit: unknown | null;
  stagedCount: number;
  publishPending: boolean;
}

export interface SyncCommitInput {
  targetId: string | null;
  targetEpoch: number | null;
  expectedGeneration: number;
  records: WatchRecord[];
  tombstones: SyncTombstoneV3[];
  baseline: SyncPayloadV3;
  conflicts: SyncConflictV3[];
  remoteEtag: string;
  lastCommit: unknown;
  v2SourceFingerprint: string | null;
  acknowledgeOutbox: boolean;
}

export interface SyncCommitResult {
  recordsGeneration: number;
  recordCount: number;
}

export async function getSyncSnapshot(): Promise<SyncSnapshot> {
  return invoke('get_sync_snapshot');
}

export async function getSyncRuntimeState(): Promise<SyncRuntimeState> {
  return invoke('get_sync_runtime_state');
}

export async function setAutoSyncPaused(paused: boolean, targetId: string | null, targetEpoch: number | null): Promise<SyncRuntimeState> {
  return invoke('set_auto_sync_paused', { paused, targetId, targetEpoch });
}

export async function recordSyncFailure(code: string, nextAttemptAt: string | null, targetId: string | null, targetEpoch: number | null): Promise<SyncRuntimeState> {
  return invoke('record_sync_failure', { code, nextAttemptAt, targetId, targetEpoch });
}

export async function commitSyncResult(input: SyncCommitInput): Promise<SyncCommitResult> {
  return invoke('commit_sync_result', { input });
}

export async function prepareSyncPublishIntent(input: {
  targetId: string | null;
  targetEpoch: number | null;
  commitId: string;
  previousCommitId: string | null;
  expectedGeneration: number;
  payloadFingerprint: string;
}): Promise<SyncPublishIntent> {
  return invoke('prepare_sync_publish_intent', { input });
}

export type SyncConflictResolution = 'local' | 'remote' | 'keep' | 'delete';

export async function resolveSyncConflict(id: string, resolution: SyncConflictResolution, targetId: string | null, targetEpoch: number | null): Promise<void> {
  return invoke('resolve_sync_conflict', { id, resolution, targetId, targetEpoch });
}

export interface SyncTargetDescriptor { id: string; normalizedUrl: string; username: string; createdAt: string; lastActivatedAt: string; }
export interface SyncTargetRegistry { version: 1; activeTargetId: string | null; targetEpoch: number; targets: SyncTargetDescriptor[]; }
export interface ActiveSyncConnection { targetId: string; targetEpoch: number; url: string; username: string; credentialAvailable: boolean; }

export const getSyncTargets = (): Promise<SyncTargetRegistry> => invoke('get_sync_targets');
export const getActiveSyncConnection = (): Promise<ActiveSyncConnection | null> => invoke('get_active_sync_connection');
export const activateSyncTarget = (input: { url: string; username: string; password: string }): Promise<SyncTargetRegistry> => invoke('activate_sync_target', { input });
export const disconnectSyncTarget = (): Promise<SyncTargetRegistry> => invoke('disconnect_sync_target');

export async function createRecoveryPoint(reason: RecoveryReason): Promise<RecoveryPoint> {
  return invoke('create_recovery_point', { reason });
}

export async function listRecoveryPoints(): Promise<RecoveryPointList> {
  return invoke('list_recovery_points');
}

export async function setRecoveryPointRetained(id: string, retained: boolean): Promise<void> {
  return invoke('set_recovery_point_retained', { id, retained });
}

export async function deleteRecoveryPoint(id: string): Promise<void> {
  return invoke('delete_recovery_point', { id });
}

export async function restoreRecoveryPoint(id: string): Promise<RecoveryResult> {
  return invoke('restore_recovery_point', { id });
}

export async function openBackupDirectory(): Promise<void> {
  return invoke('open_backup_directory');
}

export async function downloadPosterAsync(path: string): Promise<boolean> {
  const proxy = await getSettingAsync('network_proxy');
  return invoke('download_poster', { path, proxy });
}

export async function getSettingAsync(key: string): Promise<string | null> {
  return invoke('get_setting', { key });
}

export async function setSettingAsync(key: string, value: string): Promise<boolean> {
  return invoke('set_setting', { key, value });
}

export async function vacuumDbAsync(): Promise<void> {
  return invoke('vacuum_db');
}

export interface CredentialStatus { available: boolean; state: 'protected' | 'missing' | 'reentry-required' | 'unavailable'; }
export const getTmdbCredentialStatus = (): Promise<CredentialStatus> => invoke('get_tmdb_credential_status');
export const saveTmdbCredential = (secret: string): Promise<CredentialStatus> => invoke('save_tmdb_credential', { secret });
export const clearTmdbCredential = (): Promise<CredentialStatus> => invoke('clear_tmdb_credential');

interface TmdbRequest { language?: string; }

export async function searchTmdbAsync(args: TmdbRequest & { query: string }): Promise<TmdbSearchResponse> {
  try {
    const proxy = await getSettingAsync('network_proxy');
    const response = await invoke<TmdbSearchResponse>('search_tmdb', {
      query: args.query,
      language: args.language,
      proxy,
    });
    return { success: true, results: response.results ?? [] };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

export async function getTmdbDetailAsync(args: TmdbRequest & { id: number; mediaType: 'movie' | 'tv' }): Promise<TmdbSearchResponse> {
  try {
    const proxy = await getSettingAsync('network_proxy');
    const data = await invoke<TmdbMedia>('get_tmdb_detail', {
      id: args.id,
      mediaType: args.mediaType,
      language: args.language,
      proxy,
    });
    return { success: true, data };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}
