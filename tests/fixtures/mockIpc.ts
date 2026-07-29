import type { Page } from '@playwright/test';
import type { WatchRecord } from '../../src/shared/types';

export interface MockIpcOptions {
  records?: WatchRecord[];
  failRecordLoads?: boolean;
}

interface MockSnapshot {
  calls: Array<{ command: string; args: Record<string, unknown> }>;
  records: WatchRecord[];
  failRecordLoads: boolean;
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
    ({ records, failRecordLoads }) => {
      const snapshot: MockSnapshot = {
        calls: [],
        records: structuredClone(records),
        failRecordLoads,
      };
      window.__WATCHTRACKER_TEST__ = snapshot;

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
              return null;
            case 'get_all_records':
              requireKeys(command, args, []);
              if (snapshot.failRecordLoads) {
                throw new Error('injected database load failure');
              }
              return structuredClone(snapshot.records);
            case 'insert_record': {
              requireKeys(command, args, ['r']);
              const record = structuredClone(args.r as WatchRecord);
              snapshot.records.unshift(record);
              return null;
            }
            case 'update_record': {
              requireKeys(command, args, ['id', 'updates']);
              const id = args.id as string;
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
              requireKeys(command, args, ['records']);
              snapshot.records = structuredClone(args.records as WatchRecord[]);
              return null;
            case 'set_setting':
              requireKeys(command, args, ['key', 'value']);
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
    },
  );
}

export async function mockSnapshot(page: Page): Promise<MockSnapshot> {
  return page.evaluate(() => structuredClone(window.__WATCHTRACKER_TEST__));
}
