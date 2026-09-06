import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  bootstrapAssignment,
  buildBootstrapPlanV1,
  buildEntityConflictCoreV1,
  buildRelationConflictCoreV1,
  canonicalCollectionNameV1,
  canonicalSemanticValue,
  canonicalizeJcs,
  compareCommitDotV1,
  compareCommitRefV1,
  compareEntityKeyV1,
  deterministicEntityIdV1,
  entityConflictIdV1,
  normalizeCollectionNameV1,
  parseInt64DecimalString,
  parseWriterSeq,
  relationConflictIdV1,
  sha256Hex,
  sha256Jcs,
  validateCanonicalDate,
  validateCanonicalTimestamp,
  validateCanonicalUuid,
  validateCanonicalUuidV4,
  validateFloat64,
  validateEntityKey,
  validateNativeEntity,
  validateNativeTombstone,
  validateSafeInteger,
} from '../../../features/sync/s2lite/index.ts';

const fixtureUrl = new URL('../../../../contracts/s2-lite/v1/conflict-golden-v1.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const jcsOracleUrl = new URL('../../../../contracts/s2-lite/v1/jcs-oracle-v1.json', import.meta.url);
const jcsOracle = JSON.parse(await readFile(jcsOracleUrl, 'utf8'));
const floatConflictUrl = new URL('../../../../contracts/s2-lite/v1/float-roundtrip-conflict-v1.jcs', import.meta.url);
const expectedFloatConflictJcs = (await readFile(floatConflictUrl, 'utf8')).trimEnd();

const dot = ref => ({ writerId: ref.writerId, writerSeq: ref.writerSeq, commitId: ref.commitId });
const resolveState = state => state.state === 'tombstone'
  ? { state: 'tombstone' }
  : { state: 'live', value: fixture.semanticValues[state.value] };

test('S2 Lite canonical conflict codec matches all 9 language-neutral vectors', async t => {
  for (const vector of fixture.entityCases) {
    await t.test(`entity/${vector.name}`, async () => {
      const alternatives = vector.alternatives.map(alternative => ({
        ref: fixture.refs[alternative.ref],
        semanticState: resolveState(alternative.semanticState),
        changedFields: alternative.changedFields,
        baseFrontier: alternative.baseRefs.map(name => fixture.refs[name]),
      }));
      const actual = buildEntityConflictCoreV1(vector.entityKey, vector.conflictKind, alternatives);
      const expected = JSON.parse(vector.expectedJcs);
      assert.deepEqual(actual, expected);
      assert.equal(canonicalizeJcs(actual), vector.expectedJcs);
      assert.equal(await entityConflictIdV1(actual), vector.expectedSha256);
    });
  }
  for (const vector of fixture.relationCases) {
    await t.test(`relation/${vector.name}`, async () => {
      const participants = vector.participants.map(participant => ({
        entityKey: participant.entityKey,
        provenanceFrontier: participant.refs.map(name => fixture.refs[name]),
      }));
      const actual = buildRelationConflictCoreV1(vector.relationKind, vector.facts, participants);
      const expected = JSON.parse(vector.expectedJcs);
      assert.deepEqual(actual, expected);
      assert.equal(canonicalizeJcs(actual), vector.expectedJcs);
      assert.equal(await relationConflictIdV1(actual), vector.expectedSha256);
    });
  }
});

test('JCS matches the shared UTF-16/exact-byte oracle and rejects non-JSON host values', () => {
  for (const vector of jcsOracle.cases) {
    assert.equal(canonicalizeJcs(vector.input), vector.expectedJcs, vector.name);
  }
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => canonicalizeJcs(invalid));
  }
  assert.throws(() => canonicalizeJcs({ nested: [Number.NaN] }));
  assert.throws(() => canonicalizeJcs(new Array(2)));
  assert.throws(() => canonicalizeJcs([1, , 2]));
  assert.throws(() => canonicalizeJcs([undefined]));
  assert.throws(() => canonicalizeJcs([() => {}]));
  assert.throws(() => canonicalizeJcs([Symbol('x')]));
  assert.throws(() => canonicalizeJcs([1n]));
});

