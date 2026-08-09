import test from 'node:test';
import assert from 'node:assert/strict';
import { chronologicalRecords, defaultMissingSeasonNumbers, locallyKnownSeries, seasonNumberOf } from '../../../features/collections/lib/seriesDiscovery.ts';

const record = (id, chineseName, releaseYear = null) => ({ id, chineseName, originalName: '', progress: '', releaseYear, imdbId: null });

test('detects Chinese, English and compact season markers', () => {
  assert.equal(seasonNumberOf(record('1', '傲骨之战 第 5 季')), 5);
  assert.equal(seasonNumberOf({ chineseName: '', originalName: 'The Good Fight Season 2', progress: '' }), 2);
  assert.equal(seasonNumberOf({ chineseName: '', originalName: '', progress: 'S03E02' }), 3);
});

test('chronological order is old to new, unknown last and season zero after regular seasons', () => {
  const values = chronologicalRecords([record('u', '未知'), record('s0', '剧 第0季', '2020'), record('s2', '剧 第2季', '2020'), record('old', '旧作', '2018')]);
  assert.deepEqual(values.map(item => item.id), ['old', 's2', 's0', 'u']);
});

test('local discovery groups explicit seasons', () => {
  const values = locallyKnownSeries([record('1', '生活大爆炸 第1季'), record('2', '生活大爆炸 第2季')]);
  assert.equal(values.length, 1);
  assert.deepEqual(values[0].seasons, [1, 2]);
});

test('missing season defaults include only aired regular seasons', () => {
  const seasons = [{ season_number: 0, air_date: '2010-01-01' }, { season_number: 1, air_date: '2011-01-01' }, { season_number: 2, air_date: '2099-01-01' }, { season_number: 3, air_date: null }];
  assert.deepEqual(defaultMissingSeasonNumbers(seasons, new Set(), new Date('2026-01-01T00:00:00Z')), [1]);
});
