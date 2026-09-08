import { causalBusinessTransactionStores, readCausalBusiness, writeCausalBusiness } from './causalBusinessStorage';
import { openDB, type IDBPTransaction } from 'idb';
import { v5 as uuidv5 } from 'uuid';
import { applyFocusCommand, initialFocusJournal, validateFocusCommand, type FocusCommand, type FocusOutcome } from '../src/domain/causalFocus';
import { deriveTaskCompletion, validateCompletionDetails, type CompletionDetails } from '../src/domain/taskCompletion';
import { CAUSAL_STORE, TRACKING_KEY_PATH, readCausalAccount } from './causalStorage';
import type { FocusAccountState, LocalFocusIntent } from './causalFocusCoordinator';
import type { CausalEnrollmentState } from './causalEnrollment';
import { assertCausalCapability } from './causalCapability';
import { parseCausalCompletion, assertCausalCompletionReceipt, type CausalCompletionOperation } from './causalCompletionProtocol';
import { assertNewSyncPayload, SYNC_STAGED_BODY_BYTES } from './syncEnvelope';
import { applyPushResults, emptySyncMeta, normalizeSyncMeta, stableJson, syncEntityKey, type SyncMeta } from './syncProtocol';
import { sendCausalCompletion } from './causalCompletionTransport';
import { parseCausalOperation, assertCausalReceipt } from './causalProtocol';

const stores = ['tasks', 'stats', 'progress', 'goals', 'habits', 'task_events'] as const;
type Member = CausalCompletionOperation['changes'][number];
type Dependency = { kind: 'legacy' | 'completion'; actionId?: string; request: Member };
export interface CompletionIntent {
  focus: LocalFocusIntent;
  details: CompletionDetails;
  deviceId: string;
}
export interface CompletionAdmission {
  intent: CompletionIntent;
  epoch: string;
  command: FocusCommand;
  outcome: FocusOutcome;
  members: Member[];
  dependencies: Record<string, Dependency>;
  /** Original affected records, not unrelated users or whole-store snapshots. */
  preimages: Record<string, unknown>;
  earnedXp?: number;
  dayComplete?: boolean;
  leveledUp?: boolean;
}
export interface CompletionAccountState extends FocusAccountState, CausalEnrollmentState {
  completionAdmissions?: Record<string, CompletionAdmission>;
  completionOutbox?: Record<string, CompletionAdmission>;
  completionRequests?: Record<string, string>;
  completionReceipts?: Record<string, Record<string, any>>;
  causalReceipts?: Record<string, Record<string, any>>;
}
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const identity = (intent: CompletionIntent, entity: string) => uuidv5(`completion-v1:${intent.focus.accountId}:${entity}`, intent.focus.actionId);
const memberMeaning = ({ baseServerVersion: _base, ...member }: Member) => member;

export function assertCompletionCapturesMaterialized(accountId: string, meta: SyncMeta) {
  if (Object.keys(meta.localState?.blocked ?? {}).length) throw new Error('Retained local capture reviews must be resolved before completion. Final notes remain available to retry.');
  if (typeof window === 'undefined') return;
  for (const store of [...stores, 'tracking', 'sync']) {
    const raw = window.localStorage.getItem(`goalflow_fallback_${store}_${accountId}`);
    if (raw !== null && !meta.localState?.fallbackCopies?.[store]?.includes(raw)) {
      throw new Error('A retained fallback copy requires recovery before completion.');
    }
  }
  const prefix = `goalflow_wal_v2_${encodeURIComponent(accountId)}_`;
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = window.localStorage.getItem(key);
    if (raw === null || meta.localState?.groups?.[key] === raw) continue;
    let value: any;
    try { value = JSON.parse(raw); } catch (_) { throw new Error('A retained local capture requires recovery before completion.'); }
    if (!object(value) || typeof value.id !== 'string' || !same(meta.localState?.journal[value.id], value)) {
      throw new Error('Materialize or recover retained local captures before completion. Final notes remain available to retry.');
    }
  }
}

