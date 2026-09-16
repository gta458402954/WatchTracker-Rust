import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  coalesceOrdinaryPayloadsV1,
  mapOrdinaryMutationV1,
  sortOrdinaryMutationsV1,
} from '../../../features/sync/s2lite/ordinaryMutationProfile.ts';
import {
  canonicalSemanticValue,
  validateNativeEntity,
} from '../../../features/sync/s2lite/semanticProfile.ts';

const fixture = JSON.parse(readFileSync(
  new URL('../../../../contracts/s2-lite/v1/ordinary-mutation-semantic-golden-v1.json', import.meta.url),
  'utf8',
));

function typedEntity(raw) {
  const value = structuredClone(raw.value);
  value.rev = BigInt(value.rev);
  if (raw.entityType === 'record') {
    if (value.tmdbId !== null) value.tmdbId = BigInt(value.tmdbId);
    if (value.tmdbParentId !== null) value.tmdbParentId = BigInt(value.tmdbParentId);
  } else if (raw.entityType === 'collection-member') {
    value.position = BigInt(value.position);
  }
  return { entityType: raw.entityType, value };
}

function typedDelete(raw) {
  return { ...structuredClone(raw), rev: BigInt(raw.rev) };
}

function wireValue(raw) {
  return structuredClone(raw.value);
}

function wireDelete(raw) {
  const { entityType: _entityType, ...value } = structuredClone(raw);
  return value;
}

function expandRefs(names) {
  return names.map(name => structuredClone(fixture.refs[name]));
}

function makeRequest(vector) {
  const input = vector.input;
  const payload = input.payload.operation === 'upsert'
    ? { operation: 'upsert', entity: typedEntity(fixture.localValues[input.payload.localValueRef]) }
    : { operation: 'tombstone', deleteDescriptor: typedDelete(fixture.deleteDescriptors[input.payload.deleteDescriptorRef]) };
  const causalBase = input.causalBase.state === 'live'
    ? { state: 'live', value: canonicalSemanticValue(wireValue(fixture.localValues[input.causalBase.valueRef])) }
    : { state: input.causalBase.state };
  return {
    localMutationId: input.localMutationId,
    payload,
    causalBase,
    baseFrontier: expandRefs(input.baseFrontier),
  };
}

function expected(vector) {
  if (vector.expected === null) return null;
  const result = vector.expected;
  const value = result.valueRef
    ? wireValue(fixture.localValues[result.valueRef])
    : wireDelete(fixture.deleteDescriptors[result.deleteDescriptorRef]);
  return {
    localMutationId: vector.input.localMutationId,
    entityType: result.entityType,
    entityKey: result.entityKey,
    operation: result.operation,
    value,
    baseFrontier: expandRefs(result.baseFrontier),
    changedFields: result.changedFields,
  };
}

test('shared ordinary mutation semantic vectors match before hashing', async () => {
  assert.equal(fixture.cases.length, 13);
  for (const vector of fixture.cases) {
    assert.deepEqual(await mapOrdinaryMutationV1(makeRequest(vector)), expected(vector), vector.name);
  }
});

test('explicit null, missing rejection, coalescing, successor IDs, and ordering are frozen', async () => {
  const record = wireValue(fixture.localValues.recordA);
  await validateNativeEntity(['record', 'r1'], record);
  delete record.updatedAt;
  await assert.rejects(validateNativeEntity(['record', 'r1'], record), { message: 'invalid_entity_fields' });

  const payloads = fixture.coalescing.inputPayloadRefs.map(name => ({
    operation: 'upsert',
    entity: typedEntity(fixture.localValues[name]),
  }));
  const coalesced = coalesceOrdinaryPayloadsV1(payloads);
  assert.equal(coalesced.length, 2);
  assert.deepEqual(coalesced.map(value => value.entity.entityType), ['collection', 'record']);
  assert.equal(coalesced[1].entity.value.notes, 'after');
  assert.notEqual(
    fixture.coalescing.postFreeze.frozenMutationId,
    fixture.coalescing.postFreeze.successorMutationId,
  );
  const partial = fixture.cases.find(vector => vector.name === 'record-partial-update');
  const frozenRequest = makeRequest(partial);
  frozenRequest.localMutationId = fixture.coalescing.postFreeze.frozenMutationId;
  const frozen = await mapOrdinaryMutationV1(frozenRequest);
  const frozenCopy = structuredClone(frozen);
  const successorRequest = makeRequest(partial);
  successorRequest.localMutationId = fixture.coalescing.postFreeze.successorMutationId;
  successorRequest.payload = payloads[0];
  successorRequest.causalBase = {
    state: 'live',
    value: canonicalSemanticValue(wireValue(fixture.localValues.recordB)),
  };
  const successor = await mapOrdinaryMutationV1(successorRequest);
  assert.notEqual(frozen.localMutationId, successor.localMutationId);
  assert.deepEqual(frozen, frozenCopy);

  const named = new Map(fixture.cases.map(vector => [vector.name, vector]));
  const mutations = [];
  for (const name of fixture.deterministicOrdering.inputCaseNames) {
    mutations.push(await mapOrdinaryMutationV1(makeRequest(named.get(name))));
  }
  sortOrdinaryMutationsV1(mutations);
  assert.deepEqual(
    mutations.map(mutation => mutation.entityKey),
    fixture.deterministicOrdering.expectedCaseNames.map(name => named.get(name).expected.entityKey),
  );
});

function fixtureFloat64(value) {
  if (value === 'NONE') return null;
  if (value === 'NON_FINITE_NAN') return Number.NaN;
  if (value === 'NON_FINITE_POS_INF') return Number.POSITIVE_INFINITY;
  if (value === 'NON_FINITE_NEG_INF') return Number.NEGATIVE_INFINITY;
  return value;
}

function recordWithRating(value) {
  const entity = typedEntity(fixture.localValues.recordA);
  entity.value.imdbRating = value;
  return entity;
}

test('shared typed Float64 cases reject non-finite values before JSON conversion', async () => {
  for (const [index, vector] of fixture.typedFloat64Cases.entries()) {
    const outgoingRating = fixtureFloat64(vector.outgoing);
    const causalBase = vector.causalBaseRating === 'ABSENT'
      ? { state: 'absent' }
      : {
        state: 'live',
        value: canonicalSemanticValue({
          ...wireValue(fixture.localValues.recordA),
          imdbRating: vector.causalBaseRating,
        }),
      };
    const request = {
      localMutationId: `30000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
      payload: { operation: 'upsert', entity: recordWithRating(outgoingRating) },
      causalBase,
      baseFrontier: vector.causalBaseRating === 'ABSENT' ? [] : [structuredClone(fixture.refs.base)],
    };
    if (vector.expectedError) {
      await assert.rejects(mapOrdinaryMutationV1(request), { message: vector.expectedError }, vector.name);
      continue;
    }
    const mutation = await mapOrdinaryMutationV1(request);
    if (vector.expected === 'VALID_NULL' || vector.expected === 'VALID_NULL_CLEAR') {
      assert.equal(mutation.value.imdbRating, null, vector.name);
    } else {
      assert.equal(mutation.value.imdbRating, outgoingRating, vector.name);
    }
    if (vector.expected === 'VALID_NULL') {
      assert.ok(mutation.changedFields.includes('imdbRating'), vector.name);
    } else {
      assert.deepEqual(mutation.changedFields, ['imdbRating'], vector.name);
    }
  }
});
