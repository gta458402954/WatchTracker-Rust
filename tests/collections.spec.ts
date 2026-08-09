import { expect, test } from '@playwright/test';
import type { CollectionMember, WatchCollection, WatchRecord } from '../src/shared/types';
import { mockSnapshot, setupMockIpc } from './fixtures/mockIpc';

function record(id: string, status: WatchRecord['status'] = '未看'): WatchRecord {
  return {
    id, originalName: `${id} original`, chineseName: id, progress: '', totalEpisodes: null,
    movieProgress: null, movieDuration: null, releaseYear: '2026', posterPath: null,
    status, platform: '', rating: null, startDate: '', endDate: '', notes: '',
    createdAt: '2026-08-09T00:00:00.000Z', imdbId: null, mediaType: '电影',
    contentTags: null, originCountry: 'CN',
  };
}

const collection: WatchCollection = {
  id: 'collection-1', name: '测试系列', normalizedName: '测试系列', description: '端到端测试',
  sourceKind: 'manual', sourceKey: null, createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z', rev: 1, revActor: 'mock-device',
};

function member(recordId: string, position: number): CollectionMember {
  return {
    id: `member-${recordId}`, collectionId: collection.id, recordId, position, sourceKind: 'manual',
    createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z',
    rev: 1, revActor: 'mock-device',
  };
}

async function openCenter(page: Parameters<typeof setupMockIpc>[0]) {
  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '系列与收藏集' }).click();
  await expect(page.getByRole('dialog', { name: '系列与收藏集' })).toBeVisible();
}

test('@collections creates a collection, adds members, reorders them, and keeps records when deleted', async ({ page }) => {
  await setupMockIpc(page, { records: [record('第一部'), record('第二部', '已看')] });
  await page.goto('/');
  await openCenter(page);

  await page.getByRole('button', { name: '新建收藏集' }).click();
  await page.getByPlaceholder('收藏集名称').fill('我的系列');
  await page.getByPlaceholder('说明（可选）').fill('不会改变原始记录');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的系列' })).toBeVisible();

  await page.getByRole('button', { name: '从片库添加' }).first().click();
  const addDialog = page.getByRole('dialog', { name: '从片库添加' });
  await addDialog.getByText('第一部', { exact: true }).click();
  await addDialog.getByText('第二部', { exact: true }).click();
  await addDialog.getByRole('button', { name: '加入收藏集' }).click();
  await expect(page.getByText('🎬 2 部作品')).toBeVisible();

  await page.getByRole('button', { name: '上移 第二部' }).click();
  const titles = await page.getByRole('main').locator('button').filter({ hasText: /第一部|第二部/ }).allTextContents();
  expect(titles.join('|').indexOf('第二部')).toBeLessThan(titles.join('|').indexOf('第一部'));
  await page.getByRole('button', { name: '从收藏集移除 第二部' }).click();
  await expect(page.getByText('🎬 1 部作品')).toBeVisible();
  expect((await mockSnapshot(page)).records.some(item => item.id === '第二部')).toBe(true);

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('dialog', { name: '系列与收藏集' }).getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByText('创建第一个收藏集')).toBeVisible();
  const snapshot = await mockSnapshot(page);
  expect(snapshot.records.map(item => item.id).sort()).toEqual(['第一部', '第二部']);
  expect(snapshot.collections).toHaveLength(0);
  expect(snapshot.collectionMembers).toHaveLength(0);
});

test('@collections opening is read-only until an explicit action', async ({ page }) => {
  await setupMockIpc(page, { records: [record('只读检查')], collections: [collection] });
  await page.goto('/');
  const before = await mockSnapshot(page);
  await openCenter(page);
  await expect(page.getByRole('heading', { name: '测试系列' })).toBeVisible();
  const after = await mockSnapshot(page);
  const writes = new Set(['create_collection', 'update_collection', 'delete_collection', 'add_collection_members', 'remove_collection_member', 'reorder_collection_members']);
  expect(after.calls.filter(call => writes.has(call.command))).toHaveLength(before.calls.filter(call => writes.has(call.command)).length);
});

test('@collections remains page-safe at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await setupMockIpc(page, {
    records: [record('窄屏电影')],
    collections: [collection],
    collectionMembers: [member('窄屏电影', 0)],
  });
  await page.goto('/');
  await openCenter(page);
  await expect(page.getByRole('heading', { name: '测试系列' })).toBeVisible();
  expect(await page.locator('body').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
  await page.getByRole('button', { name: '返回收藏集' }).click();
  await expect(page.getByPlaceholder('搜索收藏集')).toBeVisible();
});
