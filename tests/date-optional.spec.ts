import { expect, test, type Page } from '@playwright/test';
import type { WatchRecord } from '../src/shared/types';
import { mockSnapshot, setupMockIpc } from './fixtures/mockIpc';

function record(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    id: 'date-record',
    originalName: 'Date Record',
    chineseName: '日期测试记录',
    progress: '',
    totalEpisodes: null,
    episodeTrackingEnabled: false,
    nextEpisode: null,
    movieProgress: null,
    movieDuration: null,
    releaseYear: '2026',
    posterPath: null,
    status: '未看',
    platform: '',
    rating: null,
    startDate: '',
    endDate: '',
    notes: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    imdbId: null,
    mediaType: '电影',
    contentTags: null,
    originCountry: null,
    ...overrides,
  };
}

async function openAddForm(page: Page) {
  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: /添加记录/ }).click();
  return page.getByRole('dialog', { name: '添加新记录' });
}

async function addRecordWithStatus(page: Page, chineseName: string, status: '在看' | '已看') {
  const dialog = await openAddForm(page);
  await dialog.getByPlaceholder('请输入中文名称').fill(chineseName);
  await dialog.getByPlaceholder('英文 / 原名').fill(`${chineseName} Original`);
  await dialog.getByRole('combobox').nth(1).selectOption({ label: status });
  await expect(dialog.locator('input[type="date"]').nth(0)).toHaveValue('');
  await expect(dialog.locator('input[type="date"]').nth(1)).toHaveValue('');
  await dialog.getByRole('button', { name: '添加记录' }).click();
  await expect(page.getByText(chineseName, { exact: true })).toBeVisible();
}

function recordCard(page: Page, chineseName: string) {
  return page.locator('div.relative.flex.flex-col').filter({ hasText: chineseName }).first();
}

test('@date-optional new and edited records send empty dates while explicit dates remain intact', async ({ page }) => {
  await setupMockIpc(page, {
    records: [record({
      id: 'edit-clear-dates',
      chineseName: '编辑清空日期',
      status: '已看',
      startDate: '2026-08-10',
      endDate: '2026-08-20',
    })],
  });
  await page.goto('/');

  await addRecordWithStatus(page, '新建在看空日期', '在看');
  await addRecordWithStatus(page, '新建已看空日期', '已看');

  let snapshot = await mockSnapshot(page);
  for (const [chineseName, status] of [
    ['新建在看空日期', '在看'],
    ['新建已看空日期', '已看'],
  ] as const) {
    const insert = snapshot.calls.find(call =>
      call.command === 'insert_record'
      && (call.args.r as WatchRecord).chineseName === chineseName,
    );
    expect(insert?.args.r).toMatchObject({ chineseName, status, startDate: '', endDate: '' });
    expect(snapshot.records.find(item => item.chineseName === chineseName)).toMatchObject({
      status,
      startDate: '',
      endDate: '',
    });
  }

  await recordCard(page, '编辑清空日期').getByRole('button', { name: '编辑' }).click();
  const clearDialog = page.getByRole('dialog', { name: '编辑记录' });
  await expect(clearDialog.locator('input[type="date"]').nth(0)).toHaveValue('2026-08-10');
  await expect(clearDialog.locator('input[type="date"]').nth(1)).toHaveValue('2026-08-20');
  await clearDialog.locator('input[type="date"]').nth(0).fill('');
  await clearDialog.locator('input[type="date"]').nth(1).fill('');
  await clearDialog.getByRole('button', { name: '保存修改' }).click();

  snapshot = await mockSnapshot(page);
  const clearUpdate = snapshot.calls.find(call =>
    call.command === 'update_record' && call.args.id === 'edit-clear-dates',
  );
  // Empty strings must cross IPC so Rust can normalize them to SQL NULL.
  expect(clearUpdate?.args.updates).toMatchObject({ startDate: '', endDate: '' });
  expect(snapshot.records.find(item => item.id === 'edit-clear-dates')).toMatchObject({
    startDate: '',
    endDate: '',
  });

  await recordCard(page, '新建在看空日期').getByRole('button', { name: '编辑' }).click();
  const explicitDialog = page.getByRole('dialog', { name: '编辑记录' });
  await explicitDialog.locator('input[type="date"]').nth(0).fill('2026-08-11');
  await explicitDialog.locator('input[type="date"]').nth(1).fill('2026-08-12');
  await explicitDialog.getByRole('button', { name: '保存修改' }).click();

  snapshot = await mockSnapshot(page);
  const explicitRecord = snapshot.records.find(item => item.chineseName === '新建在看空日期');
  const explicitUpdate = snapshot.calls.find(call =>
    call.command === 'update_record' && call.args.id === explicitRecord?.id,
  );
  expect(explicitUpdate?.args.updates).toMatchObject({
    startDate: '2026-08-11',
    endDate: '2026-08-12',
  });
  expect(explicitRecord).toMatchObject({ startDate: '2026-08-11', endDate: '2026-08-12' });
});

