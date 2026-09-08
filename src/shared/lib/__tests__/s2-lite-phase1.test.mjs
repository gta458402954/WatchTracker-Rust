import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BUSINESS_FIELD_ORDER,
  canonicalSemanticValue,
  canonicalizeJcs,
  causallyCoversV1,
  compareCommitRefV1,
  computeEntityFrontierV1,
  decodeFrozenWireCommitV1,
  deterministicEntityIdV1,
  detectDuplicateDiagnosticsV1,
  detectWatchTrackerRelationsV1,
  detectWriterForksV1,
  replayVerifiedHistoryV1,
  sha256Hex,
  validateCommitEnvelopeV1,
  validateWriterChainLinkV1,
} from '../../../features/sync/s2lite/index.ts';

const phase0 = JSON.parse(await readFile(
  new URL('../../../../contracts/s2-lite/v1/conflict-golden-v1.json', import.meta.url),
  'utf8',
));
const causalFixture = JSON.parse(await readFile(
  new URL('../../../../contracts/s2-lite/v1/causal-golden-v1.json', import.meta.url),
  'utf8',
));
const rawWireFixture = JSON.parse(await readFile(
  new URL('../../../../contracts/s2-lite/v1/raw-wire-json-v1.json', import.meta.url),
  'utf8',
));

const writer = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const uuid = number => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const hash = number => number.toString(16).padStart(64, '0');
const ref = commit => ({
  writerId: commit.writerId,
  writerSeq: commit.writerSeq,
  commitId: commit.commitId,
  contentHash: commit.contentHash,
});
const sortedRefs = refs => [...refs].sort(compareCommitRefV1);
const refKey = value => `${value.writerId}\0${value.writerSeq}\0${value.commitId}\0${value.contentHash}`;

function fullRecord(id = 'r1', patch = {}, metadata = {}) {
  return {
    id,
    ...phase0.semanticValues.recordChanged,
    notes: '',
    isLocked: false,
    createdAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-06T10:00:00.000Z',
    rev: '0',
    revActor: '',
    ...patch,
    ...metadata,
  };
}

function fullCollection(id = 'c1', patch = {}) {
  return {
    id,
    ...phase0.semanticValues.collectionOne,
    name: 'Collection',
    normalizedName: 'collection',
    createdAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-06T10:00:00.000Z',
    rev: '0',
    revActor: '',
    ...patch,
  };
}

function tombstone(id, patch = {}) {
  return {
    id,
    deletedAt: '2026-09-06T10:00:00.000Z',
    rev: '1',
    revActor: 'test',
    ...patch,
  };
}

function mutation(number, entityKey, operation, value, baseFrontier, changedFields) {
  return {
    localMutationId: uuid(10_000 + number),
    entityType: entityKey[0],
    entityKey,
    operation,
    value,
    baseFrontier: sortedRefs(baseFrontier),
    changedFields,
  };
}

function commit({ number, writerNumber, seq = 1, previous = null, basis = [], mutations, resolution = null }) {
  return {
    protocol: 'watchtracker-s2-lite',
    protocolVersion: 1,
    s2SemanticProfileVersion: 1,
    requiredFeatures: [],
    writerId: writer(writerNumber),
    writerSeq: String(seq),
    commitId: uuid(number),
    contentHash: hash(number),
    previousWriterCommit: previous === null ? null : ref(previous),
    basisClock: sortedRefs(basis.map(ref)),
    commitKind: resolution === null ? 'mutation' : 'resolution',
    createdAt: '2026-09-06T10:00:00.000Z',
    source: { type: resolution === null ? 'native' : 'manual-resolution' },
    resolves: resolution === null ? [] : [...resolution].sort(),
    mutations,
  };
}

function recordCreate(number, writerNumber = number, patch = {}) {
  return commit({
    number,
    writerNumber,
    mutations: [mutation(number, ['record', 'r1'], 'upsert', fullRecord('r1', patch), [], BUSINESS_FIELD_ORDER.record)],
  });
}

function recordUpdate({ number, writerNumber, basis, previous = null, seq = 1, patch, changedFields, resolution = null }) {
  const base = basis.map(ref);
  return commit({
    number,
    writerNumber,
    seq,
    previous,
    basis,
    resolution,
    mutations: [mutation(number, ['record', 'r1'], 'upsert', fullRecord('r1', patch), base, changedFields)],
  });
}

function validityOf(replay, target) {
  return replay.validity.find(item => compareCommitRefV1(item.commitRef, ref(target)) === 0).validity;
}

function materializedOf(replay, key) {
  return replay.materialized.find(item => canonicalizeJcs(item.entityKey) === canonicalizeJcs(key))?.value;
}

