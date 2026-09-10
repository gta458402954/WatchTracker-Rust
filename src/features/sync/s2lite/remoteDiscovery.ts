import {
  compareCommitRefV1,
  parseWriterSeq,
  sha256Hex,
  validateCanonicalUuid,
  validateCanonicalUuidV4,
  validateContentHash,
} from './canonical.ts';
import { decodeFrozenWireCommitV1 } from './causalReducer.ts';
import {
  buildCommitRemotePathV1,
  SEGMENT_NAME_WIDTH_V1,
} from './immutablePublish.ts';
import type { CommitRef, CommitV1 } from './types.ts';

const ACTIVATION_RE = /^activations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})--([0-9a-f]{64})\.json$/;
const COMMIT_RE = /^writers\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/segments\/([0-9a-f]{14})\/([0-9]{20})--([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})--([0-9a-f]{64})\.json$/;
const WRITER_RE = /^writers\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/;
const SEGMENT_RE = /^writers\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/segments\/([0-9a-f]{14})\/?$/;
const MAX_RETAINED_SEGMENTS_V1 = 4096;
const MAX_TRACKED_GAP_SEQUENCE_V1 = 65536n;

export interface ActivationCandidateV1 {
  kind: 'activation';
  path: string;
  activationId: string;
  contentHash: string;
}

export interface WriterCommitCandidateV1 {
  kind: 'commit';
  path: string;
  writerId: string;
  segmentName: string;
  writerSeq: string;
  commitId: string;
  contentHash: string;
}

export type ObservedCandidateV1 = ActivationCandidateV1 | WriterCommitCandidateV1;

export interface VerifiedRemoteObjectV1 {
  path: string;
  kind: 'activation' | 'commit';
  exactBytesHash: string;
  exactBytesHex: string;
  contentHash: string;
  commitRef?: CommitRef;
  activationId?: string;
  fingerprintEvidence: VerifiedFingerprintEvidenceV1;
}

export type VerifiedFingerprintEvidenceV1 =
  | { state: 'Missing' }
  | { state: 'Null' }
  | { state: 'Value'; value: string };

export interface RootFatalSignalV1 {
  code: string;
  path: string;
  writerId?: string;
  writerSeq?: string;
  safeWriterFrontier?: string;
}

export interface HistoricalAuditCursorV1 {
  lastWriterId: string | null;
  lastSegmentByWriter: Record<string, string | null>;
}

export type ExactWorkClassV1 = 'dependency' | 'candidate' | 'reverify';

export interface ExactWorkSchedulerV1 {
  nextClass: ExactWorkClassV1;
  afterByClass: Record<ExactWorkClassV1, string | null>;
}

export interface DiscoveryStateV1 {
  stateVersion: 1;
  observedActivations: string[];
  observedWriters: string[];
  observedSegments: string[];
  observedCandidates: ObservedCandidateV1[];
  verifiedObjects: VerifiedRemoteObjectV1[];
  knownGaps: string[];
  targetedQueue: CommitRef[];
  historicalClosedSegments: string[];
  historicalAuditCursor: HistoricalAuditCursorV1;
  gapSegmentCursorByWriter: Record<string, string | null>;
  reverificationQueue: string[];
  terminalCandidatePaths: string[];
  exactWorkScheduler: ExactWorkSchedulerV1;
  lastRoundScheduledLists: string[];
  lastRoundScheduledGets: string[];
  rootFatalSignals: RootFatalSignalV1[];
  lastRoundIndeterminate: boolean;
}

export interface DiscoveryBudgetsV1 {
  maxExactFetchesPerSync: number;
  maxSegmentsPerWriterPerSync: number;
  maxDependencyTargetsPerSync: number;
  maxListingEntriesPerDirectory: number;
}

export const DEFAULT_DISCOVERY_BUDGETS_V1: DiscoveryBudgetsV1 = {
  maxExactFetchesPerSync: 64,
  maxSegmentsPerWriterPerSync: 5,
  maxDependencyTargetsPerSync: 64,
  maxListingEntriesPerDirectory: 4096,
};