test('raw JSON float parsing produces frozen ECMAScript/JCS number bytes', async () => {
  const cases = [
    ['0', '0'], ['-0', '0'], ['0.1', '0.1'], ['0.2', '0.2'], ['0.3', '0.3'],
    ['1.2345678901234567', '1.2345678901234567'],
    ['2.3307731538713474', '2.3307731538713474'],
    ['9.999999999999998', '9.999999999999998'], ['10', '10'],
    ['1.0000000000000002', '1.0000000000000002'],
    ['0.10000000000000002', '0.10000000000000002'],
    ['4.9406564584124654e-324', '5e-324'],
    ['2.2250738585072014e-308', '2.2250738585072014e-308'],
    ['7.84551240822557', '7.84551240822557'],
    ['3.141592653589793', '3.141592653589793'],
  ];
  for (const [raw, expected] of cases) assert.equal(canonicalizeJcs(JSON.parse(raw)), expected, raw);

  let state = 0x5eed1234;
  const output = [];
  for (let index = 0; index < 4096; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const raw = JSON.stringify((state / 4_294_967_296) * 10);
    output.push(canonicalizeJcs(JSON.parse(raw)));
  }
  assert.equal(
    await sha256Hex(new TextEncoder().encode(output.join('\n'))),
    'd33fd9c27b6203f60b03a2be8cdc32c7c86c18c4857b65dd91107f485c158b79',
  );
});

test('reviewer float counterexample survives raw parse through native conflict hashing', async () => {
  const metadata = {
    id: 'r-lock', createdAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  };
  const rawA = JSON.stringify({ ...metadata, ...fixture.semanticValues.recordLocked });
  const rawB = JSON.stringify({ ...metadata, ...fixture.semanticValues.recordChanged })
    .replace('"imdbRating":null', '"imdbRating":2.3307731538713474');
  const recordA = JSON.parse(rawA);
  const recordB = JSON.parse(rawB);
  await validateNativeEntity(['record', 'r-lock'], recordA);
  await validateNativeEntity(['record', 'r-lock'], recordB);
  const core = buildEntityConflictCoreV1(['record', 'r-lock'], 'locked-concurrent', [
    {
      ref: fixture.refs.RA,
      semanticState: { state: 'live', value: canonicalSemanticValue(recordA) },
      changedFields: ['isLocked'],
      baseFrontier: [fixture.refs.P],
    },
    {
      ref: fixture.refs.RB,
      semanticState: { state: 'live', value: canonicalSemanticValue(recordB) },
      changedFields: ['notes', 'imdbRating'],
      baseFrontier: [fixture.refs.P],
    },
  ]);
  assert.equal(canonicalizeJcs(core), expectedFloatConflictJcs);
  assert.equal(await entityConflictIdV1(core), '94e8c8387bad34bb0d2e64f683ddc886998b2b4c3ff8fff6a2f9a6e6a0a1e90c');
});

test('CommitDot comparator trap uses protocol fields and numeric writerSeq', () => {
  const ra = dot(fixture.refs.RA);
  const rb = dot(fixture.refs.RB);
  assert.equal(compareCommitDotV1(ra, rb), -1);
  assert.equal(canonicalizeJcs(ra) > canonicalizeJcs(rb), true);
  const sameWriter2 = { ...ra, writerSeq: '2' };
  const sameWriter10 = { ...ra, writerSeq: '10' };
  assert.equal(compareCommitDotV1(sameWriter2, sameWriter10), -1);
});

test('integer boundaries remain exact strings/BigInts through parse, compare, serialize, equality, and hash', async () => {
  const safeMax = '9007199254740991';
  const unsafe = '9007199254740992';
  const unsafeNext = '9007199254740993';
  assert.equal(parseInt64DecimalString(safeMax), 9_007_199_254_740_991n);
  assert.equal(parseInt64DecimalString(unsafe), 9_007_199_254_740_992n);
  assert.equal(parseInt64DecimalString(unsafeNext), 9_007_199_254_740_993n);
  assert.notEqual(unsafe, unsafeNext);
  assert.equal(parseInt64DecimalString('9223372036854775807'), 9_223_372_036_854_775_807n);
  assert.equal(parseInt64DecimalString('-9223372036854775808'), -9_223_372_036_854_775_808n);
  assert.equal(parseWriterSeq('18446744073709551615'), 18_446_744_073_709_551_615n);
  assert.throws(() => parseWriterSeq('18446744073709551616'));
  assert.equal(canonicalizeJcs({ value: unsafe }), '{"value":"9007199254740992"}');
  assert.notEqual(await sha256Jcs({ value: unsafe }), await sha256Jcs({ value: unsafeNext }));
});

