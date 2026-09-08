import type { CommitDot, CommitRef, EntityKey, JsonValue } from './types.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSIGNED_DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const SIGNED_DECIMAL_RE = /^-?(0|[1-9][0-9]*)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const S2_WS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);
const U64_MAX = 18_446_744_073_709_551_615n;
const I64_MIN = -9_223_372_036_854_775_808n;
const I64_MAX = 9_223_372_036_854_775_807n;

export class S2ProtocolValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'S2ProtocolValidationError';
  }
}

function invalid(code: string): never {
  throw new S2ProtocolValidationError(code);
}

export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function validateUnicodeScalarString(value: unknown, code = 'invalid_string'): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0') || hasLoneSurrogate(value)) invalid(code);
}

export function unicodeScalarLength(value: string): number {
  return [...value].length;
}

export function hasBoundaryS2Whitespace(value: string): boolean {
  if (value.length === 0) return false;
  const first = value.codePointAt(0);
  const last = value.codePointAt(value.length - 1);
  return (first !== undefined && S2_WS.has(first)) || (last !== undefined && S2_WS.has(last));
}

function compareUtf16(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);
    if (difference !== 0) return Math.sign(difference);
  }
  return Math.sign(a.length - b.length);
}

export function canonicalizeJcs(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    validateUnicodeScalarString(value, 'jcs_invalid_string');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('jcs_non_finite_number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) invalid('jcs_sparse_array');
      items.push(canonicalizeJcs(value[index]!));
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value !== 'object') return invalid('jcs_unsupported_value');

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid('jcs_non_plain_object');
  if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) invalid('jcs_unsupported_value');
  const keys = Object.keys(value).sort(compareUtf16);
  return `{${keys.map(key => `${canonicalizeJcs(key)}:${canonicalizeJcs(value[key]!)}`).join(',')}}`;
}

export function canonicalJcsBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalizeJcs(value));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const exactBytes = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', exactBytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Jcs(value: JsonValue): Promise<string> {
  return sha256Hex(canonicalJcsBytes(value));
}

export function validateCanonicalUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) invalid('invalid_canonical_uuid');
}

export function validateCanonicalUuidV4(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_V4_RE.test(value)) invalid('invalid_canonical_uuid_v4');
}

export function validateContentHash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) invalid('invalid_content_hash');
}

export function parseWriterSeq(value: unknown): bigint {
  if (typeof value !== 'string' || !UNSIGNED_DECIMAL_RE.test(value)) return invalid('invalid_writer_seq');
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > U64_MAX) return invalid('invalid_writer_seq');
  return parsed;
}

export function parseInt64DecimalString(
  value: unknown,
  minimum = I64_MIN,
  maximum = I64_MAX,
): bigint {
  if (typeof value !== 'string' || !SIGNED_DECIMAL_RE.test(value) || value === '-0') {
    return invalid('invalid_int64_decimal_string');
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > maximum) return invalid('int64_out_of_range');
  return parsed;
}

export function validateSafeInteger(value: unknown, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid('invalid_safe_integer');
  }
}

export function extractSafeIntegerV1(value: unknown, minimum: number, maximum: number): number {
  validateSafeInteger(value, minimum, maximum);
  return value;
}

export function validateFloat64(value: unknown, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid('invalid_float64');
  }
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validDateParts(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

export function validateCanonicalDate(value: unknown): asserts value is string {
  if (typeof value !== 'string') invalid('invalid_date');
  const match = DATE_RE.exec(value);
  if (!match || !validDateParts(Number(match[1]), Number(match[2]), Number(match[3]))) invalid('invalid_date');
}

export function validateCanonicalTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string') invalid('invalid_timestamp');
  const match = TIMESTAMP_RE.exec(value);
  if (!match || !validDateParts(Number(match[1]), Number(match[2]), Number(match[3]))) {
    invalid('invalid_timestamp');
  }
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) invalid('invalid_timestamp');
}

export function normalizeCollectionNameV1(value: string): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    result += codePoint >= 0x41 && codePoint <= 0x5a
      ? String.fromCodePoint(codePoint + 0x20)
      : character;
  }
  return result;
}

