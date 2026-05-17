import { useState, useCallback, useRef } from 'react';
import { WatchRecord } from '../types';
import {
  getAllRecordsAsync,
  insertRecord,
  updateRecord as dbUpdateRecord,
  deleteRecord as dbDeleteRecord,
  replaceAllRecords,
} from '../utils/database';
import { syncToWebDAV, hasCreds } from '../utils/webdav';

export function useWatchList(syncInterval = 30) {
  const [records, setRecords] = useState<WatchRecord[]>([]);
  const [isSyncPaused, setIsSyncPaused] = useState(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef(syncInterval);

  // 同步最新的 interval
  intervalRef.current = syncInterval;

  // 加载所有记录
  const loadRecords = useCallback(async () => {
    const allRecords = await getAllRecordsAsync();
    setRecords(allRecords);
    return allRecords;
  }, []);

  // 自动同步到坚果云 WebDAV（增加防抖处理，避免频繁更新）
  const autoSyncDebounced = useCallback((updatedRecords: WatchRecord[]) => {
    if (!hasCreds() || isSyncPaused) return;

    // 清除之前的定时器
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
    }

    // 使用配置的秒数（转为毫秒）
    const ms = intervalRef.current * 1000;
    
    syncTimerRef.current = setTimeout(() => {
      console.log(`[Sync] Triggering debounced auto-sync after ${intervalRef.current}s...`);
      syncToWebDAV(updatedRecords).catch(() => {
        // 静默失败
      });
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

  const addRecord = useCallback((record: Omit<WatchRecord, 'id' | 'createdAt'>) => {
    const newRecord: WatchRecord = {
      ...record,
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
    };
    insertRecord(newRecord);
    setRecords(prev => {
      const updated = [newRecord, ...prev];
      autoSyncDebounced(updated);
      return updated;
    });
  }, [autoSyncDebounced]);

  const updateRecord = useCallback((id: string, updates: Partial<WatchRecord>) => {
    dbUpdateRecord(id, updates);
    setRecords(prev => {
      const updated = prev.map(r => r.id === id ? { ...r, ...updates } : r);
      autoSyncDebounced(updated);
      return updated;
    });
  }, [autoSyncDebounced]);

  const deleteRecord = useCallback((id: string) => {
    dbDeleteRecord(id);
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

  return { records, loadRecords, addRecord, updateRecord, deleteRecord, replaceRecords, isSyncPaused, toggleSyncPause };
}
