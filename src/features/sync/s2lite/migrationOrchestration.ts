import {
  beginActivationCutoverRecoveryV1,
  createActivationCutoverStateV1,
  evaluateActivationCutoverV1,
  getActivationCutoverDiagnosticStateV1,
  persistActivationCutoverStateV1,
  recoverActivationCutoverFromStoreV1,
  type ActivationCutoverStateStoreV1,
  type ActivationCutoverStateV1,
} from './activationCutover.ts';
import { buildBootstrapPlanV1 } from './bootstrapPlan.ts';
import {
  BUSINESS_FIELD_ORDER,
} from './semanticProfile.ts';
import {
  canonicalJcsBytes,
  sha256Hex,
  S2ProtocolValidationError,
  validateCanonicalTimestamp,
  validateCanonicalUuidV4,
} from './canonical.ts';
import {
  persistPreparedIntentBeforePublishV1,
  persistPreparedActivationIntentBeforePublishV1,
  persistVerifiedActivationReceiptV1,
  persistVerifiedReceiptV1,
  prepareActivationIntentV1,
  prepareCommitIntentV1,
  publishAdmittedPersistedIntentV1,
  publishAdmittedPersistedActivationIntentV1,
  restartDurableActivationPublishV1,
  restartDurablePublishV1,
  validatePreparedActivationIntentV1,
  validatePreparedIntentV1,
  validatePublishedActivationReceiptV1,
  validatePublishedReceiptV1,
  type ImmutableObjectRemoteV1,
  type PreparedActivationIntentV1,
  type PreparedActivationIntentStoreV1,
  type PreparedIntentStoreV1,
  type PreparedIntentV1,
  type PublishedActivationReceiptV1,
  type PublishedActivationReceiptStoreV1,
  type PublishedReceiptStoreV1,
  type RemotePublishedReceiptV1,
} from './immutablePublish.ts';
import {
  createDiscoveryStateV1,
  type DiscoveryStateV1,
} from './remoteDiscovery.ts';
import type {
  BootstrapEntity,
  CommitRef,
  JsonValue,
  LegacySemanticAdapterV1,
} from './types.ts';

export type MigrationStatusV1 =
  | 'NOT_STARTED'
  | 'LEGACY_SNAPSHOT_CAPTURED'
  | 'BOOTSTRAP_PLANNED'
  | 'STAGE_A_PUBLISHING'
  | 'STAGE_A_COMPLETE'
  | 'STAGE_B_PUBLISHING'
  | 'STAGE_B_COMPLETE'
  | 'ACTIVATION_PUBLISHING'
  | 'ACTIVATION_VERIFIED'
  | 'MIGRATION_COMPLETE'
  | 'ROOT_FROZEN';

export interface CapturedLegacySnapshotV1 {
  snapshotVersion: 1;
  legacyFingerprint: string;
  canonicalEntities: BootstrapEntity[];
}

export interface MigrationCommitTaskV1 {
  stage: 'A' | 'B';
  chunkIndex: number;
  rootId: string;
  intent: PreparedIntentV1;
  receipt: RemotePublishedReceiptV1 | null;
  receiptRootId: string | null;
}

export interface MigrationRootFatalV1 {
  code: string;
}

export interface MigrationRootSafetyStateV1 {
  stateVersion: 1;
  rootId: string;
  generation: number;
  rootFatalSignals: MigrationRootFatalV1[];
  cutoverState: ActivationCutoverStateV1;
}

export interface MigrationStateV1 {
  stateVersion: 1;
  generation: number;
  migrationId: string;
  rootId: string;
  sourceType: 'legacy-bootstrap' | 'new-root-bootstrap';
  writerId: string;
  createdAt: string;
  status: MigrationStatusV1;
  snapshot: CapturedLegacySnapshotV1 | null;
  stageA: MigrationCommitTaskV1[];
  stageB: MigrationCommitTaskV1[];
  activationIntent: PreparedActivationIntentV1 | null;
  activationIntentRootId: string | null;
  activationReceipt: PublishedActivationReceiptV1 | null;
  activationReceiptRootId: string | null;
  rootFatalSignals: MigrationRootFatalV1[];
  preservationHandoff: { oldRootId: string; fatalCodes: string[] } | null;
}

export interface MigrationStateStoreV1 {
  /** The first claim atomically inherits any pre-existing physical-root fatal facts. */
  claimOrLoad(candidate: Readonly<MigrationStateV1>): Promise<MigrationStateV1>;
  load(rootId: string): Promise<MigrationStateV1 | null>;
  compareAndSwap(
    rootId: string,
    migrationId: string,
    expectedGeneration: number,
    next: Readonly<MigrationStateV1>,
  ): Promise<boolean>;
  loadRootSafety(rootId: string): Promise<MigrationRootSafetyStateV1>;
  loadCutoverState(rootId: string): Promise<ActivationCutoverStateV1 | null>;
  /** Monotonic reconcile; it must never replace an already-owned fatal with a safer state. */
  persistCutoverState(rootId: string, state: Readonly<ActivationCutoverStateV1>): Promise<void>;
  persistRootFatal(rootId: string, code: string): Promise<MigrationStateV1 | null>;
  /**
   * The authority reads its owned safety state synchronously, validates the
   * generation/context, and invokes operation without yielding. Cutover/root
   * fatal persistence uses this same serialization boundary.
   */
  runPublishExclusive<T>(
    binding: Readonly<{ rootId: string; migrationId: string; expectedGeneration: number }>,
    operation: () => Promise<T>,
  ): Promise<{ executed: true; value: T } | { executed: false; current: MigrationStateV1 }>;
}

