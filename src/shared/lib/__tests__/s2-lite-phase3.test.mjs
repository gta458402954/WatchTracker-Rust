import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ActivationProtocolValidationFailureV1,
  buildCommitRemotePathV1,
  chooseHistoricalAuditTargetV1,
  classifyCandidatePathV1,
  createDiscoveryStateV1,
  decodeFrozenWireCommitV1,
  DiscoveryOperationalFailureV1,
  loadDiscoveryStateV1,
  observeCandidateListingV1,
  observeSegmentListingV1,
  observeWriterListingV1,
  parseActivationCandidatePathV1,
  parseWriterCandidatePathV1,
  persistDiscoveryStateV1,
  replayVerifiedHistoryV1,
  retainedVerifiedCommitBytesV1,
  runDiscoveryRoundV1,
  sha256Hex,
  verifyActivationCandidateV1,
  verifyCommitCandidateV1,
} from '../../../features/sync/s2lite/index.ts';

const fixture = JSON.parse(await readFile(new URL(
  '../../../../contracts/s2-lite/v1/discovery-golden-v1.json', import.meta.url,
)));
const rawFixture = JSON.parse(await readFile(new URL(
  '../../../../contracts/s2-lite/v1/raw-wire-json-v1.json', import.meta.url,
)));
const template = JSON.parse(Buffer.from(rawFixture.cases.find(item => (
  item.name === 'canonical-mutation-resolves-absent'
)).utf8Base64, 'base64').toString('utf8'));