export type DirectoryListResultV1 =
  | { state: 'Entries'; entries: string[] }
  | { state: 'Indeterminate' | 'AuthOrCapabilityFailure' };

export type DiscoveryExactGetResultV1 =
  | { state: 'DefinitelyPresent'; bytes: Uint8Array }
  | { state: 'DefinitelyAbsent' }
  | { state: 'Indeterminate' }
  | { state: 'AuthOrCapabilityFailure' };

export interface DiscoveryRemoteV1 {
  listDirectory(path: string): Promise<DirectoryListResultV1>;
  getExact(path: string): Promise<DiscoveryExactGetResultV1>;
}

export class DiscoveryOperationalFailureV1 extends Error {
  readonly category: 'Indeterminate' | 'AuthOrCapabilityFailure';

  constructor(category: 'Indeterminate' | 'AuthOrCapabilityFailure') {
    super(category);
    this.name = 'DiscoveryOperationalFailureV1';
    this.category = category;
  }
}

export interface ActivationVerificationV1 {
  activationId: string;
  legacyFingerprint: string | null;
  semanticProfileSupported: boolean;
  requiredFeaturesSupported: boolean;
}

export type ActivationBodyValidatorV1 = (bytes: Uint8Array) => Promise<ActivationVerificationV1>;

export class ActivationProtocolValidationFailureV1 extends Error {
  constructor() {
    super('activation_protocol_validation_failure');
    this.name = 'ActivationProtocolValidationFailureV1';
  }
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g)?.map(pair => Number.parseInt(pair, 16)) ?? []);
}

function refKey(ref: CommitRef): string {
  return `${ref.writerId}/${ref.writerSeq}/${ref.commitId}/${ref.contentHash}`;
}

function segmentKey(writerId: string, segmentName: string): string {
  return `${writerId}/${segmentName}`;
}

function copyRef(ref: CommitRef): CommitRef {
  return { ...ref };
}

function cloneState(state: DiscoveryStateV1): DiscoveryStateV1 {
  return structuredClone(state);
}

function pushUnique<T>(values: T[], value: T, key: (item: T) => string): void {
  const wanted = key(value);
  if (!values.some(item => key(item) === wanted)) values.push(value);
}

function pushFatal(state: DiscoveryStateV1, signal: RootFatalSignalV1): void {
  pushUnique(state.rootFatalSignals, signal, item => JSON.stringify(item));
  state.rootFatalSignals.sort((a, b) => asciiCompare(JSON.stringify(a), JSON.stringify(b)));
}

function normalizeState(state: DiscoveryStateV1): void {
  state.exactWorkScheduler ??= {
    nextClass: 'dependency',
    afterByClass: { dependency: null, candidate: null, reverify: null },
  };
  state.lastRoundScheduledLists ??= [];
  state.lastRoundScheduledGets ??= [];
  state.observedActivations = [...new Set(state.observedActivations)].sort(asciiCompare);
  state.observedWriters = [...new Set(state.observedWriters)].sort(asciiCompare);
  state.observedSegments = [...new Set(state.observedSegments)].sort(asciiCompare);
  state.historicalClosedSegments = [...new Set(state.historicalClosedSegments)].sort(asciiCompare);
  state.knownGaps = [...new Set(state.knownGaps)].sort(asciiCompare);
  state.observedCandidates.sort((a, b) => asciiCompare(a.path, b.path));
  state.verifiedObjects.sort((a, b) => asciiCompare(a.path, b.path));
  state.targetedQueue.sort(compareCommitRefV1);
  state.reverificationQueue = [...new Set(state.reverificationQueue ?? [])].sort(asciiCompare);
  state.terminalCandidatePaths = [...new Set(state.terminalCandidatePaths ?? [])].sort(asciiCompare);
}

