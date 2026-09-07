import { type IDBPDatabase } from 'idb';
import { applyFocusCommand, initialFocusJournal, validateFocusCommand, type FocusCommand, type FocusJournal, type FocusOutcome } from '../src/domain/causalFocus';
import { stableJson } from './syncProtocol';
import { CAUSAL_STORE, TRACKING_KEY_PATH, fenceLegacyTracking, readCausalAccount, type CausalAccountState } from './causalStorage';

/** Captured by the UI once, before any await. Revision is chosen only while the
 * local coordinator owns the transaction; target and epoch are never retargeted. */
export type LocalFocusIntent = Omit<FocusCommand, 'expectedRevision'> & {
  schemaVersion: 1; actionId: string; accountId: string; actorId: string;
  kind: FocusCommand['kind']; sessionId: string; taskId: string; epoch: string;
  expectedCurrentSessionId: string | null; capturedAt: string; durationSeconds: number | null;
};
export interface LocalFocusAdmission {
  intent: LocalFocusIntent;
  command: FocusCommand;
  outcome: FocusOutcome;
}
export interface FocusAccountState extends CausalAccountState {
  focus?: FocusJournal;
  focusAdmissions?: Record<string, LocalFocusAdmission>;
  /** Admitted local commands awaiting separately versioned server receipts. */
  focusOutbox?: Record<string, FocusCommand>;
  /** Exact old captures; observing them never infers or applies a counter delta. */
  legacyWal?: Record<string, string[]>;
}
export interface LocalFocusResult {
  outcome: FocusOutcome;
  duplicate: boolean;
  generation: number;
  tracking: unknown;
  command: FocusCommand;
}
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

function retainLegacyWal(state: FocusAccountState, account: string): void {
  if (typeof window === 'undefined') return;
  const prefix = `goalflow_wal_v2_${encodeURIComponent(account)}_`;
  state.legacyWal ??= {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const raw = window.localStorage.getItem(key);
    if (raw === null) continue;
    const copies = state.legacyWal[key] ??= [];
    if (!copies.includes(raw)) copies.push(raw);
  }
}

/** Dormant until the capability/rollout boundary selects causal application
 * writes. This coordinator does not claim server acceptance. Completion must
 * use the logical completion transaction, including final notes and effects. */
export async function admitLocalFocus(databaseName: string, captured: LocalFocusIntent): Promise<LocalFocusResult> {
  const intent = structuredClone(captured);
  validateFocusCommand({ ...intent, expectedRevision: null });
  if (intent.kind === 'complete') throw new Error('Focus completion requires the atomic final-notes action. Nothing was admitted.');
  const db = await fenceLegacyTracking(databaseName);
  try { return await admitInDatabase(db, intent); } finally { db.close(); }
}

async function admitInDatabase(db: IDBPDatabase, intent: LocalFocusIntent): Promise<LocalFocusResult> {
  const tx = db.transaction([CAUSAL_STORE, 'tracking', 'tasks'], 'readwrite');
  // Observe abort immediately; callers receive the original validation/storage error.
  void tx.done.catch(() => undefined);
  try {
    const state = await readCausalAccount(tx, intent.accountId) as FocusAccountState | undefined;
    if (!state || !state.trackingPresent || !record(state.trackingValue)) {
      throw new Error('A valid existing tracking baseline is required. Its original value was not replaced.');
    }
    const identity = state.actionIdentities?.[intent.actionId];
    if (identity && (identity.kind !== 'focus' || stableJson(identity.intent) !== stableJson(intent))) {
      throw new Error('The captured action ID has different intent. Nothing was admitted.');
    }
    const prior = state.focusAdmissions?.[intent.actionId];
    if (prior) {
      if (stableJson(prior.intent) !== stableJson(intent)) throw new Error('The captured action ID has different intent. Nothing was admitted.');
      await tx.done;
      return { outcome: prior.outcome, command: prior.command, duplicate: true, generation: state.generation, tracking: state.trackingValue };
    }
    const journal = state.focus ?? initialFocusJournal(intent.accountId, state.trackingValue.focusSession);
    const current = journal.currentSessionId ? journal.sessions[journal.currentSessionId] : undefined;
    const command: FocusCommand = { ...intent, expectedRevision: current?.revision ?? null };
    const tasks = await tx.objectStore('tasks').get(intent.accountId);
    if (!Array.isArray(tasks)) throw new Error('The task projection cannot be verified. Nothing was admitted.');
    const matching = tasks.filter(task => record(task) && task.id === intent.taskId);
    if (matching.length !== 1) throw new Error('The focus target is missing or ambiguous. Nothing was admitted.');
    const task = matching[0];
    if (['start', 'resume', 'extendAndResume'].includes(intent.kind)
      && (task.completed || task.wontDo || task.deletedAt || ['completed', 'dropped', 'archived', 'broken_down'].includes(task.lifecycleStatus))) {
      throw new Error('This task is no longer open. Nothing was admitted.');
    }
    const result = applyFocusCommand(journal, command);
    if (!Number.isSafeInteger(state.generation + 1)) throw new Error('Local generation exhausted. Nothing was admitted.');
    state.actionIdentities ??= {};
    state.actionIdentities[intent.actionId] = { kind: 'focus', intent };
    state.focus = result.journal;
    state.focusAdmissions ??= {};
    state.focusAdmissions[intent.actionId] = { intent, command, outcome: result.outcome };
    state.focusOutbox ??= {};
    if (result.outcome.accepted) state.focusOutbox[intent.actionId] = command;
    retainLegacyWal(state, intent.accountId);
    state.generation++;
    if (result.outcome.accepted) {
      state.trackingValue = { ...state.trackingValue, focusSession: result.journal.sessions[result.journal.currentSessionId!].projection };
    }
    await tx.objectStore(CAUSAL_STORE).put(state);
    await tx.objectStore('tracking').put({ [TRACKING_KEY_PATH]: intent.accountId, payload: state.trackingValue });
    await tx.done;
    return { outcome: result.outcome, command, duplicate: false, generation: state.generation, tracking: state.trackingValue };
  } catch (error) {
    try { tx.abort(); } catch (_) { /* already aborted */ }
    try { await tx.done; } catch (_) { /* report original error */ }
    throw error;
  }
}
