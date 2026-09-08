import { deepStrictEqual, equal } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BUSINESS_FIELD_ORDER, canonicalizeJcs, compareCommitRefV1, deterministicEntityIdV1,
  replayVerifiedHistoryV1, sha256Hex,
} from '../src/features/sync/s2lite/index.ts';

const phase0 = JSON.parse(await readFile(new URL('../contracts/s2-lite/v1/conflict-golden-v1.json', import.meta.url)));
const out = new URL('../contracts/s2-lite/v1/causal-golden-v1.json', import.meta.url);
const writer = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuid = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = n => n.toString(16).padStart(64, '0');
const ref = c => ({ writerId: c.writerId, writerSeq: c.writerSeq, commitId: c.commitId, contentHash: c.contentHash });
const refs = cs => cs.map(ref).sort(compareCommitRefV1);
const collection = (id, patch = {}) => ({
  id, name: 'Collection', normalizedName: 'collection', description: null, sourceKind: 'manual',
  sourceKey: null, collectionKind: 'manual', orderMode: 'manual',
  createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '', ...patch,
});
const record = (id, patch = {}) => ({
  id, ...phase0.semanticValues.recordChanged, notes: '', isLocked: false,
  createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '', ...patch,
});
const mutation = (n, key, value, base = [], fields = null, operation = 'upsert') => ({
  localMutationId: uuid(10_000 + n), entityType: key[0], entityKey: key, operation, value,
  baseFrontier: refs(base), changedFields: fields ?? BUSINESS_FIELD_ORDER[key[0]],
});
const commit = (n, mutations, basis = [], options = {}) => ({
  protocol: 'watchtracker-s2-lite', protocolVersion: 1, s2SemanticProfileVersion: 1,
  requiredFeatures: [], writerId: writer(options.writer ?? n), writerSeq: String(options.seq ?? 1),
  commitId: uuid(n), contentHash: hash(n), previousWriterCommit: options.previous ? ref(options.previous) : null,
  basisClock: refs(basis), commitKind: options.kind ?? (options.resolves ? 'resolution' : 'mutation'),
  createdAt: '2026-09-06T10:00:00.000Z',
  source: { type: options.source ?? (options.resolves ? 'manual-resolution' : 'native') },
  resolves: options.resolves ? [...options.resolves].sort() : [], mutations,
});
const tombstone = id => ({ id, deletedAt: '2026-09-06T10:00:00.000Z', rev: '1', revActor: 'fixture' });
const episode = async (recordId, number) => ({
  id: await deterministicEntityIdV1('episode-completion:v1', [recordId, number]), recordId, episodeNumber: number,
  completedAt: null, createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
});
const normalize = replay => ({
  validity: replay.validity,
  frontiers: replay.frontiers,
  materialized: replay.materialized,
  entityConflicts: replay.materialized.filter(x => x.value.state === 'Conflict').map(x => x.value.conflictId),
  relationConflicts: replay.relations.conflicts,
  diagnostics: replay.duplicateDiagnostics,
  forks: replay.forks,
  unsafeCommitRefs: replay.unsafeCommitRefs,
});
const resolved = (frontierCount = 1) => ({ state: 'Resolved', frontierCount, provenanceCount: frontierCount });
const conflict = (conflictKind, frontierCount = 2, exact = {}) => ({
  state: 'Conflict', conflictKind, frontierCount, provenanceCount: frontierCount, ...exact,
});
const semanticAssertions = {
  'single-writer-seq-1-3': { validityCounts: [3, 0, 0], materialized: [resolved()] },
  'two-concurrent-writers': { validityCounts: [3, 0, 0], materialized: [resolved(2)] },
  'one-writer-observes-other': { validityCounts: [4, 0, 0], materialized: [resolved()] },
  'semantic-equivalent-concurrent-values': { validityCounts: [3, 0, 0], materialized: [resolved(2)] },
  'same-base-disjoint-merge': { validityCounts: [3, 0, 0], materialized: [resolved(2)] },
  'overlapping-field': { validityCounts: [3, 0, 0], materialized: [conflict('overlapping-field')] },
  'different-base': { validityCounts: [4, 0, 0], materialized: [conflict('different-base')] },
  'live-tombstone': { validityCounts: [3, 0, 0], materialized: [conflict('live-tombstone')] },
  'locked-concurrent': {
    validityCounts: [3, 0, 0],
    materialized: [conflict('locked-concurrent', 2, {
      exactConflictId: '6e681c4abd41cfcf8bb2e034c79e67bdf152552ec34147073a3ceaf721d30adf',
      exactFrontierCommitIds: [
        '20000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000022',
      ],
    })],
  },
  'derived-domain': {
    validityCounts: [3, 0, 0],
    materialized: [conflict('derived-domain', 2, {
      exactConflictId: '9945e279c6fc972a269a12c3751362a775a5f3fc19e7c54d4e25be409dd365df',
      exactFrontierCommitIds: [
        '20000000-0000-4000-8000-000000000023', '20000000-0000-4000-8000-000000000024',
      ],
    })],
  },
  'parent-delete-member-create': {
    validityCounts: [3, 0, 0], materialized: [resolved(), resolved(), resolved(), resolved()],
    relationConflictKinds: ['collection-deleted-member-live'],
  },
  'episode-total-shrink': {
    validityCounts: [2, 0, 0], materialized: [resolved(), resolved(), resolved()],
    relationConflictKinds: ['episode-exceeds-total'],
  },
  'explicit-resolution': { validityCounts: [4, 0, 0], materialized: [resolved()] },
  'stale-resolution': { validityCounts: [3, 0, 1], materialized: [conflict('overlapping-field')] },
  'resolution-late-alternative': {
    validityCounts: [5, 0, 0],
    materialized: [conflict('different-base', 2, {
      exactConflictId: 'd3879a6935614249f4bd07c40283acdf07e6280ba5b53a1f8e889d04ffe9f3ab',
      exactFrontierCommitIds: [
        '20000000-0000-4000-8000-000000000040', '20000000-0000-4000-8000-000000000042',
      ],
    })],
  },
  'malformed-previous-ref': { validityCounts: [1, 0, 1], materialized: [resolved()] },
  'missing-dependency-pending': { validityCounts: [0, 1, 0], materialized: [] },
  'writer-fork-classification': {
    validityCounts: [2, 0, 0], materialized: [], forkCount: 1, unsafeCommitCount: 2,
  },
  'transitive-missing-pending': { validityCounts: [0, 2, 0], materialized: [] },
  'fork-descendant-isolation': {
    validityCounts: [3, 0, 0], materialized: [], forkCount: 1, unsafeCommitCount: 3,
  },
  'tracking-false-episode-valid': { validityCounts: [2, 0, 0], materialized: [resolved(), resolved()] },
  'batch-tombstone-parent': { validityCounts: [1, 0, 1], materialized: [resolved()] },
  'relation-multi-conflict-partial-resolution': {
    validityCounts: [2, 0, 1], materialized: [resolved(), resolved(), resolved()],
    relationConflictKinds: ['episode-exceeds-total', 'episode-exceeds-total'],
  },
  'relation-multi-conflict-complete-resolution': {
    validityCounts: [3, 0, 0], materialized: [resolved(), resolved(), resolved()],
  },
  'bootstrap-legacy-entity-conflict-blocked': {
    validityCounts: [3, 0, 1], materialized: [conflict('overlapping-field')],
  },
  'bootstrap-new-root-entity-conflict-blocked': {
    validityCounts: [3, 0, 1], materialized: [conflict('overlapping-field')],
  },
  'bootstrap-relation-conflict-blocked': {
    validityCounts: [2, 0, 1], materialized: [resolved(), resolved(), resolved()],
    relationConflictKinds: ['episode-exceeds-total', 'episode-exceeds-total'],
  },
  'bootstrap-new-root-relation-conflict-blocked': {
    validityCounts: [2, 0, 1], materialized: [resolved(), resolved(), resolved()],
    relationConflictKinds: ['episode-exceeds-total', 'episode-exceeds-total'],
  },
  'bootstrap-locked-record-blocked': { validityCounts: [2, 0, 1], materialized: [resolved()] },
  'clean-legacy-bootstrap-valid': { validityCounts: [1, 0, 0], materialized: [resolved(), resolved()] },
  'clean-new-root-bootstrap-valid': {
    validityCounts: [1, 0, 0], materialized: [resolved(), resolved(), resolved()],
  },
  'cycle-with-external-missing': { validityCounts: [0, 0, 2], materialized: [] },
  'cycle-with-external-now-present': { validityCounts: [1, 0, 2], materialized: [resolved()] },
  'self-loop-with-external-missing': { validityCounts: [0, 0, 1], materialized: [] },
  'cycle-descendant-with-external-missing': { validityCounts: [0, 0, 3], materialized: [] },
  'acyclic-external-missing-pending': { validityCounts: [0, 3, 0], materialized: [] },
};
const cases = [];
async function add(name, objects) {
  cases.push({
    name,
    objects,
    semanticAssertions: semanticAssertions[name],
  });
}

