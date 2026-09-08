import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  advanceImmutablePublishStateV1,
  buildCommitRemotePathV1,
  persistPreparedIntentBeforePublishV1,
  persistVerifiedReceiptV1,
  prepareCommitIntentV1,
  publishPersistedIntentV1,
  recoverPreparedIntentV1,
  RemoteOperationalFailureV1,
  restartDurablePublishV1,
  sha256Hex,
  validatePreparedIntentV1,
  validatePublishedReceiptV1,
} from '../../../features/sync/s2lite/index.ts';

const fixture = JSON.parse(await readFile(new URL(
  '../../../../contracts/s2-lite/v1/publish-golden-v1.json', import.meta.url,
)));
const verifiedAt = '2026-09-08T05:00:00.000Z';
const exactBytes = () => Buffer.from(fixture.preparedIntent.exactBytesBase64, 'base64');

function refFor(writerSeq) {
  return { ...fixture.pathIdentity, writerSeq };
}

function resultName(result) {
  return result.outcome;
}

class AdversarialRemote {
  objects = new Map();
  putCalls = [];
  getCalls = [];
  putMode = 'success';
  getMode = 'normal';
  delayedReads = 0;
  staleMetadata = true;
  getRejectOnCall = null;
  getRejectCategory = 'Indeterminate';
  getUnknownErrorOnCall = null;
  trace = [];

  async getExact(path) {
    this.getCalls.push(path);
    this.trace.push(this.getCalls.length === 1 ? 'GET_PREFLIGHT' : 'GET_VERIFY');
    if (this.getUnknownErrorOnCall === this.getCalls.length) throw new Error('programming failure');
    if (this.getRejectOnCall === this.getCalls.length) {
      this.trace.push('GET_REJECTED');
      throw new RemoteOperationalFailureV1(this.getRejectCategory);
    }
    if (this.getMode === 'indeterminate') return { state: 'Indeterminate' };
    if (this.getMode === 'auth') return { state: 'AuthOrCapabilityFailure' };
    if (this.delayedReads > 0) {
      this.delayedReads -= 1;
      return { state: 'Indeterminate' };
    }
    const bytes = this.objects.get(path);
    if (bytes === undefined) {
      this.trace.push('REMOTE_ABSENT');
      return { state: 'DefinitelyAbsent' };
    }
    this.trace.push('REMOTE_EXACT');
    return { state: 'DefinitelyPresent', bytes: Uint8Array.from(bytes) };
  }

  async putExact(path, bytes, conditions) {
    this.putCalls.push({ path, bytes: Uint8Array.from(bytes), conditions });
    this.trace.push('PUT_ATTEMPT');
    if (this.putMode === 'reject-before-store') {
      this.trace.push('PUT_REJECTED');
      throw new RemoteOperationalFailureV1('Indeterminate');
    }
    if (this.putMode === 'reject-auth-before-store') {
      this.trace.push('PUT_REJECTED');
      throw new RemoteOperationalFailureV1('AuthOrCapabilityFailure');
    }
    if (this.putMode === 'timeout-before-store') return { state: 'Indeterminate' };
    if (this.putMode === 'auth') return { state: 'AuthOrCapabilityFailure' };
    // Deliberately ignore If-None-Match and always overwrite the same path.
    this.objects.set(
      path,
      this.putMode === 'overwrite-different-then-reject'
        ? Buffer.from('provider-returned-different-bytes')
        : Uint8Array.from(bytes),
    );
    if (this.putMode === 'store-then-reject' || this.putMode === 'overwrite-different-then-reject') {
      this.trace.push('PUT_REJECTED');
      throw new RemoteOperationalFailureV1('Indeterminate');
    }
    if (this.putMode === 'store-then-timeout') return { state: 'Indeterminate' };
    this.trace.push('PUT_SUCCESS');
    return { state: 'Success' };
  }
}

class DeferredPreflightRemote {
  objects = new Map();
  putCalls = [];
  getCalls = [];
  waiters = [];
  deferredIssued = 0;
  entered;
  resolveEntered;

  constructor(expectedWaiters) {
    this.expectedWaiters = expectedWaiters;
    this.entered = new Promise(resolve => { this.resolveEntered = resolve; });
  }

