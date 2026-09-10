import type { DiscoveryStateV1 } from './remoteDiscovery.ts';

export interface VerifiedActivationEvidenceV1 {
  path: string;
  activationId: string;
  contentHash: string;
  exactBytesHash: string;
  legacyFingerprint: string | null;
}

export type ActivationFingerprintConsistencyV1 =
  | { state: 'NoEvidence' }
  | { state: 'Consistent'; legacyFingerprint: string | null }
  | { state: 'Conflict' };

export interface ActivationCutoverFatalV1 {
  code: 'SYNC_ROOT_FROZEN_LEGACY_CHANGE';
}

export interface ActivationCutoverStateV1 {
  stateVersion: 1;
  remoteS2Activated: boolean;
  verifiedActivationEvidence: VerifiedActivationEvidenceV1[];
  fingerprintConsistency: ActivationFingerprintConsistencyV1;
  rootFatalSignals: ActivationCutoverFatalV1[];
}

export type LegacyPutDecisionV1 =
  | { allowed: true; reason: 'S2_NOT_ACTIVATED' }
  | { allowed: false; reason: 'REMOTE_S2_ACTIVATED' | 'CUTOVER_RECOVERY_NOT_READY' };

export interface ActivationCutoverNotReadyV1 {
  readonly readiness: 'NotReady';
  readonly reason: 'RECOVERY_NOT_STARTED' | 'PERSISTED_STATE_INVALID';
}

declare const activationCutoverReadyBrand: unique symbol;

export interface ActivationCutoverReadyV1 {
  readonly readiness: 'Ready';
  readonly [activationCutoverReadyBrand]: true;
}

export type ActivationCutoverRecoveryV1 = ActivationCutoverNotReadyV1 | ActivationCutoverReadyV1;

const readyStateByCapability = new WeakMap<object, ActivationCutoverStateV1>();