const p = commit(1, [mutation(1, ['collection', 'c'], collection('c'))], [], { writer: 1 });
const s2 = commit(2, [mutation(2, ['collection', 'c'], collection('c', { description: '2' }), [p], ['description'])], [p], { writer: 1, seq: 2, previous: p });
const s3 = commit(3, [mutation(3, ['collection', 'c'], collection('c', { description: '3' }), [s2], ['description'])], [s2], { writer: 1, seq: 3, previous: s2 });
const a = commit(4, [mutation(4, ['collection', 'c'], collection('c', { description: 'A' }), [p], ['description'])], [p], { writer: 4 });
const b = commit(5, [mutation(5, ['collection', 'c'], collection('c', { orderMode: 'chronological' }), [p], ['orderMode'])], [p], { writer: 5 });
const overlap = commit(6, [mutation(6, ['collection', 'c'], collection('c', { description: 'B' }), [p], ['description'])], [p], { writer: 6 });
const equivalent = commit(7, [mutation(7, ['collection', 'c'], collection('c', { description: 'A', updatedAt: '2026-09-06T11:00:00.000Z' }), [p], ['description'])], [p], { writer: 7 });
const join = commit(8, [mutation(8, ['collection', 'c'], collection('c', {
  name: 'Joined', normalizedName: 'joined', description: 'A', orderMode: 'chronological',
}), [a, b], ['name', 'normalizedName'])], [a, b], { writer: 8 });
const descendant = commit(9, [mutation(9, ['collection', 'c'], collection('c', { description: 'child' }), [a], ['description'])], [a], { writer: 9 });
const deleted = commit(10, [mutation(10, ['collection', 'c'], tombstone('c'), [p], ['$tombstone'], 'tombstone')], [p], { writer: 10 });
await add('single-writer-seq-1-3', [s3, p, s2]);
await add('two-concurrent-writers', [p, a, b]);
await add('one-writer-observes-other', [p, a, b, join]);
await add('semantic-equivalent-concurrent-values', [p, a, equivalent]);
await add('same-base-disjoint-merge', [p, a, b]);
await add('overlapping-field', [p, a, overlap]);
await add('different-base', [p, a, descendant, b]);
await add('live-tombstone', [p, a, deleted]);

