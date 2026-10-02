import { expect, test } from '@playwright/test';
import { mockSnapshot, setupMockIpc } from './fixtures/mockIpc';

async function clearRecordedCalls(page: Parameters<typeof mockSnapshot>[0]) {
  await page.evaluate(() => { window.__WATCHTRACKER_TEST__.calls.length = 0; });
}

test('coordinator terminal wins before missing credentials are consulted', async ({ page }) => {
  await setupMockIpc(page, { coordinatorInitialResult: 'readOnlyFrozen' });
  await page.goto('/');
  await clearRecordedCalls(page);

  const result = await page.evaluate(async () => (await import('/src/shared/lib/webdav.ts')).syncToWebDAV());
  expect(result).toMatchObject({ ok: false, error: 's2_read_only_frozen', coordinatorOutcome: 'read-only-frozen' });
  const snapshot = await mockSnapshot(page);
  expect(snapshot.calls.filter(call => call.command === 'run_desktop_sync_coordinator')).toHaveLength(1);
  expect(snapshot.calls.some(call => call.command === 'get_active_sync_connection')).toBe(false);
});

test('normal coordinator terminal wins before a missing-credential legacy callback', async ({ page }) => {
  await setupMockIpc(page, { coordinatorInitialResult: 'pending' });
  await page.goto('/');
  await clearRecordedCalls(page);

  const result = await page.evaluate(async () => (await import('/src/shared/lib/webdav.ts')).syncToWebDAV());
  expect(result).toMatchObject({ ok: false, error: 's2_pending', coordinatorOutcome: 'pending' });
  const snapshot = await mockSnapshot(page);
  expect(snapshot.calls.filter(call => call.command === 'run_desktop_sync_coordinator')).toHaveLength(1);
  expect(snapshot.calls.some(call => call.command === 'get_active_sync_connection')).toBe(false);
});

test('missing credentials are resolved lazily only after Rust requests legacy S1', async ({ page }) => {
  await setupMockIpc(page);
  await page.goto('/');
  await clearRecordedCalls(page);

  const result = await page.evaluate(async () => (await import('/src/shared/lib/webdav.ts')).syncToWebDAV());
  expect(result).toMatchObject({ ok: false, error: '未配置凭据' });
  const snapshot = await mockSnapshot(page);
  expect(snapshot.calls.filter(call => call.command === 'run_desktop_sync_coordinator')).toHaveLength(1);
  expect(snapshot.calls.filter(call => call.command === 'get_active_sync_connection')).toHaveLength(1);
  expect(snapshot.calls.some(call => call.command === 'webdav_request')).toBe(false);
  expect(snapshot.calls.some(call => call.command === 'commit_sync_result')).toBe(false);
});

test('automatic coordinator admission does not require credentials first', async ({ page }) => {
  await setupMockIpc(page, {
    settings: {
      webdav_creds: 'encrypted:user:password',
      webdav_url: 'https://old.example.test/dav/',
    },
    coordinatorInitialResult: 'readOnlyFrozen',
  });
  await page.goto('/');
  await clearRecordedCalls(page);

  await expect.poll(async () => (await mockSnapshot(page)).calls
    .filter(call => call.command === 'run_desktop_sync_coordinator').length, { timeout: 5_000 }).toBeGreaterThan(0);
  const snapshot = await mockSnapshot(page);
  const [coordinatorCall] = snapshot.calls.filter(call => call.command === 'run_desktop_sync_coordinator');
  expect(coordinatorCall.args).toMatchObject({
    completedLegacyRoute: null,
    admission: {
      kind: 'automatic',
      targetId: 'a'.repeat(64),
      targetEpoch: 1,
    },
  });
  expect(snapshot.calls.some(call => call.command === 'get_active_sync_connection')).toBe(false);
});
