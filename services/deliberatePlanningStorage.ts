import { openDB, type IDBPTransaction } from 'idb';
import { v5 as uuidv5 } from 'uuid';
import type { Task, UserProgress } from '../types';
import { compareQueueCandidates } from '../src/domain/scheduling';
import { confirmOrderSchema, confirmPlanningOrder, initialPlanningPolicy, type ConfirmOrder,
  type DailyPlanningPolicy, type PlanningDraft, type PlanningReceipt } from '../src/domain/deliberatePlanning';
import { causalBusinessTransactionStores, readCausalBusiness, writeCausalBusiness } from './causalBusinessStorage';
import { CAUSAL_STORE, readCausalAccount } from './causalStorage';
import { effectiveCompletionMembers, effectivePlanningEdit, planningPredecessor, assertPlanningRebaseState, type PlanningRebaseState } from './planningCompletionRebase';
import { validateCompletionEvidence, type CompletionAccountState } from './causalCompletionCoordinator';
import { normalizeSyncMeta, stableJson, syncEntityKey, type SyncMutation } from './syncProtocol';
import { assertPlanningDay, assertPlanningResponse, assertPlanningReview, dailyPlanningPolicySchema, type PlanningResponse, type PlanningReview } from './deliberatePlanningProtocol';

export const PLANNING_STORE = 'planning_state';
export interface PlanningAccountState {
  schemaVersion: 1;
  accountKey: string;
  generation: number;
  planning?: {
    schemaVersion: 1;
    days: Record<string, DailyPlanningPolicy>;
    drafts: Record<string, PlanningDraft>;
    pending: Record<string, { command: ConfirmOrder; provisional: PlanningReceipt; sequence: number;
      ordinaryDependencies: string[]; causalDependencies: string[]; members: SyncMutation[];
      request?: string; response?: PlanningResponse; review?: string; reviewSnapshots?: PlanningReview[] }>;
    receipts?: Record<string, PlanningResponse>;
    resolutions?: Record<string, { pending: NonNullable<PlanningAccountState['planning']>['pending'][string]; snapshot: PlanningReview; choice: 'synced' | 'draft'; supersededBy?: string }>;
  };
}
/** Independent additive authority works before and after the reviewed causal
 * cutover. Using planning must not implicitly enroll an account into S2. */
export async function ensurePlanningStorage(name: string) {
  const close = (_old: number, _next: number | null, event: IDBVersionChangeEvent) => (event.target as IDBDatabase).close();
  for (let attempt = 0; attempt < 4; attempt++) {
    const db = await openDB(name, undefined, { blocking: close });
    if (db.objectStoreNames.contains(PLANNING_STORE)) return db;
    const version = db.version + 1; db.close();
    try {
      return await openDB(name, version, { blocking: close, upgrade(db) {
        if (!db.objectStoreNames.contains(PLANNING_STORE)) db.createObjectStore(PLANNING_STORE, { keyPath: 'accountKey' });
      } });
    } catch (error) { if ((error as DOMException).name !== 'VersionError') throw error; }
  }
  throw new Error('Planning storage upgrade needs a retry.');
}
const stores = ['tasks', 'progress', 'settings', 'daily_plans', 'sync'];
type Transaction = IDBPTransaction<unknown, string[], 'readwrite'>;

/** Uses the established private account authority. Old daily-plan clearing
 * cannot remove policy, drafts or pending evidence. No localStorage fallback:
 * failed persistence must leave the visible order and balance unchanged. */
async function transaction<T>(name: string, accountId: string,
  work: (state: PlanningAccountState, tx: Transaction) => Promise<T>): Promise<T> {
  const db = await ensurePlanningStorage(name);
  try {
    const tx = db.transaction(causalBusinessTransactionStores(db, [PLANNING_STORE, ...stores,
      ...(db.objectStoreNames.contains(CAUSAL_STORE) ? [CAUSAL_STORE] : [])]), 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = (await tx.objectStore(PLANNING_STORE).get(accountId) ?? {
        schemaVersion: 1, accountKey: accountId, generation: 0,
      }) as PlanningAccountState;
      if (state.schemaVersion !== 1 || state.accountKey !== accountId || !Number.isSafeInteger(state.generation) || state.generation < 0) throw new Error('Planning account storage needs recovery.');
      if (state.planning && state.planning.schemaVersion !== 1) throw new Error('Update required to read planning history.');
      state.planning ??= { schemaVersion: 1, days: {}, drafts: {}, pending: {} };
      const result = await work(state, tx);
      if (!Number.isSafeInteger(state.generation + 1)) throw new Error('Local generation exhausted.');
      state.generation++;
      await tx.objectStore(PLANNING_STORE).put(state);
      await tx.done;
      return structuredClone(result);
    } catch (error) {
      try { tx.abort(); } catch (_) {}
      try { await tx.done; } catch (_) {}
      throw error;
    }
  } finally { db.close(); }
}

