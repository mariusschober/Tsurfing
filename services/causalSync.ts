import { openDB } from 'idb';
import { CAUSAL_STORE, readCausalAccount } from './causalStorage';
import { discoverCausalCapability, prepareKnownCausalCutover, syncCausalCutover, commitCausalCutoverReceipt } from './causalEnrollment';
import { pullCausalHistory, type HistoryRuntime, type SavedCausalHistory } from './causalHistory';
import { applyDownloadedCausalHistory, orderedPendingFocus } from './causalProjection';
import { syncCausalAction } from './causalReceipts';
import { syncLocalCompletion, type CompletionAccountState } from './causalCompletionCoordinator';
import { validateCounterDayEvidence, type CounterDayAccountState } from './causalCounterDayCoordinator';
import { causalBusinessTransactionStores, readCausalBusiness } from './causalBusinessStorage';
import { normalizeSyncMeta, stableJson, type SyncMeta } from './syncProtocol';
import type { CausalOperation } from './causalProtocol';
import { initializeServerAccount } from './causalServerInitialization';
import { parseCausalInitialization } from './causalInitializationProtocol';

type State = CompletionAccountState & CounterDayAccountState & { causalHistory?: SavedCausalHistory;
  serverInitializationRequest?: string; serverInitializationReceipt?: Record<string, any> };
export type CausalQueueWork = { type: 'completion'; actionId: string } | { type: 'action'; operation: CausalOperation };
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** No timestamps order these queues. Day selection follows its local sequence;
 * focus follows its actual parent; completion also awaits business receipts. */
export function nextCausalQueueWork(accountId: string, state: State, meta: SyncMeta): CausalQueueWork | null {
  validateCounterDayEvidence(accountId, state);
  const capability = state.causalCapability;
  if (!capability?.enrolled || capability.accountId !== accountId) throw new Error('Causal enrollment is required before sending saved actions.');
  const receipts = { ...state.causalReceipts, ...state.completionReceipts };
  const days = Object.values(state.counterDayAdmissions ?? {}).filter(a => state.counterDayOutbox?.[a.command.actionId]
    && !receipts[a.command.actionId]).sort((a, b) => a.sequence - b.sequence);
  if (days.length) return { type: 'action', operation: { schemaVersion: 2, epoch: capability.epoch, type: 'counterDay', command: days[0].command } };
  for (const command of orderedPendingFocus(state, receipts)) {
    const parent = command.expectedRevision;
    if (parent && !receipts[parent] && (state.focusOutbox?.[parent] || state.completionOutbox?.[parent])) continue;
    const completion = state.completionOutbox?.[command.actionId];
    if (completion) {
      if (parent && receipts[parent]?.accepted === false) continue;
      if (Object.values(completion.dependencies).some(dependency => dependency.kind === 'completion'
        ? !dependency.actionId || state.completionReceipts?.[dependency.actionId]?.accepted !== true
        : meta.localState?.receipts[dependency.request.mutationId]?.result.accepted !== true)) continue;
      return { type: 'completion', actionId: command.actionId };
    }
    return { type: 'action', operation: { schemaVersion: 2, epoch: capability.epoch, type: 'focus', command } };
  }
  for (const [id, event] of Object.entries(state.counterOutbox ?? {})) {
    if (!same(event, state.counterEvents?.[id])) throw new Error('A pending counter differs from its immutable admission.');
    if (!receipts[id] && state.counterBaselines?.[event.day]) return {
      type: 'action', operation: { schemaVersion: 2, epoch: capability.epoch, type: 'counter', command: event }
    };
  }
  return null;
}

async function snapshot(name: string, accountId: string) {
  const db = await openDB(name);
  try {
    const tx = db.transaction(causalBusinessTransactionStores(db, [CAUSAL_STORE, 'sync']), 'readonly');
    const state = await readCausalAccount(tx, accountId) as State | undefined;
    const meta = normalizeSyncMeta(await readCausalBusiness(tx, 'sync', accountId));
    await tx.done;
    if (!state) throw new Error('Local account initialization must finish before causal synchronization.');
    return { state, meta };
  } finally { db.close(); }
}
const pendingCount = (state: State) => [state.focusOutbox, state.counterOutbox, state.counterDayOutbox, state.completionOutbox]
  .reduce((sum, outbox) => sum + Object.keys(outbox ?? {}).length, 0);

/** Fenced accounts may establish their preserved, known-version baseline.
 * Missing evidence must never silently fall back to legacy pushes.
 * Refresh after each exact receipt so day baselines and completion projections
 * are verified before their dependent actions become transportable. */
export async function synchronizeCausalQueues(name: string, accountId: string, runtime: HistoryRuntime,
  drainOrdinary: () => Promise<void>, onProjection: () => void) {
  let sent = 0;
  const attempted = new Set<string>();
  for (;;) {
    runtime.signal?.throwIfAborted();
    let capability = await discoverCausalCapability(name, accountId, runtime);
    if (!capability.enrolled) {
      const bytes = await prepareKnownCausalCutover(name, accountId);
      if (bytes === null) {
        if (!await initializeServerAccount(name, accountId, runtime)) return { ready: false, sent, pending: pendingCount((await snapshot(name, accountId)).state), reason: 'ENROLLMENT_REQUIRED' as const };
      } else await syncCausalCutover(name, accountId, JSON.parse(bytes), runtime);
      capability = await discoverCausalCapability(name, accountId, runtime);
      if (!capability.enrolled) throw new Error('The acknowledged cutover is not visible yet. Retry the retained enrollment.');
    }
    const enrollment = (await snapshot(name, accountId)).state;
    if (enrollment.serverInitializationRequest !== undefined && enrollment.serverInitializationReceipt === undefined
      && parseCausalInitialization(accountId, JSON.parse(enrollment.serverInitializationRequest)).initializationId === capability.epoch) {
      await initializeServerAccount(name, accountId, runtime);
    }
    for (;;) {
      const history = await pullCausalHistory(name, accountId, runtime);
      if (history.complete) break;
      if (!history.fetched) throw new Error('Causal history made no durable progress. Retained history remains available.');
    }
    const downloaded = (await snapshot(name, accountId)).state;
    if (downloaded.cutoverRequest !== undefined && downloaded.cutoverReceipt === undefined) {
      const entry = downloaded.causalHistory?.entries['0'];
      if (!entry) throw new Error('The attempted enrollment needs its verified cutover history.');
      await commitCausalCutoverReceipt(name, accountId, JSON.parse(entry.body).receipt);
    }
    const projection = await applyDownloadedCausalHistory(name, accountId);
    onProjection();
    if (projection.blocked) return { ready: false, sent, pending: pendingCount((await snapshot(name, accountId)).state), reason: 'PROJECTION_REVIEW' as const };
    await drainOrdinary();
    const { state, meta } = await snapshot(name, accountId);
    const work = nextCausalQueueWork(accountId, state, meta);
    if (!work) return { ready: true, sent, pending: pendingCount(state), reason: pendingCount(state) ? 'DEPENDENCY_REVIEW' as const : null };
    const id = work.type === 'completion' ? work.actionId : work.operation.command.actionId as string;
    if (attempted.has(id)) throw new Error('A causal receipt did not durably resolve its attempted action.');
    attempted.add(id);
    if (work.type === 'completion') await syncLocalCompletion(name, accountId, id, runtime);
    else await syncCausalAction(name, accountId, work.operation, runtime);
    sent++;
  }
}
