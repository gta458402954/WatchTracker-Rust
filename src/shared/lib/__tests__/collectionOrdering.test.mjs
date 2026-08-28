import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionsByRecentGrouping } from '../collectionOrdering.ts';

const collection = (id, createdAt, fields = {}) => ({
  id, name: id, normalizedName: id, description: null, sourceKind: 'manual', sourceKey: null,
  collectionKind: 'manual', orderMode: 'manual', createdAt, updatedAt: createdAt,
  rev: 1, revActor: 'device', ...fields,
});
const member = (collectionId, createdAt, fields = {}) => ({
  id: `${collectionId}-${createdAt}`, collectionId, recordId: `${collectionId}-record`, position: 0,
  sourceKind: 'manual', createdAt, updatedAt: createdAt, rev: 1, revActor: 'device', ...fields,
});

test('collections are ordered by the newest grouping rather than collection metadata edits', () => {
  const older = collection('older', '2026-08-01T00:00:00Z', { updatedAt: '2030-01-01T00:00:00Z' });
  const newer = collection('newer', '2026-08-02T00:00:00Z');
  const values = [older, newer];
  const ordered = collectionsByRecentGrouping(values, [
    member('older', '2026-08-03T00:00:00Z', { updatedAt: '2031-01-01T00:00:00Z' }),
    member('newer', '2026-08-04T00:00:00Z'),
  ]);
  assert.deepEqual(ordered.map(item => item.id), ['newer', 'older']);
  assert.deepEqual(values.map(item => item.id), ['older', 'newer']);
});

test('empty collections fall back to creation time and ties have a stable name and id order', () => {
  const ordered = collectionsByRecentGrouping([
    collection('b', '2026-08-02T00:00:00Z', { normalizedName: '同名' }),
    collection('a', '2026-08-02T00:00:00Z', { normalizedName: '同名' }),
    collection('newest', '2026-08-03T00:00:00Z'),
  ], []);
  assert.deepEqual(ordered.map(item => item.id), ['newest', 'a', 'b']);
});
