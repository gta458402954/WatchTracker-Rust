import type {
  DesktopSyncCoordinatorResultV1,
  LegacyRouteTicketV1,
} from '../../../shared/lib/database.ts';
import type { SyncCoordinatorOutcome, SyncResult } from './syncContracts.ts';

export interface DesktopCoordinatorDependencies {
  runCoordinator: (completedLegacyRoute: LegacyRouteTicketV1 | null) => Promise<DesktopSyncCoordinatorResultV1>;
  runLegacyS1Cycle: (ticket: LegacyRouteTicketV1) => Promise<SyncResult>;
}

function isGuardedLegacyRejection(result: SyncResult): boolean {
  return !result.ok && /s2_legacy_route_(target_changed|root_frozen|not_admitted)/.test(result.error ?? '');
}

function terminalResult(
  kind: Exclude<DesktopSyncCoordinatorResultV1['kind'], 'legacyS1Required'>,
): SyncResult {
  const results: Record<typeof kind, { ok: boolean; outcome: SyncCoordinatorOutcome; error?: string }> = {
    success: { ok: true, outcome: 'success' },
    pending: { ok: false, outcome: 'pending', error: 's2_pending' },
    remoteIndeterminate: { ok: false, outcome: 'remote-indeterminate', error: 's2_remote_indeterminate' },
    remoteAuthOrCapabilityBlocked: { ok: false, outcome: 'remote-auth-or-capability-blocked', error: 's2_remote_auth_or_capability_blocked' },
    conflicts: { ok: true, outcome: 'conflicts' },
    targetChanged: { ok: false, outcome: 'target-changed', error: 's2_target_changed' },
    readOnlyFrozen: { ok: false, outcome: 'read-only-frozen', error: 's2_read_only_frozen' },
    internalFailure: { ok: false, outcome: 'internal-failure', error: 's2_internal_failure' },
    automaticSkipped: { ok: true, outcome: 'automatic-skipped' },
  };
  const result = results[kind];
  return { ok: result.ok, coordinatorOutcome: result.outcome, error: result.error };
}

/**
 * Thin production handoff: Rust selects the route and TypeScript only carries
 * the opaque one-cycle ticket through legacy S1 writes. It never retries a
 * returned legacy route on its own.
 */
export async function runDesktopCoordinatorHandoff(
  dependencies: DesktopCoordinatorDependencies,
): Promise<SyncResult> {
  const initial = await dependencies.runCoordinator(null);
  if (initial.kind !== 'legacyS1Required') return terminalResult(initial.kind);

  const legacy = await dependencies.runLegacyS1Cycle(initial.ticket);
  if (!legacy.ok) {
    // A guarded S1 write may observe a target switch, cutover, or root fatal
    // after the ticket was issued. Rust owns the classification; ask it once
    // for the fresh route and never repeat the legacy cycle from TypeScript.
    if (!isGuardedLegacyRejection(legacy)) return legacy;
    const rerouted = await dependencies.runCoordinator(initial.ticket);
    if (rerouted.kind === 'legacyS1Required') {
      return {
        ok: false,
        error: 's2_legacy_s1_required',
        coordinatorOutcome: 'legacy-s1-required',
      };
    }
    return terminalResult(rerouted.kind);
  }

  let afterLegacy: DesktopSyncCoordinatorResultV1;
  try {
    afterLegacy = await dependencies.runCoordinator(initial.ticket);
  } catch {
    return {
      ...terminalResult('internalFailure'),
      reloadRecords: true,
    };
  }
  if (afterLegacy.kind === 'legacyS1Required') {
    return {
      ok: false,
      error: 's2_legacy_s1_required',
      coordinatorOutcome: 'legacy-s1-required',
      reloadRecords: true,
    };
  }
  return { ...legacy, ...terminalResult(afterLegacy.kind), reloadRecords: true };
}
