import {
  canonicalEntityKeyBytes,
  canonicalizeJcs,
  compareUnsignedBytes,
  compareCommitRefV1,
  compareEntityKeyV1,
  extractSafeIntegerV1,
  parseWriterSeq,
  sha256Hex,
  S2ProtocolValidationError,
  validateCanonicalUuidV4,
  validateCommitRef,
  validateContentHash,
  validateEntityKey,
  validateCanonicalTimestamp,
  validateUnicodeScalarString,
} from './canonical.ts';
import {
  buildEntityConflictCoreV1,
  buildRelationConflictCoreV1,
  entityConflictIdV1,
  relationConflictIdV1,
} from './conflictCodec.ts';
import {
  BUSINESS_FIELD_ORDER,
  canonicalSemanticValue,
  validateNativeEntity,
  validateNativeTombstone,
} from './semanticProfile.ts';
import type {
  CanonicalSemanticState,
  CommitMutationV1,
  CommitRef,
  CommitV1,
  DuplicateDiagnosticV1,
  EntityConflictKind,
  EntityKey,
  EntityVersionV1,
  HistoricalValidity,
  JsonValue,
  MaterializedEntityV1,
  MetadataVariantV1,
  RelationConflictV1,
  RelationDetectionV1,
  VerifiedReplayV1,
  WriterForkV1,
  WriterSeqDecimalString,
} from './types.ts';

export const MAX_MUTATIONS_PER_COMMIT_V1 = 256;

const SHA256_RE = /^[0-9a-f]{64}$/;
const SYSTEM_METADATA_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'rev', 'revActor', 'deletedAt']);

function invalid(code: string): never {
  throw new S2ProtocolValidationError(code);
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((field, index) => field !== sortedExpected[index])) invalid(code);
}

function exactRefKey(ref: CommitRef): string {
  return `${ref.writerId}\0${ref.writerSeq}\0${ref.commitId}\0${ref.contentHash}`;
}

function compareTextBytes(a: string, b: string): number {
  return compareUnsignedBytes(new TextEncoder().encode(a), new TextEncoder().encode(b));
}

function entityKeyId(key: EntityKey): string {
  return canonicalizeJcs(key as unknown as JsonValue);
}

function sameRef(a: CommitRef, b: CommitRef): boolean {
  return compareCommitRefV1(a, b) === 0;
}