async function run<T>(name: string, accountId: string, work: (state: CompletionAccountState, meta: SyncMeta,
  tx: IDBPTransaction<unknown, string[], 'readwrite'>) => Promise<T>): Promise<T> {
  const db = await openDB(name);
  try {
    if (!db.objectStoreNames.contains(CAUSAL_STORE)) throw new Error('Explicit causal enrollment is required before completion.');
    const tx = db.transaction(causalBusinessTransactionStores(db, [CAUSAL_STORE, 'tracking', 'sync', ...stores]), 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, accountId) as CompletionAccountState | undefined;
      if (!state || !state.trackingPresent || !object(state.trackingValue)) throw new Error('Completion requires retained causal tracking.');
      const rawMeta = await readCausalBusiness(tx, 'sync', accountId);
      const meta = normalizeSyncMeta(rawMeta);
      const beforeState = stableJson(state), beforeMeta = stableJson(meta);
      const result = await work(state, meta, tx);
      if (stableJson(state) !== beforeState || stableJson(meta) !== beforeMeta) {
        if (!Number.isSafeInteger(state.generation + 1)) throw new Error('Local generation exhausted.');
        state.generation++;
        meta.localState ??= { generation: 0, journal: {}, receipts: {} };
        if (!Number.isSafeInteger(meta.localState.generation + 1)) throw new Error('Local generation exhausted.');
        meta.localState.generation++;
        await tx.objectStore(CAUSAL_STORE).put(state);
        await writeCausalBusiness(tx, 'sync', accountId, { ...(object(rawMeta) ? rawMeta : {}), ...meta });
      }
      await tx.done;
      return structuredClone(result);
    } catch (error) {
      try { tx.abort(); } catch (_) {}
      try { await tx.done; } catch (_) {}
      throw error;
    }
  } finally { db.close(); }
}

/** Intent is copied before any await. Business effects and the actual focus
 * parent are derived only after acquiring the same transaction as persistence.
 * This remains dormant until the application rollout coordinator selects it. */