export function canonicalCollectionNameV1(value: unknown): string {
  validateUnicodeScalarString(value, 'invalid_collection_name');
  let output = '';
  let pendingSpace = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (S2_WS.has(codePoint)) {
      if (output.length > 0) pendingSpace = true;
      continue;
    }
    if ((codePoint >= 0 && codePoint <= 0x1f) || codePoint === 0x7f) {
      invalid('invalid_collection_name');
    }
    if (pendingSpace) {
      output += ' ';
      pendingSpace = false;
    }
    output += character;
  }
  if (unicodeScalarLength(output) < 1 || unicodeScalarLength(output) > 80) invalid('invalid_collection_name');
  return output;
}

function compareAscii(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);
    if (difference !== 0) return Math.sign(difference);
  }
  return Math.sign(a.length - b.length);
}

export function compareCommitDotV1(a: CommitDot, b: CommitDot): number {
  let comparison = compareAscii(a.writerId, b.writerId);
  if (comparison !== 0) return comparison;
  const aSeq = parseWriterSeq(a.writerSeq);
  const bSeq = parseWriterSeq(b.writerSeq);
  comparison = aSeq < bSeq ? -1 : aSeq > bSeq ? 1 : 0;
  return comparison || compareAscii(a.commitId, b.commitId);
}

export function compareCommitRefV1(a: CommitRef, b: CommitRef): number {
  const dotComparison = compareCommitDotV1(a, b);
  return dotComparison || compareAscii(a.contentHash, b.contentHash);
}

export function compareUnsignedBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return Math.sign(a.length - b.length);
}

export function canonicalEntityKeyBytes(key: EntityKey): Uint8Array {
  return canonicalJcsBytes(key as unknown as JsonValue);
}

export function compareEntityKeyV1(a: EntityKey, b: EntityKey): number {
  return compareUnsignedBytes(canonicalEntityKeyBytes(a), canonicalEntityKeyBytes(b));
}

function validateIdentityPart(value: unknown): void {
  validateUnicodeScalarString(value, 'invalid_entity_key');
  if (value.length === 0 || unicodeScalarLength(value) > 512 || hasBoundaryS2Whitespace(value)) {
    invalid('invalid_entity_key');
  }
}

export function validateEntityKey(value: unknown): asserts value is EntityKey {
  if (!Array.isArray(value) || typeof value[0] !== 'string') invalid('invalid_entity_key');
  if (value[0] === 'record' || value[0] === 'collection') {
    if (value.length !== 2) invalid('invalid_entity_key');
    validateIdentityPart(value[1]);
  } else if (value[0] === 'episode-completion') {
    if (value.length !== 3) invalid('invalid_entity_key');
    validateIdentityPart(value[1]);
    validateSafeInteger(value[2], 1, 2_147_483_647);
  } else if (value[0] === 'collection-member') {
    if (value.length !== 3) invalid('invalid_entity_key');
    validateIdentityPart(value[1]);
    validateIdentityPart(value[2]);
  } else {
    invalid('invalid_entity_key');
  }
}

function hasExactObjectFields(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((field, index) => field === sortedExpected[index]);
}

export function validateCommitDot(dot: CommitDot): void {
  if (!hasExactObjectFields(dot, ['writerId', 'writerSeq', 'commitId'])) invalid('invalid_commit_dot');
  validateCanonicalUuidV4(dot.writerId);
  parseWriterSeq(dot.writerSeq);
  validateCanonicalUuidV4(dot.commitId);
}

export function validateCommitRef(ref: CommitRef): void {
  if (!hasExactObjectFields(ref, ['writerId', 'writerSeq', 'commitId', 'contentHash'])) {
    invalid('invalid_commit_ref');
  }
  validateCanonicalUuidV4(ref.writerId);
  parseWriterSeq(ref.writerSeq);
  validateCanonicalUuidV4(ref.commitId);
  validateContentHash(ref.contentHash);
}

export const INT64_MIN = I64_MIN;
export const INT64_MAX = I64_MAX;
export const UINT64_MAX = U64_MAX;
