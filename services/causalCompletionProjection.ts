import { assertCausalCompletionReceipt, parseCausalCompletion } from './causalCompletionProtocol';
import { assertCompletionAdmissionOperation, retainCompletionReceipt, type CompletionAccountState } from './causalCompletionCoordinator';
import { stableJson, syncEntityKey, type SyncMeta } from './syncProtocol';
import { validateSavedCausalHistory, type SavedCausalHistory } from './causalHistory';

export const COMPLETION_STORES = ['tasks', 'stats', 'progress', 'goals', 'habits', 'task_events'] as const;
export interface CompletionHistoryProof { epoch: string; revision: number; sha256: string }
interface CompletionApplication extends CompletionHistoryProof {
  preimages: Record<string, unknown>;
  decisions: Record<string, 'applied' | 'local-admission' | 'represented'>;
}
export interface CompletionProjectionState extends CompletionAccountState {
  completionApplications?: Record<string, CompletionApplication>;
  completionApplicationReviews?: Record<string, CompletionHistoryProof & { actionId: string; code: string; entityKey?: string }>;
}
export class CompletionProjectionReview extends Error {
  constructor(readonly actionId: string, readonly code: string, readonly entityKey?: string) {
    super('Completion needs recovery review before applying its final effects. All versions remain retained.');
  }
}
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** Plans member projections in transaction-owned values. The caller commits
 * these values, tracking, metadata and authority together, or aborts all of it.
 * No receipt cursor is interpreted as an authoritative ordinary pull cursor. */
export function applyCompletionHistory(accountId: string, state: CompletionProjectionState, meta: SyncMeta,
  values: Record<string, unknown>, receipt: Record<string, any>, proof: CompletionHistoryProof) {
  const operation = parseCausalCompletion(accountId, receipt.operation);
  assertCausalCompletionReceipt(accountId, operation, receipt);
  const id = operation.command.actionId;
  if (proof.epoch !== operation.epoch || proof.revision !== receipt.projectionRevision || !/^[a-f0-9]{64}$/.test(proof.sha256)) {
    throw new Error('The completion application has different history evidence.');
  }
  const local = state.completionAdmissions?.[id], existing = state.actionIdentities?.[id];
  if (local) {
    assertCompletionAdmissionOperation(local, operation);
    if (!same(existing, { kind: 'completion', intent: local.intent })) throw new Error('The original completion identity differs.');
    if (!receipt.accepted) throw new CompletionProjectionReview(id, 'COMPLETION_REJECTED');
  } else if (existing && !same(existing, { kind: 'remote-completion', intent: operation })) {
    throw new Error('The remote completion reuses a local action identity.');
  }
  const previous = state.completionApplications?.[id];
  if (previous && (previous.epoch !== proof.epoch || previous.revision !== proof.revision || previous.sha256 !== proof.sha256)) {
    throw new Error('The retained completion application has different history evidence.');
  }
  const application: CompletionApplication = { ...proof, preimages: {}, decisions: {} };
  const changed = new Set<string>();
  if (receipt.accepted) for (let index = 0; index < operation.changes.length; index++) {
    const member = operation.changes[index], result = receipt.changes[index];
    const key = syncEntityKey(member.entityType, member.entityId), collection = values[member.entityType];
    const singleton = member.entityType === 'stats' || member.entityType === 'progress';
    if (singleton ? collection !== undefined && !object(collection) : collection !== undefined && !Array.isArray(collection)) {
      throw new CompletionProjectionReview(id, 'COMPLETION_COLLECTION_REVIEW', key);
    }
    const rows = singleton ? undefined : (collection ?? []) as any[];
    if (rows && (rows.some(row => !object(row) || typeof row.id !== 'string' || !row.id)
      || new Set(rows.map(row => row.id)).size !== rows.length)) throw new CompletionProjectionReview(id, 'COMPLETION_COLLECTION_REVIEW', key);
    const current = singleton ? collection : rows!.find(row => row.id === member.entityId);
    const known = meta.versions[key] ?? (singleton ? meta.versions[member.entityType] : undefined);
    const serverVersion = known?.server ?? 0;
    const pending = meta.outbox.some(item => item.entityType === member.entityType && item.entityId === member.entityId)
      || meta.conflicts.some(item => item.entityType === member.entityType && item.entityId === member.entityId)
      || Object.values(meta.localState?.completionReservations ?? {}).some(item => item.entityType === member.entityType && item.entityId === member.entityId);
    if (state.actionIdentities?.[member.mutationId]) throw new Error('A completion member reuses a local action identity.');
    if (serverVersion >= result.serverVersion) {
      if (serverVersion === result.serverVersion && !pending && !same(current, member.payload)) {
        throw new CompletionProjectionReview(id, 'COMPLETION_PROJECTION_MISMATCH', key);
      }
      application.decisions[key] = 'represented';
    } else if (local && (state.completionOutbox?.[id] || same(current, member.payload))) {
      // The full local journal and its latest effect projections were verified
      // by the caller before any action was retired. Keep subsequent edits.
      application.decisions[key] = 'local-admission';
    } else {
      if (pending) throw new CompletionProjectionReview(id, 'COMPLETION_LOCAL_REVIEW', key);
      // An unversioned record is not proof of a server preimage. Known empty
      // application defaults are the only non-absent creation baselines. A
      // versioned replica may skip intermediate snapshots: this newer exact
      // server receipt is authoritative when it has no pending local edits.
      const emptyDefault = member.entityType === 'stats' && object(current) && Object.keys(current).length === 0
        || member.entityType === 'progress' && same(current, { level: 1, xp: 0, xpToNextLevel: 100 });
      if (serverVersion === 0 && ((known?.local ?? 0) > 0 || (current !== undefined && !emptyDefault))) {
        throw new CompletionProjectionReview(id, 'COMPLETION_BASE_REQUIRED', key);
      }
      application.preimages[key] = structuredClone(current);
      values[member.entityType] = singleton ? structuredClone(member.payload)
        : current === undefined ? [...rows!, structuredClone(member.payload)]
          : rows!.map(row => row.id === member.entityId ? structuredClone(member.payload) : row);
      changed.add(member.entityType);
      application.decisions[key] = 'applied';
    }
    meta.versions[key] = { local: Math.max(known?.local ?? 0, member.version), server: Math.max(serverVersion, result.serverVersion) };
  }
  if (local && state.completionRequests?.[id]) retainCompletionReceipt(accountId, state, meta, id, receipt);
  state.actionIdentities ??= {};
  if (!local) state.actionIdentities[id] = { kind: 'remote-completion', intent: operation };
  state.completionApplications ??= {};
  state.completionApplications[id] ??= application;
  return changed;
}

