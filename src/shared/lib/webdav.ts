/**
 * webdav.ts - 坚果云 WebDAV 同步工具
 * 
 * 凭据存储已升级为 Electron safeStorage 加密模式
 */

import { getSettingAsync, setSettingAsync, safeEncrypt, safeDecrypt } from './database';
import { invoke } from '@tauri-apps/api/core';

const WEBDAV_URL = 'https://dav.jianguoyun.com/dav/%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA/records.json';

export interface WebDAVCreds {
  username: string;
  password: string;
}

/** 保存 WebDAV 凭据（同步至数据库以支持便携化） */
export async function saveCreds(creds: WebDAVCreds) {
  const plainText = `${creds.username}:${creds.password}`;
  const encrypted = await safeEncrypt(plainText, 'webdav_creds');
  await setSettingAsync('webdav_creds', encrypted);
}

/** 获取并解密 WebDAV 凭据 */
export async function getCreds(): Promise<WebDAVCreds | null> {
  const stored = await getSettingAsync('webdav_creds');
  if (!stored) return null;
  try {
    const decrypted = await safeDecrypt(stored);

    // 检查主进程返回的加密错误标记
    if (decrypted === '__ERR_DECRYPT_FAILED__' || decrypted === '__ERR_DECRYPT_VERSION_MISMATCH__') {
      throw new Error('DECRYPT_FAILED');
    }
    
    if (!decrypted) return null;
    const [username, password] = decrypted.split(':');
    return { username, password };
  } catch (e: any) {
    if (e.message === 'DECRYPT_FAILED') throw e;
    return null;
  }
}

/** 清除 WebDAV 凭据 */
export async function clearCreds() {
  await setSettingAsync('webdav_creds', '');
}

/** 检查是否已配置 WebDAV 凭据 */
export async function hasCreds(): Promise<boolean> {
  const stored = await getSettingAsync('webdav_creds');
  return !!stored;
}

/** 同步数据到坚果云 WebDAV */
export async function syncToWebDAV(records: unknown): Promise<{ ok: boolean; error?: string }> {
  const creds = await getCreds();
  if (!creds) return { ok: false, error: '未配置凭据' };

  const proxy = await getSettingAsync('network_proxy');

  try {
    // 先尝试创建目录（如果不存在）
    // 忽略错误，因为如果目录已存在，MKCOL 会返回 405
    try {
      await invoke('webdav_request', {
        method: 'MKCOL',
        url: 'https://dav.jianguoyun.com/dav/%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA/',
        username: creds.username,
        password: creds.password,
        proxy
      });
    } catch (e) {
      // 忽略目录创建错误，继续尝试上传
      console.log('MKCOL note:', e);
    }

    // 上传文件
    await invoke('webdav_request', {
      method: 'PUT',
      url: WEBDAV_URL,
      username: creds.username,
      password: creds.password,
      body: JSON.stringify(records),
      proxy
    });

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.toString() };
  }
}

/** 从坚果云 WebDAV 加载数据 */
export async function loadFromWebDAV(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const creds = await getCreds();
  if (!creds) return { ok: false, error: '未配置凭据' };

  const proxy = await getSettingAsync('network_proxy');

  try {
    const data = await invoke('webdav_request', {
      method: 'GET',
      url: WEBDAV_URL,
      username: creds.username,
      password: creds.password,
      proxy
    });

    return { ok: true, data };
  } catch (e: any) {
    if (e.toString().includes('404')) {
      return { ok: false, error: '云端暂无数据' };
    }
    return { ok: false, error: e.toString() };
  }
}
