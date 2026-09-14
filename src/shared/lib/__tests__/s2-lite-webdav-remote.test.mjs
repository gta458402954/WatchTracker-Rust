import assert from 'node:assert/strict';
import test from 'node:test';

import { createS2WebDavRemote, mapDiscoveryGetResult } from '../../../features/sync/s2lite/webdavRemote.ts';

function fake(overrides = {}) {
  return {
    physicalRootId: 's2-root-v1:test',
    async get() { return { kind: 'indeterminate' }; },
    async put() { return { kind: 'indeterminate' }; },
    async propfindDepthOne() { return { kind: 'indeterminate' }; },
    ...overrides,
  };
}

test('WebDAV mapper preserves exact GET bytes and makes PUT success transport-only', async () => {
  const raw = new Uint8Array([0, 255, 128, 123, 0, 13]);
  let putBytes;
  let defense;
  const remote = createS2WebDavRemote(fake({
    async get() { return { kind: 'present', bytes: raw }; },
    async put(_path, bytes, suppliedDefense) {
      putBytes = bytes;
      defense = suppliedDefense;
      return { kind: 'put-success' };
    },
  }));
  const got = await remote.getExact('activations/a.json');
  assert.deepEqual(got, { state: 'DefinitelyPresent', bytes: raw });
  const put = await remote.putExact('activations/a.json', raw, { ifNoneMatchStar: true });
  assert.deepEqual(put, { state: 'Success' });
  assert.deepEqual(putBytes, raw);
  assert.deepEqual(defense, { ifNoneMatchStar: true });
  assert.equal('receipt' in put, false, 'transport success cannot create a publication receipt');
});

test('WebDAV mapper retains conservative result taxonomy for immutable and discovery reads', async () => {
  for (const [wire, state] of [
    [{ kind: 'absent' }, 'DefinitelyAbsent'],
    [{ kind: 'auth' }, 'AuthOrCapabilityFailure'],
    [{ kind: 'indeterminate' }, 'Indeterminate'],
  ]) {
    const remote = createS2WebDavRemote(fake({ async get() { return wire; } }));
    assert.equal((await remote.getExact('writers/a/x.json')).state, state);
    assert.equal(mapDiscoveryGetResult(wire).state, state);
  }
  const listed = createS2WebDavRemote(fake({
    async propfindDepthOne() { return { kind: 'entries', entries: ['b', 'a', 'a'] }; },
  }));
  assert.deepEqual(await listed.listDirectory('writers'), { state: 'Entries', entries: ['a', 'b'] });
});

test('invalid wire variants and transport programming errors propagate', async () => {
  const invalid = createS2WebDavRemote(fake({ async get() { return { kind: 'put-success' }; } }));
  await assert.rejects(invalid.getExact('x'), /invalid WebDAV GET result/);
  const failed = createS2WebDavRemote(fake({ async put() { throw new Error('socket bug'); } }));
  await assert.rejects(failed.putExact('x', new Uint8Array(), { ifNoneMatchStar: true }), /socket bug/);
});