export async function admitLocalCompletion(name: string, captured: CompletionIntent) {
  const intent = structuredClone(captured);
  validateFocusCommand({ ...intent.focus, expectedRevision: null });
  validateCompletionDetails(intent.details);
  if (intent.focus.kind !== 'complete' || typeof intent.deviceId !== 'string' || !intent.deviceId.length || intent.deviceId.length > 128) {
    throw new Error('Invalid completion intent. Nothing was admitted.');
  }
  const accountId = intent.focus.accountId, id = intent.focus.actionId;
  return run(name, accountId, async (state, meta, tx) => {
    if (!object(state.trackingValue)) throw new Error('Completion requires valid tracking.');
    const prior = state.completionAdmissions?.[id];
    const known = state.actionIdentities?.[id];
    if (known && (known.kind !== 'completion' || !same(known.intent, intent))) throw new Error('The completion identity has different intent.');
    if (known && !prior) throw new Error('The completion identity is missing its original admission.');
    if (prior) {
      assertAdmission(state, id);
      if (!same(prior.intent, intent)) throw new Error('The completion identity has different intent.');
      return { duplicate: true, admission: prior };
    }
    const capability = assertCausalCapability(accountId, state.causalCapability);
    if (!capability.enrolled) throw new Error('Completion requires the established account epoch.');
    assertCompletionCapturesMaterialized(accountId, meta);
    const journal = state.focus ?? initialFocusJournal(accountId, state.trackingValue.focusSession);
    const current = journal.currentSessionId ? journal.sessions[journal.currentSessionId] : undefined;
    const command: FocusCommand = { ...intent.focus, expectedRevision: current?.revision ?? null };
    const result = applyFocusCommand(journal, command);
    const admission: CompletionAdmission = { intent, epoch: capability.epoch, command, outcome: result.outcome, members: [], dependencies: {}, preimages: {} };
    if (result.outcome.accepted) {
      const collections: any = {};
      for (const store of stores) {
        const value = await readCausalBusiness(tx, store, accountId);
        if (value === undefined && Object.keys(meta.versions).some(key => key === store || key.startsWith(`${store}:`))) {
          throw new Error('An absent completion collection has retained version evidence and requires recovery.');
        }
        collections[store] = value ?? (store === 'stats' ? {} : store === 'progress' ? { level: 1, xp: 0, xpToNextLevel: 100 } : []);
      }
      const eventId = identity(intent, 'event');
      const derived = deriveTaskCompletion(collections, command.taskId, command.capturedAt, intent.details, eventId, id);
      admission.earnedXp = derived.earnedXp; admission.dayComplete = derived.dayComplete; admission.leveledUp = derived.leveledUp;
      meta.localState ??= { generation: 0, journal: {}, receipts: {} };
      const reservations = meta.localState.completionReservations ??= {};
      for (const store of stores) {
        const before = collections[store], after = derived.collections[store];
        if (same(before, after)) continue;
        const beforeRows = Array.isArray(before) ? before : undefined;
        const changed = Array.isArray(after) ? after.filter(row => !same(beforeRows?.find(item => item.id === row.id), row)) : [after];
        if (changed.length !== 1) throw new Error('Completion must bind exactly one member per changed collection.');
        const payload = changed[0], entityId = Array.isArray(after) ? payload.id : 'singleton';
        assertNewSyncPayload(payload);
        const key = syncEntityKey(store, entityId), mutationId = identity(intent, store);
        if (meta.conflicts.some(item => item.entityType === store && item.entityId === entityId)) throw new Error('Resolve the affected entity conflict before completion.');
        if (meta.outbox.some(item => item.mutationId === mutationId) || meta.localState.receipts[mutationId] || reservations[mutationId]
          || meta.outbox.some(item => item.mutationId === id) || meta.localState.receipts[id] || state.actionIdentities?.[mutationId]
          || Object.values(meta.localState.journal).some(entry => [id, mutationId].includes(entry.id)
            || entry.changes.some(change => [id, mutationId].includes(change.mutationId)))) throw new Error('Completion reuses an existing mutation identity.');
        const older = meta.outbox.filter(item => item.entityType === store && item.entityId === entityId);
        const reserved = Object.entries(reservations).filter(([, entry]) => entry.entityType === store && entry.entityId === entityId);
        const predecessors = [...older.map(request => ({ kind: 'legacy' as const, request })), ...reserved.map(([memberId, entry]) => {
          const previous = state.completionAdmissions?.[entry.actionId]?.members.find(item => item.mutationId === memberId);
          if (!previous || !same({ actionId: entry.actionId, entityType: previous.entityType, entityId: previous.entityId, version: previous.version }, entry)) {
            throw new Error('Completion reservation is missing its original admission.');
          }
          return { kind: 'completion' as const, actionId: entry.actionId, request: previous };
        })].sort((a, b) => b.request.version - a.request.version);
        if (new Set(predecessors.map(item => item.request.version)).size !== predecessors.length) throw new Error('Ambiguous predecessor versions require recovery before completion.');
        const latest = predecessors[0];
        const versionEntry = meta.versions[key] ?? (entityId === 'singleton' ? meta.versions[store] : undefined);
        const version = Math.max(versionEntry?.local ?? 0, latest?.request.version ?? 0) + 1;
        const member: Member = { mutationId, entityType: store, entityId, deviceId: intent.deviceId,
          baseServerVersion: latest ? null : versionEntry?.server ?? null, version, payload, updatedAt: command.capturedAt, deletedAt: null };
        if (latest) {
          const r = latest.request;
          admission.dependencies[mutationId] = { kind: latest.kind, ...('actionId' in latest ? { actionId: latest.actionId } : {}),
            request: { mutationId: r.mutationId, entityType: r.entityType as Member['entityType'], entityId: r.entityId, deviceId: r.deviceId,
              baseServerVersion: r.baseServerVersion, version: r.version, payload: r.payload as Record<string, any>, updatedAt: r.updatedAt, deletedAt: null } };
          if (r.deletedAt !== null || r.resolvesConflictId) throw new Error('A completion predecessor requires explicit recovery.');
        }
        admission.members.push(member);
        admission.preimages[key] = structuredClone(Array.isArray(before) ? before.find(row => row.id === entityId) : before);
        reservations[mutationId] = { actionId: id, entityType: store, entityId, version };
        meta.versions[key] = { local: version, server: versionEntry?.server ?? null };
      }
      const operation = parseCausalCompletion(accountId, { schemaVersion: 2, epoch: capability.epoch, type: 'completion', command, changes: admission.members });
      // Reserve room for every dependency's largest possible safe server version.
      const maximum = { ...operation, changes: operation.changes.map(member => ({ ...member, baseServerVersion: Number.MAX_SAFE_INTEGER })) };
      if (new TextEncoder().encode(JSON.stringify(maximum)).byteLength > SYNC_STAGED_BODY_BYTES) throw new Error('The complete action exceeds the 4 MiB transport envelope. Nothing was completed.');
      for (const store of stores) if (!same(collections[store], derived.collections[store])) await writeCausalBusiness(tx, store, accountId, derived.collections[store]);
      state.trackingValue = { ...state.trackingValue, focusSession: result.journal.sessions[result.journal.currentSessionId!].projection };
      await tx.objectStore('tracking').put({ [TRACKING_KEY_PATH]: accountId, payload: state.trackingValue });
      state.completionOutbox ??= {}; state.completionOutbox[id] = admission;
    }
    state.focus = result.journal;
    state.actionIdentities ??= {}; state.actionIdentities[id] = { kind: 'completion', intent };
    state.completionAdmissions ??= {}; state.completionAdmissions[id] = admission;
    return { duplicate: false, admission };
  });
}

