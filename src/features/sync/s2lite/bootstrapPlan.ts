import {
  compareEntityKeyV1,
  S2ProtocolValidationError,
  validateEntityKey,
} from './canonical.ts';
import { validateNativeEntity } from './semanticProfile.ts';
import type { BootstrapEntity, BootstrapPlan, EntityKey, EntityType } from './types.ts';

export const MAX_BOOTSTRAP_MUTATIONS_PER_COMMIT = 256;

const RANK: Readonly<Record<EntityType, number>> = {
  record: 0,
  collection: 1,
  'episode-completion': 2,
  'collection-member': 3,
};

function invalid(code: string): never {
  throw new S2ProtocolValidationError(code);
}

function sameKey(a: EntityKey, b: EntityKey): boolean {
  return compareEntityKeyV1(a, b) === 0;
}

function chunks(values: readonly BootstrapEntity[]): BootstrapEntity[][] {
  const result: BootstrapEntity[][] = [];
  for (let index = 0; index < values.length; index += MAX_BOOTSTRAP_MUTATIONS_PER_COMMIT) {
    result.push(values.slice(index, index + MAX_BOOTSTRAP_MUTATIONS_PER_COMMIT));
  }
  return result;
}

async function validateBootstrapEntity(entity: BootstrapEntity): Promise<void> {
  validateEntityKey(entity.entityKey);
  if (!Object.prototype.hasOwnProperty.call(RANK, entity.entityType)) invalid('invalid_entity_type');
  if (entity.entityKey[0] !== entity.entityType) invalid('bootstrap_entity_type_mismatch');
  await validateNativeEntity(entity.entityKey, entity.value);
}

export async function buildBootstrapPlanV1(input: readonly BootstrapEntity[]): Promise<BootstrapPlan> {
  const values = [...input];
  for (const value of values) await validateBootstrapEntity(value);
  values.sort((a, b) => RANK[a.entityType] - RANK[b.entityType] || compareEntityKeyV1(a.entityKey, b.entityKey));
  for (let index = 1; index < values.length; index += 1) {
    if (sameKey(values[index - 1]!.entityKey, values[index]!.entityKey)) invalid('duplicate_bootstrap_entity_key');
  }

  const records = new Map(values
    .filter(value => value.entityType === 'record')
    .map(value => [value.entityKey[1] as string, value]));
  const collections = new Set(values.filter(value => value.entityType === 'collection').map(value => value.entityKey[1] as string));
  for (const value of values) {
    if (value.entityType === 'episode-completion') {
      const parent = records.get(value.entityKey[1] as string);
      const record = parent?.value as Record<string, unknown> | undefined;
      const episodeNumber = value.entityKey[2] as number;
      if (!parent || record?.mediaType === '电影' || record?.totalEpisodes === null
        || typeof record?.totalEpisodes !== 'number' || episodeNumber > record.totalEpisodes) {
        invalid('invalid_bootstrap_dependency_graph');
      }
    }
    if (value.entityType === 'collection-member') {
      if (!collections.has(value.entityKey[1] as string) || !records.has(value.entityKey[2] as string)) {
        invalid('invalid_bootstrap_dependency_graph');
      }
    }
  }

  const stageAOrderedMutations = values.filter(value => RANK[value.entityType] <= 1);
  const stageBOrderedMutations = values.filter(value => RANK[value.entityType] >= 2);
  return {
    stageAOrderedMutations,
    stageAChunks: chunks(stageAOrderedMutations),
    stageBOrderedMutations,
    stageBChunks: chunks(stageBOrderedMutations),
  };
}

export function bootstrapAssignment(plan: BootstrapPlan): string[] {
  const encode = (stage: string, stageChunks: readonly BootstrapEntity[][]): string[] => stageChunks.flatMap(
    (chunk, chunkIndex) => chunk.map(entity => `${stage}:${chunkIndex}:${JSON.stringify(entity.entityKey)}`),
  );
  return [...encode('A', plan.stageAChunks), ...encode('B', plan.stageBChunks)];
}
