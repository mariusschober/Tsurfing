import { z } from 'zod';
import { confirmOrderSchema, type ConfirmOrder } from '../src/domain/deliberatePlanning';
import { stableJson } from './syncProtocol';

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const order = confirmOrderSchema.shape.proposedOrder;
export const planningReceiptSchema = z.object({ command: confirmOrderSchema,
  code: z.enum(['APPLIED', 'STALE_REVISION', 'COST_CHANGED']), revision: z.string().nullable(),
  acceptedReplans: integer, actualDebit: integer.max(50), requiredCost: integer.max(50), order,
}).strict();
export const dailyPlanningPolicySchema = z.object({ schemaVersion: z.literal(1), accountId: z.string().min(1),
  localDate: confirmOrderSchema.shape.localDate, revision: z.string().nullable(), confirmedOrder: order,
  acceptedReplans: integer, history: z.array(planningReceiptSchema),
}).strict().superRefine((policy, ctx) => {
  const identities = new Set<string>();
  for (const receipt of policy.history) {
    if (receipt.command.accountId !== policy.accountId || receipt.command.localDate !== policy.localDate
      || identities.has(receipt.command.operationId) || receipt.actualDebit > receipt.requiredCost
      || (receipt.code !== 'APPLIED' && receipt.actualDebit !== 0)
      || (receipt.code === 'APPLIED' && (receipt.revision !== receipt.command.operationId || receipt.requiredCost > receipt.command.maximumAcceptedXp))) {
      ctx.addIssue({ code: 'custom', message: 'Planning history does not prove a valid confirmation.' });
    }
    identities.add(receipt.command.operationId);
  }
  const last = policy.history.at(-1);
  if (last && (last.revision !== policy.revision || last.acceptedReplans !== policy.acceptedReplans)) {
    ctx.addIssue({ code: 'custom', message: 'Planning policy differs from its confirmation history.' });
  }
});
const record = z.object({ user_id: z.string().uuid(), entity_type: z.enum(['tasks', 'progress', 'daily_plans']),
  entity_id: z.string().min(1), version: integer.min(1), server_version: integer.min(1),
  device_id: z.string().min(1), payload: z.record(z.string(), z.unknown()),
  updated_at: z.string().refine(value => Number.isFinite(Date.parse(value))), deleted_at: z.null(),
}).passthrough();
const dayRecord = record.extend({ deleted_at: z.string().nullable() });
const responseSchema = z.object({ schemaVersion: z.literal(1), accountId: z.string().uuid(),
  receipt: planningReceiptSchema, policy: dailyPlanningPolicySchema, records: z.array(record),
}).strict();
export type PlanningResponse = z.infer<typeof responseSchema>;

export function assertPlanningResponse(accountId: string, command: ConfirmOrder, input: unknown): PlanningResponse {
  confirmOrderSchema.parse(command);
  const response = responseSchema.parse(input);
  const fail = () => { throw new Error('The planning response does not prove the complete confirmation.'); };
  if (command.accountId !== accountId || response.accountId !== accountId || response.policy.accountId !== accountId
    || response.policy.localDate !== command.localDate || stableJson(response.receipt.command) !== stableJson(command)
    || stableJson(response.policy.history.at(-1)) !== stableJson(response.receipt)) return fail();
  if (response.receipt.code !== 'APPLIED') {
    if (response.records.length) return fail();
    return response;
  }
  if (stableJson(response.policy.confirmedOrder) !== stableJson(response.receipt.order)) return fail();
  const keys = new Set<string>();
  for (const record of response.records) {
    const key = `${record.entity_type}:${record.entity_id}`;
    if (record.user_id !== accountId || keys.has(key)) return fail();
    keys.add(key);
    if (record.entity_type === 'tasks' && (record.payload.id !== record.entity_id
      || record.payload.plannedOrder !== response.receipt.order.indexOf(record.entity_id)
      || record.payload.completed === true || ['completed', 'dropped', 'archived', 'broken_down'].includes(String(record.payload.lifecycleStatus)))) return fail();
    if (record.entity_type === 'daily_plans' && (record.entity_id !== command.localDate
      || stableJson(record.payload.taskIds) !== stableJson(response.receipt.order))) return fail();
    if (record.entity_type === 'progress' && (record.entity_id !== 'singleton' || !integer.safeParse(record.payload.xp).success)) return fail();
  }
  if (keys.size !== response.receipt.order.length + 2 || !keys.has('progress:singleton')
    || !keys.has(`daily_plans:${command.localDate}`) || response.receipt.order.some(id => !keys.has(`tasks:${id}`))) return fail();
  return response;
}

export function assertPlanningDay(accountId: string, localDate: string, input: unknown) {
  const result = z.object({ schemaVersion: z.literal(1), accountId: z.string().uuid(), policy: dailyPlanningPolicySchema,
    enforcementEnabled: z.boolean(), records: z.array(dayRecord).optional() }).strict().parse(input);
  if (result.accountId !== accountId || result.policy.accountId !== accountId || result.policy.localDate !== localDate) throw new Error('The planning policy belongs to another account or day.');
  const keys = new Set<string>();
  for (const record of result.records ?? []) {
    const key = `${record.entity_type}:${record.entity_id}`;
    if (record.user_id !== accountId || keys.has(key)
      || (record.entity_type === 'daily_plans' && record.entity_id !== localDate)
      || (record.entity_type === 'progress' && record.entity_id !== 'singleton')
      || (record.entity_type === 'tasks' && (record.payload.id !== record.entity_id
        || (record.payload.scheduledFor ?? record.payload.dateAssigned) !== localDate))) throw new Error('The planning snapshot contains unrelated records.');
    keys.add(key);
  }
  return result;
}

/** A review must account for every original task, including moved tasks and
 * tombstones. Absence in an ordinary day snapshot is never deletion evidence. */
export function assertPlanningReview(accountId: string, command: ConfirmOrder, input: unknown) {
  const result = z.object({ schemaVersion: z.literal(1), accountId: z.string().uuid(), operationId: z.string().uuid(),
    response: responseSchema, policy: dailyPlanningPolicySchema, records: z.array(dayRecord),
    missingTaskIds: order }).strict().parse(input);
  assertPlanningResponse(accountId, command, result.response);
  const fail = () => { throw new Error('The planning review does not account for the original confirmation.'); };
  if (result.accountId !== accountId || result.operationId !== command.operationId
    || result.policy.accountId !== accountId || result.policy.localDate !== command.localDate
    || result.response.policy.history.some((receipt, index) => stableJson(receipt) !== stableJson(result.policy.history[index]))) return fail();
  const keys = new Set<string>();
  for (const row of result.records) {
    const key = `${row.entity_type}:${row.entity_id}`;
    if (row.user_id !== accountId || keys.has(key)
      || (row.entity_type === 'progress' && row.entity_id !== 'singleton')
      || (row.entity_type === 'daily_plans' && row.entity_id !== command.localDate)
      || (row.entity_type === 'tasks' && (row.payload.id !== row.entity_id
        || (!command.proposedOrder.includes(row.entity_id)
          && (row.payload.scheduledFor ?? row.payload.dateAssigned) !== command.localDate)))) return fail();
    keys.add(key);
  }
  if (result.missingTaskIds.some(id => !command.proposedOrder.includes(id) || keys.has(`tasks:${id}`))
    || command.proposedOrder.some(id => !keys.has(`tasks:${id}`) && !result.missingTaskIds.includes(id))) return fail();
  return result;
}
export type PlanningReview = ReturnType<typeof assertPlanningReview>;