const rp = commit(20, [mutation(20, ['record', 'r'], record('r', { isLocked: null }))]);
const lock = commit(21, [mutation(21, ['record', 'r'], record('r', { isLocked: true }), [rp], ['isLocked'])], [rp]);
const note = commit(22, [mutation(22, ['record', 'r'], record('r', { isLocked: null, notes: 'N' }), [rp], ['notes'])], [rp]);
const noOriginal = commit(23, [mutation(23, ['record', 'r'], record('r', {
  originalName: '', isLocked: null,
}), [rp], ['originalName'])], [rp]);
const noChinese = commit(24, [mutation(24, ['record', 'r'], record('r', {
  chineseName: '', isLocked: null,
}), [rp], ['chineseName'])], [rp]);
await add('locked-concurrent', [rp, lock, note]);
await add('derived-domain', [rp, noOriginal, noChinese]);

const parent = commit(30, [
  mutation(301, ['record', 'pr'], record('pr', { totalEpisodes: 12 })),
  mutation(302, ['collection', 'pc'], collection('pc')),
  mutation(303, ['episode-completion', 'pr', 12], await episode('pr', 12)),
]);
const member = commit(31, [mutation(31, ['collection-member', 'pc', 'pr'], {
  id: await deterministicEntityIdV1('collection-member:v1', ['pc', 'pr']), collectionId: 'pc', recordId: 'pr',
  position: '0', sourceKind: 'manual', createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
})], [parent]);
const deleteParent = commit(32, [mutation(32, ['collection', 'pc'], tombstone('pc'), [parent], ['$tombstone'], 'tombstone')], [parent]);
const shrink = commit(33, [mutation(33, ['record', 'pr'], record('pr', { totalEpisodes: 10 }), [parent], ['totalEpisodes'])], [parent]);
await add('parent-delete-member-create', [parent, member, deleteParent]);
await add('episode-total-shrink', [parent, shrink]);