function permute(values, seed) {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function resolvedState(state, provenance, businessValue = null) {
  return {
    state: 'Resolved',
    semanticState: state === 'tombstone' ? { state: 'tombstone' } : { state: 'live', value: businessValue },
    businessValue: state === 'tombstone' ? null : businessValue,
    provenanceFrontier: [provenance],
    metadataVariants: [],
  };
}

test('shared Phase 1 causal fixture contains all 18 mandatory language-neutral scenarios', () => {
  assert.equal(causalFixture.schema, 'watchtracker-s2-lite-causal-golden-v1');
  assert.deepEqual(causalFixture.cases.slice(0, 18).map(item => item.name), [
    'single-writer-seq-1-3', 'two-concurrent-writers', 'one-writer-observes-other',
    'semantic-equivalent-concurrent-values', 'same-base-disjoint-merge', 'overlapping-field',
    'different-base', 'live-tombstone', 'locked-concurrent', 'derived-domain',
    'parent-delete-member-create', 'episode-total-shrink', 'explicit-resolution',
    'stale-resolution', 'resolution-late-alternative', 'malformed-previous-ref',
    'missing-dependency-pending', 'writer-fork-classification',
  ]);
});

function normalizedObservable(replay) {
  return {
    validity: replay.validity,
    frontiers: replay.frontiers,
    materialized: replay.materialized,
    entityConflicts: replay.materialized.filter(item => item.value.state === 'Conflict').map(item => item.value.conflictId),
    relationConflicts: replay.relations.conflicts,
    diagnostics: replay.duplicateDiagnostics,
    forks: replay.forks,
    unsafeCommitRefs: replay.unsafeCommitRefs,
  };
}

test('every shared causal case independently replays to its explicit observable expectations', async () => {
  for (const scenario of causalFixture.cases) {
    const replay = await replayVerifiedHistoryV1(scenario.objects);
    const actual = normalizedObservable(replay);
    assert.equal(canonicalizeJcs(actual), canonicalizeJcs(scenario.expected), scenario.name);
    assert.ok(Array.isArray(scenario.expected.validity));
    assert.ok(Array.isArray(scenario.expected.frontiers));
    assert.ok(Array.isArray(scenario.expected.materialized));
    assert.ok(Array.isArray(scenario.expected.entityConflicts));
    assert.ok(Array.isArray(scenario.expected.relationConflicts));
    assert.ok(Array.isArray(scenario.expected.diagnostics));
    const counts = ['VALID', 'PENDING', 'INVALID'].map(state => (
      replay.validity.filter(item => item.validity.state === state).length
    ));
    const materialized = replay.materialized.map((item, index) => {
      const frontierCount = replay.frontiers.find(frontier => (
        canonicalizeJcs(frontier.entityKey) === canonicalizeJcs(item.entityKey)
      )).frontier.length;
      if (item.value.state === 'Resolved') {
        return { state: 'Resolved', frontierCount, provenanceCount: item.value.provenanceFrontier.length };
      }
      const assertion = {
        state: 'Conflict',
        conflictKind: item.value.conflictKind,
        frontierCount,
        provenanceCount: item.value.semanticAlternatives.length,
      };
      const frozen = scenario.semanticAssertions.materialized[index];
      if (frozen.exactConflictId !== undefined) {
        assertion.exactConflictId = item.value.conflictId;
        assertion.exactFrontierCommitIds = item.value.frontier.map(reference => reference.commitId);
      }
      return assertion;
    });
    assert.deepEqual({
      validityCounts: counts,
      materialized,
      ...(replay.relations.conflicts.length > 0 ? {
        relationConflictKinds: replay.relations.conflicts.map(conflict => conflict.core.relationKind),
      } : {}),
      ...(replay.forks.length > 0 ? { forkCount: replay.forks.length } : {}),
      ...(replay.unsafeCommitRefs.length > 0 ? { unsafeCommitCount: replay.unsafeCommitRefs.length } : {}),
    }, scenario.semanticAssertions, `${scenario.name}: manual semantic guard`);
  }
});

test('TypeScript replay matches the shared exact causal parity digest', async () => {
  const replay = await replayVerifiedHistoryV1(causalFixture.parityScenario.commits);
  const bytes = new TextEncoder().encode(canonicalizeJcs(replay));
  assert.equal(await sha256Hex(bytes), causalFixture.parityScenario.expectedReplaySha256);
});

test('commit envelope and own-writer chain enforce exact causal identity', async () => {
  const one = recordCreate(1, 1);
  const two = recordUpdate({
    number: 2, writerNumber: 1, seq: 2, previous: one, basis: [one],
    patch: { notes: 'two' }, changedFields: ['notes'],
  });
  const three = recordUpdate({
    number: 3, writerNumber: 1, seq: 3, previous: two, basis: [two],
    patch: { notes: 'three' }, changedFields: ['notes'],
  });
  [one, two, three].forEach(validateCommitEnvelopeV1);
  const replay = await replayVerifiedHistoryV1([three, one, two]);
  assert.deepEqual(replay.validity.map(item => item.validity.state), ['VALID', 'VALID', 'VALID']);
  assert.equal(materializedOf(replay, ['record', 'r1']).businessValue.notes, 'three');

  const malformed = structuredClone(two);
  malformed.basisClock = [];
  assert.throws(() => validateWriterChainLinkV1(malformed, new Map([[canonicalizeJcs(ref(one)), one]])), {
    message: 'invalid_writer_causal_chain',
  });
  assert.equal(validityOf(await replayVerifiedHistoryV1([one, malformed]), malformed).error, 'invalid_writer_causal_chain');
});

test('adversarial writer links and malformed commit batches are rejected deterministically', () => {
  const prior = recordCreate(5, 5);
  const proper = recordUpdate({
    number: 6, writerNumber: 5, seq: 2, previous: prior, basis: [prior],
    patch: { notes: 'next' }, changedFields: ['notes'],
  });
  const verified = new Map([[refKey(ref(prior)), prior]]);
  const cases = [];
  const gap = structuredClone(proper);
  gap.writerSeq = '3';
  cases.push(gap);
  const missingOwn = structuredClone(proper);
  missingOwn.basisClock = [];
  cases.push(missingOwn);
  const mismatchedOwn = structuredClone(proper);
  mismatchedOwn.basisClock[0].commitId = uuid(999);
  cases.push(mismatchedOwn);
  const mismatchedHash = structuredClone(proper);
  mismatchedHash.previousWriterCommit.contentHash = 'f'.repeat(64);
  cases.push(mismatchedHash);
  const seqOneOwnBasis = structuredClone(prior);
  seqOneOwnBasis.basisClock = [ref(prior)];
  cases.push(seqOneOwnBasis);
  for (const candidate of cases) {
    assert.throws(() => validateWriterChainLinkV1(candidate, verified), { message: 'invalid_writer_causal_chain' });
  }

  const duplicate = structuredClone(prior);
  duplicate.mutations.push(structuredClone(duplicate.mutations[0]));
  assert.throws(() => validateCommitEnvelopeV1(duplicate), { message: 'duplicate_local_mutation_id' });
  duplicate.mutations[1].localMutationId = uuid(998);
  assert.throws(() => validateCommitEnvelopeV1(duplicate), { message: 'duplicate_entity_key' });
  const feature = structuredClone(prior);
  feature.requiredFeatures = ['future-feature'];
  assert.throws(() => validateCommitEnvelopeV1(feature), { message: 'unsupported_required_feature' });
});

test('frozen raw wire decoder enforces required nullable fields, numeric versions, and UUIDv4', async () => {
  const internal = recordCreate(6, 6);
  const wire = structuredClone(causalFixture.rawWireCommit);
  const decoded = await decodeFrozenWireCommitV1(JSON.stringify(wire));
  assert.equal(decoded.protocolVersion, 1);
  assert.equal(decoded.s2SemanticProfileVersion, 1);
  assert.equal(decoded.source.type, 'native');
  assert.equal(decoded.mutations[0].entityType, 'collection');
  assert.match(decoded.contentHash, /^[0-9a-f]{64}$/);

  const missingPrevious = structuredClone(wire);
  delete missingPrevious.previousWriterCommit;
  await assert.rejects(decodeFrozenWireCommitV1(JSON.stringify(missingPrevious)), { message: 'invalid_commit_envelope' });
  const stringVersion = structuredClone(wire);
  stringVersion.protocolVersion = '1';
  await assert.rejects(decodeFrozenWireCommitV1(JSON.stringify(stringVersion)), { message: 'unsupported_protocol_version' });
  const bootstrap = structuredClone(wire);
  bootstrap.commitKind = 'bootstrap';
  bootstrap.source.type = 'legacy-bootstrap';
  assert.equal((await decodeFrozenWireCommitV1(JSON.stringify(bootstrap))).source.type, 'legacy-bootstrap');

  for (const bad of [
    '10000000-0000-1000-8000-000000000006',
    '10000000-0000-7000-8000-000000000006',
    '10000000-0000-4000-8000-00000000000A',
    'not-a-uuid',
  ]) {
    const candidate = structuredClone(internal);
    candidate.writerId = bad;
    assert.throws(() => validateCommitEnvelopeV1(candidate));
  }
  validateCommitEnvelopeV1(internal);
});

test('strict raw byte fixture has identical accept/reject and exact-hash semantics', async () => {
  assert.equal(rawWireFixture.cases.length, 20);
  for (const vector of rawWireFixture.cases) {
    const bytes = Buffer.from(vector.utf8Base64, 'base64');
    assert.equal(await sha256Hex(bytes), vector.expectedContentHash, `${vector.name}: raw hash oracle`);
    if (vector.expected === 'accept') {
      const decoded = await decodeFrozenWireCommitV1(bytes);
      assert.equal(decoded.contentHash, vector.expectedContentHash, vector.name);
      assert.equal(
        canonicalizeJcs(decoded),
        canonicalizeJcs(vector.expectedNormalizedCommit),
        `${vector.name}: normalized commit`,
      );
      if (vector.name === 'canonical-mutation-resolves-absent') {
        assert.equal(decoded.commitKind, 'mutation');
        assert.deepEqual(decoded.resolves, []);
      } else if (vector.name === 'canonical-resolution') {
        assert.equal(decoded.commitKind, 'resolution');
        assert.equal(decoded.source.type, 'manual-resolution');
      } else if (vector.name === 'legacy-bootstrap' || vector.name === 'new-root-bootstrap') {
        assert.equal(decoded.commitKind, 'bootstrap');
        assert.deepEqual(decoded.resolves, []);
        assert.equal(validityOf(await replayVerifiedHistoryV1([decoded]), decoded).state, 'VALID');
      } else if (vector.name === 'safe-integer-lexical-float') {
        assert.equal(decoded.mutations[0].entityKey[2], 5);
        assert.equal(decoded.mutations[0].value.episodeNumber, 5);
      }
    } else {
      await assert.rejects(decodeFrozenWireCommitV1(bytes), undefined, vector.name);
    }
  }
  const bom = rawWireFixture.cases.find(vector => vector.name === 'utf8-bom');
  await assert.rejects(decodeFrozenWireCommitV1(Buffer.from(bom.utf8Base64, 'base64')), {
    message: 'invalid_commit_json_bytes',
  });
});

test('bootstrap shares every non-resolution conflict and lock safety gate', async () => {
  const asBootstrap = (value, source) => {
    value.commitKind = 'bootstrap';
    value.source = { type: source };
    value.resolves = [];
    return value;
  };
  const parent = commit({
    number: 950, writerNumber: 950,
    mutations: [mutation(950, ['collection', 'bootstrap-conflict'], 'upsert', {
      ...fullCollection('bootstrap-conflict'), description: 'base',
    }, [], BUSINESS_FIELD_ORDER.collection)],
  });
  const left = commit({
    number: 951, writerNumber: 951, basis: [parent],
    mutations: [mutation(951, ['collection', 'bootstrap-conflict'], 'upsert', {
      ...fullCollection('bootstrap-conflict'), description: 'left',
    }, [ref(parent)], ['description'])],
  });
  const right = commit({
    number: 952, writerNumber: 952, basis: [parent],
    mutations: [mutation(952, ['collection', 'bootstrap-conflict'], 'upsert', {
      ...fullCollection('bootstrap-conflict'), description: 'right',
    }, [ref(parent)], ['description'])],
  });
  for (const [offset, source] of [[0, 'legacy-bootstrap'], [1, 'new-root-bootstrap']]) {
    const bootstrap = asBootstrap(commit({
      number: 953 + offset, writerNumber: 953 + offset, basis: [left, right],
      mutations: [mutation(
        953 + offset,
        ['collection', 'bootstrap-conflict'],
        'tombstone',
        tombstone('bootstrap-conflict'),
        sortedRefs([ref(left), ref(right)]),
        ['$tombstone'],
      )],
    }), source);
    const replay = await replayVerifiedHistoryV1([parent, left, right, bootstrap]);
    assert.equal(validityOf(replay, bootstrap).error, 'ordinary_mutation_blocked_by_entity_conflict');
  }
  const ordinary = commit({
    number: 955, writerNumber: 955, basis: [left, right],
    mutations: [mutation(955, ['collection', 'bootstrap-conflict'], 'tombstone',
      tombstone('bootstrap-conflict'), sortedRefs([ref(left), ref(right)]), ['$tombstone'])],
  });
  assert.equal(validityOf(await replayVerifiedHistoryV1([parent, left, right, ordinary]), ordinary).error,
    'ordinary_mutation_blocked_by_entity_conflict');

  const relationParent = commit({
    number: 960, writerNumber: 960,
    mutations: [
      mutation(9601, ['record', 'bootstrap-relation'], 'upsert', fullRecord('bootstrap-relation', {
        totalEpisodes: 7,
      }), [], BUSINESS_FIELD_ORDER.record),
      mutation(9602, ['episode-completion', 'bootstrap-relation', 5], 'upsert', {
        id: await deterministicEntityIdV1('episode-completion:v1', ['bootstrap-relation', 5]),
        recordId: 'bootstrap-relation', episodeNumber: 5, completedAt: null,
        createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
      }, [], BUSINESS_FIELD_ORDER['episode-completion']),
      mutation(9603, ['episode-completion', 'bootstrap-relation', 7], 'upsert', {
        id: await deterministicEntityIdV1('episode-completion:v1', ['bootstrap-relation', 7]),
        recordId: 'bootstrap-relation', episodeNumber: 7, completedAt: null,
        createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
      }, [], BUSINESS_FIELD_ORDER['episode-completion']),
    ],
  });
  const shrink = commit({
    number: 961, writerNumber: 961, basis: [relationParent],
    mutations: [mutation(961, ['record', 'bootstrap-relation'], 'upsert', fullRecord('bootstrap-relation', {
      totalEpisodes: 3,
    }), [ref(relationParent)], ['totalEpisodes'])],
  });
  for (const [offset, source] of [[0, 'legacy-bootstrap'], [1, 'new-root-bootstrap']]) {
    const bootstrap = asBootstrap(commit({
      number: 962 + offset, writerNumber: 962 + offset, basis: [shrink],
      mutations: [mutation(962 + offset, ['record', 'bootstrap-relation'], 'upsert',
        fullRecord('bootstrap-relation', { totalEpisodes: 7 }), [ref(shrink)], ['totalEpisodes'])],
    }), source);
    assert.equal(validityOf(await replayVerifiedHistoryV1([
      relationParent, shrink, bootstrap,
    ]), bootstrap).error, 'ordinary_mutation_blocked_by_relation_conflict');
  }

  const locked = commit({
    number: 970, writerNumber: 970,
    mutations: [mutation(970, ['record', 'bootstrap-locked'], 'upsert', fullRecord('bootstrap-locked', {
      isLocked: true,
    }), [], BUSINESS_FIELD_ORDER.record)],
  });
  for (const [offset, source] of [[0, 'legacy-bootstrap'], [1, 'new-root-bootstrap']]) {
    const bootstrap = asBootstrap(commit({
      number: 971 + offset, writerNumber: 971 + offset, basis: [locked],
      mutations: [mutation(971 + offset, ['record', 'bootstrap-locked'], 'upsert',
        fullRecord('bootstrap-locked', { isLocked: true, notes: 'forbidden' }),
        [ref(locked)], ['notes'])],
    }), source);
    assert.equal(validityOf(await replayVerifiedHistoryV1([locked, bootstrap]), bootstrap).error,
      'ordinary_mutation_blocked_by_lock');
  }

  const cleanLegacy = asBootstrap(commit({
    number: 980, writerNumber: 980,
    mutations: [
      mutation(9801, ['record', 'bootstrap-clean'], 'upsert', fullRecord('bootstrap-clean', {
        totalEpisodes: 5,
      }), [], BUSINESS_FIELD_ORDER.record),
      mutation(9802, ['episode-completion', 'bootstrap-clean', 5], 'upsert', {
        id: await deterministicEntityIdV1('episode-completion:v1', ['bootstrap-clean', 5]),
        recordId: 'bootstrap-clean', episodeNumber: 5, completedAt: null,
        createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
      }, [], BUSINESS_FIELD_ORDER['episode-completion']),
    ],
  }), 'legacy-bootstrap');
  assert.equal(validityOf(await replayVerifiedHistoryV1([cleanLegacy]), cleanLegacy).state, 'VALID');

  const cleanNewRoot = asBootstrap(commit({
    number: 981, writerNumber: 981,
    mutations: [
      mutation(9811, ['collection', 'bootstrap-clean'], 'upsert', fullCollection('bootstrap-clean'), [], BUSINESS_FIELD_ORDER.collection),
      mutation(9812, ['record', 'bootstrap-member-record'], 'upsert', fullRecord('bootstrap-member-record'), [], BUSINESS_FIELD_ORDER.record),
      mutation(9813, ['collection-member', 'bootstrap-clean', 'bootstrap-member-record'], 'upsert', {
        id: await deterministicEntityIdV1('collection-member:v1', ['bootstrap-clean', 'bootstrap-member-record']),
        collectionId: 'bootstrap-clean', recordId: 'bootstrap-member-record', position: '0', sourceKind: 'manual',
        createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
      }, [], BUSINESS_FIELD_ORDER['collection-member']),
    ],
  }), 'new-root-bootstrap');
  assert.equal(validityOf(await replayVerifiedHistoryV1([cleanNewRoot]), cleanNewRoot).state, 'VALID');
});

test('deterministically generated commit corruptions have stable validity outcomes', async () => {
  const base = recordCreate(7, 7);
  const proper = recordUpdate({
    number: 8, writerNumber: 7, seq: 2, previous: base, basis: [base],
    patch: { notes: 'next' }, changedFields: ['notes'],
  });
  let state = 0xc0ffee12;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const mode = state % 5;
    const candidate = structuredClone(proper);
    let inputs = [base, candidate];
    let expected;
    if (mode === 0) {
      candidate.previousWriterCommit.contentHash = 'f'.repeat(64);
      expected = { state: 'INVALID', error: 'invalid_writer_causal_chain' };
    } else if (mode === 1) {
      const alternateBase = structuredClone(base);
      alternateBase.commitId = uuid(997);
      candidate.basisClock = [ref(alternateBase)];
      inputs = [alternateBase, candidate];
      expected = { state: 'INVALID', error: 'invalid_writer_causal_chain' };
    } else if (mode === 2) {
      inputs = [candidate];
      expected = { state: 'PENDING' };
    } else if (mode === 3) {
      candidate.mutations[0].baseFrontier = [];
      expected = { state: 'INVALID', error: 'invalid_entity_base_frontier' };
    } else {
      const copy = structuredClone(candidate.mutations[0]);
      copy.localMutationId = uuid(996);
      candidate.mutations.push(copy);
      expected = { state: 'INVALID', error: 'duplicate_entity_key' };
    }
    const first = validityOf(await replayVerifiedHistoryV1(inputs), candidate);
    const second = validityOf(await replayVerifiedHistoryV1(permute(inputs, state)), candidate);
    assert.deepEqual(first, expected);
    assert.deepEqual(second, expected);
  }
});

