import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  captureLegacySnapshotV1,
  createMigrationRootExecutionCapabilityV1,
  createMigrationRootSafetyStateV1,
  createMigrationStateV1,
  createNewRootMigrationHandoffV1,
  decideLegacyPutV1,
  deserializeMigrationStateV1,
  decodeFrozenWireCommitV1,
  deterministicEntityIdV1,
  detectWriterForksV1,
  executeMigrationStepV1,
  freezeOldRootForNewRootHandoffV1,
  migrationProjectionV1,
  mergeMigrationRootCutoverStateV1,
  planCapturedMigrationV1,
  retainCapturedSnapshotV1,
  recoverMigrationActivationCutoverV1,
  restartDurableActivationPublishV1,
  restartDurablePublishV1,
  serializeMigrationStateV1,
  startOrAttachMigrationV1,
  publishPersistedActivationIntentV1,
} from '../../../features/sync/s2lite/index.ts';

const fixture = JSON.parse(await readFile(new URL(
  '../../../../contracts/s2-lite/v1/migration-golden-v1.json', import.meta.url,
)));

const timestamp = fixture.identity.createdAt;
const failureScenario = name => fixture.failureScenarios.find(value => value.name === name);
const correctnessScenario = name => fixture.correctnessScenarios.find(value => value.name === name);

function record(index) {
  const id = `record-${String(index).padStart(4, '0')}`;
  return {
    entityType: 'record',
    entityKey: ['record', id],
    value: {
      id, originalName: `Record ${index}`, chineseName: '', progress: '', totalEpisodes: 1,
      episodeTrackingEnabled: false, nextEpisode: null, movieProgress: null, movieDuration: null,
      releaseYear: null, posterPath: null, status: '未看', platform: '', rating: null,
      startDate: null, endDate: null, notes: '', createdAt: timestamp, updatedAt: null,
      imdbId: null, isLocked: null, genres: null, originCountry: null, imdbRating: null,
      tmdbStatus: null, interestLevel: null, episodeRuntime: null, mediaType: '剧集',
      contentTags: null, tmdbMediaKind: null, tmdbId: null, tmdbParentId: null,
      tmdbSeasonNumber: null, seriesRecordKind: null, rev: '0', revActor: '',
    },
  };
}

function collection(index) {
  const id = `collection-${String(index).padStart(4, '0')}`;
  return {
    entityType: 'collection',
    entityKey: ['collection', id],
    value: {
      id, name: `Collection ${index}`, normalizedName: `collection ${index}`, description: null,
      sourceKind: 'manual', sourceKey: null, collectionKind: 'manual', orderMode: 'manual',
      createdAt: timestamp, updatedAt: timestamp, rev: '0', revActor: '',
    },
  };
}

async function entitiesFor(scenario) {
  const values = [];
  for (let index = 0; index < scenario.records; index += 1) values.push(record(index));
  for (let index = 0; index < scenario.collections; index += 1) values.push(collection(index));
  for (let index = 0; index < scenario.episodes; index += 1) {
    const recordId = `record-${String(index).padStart(4, '0')}`;
    values.push({
      entityType: 'episode-completion',
      entityKey: ['episode-completion', recordId, 1],
      value: {
        id: await deterministicEntityIdV1('episode-completion:v1', [recordId, 1]),
        recordId, episodeNumber: 1, completedAt: timestamp, createdAt: timestamp,
        updatedAt: timestamp, rev: '0', revActor: '',
      },
    });
  }
  for (let index = 0; index < scenario.members; index += 1) {
    const recordId = `record-${String(index).padStart(4, '0')}`;
    const collectionId = `collection-${String(index).padStart(4, '0')}`;
    values.push({
      entityType: 'collection-member',
      entityKey: ['collection-member', collectionId, recordId],
      value: {
        id: await deterministicEntityIdV1('collection-member:v1', [collectionId, recordId]),
        collectionId, recordId, position: '0', sourceKind: 'manual', createdAt: timestamp,
        updatedAt: timestamp, rev: '0', revActor: '',
      },
    });
  }
  return values;
}

const adapter = {
  async adaptLiveEntity(entityType, legacyValue) {
    assert.equal(entityType, legacyValue.entityType);
    return structuredClone(legacyValue);
  },
};

async function plannedFor(scenario) {
  const initial = createMigrationStateV1({
    migrationId: fixture.identity.migrationId,
    rootId: fixture.identity.rootId,
    writerId: fixture.identity.writerId,
    createdAt: fixture.identity.createdAt,
  });
  const entities = await entitiesFor(scenario);
  const snapshot = await captureLegacySnapshotV1(
    entities.map(value => ({ entityType: value.entityType, value })), adapter,
  );
  return planCapturedMigrationV1(retainCapturedSnapshotV1(initial, snapshot));
}

function chunkSizes(tasks) {
  return tasks.map(task => JSON.parse(new TextDecoder().decode(task.intent.exactBytes)).mutations.length);
}

test('shared Phase 3D planning fixture fixes empty, staged, and 256-boundary plans', async () => {
  assert.equal(fixture.schema, 'watchtracker-s2-lite-migration-golden-v1');
  for (const scenario of fixture.planningScenarios) {
    const state = await plannedFor(scenario);
    assert.deepEqual(chunkSizes(state.stageA), scenario.expectedStageAChunkSizes, scenario.name);
    assert.deepEqual(chunkSizes(state.stageB), scenario.expectedStageBChunkSizes, scenario.name);
    assert.deepEqual(
      [...state.stageA, ...state.stageB].map(task => task.intent.commitRef.writerSeq),
      scenario.expectedWriterSeqs,
      scenario.name,
    );
    assert.equal(state.activationIntent.activationId, fixture.deterministicIdentity.activation, scenario.name);
  }
  const standard = await plannedFor(fixture.planningScenarios[2]);
  assert.deepEqual(migrationProjectionV1(standard), fixture.standardExpectedProjection);
  assert.equal(standard.stageA[0].intent.commitRef.commitId, fixture.deterministicIdentity.commit1);
  assert.equal(standard.stageB[0].intent.commitRef.commitId, fixture.deterministicIdentity.commit2);
});

