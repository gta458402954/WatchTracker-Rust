import { expect, test, type Page } from '@playwright/test';
import type { WatchRecord } from '../src/shared/types';
import { mockSnapshot, setupMockIpc } from './fixtures/mockIpc';

function record(id: string, overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    id,
    originalName: `${id} original`,
    chineseName: id,
    progress: '',
    totalEpisodes: null,
    movieProgress: null,
    movieDuration: null,
    releaseYear: '2025',
    posterPath: null,
    status: '未看',
    platform: '',
    rating: null,
    startDate: '',
    endDate: '',
    notes: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    imdbId: null,
    mediaType: '电影',
    contentTags: null,
    originCountry: null,
    ...overrides,
  };
}

async function openSettingsTools(page: Page) {
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: /系统工具/ }).click();
}

test('@expected-settings-modal batch metadata preserves custom tags and normalized countries', async ({ page }) => {
  const original = record('批量补全记录', {
    imdbId: 'tt-b003-settings',
    contentTags: '美国,律政,自定义',
  });
  await setupMockIpc(page, {
    records: [original],
    settings: { tmdb_api_key: 'encrypted:test-key' },
    tmdbSearchResults: [{ id: 301, title: '批量补全结果', media_type: 'movie' }],
    tmdbDetail: {
      id: 301,
      title: '批量补全结果',
      production_countries: [
        { iso_3166_1: ' uk ' }, { iso_3166_1: 'GB' }, { iso_3166_1: 'xx' }, { iso_3166_1: 'N/A' },
      ],
      genres: [{ name: 'Drama' }],
      runtime: 120,
    },
  });
  await page.goto('/');
  await openSettingsTools(page);

  const batchButton = page.getByRole('button', { name: /立即一键补全缺失字段/ });
  await expect(batchButton).toBeEnabled();
  page.once('dialog', dialog => dialog.accept());
  await batchButton.click();
  await expect(page.getByText('🎉 同步完成！成功: 1, 失败: 0')).toBeVisible();

  const snapshot = await mockSnapshot(page);
  const update = snapshot.calls.find(call => call.command === 'update_record');
  expect(update?.args.id).toBe(original.id);
  expect(update?.args.updates).toMatchObject({
    originCountry: 'GB, XX',
    contentTags: '律政,自定义,英国',
  });
});

test('@conditional-record-form new movie preserves all normalized countries and custom tags', async ({ page }) => {
  await setupMockIpc(page, {
    settings: { tmdb_api_key: 'encrypted:test-key' },
    tmdbSearchResults: [{ id: 401, title: '电影候选', media_type: 'movie' }],
    tmdbDetail: {
      id: 401,
      title: '电影候选',
      original_title: 'Movie Candidate',
      production_countries: [
        { iso_3166_1: 'us' }, { iso_3166_1: ' UK ' }, { iso_3166_1: 'xx' },
      ],
      genres: [{ name: 'Drama' }],
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByPlaceholder('请输入中文名称').fill('电影候选');
  await page.getByPlaceholder('如：韩国').fill('美国,律政,自定义');
  await page.getByRole('button', { name: /自动填充/ }).click();
  await page.getByRole('button', { name: /电影候选/ }).click();
  await page.getByRole('button', { name: '添加记录' }).click();

  const snapshot = await mockSnapshot(page);
  const inserted = snapshot.calls.find(call => call.command === 'insert_record')?.args.r as WatchRecord;
  expect(inserted.originCountry).toBe('US, GB, XX');
  expect(inserted.contentTags).toBe('律政,自定义,美国,英国');
});

test('@conditional-record-form edited TV season preserves countries and custom tags', async ({ page }) => {
  await setupMockIpc(page, {
    records: [record('旧剧集', {
      imdbId: 'tt-b003-series',
      mediaType: '剧集',
      totalEpisodes: 8,
      contentTags: '美国,悬疑,自定义',
    })],
    settings: { tmdb_api_key: 'encrypted:test-key' },
    tmdbSearchResults: [{ id: 501, name: '剧集候选', media_type: 'tv' }],
    tmdbDetail: {
      id: 501,
      name: '剧集候选',
      original_name: 'Series Candidate',
      origin_country: [' hk ', 'TW', 'uk', 'HK'],
      genres: [{ name: 'Drama' }],
      seasons: [{ id: 510, name: '第一季', season_number: 1, episode_count: 10 }],
    },
  });
  await page.goto('/');
  await page.getByTitle('编辑').click();
  await page.getByRole('button', { name: /自动填充/ }).click();
  await page.getByRole('button', { name: /剧集候选/ }).click();
  await page.getByRole('button', { name: /第一季/ }).click();
  await page.getByRole('button', { name: '保存修改' }).click();

  const snapshot = await mockSnapshot(page);
  const update = snapshot.calls.find(call => call.command === 'update_record');
  expect(update?.args.updates).toMatchObject({
    originCountry: 'HK, TW, GB',
    contentTags: '悬疑,自定义,中国香港,中国台湾,英国',
  });
});

test('@conditional-webdav-payload schema v2 merge and PUT preserve region fields', async ({ page }) => {
  const local = record('shared', {
    originCountry: 'GB, XX',
    contentTags: '律政,自定义',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
  const remote = record('remote-only', {
    originCountry: 'CN, HK, TW',
    contentTags: '历史,自定义',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await setupMockIpc(page, {
    settings: {
      webdav_creds: 'encrypted:fixture-user:fixture-password',
      webdav_url: 'https://mock.invalid/dav/',
    },
    webdavRemote: { schemaVersion: 2, updatedAt: '', records: [remote], tombstones: [] },
  });
  await page.goto('/');

  const result = await page.evaluate(async (records) => {
    const { syncToWebDAV } = await import('/src/shared/lib/webdav.ts');
    return syncToWebDAV(records);
  }, [local]);
  expect(result.ok).toBe(true);

  const snapshot = await mockSnapshot(page);
  const put = snapshot.calls.find(call => call.command === 'webdav_request' && call.args.method === 'PUT');
  const payload = JSON.parse(String(put?.args.body));
  expect(payload.records).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'shared', originCountry: 'GB, XX', contentTags: '律政,自定义' }),
    expect.objectContaining({ id: 'remote-only', originCountry: 'CN, HK, TW', contentTags: '历史,自定义' }),
  ]));
});

test('@conditional-webdav-payload legacy array GET preserves region fields', async ({ page }) => {
  const remote = record('legacy-remote', {
    originCountry: 'US, GB',
    contentTags: '旧标签,自定义',
  });
  await setupMockIpc(page, {
    settings: {
      webdav_creds: 'encrypted:fixture-user:fixture-password',
      webdav_url: 'https://mock.invalid/dav/',
    },
    webdavRemote: [remote],
  });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { loadFromWebDAV } = await import('/src/shared/lib/webdav.ts');
    return loadFromWebDAV();
  });
  expect(result.data?.[0]).toMatchObject({ originCountry: 'US, GB', contentTags: '旧标签,自定义' });
});