test('dependency graph keeps transitive missing pending and classifies only true cycles invalid', async () => {
  const a = recordCreate(70, 70);
  const b = recordUpdate({ number: 71, writerNumber: 71, basis: [a], patch: { notes: 'B' }, changedFields: ['notes'] });
  const c = recordUpdate({ number: 72, writerNumber: 72, basis: [b], patch: { notes: 'C' }, changedFields: ['notes'] });
  let replay = await replayVerifiedHistoryV1([c, b]);
  assert.equal(validityOf(replay, b).state, 'PENDING');
  assert.equal(validityOf(replay, c).state, 'PENDING');
  replay = await replayVerifiedHistoryV1([c, a, b]);
  assert.equal(validityOf(replay, c).state, 'VALID');

  const invalidDependency = recordCreate(73, 73);
  invalidDependency.protocol = 'invalid';
  const missing = recordCreate(74, 74);
  const mixed = commit({
    number: 75, writerNumber: 75, basis: [invalidDependency, missing],
    mutations: [mutation(75, ['collection', 'mixed'], 'upsert', fullCollection('mixed'), [], BUSINESS_FIELD_ORDER.collection)],
  });
  replay = await replayVerifiedHistoryV1([mixed, invalidDependency]);
  assert.deepEqual(validityOf(replay, mixed), { state: 'INVALID', error: 'invalid_causal_dependency' });

  const external = commit({
    number: 751, writerNumber: 751,
    mutations: [mutation(751, ['collection', 'external'], 'upsert', fullCollection('external'), [], BUSINESS_FIELD_ORDER.collection)],
  });
  const externalCycleA = commit({
    number: 752, writerNumber: 752,
    mutations: [mutation(752, ['collection', 'external-cycle-a'], 'upsert', fullCollection('external-cycle-a'), [], BUSINESS_FIELD_ORDER.collection)],
  });
  const externalCycleB = commit({
    number: 753, writerNumber: 753,
    mutations: [mutation(753, ['collection', 'external-cycle-b'], 'upsert', fullCollection('external-cycle-b'), [], BUSINESS_FIELD_ORDER.collection)],
  });
  const externalCycleChild = commit({
    number: 754, writerNumber: 754,
    mutations: [mutation(754, ['collection', 'external-cycle-child'], 'upsert', fullCollection('external-cycle-child'), [], BUSINESS_FIELD_ORDER.collection)],
  });
  externalCycleA.basisClock = sortedRefs([ref(externalCycleB), ref(external)]);
  externalCycleB.basisClock = [ref(externalCycleA)];
  externalCycleChild.basisClock = [ref(externalCycleA)];
  for (const inputs of [
    [externalCycleA, externalCycleB, externalCycleChild],
    [externalCycleA, externalCycleB, externalCycleChild, external],
  ]) {
    replay = await replayVerifiedHistoryV1(inputs);
    assert.equal(validityOf(replay, externalCycleA).error, 'causal_cycle');
    assert.equal(validityOf(replay, externalCycleB).error, 'causal_cycle');
    assert.equal(validityOf(replay, externalCycleChild).error, 'invalid_causal_dependency');
  }
  assert.equal(validityOf(replay, external).state, 'VALID');

  const externalSelf = commit({
    number: 755, writerNumber: 755,
    mutations: [mutation(755, ['collection', 'external-self'], 'upsert', fullCollection('external-self'), [], BUSINESS_FIELD_ORDER.collection)],
  });
  externalSelf.basisClock = sortedRefs([ref(externalSelf), ref(external)]);
  assert.equal(
    validityOf(await replayVerifiedHistoryV1([externalSelf]), externalSelf).error,
    'causal_cycle',
  );

  const cycleA = recordCreate(76, 76);
  const cycleB = recordCreate(77, 77);
  cycleA.basisClock = [ref(cycleB)];
  cycleB.basisClock = [ref(cycleA)];
  const cycleDescendant = recordUpdate({
    number: 78, writerNumber: 78, basis: [cycleA], patch: { notes: 'descendant' }, changedFields: ['notes'],
  });
  replay = await replayVerifiedHistoryV1([cycleDescendant, cycleB, cycleA]);
  assert.equal(validityOf(replay, cycleA).error, 'causal_cycle');
  assert.equal(validityOf(replay, cycleB).error, 'causal_cycle');
  assert.equal(validityOf(replay, cycleDescendant).error, 'invalid_causal_dependency');

  const cycleC = recordCreate(79, 79);
  cycleA.basisClock = [ref(cycleB)];
  cycleB.basisClock = [ref(cycleC)];
  cycleC.basisClock = [ref(cycleA)];
  replay = await replayVerifiedHistoryV1([cycleC, cycleA, cycleB]);
  assert.ok([cycleA, cycleB, cycleC].every(item => validityOf(replay, item).error === 'causal_cycle'));

  const diamondD = commit({
    number: 790, writerNumber: 790,
    mutations: [mutation(790, ['collection', 'diamond-d'], 'upsert', fullCollection('diamond-d'), [], BUSINESS_FIELD_ORDER.collection)],
  });
  const diamondC = commit({
    number: 791, writerNumber: 791, basis: [diamondD],
    mutations: [mutation(791, ['collection', 'diamond-c'], 'upsert', fullCollection('diamond-c'), [], BUSINESS_FIELD_ORDER.collection)],
  });
  const diamondB = commit({
    number: 792, writerNumber: 792, basis: [diamondC],
    mutations: [mutation(792, ['collection', 'diamond-b'], 'upsert', fullCollection('diamond-b'), [], BUSINESS_FIELD_ORDER.collection)],
  });
  const diamondA = commit({
    number: 793, writerNumber: 793, basis: [diamondB, diamondC],
    mutations: [mutation(793, ['collection', 'diamond-a'], 'upsert', fullCollection('diamond-a'), [], BUSINESS_FIELD_ORDER.collection)],
  });
  replay = await replayVerifiedHistoryV1([diamondA, diamondB, diamondC]);
  assert.ok([diamondA, diamondB, diamondC].every(item => validityOf(replay, item).state === 'PENDING'));
  replay = await replayVerifiedHistoryV1([diamondA, diamondB, diamondC, diamondD]);
  assert.ok([diamondA, diamondB, diamondC, diamondD].every(item => validityOf(replay, item).state === 'VALID'));
});