export function createDiscoveryStateV1(): DiscoveryStateV1 {
  return {
    stateVersion: 1,
    observedActivations: [],
    observedWriters: [],
    observedSegments: [],
    observedCandidates: [],
    verifiedObjects: [],
    knownGaps: [],
    targetedQueue: [],
    historicalClosedSegments: [],
    historicalAuditCursor: { lastWriterId: null, lastSegmentByWriter: {} },
    gapSegmentCursorByWriter: {},
    reverificationQueue: [],
    terminalCandidatePaths: [],
    exactWorkScheduler: {
      nextClass: 'dependency',
      afterByClass: { dependency: null, candidate: null, reverify: null },
    },
    lastRoundScheduledLists: [],
    lastRoundScheduledGets: [],
    rootFatalSignals: [],
    lastRoundIndeterminate: false,
  };
}

export function parseActivationCandidatePathV1(path: string): ActivationCandidateV1 | null {
  if (path.includes('..') || path.includes('\\') || path.startsWith('/')) return null;
  const match = ACTIVATION_RE.exec(path);
  if (match === null) return null;
  try {
    validateCanonicalUuid(match[1]);
    validateContentHash(match[2]);
  } catch {
    return null;
  }
  return { kind: 'activation', path, activationId: match[1]!, contentHash: match[2]! };
}

export function parseWriterCandidatePathV1(path: string): WriterCommitCandidateV1 | null {
  if (path.includes('..') || path.includes('\\') || path.startsWith('/')) return null;
  const match = COMMIT_RE.exec(path);
  if (match === null) return null;
  const [, writerId, segmentName, seq20, commitId, contentHash] = match;
  try {
    validateCanonicalUuidV4(writerId);
    validateCanonicalUuidV4(commitId);
    validateContentHash(contentHash);
    const writerSeq = BigInt(seq20!).toString(10) as CommitRef['writerSeq'];
    if (writerSeq === '0') return null;
    const canonical = buildCommitRemotePathV1({ writerId: writerId!, writerSeq, commitId: commitId!, contentHash: contentHash! });
    if (canonical !== path) return null;
    return { kind: 'commit', path, writerId: writerId!, segmentName: segmentName!, writerSeq, commitId: commitId!, contentHash: contentHash! };
  } catch {
    return null;
  }
}

export type CandidatePathClassificationV1 = 'Candidate' | 'CanonicalIdentityMismatch' | 'UnrelatedJunk';

const UUID_SHAPE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CANONICAL_LOOKING_COMMIT_RE = new RegExp(`^writers/${UUID_SHAPE}/segments/[0-9a-f]{14}/[0-9]{20}--${UUID_SHAPE}--[0-9a-f]{64}\\.json$`);
const CANONICAL_LOOKING_ACTIVATION_RE = new RegExp(`^activations/${UUID_SHAPE}--[0-9a-f]{64}\\.json$`);

export function classifyCandidatePathV1(path: string): CandidatePathClassificationV1 {
  if (parseWriterCandidatePathV1(path) !== null || parseActivationCandidatePathV1(path) !== null) return 'Candidate';
  return CANONICAL_LOOKING_COMMIT_RE.test(path) || CANONICAL_LOOKING_ACTIVATION_RE.test(path)
    ? 'CanonicalIdentityMismatch'
    : 'UnrelatedJunk';
}

export function observeWriterListingV1(state: DiscoveryStateV1, entries: readonly string[]): void {
  for (const entry of entries) {
    const normalized = entry.includes('/') ? entry : `writers/${entry}`;
    const match = WRITER_RE.exec(normalized);
    if (match !== null) pushUnique(state.observedWriters, match[1]!, value => value);
  }
  normalizeState(state);
}

export function observeSegmentListingV1(
  state: DiscoveryStateV1,
  writerId: string,
  entries: readonly string[],
): void {
  for (const entry of entries) {
    const normalized = entry.includes('/') ? entry : `writers/${writerId}/segments/${entry}`;
    const match = SEGMENT_RE.exec(normalized);
    if (match !== null && match[1] === writerId) {
      pushUnique(state.observedSegments, segmentKey(writerId, match[2]!), value => value);
    }
  }
  updateHistoricalSegmentsV1(state);
  normalizeState(state);
}

