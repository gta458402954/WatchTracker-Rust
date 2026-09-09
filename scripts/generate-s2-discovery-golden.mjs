import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const outputUrl = new URL('../contracts/s2-lite/v1/discovery-golden-v1.json', import.meta.url);
const zeroHash = '0'.repeat(64);
const writerA = '10000000-0000-4000-8000-000000000001';
const writerB = '10000000-0000-4000-8000-000000000002';
const writerC = '10000000-0000-4000-8000-000000000003';
const commitId = '20000000-0000-4000-8000-000000000001';
const path = `writers/${writerA}/segments/00000000000000/00000000000000000001--${commitId}--${zeroHash}.json`;
const activationId = '30000000-0000-4000-8000-000000000001';
const activationPath = `activations/${activationId}--${zeroHash}.json`;

const rawFixture = JSON.parse(await readFile(new URL('../contracts/s2-lite/v1/raw-wire-json-v1.json', import.meta.url), 'utf8'));
const rawTemplate = JSON.parse(Buffer.from(rawFixture.cases.find(item => item.name === 'canonical-mutation-resolves-absent').utf8Base64, 'base64').toString('utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const makeTraceCommit = (seq, salt, previous = null) => {
  const wire = structuredClone(rawTemplate);
  wire.writerId = writerA;
  wire.writerSeq = String(seq);
  wire.commitId = `20000000-0000-4000-8000-${String(salt).padStart(12, '0')}`;
  wire.previousWriterCommit = previous;
  wire.basisClock = previous === null ? [] : [previous];
  wire.mutations[0].localMutationId = `40000000-0000-4000-8000-${String(salt).padStart(12, '0')}`;
  wire.mutations[0].entityKey = ['collection', `trace-${salt}`];
  wire.mutations[0].value.id = `trace-${salt}`;
  wire.mutations[0].value.name = `Trace ${salt}`;
  wire.mutations[0].value.normalizedName = `trace ${salt}`;
  const bytes = Buffer.from(JSON.stringify(wire));
  const ref = { writerId: writerA, writerSeq: String(seq), commitId: wire.commitId, contentHash: sha256(bytes) };
  const segment = ((BigInt(seq) - 1n) / 256n).toString(16).padStart(14, '0');
  const seq20 = String(seq).padStart(20, '0');
  return {
    ref,
    path: `writers/${writerA}/segments/${segment}/${seq20}--${ref.commitId}--${ref.contentHash}.json`,
    utf8Base64: bytes.toString('base64'),
  };
};
const traceOne = makeTraceCommit(1, 101);
const traceTwo = makeTraceCommit(2, 102, traceOne.ref);
const traceFork = makeTraceCommit(2, 103, traceOne.ref);
const traceSegmentDirectory = `writers/${writerA}/segments/00000000000000/`;
const traceOpenDirectory = `writers/${writerA}/segments/00000000000001/`;
const traceLists = ['activations/', 'writers/', `writers/${writerA}/segments/`, traceSegmentDirectory, traceOpenDirectory];
const refKey = ref => `${ref.writerId}/${ref.writerSeq}/${ref.commitId}/${ref.contentHash}`;
const traceProjection = ({ candidates, verified, gaps, queue, scheduler, gets, fatal = [], forks = [], auditCursor = { lastWriterId: writerA, lastSegmentByWriter: { [writerA]: '00000000000000' } }, lists = traceLists }) => ({
  observedCandidates: [...candidates].sort(),
  verifiedRefs: [...verified].sort((a, b) => a.path.localeCompare(b.path)).map(value => refKey(value.ref)),
  gaps,
  dependencyQueue: queue.map(refKey),
  dependencyProgress: scheduler,
  auditCursor,
  scheduledLists: lists,
  scheduledGets: gets,
  fatalSignals: fatal,
  forkState: forks,
});
const schedulerRound1 = { nextClass: 'reverify', afterByClass: { dependency: null, candidate: traceTwo.path, reverify: null } };
const schedulerRound2 = { nextClass: 'candidate', afterByClass: { dependency: traceOne.path, candidate: traceTwo.path, reverify: traceTwo.path } };
const schedulerRound3 = { nextClass: 'dependency', afterByClass: { dependency: traceOne.path, candidate: traceFork.path, reverify: traceTwo.path } };
const invalidActivationBytes = Buffer.from('{');
const invalidActivationHash = sha256(invalidActivationBytes);
const invalidActivationPath = `activations/${activationId}--${invalidActivationHash}.json`;
const activationTraceLists = ['activations/', 'writers/', `writers/${writerA}/segments/`, traceSegmentDirectory];
const activationTraceScheduler = { nextClass: 'reverify', afterByClass: { dependency: null, candidate: traceOne.path, reverify: null } };

const fixture = {
  schema: 'watchtracker-s2-lite-discovery-golden-v1',
  description: 'Manually frozen path, retention, gap, targeting, and fair historical-audit observations.',
  scenarioCoverage: [
    'writer-segment-path-parsing',
    'listing-omission-retain',
    'listing-reordering',
    'duplicate-entries',
    'known-gap',
    'targeted-dependency-exact-get',
    'late-object',
    'historical-audit-cursor',
    'delayed-historical-fork',
    'path-body-mismatch',
    'unrelated-junk',
    'activation-candidate-retention',
    'persistent-fair-exact-work',
    'executable-cross-language-multi-round-trace',
  ],
  identities: { writerA, writerB, writerC, commitId, zeroHash, path, activationId, activationPath },
  pathCases: [
    { name: 'canonical-commit', kind: 'commit', path, accepted: true },
    { name: 'canonical-activation', kind: 'activation', path: activationPath, accepted: true },
    { name: 'segment-seq-mismatch', kind: 'commit', path: path.replace('segments/00000000000000', 'segments/00000000000001'), accepted: false, canonicalLooking: true },
    { name: 'uppercase-writer', kind: 'commit', path: path.replace('10000000', 'ABCDEF00'), accepted: false },
    { name: 'short-seq', kind: 'commit', path: path.replace('00000000000000000001', '1'), accepted: false },
    { name: 'uppercase-hash', kind: 'commit', path: path.replace(zeroHash, 'A'.repeat(64)), accepted: false },
    { name: 'suffix-junk', kind: 'commit', path: `${path}.bak`, accepted: false },
    { name: 'path-traversal', kind: 'commit', path: `../${path}`, accepted: false },
    { name: 'unrelated-junk', kind: 'none', path: 'writers/notes.txt', accepted: false },
  ],
  junkCorpus: [
    { name: 'activation-notes-json', path: 'activations/notes.json', classification: 'UnrelatedJunk', fatal: false },
    { name: 'segment-notes-json', path: `writers/${writerA}/segments/00000000000000/notes.json`, classification: 'UnrelatedJunk', fatal: false },
    { name: 'writer-text-note', path: `writers/${writerA}/notes.json`, classification: 'UnrelatedJunk', fatal: false },
    { name: 'backup-suffix', path: `${path}.bak`, classification: 'UnrelatedJunk', fatal: false },
    { name: 'canonical-commit', path, classification: 'Candidate', fatal: false },
    { name: 'segment-seq-mismatch', path: path.replace('segments/00000000000000', 'segments/00000000000001'), classification: 'CanonicalIdentityMismatch', fatal: true },
  ],
  executableTrace: {
    budgets: { maxExactFetchesPerSync: 2, maxSegmentsPerWriterPerSync: 5, maxDependencyTargetsPerSync: 64, maxListingEntriesPerDirectory: 4096 },
    objects: [traceOne, traceTwo, traceFork],
    rounds: [
      {
        listings: { 'activations/': [], 'writers/': [`writers/${writerA}/`], [`writers/${writerA}/segments/`]: ['00000000000001'], [traceSegmentDirectory]: [traceTwo.path, 'activations/notes.json'], [traceOpenDirectory]: [] },
        expected: traceProjection({ candidates: [traceTwo.path], verified: [traceTwo], gaps: [`${writerA}/1`], queue: [traceOne.ref], scheduler: schedulerRound1, gets: [traceTwo.path] }),
      },
      {
        listings: { 'activations/': [], 'writers/': [`writers/${writerA}/`], [`writers/${writerA}/segments/`]: ['00000000000001'], [traceSegmentDirectory]: [traceTwo.path], [traceOpenDirectory]: [] },
        expected: traceProjection({ candidates: [traceOne.path, traceTwo.path], verified: [traceOne, traceTwo], gaps: [], queue: [], scheduler: schedulerRound2, gets: [traceTwo.path, traceOne.path] }),
      },
      {
        listings: { 'activations/': [], 'writers/': [`writers/${writerA}/`], [`writers/${writerA}/segments/`]: ['00000000000001'], [traceSegmentDirectory]: [traceTwo.path, traceFork.path], [traceOpenDirectory]: [] },
        expected: traceProjection({
          candidates: [traceOne.path, traceTwo.path, traceFork.path], verified: [traceOne, traceTwo, traceFork], gaps: [], queue: [], scheduler: schedulerRound3,
          gets: [traceFork.path, traceTwo.path],
          fatal: [{ code: 'WRITER_FORK', path: traceTwo.path, writerId: writerA, writerSeq: '2', safeWriterFrontier: '1' }],
          forks: [{ writerId: writerA, writerSeq: '2', safeWriterFrontier: '1', paths: [traceTwo.path, traceFork.path].sort() }],
        }),
      },
    ],
  },
  activationFailureTrace: {
    budgets: { maxExactFetchesPerSync: 2, maxSegmentsPerWriterPerSync: 5, maxDependencyTargetsPerSync: 64, maxListingEntriesPerDirectory: 4096 },
    objects: [
      { path: invalidActivationPath, utf8Base64: invalidActivationBytes.toString('base64') },
      traceOne,
    ],
    listing: {
      'activations/': [invalidActivationPath],
      'writers/': [`writers/${writerA}/`],
      [`writers/${writerA}/segments/`]: ['00000000000000'],
      [traceSegmentDirectory]: [traceOne.path],
    },
    expected: traceProjection({
      candidates: [invalidActivationPath, traceOne.path],
      verified: [traceOne],
      gaps: [],
      queue: [],
      scheduler: activationTraceScheduler,
      gets: [invalidActivationPath, traceOne.path],
      fatal: [{ code: 'REMOTE_S2_OBJECT_INVALID', path: invalidActivationPath }],
      auditCursor: { lastWriterId: null, lastSegmentByWriter: {} },
      lists: activationTraceLists,
    }),
  },
  audit: {
    closedSegments: [
      `${writerA}/00000000000000`, `${writerA}/00000000000001`, `${writerA}/00000000000002`,
      `${writerB}/00000000000000`, `${writerB}/00000000000001`,
      `${writerC}/00000000000000`,
    ],
    initialCursor: { lastWriterId: null, lastSegmentByWriter: {} },
    rounds: 12,
    expectedSequence: [
      `${writerA}/00000000000000`, `${writerB}/00000000000000`, `${writerC}/00000000000000`,
      `${writerA}/00000000000001`, `${writerB}/00000000000001`, `${writerC}/00000000000000`,
      `${writerA}/00000000000002`, `${writerB}/00000000000000`, `${writerC}/00000000000000`,
      `${writerA}/00000000000000`, `${writerB}/00000000000001`, `${writerC}/00000000000000`,
    ],
  },
  expected: {
    retentionAfterOmission: [path],
    gapAfterSeqsOneAndFour: [`${writerA}/2`, `${writerA}/3`],
    targetedListingOmittedFound: true,
    activationRetainedAfterOmission: [activationPath],
    forkCode: 'WRITER_FORK',
    immutableMismatchCode: 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH',
  },
  permutationIterations: 256,
};

const rendered = `${JSON.stringify(fixture, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = await readFile(outputUrl, 'utf8');
  if (current !== rendered) throw new Error('discovery-golden-v1.json is stale');
  console.log(`verified ${fixture.pathCases.length} discovery paths, ${fixture.junkCorpus.length} junk classifications, ${fixture.audit.rounds} frozen audit rounds, ${fixture.executableTrace.rounds.length} executable trace rounds, and 1 activation-failure trace`);
} else {
  await writeFile(outputUrl, rendered);
}