function assertAdmission(state: CompletionAccountState, id: string) {
  const admission = state.completionAdmissions?.[id];
  if (!admission || admission.command.actionId !== id || admission.command.accountId !== state.accountKey
    || !same(state.actionIdentities?.[id], { kind: 'completion', intent: admission.intent })) throw new Error('The original completion admission is missing.');
  if (state.completionOutbox?.[id] && !same(state.completionOutbox[id], admission)) throw new Error('The pending completion differs from its original admission.');
  return admission;
}

export function assertCompletionAdmissionOperation(admission: CompletionAdmission, operation: CausalCompletionOperation) {
  if (operation.epoch !== admission.epoch || !same(operation.command, admission.command)
    || !same(operation.changes.map(memberMeaning), admission.members.map(memberMeaning))) throw new Error('The saved completion differs from its durable admission.');
  for (const member of operation.changes) {
    const original = admission.members.find(item => item.mutationId === member.mutationId)!;
    if (!admission.dependencies[member.mutationId] && member.baseServerVersion !== original.baseServerVersion) throw new Error('The saved completion rewrites its original base version.');
  }
}


function resolvedMembers(accountId: string, state: CompletionAccountState, meta: SyncMeta, admission: CompletionAdmission): Member[] {
  return admission.members.map(member => {
      const dependency = admission.dependencies[member.mutationId];
      if (!dependency) return member;
      let request: Member, result: any;
      if (dependency.kind === 'completion') {
        const bytes = state.completionRequests?.[dependency.actionId!], receipt = state.completionReceipts?.[dependency.actionId!];
        if (!bytes || !receipt) throw new Error('Completion awaits its preceding logical action receipt.');
        const operation = parseCausalCompletion(accountId, JSON.parse(bytes));
        assertCausalCompletionReceipt(accountId, operation, receipt);
        if (!receipt.accepted) throw new Error('A preceding completion requires recovery.');
        request = operation.changes.find(item => item.mutationId === dependency.request.mutationId)!;
        result = receipt.changes.find((item: any) => item.mutationId === dependency.request.mutationId);
      } else {
        const evidence = meta.localState?.receipts[dependency.request.mutationId];
        if (!evidence) throw new Error('Completion awaits its preceding entity receipt.');
        request = { ...dependency.request, baseServerVersion: evidence.request.baseServerVersion };
        if (!same(memberMeaning(request), memberMeaning({ mutationId: evidence.request.mutationId, entityType: evidence.request.entityType as Member['entityType'],
          entityId: evidence.request.entityId, deviceId: evidence.request.deviceId, baseServerVersion: evidence.request.baseServerVersion,
          version: evidence.request.version, payload: evidence.request.payload as Record<string, any>, updatedAt: evidence.request.updatedAt, deletedAt: evidence.request.deletedAt as null }))) {
          throw new Error('The preceding entity receipt has a different original request.');
        }
        applyPushResults(emptySyncMeta(), [evidence.request], [evidence.result], admission.command.capturedAt);
        result = evidence.result;
        if (!result.accepted || (result.record?.user_id ?? result.record?.userId) !== accountId) throw new Error('The preceding entity receipt needs recovery.');
      }
      if (!request || !result || !same(memberMeaning(request), memberMeaning(dependency.request))) throw new Error('Completion predecessor evidence differs.');
      return { ...member, baseServerVersion: result.serverVersion };
    });
}