const pre = await replayVerifiedHistoryV1([p, a, overlap]);
const conflictId = pre.materialized[0].value.conflictId;
const resolution = commit(40, [mutation(40, ['collection', 'c'], collection('c', { description: 'R' }), [a, overlap])], [a, overlap], { resolves: [conflictId] });
const stale = commit(41, [mutation(41, ['collection', 'c'], collection('c', { description: 'R' }), [a, overlap])], [a, overlap], { resolves: ['0'.repeat(64)] });
const late = commit(42, [mutation(42, ['collection', 'c'], collection('c', { description: 'late' }), [p], ['description'])], [p]);
await add('explicit-resolution', [p, a, overlap, resolution]);
await add('stale-resolution', [p, a, overlap, stale]);
await add('resolution-late-alternative', [p, a, overlap, resolution, late]);
const malformed = structuredClone(s2); malformed.previousWriterCommit.contentHash = 'f'.repeat(64);
await add('malformed-previous-ref', [p, malformed]);
await add('missing-dependency-pending', [a]);
const forkA = commit(50, [mutation(50, ['collection', 'fork'], collection('fork'))], [], { writer: 50 });
const forkB = commit(51, [mutation(51, ['collection', 'fork'], collection('fork', { description: 'fork' }))], [], { writer: 50 });
await add('writer-fork-classification', [forkA, forkB]);

const pendingB = commit(60, [mutation(60, ['collection', 'pending'], collection('pending', { description: 'B' }), [p], ['description'])], [p]);
const pendingC = commit(61, [mutation(61, ['collection', 'pending'], collection('pending', { description: 'C' }), [pendingB], ['description'])], [pendingB]);
await add('transitive-missing-pending', [pendingB, pendingC]);
const forkDesc = commit(62, [mutation(62, ['collection', 'fork'], collection('fork', { description: 'desc' }), [forkA], ['description'])], [forkA]);
await add('fork-descendant-isolation', [forkA, forkB, forkDesc]);
const trackingParent = commit(63, [mutation(63, ['record', 'tracking'], record('tracking', { totalEpisodes: 10.0, episodeTrackingEnabled: false }))]);
const trackingEpisode = commit(64, [mutation(64, ['episode-completion', 'tracking', 5.0], await episode('tracking', 5.0))], [trackingParent]);
await add('tracking-false-episode-valid', [trackingParent, trackingEpisode]);
const batchBad = commit(65, [
  mutation(651, ['record', 'tracking'], tombstone('tracking'), [trackingParent], ['$tombstone'], 'tombstone'),
  mutation(652, ['episode-completion', 'tracking', 6], await episode('tracking', 6)),
], [trackingParent]);
await add('batch-tombstone-parent', [trackingParent, batchBad]);

