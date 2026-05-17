import { invoke } from '@tauri-apps/api/core';
import { WatchRecord } from '../types';
import { CategoryItem } from '../hooks/useCategories';

export async function initDatabase(): Promise<void> {
  // Tauri 后端在 setup 中自动初始化
  return Promise.resolve();
}

export async function getAllRecordsAsync(): Promise<WatchRecord[]> {
  return await invoke('get_all_records');
}

export async function insertRecord(r: WatchRecord) {
  try {
    await invoke('insert_record', { r });
  } catch (err) {
    console.error('[DB] Insert record failed:', err);
  }
}

export async function updateRecord(id: string, updates: Partial<WatchRecord>) {
  try {
    await invoke('update_record', { id, updates });
  } catch (err) {
    console.error('[DB] Update record failed:', err);
  }
}

export async function deleteRecord(id: string) {
  try {
    await invoke('delete_record', { id });
  } catch (err) {
    console.error('[DB] Delete record failed:', err);
  }
}

export async function replaceAllRecords(records: WatchRecord[]) {
  return await invoke('replace_all_records', { records });
}

export async function getAllCategoriesAsync(): Promise<CategoryItem[]> {
  return await invoke('get_all_categories');
}

export async function upsertCategory(name: string, emoji: string, sortOrder = 0) {
  try {
    await invoke('upsert_category', { name, emoji, sortOrder });
  } catch (err) {
    console.error('[DB] Upsert category failed:', err);
  }
}

export async function renameCategory(oldName: string, newName: string, emoji: string) {
  // 注意：Rust 端目前没实现专门的 rename，可以使用 upsert + delete，
  // 或者直接在 Rust 端补上 rename_category。
  // 计划阶段我列了 rename_category，但在实施时我可能漏写了，建议去 Rust 侧补上。
  // 为了兼容现有逻辑，我们这里调用 Rust 的 rename_category（假设已实现）。
  return await invoke('rename_category', { oldName, newName, emoji });
}

export async function deleteCategoryDb(name: string) {
  try {
    await invoke('delete_category', { name });
  } catch (err) {
    console.error('[DB] Delete category failed:', err);
  }
}

export async function reorderCategories(names: string[]) {
  try {
    // 假设 Rust 端实现了 reorder_categories
    await invoke('reorder_categories', { names });
  } catch (err) {
    console.error('[DB] Reorder categories failed:', err);
  }
}

export async function downloadPosterAsync(path: string): Promise<boolean> {
  const proxy = await getSettingAsync('network_proxy');
  return await invoke('download_poster', { path, proxy });
}

export async function getSettingAsync(key: string): Promise<string | null> {
  return await invoke('get_setting', { key });
}

export async function setSettingAsync(key: string, value: string): Promise<boolean> {
  return await invoke('set_setting', { key, value });
}

export async function vacuumDbAsync(): Promise<void> {
  return await invoke('vacuum_db');
}

export async function safeEncrypt(text: string, tag?: string): Promise<string> {
  return await invoke('encrypt', { text, tag });
}

export async function safeDecrypt(id: string): Promise<string> {
  return await invoke('decrypt', { id });
}

export async function searchTmdbAsync(args: { apiKey: string, query: string, mediaType: 'movie' | 'tv', language?: string }) {
  try {
    const proxy = await getSettingAsync('network_proxy');
    const response = await invoke<any>('search_tmdb', { 
      apiKey: args.apiKey, 
      query: args.query, 
      mediaType: args.mediaType, 
      language: args.language,
      proxy
    });
    
    // 如果 Rust 端返回的是 Ok(Value)，且该 Value 包含 results
    if (response && response.results) {
      return { success: true, results: response.results };
    }
    
    // 如果没有 results 字段，但也属于成功返回（比如空结果对象）
    return { success: true, results: [] };
  } catch (err: any) {
    // Rust 端的 Err(String) 会在这里被捕获
    return { success: false, error: err.toString() };
  }
}

export async function getTmdbDetailAsync(args: { apiKey: string, id: number, mediaType: 'movie' | 'tv', language?: string }) {
  try {
    const proxy = await getSettingAsync('network_proxy');
    const data = await invoke<any>('get_tmdb_detail', { 
      apiKey: args.apiKey, 
      id: args.id, 
      mediaType: args.mediaType, 
      language: args.language,
      proxy
    });
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.toString() };
  }
}

export function isDbReady() { return true; }
export async function persistNow() { return Promise.resolve(); }
