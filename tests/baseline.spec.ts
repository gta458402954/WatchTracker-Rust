import { expect, test } from '@playwright/test';
import { mockSnapshot, setupMockIpc } from './fixtures/mockIpc';

test('ready empty data renders the normal empty state', async ({ page }) => {
  await setupMockIpc(page);
  await page.goto('/');

  await expect(page.getByText('还没有记录，快去添加吧！')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('build-commit')).toHaveText(/^git (?:[0-9a-f]{7,40}|unknown)$/);
});

test('initialization failure shows an error, not empty data, and retry recovers', async ({ page }) => {
  await setupMockIpc(page, { failRecordLoads: true });
  await page.goto('/');

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('无法读取本地数据');
  await expect(alert.getByRole('button', { name: '重试加载' })).toBeVisible();
  await expect(page.getByText('还没有记录，快去添加吧！')).toHaveCount(0);

  await page.evaluate(() => {
    window.__WATCHTRACKER_TEST__.failRecordLoads = false;
  });
  await alert.getByRole('button', { name: '重试加载' }).click();
  await expect(page.getByText('还没有记录，快去添加吧！')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  const snapshot = await mockSnapshot(page);
  expect(snapshot.calls.filter(({ command }) => command === 'get_all_records').length).toBeGreaterThanOrEqual(2);
});

test('current IPC DTO supports create, update, and delete without permissive fallbacks', async ({ page }) => {
  await setupMockIpc(page);
  await page.goto('/');
  await expect(page.getByText('还没有记录，快去添加吧！')).toBeVisible();

  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('heading', { name: '添加新记录' })).toBeVisible();
  await page.getByPlaceholder('请输入中文名称').fill('A007 自动化记录');
  await page.getByPlaceholder('英文 / 原名').fill('A007 Automated Record');
  await page.getByRole('button', { name: '添加记录' }).click();
  await expect(page.getByText('A007 自动化记录')).toBeVisible();

  await page.getByTitle('编辑').click();
  await expect(page.getByRole('heading', { name: '编辑记录' })).toBeVisible();
  await page.getByPlaceholder('请输入中文名称').fill('A007 自动化记录（已修改）');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByText('A007 自动化记录（已修改）')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTitle('删除').click();
  await expect(page.getByText('A007 自动化记录（已修改）')).toHaveCount(0);
  await expect(page.getByText('还没有记录，快去添加吧！')).toBeVisible();

  const snapshot = await mockSnapshot(page);
  expect(snapshot.records).toHaveLength(0);
  expect(snapshot.calls.map(({ command }) => command)).toEqual(expect.arrayContaining([
    'insert_record',
    'update_record',
    'delete_record',
  ]));
});