/** Freeze wire bytes once predecessor receipts are durable. Local completion
 * does not require connectivity; an unavailable predecessor leaves it queued. */
export async function prepareCompletionRequest(name: string, accountId: string, id: string) {
  return run(name, accountId, async (state, meta) => {
    const admission = assertAdmission(state, id);
    const capability = assertCausalCapability(accountId, state.causalCapability);
    if (!capability.enrolled || capability.epoch !== admission.epoch) throw new Error('Completion needs its original account epoch.');
    const prior = state.completionRequests?.[id];
    if (prior !== undefined) {
      const operation = parseCausalCompletion(accountId, JSON.parse(prior));
      assertCompletionAdmissionOperation(admission, operation);
      if (!same(operation.changes, resolvedMembers(accountId, state, meta, admission))) throw new Error('The attempted completion has different dependency evidence.');
      return prior;
    }
    if (!state.completionOutbox?.[id] || !admission.outcome.accepted) throw new Error('The completion is not pending.');
    const parent = admission.command.expectedRevision;
    if (parent && (state.focusOutbox?.[parent] || state.causalRequests?.[parent])) {
      const bytes = state.causalRequests?.[parent], receipt = state.causalReceipts?.[parent];
      if (!bytes || !receipt) throw new Error('Completion awaits its causal focus predecessor receipt.');
      const operation = parseCausalOperation(accountId, JSON.parse(bytes));
      assertCausalReceipt(accountId, operation, receipt);
      if (!receipt.accepted || !same(operation.command, state.focusAdmissions?.[parent]?.command)) throw new Error('Completion predecessor focus evidence requires recovery.');
    }
    if (parent && state.completionAdmissions?.[parent] && state.completionReceipts?.[parent]?.accepted !== true) throw new Error('Completion awaits its causal predecessor receipt.');
    const changes = resolvedMembers(accountId, state, meta, admission);
    const operation = parseCausalCompletion(accountId, { schemaVersion: 2, epoch: admission.epoch, type: 'completion', command: admission.command, changes });
    const bytes = JSON.stringify(operation);
    if (new TextEncoder().encode(bytes).byteLength > SYNC_STAGED_BODY_BYTES) throw new Error('Completion requires large-action recovery. Its admission remains retained.');
    state.completionRequests ??= {}; state.completionRequests[id] = bytes;
    return bytes;
  });
}

/** Archive exact outer/member receipts together and release only their own
 * reservations. Receipt snapshots never overwrite newer local projections. */
export async function commitCompletionReceipt(name: string, accountId: string, id: string, input: unknown) {
  const receipt = structuredClone(input);
  return run(name, accountId, async (state, meta) => retainCompletionReceipt(accountId, state, meta, id, receipt));
}

/** Caller must own the transaction containing authority and sync metadata.
 * Shared by direct responses and atomic downloaded-history application. */
