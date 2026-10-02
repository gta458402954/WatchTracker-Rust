import { expect, test } from '@playwright/test';
import { mockSnapshot, setupMockIpc } from './fixtures/mockIpc';

const settings = {
  webdav_creds: 'encrypted:user:password',
  webdav_url: 'https://old.example.test/dav/',
};

async function openSyncSettings(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '☁️ 云端同步', exact: true }).click();
  await expect(page.getByText(/已保存目标/)).toBeVisible();
  await page.getByRole('button', { name: '切换或更新凭据' }).click();
}

test('@sync-target-display shows a friendly safe address without overflowing actions', async ({ page }) => {
  await setupMockIpc(page, {
    settings: {
      webdav_creds: 'encrypted:gtazhuce@qq.com:password',
      webdav_url: 'https://dav.jianguoyun.com/dav/%E5%BD%B1%E8%A7%86%E8%BF%BD%E8%B8%AA/?token=hidden',
    },
  });
  await page.setViewportSize({ width: 760, height: 760 });
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '☁️ 云端同步', exact: true }).click();

  await expect(page.getByText('WebDAV 已连接')).toBeVisible();
  await expect(page.getByText(/坚果云 · \/影视追踪/).first()).toBeVisible();
  await expect(page.getByText('自动同步：已开启')).toBeVisible();
  await expect(page.getByRole('button', { name: '切换或更新凭据' })).toBeVisible();
  await expect(page.getByRole('button', { name: '断开连接' })).toBeVisible();
  await expect(page.getByText(/断开只移除当前连接/)).toBeVisible();
  await expect(page.getByText(/token=hidden/)).toHaveCount(0);

  const horizontalOverflow = await page.locator('body').evaluate(element => element.scrollWidth > element.clientWidth);
  expect(horizontalOverflow).toBe(false);
});

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
  const probeCalls = snapshot.calls.filter(call => call.command === 'probe_webdav_request');
  expect(probeCalls.length).toBeGreaterThan(0);
  expect(probeCalls.every(call => call.args.request.method === 'GET')).toBe(true);
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
  await expect(page.getByText('✅ 目标已激活。请手动同步以完成首次云端核对。')).toBeVisible();

  const snapshot = await mockSnapshot(page);
  const activation = snapshot.calls.findIndex(call => call.command === 'activate_sync_target');
  expect(activation).toBeGreaterThan(-1);
  expect(snapshot.calls.slice(0, activation).some(call => call.command === 'webdav_request')).toBe(false);
  expect(snapshot.calls.filter(call => call.command === 'run_desktop_sync_coordinator')).toHaveLength(0);
  expect(dialogCount).toBe(0);
});

test('@sync-target-isolation changing the physical target pauses automatic sync before any later configuration notification', async ({ page }) => {
  await setupMockIpc(page, { settings });
  await openSyncSettings(page);
  await page.getByPlaceholder('WebDAV 服务器地址').fill('https://new.example.test/dav/new-root/');
  await page.getByPlaceholder('用户名').fill('new-user');
  await page.getByPlaceholder('WebDAV 密码 / 应用密码').fill('new-password');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '只读检查并更新目标' }).click();

  await expect(page.getByText('自动同步：已暂停')).toBeVisible();
  await expect(page.getByText('自动同步已暂停')).toBeVisible();
  const beforeClose = await mockSnapshot(page);
  const activation = beforeClose.calls.findIndex(call => call.command === 'activate_sync_target');
  const runtimeAfterActivation = beforeClose.calls.findIndex((call, index) => index > activation && call.command === 'get_sync_runtime_state');
  expect(activation).toBeGreaterThan(-1);
  expect(runtimeAfterActivation).toBeGreaterThan(activation);
  expect(JSON.parse(beforeClose.settings.sync_scheduler_v1 as string).paused).toBe(true);

  const coordinatorCallsBeforeClose = beforeClose.calls.filter(call => call.command === 'run_desktop_sync_coordinator').length;
  expect(coordinatorCallsBeforeClose).toBe(0);
  expect(beforeClose.calls.filter(call => call.command === 'webdav_request')).toHaveLength(0);
  await page.getByRole('button', { name: '返回主页' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const afterClose = await mockSnapshot(page);
  expect(afterClose.calls.filter(call => call.command === 'run_desktop_sync_coordinator')).toHaveLength(coordinatorCallsBeforeClose);
});