function sameRefSet(a: readonly CommitRef[], b: readonly CommitRef[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort(compareCommitRefV1);
  const right = [...b].sort(compareCommitRefV1);
  return left.every((ref, index) => sameRef(ref, right[index]!));
}

function commitRef(commit: CommitV1): CommitRef {
  return {
    writerId: commit.writerId,
    writerSeq: commit.writerSeq,
    commitId: commit.commitId,
    contentHash: commit.contentHash,
  };
}

function validateStringArray(value: unknown, code: string): asserts value is string[] {
  if (!Array.isArray(value)) invalid(code);
  for (const item of value) validateUnicodeScalarString(item, code);
}

function validateMutationEnvelope(mutation: unknown): asserts mutation is CommitMutationV1 {
  const value = object(mutation, 'invalid_mutation');
  exactFields(
    value,
    ['localMutationId', 'entityType', 'entityKey', 'operation', 'value', 'baseFrontier', 'changedFields'],
    'invalid_mutation',
  );
  validateCanonicalUuidV4(value.localMutationId);
  validateEntityKey(value.entityKey);
  if (value.entityType !== (value.entityKey as EntityKey)[0]) invalid('mutation_entity_type_mismatch');
  if (value.operation !== 'upsert' && value.operation !== 'tombstone') invalid('invalid_mutation_operation');
  object(value.value, 'invalid_mutation_value');
  if (!Array.isArray(value.baseFrontier)) invalid('invalid_entity_base_frontier');
  value.baseFrontier.forEach(validateCommitRef);
  for (let index = 1; index < value.baseFrontier.length; index += 1) {
    if (compareCommitRefV1(value.baseFrontier[index - 1]!, value.baseFrontier[index]!) >= 0) {
      invalid('noncanonical_entity_base_frontier');
    }
  }
  validateStringArray(value.changedFields, 'invalid_changed_fields');
  if (new Set(value.changedFields).size !== value.changedFields.length) invalid('invalid_changed_fields');
}

export function validateCommitEnvelopeV1(input: unknown): asserts input is CommitV1 {
  const commit = object(input, 'invalid_commit_envelope');
  exactFields(commit, [
    'protocol', 'protocolVersion', 's2SemanticProfileVersion', 'requiredFeatures', 'writerId',
    'writerSeq', 'commitId', 'contentHash', 'previousWriterCommit', 'basisClock', 'commitKind',
    'createdAt', 'source', 'resolves', 'mutations',
  ], 'invalid_commit_envelope');
  if (commit.protocol !== 'watchtracker-s2-lite' || commit.protocolVersion !== 1) {
    invalid('unsupported_protocol_version');
  }
  if (commit.s2SemanticProfileVersion !== 1) invalid('unsupported_semantic_profile');
  validateStringArray(commit.requiredFeatures, 'invalid_required_features');
  if (commit.requiredFeatures.length !== 0) invalid('unsupported_required_feature');
  validateCanonicalUuidV4(commit.writerId);
  const seq = parseWriterSeq(commit.writerSeq);
  if (seq < 1n) invalid('invalid_writer_seq');
  validateCanonicalUuidV4(commit.commitId);
  validateContentHash(commit.contentHash);
  if (commit.previousWriterCommit !== null) validateCommitRef(commit.previousWriterCommit as CommitRef);
  if (!Array.isArray(commit.basisClock)) invalid('invalid_basis_clock');
  const writers = new Set<string>();
  for (let index = 0; index < commit.basisClock.length; index += 1) {
    const ref = commit.basisClock[index] as CommitRef;
    validateCommitRef(ref);
    if (writers.has(ref.writerId)) invalid('duplicate_basis_writer');
    writers.add(ref.writerId);
    if (index > 0 && compareCommitRefV1(commit.basisClock[index - 1] as CommitRef, ref) >= 0) {
      invalid('noncanonical_basis_clock');
    }
  }
  if (!['mutation', 'resolution', 'bootstrap'].includes(commit.commitKind as string)) {
    invalid('invalid_commit_kind');
  }
  validateCanonicalTimestamp(commit.createdAt);
  const source = object(commit.source, 'invalid_commit_source');
  exactFields(source, ['type'], 'invalid_commit_source');
  if (!['native', 'manual-resolution', 'legacy-bootstrap', 'new-root-bootstrap'].includes(source.type as string)) {
    invalid('invalid_commit_source');
  }
  validateStringArray(commit.resolves, 'invalid_resolves');
  const resolves = commit.resolves as string[];
  if (new Set(resolves).size !== resolves.length
    || resolves.some(value => !SHA256_RE.test(value))) invalid('invalid_resolves');
  if (resolves.some((value, index) => index > 0 && resolves[index - 1]! >= value)) {
    invalid('noncanonical_resolves');
  }
  if (commit.commitKind === 'mutation') {
    if (commit.resolves.length !== 0 || source.type !== 'native') invalid('invalid_mutation_commit');
  } else if (commit.commitKind === 'resolution') {
    if (source.type !== 'manual-resolution' || commit.resolves.length === 0) {
      invalid('invalid_resolution_commit');
    }
  } else if (commit.resolves.length !== 0
    || (source.type !== 'legacy-bootstrap' && source.type !== 'new-root-bootstrap')) {
    invalid('invalid_bootstrap_commit');
  }
  if (!Array.isArray(commit.mutations) || commit.mutations.length === 0
    || commit.mutations.length > MAX_MUTATIONS_PER_COMMIT_V1) invalid('invalid_mutation_count');
  const mutationIds = new Set<string>();
  const entityKeys: EntityKey[] = [];
  for (const mutation of commit.mutations) {
    validateMutationEnvelope(mutation);
    if (mutationIds.has(mutation.localMutationId)) invalid('duplicate_local_mutation_id');
    mutationIds.add(mutation.localMutationId);
    if (entityKeys.some(key => compareEntityKeyV1(key, mutation.entityKey) === 0)) invalid('duplicate_entity_key');
    entityKeys.push(mutation.entityKey);
  }
}

const FORBIDDEN_JSON_ENCODING_MARKERS = [
  [0xef, 0xbb, 0xbf],
  [0xfe, 0xff],
  [0xff, 0xfe],
  [0x00, 0x00, 0xfe, 0xff],
  [0xff, 0xfe, 0x00, 0x00],
] as const;

class StrictJsonScannerV1 {
  private index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  validate(): void {
    this.whitespace();
    this.value();
    this.whitespace();
    if (this.index !== this.text.length) invalid('invalid_commit_json');
  }

  private whitespace(): void {
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) return;
      this.index += 1;
    }
  }

  private value(): void {
    const current = this.text[this.index];
    if (current === '{') this.object();
    else if (current === '[') this.array();
    else if (current === '"') this.string();
    else if (current === 't') this.literal('true');
    else if (current === 'f') this.literal('false');
    else if (current === 'n') this.literal('null');
    else this.number();
  }

  private object(): void {
    this.index += 1;
    this.whitespace();
    const keys = new Set<string>();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return;
    }
    while (true) {
      if (this.text[this.index] !== '"') invalid('invalid_commit_json');
      const key = this.string();
      if (keys.has(key)) invalid('invalid_commit_json');
      keys.add(key);
      this.whitespace();
      if (this.text[this.index] !== ':') invalid('invalid_commit_json');
      this.index += 1;
      this.whitespace();
      this.value();
      this.whitespace();
      if (this.text[this.index] === '}') {
        this.index += 1;
        return;
      }
      if (this.text[this.index] !== ',') invalid('invalid_commit_json');
      this.index += 1;
      this.whitespace();
    }
  }

  private array(): void {
    this.index += 1;
    this.whitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return;
    }
    while (true) {
      this.value();
      this.whitespace();
      if (this.text[this.index] === ']') {
        this.index += 1;
        return;
      }
      if (this.text[this.index] !== ',') invalid('invalid_commit_json');
      this.index += 1;
      this.whitespace();
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        try {
          const decoded = JSON.parse(this.text.slice(start, this.index)) as string;
          for (let offset = 0; offset < decoded.length; offset += 1) {
            const unit = decoded.charCodeAt(offset);
            if (unit >= 0xd800 && unit <= 0xdbff) {
              const low = decoded.charCodeAt(offset + 1);
              if (!(low >= 0xdc00 && low <= 0xdfff)) invalid('invalid_commit_json');
              offset += 1;
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
              invalid('invalid_commit_json');
            }
          }
          return decoded;
        } catch {
          return invalid('invalid_commit_json');
        }
      }
      if (code < 0x20) invalid('invalid_commit_json');
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.index + 1, this.index + 5))) {
            invalid('invalid_commit_json');
          }
          this.index += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) invalid('invalid_commit_json');
      }
      this.index += 1;
    }
    return invalid('invalid_commit_json');
  }

  private literal(expected: string): void {
    if (this.text.slice(this.index, this.index + expected.length) !== expected) invalid('invalid_commit_json');
    this.index += expected.length;
  }

  private number(): void {
    const rest = this.text.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (match === null) invalid('invalid_commit_json');
    if (!Number.isFinite(Number(match[0]))) invalid('invalid_commit_json');
    this.index += match[0].length;
  }
}

export function validateFrozenJsonBytesV1(bytes: Uint8Array): string {
  if (FORBIDDEN_JSON_ENCODING_MARKERS.some(marker => (
    bytes.length >= marker.length && marker.every((byte, index) => bytes[index] === byte)
  ))) invalid('invalid_commit_json_bytes');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid('invalid_commit_json_bytes');
  }
  new StrictJsonScannerV1(text).validate();
  return text;
}

