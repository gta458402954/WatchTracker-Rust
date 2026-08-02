import { expect, test } from '@playwright/test';
import { mockSnapshot, setupMockIpc } from './fixtures/mockIpc';

const settings = {
  webdav_creds: 'encrypted:user:password',
  webdav_url: 'https://old.example.test/dav/',
};

async function openSyncSettings(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: /云端同步/ }).click();
  await expect(page.getByText(/已保存目标/)).toBeVisible();
  await page.getByRole('button', { name: '切换 / 更新凭据' }).click();
}

test('@sync-target-isolation cancelling a read-only probe never activates or writes the new target', async ({ page }) => {
  await setupMockIpc(page, { settings });
  await openSyncSettings(page);
  await page.getByPlaceholder('WebDAV 服务器地址').fill('https://new.example.test/dav/');
  await page.getByPlaceholder('用户名').fill('new-user');
  await page.getByPlaceholder('WebDAV 密码 / 应用密码').fill('new-password');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '只读检查并更新目标' }).click();
  await expect(page.getByText(/已取消切换/)).toBeVisible();

  const snapshot = await mockSnapshot(page);
  const webdavCalls = snapshot.calls.filter(call => call.command === 'webdav_request');
  expect(webdavCalls.length).toBeGreaterThan(0);
  expect(webdavCalls.every(call => call.args.method === 'GET')).toBe(true);
  expect(snapshot.calls.some(call => call.command === 'activate_sync_target')).toBe(false);
  expect(snapshot.settings.webdav_url).toBe('https://old.example.test/dav/');
});

test('@sync-target-isolation password rotation keeps the same target and proceeds without a switch prompt', async ({ page }) => {
  await setupMockIpc(page, { settings });
  await openSyncSettings(page);
  await page.getByPlaceholder('WebDAV 密码 / 应用密码').fill('rotated-password');
  let dialogCount = 0;
  page.on('dialog', async dialog => { dialogCount += 1; await dialog.accept(); });
  await page.getByRole('button', { name: '只读检查并更新目标' }).click();
  await expect(page.getByText('✅ 目标已激活并完成首次同步')).toBeVisible();

  const snapshot = await mockSnapshot(page);
  const activation = snapshot.calls.findIndex(call => call.command === 'activate_sync_target');
  expect(activation).toBeGreaterThan(-1);
  expect(snapshot.calls.slice(0, activation).some(call => call.command === 'webdav_request')).toBe(false);
  expect(dialogCount).toBe(0);
});
