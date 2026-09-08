import { v5 as uuidv5 } from 'uuid';
import { applyCompletionReward } from '../src/domain/taskCompletion';
import { stableJson } from './syncProtocol';
import type { SyncMutation } from './syncProtocol';
import { confirmOrderSchema, type ConfirmOrder } from '../src/domain/deliberatePlanning';
import { assertPlanningReview, type PlanningReview } from './deliberatePlanningProtocol';
import type { CompletionAccountState, CompletionAdmission } from './causalCompletionCoordinator';

export interface PlanningEditProof {
  original: SyncMutation;
  predecessor: SyncMutation;
}
export interface PlanningRebaseState {
  accountKey: IDBValidKey;
  planningResolutions?: Record<string, PlanningCompletionResolution>;
  planningEdits?: Record<string, PlanningEditProof>;
  completionAdmissions?: CompletionAccountState['completionAdmissions'];
}

export interface PlanningCompletionResolution {
  command: ConfirmOrder;
  request?: string;
  members: SyncMutation[];
  snapshot: PlanningReview;
  /** An explicit order choice can supersede only an unattempted continuation
   * of the same day's provisional revision. It never fabricates a receipt. */
  supersededBy?: PlanningCompletionResolution;
  predecessors?: Record<string, NonNullable<CompletionAdmission['dependencies'][string]>>;
}

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const terminal = (task: Record<string, any>) => task.completed || task.wontDo || task.deletedAt
  || ['completed', 'dropped', 'archived', 'broken_down'].includes(task.lifecycleStatus);

export function assertPlanningCompletionResolution(accountId: string, resolution: PlanningCompletionResolution, visited = new Set<string>()) {
  confirmOrderSchema.parse(resolution.command);
  if (visited.has(resolution.command.operationId)) throw new Error('Planning resolution ancestry is cyclic.');
  if (resolution.supersededBy) {
    const parent = resolution.supersededBy;
    assertPlanningCompletionResolution(accountId, parent, new Set(visited).add(resolution.command.operationId));
    if (resolution.request !== undefined || resolution.command.accountId !== accountId
      || resolution.command.localDate !== parent.command.localDate || resolution.command.baselineRevision !== parent.command.operationId
      || !same(resolution.snapshot, parent.snapshot) || !object(resolution.predecessors)) {
      throw new Error('The superseded planning command differs from its unattempted same-day continuation.');
    }
  } else {
    assertPlanningReview(accountId, resolution.command, resolution.snapshot);
    if (resolution.request !== JSON.stringify(resolution.command) || resolution.predecessors !== undefined) throw new Error('The planning resolution has different request evidence.');
  }
  if (!Array.isArray(resolution.members)
    || resolution.members.some(member => member.mutationId !== uuidv5(`planning:${member.entityType}:${member.entityId}`, resolution.command.operationId))
    || new Set(resolution.members.map(member => member.mutationId)).size !== resolution.members.length) {
    throw new Error('The planning resolution has different original member identities.');
  }
  for (const [id, dependency] of Object.entries(resolution.predecessors ?? {})) {
    const member = resolution.members.find(m => m.mutationId === id);
    if (!member || !['planning', 'completion', 'legacy'].includes(dependency.kind) || !dependency.request
      || member.entityType !== dependency.request.entityType || member.entityId !== dependency.request.entityId
      || member.version <= dependency.request.version) throw new Error('The superseded order has different saved-action ancestry.');
  }
}

export function planningDependencyRecord(accountId: string, resolution: PlanningCompletionResolution, source: CompletionAdmission['members'][number]) {
  assertPlanningCompletionResolution(accountId, resolution);
  if (!resolution.members.some(member => same(member, source))) throw new Error('The planning resolution has different predecessor evidence.');
  const record = resolution.snapshot.records.find(row => row.entity_type === source.entityType && row.entity_id === source.entityId);
  if (!record || record.deleted_at) throw new Error('The completion predecessor was removed on another device.');
  return record;
}

