import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const causal = JSON.parse(await readFile(
  new URL('../contracts/s2-lite/v1/causal-golden-v1.json', import.meta.url),
));
const output = new URL('../contracts/s2-lite/v1/raw-wire-json-v1.json', import.meta.url);
const base = structuredClone(causal.rawWireCommit);
delete base.resolves;

const encode = (name, bytes, expected) => {
  const exactBytes = Buffer.from(bytes);
  const expectedContentHash = createHash('sha256').update(exactBytes).digest('hex');
  const expectedNormalizedCommit = expected === 'accept' ? JSON.parse(exactBytes.toString('utf8')) : undefined;
  if (expectedNormalizedCommit !== undefined) {
    expectedNormalizedCommit.resolves ??= [];
    expectedNormalizedCommit.contentHash = expectedContentHash;
  }
  return {
    name,
    utf8Base64: exactBytes.toString('base64'),
    expectedContentHash,
    ...(expectedNormalizedCommit === undefined ? {} : { expectedNormalizedCommit }),
    expected,
  };
};
const raw = value => JSON.stringify(value);
const mutation = raw(base);

const resolution = structuredClone(base);
resolution.commitId = '20000000-0000-4000-8000-000000000091';
resolution.commitKind = 'resolution';
resolution.source = { type: 'manual-resolution' };
resolution.resolves = ['0'.repeat(64)];

const legacyBootstrap = structuredClone(base);
legacyBootstrap.commitId = '20000000-0000-4000-8000-000000000092';
legacyBootstrap.commitKind = 'bootstrap';
legacyBootstrap.source = { type: 'legacy-bootstrap' };

const newRootBootstrap = structuredClone(legacyBootstrap);
newRootBootstrap.commitId = '20000000-0000-4000-8000-000000000093';
newRootBootstrap.source = { type: 'new-root-bootstrap' };

const mutationWrongSource = structuredClone(base);
mutationWrongSource.source = { type: 'legacy-bootstrap' };
const resolutionWrongSource = structuredClone(resolution);
resolutionWrongSource.source = { type: 'native' };
const bootstrapWrongSource = structuredClone(legacyBootstrap);
bootstrapWrongSource.source = { type: 'native' };
const bootstrapResolutionSource = structuredClone(legacyBootstrap);
bootstrapResolutionSource.source = { type: 'manual-resolution' };

const numeric = structuredClone(base);
numeric.commitId = '20000000-0000-4000-8000-000000000094';
numeric.mutations[0].entityType = 'episode-completion';
numeric.mutations[0].entityKey = ['episode-completion', 'numeric', 5];
numeric.mutations[0].value = {
  id: 'a',
  recordId: 'numeric',
  episodeNumber: 5,
  completedAt: null,
  createdAt: '2026-09-06T10:00:00.000Z',
  updatedAt: '2026-09-06T10:00:00.000Z',
  rev: '0',
  revActor: '',
};
numeric.mutations[0].changedFields = ['completedAt'];
const numericRaw = raw(numeric)
  .replace('["episode-completion","numeric",5]', '["episode-completion","numeric",5.0]')
  .replace('"episodeNumber":5', '"episodeNumber":5.0');

const cases = [
  encode('canonical-mutation-resolves-absent', mutation, 'accept'),
  encode('canonical-resolution', raw(resolution), 'accept'),
  encode('legacy-bootstrap', raw(legacyBootstrap), 'accept'),
  encode('new-root-bootstrap', raw(newRootBootstrap), 'accept'),
  encode('safe-integer-lexical-float', numericRaw, 'accept'),
  encode(
    'protocol-version-lexical-float',
    mutation.replace('"protocolVersion":1', '"protocolVersion":1.0'),
    'accept',
  ),
  encode('mutation-wrong-source', raw(mutationWrongSource), 'reject'),
  encode('resolution-wrong-source', raw(resolutionWrongSource), 'reject'),
  encode('bootstrap-wrong-source', raw(bootstrapWrongSource), 'reject'),
  encode('bootstrap-resolution-source', raw(bootstrapResolutionSource), 'reject'),
  encode('utf8-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(mutation)]), 'reject'),
  encode('invalid-utf8', Buffer.from([0xff, 0xfe, 0x7b]), 'reject'),
  encode(
    'duplicate-top-level-key',
    mutation.replace('"protocolVersion":1', '"protocolVersion":999,"protocolVersion":1'),
    'reject',
  ),
  encode(
    'duplicate-source-key',
    mutation.replace(
      '"source":{"type":"native"}',
      '"source":{"type":"native","type":"legacy-bootstrap"}',
    ),
    'reject',
  ),
  encode(
    'duplicate-mutation-key',
    mutation.replace(
      '"entityKey":["collection","raw-wire"]',
      '"entityKey":["collection","wrong"],"entityKey":["collection","raw-wire"]',
    ),
    'reject',
  ),
  encode(
    'duplicate-nested-payload-key',
    mutation.replace('"name":"Collection"', '"name":"Wrong","name":"Collection"'),
    'reject',
  ),
  encode(
    'number-outside-finite-float64',
    mutation.replace('"description":null', '"description":1e400'),
    'reject',
  ),
  encode(
    'unpaired-unicode-surrogate',
    mutation.replace('"name":"Collection"', '"name":"\\ud800"'),
    'reject',
  ),
  encode('trailing-garbage', `${mutation}x`, 'reject'),
  encode('malformed-json', mutation.slice(0, -1), 'reject'),
];

const serialized = `${JSON.stringify({
  schema: 'watchtracker-s2-lite-raw-wire-json-v1',
  description: 'Exact raw byte vectors. Decode utf8Base64 without text normalization before FrozenWireCommitV1 decoding.',
  cases,
}, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = await readFile(output, 'utf8');
  if (existing !== serialized) throw new Error('raw-wire-json-v1.json is stale');
  console.log(`verified ${cases.length} exact raw-wire byte vectors`);
} else {
  await writeFile(output, serialized);
}