/** Completion application proofs refer to exact retained history bodies. A
 * backup checksum alone cannot establish those internal identity bindings. */
export async function validateCompletionApplicationEvidence(accountId: string,
  state: CompletionProjectionState & { causalHistory?: SavedCausalHistory }) {
  if (state.completionApplications === undefined && state.completionApplicationReviews === undefined) return;
  if ((state.completionApplications !== undefined && !object(state.completionApplications))
    || (state.completionApplicationReviews !== undefined && !object(state.completionApplicationReviews)) || !state.causalHistory) {
    throw new Error('Completion application evidence is incomplete.');
  }
  const history = state.causalHistory;
  await validateSavedCausalHistory(accountId, history);
  const proof = (value: any) => object(value) && value.epoch === history.epoch && Number.isSafeInteger(value.revision)
    && value.revision >= 0 && value.revision <= history.downloadedRevision && value.sha256 === history.entries[String(value.revision)]?.sha256;
  for (const [id, application] of Object.entries(state.completionApplications ?? {})) {
    if (!proof(application) || application.revision === 0 || !object(application.preimages) || !object(application.decisions)) {
      throw new Error('Completion application has a different history proof.');
    }
    const receipt = JSON.parse(history.entries[String(application.revision)].body).receipt;
    const operation = parseCausalCompletion(accountId, receipt.operation);
    if (operation.command.actionId !== id) throw new Error('Completion application has a different action identity.');
    const keys = receipt.accepted ? operation.changes.map(member => syncEntityKey(member.entityType, member.entityId)).sort() : [];
    if (!same(Object.keys(application.decisions).sort(), keys)
      || Object.values(application.decisions).some(value => !['applied', 'local-admission', 'represented'].includes(value))
      || !same(Object.keys(application.preimages).sort(), Object.entries(application.decisions).filter(([, value]) => value === 'applied').map(([key]) => key).sort())) {
      throw new Error('Completion application effects differ from their receipt.');
    }
  }
  for (const [key, review] of Object.entries(state.completionApplicationReviews ?? {})) {
    if (!proof(review) || key !== stableJson(review) || typeof review.actionId !== 'string' || typeof review.code !== 'string'
      || (review.entityKey !== undefined && typeof review.entityKey !== 'string')) throw new Error('Completion recovery review has a different history proof.');
  }
}