export function planningPredecessor(state: PlanningRebaseState, resolution: PlanningCompletionResolution,
  source: CompletionAdmission['members'][number], visiting = new Set<string>()): {
    payload: unknown; record?: ReturnType<typeof planningDependencyRecord>;
    dependency?: NonNullable<CompletionAdmission['dependencies'][string]>;
  } {
  assertPlanningCompletionResolution(String(state.accountKey), resolution);
  if (!resolution.members.some(member => same(member, source))) throw new Error('The planning predecessor has a different original member.');
  const id = source.mutationId;
  if (visiting.has(id)) throw new Error('Planning saved-action ancestry is cyclic.');
  const next = new Set(visiting).add(id);
  const predecessor = resolution.predecessors?.[id];
  if (!predecessor) {
    const observed = resolution.snapshot.records.find(row => row.entity_type === source.entityType && row.entity_id === source.entityId);
    if ((!observed || observed.deleted_at) && source.entityType !== 'progress') {
      if (!observed && source.entityType === 'tasks' && !resolution.snapshot.missingTaskIds.includes(source.entityId)) throw new Error('The review does not account for this task.');
      return { payload: undefined, ...(observed ? { record: observed } : {}) };
    }
    const record = planningDependencyRecord(String(state.accountKey), resolution, source);
    return { payload: record.payload, record };
  }
  if (predecessor.kind === 'planning') {
    const prior = state.planningResolutions?.[predecessor.actionId!];
    if (!prior) throw new Error('The superseded order has no retained preceding order.');
    return planningPredecessor(state, prior, predecessor.request, next);
  }
  if (predecessor.kind === 'completion') {
    const original = state.completionAdmissions?.[predecessor.actionId!];
    const member = original?.members.find(m => m.mutationId === predecessor.request.mutationId);
    if (!original || !member) throw new Error('The superseded order lost its completion predecessor.');
    const effective = effectiveCompletionMembers(state, original, next).find(m => m.mutationId === member.mutationId)!;
    if (!same(member.payload, predecessor.request.payload) && !same(effective.payload, predecessor.request.payload)) throw new Error('The saved completion predecessor differs.');
    return { payload: effective.payload, dependency: { ...predecessor, request: effective } };
  }
  const original = state.planningEdits?.[predecessor.request.mutationId]?.original ?? predecessor.request as SyncMutation;
  const effective = effectivePlanningEdit(state, original, next);
  const { mutationId, entityType, entityId, deviceId, baseServerVersion, version, updatedAt, deletedAt } = predecessor.request;
  return { payload: effective.payload, dependency: { ...predecessor,
    request: { mutationId, entityType, entityId, deviceId, baseServerVersion, version, updatedAt, deletedAt, payload: effective.payload as any } } };
}

/** Every changed member is recomputed from the original admission and its
 * predecessor proof. No mutable copy of an admission becomes new authority. */
export function effectiveCompletionMembers(state: PlanningRebaseState, admission: CompletionAdmission,
  visiting = new Set<string>()): CompletionAdmission['members'] {
  const id = admission.command.actionId;
  if (visiting.has(id)) throw new Error('Completion dependency cycle requires recovery.');
  const next = new Set(visiting).add(id);
  return admission.members.map(member => {
    const dependency = admission.dependencies[member.mutationId];
    if (!dependency) return member;
    let replacement: unknown;
    if (dependency.kind === 'planning') {
      const resolution = state.planningResolutions?.[dependency.actionId!];
      if (!resolution) return member;
      if (resolution.command.operationId !== dependency.actionId) throw new Error('Planning resolution identity differs.');
      replacement = planningPredecessor(state, resolution, dependency.request, next).payload;
    } else if (dependency.kind === 'completion') {
      const prior = state.completionAdmissions?.[dependency.actionId!];
      const original = prior?.members.find(item => item.mutationId === dependency.request.mutationId);
      if (!prior || !original) throw new Error('The original completion predecessor differs.');
      const effective = effectiveCompletionMembers(state, prior, next).find(item => item.mutationId === original.mutationId)!;
      if (same(effective, dependency.request)) return member;
      if (!same(original, dependency.request)) throw new Error('The original completion predecessor differs.');
      if (same(effective.payload, original.payload)) return member;
      replacement = effective.payload;
    } else if (dependency.kind === 'legacy') {
      const proof = state.planningEdits?.[dependency.request.mutationId];
      if (!proof) return member;
      const effective = effectivePlanningEdit(state, proof.original, next);
      if (same(effective.payload, dependency.request.payload)) return member;
      if (!same(proof.original.payload, dependency.request.payload)) throw new Error('The captured saved edit differs from its retained original.');
      replacement = effective.payload;
    } else return member;
    if (same(replacement, dependency.request.payload)) return member;
    if (!same(admission.preimages[`${member.entityType}:${member.entityId}`], dependency.request.payload)) {
      throw new Error('The completion preimage differs from its captured predecessor.');
    }
    return { ...member, payload: rebasePlanningCompletionMember(member.entityType,
      dependency.request.payload, member.payload, replacement, admission.earnedXp) };
  });
}

/** Derive a new projection from an immutable completion and a verified planning
 * resolution. This is not permission to replace an attempted wire request. */
export function rebasePlanningCompletionMember(entityType: string, before: unknown, after: unknown,
  synced: unknown, earnedXp: number | undefined): Record<string, any> {
  if (!object(before) || !object(after) || !object(synced)) throw new Error('Completion rebase needs all three retained records.');
  if (entityType === 'progress') {
    if (!Number.isSafeInteger(earnedXp) || earnedXp! < 0
      || !same(applyCompletionReward(before, earnedXp!).progress, after)) {
      throw new Error('The captured reward does not prove the original completion balance.');
    }
    return applyCompletionReward(synced, earnedXp!).progress;
  }
  if (entityType !== 'tasks' || !before.id || before.id !== after.id || before.id !== synced.id
    || terminal(before) || after.completed !== true || after.lifecycleStatus !== 'completed') {
    throw new Error('The retained records do not prove a task completion.');
  }
  if (terminal(synced)) throw new Error('This task was already completed or removed on another device. Its completion needs review.');
  // Completion owns these fields. Ordering, ratings, scheduling, labels and
  // other task metadata come from the synced record, not the rejected plan.
  const owned = new Set(['completed', 'lifecycleStatus', 'completedAt', 'actualDuration', 'flowState', 'description']);
  const result = { ...synced };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue;
    if (!owned.has(key)) throw new Error('The saved completion also changes unrelated task fields.');
    if (key in after) result[key] = after[key]; else delete result[key];
  }
  return result;
}