test('canonical scalar contract rejects host coercion and preserves NONE/null semantics', () => {
  validateCanonicalUuid('11111111-1111-4111-8111-111111111111');
  validateCanonicalUuidV4('11111111-1111-4111-8111-111111111111');
  assert.throws(() => validateCanonicalUuid('11111111-1111-4111-8111-11111111111A'));
  assert.throws(() => validateCanonicalUuidV4('11111111-1111-1111-8111-111111111111'));
  for (const invalid of ['0', '01', '+1', ' 1', 1]) assert.throws(() => parseWriterSeq(invalid));
  for (const invalid of ['-0', '+1', '01', ' 1', 1]) assert.throws(() => parseInt64DecimalString(invalid));
  validateSafeInteger(9_007_199_254_740_991, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  assert.throws(() => validateSafeInteger(9_007_199_254_740_992, 0, Number.MAX_SAFE_INTEGER));
  validateFloat64(10, 0, 10);
  assert.throws(() => validateFloat64(Number.POSITIVE_INFINITY, 0, 10));
  validateCanonicalDate('2024-02-29');
  assert.throws(() => validateCanonicalDate('2023-02-29'));
  validateCanonicalTimestamp('2026-09-06T10:00:00.000Z');
  assert.throws(() => validateCanonicalTimestamp('2026-09-06T18:00:00.000+08:00'));
  assert.notEqual(canonicalizeJcs(null), canonicalizeJcs(''));
  assert.equal(canonicalizeJcs(-0), '0');
  assert.notEqual(canonicalizeJcs('é'), canonicalizeJcs('e\u0301'));
  assert.equal(normalizeCollectionNameV1('FaVÉ'), 'favÉ');
});

test('Collection S2WS canonicalization covers all six code points and rejects other controls', () => {
  assert.equal(canonicalCollectionNameV1(' A  B '), 'A B');
  assert.equal(canonicalCollectionNameV1('A \t B'), 'A B');
  assert.equal(canonicalCollectionNameV1('\tA\nB\r'), 'A B');
  for (const whitespace of ['\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020']) {
    assert.equal(canonicalCollectionNameV1(`${whitespace}A${whitespace}${whitespace}B${whitespace}`), 'A B');
  }
  assert.equal(canonicalCollectionNameV1(' \t\n\v\f\r A \t B \r '), 'A B');
  assert.throws(() => canonicalCollectionNameV1(' '));
  assert.throws(() => canonicalCollectionNameV1('\u0001A'));
  assert.throws(() => canonicalCollectionNameV1('A\u007f'));
});

test('Date/Timestamp acceptance matrix uses fixed-width ASCII digits only', () => {
  for (const valid of ['0001-01-01', '2000-02-29', '2024-02-29', '9999-12-31']) validateCanonicalDate(valid);
  for (const invalid of [
    '0000-01-01', '2023-02-29', '1900-02-29', '2026-02-30',
    '-001-01-01', '+001-01-01', '2026-+1-01', '2026--1-01', '2026-01-+1', '2026-01--1',
    '2026-1-01', '2026-01-1', '٢٠٢٦-09-06', ' 2026-09-06',
  ]) assert.throws(() => validateCanonicalDate(invalid), invalid);
  validateCanonicalTimestamp('2026-09-06T23:59:59.999Z');
  for (const invalid of [
    '2026-09-06T24:00:00.000Z', '2026-09-06T10:60:00.000Z',
    '2026-09-06T10:00:60.000Z', '2026-09-06T10:00:00.00Z',
    '2026-09-06T+1:00:00.000Z', '2026-09-06T-1:00:00.000Z',
    '2026-09-06T10:+0:00.000Z', '2026-09-06T10:-0:00.000Z',
    '2026-09-06T10:00:+0.000Z', '2026-09-06T10:00:-0.000Z',
    '2026-09-06T10:00:00.+00Z', '2026-09-06T10:00:00.-00Z',
    '2026-09-06T10:00:00.000+00:00', '٢٠٢٦-09-06T10:00:00.000Z',
  ]) assert.throws(() => validateCanonicalTimestamp(invalid), invalid);
});

function recordValue(overrides = {}) {
  return {
    id: 'record-1',
    ...fixture.semanticValues.recordChanged,
    createdAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-06T10:00:00.000Z',
    rev: '9223372036854775807',
    revActor: '',
    ...overrides,
  };
}

test('Semantic Profile v1 is native-strict and metadata is non-business-semantic', async () => {
  const a = recordValue();
  const b = recordValue({ updatedAt: '2026-09-06T10:00:01.000Z' });
  await validateNativeEntity(['record', 'record-1'], a);
  await validateNativeEntity(['record', 'record-1'], b);
  assert.deepEqual(canonicalSemanticValue(a), canonicalSemanticValue(b));
  await validateNativeEntity(['record', 'record-1'], recordValue({
    tmdbMediaKind: 'movie', tmdbId: '9007199254740993', seriesRecordKind: 'single-work',
  }));
  await assert.rejects(
    validateNativeEntity(['record', 'record-1'], recordValue({ updatedAt: '2026-09-06T18:00:00.000+08:00' })),
  );

  const episodeId = await deterministicEntityIdV1('episode-completion:v1', ['record-1', 7]);
  const episode = {
    id: episodeId, recordId: 'record-1', episodeNumber: 7, completedAt: null,
    createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  };
  await validateNativeEntity(['episode-completion', 'record-1', 7], episode);
  await validateNativeTombstone(['episode-completion', 'record-1', 7], {
    id: episodeId, recordId: 'record-1', episodeNumber: 7,
    deletedAt: '2026-09-06T10:00:00.000Z', rev: '1', revActor: '',
  });

  const collection = {
    id: 'collection-1', name: 'Favorites', normalizedName: 'favorites', description: null,
    sourceKind: 'manual', sourceKey: null, collectionKind: 'manual', orderMode: 'manual',
    createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  };
  await validateNativeEntity(['collection', 'collection-1'], collection);
  await assert.rejects(validateNativeEntity(
    ['collection', 'collection-1'],
    { ...collection, name: ' A  B ', normalizedName: ' a  b ' },
  ));
  const memberId = await deterministicEntityIdV1('collection-member:v1', ['collection-1', 'record-1']);
  await validateNativeEntity(['collection-member', 'collection-1', 'record-1'], {
    id: memberId, collectionId: 'collection-1', recordId: 'record-1', position: '9007199254740993', sourceKind: 'manual',
    createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  });
});

test('native Entity/Tombstone entrypoints reject malformed identity before deterministic hashing', async () => {
  for (const key of [
    ['record', 'record-1', 'extra'], ['collection', ''], ['episode-completion', 'record-1', -1],
    ['episode-completion', 'record-1', 0], ['episode-completion', 'record-1', 2_147_483_648],
    ['collection-member', '', 'record-1'], ['collection-member', 'collection-1', ''],
  ]) assert.throws(() => validateEntityKey(key));

  const illegalEpisodeId = await deterministicEntityIdV1('episode-completion:v1', ['record-1', 0]);
  const illegalEpisode = {
    id: illegalEpisodeId, recordId: 'record-1', episodeNumber: 0, completedAt: null,
    createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  };
  await assert.rejects(validateNativeEntity(['episode-completion', 'record-1', 0], illegalEpisode));
  await assert.rejects(validateNativeTombstone(['episode-completion', 'record-1', 0], {
    id: illegalEpisodeId, recordId: 'record-1', episodeNumber: 0,
    deletedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  }));
  const illegalMemberId = await deterministicEntityIdV1('collection-member:v1', ['', 'record-1']);
  await assert.rejects(validateNativeEntity(['collection-member', '', 'record-1'], {
    id: illegalMemberId, collectionId: '', recordId: 'record-1', position: '0', sourceKind: 'manual',
    createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  }));
});

test('full native entity validation rejects noncanonical Date/Timestamp fields', async () => {
  for (const startDate of ['-001-01-01', '+001-01-01', '2026-+1-01', '٢٠٢٦-09-06']) {
    await assert.rejects(validateNativeEntity(['record', 'record-1'], recordValue({ startDate })));
  }
  for (const updatedAt of [
    '2026-09-06T+1:00:00.000Z', '2026-09-06T10:+0:00.000Z',
    '2026-09-06T10:00:+0.000Z', '2026-09-06T10:00:60.000Z',
    '2026-09-06T10:00:00.000+00:00',
  ]) await assert.rejects(validateNativeEntity(['record', 'record-1'], recordValue({ updatedAt })));
});

function bootstrapRecord(id, overrides = {}) {
  return recordValue({ id, totalEpisodes: 10_000, mediaType: '剧集', ...overrides });
}

function bootstrapCollection(id) {
  return {
    id, name: `Collection-${id}`, normalizedName: `collection-${id}`, description: null,
    sourceKind: 'manual', sourceKey: null, collectionKind: 'manual', orderMode: 'manual',
    createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  };
}

async function bootstrapCase(recordCount, collectionCount, memberCount, episodeCount) {
  const result = [];
  for (let index = 0; index < recordCount; index += 1) {
    const id = `r${String(index).padStart(4, '0')}`;
    result.push({ entityType: 'record', entityKey: ['record', id], value: bootstrapRecord(id) });
  }
  for (let index = 0; index < collectionCount; index += 1) {
    const id = `c${index}`;
    result.push({ entityType: 'collection', entityKey: ['collection', id], value: bootstrapCollection(id) });
  }
  for (let index = 0; index < memberCount; index += 1) {
    const collectionId = `c${index % collectionCount}`;
    const recordId = `r${String(index % recordCount).padStart(4, '0')}`;
    result.push({
      entityType: 'collection-member',
      entityKey: ['collection-member', collectionId, recordId],
      value: {
        id: await deterministicEntityIdV1('collection-member:v1', [collectionId, recordId]),
        collectionId, recordId, position: String(index), sourceKind: 'manual',
        createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
      },
    });
  }
  for (let index = 0; index < episodeCount; index += 1) {
    const recordId = `r${String(index % recordCount).padStart(4, '0')}`;
    const episodeNumber = Math.floor(index / recordCount) + 1;
    result.push({
      entityType: 'episode-completion',
      entityKey: ['episode-completion', recordId, episodeNumber],
      value: {
        id: await deterministicEntityIdV1('episode-completion:v1', [recordId, episodeNumber]),
        recordId, episodeNumber, completedAt: null,
        createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
      },
    });
  }
  return result;
}

function deterministicShuffle(values) {
  const result = [...values];
  let seed = 0x5eed1234;
  for (let index = result.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const target = seed % (index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

test('BuildBootstrapPlanV1 produces required dependency stages/chunks from complete canonical values', async () => {
  const cases = [
    [await bootstrapCase(300, 1, 300, 0), [[256, 45], [256, 44]]],
    [await bootstrapCase(600, 1, 1, 0), [[256, 256, 89], [1]]],
    [await bootstrapCase(300, 0, 0, 1000), [[256, 44], [256, 256, 256, 232]]],
  ];
  for (const [input, expected] of cases) {
    const plan = await buildBootstrapPlanV1(input);
    assert.deepEqual(plan.stageAChunks.map(chunk => chunk.length), expected[0]);
    assert.deepEqual(plan.stageBChunks.map(chunk => chunk.length), expected[1]);
  }
});

test('bootstrap planning is invariant under forward/reverse/random/insertion permutations', async () => {
  const forward = await bootstrapCase(300, 1, 300, 60);
  const expectedPlan = await buildBootstrapPlanV1(forward);
  const expected = bootstrapAssignment(expectedPlan);
  for (const permutation of [[...forward].reverse(), deterministicShuffle(forward), [...new Map(forward.map((value, i) => [i, value])).values()]]) {
    const actualPlan = await buildBootstrapPlanV1(permutation);
    assert.deepEqual(actualPlan, expectedPlan);
    assert.deepEqual(bootstrapAssignment(actualPlan), expected);
  }
});

test('bootstrap and conflict codecs fail closed on missing parents or malformed logical facts', async () => {
  await assert.rejects(buildBootstrapPlanV1([
    { entityType: 'episode-completion', entityKey: ['episode-completion', 'missing', 1], value: {} },
  ]));
  const live = { state: 'live', value: fixture.semanticValues.collectionAlpha };
  assert.throws(() => buildEntityConflictCoreV1(
    ['collection', 'c-live'],
    'different-base',
    [
      { ref: fixture.refs.RA, semanticState: live, changedFields: [], baseFrontier: [fixture.refs.P] },
      { ref: fixture.refs.RB, semanticState: { state: 'live', value: {} }, changedFields: [], baseFrontier: [fixture.refs.Q] },
    ],
  ));
  assert.throws(() => buildRelationConflictCoreV1(
    'episode-exceeds-total',
    { recordId: 'r1', episodeNumber: 12, totalEpisodes: 10 },
    [
      { entityKey: ['record', 'wrong'], provenanceFrontier: [fixture.refs.RA] },
      { entityKey: ['episode-completion', 'r1', 12], provenanceFrontier: [fixture.refs.RB] },
    ],
  ));
});

test('BuildBootstrapPlanV1 validates the complete current-state contract before ordering', async () => {
  const valid = await bootstrapCase(1, 1, 1, 1);
  await buildBootstrapPlanV1(valid);
  const reject = async candidate => assert.rejects(buildBootstrapPlanV1(candidate));

  await reject([{ ...valid[0], entityType: 'future-type' }]);
  await reject([{ ...valid[0], value: {} }]);
  await reject([{ ...valid[0], value: { state: 'tombstone' } }]);
  await reject([{ ...valid[0], value: { state: 'unresolved', alternatives: [] } }]);
  await reject([{ ...valid[0], entityKey: ['record', 'wrong'] }]);
  await reject([{ ...valid[0], entityKey: ['record', 'r0000', 'extra'] }]);
  await reject([{ ...valid[3], value: { ...valid[3].value, id: '0'.repeat(64) } }]);
  await reject([valid[3]]);
  await reject([valid[0], { ...valid[3], value: { ...valid[3].value, episodeNumber: 2 } }]);

  const episodeTwo = {
    ...valid[3],
    entityKey: ['episode-completion', 'r0000', 2],
    value: {
      ...valid[3].value,
      id: await deterministicEntityIdV1('episode-completion:v1', ['r0000', 2]),
      episodeNumber: 2,
    },
  };
  await reject([{ ...valid[0], value: bootstrapRecord('r0000', { totalEpisodes: 1 }) }, episodeTwo]);
  await reject([{ ...valid[0], value: bootstrapRecord('r0000', { mediaType: '电影' }) }, valid[3]]);
  await reject([{ ...valid[0], value: bootstrapRecord('r0000', { totalEpisodes: null }) }, valid[3]]);
  await reject([valid[0], valid[0]]);
  await reject([valid[0], valid[2]]);
});

test('each RelationConflict participant must independently carry provenance', () => {
  const cases = [
    ['collection-deleted-member-live',
      { collectionId: 'c1', recordId: 'r1', collectionState: 'tombstone', memberState: 'live' },
      [['collection', 'c1'], ['collection-member', 'c1', 'r1']]],
    ['record-deleted-member-live',
      { collectionId: 'c1', recordId: 'r1', recordState: 'tombstone', memberState: 'live' },
      [['record', 'r1'], ['collection-member', 'c1', 'r1']]],
    ['record-deleted-episode-live',
      { recordId: 'r1', episodeNumber: 12, recordState: 'tombstone', episodeState: 'live' },
      [['record', 'r1'], ['episode-completion', 'r1', 12]]],
    ['episode-exceeds-total',
      { recordId: 'r1', episodeNumber: 12, totalEpisodes: 10 },
      [['record', 'r1'], ['episode-completion', 'r1', 12]]],
  ];
  for (const [kind, facts, keys] of cases) {
    for (const empty of [[true, false], [false, true], [true, true]]) {
      const participants = keys.map((entityKey, index) => ({
        entityKey,
        provenanceFrontier: empty[index] ? [] : [index === 0 ? fixture.refs.RA : fixture.refs.RB],
      }));
      assert.throws(() => buildRelationConflictCoreV1(kind, facts, participants), `${kind}/${empty.join('-')}`);
    }
  }
});

test('relation EntityKey equality canonicalizes all 12/12.0 representations', async () => {
  let expectedJcs;
  let expectedId;
  const expectedKeyJcs = canonicalizeJcs(['episode-completion', 'r1', 12]);
  for (const [factEpisode, keyEpisode] of [['12', '12'], ['12.0', '12'], ['12', '12.0'], ['12.0', '12.0']]) {
    const facts = JSON.parse(`{"recordId":"r1","episodeNumber":${factEpisode},"totalEpisodes":10}`);
    const episodeKey = JSON.parse(`["episode-completion","r1",${keyEpisode}]`);
    assert.equal(canonicalizeJcs(episodeKey), expectedKeyJcs);
    const core = buildRelationConflictCoreV1(
      'episode-exceeds-total',
      facts,
      [
        { entityKey: ['record', 'r1'], provenanceFrontier: [fixture.refs.RA] },
        { entityKey: episodeKey, provenanceFrontier: [fixture.refs.RB] },
      ],
    );
    const jcs = canonicalizeJcs(core);
    const id = await relationConflictIdV1(core);
    expectedJcs ??= jcs;
    expectedId ??= id;
    assert.equal(jcs, expectedJcs);
    assert.equal(id, expectedId);
  }
  const frozen = fixture.relationCases.find(item => item.name === 'episode-exceeds-total');
  assert.equal(expectedJcs, frozen.expectedJcs);
  assert.equal(expectedId, frozen.expectedSha256);
  for (const invalid of [12.5, 0, 2_147_483_648]) {
    for (const [factEpisode, keyEpisode] of [[invalid, 12], [12, invalid]]) {
      assert.throws(() => buildRelationConflictCoreV1(
        'episode-exceeds-total',
        { recordId: 'r1', episodeNumber: factEpisode, totalEpisodes: 10 },
        [
          { entityKey: ['record', 'r1'], provenanceFrontier: [fixture.refs.RA] },
          { entityKey: ['episode-completion', 'r1', keyEpisode], provenanceFrontier: [fixture.refs.RB] },
        ],
      ));
    }
  }
});

test('canonical comparators satisfy antisymmetry, transitivity, totality, and JCS round-trip', () => {
  const refs = Array.from({ length: 60 }, (_, index) => ({
    writerId: `${String(index % 4).padStart(8, '0')}-0000-4000-8000-${String(index % 7).padStart(12, '0')}`,
    writerSeq: String((index * 17) % 41 + 1),
    commitId: `${String(59 - index).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
    contentHash: index.toString(16).padStart(64, '0'),
  }));
  const sign = value => Math.sign(value);
  for (const a of refs) {
    for (const b of refs) {
      assert.equal(sign(compareCommitRefV1(a, b)) + sign(compareCommitRefV1(b, a)), 0);
      assert.equal(compareCommitRefV1(a, b) === 0, canonicalizeJcs(a) === canonicalizeJcs(b));
    }
  }
  const sorted = [...refs].sort(compareCommitRefV1);
  for (let index = 0; index + 2 < sorted.length; index += 1) {
    assert.ok(compareCommitRefV1(sorted[index], sorted[index + 2]) <= 0);
  }
  const keys = [['record', 'z'], ['collection', 'a'], ['episode-completion', 'r', 10], ['episode-completion', 'r', 2]];
  const sortedKeys = [...keys].sort(compareEntityKeyV1);
  assert.deepEqual([...sortedKeys].sort(compareEntityKeyV1), sortedKeys);
  const value = { z: [null, '', 'e\u0301', 'é'], a: { integer: '9007199254740993', safe: 11 } };
  const encoded = canonicalizeJcs(value);
  assert.equal(canonicalizeJcs(JSON.parse(encoded)), encoded);
});