  async getExact(path) {
    this.getCalls.push(path);
    if (this.deferredIssued < this.expectedWaiters) {
      this.deferredIssued += 1;
      const pending = new Promise(resolve => this.waiters.push(resolve));
      if (this.deferredIssued === this.expectedWaiters) this.resolveEntered();
      return pending;
    }
    const bytes = this.objects.get(path);
    return bytes === undefined
      ? { state: 'DefinitelyAbsent' }
      : { state: 'DefinitelyPresent', bytes: Uint8Array.from(bytes) };
  }

  async putExact(path, bytes, conditions) {
    this.putCalls.push({ path, bytes: Uint8Array.from(bytes), conditions });
    this.objects.set(path, Uint8Array.from(bytes));
    return { state: 'Success' };
  }

  releaseAbsent() {
    for (const resolve of this.waiters.splice(0)) resolve({ state: 'DefinitelyAbsent' });
  }
}

class SerializedIntentStore {
  blob = null;
  loadCount = 0;

  async persist(value) {
    this.blob = JSON.stringify({
      ...value,
      exactBytesBase64: Buffer.from(value.exactBytes).toString('base64'),
      exactBytes: undefined,
    });
  }

  load() {
    this.loadCount += 1;
    const value = JSON.parse(this.blob);
    const bytes = Buffer.from(value.exactBytesBase64, 'base64');
    delete value.exactBytesBase64;
    value.exactBytes = new Uint8Array(bytes);
    return value;
  }
}

class SerializedReceiptStore {
  blob = null;
  loadCount = 0;
  persistCount = 0;
  history = [];

  async persist(value) {
    this.persistCount += 1;
    this.blob = JSON.stringify(value);
    this.history.push(this.blob);
  }

  load() {
    this.loadCount += 1;
    return JSON.parse(this.blob);
  }
}

async function prepared() {
  return prepareCommitIntentV1(exactBytes(), fixture.preparedIntent.createdLocallyAtDiagnostic);
}

async function alternatePrepared() {
  const wire = JSON.parse(exactBytes().toString('utf8'));
  wire.commitId = '20000000-0000-4000-8000-000000000099';
  return prepareCommitIntentV1(
    Buffer.from(JSON.stringify(wire)),
    fixture.preparedIntent.createdLocallyAtDiagnostic,
  );
}

async function publishPersisted(intent, remote) {
  const token = await persistPreparedIntentBeforePublishV1(intent, { async persist() {} });
  return publishPersistedIntentV1(token, remote, verifiedAt);
}

async function verifiedResult(intent) {
  const remote = new AdversarialRemote();
  remote.objects.set(intent.remotePath, intent.exactBytes);
  const result = await recoverPreparedIntentV1(intent, remote, verifiedAt);
  assert.equal(result.outcome, 'AlreadyPublishedExact');
  return result;
}

test('shared Phase 2 fixture freezes segment boundaries and exact PreparedIntent identity', async () => {
  assert.equal(fixture.schema, 'watchtracker-s2-lite-publish-golden-v1');
  for (const vector of fixture.pathCases) {
    assert.equal(buildCommitRemotePathV1(refFor(vector.writerSeq)), vector.expectedPath, vector.writerSeq);
  }
  for (const vector of fixture.invalidWriterSeqCases) {
    assert.throws(() => buildCommitRemotePathV1(refFor(vector.writerSeq)), { message: vector.expectedError });
  }
  const intent = await prepared();
  assert.equal(intent.contentHash, fixture.preparedIntent.expectedContentHash);
  assert.deepEqual(intent.commitRef, fixture.preparedIntent.expectedCommitRef);
  assert.equal(intent.remotePath, fixture.preparedIntent.expectedRemotePath);
  assert.equal(intent.intentFingerprint, fixture.preparedIntent.expectedIntentFingerprint);
  assert.deepEqual(Buffer.from(intent.exactBytes), exactBytes());
  assert.equal(await sha256Hex(intent.exactBytes), intent.contentHash);
  assert.match(intent.remotePath, new RegExp(`${intent.contentHash}\\.json$`));
  await validatePreparedIntentV1(intent);
});