async function policyFor(state: PlanningAccountState, tx: Transaction, accountId: string, localDate: string) {
  initialPlanningPolicy(accountId, localDate);
  if (state.planning!.days[localDate]) return state.planning!.days[localDate];
  const plans = await readCausalBusiness(tx, 'daily_plans', accountId);
  const legacy = Array.isArray(plans) ? plans.find(plan => plan.localDate === localDate && plan.confirmedAt) : undefined;
  const policy = initialPlanningPolicy(accountId, localDate, legacy);
  state.planning!.days[localDate] = policy;
  return policy;
}

export async function readDailyPlanning(name: string, accountId: string, localDate: string) {
  return transaction(name, accountId, async (state, tx) => ({
    policy: await policyFor(state, tx, accountId, localDate), draft: state.planning!.drafts[localDate] ?? null,
    pending: Object.values(state.planning!.pending).filter(item => item.command.localDate === localDate),
    otherDates: [...new Set([...Object.keys(state.planning!.drafts),
      ...Object.values(state.planning!.pending).map(item => item.command.localDate)])]
      .filter(day => day !== localDate).sort(),
  }));
}

export async function savePlanningDraft(name: string, captured: PlanningDraft) {
  const draft = structuredClone(captured);
  // Reuse command validation for dates, identities, unique ordering and ratings.
  const { updatedAt, ...fields } = draft;
  confirmOrderSchema.parse({ ...fields, operationId: '00000000-0000-4000-8000-000000000001', capturedAt: updatedAt });
  return transaction(name, draft.accountId, async (state, tx) => {
    await policyFor(state, tx, draft.accountId, draft.localDate);
    state.planning!.drafts[draft.localDate] = draft;
    return draft;
  });
}

export async function discardPlanningDraft(name: string, accountId: string, localDate: string) {
  return transaction(name, accountId, async state => { delete state.planning!.drafts[localDate]; });
}

export async function commitPlanningDay(name: string, accountId: string, localDate: string, input: unknown) {
  const response = assertPlanningDay(accountId, localDate, input);
  return transaction(name, accountId, async (state, tx) => {
    if (Object.values(state.planning!.pending).some(item => item.command.localDate === localDate)) return false;
    const meta = normalizeSyncMeta(await readCausalBusiness(tx, 'sync', accountId));
    if ((response.records ?? []).some(record => record.server_version > meta.cursor)) return false;
    const previous = state.planning!.days[localDate];
    // A delayed snapshot must not roll back a confirmed allowance or replace
    // durable receipts. Legacy policies have no history and may be migrated.
    if (previous?.history.length && (response.policy.history.length < previous.history.length
      || previous.history.some((receipt, index) => stableJson(receipt) !== stableJson(response.policy.history[index])))) return false;
    state.planning!.days[localDate] = response.policy as DailyPlanningPolicy;
    return true;
  });
}

/** Dormant until the matching synchronization command is enabled. The original
 * operation is queued in the same transaction as every provisional effect. */
