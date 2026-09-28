import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebDavTransport } from '../../../features/sync/infrastructure/webdavTransport.ts';
import { syncLegacyS1Cycle } from '../../../features/sync/services/syncService.ts';
import { runDesktopCoordinatorHandoff } from '../../../features/sync/services/desktopCoordinatorService.ts';

const now = new Date('2026-08-22T00:00:00.000Z');

test('legacy webdav facade exports remain available without invoking Tauri on import', async () => {
  const facade = await import('../webdav.ts');
  for (const name of [
    'normalizeSyncTargetUrl', 'saveCreds', 'getCreds', 'clearCreds', 'hasCreds',
    'probeSyncTarget', 'syncToWebDAV', 'loadFromWebDAV', 'importLegacyChangesToConflictCenter',
    'getSyncConflicts', 'clearResolvedSyncConflicts', 'syncFailureMessage',
  ]) assert.equal(typeof facade[name], 'function', name);
  assert.equal(facade.normalizeSyncTargetUrl('https://example.test/dav/?secret=removed'), 'https://example.test/dav/');
});

test('WebDAV transport maps injected command calls without applying sync policy', async () => {
  const calls = [];
  const transport = createWebDavTransport(async (command, args) => {
    calls.push({ command, args });
    return { status: 200, body: null, etag: '"etag"', text: null };
  });

  await transport.request('GET', { username: 'u', password: 'p', url: 'https://example.test/dav/' }, 'proxy', 'records-v3.json');
  await transport.request('GET', { username: 'u', password: 'p', url: 'https://example.test/dav/' }, 'proxy', 'records-v3.json', null, null, null, null, 'bytes=0-0');
  await transport.request('PUT', { username: 'u', targetId: 'target', targetEpoch: 4, url: 'https://example.test/dav/' }, null, 'records-v3.json', '{}', '"old"');

  assert.equal(calls[0].command, 'probe_webdav_request');
  assert.equal(calls[0].args.request.url, 'https://example.test/dav/records-v3.json');
  assert.equal(calls[0].args.request.proxy, 'proxy');
  assert.equal(calls[1].args.request.range, 'bytes=0-0');
  assert.equal(calls[2].command, 'webdav_request');
  assert.equal(calls[2].args.request.targetEpoch, 4);
  assert.equal(calls[2].args.request.ifMatch, '"old"');
});