interface MigrationExecutionDependenciesV1 {
  remote: ImmutableObjectRemoteV1 & { readonly physicalRootId: string };
  migrationStore: MigrationStateStoreV1;
  intentStore: PreparedIntentStoreV1;
  receiptStore: PublishedReceiptStoreV1;
  activationIntentStore: PreparedActivationIntentStoreV1;
  activationReceiptStore: PublishedActivationReceiptStoreV1;
  verifiedAtDiagnostic: string;
}

type BoundMigrationExecutionDependenciesV1 = Readonly<MigrationExecutionDependenciesV1>;

declare const migrationRootExecutionBrand: unique symbol;
export interface MigrationRootExecutionCapabilityV1 {
  readonly rootId: string;
  readonly migrationId: string;
  readonly [migrationRootExecutionBrand]: true;
}

const executionDependencies = new WeakMap<object, BoundMigrationExecutionDependenciesV1>();
declare const migrationAttemptBrand: unique symbol;
export interface MigrationAttemptAttachmentV1 {
  readonly state: MigrationStateV1;
  readonly [migrationAttemptBrand]: true;
}
const attachedAttempts = new WeakMap<object, {
  rootId: string;
  migrationId: string;
  store: MigrationStateStoreV1;
}>();

export interface LegacySnapshotEntryV1 {
  entityType: BootstrapEntity['entityType'];
  value: unknown;
}

export interface MigrationActivationBodyV1 {
  protocol: 'watchtracker-s2-lite';
  protocolVersion: 1;
  s2SemanticProfileVersion: 1;
  requiredFeatures: [];
  activationId: string;
  legacyFingerprint: string;
}

function invalid(code: string): never {
  throw new S2ProtocolValidationError(code);
}

function cloneState(state: Readonly<MigrationStateV1>): MigrationStateV1 {
  return structuredClone(state);
}

export function createMigrationRootSafetyStateV1(rootId: string): MigrationRootSafetyStateV1 {
  return {
    stateVersion: 1,
    rootId,
    generation: 0,
    rootFatalSignals: [],
    cutoverState: createActivationCutoverStateV1(),
  };
}

export function mergeMigrationRootCutoverStateV1(
  existing: Readonly<ActivationCutoverStateV1>,
  incoming: Readonly<ActivationCutoverStateV1>,
): ActivationCutoverStateV1 {
  const discovery = createDiscoveryStateV1();
  discovery.verifiedObjects = incoming.verifiedActivationEvidence.map(value => ({
    path: value.path,
    kind: 'activation',
    exactBytesHash: value.exactBytesHash,
    exactBytesHex: '',
    contentHash: value.contentHash,
    activationId: value.activationId,
    fingerprintEvidence: value.legacyFingerprint === null
      ? { state: 'Null' as const }
      : { state: 'Value' as const, value: value.legacyFingerprint },
  }));
  const merged = evaluateActivationCutoverV1(existing, discovery);
  merged.rootFatalSignals = [...new Set([
    ...existing.rootFatalSignals.map(value => value.code),
    ...incoming.rootFatalSignals.map(value => value.code),
    ...merged.rootFatalSignals.map(value => value.code),
  ])].sort().map(code => ({ code }));
  return merged;
}

function uuidFromHash(hash: string): string {
  const bytes = hash.slice(0, 32).split('');
  bytes[12] = '4';
  bytes[16] = ['8', '9', 'a', 'b'][Number.parseInt(bytes[16]!, 16) & 3]!;
  const compact = bytes.join('');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function validateMigrationActivationBodyV1(bytes: Uint8Array): MigrationActivationBodyV1 {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    const fields = Object.keys(value).sort();
    const expected = [
      'activationId', 'legacyFingerprint', 'protocol', 'protocolVersion', 'requiredFeatures',
      's2SemanticProfileVersion',
    ].sort();
    if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])
      || value.protocol !== 'watchtracker-s2-lite' || value.protocolVersion !== 1
      || value.s2SemanticProfileVersion !== 1 || !Array.isArray(value.requiredFeatures)
      || value.requiredFeatures.length !== 0 || typeof value.legacyFingerprint !== 'string') invalid('invalid');
    validateCanonicalUuidV4(value.activationId);
    if (!/^[0-9a-f]{64}$/.test(value.legacyFingerprint)) invalid('invalid');
    return value as unknown as MigrationActivationBodyV1;
  } catch {
    return invalid('INVALID_ACTIVATION_BODY');
  }
}