export function observeCandidateListingV1(state: DiscoveryStateV1, entries: readonly string[]): void {
  for (const path of entries) {
    const candidate = parseWriterCandidatePathV1(path) ?? parseActivationCandidatePathV1(path);
    if (candidate === null) {
      if (classifyCandidatePathV1(path) === 'CanonicalIdentityMismatch') pushFatal(state, { code: 'REMOTE_S2_PATH_IDENTITY_MISMATCH', path });
      continue;
    }
    pushUnique(state.observedCandidates, candidate, item => item.path);
    if (candidate.kind === 'activation') {
      pushUnique(state.observedActivations, candidate.path, value => value);
    } else {
      pushUnique(state.observedWriters, candidate.writerId, value => value);
      pushUnique(state.observedSegments, segmentKey(candidate.writerId, candidate.segmentName), value => value);
    }
  }
  updateHistoricalSegmentsV1(state);
  normalizeState(state);
}

function updateHistoricalSegmentsV1(state: DiscoveryStateV1): void {
  for (const writerId of state.observedWriters) {
    const indices = state.observedSegments
      .filter(key => key.startsWith(`${writerId}/`))
      .map(key => BigInt(`0x${key.slice(writerId.length + 1)}`));
    for (const candidate of state.observedCandidates) {
      if (candidate.kind === 'commit' && candidate.writerId === writerId) {
        indices.push(BigInt(`0x${candidate.segmentName}`));
      }
    }
    if (indices.length === 0) continue;
    const highest = indices.reduce((left, right) => left > right ? left : right);
    if (highest > BigInt(MAX_RETAINED_SEGMENTS_V1)) {
      pushFatal(state, { code: 'DISCOVERY_PROTOCOL_LIMIT_EXCEEDED', path: `writers/${writerId}/segments/` });
      continue;
    }
    for (let index = 0n; index < highest; index += 1n) {
      const name = index.toString(16).padStart(SEGMENT_NAME_WIDTH_V1, '0');
      pushUnique(state.historicalClosedSegments, segmentKey(writerId, name), value => value);
    }
  }
}

export function chooseHistoricalAuditTargetV1(state: DiscoveryStateV1): string | null {
  const byWriter = new Map<string, string[]>();
  for (const key of state.historicalClosedSegments) {
    const split = key.lastIndexOf('/');
    const writer = key.slice(0, split);
    const segment = key.slice(split + 1);
    const values = byWriter.get(writer) ?? [];
    values.push(segment);
    byWriter.set(writer, values);
  }
  const writers = [...byWriter.keys()].sort(asciiCompare);
  if (writers.length === 0) return null;
  const previousWriter = state.historicalAuditCursor.lastWriterId;
  let writerIndex = previousWriter === null ? 0 : writers.findIndex(writer => writer > previousWriter);
  if (writerIndex < 0) writerIndex = 0;
  const writerId = writers[writerIndex]!;
  const segments = byWriter.get(writerId)!.sort(asciiCompare);
  const previousSegment = state.historicalAuditCursor.lastSegmentByWriter[writerId] ?? null;
  let segmentIndex = previousSegment === null ? 0 : segments.findIndex(segment => segment > previousSegment);
  if (segmentIndex < 0) segmentIndex = 0;
  const segment = segments[segmentIndex]!;
  state.historicalAuditCursor.lastWriterId = writerId;
  state.historicalAuditCursor.lastSegmentByWriter[writerId] = segment;
  return segmentKey(writerId, segment);
}

function addTarget(state: DiscoveryStateV1, ref: CommitRef): void {
  if (state.verifiedObjects.some(value => value.commitRef !== undefined && refKey(value.commitRef) === refKey(ref))) return;
  pushUnique(state.targetedQueue, copyRef(ref), refKey);
}