export async function admitPlanningConfirmation(name: string, captured: ConfirmOrder) {
  const command = confirmOrderSchema.parse(structuredClone(captured));
  return transaction(name, command.accountId, async (state, tx) => {
    if (Object.values(state.planning!.days).some(day => day.localDate !== command.localDate
      && day.history.some(receipt => receipt.command.operationId === command.operationId))) {
      throw new Error('Planning operation identity belongs to another day.');
    }
    const policy = await policyFor(state, tx, command.accountId, command.localDate);
    const rawTasks = await readCausalBusiness(tx, 'tasks', command.accountId);
    const progress = await readCausalBusiness(tx, 'progress', command.accountId) as UserProgress | undefined;
    const settings = await readCausalBusiness(tx, 'settings', command.accountId) as { penaltyMode?: 'classic' | 'gentle' | 'off' } | undefined;
    const rawMeta = await readCausalBusiness(tx, 'sync', command.accountId);
    const meta = normalizeSyncMeta(rawMeta);
    const causal = tx.objectStoreNames.contains(CAUSAL_STORE) ? await readCausalAccount(tx, command.accountId) as any : undefined;
    if (!Array.isArray(rawTasks) || !progress) throw new Error('Planning requires available tasks and XP balance.');
    const tasks = rawTasks as Task[];
    const available = tasks.filter(task => !task.completed && !task.wontDo && !task.deletedAt
      && (!task.lifecycleStatus || task.lifecycleStatus === 'open') && task.schedulePrecision !== 'month'
      && (task.scheduledFor ?? task.dateAssigned) === command.localDate).sort(compareQueueCandidates)
      .map(task => ({ id: task.id, precedence: task.beforeFrog && task.habitId ? 0 : task.isFrog ? 1 : 2 }));
    const result = confirmPlanningOrder(policy, command, available, progress.xp, settings?.penaltyMode ?? 'off');
    if (result.replay) return result;
    state.planning!.days[command.localDate] = result.policy;
    if (result.receipt.code !== 'APPLIED') return result;
    const rank = new Map(result.receipt.order.map((id, index) => [id, index]));
    const ratings = new Map(result.ratings.map(rating => [rating.taskId, rating]));
    const promoted = new Set(command.priorityChanges?.map(change => change.taskId));
    const nextTasks = tasks.map(task => {
      if (!rank.has(task.id)) return task;
      const rating = ratings.get(task.id);
      return { ...task, plannedOrder: rank.get(task.id), session: undefined,
        ...(promoted.has(task.id) ? { isFrog: true } : {}),
        ...(rating ? { excitement: rating.excitement, roi: rating.roi } : {}) };
    });
    await writeCausalBusiness(tx, 'tasks', command.accountId, nextTasks);
    await writeCausalBusiness(tx, 'progress', command.accountId, { ...progress, xp: result.xp });
    const rawPlans = await readCausalBusiness(tx, 'daily_plans', command.accountId);
    if (rawPlans !== undefined && !Array.isArray(rawPlans)) throw new Error('Existing plan data needs recovery.');
    const nextPlan = { id: command.localDate, localDate: command.localDate, taskIds: result.receipt.order, confirmedAt: Date.parse(command.capturedAt) };
    await writeCausalBusiness(tx, 'daily_plans', command.accountId, [
      ...(Array.isArray(rawPlans) ? rawPlans : []).filter((plan: { localDate: string }) => plan.localDate !== command.localDate),
      nextPlan,
    ]);
    meta.localState ??= { generation: 0, journal: {}, receipts: {} };
    const reservations = meta.localState.planningReservations ??= {};
    const members: SyncMutation[] = [];
    for (const [entityType, entityId, payload] of [
      ...nextTasks.filter(task => rank.has(task.id)).map(task => ['tasks', task.id, task] as const),
      ['progress', 'singleton', { ...progress, xp: result.xp }] as const,
      ['daily_plans', command.localDate, nextPlan] as const,
    ]) {
      const key = syncEntityKey(entityType, entityId), version = (meta.versions[key]?.local ?? 0) + 1;
      const mutationId = uuidv5(`planning:${entityType}:${entityId}`, command.operationId);
      const member: SyncMutation = { mutationId, entityType, entityId, payload, version, deviceId: 'planning-v1',
        baseServerVersion: meta.versions[key]?.server ?? null, updatedAt: command.capturedAt, deletedAt: null };
      members.push(member); reservations[mutationId] = { ...member, actionId: command.operationId };
      meta.versions[key] = { local: version, server: meta.versions[key]?.server ?? null };
    }
    state.planning!.pending[command.operationId] = { command, provisional: result.receipt, members,
      sequence: state.generation + 1, ordinaryDependencies: meta.outbox.map(item => item.mutationId),
      causalDependencies: [causal?.focusOutbox, causal?.counterOutbox, causal?.counterDayOutbox, causal?.completionOutbox]
        .flatMap(outbox => Object.keys(outbox ?? {})),
    };
    meta.localState.generation++;
    await writeCausalBusiness(tx, 'sync', command.accountId, { ...(rawMeta as object ?? {}), ...meta });
    delete state.planning!.drafts[command.localDate];
    return result;
  });
}

/** Freeze the oldest operation only when all work captured before it has a
 * receipt. Later edits remain behind its reservations. */
export async function preparePlanningRequest(name: string, accountId: string) {
  return transaction(name, accountId, async (state, tx) => {
    const pending = Object.values(state.planning!.pending).sort((a, b) => a.sequence - b.sequence)[0];
    if (!pending) return null;
    if (pending.review) return { blocked: pending.review,
      reviewRequest: pending.response && !pending.reviewSnapshots?.length ? pending.request : undefined };
    const meta = normalizeSyncMeta(await readCausalBusiness(tx, 'sync', accountId));
    if (pending.ordinaryDependencies.some(id => meta.localState?.receipts[id]?.result.accepted !== true)) {
      return { blocked: 'Earlier changes must synchronize before this order.' };
    }
    const causal = tx.objectStoreNames.contains(CAUSAL_STORE) ? await readCausalAccount(tx, accountId) as any : undefined;
    if (pending.causalDependencies.some(id => !(causal?.causalReceipts?.[id] ?? causal?.completionReceipts?.[id]))) {
      return { blocked: 'Earlier focus actions must synchronize before this order.' };
    }
    const bytes = JSON.stringify(pending.command);
    if (pending.request !== undefined && pending.request !== bytes) throw new Error('The saved planning request changed.');
    pending.request = bytes;
    return { request: bytes };
  });
}