export async function decodeFrozenWireCommitV1(rawJson: string | Uint8Array): Promise<CommitV1> {
  const bytes = typeof rawJson === 'string' ? new TextEncoder().encode(rawJson) : rawJson;
  const text = validateFrozenJsonBytesV1(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('invalid_commit_json');
  }
  const wire = object(parsed, 'invalid_commit_envelope');
  const requiredFields = [
    'protocol', 'protocolVersion', 's2SemanticProfileVersion', 'requiredFeatures', 'writerId',
    'writerSeq', 'commitId', 'previousWriterCommit', 'basisClock', 'commitKind', 'createdAt',
    'source', 'mutations',
  ];
  const actualFields = Object.keys(wire);
  if (actualFields.some(field => !requiredFields.includes(field) && field !== 'resolves')
    || requiredFields.some(field => !Object.hasOwn(wire, field))) invalid('invalid_commit_envelope');
  if (wire.commitKind === 'resolution' && !Object.hasOwn(wire, 'resolves')) invalid('invalid_commit_envelope');
  const commit = {
    ...wire,
    resolves: Object.hasOwn(wire, 'resolves') ? wire.resolves : [],
    contentHash: await sha256Hex(bytes),
  } as unknown as CommitV1;
  validateCommitEnvelopeV1(commit);
  return commit;
}

export function validateWriterChainLinkV1(
  commit: CommitV1,
  verifiedDependencies: ReadonlyMap<string, CommitV1>,
): void {
  const seq = parseWriterSeq(commit.writerSeq);
  const ownBasis = commit.basisClock.find(ref => ref.writerId === commit.writerId);
  if (seq === 1n) {
    if (commit.previousWriterCommit !== null || ownBasis !== undefined) invalid('invalid_writer_causal_chain');
    return;
  }
  const previous = commit.previousWriterCommit;
  if (previous === null || previous.writerId !== commit.writerId
    || parseWriterSeq(previous.writerSeq) !== seq - 1n
    || ownBasis === undefined || !sameRef(previous, ownBasis)
    || !verifiedDependencies.has(exactRefKey(previous))) invalid('invalid_writer_causal_chain');
}

export function detectWriterForksV1(commits: readonly CommitV1[]): WriterForkV1[] {
  const groups = new Map<string, CommitRef[]>();
  for (const commit of commits) {
    try {
      validateCommitRef(commitRef(commit));
    } catch {
      continue;
    }
    const key = `${commit.writerId}\0${commit.writerSeq}`;
    const refs = groups.get(key) ?? [];
    if (!refs.some(ref => sameRef(ref, commitRef(commit)))) refs.push(commitRef(commit));
    groups.set(key, refs);
  }
  return [...groups.values()]
    .filter(refs => refs.length > 1)
    .map(refs => {
      refs.sort(compareCommitRefV1);
      const seq = parseWriterSeq(refs[0]!.writerSeq);
      return {
        writerId: refs[0]!.writerId,
        writerSeq: refs[0]!.writerSeq,
        alternatives: refs,
        safeWriterFrontier: String(seq - 1n) as WriterSeqDecimalString,
      };
    })
    .sort((a, b) => compareTextBytes(a.writerId, b.writerId) || (
      parseWriterSeq(a.writerSeq) < parseWriterSeq(b.writerSeq) ? -1 : 1
    ));
}

function dependencyRefs(commit: CommitV1): CommitRef[] {
  return commit.basisClock;
}

function ancestorRefKeys(heads: readonly CommitRef[], commits: ReadonlyMap<string, CommitV1>): Set<string> {
  const result = new Set<string>();
  const pending = [...heads];
  while (pending.length > 0) {
    const ref = pending.pop()!;
    const key = exactRefKey(ref);
    if (result.has(key)) continue;
    const commit = commits.get(key);
    if (commit === undefined) continue;
    result.add(key);
    pending.push(...dependencyRefs(commit));
  }
  return result;
}

function pendingCycleKeys(
  commits: ReadonlyMap<string, CommitV1>,
  validity: ReadonlyMap<string, HistoricalValidity>,
): Set<string> {
  const pending = new Set([...commits.keys()].filter(key => validity.get(key)?.state === 'PENDING'));
  const candidates = pending;
  const adjacency = new Map<string, string[]>();
  for (const key of candidates) {
    const dependencies = dependencyRefs(commits.get(key)!).map(exactRefKey)
      .filter(ref => candidates.has(ref)).sort(compareTextBytes);
    adjacency.set(key, dependencies);
  }
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles = new Set<string>();

  const strongConnect = (key: string): void => {
    const index = nextIndex;
    nextIndex += 1;
    indices.set(key, index);
    lowlinks.set(key, index);
    stack.push(key);
    onStack.add(key);
    for (const dependency of adjacency.get(key)!) {
      if (!indices.has(dependency)) {
        strongConnect(dependency);
        lowlinks.set(key, Math.min(lowlinks.get(key)!, lowlinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowlinks.set(key, Math.min(lowlinks.get(key)!, indices.get(dependency)!));
      }
    }

    if (lowlinks.get(key) === indices.get(key)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== key);
      if (component.length > 1 || adjacency.get(key)!.includes(key)) {
        component.forEach(memberKey => cycles.add(memberKey));
      }
    }
  };

  for (const key of [...candidates].sort(compareTextBytes)) {
    if (!indices.has(key)) strongConnect(key);
  }
  return cycles;
}

function unsafeCommitKeys(
  forks: readonly WriterForkV1[],
  verifiedCommits: ReadonlyMap<string, CommitV1>,
): Set<string> {
  const unsafe = new Set(forks.flatMap(fork => fork.alternatives.map(exactRefKey)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, commit] of verifiedCommits) {
      if (!unsafe.has(key) && dependencyRefs(commit).some(reference => unsafe.has(exactRefKey(reference)))) {
        unsafe.add(key);
        changed = true;
      }
    }
  }
  return unsafe;
}