function recomputeGaps(state: DiscoveryStateV1, writerId: string): void {
  const seqs = state.verifiedObjects
    .filter(value => value.commitRef?.writerId === writerId)
    .map(value => parseWriterSeq(value.commitRef!.writerSeq));
  if (seqs.length === 0) return;
  const present = new Set(seqs.map(String));
  const highest = seqs.reduce((left, right) => left > right ? left : right);
  if (highest > MAX_TRACKED_GAP_SEQUENCE_V1) {
    pushFatal(state, { code: 'DISCOVERY_PROTOCOL_LIMIT_EXCEEDED', path: `writers/${writerId}/gaps` });
    return;
  }
  state.knownGaps = state.knownGaps.filter(key => !key.startsWith(`${writerId}/`) || !present.has(key.slice(writerId.length + 1)));
  for (let seq = 1n; seq < highest; seq += 1n) {
    if (!present.has(String(seq))) pushUnique(state.knownGaps, `${writerId}/${seq}`, value => value);
  }
}

export async function verifyCommitCandidateV1(
  state: DiscoveryStateV1,
  candidate: WriterCommitCandidateV1,
  bytes: Uint8Array,
): Promise<CommitV1 | null> {
  const candidateSnapshot = { ...candidate };
  const bytesSnapshot = Uint8Array.from(bytes);
  const exactBytesHash = await sha256Hex(bytesSnapshot);
  const previous = state.verifiedObjects.find(value => value.path === candidateSnapshot.path);
  if (previous !== undefined && previous.exactBytesHash !== exactBytesHash) {
    pushFatal(state, { code: 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH', path: candidateSnapshot.path });
    return null;
  }
  if (exactBytesHash !== candidateSnapshot.contentHash) {
    pushFatal(state, { code: 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH', path: candidateSnapshot.path });
    return null;
  }
  let commit: CommitV1;
  try {
    commit = await decodeFrozenWireCommitV1(bytesSnapshot);
  } catch {
    pushFatal(state, { code: 'REMOTE_S2_OBJECT_INVALID', path: candidateSnapshot.path });
    return null;
  }
  if (commit.writerId !== candidateSnapshot.writerId || commit.writerSeq !== candidateSnapshot.writerSeq
    || commit.commitId !== candidateSnapshot.commitId || commit.contentHash !== candidateSnapshot.contentHash) {
    pushFatal(state, { code: 'REMOTE_S2_PATH_BODY_IDENTITY_MISMATCH', path: candidateSnapshot.path });
    return null;
  }
  const ref: CommitRef = { writerId: commit.writerId, writerSeq: commit.writerSeq, commitId: commit.commitId, contentHash: commit.contentHash };
  pushUnique(state.verifiedObjects, {
    path: candidateSnapshot.path, kind: 'commit', exactBytesHash, exactBytesHex: bytesToHex(bytesSnapshot),
    contentHash: candidateSnapshot.contentHash, commitRef: ref,
    fingerprintEvidence: { state: 'Missing' },
  }, item => item.path);
  const sameSeqObjects = state.verifiedObjects.filter(object => (
    object.commitRef?.writerId === ref.writerId && object.commitRef.writerSeq === ref.writerSeq
  ));
  const alternatives = new Set(sameSeqObjects.map(object => (
    `${object.commitRef!.commitId}/${object.commitRef!.contentHash}`
  )));
  if (alternatives.size > 1) {
    state.rootFatalSignals = state.rootFatalSignals.filter(signal => !(
      signal.code === 'WRITER_FORK' && signal.writerId === ref.writerId && signal.writerSeq === ref.writerSeq
    ));
    pushFatal(state, {
      code: 'WRITER_FORK', path: sameSeqObjects.map(object => object.path).sort(asciiCompare)[0]!,
      writerId: ref.writerId, writerSeq: ref.writerSeq,
      safeWriterFrontier: (parseWriterSeq(ref.writerSeq) - 1n).toString(),
    });
  }
  if (commit.previousWriterCommit !== null) addTarget(state, commit.previousWriterCommit);
  for (const dependency of commit.basisClock) addTarget(state, dependency);
  state.targetedQueue = state.targetedQueue.filter(value => refKey(value) !== refKey(ref));
  recomputeGaps(state, ref.writerId);
  normalizeState(state);
  return commit;
}

export async function verifyActivationCandidateV1(
  state: DiscoveryStateV1,
  candidate: ActivationCandidateV1,
  bytes: Uint8Array,
  validator: ActivationBodyValidatorV1,
): Promise<void> {
  const candidateSnapshot = { ...candidate };
  const bytesSnapshot = Uint8Array.from(bytes);
  const exactBytesHash = await sha256Hex(bytesSnapshot);
  const previous = state.verifiedObjects.find(value => value.path === candidateSnapshot.path);
  if (previous !== undefined && previous.exactBytesHash !== exactBytesHash) {
    pushFatal(state, { code: 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH', path: candidateSnapshot.path });
    return;
  }
  if (exactBytesHash !== candidateSnapshot.contentHash) {
    pushFatal(state, { code: 'REMOTE_IMMUTABLE_PATH_CONTENT_MISMATCH', path: candidateSnapshot.path });
    return;
  }
  let result: ActivationVerificationV1;
  try {
    result = await validator(Uint8Array.from(bytesSnapshot));
  } catch (error) {
    if (error instanceof ActivationProtocolValidationFailureV1) {
      pushFatal(state, { code: 'REMOTE_S2_OBJECT_INVALID', path: candidateSnapshot.path });
      return;
    }
    throw error;
  }
  if (result.activationId !== candidateSnapshot.activationId) {
    pushFatal(state, { code: 'REMOTE_S2_PATH_BODY_IDENTITY_MISMATCH', path: candidateSnapshot.path });
    return;
  }
  if (!result.semanticProfileSupported || !result.requiredFeaturesSupported) {
    pushFatal(state, { code: 'REMOTE_S2_UNSUPPORTED_FEATURE', path: candidateSnapshot.path });
    return;
  }
  pushUnique(state.verifiedObjects, {
    path: candidateSnapshot.path, kind: 'activation', exactBytesHash, exactBytesHex: bytesToHex(bytesSnapshot),
    contentHash: candidateSnapshot.contentHash,
    activationId: candidateSnapshot.activationId,
    fingerprintEvidence: result.legacyFingerprint === null
      ? { state: 'Null' }
      : { state: 'Value', value: result.legacyFingerprint },
  }, item => item.path);
  normalizeState(state);
}

function boundedEntries(
  state: DiscoveryStateV1,
  path: string,
  result: DirectoryListResultV1,
  budget: number,
): string[] {
  if (result.state !== 'Entries') {
    state.lastRoundIndeterminate = true;
    return [];
  }
  const entries = [...new Set(result.entries)].sort(asciiCompare);
  if (entries.length > budget) pushFatal(state, { code: 'DISCOVERY_PROTOCOL_LIMIT_EXCEEDED', path });
  return entries.slice(0, budget);
}

function scanTargetsForWriter(
  state: DiscoveryStateV1,
  writerId: string,
  auditTarget: string | null,
  budget: number,
): string[] {
  const segments = state.observedSegments.filter(key => key.startsWith(`${writerId}/`)).sort(asciiCompare);
  const targets: string[] = [];
  const add = (value: string): void => {
    if (!targets.includes(value)) targets.push(value);
  };
  if (auditTarget?.startsWith(`${writerId}/`)) add(auditTarget);
  const highest = segments.at(-1);
  if (highest !== undefined) {
    const highIndex = BigInt(`0x${highest.slice(writerId.length + 1)}`);
    for (let offset = 0n; offset <= 2n && highIndex >= offset; offset += 1n) {
      add(segmentKey(writerId, (highIndex - offset).toString(16).padStart(SEGMENT_NAME_WIDTH_V1, '0')));
    }
  }
  const gapSegments = new Set<string>();
  for (const gap of state.knownGaps.filter(key => key.startsWith(`${writerId}/`)).sort(asciiCompare)) {
    const seq = BigInt(gap.slice(writerId.length + 1));
    const segment = ((seq - 1n) / 256n).toString(16).padStart(SEGMENT_NAME_WIDTH_V1, '0');
    gapSegments.add(segmentKey(writerId, segment));
  }
  const orderedGaps = [...gapSegments].sort(asciiCompare);
  if (orderedGaps.length > 0) {
    const previous = state.gapSegmentCursorByWriter[writerId] ?? null;
    let index = previous === null ? 0 : orderedGaps.findIndex(value => value > previous);
    if (index < 0) index = 0;
    add(orderedGaps[index]!);
    state.gapSegmentCursorByWriter[writerId] = orderedGaps[index]!;
  }
  return targets.slice(0, budget);
}

async function callDirectoryListV1(remote: DiscoveryRemoteV1, path: string): Promise<DirectoryListResultV1> {
  try {
    return await remote.listDirectory(path);
  } catch (error) {
    if (error instanceof DiscoveryOperationalFailureV1) return { state: error.category };
    throw error;
  }
}

async function callDiscoveryGetV1(remote: DiscoveryRemoteV1, path: string): Promise<DiscoveryExactGetResultV1> {
  try {
    return await remote.getExact(path);
  } catch (error) {
    if (error instanceof DiscoveryOperationalFailureV1) return { state: error.category };
    throw error;
  }
}

interface ScheduledExactWorkV1 {
  path: string;
  workClass: ExactWorkClassV1;
}

function nextFairItem(items: readonly string[], after: string | null, selected: ReadonlySet<string>): string | null {
  const available = [...new Set(items)].sort(asciiCompare).filter(item => !selected.has(item));
  if (available.length === 0) return null;
  if (after !== null) {
    const next = available.find(item => item > after);
    if (next !== undefined) return next;
  }
  return available[0]!;
}

function scheduleExactWorkV1(
  state: DiscoveryStateV1,
  budgets: DiscoveryBudgetsV1,
): ScheduledExactWorkV1[] {
  const classes: ExactWorkClassV1[] = ['dependency', 'candidate', 'reverify'];
  const verifiedPaths = new Set(state.verifiedObjects.map(value => value.path));
  const terminalPaths = new Set(state.terminalCandidatePaths);
  const workByClass: Record<ExactWorkClassV1, string[]> = {
    dependency: state.targetedQueue.map(buildCommitRemotePathV1),
    candidate: state.observedCandidates
      .filter(value => !verifiedPaths.has(value.path) && !terminalPaths.has(value.path))
      .map(value => value.path),
    reverify: state.reverificationQueue.filter(path => verifiedPaths.has(path)),
  };
  const selected = new Set<string>();
  const result: ScheduledExactWorkV1[] = [];
  const classCounts: Record<ExactWorkClassV1, number> = { dependency: 0, candidate: 0, reverify: 0 };
  let classIndex = Math.max(0, classes.indexOf(state.exactWorkScheduler.nextClass));
  while (result.length < budgets.maxExactFetchesPerSync) {
    let scheduled = false;
    for (let offset = 0; offset < classes.length; offset += 1) {
      const index = (classIndex + offset) % classes.length;
      const workClass = classes[index]!;
      if (workClass === 'dependency' && classCounts.dependency >= budgets.maxDependencyTargetsPerSync) continue;
      const path = nextFairItem(
        workByClass[workClass],
        state.exactWorkScheduler.afterByClass[workClass],
        selected,
      );
      if (path === null) continue;
      result.push({ path, workClass });
      selected.add(path);
      classCounts[workClass] += 1;
      state.exactWorkScheduler.afterByClass[workClass] = path;
      classIndex = (index + 1) % classes.length;
      state.exactWorkScheduler.nextClass = classes[classIndex]!;
      scheduled = true;
      break;
    }
    if (!scheduled) break;
  }
  return result;
}

export async function runDiscoveryRoundV1(
  prior: DiscoveryStateV1,
  remote: DiscoveryRemoteV1,
  activationValidator: ActivationBodyValidatorV1,
  budgets: DiscoveryBudgetsV1 = DEFAULT_DISCOVERY_BUDGETS_V1,
): Promise<DiscoveryStateV1> {
  const state = cloneState(prior);
  normalizeState(state);
  state.lastRoundIndeterminate = false;
  state.lastRoundScheduledLists = [];
  state.lastRoundScheduledGets = [];
  const list = async (path: string): Promise<DirectoryListResultV1> => {
    state.lastRoundScheduledLists.push(path);
    return callDirectoryListV1(remote, path);
  };
  const activationEntries = boundedEntries(state, 'activations/', await list('activations/'), budgets.maxListingEntriesPerDirectory);
  observeCandidateListingV1(state, activationEntries);
  const writerEntries = boundedEntries(state, 'writers/', await list('writers/'), budgets.maxListingEntriesPerDirectory);
  observeWriterListingV1(state, writerEntries);
  for (const writerId of [...state.observedWriters]) {
    const path = `writers/${writerId}/segments/`;
    const entries = boundedEntries(state, path, await list(path), budgets.maxListingEntriesPerDirectory);
    observeSegmentListingV1(state, writerId, entries);
  }
  const auditTarget = chooseHistoricalAuditTargetV1(state);
  for (const writerId of [...state.observedWriters]) {
    for (const key of scanTargetsForWriter(state, writerId, auditTarget, budgets.maxSegmentsPerWriterPerSync)) {
      const segment = key.slice(writerId.length + 1);
      const path = `writers/${writerId}/segments/${segment}/`;
      const entries = boundedEntries(state, path, await list(path), budgets.maxListingEntriesPerDirectory);
      if (key === auditTarget) {
        for (const entry of entries) {
          if (parseWriterCandidatePathV1(entry) !== null && state.verifiedObjects.some(value => value.path === entry)) {
            pushUnique(state.reverificationQueue, entry, value => value);
          }
        }
      }
      observeCandidateListingV1(state, entries);
    }
  }
  const candidateByPath = new Map(state.observedCandidates.map(value => [value.path, value]));
  const scheduledWork = scheduleExactWorkV1(state, budgets);
  state.lastRoundScheduledGets = scheduledWork.map(value => value.path);
  for (const { path, workClass } of scheduledWork) {
    const fetched = await callDiscoveryGetV1(remote, path);
    if (fetched.state === 'Indeterminate' || fetched.state === 'AuthOrCapabilityFailure') {
      state.lastRoundIndeterminate = true;
      continue;
    }
    if (fetched.state === 'DefinitelyAbsent') continue;
    if (workClass === 'reverify') {
      state.reverificationQueue = state.reverificationQueue.filter(value => value !== path);
    }
    let candidate = candidateByPath.get(path);
    if (candidate === undefined) {
      candidate = parseWriterCandidatePathV1(path) ?? parseActivationCandidatePathV1(path) ?? undefined;
      if (candidate !== undefined) {
        observeCandidateListingV1(state, [path]);
        candidateByPath.set(path, candidate);
      }
    }
    if (candidate?.kind === 'commit') await verifyCommitCandidateV1(state, candidate, fetched.bytes);
    if (candidate?.kind === 'activation') await verifyActivationCandidateV1(state, candidate, fetched.bytes, activationValidator);
    if (candidate !== undefined && !state.verifiedObjects.some(value => value.path === path)) {
      pushUnique(state.terminalCandidatePaths, path, value => value);
    }
  }
  normalizeState(state);
  return state;
}

export interface DiscoveryStateStoreV1 {
  persist(state: Readonly<DiscoveryStateV1>): Promise<void>;
  load(): Promise<DiscoveryStateV1 | null>;
}

export async function persistDiscoveryStateV1(state: DiscoveryStateV1, store: DiscoveryStateStoreV1): Promise<void> {
  await store.persist(cloneState(state));
}

export async function loadDiscoveryStateV1(store: DiscoveryStateStoreV1): Promise<DiscoveryStateV1> {
  const loaded = await store.load();
  return loaded === null ? createDiscoveryStateV1() : cloneState(loaded);
}

export function retainedVerifiedCommitBytesV1(state: DiscoveryStateV1): Uint8Array[] {
  return state.verifiedObjects
    .filter(value => value.kind === 'commit')
    .sort((a, b) => asciiCompare(a.path, b.path))
    .map(value => hexToBytes(value.exactBytesHex));
}
