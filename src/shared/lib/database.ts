import { invoke } from '@tauri-apps/api/core';
import { UpdateWatchRecord, WatchRecord } from '../types';
import { errorMessage, TmdbMedia, TmdbSearchResponse } from './classification';
import { assertValidUpdateNumbers } from './updateValidation';

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

export async function replaceAllRecords(records: WatchRecord[]): Promise<void> {
  return invoke('replace_all_records', { records });
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

export async function safeEncrypt(text: string, tag?: string): Promise<string> {
  return invoke('encrypt', { text, tag });
}

export async function safeDecrypt(id: string): Promise<string> {
  return invoke('decrypt', { id });
}

interface TmdbRequest {
  apiKey: string;
  language?: string;
}

export async function searchTmdbAsync(args: TmdbRequest & { query: string }): Promise<TmdbSearchResponse> {
  try {
    const proxy = await getSettingAsync('network_proxy');
    const response = await invoke<TmdbSearchResponse>('search_tmdb', {
      apiKey: args.apiKey,
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
      apiKey: args.apiKey,
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