async function deterministicUuidV4(migrationId: string, domain: string, index: number): Promise<string> {
  return uuidFromHash(await sha256Hex(new TextEncoder().encode(`${migrationId}\0${domain}\0${index}`)));
}

export function createMigrationStateV1(input: {
  migrationId: string;
  rootId: string;
  writerId: string;
  createdAt: string;
  sourceType?: 'legacy-bootstrap' | 'new-root-bootstrap';
}): MigrationStateV1 {
  validateCanonicalUuidV4(input.migrationId);
  validateCanonicalUuidV4(input.writerId);
  validateCanonicalTimestamp(input.createdAt);
  if (input.rootId.length === 0) invalid('invalid_migration_root');
  return {
    stateVersion: 1,
    generation: 0,
    migrationId: input.migrationId,
    rootId: input.rootId,
    sourceType: input.sourceType ?? 'legacy-bootstrap',
    writerId: input.writerId,
    createdAt: input.createdAt,
    status: 'NOT_STARTED',
    snapshot: null,
    stageA: [],
    stageB: [],
    activationIntent: null,
    activationIntentRootId: null,
    activationReceipt: null,
    activationReceiptRootId: null,
    rootFatalSignals: [],
    preservationHandoff: null,
  };
}

export async function captureLegacySnapshotV1(
  input: readonly LegacySnapshotEntryV1[],
  adapter: LegacySemanticAdapterV1,
): Promise<CapturedLegacySnapshotV1> {
  const ownedInput = structuredClone(input);
  try {
    const entities: BootstrapEntity[] = [];
    for (const entry of ownedInput) {
      entities.push(await adapter.adaptLiveEntity(entry.entityType, entry.value));
    }
    const plan = await buildBootstrapPlanV1(entities);
    const canonicalEntities = [...plan.stageAOrderedMutations, ...plan.stageBOrderedMutations];
    const legacyFingerprint = await sha256Hex(canonicalJcsBytes({
      domain: 'watchtracker-s2-lite-legacy-snapshot-v1',
      canonicalEntities: canonicalEntities as unknown as JsonValue,
    }));
    return { snapshotVersion: 1, legacyFingerprint, canonicalEntities: structuredClone(canonicalEntities) };
  } catch {
    return invalid('LEGACY_SNAPSHOT_INVALID');
  }
}

export function retainCapturedSnapshotV1(
  prior: Readonly<MigrationStateV1>,
  snapshot: Readonly<CapturedLegacySnapshotV1>,
): MigrationStateV1 {
  if (prior.status !== 'NOT_STARTED' || prior.snapshot !== null) invalid('invalid_migration_transition');
  const state = cloneState(prior);
  state.snapshot = structuredClone(snapshot);
  state.status = 'LEGACY_SNAPSHOT_CAPTURED';
  return state;
}

function commitWire(
  state: MigrationStateV1,
  chunk: readonly BootstrapEntity[],
  writerSeq: number,
  commitId: string,
  previous: CommitRef | null,
  mutationIds: readonly string[],
): JsonValue {
  return {
    protocol: 'watchtracker-s2-lite',
    protocolVersion: 1,
    s2SemanticProfileVersion: 1,
    requiredFeatures: [],
    writerId: state.writerId,
    writerSeq: String(writerSeq),
    commitId,
    previousWriterCommit: previous as unknown as JsonValue,
    basisClock: previous === null ? [] : [previous as unknown as JsonValue],
    commitKind: 'bootstrap',
    createdAt: state.createdAt,
    source: { type: state.sourceType },
    mutations: chunk.map((entity, index) => ({
      localMutationId: mutationIds[index],
      entityType: entity.entityType,
      entityKey: entity.entityKey as unknown as JsonValue,
      operation: 'upsert',
      value: entity.value,
      baseFrontier: [],
      changedFields: [...BUSINESS_FIELD_ORDER[entity.entityType]],
    })),
  };
}