test('PreparedIntent and receipt validation fail closed on every bound identity component', async () => {
  const intent = await prepared();
  for (const mutate of [
    value => { value.remotePath += '.other'; },
    value => { value.contentHash = '0'.repeat(64); },
    value => { value.commitRef.contentHash = '0'.repeat(64); },
    value => { value.exactBytes[0] ^= 1; },
    value => { value.intentFingerprint = '0'.repeat(64); },
    value => { value.unexpected = true; },
  ]) {
    const corrupt = structuredClone(intent);
    mutate(corrupt);
    await assert.rejects(validatePreparedIntentV1(corrupt), { message: 'LOCAL_PREPARED_INTENT_CORRUPTION' });
  }

  const remote = new AdversarialRemote();
  remote.objects.set(intent.remotePath, intent.exactBytes);
  const published = await recoverPreparedIntentV1(intent, remote, verifiedAt);
  assert.equal(published.outcome, 'AlreadyPublishedExact');
  await validatePublishedReceiptV1(published.receipt, intent);
  for (const mutate of [
    value => { value.remotePath += '.other'; },
    value => { value.contentHash = '0'.repeat(64); },
    value => { value.commitRef.commitId = '20000000-0000-4000-8000-000000000099'; },
    value => { value.preparedIntentFingerprint = '0'.repeat(64); },
    value => { value.verifiedExactBytesHash = '0'.repeat(64); },
    value => { value.unexpected = true; },
  ]) {
    const corrupt = structuredClone(published.receipt);
    mutate(corrupt);
    await assert.rejects(validatePublishedReceiptV1(corrupt, intent), {
      message: 'LOCAL_PUBLISHED_RECEIPT_CORRUPTION',
    });
  }
});

test('shared recovery vectors distinguish exact, mismatch, absent, indeterminate, and auth', async () => {
  const intent = await prepared();
  for (const vector of fixture.recoveryCases) {
    const remote = new AdversarialRemote();
    if (vector.remote === 'exact') remote.objects.set(intent.remotePath, intent.exactBytes);
    if (vector.remote === 'different') {
      remote.objects.set(intent.remotePath, Buffer.from(fixture.differentRemoteBytesBase64, 'base64'));
    }
    if (vector.remote === 'indeterminate') remote.getMode = 'indeterminate';
    if (vector.remote === 'auth') remote.getMode = 'auth';
    const result = await recoverPreparedIntentV1(intent, remote, verifiedAt);
    assert.equal(resultName(result), vector.expectedOutcome, vector.name);
    assert.equal(remote.putCalls.length, 0, vector.name);
    if (result.outcome === 'CorruptionMismatch') {
      assert.deepEqual(result.safetyEvent, {
        code: 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH',
        freezeClass: 'SYNC_ROOT_FROZEN_CORRUPTION',
        remotePath: intent.remotePath,
        expectedContentHash: intent.contentHash,
        observedContentHash: fixture.differentRemoteBytesHash,
      });
    }
  }
});

test('PUT success and lost responses always GET and verify exact bytes', async () => {
  for (const putMode of ['success', 'store-then-timeout']) {
    const intent = await prepared();
    const remote = new AdversarialRemote();
    remote.putMode = putMode;
    const result = await publishPersisted(intent, remote);
    assert.equal(result.outcome, 'AlreadyPublishedExact');
    assert.equal(remote.putCalls.length, 1);
    assert.equal(remote.getCalls.length, 2);
    assert.deepEqual(remote.putCalls[0].conditions, { ifNoneMatchStar: true });
    assert.deepEqual(remote.putCalls[0].bytes, intent.exactBytes);
  }

  const intent = await prepared();
  const noStore = new AdversarialRemote();
  noStore.putMode = 'timeout-before-store';
  assert.equal((await publishPersisted(intent, noStore)).outcome, 'RetryPublishExact');
  assert.equal(noStore.putCalls.length, 1);
  noStore.putMode = 'success';
  assert.equal((await publishPersisted(intent, noStore)).outcome, 'AlreadyPublishedExact');
  assert.equal(noStore.putCalls.length, 2);
  assert.ok(noStore.putCalls.every(call => (
    call.path === intent.remotePath && Buffer.from(call.bytes).equals(intent.exactBytes)
  )));

  const authPut = new AdversarialRemote();
  authPut.putMode = 'auth';
  assert.equal((await publishPersisted(intent, authPut)).outcome, 'AuthOrCapabilityFailure');

  const unavailable = new AdversarialRemote();
  unavailable.getMode = 'indeterminate';
  assert.equal((await publishPersisted(intent, unavailable)).outcome, 'RemoteIndeterminate');
  assert.equal(unavailable.putCalls.length, 0);
});

