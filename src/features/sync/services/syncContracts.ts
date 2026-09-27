import type { WatchRecord } from '../../../shared/types';
import type { SyncConflictV3 } from '../../../shared/lib/syncMerge';

export type SyncCoordinatorOutcome =
  | 'success'
  | 'pending'
  | 'remote-indeterminate'
  | 'remote-auth-or-capability-blocked'
  | 'conflicts'
  | 'target-changed'
  | 'read-only-frozen'
  | 'internal-failure'
  | 'legacy-s1-required';

export interface SyncResult {
  ok: boolean;
  error?: string;
  records?: WatchRecord[];
  conflictCount?: number;
  conflicts?: SyncConflictV3[];
  staleLocal?: boolean;
  legacyImported?: boolean;
  coordinatorOutcome?: SyncCoordinatorOutcome;
  /** A completed guarded S1 cycle changed local state before a later S2 terminal. */
  reloadRecords?: boolean;
}
