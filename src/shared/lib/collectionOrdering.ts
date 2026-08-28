import type { CollectionMember, WatchCollection } from '../types';

function timestampRank(value: string): number {
  const rank = Date.parse(value);
  return Number.isFinite(rank) ? rank : Number.NEGATIVE_INFINITY;
}

/** Orders collections by their newest currently grouped member, without treating metadata edits as grouping activity. */
export function collectionsByRecentGrouping(
  collections: WatchCollection[],
  members: CollectionMember[],
): WatchCollection[] {
  const latestMemberAt = new Map<string, number>();
  for (const member of members) {
    const rank = timestampRank(member.createdAt);
    if (rank > (latestMemberAt.get(member.collectionId) ?? Number.NEGATIVE_INFINITY)) {
      latestMemberAt.set(member.collectionId, rank);
    }
  }
  return [...collections].sort((left, right) => {
    const leftRank = latestMemberAt.get(left.id) ?? timestampRank(left.createdAt);
    const rightRank = latestMemberAt.get(right.id) ?? timestampRank(right.createdAt);
    return rightRank - leftRank
      || left.normalizedName.localeCompare(right.normalizedName)
      || left.id.localeCompare(right.id);
  });
}