const multiParent = commit(70, [
  mutation(701, ['record', 'multi'], record('multi', { totalEpisodes: 7 })),
  mutation(702, ['episode-completion', 'multi', 5], await episode('multi', 5)),
  mutation(703, ['episode-completion', 'multi', 7], await episode('multi', 7)),
]);
const multiShrink = commit(71, [
  mutation(711, ['record', 'multi'], record('multi', { totalEpisodes: 3 }), [multiParent], ['totalEpisodes']),
], [multiParent]);
const multiPre = await replayVerifiedHistoryV1([multiParent, multiShrink]);
const multiIds = new Map(multiPre.relations.conflicts.map(conflict => [
  conflict.core.semanticRelationFacts.episodeNumber, conflict.relationConflictId,
]));
const resolveSevenOnly = commit(72, [
  mutation(721, ['record', 'multi'], record('multi', { totalEpisodes: 7 }), [multiShrink], ['totalEpisodes']),
  mutation(722, ['episode-completion', 'multi', 7], await episode('multi', 7), [multiParent], []),
], [multiShrink], { resolves: [multiIds.get(7)] });
const resolveBoth = commit(73, [
  mutation(731, ['record', 'multi'], record('multi', { totalEpisodes: 7 }), [multiShrink], ['totalEpisodes']),
  mutation(732, ['episode-completion', 'multi', 5], await episode('multi', 5), [multiParent], []),
  mutation(733, ['episode-completion', 'multi', 7], await episode('multi', 7), [multiParent], []),
], [multiShrink], { resolves: [multiIds.get(5), multiIds.get(7)] });
await add('relation-multi-conflict-partial-resolution', [multiParent, multiShrink, resolveSevenOnly]);
await add('relation-multi-conflict-complete-resolution', [multiParent, multiShrink, resolveBoth]);

const bootstrapEntity = (n, source) => commit(n, [
  mutation(n, ['collection', 'c'], tombstone('c'), [a, overlap], ['$tombstone'], 'tombstone'),
], [a, overlap], { kind: 'bootstrap', source });
await add('bootstrap-legacy-entity-conflict-blocked', [p, a, overlap, bootstrapEntity(80, 'legacy-bootstrap')]);
await add('bootstrap-new-root-entity-conflict-blocked', [p, a, overlap, bootstrapEntity(81, 'new-root-bootstrap')]);
const bootstrapRelation = commit(82, [
  mutation(82, ['record', 'multi'], record('multi', { totalEpisodes: 7 }), [multiShrink], ['totalEpisodes']),
], [multiShrink], { kind: 'bootstrap', source: 'legacy-bootstrap' });
await add('bootstrap-relation-conflict-blocked', [multiParent, multiShrink, bootstrapRelation]);
const bootstrapNewRootRelation = commit(95, [
  mutation(95, ['record', 'multi'], record('multi', { totalEpisodes: 7 }), [multiShrink], ['totalEpisodes']),
], [multiShrink], { kind: 'bootstrap', source: 'new-root-bootstrap' });
await add('bootstrap-new-root-relation-conflict-blocked', [multiParent, multiShrink, bootstrapNewRootRelation]);
const bootstrapLocked = commit(83, [
  mutation(83, ['record', 'r'], record('r', { isLocked: true, notes: 'forbidden' }), [lock], ['notes']),
], [lock], { kind: 'bootstrap', source: 'new-root-bootstrap' });
await add('bootstrap-locked-record-blocked', [rp, lock, bootstrapLocked]);