test('Tarjan classification matches an independent exhaustive three-node graph oracle', async () => {
  const nodeCount = 3;
  const edgeSlots = [];
  for (let from = 0; from < nodeCount; from += 1) {
    for (let to = 0; to < nodeCount; to += 1) if (from !== to) edgeSlots.push([from, to]);
  }
  for (let mask = 0; mask < (1 << edgeSlots.length); mask += 1) {
    const nodes = Array.from({ length: nodeCount }, (_, index) => commit({
      number: 8_000 + mask * 10 + index,
      writerNumber: 8_000 + mask * 10 + index,
      mutations: [mutation(
        8_000 + mask * 10 + index,
        ['collection', `graph-${mask}-${index}`],
        'upsert',
        fullCollection(`graph-${mask}-${index}`),
        [],
        BUSINESS_FIELD_ORDER.collection,
      )],
    }));
    const edges = Array.from({ length: nodeCount }, () => []);
    edgeSlots.forEach(([from, to], bit) => {
      if ((mask & (1 << bit)) !== 0) edges[from].push(to);
    });
    nodes.forEach((node, index) => {
      node.basisClock = sortedRefs(edges[index].map(target => ref(nodes[target])));
    });

    const reaches = (from, target, seen = new Set()) => {
      for (const next of edges[from]) {
        if (next === target) return true;
        if (!seen.has(next)) {
          seen.add(next);
          if (reaches(next, target, seen)) return true;
        }
      }
      return false;
    };
    const cycleNodes = new Set(nodes.map((_, index) => index).filter(index => reaches(index, index)));
    const expected = nodes.map((_, index) => {
      if (cycleNodes.has(index)) return { state: 'INVALID', error: 'causal_cycle' };
      if ([...cycleNodes].some(cycle => reaches(index, cycle))) {
        return { state: 'INVALID', error: 'invalid_causal_dependency' };
      }
      return { state: 'VALID' };
    });
    const replay = await replayVerifiedHistoryV1(permute(nodes, mask));
    nodes.forEach((node, index) => assert.deepEqual(validityOf(replay, node), expected[index], `graph mask ${mask}`));
  }

  const self = commit({
    number: 9_000, writerNumber: 9_000,
    mutations: [mutation(9_000, ['collection', 'self-loop'], 'upsert', fullCollection('self-loop'), [], BUSINESS_FIELD_ORDER.collection)],
  });
  self.basisClock = [ref(self)];
  assert.deepEqual(validityOf(await replayVerifiedHistoryV1([self]), self), {
    state: 'INVALID', error: 'causal_cycle',
  });
});

