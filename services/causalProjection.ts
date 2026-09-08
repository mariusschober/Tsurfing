import { openDB } from 'idb';
import { applyFocusCommand, initialFocusJournal, type FocusCommand } from '../src/domain/causalFocus';
import { projectCounters, validateCounterBaseline, type CounterBaseline, type CounterDelta } from '../src/domain/counterLedger';
import { assertCausalHistoryEntry } from './causalHistoryProtocol';
import { validateSavedCausalHistory, type SavedCausalHistory } from './causalHistory';
import { assertCausalCapability } from './causalCapability';
import { assertCausalReceipt, parseCausalOperation } from './causalProtocol';
import { CAUSAL_STORE, TRACKING_KEY_PATH, readCausalAccount } from './causalStorage';
import type { CausalEnrollmentState } from './causalEnrollment';
import type { CausalReceiptState } from './causalReceipts';
import type { FocusAccountState, LocalFocusIntent } from './causalFocusCoordinator';
import type { CounterAccountState } from './causalCounterCoordinator';
import { stableJson } from './syncProtocol';

const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const protectedTracking = (value: Record<string, any>) => Object.fromEntries(
  ['date', 'planViewCount', 'dailyPostponeCount', 'focusSession'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])
);
const focusIntent = (command: FocusCommand): LocalFocusIntent => {
  const { expectedRevision: _parent, ...intent } = command;
  return intent as LocalFocusIntent;
};

/** Reconstruct every transition, not just the latest snapshot. Callers also
 * validate the saved body hashes before applying this result to storage. */
export function replayCausalHistory(accountId: string, history: SavedCausalHistory) {
  if (history.downloadedRevision < 0) throw new Error('The causal cutover receipt has not been downloaded.');
  const first = assertCausalHistoryEntry(accountId, history.epoch, 0, JSON.parse(history.entries['0'].body));
  let tracking = structuredClone(first.receipt.record.payload);
  let focus = initialFocusJournal(accountId, tracking.focusSession);
  const baselines: Record<string, CounterBaseline> = { [first.receipt.baseline.day]: first.receipt.baseline };
  const events: Record<string, CounterDelta> = {};
  const receipts: Record<string, Record<string, any>> = {};
  for (let revision = 1; revision <= history.downloadedRevision; revision++) {
    const entry = assertCausalHistoryEntry(accountId, history.epoch, revision, JSON.parse(history.entries[String(revision)].body));
    const receipt = entry.receipt;
    if (receipt.operation?.type === 'completion') throw new Error('Atomic completion history requires the task/effect application coordinator. All history remains retained.');
    const operation = parseCausalOperation(accountId, receipt.operation), command = operation.command;
    const id = command.actionId as string;
    if (receipts[id] || id === history.epoch || Object.values(baselines).some(b => b.baselineId === id)) throw new Error('Causal history repeats an immutable action identity.');
    if (operation.type === 'focus') {
      const result = applyFocusCommand(focus, command as FocusCommand);
      if (!same(result.outcome, receipt.outcome)) throw new Error('Causal history contradicts its focus transition.');
      focus = result.journal;
      if (result.outcome.accepted) tracking = { ...tracking, focusSession: focus.sessions[focus.currentSessionId!].projection };
    } else if (operation.type === 'counter') {
      const baseline = baselines[command.day as string];
      if (!baseline) throw new Error('Causal history is missing an established counter day.');
      events[id] = command as unknown as CounterDelta;
      const counts = projectCounters(baseline, Object.values(events));
      if (!same(counts, receipt.outcome.counts)) throw new Error('Causal history violates counter conservation.');
      if (tracking.date === command.day) tracking = { ...tracking, ...counts };
    } else {
      const baseline = receipt.baseline as CounterBaseline;
      validateCounterBaseline(baseline);
      const prior = baselines[baseline.day];
      if (prior && !same(prior, baseline)) throw new Error('Causal history rewrites a counter baseline.');
      if (!prior && (receipts[baseline.baselineId] || baseline.baselineId === id)) throw new Error('Causal history reuses an action as baseline evidence.');
      baselines[baseline.day] = baseline;
      const counts = projectCounters(baseline, Object.values(events));
      if (!same(counts, receipt.counts)) throw new Error('Causal history violates counter day conservation.');
      if (command.kind === 'select') tracking = { ...tracking, date: command.day, ...counts };
    }
    if (!same(protectedTracking(tracking), protectedTracking(receipt.record.payload))) throw new Error('Causal history changes unrelated protected tracking state.');
    receipts[id] = receipt;
    // Unprotected fields can legitimately change through the ordinary protocol.
    // Keep the exact latest server record as evidence; local application below
    // changes only protected fields in the current local tracking object.
    tracking = structuredClone(receipt.record.payload);
  }
  return { tracking, focus, baselines, events, receipts };
}