export async function planCapturedMigrationV1(
  prior: Readonly<MigrationStateV1>,
): Promise<MigrationStateV1> {
  if (prior.status !== 'LEGACY_SNAPSHOT_CAPTURED' || prior.snapshot === null) {
    return invalid('invalid_migration_transition');
  }
  const state = cloneState(prior);
  const snapshot = state.snapshot!;
  const plan = await buildBootstrapPlanV1(snapshot.canonicalEntities);
  let previous: CommitRef | null = null;
  let writerSeq = 1;
  const buildTasks = async (stage: 'A' | 'B', chunks: readonly BootstrapEntity[][]) => {
    const tasks: MigrationCommitTaskV1[] = [];
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex]!;
      const commitId = await deterministicUuidV4(state.migrationId, 'commit', writerSeq);
      const mutationIds = await Promise.all(chunk.map((_, index) => (
        deterministicUuidV4(state.migrationId, `mutation-${writerSeq}`, index)
      )));
      const intent = await prepareCommitIntentV1(
        canonicalJcsBytes(commitWire(state, chunk, writerSeq, commitId, previous, mutationIds)),
        state.createdAt,
      );
      tasks.push({ stage, chunkIndex, rootId: state.rootId, intent, receipt: null, receiptRootId: null });
      previous = { ...intent.commitRef };
      writerSeq += 1;
    }
    return tasks;
  };
  state.stageA = await buildTasks('A', plan.stageAChunks);
  state.stageB = await buildTasks('B', plan.stageBChunks);
  const activationId = await deterministicUuidV4(state.migrationId, 'activation', 0);
  const activationBytes = canonicalJcsBytes({
    protocol: 'watchtracker-s2-lite',
    protocolVersion: 1,
    s2SemanticProfileVersion: 1,
    requiredFeatures: [],
    activationId,
    legacyFingerprint: snapshot.legacyFingerprint,
  });
  validateMigrationActivationBodyV1(activationBytes);
  state.activationIntent = await prepareActivationIntentV1(activationId, activationBytes, state.createdAt);
  state.activationIntentRootId = state.rootId;
  state.status = 'BOOTSTRAP_PLANNED';
  return state;
}

function allReceipted(tasks: readonly MigrationCommitTaskV1[]): boolean {
  return tasks.every(task => task.receipt !== null);
}

async function validateTaskReceipts(tasks: readonly MigrationCommitTaskV1[]): Promise<void> {
  for (const task of tasks) {
    await validatePreparedIntentV1(task.intent);
    if (task.receipt !== null) await validatePublishedReceiptV1(task.receipt, task.intent);
  }
}

export async function reconcileMigrationStateV1(input: Readonly<MigrationStateV1>): Promise<MigrationStateV1> {
  const state = cloneState(input);
  if (state.stateVersion !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 0
    || typeof state.rootId !== 'string' || state.rootId.length === 0) {
    invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
  }
  try {
    validateCanonicalUuidV4(state.migrationId);
    validateCanonicalUuidV4(state.writerId);
    validateCanonicalTimestamp(state.createdAt);
  } catch {
    return invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
  }
  if (state.snapshot !== null) {
    try {
      const plan = await buildBootstrapPlanV1(state.snapshot.canonicalEntities);
      const canonicalEntities = [...plan.stageAOrderedMutations, ...plan.stageBOrderedMutations];
      const fingerprint = await sha256Hex(canonicalJcsBytes({
        domain: 'watchtracker-s2-lite-legacy-snapshot-v1',
        canonicalEntities: canonicalEntities as unknown as JsonValue,
      }));
      if (fingerprint !== state.snapshot.legacyFingerprint) invalid('invalid');
    } catch {
      return invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
    }
  }
  if (state.rootFatalSignals.length > 0 || state.status === 'ROOT_FROZEN') {
    state.status = 'ROOT_FROZEN';
    return state;
  }
  if (state.status === 'NOT_STARTED' || state.status === 'LEGACY_SNAPSHOT_CAPTURED') {
    return state;
  }
  if (state.snapshot === null || state.activationIntent === null) invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
  try {
    const expectedSeed = cloneState(state);
    expectedSeed.status = 'LEGACY_SNAPSHOT_CAPTURED';
    expectedSeed.stageA = [];
    expectedSeed.stageB = [];
    expectedSeed.activationIntent = null;
    expectedSeed.activationIntentRootId = null;
    expectedSeed.activationReceipt = null;
    expectedSeed.activationReceiptRootId = null;
    const expectedPlan = await planCapturedMigrationV1(expectedSeed);
    const actualTasks = [...state.stageA, ...state.stageB];
    const expectedTasks = [...expectedPlan.stageA, ...expectedPlan.stageB];
    if (actualTasks.length !== expectedTasks.length
      || actualTasks.some((task, index) => task.stage !== expectedTasks[index]!.stage
        || task.chunkIndex !== expectedTasks[index]!.chunkIndex
        || task.rootId !== state.rootId || task.rootId !== expectedTasks[index]!.rootId
        || task.intent.intentFingerprint !== expectedTasks[index]!.intent.intentFingerprint)
      || state.activationIntentRootId !== state.rootId
      || state.activationIntent.intentFingerprint !== expectedPlan.activationIntent!.intentFingerprint) {
      invalid('invalid');
    }
    for (const task of actualTasks) {
      if ((task.receipt === null) !== (task.receiptRootId === null)
        || (task.receipt !== null && task.receiptRootId !== state.rootId)) invalid('invalid');
    }
    await validateTaskReceipts(state.stageA);
    await validateTaskReceipts(state.stageB);
    await validatePreparedActivationIntentV1(state.activationIntent);
    const body = validateMigrationActivationBodyV1(state.activationIntent.exactBytes);
    if (body.activationId !== state.activationIntent.activationId
      || body.legacyFingerprint !== state.snapshot.legacyFingerprint) invalid('invalid');
    if (state.activationReceipt !== null) {
      if (state.activationReceiptRootId !== state.rootId) invalid('invalid');
      await validatePublishedActivationReceiptV1(state.activationReceipt, state.activationIntent);
    } else if (state.activationReceiptRootId !== null) {
      invalid('invalid');
    }
    if (!allReceipted(state.stageA)) state.status = state.status === 'BOOTSTRAP_PLANNED' ? 'BOOTSTRAP_PLANNED' : 'STAGE_A_PUBLISHING';
    else if (!allReceipted(state.stageB)) state.status = state.status === 'STAGE_A_COMPLETE' ? 'STAGE_A_COMPLETE' : 'STAGE_B_PUBLISHING';
    else if (state.activationReceipt === null) state.status = state.status === 'STAGE_B_COMPLETE' ? 'STAGE_B_COMPLETE' : 'ACTIVATION_PUBLISHING';
    else state.status = 'ACTIVATION_VERIFIED';
    return state;
  } catch {
    return invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
  }
}