test('real Promise rejections stay inside recovery taxonomy and preserve verify-after-PUT', async () => {
  const intent = await prepared();
  for (const vector of fixture.publishCases) {
    const remote = new AdversarialRemote();
    if (vector.initialRemote === 'exact') remote.objects.set(intent.remotePath, intent.exactBytes);
    if (vector.putBehavior === 'store-then-reject-indeterminate') remote.putMode = 'store-then-reject';
    if (vector.putBehavior === 'reject-indeterminate-before-store') remote.putMode = 'reject-before-store';
    if (vector.verifyBehavior === 'reject-indeterminate') remote.getRejectOnCall = 2;
    const result = await publishPersisted(intent, remote);
    if (result.outcome === 'AlreadyPublishedExact') remote.trace.push('RECEIPT_READY');
    assert.equal(result.outcome, vector.expectedOutcome, vector.name);
    assert.equal(remote.getCalls.length, vector.expectedGetCount, vector.name);
    assert.equal(remote.putCalls.length, vector.expectedPutCount, vector.name);
    assert.deepEqual(remote.trace, vector.expectedTrace, vector.name);
  }

  const preflightReject = new AdversarialRemote();
  preflightReject.getRejectOnCall = 1;
  assert.equal((await publishPersisted(intent, preflightReject)).outcome, 'RemoteIndeterminate');
  assert.equal(preflightReject.putCalls.length, 0);

  const preflightAuthReject = new AdversarialRemote();
  preflightAuthReject.getRejectOnCall = 1;
  preflightAuthReject.getRejectCategory = 'AuthOrCapabilityFailure';
  assert.equal((await publishPersisted(intent, preflightAuthReject)).outcome, 'AuthOrCapabilityFailure');
  assert.equal(preflightAuthReject.putCalls.length, 0);

  const putAuthReject = new AdversarialRemote();
  putAuthReject.putMode = 'reject-auth-before-store';
  assert.equal((await publishPersisted(intent, putAuthReject)).outcome, 'AuthOrCapabilityFailure');
  assert.equal(putAuthReject.getCalls.length, 2);

  const overwrittenThenRejected = new AdversarialRemote();
  overwrittenThenRejected.putMode = 'overwrite-different-then-reject';
  const mismatch = await publishPersisted(intent, overwrittenThenRejected);
  assert.equal(mismatch.outcome, 'CorruptionMismatch');
  assert.equal(mismatch.safetyEvent.code, 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH');
  assert.equal(mismatch.safetyEvent.freezeClass, 'SYNC_ROOT_FROZEN_CORRUPTION');

  const programmingFailure = new AdversarialRemote();
  programmingFailure.getUnknownErrorOnCall = 1;
  await assert.rejects(publishPersisted(intent, programmingFailure), /programming failure/);
  assert.equal(programmingFailure.putCalls.length, 0);
});

test('same-path mismatch is never overwritten and exact retry remains one logical publication', async () => {
  const intent = await prepared();
  const mismatch = new AdversarialRemote();
  mismatch.objects.set(intent.remotePath, Buffer.from('different'));
  const mismatchResult = await publishPersisted(intent, mismatch);
  assert.equal(mismatchResult.outcome, 'CorruptionMismatch');
  assert.equal(mismatch.putCalls.length, 0);
  assert.deepEqual(mismatch.objects.get(intent.remotePath), Buffer.from('different'));

  const remote = new AdversarialRemote();
  for (let retry = 0; retry < 8; retry += 1) {
    const result = await publishPersisted(intent, remote);
    assert.equal(result.outcome, 'AlreadyPublishedExact');
  }
  assert.deepEqual(remote.objects.get(intent.remotePath), intent.exactBytes);
  assert.equal(remote.objects.size, 1);
});

test('concurrent workers and different commits remain safe when conditionals are ignored', async () => {
  const intent = await prepared();
  const remote = new AdversarialRemote();
  const results = await Promise.all([
    publishPersisted(intent, remote),
    publishPersisted(intent, remote),
  ]);
  assert.ok(results.every(result => result.outcome === 'AlreadyPublishedExact'));
  assert.equal(remote.objects.size, 1);
  assert.ok(remote.putCalls.every(call => Buffer.from(call.bytes).equals(exactBytes())));

  const secondWire = JSON.parse(exactBytes().toString('utf8'));
  secondWire.commitId = '20000000-0000-4000-8000-000000000099';
  const second = await prepareCommitIntentV1(
    Buffer.from(JSON.stringify(secondWire)),
    fixture.preparedIntent.createdLocallyAtDiagnostic,
  );
  assert.notEqual(second.remotePath, intent.remotePath);
  await publishPersisted(second, remote);
  assert.equal(remote.objects.size, 2);
  assert.deepEqual(remote.objects.get(intent.remotePath), intent.exactBytes);
  assert.deepEqual(remote.objects.get(second.remotePath), second.exactBytes);
});

test('private publish snapshots defeat deferred full swaps, field mutation, and ArrayBuffer aliasing', async () => {
  const original = await prepared();
  const alternate = await alternatePrepared();
  const attempts = [
    {
      name: 'full-intent-swap',
      mutate(value) {
        value.remotePath = alternate.remotePath;
        value.exactBytes = alternate.exactBytes;
        value.contentHash = alternate.contentHash;
        value.commitRef = { ...alternate.commitRef };
        value.intentFingerprint = alternate.intentFingerprint;
      },
    },
    { name: 'exact-bytes-alias', mutate(value) { value.exactBytes[0] ^= 1; } },
    { name: 'remote-path', mutate(value) { value.remotePath = alternate.remotePath; } },
    {
      name: 'commit-ref',
      mutate(value) {
        value.commitRef.writerId = alternate.commitRef.writerId;
        value.commitRef.writerSeq = alternate.commitRef.writerSeq;
        value.commitRef.commitId = alternate.commitRef.commitId;
        value.commitRef.contentHash = alternate.commitRef.contentHash;
      },
    },
  ];
  for (const attempt of attempts) {
    const caller = structuredClone(original);
    const shared = new Uint8Array(caller.exactBytes);
    caller.exactBytes = shared;
    const token = await persistPreparedIntentBeforePublishV1(caller, { async persist() {} });
    assert.equal(Object.hasOwn(token, 'intent'), false);
    const remote = new DeferredPreflightRemote(1);
    const publishing = publishPersistedIntentV1(token, remote, verifiedAt);
    await remote.entered;
    attempt.mutate(caller);
    remote.releaseAbsent();
    const result = await publishing;
    assert.equal(result.outcome, 'AlreadyPublishedExact', attempt.name);
    assert.equal(remote.putCalls.length, 1, attempt.name);
    assert.equal(remote.putCalls[0].path, original.remotePath, attempt.name);
    assert.deepEqual(remote.putCalls[0].bytes, original.exactBytes, attempt.name);
    assert.deepEqual(result.receipt.commitRef, original.commitRef, attempt.name);
    assert.equal(result.receipt.remotePath, original.remotePath, attempt.name);
  }
});

test('concurrent deferred workers retain the same durable snapshot after caller mutation', async () => {
  const caller = await prepared();
  const alternate = await alternatePrepared();
  const token = await persistPreparedIntentBeforePublishV1(caller, { async persist() {} });
  const remote = new DeferredPreflightRemote(2);
  const first = publishPersistedIntentV1(token, remote, verifiedAt);
  const second = publishPersistedIntentV1(token, remote, verifiedAt);
  await remote.entered;
  Object.assign(caller, alternate);
  caller.exactBytes[0] ^= 1;
  remote.releaseAbsent();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.outcome === 'AlreadyPublishedExact'));
  assert.ok(remote.putCalls.every(call => (
    call.path === fixture.preparedIntent.expectedRemotePath
    && Buffer.from(call.bytes).equals(exactBytes())
  )));
  assert.deepEqual(results[0].receipt, results[1].receipt);
});