test('@conditional-watchlist-boundary local export and import preserve region fields', async ({ page }) => {
  const original = record('本地往返', {
    originCountry: 'GB, XX, CN',
    contentTags: '律政,自定义,日本料理',
  });
  await setupMockIpc(page, { records: [original] });
  await page.goto('/');
  await openSettingsTools(page);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出备份 JSON/ }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /导入本地 JSON/ }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path!);
  await expect(page.getByText('已导入 1 条本地记录。')).toBeVisible();

  const snapshot = await mockSnapshot(page);
  const replacement = snapshot.calls.find(call => call.command === 'replace_all_records');
  expect(replacement?.args.records).toEqual([
    expect.objectContaining({ originCountry: 'GB, XX, CN', contentTags: '律政,自定义,日本料理' }),
  ]);
});

test('@conditional-watchlist-boundary sync replacement preserves region fields', async ({ page }) => {
  const local = record('shared', { chineseName: '本地旧版本' });
  const remote = record('shared', {
    chineseName: '云端新版本',
    originCountry: 'HK, TW, GB',
    contentTags: '悬疑,自定义',
    updatedAt: '2026-02-01T00:00:00.000Z',
  });
  await setupMockIpc(page, {
    records: [local],
    settings: {
      webdav_creds: 'encrypted:fixture-user:fixture-password',
      webdav_url: 'https://mock.invalid/dav/',
    },
    webdavRemote: { schemaVersion: 2, updatedAt: '', records: [remote], tombstones: [] },
  });
  await page.goto('/');
  await page.getByTitle('手动同步到坚果云').click();
  await expect(page.getByText('云端新版本', { exact: true })).toBeVisible();

  const snapshot = await mockSnapshot(page);
  expect(snapshot.records[0]).toMatchObject({
    originCountry: 'HK, TW, GB',
    contentTags: '悬疑,自定义',
  });
});

test('@conditional-watchlist-boundary conflict restore preserves region fields and clears history', async ({ page }) => {
  const current = record('conflict-record', {
    chineseName: '当前保留版本',
    originCountry: 'CN',
    contentTags: '当前标签',
    updatedAt: '2026-03-02T00:00:00.000Z',
  });
  const discarded = record('conflict-record', {
    chineseName: '被覆盖版本',
    originCountry: 'HK, TW, GB',
    contentTags: '悬疑,自定义',
    updatedAt: '2026-03-01T00:00:00.000Z',
  });
  const conflict = {
    id: current.id,
    kept: 'local',
    at: '2026-03-03T00:00:00.000Z',
    discarded,
  };
  await setupMockIpc(page, {
    records: [current],
    settings: {
      sync_conflict_history_version: '2',
      sync_conflicts: JSON.stringify([conflict]),
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: /云端同步/ }).click();

  await expect(page.getByText('被覆盖版本', { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '恢复此版本' }).click();
  await expect(page.getByRole('status').filter({ hasText: '冲突记录已恢复。' })).toBeVisible();
  await expect(page.getByText('暂无同步冲突记录')).toBeVisible();

  const snapshot = await mockSnapshot(page);
  const insert = snapshot.calls.find(call => call.command === 'insert_record');
  expect(insert?.args.r).toMatchObject({
    id: current.id,
    chineseName: '被覆盖版本',
    originCountry: 'HK, TW, GB',
    contentTags: '悬疑,自定义',
  });
  expect(snapshot.records).toHaveLength(1);
  expect(snapshot.records[0]).toMatchObject({
    id: current.id,
    chineseName: '被覆盖版本',
    originCountry: 'HK, TW, GB',
    contentTags: '悬疑,自定义',
  });
  expect(snapshot.settings.sync_conflicts).toBe('[]');
});
