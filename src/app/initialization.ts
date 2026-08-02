import { parsePullInterval } from '../shared/lib/syncScheduling.ts';

export interface InitializationDependencies {
  readCredentials: () => Promise<boolean>;
  readSyncInterval: () => Promise<string | null>;
  readPullInterval: () => Promise<string | null>;
  readRecords: () => Promise<unknown>;
}

export interface InitialAppData {
  hasWebDAVCredentials: boolean;
  syncInterval: number;
  pullIntervalMinutes: number;
}

export function parseSyncInterval(value: string | null, fallback = 30): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 5 && parsed <= 300 ? parsed : fallback;
}

export async function initializeApp(
  dependencies: InitializationDependencies,
): Promise<InitialAppData> {
  const hasWebDAVCredentials = await dependencies.readCredentials();
  const savedInterval = await dependencies.readSyncInterval();
  const savedPullInterval = await dependencies.readPullInterval();
  await dependencies.readRecords();

  return {
    hasWebDAVCredentials,
    syncInterval: parseSyncInterval(savedInterval),
    pullIntervalMinutes: parsePullInterval(savedPullInterval),
  };
}