export function causallyCoversV1(
  covering: CommitRef,
  covered: CommitRef,
  verifiedCommits: ReadonlyMap<string, CommitV1>,
): boolean {
  if (sameRef(covering, covered)) return true;
  const commit = verifiedCommits.get(exactRefKey(covering));
  return commit !== undefined
    && ancestorRefKeys(commit.basisClock, verifiedCommits).has(exactRefKey(covered));
}

export function computeEntityFrontierV1(
  versions: readonly EntityVersionV1[],
  verifiedCommits: ReadonlyMap<string, CommitV1>,
): EntityVersionV1[] {
  const frontier = versions.filter(candidate => !versions.some(other => (
    !sameRef(candidate.commitRef, other.commitRef)
    && causallyCoversV1(other.commitRef, candidate.commitRef, verifiedCommits)
  )));
  return frontier.sort((a, b) => compareCommitRefV1(a.commitRef, b.commitRef));
}

export function expectedEntityFrontierV1(
  entityKey: EntityKey,
  authorVerifiedBasis: readonly CommitRef[],
  versions: readonly EntityVersionV1[],
  verifiedCommits: ReadonlyMap<string, CommitV1>,
): EntityVersionV1[] {
  const visible = ancestorRefKeys(authorVerifiedBasis, verifiedCommits);
  return computeEntityFrontierV1(versions.filter(version => (
    compareEntityKeyV1(version.entityKey, entityKey) === 0 && visible.has(exactRefKey(version.commitRef))
  )), verifiedCommits);
}

function metadataOf(version: EntityVersionV1): { [key: string]: JsonValue } {
  const metadata: { [key: string]: JsonValue } = {};
  for (const [field, value] of Object.entries(version.fullValue)) {
    if (SYSTEM_METADATA_FIELDS.has(field)) metadata[field] = value;
  }
  return metadata;
}

function metadataVariants(frontier: readonly EntityVersionV1[]): MetadataVariantV1[] {
  return [...frontier]
    .sort((a, b) => compareCommitRefV1(a.commitRef, b.commitRef))
    .map(version => ({ commitRef: version.commitRef, metadata: metadataOf(version) }));
}

function resolved(
  semanticState: CanonicalSemanticState,
  frontier: readonly EntityVersionV1[],
): MaterializedEntityV1 {
  return {
    state: 'Resolved',
    semanticState,
    businessValue: semanticState.state === 'live' ? semanticState.value : null,
    provenanceFrontier: frontier.map(version => version.commitRef).sort(compareCommitRefV1),
    metadataVariants: metadataVariants(frontier),
  };
}

function sameSemanticState(frontier: readonly EntityVersionV1[]): boolean {
  if (frontier.length < 2) return true;
  const first = canonicalizeJcs(frontier[0]!.semanticState as unknown as JsonValue);
  return frontier.slice(1).every(version => (
    canonicalizeJcs(version.semanticState as unknown as JsonValue) === first
  ));
}

function changedFieldsOverlap(frontier: readonly EntityVersionV1[]): boolean {
  const seen = new Set<string>();
  for (const version of frontier) {
    for (const field of version.changedFields) {
      if (seen.has(field)) return true;
      seen.add(field);
    }
  }
  return false;
}

function hasLockedConcurrency(frontier: readonly EntityVersionV1[]): boolean {
  if (frontier[0]?.entityKey[0] !== 'record') return false;
  return frontier.some((version, index) => (
    version.semanticState.state === 'live'
    && version.changedFields.includes('isLocked')
    && version.semanticState.value.isLocked === true
    && frontier.some((other, otherIndex) => otherIndex !== index && other.changedFields.length > 0)
  ));
}

async function conflict(
  entityKey: EntityKey,
  kind: EntityConflictKind,
  frontier: readonly EntityVersionV1[],
): Promise<MaterializedEntityV1> {
  const core = buildEntityConflictCoreV1(entityKey, kind, frontier.map(version => ({
    ref: version.commitRef,
    semanticState: version.semanticState,
    changedFields: version.changedFields,
    baseFrontier: version.baseFrontier,
  })));
  return {
    state: 'Conflict',
    conflictId: await entityConflictIdV1(core),
    conflictKind: kind,
    entityKey,
    frontier: frontier.map(version => version.commitRef).sort(compareCommitRefV1),
    conflictFields: core.conflictFields,
    semanticAlternatives: core.semanticAlternatives,
  };
}

async function validateDerivedLive(
  entityKey: EntityKey,
  value: { [key: string]: JsonValue },
  metadataSource: EntityVersionV1,
): Promise<boolean> {
  const full = { ...metadataOf(metadataSource), ...value };
  try {
    await validateNativeEntity(entityKey, full);
    return true;
  } catch {
    return false;
  }
}

export async function materializeV1(
  entityKey: EntityKey,
  exactExpectedFrontier: readonly EntityVersionV1[],
  verifiedClosure: ReadonlyMap<string, CommitV1>,
  allVersions: readonly EntityVersionV1[] = exactExpectedFrontier,
): Promise<MaterializedEntityV1> {
  const frontier = computeEntityFrontierV1(exactExpectedFrontier, verifiedClosure);
  if (frontier.length === 0) return { state: 'Absent' };
  if (sameSemanticState(frontier)) return resolved(frontier[0]!.semanticState, frontier);
  if (frontier.length === 1) return resolved(frontier[0]!.semanticState, frontier);
  if (frontier.some(version => version.operation === 'tombstone')) {
    return conflict(entityKey, 'live-tombstone', frontier);
  }
  const sameBase = frontier.every(version => sameRefSet(version.baseFrontier, frontier[0]!.baseFrontier));
  if (hasLockedConcurrency(frontier)) return conflict(entityKey, 'locked-concurrent', frontier);
  if (!sameBase) return conflict(entityKey, 'different-base', frontier);
  if (changedFieldsOverlap(frontier)) return conflict(entityKey, 'overlapping-field', frontier);

  const baseVersions = frontier[0]!.baseFrontier.map(ref => allVersions.find(version => (
    compareEntityKeyV1(version.entityKey, entityKey) === 0 && sameRef(version.commitRef, ref)
  ))).filter((version): version is EntityVersionV1 => version !== undefined);
  const base = await materializeV1(entityKey, baseVersions, verifiedClosure, allVersions);
  if (base.state !== 'Resolved' || base.semanticState.state !== 'live') {
    return conflict(entityKey, 'different-base', frontier);
  }
  const merged = { ...base.semanticState.value };
  for (const version of frontier) {
    if (version.semanticState.state !== 'live') return conflict(entityKey, 'live-tombstone', frontier);
    for (const field of version.changedFields) merged[field] = version.semanticState.value[field]!;
  }
  if (!await validateDerivedLive(entityKey, merged, frontier[0]!)) {
    return conflict(entityKey, 'derived-domain', frontier);
  }
  return resolved({ state: 'live', value: merged }, frontier);
}

