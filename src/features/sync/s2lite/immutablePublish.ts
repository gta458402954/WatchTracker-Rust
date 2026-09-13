import {
  S2ProtocolValidationError,
  canonicalJcsBytes,
  compareCommitRefV1,
  parseWriterSeq,
  sha256Hex,
  validateCanonicalUuidV4,
  validateCanonicalTimestamp,
  validateCommitRef,
  validateContentHash,
} from './canonical.ts';
import { decodeFrozenWireCommitV1 } from './causalReducer.ts';
import type { CommitRef, JsonValue } from './types.ts';

export const COMMIT_SEGMENT_SIZE_V1 = 256n;
export const WRITER_SEQ_PATH_WIDTH_V1 = 20;
export const SEGMENT_NAME_WIDTH_V1 = 14;

export interface PreparedIntentV1 {
  intentVersion: 1;
  objectKind: 'commit';
  remotePath: string;
  exactBytes: Uint8Array;
  contentHash: string;
  commitRef: CommitRef;
  intentFingerprint: string;
  createdLocallyAtDiagnostic: string;
}

export interface RemotePublishedReceiptV1 {
  receiptVersion: 1;
  remotePath: string;
  contentHash: string;
  commitRef: CommitRef;
  preparedIntentFingerprint: string;
  verifiedExactBytesHash: string;
  verifiedAtDiagnostic: string;
}

export type RemoteExactGetResultV1 =
  | { state: 'DefinitelyPresent'; bytes: Uint8Array }
  | { state: 'DefinitelyAbsent' }
  | { state: 'Indeterminate' }
  | { state: 'AuthOrCapabilityFailure' };

export type RemotePutResultV1 =
  | { state: 'Success' }
  | { state: 'Indeterminate' }
  | { state: 'AuthOrCapabilityFailure' };

export interface ImmutableObjectRemoteV1 {
  getExact(remotePath: string): Promise<RemoteExactGetResultV1>;
  putExact(
    remotePath: string,
    exactBytes: Uint8Array,
    defenseInDepth: { ifNoneMatchStar: true },
  ): Promise<RemotePutResultV1>;
}

export interface PreparedIntentStoreV1 {
  persist(intent: Readonly<PreparedIntentV1>): Promise<void>;
}

export interface PublishedReceiptStoreV1 {
  persist(receipt: Readonly<RemotePublishedReceiptV1>): Promise<void>;
}

export interface PreparedActivationIntentStoreV1 {
  persist(intent: Readonly<PreparedActivationIntentV1>): Promise<void>;
}

export interface PublishedActivationReceiptStoreV1 {
  persist(receipt: Readonly<PublishedActivationReceiptV1>): Promise<void>;
}

export interface PreparedActivationIntentV1 {
  intentVersion: 1;
  objectKind: 'activation';
  remotePath: string;
  exactBytes: Uint8Array;
  contentHash: string;
  activationId: string;
  intentFingerprint: string;
  createdLocallyAtDiagnostic: string;
}

export interface PublishedActivationReceiptV1 {
  receiptVersion: 1;
  remotePath: string;
  contentHash: string;
  activationId: string;
  preparedIntentFingerprint: string;
  verifiedExactBytesHash: string;
  verifiedAtDiagnostic: string;
}

export type PublishActivationResultV1 =
  | { outcome: 'AlreadyPublishedExact'; receipt: PublishedActivationReceiptV1 }
  | { outcome: 'CorruptionMismatch'; safetyEvent: ImmutablePathMismatchEventV1 }
  | { outcome: 'RemoteIndeterminate' }
  | { outcome: 'AuthOrCapabilityFailure' };

const persistedIntentBrand: unique symbol = Symbol('s2-lite-persisted-intent-v1');

export interface PersistedPreparedIntentV1 {
  readonly persistedFingerprint: string;
  readonly [persistedIntentBrand]: true;
}

const ownedPersistedIntents = new WeakMap<object, PreparedIntentV1>();
const ownedPersistedActivationIntents = new WeakMap<object, PreparedActivationIntentV1>();

export interface PersistedPreparedActivationIntentV1 {
  readonly persistedFingerprint: string;
  readonly [persistedIntentBrand]: true;
}

export class RemoteOperationalFailureV1 extends Error {
  readonly category: 'Indeterminate' | 'AuthOrCapabilityFailure';

  constructor(category: 'Indeterminate' | 'AuthOrCapabilityFailure') {
    super(category);
    this.name = 'RemoteOperationalFailureV1';
    this.category = category;
  }
}

