import test from 'node:test';
import assert from 'node:assert/strict';
import { seasonRecordMetadata } from '../../../features/collections/lib/tmdbRecordMapping.ts';

const blackMirror = {
  id: 42009,
  name: '黑镜',
  original_name: 'Black Mirror',
  external_ids: { imdb_id: 'tt2085059' },
  origin_country: ['GB'],
  genres: [{ name: 'Sci-Fi & Fantasy' }, { name: '剧情' }],
  networks: [{ name: 'Channel 4' }],
  episode_run_time: [60],
  vote_average: 8.288,
  status: 'Returning Series',
};

test('missing-season creation inherits complete series metadata', () => {
  const result = seasonRecordMetadata(blackMirror, {
    id: 63871, season_number: 3, name: '第 3 季', air_date: '2016-10-21', episode_count: 6,
    poster_path: '/black-mirror-s3.jpg',
  });
  assert.equal(result.chineseName, '黑镜 第 3 季');
  assert.equal(result.originCountry, 'GB');
  assert.equal(result.genres, 'Sci-Fi & Fantasy,剧情');
  assert.equal(result.contentTags, '英国');
  assert.equal(result.platform, 'Channel 4');
  assert.equal(result.episodeRuntime, 60);
  assert.equal(result.tmdbParentId, 42009);
  assert.equal(result.tmdbSeasonNumber, 3);
});

test('metadata completion does not replace existing manually maintained fields', () => {
  const result = seasonRecordMetadata(blackMirror, { id: 63871, season_number: 3 }, {
    platform: 'Netflix', originCountry: 'US', genres: '自定义', contentTags: '自定义标签', episodeRuntime: 42,
  });
  assert.equal(result.platform, undefined);
  assert.equal(result.originCountry, undefined);
  assert.equal(result.genres, undefined);
  assert.equal(result.episodeRuntime, undefined);
  assert.equal(result.contentTags, '自定义标签,英国');
});