test('@sync-target-isolation stale automatic admission cannot reinterpret a paused replacement target', async ({ page }) => {
  await setupMockIpc(page, { settings });
  await openSyncSettings(page);
  await page.getByPlaceholder('WebDAV 服务器地址').fill('https://new.example.test/dav/replacement-root/');
  await page.getByPlaceholder('用户名').fill('new-user');
  await page.getByPlaceholder('WebDAV 密码 / 应用密码').fill('new-password');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '只读检查并更新目标' }).click();

  const result = await page.evaluate(async () => {
    const { runDesktopSyncCoordinator } = await import('/src/shared/lib/database.ts');
    return runDesktopSyncCoordinator(null, {
      kind: 'automatic',
      targetId: 'a'.repeat(64),
      targetEpoch: 1,
    });
  });
  expect(result).toEqual({ kind: 'automaticSkipped' });

  const snapshot = await mockSnapshot(page);
  const coordinator = snapshot.calls.filter(call => call.command === 'run_desktop_sync_coordinator');
  expect(coordinator).toHaveLength(1);
  expect(coordinator[0].args.admission).toEqual({
    kind: 'automatic',
    targetId: 'a'.repeat(64),
    targetEpoch: 1,
  });
  expect(JSON.parse(snapshot.settings.sync_scheduler_v1 as string).paused).toBe(true);
  expect(snapshot.calls.filter(call => call.command === 'webdav_request')).toHaveLength(0);
});

test('@sync-target-isolation first target activation remains paused and does not synchronize', async ({ page }) => {
  await setupMockIpc(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '☁️ 云端同步', exact: true }).click();
  await page.getByPlaceholder('WebDAV 服务器地址').fill('https://new.example.test/dav/first-root/');
  await page.getByPlaceholder('用户名').fill('new-user');
  await page.getByPlaceholder('WebDAV 密码 / 应用密码').fill('new-password');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '只读检查并连接' }).click();

  await expect(page.getByText('自动同步：已暂停')).toBeVisible();
  await expect(page.getByText('✅ 目标已激活。请手动同步以完成首次云端核对。')).toBeVisible();
  const snapshot = await mockSnapshot(page);
  expect(snapshot.calls.some(call => call.command === 'activate_sync_target')).toBe(true);
  expect(JSON.parse(snapshot.settings.sync_scheduler_v1 as string).paused).toBe(true);
  expect(snapshot.calls.filter(call => call.command === 'run_desktop_sync_coordinator')).toHaveLength(0);
  expect(snapshot.calls.filter(call => call.command === 'webdav_request')).toHaveLength(0);
  const probeCalls = snapshot.calls.filter(call => call.command === 'probe_webdav_request');
  expect(probeCalls.length).toBeGreaterThan(0);
  expect(probeCalls.every(call => call.args.request.method === 'GET')).toBe(true);
});

test('@sync-target-isolation manual sync is the only explicit coordinator entry point after save', async ({ page }) => {
  await setupMockIpc(page, { settings, coordinatorInitialResult: 'success' });
  await openSyncSettings(page);
  await page.getByPlaceholder('WebDAV 密码 / 应用密码').fill('rotated-password');
  await page.getByRole('button', { name: '只读检查并更新目标' }).click();

  let snapshot = await mockSnapshot(page);
  expect(snapshot.calls.filter(call => call.command === 'run_desktop_sync_coordinator')).toHaveLength(0);
  await page.getByRole('button', { name: '立即同步到云端' }).click();
  await expect(page.getByText('✅ 同步成功')).toBeVisible();
  snapshot = await mockSnapshot(page);
  expect(snapshot.calls.filter(call => call.command === 'run_desktop_sync_coordinator')).toHaveLength(1);
});

test('@sync-target-isolation reports HTTP 409 as an inaccessible target directory', async ({ page }) => {
  await setupMockIpc(page, { settings, webdavFailureStatus: 409, webdavFailureCount: 1 });
  await openSyncSettings(page);
  await page.getByPlaceholder('WebDAV 服务器地址').fill('https://new.example.test/dav/');
  await page.getByPlaceholder('用户名').fill('new-user');
  await page.getByPlaceholder('WebDAV 密码 / 应用密码').fill('new-password');
  await page.getByRole('button', { name: '只读检查并更新目标' }).click();
  await expect(page.getByText('WebDAV 目标目录不存在或无法访问，请确认目录已创建后重试。', { exact: true })).toBeVisible();
  const snapshot = await mockSnapshot(page);
  expect(snapshot.calls.some(call => call.command === 'activate_sync_target')).toBe(false);
});

test('@credential-boundary saved requests never expose credentials to the frontend', async ({ page }) => {
  await setupMockIpc(page, { settings });
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '☁️ 云端同步', exact: true }).click();
  await page.getByRole('button', { name: '立即同步到云端' }).click();

  const snapshot = await mockSnapshot(page);
  const storedCalls = snapshot.calls.filter(call => call.command === 'webdav_request');
  expect(storedCalls.length).toBeGreaterThan(0);
  for (const call of storedCalls) {
    expect(JSON.stringify(call.args)).not.toContain('password');
    expect(JSON.stringify(call.args)).not.toContain('username');
  }
  const connection = snapshot.calls.find(call => call.command === 'get_active_sync_connection');
  expect(JSON.stringify(connection)).not.toContain('password');
});