export function retainCompletionReceipt(accountId: string, state: CompletionAccountState, meta: SyncMeta, id: string, receipt: unknown) {
  const admission = assertAdmission(state, id), bytes = state.completionRequests?.[id];
  if (!bytes) throw new Error('The original completion request is missing.');
  const operation = parseCausalCompletion(accountId, JSON.parse(bytes));
  assertCompletionAdmissionOperation(admission, operation);
  if (!same(operation.changes, resolvedMembers(accountId, state, meta, admission))) throw new Error('The attempted completion has different dependency evidence.');
  const verified = assertCausalCompletionReceipt(accountId, operation, receipt);
  const prior = state.completionReceipts?.[id];
  if (prior) {
    if (!same(prior, verified)) throw new Error('The original completion receipt is immutable.');
    return { duplicate: true, accepted: prior.accepted as boolean };
  }
  if (!state.completionOutbox?.[id]) throw new Error('The pending completion is missing.');
  if (verified.accepted) {
    for (let index = 0; index < operation.changes.length; index++) {
      const member = operation.changes[index], result = verified.changes[index];
      const reservation = meta.localState?.completionReservations?.[member.mutationId];
      if (!same(reservation, { actionId: id, entityType: member.entityType, entityId: member.entityId, version: member.version })) throw new Error('The completion reservation differs from its receipt.');
      for (const later of meta.outbox) if (later.dependsOnMutationId === member.mutationId) {
        if (later.attemptedAt) throw new Error('An attempted successor requires explicit recovery. Its request was not rewritten.');
        later.dependsOnMutationId = undefined; later.baseServerVersion = result.serverVersion;
      }
      const key = syncEntityKey(member.entityType, member.entityId), version = meta.versions[key];
      meta.versions[key] = { local: Math.max(version?.local ?? 0, member.version), server: Math.max(version?.server ?? 0, result.serverVersion) };
      delete meta.localState!.completionReservations![member.mutationId];
    }
    delete state.completionOutbox![id];
  }
  state.completionReceipts ??= {}; state.completionReceipts[id] = verified;
  return { duplicate: false, accepted: verified.accepted as boolean };
}

export async function syncLocalCompletion(name: string, accountId: string, id: string, runtime: Parameters<typeof sendCausalCompletion>[2]) {
  const bytes = await prepareCompletionRequest(name, accountId, id);
  const retained = await run(name, accountId, async state => state.completionReceipts?.[id]);
  if (retained) {
    assertCausalCompletionReceipt(accountId, parseCausalCompletion(accountId, JSON.parse(bytes)), retained);
    return { duplicate: true, accepted: retained.accepted as boolean };
  }
  return commitCompletionReceipt(name, accountId, id, await sendCausalCompletion(accountId, bytes, runtime));
}

/** Restore validates the complete journal/reservation binding before creating
 * or changing a database. Unknown evidence remains in the original artifact. */