test('receipt persistence binds validation and durable write to one private receipt and intent snapshot', async () => {
  const intentX = await prepared();
  const intentY = await alternatePrepared();
  const resultX = await verifiedResult(intentX);
  const resultY = await verifiedResult(intentY);
  const expectedReceipt = structuredClone(resultX.receipt);
  const expectedIntent = structuredClone(intentX);
  const attempts = [
    {
      name: 'full-valid-X-to-Y',
      mutate(result, intent) {
        result.receipt = structuredClone(resultY.receipt);
        Object.assign(intent, structuredClone(intentY));
      },
    },
    { name: 'receipt-path', mutate(result) { result.receipt.remotePath = resultY.receipt.remotePath; } },
    { name: 'receipt-content-hash', mutate(result) { result.receipt.contentHash = resultY.receipt.contentHash; } },
    {
      name: 'receipt-ref-writer-id',
      mutate(result) { result.receipt.commitRef.writerId = '30000000-0000-4000-8000-000000000001'; },
    },
    { name: 'receipt-ref-writer-seq', mutate(result) { result.receipt.commitRef.writerSeq = '2'; } },
    {
      name: 'receipt-ref-commit-id',
      mutate(result) { result.receipt.commitRef.commitId = resultY.receipt.commitRef.commitId; },
    },
    {
      name: 'receipt-ref-content-hash',
      mutate(result) { result.receipt.commitRef.contentHash = resultY.receipt.commitRef.contentHash; },
    },
    { name: 'intent-path', mutate(_result, intent) { intent.remotePath = intentY.remotePath; } },
    { name: 'intent-content-hash', mutate(_result, intent) { intent.contentHash = intentY.contentHash; } },
    {
      name: 'intent-commit-ref',
      mutate(_result, intent) { intent.commitRef = structuredClone(intentY.commitRef); },
    },
    {
      name: 'intent-fingerprint',
      mutate(_result, intent) { intent.intentFingerprint = intentY.intentFingerprint; },
    },
  ];

  for (const attempt of attempts) {
    const callerResult = structuredClone(resultX);
    const callerIntent = structuredClone(intentX);
    const store = new SerializedReceiptStore();
    const persisting = persistVerifiedReceiptV1(callerResult, callerIntent, store);
    assert.equal(store.persistCount, 0, `${attempt.name}: validation must precede write`);
    attempt.mutate(callerResult, callerIntent);
    await persisting;
    assert.equal(store.persistCount, 1, attempt.name);
    const durableReceipt = store.load();
    assert.deepEqual(durableReceipt, expectedReceipt, attempt.name);
    await validatePublishedReceiptV1(durableReceipt, expectedIntent);
  }

  const ownershipStore = new SerializedReceiptStore();
  const externalReceipt = structuredClone(expectedReceipt);
  await ownershipStore.persist(externalReceipt);
  externalReceipt.remotePath = resultY.receipt.remotePath;
  externalReceipt.commitRef = structuredClone(resultY.receipt.commitRef);
  const firstLoad = ownershipStore.load();
  assert.deepEqual(firstLoad, expectedReceipt);
  firstLoad.remotePath = resultY.receipt.remotePath;
  firstLoad.commitRef.writerId = resultY.receipt.commitRef.writerId;
  assert.deepEqual(ownershipStore.load(), expectedReceipt);

  const invalidBeforeWrite = structuredClone(resultX);
  invalidBeforeWrite.receipt.remotePath += '.invalid';
  const untouchedStore = new SerializedReceiptStore();
  await assert.rejects(
    persistVerifiedReceiptV1(invalidBeforeWrite, structuredClone(intentX), untouchedStore),
    { message: 'LOCAL_PUBLISHED_RECEIPT_CORRUPTION' },
  );
  assert.equal(untouchedStore.persistCount, 0);

  const durableIntentStore = new SerializedIntentStore();
  await persistPreparedIntentBeforePublishV1(intentX, durableIntentStore);
  const restartReceiptStore = new SerializedReceiptStore();
  const attackedResult = structuredClone(resultX);
  const attackedIntent = structuredClone(intentX);
  const attackedPersist = persistVerifiedReceiptV1(attackedResult, attackedIntent, restartReceiptStore);
  attackedResult.receipt = structuredClone(resultY.receipt);
  Object.assign(attackedIntent, structuredClone(intentY));
  await attackedPersist;
  const restartRemote = new AdversarialRemote();
  const restarted = await restartDurablePublishV1(
    durableIntentStore.load(), restartReceiptStore.load(), restartRemote, verifiedAt,
  );
  assert.equal(restarted.outcome, 'AlreadyPublishedExact');
  assert.deepEqual(restarted.receipt, expectedReceipt);
  assert.equal(restartRemote.getCalls.length, 0);
  assert.equal(restartRemote.putCalls.length, 0);

  const failedStore = {
    persistCount: 0,
    async persist() {
      this.persistCount += 1;
      throw new Error('receipt disk failed');
    },
  };
  await assert.rejects(
    persistVerifiedReceiptV1(structuredClone(resultX), structuredClone(intentX), failedStore),
    /receipt disk failed/,
  );
  assert.equal(failedStore.persistCount, 1);
  const recoveryRemote = new AdversarialRemote();
  recoveryRemote.objects.set(intentX.remotePath, intentX.exactBytes);
  assert.equal((await recoverPreparedIntentV1(intentX, recoveryRemote, verifiedAt)).outcome,
    'AlreadyPublishedExact');

  const concurrentStore = new SerializedReceiptStore();
  const concurrentResult = structuredClone(resultX);
  const concurrentIntent = structuredClone(intentX);
  const first = persistVerifiedReceiptV1(concurrentResult, concurrentIntent, concurrentStore);
  const second = persistVerifiedReceiptV1(concurrentResult, concurrentIntent, concurrentStore);
  concurrentResult.receipt = structuredClone(resultY.receipt);
  Object.assign(concurrentIntent, structuredClone(intentY));
  await Promise.all([first, second]);
  assert.equal(concurrentStore.persistCount, 2);
  assert.ok(concurrentStore.history.every(blob => (
    JSON.stringify(JSON.parse(blob)) === JSON.stringify(expectedReceipt)
  )));
  assert.deepEqual(concurrentStore.load(), expectedReceipt);
});