function uuid(prefix, value) {
  return `${prefix}0000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function dummyRef(writerId, writerSeq, salt = 1) {
  return {
    writerId,
    writerSeq: String(writerSeq),
    commitId: uuid('2', salt),
    contentHash: String(salt % 10).repeat(64),
  };
}

async function makeCommit({ writerId = fixture.identities.writerA, seq = 1, salt = seq, previous = undefined }) {
  const wire = structuredClone(template);
  wire.writerId = writerId;
  wire.writerSeq = String(seq);
  wire.commitId = uuid('2', salt);
  const prior = previous === undefined && seq > 1 ? dummyRef(writerId, seq - 1, salt + 1000) : previous;
  wire.previousWriterCommit = prior ?? null;
  wire.basisClock = prior === null || prior === undefined ? [] : [prior];
  wire.mutations[0].localMutationId = uuid('4', salt);
  wire.mutations[0].entityKey = ['collection', `discovery-${salt}`];
  wire.mutations[0].value.id = `discovery-${salt}`;
  wire.mutations[0].value.name = `Discovery ${salt}`;
  wire.mutations[0].value.normalizedName = `discovery ${salt}`;
  const bytes = Buffer.from(JSON.stringify(wire));
  const contentHash = await sha256Hex(bytes);
  const ref = { writerId, writerSeq: String(seq), commitId: wire.commitId, contentHash };
  const path = buildCommitRemotePathV1(ref);
  return { bytes, ref, path, candidate: parseWriterCandidatePathV1(path), commit: await decodeFrozenWireCommitV1(bytes) };
}

class FakeDiscoveryRemote {
  listings = new Map();
  objects = new Map();
  listFailures = new Set();
  getFailures = new Set();
  listRejections = new Set();
  getRejections = new Set();
  listCalls = [];
  getCalls = [];

  async listDirectory(path) {
    this.listCalls.push(path);
    if (this.listRejections.has(path)) throw new DiscoveryOperationalFailureV1('Indeterminate');
    if (this.listFailures.has(path)) return { state: 'Indeterminate' };
    const source = this.listings.get(path);
    const entries = typeof source === 'function' ? source() : source ?? [];
    return { state: 'Entries', entries: [...entries] };
  }

  async getExact(path) {
    this.getCalls.push(path);
    if (this.getRejections.has(path)) throw new DiscoveryOperationalFailureV1('Indeterminate');
    if (this.getFailures.has(path)) return { state: 'Indeterminate' };
    const bytes = this.objects.get(path);
    return bytes === undefined
      ? { state: 'DefinitelyAbsent' }
      : { state: 'DefinitelyPresent', bytes: Uint8Array.from(bytes) };
  }
}

class SerializedDiscoveryStore {
  blob = null;

  async persist(state) {
    this.blob = JSON.stringify(state);
  }

  async load() {
    return this.blob === null ? null : JSON.parse(this.blob);
  }
}

const activationValidator = async bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));

test('shared discovery fixture freezes strict candidate parsing and independent audit sequence', () => {
  assert.equal(fixture.schema, 'watchtracker-s2-lite-discovery-golden-v1');
  assert.equal(fixture.scenarioCoverage.length, 14);
  for (const vector of fixture.pathCases) {
    const parsed = vector.kind === 'activation'
      ? parseActivationCandidatePathV1(vector.path)
      : parseWriterCandidatePathV1(vector.path);
    assert.equal(parsed !== null, vector.accepted, vector.name);
  }
  const state = createDiscoveryStateV1();
  state.historicalClosedSegments = [...fixture.audit.closedSegments];
  state.historicalAuditCursor = structuredClone(fixture.audit.initialCursor);
  const sequence = Array.from({ length: fixture.audit.rounds }, () => chooseHistoricalAuditTargetV1(state));
  assert.deepEqual(sequence, fixture.audit.expectedSequence);
  const corruptState = createDiscoveryStateV1();
  const inconsistent = fixture.pathCases.find(value => value.name === 'segment-seq-mismatch');
  observeCandidateListingV1(corruptState, [inconsistent.path]);
  assert.ok(corruptState.rootFatalSignals.some(value => value.code === 'REMOTE_S2_PATH_IDENTITY_MISMATCH'));
});

test('shared junk corpus has identical candidate/fatal classification semantics', () => {
  for (const item of fixture.junkCorpus) {
    assert.equal(classifyCandidatePathV1(item.path), item.classification, item.name);
    const state = createDiscoveryStateV1();
    observeCandidateListingV1(state, [item.path]);
    assert.equal(state.rootFatalSignals.length > 0, item.fatal, item.name);
  }
});

function canonicalTraceProjection(state) {
  const verified = state.verifiedObjects
    .filter(value => value.commitRef !== undefined)
    .sort((a, b) => a.path.localeCompare(b.path));
  const groups = new Map();
  for (const value of verified) {
    const key = `${value.commitRef.writerId}/${value.commitRef.writerSeq}`;
    const entries = groups.get(key) ?? [];
    entries.push(value);
    groups.set(key, entries);
  }
  return {
    observedCandidates: state.observedCandidates.map(value => value.path).sort(),
    verifiedRefs: verified.map(value => `${value.commitRef.writerId}/${value.commitRef.writerSeq}/${value.commitRef.commitId}/${value.commitRef.contentHash}`),
    gaps: [...state.knownGaps],
    dependencyQueue: state.targetedQueue.map(value => `${value.writerId}/${value.writerSeq}/${value.commitId}/${value.contentHash}`),
    dependencyProgress: structuredClone(state.exactWorkScheduler),
    auditCursor: structuredClone(state.historicalAuditCursor),
    scheduledLists: [...state.lastRoundScheduledLists],
    scheduledGets: [...state.lastRoundScheduledGets],
    fatalSignals: state.rootFatalSignals.map(value => structuredClone(value)),
    forkState: [...groups.values()].filter(values => values.length > 1).map(values => ({
      writerId: values[0].commitRef.writerId,
      writerSeq: values[0].commitRef.writerSeq,
      safeWriterFrontier: (BigInt(values[0].commitRef.writerSeq) - 1n).toString(),
      paths: values.map(value => value.path).sort(),
    })),
  };
}

test('TS executes the shared multi-round remote trace and matches canonical projection each round', async () => {
  const trace = fixture.executableTrace;
  const objects = new Map(trace.objects.map(value => [value.path, Buffer.from(value.utf8Base64, 'base64')]));
  let state = createDiscoveryStateV1();
  for (const round of trace.rounds) {
    const remote = new FakeDiscoveryRemote();
    for (const [path, entries] of Object.entries(round.listings)) remote.listings.set(path, entries);
    remote.objects = objects;
    state = await runDiscoveryRoundV1(state, remote, activationValidator, trace.budgets);
    assert.deepEqual(canonicalTraceProjection(state), round.expected);
  }
});

test('invalid activation is retained fatal while a valid commit completes the same round and survives omission restart', async () => {
  const trace = fixture.activationFailureTrace;
  const remote = new FakeDiscoveryRemote();
  for (const [path, entries] of Object.entries(trace.listing)) remote.listings.set(path, entries);
  for (const object of trace.objects) remote.objects.set(object.path, Buffer.from(object.utf8Base64, 'base64'));
  const rejectingValidator = async bytes => {
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      throw new ActivationProtocolValidationFailureV1();
    }
  };
  const first = await runDiscoveryRoundV1(createDiscoveryStateV1(), remote, rejectingValidator, trace.budgets);
  assert.deepEqual(canonicalTraceProjection(first), trace.expected);
  const badPath = trace.objects[0].path;
  assert.ok(first.observedCandidates.some(value => value.path === badPath));
  assert.equal(first.verifiedObjects.filter(value => value.kind === 'commit').length, 1);

  const store = new SerializedDiscoveryStore();
  await persistDiscoveryStateV1(first, store);
  const restarted = await loadDiscoveryStateV1(store);
  const omittedRemote = new FakeDiscoveryRemote();
  const afterOmission = await runDiscoveryRoundV1(restarted, omittedRemote, rejectingValidator, trace.budgets);
  assert.deepEqual(afterOmission.rootFatalSignals, first.rootFatalSignals);
  assert.ok(afterOmission.observedCandidates.some(value => value.path === badPath));
  assert.ok(omittedRemote.listCalls.length > 0);
});

test('unknown activation validator programming error still propagates', async () => {
  const trace = fixture.activationFailureTrace;
  const remote = new FakeDiscoveryRemote();
  for (const [path, entries] of Object.entries(trace.listing)) remote.listings.set(path, entries);
  for (const object of trace.objects) remote.objects.set(object.path, Buffer.from(object.utf8Base64, 'base64'));
  await assert.rejects(
    runDiscoveryRoundV1(createDiscoveryStateV1(), remote, async () => { throw new Error('validator programming bug'); }, trace.budgets),
    /validator programming bug/,
  );
});

test('fair exact scheduler cannot starve a late fork behind 64 retained verified objects', async () => {
  const writer = fixture.identities.writerB;
  const original = await makeCommit({ writerId: writer, seq: 1, salt: 7001 });
  const alternate = await makeCommit({ writerId: writer, seq: 1, salt: 7002 });
  const state = createDiscoveryStateV1();
  observeCandidateListingV1(state, [original.path, alternate.path]);
  await verifyCommitCandidateV1(state, original.candidate, original.bytes);
  for (let index = 1; index <= 64; index += 1) {
    const ref = dummyRef(fixture.identities.writerA, index, 8000 + index);
    const prefixPath = buildCommitRemotePathV1(ref);
    state.verifiedObjects.push({ path: prefixPath, kind: 'commit', exactBytesHash: ref.contentHash, exactBytesHex: '', contentHash: ref.contentHash, commitRef: ref });
    state.reverificationQueue.push(prefixPath);
  }
  const remote = new FakeDiscoveryRemote();
  remote.objects.set(alternate.path, alternate.bytes);
  const next = await runDiscoveryRoundV1(state, remote, activationValidator);
  assert.equal(next.lastRoundScheduledGets[0], alternate.path);
  assert.ok(next.rootFatalSignals.some(value => value.code === 'WRITER_FORK' && value.writerId === writer));
});

test('65 retained dependencies advance fairly across budget 64 and serialized restart', async () => {
  const state = createDiscoveryStateV1();
  state.targetedQueue = Array.from({ length: 65 }, (_, index) => dummyRef(fixture.identities.writerA, index + 1, 9000 + index));
  const expected65 = buildCommitRemotePathV1(state.targetedQueue[64]);
  const remote = new FakeDiscoveryRemote();
  const first = await runDiscoveryRoundV1(state, remote, activationValidator);
  assert.equal(first.lastRoundScheduledGets.length, 64);
  assert.equal(first.lastRoundScheduledGets.includes(expected65), false);
  const store = new SerializedDiscoveryStore();
  await persistDiscoveryStateV1(first, store);
  const restarted = await loadDiscoveryStateV1(store);
  const second = await runDiscoveryRoundV1(restarted, remote, activationValidator);
  assert.equal(second.lastRoundScheduledGets[0], expected65);
  assert.ok(second.targetedQueue.some(value => buildCommitRemotePathV1(value) === expected65));
});

test('activation verification retains an owned entry snapshot across deferred validator mutation', async () => {
  const activationId = fixture.identities.activationId;
  const originalBytes = Buffer.from(JSON.stringify({ activationId, legacyFingerprint: null, semanticProfileSupported: true, requiredFeaturesSupported: true }));
  const originalHash = await sha256Hex(originalBytes);
  const candidate = parseActivationCandidatePathV1(`activations/${activationId}--${originalHash}.json`);
  const state = createDiscoveryStateV1();
  let entered;
  let release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const releasePromise = new Promise(resolve => { release = resolve; });
  const pending = verifyActivationCandidateV1(state, candidate, originalBytes, async snapshot => {
    entered();
    await releasePromise;
    return JSON.parse(Buffer.from(snapshot).toString('utf8'));
  });
  await enteredPromise;
  originalBytes.fill(0x78);
  candidate.activationId = '30000000-0000-4000-8000-000000000099';
  release();
  await pending;
  const retained = state.verifiedObjects[0];
  assert.equal(retained.exactBytesHash, originalHash);
  assert.equal(Buffer.from(retained.exactBytesHex, 'hex').toString('utf8'), JSON.stringify({ activationId, legacyFingerprint: null, semanticProfileSupported: true, requiredFeaturesSupported: true }));
  assert.equal(retained.activationId, activationId);
  assert.deepEqual(retained.fingerprintEvidence, { state: 'Null' });
});

test('commit verification also owns its entry bytes and identity before asynchronous hashing', async () => {
  const made = await makeCommit({ seq: 1, salt: 7101 });
  const state = createDiscoveryStateV1();
  const bytes = Uint8Array.from(made.bytes);
  const candidate = { ...made.candidate };
  const pending = verifyCommitCandidateV1(state, candidate, bytes);
  bytes.fill(0x78);
  candidate.commitId = uuid('2', 9999);
  await pending;
  assert.equal(state.rootFatalSignals.length, 0);
  assert.equal(state.verifiedObjects[0].commitRef.commitId, made.ref.commitId);
  assert.equal(state.verifiedObjects[0].exactBytesHash, made.ref.contentHash);
  assert.deepEqual(Buffer.from(state.verifiedObjects[0].exactBytesHex, 'hex'), made.bytes);
});

test('observed writers, segments, candidates, gaps, and activations survive omission and serialized restart', async () => {
  const one = await makeCommit({ seq: 1, salt: 1 });
  const four = await makeCommit({ seq: 4, salt: 4 });
  const state = createDiscoveryStateV1();
  observeWriterListingV1(state, [fixture.identities.writerA, fixture.identities.writerA, 'junk']);
  observeSegmentListingV1(state, fixture.identities.writerA, ['00000000000000', '00000000000000']);
  observeCandidateListingV1(state, [four.path, one.path, one.path, 'writers/notes.txt']);
  await verifyCommitCandidateV1(state, one.candidate, one.bytes);
  await verifyCommitCandidateV1(state, four.candidate, four.bytes);
  assert.deepEqual(state.knownGaps, fixture.expected.gapAfterSeqsOneAndFour);
  observeWriterListingV1(state, []);
  observeSegmentListingV1(state, fixture.identities.writerA, []);
  observeCandidateListingV1(state, []);
  assert.deepEqual(state.observedCandidates.map(value => value.path).sort(), [four.path, one.path].sort());

  const activationBytes = Buffer.from(JSON.stringify({
    activationId: fixture.identities.activationId,
    legacyFingerprint: null,
    semanticProfileSupported: true,
    requiredFeaturesSupported: true,
  }));
  const activationHash = await sha256Hex(activationBytes);
  const activationPath = `activations/${fixture.identities.activationId}--${activationHash}.json`;
  observeCandidateListingV1(state, [activationPath]);
  const activation = parseActivationCandidatePathV1(activationPath);
  await verifyActivationCandidateV1(state, activation, activationBytes, activationValidator);
  const secondActivationId = '30000000-0000-4000-8000-000000000002';
  const secondActivationBytes = Buffer.from(JSON.stringify({
    activationId: secondActivationId,
    legacyFingerprint: null,
    semanticProfileSupported: true,
    requiredFeaturesSupported: true,
  }));
  const secondActivationPath = `activations/${secondActivationId}--${await sha256Hex(secondActivationBytes)}.json`;
  observeCandidateListingV1(state, [secondActivationPath]);
  await verifyActivationCandidateV1(
    state,
    parseActivationCandidatePathV1(secondActivationPath),
    secondActivationBytes,
    activationValidator,
  );
  observeCandidateListingV1(state, []);
  assert.ok(state.observedActivations.includes(activationPath));
  assert.equal(state.observedActivations.length, 2);

  const store = new SerializedDiscoveryStore();
  await persistDiscoveryStateV1(state, store);
  const loaded = await loadDiscoveryStateV1(store);
  loaded.observedCandidates.length = 0;
  const reloaded = await loadDiscoveryStateV1(store);
  assert.ok(reloaded.observedCandidates.some(value => value.path === one.path));
  assert.deepEqual(reloaded.knownGaps, fixture.expected.gapAfterSeqsOneAndFour);
  assert.ok(reloaded.verifiedObjects.some(value => value.path === activationPath));
  assert.equal(reloaded.verifiedObjects.filter(value => value.kind === 'activation').length, 2);
  const retainedBytes = retainedVerifiedCommitBytesV1(reloaded);
  assert.equal(retainedBytes.length, 2);
  const retainedCommits = await Promise.all(retainedBytes.map(decodeFrozenWireCommitV1));
  assert.equal((await replayVerifiedHistoryV1(retainedCommits)).validity.length, 2);
});

test('dependency exact GET discovers listing-omitted objects and preserves pending targets on absence or timeout', async () => {
  const three = await makeCommit({ seq: 3, salt: 3 });
  const four = await makeCommit({ seq: 4, salt: 4, previous: three.ref });
  const state = createDiscoveryStateV1();
  observeCandidateListingV1(state, [four.path]);
  await verifyCommitCandidateV1(state, four.candidate, four.bytes);
  assert.ok(state.targetedQueue.some(ref => ref.commitId === three.ref.commitId));
  const remote = new FakeDiscoveryRemote();
  remote.objects.set(three.path, three.bytes);
  const discovered = await runDiscoveryRoundV1(state, remote, activationValidator);
  assert.ok(discovered.verifiedObjects.some(value => value.path === three.path));
  assert.ok(remote.getCalls.includes(three.path));

  const two = await makeCommit({ seq: 2, salt: 2 });
  discovered.targetedQueue.push(two.ref);
  remote.getFailures.add(two.path);
  const indeterminate = await runDiscoveryRoundV1(discovered, remote, activationValidator);
  assert.equal(indeterminate.lastRoundIndeterminate, true);
  assert.ok(indeterminate.targetedQueue.some(ref => ref.commitId === two.ref.commitId));
});

test('listing order and duplicates do not affect retained protocol-visible knowledge', async () => {
  const commits = await Promise.all([1, 2, 3, 4].map(seq => makeCommit({ seq, salt: seq })));
  const reference = createDiscoveryStateV1();
  observeWriterListingV1(reference, [fixture.identities.writerA]);
  observeSegmentListingV1(reference, fixture.identities.writerA, ['00000000000000']);
  observeCandidateListingV1(reference, commits.map(value => value.path));
  for (const commit of commits) await verifyCommitCandidateV1(reference, commit.candidate, commit.bytes);
  const expected = JSON.stringify({
    writers: reference.observedWriters,
    segments: reference.observedSegments,
    candidates: reference.observedCandidates,
    verified: reference.verifiedObjects,
    gaps: reference.knownGaps,
    targets: reference.targetedQueue,
  });
  for (let seed = 0; seed < fixture.permutationIterations; seed += 1) {
    const state = createDiscoveryStateV1();
    const order = [...commits].sort((a, b) => ((a.ref.commitId.charCodeAt(35) * (seed + 3)) % 7)
      - ((b.ref.commitId.charCodeAt(35) * (seed + 3)) % 7));
    observeWriterListingV1(state, [fixture.identities.writerA, fixture.identities.writerA]);
    observeSegmentListingV1(state, fixture.identities.writerA, ['00000000000000', '00000000000000']);
    observeCandidateListingV1(state, [...order.map(value => value.path), order[0].path]);
    for (const commit of order) await verifyCommitCandidateV1(state, commit.candidate, commit.bytes);
    assert.equal(JSON.stringify({
      writers: state.observedWriters,
      segments: state.observedSegments,
      candidates: state.observedCandidates,
      verified: state.verifiedObjects,
      gaps: state.knownGaps,
      targets: state.targetedQueue,
    }), expected, `permutation ${seed}`);
  }
});

test('historical cursor is fair, persists midway, and includes newly retained old segments', async () => {
  const state = createDiscoveryStateV1();
  state.historicalClosedSegments = [...fixture.audit.closedSegments];
  const firstHalf = Array.from({ length: 5 }, () => chooseHistoricalAuditTargetV1(state));
  const store = new SerializedDiscoveryStore();
  await persistDiscoveryStateV1(state, store);
  const restarted = await loadDiscoveryStateV1(store);
  restarted.historicalClosedSegments.push(`${fixture.identities.writerC}/00000000000001`);
  const secondHalf = Array.from({ length: 10_000 }, () => chooseHistoricalAuditTargetV1(restarted));
  assert.deepEqual(firstHalf, fixture.audit.expectedSequence.slice(0, 5));
  for (const segment of restarted.historicalClosedSegments) {
    assert.ok(secondHalf.includes(segment), segment);
  }
});

test('late historical alternate is eventually audited, freezes monotonically, and Phase 1 quarantines the fork', async () => {
  const writerId = fixture.identities.writerA;
  const previous = dummyRef(writerId, 199, 9000);
  const original = await makeCommit({ writerId, seq: 200, salt: 200, previous });
  const alternate = await makeCommit({ writerId, seq: 200, salt: 201, previous });
  let state = createDiscoveryStateV1();
  observeCandidateListingV1(state, [original.path]);
  await verifyCommitCandidateV1(state, original.candidate, original.bytes);
  observeWriterListingV1(state, [writerId]);
  observeSegmentListingV1(state, writerId, ['00000000000017']);
  const remote = new FakeDiscoveryRemote();
  remote.listings.set('writers/', [`writers/${writerId}/`]);
  remote.listings.set(`writers/${writerId}/segments/`, ['00000000000017']);
  let forkVisible = false;
  remote.listings.set(`writers/${writerId}/segments/00000000000000/`, () => forkVisible ? [alternate.path] : []);
  remote.objects.set(alternate.path, alternate.bytes);
  for (let round = 0; round < 5; round += 1) state = await runDiscoveryRoundV1(state, remote, activationValidator);
  assert.equal(state.rootFatalSignals.some(value => value.code === 'WRITER_FORK'), false);
  forkVisible = true;
  for (let round = 0; round < 30 && !state.rootFatalSignals.some(value => value.code === 'WRITER_FORK'); round += 1) {
    state = await runDiscoveryRoundV1(state, remote, activationValidator);
  }
  const fork = state.rootFatalSignals.find(value => value.code === 'WRITER_FORK');
  assert.equal(fork.safeWriterFrontier, '199');
  forkVisible = false;
  state = await runDiscoveryRoundV1(state, remote, activationValidator);
  assert.ok(state.rootFatalSignals.some(value => value.code === 'WRITER_FORK'));
  const replay = await replayVerifiedHistoryV1([original.commit, alternate.commit]);
  assert.equal(replay.forks.length, 1);
  assert.equal(replay.forks[0].safeWriterFrontier, '199');
  assert.equal(replay.unsafeCommitRefs.length, 2);
  assert.equal(state.verifiedObjects.filter(value => value.commitRef?.writerSeq === '200').length, 2);
  const reverse = createDiscoveryStateV1();
  observeCandidateListingV1(reverse, [alternate.path, original.path]);
  await verifyCommitCandidateV1(reverse, alternate.candidate, alternate.bytes);
  await verifyCommitCandidateV1(reverse, original.candidate, original.bytes);
  assert.deepEqual(reverse.rootFatalSignals, state.rootFatalSignals.filter(value => value.code === 'WRITER_FORK'));
});

test('path/body mismatches, immutable byte changes, and unsupported activation are monotonic fatal facts', async () => {
  const original = await makeCommit({ seq: 1, salt: 11 });
  const state = createDiscoveryStateV1();
  observeCandidateListingV1(state, [original.path]);
  await verifyCommitCandidateV1(state, original.candidate, original.bytes);
  await verifyCommitCandidateV1(state, original.candidate, Buffer.from('changed'));
  assert.ok(state.rootFatalSignals.some(value => value.code === fixture.expected.immutableMismatchCode));

  const otherWriter = await makeCommit({ writerId: fixture.identities.writerB, seq: 1, salt: 12 });
  const mismatchedPath = buildCommitRemotePathV1({ ...otherWriter.ref, writerId: fixture.identities.writerA });
  const mismatched = parseWriterCandidatePathV1(mismatchedPath);
  observeCandidateListingV1(state, [mismatchedPath]);
  await verifyCommitCandidateV1(state, mismatched, otherWriter.bytes);
  assert.ok(state.rootFatalSignals.some(value => value.code === 'REMOTE_S2_PATH_BODY_IDENTITY_MISMATCH'));

  const activationId = fixture.identities.activationId;
  const bytes = Buffer.from(JSON.stringify({
    activationId, legacyFingerprint: null, semanticProfileSupported: false, requiredFeaturesSupported: true,
  }));
  const path = `activations/${activationId}--${await sha256Hex(bytes)}.json`;
  const candidate = parseActivationCandidatePathV1(path);
  observeCandidateListingV1(state, [path]);
  await verifyActivationCandidateV1(state, candidate, bytes, activationValidator);
  assert.ok(state.rootFatalSignals.some(value => value.code === 'REMOTE_S2_UNSUPPORTED_FEATURE'));
  observeCandidateListingV1(state, []);
  assert.ok(state.observedActivations.includes(path));
});

test('directory and exact GET failures retain knowledge and do not become absence proofs', async () => {
  const commit = await makeCommit({ seq: 1, salt: 21 });
  let state = createDiscoveryStateV1();
  observeCandidateListingV1(state, [commit.path]);
  const remote = new FakeDiscoveryRemote();
  remote.listFailures.add('writers/');
  remote.getFailures.add(commit.path);
  state = await runDiscoveryRoundV1(state, remote, activationValidator);
  assert.equal(state.lastRoundIndeterminate, true);
  assert.ok(state.observedCandidates.some(value => value.path === commit.path));
  remote.listFailures.clear();
  remote.getFailures.clear();
  remote.objects.set(commit.path, commit.bytes);
  state = await runDiscoveryRoundV1(state, remote, activationValidator);
  assert.ok(state.verifiedObjects.some(value => value.path === commit.path));

  const rejectedRemote = new FakeDiscoveryRemote();
  rejectedRemote.listRejections.add('writers/');
  rejectedRemote.getRejections.add(commit.path);
  const pending = createDiscoveryStateV1();
  observeCandidateListingV1(pending, [commit.path]);
  const rejected = await runDiscoveryRoundV1(pending, rejectedRemote, activationValidator);
  assert.equal(rejected.lastRoundIndeterminate, true);
  assert.ok(rejected.observedCandidates.some(value => value.path === commit.path));
});