test('legacy capture owns its pre-await input and invalid legacy conversion fails closed', async () => {
  const source = [{ entityType: 'record', value: record(0) }];
  let release;
  const deferredAdapter = {
    adaptLiveEntity(_type, value) {
      return new Promise(resolve => { release = () => resolve(value); });
    },
  };
  const pending = captureLegacySnapshotV1(source, deferredAdapter);
  source[0].value.value.originalName = 'MUTATED';
  release();
  const snapshot = await pending;
  assert.equal(snapshot.canonicalEntities[0].value.originalName, 'Record 0');
  await assert.rejects(
    captureLegacySnapshotV1([{ entityType: 'record', value: { broken: true } }], adapter),
    error => error.code === 'LEGACY_SNAPSHOT_INVALID',
  );
});

function fakeDependencies({ responseLost = false, rootId = fixture.identity.rootId } = {}) {
  const objects = new Map();
  const putCounts = new Map();
  const migrationStates = [];
  const receipts = [];
  const intents = [];
  const cutover = { state: null };
  const remoteTrace = [];
  const actualDecisions = { cutover: [], recovery: [] };
  const migrationAuthority = { current: null, freezeBeforePublish: false };
  const rootSafety = createMigrationRootSafetyStateV1(rootId);
  let beforeGetReturn = null;
  let afterPutStarted = null;
  let rootQueue = Promise.resolve();
  const rootBindingMismatch = () => {
    const error = new Error('MIGRATION_ROOT_BINDING_MISMATCH');
    error.code = 'MIGRATION_ROOT_BINDING_MISMATCH';
    return error;
  };
  const runRootExclusive = operation => {
    const result = rootQueue.then(operation);
    rootQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const retainMigrationFatal = code => {
    const current = migrationAuthority.current;
    if (current === null || current.rootFatalSignals.some(value => value.code === code)) return;
    current.generation += 1;
    current.status = 'ROOT_FROZEN';
    current.rootFatalSignals.push({ code });
    current.rootFatalSignals.sort((left, right) => left.code.localeCompare(right.code));
    migrationStates.push(structuredClone(current));
  };
  const retainRootFatal = code => {
    if (!rootSafety.rootFatalSignals.some(value => value.code === code)) {
      rootSafety.generation += 1;
      rootSafety.rootFatalSignals.push({ code });
      rootSafety.rootFatalSignals.sort((left, right) => left.code.localeCompare(right.code));
    }
    retainMigrationFatal(code);
  };
  const migrationStore = {
    async claimOrLoad(candidate) {
      return runRootExclusive(() => {
        if (candidate.rootId !== rootSafety.rootId) throw rootBindingMismatch();
        if (migrationAuthority.current === null) {
          migrationAuthority.current = structuredClone(candidate);
          if (rootSafety.rootFatalSignals.length > 0) {
            migrationAuthority.current.generation += 1;
            migrationAuthority.current.status = 'ROOT_FROZEN';
            migrationAuthority.current.rootFatalSignals = structuredClone(rootSafety.rootFatalSignals);
          }
        }
        migrationStates.push(structuredClone(migrationAuthority.current));
        return structuredClone(migrationAuthority.current);
      });
    },
    async load(rootId) {
      return runRootExclusive(() => migrationAuthority.current?.rootId === rootId
        ? structuredClone(migrationAuthority.current) : null);
    },
    async compareAndSwap(rootId, migrationId, expectedGeneration, next) {
      return runRootExclusive(() => {
        if (rootId !== rootSafety.rootId) return false;
        const current = migrationAuthority.current;
        if (current === null || current.rootId !== rootId || current.migrationId !== migrationId
          || current.generation !== expectedGeneration) return false;
        migrationAuthority.current = structuredClone(next);
        migrationStates.push(structuredClone(next));
        return true;
      });
    },
    async loadRootSafety(requestedRootId) {
      return runRootExclusive(() => {
        if (requestedRootId !== rootSafety.rootId) throw rootBindingMismatch();
        return structuredClone(rootSafety);
      });
    },
    async loadCutoverState(rootId) {
      return runRootExclusive(() => rootSafety.rootId === rootId
        ? structuredClone(rootSafety.cutoverState) : null);
    },
    async persistCutoverState(rootId, value) {
      return runRootExclusive(() => {
        if (rootId !== rootSafety.rootId) throw rootBindingMismatch();
        const merged = mergeMigrationRootCutoverStateV1(rootSafety.cutoverState, value);
        const fatalCodes = new Set([
          ...rootSafety.rootFatalSignals.map(fatal => fatal.code),
          ...merged.rootFatalSignals.map(fatal => fatal.code),
        ]);
        const nextRootFatals = [...fatalCodes].sort().map(code => ({ code }));
        if (JSON.stringify(merged) !== JSON.stringify(rootSafety.cutoverState)
          || JSON.stringify(nextRootFatals) !== JSON.stringify(rootSafety.rootFatalSignals)) {
          rootSafety.generation += 1;
        }
        rootSafety.cutoverState = structuredClone(merged);
        rootSafety.rootFatalSignals = nextRootFatals;
        cutover.state = structuredClone(merged);
        for (const fatal of cutover.state.rootFatalSignals) retainMigrationFatal(fatal.code);
        actualDecisions.cutover.push(cutover.state.rootFatalSignals.length > 0
          ? 'root-fatal-denied' : 'publish-eligible');
      });
    },
    async persistRootFatal(rootId, code) {
      return runRootExclusive(() => {
        if (rootSafety.rootId !== rootId) throw rootBindingMismatch();
        retainRootFatal(code);
        return structuredClone(migrationAuthority.current);
      });
    },
    async runPublishExclusive(binding, operation) {
      return runRootExclusive(async () => {
        if (migrationAuthority.freezeBeforePublish) {
          migrationAuthority.freezeBeforePublish = false;
          retainRootFatal('SYNC_ROOT_FROZEN_CORRUPTION');
        }
        const current = migrationAuthority.current;
        if (current.rootId !== binding.rootId || current.migrationId !== binding.migrationId
          || current.generation !== binding.expectedGeneration || current.status === 'ROOT_FROZEN'
          || current.rootFatalSignals.length > 0) {
          actualDecisions.cutover.push('root-fatal-denied');
          return { executed: false, current: structuredClone(current) };
        }
        actualDecisions.cutover.push('publish-eligible');
        // No await occurs between this owned-state decision and operation().
        const admitted = operation();
        return { executed: true, value: await admitted };
      });
    },
  };
  const rawDependencies = {
    remote: {
      physicalRootId: rootId,
      async getExact(path) {
        remoteTrace.push({ operation: 'GET', path });
        if (beforeGetReturn !== null) {
          const hook = beforeGetReturn;
          beforeGetReturn = null;
          await hook(path);
        }
        return objects.has(path)
          ? { state: 'DefinitelyPresent', bytes: Uint8Array.from(objects.get(path)) }
          : { state: 'DefinitelyAbsent' };
      },
      async putExact(path, bytes) {
        remoteTrace.push({ operation: 'PUT', path });
        afterPutStarted?.(path);
        putCounts.set(path, (putCounts.get(path) ?? 0) + 1);
        objects.set(path, Uint8Array.from(bytes));
        return { state: responseLost ? 'Indeterminate' : 'Success' };
      },
    },
    migrationStore,
    intentStore: { async persist(value) { intents.push(structuredClone(value)); } },
    receiptStore: { async persist(value) { receipts.push(structuredClone(value)); } },
    activationIntentStore: { async persist(value) { intents.push(structuredClone(value)); } },
    activationReceiptStore: { async persist(value) { receipts.push(structuredClone(value)); } },
    cutoverStore: {
      async load() { return migrationStore.loadCutoverState(rootId); },
      async persist(value) { return migrationStore.persistCutoverState(rootId, value); },
    },
    verifiedAtDiagnostic: timestamp,
  };
  return {
    objects,
    putCounts,
    migrationStates,
    receipts,
    intents,
    cutover,
    migrationAuthority,
    rootSafety,
    remoteTrace,
    actualDecisions,
    setBeforeGetReturn(hook) { beforeGetReturn = hook; },
    setAfterPutStarted(hook) { afterPutStarted = hook; },
    dependencies: rawDependencies,
  };
}

async function execute(state, fake) {
  fake.migrationAuthority.current ??= structuredClone(state);
  const attachment = await startOrAttachMigrationV1(state, fake.dependencies.migrationStore);
  const capability = createMigrationRootExecutionCapabilityV1(attachment, fake.dependencies);
  return executeMigrationStepV1(state, capability);
}

async function installCutoverFatal(fake) {
  await fake.dependencies.cutoverStore.persist({
    stateVersion: 1,
    remoteS2Activated: true,
    verifiedActivationEvidence: [
      { path: 'a', activationId: fixture.deterministicIdentity.activation, contentHash: 'a'.repeat(64), exactBytesHash: 'a'.repeat(64), legacyFingerprint: null },
      { path: 'b', activationId: fixture.deterministicIdentity.activation, contentHash: 'b'.repeat(64), exactBytesHash: 'b'.repeat(64), legacyFingerprint: 'f'.repeat(64) },
    ],
    fingerprintConsistency: { state: 'Conflict' },
    rootFatalSignals: [{ code: 'SYNC_ROOT_FROZEN_LEGACY_CHANGE' }],
  });
}

function assertCorrectnessProjection(scenario, state, fake) {
  assert.equal(state.rootId, scenario.expectedActualRoot);
  assert.deepEqual(fake.remoteTrace, scenario.expectedOperations);
  assert.equal(fake.remoteTrace.some(value => value.operation === 'PUT'), scenario.expectedPutOccurred);
  assert.equal(state.generation, scenario.expectedGeneration);
  assert.equal(state.status, scenario.expectedStatus);
  assert.equal(state.snapshot.legacyFingerprint, scenario.expectedSnapshotIdentity);
  assert.equal(state.stageA[0].intent.intentFingerprint, scenario.expectedPlanIdentity);
  assert.equal([...state.stageA, ...state.stageB].filter(value => value.receipt !== null).length, scenario.expectedRetainedReceipts);
  assert.deepEqual(state.rootFatalSignals.map(value => value.code).sort(), scenario.expectedFatalCodes);
}

function finalRaceScenario(name) {
  return fixture.finalRaceScenarios.find(value => value.name === name);
}

function rootSafetyScenario(name) {
  return fixture.rootSafetyScenarios.find(value => value.name === name);
}

function rootBindingScenario(name) {
  return fixture.rootBindingScenarios.find(value => value.name === name);
}

function activationEvidence(path, fingerprint, hashChar) {
  return {
    path,
    activationId: fixture.deterministicIdentity.activation,
    contentHash: hashChar.repeat(64),
    exactBytesHash: hashChar.repeat(64),
    legacyFingerprint: fingerprint,
  };
}

function cutoverInput(evidence = []) {
  return {
    stateVersion: 1,
    remoteS2Activated: evidence.length > 0,
    verifiedActivationEvidence: structuredClone(evidence),
    fingerprintConsistency: { state: 'NoEvidence' },
    rootFatalSignals: [],
  };
}

async function assertRootSafetyProjection(scenario, fake, decision) {
  const safety = await fake.dependencies.migrationStore.loadRootSafety(fixture.identity.rootId);
  const migration = await fake.dependencies.migrationStore.load(fixture.identity.rootId);
  assert.deepEqual({
    rootFatalCodes: safety.rootFatalSignals.map(value => value.code).sort(),
    migrationStatus: migration?.status ?? null,
    remoteS2Activated: safety.cutoverState.remoteS2Activated,
    evidencePaths: safety.cutoverState.verifiedActivationEvidence.map(value => value.path),
    fingerprintConsistency: safety.cutoverState.fingerprintConsistency.state,
    cutoverDecision: decision,
    putCount: fake.remoteTrace.filter(value => value.operation === 'PUT').length,
    migrationGeneration: migration?.generation ?? null,
    authorityGeneration: safety.generation,
  }, {
    rootFatalCodes: scenario.expectedRootFatalCodes,
    migrationStatus: scenario.expectedMigrationStatus,
    remoteS2Activated: scenario.expectedRemoteS2Activated,
    evidencePaths: scenario.expectedEvidencePaths,
    fingerprintConsistency: scenario.expectedFingerprintConsistency,
    cutoverDecision: scenario.expectedCutoverDecision,
    putCount: scenario.expectedPutCount,
    migrationGeneration: scenario.expectedMigrationGeneration,
    authorityGeneration: scenario.expectedAuthorityGeneration,
  });
}

function assertFinalRaceProjection(
  scenario, state, trace, {
    fatalCodes = state.rootFatalSignals.map(value => value.code).sort(),
    cutoverDecision,
    recoveryDecision,
  } = {},
) {
  const actual = {
    actualRoot: state.rootId,
    operations: trace,
    putCount: trace.filter(value => value.operation === 'PUT').length,
    generation: state.generation,
    status: state.status,
    snapshotIdentity: state.snapshot.legacyFingerprint,
    planIdentity: state.stageA[0]?.intent.intentFingerprint ?? null,
    retainedReceipts: [...state.stageA, ...state.stageB].filter(value => value.receipt !== null).length,
    fatalCodes,
    cutoverDecision,
    recoveryDecision,
  };
  const expected = {
    actualRoot: scenario.expectedActualRoot,
    operations: scenario.expectedOperations,
    putCount: scenario.expectedPutCount,
    generation: scenario.expectedGeneration,
    status: scenario.expectedStatus,
    snapshotIdentity: scenario.expectedSnapshotIdentity,
    planIdentity: scenario.expectedPlanIdentity,
    retainedReceipts: scenario.expectedRetainedReceipts,
    fatalCodes: scenario.expectedFatalCodes,
    cutoverDecision: scenario.expectedCutoverDecision,
    recoveryDecision: scenario.expectedRecoveryDecision,
  };
  assert.deepEqual(actual, expected);
}

test('durable captured snapshot is immutable before bootstrap planning', async () => {
  const scenario = finalRaceScenario('captured-x-restart-proposed-y');
  const initial = createMigrationStateV1({
    migrationId: fixture.identity.migrationId,
    rootId: fixture.identity.rootId,
    writerId: fixture.identity.writerId,
    createdAt: timestamp,
  });
  const snapshotX = await captureLegacySnapshotV1(
    (await entitiesFor(fixture.planningScenarios[1])).map(value => ({ entityType: value.entityType, value })), adapter,
  );
  const capturedX = retainCapturedSnapshotV1(initial, snapshotX);
  const fake = fakeDependencies();
  fake.migrationAuthority.current = structuredClone(capturedX);
  const plannedY = await plannedFor(fixture.planningScenarios[2]);
  plannedY.generation = capturedX.generation;
  const attachment = await startOrAttachMigrationV1(capturedX, fake.dependencies.migrationStore);
  const capability = createMigrationRootExecutionCapabilityV1(attachment, fake.dependencies);
  let cutoverDecision;
  await assert.rejects(executeMigrationStepV1(plannedY, capability), error => {
    cutoverDecision = error.code === 'LOCAL_MIGRATION_STATE_CORRUPTION'
      ? 'local-corruption-rejected' : undefined;
    return cutoverDecision !== undefined;
  });
  const retained = await fake.dependencies.migrationStore.load(fixture.identity.rootId);
  assertFinalRaceProjection(scenario, retained, fake.remoteTrace, {
    cutoverDecision,
    recoveryDecision: null,
  });
});

test('fatal persisted during Stage A, Stage B, or activation preflight wins before PUT admission', async () => {
  for (const [name, targetStatus] of [
    ['stage-a-fatal-during-preflight', 'BOOTSTRAP_PLANNED'],
    ['stage-b-fatal-during-preflight', 'STAGE_B_PUBLISHING'],
    ['activation-fatal-during-preflight', 'ACTIVATION_PUBLISHING'],
  ]) {
    const scenario = finalRaceScenario(name);
    let state = await plannedFor(name.startsWith('stage-a')
      ? fixture.planningScenarios[1] : fixture.planningScenarios[2]);
    const fake = fakeDependencies();
    while (state.status !== targetStatus) state = await execute(state, fake);
    fake.migrationAuthority.current ??= structuredClone(state);
    fake.remoteTrace.length = 0;
    fake.setBeforeGetReturn(async () => {
      await Promise.resolve();
      await installCutoverFatal(fake);
    });
    const task = targetStatus === 'ACTIVATION_PUBLISHING'
      ? state.activationIntent
      : (targetStatus === 'BOOTSTRAP_PLANNED' ? state.stageA[0].intent : state.stageB[0].intent);
    const recovery = targetStatus === 'ACTIVATION_PUBLISHING'
      ? await restartDurableActivationPublishV1(task, null, fake.dependencies.remote, timestamp)
      : await restartDurablePublishV1(task, null, fake.dependencies.remote, timestamp);
    fake.actualDecisions.recovery.push(recovery.outcome);
    state = await execute(state, fake);
    assertFinalRaceProjection(scenario, state, fake.remoteTrace, {
      cutoverDecision: fake.actualDecisions.cutover.at(-1),
      recoveryDecision: fake.actualDecisions.recovery.at(-1),
    });
  }
});

test('activation recovery is read-only for exact-present then transient-absent visibility', async () => {
  const scenario = finalRaceScenario('activation-recovery-present-then-absent');
  let state = await plannedFor(fixture.planningScenarios[2]);
  const setup = fakeDependencies();
  while (state.status !== 'ACTIVATION_PUBLISHING') state = await execute(state, setup);
  await installCutoverFatal(setup);
  const authoritativeFatalCodes = setup.migrationAuthority.current.rootFatalSignals
    .map(value => value.code).sort();
  const responses = [
    { state: 'DefinitelyPresent', bytes: Uint8Array.from(state.activationIntent.exactBytes) },
    { state: 'DefinitelyAbsent' },
  ];
  const trace = [];
  const remote = {
    async getExact(path) {
      trace.push({ operation: 'GET', path });
      return responses.shift();
    },
    async putExact(path) {
      trace.push({ operation: 'PUT', path });
      return { state: 'Success' };
    },
  };
    const result = await restartDurableActivationPublishV1(
    state.activationIntent, null, remote, timestamp,
  );
  setup.actualDecisions.recovery.push(result.outcome);
  assert.equal(setup.actualDecisions.recovery.at(-1), scenario.expectedRecoveryDecision);
  assert.equal(setup.actualDecisions.cutover.at(-1), scenario.expectedCutoverDecision);
  assert.equal(responses.length, 1);
  assertFinalRaceProjection(scenario, state, trace, {
    fatalCodes: authoritativeFatalCodes,
    cutoverDecision: setup.actualDecisions.cutover.at(-1),
    recoveryDecision: setup.actualDecisions.recovery.at(-1),
  });
});

test('an admitted PUT finishes before a later fatal, and that fatal blocks every later mutation', async () => {
  const admissionScenario = finalRaceScenario('admission-wins-then-fatal');
  const blockedScenario = finalRaceScenario('fatal-after-admitted-put-blocks-next');
  let state = await plannedFor(fixture.planningScenarios[1]);
  const fake = fakeDependencies();
  fake.migrationAuthority.current = structuredClone(state);
  const recovery = await restartDurablePublishV1(
    state.stageA[0].intent, null, fake.dependencies.remote, timestamp,
  );
  fake.actualDecisions.recovery.push(recovery.outcome);
  let fatalPersistence;
  fake.setAfterPutStarted(() => {
    fatalPersistence ??= installCutoverFatal(fake);
  });
  state = await execute(state, fake);
  await fatalPersistence;
  state = await fake.dependencies.migrationStore.load(fixture.identity.rootId);
  assertFinalRaceProjection(admissionScenario, state, fake.remoteTrace, {
    cutoverDecision: fake.actualDecisions.cutover[0],
    recoveryDecision: fake.actualDecisions.recovery.at(-1),
  });
  assert.equal(fake.actualDecisions.recovery.at(-1), admissionScenario.expectedRecoveryDecision);
  assert.equal(fake.actualDecisions.cutover[0], admissionScenario.expectedCutoverDecision);

  const staleSafeCutover = structuredClone(fake.cutover.state);
  staleSafeCutover.rootFatalSignals = [];
  await fake.dependencies.migrationStore.persistCutoverState(fixture.identity.rootId, staleSafeCutover);
  assert.deepEqual(fake.cutover.state.rootFatalSignals, [{ code: 'SYNC_ROOT_FROZEN_LEGACY_CHANGE' }]);

  const traceBeforeRetry = structuredClone(fake.remoteTrace);
  state = await execute(state, fake);
  assert.deepEqual(fake.remoteTrace, traceBeforeRetry);
  assertFinalRaceProjection(blockedScenario, state, fake.remoteTrace, {
    cutoverDecision: fake.actualDecisions.cutover.at(-1),
    recoveryDecision: fake.actualDecisions.recovery.at(-1),
  });
  assert.equal(fake.actualDecisions.cutover.at(-1), blockedScenario.expectedCutoverDecision);
});

test('root safety predates migration claims and cutover persistence retains every stronger fact', async () => {
  let fatalFake = fakeDependencies();
  await fatalFake.dependencies.migrationStore.persistRootFatal(
    fixture.identity.rootId, 'SYNC_ROOT_FROZEN_LEGACY_CHANGE',
  );
  const durablePreClaimSafety = await fatalFake.dependencies.migrationStore.loadRootSafety(
    fixture.identity.rootId,
  );
  const restartedBeforeClaim = fakeDependencies();
  Object.assign(restartedBeforeClaim.rootSafety, structuredClone(durablePreClaimSafety));
  fatalFake = restartedBeforeClaim;
  const initial = createMigrationStateV1({
    migrationId: fixture.identity.migrationId,
    rootId: fixture.identity.rootId,
    writerId: fixture.identity.writerId,
    createdAt: timestamp,
  });
  const attachment = await startOrAttachMigrationV1(initial, fatalFake.dependencies.migrationStore);
  assert.equal(attachment.state.status, 'ROOT_FROZEN');
  const capability = createMigrationRootExecutionCapabilityV1(attachment, fatalFake.dependencies);
  const proposedStageA = await plannedFor(fixture.planningScenarios[1]);
  const frozen = await executeMigrationStepV1(proposedStageA, capability);
  assert.equal(frozen.status, 'ROOT_FROZEN');
  await assertRootSafetyProjection(
    rootSafetyScenario('fatal-before-first-claim'), fatalFake, 'root-fatal-denied',
  );

  const fingerprintOne = 'f'.repeat(64);
  const fingerprintTwo = 'e'.repeat(64);
  const evidenceA = activationEvidence('activations/a.json', fingerprintOne, 'a');
  const evidenceBSame = activationEvidence('activations/b.json', fingerprintOne, 'b');
  const evidenceBDifferent = activationEvidence('activations/b.json', fingerprintTwo, 'b');
  const stale = cutoverInput();
  for (const [name, first, later, restart] of [
    ['activated-state-then-stale-preactivation-state', cutoverInput([evidenceA]), stale, false],
    ['conflict-fatal-then-stale-safe-state', cutoverInput([evidenceA, evidenceBDifferent]), cutoverInput([evidenceA]), false],
    ['evidence-retention-subset-write', cutoverInput([evidenceA, evidenceBSame]), cutoverInput([evidenceA]), false],
    ['restart-after-stale-cutover-write', cutoverInput([evidenceA]), stale, true],
  ]) {
    let fake = fakeDependencies();
    await fake.dependencies.migrationStore.persistCutoverState(fixture.identity.rootId, first);
    await fake.dependencies.migrationStore.persistCutoverState(fixture.identity.rootId, later);
    if (restart) {
      const durable = await fake.dependencies.migrationStore.loadRootSafety(fixture.identity.rootId);
      const restarted = fakeDependencies();
      Object.assign(restarted.rootSafety, structuredClone(durable));
      fake = restarted;
    }
    const recovery = await recoverMigrationActivationCutoverV1(
      initial,
      {
        load: () => fake.dependencies.migrationStore.loadCutoverState(fixture.identity.rootId),
        persist: value => fake.dependencies.migrationStore.persistCutoverState(fixture.identity.rootId, value),
      },
    );
    const decision = decideLegacyPutV1(recovery);
    await assertRootSafetyProjection(rootSafetyScenario(name), fake, decision.reason);
  }
});

test('cross-root cutover before first claim is rejected without mutating root authority', async () => {
  const scenario = rootBindingScenario('cross-root-cutover-before-first-claim');
  const fake = fakeDependencies();
  const before = await fake.dependencies.migrationStore.loadRootSafety(fixture.identity.rootId);
  const conflictingCutover = cutoverInput([
    activationEvidence('activations/a.json', 'f'.repeat(64), 'a'),
    activationEvidence('activations/b.json', 'e'.repeat(64), 'b'),
  ]);
  let result;
  await assert.rejects(
    fake.dependencies.migrationStore.persistCutoverState(
      scenario.requestedRootId, conflictingCutover,
    ),
    error => {
      result = error.code;
      return error.code === scenario.expectedResult;
    },
  );
  const afterRejection = await fake.dependencies.migrationStore.loadRootSafety(
    fixture.identity.rootId,
  );
  assert.deepEqual(afterRejection, before);
  assert.equal(await fake.dependencies.migrationStore.load(fixture.identity.rootId), null);
  assert.equal(fake.migrationStates.length, 0);

  const initial = createMigrationStateV1({
    migrationId: fixture.identity.migrationId,
    rootId: fixture.identity.rootId,
    writerId: fixture.identity.writerId,
    createdAt: timestamp,
  });
  const attachment = await startOrAttachMigrationV1(initial, fake.dependencies.migrationStore);
  const safety = await fake.dependencies.migrationStore.loadRootSafety(fixture.identity.rootId);
  assert.deepEqual({
    result,
    rootSafetyRootId: safety.rootId,
    authorityGeneration: safety.generation,
    evidencePaths: safety.cutoverState.verifiedActivationEvidence.map(value => value.path),
    fatalCodes: safety.rootFatalSignals.map(value => value.code).sort(),
    remoteS2Activated: safety.cutoverState.remoteS2Activated,
    migrationStatus: attachment.state.status,
    putCount: fake.remoteTrace.filter(value => value.operation === 'PUT').length,
  }, {
    result: scenario.expectedResult,
    rootSafetyRootId: scenario.expectedRootSafetyRootId,
    authorityGeneration: scenario.expectedAuthorityGeneration,
    evidencePaths: scenario.expectedEvidencePaths,
    fatalCodes: scenario.expectedFatalCodes,
    remoteS2Activated: scenario.expectedRemoteS2Activated,
    migrationStatus: scenario.expectedMigrationStatus,
    putCount: scenario.expectedPutCount,
  });

  const claimed = fakeDependencies();
  await startOrAttachMigrationV1(initial, claimed.dependencies.migrationStore);
  const claimedSafetyBefore = await claimed.dependencies.migrationStore.loadRootSafety(
    fixture.identity.rootId,
  );
  const claimedMigrationBefore = await claimed.dependencies.migrationStore.load(
    fixture.identity.rootId,
  );
  await assert.rejects(
    claimed.dependencies.migrationStore.persistCutoverState(
      scenario.requestedRootId, conflictingCutover,
    ),
    error => error.code === scenario.expectedResult,
  );
  assert.deepEqual(
    await claimed.dependencies.migrationStore.loadRootSafety(fixture.identity.rootId),
    claimedSafetyBefore,
  );
  assert.deepEqual(
    await claimed.dependencies.migrationStore.load(fixture.identity.rootId),
    claimedMigrationBefore,
  );
  assert.equal(claimed.remoteTrace.length, 0);
});

test('execution capability privately binds its issuance remote and authority references', async () => {
  const scenario = correctnessScenario('capability-post-issuance-remote-replacement');
  const planned = await plannedFor(fixture.planningScenarios[1]);
  const bound = fakeDependencies();
  bound.migrationAuthority.current = structuredClone(planned);
  const attachment = await startOrAttachMigrationV1(planned, bound.dependencies.migrationStore);
  const capability = createMigrationRootExecutionCapabilityV1(attachment, bound.dependencies);
  const replacement = fakeDependencies({ rootId: fixture.identity.newRootId });
  bound.dependencies.remote = replacement.dependencies.remote;
  bound.dependencies.migrationStore = replacement.dependencies.migrationStore;
  bound.dependencies.cutoverStore = replacement.dependencies.cutoverStore;
  const result = await executeMigrationStepV1(planned, capability);
  assertCorrectnessProjection(scenario, result, bound);
  assert.equal(replacement.remoteTrace.length, 0);
});

test('same-generation snapshot and plan replacement is rejected after a durable receipt', async () => {
  const scenario = correctnessScenario('same-generation-snapshot-replacement');
  const plannedX = await plannedFor(fixture.planningScenarios[1]);
  const fake = fakeDependencies();
  let durableX = await execute(plannedX, fake);
  assert.equal(durableX.status, 'STAGE_A_COMPLETE');
  const originalPath = durableX.stageA[0].intent.remotePath;
  fake.remoteTrace.length = 0;
  const proposedY = await plannedFor(fixture.planningScenarios[2]);
  proposedY.generation = durableX.generation;
  const attachment = await startOrAttachMigrationV1(durableX, fake.dependencies.migrationStore);
  const capability = createMigrationRootExecutionCapabilityV1(attachment, fake.dependencies);
  await assert.rejects(
    executeMigrationStepV1(proposedY, capability),
    error => error.code === 'LOCAL_MIGRATION_STATE_CORRUPTION',
  );
  durableX = await fake.dependencies.migrationStore.load(fixture.identity.rootId);
  assertCorrectnessProjection(scenario, durableX, fake);
  assert.deepEqual([...fake.objects.keys()], [originalPath]);
  const published = await Promise.all([...fake.objects.values()].map(bytes => decodeFrozenWireCommitV1(bytes)));
  assert.deepEqual(detectWriterForksV1(published), []);
});

test('cutover fatal is read inside the publish gate and stale caller dependencies cannot bypass it', async () => {
  for (const name of ['cutover-fatal-blocks-publish', 'combined-stale-context-cutover-fatal']) {
    const scenario = correctnessScenario(name);
    const planned = await plannedFor(fixture.planningScenarios[1]);
    const live = fakeDependencies();
    live.migrationAuthority.current = structuredClone(planned);
    await installCutoverFatal(live);
    const attachment = await startOrAttachMigrationV1(planned, live.dependencies.migrationStore);
    const capability = createMigrationRootExecutionCapabilityV1(attachment, live.dependencies);
    if (name.startsWith('combined')) {
      const stale = fakeDependencies();
      live.dependencies.remote = stale.dependencies.remote;
      live.dependencies.migrationStore = stale.dependencies.migrationStore;
      live.dependencies.cutoverStore = stale.dependencies.cutoverStore;
    }
    const result = await executeMigrationStepV1(planned, capability);
    assertCorrectnessProjection(scenario, result, live);
    assert.equal(live.actualDecisions.cutover.at(-1), scenario.expectedCutoverDecision);
  }
});

test('shared execution scenarios recover through receipts and preserve the Stage A gate', async () => {
  const standardScenario = fixture.planningScenarios[2];
  let normal = await plannedFor(standardScenario);
  const normalFake = fakeDependencies({ responseLost: true });
  const normalTrace = [];
  while (normal.status !== 'MIGRATION_COMPLETE') {
    normal = await execute(normal, normalFake);
    normalTrace.push(normal.status);
  }
  assert.deepEqual(normalTrace, fixture.standardStatusTrace);

  for (const scenario of fixture.executionScenarios.slice(0, 4)) {
    const planningScenario = fixture.planningScenarios.find(value => value.name === scenario.planningScenario);
    let state = await plannedFor(planningScenario);
    const fake = fakeDependencies();
    if (scenario.name === 'restart-during-stage-a') {
      state = await execute(state, fake);
    } else if (scenario.name === 'restart-during-activation-publish') {
      while (state.status !== 'ACTIVATION_PUBLISHING') {
        state = await execute(state, fake);
      }
    } else {
      state = await execute(state, fake);
    }
    assert.equal(state.status, scenario.expectedRestartStatus, scenario.name);
    const firstStagePath = state.stageA[0]?.intent.remotePath;
    const putsBeforeRestart = firstStagePath === undefined ? 0 : fake.putCounts.get(firstStagePath);
    state = await deserializeMigrationStateV1(serializeMigrationStateV1(state));
    while (state.status !== 'MIGRATION_COMPLETE') {
      state = await execute(state, fake);
      if (state.status === 'STAGE_B_PUBLISHING') assert.equal(state.stageA.every(value => value.receipt !== null), true);
    }
    assert.equal(state.status, scenario.expectedFinalStatus, scenario.name);
    assert.equal(fake.cutover.state.remoteS2Activated, true, scenario.name);
    if (scenario.expectedNoRepublish) assert.equal(fake.putCounts.get(firstStagePath), putsBeforeRestart);
  }
});

test('empty migration and response-lost publishing still require exact verification before cutover', async () => {
  let state = await plannedFor(fixture.planningScenarios[0]);
  const fake = fakeDependencies({ responseLost: true });
  const trace = [];
  while (state.status !== 'MIGRATION_COMPLETE') {
    state = await execute(state, fake);
    trace.push(state.status);
  }
  assert.deepEqual(trace, fixture.emptyStatusTrace);
  assert.equal(fake.objects.size, 1);
  assert.equal(fake.cutover.state.remoteS2Activated, true);
});

test('durable migration codec rejects a changed captured snapshot', async () => {
  const state = await plannedFor(fixture.planningScenarios[2]);
  const encoded = JSON.parse(serializeMigrationStateV1(state));
  encoded.snapshot.canonicalEntities[0].value.originalName = 'CORRUPTED';
  await assert.rejects(
    deserializeMigrationStateV1(JSON.stringify(encoded)),
    error => error.code === 'LOCAL_MIGRATION_STATE_CORRUPTION',
  );
  const identityChanged = structuredClone(state);
  identityChanged.migrationId = fixture.identity.newMigrationId;
  await assert.rejects(
    deserializeMigrationStateV1(serializeMigrationStateV1(identityChanged)),
    error => error.code === 'LOCAL_MIGRATION_STATE_CORRUPTION',
  );
});

test('same snapshot replans byte-identically and frozen roots only hand off to a new root', async () => {
  const scenario = fixture.planningScenarios[2];
  const first = await plannedFor(scenario);
  const second = await plannedFor(scenario);
  assert.deepEqual(migrationProjectionV1(second), migrationProjectionV1(first));
  assert.deepEqual(
    [...second.stageA, ...second.stageB].map(value => value.intent.exactBytes),
    [...first.stageA, ...first.stageB].map(value => value.intent.exactBytes),
  );

  const handoffCase = fixture.executionScenarios.at(-1);
  const frozen = freezeOldRootForNewRootHandoffV1(first, [handoffCase.fatalCode]);
  const frozenFake = fakeDependencies();
  frozenFake.migrationAuthority.current = structuredClone(frozen);
  assert.deepEqual(await execute(frozen, frozenFake), frozen);
  assert.equal(frozenFake.objects.size, 0);
  const next = createNewRootMigrationHandoffV1(frozen, {
    migrationId: fixture.identity.newMigrationId,
    newRootId: fixture.identity.newRootId,
    writerId: fixture.identity.newWriterId,
    createdAt: timestamp,
  });
  const planned = await planCapturedMigrationV1(next);
  assert.equal(frozen.status, 'ROOT_FROZEN');
  assert.equal(planned.sourceType, handoffCase.expectedSourceType);
  assert.equal(planned.preservationHandoff.oldRootId, fixture.identity.rootId);
  assert.equal(planned.snapshot.legacyFingerprint, first.snapshot.legacyFingerprint);
  const newRootFake = fakeDependencies({ responseLost: true, rootId: fixture.identity.newRootId });
  let completed = planned;
  while (completed.status !== 'MIGRATION_COMPLETE') {
    completed = await execute(completed, newRootFake);
  }
  assert.equal(completed.status, 'MIGRATION_COMPLETE');
  assert.equal(newRootFake.cutover.state.remoteS2Activated, true);
});

test('activation same-path mismatch freezes migration without overwriting remote bytes', async () => {
  let state = await plannedFor(fixture.planningScenarios[1]);
  const fake = fakeDependencies();
  while (state.status !== 'STAGE_A_COMPLETE') {
    state = await execute(state, fake);
  }
  const path = state.activationIntent.remotePath;
  fake.objects.set(path, Uint8Array.from([1, 2, 3]));
  state = await execute(state, fake);
  assert.equal(state.status, 'ROOT_FROZEN');
  assert.deepEqual(state.rootFatalSignals, [{ code: 'SYNC_ROOT_FROZEN_CORRUPTION' }]);
  assert.deepEqual([...fake.objects.get(path)], [1, 2, 3]);
  assert.equal(fake.putCounts.get(path), undefined);
});

test('shared root binding failures reject A-to-B confusion, old receipts, and same-root handoff', async () => {
  assert.deepEqual(fixture.failureScenarios.slice(0, 3).map(value => value.name), [
    'root-a-state-on-root-b', 'old-receipt-on-new-root', 'same-root-handoff',
  ]);
  const planned = await plannedFor(fixture.planningScenarios[1]);
  const rootB = fakeDependencies({ rootId: fixture.identity.newRootId });
  const wrongRootState = createMigrationStateV1({
    migrationId: fixture.identity.newMigrationId,
    rootId: fixture.identity.newRootId,
    writerId: fixture.identity.newWriterId,
    createdAt: timestamp,
  });
  rootB.migrationAuthority.current = structuredClone(wrongRootState);
  const rootBAttachment = await startOrAttachMigrationV1(wrongRootState, rootB.dependencies.migrationStore);
  const rootBCapability = createMigrationRootExecutionCapabilityV1(rootBAttachment, rootB.dependencies);
  await assert.rejects(
    executeMigrationStepV1(planned, rootBCapability),
    error => error.code === 'MIGRATION_ROOT_BINDING_MISMATCH',
  );
  assert.equal(rootB.remoteTrace.some(value => value.operation === 'PUT'), false);
  assert.deepEqual(rootB.remoteTrace.map(value => value.operation), failureScenario('root-a-state-on-root-b').expectedOperations);

  const fake = fakeDependencies();
  let receipted = planned;
  while (receipted.status !== 'STAGE_A_COMPLETE') receipted = await execute(receipted, fake);
  const moved = structuredClone(receipted);
  moved.rootId = fixture.identity.newRootId;
  await assert.rejects(
    deserializeMigrationStateV1(serializeMigrationStateV1(moved)),
    error => error.code === 'LOCAL_MIGRATION_STATE_CORRUPTION',
  );
  const frozen = freezeOldRootForNewRootHandoffV1(receipted, ['SYNC_ROOT_FROZEN_CORRUPTION']);
  assert.throws(
    () => createNewRootMigrationHandoffV1(frozen, {
      migrationId: fixture.identity.newMigrationId,
      newRootId: fixture.identity.rootId,
      writerId: fixture.identity.newWriterId,
      createdAt: timestamp,
    }),
    error => error.code === 'invalid_frozen_root_handoff',
  );
});

test('fatal authority blocks publishing and stale execution cannot overwrite an interleaved freeze', async () => {
  const planned = await plannedFor(fixture.planningScenarios[1]);
  const knownFatal = fakeDependencies();
  const frozen = freezeOldRootForNewRootHandoffV1(planned, ['SYNC_ROOT_FROZEN_WRITER_FORK']);
  knownFatal.migrationAuthority.current = structuredClone(frozen);
  const returned = await execute(planned, knownFatal);
  assert.equal(returned.status, 'ROOT_FROZEN');
  assert.equal(knownFatal.remoteTrace.some(value => value.operation === 'PUT'), false);
  assert.deepEqual(knownFatal.remoteTrace.map(value => value.operation), failureScenario('known-fatal-blocks-publish').expectedOperations);

  const interleaved = fakeDependencies();
  interleaved.migrationAuthority.freezeBeforePublish = true;
  const stopped = await execute(planned, interleaved);
  assert.equal(stopped.status, 'ROOT_FROZEN');
  assert.deepEqual(stopped.rootFatalSignals, [{ code: 'SYNC_ROOT_FROZEN_CORRUPTION' }]);
  assert.equal(interleaved.remoteTrace.some(value => value.operation === 'PUT'), false);
  assert.deepEqual(interleaved.remoteTrace.map(value => value.operation), failureScenario('freeze-before-exclusive-publish').expectedOperations);
  assert.equal(interleaved.migrationAuthority.current.status, 'ROOT_FROZEN');
});

test('durable activation evidence recovers cutover and forged Complete cannot allow legacy PUT', async () => {
  let state = await plannedFor(fixture.planningScenarios[0]);
  const fake = fakeDependencies({ responseLost: true });
  while (state.status !== 'ACTIVATION_VERIFIED') state = await execute(state, fake);
  assert.deepEqual(fake.remoteTrace.map(value => value.operation), failureScenario('activation-cutover-crash').expectedOperations);
  assert.equal(fake.cutover.state, null);
  const recovery = await recoverMigrationActivationCutoverV1(state, fake.dependencies.cutoverStore);
  assert.deepEqual(decideLegacyPutV1(recovery), { allowed: false, reason: 'REMOTE_S2_ACTIVATED' });
  state = await deserializeMigrationStateV1(serializeMigrationStateV1(state));
  state = await execute(state, fake);
  assert.equal(state.status, 'MIGRATION_COMPLETE');

  const stale = await plannedFor(fixture.planningScenarios[0]);
  stale.status = 'MIGRATION_COMPLETE';
  const staleRecovery = await recoverMigrationActivationCutoverV1(stale, fakeDependencies().dependencies.cutoverStore);
  assert.deepEqual(decideLegacyPutV1(staleRecovery), {
    allowed: false, reason: 'CUTOVER_RECOVERY_NOT_READY',
  });
});

test('atomic start-or-attach chooses one same-root attempt and activation requires durable capability', async () => {
  const first = createMigrationStateV1({
    migrationId: fixture.identity.migrationId,
    rootId: fixture.identity.rootId,
    writerId: fixture.identity.writerId,
    createdAt: timestamp,
  });
  const second = createMigrationStateV1({
    migrationId: fixture.identity.newMigrationId,
    rootId: fixture.identity.rootId,
    writerId: fixture.identity.newWriterId,
    createdAt: timestamp,
  });
  const fake = fakeDependencies();
  const [attachedA, attachedB] = await Promise.all([
    startOrAttachMigrationV1(first, fake.dependencies.migrationStore),
    startOrAttachMigrationV1(second, fake.dependencies.migrationStore),
  ]);
  assert.equal(attachedA.state.migrationId, attachedB.state.migrationId);
  assert.equal(fake.migrationAuthority.current.migrationId, attachedA.state.migrationId);

  const planned = await plannedFor(fixture.planningScenarios[0]);
  await assert.rejects(
    publishPersistedActivationIntentV1(
      { persistedFingerprint: planned.activationIntent.intentFingerprint },
      fake.dependencies.remote,
      timestamp,
    ),
    error => error.code === 'LOCAL_PREPARED_INTENT_CORRUPTION',
  );
  assert.equal(fake.remoteTrace.some(value => value.operation === 'PUT'), false);
});

test('shared Stage B partial-crash trace resumes without republishing Stage A', async () => {
  const scenario = fixture.planningScenarios.find(value => value.name === 'stage-b-more-than-256');
  let state = await plannedFor(scenario);
  const fake = fakeDependencies({ responseLost: true });
  while (!(state.status === 'STAGE_B_PUBLISHING' && state.stageB[0].receipt !== null)) {
    state = await execute(state, fake);
  }
  const stageAPuts = state.stageA.map(task => fake.putCounts.get(task.intent.remotePath));
  state = await deserializeMigrationStateV1(serializeMigrationStateV1(state));
  while (state.status !== 'MIGRATION_COMPLETE') state = await execute(state, fake);
  assert.deepEqual(state.stageA.map(task => fake.putCounts.get(task.intent.remotePath)), stageAPuts);
  assert.equal(state.stageB.every(task => task.receipt !== null), true);
});
