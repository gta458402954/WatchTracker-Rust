import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCollectionCandidateGroup,
  collectionCandidateDescription,
  movieCollectionCandidateEligibility,
  normalizeCollectionSearchMatches,
} from '../../../features/collections/lib/collectionCandidateEligibility.ts';

test('collection search matches are normalized and duplicate parent TV identities are removed', () => {
  const matches = normalizeCollectionSearchMatches([
    { id: 10, media_type: 'movie', title: '电影', original_title: 'Movie', release_date: '2020-01-01' },
    { id: 20, media_type: 'tv', name: '剧集', first_air_date: '2021-01-01' },
    { id: 30, show_id: 20, media_type: 'tv_season', name: '第 1 季' },
    { id: 10, media_type: 'movie', title: '重复电影' },
  ]);
  assert.deepEqual(matches.map(item => [item.mediaType, item.id]), [['movie', 10], ['tv', 20]]);
  assert.equal(matches[0].originalLabel, 'Movie');
  assert.equal(matches[0].year, '2020');
});

test('a movie without two released collection parts is not actionable', () => {
  const now = new Date('2026-08-13T00:00:00Z');
  assert.equal(movieCollectionCandidateEligibility({}, now), 'unknown');
  assert.equal(movieCollectionCandidateEligibility({ parts: [
    { id: 1, release_date: '2020-01-01' },
    { id: 2, release_date: '2099-01-01' },
  ] }, now), 'complete');
});

test('a movie collection with two released parts remains actionable for grouping', () => {
  const detail = { parts: [
    { id: 1, release_date: '2020-01-01' },
    { id: 2, release_date: '2021-01-01' },
  ] };
  const now = new Date('2026-08-13T00:00:00Z');
  assert.equal(movieCollectionCandidateEligibility(detail, now), 'actionable');
});

test('candidate description exposes year, original title, TMDB identity and source', () => {
  const description = collectionCandidateDescription({
    id: 42,
    mediaType: 'movie',
    label: '示例',
    originalLabel: 'Example',
    year: '2020',
    posterPath: null,
  }, '示例合集', 2);
  assert.match(description, /Example · 2020 · TMDB 42/);
  assert.match(description, /电影合集：示例合集/);
  assert.match(description, /至少缺少 2 部/);
});

test('a qualified candidate owns the IMDb group despite unavailable or rejected sibling matches', () => {
  const choice = { sourceKey: 'tmdb:movie-collection:95051' };
  assert.deepEqual(classifyCollectionCandidateGroup([
    { reason: 'qualified', choice },
    { reason: 'unavailable' },
    { reason: 'complete' },
    { reason: 'ineligible' },
  ]), { disposition: 'actionable', choices: [choice] });
});

test('multiple qualified candidates remain ambiguous without counting rejected siblings', () => {
  const first = { sourceKey: 'tmdb:movie-collection:1' };
  const second = { sourceKey: 'tmdb:tv-show:2' };
  assert.deepEqual(classifyCollectionCandidateGroup([
    { reason: 'qualified', choice: first },
    { reason: 'unavailable' },
    { reason: 'qualified', choice: second },
  ]), { disposition: 'ambiguous', choices: [first, second] });
});

test('an IMDb group is unavailable only when it has no qualified candidate and any result is unknown', () => {
  assert.equal(classifyCollectionCandidateGroup([
    { reason: 'complete' },
    { reason: 'unavailable' },
  ]).disposition, 'unavailable');
  assert.equal(classifyCollectionCandidateGroup([]).disposition, 'unavailable');
});

test('known rejected IMDb groups are counted once using dismissal, completion, then ineligibility priority', () => {
  assert.equal(classifyCollectionCandidateGroup([
    { reason: 'ineligible' },
    { reason: 'ignored' },
  ]).disposition, 'ignored');
  assert.equal(classifyCollectionCandidateGroup([
    { reason: 'ineligible' },
    { reason: 'complete' },
  ]).disposition, 'complete');
  assert.equal(classifyCollectionCandidateGroup([
    { reason: 'ineligible' },
    { reason: 'ineligible' },
  ]).disposition, 'ineligible');
});
