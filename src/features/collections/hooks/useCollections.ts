import { useCallback, useState } from 'react';
import type { CollectionMember, WatchCollection } from '../../../shared/types';
import {
  addCollectionMembers,
  createCollection,
  createCollectionForRecord,
  deleteCollection,
  getCollectionMembers,
  getCollections,
  removeCollectionMember,
  reorderCollectionMembers,
  updateCollection,
} from '../../../shared/lib/database';

export function useCollections() {
  const [collections, setCollections] = useState<WatchCollection[]>([]);
  const [members, setMembers] = useState<CollectionMember[]>([]);

  const refresh = useCallback(async () => {
    const [nextCollections, nextMembers] = await Promise.all([getCollections(), getCollectionMembers()]);
    setCollections(nextCollections);
    setMembers(nextMembers);
    return { collections: nextCollections, members: nextMembers };
  }, []);

  const create = useCallback(async (name: string, description: string | null = null, collectionKind: WatchCollection['collectionKind'] = 'manual') => {
    const value = await createCollection({ name, description, sourceKind: 'manual', sourceKey: null, collectionKind, orderMode: collectionKind === 'manual' ? 'manual' : 'chronological' });
    await refresh();
    return value;
  }, [refresh]);

  const createForRecord = useCallback(async (name: string, description: string | null, collectionKind: WatchCollection['collectionKind'], recordId: string) => {
    const value = await createCollectionForRecord({ name, description, sourceKind: 'manual', sourceKey: null, collectionKind, orderMode: collectionKind === 'manual' ? 'manual' : 'chronological' }, recordId);
    await refresh();
    return value;
  }, [refresh]);

  const update = useCallback(async (collection: WatchCollection, name: string, description: string | null) => {
    const value = await updateCollection(collection.id, { name, description, expectedRev: collection.rev });
    await refresh();
    return value;
  }, [refresh]);

  const setOrderMode = useCallback(async (collection: WatchCollection, orderMode: WatchCollection['orderMode']) => {
    const value = await updateCollection(collection.id, { name: collection.name, description: collection.description, expectedRev: collection.rev, orderMode });
    await refresh();
    return value;
  }, [refresh]);

  const bindSource = useCallback(async (collection: WatchCollection, sourceKind: WatchCollection['sourceKind'], sourceKey: string, collectionKind: WatchCollection['collectionKind']) => {
    const value = await updateCollection(collection.id, { name: collection.name, description: collection.description, expectedRev: collection.rev, sourceKind, sourceKey, collectionKind, orderMode: 'chronological' });
    await refresh();
    return value;
  }, [refresh]);

  const remove = useCallback(async (collection: WatchCollection) => {
    await deleteCollection(collection.id, collection.rev);
    await refresh();
  }, [refresh]);

  const addMembers = useCallback(async (collection: WatchCollection, recordIds: string[]) => {
    await addCollectionMembers(collection.id, recordIds, collection.rev);
    await refresh();
  }, [refresh]);

  const removeMember = useCallback(async (member: CollectionMember) => {
    await removeCollectionMember(member.collectionId, member.recordId, member.rev);
    await refresh();
  }, [refresh]);

  const reorder = useCallback(async (collection: WatchCollection, recordIds: string[]) => {
    await reorderCollectionMembers(collection.id, recordIds, collection.rev);
    await refresh();
  }, [refresh]);

  const applySuggestion = useCallback(async (name: string, sourceKind: 'tmdb-movie-collection' | 'tmdb-tv-show', sourceKey: string, recordIds: string[]) => {
    let collection = collections.find(item => item.sourceKey === sourceKey);
    if (!collection) collection = await createCollection({ name, description: null, sourceKind, sourceKey });
    await addCollectionMembers(collection.id, recordIds, collection.rev, 'tmdb');
    await refresh();
  }, [collections, refresh]);

  return { collections, members, refresh, create, createForRecord, update, setOrderMode, bindSource, remove, addMembers, removeMember, reorder, applySuggestion };
}