export function serializeMigrationStateV1(state: Readonly<MigrationStateV1>): string {
  return JSON.stringify(state, function encodeExactBytes(key, value) {
    const original = (this as Record<string, unknown>)[key];
    if (key === 'exactBytes' && original instanceof Uint8Array) {
      return { encoding: 'hex', value: Array.from(original, byte => byte.toString(16).padStart(2, '0')).join('') };
    }
    return value;
  });
}

export async function deserializeMigrationStateV1(encoded: string): Promise<MigrationStateV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded, (key, value) => {
      if (key !== 'exactBytes') return value;
      if (value === null || typeof value !== 'object' || Array.isArray(value)
        || (value as { encoding?: unknown }).encoding !== 'hex'
        || typeof (value as { value?: unknown }).value !== 'string'
        || !/^(?:[0-9a-f]{2})*$/.test((value as { value: string }).value)) {
        return invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
      }
      return Uint8Array.from((value as { value: string }).value.match(/../g)?.map(byte => Number.parseInt(byte, 16)) ?? []);
    });
  } catch {
    return invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
  }
  return reconcileMigrationStateV1(parsed as MigrationStateV1);
}

function activationDiscovery(state: MigrationStateV1): DiscoveryStateV1 {
  const intent = state.activationIntent!;
  const discovery = createDiscoveryStateV1();
  discovery.verifiedObjects.push({
    path: intent.remotePath,
    kind: 'activation',
    exactBytesHash: intent.contentHash,
    exactBytesHex: Array.from(intent.exactBytes, byte => byte.toString(16).padStart(2, '0')).join(''),
    contentHash: intent.contentHash,
    activationId: intent.activationId,
    fingerprintEvidence: { state: 'Value', value: state.snapshot!.legacyFingerprint },
  });
  return discovery;
}

export async function startOrAttachMigrationV1(
  candidate: Readonly<MigrationStateV1>,
  store: MigrationStateStoreV1,
): Promise<MigrationAttemptAttachmentV1> {
  const owned = await reconcileMigrationStateV1(candidate);
  const existing = await store.load(owned.rootId);
  if (existing === null && (owned.status !== 'NOT_STARTED' || owned.generation !== 0)) {
    invalid('invalid_migration_start');
  }
  const attached = await reconcileMigrationStateV1(await store.claimOrLoad(cloneState(owned)));
  if (attached.rootId !== owned.rootId) invalid('MIGRATION_ROOT_BINDING_MISMATCH');
  const result = Object.freeze({ state: cloneState(attached) }) as MigrationAttemptAttachmentV1;
  attachedAttempts.set(result, { rootId: attached.rootId, migrationId: attached.migrationId, store });
  return result;
}

export function createMigrationRootExecutionCapabilityV1(
  attachment: MigrationAttemptAttachmentV1,
  dependencies: MigrationExecutionDependenciesV1,
): MigrationRootExecutionCapabilityV1 {
  const binding = attachedAttempts.get(attachment);
  if (binding === undefined || dependencies === null || typeof dependencies !== 'object'
    || dependencies.migrationStore !== binding.store) {
    invalid('MIGRATION_ROOT_BINDING_MISMATCH');
  }
  if (dependencies.remote.physicalRootId !== binding.rootId) {
    invalid('MIGRATION_ROOT_BINDING_MISMATCH');
  }
  const capability = Object.freeze({
    rootId: binding.rootId,
    migrationId: binding.migrationId,
  }) as MigrationRootExecutionCapabilityV1;
  // Capture each execution dependency by value. In particular, never retain the
  // caller-owned container: replacing dependencies.remote/store after issuance
  // must not redirect a capability.
  executionDependencies.set(capability, Object.freeze({
    remote: dependencies.remote,
    migrationStore: dependencies.migrationStore,
    intentStore: dependencies.intentStore,
    receiptStore: dependencies.receiptStore,
    activationIntentStore: dependencies.activationIntentStore,
    activationReceiptStore: dependencies.activationReceiptStore,
    verifiedAtDiagnostic: dependencies.verifiedAtDiagnostic,
  }));
  return capability;
}

