import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const rawFixture = JSON.parse(await readFile(
  new URL('../contracts/s2-lite/v1/raw-wire-json-v1.json', import.meta.url),
));
const output = new URL('../contracts/s2-lite/v1/publish-golden-v1.json', import.meta.url);
const rawCommit = rawFixture.cases.find(item => item.name === 'canonical-mutation-resolves-absent');
if (rawCommit === undefined || rawCommit.expected !== 'accept') throw new Error('missing approved raw commit');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const compareUtf16 = (a, b) => {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);
    if (difference !== 0) return Math.sign(difference);
  }
  return Math.sign(a.length - b.length);
};
const canonical = value => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort(compareUtf16).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const buildPath = ref => {
  const sequence = BigInt(ref.writerSeq);
  const segment = ((sequence - 1n) / 256n).toString(16).padStart(14, '0');
  const sequence20 = sequence.toString().padStart(20, '0');
  return `writers/${ref.writerId}/segments/${segment}/${sequence20}--${ref.commitId}--${ref.contentHash}.json`;
};
const writerId = '10000000-0000-4000-8000-000000000090';
const commitId = '20000000-0000-4000-8000-000000000090';
const zeroHash = '0'.repeat(64);
const pathRef = writerSeq => ({ writerId, writerSeq, commitId, contentHash: zeroHash });
const pathCases = ['1', '256', '257', '512', '513', '18446744073709551615'].map(writerSeq => ({
  writerSeq,
  expectedPath: buildPath(pathRef(writerSeq)),
}));
let pathPropertyState = 0x9e3779b97f4a7c15n;
const pathPropertyValues = [];
for (let index = 1; index <= 512; index += 1) {
  pathPropertyState = (
    pathPropertyState * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n
  ) & ((1n << 64n) - 1n);
  const suffix = String(index).padStart(12, '0');
  pathPropertyValues.push(buildPath({
    writerId: `10000000-0000-4000-8000-${suffix}`,
    writerSeq: (pathPropertyState || 1n).toString(),
    commitId: `20000000-0000-4000-8000-${suffix}`,
    contentHash: zeroHash,
  }));
}