async function materializeVisibleEntities(
  versions: readonly EntityVersionV1[],
  commits: ReadonlyMap<string, CommitV1>,
): Promise<Array<{ entityKey: EntityKey; value: MaterializedEntityV1 }>> {
  const keys = new Map<string, EntityKey>();
  for (const version of versions) keys.set(entityKeyId(version.entityKey), version.entityKey);
  const ordered = [...keys.values()].sort(compareEntityKeyV1);
  return Promise.all(ordered.map(async entityKey => ({
    entityKey,
    value: await materializeV1(
      entityKey,
      computeEntityFrontierV1(versions.filter(version => compareEntityKeyV1(version.entityKey, entityKey) === 0), commits),
      commits,
      versions,
    ),
  })));
}

function materializedMap(
  values: readonly { entityKey: EntityKey; value: MaterializedEntityV1 }[],
): Map<string, MaterializedEntityV1> {
  return new Map(values.map(item => [entityKeyId(item.entityKey), item.value]));
}

function relationParticipant(entityKey: EntityKey, value: MaterializedEntityV1) {
  if (value.state !== 'Resolved') invalid('invalid_relation_participant');
  return { entityKey, provenanceFrontier: value.provenanceFrontier };
}

export async function detectWatchTrackerRelationsV1(
  entities: readonly { entityKey: EntityKey; value: MaterializedEntityV1 }[],
): Promise<RelationDetectionV1> {
  const byKey = materializedMap(entities);
  const conflicts: RelationConflictV1[] = [];
  const blocked = new Map<string, EntityKey>();
  const ordered = [...entities].sort((a, b) => compareEntityKeyV1(a.entityKey, b.entityKey));
  const add = async (
    kind: Parameters<typeof buildRelationConflictCoreV1>[0],
    facts: Parameters<typeof buildRelationConflictCoreV1>[1],
    participants: Parameters<typeof buildRelationConflictCoreV1>[2],
  ) => {
    const core = buildRelationConflictCoreV1(kind, facts, participants);
    conflicts.push({ relationConflictId: await relationConflictIdV1(core), core });
  };
  for (const item of ordered) {
    const key = item.entityKey;
    if (key[0] === 'collection-member' && item.value.state !== 'Absent') {
      const collectionKey: EntityKey = ['collection', key[1]];
      const recordKey: EntityKey = ['record', key[2]];
      const collection = byKey.get(entityKeyId(collectionKey)) ?? { state: 'Absent' };
      const record = byKey.get(entityKeyId(recordKey)) ?? { state: 'Absent' };
      for (const [parentKey, parent] of [[collectionKey, collection], [recordKey, record]] as const) {
        if (item.value.state === 'Conflict' || parent.state === 'Conflict') {
          blocked.set(entityKeyId(key), key);
          blocked.set(entityKeyId(parentKey), parentKey);
        }
      }
      if (item.value.state === 'Resolved' && item.value.semanticState.state === 'live'
        && collection.state === 'Resolved' && collection.semanticState.state === 'tombstone') {
        await add('collection-deleted-member-live', {
          collectionId: key[1], recordId: key[2], collectionState: 'tombstone', memberState: 'live',
        }, [relationParticipant(collectionKey, collection), relationParticipant(key, item.value)]);
      }
      if (item.value.state === 'Resolved' && item.value.semanticState.state === 'live'
        && record.state === 'Resolved' && record.semanticState.state === 'tombstone') {
        await add('record-deleted-member-live', {
          collectionId: key[1], recordId: key[2], recordState: 'tombstone', memberState: 'live',
        }, [relationParticipant(recordKey, record), relationParticipant(key, item.value)]);
      }
    }
    if (key[0] === 'episode-completion' && item.value.state !== 'Absent') {
      const recordKey: EntityKey = ['record', key[1]];
      const record = byKey.get(entityKeyId(recordKey)) ?? { state: 'Absent' };
      if (item.value.state === 'Conflict' || record.state === 'Conflict') {
        blocked.set(entityKeyId(key), key);
        blocked.set(entityKeyId(recordKey), recordKey);
      } else if (item.value.state === 'Resolved' && item.value.semanticState.state === 'live'
        && record.state === 'Resolved' && record.semanticState.state === 'tombstone') {
        await add('record-deleted-episode-live', {
          recordId: key[1], episodeNumber: key[2], recordState: 'tombstone', episodeState: 'live',
        }, [relationParticipant(recordKey, record), relationParticipant(key, item.value)]);
      } else if (item.value.state === 'Resolved' && item.value.semanticState.state === 'live'
        && record.state === 'Resolved' && record.semanticState.state === 'live') {
        const totalValue = record.businessValue?.totalEpisodes;
        const episode = extractSafeIntegerV1(key[2], 1, 2_147_483_647);
        const total = totalValue === null ? null : extractSafeIntegerV1(totalValue, 1, 2_147_483_647);
        if (total !== null && episode > total) {
          await add('episode-exceeds-total', {
            recordId: key[1], episodeNumber: key[2], totalEpisodes: total,
          }, [relationParticipant(recordKey, record), relationParticipant(key, item.value)]);
        }
      }
    }
  }
  conflicts.sort((a, b) => compareTextBytes(a.relationConflictId, b.relationConflictId));
  return { conflicts, blockedByEntityConflict: [...blocked.values()].sort(compareEntityKeyV1) };
}

