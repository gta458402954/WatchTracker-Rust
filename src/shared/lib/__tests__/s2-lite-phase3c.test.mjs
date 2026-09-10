import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  beginActivationCutoverRecoveryV1,
  createActivationCutoverStateV1,
  createDiscoveryStateV1,
  decideLegacyPutV1,
  getActivationCutoverDiagnosticStateV1,
  loadActivationCutoverStateV1,
  observeCandidateListingV1,
  parseActivationCandidatePathV1,
  persistActivationCutoverStateV1,
  recoverActivationCutoverFromStoreV1,
  recoverActivationCutoverV1,
  sha256Hex,
  verifyActivationCandidateV1,
} from '../../../features/sync/s2lite/index.ts';

const fixture = JSON.parse(await readFile(new URL(
  '../../../../contracts/s2-lite/v1/activation-cutover-golden-v1.json', import.meta.url,
)));

function discoveryWithEvidence(evidence) {
  const discovery = createDiscoveryStateV1();
  discovery.verifiedObjects = evidence.map(value => ({
    path: value.path,
    kind: 'activation',
    exactBytesHash: value.exactBytesHash,
    exactBytesHex: '',
    contentHash: value.contentHash,
    activationId: value.activationId,
    fingerprintEvidence: value.legacyFingerprint === null
      ? { state: 'Null' }
      : { state: 'Value', value: value.legacyFingerprint },
  }));
  return discovery;
}

function discoveryWithTaggedEvidence(entries) {
  const discovery = createDiscoveryStateV1();
  discovery.verifiedObjects = entries.map(entry => {
    const value = fixture.evidence[entry.key];
    return {
      path: value.path,
      kind: 'activation',
      exactBytesHash: value.exactBytesHash,
      exactBytesHex: '',
      contentHash: value.contentHash,
      activationId: value.activationId,
      fingerprintEvidence: structuredClone(entry.fingerprintEvidence),
    };
  });
  return discovery;
}

function expectedState(name) {
  return fixture.scenarios.find(value => value.name === name).expected;
}

test('shared Phase 3C fixture matches every activation/cutover state transition', () => {
  assert.equal(fixture.schema, 'watchtracker-s2-lite-activation-cutover-golden-v1');
  assert.equal(fixture.scenarios.length, 9);
  for (const scenario of fixture.scenarios) {
    const prior = scenario.serializeRestart
      ? JSON.parse(JSON.stringify(scenario.prior))
      : structuredClone(scenario.prior);
    const discovery = JSON.parse(JSON.stringify(discoveryWithEvidence(scenario.verifiedActivations)));
    const recovery = recoverActivationCutoverV1(discovery, prior);
    assert.equal(recovery.readiness, 'Ready', scenario.name);
    assert.deepEqual(getActivationCutoverDiagnosticStateV1(recovery), scenario.expected, scenario.name);
    assert.equal(decideLegacyPutV1(recovery).allowed, scenario.legacyPutAllowed, scenario.name);
  }
});

test('activation consistency is independent of verified discovery order and never selects a winner', () => {
  for (const name of ['multiple-same-fingerprint', 'conflicting-fingerprints', 'null-fingerprint-equality', 'null-vs-non-null-conflict']) {
    const scenario = fixture.scenarios.find(value => value.name === name);
    const forward = recoverActivationCutoverV1(discoveryWithEvidence(scenario.verifiedActivations), createActivationCutoverStateV1());
    const reverse = recoverActivationCutoverV1(discoveryWithEvidence([...scenario.verifiedActivations].reverse()), createActivationCutoverStateV1());
    assert.deepEqual(
      getActivationCutoverDiagnosticStateV1(reverse),
      getActivationCutoverDiagnosticStateV1(forward),
      name,
    );
    assert.deepEqual(decideLegacyPutV1(reverse), decideLegacyPutV1(forward), name);
    assert.deepEqual(getActivationCutoverDiagnosticStateV1(forward), scenario.expected, name);
  }
});

test('verified discovery activation evidence drives a monotonic persisted cutover latch', async () => {
  const activationId = fixture.evidence.a.activationId;
  const bytes = Buffer.from(JSON.stringify({
    activationId,
    legacyFingerprint: 'F1',
    semanticProfileSupported: true,
    requiredFeaturesSupported: true,
  }));
  const path = `activations/${activationId}--${await sha256Hex(bytes)}.json`;
  const discovery = createDiscoveryStateV1();
  observeCandidateListingV1(discovery, [path]);
  await verifyActivationCandidateV1(
    discovery,
    parseActivationCandidatePathV1(path),
    bytes,
    async value => JSON.parse(Buffer.from(value).toString('utf8')),
  );
  const recovery = recoverActivationCutoverV1(discovery, null);
  assert.equal(recovery.readiness, 'Ready');
  const activated = getActivationCutoverDiagnosticStateV1(recovery);
  assert.equal(activated.remoteS2Activated, true);
  assert.deepEqual(decideLegacyPutV1(recovery), { allowed: false, reason: 'REMOTE_S2_ACTIVATED' });

  const store = {
    blob: null,
    async persist(value) { this.blob = JSON.stringify(value); },
    async load() { return this.blob === null ? null : JSON.parse(this.blob); },
  };
  await persistActivationCutoverStateV1(activated, store);
  const restarted = await loadActivationCutoverStateV1(store);
  const omitted = recoverActivationCutoverV1(createDiscoveryStateV1(), restarted);
  assert.equal(omitted.readiness, 'Ready');
  assert.deepEqual(getActivationCutoverDiagnosticStateV1(omitted), activated);
  assert.equal(decideLegacyPutV1(omitted).allowed, false);
});