/** Retain every exact server receipt, including conflicts, before attempting to
 * reconcile its provisional projection. Conflicts never erase the local draft. */
export async function commitPlanningResponse(name: string, accountId: string, command: ConfirmOrder, input: unknown) {
  const response = assertPlanningResponse(accountId, command, input);
  return transaction(name, accountId, async (state, tx) => {
    const planning = state.planning!, id = command.operationId;
    const previous = planning.receipts?.[id];
    if (previous) {
      if (stableJson(previous) !== stableJson(response)) throw new Error('The planning receipt changed on retry.');
      return { applied: previous.receipt.code === 'APPLIED', duplicate: true };
    }
    const pending = planning.pending[id];
    if (!pending || stableJson(pending.command) !== stableJson(command) || pending.request !== JSON.stringify(pending.command)) {
      throw new Error('The planning response has no matching attempted request.');
    }
    if (pending.response && stableJson(pending.response) !== stableJson(response)) throw new Error('The planning receipt changed on retry.');
    pending.response = response;
    if (response.receipt.code !== 'APPLIED') {
      pending.review = response.receipt.code;
      return { applied: false, review: pending.review };
    }
    const rawMeta = await readCausalBusiness(tx, 'sync', accountId), meta = normalizeSyncMeta(rawMeta);
    const causalState = tx.objectStoreNames.contains(CAUSAL_STORE) ? await readCausalAccount(tx, accountId) as any : undefined;
    const updates = new Map<string, unknown>();
    for (const store of stores.filter(store => !['sync', 'settings'].includes(store))) {
      updates.set(store, await readCausalBusiness(tx, store, accountId));
    }
    // Three-way field reconciliation preserves edits made after confirmation.
    // Simultaneous edits to the same field need an explicit choice.
    for (const member of pending.members) {
      const remote = response.records.find(row => row.entity_type === member.entityType && row.entity_id === member.entityId);
      if (!remote) { pending.review = 'A task changed on another device. Review both orders.'; return { applied: false, review: pending.review }; }
      const hasSuccessor = meta.outbox.some(item => item.entityType === member.entityType && item.entityId === member.entityId && item.version > member.version)
        || Object.values(meta.localState?.planningReservations ?? {}).some(item => item.entityType === member.entityType && item.entityId === member.entityId && item.version > member.version)
        || Object.values(meta.localState?.completionReservations ?? {}).some(item => item.entityType === member.entityType && item.entityId === member.entityId && item.version > member.version);
      if (hasSuccessor && stableJson(remote.payload) !== stableJson(member.payload)) {
        pending.review = 'An earlier synced version differs from later saved changes. Review both versions.';
        return { applied: false, review: pending.review };
      }
      const collection = updates.get(member.entityType);
      const current = Array.isArray(collection) ? collection.find(row => row.id === member.entityId) : collection;
      if (!current || typeof current !== 'object') { pending.review = 'A planned item was removed locally. Review both orders.'; return { applied: false, review: pending.review }; }
      const base = member.payload as Record<string, unknown>, live = current as Record<string, unknown>;
      const merged = { ...live };
      for (const key of new Set([...Object.keys(base), ...Object.keys(remote.payload)])) {
        if (stableJson(base[key]) === stableJson(remote.payload[key])) continue;
        if (stableJson(live[key]) !== stableJson(base[key]) && stableJson(live[key]) !== stableJson(remote.payload[key])) {
          pending.review = 'The same item changed on both devices. Review both versions.';
          return { applied: false, review: pending.review };
        }
        if (key in remote.payload) merged[key] = remote.payload[key]; else delete merged[key];
      }
      updates.set(member.entityType, Array.isArray(collection)
        ? collection.map(row => row.id === member.entityId ? merged : row) : merged);
    }
    for (const member of pending.members) {
      const remote = response.records.find(row => row.entity_type === member.entityType && row.entity_id === member.entityId)!;
      const reservation = meta.localState?.planningReservations?.[member.mutationId];
      if (!reservation || stableJson(reservation) !== stableJson({ ...member, actionId: id })) throw new Error('Planning reservation evidence differs.');
      for (const successor of meta.outbox.filter(item => item.dependsOnMutationId === member.mutationId)) {
        if (successor.attemptedAt) throw new Error('A planning successor was attempted before its predecessor.');
        successor.baseServerVersion = remote.server_version;
        delete successor.dependsOnMutationId;
      }
      delete meta.localState!.planningReservations![member.mutationId];
      const key = syncEntityKey(member.entityType, member.entityId);
      meta.versions[key] = { local: Math.max(meta.versions[key]?.local ?? 0, member.version),
        server: Math.max(meta.versions[key]?.server ?? 0, remote.server_version) };
    }
    for (const [store, value] of updates) await writeCausalBusiness(tx, store, accountId, value);
    planning.receipts ??= {}; planning.receipts[id] = response;
    if (tx.objectStoreNames.contains(CAUSAL_STORE)) {
      const causal = causalState;
      if (causal) {
        causal.planningReceipts ??= {}; causal.planningReceipts[id] = response;
        if (!Number.isSafeInteger(causal.generation + 1)) throw new Error('Local generation exhausted.');
        causal.generation++;
        await tx.objectStore(CAUSAL_STORE).put(causal);
      }
    }
    delete planning.pending[id];
    if (!Object.values(planning.pending).some(item => item.command.localDate === command.localDate)) planning.days[command.localDate] = response.policy as DailyPlanningPolicy;
    meta.localState!.generation++;
    await writeCausalBusiness(tx, 'sync', accountId, { ...(rawMeta as object ?? {}), ...meta });
    return { applied: true, duplicate: false };
  });
}