test('SCC classification matches 448 independent external-missing graph variants', async () => {
  const nodeCount = 3;
  const edgeSlots = [];
  for (let from = 0; from < nodeCount; from += 1) {
    for (let to = 0; to < nodeCount; to += 1) if (from !== to) edgeSlots.push([from, to]);
  }
  for (let mask = 0; mask < (1 << edgeSlots.length); mask += 1) {
    for (let missingMask = 1; missingMask < (1 << nodeCount); missingMask += 1) {
      const baseNumber = 20_000 + mask * 100 + missingMask * 10;
      const nodes = Array.from({ length: nodeCount }, (_, index) => commit({
        number: baseNumber + index,
        writerNumber: baseNumber + index,
        mutations: [mutation(baseNumber + index, ['collection', `missing-${mask}-${missingMask}-${index}`],
          'upsert', fullCollection(`missing-${mask}-${missingMask}-${index}`), [], BUSINESS_FIELD_ORDER.collection)],
      }));
      const missing = Array.from({ length: nodeCount }, (_, index) => commit({
        number: baseNumber + nodeCount + index,
        writerNumber: baseNumber + nodeCount + index,
        mutations: [mutation(baseNumber + nodeCount + index,
          ['collection', `absent-${mask}-${missingMask}-${index}`], 'upsert',
          fullCollection(`absent-${mask}-${missingMask}-${index}`), [], BUSINESS_FIELD_ORDER.collection)],
      }));
      const reach = Array.from({ length: nodeCount }, () => Array(nodeCount).fill(false));
      edgeSlots.forEach(([from, to], bit) => {
        if ((mask & (1 << bit)) !== 0) reach[from][to] = true;
      });
      nodes.forEach((node, index) => {
        const internal = nodes.filter((_, target) => reach[index][target]).map(ref);
        const external = (missingMask & (1 << index)) === 0 ? [] : [ref(missing[index])];
        node.basisClock = sortedRefs([...internal, ...external]);
      });
      for (let via = 0; via < nodeCount; via += 1) {
        for (let from = 0; from < nodeCount; from += 1) {
          for (let to = 0; to < nodeCount; to += 1) {
            reach[from][to] ||= reach[from][via] && reach[via][to];
          }
        }
      }
      const cycleNodes = new Set(nodes.map((_, index) => index).filter(index => reach[index][index]));
      const replay = await replayVerifiedHistoryV1(permute(nodes, mask * 8 + missingMask));
      nodes.forEach((node, index) => {
        let expected;
        if (cycleNodes.has(index)) expected = { state: 'INVALID', error: 'causal_cycle' };
        else if ([...cycleNodes].some(cycle => reach[index][cycle])) {
          expected = { state: 'INVALID', error: 'invalid_causal_dependency' };
        } else {
          const transitivelyMissing = (missingMask & (1 << index)) !== 0 || nodes.some((_, target) => (
            (missingMask & (1 << target)) !== 0 && reach[index][target]
          ));
          expected = transitivelyMissing ? { state: 'PENDING' } : { state: 'VALID' };
        }
        assert.deepEqual(validityOf(replay, node), expected, `graph=${mask} missing=${missingMask} node=${index}`);
      });
    }
  }
});

test('causal frontier, semantic equivalence, disjoint merge, and conflicts follow frozen precedence', async () => {
  const base = recordCreate(10, 10);
  const sameA = recordUpdate({ number: 11, writerNumber: 11, basis: [base], patch: { notes: 'same' }, changedFields: ['notes'] });
  const sameB = recordUpdate({ number: 12, writerNumber: 12, basis: [base], patch: { notes: 'same' }, changedFields: ['notes'] });
  sameB.mutations[0].value.updatedAt = '2026-09-06T13:00:00.000Z';
  let replay = await replayVerifiedHistoryV1([sameB, base, sameA]);
  let value = materializedOf(replay, ['record', 'r1']);
  assert.equal(value.state, 'Resolved');
  assert.equal(value.businessValue.notes, 'same');
  assert.equal(value.provenanceFrontier.length, 2);

  const note = recordUpdate({ number: 13, writerNumber: 13, basis: [base], patch: { notes: 'note' }, changedFields: ['notes'] });
  const rating = recordUpdate({ number: 14, writerNumber: 14, basis: [base], patch: { rating: 8 }, changedFields: ['rating'] });
  const platform = recordUpdate({ number: 141, writerNumber: 141, basis: [base], patch: { platform: 'web' }, changedFields: ['platform'] });
  replay = await replayVerifiedHistoryV1([platform, rating, base, note]);
  value = materializedOf(replay, ['record', 'r1']);
  assert.equal(value.state, 'Resolved');
  assert.equal(value.businessValue.notes, 'note');
  assert.equal(value.businessValue.rating, 8);
  assert.equal(value.businessValue.platform, 'web');
  assert.deepEqual(value.provenanceFrontier, sortedRefs([ref(note), ref(rating), ref(platform)]));

  const overlap = recordUpdate({ number: 15, writerNumber: 15, basis: [base], patch: { notes: 'other' }, changedFields: ['notes'] });
  assert.equal(materializedOf(await replayVerifiedHistoryV1([base, note, overlap]), ['record', 'r1']).conflictKind, 'overlapping-field');

  const nextBase = recordUpdate({ number: 16, writerNumber: 10, seq: 2, previous: base, basis: [base], patch: { platform: 'next' }, changedFields: ['platform'] });
  const descendant = recordUpdate({ number: 17, writerNumber: 16, basis: [nextBase], patch: { platform: 'next', rating: 7 }, changedFields: ['rating'] });
  assert.equal(materializedOf(await replayVerifiedHistoryV1([base, nextBase, descendant, note]), ['record', 'r1']).conflictKind, 'different-base');

  const deleted = commit({
    number: 18, writerNumber: 18, basis: [base],
    mutations: [mutation(18, ['record', 'r1'], 'tombstone', tombstone('r1'), [ref(base)], ['$tombstone'])],
  });
  assert.equal(materializedOf(await replayVerifiedHistoryV1([base, note, deleted]), ['record', 'r1']).conflictKind, 'live-tombstone');

  const locked = recordUpdate({ number: 19, writerNumber: 19, basis: [base], patch: { isLocked: true }, changedFields: ['isLocked'] });
  assert.equal(materializedOf(await replayVerifiedHistoryV1([base, locked, note]), ['record', 'r1']).conflictKind, 'locked-concurrent');

  const originalMissing = recordUpdate({ number: 20, writerNumber: 20, basis: [base], patch: { originalName: '' }, changedFields: ['originalName'] });
  const chineseMissing = recordUpdate({ number: 21, writerNumber: 21, basis: [base], patch: { chineseName: '' }, changedFields: ['chineseName'] });
  assert.equal(materializedOf(await replayVerifiedHistoryV1([base, originalMissing, chineseMissing]), ['record', 'r1']).conflictKind, 'derived-domain');

  const nullableLockBase = recordCreate(181, 181, { isLocked: null });
  const newerBase = recordUpdate({
    number: 182, writerNumber: 182, basis: [nullableLockBase], patch: { isLocked: null, platform: 'P' }, changedFields: ['platform'],
  });
  const differentBaseLock = recordUpdate({
    number: 183, writerNumber: 183, basis: [newerBase], patch: { platform: 'P', isLocked: true }, changedFields: ['isLocked'],
  });
  const olderBaseNotes = recordUpdate({
    number: 184, writerNumber: 184, basis: [nullableLockBase], patch: { isLocked: null, notes: 'parallel' }, changedFields: ['notes'],
  });
  assert.equal(materializedOf(await replayVerifiedHistoryV1([
    nullableLockBase, newerBase, differentBaseLock, olderBaseNotes,
  ]), ['record', 'r1']).conflictKind, 'locked-concurrent');
  const sameBaseTrue = recordUpdate({
    number: 185, writerNumber: 185, basis: [nullableLockBase], patch: { isLocked: true }, changedFields: ['isLocked'],
  });
  const sameBaseFalse = recordUpdate({
    number: 186, writerNumber: 186, basis: [nullableLockBase], patch: { isLocked: false }, changedFields: ['isLocked'],
  });
  assert.equal(materializedOf(await replayVerifiedHistoryV1([
    nullableLockBase, sameBaseTrue, sameBaseFalse,
  ]), ['record', 'r1']).conflictKind, 'locked-concurrent');
});

test('locked author basis permits only an isolated unlock and metadata-only mutation is invalid', async () => {
  const locked = recordCreate(25, 25, { isLocked: true });
  const edit = recordUpdate({
    number: 26, writerNumber: 25, seq: 2, previous: locked, basis: [locked],
    patch: { isLocked: true, notes: 'forbidden' }, changedFields: ['notes'],
  });
  let replay = await replayVerifiedHistoryV1([locked, edit]);
  assert.equal(validityOf(replay, edit).error, 'ordinary_mutation_blocked_by_lock');
  const unlock = recordUpdate({
    number: 27, writerNumber: 25, seq: 2, previous: locked, basis: [locked],
    patch: { isLocked: false }, changedFields: ['isLocked'],
  });
  replay = await replayVerifiedHistoryV1([locked, unlock]);
  assert.equal(validityOf(replay, unlock).state, 'VALID');
  const metadataOnly = recordUpdate({
    number: 28, writerNumber: 28, basis: [locked], patch: { isLocked: true }, changedFields: [],
  });
  metadataOnly.mutations[0].value.updatedAt = '2026-09-06T14:00:00.000Z';
  replay = await replayVerifiedHistoryV1([locked, metadataOnly]);
  assert.equal(validityOf(replay, metadataOnly).error, 'metadata_only_mutation');
});

test('missing dependencies stay pending and forks classify without choosing a winner', async () => {
  const base = recordCreate(30, 30);
  const missing = recordUpdate({ number: 31, writerNumber: 31, basis: [base], patch: { notes: 'pending' }, changedFields: ['notes'] });
  const pending = await replayVerifiedHistoryV1([missing]);
  assert.equal(validityOf(pending, missing).state, 'PENDING');

  const forkA = recordCreate(32, 32, { notes: 'A' });
  const forkB = recordCreate(33, 32, { notes: 'B' });
  const forks = detectWriterForksV1([forkB, forkA]);
  assert.equal(forks.length, 1);
  assert.equal(forks[0].safeWriterFrontier, '0');
  assert.deepEqual(forks[0].alternatives, sortedRefs([ref(forkA), ref(forkB)]));
});