test('durable stores and crash cut-points distinguish missing, new, reused, and corrupt receipts', async () => {
  const intent = await prepared();
  const neverCalledRemote = new AdversarialRemote();
  const failingStore = { async persist() { throw new Error('disk failed'); } };
  await assert.rejects(persistPreparedIntentBeforePublishV1(intent, failingStore), /disk failed/);
  assert.equal(neverCalledRemote.putCalls.length, 0);
  await assert.rejects(publishPersistedIntentV1({
    persistedFingerprint: intent.intentFingerprint,
  }, neverCalledRemote, verifiedAt), { message: 'LOCAL_PREPARED_INTENT_CORRUPTION' });

  const intentStore = new SerializedIntentStore();
  const persisted = await persistPreparedIntentBeforePublishV1(intent, intentStore);
  assert.equal(persisted.persistedFingerprint, intent.intentFingerprint);

  const receiptRemote = new AdversarialRemote();
  receiptRemote.objects.set(intent.remotePath, intent.exactBytes);
  const receiptResult = await recoverPreparedIntentV1(intentStore.load(), receiptRemote, verifiedAt);
  assert.equal(receiptResult.outcome, 'AlreadyPublishedExact');
  const receiptStore = new SerializedReceiptStore();
  await persistVerifiedReceiptV1(receiptResult, intentStore.load(), receiptStore);

  for (const cut of fixture.crashCutPoints) {
    const remote = new AdversarialRemote();
    if (!cut.durableIntentPresent) {
      assert.equal(cut.expectedOutcome, 'NoNetworkWithoutIntent');
      assert.equal(remote.getCalls.length, cut.expectedGetCount);
      assert.equal(remote.putCalls.length, cut.expectedPutCount);
      continue;
    }
    const durableIntent = intentStore.load();
    if (cut.remoteObjectState === 'exact') {
      remote.objects.set(durableIntent.remotePath, durableIntent.exactBytes);
    }
    const durableReceipt = cut.durableReceiptPresent ? receiptStore.load() : null;
    if (cut.durableReceiptCorrupted) durableReceipt.remotePath += '.corrupt';
    if (cut.expectedOutcome === 'LOCAL_PUBLISHED_RECEIPT_CORRUPTION') {
      await assert.rejects(
        restartDurablePublishV1(durableIntent, durableReceipt, remote, verifiedAt),
        { message: cut.expectedOutcome },
        cut.cutPoint,
      );
    } else {
      const recovered = await restartDurablePublishV1(
        durableIntent, durableReceipt, remote, verifiedAt,
      );
      assert.equal(recovered.outcome, cut.expectedOutcome, cut.cutPoint);
      if (cut.expectedReceiptAction === 'reuse-existing') {
        assert.deepEqual(recovered.receipt, durableReceipt, cut.cutPoint);
      }
      if (cut.expectedReceiptAction === 'create-new') {
        assert.equal(durableReceipt, null, cut.cutPoint);
        await validatePublishedReceiptV1(recovered.receipt, durableIntent);
      }
    }
    assert.equal(remote.getCalls.length, cut.expectedGetCount, cut.cutPoint);
    assert.equal(remote.putCalls.length, cut.expectedPutCount, cut.cutPoint);
  }

  const remote = new AdversarialRemote();
  remote.putMode = 'store-then-timeout';
  const result = await publishPersistedIntentV1(persisted, remote, verifiedAt);
  assert.equal(result.outcome, 'AlreadyPublishedExact');
  await assert.rejects(persistVerifiedReceiptV1(
    { outcome: 'RetryPublishExact' }, intent, receiptStore,
  ), { message: 'receipt_requires_exact_remote_verification' });
  await persistVerifiedReceiptV1(result, intent, receiptStore);
  await validatePublishedReceiptV1(receiptStore.load(), intentStore.load());
});