type State = CausalEnrollmentState & CausalReceiptState & FocusAccountState & CounterAccountState & {
  causalHistory?: SavedCausalHistory;
  causalProjection?: { schemaVersion: 1; epoch: string; revision: number };
  causalProjectionPreimage?: { tracking: unknown; focus: unknown };
  causalProjectionReviews?: Record<string, { code: string }>;
  causalProjectionReviewHistory?: Record<string, string[]>;
};

/** All protected projections, exact local acknowledgments and generation move
 * together. The regular entity pull cursor and unrelated business data do not
 * move here. Pending commands keep their captured parents and identities. */
export async function applyDownloadedCausalHistory(name: string, accountId: string) {
  const db = await openDB(name);
  try {
    if (!db.objectStoreNames.contains(CAUSAL_STORE)) throw new Error('Explicit causal admission is required.');
    const initial = await db.get(CAUSAL_STORE, accountId) as State | undefined;
    const history = initial?.causalHistory;
    if (!history || history.partial || history.downloadedRevision !== history.throughRevision) throw new Error('Complete the retained history horizon before applying it.');
    await validateSavedCausalHistory(accountId, history);
    const canonical = replayCausalHistory(accountId, history);
    const tx = db.transaction([CAUSAL_STORE, 'tracking', 'tasks'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, accountId) as State | undefined;
      if (!state || !state.trackingPresent || !record(state.trackingValue) || !same(state.causalHistory, history)) throw new Error('Causal state changed; resume from retained history.');
      if (Object.keys((state as State & { completionOutbox?: Record<string, unknown> }).completionOutbox ?? {}).length) {
        throw new Error('Pending atomic completion requires the task/effect application coordinator. All projections remain retained.');
      }
      const capability = assertCausalCapability(accountId, state.causalCapability);
      if (!capability.enrolled || capability.epoch !== history.epoch || capability.projectionRevision < history.downloadedRevision
        || (state.causalProjection && (state.causalProjection.epoch !== history.epoch || state.causalProjection.revision > history.downloadedRevision))) throw new Error('The causal projection epoch or revision cannot be rewound.');
      const before = stableJson(state);
      const cutover = JSON.parse(history.entries['0'].body).receipt.record.payload;
      if (!state.cutover.trackingPresent || !record(state.cutover.trackingValue)
        || !same(protectedTracking(state.cutover.trackingValue), protectedTracking(cutover))) {
        throw new Error('The preserved local cutover differs from server evidence. Explicit legacy recovery is required.');
      }
      for (const [id, bytes] of Object.entries(state.causalRequests ?? {})) {
        const operation = parseCausalOperation(accountId, JSON.parse(bytes));
        const admitted = operation.type === 'focus' ? state.focusAdmissions?.[id]?.command : state.counterEvents?.[id];
        if (operation.epoch !== history.epoch || operation.command.actionId !== id || !same(admitted, operation.command)) {
          throw new Error('A retained request differs from its account epoch or original admission.');
        }
      }
      for (const [id, receipt] of Object.entries(state.causalReceipts ?? {})) {
        const bytes = state.causalRequests?.[id];
        if (!bytes) throw new Error('A retained receipt has no immutable request.');
        assertCausalReceipt(accountId, parseCausalOperation(accountId, JSON.parse(bytes)), receipt);
        if (receipt.projectionRevision > history.downloadedRevision) throw new Error('Download history through the newest retained receipt before applying it.');
        if (!same(canonical.receipts[id], receipt)) throw new Error('Downloaded history differs from a retained receipt.');
      }
      state.causalProjectionPreimage ??= { tracking: structuredClone(state.trackingValue), focus: structuredClone(state.focus) };
      state.counterBaselines ??= {};
      for (const [day, baseline] of Object.entries(canonical.baselines)) {
        if (state.counterBaselines[day] && !same(state.counterBaselines[day], baseline)) throw new Error('The local baseline needs explicit recovery; it was not replaced.');
        state.counterBaselines[day] = baseline;
      }
      state.counterEvents ??= {};
      state.actionIdentities ??= {};
      state.focusAdmissions ??= {};
      const reviews: Record<string, { code: string }> = {};
      for (const [id, receipt] of Object.entries(canonical.receipts)) {
        const operation = parseCausalOperation(accountId, receipt.operation);
        const command = operation.command;
        const intent = operation.type === 'focus' ? focusIntent(command as FocusCommand) : command;
        const existing = state.actionIdentities[id];
        if (existing && (existing.kind !== operation.type || !same(existing.intent, intent))) throw new Error('A remote action has different local identity evidence.');
        state.actionIdentities[id] = { kind: operation.type, intent };
        if (operation.type === 'counter') {
          if (state.counterEvents[id] && !same(state.counterEvents[id], command)) throw new Error('A remote counter differs from its original local event.');
          state.counterEvents[id] = command as unknown as CounterDelta;
        } else if (operation.type === 'focus') {
          if (state.focusAdmissions[id] && !same(state.focusAdmissions[id].command, command)) throw new Error('A remote focus action differs from its original local command.');
          state.focusAdmissions[id] ??= { intent: intent as LocalFocusIntent, command: command as FocusCommand, outcome: receipt.outcome };
          if (!receipt.accepted) reviews[id] = { code: receipt.outcome.code };
        }
        const bytes = state.causalRequests?.[id];
        if (bytes !== undefined) {
          const attempted = parseCausalOperation(accountId, JSON.parse(bytes));
          assertCausalReceipt(accountId, attempted, receipt);
          const pending = operation.type === 'focus' ? state.focusOutbox?.[id] : state.counterOutbox?.[id];
          if (pending && !same(pending, command)) throw new Error('The pending action differs from its original receipt.');
          if (!pending && !state.causalReceipts?.[id]) throw new Error('The local request is missing its durable pending intent.');
          state.causalReceipts ??= {};
          state.causalReceipts[id] = receipt;
          if (receipt.accepted) {
            if (operation.type === 'focus') delete state.focusOutbox?.[id];
            else delete state.counterOutbox?.[id];
          }
        }
      }
      // Local counters are merged by immutable action identity. Events already
      // present in server history are represented once, even before their local
      // request has been sent/acknowledged after a restore.
      const events = Object.values(state.counterEvents);
      for (const [id, event] of Object.entries(state.counterEvents)) {
        if (event.actionId !== id || !state.counterBaselines[event.day]) throw new Error('A local counter has incomplete baseline evidence.');
      }
      for (const [id, event] of Object.entries(state.counterOutbox ?? {})) {
        if (!same(state.counterEvents[id], event)) throw new Error('A pending counter has no exact durable event.');
      }
      for (const [day, baseline] of Object.entries(state.counterBaselines)) {
        if (baseline.day !== day) throw new Error('A counter baseline has a different day identity.');
        projectCounters(baseline, events);
      }
      const selected = state.counterBaselines[canonical.tracking.date];
      if (!selected) throw new Error('The selected counter day has no baseline.');
      let focus = canonical.focus;
      const tasks = await tx.objectStore('tasks').get(accountId);
      for (const [id, command] of Object.entries(state.focusOutbox ?? {})) {
        if (canonical.receipts[id]) continue;
        if (!same(state.focusAdmissions[id]?.command, command)) throw new Error('A pending focus command has no exact admission.');
        const task = Array.isArray(tasks) ? tasks.filter(item => record(item) && item.id === command.taskId) : [];
        if (task.length !== 1 || (['start', 'resume', 'extendAndResume'].includes(command.kind)
          && (task[0].completed || task[0].wontDo || task[0].deletedAt || ['completed', 'dropped', 'archived', 'broken_down'].includes(task[0].lifecycleStatus)))) {
          reviews[id] = { code: 'TASK_REVIEW_REQUIRED' }; continue;
        }
        const result = applyFocusCommand(focus, command);
        focus = result.journal;
        if (!result.outcome.accepted) reviews[id] = { code: result.outcome.code };
      }
      const next: Record<string, any> = { ...state.trackingValue, date: canonical.tracking.date, ...projectCounters(selected, events) };
      if (focus.currentSessionId) next.focusSession = focus.sessions[focus.currentSessionId].projection;
      else if (Object.hasOwn(canonical.tracking, 'focusSession')) next.focusSession = canonical.tracking.focusSession;
      else delete next.focusSession;
      state.focus = focus;
      state.trackingValue = next;
      state.causalProjection = { schemaVersion: 1, epoch: history.epoch, revision: history.downloadedRevision };
      state.causalProjectionReviewHistory ??= {};
      for (const [id, review] of Object.entries(reviews)) {
        const codes = state.causalProjectionReviewHistory[id] ??= [];
        if (!codes.includes(review.code)) codes.push(review.code);
      }
      state.causalProjectionReviews = reviews;
      if (before === stableJson(state)) { await tx.done; return { duplicate: true, generation: state.generation, reviews }; }
      if (!Number.isSafeInteger(state.generation + 1)) throw new Error('Local generation exhausted.');
      state.generation++;
      await tx.objectStore(CAUSAL_STORE).put(state);
      await tx.objectStore('tracking').put({ [TRACKING_KEY_PATH]: accountId, payload: next });
      await tx.done;
      return { duplicate: false, generation: state.generation, reviews };
    } catch (error) {
      try { tx.abort(); } catch (_) {}
      try { await tx.done; } catch (_) {}
      throw error;
    }
  } finally { db.close(); }
}
