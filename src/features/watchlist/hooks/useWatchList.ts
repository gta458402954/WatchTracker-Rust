import { useState, useCallback, useEffect, useRef } from 'react';
import { WatchRecord } from '../../../shared/types';
import {
  getAllRecordsAsync,
  insertRecord,
  updateRecord as dbUpdateRecord,
  deleteRecord as dbDeleteRecord,
  replaceAllRecords,
} from '../../../shared/lib/database';
import {
  syncToWebDAV,
  hasCreds,
  markRecordDeleted,
  clearRecordDeletion,
  type SyncResult,
} from '../../../shared/lib/webdav';

export function useWatchList(syncInterval = 30) {
  const [records, setRecords] = useState<WatchRecord[]>([]);
  const [isSyncPaused, setIsSyncPaused] = useState(false);
  const recordsRef = useRef<WatchRecord[]>([]);
  const revisionRef = useRef(0);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncInFlightRef = useRef<Promise<SyncResult> | null>(null);
  const intervalRef = useRef(syncInterval);

  useEffect(() => {
    intervalRef.current = syncInterval;
  }, [syncInterval]);

  useEffect(() => () => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
  }, []);

  const loadRecords = useCallback(async () => {
    const allRecords = await getAllRecordsAsync();
    recordsRef.current = allRecords;
    setRecords(allRecords);
    return allRecords;
  }, []);

  const runSync = useCallback(async (): Promise<SyncResult> => {
    while (syncInFlightRef.current) {
      await syncInFlightRef.current;
    }

    const startedRevision = revisionRef.current;
    const task = syncToWebDAV(recordsRef.current);
    syncInFlightRef.current = task;

    try {
      const result = await task;
      if (result.ok && result.records && revisionRef.current === startedRevision) {
        await replaceAllRecords(result.records);
        const reloaded = await getAllRecordsAsync();
        recordsRef.current = reloaded;
        setRecords(reloaded);
      }
      return result;
    } finally {
      if (syncInFlightRef.current === task) syncInFlightRef.current = null;
    }
  }, []);

  const autoSyncDebounced = useCallback(() => {
    if (isSyncPaused) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);

    syncTimerRef.current = setTimeout(async () => {
      syncTimerRef.current = null;
      try {
        if (await hasCreds()) await runSync();
      } catch (error) {
        console.error('[Sync] Automatic sync failed:', error);
      }
    }, intervalRef.current * 1000);
  }, [isSyncPaused, runSync]);

  const toggleSyncPause = useCallback(() => {
    setIsSyncPaused(previous => {
      const next = !previous;
      if (next && syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      return next;
    });
  }, []);

  const addRecord = useCallback(async (record: Omit<WatchRecord, 'id' | 'createdAt'>) => {
    const now = new Date().toISOString();
    const newRecord: WatchRecord = {
      ...record,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await insertRecord(newRecord);
    revisionRef.current++;
    const updated = [newRecord, ...recordsRef.current];
    recordsRef.current = updated;
    setRecords(updated);
    autoSyncDebounced();
  }, [autoSyncDebounced]);

  const updateRecord = useCallback(async (id: string, updates: Partial<WatchRecord>) => {
    const syncedUpdates = { ...updates, updatedAt: new Date().toISOString() };
    await clearRecordDeletion(id);
    await dbUpdateRecord(id, syncedUpdates);
    revisionRef.current++;
    const updated = recordsRef.current.map(record => record.id === id ? { ...record, ...syncedUpdates } : record);
    recordsRef.current = updated;
    setRecords(updated);
    autoSyncDebounced();
  }, [autoSyncDebounced]);

  const deleteRecord = useCallback(async (id: string) => {
    await markRecordDeleted(id);
    await dbDeleteRecord(id);
    revisionRef.current++;
    const updated = recordsRef.current.filter(record => record.id !== id);
    recordsRef.current = updated;
    setRecords(updated);
    autoSyncDebounced();
  }, [autoSyncDebounced]);

  const replaceRecords = useCallback(async (newRecords: WatchRecord[]) => {
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    await replaceAllRecords(newRecords);
    const persisted = await getAllRecordsAsync();
    revisionRef.current++;
    recordsRef.current = persisted;
    setRecords(persisted);
  }, []);

  const restoreRecord = useCallback(async (record: WatchRecord) => {
    const restored = { ...record, updatedAt: new Date().toISOString() };
    await clearRecordDeletion(restored.id);
    await insertRecord(restored);
    revisionRef.current++;
    const updated = recordsRef.current.some(item => item.id === restored.id)
      ? recordsRef.current.map(item => item.id === restored.id ? restored : item)
      : [restored, ...recordsRef.current];
    recordsRef.current = updated;
    setRecords(updated);
    autoSyncDebounced();
  }, [autoSyncDebounced]);

  const syncNow = useCallback(async () => {
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    return runSync();
  }, [runSync]);

  return {
    records,
    loadRecords,
    addRecord,
    updateRecord,
    deleteRecord,
    replaceRecords,
    syncNow,
    restoreRecord,
    isSyncPaused,
    toggleSyncPause,
  };
}