export interface ImmutablePathMismatchEventV1 {
  code: 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH';
  freezeClass: 'SYNC_ROOT_FROZEN_CORRUPTION';
  remotePath: string;
  expectedContentHash: string;
  observedContentHash: string;
}

export type RecoverPreparedIntentResultV1 =
  | { outcome: 'AlreadyPublishedExact'; receipt: RemotePublishedReceiptV1 }
  | { outcome: 'RetryPublishExact' }
  | { outcome: 'CorruptionMismatch'; safetyEvent: ImmutablePathMismatchEventV1 }
  | { outcome: 'RemoteIndeterminate' }
  | { outcome: 'AuthOrCapabilityFailure' };

export type ImmutablePublishStateV1 =
  | 'PREPARED'
  | 'PUT_ATTEMPTED'
  | 'VERIFY_REMOTE'
  | 'VERIFIED_PUBLISHED'
  | 'CORRUPTION_MISMATCH'
  | 'REMOTE_INDETERMINATE'
  | 'AUTH_OR_CAPABILITY_FAILURE';

export type ImmutablePublishEventV1 =
  | 'PUT_STARTED'
  | 'VERIFY_STARTED'
  | 'REMOTE_EXACT'
  | 'REMOTE_ABSENT'
  | 'REMOTE_MISMATCH'
  | 'REMOTE_INDETERMINATE'
  | 'REMOTE_AUTH_OR_CAPABILITY_FAILURE';

function invalid(code: string): never {
  throw new S2ProtocolValidationError(code);
}

