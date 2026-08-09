import { useCallback, useState } from 'react';
import type { CollectionMember, WatchCollection } from '../../../shared/types';
import {
  addCollectionMembers,
  createCollection,
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

  const create = useCallback(async (name: string, description: string | null = null) => {
    const value = await createCollection({ name, description, sourceKind: 'manual', sourceKey: null });
    await refresh();
    return value;
  }, [refresh]);

  const update = useCallback(async (collection: WatchCollection, name: string, description: string | null) => {
    const value = await updateCollection(collection.id, { name, description, expectedRev: collection.rev });
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

  return { collections, members, refresh, create, update, remove, addMembers, removeMember, reorder, applySuggestion };
}