/** Keep review observations alongside the exact rejected receipt. Reading a
 * review cannot change task state, retire an operation or grant XP consent. */
export async function retainPlanningReview(name: string, accountId: string, command: ConfirmOrder, input: unknown) {
  const snapshot = assertPlanningReview(accountId, command, input);
  return transaction(name, accountId, async state => {
    const pending = state.planning!.pending[command.operationId];
    if (!pending?.response || !pending.review || pending.request !== JSON.stringify(command)
      || stableJson(pending.response) !== stableJson(snapshot.response)) throw new Error('Planning review has no matching retained receipt.');
    pending.reviewSnapshots ??= [];
    if (!pending.reviewSnapshots.some(previous => stableJson(previous) === stableJson(snapshot))) pending.reviewSnapshots.push(snapshot);
    return snapshot;
  });
}

/** Resolve only against a retained complete observation. Original attempts and
 * rejected receipts remain immutable evidence. Later dependent actions require
 * their own rebase proof and must never be discarded by this choice. */
export async function resolvePlanningReview(name: string, accountId: string, operationId: string, choice: 'synced' | 'draft') {
  return transaction(name, accountId, async (state, tx) => {
    const planning = state.planning!;
    if (planning.resolutions?.[operationId]) return { duplicate: true };
    const pending = planning.pending[operationId], snapshot = pending?.reviewSnapshots?.at(-1);
    if (!pending?.review || !pending.response || !snapshot) throw new Error('Wait for the complete synced order before choosing.');
    assertPlanningReview(accountId, pending.command, snapshot);
    if (choice === 'draft' && planning.drafts[pending.command.localDate]) throw new Error('Resume or discard your later draft before reopening this proposal.');
    const chain = [pending];
    for (const candidate of Object.values(planning.pending).sort((a, b) => a.sequence - b.sequence)) {
      if (candidate === pending || candidate.command.localDate !== pending.command.localDate) continue;
      const parent = chain.find(item => item.command.operationId === candidate.command.baselineRevision);
      if (!parent) continue;
      if (candidate.request !== undefined || candidate.response !== undefined) throw new Error('An attempted later confirmation needs its own receipt review.');
      chain.push(candidate);
    }
    const chainIds = new Set(chain.map(item => item.command.operationId));
    const chainMembers = chain.flatMap(item => item.members);

    if (pending.request !== JSON.stringify(pending.command) || stableJson(snapshot.response) !== stableJson(pending.response)) throw new Error('The review differs from the retained planning attempt.');
    const rawMeta = await readCausalBusiness(tx, 'sync', accountId), meta = normalizeSyncMeta(rawMeta);
    const updates = new Map<string, unknown>();
    for (const store of ['tasks', 'progress', 'daily_plans']) updates.set(store, await readCausalBusiness(tx, store, accountId));
    const causal = tx.objectStoreNames.contains(CAUSAL_STORE) ? await readCausalAccount(tx, accountId) as CompletionAccountState | undefined : undefined;
    const beforeOutbox = structuredClone(meta.outbox);
    const graph: PlanningRebaseState = {
      accountKey: accountId,
      planningResolutions: { ...meta.localState?.planningRebase?.planningResolutions, ...causal?.planningResolutions },
      planningEdits: { ...meta.localState?.planningRebase?.planningEdits, ...causal?.planningEdits },
      completionAdmissions: { ...meta.localState?.planningRebase?.completionAdmissions, ...causal?.completionAdmissions }
    };
    const beforeCompletions = new Map<string, ReturnType<typeof effectiveCompletionMembers>>();
    const afterCompletions = new Map<string, ReturnType<typeof effectiveCompletionMembers>>();
    if (causal && Object.keys(causal.completionOutbox ?? {}).length) {
      validateCompletionEvidence(accountId, causal, meta);
      for (const [id, admission] of Object.entries(causal.completionOutbox!)) beforeCompletions.set(id, effectiveCompletionMembers(causal, admission));
    }
    if (graph.planningResolutions![operationId]) throw new Error('The planning resolution already has saved-action evidence.');
    graph.planningResolutions![operationId] = { command: pending.command, request: pending.request!, members: pending.members, snapshot };
    const sources = [...chainMembers, ...beforeOutbox, ...[...beforeCompletions.values()].flat()];
    for (const continuation of chain.slice(1)) {
      const predecessors: NonNullable<import('./planningCompletionRebase').PlanningCompletionResolution['predecessors']> = {};
      for (const member of continuation.members) {
        const previous = sources.filter(source => source.entityType === member.entityType && source.entityId === member.entityId && source.version < member.version)
          .sort((a, b) => b.version - a.version)[0];
        if (!previous) continue;
        const planningParent = chain.find(item => item.members.some(m => m.mutationId === previous.mutationId));
        const completionParent = Object.values(causal?.completionAdmissions ?? {}).find(item => item.members.some(m => m.mutationId === previous.mutationId));
        predecessors[member.mutationId] = { kind: planningParent ? 'planning' : completionParent ? 'completion' : 'legacy',
          ...(planningParent || completionParent ? { actionId: planningParent?.command.operationId ?? completionParent!.command.actionId } : {}),
          request: structuredClone(previous) as any };
      }
      graph.planningResolutions![continuation.command.operationId] = { command: continuation.command, members: continuation.members, snapshot,
        supersededBy: graph.planningResolutions![continuation.command.baselineRevision!], predecessors };
    }

    for (const mutation of beforeOutbox) {
      const root = chainMembers.find(member => member.entityType === mutation.entityType && member.entityId === mutation.entityId && member.version < mutation.version);
      if (!root) continue;
      if (mutation.attemptedAt || graph.planningEdits![mutation.mutationId]) throw new Error('An attempted or previously reviewed saved edit needs separate reconciliation.');
      const predecessor = sources.find(source => source.mutationId === mutation.dependsOnMutationId);
      if (!predecessor) throw new Error('The saved edit is missing its original predecessor.');
      graph.planningEdits![mutation.mutationId] = { original: structuredClone(mutation), predecessor: structuredClone(predecessor) as SyncMutation };
    }
    assertPlanningRebaseState(graph);
    meta.outbox = meta.outbox.map(mutation => effectivePlanningEdit(graph, mutation));
    // Keep the immutable graph beside legacy outbox evidence so replay can
    // compare the original WAL while transport uses the reviewed projection.
    meta.localState!.planningRebase = graph;
    if (causal) {
      causal.planningResolutions = graph.planningResolutions;
      causal.planningEdits = graph.planningEdits;
      for (const [id, admission] of Object.entries(causal.completionOutbox ?? {})) {
        const after = effectiveCompletionMembers(causal, admission);
        if (stableJson(after) !== stableJson(beforeCompletions.get(id)) && causal.completionRequests?.[id]) throw new Error('An attempted completion cannot be rewritten by planning resolution.');
        afterCompletions.set(id, after);
      }
    }
    const latestReserved = [...new Map(chainMembers.slice().sort((a, b) => a.version - b.version)
      .map(member => [syncEntityKey(member.entityType, member.entityId), member])).values()];
    for (const member of latestReserved) {
      const key = syncEntityKey(member.entityType, member.entityId);
      const successors = Object.values(meta.localState?.planningReservations ?? {}).filter(item => !chainIds.has(item.actionId) && item.entityType === member.entityType && item.entityId === member.entityId && item.version > member.version);
      if (successors.length) throw new Error('Later saved actions need reconciliation before this order can be resolved. Your changes are retained.');
      const collection = updates.get(member.entityType), current = Array.isArray(collection) ? collection.find(row => row.id === member.entityId) : collection;
      const laterCompletions = [...beforeOutbox, ...[...beforeCompletions.values()].flat()].filter(item => item.entityType === member.entityType && item.entityId === member.entityId && item.version > member.version).sort((a, b) => b.version - a.version);
      const latestCompletion = laterCompletions[0];
      if (stableJson(current) !== stableJson(latestCompletion?.payload ?? member.payload)) throw new Error('Later saved edits need reconciliation before this order can be resolved. Your changes are retained.');
      const reservation = meta.localState?.planningReservations?.[member.mutationId];
      if (stableJson(reservation) !== stableJson({ ...member, actionId: chain.find(item => item.members.some(m => m.mutationId === member.mutationId))!.command.operationId })) throw new Error('The planning reservation differs from its original attempt.');
      const remote = snapshot.records.find(row => row.entity_type === member.entityType && row.entity_id === member.entityId);
      if (member.entityType === 'progress' && (!remote || remote.deleted_at)) throw new Error('The synced XP balance is missing. Refresh the review.');

      const derived = latestCompletion && [...meta.outbox, ...[...afterCompletions.values()].flat()].find(item => item.mutationId === latestCompletion.mutationId);
      const owner = chain.find(item => item.members.some(m => m.mutationId === member.mutationId))!;
      const proof = graph.planningResolutions![owner.command.operationId];
      const inherited = proof.supersededBy ? planningPredecessor(graph, proof, member as any) : undefined;
      if (!remote && member.entityType === 'tasks' && !snapshot.missingTaskIds.includes(member.entityId) && !inherited?.dependency) throw new Error('The review does not account for a planned task.');
      const payload = derived ? derived.payload : inherited ? inherited.payload : remote && !remote.deleted_at ? remote.payload : undefined;
      updates.set(member.entityType, Array.isArray(collection)
        ? collection.flatMap(row => row.id === member.entityId ? payload ? [payload] : [] : [row]) : payload);
      meta.versions[key] = { local: meta.versions[key]?.local ?? member.version, server: remote?.server_version ?? null };
    }
    for (const item of chain) for (const member of item.members) {
      const proof = graph.planningResolutions![item.command.operationId];
      // Ordinary successors can inherit an earlier saved edit or completion;
      // only a real server snapshot makes their dependency immediately ready.
      const hasSuccessor = meta.outbox.some(row => row.dependsOnMutationId === member.mutationId);
      if (hasSuccessor) {
        const inherited = planningPredecessor(graph, proof, member as any);
        meta.outbox = meta.outbox.map(row => row.dependsOnMutationId === member.mutationId
          ? { ...row, dependsOnMutationId: inherited.dependency?.request.mutationId,
            baseServerVersion: inherited.record?.server_version ?? null } : row);
      }
      delete meta.localState!.planningReservations![member.mutationId];
    }
    // Independent additions stay in their own queue. Other remote tasks arrive
    // through normal sync; this transaction changes only reserved members.
    for (const [store, value] of updates) await writeCausalBusiness(tx, store, accountId, value);
    if (causal) {
      validateCompletionEvidence(accountId, causal, meta);
      if (!Number.isSafeInteger(causal.generation + 1)) throw new Error('Local generation exhausted.');
      causal.generation++;
      await tx.objectStore(CAUSAL_STORE).put(causal);
    }
    planning.resolutions ??= {};
    for (const item of chain) {
      planning.resolutions[item.command.operationId] = { pending: structuredClone(item), snapshot, choice,
        ...(item !== pending ? { supersededBy: item.command.baselineRevision! } : {}) };
      delete planning.pending[item.command.operationId];
    }
    planning.receipts ??= {}; planning.receipts[operationId] = pending.response;
    planning.days[pending.command.localDate] = snapshot.policy as DailyPlanningPolicy;
    if (choice === 'draft') {
      const { operationId: _id, capturedAt, ...command } = chain.at(-1)!.command;
      planning.drafts[command.localDate] = { ...command, baselineRevision: snapshot.policy.revision,
        maximumAcceptedXp: 0, updatedAt: capturedAt } as PlanningDraft;
    }
    meta.localState!.generation++;
    await writeCausalBusiness(tx, 'sync', accountId, { ...(rawMeta as object ?? {}), ...meta });
    return { duplicate: false };
  });
}