test('sync service accepts injected transport/database and preserves create CAS flow', async () => {
  const requests = [];
  const intents = [];
  const commits = [];
  const guardedTickets = [];
  const database = {
    getSettingAsync: async () => null,
    getSyncSnapshot: async () => ({
      targetId: null, targetEpoch: null, records: [], tombstones: [], episodeCompletions: [],
      collections: [], collectionMembers: [], collectionTombstones: [], collectionMemberTombstones: [],
      recordsGeneration: 7, baseline: null, deviceId: 'device-a', conflicts: [], remoteEtag: null,
      lastCommit: null, v2SourceFingerprint: null, outbox: {}, scheduler: {}, staging: {}, publishIntent: null,
    }),
    prepareSyncPublishIntent: async (input, legacyRouteTicket) => {
      intents.push(input); guardedTickets.push(legacyRouteTicket); return input;
    },
    setSettingAsync: async () => true,
    commitSyncResult: async (input, legacyRouteTicket) => {
      commits.push(input); guardedTickets.push(legacyRouteTicket); return { recordsGeneration: 8, recordCount: 0 };
    },
  };
  const transport = {
    request: async (method, _creds, _proxy, resource, body, ifMatch, ifNoneMatch) => {
      requests.push({ method, resource, body, ifMatch, ifNoneMatch });
      if (method === 'MKCOL') return { status: 405, body: null, etag: null, text: null };
      if (method === 'GET' && resource === 'records-v3.json') return { status: 404, body: null, etag: null, text: null };
      if (method === 'GET' && resource === 'records.json') return { status: 404, body: null, etag: null, text: null };
      if (method === 'PUT') return { status: 201, body: null, etag: '"created"', text: null };
      throw new Error(`unexpected request ${method} ${resource}`);
    },
  };

  const ticket = { targetId: 'target-a', targetEpoch: 7, physicalRootId: 'root-a', rootSafetyGeneration: 3 };
  const result = await syncLegacyS1Cycle(
    { username: 'u', password: 'p', url: 'https://example.test/dav/' },
    ticket,
    undefined,
    { transport, database, now: () => now, uuid: () => 'commit-fixed', confirm: () => true },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(requests.map(item => `${item.method}:${item.resource}`), [
    'MKCOL:records-v3.json', 'GET:records-v3.json', 'GET:records.json', 'PUT:records-v3.json',
  ]);
  assert.equal(intents[0].commitId, 'commit-fixed');
  assert.equal(commits[0].remoteEtag, '"created"');
  assert.equal(commits[0].lastCommit.commitId, 'commit-fixed');
  assert.deepEqual(guardedTickets, [ticket, ticket]);
});

test('desktop coordinator carries one opaque legacy ticket through S1 then reroutes', async () => {
  const ticket = { targetId: 'target-a', targetEpoch: 7, physicalRootId: 'root-a', rootSafetyGeneration: 3 };
  const coordinatorCalls = [];
  const legacyTickets = [];
  const result = await runDesktopCoordinatorHandoff({
    runCoordinator: async completed => {
      coordinatorCalls.push(completed);
      return completed === null ? { kind: 'legacyS1Required', ticket } : { kind: 'success' };
    },
    runLegacyS1Cycle: async received => {
      legacyTickets.push(received);
      return { ok: true };
    },
  });

  assert.deepEqual(legacyTickets, [ticket]);
  assert.deepEqual(coordinatorCalls, [null, ticket]);
  assert.equal(result.ok, true);
  assert.equal(result.coordinatorOutcome, 'success');
  assert.equal(result.reloadRecords, true);
});

test('desktop coordinator reloads after a successful legacy commit when post-commit classification rejects', async () => {
  const ticket = { targetId: 'target-a', targetEpoch: 7, physicalRootId: 'root-a', rootSafetyGeneration: 3 };
  let coordinatorCalls = 0;
  let legacyCalls = 0;
  const result = await runDesktopCoordinatorHandoff({
    runCoordinator: async completed => {
      coordinatorCalls += 1;
      if (completed === null) return { kind: 'legacyS1Required', ticket };
      throw new Error('durable coordinator failure');
    },
    runLegacyS1Cycle: async received => {
      legacyCalls += 1;
      assert.equal(received, ticket);
      return { ok: true };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.coordinatorOutcome, 'internal-failure');
  assert.equal(result.error, 's2_internal_failure');
  assert.equal(result.reloadRecords, true);
  assert.equal(legacyCalls, 1);
  assert.equal(coordinatorCalls, 2);
});

test('desktop coordinator preserves Rust terminals and never invokes S1 without LegacyS1Required', async () => {
  for (const [kind, expected] of [
    ['pending', 'pending'],
    ['remoteIndeterminate', 'remote-indeterminate'],
    ['remoteAuthOrCapabilityBlocked', 'remote-auth-or-capability-blocked'],
    ['conflicts', 'conflicts'],
    ['targetChanged', 'target-changed'],
    ['readOnlyFrozen', 'read-only-frozen'],
    ['internalFailure', 'internal-failure'],
  ]) {
    let legacyCalls = 0;
    const result = await runDesktopCoordinatorHandoff({
      runCoordinator: async () => ({ kind }),
      runLegacyS1Cycle: async () => { legacyCalls += 1; return { ok: true }; },
    });
    assert.equal(result.coordinatorOutcome, expected, kind);
    assert.equal(legacyCalls, 0, kind);
  }
});

test('stale guarded legacy completion follows Rust TargetChanged without a frontend retry', async () => {
  const ticket = { targetId: 'target-a', targetEpoch: 7, physicalRootId: 'root-a', rootSafetyGeneration: 3 };
  let legacyCalls = 0;
  const result = await runDesktopCoordinatorHandoff({
    runCoordinator: async completed => completed === null
      ? { kind: 'legacyS1Required', ticket }
      : { kind: 'targetChanged' },
    runLegacyS1Cycle: async received => {
      legacyCalls += 1;
      assert.equal(received, ticket);
      return { ok: true };
    },
  });
  assert.equal(legacyCalls, 1);
  assert.equal(result.coordinatorOutcome, 'target-changed');
  assert.equal(result.reloadRecords, true);
});

test('guarded legacy completion rejection is classified by Rust without a frontend legacy retry', async () => {
  const ticket = { targetId: 'target-a', targetEpoch: 7, physicalRootId: 'root-a', rootSafetyGeneration: 3 };
  let coordinatorCalls = 0;
  const result = await runDesktopCoordinatorHandoff({
    runCoordinator: async completed => {
      coordinatorCalls += 1;
      return completed === null ? { kind: 'legacyS1Required', ticket } : { kind: 'readOnlyFrozen' };
    },
    runLegacyS1Cycle: async () => ({ ok: false, error: 's2_legacy_route_root_frozen' }),
  });
  assert.equal(coordinatorCalls, 2);
  assert.equal(result.coordinatorOutcome, 'read-only-frozen');
});

test('activation during a guarded S1 cycle reroutes once without reusing its ticket', async () => {
  const ticket = { targetId: 'target-a', targetEpoch: 7, physicalRootId: 'root-a', rootSafetyGeneration: 3 };
  let legacyCalls = 0;
  const result = await runDesktopCoordinatorHandoff({
    runCoordinator: async completed => completed === null
      ? { kind: 'legacyS1Required', ticket }
      : { kind: 'pending' },
    runLegacyS1Cycle: async () => {
      legacyCalls += 1;
      return { ok: false, error: 's2_legacy_route_not_admitted' };
    },
  });
  assert.equal(legacyCalls, 1);
  assert.equal(result.coordinatorOutcome, 'pending');
});

test('a fresh LegacyS1Required result is deferred to a later invocation', async () => {
  const ticket = { targetId: 'target-a', targetEpoch: 7, physicalRootId: 'root-a', rootSafetyGeneration: 3 };
  let legacyCalls = 0;
  const result = await runDesktopCoordinatorHandoff({
    runCoordinator: async () => ({ kind: 'legacyS1Required', ticket }),
    runLegacyS1Cycle: async () => { legacyCalls += 1; return { ok: true }; },
  });
  assert.equal(legacyCalls, 1);
  assert.equal(result.coordinatorOutcome, 'legacy-s1-required');
});
