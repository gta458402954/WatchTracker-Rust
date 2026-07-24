import { useState, useCallback, useEffect, useRef } from 'react';
import { WatchRecord } from '../../../shared/types';
import {
  getAllRecordsAsync,
  insertRecord,
  updateRecord as dbUpdateRecord,
  deleteRecord as dbDeleteRecord,
  replaceAllRecords,
  reorderRecords as dbReorderRecords,
} from '../../../shared/lib/database';
import { syncToWebDAV, hasCreds, markRecordDeleted, clearRecordDeletion } from '../../../shared/lib/webdav';

export function useWatchList(syncInterval = 30) {
  const [records, setRecords] = useState<WatchRecord[]>([]);
  const [isSyncPaused, setIsSyncPaused] = useState(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef(syncInterval);

  // 同步最新的 interval，避免在 render 阶段修改 ref。
  useEffect(() => {
    intervalRef.current = syncInterval;
  }, [syncInterval]);

  // 组件卸载时清除尚未执行的同步任务。
  useEffect(() => {
    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
      }
    };
  }, []);

  // 加载所有记录
  const loadRecords = useCallback(async () => {
    const allRecords = await getAllRecordsAsync();
    setRecords(allRecords);
    return allRecords;
  }, []);

  // 自动同步到坚果云 WebDAV（增加防抖处理，避免频繁更新）
  const autoSyncDebounced = useCallback((updatedRecords: WatchRecord[]) => {
    if (isSyncPaused) return;

    // 清除之前的定时器
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
    }

    // 使用配置的秒数（转为毫秒）
    const ms = intervalRef.current * 1000;
    
    syncTimerRef.current = setTimeout(async () => {
      // 凭据可能在定时器等待期间被清除，因此在实际发起请求前检查。
      if (!(await hasCreds())) {
        syncTimerRef.current = null;
        return;
      }

      console.log(`[Sync] Triggering debounced auto-sync after ${intervalRef.current}s...`);
      const result = await syncToWebDAV(updatedRecords);
      if (result.ok && result.records) {
        await replaceAllRecords(result.records);
        setRecords(await getAllRecordsAsync());
      }
      syncTimerRef.current = null;
    }, ms); 
  }, [isSyncPaused]);

  const toggleSyncPause = useCallback(() => {
    setIsSyncPaused(prev => {
      const next = !prev;
      // 如果是从暂停恢复到开启，且有累积的数据变动，可以考虑立即同步一次
      // 但这里我们简单处理，让用户通过手动同步或下一次操作触发
      if (!next && syncTimerRef.current === null) {
        console.log('[Sync] Resumed. Next change will trigger sync.');
      }
      return next;
    });
  }, []);

  const addRecord = useCallback(async (record: Omit<WatchRecord, 'id' | 'createdAt'>) => {
    const newRecord: WatchRecord = {
      ...record,
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await insertRecord(newRecord);
    setRecords(prev => {
      const updated = [newRecord, ...prev];
      autoSyncDebounced(updated);
      return updated;
    });
  }, [autoSyncDebounced]);

  const updateRecord = useCallback(async (id: string, updates: Partial<WatchRecord>) => {
    const syncedUpdates = { ...updates, updatedAt: new Date().toISOString() };
    await clearRecordDeletion(id);
    await dbUpdateRecord(id, syncedUpdates);
    setRecords(prev => {
      const updated = prev.map(r => r.id === id ? { ...r, ...syncedUpdates } : r);
      autoSyncDebounced(updated);
      return updated;
    });
  }, [autoSyncDebounced]);

  const deleteRecord = useCallback(async (id: string) => {
    await markRecordDeleted(id);
    await dbDeleteRecord(id);
    setRecords(prev => {
      const updated = prev.filter(r => r.id !== id);
      autoSyncDebounced(updated);
      return updated;
    });
  }, [autoSyncDebounced]);

  // WebDAV 同步回写（从云端拉取数据后替换本地）
  const replaceRecords = useCallback(async (newRecords: WatchRecord[]) => {
    // 如果有正在等待的同步，直接取消
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    await replaceAllRecords(newRecords);
    setRecords(newRecords);
  }, []);

  const reorderRecords = useCallback(async (ids: string[]) => {
    await dbReorderRecords(ids);
    setRecords(prev => {
      // Create a map for quick lookup
      const idToIndex = new Map(ids.map((id, index) => [id, index]));
      // Sort the existing array according to the new order
      const updated = [...prev].sort((a, b) => {
        const indexA = idToIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const indexB = idToIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return indexA - indexB;
      });
      // Also update their sortOrder properties
      updated.forEach((r) => {
        if (idToIndex.has(r.id)) {
          r.sortOrder = idToIndex.get(r.id);
        }
      });
      autoSyncDebounced(updated);
      return updated;
    });
  }, [autoSyncDebounced]);

  const restoreRecord = useCallback(async (record: WatchRecord) => {
    const restored = { ...record, updatedAt: new Date().toISOString() };
    await clearRecordDeletion(restored.id);
    await insertRecord(restored);
    setRecords(prev => {
      const updated = prev.some(item => item.id === restored.id)
        ? prev.map(item => item.id === restored.id ? restored : item)
        : [restored, ...prev];
      autoSyncDebounced(updated);
      return updated;
    });
  }, [autoSyncDebounced]);  const syncNow = useCallback(async () => {
    const result = await syncToWebDAV(records);
    if (result.ok && result.records) {
      await replaceAllRecords(result.records);
      setRecords(await getAllRecordsAsync());
    }
    return result;
  }, [records]);
  return { records, loadRecords, addRecord, updateRecord, deleteRecord, replaceRecords, reorderRecords, syncNow, restoreRecord, isSyncPaused, toggleSyncPause };
}
