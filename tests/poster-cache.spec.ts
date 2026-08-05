import { expect, test } from '@playwright/test';
import { mockSnapshot, setupMockIpc } from './fixtures/mockIpc';

test('@poster-cache maintenance is explicit and never writes business records', async ({ page }) => {
  await setupMockIpc(page, { records: [] });
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: /系统工具/ }).click();

  const cache = page.getByLabel('海报缓存');
  await expect(cache).toContainText('自动清理永不删除仍被条目引用的海报');
  await expect(cache).toContainText('建议上限：500.0 MB');

  page.once('dialog', dialog => dialog.accept());
  await cache.getByRole('button', { name: '清理未引用缓存' }).click();
  await expect(cache).toContainText('未引用海报缓存已清理');

  const snapshot = await mockSnapshot(page);
  expect(snapshot.calls.some(call => call.command === 'clean_poster_cache' && call.args.mode === 'unreferenced')).toBe(true);
  expect(snapshot.calls.some(call => ['insert_record', 'update_record', 'delete_record', 'replace_all_records', 'replace_library'].includes(call.command))).toBe(false);
});
