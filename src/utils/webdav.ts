/**
 * webdav.ts - 坚果云 WebDAV 同步工具
 * 
 * 凭据存储已升级为 Electron safeStorage 加密模式
 */

import { getSettingAsync, setSettingAsync, safeEncrypt, safeDecrypt } from './database';

const WEBDAV_URL = 'https://dav.jianguoyun.com/dav/影视追踪/records.json';

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

  try {
    const authHeader = `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
    
    // 先尝试创建目录（如果不存在）
    await fetch('https://dav.jianguoyun.com/dav/%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA/', {
      method: 'MKCOL',
      headers: { Authorization: authHeader },
    });

    // 上传文件
    const res = await fetch(WEBDAV_URL, {
      method: 'PUT',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(records),
    });

    if (res.ok || res.status === 201 || res.status === 204) return { ok: true };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** 从坚果云 WebDAV 加载数据 */
export async function loadFromWebDAV(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const creds = await getCreds();
  if (!creds) return { ok: false, error: '未配置凭据' };

  try {
    const res = await fetch(WEBDAV_URL, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}`,
      },
    });

    if (res.ok) {
      const data = await res.json();
      return { ok: true, data };
    }
    if (res.status === 404) return { ok: false, error: '云端暂无数据' };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
