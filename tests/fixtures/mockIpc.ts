import type { Page } from '@playwright/test';
import type { WatchRecord } from '../../src/shared/types';
import type { TmdbMedia } from '../../src/shared/lib/classification';
import type { RecoveryPoint, SyncOutboxState, SyncSchedulerState } from '../../src/shared/lib/database';
import type { SyncConflictV3, SyncPayloadV3, SyncTombstoneV3 } from '../../src/shared/lib/syncMerge';

export interface MockIpcOptions {
  records?: WatchRecord[];
  failRecordLoads?: boolean;
  settings?: Record<string, string | null>;
  tmdbSearchResults?: TmdbMedia[];
  tmdbDetail?: TmdbMedia;
  tmdbDelayMs?: number;
  updateFailureCounts?: Record<string, number>;
  webdavRemote?: unknown;
  webdavV3Remote?: SyncPayloadV3 | null;
  webdavV3Etag?: string | null;
  webdavPreconditionFailures?: number;
  rotateEtagOnPreconditionFailure?: boolean;
  mutateLocalDuringPut?: boolean;
  omitPutEtag?: boolean;
  omitGetEtag?: boolean;
  webdavFailureStatus?: number;
  webdavFailureCount?: number;
  databaseCompatibilityIssue?: {
    code: 'unsupported_newer_database' | 'v19_downgrade_failed';
    detectedVersion: number;
    supportedVersion: number;
  } | null;
  recoveryPoints?: RecoveryPoint[];
}

export interface MockSnapshot {
  calls: Array<{ command: string; args: Record<string, unknown> }>;
  records: WatchRecord[];
  failRecordLoads: boolean;
  settings: Record<string, string | null>;
  recoveryPoints: RecoveryPoint[];
  webdavV3Remote: SyncPayloadV3 | null;
}