test('@date-optional quick status changes never synthesize or replace dates and still complete progress', async ({ page }) => {
  const movie = record({ id: 'quick-movie', chineseName: '快捷电影', movieDuration: 5400 });
  const series = record({
    id: 'quick-series',
    chineseName: '快捷剧集',
    mediaType: '剧集',
    totalEpisodes: 8,
    progress: '第2集',
  });
  const watchingEmpty = record({ id: 'quick-watching-empty', chineseName: '快捷在看空日期' });
  const watchingDated = record({
    id: 'quick-watching-dated',
    chineseName: '快捷在看已有日期',
    startDate: '2026-07-01',
    endDate: '2026-07-02',
  });
  const watchedDated = record({
    id: 'quick-watched-dated',
    chineseName: '快捷已看已有日期',
    movieDuration: 3600,
    startDate: '2026-06-01',
    endDate: '2026-06-02',
  });
  await setupMockIpc(page, { records: [movie, series, watchingEmpty, watchingDated, watchedDated] });
  await page.goto('/');

  for (const chineseName of ['快捷电影', '快捷剧集', '快捷已看已有日期']) {
    const card = recordCard(page, chineseName);
    await card.getByRole('combobox').first().selectOption({ label: '已看' });
    await expect(card.getByRole('combobox').first()).toHaveValue('已看');
  }
  for (const chineseName of ['快捷在看空日期', '快捷在看已有日期']) {
    const card = recordCard(page, chineseName);
    await card.getByRole('combobox').first().selectOption({ label: '在看' });
    await expect(card.getByRole('combobox').first()).toHaveValue('在看');
  }

  const snapshot = await mockSnapshot(page);
  expect(snapshot.records.find(item => item.id === 'quick-movie')).toMatchObject({
    status: '已看', movieProgress: 5400, startDate: '', endDate: '',
  });
  expect(snapshot.records.find(item => item.id === 'quick-series')).toMatchObject({
    status: '已看', progress: '第8集', startDate: '', endDate: '',
  });
  expect(snapshot.records.find(item => item.id === 'quick-watching-empty')).toMatchObject({
    status: '在看', startDate: '', endDate: '',
  });
  expect(snapshot.records.find(item => item.id === 'quick-watching-dated')).toMatchObject({
    status: '在看', startDate: '2026-07-01', endDate: '2026-07-02',
  });
  expect(snapshot.records.find(item => item.id === 'quick-watched-dated')).toMatchObject({
    status: '已看', movieProgress: 3600, startDate: '2026-06-01', endDate: '2026-06-02',
  });

  const updates = snapshot.calls.filter(call => call.command === 'update_record');
  const updatesById = new Map(updates.map(call => [call.args.id, call.args.updates]));
  expect(updatesById.get('quick-movie')).toEqual({ status: '已看', movieProgress: 5400 });
  expect(updatesById.get('quick-series')).toEqual({ status: '已看', progress: '第8集' });
  expect(updatesById.get('quick-watching-empty')).toEqual({ status: '在看' });
  expect(updatesById.get('quick-watching-dated')).toEqual({ status: '在看' });
  expect(updatesById.get('quick-watched-dated')).toEqual({ status: '已看', movieProgress: 3600 });
});