const exactBytes = Buffer.from(rawCommit.utf8Base64, 'base64');
const commitRef = {
  writerId: rawCommit.expectedNormalizedCommit.writerId,
  writerSeq: rawCommit.expectedNormalizedCommit.writerSeq,
  commitId: rawCommit.expectedNormalizedCommit.commitId,
  contentHash: sha256(exactBytes),
};
const remotePath = buildPath(commitRef);
const intentCore = {
  domain: 'watchtracker-s2-lite-prepared-intent-fingerprint-v1',
  intentVersion: 1,
  objectKind: 'commit',
  remotePath,
  exactBytesHex: exactBytes.toString('hex'),
  contentHash: commitRef.contentHash,
  commitRef,
};
const differentBytes = Buffer.from('remote-corruption', 'utf8');
const fixture = {
  schema: 'watchtracker-s2-lite-publish-golden-v1',
  description: 'Language-neutral immutable path, PreparedIntent, recovery, and crash-cut-point vectors.',
  pathIdentity: { writerId, commitId, contentHash: zeroHash },
  pathCases,
  pathProperty: {
    seedHex: '9e3779b97f4a7c15',
    count: pathPropertyValues.length,
    expectedPathsSha256: sha256(Buffer.from(pathPropertyValues.join('\n'), 'utf8')),
  },
  invalidWriterSeqCases: [
    { writerSeq: '0', expectedError: 'invalid_writer_seq' },
    { writerSeq: '01', expectedError: 'invalid_writer_seq' },
    { writerSeq: '18446744073709551616', expectedError: 'invalid_writer_seq' },
  ],
  preparedIntent: {
    exactBytesBase64: exactBytes.toString('base64'),
    createdLocallyAtDiagnostic: '2026-09-08T04:00:00.000Z',
    expectedContentHash: commitRef.contentHash,
    expectedCommitRef: commitRef,
    expectedRemotePath: remotePath,
    expectedIntentFingerprint: sha256(Buffer.from(canonical(intentCore), 'utf8')),
  },
  recoveryCases: [
    { name: 'same-path-same-bytes', remote: 'exact', expectedOutcome: 'AlreadyPublishedExact' },
    { name: 'same-path-different-bytes', remote: 'different', expectedOutcome: 'CorruptionMismatch' },
    { name: 'definitely-absent', remote: 'absent', expectedOutcome: 'RetryPublishExact' },
    { name: 'indeterminate-get', remote: 'indeterminate', expectedOutcome: 'RemoteIndeterminate' },
    { name: 'auth-or-capability-failure', remote: 'auth', expectedOutcome: 'AuthOrCapabilityFailure' },
  ],
  publishCases: [
    {
      name: 'already-exact-preflight',
      initialRemote: 'exact',
      putBehavior: 'not-called',
      verifyBehavior: 'not-called',
      expectedTrace: ['GET_PREFLIGHT', 'REMOTE_EXACT', 'RECEIPT_READY'],
      expectedGetCount: 1,
      expectedPutCount: 0,
      expectedOutcome: 'AlreadyPublishedExact',
    },
    {
      name: 'store-then-timeout-rejection',
      initialRemote: 'absent',
      putBehavior: 'store-then-reject-indeterminate',
      verifyBehavior: 'exact',
      expectedTrace: ['GET_PREFLIGHT', 'REMOTE_ABSENT', 'PUT_ATTEMPT', 'PUT_REJECTED', 'GET_VERIFY', 'REMOTE_EXACT', 'RECEIPT_READY'],
      expectedGetCount: 2,
      expectedPutCount: 1,
      expectedOutcome: 'AlreadyPublishedExact',
    },
    {
      name: 'timeout-before-store-rejection',
      initialRemote: 'absent',
      putBehavior: 'reject-indeterminate-before-store',
      verifyBehavior: 'absent',
      expectedTrace: ['GET_PREFLIGHT', 'REMOTE_ABSENT', 'PUT_ATTEMPT', 'PUT_REJECTED', 'GET_VERIFY', 'REMOTE_ABSENT'],
      expectedGetCount: 2,
      expectedPutCount: 1,
      expectedOutcome: 'RetryPublishExact',
    },
    {
      name: 'verify-get-rejection',
      initialRemote: 'absent',
      putBehavior: 'success',
      verifyBehavior: 'reject-indeterminate',
      expectedTrace: ['GET_PREFLIGHT', 'REMOTE_ABSENT', 'PUT_ATTEMPT', 'PUT_SUCCESS', 'GET_VERIFY', 'GET_REJECTED'],
      expectedGetCount: 2,
      expectedPutCount: 1,
      expectedOutcome: 'RemoteIndeterminate',
    },
  ],
  differentRemoteBytesBase64: differentBytes.toString('base64'),
  differentRemoteBytesHash: sha256(differentBytes),
  crashCutPoints: [
    {
      cutPoint: 'A-before-intent-persistence', durableIntentPresent: false,
      durableReceiptPresent: false, remoteObjectState: 'absent', restartAction: 'no-publish-without-intent',
      expectedGetCount: 0, expectedPutCount: 0, expectedReceiptAction: 'none',
      expectedOutcome: 'NoNetworkWithoutIntent',
    },
    {
      cutPoint: 'B-after-intent-persistence', durableIntentPresent: true,
      durableReceiptPresent: false, remoteObjectState: 'absent', restartAction: 'recover-durable-intent',
      expectedGetCount: 1, expectedPutCount: 0, expectedReceiptAction: 'none',
      expectedOutcome: 'RetryPublishExact',
    },
    {
      cutPoint: 'C-put-before-server-write', durableIntentPresent: true,
      durableReceiptPresent: false, remoteObjectState: 'absent', restartAction: 'recover-durable-intent',
      expectedGetCount: 1, expectedPutCount: 0, expectedReceiptAction: 'none',
      expectedOutcome: 'RetryPublishExact',
    },
    {
      cutPoint: 'D-server-write-before-response', durableIntentPresent: true,
      durableReceiptPresent: false, remoteObjectState: 'exact', restartAction: 'recover-durable-intent',
      expectedGetCount: 1, expectedPutCount: 0, expectedReceiptAction: 'create-new',
      expectedOutcome: 'AlreadyPublishedExact',
    },
    {
      cutPoint: 'E-put-response-before-verify', durableIntentPresent: true,
      durableReceiptPresent: false, remoteObjectState: 'exact', restartAction: 'recover-durable-intent',
      expectedGetCount: 1, expectedPutCount: 0, expectedReceiptAction: 'create-new',
      expectedOutcome: 'AlreadyPublishedExact',
    },
    {
      cutPoint: 'F-verify-before-receipt', durableIntentPresent: true,
      durableReceiptPresent: false, remoteObjectState: 'exact', restartAction: 'recover-durable-intent',
      expectedGetCount: 1, expectedPutCount: 0, expectedReceiptAction: 'create-new',
      expectedOutcome: 'AlreadyPublishedExact',
    },
    {
      cutPoint: 'G-after-receipt-persistence', durableIntentPresent: true,
      durableReceiptPresent: true, remoteObjectState: 'exact', restartAction: 'load-and-validate-existing-receipt',
      expectedGetCount: 0, expectedPutCount: 0, expectedReceiptAction: 'reuse-existing',
      expectedOutcome: 'AlreadyPublishedExact',
    },
    {
      cutPoint: 'G-corrupted-durable-receipt', durableIntentPresent: true,
      durableReceiptPresent: true, durableReceiptCorrupted: true, remoteObjectState: 'exact',
      restartAction: 'load-and-reject-existing-receipt', expectedGetCount: 0, expectedPutCount: 0,
      expectedReceiptAction: 'reject-existing', expectedOutcome: 'LOCAL_PUBLISHED_RECEIPT_CORRUPTION',
    },
  ],
};

const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = await readFile(output, 'utf8');
  if (existing !== serialized) throw new Error('publish-golden-v1.json is stale');
  console.log(`verified ${pathCases.length} path and ${fixture.recoveryCases.length} recovery publish vectors`);
} else {
  await writeFile(output, serialized);
}