test('fork branches and all causal descendants remain forensic-only in the safe view', async () => {
  const equivalentA = recordCreate(90, 90, { notes: 'same' });
  const equivalentB = recordCreate(91, 90, { notes: 'same' });
  const different = recordCreate(92, 90, { notes: 'different' });
  const ownDescendant = recordUpdate({
    number: 93, writerNumber: 90, seq: 2, previous: equivalentA, basis: [equivalentA],
    patch: { notes: 'own descendant' }, changedFields: ['notes'],
  });
  const crossDescendant = recordUpdate({
    number: 94, writerNumber: 94, basis: [different],
    patch: { notes: 'cross descendant' }, changedFields: ['notes'],
  });
  for (let seed = 0; seed < 16; seed += 1) {
    const replay = await replayVerifiedHistoryV1(permute([
      equivalentA, different, ownDescendant, crossDescendant,
    ], seed));
    assert.equal(replay.forks.length, 1);
    assert.equal(replay.forks[0].safeWriterFrontier, '0');
    assert.equal(replay.forensicVersions.length, 4);
    assert.equal(replay.versions.length, 0);
    assert.equal(replay.materialized.length, 0);
    assert.deepEqual(replay.unsafeCommitRefs, sortedRefs([
      ref(equivalentA), ref(different), ref(ownDescendant), ref(crossDescendant),
    ]));
  }

  const sameDotDifferentHash = structuredClone(equivalentA);
  sameDotDifferentHash.contentHash = 'f'.repeat(64);
  sameDotDifferentHash.mutations[0].value.updatedAt = '2026-09-06T11:00:00.000Z';
  const replay = await replayVerifiedHistoryV1([sameDotDifferentHash, equivalentA]);
  assert.equal(replay.forks.length, 1);
  assert.equal(replay.forensicVersions.length, 2);
  assert.equal(replay.versions.length, 0);

  const equivalentReplay = await replayVerifiedHistoryV1([equivalentB, equivalentA]);
  assert.equal(equivalentReplay.forensicVersions.length, 2);
  assert.equal(equivalentReplay.versions.length, 0);
});

test('relation detector emits exactly the four frozen kinds and blocks competing entity conflicts', async () => {
  const ra = phase0.refs.RA;
  const rb = phase0.refs.RB;
  const member = resolvedState('live', rb, { collectionId: 'c', recordId: 'r', position: '0', sourceKind: 'manual' });
  const episode = resolvedState('live', rb, { recordId: 'r', episodeNumber: 12, completedAt: null });
  const tomb = resolvedState('tombstone', ra);
  const record = resolvedState('live', ra, { totalEpisodes: 10 });
  const cases = [
    [
      [{ entityKey: ['collection', 'c'], value: tomb }, { entityKey: ['collection-member', 'c', 'r'], value: member }],
      'collection-deleted-member-live',
    ],
    [
      [{ entityKey: ['record', 'r'], value: tomb }, { entityKey: ['collection-member', 'c', 'r'], value: member }],
      'record-deleted-member-live',
    ],
    [
      [{ entityKey: ['record', 'r'], value: tomb }, { entityKey: ['episode-completion', 'r', 12], value: episode }],
      'record-deleted-episode-live',
    ],
    [
      [{ entityKey: ['record', 'r'], value: record }, { entityKey: ['episode-completion', 'r', 12], value: episode }],
      'episode-exceeds-total',
    ],
  ];
  for (const [entities, expected] of cases) {
    const actual = await detectWatchTrackerRelationsV1(entities);
    assert.deepEqual(actual.conflicts.map(item => item.core.relationKind), [expected]);
    assert.deepEqual(actual.blockedByEntityConflict, []);
  }
  const entityConflict = {
    state: 'Conflict', conflictId: '0'.repeat(64), conflictKind: 'overlapping-field',
    entityKey: ['record', 'r'], frontier: [ra, rb], conflictFields: ['notes'], semanticAlternatives: [],
  };
  const blocked = await detectWatchTrackerRelationsV1([
    { entityKey: ['record', 'r'], value: entityConflict },
    { entityKey: ['episode-completion', 'r', 12], value: episode },
  ]);
  assert.equal(blocked.conflicts.length, 0);
  assert.deepEqual(blocked.blockedByEntityConflict, [['episode-completion', 'r', 12], ['record', 'r']].sort((a, b) => (
    canonicalizeJcs(a) < canonicalizeJcs(b) ? -1 : 1
  )));
});

test('duplicate diagnostics preserve every entity and are insertion-order deterministic', () => {
  const ra = phase0.refs.RA;
  const rb = phase0.refs.RB;
  const recordA = resolvedState('live', ra, canonicalSemanticValue(fullRecord('r-a', { imdbId: 'tt123' })));
  const recordB = resolvedState('live', rb, canonicalSemanticValue(fullRecord('r-b', { imdbId: 'tt123' })));
  const collectionA = resolvedState('live', ra, canonicalSemanticValue(fullCollection('c-a')));
  const collectionB = resolvedState('live', rb, canonicalSemanticValue(fullCollection('c-b')));
  const entities = [
    { entityKey: ['record', 'r-a'], value: recordA },
    { entityKey: ['record', 'r-b'], value: recordB },
    { entityKey: ['collection', 'c-a'], value: collectionA },
    { entityKey: ['collection', 'c-b'], value: collectionB },
  ];
  const forward = detectDuplicateDiagnosticsV1(entities);
  const reverse = detectDuplicateDiagnosticsV1([...entities].reverse());
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.map(item => item.kind), [
    'duplicate-collection-normalized-name',
    'duplicate-record-external-identity',
  ]);
});

