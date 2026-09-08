import { z } from 'zod';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const id = z.string().min(1).max(240);
const order = z.array(id).max(10000).refine(ids => new Set(ids).size === ids.length);
const rating = z.object({ taskId: id, excitement: z.number().int().min(0).max(100), roi: z.number().int().min(0).max(100) }).strict();
export const confirmOrderSchema = z.object({
  schemaVersion: z.literal(1), operationId: z.string().uuid(), accountId: id, localDate: day,
  baselineRevision: z.string().nullable(), proposedOrder: order,
  ratings: z.array(rating).max(10000).refine(items => new Set(items.map(item => item.taskId)).size === items.length),
  priorityChanges: z.array(z.object({ taskId: id, isFrog: z.literal(true) }).strict()).max(10000)
    .refine(items => new Set(items.map(item => item.taskId)).size === items.length).optional(),
  maximumAcceptedXp: z.number().int().min(0).max(50), capturedAt: z.string().datetime(),
}).strict();
export type ConfirmOrder = z.infer<typeof confirmOrderSchema>;
export type PlanningPenalty = 'classic' | 'gentle' | 'off';
export interface PlanningReceipt {
  command: ConfirmOrder;
  code: 'APPLIED' | 'STALE_REVISION' | 'COST_CHANGED';
  revision: string | null;
  acceptedReplans: number;
  actualDebit: number;
  requiredCost: number;
  order: string[];
}
/** This journal survives daily-plan clearing and task completion. Rejected
 * commands are also retained so a retry cannot turn a conflict into a write. */
export interface DailyPlanningPolicy {
  schemaVersion: 1;
  accountId: string;
  localDate: string;
  revision: string | null;
  confirmedOrder: string[];
  acceptedReplans: number;
  history: PlanningReceipt[];
}
export interface PlanningDraft {
  schemaVersion: 1;
  accountId: string;
  localDate: string;
  baselineRevision: string | null;
  proposedOrder: string[];
  ratings: ConfirmOrder['ratings'];
  priorityChanges?: ConfirmOrder['priorityChanges'];
  maximumAcceptedXp: number;
  updatedAt: string;
}
export interface PlanningTask {
  id: string;
  /** Existing scheduling precedence: before-Frog, Frog, ordinary, etc. */
  precedence: number;
}

export function initialPlanningPolicy(accountId: string, localDate: string,
  legacy?: { taskIds: string[]; confirmedAt: number | string }): DailyPlanningPolicy {
  id.parse(accountId); day.parse(localDate);
  const confirmedOrder = legacy ? order.parse(legacy.taskIds) : [];
  return { schemaVersion: 1, accountId, localDate,
    revision: legacy ? `legacy:${localDate}:${legacy.confirmedAt}` : null,
    confirmedOrder, acceptedReplans: 0, history: [] };
}

export function nextReplanCost(policy: DailyPlanningPolicy, setting: PlanningPenalty): number {
  return policy.revision === null || policy.acceptedReplans < 3 || setting === 'off' ? 0 : setting === 'gentle' ? 25 : 50;
}

/** Compare only surviving common identities. Additions/removals cannot consume
 * an allowance, and deleted/completed tasks cannot be resurrected by a draft. */
export function relativeOrderChanged(previous: readonly string[], proposed: readonly string[]): boolean {
  const before = new Set(previous), after = new Set(proposed);
  const left = previous.filter(id => after.has(id)), right = proposed.filter(id => before.has(id));
  return left.some((id, index) => id !== right[index]);
}

/** Existing relative order wins inside each scheduling-precedence group. New
 * tasks append in the order supplied by the existing scheduling comparator. */
export function reconcilePlanningOrder(proposed: readonly string[], available: readonly PlanningTask[]): string[] {
  const byId = new Map(available.map(task => [task.id, task]));
  if (byId.size !== available.length) throw new Error('Duplicate available planning task.');
  const seen = new Set<string>();
  return [...proposed, ...available.map(task => task.id)]
    .filter(id => byId.has(id) && !seen.has(id) && Boolean(seen.add(id)))
    .sort((a, b) => byId.get(a)!.precedence - byId.get(b)!.precedence);
}

function fingerprint(command: ConfirmOrder): string {
  return JSON.stringify([command.schemaVersion, command.operationId, command.accountId, command.localDate,
    command.baselineRevision, command.proposedOrder,
    command.ratings.map(r => [r.taskId, r.excitement, r.roi]),
    command.priorityChanges?.map(change => [change.taskId, change.isFrog]) ?? null,
    command.maximumAcceptedXp, command.capturedAt]);
}

/** Pure transaction decision. The caller must atomically persist policy, order,
 * accepted ratings and the returned XP balance; this function performs no IO. */
export function confirmPlanningOrder(policy: DailyPlanningPolicy, input: ConfirmOrder,
  available: readonly PlanningTask[], xp: number, setting: PlanningPenalty): {
    policy: DailyPlanningPolicy; receipt: PlanningReceipt; xp: number;
    ratings: ConfirmOrder['ratings']; replay: boolean;
  } {
  const command = confirmOrderSchema.parse(input);
  if (command.accountId !== policy.accountId || command.localDate !== policy.localDate) throw new Error('Planning scope mismatch.');
  if (!Number.isSafeInteger(xp) || xp < 0 || !Number.isSafeInteger(policy.acceptedReplans) || policy.acceptedReplans < 0) throw new Error('Invalid planning balance.');
  const prior = policy.history.find(item => item.command.operationId === command.operationId);
  if (prior) {
    if (fingerprint(prior.command) !== fingerprint(command)) throw new Error('Planning operation identity reused with different content.');
    return { policy, receipt: prior, xp, ratings: [], replay: true };
  }
  const promoted = new Set(command.priorityChanges?.map(change => change.taskId));
  const proposedOrder = reconcilePlanningOrder(command.proposedOrder,
    available.map(task => promoted.has(task.id) && task.precedence > 1 ? { ...task, precedence: 1 } : task));
  const existingOrder = reconcilePlanningOrder(policy.confirmedOrder, available);
  const availableIds = new Set(available.map(task => task.id));
  const changed = policy.revision !== null && relativeOrderChanged(
    policy.confirmedOrder.filter(id => availableIds.has(id)), proposedOrder);
  const cost = changed ? nextReplanCost(policy, setting) : 0;
  const code = command.baselineRevision !== policy.revision ? 'STALE_REVISION'
    : cost > command.maximumAcceptedXp ? 'COST_CHANGED' : 'APPLIED';
  const accepted = code === 'APPLIED';
  const actualDebit = accepted ? Math.min(xp, cost) : 0;
  const receipt: PlanningReceipt = { command, code,
    revision: accepted ? command.operationId : policy.revision,
    acceptedReplans: policy.acceptedReplans + (accepted && changed ? 1 : 0),
    actualDebit, requiredCost: cost, order: accepted ? proposedOrder : existingOrder };
  return { policy: { ...policy, revision: receipt.revision, acceptedReplans: receipt.acceptedReplans,
    confirmedOrder: accepted ? proposedOrder : policy.confirmedOrder, history: [...policy.history, receipt] },
    receipt, xp: xp - actualDebit,
    ratings: accepted ? command.ratings.filter(rating => availableIds.has(rating.taskId)) : [], replay: false };
}