const cleanLegacy = commit(84, [
  mutation(841, ['record', 'clean-legacy'], record('clean-legacy', { totalEpisodes: 5 })),
  mutation(842, ['episode-completion', 'clean-legacy', 5], await episode('clean-legacy', 5)),
], [], { kind: 'bootstrap', source: 'legacy-bootstrap' });
await add('clean-legacy-bootstrap-valid', [cleanLegacy]);
const cleanNewRoot = commit(85, [
  mutation(851, ['collection', 'clean-root'], collection('clean-root')),
  mutation(852, ['record', 'clean-member-record'], record('clean-member-record')),
  mutation(853, ['collection-member', 'clean-root', 'clean-member-record'], {
    id: await deterministicEntityIdV1('collection-member:v1', ['clean-root', 'clean-member-record']),
    collectionId: 'clean-root', recordId: 'clean-member-record', position: '0', sourceKind: 'manual',
    createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z', rev: '0', revActor: '',
  }),
], [], { kind: 'bootstrap', source: 'new-root-bootstrap' });
await add('clean-new-root-bootstrap-valid', [cleanNewRoot]);

const graphNode = n => commit(n, [mutation(
  n, ['collection', `graph-golden-${n}`], collection(`graph-golden-${n}`), [], BUSINESS_FIELD_ORDER.collection,
)]);
const externalMissing = graphNode(86);
const cycleMissingA = graphNode(87);
const cycleMissingB = graphNode(88);
cycleMissingA.basisClock = refs([cycleMissingB, externalMissing]);
cycleMissingB.basisClock = refs([cycleMissingA]);
await add('cycle-with-external-missing', [cycleMissingA, cycleMissingB]);
await add('cycle-with-external-now-present', [cycleMissingA, cycleMissingB, externalMissing]);
const selfMissing = graphNode(89);
selfMissing.basisClock = refs([selfMissing, externalMissing]);
await add('self-loop-with-external-missing', [selfMissing]);
const cycleMissingDescendant = graphNode(91);
cycleMissingDescendant.basisClock = refs([cycleMissingA, externalMissing]);
await add('cycle-descendant-with-external-missing', [cycleMissingA, cycleMissingB, cycleMissingDescendant]);
const acyclicC = graphNode(92);
acyclicC.basisClock = refs([externalMissing]);
const acyclicB = graphNode(93);
acyclicB.basisClock = refs([acyclicC]);
const acyclicA = graphNode(94);
acyclicA.basisClock = refs([acyclicB, acyclicC]);
await add('acyclic-external-missing-pending', [acyclicA, acyclicB, acyclicC]);

const rawWireCommit = {
  protocol: 'watchtracker-s2-lite', protocolVersion: 1, s2SemanticProfileVersion: 1, requiredFeatures: [],
  writerId: writer(90), writerSeq: '1', commitId: uuid(90), previousWriterCommit: null, basisClock: [],
  commitKind: 'mutation', createdAt: '2026-09-06T10:00:00.000Z', source: { type: 'native' },
  mutations: [mutation(90, ['collection', 'raw-wire'], collection('raw-wire'))],
};
const parity = cases.find(x => x.name === 'same-base-disjoint-merge');
const parityReplay = await replayVerifiedHistoryV1(parity.objects);
const expectedReplaySha256 = await sha256Hex(new TextEncoder().encode(canonicalizeJcs(parityReplay)));
const frozen = JSON.parse(await readFile(out));
equal(frozen.schema, 'watchtracker-s2-lite-causal-golden-v1');
equal(frozen.cases.length, cases.length);
deepStrictEqual(frozen.rawWireCommit, rawWireCommit);
deepStrictEqual(frozen.parityScenario.commits, parity.objects);
equal(frozen.parityScenario.expectedReplaySha256, expectedReplaySha256);
for (const generated of cases) {
  const frozenCase = frozen.cases.find(candidate => candidate.name === generated.name);
  if (frozenCase === undefined) throw new Error(`missing frozen causal case: ${generated.name}`);
  deepStrictEqual(frozenCase.objects, generated.objects, `${generated.name}: input drift`);
  deepStrictEqual(
    frozenCase.semanticAssertions,
    generated.semanticAssertions,
    `${generated.name}: semantic assertion drift`,
  );
  deepStrictEqual(
    frozenCase.expected,
    normalize(await replayVerifiedHistoryV1(generated.objects)),
    `${generated.name}: frozen expected mismatch`,
  );
}
console.log(`verified ${cases.length} manually frozen S2 causal golden scenarios`);