export function detectDuplicateDiagnosticsV1(
  entities: readonly { entityKey: EntityKey; value: MaterializedEntityV1 }[],
): DuplicateDiagnosticV1[] {
  type Kind = DuplicateDiagnosticV1['kind'];
  const groups = new Map<string, { kind: Kind; value: JsonValue; keys: EntityKey[] }>();
  const add = (kind: Kind, value: JsonValue, key: EntityKey) => {
    const id = `${kind}\0${canonicalizeJcs(value)}`;
    const group = groups.get(id) ?? { kind, value, keys: [] };
    group.keys.push(key);
    groups.set(id, group);
  };
  for (const { entityKey, value } of entities) {
    if (value.state !== 'Resolved' || value.semanticState.state !== 'live') continue;
    const business = value.businessValue!;
    if (entityKey[0] === 'collection') {
      add('duplicate-collection-normalized-name', business.normalizedName!, entityKey);
      if (business.sourceKind !== 'manual') {
        add('duplicate-collection-source', [business.sourceKind!, business.sourceKey!] as JsonValue, entityKey);
      }
    } else if (entityKey[0] === 'record') {
      if (business.imdbId !== null) add('duplicate-record-external-identity', `imdb:${business.imdbId}`, entityKey);
      if (business.tmdbId !== null) {
        add('duplicate-record-external-identity', [
          'tmdb', business.tmdbMediaKind!, business.tmdbId!, business.tmdbParentId!, business.tmdbSeasonNumber!,
        ] as JsonValue, entityKey);
      }
    }
  }
  return [...groups.values()]
    .filter(group => group.keys.length > 1)
    .map(group => ({ kind: group.kind, value: group.value, entityKeys: group.keys.sort(compareEntityKeyV1) }))
    .sort((a, b) => compareTextBytes(a.kind, b.kind)
      || compareTextBytes(canonicalizeJcs(a.value), canonicalizeJcs(b.value)));
}

function expectedChangedFields(
  mutation: CommitMutationV1,
  base: MaterializedEntityV1,
  resolution: boolean,
): string[] {
  if (mutation.operation === 'tombstone') return ['$tombstone'];
  const next = canonicalSemanticValue(mutation.value);
  const order = BUSINESS_FIELD_ORDER[mutation.entityKey[0]];
  if (base.state === 'Resolved' && base.semanticState.state === 'live') {
    const prior = base.semanticState.value;
    return order.filter(field => canonicalizeJcs(prior[field]!) !== canonicalizeJcs(next[field]!));
  }
  if (base.state === 'Conflict' && !resolution) invalid('ordinary_mutation_blocked_by_entity_conflict');
  return [...order];
}

function assertCanonicalChangedFields(
  mutation: CommitMutationV1,
  expected: readonly string[],
  resolution: boolean,
): void {
  if (mutation.changedFields.length !== expected.length
    || mutation.changedFields.some((field, index) => field !== expected[index])) invalid('invalid_changed_fields');
  if (mutation.operation === 'upsert' && expected.length === 0 && !resolution) invalid('metadata_only_mutation');
}

async function createVersion(commit: CommitV1, mutation: CommitMutationV1): Promise<EntityVersionV1> {
  if (mutation.operation === 'upsert') await validateNativeEntity(mutation.entityKey, mutation.value);
  else await validateNativeTombstone(mutation.entityKey, mutation.value);
  const semantic = mutation.operation === 'upsert' ? canonicalSemanticValue(mutation.value) : null;
  return {
    entityKey: mutation.entityKey,
    operation: mutation.operation,
    fullValue: mutation.value,
    semanticState: semantic === null ? { state: 'tombstone' } : { state: 'live', value: semantic },
    canonicalSemanticValue: semantic,
    changedFields: [...mutation.changedFields],
    baseFrontier: [...mutation.baseFrontier],
    commitRef: commitRef(commit),
    commitDot: {
      writerId: commit.writerId, writerSeq: commit.writerSeq, commitId: commit.commitId,
    },
    causalBasis: [...commit.basisClock],
  };
}

function isResolvedLive(value: MaterializedEntityV1 | undefined): value is Extract<MaterializedEntityV1, { state: 'Resolved' }> {
  return value?.state === 'Resolved' && value.semanticState.state === 'live';
}

function recordSupportsEpisode(value: { [key: string]: JsonValue }, episodeValue: JsonValue): boolean {
  const episode = extractSafeIntegerV1(episodeValue, 1, 2_147_483_647);
  const total = value.totalEpisodes === null
    ? null
    : extractSafeIntegerV1(value.totalEpisodes, 1, 2_147_483_647);
  return value.mediaType !== '电影' && total !== null && episode <= total;
}

async function validateAuthorReferences(
  candidates: readonly EntityVersionV1[],
  basisMaterialized: readonly { entityKey: EntityKey; value: MaterializedEntityV1 }[],
): Promise<void> {
  const basis = materializedMap(basisMaterialized);
  const batch = new Map(candidates.map(version => [entityKeyId(version.entityKey), version]));
  const liveValue = (key: EntityKey): { [key: string]: JsonValue } | undefined => {
    const inBatch = batch.get(entityKeyId(key));
    if (inBatch !== undefined) {
      return inBatch.semanticState.state === 'live' ? inBatch.semanticState.value : undefined;
    }
    const prior = basis.get(entityKeyId(key));
    return isResolvedLive(prior) ? prior.businessValue! : undefined;
  };
  for (const version of candidates) {
    if (version.operation !== 'upsert') continue;
    const key = version.entityKey;
    if (key[0] === 'episode-completion') {
      const parent = liveValue(['record', key[1]]);
      if (parent === undefined || !recordSupportsEpisode(parent, key[2])) invalid('invalid_episode_parent_basis');
    } else if (key[0] === 'collection-member') {
      if (liveValue(['collection', key[1]]) === undefined || liveValue(['record', key[2]]) === undefined) {
        invalid('invalid_member_parent_basis');
      }
    }
  }
}

