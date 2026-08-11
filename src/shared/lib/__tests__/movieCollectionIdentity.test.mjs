import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMovieCollectionPart, normalizeImdbId } from '../../../features/collections/lib/movieCollectionIdentity.ts';

const record = (id, overrides = {}) => ({
  id, mediaType: '电影', tmdbMediaKind: null, tmdbId: null, imdbId: null, ...overrides,
});

test('normalizes only valid IMDb title identifiers', () => {
  assert.equal(normalizeImdbId(' TT0181852 '), 'tt0181852');
  assert.equal(normalizeImdbId('nm123'), null);
});

test('matches a legacy movie by IMDb when its TMDB identity is missing', () => {
  const legacy = record('terminator', { imdbId: 'tt0088247' });
  const result = classifyMovieCollectionPart(
    { id: 218, external_ids: { imdb_id: 'tt0088247' } },
    [legacy],
    new Set(['terminator']),
  );
  assert.equal(result.status, 'member');
  assert.equal(result.recordId, 'terminator');
});

test('distinguishes reusable library movies and true missing movies', () => {
  const library = record('matrix', { tmdbMediaKind: 'movie', tmdbId: 603, imdbId: 'tt0133093' });
  assert.equal(classifyMovieCollectionPart({ id: 603, imdb_id: 'tt0133093' }, [library], new Set()).status, 'library');
  assert.equal(classifyMovieCollectionPart({ id: 604, imdb_id: 'tt0234215' }, [library], new Set()).status, 'missing');
});

test('reports conflicting TMDB and IMDb identities and ignores TV IMDb sharing', () => {
  const byTmdb = record('one', { tmdbMediaKind: 'movie', tmdbId: 10, imdbId: 'tt0000010' });
  const byImdb = record('two', { imdbId: 'tt0000020' });
  const tvSeason = record('season', { mediaType: '剧集', tmdbMediaKind: 'tv-season', imdbId: 'tt0000030' });
  assert.equal(classifyMovieCollectionPart({ id: 10, imdb_id: 'tt0000020' }, [byTmdb, byImdb], new Set()).status, 'conflict');
  assert.equal(classifyMovieCollectionPart({ id: 30, imdb_id: 'tt0000030' }, [tvSeason], new Set()).status, 'missing');
});