/** Preserve ordinary saved edits as deltas over the chosen order. Original
 * mutation identities and predecessor payloads remain available for replay. */
export function effectivePlanningEdit(state: PlanningRebaseState, mutation: SyncMutation,
  visiting = new Set<string>()): SyncMutation {
  const proof = state.planningEdits?.[mutation.mutationId];
  if (!proof) return mutation;
  const { original, predecessor } = proof;
  if (original.mutationId !== mutation.mutationId || original.attemptedAt
    || original.dependsOnMutationId !== predecessor.mutationId
    || original.entityType !== predecessor.entityType || original.entityId !== predecessor.entityId
    || original.version <= predecessor.version || visiting.has(original.mutationId)) {
    throw new Error('The saved edit has different predecessor evidence.');
  }
  const next = new Set(visiting).add(original.mutationId);
  let replacement: unknown;
  const earlierEdit = state.planningEdits?.[predecessor.mutationId];
  if (earlierEdit) {
    const effective = effectivePlanningEdit(state, earlierEdit.original, next);
    if (!same(earlierEdit.original.payload, predecessor.payload) && !same(effective.payload, predecessor.payload)) {
      throw new Error('The saved edit predecessor was changed.');
    }
    replacement = effective.payload;
  } else {
    const completion = Object.values(state.completionAdmissions ?? {}).find(a => a.members.some(m => m.mutationId === predecessor.mutationId));
    if (completion) {
      const originalMember = completion.members.find(m => m.mutationId === predecessor.mutationId)!;
      const effective = effectiveCompletionMembers(state, completion, next).find(m => m.mutationId === predecessor.mutationId)!;
      if (!same(originalMember.payload, predecessor.payload) && !same(effective.payload, predecessor.payload)) {
        throw new Error('The saved edit has a different completion predecessor.');
      }
      replacement = effective.payload;
    } else {
      const resolution = Object.values(state.planningResolutions ?? {}).find(r => r.members.some(m => same(m, predecessor)));
      if (!resolution) throw new Error('The saved edit has no retained planning resolution.');
      replacement = planningPredecessor(state, resolution, predecessor as any, next).payload;
    }
  }
  return { ...mutation, payload: rebaseSavedTaskEdit(original.entityType, predecessor.payload, original.payload, replacement) };
}

export function rebaseSavedTaskEdit(entityType: string, before: unknown, after: unknown, synced: unknown) {
  if (entityType !== 'tasks' || !object(before) || !object(after) || !object(synced)
    || !before.id || before.id !== after.id || before.id !== synced.id) {
    throw new Error('This saved change needs separate review before resolving the order.');
  }
  // The order choice owns planning fields. These must never be smuggled into
  // the ordinary endpoint, even when a later edit captured the whole task.
  const planningFields = new Set(['plannedOrder', 'plannedOrderDate', 'excitement', 'roi', 'order', 'isFrog', 'beforeFrog', 'importance', 'urgency', 'priority', 'energyLevel']);
  const result = { ...synced };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue;
    if (planningFields.has(key)) throw new Error('A later ordering change needs its own planning review.');
    if (!same(synced[key], before[key]) && !same(synced[key], after[key])) {
      throw new Error(`Both devices changed ${key}. Your saved edit is retained for review.`);
    }
    if (terminal(synced) && ['completed', 'lifecycleStatus', 'deletedAt', 'wontDo'].includes(key)
      && !same(synced[key], after[key])) throw new Error('A saved edit cannot restore a completed or removed task.');
    if (key in after) result[key] = after[key]; else delete result[key];
  }
  return result;
}

export function assertPlanningRebaseState(state: PlanningRebaseState) {
  if (!state || typeof state.accountKey !== 'string') throw new Error('Planning edit evidence has no account.');
  for (const [id, resolution] of Object.entries(state.planningResolutions ?? {})) {
    if (resolution.command.operationId !== id) throw new Error('Planning resolution identity differs.');
    assertPlanningCompletionResolution(String(state.accountKey), resolution);
    if (resolution.supersededBy && !same(resolution.supersededBy, state.planningResolutions?.[resolution.supersededBy.command.operationId])) {
      throw new Error('The superseded order has a different retained ancestor.');
    }
    for (const member of resolution.members) if (resolution.supersededBy) planningPredecessor(state, resolution, member as any);

  }
  for (const [id, proof] of Object.entries(state.planningEdits ?? {})) {
    if (proof.original?.mutationId !== id) throw new Error('Saved edit identity differs.');
    effectivePlanningEdit(state, proof.original);
  }
}