test('author-basis parent predicates are atomic and later relations are deterministic', async () => {
  const recordValue = fullRecord('r-parent', { totalEpisodes: 12, episodeTrackingEnabled: true });
  const collectionValue = fullCollection('c-parent');
  const memberId = await deterministicEntityIdV1('collection-member:v1', ['c-parent', 'r-parent']);
  const episodeId = await deterministicEntityIdV1('episode-completion:v1', ['r-parent', 12]);
  const parents = commit({
    number: 40,
    writerNumber: 40,
    mutations: [
      mutation(401, ['record', 'r-parent'], 'upsert', recordValue, [], BUSINESS_FIELD_ORDER.record),
      mutation(402, ['collection', 'c-parent'], 'upsert', collectionValue, [], BUSINESS_FIELD_ORDER.collection),
      mutation(403, ['episode-completion', 'r-parent', 12], 'upsert', {
        id: episodeId, recordId: 'r-parent', episodeNumber: 12, completedAt: null,
        createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
      }, [], BUSINESS_FIELD_ORDER['episode-completion']),
    ],
  });
  const member = commit({
    number: 41, writerNumber: 41, basis: [parents],
    mutations: [mutation(41, ['collection-member', 'c-parent', 'r-parent'], 'upsert', {
      id: memberId, collectionId: 'c-parent', recordId: 'r-parent', position: '0', sourceKind: 'manual',
      createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
    }, [], BUSINESS_FIELD_ORDER['collection-member'])],
  });
  // Member create sees no earlier member version, so its entity base is empty while parents are in basis.
  let replay = await replayVerifiedHistoryV1([member, parents]);
  assert.equal(validityOf(replay, parents).state, 'VALID');
  assert.equal(validityOf(replay, member).state, 'VALID');

  const deleteCollection = commit({
    number: 42, writerNumber: 42, basis: [parents],
    mutations: [mutation(42, ['collection', 'c-parent'], 'tombstone', tombstone('c-parent'), [ref(parents)], ['$tombstone'])],
  });
  replay = await replayVerifiedHistoryV1([parents, member, deleteCollection]);
  assert.deepEqual(replay.relations.conflicts.map(item => item.core.relationKind), ['collection-deleted-member-live']);

  const shrink = commit({
    number: 43, writerNumber: 43, basis: [parents],
    mutations: [mutation(43, ['record', 'r-parent'], 'upsert', {
      ...recordValue, totalEpisodes: 10,
    }, [ref(parents)], ['totalEpisodes'])],
  });
  replay = await replayVerifiedHistoryV1([parents, shrink]);
  assert.deepEqual(replay.relations.conflicts.map(item => item.core.relationKind), ['episode-exceeds-total']);
  const relationId = replay.relations.conflicts[0].relationConflictId;

  const ordinaryRepair = commit({
    number: 431, writerNumber: 44, basis: [shrink],
    mutations: [mutation(431, ['record', 'r-parent'], 'upsert', recordValue, [ref(shrink)], ['totalEpisodes'])],
  });
  replay = await replayVerifiedHistoryV1([parents, shrink, ordinaryRepair]);
  assert.equal(validityOf(replay, ordinaryRepair).error, 'ordinary_mutation_blocked_by_relation_conflict');

  const relationResolution = commit({
    number: 432, writerNumber: 45, basis: [shrink], resolution: [relationId],
    mutations: [
      mutation(4321, ['record', 'r-parent'], 'upsert', recordValue, [ref(shrink)], ['totalEpisodes']),
      mutation(4322, ['episode-completion', 'r-parent', 12], 'upsert', {
        id: episodeId, recordId: 'r-parent', episodeNumber: 12, completedAt: null,
        createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
      }, [ref(parents)], []),
    ],
  });
  replay = await replayVerifiedHistoryV1([relationResolution, shrink, parents]);
  assert.equal(validityOf(replay, relationResolution).state, 'VALID');
  assert.equal(replay.relations.conflicts.length, 0);

  const partialRelationResolution = commit({
    number: 433, writerNumber: 46, basis: [shrink], resolution: [relationId],
    mutations: [mutation(433, ['record', 'r-parent'], 'upsert', recordValue, [ref(shrink)], ['totalEpisodes'])],
  });
  replay = await replayVerifiedHistoryV1([parents, shrink, partialRelationResolution]);
  assert.equal(validityOf(replay, partialRelationResolution).error, 'incomplete_relation_resolution');

  const stillConflictingResolution = commit({
    number: 434, writerNumber: 47, basis: [shrink], resolution: [relationId],
    mutations: [
      mutation(4341, ['record', 'r-parent'], 'upsert', { ...recordValue, totalEpisodes: 11 }, [ref(shrink)], ['totalEpisodes']),
      mutation(4342, ['episode-completion', 'r-parent', 12], 'upsert', {
        id: episodeId, recordId: 'r-parent', episodeNumber: 12, completedAt: null,
        createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
      }, [ref(parents)], []),
    ],
  });
  replay = await replayVerifiedHistoryV1([parents, shrink, stillConflictingResolution]);
  assert.equal(validityOf(replay, stillConflictingResolution).error, 'invalid_episode_parent_basis');

  const badAtomic = structuredClone(parents);
  badAtomic.commitId = uuid(44);
  badAtomic.contentHash = hash(44);
  badAtomic.mutations[2].value.episodeNumber = 13;
  replay = await replayVerifiedHistoryV1([badAtomic]);
  assert.equal(validityOf(replay, badAtomic).state, 'INVALID');
  assert.equal(replay.versions.length, 0);

  const trackingOffParent = commit({
    number: 435, writerNumber: 48,
    mutations: [mutation(435, ['record', 'tracking-off'], 'upsert', fullRecord('tracking-off', {
      totalEpisodes: 10.0, episodeTrackingEnabled: false, nextEpisode: null,
    }), [], BUSINESS_FIELD_ORDER.record)],
  });
  const trackingOffEpisodeId = await deterministicEntityIdV1('episode-completion:v1', ['tracking-off', 5]);
  const trackingOffEpisode = commit({
    number: 436, writerNumber: 49, basis: [trackingOffParent],
    mutations: [mutation(436, ['episode-completion', 'tracking-off', 5.0], 'upsert', {
      id: trackingOffEpisodeId, recordId: 'tracking-off', episodeNumber: 5.0, completedAt: null,
      createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
    }, [], BUSINESS_FIELD_ORDER['episode-completion'])],
  });
  replay = await replayVerifiedHistoryV1([trackingOffEpisode, trackingOffParent]);
  assert.equal(validityOf(replay, trackingOffEpisode).state, 'VALID');
  const numericShrink = commit({
    number: 4361, writerNumber: 491, basis: [trackingOffParent],
    mutations: [mutation(4361, ['record', 'tracking-off'], 'upsert', fullRecord('tracking-off', {
      totalEpisodes: 3.0, episodeTrackingEnabled: false, nextEpisode: null,
    }), [ref(trackingOffParent)], ['totalEpisodes'])],
  });
  replay = await replayVerifiedHistoryV1([trackingOffEpisode, trackingOffParent, numericShrink]);
  assert.equal(replay.relations.conflicts[0].core.semanticRelationFacts.episodeNumber, 5);
  assert.equal(replay.relations.conflicts[0].core.semanticRelationFacts.totalEpisodes, 3);
  const numericOrdinary = commit({
    number: 4362, writerNumber: 492, basis: [numericShrink, trackingOffEpisode],
    mutations: [mutation(4362, ['record', 'tracking-off'], 'upsert', fullRecord('tracking-off', {
      totalEpisodes: 10.0, episodeTrackingEnabled: false, nextEpisode: null,
    }), [ref(numericShrink)], ['totalEpisodes'])],
  });
  replay = await replayVerifiedHistoryV1([trackingOffEpisode, trackingOffParent, numericShrink, numericOrdinary]);
  assert.equal(validityOf(replay, numericOrdinary).error, 'ordinary_mutation_blocked_by_relation_conflict');

  const recordDelete = mutation(4371, ['record', 'tracking-off'], 'tombstone', tombstone('tracking-off'),
    [ref(trackingOffParent)], ['$tombstone']);
  const episodeCreate = mutation(4372, ['episode-completion', 'tracking-off', 6], 'upsert', {
    id: await deterministicEntityIdV1('episode-completion:v1', ['tracking-off', 6]),
    recordId: 'tracking-off', episodeNumber: 6, completedAt: null,
    createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  }, [], BUSINESS_FIELD_ORDER['episode-completion']);
  for (const mutations of [[recordDelete, episodeCreate], [episodeCreate, recordDelete]]) {
    const batch = commit({ number: 437, writerNumber: 50, basis: [trackingOffParent], mutations });
    replay = await replayVerifiedHistoryV1([trackingOffParent, batch]);
    assert.equal(validityOf(replay, batch).error, 'invalid_episode_parent_basis');
    assert.equal(replay.forensicVersions.length, 1);
  }

  const collectionParent = commit({
    number: 438, writerNumber: 51,
    mutations: [
      mutation(4381, ['record', 'member-record'], 'upsert', fullRecord('member-record'), [], BUSINESS_FIELD_ORDER.record),
      mutation(4382, ['collection', 'member-collection'], 'upsert', fullCollection('member-collection'), [], BUSINESS_FIELD_ORDER.collection),
    ],
  });
  const collectionDelete = mutation(4391, ['collection', 'member-collection'], 'tombstone',
    tombstone('member-collection'), [ref(collectionParent)], ['$tombstone']);
  const memberCreate = mutation(4392, ['collection-member', 'member-collection', 'member-record'], 'upsert', {
    id: await deterministicEntityIdV1('collection-member:v1', ['member-collection', 'member-record']),
    collectionId: 'member-collection', recordId: 'member-record', position: '0', sourceKind: 'manual',
    createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  }, [], BUSINESS_FIELD_ORDER['collection-member']);
  for (const mutations of [[collectionDelete, memberCreate], [memberCreate, collectionDelete]]) {
    const batch = commit({ number: 439, writerNumber: 52, basis: [collectionParent], mutations });
    replay = await replayVerifiedHistoryV1([collectionParent, batch]);
    assert.equal(validityOf(replay, batch).error, 'invalid_member_parent_basis');
    assert.equal(replay.forensicVersions.length, 2);
  }

  const episodeValue = async episodeNumber => ({
    id: await deterministicEntityIdV1('episode-completion:v1', ['multi', episodeNumber]),
    recordId: 'multi', episodeNumber, completedAt: null,
    createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  });
  const multiParent = commit({
    number: 440, writerNumber: 53,
    mutations: [
      mutation(4401, ['record', 'multi'], 'upsert', fullRecord('multi', { totalEpisodes: 7 }), [], BUSINESS_FIELD_ORDER.record),
      mutation(4402, ['episode-completion', 'multi', 5], 'upsert', await episodeValue(5), [], BUSINESS_FIELD_ORDER['episode-completion']),
      mutation(4403, ['episode-completion', 'multi', 7], 'upsert', await episodeValue(7), [], BUSINESS_FIELD_ORDER['episode-completion']),
    ],
  });
  const multiShrink = commit({
    number: 441, writerNumber: 54, basis: [multiParent],
    mutations: [mutation(441, ['record', 'multi'], 'upsert', fullRecord('multi', { totalEpisodes: 3 }),
      [ref(multiParent)], ['totalEpisodes'])],
  });
  replay = await replayVerifiedHistoryV1([multiParent, multiShrink]);
  assert.equal(replay.relations.conflicts.length, 2);
  const byEpisode = new Map(replay.relations.conflicts.map(conflict => (
    [conflict.core.semanticRelationFacts.episodeNumber, conflict.relationConflictId]
  )));
  const resolveSevenOnly = commit({
    number: 442, writerNumber: 55, basis: [multiShrink], resolution: [byEpisode.get(7)],
    mutations: [
      mutation(4421, ['record', 'multi'], 'upsert', fullRecord('multi', { totalEpisodes: 7 }), [ref(multiShrink)], ['totalEpisodes']),
      mutation(4422, ['episode-completion', 'multi', 7], 'upsert', await episodeValue(7), [ref(multiParent)], []),
    ],
  });
  replay = await replayVerifiedHistoryV1([multiParent, multiShrink, resolveSevenOnly]);
  assert.equal(validityOf(replay, resolveSevenOnly).error, 'incomplete_relation_resolution');
  const resolveBoth = commit({
    number: 443, writerNumber: 56, basis: [multiShrink],
    resolution: [byEpisode.get(5), byEpisode.get(7)],
    mutations: [
      mutation(4431, ['record', 'multi'], 'upsert', fullRecord('multi', { totalEpisodes: 7 }), [ref(multiShrink)], ['totalEpisodes']),
      mutation(4432, ['episode-completion', 'multi', 5], 'upsert', await episodeValue(5), [ref(multiParent)], []),
      mutation(4433, ['episode-completion', 'multi', 7], 'upsert', await episodeValue(7), [ref(multiParent)], []),
    ],
  });
  replay = await replayVerifiedHistoryV1([resolveBoth, multiShrink, multiParent]);
  assert.equal(validityOf(replay, resolveBoth).state, 'VALID');
  assert.equal(replay.relations.conflicts.length, 0);
});

