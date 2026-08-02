import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mergeSyncStates, parseSyncPayloadV3 } from '../syncMerge.ts';

const now = '2026-08-02T00:00:00.000Z';
function record(id, fields = {}) {
  return {
    id, originalName: '', chineseName: id, progress: '', status: '未看', platform: '',
    startDate: '', endDate: '', notes: '', createdAt: '2026-01-01T00:00:00Z',
    mediaType: '电影', rev: 1, revActor: 'base', ...fields,
  };
}
const side = (records = [], tombstones = []) => ({ records, tombstones });

describe('TASK-D-SYNC-001 three-way merge', () => {
  test('automatically merges different fields without using wall-clock order', () => {
    const base = record('same', { notes: 'base', platform: '' });
    const local = record('same', { notes: 'local', platform: '', updatedAt: '2020-01-01T00:00:00Z' });
    const remote = record('same', { notes: 'base', platform: 'Netflix', updatedAt: '2030-01-01T00:00:00Z' });
    const result = mergeSyncStates(side([base]), side([local]), side([remote]), 'device-a', now);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.local.records[0].notes, 'local');
    assert.equal(result.local.records[0].platform, 'Netflix');
    assert.equal(result.local.records[0].revActor, 'device-a');
  });

  test('same-field divergence stays split and requires a user choice', () => {
    const base = record('same', { notes: 'base' });
    const local = record('same', { notes: 'local' });
    const remote = record('same', { notes: 'remote' });
    const result = mergeSyncStates(side([base]), side([local]), side([remote]), 'device-a', now);
    assert.deepEqual(result.conflicts[0].fields, ['notes']);
    assert.equal(result.local.records[0].notes, 'local');
    assert.equal(result.remote.records[0].notes, 'remote');
  });

  test('one-sided deletion propagates but delete-edit becomes a conflict', () => {
    const base = record('same');
    const tombstone = { id: 'same', deletedAt: now, rev: 2, revActor: 'device-a' };
    const deleted = mergeSyncStates(side([base]), side([], [tombstone]), side([base]), 'device-a', now);
    assert.equal(deleted.local.records.length, 0);
    assert.equal(deleted.remote.tombstones[0].id, 'same');

    const edited = mergeSyncStates(
      side([base]), side([], [tombstone]), side([record('same', { notes: 'remote edit' })]), 'device-a', now,
    );
    assert.equal(edited.conflicts[0].kind, 'delete-edit');
    assert.equal(edited.local.tombstones[0].id, 'same');
    assert.equal(edited.remote.records[0].notes, 'remote edit');
  });

  test('locked local records are never overwritten or force-published', () => {
    const base = record('same');
    const local = record('same', { isLocked: true, notes: 'local' });
    const remote = record('same', { notes: 'remote' });
    const result = mergeSyncStates(side([base]), side([local]), side([remote]), 'device-a', now);
    assert.equal(result.conflicts[0].kind, 'locked');
    assert.equal(result.local.records[0].notes, 'local');
    assert.equal(result.remote.records[0].notes, 'remote');
  });

  test('unknown future schema is rejected instead of parsed as empty data', () => {
    assert.throws(() => parseSyncPayloadV3({ schemaVersion: 4, records: [], tombstones: [] }), /unsupported_remote_schema/);
  });

  test('malformed v3 metadata and tombstones are rejected before merge', () => {
    assert.throws(() => parseSyncPayloadV3({
      schemaVersion: 3, documentId: 'doc', revision: -1, commitId: 'c', parentCommitId: null,
      writerId: 'writer', committedAt: now, records: [], tombstones: [],
    }), /invalid_remote_payload/);
    assert.throws(() => parseSyncPayloadV3({
      schemaVersion: 3, documentId: 'doc', revision: 1, commitId: 'c', parentCommitId: null,
      writerId: 'writer', committedAt: now, records: [], tombstones: [{ id: 'x', deletedAt: now }],
    }), /invalid_remote_payload/);
  });

  test('unresolved conflict IDs remain frozen until an explicit choice', () => {
    const base = record('same', { notes: 'base' });
    const local = record('same', { notes: 'local' });
    const remote = record('same', { notes: 'remote' });
    const initial = mergeSyncStates(side([base]), side([local]), side([remote]), 'device-a', now);
    const repeated = mergeSyncStates(side([remote]), side([local]), side([remote]), 'device-a', now, initial.conflicts);
    assert.equal(repeated.local.records[0].notes, 'local');
    assert.equal(repeated.remote.records[0].notes, 'remote');
    assert.equal(repeated.conflicts.length, 1);
  });

  test('a new client does not report a conflict for system-field-only differences', () => {
    const local = record('same', { updatedAt: '2020-01-01T00:00:00Z', rev: 2, revActor: 'local' });
    const remote = record('same', { updatedAt: '2030-01-01T00:00:00Z', rev: 3, revActor: 'remote' });
    const result = mergeSyncStates(side(), side([local]), side([remote]), 'device-a', now);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.local.records[0].revActor, 'remote');
  });
});