export function validateCompletionEvidence(accountId: string, state: CompletionAccountState, sync: unknown, collections?: Record<string, unknown>) {
  if ([state.completionAdmissions, state.completionOutbox, state.completionRequests, state.completionReceipts].every(value => value === undefined)
    && !(object(sync) && object(sync.localState) && sync.localState.completionReservations !== undefined)) return;
  for (const value of [state.completionAdmissions, state.completionOutbox, state.completionRequests, state.completionReceipts]) {
    if (value !== undefined && !object(value)) throw new Error('The completion evidence ledger is invalid.');
  }
  const meta = normalizeSyncMeta(sync);
  const capability = assertCausalCapability(accountId, state.causalCapability);
  if (!capability.enrolled) throw new Error('Completion evidence has no established account epoch.');
  const expectedReservations: NonNullable<NonNullable<SyncMeta['localState']>['completionReservations']> = {};
  for (const [id, value] of Object.entries(state.completionAdmissions ?? {})) {
    const admission = assertAdmission(state, id);
    if (!object(value.intent) || !object(value.intent.focus) || !object(value.outcome) || !Array.isArray(value.members)
      || !object(value.dependencies) || !object(value.preimages) || typeof value.epoch !== 'string') throw new Error('The completion admission evidence is invalid.');
    validateFocusCommand(admission.command); validateCompletionDetails(admission.intent.details);
    if (admission.epoch !== capability.epoch || admission.command.kind !== 'complete'
      || !same({ ...admission.intent.focus, expectedRevision: admission.command.expectedRevision }, admission.command)
      || typeof admission.outcome.accepted !== 'boolean') throw new Error('Completion admission intent differs from its command.');
    if (admission.outcome.accepted) {
      parseCausalCompletion(accountId, { schemaVersion: 2, epoch: admission.epoch, type: 'completion', command: admission.command, changes: admission.members });
      if (admission.members.some(member => member.deviceId !== admission.intent.deviceId)) throw new Error('Completion member device differs from its captured intent.');
      if (admission.outcome.code !== 'APPLIED' || admission.outcome.revision !== id) throw new Error('Completion admission outcome differs.');
      if (!state.completionOutbox?.[id] && state.completionReceipts?.[id]?.accepted !== true) throw new Error('An admitted completion has neither a pending intent nor an accepted receipt.');
      if (state.completionOutbox?.[id] && state.completionReceipts?.[id]?.accepted === true) throw new Error('An accepted completion still has pending reservations.');
    } else if (admission.members.length || Object.keys(admission.dependencies).length || state.completionOutbox?.[id]) {
      throw new Error('A rejected local completion has member effects.');
    }
    for (const [memberId, dependency] of Object.entries(admission.dependencies)) {
      if (!object(dependency) || !['legacy', 'completion'].includes(dependency.kind) || !object(dependency.request)
        || !admission.members.some(member => member.mutationId === memberId && member.entityType === dependency.request.entityType
          && member.entityId === dependency.request.entityId && member.version > dependency.request.version)) throw new Error('Completion dependency evidence is invalid.');
    }
    if (state.completionOutbox?.[id]) for (const member of admission.members) {
      if (expectedReservations[member.mutationId]) throw new Error('Completion members repeat a reserved identity.');
      expectedReservations[member.mutationId] = { actionId: id, entityType: member.entityType, entityId: member.entityId, version: member.version };
    }
  }
  for (const id of Object.keys(state.completionOutbox ?? {})) assertAdmission(state, id);
  if (!same(expectedReservations, meta.localState?.completionReservations ?? {})) throw new Error('Completion reservations differ from their durable intents.');
  for (const [id, bytes] of Object.entries(state.completionRequests ?? {})) {
    if (typeof bytes !== 'string') throw new Error('The completion request evidence is invalid.');
    const admission = assertAdmission(state, id), operation = parseCausalCompletion(accountId, JSON.parse(bytes));
    assertCompletionAdmissionOperation(admission, operation);
    if (!same(operation.changes, resolvedMembers(accountId, state, meta, admission))) throw new Error('The attempted completion has different dependency evidence.');
    if (state.completionReceipts?.[id]) assertCausalCompletionReceipt(accountId, operation, state.completionReceipts[id]);
  }
  if (Object.keys(state.completionReceipts ?? {}).some(id => !state.completionRequests?.[id])) throw new Error('A completion receipt has no original request.');
  if (collections) {
    const latest = new Map<string, Member>();
    for (const admission of Object.values(state.completionOutbox ?? {})) for (const member of admission.members) {
      const key = syncEntityKey(member.entityType, member.entityId);
      if ((latest.get(key)?.version ?? 0) < member.version) latest.set(key, member);
    }
    for (const member of latest.values()) {
      const successors = meta.outbox.filter(item => item.entityType === member.entityType && item.entityId === member.entityId && item.version > member.version);
      const conflicts = meta.conflicts.filter(item => item.entityType === member.entityType && item.entityId === member.entityId)
        .flatMap(item => item.localHistory).filter(item => item.version > member.version);
      const expected = [...successors, ...conflicts, member].sort((a, b) => b.version - a.version)[0];
      const value = collections[member.entityType];
      const matching = member.entityId === 'singleton' ? [value] : Array.isArray(value) ? value.filter(row => object(row) && row.id === member.entityId) : [];
      const valid = expected.deletedAt
        ? matching.length === 0 || (matching.length === 1 && (matching[0] === undefined || same(matching[0], expected.payload)))
        : matching.length === 1 && same(matching[0], expected.payload);
      if (!valid) {
        throw new Error('The completion backup projection differs from its retained final effects.');
      }
    }
  }
}