export function validateEntityResolutionV1(
  commit: CommitV1,
  basisMaterialized: readonly { entityKey: EntityKey; value: MaterializedEntityV1 }[],
  candidates: readonly EntityVersionV1[],
): EntityKey[] {
  if (commit.commitKind !== 'resolution' || commit.source.type !== 'manual-resolution') {
    invalid('invalid_resolution_commit');
  }
  const byKey = materializedMap(basisMaterialized);
  const participants = new Map<string, EntityKey>();
  for (const candidate of candidates) {
    const current = byKey.get(entityKeyId(candidate.entityKey));
    if (current?.state !== 'Conflict') continue;
    if (!commit.resolves.includes(current.conflictId)) invalid('incomplete_entity_resolution');
    participants.set(entityKeyId(candidate.entityKey), candidate.entityKey);
  }
  return [...participants.values()].sort(compareEntityKeyV1);
}

function sameRelationIdentity(a: RelationConflictV1, b: RelationConflictV1): boolean {
  return a.core.relationKind === b.core.relationKind
    && a.core.entityKeys.length === b.core.entityKeys.length
    && a.core.entityKeys.every((key, index) => compareEntityKeyV1(key, b.core.entityKeys[index]!) === 0);
}

export function validateRelationResolutionV1(
  commit: CommitV1,
  basisRelations: RelationDetectionV1,
  candidates: readonly EntityVersionV1[],
  afterRelations: RelationDetectionV1,
): EntityKey[] {
  if (commit.commitKind !== 'resolution' || commit.source.type !== 'manual-resolution') {
    invalid('invalid_resolution_commit');
  }
  const targeted = basisRelations.conflicts.filter(item => commit.resolves.includes(item.relationConflictId));
  const postIds = new Set(afterRelations.conflicts.map(item => item.relationConflictId));
  if (basisRelations.conflicts.some(item => (
    !postIds.has(item.relationConflictId) && !commit.resolves.includes(item.relationConflictId)
  ))) invalid('incomplete_relation_resolution');
  const participants = new Map<string, EntityKey>();
  for (const relation of targeted) {
    for (const key of relation.core.entityKeys) {
      participants.set(entityKeyId(key), key);
      if (!candidates.some(version => compareEntityKeyV1(version.entityKey, key) === 0)) {
        invalid('incomplete_relation_resolution');
      }
    }
  }
  if (afterRelations.conflicts.some(after => targeted.some(target => sameRelationIdentity(after, target)))) {
    invalid('incomplete_relation_resolution');
  }
  return [...participants.values()].sort(compareEntityKeyV1);
}

async function validateHistoricalCommit(
  commit: CommitV1,
  verifiedCommits: ReadonlyMap<string, CommitV1>,
  priorVersions: readonly EntityVersionV1[],
): Promise<EntityVersionV1[]> {
  const isExplicitResolution = commit.commitKind === 'resolution';
  validateWriterChainLinkV1(commit, verifiedCommits);
  const visibleKeys = ancestorRefKeys(commit.basisClock, verifiedCommits);
  const basisVersions = priorVersions.filter(version => visibleKeys.has(exactRefKey(version.commitRef)));
  const basisMaterialized = await materializeVisibleEntities(basisVersions, verifiedCommits);
  const basisByKey = materializedMap(basisMaterialized);
  const relations = await detectWatchTrackerRelationsV1(basisMaterialized);
  const relationIds = new Set(relations.conflicts.map(item => item.relationConflictId));
  const candidates: EntityVersionV1[] = [];
  const entityConflictIds = new Set<string>();
  const resolutionParticipantKeys = new Map<string, EntityKey>();

  for (const mutation of commit.mutations) {
    const expected = expectedEntityFrontierV1(mutation.entityKey, commit.basisClock, priorVersions, verifiedCommits);
    if (!sameRefSet(mutation.baseFrontier, expected.map(version => version.commitRef))) {
      invalid('invalid_entity_base_frontier');
    }
    const base = basisByKey.get(entityKeyId(mutation.entityKey)) ?? { state: 'Absent' };
    if (!isExplicitResolution && base.state === 'Conflict') {
      invalid('ordinary_mutation_blocked_by_entity_conflict');
    }
    if (!isExplicitResolution && relations.conflicts.some(relation => (
      relation.core.entityKeys.some(key => compareEntityKeyV1(key, mutation.entityKey) === 0)
    ))) invalid('ordinary_mutation_blocked_by_relation_conflict');
    if (base.state === 'Conflict') {
      entityConflictIds.add(base.conflictId);
      resolutionParticipantKeys.set(entityKeyId(mutation.entityKey), mutation.entityKey);
    }
    const expectedFields = expectedChangedFields(mutation, base, isExplicitResolution);
    assertCanonicalChangedFields(mutation, expectedFields, isExplicitResolution);
    const candidate = await createVersion(commit, mutation);
    if (!isExplicitResolution && mutation.entityKey[0] === 'record'
      && isResolvedLive(base) && base.businessValue?.isLocked === true) {
      if (candidate.operation !== 'upsert' || candidate.semanticState.state !== 'live'
        || candidate.changedFields.length !== 1 || candidate.changedFields[0] !== 'isLocked'
        || candidate.semanticState.value.isLocked !== false) invalid('ordinary_mutation_blocked_by_lock');
    }
    candidates.push(candidate);
  }

  await validateAuthorReferences(candidates, basisMaterialized);
  if (commit.commitKind === 'resolution') {
    const currentTargets = new Set([...entityConflictIds, ...relationIds]);
    if (commit.resolves.some(id => !currentTargets.has(id))) invalid('stale_resolution');
    const simulatedCommits = new Map(verifiedCommits);
    simulatedCommits.set(exactRefKey(commitRef(commit)), commit);
    // Historical resolution validity is evaluated only against the author's verified basis.
    // A concurrently discovered version outside that basis must remain a late alternative,
    // never retroactively invalidate this resolution.
    const simulatedVersions = [...basisVersions, ...candidates];
    const afterMaterialized = await materializeVisibleEntities(simulatedVersions, simulatedCommits);
    const afterRelations = await detectWatchTrackerRelationsV1(afterMaterialized);
    for (const key of validateEntityResolutionV1(commit, basisMaterialized, candidates)) {
      resolutionParticipantKeys.set(entityKeyId(key), key);
    }
    for (const key of validateRelationResolutionV1(commit, relations, candidates, afterRelations)) {
      resolutionParticipantKeys.set(entityKeyId(key), key);
    }
    if (candidates.some(version => !resolutionParticipantKeys.has(entityKeyId(version.entityKey)))) {
      invalid('invalid_resolution_composition');
    }
  }
  return candidates;
}