function createReadyCapability(state: Readonly<ActivationCutoverStateV1>): ActivationCutoverReadyV1 {
  const capability = Object.freeze({ readiness: 'Ready' }) as ActivationCutoverReadyV1;
  readyStateByCapability.set(capability, structuredClone(state));
  return capability;
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fingerprintKey(value: string | null): string {
  return value === null ? '0:null' : `1:${value}`;
}

function computeConsistency(evidence: readonly VerifiedActivationEvidenceV1[]): ActivationFingerprintConsistencyV1 {
  if (evidence.length === 0) return { state: 'NoEvidence' };
  const fingerprints = new Map<string, string | null>();
  for (const value of evidence) fingerprints.set(fingerprintKey(value.legacyFingerprint), value.legacyFingerprint);
  if (fingerprints.size > 1) return { state: 'Conflict' };
  return { state: 'Consistent', legacyFingerprint: fingerprints.values().next().value as string | null };
}

export function createActivationCutoverStateV1(): ActivationCutoverStateV1 {
  return {
    stateVersion: 1,
    remoteS2Activated: false,
    verifiedActivationEvidence: [],
    fingerprintConsistency: { state: 'NoEvidence' },
    rootFatalSignals: [],
  };
}

export function evaluateActivationCutoverV1(
  prior: Readonly<ActivationCutoverStateV1>,
  discovery: Readonly<DiscoveryStateV1>,
): ActivationCutoverStateV1 {
  const state = structuredClone(prior) as ActivationCutoverStateV1;
  for (const object of discovery.verifiedObjects) {
    if (object.kind !== 'activation') continue;
    if (object.activationId === undefined || object.fingerprintEvidence.state === 'Missing') {
      throw new Error('verified_activation_evidence_incomplete');
    }
    if (!state.verifiedActivationEvidence.some(value => value.path === object.path)) {
      state.verifiedActivationEvidence.push({
        path: object.path,
        activationId: object.activationId,
        contentHash: object.contentHash,
        exactBytesHash: object.exactBytesHash,
        legacyFingerprint: object.fingerprintEvidence.state === 'Null'
          ? null
          : object.fingerprintEvidence.value,
      });
    }
  }
  state.verifiedActivationEvidence.sort((left, right) => asciiCompare(left.path, right.path));
  state.remoteS2Activated ||= state.verifiedActivationEvidence.length > 0;
  state.fingerprintConsistency = computeConsistency(state.verifiedActivationEvidence);
  if (state.fingerprintConsistency.state === 'Conflict'
    && !state.rootFatalSignals.some(value => value.code === 'SYNC_ROOT_FROZEN_LEGACY_CHANGE')) {
    state.rootFatalSignals.push({ code: 'SYNC_ROOT_FROZEN_LEGACY_CHANGE' });
  }
  return state;
}

export function beginActivationCutoverRecoveryV1(): ActivationCutoverRecoveryV1 {
  return { readiness: 'NotReady', reason: 'RECOVERY_NOT_STARTED' };
}

export function recoverActivationCutoverV1(
  discovery: Readonly<DiscoveryStateV1>,
  persisted: Readonly<ActivationCutoverStateV1> | null,
): ActivationCutoverRecoveryV1 {
  try {
    const prior = persisted === null ? createActivationCutoverStateV1() : structuredClone(persisted);
    const state = evaluateActivationCutoverV1(prior, discovery);
    const hasEvidence = state.verifiedActivationEvidence.length > 0;
    const hasConflictFatal = state.rootFatalSignals.some(value => value.code === 'SYNC_ROOT_FROZEN_LEGACY_CHANGE');
    if (state.stateVersion !== 1
      || (state.remoteS2Activated && !hasEvidence)
      || (hasConflictFatal && state.fingerprintConsistency.state !== 'Conflict')) {
      return { readiness: 'NotReady', reason: 'PERSISTED_STATE_INVALID' };
    }
    return createReadyCapability(state);
  } catch {
    return { readiness: 'NotReady', reason: 'PERSISTED_STATE_INVALID' };
  }
}

export function decideLegacyPutV1(recovery: Readonly<ActivationCutoverRecoveryV1>): LegacyPutDecisionV1 {
  const state = typeof recovery === 'object' && recovery !== null
    ? readyStateByCapability.get(recovery)
    : undefined;
  if (state === undefined) {
    return { allowed: false, reason: 'CUTOVER_RECOVERY_NOT_READY' };
  }
  return state.remoteS2Activated
    ? { allowed: false, reason: 'REMOTE_S2_ACTIVATED' }
    : { allowed: true, reason: 'S2_NOT_ACTIVATED' };
}

export function getActivationCutoverDiagnosticStateV1(
  recovery: Readonly<ActivationCutoverRecoveryV1>,
): ActivationCutoverStateV1 | null {
  const state = typeof recovery === 'object' && recovery !== null
    ? readyStateByCapability.get(recovery)
    : undefined;
  return state === undefined ? null : structuredClone(state);
}

export interface ActivationCutoverStateStoreV1 {
  persist(state: Readonly<ActivationCutoverStateV1>): Promise<void>;
  load(): Promise<ActivationCutoverStateV1 | null>;
}

export async function persistActivationCutoverStateV1(
  state: Readonly<ActivationCutoverStateV1>,
  store: ActivationCutoverStateStoreV1,
): Promise<void> {
  await store.persist(structuredClone(state));
}

export async function loadActivationCutoverStateV1(
  store: ActivationCutoverStateStoreV1,
): Promise<ActivationCutoverStateV1 | null> {
  return structuredClone(await store.load());
}

export async function recoverActivationCutoverFromStoreV1(
  discovery: Readonly<DiscoveryStateV1>,
  store: ActivationCutoverStateStoreV1,
): Promise<ActivationCutoverRecoveryV1> {
  const ownedDiscovery = structuredClone(discovery);
  const persisted = await loadActivationCutoverStateV1(store);
  return recoverActivationCutoverV1(ownedDiscovery, persisted);
}