declare global {
  interface Window {
    __WATCHTRACKER_TEST__: MockSnapshot;
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

export async function setupMockIpc(page: Page, options: MockIpcOptions = {}) {
  await page.addInitScript(
    ({ records, failRecordLoads, settings, tmdbSearchResults, tmdbDetail, tmdbDelayMs, updateFailureCounts, webdavRemote, webdavV3Remote, webdavV3Etag, webdavPreconditionFailures, rotateEtagOnPreconditionFailure, mutateLocalDuringPut, omitPutEtag, omitGetEtag, webdavFailureStatus, webdavFailureCount, databaseCompatibilityIssue, recoveryPoints }) => {
      const controlledRecords = sessionStorage.getItem('__WATCHTRACKER_CONTROLLED_RECORDS__');
      const controlledRuntime = sessionStorage.getItem('__WATCHTRACKER_SYNC_RUNTIME__');
      const restoredRuntime = controlledRuntime ? JSON.parse(controlledRuntime) as {
        recordsGeneration: number; outbox: SyncOutboxState; scheduler: SyncSchedulerState;
      } : null;
      const snapshot: MockSnapshot = {
        calls: [],
        records: controlledRecords ? JSON.parse(controlledRecords) : structuredClone(records),
        failRecordLoads,
        settings: structuredClone(settings),
        recoveryPoints: structuredClone(recoveryPoints),
        webdavV3Remote: structuredClone(webdavV3Remote),
      };
      window.__WATCHTRACKER_TEST__ = snapshot;
      const remainingUpdateFailures = structuredClone(updateFailureCounts);
      const recoveryRecords: Record<string, WatchRecord[]> = {};
      let recoverySequence = snapshot.recoveryPoints.length;
      let recordsGeneration = restoredRuntime?.recordsGeneration ?? 0;
      let activeTargetId: string | null = snapshot.settings.webdav_creds ? 'a'.repeat(64) : null;
      let targetEpoch = activeTargetId ? 1 : 0;
      const outbox: SyncOutboxState = (() => {
        if (restoredRuntime) return structuredClone(restoredRuntime.outbox);
        try { return JSON.parse(snapshot.settings.sync_outbox_v1 || 'null') || {
          version: 1, pending: false, dirtyGeneration: 0, reasons: [], firstQueuedAt: null, lastQueuedAt: null,
        }; } catch { throw new Error('Invalid sync_outbox_v1'); }
      })();
      let scheduler: SyncSchedulerState = (() => {
        if (restoredRuntime) return structuredClone(restoredRuntime.scheduler);
        try { return JSON.parse(snapshot.settings.sync_scheduler_v1 || 'null') || {
          version: 1, paused: false, consecutiveFailures: 0, nextAttemptAt: null, lastAttemptAt: null,
          lastSuccessAt: null, lastErrorCode: null, lastRemoteCheckAt: null,
        }; } catch { throw new Error('Invalid sync_scheduler_v1'); }
      })();
      let v3Etag: string | null = webdavV3Etag;
      let remainingPreconditionFailures = webdavPreconditionFailures;
      let remainingWebdavFailures = webdavFailureCount;
      let shouldMutateLocalDuringPut = mutateLocalDuringPut;
      let tombstones: SyncTombstoneV3[] = (() => {
        try { return JSON.parse(snapshot.settings.sync_tombstones || '[]'); } catch { return []; }
      })();

      const persistRuntime = () => {
        snapshot.settings.sync_outbox_v1 = JSON.stringify(outbox);
        snapshot.settings.sync_scheduler_v1 = JSON.stringify(scheduler);
        sessionStorage.setItem('__WATCHTRACKER_SYNC_RUNTIME__', JSON.stringify({ recordsGeneration, outbox, scheduler }));
        sessionStorage.setItem('__WATCHTRACKER_CONTROLLED_RECORDS__', JSON.stringify(snapshot.records));
      };

      const queueOutbox = (reason: string) => {
        const now = new Date().toISOString();
        if (!outbox.pending) {
          outbox.firstQueuedAt = now;
          outbox.reasons = [];
        }
        outbox.pending = true;
        outbox.dirtyGeneration = recordsGeneration;
        outbox.lastQueuedAt = now;
        if (!outbox.reasons.includes(reason)) outbox.reasons = [...outbox.reasons.slice(-7), reason];
        persistRuntime();
      };

      const makeRecoveryPoint = (reason: RecoveryPoint['reason']) => {
        recoverySequence += 1;
        const id = `watchtracker-recovery-test-${recoverySequence}-${reason}.db`;
        const point: RecoveryPoint = {
          id,
          createdAt: new Date(1785660000000 + recoverySequence * 1000).toISOString(),
          reason,
          databaseVersion: 18,
          recordCount: snapshot.records.length,
          sizeBytes: 4096,
          sha256: `TEST${recoverySequence}`,
          retained: false,
          integrityOk: true,
        };
        recoveryRecords[id] = structuredClone(snapshot.records);
        snapshot.recoveryPoints.unshift(point);
        return structuredClone(point);
      };

      const requireKeys = (
        command: string,
        args: Record<string, unknown>,
        required: string[],
      ) => {
        const actual = Object.keys(args).sort();
        const expected = [...required].sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`${command} argument keys ${actual.join(',')} != ${expected.join(',')}`);
        }
      };

      window.__TAURI_INTERNALS__ = {
        invoke: async (command, rawArgs = {}) => {
          const args = structuredClone(rawArgs);
          snapshot.calls.push({
            command,
            args: command === 'webdav_request'
              ? structuredClone(args.request as Record<string, unknown>)
              : args,
          });

          switch (command) {
            case 'get_setting':
              requireKeys(command, args, ['key']);
              return snapshot.settings[args.key as string] ?? null;
            case 'get_database_compatibility':
              requireKeys(command, args, []);
              return structuredClone(databaseCompatibilityIssue);
            case 'get_all_records':
              requireKeys(command, args, []);
              if (snapshot.failRecordLoads) {
                throw new Error('injected database load failure');
              }
              return structuredClone(snapshot.records);
            case 'insert_record': {
              requireKeys(command, args, ['r']);
              const record = structuredClone(args.r as WatchRecord);
              const existingIndex = snapshot.records.findIndex(item => item.id === record.id);
              const previous = existingIndex >= 0 ? snapshot.records[existingIndex] : undefined;
              const persisted: WatchRecord = {
                ...record,
                updatedAt: new Date().toISOString(),
                rev: (previous?.rev ?? 0) + 1,
                revActor: 'mock-device',
              };
              if (existingIndex >= 0) snapshot.records[existingIndex] = persisted;
              else snapshot.records.unshift(persisted);
              recordsGeneration += 1;
              queueOutbox('record-insert');
              return structuredClone(persisted);
            }
            case 'update_record': {
              requireKeys(command, args, ['id', 'updates']);
              const id = args.id as string;
              if ((args.updates as Partial<WatchRecord>).episodeRuntime === 0) {
                throw new Error('Invalid episodeRuntime: must be greater than zero');
              }
              if ((remainingUpdateFailures[id] ?? 0) > 0) {
                remainingUpdateFailures[id] -= 1;
                throw new Error('Injected update failure');
              }
              const index = snapshot.records.findIndex((record) => record.id === id);
              if (index < 0) throw new Error('Record not found');
              const previous = snapshot.records[index];
              const persisted: WatchRecord = {
                ...previous,
                ...(args.updates as Partial<WatchRecord>),
                updatedAt: new Date().toISOString(),
                rev: (previous.rev ?? 0) + 1,
                revActor: 'mock-device',
              };
              snapshot.records[index] = persisted;
              recordsGeneration += 1;
              queueOutbox('record-update');
              return structuredClone(persisted);
            }
            case 'delete_record':
              requireKeys(command, args, ['id']);
              snapshot.records = snapshot.records.filter((record) => record.id !== args.id);
              tombstones = tombstones.filter(item => item.id !== args.id);
              tombstones.push({ id: args.id as string, deletedAt: new Date().toISOString(), rev: 0, revActor: 'mock-device' });
              recordsGeneration += 1;
              queueOutbox('record-delete');
              return null;
            case 'replace_all_records':
              requireKeys(command, args, ['reason', 'records']);
              makeRecoveryPoint(args.reason as 'import' | 'sync');
              snapshot.records = structuredClone(args.records as WatchRecord[]);
              recordsGeneration += 1;
              queueOutbox('records-replace');
              return null;
            case 'get_sync_snapshot': {
              requireKeys(command, args, []);
              const parse = (key: string) => {
                const raw = snapshot.settings[key];
                return raw ? JSON.parse(raw) : null;
              };
              return {
                targetId: activeTargetId,
                targetEpoch: activeTargetId ? targetEpoch : null,
                records: structuredClone(snapshot.records),
                tombstones: structuredClone(tombstones),
                recordsGeneration,
                baseline: parse('sync_v3_baseline'),
                deviceId: snapshot.settings.sync_device_id_v1 || 'mock-device',
                conflicts: parse('sync_v3_conflicts') || [],
                remoteEtag: snapshot.settings.sync_v3_remote_etag || null,
                lastCommit: parse('sync_v3_last_commit'),
                v2SourceFingerprint: snapshot.settings.sync_v2_source_fingerprint || null,
                outbox: structuredClone(outbox),
                scheduler: structuredClone(scheduler),
                staging: parse('sync_staging_v1') || { version: 1, entries: [] },
                publishIntent: parse('sync_publish_intent_v1'),
              };
            }
            case 'get_sync_runtime_state':
              requireKeys(command, args, []);
              return {
                targetId: activeTargetId, targetEpoch: activeTargetId ? targetEpoch : null,
                outbox: structuredClone(outbox), scheduler: structuredClone(scheduler),
                conflictCount: JSON.parse(snapshot.settings.sync_v3_conflicts || '[]').length,
                lastCommit: snapshot.settings.sync_v3_last_commit ? JSON.parse(snapshot.settings.sync_v3_last_commit) : null,
                stagedCount: JSON.parse(snapshot.settings.sync_staging_v1 || '{"entries":[]}').entries.length,
                publishPending: Boolean(snapshot.settings.sync_publish_intent_v1),
              };
            case 'set_auto_sync_paused':
              requireKeys(command, args, ['paused', 'targetEpoch', 'targetId']);
              scheduler.paused = args.paused as boolean;
              if (!scheduler.paused) scheduler.nextAttemptAt = null;
              persistRuntime();
              return {
                targetId: activeTargetId, targetEpoch: activeTargetId ? targetEpoch : null,
                outbox: structuredClone(outbox), scheduler: structuredClone(scheduler),
                conflictCount: JSON.parse(snapshot.settings.sync_v3_conflicts || '[]').length,
                lastCommit: snapshot.settings.sync_v3_last_commit ? JSON.parse(snapshot.settings.sync_v3_last_commit) : null,
                stagedCount: JSON.parse(snapshot.settings.sync_staging_v1 || '{"entries":[]}').entries.length,
                publishPending: Boolean(snapshot.settings.sync_publish_intent_v1),
              };
            case 'record_sync_failure':
              requireKeys(command, args, ['code', 'nextAttemptAt', 'targetEpoch', 'targetId']);
              scheduler.consecutiveFailures += 1;
              scheduler.lastAttemptAt = new Date().toISOString();
              scheduler.lastErrorCode = args.code as string;
              scheduler.nextAttemptAt = args.nextAttemptAt as string | null;
              persistRuntime();
              return {
                targetId: activeTargetId, targetEpoch: activeTargetId ? targetEpoch : null,
                outbox: structuredClone(outbox), scheduler: structuredClone(scheduler),
                conflictCount: JSON.parse(snapshot.settings.sync_v3_conflicts || '[]').length,
                lastCommit: snapshot.settings.sync_v3_last_commit ? JSON.parse(snapshot.settings.sync_v3_last_commit) : null,
                stagedCount: JSON.parse(snapshot.settings.sync_staging_v1 || '{"entries":[]}').entries.length,
                publishPending: Boolean(snapshot.settings.sync_publish_intent_v1),
              };
            case 'prepare_sync_publish_intent': {
              requireKeys(command, args, ['input']);
              const input = args.input as {
                targetId: string | null; targetEpoch: number | null;
                commitId: string; previousCommitId: string | null;
                expectedGeneration: number; payloadFingerprint: string;
              };
              if (input.targetId !== activeTargetId || input.targetEpoch !== (activeTargetId ? targetEpoch : null)) throw new Error('stale_sync_target');
              if (input.expectedGeneration !== recordsGeneration) throw new Error('stale_local_snapshot');
              const staging = JSON.parse(snapshot.settings.sync_staging_v1 || '{"entries":[]}') as {
                entries: Array<{ id: string; lastGeneration: number }>;
              };
              const intent = {
                version: 1, ...input,
                includedEntries: staging.entries
                  .filter(entry => entry.lastGeneration <= input.expectedGeneration)
                  .map(entry => ({ id: entry.id, lastGeneration: entry.lastGeneration })),
                createdAt: new Date().toISOString(),
              };
              snapshot.settings.sync_publish_intent_v1 = JSON.stringify(intent);
              return structuredClone(intent);
            }
            case 'commit_sync_result': {
              requireKeys(command, args, ['input']);
              const input = args.input as {
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
              };
              if (input.targetId !== activeTargetId || input.targetEpoch !== (activeTargetId ? targetEpoch : null)) throw new Error('stale_sync_target');
              if (input.expectedGeneration !== recordsGeneration) throw new Error('stale_local_snapshot');
              const businessStateChanged = JSON.stringify(snapshot.records) !== JSON.stringify(input.records)
                || JSON.stringify(tombstones) !== JSON.stringify(input.tombstones);
              if (businessStateChanged) makeRecoveryPoint('sync');
              snapshot.records = structuredClone(input.records);
              tombstones = structuredClone(input.tombstones);
              snapshot.settings.sync_tombstones = JSON.stringify(tombstones);
              snapshot.settings.sync_v3_baseline = JSON.stringify(input.baseline);
              snapshot.settings.sync_v3_conflicts = JSON.stringify(input.conflicts);
              snapshot.settings.sync_v3_remote_etag = input.remoteEtag;
              snapshot.settings.sync_v3_last_commit = JSON.stringify(input.lastCommit);
              const intent = snapshot.settings.sync_publish_intent_v1
                ? JSON.parse(snapshot.settings.sync_publish_intent_v1) as { commitId: string }
                : null;
              if (intent?.commitId === input.baseline.commitId) delete snapshot.settings.sync_publish_intent_v1;
              if (input.v2SourceFingerprint) snapshot.settings.sync_v2_source_fingerprint = input.v2SourceFingerprint;
              if (businessStateChanged) recordsGeneration += 1;
              if (input.acknowledgeOutbox && outbox.pending && outbox.dirtyGeneration <= input.expectedGeneration) {
                outbox.pending = false;
                outbox.reasons = [];
                outbox.firstQueuedAt = null;
                outbox.lastQueuedAt = null;
              }
              if (input.acknowledgeOutbox) {
                outbox.dirtyGeneration = recordsGeneration;
                const now = new Date().toISOString();
                scheduler = {
                  ...scheduler, consecutiveFailures: 0, nextAttemptAt: null, lastAttemptAt: now,
                  lastSuccessAt: now, lastErrorCode: null, lastRemoteCheckAt: now,
                };
              }
              persistRuntime();
              return { recordsGeneration, recordCount: snapshot.records.length };
            }
            case 'resolve_sync_conflict': {
              requireKeys(command, args, ['id', 'resolution', 'targetEpoch', 'targetId']);
              const conflicts = JSON.parse(snapshot.settings.sync_v3_conflicts || '[]') as SyncConflictV3[];
              const conflict = conflicts.find(item => item.id === args.id);
              if (!conflict) throw new Error('Sync conflict not found');
              const resolution = args.resolution as 'local' | 'remote' | 'keep' | 'delete';
              const selected = resolution === 'local' ? conflict.local
                : resolution === 'remote' ? conflict.remote
                  : resolution === 'keep' ? (conflict.local || conflict.remote) : null;
              snapshot.records = snapshot.records.filter(item => item.id !== conflict.id);
              tombstones = tombstones.filter(item => item.id !== conflict.id);
              if (selected) snapshot.records.unshift(structuredClone(selected));
              else tombstones.push({ id: conflict.id, deletedAt: new Date().toISOString(), rev: 0, revActor: 'mock-device' });
              snapshot.settings.sync_v3_conflicts = JSON.stringify(conflicts.filter(item => item.id !== conflict.id));
              recordsGeneration += 1;
              queueOutbox('conflict-resolution');
              return null;
            }
            case 'create_recovery_point':
              requireKeys(command, args, ['reason']);
              return makeRecoveryPoint(args.reason as RecoveryPoint['reason']);
            case 'list_recovery_points': {
              requireKeys(command, args, []);
              const totalBytes = snapshot.recoveryPoints.reduce((sum, point) => sum + point.sizeBytes, 0);
              return {
                points: structuredClone(snapshot.recoveryPoints),
                totalBytes,
                capacityBytes: 500 * 1024 * 1024,
                capacityExceeded: totalBytes > 500 * 1024 * 1024,
              };
            }
            case 'set_recovery_point_retained': {
              requireKeys(command, args, ['id', 'retained']);
              const point = snapshot.recoveryPoints.find(item => item.id === args.id);
              if (!point) throw new Error('Recovery point not found');
              point.retained = args.retained as boolean;
              return null;
            }
            case 'delete_recovery_point':
              requireKeys(command, args, ['id']);
              snapshot.recoveryPoints = snapshot.recoveryPoints.filter(point => point.id !== args.id);
              delete recoveryRecords[args.id as string];
              return null;
            case 'restore_recovery_point': {
              requireKeys(command, args, ['id']);
              const restored = recoveryRecords[args.id as string];
              if (!restored) throw new Error('Recovery point not found');
              const preRestore = makeRecoveryPoint('pre-restore');
              snapshot.records = structuredClone(restored);
              recordsGeneration += 1;
              queueOutbox('recovery-restore');
              return { preRestorePointId: preRestore.id, recordCount: snapshot.records.length };
            }
            case 'open_backup_directory':
              requireKeys(command, args, []);
              return null;
            case 'get_active_sync_credentials': {
              requireKeys(command, args, []);
              if (!activeTargetId || !snapshot.settings.webdav_creds) return null;
              const decrypted = String(snapshot.settings.webdav_creds).replace(/^encrypted:/, '');
              const separator = decrypted.indexOf(':');
              return {
                targetId: activeTargetId, targetEpoch, url: snapshot.settings.webdav_url,
                username: decrypted.slice(0, separator), password: decrypted.slice(separator + 1),
              };
            }
            case 'get_sync_targets':
              requireKeys(command, args, []);
              return {
                version: 1, activeTargetId, targetEpoch,
                targets: activeTargetId ? [{ id: activeTargetId, normalizedUrl: snapshot.settings.webdav_url, username: 'user', createdAt: new Date().toISOString(), lastActivatedAt: new Date().toISOString() }] : [],
              };
            case 'activate_sync_target': {
              requireKeys(command, args, ['input']);
              const input = args.input as { url: string; username: string; password: string };
              if (!activeTargetId) targetEpoch += 1;
              activeTargetId = 'a'.repeat(64);
              snapshot.settings.webdav_url = input.url;
              snapshot.settings.webdav_creds = `encrypted:${input.username}:${input.password}`;
              return { version: 1, activeTargetId, targetEpoch, targets: [{ id: activeTargetId, normalizedUrl: input.url, username: input.username, createdAt: new Date().toISOString(), lastActivatedAt: new Date().toISOString() }] };
            }
            case 'disconnect_sync_target':
              requireKeys(command, args, []);
              activeTargetId = null;
              targetEpoch += 1;
              snapshot.settings.webdav_creds = '';
              return { version: 1, activeTargetId, targetEpoch, targets: [] };
            case 'set_setting':
              requireKeys(command, args, ['key', 'value']);
              snapshot.settings[args.key as string] = args.value as string;
              return true;
            case 'encrypt':
              requireKeys(command, args, ['tag', 'text']);
              return `encrypted:${String(args.text)}`;
            case 'decrypt':
              requireKeys(command, args, ['id']);
              return String(args.id).replace(/^encrypted:/, '');
            case 'search_tmdb':
              requireKeys(command, args, ['apiKey', 'language', 'proxy', 'query']);
              if (tmdbDelayMs > 0) await new Promise(resolve => setTimeout(resolve, tmdbDelayMs));
              return { results: structuredClone(tmdbSearchResults) };
            case 'get_tmdb_detail':
              requireKeys(command, args, ['apiKey', 'id', 'language', 'mediaType', 'proxy']);
              if (tmdbDelayMs > 0) await new Promise(resolve => setTimeout(resolve, tmdbDelayMs));
              return structuredClone(tmdbDetail);
            case 'webdav_request':
              requireKeys(command, args, ['request']);
              {
              const request = args.request as Record<string, unknown>;
              if (remainingWebdavFailures > 0) {
                remainingWebdavFailures -= 1;
                return { status: webdavFailureStatus, body: null, etag: null };
              }
              if (request.method === 'MKCOL') return { status: 405, body: null, etag: null };
              if (request.method === 'PROPFIND') {
                if (!snapshot.webdavV3Remote) return { status: 404, body: null, etag: null, text: null };
                const value = v3Etag ? `<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:getetag>${v3Etag.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}</d:getetag></d:prop></d:propstat></d:response></d:multistatus>` : '<d:multistatus xmlns:d="DAV:" />';
                return { status: 207, body: null, etag: null, text: value };
              }
              if (request.method === 'GET') {
                if (String(request.url).endsWith('records-v3.json')) {
                  return snapshot.webdavV3Remote
                    ? { status: 200, body: structuredClone(snapshot.webdavV3Remote), etag: omitGetEtag ? null : v3Etag }
                    : { status: 404, body: null, etag: null };
                }
                return { status: 200, body: structuredClone(webdavRemote), etag: '"legacy-1"' };
              }
              if (request.method === 'PUT' && String(request.url).endsWith('records-v3.json')) {
                if (remainingPreconditionFailures > 0) {
                  remainingPreconditionFailures -= 1;
                  if (rotateEtagOnPreconditionFailure) v3Etag = `"external-${remainingPreconditionFailures}"`;
                  return { status: 412, body: null, etag: v3Etag };
                }
                const normalizedV3Etag = v3Etag && !v3Etag.includes('"') ? `"${v3Etag}"` : v3Etag;
                const existingPreconditionMatches = request.ifMatch === normalizedV3Etag || request.ifDavEtag === normalizedV3Etag;
                if (snapshot.webdavV3Remote && !existingPreconditionMatches) return { status: 412, body: null, etag: v3Etag };
                if (!snapshot.webdavV3Remote && request.ifNoneMatch !== '*') return { status: 412, body: null, etag: null };
                snapshot.webdavV3Remote = JSON.parse(String(request.body));
                v3Etag = `"v3-${snapshot.webdavV3Remote?.revision ?? 1}"`;
                if (shouldMutateLocalDuringPut) {
                  shouldMutateLocalDuringPut = false;
                  recordsGeneration += 1;
                  if (snapshot.records[0]) snapshot.records[0].notes = 'edited during sync';
                  queueOutbox('record-update');
                }
                return { status: 204, body: null, etag: omitPutEtag ? null : v3Etag };
              }
              return { status: 405, body: null, etag: null };
              }
            case 'vacuum_db':
              requireKeys(command, args, []);
              return null;
            default:
              throw new Error(`Unhandled mock IPC command: ${command}`);
          }
        },
      };
    },
    {
      records: options.records ?? [],
      failRecordLoads: options.failRecordLoads ?? false,
      settings: options.settings ?? {},
      tmdbSearchResults: options.tmdbSearchResults ?? [],
      tmdbDetail: options.tmdbDetail ?? {},
      tmdbDelayMs: options.tmdbDelayMs ?? 0,
      updateFailureCounts: options.updateFailureCounts ?? {},
      webdavRemote: options.webdavRemote ?? [],
      webdavV3Remote: options.webdavV3Remote ?? null,
      webdavV3Etag: options.webdavV3Etag === undefined ? '"v3-1"' : options.webdavV3Etag,
      webdavPreconditionFailures: options.webdavPreconditionFailures ?? 0,
      rotateEtagOnPreconditionFailure: options.rotateEtagOnPreconditionFailure ?? false,
      mutateLocalDuringPut: options.mutateLocalDuringPut ?? false,
      omitPutEtag: options.omitPutEtag ?? false,
      omitGetEtag: options.omitGetEtag ?? false,
      webdavFailureStatus: options.webdavFailureStatus ?? 503,
      webdavFailureCount: options.webdavFailureCount ?? 0,
      databaseCompatibilityIssue: options.databaseCompatibilityIssue ?? null,
      recoveryPoints: options.recoveryPoints ?? [],
    },
  );
}

export async function replaceMockRecords(page: Page, records: WatchRecord[]): Promise<void> {
  await page.evaluate((replacement) => {
    sessionStorage.setItem('__WATCHTRACKER_CONTROLLED_RECORDS__', JSON.stringify(replacement));
  }, records);
  await page.reload();
}

export async function mockSnapshot(page: Page): Promise<MockSnapshot> {
  return page.evaluate(() => structuredClone(window.__WATCHTRACKER_TEST__));
}
