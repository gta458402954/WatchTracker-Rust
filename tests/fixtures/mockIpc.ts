import type { Page } from '@playwright/test';
import type { WatchRecord } from '../../src/shared/types';
import type { TmdbMedia } from '../../src/shared/lib/classification';
import type { RecoveryPoint } from '../../src/shared/lib/database';

export interface MockIpcOptions {
  records?: WatchRecord[];
  failRecordLoads?: boolean;
  settings?: Record<string, string | null>;
  tmdbSearchResults?: TmdbMedia[];
  tmdbDetail?: TmdbMedia;
  tmdbDelayMs?: number;
  updateFailureCounts?: Record<string, number>;
  webdavRemote?: unknown;
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
    ({ records, failRecordLoads, settings, tmdbSearchResults, tmdbDetail, tmdbDelayMs, updateFailureCounts, webdavRemote, databaseCompatibilityIssue, recoveryPoints }) => {
      const controlledRecords = sessionStorage.getItem('__WATCHTRACKER_CONTROLLED_RECORDS__');
      const snapshot: MockSnapshot = {
        calls: [],
        records: controlledRecords ? JSON.parse(controlledRecords) : structuredClone(records),
        failRecordLoads,
        settings: structuredClone(settings),
        recoveryPoints: structuredClone(recoveryPoints),
      };
      window.__WATCHTRACKER_TEST__ = snapshot;
      const remainingUpdateFailures = structuredClone(updateFailureCounts);
      const recoveryRecords: Record<string, WatchRecord[]> = {};
      let recoverySequence = snapshot.recoveryPoints.length;

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
          snapshot.calls.push({ command, args });

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
                revActor: 'local',
              };
              if (existingIndex >= 0) snapshot.records[existingIndex] = persisted;
              else snapshot.records.unshift(persisted);
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
                revActor: 'local',
              };
              snapshot.records[index] = persisted;
              return structuredClone(persisted);
            }
            case 'delete_record':
              requireKeys(command, args, ['id']);
              snapshot.records = snapshot.records.filter((record) => record.id !== args.id);
              return null;
            case 'replace_all_records':
              requireKeys(command, args, ['reason', 'records']);
              makeRecoveryPoint(args.reason as 'import' | 'sync');
              snapshot.records = structuredClone(args.records as WatchRecord[]);
              return null;
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
              return { preRestorePointId: preRestore.id, recordCount: snapshot.records.length };
            }
            case 'open_backup_directory':
              requireKeys(command, args, []);
              return null;
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
              requireKeys(command, args, ['body', 'method', 'password', 'proxy', 'url', 'username']);
              return args.method === 'GET' ? structuredClone(webdavRemote) : null;
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