test('receipt loss, delayed exact visibility, and restart never regenerate identity', async () => {
  const intent = await prepared();
  const remote = new AdversarialRemote();
  remote.objects.set(intent.remotePath, intent.exactBytes);
  remote.delayedReads = 1;
  const first = await publishPersisted(intent, remote);
  assert.equal(first.outcome, 'RemoteIndeterminate');
  const recovered = await recoverPreparedIntentV1(structuredClone(intent), remote, verifiedAt);
  assert.equal(recovered.outcome, 'AlreadyPublishedExact');
  assert.deepEqual(recovered.receipt.commitRef, intent.commitRef);
  assert.equal(recovered.receipt.remotePath, intent.remotePath);
  assert.equal(recovered.receipt.contentHash, intent.contentHash);

  const failedReceiptStore = { async persist() { throw new Error('receipt disk failed'); } };
  await assert.rejects(persistVerifiedReceiptV1(recovered, intent, failedReceiptStore), /receipt disk failed/);
  const afterRestart = await recoverPreparedIntentV1(intent, remote, verifiedAt);
  assert.equal(afterRestart.outcome, 'AlreadyPublishedExact');
  assert.deepEqual(afterRestart.receipt, recovered.receipt);
});

test('pure publish state machine rejects skipped verification', () => {
  let state = 'PREPARED';
  state = advanceImmutablePublishStateV1(state, 'PUT_STARTED');
  assert.equal(state, 'PUT_ATTEMPTED');
  assert.throws(() => advanceImmutablePublishStateV1(state, 'REMOTE_EXACT'), {
    message: 'invalid_immutable_publish_transition',
  });
  state = advanceImmutablePublishStateV1(state, 'VERIFY_STARTED');
  assert.equal(advanceImmutablePublishStateV1(state, 'REMOTE_EXACT'), 'VERIFIED_PUBLISHED');
  assert.equal(advanceImmutablePublishStateV1(state, 'REMOTE_ABSENT'), 'PREPARED');
  assert.equal(advanceImmutablePublishStateV1(state, 'REMOTE_MISMATCH'), 'CORRUPTION_MISMATCH');
  assert.equal(advanceImmutablePublishStateV1(state, 'REMOTE_INDETERMINATE'), 'REMOTE_INDETERMINATE');
});

