import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile(
  new URL('../contracts/s2-lite/v1/migration-golden-v1.json', import.meta.url),
));
assert.equal(fixture.schema, 'watchtracker-s2-lite-migration-golden-v1');
assert.equal(fixture.planningScenarios.length, 5);
assert.deepEqual(fixture.executionScenarios.map(value => value.name), [
  'restart-during-stage-a',
  'restart-between-stage-a-and-stage-b',
  'restart-during-activation-publish',
  'already-receipted-object-recovery',
  'same-snapshot-deterministic-replan',
  'frozen-old-root-new-root-handoff',
]);
assert.deepEqual(fixture.failureScenarios.map(value => value.name), [
  'root-a-state-on-root-b',
  'old-receipt-on-new-root',
  'same-root-handoff',
  'known-fatal-blocks-publish',
  'freeze-before-exclusive-publish',
  'activation-cutover-crash',
  'stale-complete',
  'duplicate-concurrent-start',
  'stage-b-partial-crash',
  'activation-requires-durable-capability',
]);
assert.deepEqual(fixture.correctnessScenarios.map(value => value.name), [
  'capability-post-issuance-remote-replacement',
  'same-generation-snapshot-replacement',
  'cutover-fatal-blocks-publish',
  'stale-authority-copy',
  'combined-stale-context-cutover-fatal',
]);
for (const scenario of fixture.correctnessScenarios) {
  assert.deepEqual(Object.keys(scenario), [
    'name', 'expectedActualRoot', 'expectedOperations', 'expectedPutOccurred',
    'expectedGeneration', 'expectedStatus', 'expectedSnapshotIdentity',
    'expectedPlanIdentity', 'expectedRetainedReceipts', 'expectedFatalCodes',
    'expectedCutoverDecision',
  ]);
  for (const operation of scenario.expectedOperations) {
    assert.deepEqual(Object.keys(operation), ['operation', 'path']);
  }
}
assert.deepEqual(fixture.finalRaceScenarios.map(value => value.name), [
  'captured-x-restart-proposed-y',
  'stage-a-fatal-during-preflight',
  'stage-b-fatal-during-preflight',
  'activation-fatal-during-preflight',
  'activation-recovery-present-then-absent',
  'admission-wins-then-fatal',
  'fatal-after-admitted-put-blocks-next',
]);
for (const scenario of fixture.finalRaceScenarios) {
  assert.deepEqual(Object.keys(scenario), [
    'name', 'expectedActualRoot', 'expectedOperations', 'expectedPutCount',
    'expectedGeneration', 'expectedStatus', 'expectedSnapshotIdentity',
    'expectedPlanIdentity', 'expectedRetainedReceipts', 'expectedFatalCodes',
    'expectedCutoverDecision', 'expectedRecoveryDecision',
  ]);
}
assert.deepEqual(fixture.rootSafetyScenarios.map(value => value.name), [
  'fatal-before-first-claim',
  'activated-state-then-stale-preactivation-state',
  'conflict-fatal-then-stale-safe-state',
  'evidence-retention-subset-write',
  'restart-after-stale-cutover-write',
]);
assert.deepEqual(fixture.rootBindingScenarios.map(value => value.name), [
  'cross-root-cutover-before-first-claim',
]);
for (const scenario of fixture.rootBindingScenarios) {
  assert.deepEqual(Object.keys(scenario), [
    'name', 'requestedRootId', 'expectedResult', 'expectedRootSafetyRootId',
    'expectedAuthorityGeneration', 'expectedEvidencePaths', 'expectedFatalCodes',
    'expectedRemoteS2Activated', 'expectedMigrationStatus', 'expectedPutCount',
  ]);
}
for (const scenario of fixture.rootSafetyScenarios) {
  assert.deepEqual(Object.keys(scenario), [
    'name', 'expectedRootFatalCodes', 'expectedMigrationStatus',
    'expectedRemoteS2Activated', 'expectedEvidencePaths',
    'expectedFingerprintConsistency', 'expectedCutoverDecision',
    'expectedPutCount', 'expectedMigrationGeneration', 'expectedAuthorityGeneration',
  ]);
}
console.log('verified 5 migration plans, 6 recovery scenarios, 10 failure interleavings, 5 correctness traces, 7 final race traces, 1 root-binding trace, and 5 root-safety traces');