const STATUS_RANK: Readonly<Record<MigrationStatusV1, number>> = Object.freeze({
  NOT_STARTED: 0,
  LEGACY_SNAPSHOT_CAPTURED: 1,
  BOOTSTRAP_PLANNED: 2,
  STAGE_A_PUBLISHING: 3,
  STAGE_A_COMPLETE: 4,
  STAGE_B_PUBLISHING: 5,
  STAGE_B_COMPLETE: 6,
  ACTIVATION_PUBLISHING: 7,
  ACTIVATION_VERIFIED: 8,
  MIGRATION_COMPLETE: 9,
  ROOT_FROZEN: 10,
});

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function taskAttemptIdentity(task: Readonly<MigrationCommitTaskV1>) {
  return {
    stage: task.stage,
    chunkIndex: task.chunkIndex,
    rootId: task.rootId,
    intentFingerprint: task.intent.intentFingerprint,
  };
}

function validateAttemptTransition(prior: MigrationStateV1, requested: MigrationStateV1): void {
  if (prior.rootId !== requested.rootId || prior.migrationId !== requested.migrationId) {
    invalid('MIGRATION_ROOT_BINDING_MISMATCH');
  }
  if (prior.writerId !== requested.writerId || prior.sourceType !== requested.sourceType
    || prior.createdAt !== requested.createdAt) invalid('LOCAL_MIGRATION_STATE_CORRUPTION');

  if (prior.snapshot !== null) {
    if (requested.snapshot === null
      || prior.snapshot.legacyFingerprint !== requested.snapshot.legacyFingerprint
      || !sameJson(
        Array.from(canonicalJcsBytes(prior.snapshot.canonicalEntities as unknown as JsonValue)),
        Array.from(canonicalJcsBytes(requested.snapshot.canonicalEntities as unknown as JsonValue)),
      )) invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
  }

  if (STATUS_RANK[prior.status] >= STATUS_RANK.BOOTSTRAP_PLANNED) {
    if (prior.snapshot?.legacyFingerprint !== requested.snapshot?.legacyFingerprint
      || !sameJson(prior.stageA.map(taskAttemptIdentity), requested.stageA.map(taskAttemptIdentity))
      || !sameJson(prior.stageB.map(taskAttemptIdentity), requested.stageB.map(taskAttemptIdentity))
      || prior.activationIntent?.intentFingerprint !== requested.activationIntent?.intentFingerprint
      || prior.activationIntentRootId !== requested.activationIntentRootId
      || !sameJson(prior.preservationHandoff, requested.preservationHandoff)) {
      invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
    }
  }
  const priorTasks = [...prior.stageA, ...prior.stageB];
  const requestedTasks = [...requested.stageA, ...requested.stageB];
  for (let index = 0; index < priorTasks.length; index += 1) {
    const oldTask = priorTasks[index]!;
    const newTask = requestedTasks[index]!;
    if (oldTask.receipt !== null && (!sameJson(oldTask.receipt, newTask.receipt)
      || oldTask.receiptRootId !== newTask.receiptRootId)) invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
  }
  if (prior.activationReceipt !== null && (!sameJson(prior.activationReceipt, requested.activationReceipt)
    || prior.activationReceiptRootId !== requested.activationReceiptRootId)) {
    invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
  }
  if (prior.status !== 'ROOT_FROZEN' && requested.status !== 'ROOT_FROZEN'
    && STATUS_RANK[requested.status] < STATUS_RANK[prior.status]) {
    invalid('LOCAL_MIGRATION_STATE_CORRUPTION');
  }
}

async function persistTransition(
  prior: MigrationStateV1,
  requested: MigrationStateV1,
  store: MigrationStateStoreV1,
): Promise<MigrationStateV1> {
  validateAttemptTransition(prior, requested);
  const next = cloneState(requested);
  const fatalCodes = new Set([
    ...prior.rootFatalSignals.map(value => value.code),
    ...next.rootFatalSignals.map(value => value.code),
  ]);
  next.rootFatalSignals = [...fatalCodes].sort().map(code => ({ code }));
  if (next.rootFatalSignals.length > 0 || prior.status === 'ROOT_FROZEN') next.status = 'ROOT_FROZEN';
  next.generation = prior.generation + 1;
  if (await store.compareAndSwap(prior.rootId, prior.migrationId, prior.generation, cloneState(next))) {
    return next;
  }
  const current = await store.load(prior.rootId);
  if (current === null || current.migrationId !== prior.migrationId) {
    return invalid('MIGRATION_ROOT_BINDING_MISMATCH');
  }
  return reconcileMigrationStateV1(current);
}

export async function recoverMigrationActivationCutoverV1(
  stateInput: Readonly<MigrationStateV1>,
  store: ActivationCutoverStateStoreV1,
) {
  const state = await reconcileMigrationStateV1(stateInput);
  if (state.activationReceipt !== null) {
    return recoverActivationCutoverFromStoreV1(activationDiscovery(state), store);
  }
  if (state.status === 'ACTIVATION_PUBLISHING' || state.status === 'ACTIVATION_VERIFIED'
    || state.status === 'MIGRATION_COMPLETE') {
    return beginActivationCutoverRecoveryV1();
  }
  return recoverActivationCutoverFromStoreV1(createDiscoveryStateV1(), store);
}