test('recovery is fail-closed before readiness and reconciles durable evidence ahead of a missing or false latch', async () => {
  const notReady = beginActivationCutoverRecoveryV1();
  assert.deepEqual(decideLegacyPutV1(notReady), { allowed: false, reason: 'CUTOVER_RECOVERY_NOT_READY' });

  const discovery = discoveryWithEvidence([fixture.evidence.a]);
  const emptyStore = { async persist() {}, async load() { return null; } };
  const recoveredEmpty = await recoverActivationCutoverFromStoreV1(discovery, emptyStore);
  assert.equal(recoveredEmpty.readiness, 'Ready');
  assert.equal(getActivationCutoverDiagnosticStateV1(recoveredEmpty).remoteS2Activated, true);
  assert.equal(decideLegacyPutV1(recoveredEmpty).allowed, false);

  const contradictoryFalse = createActivationCutoverStateV1();
  const recoveredFalse = recoverActivationCutoverV1(discovery, contradictoryFalse);
  assert.equal(recoveredFalse.readiness, 'Ready');
  assert.equal(getActivationCutoverDiagnosticStateV1(recoveredFalse).remoteS2Activated, true);
  assert.equal(decideLegacyPutV1(recoveredFalse).allowed, false);
});

test('shared recovery fixture covers readiness, persistence contradictions, tri-state roundtrips, and equality cases', () => {
  assert.equal(fixture.recoveryScenarios.length, 11);
  for (const scenario of fixture.recoveryScenarios) {
    if (scenario.operation === 'notReady') {
      const recovery = beginActivationCutoverRecoveryV1();
      assert.equal(recovery.readiness, scenario.expectedReadiness, scenario.name);
      assert.deepEqual(decideLegacyPutV1(recovery), scenario.expectedDecision, scenario.name);
      continue;
    }

    let discovery = discoveryWithTaggedEvidence(scenario.evidence);
    if (scenario.operation === 'roundtripRecover') {
      discovery = JSON.parse(JSON.stringify(discovery));
      assert.deepEqual(
        discovery.verifiedObjects[0].fingerprintEvidence,
        scenario.expectedFingerprintEvidence,
        scenario.name,
      );
    }
    const persisted = scenario.persistedScenario === null
      ? null
      : structuredClone(expectedState(scenario.persistedScenario));
    const recovery = recoverActivationCutoverV1(discovery, persisted);
    assert.deepEqual(decideLegacyPutV1(recovery), scenario.expectedDecision, scenario.name);
    if (scenario.expectedReadiness !== undefined) {
      assert.equal(recovery.readiness, scenario.expectedReadiness, scenario.name);
    }
    const state = getActivationCutoverDiagnosticStateV1(recovery);
    if (scenario.expectedScenario !== undefined) {
      assert.deepEqual(state, expectedState(scenario.expectedScenario), scenario.name);
    }
    if (scenario.expectedActivated !== undefined) {
      assert.equal(state.remoteS2Activated, scenario.expectedActivated, scenario.name);
      assert.deepEqual(state.fingerprintConsistency, scenario.expectedConsistency, scenario.name);
    }
  }
});

test('async store recovery owns discovery evidence before the first await', async () => {
  for (const fingerprintEvidence of [
    { state: 'Null' },
    { state: 'Value', value: 'F1' },
  ]) {
    for (const persisted of [null, createActivationCutoverStateV1()]) {
      const key = fingerprintEvidence.state === 'Null' ? 'n1' : 'a';
      const discovery = discoveryWithTaggedEvidence([{ key, fingerprintEvidence }]);
      let releaseLoad;
      const store = {
        async persist() {},
        load() {
          return new Promise(resolve => { releaseLoad = () => resolve(structuredClone(persisted)); });
        },
      };
      const recoveryPromise = recoverActivationCutoverFromStoreV1(discovery, store);
      discovery.verifiedObjects[0].fingerprintEvidence = fingerprintEvidence.state === 'Null'
        ? { state: 'Value', value: 'MUTATED' }
        : { state: 'Null' };
      discovery.verifiedObjects.length = 0;
      releaseLoad();
      const recovery = await recoveryPromise;
      const state = getActivationCutoverDiagnosticStateV1(recovery);
      assert.equal(state.remoteS2Activated, true);
      assert.deepEqual(state.fingerprintConsistency, {
        state: 'Consistent',
        legacyFingerprint: fingerprintEvidence.state === 'Null' ? null : 'F1',
      });
      assert.deepEqual(decideLegacyPutV1(recovery), { allowed: false, reason: 'REMOTE_S2_ACTIVATED' });
    }
  }
});

test('Ready is runtime-opaque and diagnostic state mutation cannot change a decision', () => {
  const fakeReady = { readiness: 'Ready', state: createActivationCutoverStateV1() };
  assert.deepEqual(decideLegacyPutV1(fakeReady), {
    allowed: false,
    reason: 'CUTOVER_RECOVERY_NOT_READY',
  });
  assert.equal(getActivationCutoverDiagnosticStateV1(fakeReady), null);

  const discovery = discoveryWithEvidence([fixture.evidence.a]);
  const originalPersisted = createActivationCutoverStateV1();
  const recovery = recoverActivationCutoverV1(discovery, originalPersisted);
  const diagnostic = getActivationCutoverDiagnosticStateV1(recovery);
  diagnostic.remoteS2Activated = false;
  diagnostic.verifiedActivationEvidence.length = 0;
  originalPersisted.remoteS2Activated = false;
  discovery.verifiedObjects.length = 0;
  assert.deepEqual(decideLegacyPutV1(recovery), { allowed: false, reason: 'REMOTE_S2_ACTIVATED' });
  assert.equal(getActivationCutoverDiagnosticStateV1(recovery).remoteS2Activated, true);
});
