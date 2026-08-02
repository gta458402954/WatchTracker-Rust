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

test('@expected-settings-modal batch metadata previews and only fills missing movie fields', async ({ page }) => {
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

  const batchButton = page.getByRole('button', { name: /分析并预览缺失字段/ });
  await expect(batchButton).toBeEnabled();
  await batchButton.click();

  const preview = page.getByLabel('元数据补全预览');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('题材、国家、电影时长');
  expect((await mockSnapshot(page)).calls.filter(call => call.command === 'update_record')).toHaveLength(0);

  await preview.getByRole('button', { name: '确认写入 1 条' }).click();
  await expect(page.getByText('补全结束：已更新 1 条，跳过 0 条，失败 0 条。')).toBeVisible();
  await expect(page.getByLabel('元数据补全结果')).toContainText('已更新');

  const snapshot = await mockSnapshot(page);
  const update = snapshot.calls.find(call => call.command === 'update_record');
  expect(update?.args.id).toBe(original.id);
  expect(update?.args.updates).toMatchObject({
    originCountry: 'GB, XX',
    genres: 'Drama',
    movieDuration: 7200,
  });
  expect(update?.args.updates).not.toHaveProperty('contentTags');
  expect(update?.args.updates).not.toHaveProperty('mediaType');
  expect(update?.args.updates).not.toHaveProperty('episodeRuntime');
  expect(snapshot.records[0].contentTags).toBe('美国,律政,自定义');
});

test('@expected-settings-modal shared IMDb seasons keep distinct episode totals', async ({ page }) => {
  const first = record('第一季', {
    originalName: 'Example Season 1', imdbId: 'tt-shared-series', mediaType: '剧集', contentTags: '自定义',
  });
  const second = record('第二季', {
    originalName: 'Example Season 2', imdbId: 'tt-shared-series', mediaType: '剧集', contentTags: '自定义',
  });
  await setupMockIpc(page, {
    records: [first, second],
    settings: { tmdb_api_key: 'encrypted:test-key' },
    tmdbSearchResults: [{ id: 510, name: 'Example', media_type: 'tv' }],
    tmdbDetail: {
      id: 510, name: 'Example', origin_country: ['US'], genres: [{ name: 'Drama' }],
      episode_run_time: [48], number_of_episodes: 23,
      seasons: [{ season_number: 1, episode_count: 10 }, { season_number: 2, episode_count: 13 }],
    },
  });
  await page.goto('/');
  await openSettingsTools(page);

  await page.getByRole('button', { name: /分析并预览缺失字段/ }).click();
  const preview = page.getByLabel('元数据补全预览');
  await expect(preview).toContainText('tv:510:season-1');
  await expect(preview).toContainText('tv:510:season-2');
  await preview.getByRole('button', { name: '确认写入 2 条' }).click();
  await expect(page.getByText('补全结束：已更新 2 条，跳过 0 条，失败 0 条。')).toBeVisible();

  const updates = (await mockSnapshot(page)).calls
    .filter(call => call.command === 'update_record')
    .map(call => ({ id: call.args.id, updates: call.args.updates }));
  expect(updates).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.id, updates: expect.objectContaining({ totalEpisodes: 10, episodeRuntime: 48 }) }),
    expect.objectContaining({ id: second.id, updates: expect.objectContaining({ totalEpisodes: 13, episodeRuntime: 48 }) }),
  ]));
});

test('@expected-settings-modal partial write failure is visible and retryable', async ({ page }) => {
  const first = record('成功记录', { imdbId: 'tt-success' });
  const second = record('重试记录', { imdbId: 'tt-retry' });
  await setupMockIpc(page, {
    records: [first, second],
    settings: { tmdb_api_key: 'encrypted:test-key' },
    tmdbSearchResults: [{ id: 301, title: 'Movie', media_type: 'movie' }],
    tmdbDetail: { id: 301, runtime: 100, genres: [{ name: 'Drama' }], production_countries: [{ iso_3166_1: 'US' }] },
    updateFailureCounts: { [second.id]: 1 },
  });
  await page.goto('/');
  await openSettingsTools(page);

  await page.getByRole('button', { name: /分析并预览缺失字段/ }).click();
  await page.getByRole('button', { name: '确认写入 2 条' }).click();
  await expect(page.getByText('补全结束：已更新 1 条，跳过 0 条，失败 1 条。')).toBeVisible();

  await page.getByRole('button', { name: '重试失败项' }).click();
  await expect(page.getByText('补全结束：已更新 2 条，跳过 0 条，失败 0 条。')).toBeVisible();
  const retryWrites = (await mockSnapshot(page)).calls.filter(call => call.command === 'update_record' && call.args.id === second.id);
  expect(retryWrites).toHaveLength(2);
});

test('@expected-settings-modal planning can be cancelled without database writes', async ({ page }) => {
  await setupMockIpc(page, {
    records: [record('慢速记录一', { imdbId: 'tt-slow-1' }), record('慢速记录二', { imdbId: 'tt-slow-2' })],
    settings: { tmdb_api_key: 'encrypted:test-key' },
    tmdbSearchResults: [{ id: 301, title: 'Movie', media_type: 'movie' }],
    tmdbDetail: { id: 301, runtime: 100 },
    tmdbDelayMs: 400,
  });
  await page.goto('/');
  await openSettingsTools(page);

  await page.getByRole('button', { name: /分析并预览缺失字段/ }).click();
  await page.getByRole('button', { name: '安全停止', exact: true }).click();
  await expect(page.getByText(/分析已取消/)).toBeVisible();
  expect((await mockSnapshot(page)).calls.filter(call => call.command === 'update_record')).toHaveLength(0);
});

test('@expected-settings-modal successful write uses the normal action and schedules auto sync', async ({ page }) => {
  await setupMockIpc(page, {
    records: [record('自动同步记录', { imdbId: 'tt-auto-sync' })],
    settings: {
      tmdb_api_key: 'encrypted:test-key',
      sync_interval: '5',
      webdav_creds: 'encrypted:user:password',
      webdav_url: 'https://dav.example.test/watchtracker/',
    },
    tmdbSearchResults: [{ id: 301, title: 'Movie', media_type: 'movie' }],
    tmdbDetail: { id: 301, runtime: 100, genres: [{ name: 'Drama' }] },
    webdavRemote: [],
  });
  await page.goto('/');
  await openSettingsTools(page);

  await page.getByRole('button', { name: /分析并预览缺失字段/ }).click();
  await page.getByRole('button', { name: '确认写入 1 条' }).click();
  await expect(page.getByText('补全结束：已更新 1 条，跳过 0 条，失败 0 条。')).toBeVisible();

  await expect.poll(async () => (await mockSnapshot(page)).calls.some(call => call.command === 'webdav_request'), {
    timeout: 8000,
  }).toBe(true);
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