export async function executeMigrationStepV1(
  input: Readonly<MigrationStateV1>,
  capability: MigrationRootExecutionCapabilityV1,
): Promise<MigrationStateV1> {
  const dependencies = executionDependencies.get(capability);
  if (dependencies === undefined || capability.rootId !== input.rootId
    || capability.migrationId !== input.migrationId
    || dependencies.remote.physicalRootId !== capability.rootId) invalid('MIGRATION_ROOT_BINDING_MISMATCH');
  let durable = await dependencies.migrationStore.load(capability.rootId);
  if (durable === null || durable.migrationId !== capability.migrationId) {
    return invalid('MIGRATION_ROOT_BINDING_MISMATCH');
  }
  durable = await reconcileMigrationStateV1(durable);
  if (durable.status === 'ROOT_FROZEN') return durable;
  const proposed = await reconcileMigrationStateV1(input);
  if (proposed.generation === durable.generation) {
    validateAttemptTransition(durable, proposed);
    if (proposed.status !== durable.status) {
      durable = await persistTransition(durable, proposed, dependencies.migrationStore);
    }
  }
  let state = durable;
  if (state.status === 'NOT_STARTED' || state.status === 'LEGACY_SNAPSHOT_CAPTURED') {
    return invalid('migration_not_planned');
  }
  const persist = async () => {
    state = await persistTransition(durable!, state, dependencies.migrationStore);
    durable = state;
    return state;
  };
  if (state.status === 'BOOTSTRAP_PLANNED') {
    state.status = state.stageA.length === 0 ? 'STAGE_A_COMPLETE' : 'STAGE_A_PUBLISHING';
    await persist();
    if (state.status === 'STAGE_A_COMPLETE') return state;
  }
  if (state.status === 'STAGE_A_COMPLETE') {
    state.status = state.stageB.length === 0 ? 'STAGE_B_COMPLETE' : 'STAGE_B_PUBLISHING';
    await persist();
    return state;
  }
  if (state.status === 'STAGE_B_COMPLETE') {
    state.status = 'ACTIVATION_PUBLISHING';
    await persist();
    return state;
  }

  const tasks = state.status === 'STAGE_A_PUBLISHING' ? state.stageA
    : state.status === 'STAGE_B_PUBLISHING' ? state.stageB : null;
  if (tasks !== null) {
    if (state.status === 'STAGE_B_PUBLISHING' && !allReceipted(state.stageA)) {
      return invalid('stage_b_before_stage_a');
    }
    const task = tasks.find(value => value.receipt === null);
    if (task === undefined) {
      state.status = state.status === 'STAGE_A_PUBLISHING' ? 'STAGE_A_COMPLETE' : 'STAGE_B_COMPLETE';
      await persist();
      return state;
    }
    let result = await restartDurablePublishV1(task.intent, task.receipt, dependencies.remote, dependencies.verifiedAtDiagnostic);
    if (result.outcome === 'RetryPublishExact') {
      const publishCapability = await persistPreparedIntentBeforePublishV1(task.intent, dependencies.intentStore);
      const guarded = await dependencies.migrationStore.runPublishExclusive(
        { rootId: state.rootId, migrationId: state.migrationId, expectedGeneration: state.generation },
        () => publishAdmittedPersistedIntentV1(
          publishCapability, dependencies.remote, dependencies.verifiedAtDiagnostic,
        ),
      );
      if (!guarded.executed) return reconcileMigrationStateV1(guarded.current);
      result = guarded.value;
    }
    if (result.outcome === 'CorruptionMismatch') {
      const frozen = await dependencies.migrationStore.persistRootFatal(
        state.rootId, result.safetyEvent.freezeClass,
      );
      if (frozen !== null) return reconcileMigrationStateV1(frozen);
      return invalid('MIGRATION_ROOT_BINDING_MISMATCH');
    } else if (result.outcome === 'AlreadyPublishedExact') {
      await persistVerifiedReceiptV1(result, task.intent, dependencies.receiptStore);
      task.receipt = structuredClone(result.receipt);
      task.receiptRootId = state.rootId;
      if (allReceipted(tasks)) {
        state.status = state.status === 'STAGE_A_PUBLISHING' ? 'STAGE_A_COMPLETE' : 'STAGE_B_COMPLETE';
      }
    }
    await persist();
    return state;
  }

  if (state.status === 'ACTIVATION_PUBLISHING') {
    let result = await restartDurableActivationPublishV1(
      state.activationIntent!, state.activationReceipt, dependencies.remote, dependencies.verifiedAtDiagnostic,
    );
    if (result.outcome === 'RetryPublishExact') {
      const publishCapability = await persistPreparedActivationIntentBeforePublishV1(
        state.activationIntent!, dependencies.activationIntentStore,
      );
      const guarded = await dependencies.migrationStore.runPublishExclusive(
        { rootId: state.rootId, migrationId: state.migrationId, expectedGeneration: state.generation },
        () => publishAdmittedPersistedActivationIntentV1(
          publishCapability, dependencies.remote, dependencies.verifiedAtDiagnostic,
        ),
      );
      if (!guarded.executed) return reconcileMigrationStateV1(guarded.current);
      result = guarded.value;
    }
    if (result.outcome === 'CorruptionMismatch') {
      const frozen = await dependencies.migrationStore.persistRootFatal(
        state.rootId, result.safetyEvent.freezeClass,
      );
      if (frozen !== null) return reconcileMigrationStateV1(frozen);
      return invalid('MIGRATION_ROOT_BINDING_MISMATCH');
    } else if (result.outcome === 'AlreadyPublishedExact') {
      await persistVerifiedActivationReceiptV1(
        result, state.activationIntent!, dependencies.activationReceiptStore,
      );
      state.activationReceipt = structuredClone(result.receipt);
      state.activationReceiptRootId = state.rootId;
      state.status = 'ACTIVATION_VERIFIED';
    }
    await persist();
    return state;
  }

  if (state.status === 'ACTIVATION_VERIFIED' || state.status === 'MIGRATION_COMPLETE') {
    const authorityCutoverStore: ActivationCutoverStateStoreV1 = {
      load: () => dependencies.migrationStore.loadCutoverState(state.rootId),
      persist: value => dependencies.migrationStore.persistCutoverState(state.rootId, value),
    };
    const recovery = await recoverMigrationActivationCutoverV1(state, authorityCutoverStore);
    const cutover = getActivationCutoverDiagnosticStateV1(recovery);
    if (cutover === null || !cutover.remoteS2Activated) return invalid('activation_cutover_not_ready');
    await persistActivationCutoverStateV1(cutover, authorityCutoverStore);
    state.status = 'MIGRATION_COMPLETE';
    await persist();
    return state;
  }
  return state;
}