function hasExactFields(input: object, fields: readonly string[]): boolean {
  const actual = Object.keys(input).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function exactBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function exactRefEqual(left: CommitRef, right: CommitRef): boolean {
  return compareCommitRefV1(left, right) === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function copyPreparedIntent(intent: PreparedIntentV1): PreparedIntentV1 {
  return {
    ...intent,
    exactBytes: Uint8Array.from(intent.exactBytes),
    commitRef: { ...intent.commitRef },
  };
}

function copyPublishedReceipt(receipt: RemotePublishedReceiptV1): RemotePublishedReceiptV1 {
  return { ...receipt, commitRef: { ...receipt.commitRef } };
}

function intentFingerprintCore(intent: Omit<PreparedIntentV1, 'intentFingerprint'>): JsonValue {
  return {
    domain: 'watchtracker-s2-lite-prepared-intent-fingerprint-v1',
    intentVersion: intent.intentVersion,
    objectKind: intent.objectKind,
    remotePath: intent.remotePath,
    exactBytesHex: bytesToHex(intent.exactBytes),
    contentHash: intent.contentHash,
    commitRef: intent.commitRef as unknown as JsonValue,
  };
}

async function computeIntentFingerprintV1(
  intent: Omit<PreparedIntentV1, 'intentFingerprint'>,
): Promise<string> {
  return sha256Hex(canonicalJcsBytes(intentFingerprintCore(intent)));
}

export function buildCommitRemotePathV1(commitRef: CommitRef): string {
  validateCommitRef(commitRef);
  const writerSeq = parseWriterSeq(commitRef.writerSeq);
  const segmentIndex = (writerSeq - 1n) / COMMIT_SEGMENT_SIZE_V1;
  const segmentName = segmentIndex.toString(16).padStart(SEGMENT_NAME_WIDTH_V1, '0');
  if (segmentName.length !== SEGMENT_NAME_WIDTH_V1) invalid('segment_name_overflow');
  const writerSeq20 = writerSeq.toString(10).padStart(WRITER_SEQ_PATH_WIDTH_V1, '0');
  if (writerSeq20.length !== WRITER_SEQ_PATH_WIDTH_V1) invalid('writer_seq_path_overflow');
  return `writers/${commitRef.writerId}/segments/${segmentName}/${writerSeq20}--${commitRef.commitId}--${commitRef.contentHash}.json`;
}

export async function prepareCommitIntentV1(
  exactCommitBytes: Uint8Array,
  createdLocallyAtDiagnostic: string,
): Promise<PreparedIntentV1> {
  validateCanonicalTimestamp(createdLocallyAtDiagnostic);
  const exactBytes = Uint8Array.from(exactCommitBytes);
  const commit = await decodeFrozenWireCommitV1(exactBytes);
  const commitRef: CommitRef = {
    writerId: commit.writerId,
    writerSeq: commit.writerSeq,
    commitId: commit.commitId,
    contentHash: commit.contentHash,
  };
  const withoutFingerprint: Omit<PreparedIntentV1, 'intentFingerprint'> = {
    intentVersion: 1,
    objectKind: 'commit',
    remotePath: buildCommitRemotePathV1(commitRef),
    exactBytes,
    contentHash: commit.contentHash,
    commitRef,
    createdLocallyAtDiagnostic,
  };
  return {
    ...withoutFingerprint,
    intentFingerprint: await computeIntentFingerprintV1(withoutFingerprint),
  };
}

async function validateOwnedPreparedIntentV1(intent: PreparedIntentV1): Promise<void> {
  if (typeof intent !== 'object' || intent === null || !hasExactFields(intent, [
    'intentVersion', 'objectKind', 'remotePath', 'exactBytes', 'contentHash', 'commitRef',
    'intentFingerprint', 'createdLocallyAtDiagnostic',
  ]) || intent.intentVersion !== 1 || intent.objectKind !== 'commit'
    || !(intent.exactBytes instanceof Uint8Array)) invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  try {
    validateContentHash(intent.contentHash);
    validateCommitRef(intent.commitRef);
    validateCanonicalTimestamp(intent.createdLocallyAtDiagnostic);
    if (intent.remotePath !== buildCommitRemotePathV1(intent.commitRef)) {
      invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
    }
    const exactHash = await sha256Hex(intent.exactBytes);
    if (exactHash !== intent.contentHash || exactHash !== intent.commitRef.contentHash) {
      invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
    }
    const decoded = await decodeFrozenWireCommitV1(intent.exactBytes);
    const decodedRef: CommitRef = {
      writerId: decoded.writerId,
      writerSeq: decoded.writerSeq,
      commitId: decoded.commitId,
      contentHash: decoded.contentHash,
    };
    if (!exactRefEqual(decodedRef, intent.commitRef)) invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
    const withoutFingerprint: Omit<PreparedIntentV1, 'intentFingerprint'> = {
      intentVersion: intent.intentVersion,
      objectKind: intent.objectKind,
      remotePath: intent.remotePath,
      exactBytes: intent.exactBytes,
      contentHash: intent.contentHash,
      commitRef: intent.commitRef,
      createdLocallyAtDiagnostic: intent.createdLocallyAtDiagnostic,
    };
    if (intent.intentFingerprint !== await computeIntentFingerprintV1(withoutFingerprint)) {
      invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
    }
  } catch (error) {
    if (error instanceof S2ProtocolValidationError
      && error.code === 'LOCAL_PREPARED_INTENT_CORRUPTION') throw error;
    return invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  }
}

export async function validatePreparedIntentV1(intent: PreparedIntentV1): Promise<void> {
  if (typeof intent !== 'object' || intent === null || !(intent.exactBytes instanceof Uint8Array)) {
    invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  }
  return validateOwnedPreparedIntentV1(copyPreparedIntent(intent));
}

async function makeReceiptV1(
  intent: PreparedIntentV1,
  verifiedAtDiagnostic: string,
): Promise<RemotePublishedReceiptV1> {
  validateCanonicalTimestamp(verifiedAtDiagnostic);
  return {
    receiptVersion: 1,
    remotePath: intent.remotePath,
    contentHash: intent.contentHash,
    commitRef: { ...intent.commitRef },
    preparedIntentFingerprint: intent.intentFingerprint,
    verifiedExactBytesHash: await sha256Hex(intent.exactBytes),
    verifiedAtDiagnostic,
  };
}

export async function validatePublishedReceiptV1(
  receipt: RemotePublishedReceiptV1,
  intent: PreparedIntentV1,
): Promise<void> {
  if (typeof receipt !== 'object' || receipt === null || typeof intent !== 'object' || intent === null
    || !(intent.exactBytes instanceof Uint8Array)) invalid('LOCAL_PUBLISHED_RECEIPT_CORRUPTION');
  const receiptSnapshot = copyPublishedReceipt(receipt);
  const intentSnapshot = copyPreparedIntent(intent);
  try {
    await validateOwnedPreparedIntentV1(intentSnapshot);
    if (!hasExactFields(receiptSnapshot, [
      'receiptVersion', 'remotePath', 'contentHash', 'commitRef', 'preparedIntentFingerprint',
      'verifiedExactBytesHash', 'verifiedAtDiagnostic',
    ])) invalid('LOCAL_PUBLISHED_RECEIPT_CORRUPTION');
    validateCanonicalTimestamp(receiptSnapshot.verifiedAtDiagnostic);
    validateContentHash(receiptSnapshot.contentHash);
    validateContentHash(receiptSnapshot.verifiedExactBytesHash);
    validateCommitRef(receiptSnapshot.commitRef);
    if (receiptSnapshot.receiptVersion !== 1
      || receiptSnapshot.remotePath !== intentSnapshot.remotePath
      || receiptSnapshot.contentHash !== intentSnapshot.contentHash
      || receiptSnapshot.verifiedExactBytesHash !== intentSnapshot.contentHash
      || receiptSnapshot.preparedIntentFingerprint !== intentSnapshot.intentFingerprint
      || !exactRefEqual(receiptSnapshot.commitRef, intentSnapshot.commitRef)) {
      invalid('LOCAL_PUBLISHED_RECEIPT_CORRUPTION');
    }
  } catch (error) {
    if (error instanceof S2ProtocolValidationError
      && error.code === 'LOCAL_PUBLISHED_RECEIPT_CORRUPTION') throw error;
    return invalid('LOCAL_PUBLISHED_RECEIPT_CORRUPTION');
  }
}

export function advanceImmutablePublishStateV1(
  state: ImmutablePublishStateV1,
  event: ImmutablePublishEventV1,
): ImmutablePublishStateV1 {
  if (event === 'PUT_STARTED' && state === 'PREPARED') return 'PUT_ATTEMPTED';
  if (event === 'VERIFY_STARTED' && (state === 'PREPARED' || state === 'PUT_ATTEMPTED')) {
    return 'VERIFY_REMOTE';
  }
  if (state === 'VERIFY_REMOTE') {
    if (event === 'REMOTE_EXACT') return 'VERIFIED_PUBLISHED';
    if (event === 'REMOTE_ABSENT') return 'PREPARED';
    if (event === 'REMOTE_MISMATCH') return 'CORRUPTION_MISMATCH';
    if (event === 'REMOTE_INDETERMINATE') return 'REMOTE_INDETERMINATE';
    if (event === 'REMOTE_AUTH_OR_CAPABILITY_FAILURE') return 'AUTH_OR_CAPABILITY_FAILURE';
  }
  return invalid('invalid_immutable_publish_transition');
}

async function classifyExactGetV1(
  intent: PreparedIntentV1,
  fetched: RemoteExactGetResultV1,
  verifiedAtDiagnostic: string,
): Promise<RecoverPreparedIntentResultV1> {
  if (fetched.state === 'DefinitelyAbsent') return { outcome: 'RetryPublishExact' };
  if (fetched.state === 'Indeterminate') return { outcome: 'RemoteIndeterminate' };
  if (fetched.state === 'AuthOrCapabilityFailure') return { outcome: 'AuthOrCapabilityFailure' };
  if (exactBytesEqual(fetched.bytes, intent.exactBytes)) {
    return { outcome: 'AlreadyPublishedExact', receipt: await makeReceiptV1(intent, verifiedAtDiagnostic) };
  }
  return {
    outcome: 'CorruptionMismatch',
    safetyEvent: {
      code: 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH',
      freezeClass: 'SYNC_ROOT_FROZEN_CORRUPTION',
      remotePath: intent.remotePath,
      expectedContentHash: intent.contentHash,
      observedContentHash: await sha256Hex(fetched.bytes),
    },
  };
}

async function callRemoteGetExactV1(
  remote: ImmutableObjectRemoteV1,
  remotePath: string,
): Promise<RemoteExactGetResultV1> {
  try {
    return await remote.getExact(remotePath);
  } catch (error) {
    if (error instanceof RemoteOperationalFailureV1) return { state: error.category };
    throw error;
  }
}

async function callRemotePutExactV1(
  remote: ImmutableObjectRemoteV1,
  remotePath: string,
  exactBytes: Uint8Array,
): Promise<RemotePutResultV1> {
  try {
    return await remote.putExact(remotePath, exactBytes, { ifNoneMatchStar: true });
  } catch (error) {
    if (error instanceof RemoteOperationalFailureV1) return { state: error.category };
    throw error;
  }
}

export async function recoverPreparedIntentV1(
  intent: PreparedIntentV1,
  remote: ImmutableObjectRemoteV1,
  verifiedAtDiagnostic: string,
): Promise<RecoverPreparedIntentResultV1> {
  if (typeof intent !== 'object' || intent === null || !(intent.exactBytes instanceof Uint8Array)) {
    invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  }
  const snapshot = copyPreparedIntent(intent);
  await validateOwnedPreparedIntentV1(snapshot);
  validateCanonicalTimestamp(verifiedAtDiagnostic);
  return classifyExactGetV1(
    snapshot,
    await callRemoteGetExactV1(remote, snapshot.remotePath),
    verifiedAtDiagnostic,
  );
}

async function publishPreparedIntentV1(
  intent: PreparedIntentV1,
  remote: ImmutableObjectRemoteV1,
  verifiedAtDiagnostic: string,
): Promise<RecoverPreparedIntentResultV1> {
  const preflight = await recoverPreparedIntentV1(intent, remote, verifiedAtDiagnostic);
  if (preflight.outcome !== 'RetryPublishExact') return preflight;
  const putResult = await callRemotePutExactV1(
    remote,
    intent.remotePath,
    Uint8Array.from(intent.exactBytes),
  );
  const verification = await classifyExactGetV1(
    intent,
    await callRemoteGetExactV1(remote, intent.remotePath),
    verifiedAtDiagnostic,
  );
  if (verification.outcome === 'RetryPublishExact' && putResult.state === 'AuthOrCapabilityFailure') {
    return { outcome: 'AuthOrCapabilityFailure' };
  }
  return verification;
}

export async function persistPreparedIntentBeforePublishV1(
  intent: PreparedIntentV1,
  store: PreparedIntentStoreV1,
): Promise<PersistedPreparedIntentV1> {
  if (typeof intent !== 'object' || intent === null || !(intent.exactBytes instanceof Uint8Array)) {
    invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  }
  const snapshot = copyPreparedIntent(intent);
  await validateOwnedPreparedIntentV1(snapshot);
  const durableCopy = copyPreparedIntent(snapshot);
  await store.persist(durableCopy);
  await validateOwnedPreparedIntentV1(durableCopy);
  const token: PersistedPreparedIntentV1 = Object.freeze({
    persistedFingerprint: snapshot.intentFingerprint,
    [persistedIntentBrand]: true as const,
  });
  ownedPersistedIntents.set(token, copyPreparedIntent(snapshot));
  return token;
}

export async function publishPersistedIntentV1(
  persisted: PersistedPreparedIntentV1,
  remote: ImmutableObjectRemoteV1,
  verifiedAtDiagnostic: string,
): Promise<RecoverPreparedIntentResultV1> {
  const owned = ownedPersistedIntents.get(persisted);
  if (persisted[persistedIntentBrand] !== true || owned === undefined) {
    invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  }
  const snapshot = copyPreparedIntent(owned);
  if (persisted.persistedFingerprint !== snapshot.intentFingerprint) {
    invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  }
  await validateOwnedPreparedIntentV1(snapshot);
  return publishPreparedIntentV1(snapshot, remote, verifiedAtDiagnostic);
}

export async function publishAdmittedPersistedIntentV1(
  persisted: PersistedPreparedIntentV1,
  remote: ImmutableObjectRemoteV1,
  verifiedAtDiagnostic: string,
): Promise<RecoverPreparedIntentResultV1> {
  const owned = ownedPersistedIntents.get(persisted);
  if (persisted[persistedIntentBrand] !== true || owned === undefined) {
    invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  }
  const intent = copyPreparedIntent(owned);
  if (persisted.persistedFingerprint !== intent.intentFingerprint) {
    invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  }
  // The module-private snapshot was fully validated before the durable token
  // was issued. Keep admission-to-PUT synchronous: no await may reopen a root
  // fatal race after the orchestration gate has admitted this exact attempt.
  validateCanonicalTimestamp(verifiedAtDiagnostic);
  const putResult = await callRemotePutExactV1(
    remote, intent.remotePath, Uint8Array.from(intent.exactBytes),
  );
  const verification = await classifyExactGetV1(
    intent,
    await callRemoteGetExactV1(remote, intent.remotePath),
    verifiedAtDiagnostic,
  );
  if (verification.outcome === 'RetryPublishExact' && putResult.state === 'AuthOrCapabilityFailure') {
    return { outcome: 'AuthOrCapabilityFailure' };
  }
  return verification;
}

export async function restartDurablePublishV1(
  durableIntent: PreparedIntentV1,
  durableReceipt: RemotePublishedReceiptV1 | null,
  remote: ImmutableObjectRemoteV1,
  verifiedAtDiagnostic: string,
): Promise<RecoverPreparedIntentResultV1> {
  if (typeof durableIntent !== 'object' || durableIntent === null
    || !(durableIntent.exactBytes instanceof Uint8Array)) invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  const intentSnapshot = copyPreparedIntent(durableIntent);
  if (durableReceipt !== null) {
    const receiptSnapshot = copyPublishedReceipt(durableReceipt);
    await validatePublishedReceiptV1(receiptSnapshot, intentSnapshot);
    return { outcome: 'AlreadyPublishedExact', receipt: receiptSnapshot };
  }
  return recoverPreparedIntentV1(intentSnapshot, remote, verifiedAtDiagnostic);
}

export async function persistVerifiedReceiptV1(
  result: RecoverPreparedIntentResultV1,
  intent: PreparedIntentV1,
  store: PublishedReceiptStoreV1,
): Promise<void> {
  if (result.outcome !== 'AlreadyPublishedExact') invalid('receipt_requires_exact_remote_verification');
  if (typeof result.receipt !== 'object' || result.receipt === null
    || typeof intent !== 'object' || intent === null
    || !(intent.exactBytes instanceof Uint8Array)) invalid('LOCAL_PUBLISHED_RECEIPT_CORRUPTION');
  const ownedReceipt = copyPublishedReceipt(result.receipt);
  const ownedIntent = copyPreparedIntent(intent);
  await validatePublishedReceiptV1(ownedReceipt, ownedIntent);
  const durableCopy = copyPublishedReceipt(ownedReceipt);
  await store.persist(durableCopy);
  await validatePublishedReceiptV1(durableCopy, ownedIntent);
}

function copyActivationIntent(intent: PreparedActivationIntentV1): PreparedActivationIntentV1 {
  return { ...intent, exactBytes: Uint8Array.from(intent.exactBytes) };
}

function activationIntentCore(intent: Omit<PreparedActivationIntentV1, 'intentFingerprint'>): JsonValue {
  return {
    domain: 'watchtracker-s2-lite-prepared-activation-intent-v1',
    intentVersion: intent.intentVersion,
    objectKind: intent.objectKind,
    remotePath: intent.remotePath,
    exactBytesHex: bytesToHex(intent.exactBytes),
    contentHash: intent.contentHash,
    activationId: intent.activationId,
  };
}

export async function prepareActivationIntentV1(
  activationId: string,
  exactActivationBytes: Uint8Array,
  createdLocallyAtDiagnostic: string,
): Promise<PreparedActivationIntentV1> {
  validateCanonicalUuidV4(activationId);
  validateCanonicalTimestamp(createdLocallyAtDiagnostic);
  const exactBytes = Uint8Array.from(exactActivationBytes);
  const contentHash = await sha256Hex(exactBytes);
  const withoutFingerprint: Omit<PreparedActivationIntentV1, 'intentFingerprint'> = {
    intentVersion: 1,
    objectKind: 'activation',
    remotePath: `activations/${activationId}--${contentHash}.json`,
    exactBytes,
    contentHash,
    activationId,
    createdLocallyAtDiagnostic,
  };
  return {
    ...withoutFingerprint,
    intentFingerprint: await sha256Hex(canonicalJcsBytes(activationIntentCore(withoutFingerprint))),
  };
}

export async function validatePreparedActivationIntentV1(
  input: PreparedActivationIntentV1,
): Promise<void> {
  const intent = copyActivationIntent(input);
  try {
    if (!hasExactFields(intent, [
      'intentVersion', 'objectKind', 'remotePath', 'exactBytes', 'contentHash', 'activationId',
      'intentFingerprint', 'createdLocallyAtDiagnostic',
    ]) || intent.intentVersion !== 1 || intent.objectKind !== 'activation') invalid('invalid');
    validateCanonicalUuidV4(intent.activationId);
    validateCanonicalTimestamp(intent.createdLocallyAtDiagnostic);
    validateContentHash(intent.contentHash);
    const hash = await sha256Hex(intent.exactBytes);
    if (hash !== intent.contentHash
      || intent.remotePath !== `activations/${intent.activationId}--${hash}.json`) invalid('invalid');
    const withoutFingerprint: Omit<PreparedActivationIntentV1, 'intentFingerprint'> = {
      intentVersion: intent.intentVersion,
      objectKind: intent.objectKind,
      remotePath: intent.remotePath,
      exactBytes: intent.exactBytes,
      contentHash: intent.contentHash,
      activationId: intent.activationId,
      createdLocallyAtDiagnostic: intent.createdLocallyAtDiagnostic,
    };
    const expected = await sha256Hex(canonicalJcsBytes(activationIntentCore(withoutFingerprint)));
    if (intent.intentFingerprint !== expected) invalid('invalid');
  } catch {
    invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  }
}

export async function validatePublishedActivationReceiptV1(
  input: PublishedActivationReceiptV1,
  intentInput: PreparedActivationIntentV1,
): Promise<void> {
  const receipt = structuredClone(input);
  const intent = copyActivationIntent(intentInput);
  try {
    await validatePreparedActivationIntentV1(intent);
    if (!hasExactFields(receipt, [
      'receiptVersion', 'remotePath', 'contentHash', 'activationId', 'preparedIntentFingerprint',
      'verifiedExactBytesHash', 'verifiedAtDiagnostic',
    ]) || receipt.receiptVersion !== 1) invalid('invalid');
    validateCanonicalTimestamp(receipt.verifiedAtDiagnostic);
    validateContentHash(receipt.contentHash);
    validateContentHash(receipt.verifiedExactBytesHash);
    validateCanonicalUuidV4(receipt.activationId);
    if (receipt.remotePath !== intent.remotePath || receipt.contentHash !== intent.contentHash
      || receipt.activationId !== intent.activationId
      || receipt.preparedIntentFingerprint !== intent.intentFingerprint
      || receipt.verifiedExactBytesHash !== intent.contentHash) invalid('invalid');
  } catch {
    invalid('LOCAL_PUBLISHED_RECEIPT_CORRUPTION');
  }
}

function activationReceipt(
  intent: PreparedActivationIntentV1,
  verifiedAtDiagnostic: string,
): PublishedActivationReceiptV1 {
  validateCanonicalTimestamp(verifiedAtDiagnostic);
  return {
    receiptVersion: 1,
    remotePath: intent.remotePath,
    contentHash: intent.contentHash,
    activationId: intent.activationId,
    preparedIntentFingerprint: intent.intentFingerprint,
    verifiedExactBytesHash: intent.contentHash,
    verifiedAtDiagnostic,
  };
}

async function publishPreparedActivationIntentV1(
  input: PreparedActivationIntentV1,
  remote: ImmutableObjectRemoteV1,
  verifiedAtDiagnostic: string,
): Promise<PublishActivationResultV1> {
  const intent = copyActivationIntent(input);
  await validatePreparedActivationIntentV1(intent);
  validateCanonicalTimestamp(verifiedAtDiagnostic);
  let fetched = await callRemoteGetExactV1(remote, intent.remotePath);
  if (fetched.state === 'DefinitelyAbsent') {
    const put = await callRemotePutExactV1(remote, intent.remotePath, Uint8Array.from(intent.exactBytes));
    fetched = await callRemoteGetExactV1(remote, intent.remotePath);
    if (fetched.state === 'DefinitelyAbsent' && put.state === 'AuthOrCapabilityFailure') {
      return { outcome: 'AuthOrCapabilityFailure' };
    }
  }
  if (fetched.state === 'Indeterminate' || fetched.state === 'DefinitelyAbsent') {
    return { outcome: 'RemoteIndeterminate' };
  }
  if (fetched.state === 'AuthOrCapabilityFailure') return { outcome: 'AuthOrCapabilityFailure' };
  const observedHash = await sha256Hex(fetched.bytes);
  if (!exactBytesEqual(fetched.bytes, intent.exactBytes)) {
    return {
      outcome: 'CorruptionMismatch',
      safetyEvent: {
        code: 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH',
        freezeClass: 'SYNC_ROOT_FROZEN_CORRUPTION',
        remotePath: intent.remotePath,
        expectedContentHash: intent.contentHash,
        observedContentHash: observedHash,
      },
    };
  }
  return { outcome: 'AlreadyPublishedExact', receipt: activationReceipt(intent, verifiedAtDiagnostic) };
}

export async function persistPreparedActivationIntentBeforePublishV1(
  input: PreparedActivationIntentV1,
  store: PreparedActivationIntentStoreV1,
): Promise<PersistedPreparedActivationIntentV1> {
  const snapshot = copyActivationIntent(input);
  await validatePreparedActivationIntentV1(snapshot);
  const durableCopy = copyActivationIntent(snapshot);
  await store.persist(durableCopy);
  await validatePreparedActivationIntentV1(durableCopy);
  const token: PersistedPreparedActivationIntentV1 = Object.freeze({
    persistedFingerprint: snapshot.intentFingerprint,
    [persistedIntentBrand]: true as const,
  });
  ownedPersistedActivationIntents.set(token, copyActivationIntent(snapshot));
  return token;
}

export async function publishPersistedActivationIntentV1(
  persisted: PersistedPreparedActivationIntentV1,
  remote: ImmutableObjectRemoteV1,
  verifiedAtDiagnostic: string,
): Promise<PublishActivationResultV1> {
  const owned = ownedPersistedActivationIntents.get(persisted);
  if (persisted[persistedIntentBrand] !== true || owned === undefined
    || persisted.persistedFingerprint !== owned.intentFingerprint) {
    invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  }
  const snapshot = copyActivationIntent(owned);
  await validatePreparedActivationIntentV1(snapshot);
  return publishPreparedActivationIntentV1(snapshot, remote, verifiedAtDiagnostic);
}

export async function publishAdmittedPersistedActivationIntentV1(
  persisted: PersistedPreparedActivationIntentV1,
  remote: ImmutableObjectRemoteV1,
  verifiedAtDiagnostic: string,
): Promise<PublishActivationResultV1> {
  const owned = ownedPersistedActivationIntents.get(persisted);
  if (persisted[persistedIntentBrand] !== true || owned === undefined
    || persisted.persistedFingerprint !== owned.intentFingerprint) {
    invalid('LOCAL_PREPARED_INTENT_CORRUPTION');
  }
  const intent = copyActivationIntent(owned);
  // As above, the owned snapshot was validated before token issuance. The
  // first asynchronous remote operation after admission must be the PUT.
  validateCanonicalTimestamp(verifiedAtDiagnostic);
  const put = await callRemotePutExactV1(remote, intent.remotePath, Uint8Array.from(intent.exactBytes));
  const fetched = await callRemoteGetExactV1(remote, intent.remotePath);
  if (fetched.state === 'DefinitelyAbsent' && put.state === 'AuthOrCapabilityFailure') {
    return { outcome: 'AuthOrCapabilityFailure' };
  }
  if (fetched.state === 'Indeterminate' || fetched.state === 'DefinitelyAbsent') {
    return { outcome: 'RemoteIndeterminate' };
  }
  if (fetched.state === 'AuthOrCapabilityFailure') return { outcome: 'AuthOrCapabilityFailure' };
  if (!exactBytesEqual(fetched.bytes, intent.exactBytes)) {
    return {
      outcome: 'CorruptionMismatch',
      safetyEvent: {
        code: 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH',
        freezeClass: 'SYNC_ROOT_FROZEN_CORRUPTION',
        remotePath: intent.remotePath,
        expectedContentHash: intent.contentHash,
        observedContentHash: await sha256Hex(fetched.bytes),
      },
    };
  }
  return { outcome: 'AlreadyPublishedExact', receipt: activationReceipt(intent, verifiedAtDiagnostic) };
}

export async function restartDurableActivationPublishV1(
  intentInput: PreparedActivationIntentV1,
  receiptInput: PublishedActivationReceiptV1 | null,
  remote: ImmutableObjectRemoteV1,
  verifiedAtDiagnostic: string,
): Promise<PublishActivationResultV1 | { outcome: 'RetryPublishExact' }> {
  const intent = copyActivationIntent(intentInput);
  await validatePreparedActivationIntentV1(intent);
  if (receiptInput !== null) {
    const receipt = structuredClone(receiptInput);
    await validatePublishedActivationReceiptV1(receipt, intent);
    return { outcome: 'AlreadyPublishedExact', receipt };
  }
  const fetched = await callRemoteGetExactV1(remote, intent.remotePath);
  if (fetched.state === 'DefinitelyAbsent') return { outcome: 'RetryPublishExact' };
  if (fetched.state === 'Indeterminate') return { outcome: 'RemoteIndeterminate' };
  if (fetched.state === 'AuthOrCapabilityFailure') return { outcome: 'AuthOrCapabilityFailure' };
  if (!exactBytesEqual(fetched.bytes, intent.exactBytes)) {
    return {
      outcome: 'CorruptionMismatch',
      safetyEvent: {
        code: 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH',
        freezeClass: 'SYNC_ROOT_FROZEN_CORRUPTION',
        remotePath: intent.remotePath,
        expectedContentHash: intent.contentHash,
        observedContentHash: await sha256Hex(fetched.bytes),
      },
    };
  }
  return { outcome: 'AlreadyPublishedExact', receipt: activationReceipt(intent, verifiedAtDiagnostic) };
}

export async function persistVerifiedActivationReceiptV1(
  result: PublishActivationResultV1,
  intentInput: PreparedActivationIntentV1,
  store: PublishedActivationReceiptStoreV1,
): Promise<void> {
  if (result.outcome !== 'AlreadyPublishedExact') invalid('receipt_requires_exact_remote_verification');
  const intent = copyActivationIntent(intentInput);
  const receipt = structuredClone(result.receipt);
  await validatePublishedActivationReceiptV1(receipt, intent);
  const durableCopy = structuredClone(receipt);
  await store.persist(durableCopy);
  await validatePublishedActivationReceiptV1(durableCopy, intent);
}