test('deterministic path and preparation properties hold across 512 generated commits', async () => {
  const template = JSON.parse(exactBytes().toString('utf8'));
  let state = 0x9e3779b97f4a7c15n;
  const propertyPaths = [];
  for (let index = 1; index <= 512; index += 1) {
    state = (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) & ((1n << 64n) - 1n);
    const sequence = (state || 1n).toString();
    const suffix = String(index).padStart(12, '0');
    const wire = structuredClone(template);
    wire.writerId = `10000000-0000-4000-8000-${suffix}`;
    wire.writerSeq = sequence;
    wire.commitId = `20000000-0000-4000-8000-${suffix}`;
    propertyPaths.push(buildCommitRemotePathV1({
      writerId: wire.writerId,
      writerSeq: sequence,
      commitId: wire.commitId,
      contentHash: fixture.pathIdentity.contentHash,
    }));
    const bytes = Buffer.from(JSON.stringify(wire));
    const intent = await prepareCommitIntentV1(bytes, fixture.preparedIntent.createdLocallyAtDiagnostic);
    assert.equal(intent.contentHash, await sha256Hex(bytes));
    assert.equal(intent.commitRef.contentHash, intent.contentHash);
    assert.equal(buildCommitRemotePathV1(intent.commitRef), intent.remotePath);
    assert.match(intent.remotePath, new RegExp(`/${sequence.padStart(20, '0')}--`));
  }
  assert.equal(propertyPaths.length, fixture.pathProperty.count);
  assert.equal(
    await sha256Hex(new TextEncoder().encode(propertyPaths.join('\n'))),
    fixture.pathProperty.expectedPathsSha256,
  );
});