export async function replayVerifiedHistoryV1(input: readonly CommitV1[]): Promise<VerifiedReplayV1> {
  const commits = [...input];
  const validity = new Map<string, HistoricalValidity>();
  const structurallyValid = new Map<string, CommitV1>();
  const inputGroups = new Map<string, CommitV1[]>();
  for (const commit of commits) {
    const key = exactRefKey(commitRef(commit));
    const group = inputGroups.get(key) ?? [];
    group.push(commit);
    inputGroups.set(key, group);
  }
  for (const [key, group] of inputGroups) {
    const commit = group[0]!;
    try {
      const representations = new Set(group.map(candidate => (
        canonicalizeJcs(candidate as unknown as JsonValue)
      )));
      if (representations.size !== 1) {
        validity.set(key, { state: 'INVALID', error: 'duplicate_commit_ref' });
        continue;
      }
      validateCommitEnvelopeV1(commit);
      structurallyValid.set(key, commit);
      validity.set(key, { state: 'PENDING' });
    } catch (error) {
      validity.set(key, {
        state: 'INVALID',
        error: error instanceof S2ProtocolValidationError ? error.code : 'invalid_commit_envelope',
      });
    }
  }
  const verifiedCommits = new Map<string, CommitV1>();
  const versions: EntityVersionV1[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    const pending = [...structurallyValid.entries()]
      .filter(([key]) => validity.get(key)?.state === 'PENDING')
      .sort(([a], [b]) => compareTextBytes(a, b));
    for (const [key, commit] of pending) {
      const dependencies = dependencyRefs(commit).map(exactRefKey);
      if (dependencies.some(ref => validity.get(ref)?.state === 'INVALID')) {
        validity.set(key, { state: 'INVALID', error: 'invalid_causal_dependency' });
        progressed = true;
        continue;
      }
      if (dependencies.some(ref => !validity.has(ref))) continue;
      if (dependencies.some(ref => validity.get(ref)?.state !== 'VALID')) continue;
      try {
        const produced = await validateHistoricalCommit(commit, verifiedCommits, versions);
        verifiedCommits.set(key, commit);
        versions.push(...produced);
        validity.set(key, { state: 'VALID' });
      } catch (error) {
        validity.set(key, {
          state: 'INVALID',
          error: error instanceof S2ProtocolValidationError ? error.code : 'invalid_commit',
        });
      }
      progressed = true;
    }
  }
  for (const key of pendingCycleKeys(structurallyValid, validity)) {
    validity.set(key, { state: 'INVALID', error: 'causal_cycle' });
  }
  let invalidPropagated = true;
  while (invalidPropagated) {
    invalidPropagated = false;
    for (const [key, commit] of structurallyValid) {
      if (validity.get(key)?.state === 'PENDING'
        && dependencyRefs(commit).some(ref => validity.get(exactRefKey(ref))?.state === 'INVALID')) {
        validity.set(key, { state: 'INVALID', error: 'invalid_causal_dependency' });
        invalidPropagated = true;
      }
    }
  }

  const forks = detectWriterForksV1(commits);
  const unsafeKeys = unsafeCommitKeys(forks, verifiedCommits);
  const safeCommits = new Map([...verifiedCommits].filter(([key]) => !unsafeKeys.has(key)));
  const forensicVersions = [...versions].sort((a, b) => compareEntityKeyV1(a.entityKey, b.entityKey)
    || compareCommitRefV1(a.commitRef, b.commitRef));
  const safeVersions = forensicVersions.filter(version => !unsafeKeys.has(exactRefKey(version.commitRef)));
  const materialized = await materializeVisibleEntities(safeVersions, safeCommits);
  const frontiers = materialized.map(({ entityKey }) => ({
    entityKey,
    frontier: computeEntityFrontierV1(
      safeVersions.filter(version => compareEntityKeyV1(version.entityKey, entityKey) === 0),
      safeCommits,
    ).map(version => version.commitRef),
  }));
  const validityOutput = [...inputGroups.values()].map(group => commitRef(group[0]!)).map(reference => ({
    commitRef: reference,
    validity: validity.get(exactRefKey(reference)) ?? { state: 'INVALID', error: 'invalid_commit' } as HistoricalValidity,
  })).sort((a, b) => compareTextBytes(exactRefKey(a.commitRef), exactRefKey(b.commitRef)));
  return {
    validity: validityOutput,
    forks,
    unsafeCommitRefs: [...unsafeKeys].map(key => commitRef(
      verifiedCommits.get(key) ?? commits.find(commit => exactRefKey(commitRef(commit)) === key)!,
    )).sort(compareCommitRefV1),
    forensicVersions,
    versions: safeVersions,
    frontiers,
    materialized,
    relations: await detectWatchTrackerRelationsV1(materialized),
    duplicateDiagnostics: detectDuplicateDiagnosticsV1(materialized),
  };
}

export function canonicalEntityKeyHexV1(key: EntityKey): string {
  return [...canonicalEntityKeyBytes(key)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