test('entity and relation conflict gates require exact explicit resolution', async () => {
  const base = recordCreate(50, 50);
  const a = recordUpdate({ number: 51, writerNumber: 51, basis: [base], patch: { notes: 'A' }, changedFields: ['notes'] });
  const b = recordUpdate({ number: 52, writerNumber: 52, basis: [base], patch: { notes: 'B' }, changedFields: ['notes'] });
  const conflicted = await replayVerifiedHistoryV1([base, a, b]);
  const conflict = materializedOf(conflicted, ['record', 'r1']);
  assert.equal(conflict.state, 'Conflict');

  const ordinary = recordUpdate({
    number: 53, writerNumber: 53, basis: [a, b], patch: { notes: 'resolved' },
    changedFields: BUSINESS_FIELD_ORDER.record,
  });
  assert.equal(validityOf(await replayVerifiedHistoryV1([base, a, b, ordinary]), ordinary).error,
    'ordinary_mutation_blocked_by_entity_conflict');
  const incompleteBase = structuredClone(ordinary);
  incompleteBase.commitId = uuid(531);
  incompleteBase.contentHash = hash(531);
  incompleteBase.mutations[0].baseFrontier = [ref(a)];
  assert.equal(validityOf(await replayVerifiedHistoryV1([base, a, b, incompleteBase]), incompleteBase).error,
    'invalid_entity_base_frontier');

  const resolution = recordUpdate({
    number: 54, writerNumber: 54, basis: [a, b], patch: { notes: 'resolved' },
    changedFields: BUSINESS_FIELD_ORDER.record, resolution: [conflict.conflictId],
  });
  let replay = await replayVerifiedHistoryV1([resolution, b, base, a]);
  assert.equal(validityOf(replay, resolution).state, 'VALID');
  assert.equal(materializedOf(replay, ['record', 'r1']).businessValue.notes, 'resolved');

  const mixedResolution = structuredClone(resolution);
  mixedResolution.commitId = uuid(541);
  mixedResolution.contentHash = hash(541);
  mixedResolution.mutations.push(mutation(
    541,
    ['collection', 'unrelated'],
    'upsert',
    fullCollection('unrelated'),
    [],
    BUSINESS_FIELD_ORDER.collection,
  ));
  replay = await replayVerifiedHistoryV1([base, a, b, mixedResolution]);
  assert.equal(validityOf(replay, mixedResolution).error, 'invalid_resolution_composition');

  const stale = recordUpdate({
    number: 55, writerNumber: 55, basis: [a, b], patch: { notes: 'stale' },
    changedFields: BUSINESS_FIELD_ORDER.record, resolution: ['f'.repeat(64)],
  });
  assert.equal(validityOf(await replayVerifiedHistoryV1([base, a, b, stale]), stale).error, 'stale_resolution');

  const late = recordUpdate({ number: 56, writerNumber: 49, basis: [base], patch: { platform: 'late' }, changedFields: ['platform'] });
  replay = await replayVerifiedHistoryV1([base, a, b, resolution, late]);
  assert.equal(validityOf(replay, resolution).state, 'VALID');
  assert.equal(materializedOf(replay, ['record', 'r1']).state, 'Conflict');
  assert.deepEqual(replay.frontiers[0].frontier, sortedRefs([ref(resolution), ref(late)]));
});

test('DAG/reducer replay is invariant across input, topological, and cache reconstruction order', async () => {
  const base = recordCreate(60, 60);
  const a = recordUpdate({ number: 61, writerNumber: 61, basis: [base], patch: { notes: 'A' }, changedFields: ['notes'] });
  const b = recordUpdate({ number: 62, writerNumber: 62, basis: [base], patch: { rating: 9 }, changedFields: ['rating'] });
  const observed = recordUpdate({
    number: 63, writerNumber: 61, seq: 2, previous: a, basis: [a, b],
    patch: { notes: 'A', rating: 9, platform: 'P' }, changedFields: ['platform'],
  });
  const commits = [base, a, b, observed];
  const baseline = canonicalizeJcs(await replayVerifiedHistoryV1(commits));
  for (let seed = 0; seed < 64; seed += 1) {
    assert.equal(canonicalizeJcs(await replayVerifiedHistoryV1(permute(commits, seed))), baseline);
  }
  const replay = await replayVerifiedHistoryV1(commits);
  const map = new Map(commits.map(item => [
    `${item.writerId}\0${item.writerSeq}\0${item.commitId}\0${item.contentHash}`,
    item,
  ]));
  const entityVersions = replay.versions.filter(version => version.entityKey[0] === 'record');
  const frontier = computeEntityFrontierV1(entityVersions, map);
  assert.equal(frontier.length, 1);
  assert.deepEqual(frontier[0].commitRef, ref(observed));

  assert.equal(
    canonicalizeJcs(await replayVerifiedHistoryV1([base, structuredClone(base)])),
    canonicalizeJcs(await replayVerifiedHistoryV1([base])),
  );
  const collision = structuredClone(base);
  collision.mutations[0].value.updatedAt = '2026-09-06T11:00:00.000Z';
  for (const ordered of [[base, collision], [base, collision, base], [collision, base, collision]]) {
    const collided = await replayVerifiedHistoryV1(ordered);
    assert.deepEqual(collided.validity, [{
      commitRef: ref(base),
      validity: { state: 'INVALID', error: 'duplicate_commit_ref' },
    }]);
    assert.equal(collided.versions.length, 0);
  }
});

test('deterministically generated causal DAG matches a reference transitive closure model', async () => {
  const commits = [];
  const ancestors = [];
  let state = 0x51a7c0de;
  for (let index = 0; index < 24; index += 1) {
    const parentIndexes = new Set();
    if (index > 0) {
      parentIndexes.add(index - 1);
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      parentIndexes.add(state % index);
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      parentIndexes.add(state % index);
    }
    const parentList = [...parentIndexes].sort((a, b) => a - b);
    const closure = new Set(parentList);
    for (const parent of parentList) for (const ancestor of ancestors[parent]) closure.add(ancestor);
    ancestors.push(closure);
    const id = `dag-${String(index).padStart(2, '0')}`;
    commits.push(commit({
      number: 100 + index,
      writerNumber: 100 + index,
      basis: parentList.map(parent => commits[parent]),
      mutations: [mutation(
        100 + index,
        ['collection', id],
        'upsert',
        fullCollection(id, { name: `D${index}`, normalizedName: `d${index}` }),
        [],
        BUSINESS_FIELD_ORDER.collection,
      )],
    }));
  }
  const replay = await replayVerifiedHistoryV1(permute(commits, 99));
  assert.equal(replay.validity.filter(item => item.validity.state === 'VALID').length, commits.length);
  const map = new Map(commits.map(item => [refKey(item), item]));
  for (let covering = 0; covering < commits.length; covering += 1) {
    for (let covered = 0; covered < commits.length; covered += 1) {
      assert.equal(
        causallyCoversV1(ref(commits[covering]), ref(commits[covered]), map),
        covering === covered || ancestors[covering].has(covered),
        `${covering} covers ${covered}`,
      );
    }
  }
  const baseline = canonicalizeJcs(await replayVerifiedHistoryV1(commits));
  for (let seed = 0; seed < 16; seed += 1) {
    assert.equal(canonicalizeJcs(await replayVerifiedHistoryV1(permute(commits, seed))), baseline);
  }
});