export function validatePlanningBackup(accountId: string, input: unknown, sync: unknown): PlanningAccountState {
  const state = structuredClone(input) as PlanningAccountState;
  if (!state || state.schemaVersion !== 1 || state.accountKey !== accountId || !Number.isSafeInteger(state.generation)
    || state.generation < 0 || !state.planning || state.planning.schemaVersion !== 1) throw new Error('Invalid planning backup account.');
  const planning = state.planning;
  const graph = normalizeSyncMeta(sync).localState?.planningRebase;
  if (graph) {
    if (graph.accountKey !== accountId) throw new Error('Saved planning edits belong to a different account.');
    assertPlanningRebaseState(graph);
    for (const [id, proof] of Object.entries(graph.planningResolutions ?? {})) {
      const retained = planning.resolutions?.[id];
      const { supersededBy, predecessors: _predecessors, ...original } = proof;
      if (!retained || retained.supersededBy !== supersededBy?.command.operationId || stableJson(original) !== stableJson({ command: retained.pending.command, request: retained.pending.request,
        members: retained.pending.members, snapshot: retained.snapshot })) throw new Error('Saved edit resolution differs from retained planning evidence.');
    }
  }
  for (const [day, policy] of Object.entries(planning.days)) {
    dailyPlanningPolicySchema.parse(policy);
    initialPlanningPolicy(accountId, day);
    if (policy.accountId !== accountId || policy.localDate !== day || !Array.isArray(policy.history)) throw new Error('Invalid planning backup day.');
    for (const receipt of policy.history) confirmOrderSchema.parse(receipt.command);
  }
  for (const [day, draft] of Object.entries(planning.drafts)) {
    const { updatedAt, ...fields } = draft;
    if (draft.accountId !== accountId || draft.localDate !== day) throw new Error('Invalid planning backup draft.');
    confirmOrderSchema.parse({ ...fields, capturedAt: updatedAt, operationId: '00000000-0000-4000-8000-000000000001' });
  }
  const reservations: Record<string, unknown> = {};
  const sequences = new Set<number>();
  for (const [id, pending] of Object.entries(planning.pending)) {
    const command = confirmOrderSchema.parse(pending.command);
    if (command.accountId !== accountId || command.operationId !== id || !Number.isSafeInteger(pending.sequence)
      || pending.sequence < 1 || sequences.has(pending.sequence) || !Array.isArray(pending.members)
      || !Array.isArray(pending.ordinaryDependencies) || !Array.isArray(pending.causalDependencies)
      || (pending.request !== undefined && pending.request !== JSON.stringify(pending.command))
      || stableJson(planning.days[command.localDate]?.history.find(receipt => receipt.command.operationId === id)) !== stableJson(pending.provisional)) {
      throw new Error('Invalid pending planning evidence.');
    }
    sequences.add(pending.sequence);
    if (pending.response) assertPlanningResponse(accountId, command, pending.response);
    for (const snapshot of pending.reviewSnapshots ?? []) {
      assertPlanningReview(accountId, command, snapshot);
      if (!pending.review || stableJson(snapshot.response) !== stableJson(pending.response)) throw new Error('Invalid planning review evidence.');
    }
    for (const member of pending.members) {
      if (reservations[member.mutationId] || member.mutationId !== uuidv5(`planning:${member.entityType}:${member.entityId}`, id)) {
        throw new Error('Invalid planning member identity.');
      }
      reservations[member.mutationId] = { ...member, actionId: id };
    }
  }
  for (const [id, receipt] of Object.entries(planning.receipts ?? {})) {
    if (id !== receipt.receipt.command.operationId || planning.pending[id]) throw new Error('Invalid planning receipt identity.');
    assertPlanningResponse(accountId, receipt.receipt.command as ConfirmOrder, receipt);
  }
  for (const [id, resolution] of Object.entries(planning.resolutions ?? {})) {
    const { pending, snapshot, choice } = resolution;
    if (!['synced', 'draft'].includes(choice) || pending.command.operationId !== id || pending.command.accountId !== accountId || planning.pending[id]) {
      throw new Error('Invalid planning resolution identity.');
    }
    if (resolution.supersededBy) {
      const parent = planning.resolutions?.[resolution.supersededBy];
      if (!parent || pending.request !== undefined || pending.response !== undefined || planning.receipts?.[id] !== undefined
        || pending.command.baselineRevision !== parent.pending.command.operationId || pending.command.localDate !== parent.pending.command.localDate
        || pending.sequence <= parent.pending.sequence || stableJson(snapshot) !== stableJson(parent.snapshot) || choice !== parent.choice
        || pending.provisional.code !== 'APPLIED' || pending.provisional.revision !== id
        || stableJson(pending.provisional.command) !== stableJson(pending.command)
        || !graph?.planningResolutions?.[id]?.supersededBy) throw new Error('Invalid superseded planning continuation.');
      confirmOrderSchema.parse(pending.command);
    } else {
      if (pending.request !== JSON.stringify(pending.command) || !pending.review
        || stableJson(pending.response) !== stableJson(planning.receipts?.[id])
        || stableJson(snapshot.response) !== stableJson(pending.response)
        || !pending.reviewSnapshots?.some(item => stableJson(item) === stableJson(snapshot))) throw new Error('Invalid planning resolution evidence.');
      assertPlanningReview(accountId, pending.command, snapshot);
    }
  }
  if (stableJson(reservations) !== stableJson(normalizeSyncMeta(sync).localState?.planningReservations ?? {})) {
    throw new Error('Planning reservations differ from the backup journal.');
  }
  return state;
}