export function freezeOldRootForNewRootHandoffV1(
  state: Readonly<MigrationStateV1>,
  fatalCodes: readonly string[],
): MigrationStateV1 {
  if (state.snapshot === null || fatalCodes.length === 0) invalid('invalid_frozen_root_handoff');
  const frozen = cloneState(state);
  frozen.status = 'ROOT_FROZEN';
  frozen.rootFatalSignals = [...new Set([
    ...frozen.rootFatalSignals.map(value => value.code),
    ...fatalCodes,
  ])].sort().map(code => ({ code }));
  return frozen;
}

export function createNewRootMigrationHandoffV1(
  frozen: Readonly<MigrationStateV1>,
  input: { migrationId: string; newRootId: string; writerId: string; createdAt: string },
): MigrationStateV1 {
  if (frozen.status !== 'ROOT_FROZEN' || frozen.snapshot === null
    || input.newRootId === frozen.rootId) invalid('invalid_frozen_root_handoff');
  const next = createMigrationStateV1({
    migrationId: input.migrationId,
    rootId: input.newRootId,
    writerId: input.writerId,
    createdAt: input.createdAt,
    sourceType: 'new-root-bootstrap',
  });
  next.snapshot = structuredClone(frozen.snapshot);
  next.status = 'LEGACY_SNAPSHOT_CAPTURED';
  next.preservationHandoff = {
    oldRootId: frozen.rootId,
    fatalCodes: frozen.rootFatalSignals.map(value => value.code),
  };
  return next;
}

export function migrationProjectionV1(state: Readonly<MigrationStateV1>): JsonValue {
  return {
    rootId: state.rootId,
    generation: state.generation,
    status: state.status,
    legacyFingerprint: state.snapshot?.legacyFingerprint ?? null,
    stageA: state.stageA.map(task => ({
      writerSeq: task.intent.commitRef.writerSeq,
      commitId: task.intent.commitRef.commitId,
      contentHash: task.intent.contentHash,
      intentFingerprint: task.intent.intentFingerprint,
      mutationCount: JSON.parse(new TextDecoder().decode(task.intent.exactBytes)).mutations.length,
      receipted: task.receipt !== null,
    })),
    stageB: state.stageB.map(task => ({
      writerSeq: task.intent.commitRef.writerSeq,
      commitId: task.intent.commitRef.commitId,
      contentHash: task.intent.contentHash,
      intentFingerprint: task.intent.intentFingerprint,
      mutationCount: JSON.parse(new TextDecoder().decode(task.intent.exactBytes)).mutations.length,
      receipted: task.receipt !== null,
    })),
    activationId: state.activationIntent?.activationId ?? null,
    activationContentHash: state.activationIntent?.contentHash ?? null,
    activationIntentFingerprint: state.activationIntent?.intentFingerprint ?? null,
    activationVerified: state.activationReceipt !== null,
    fatalCodes: state.rootFatalSignals.map(value => value.code),
    sourceType: state.sourceType,
    preservationHandoff: state.preservationHandoff as unknown as JsonValue,
  };
}
