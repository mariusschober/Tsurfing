import { z } from 'zod';
import { validateFocusCommand, type FocusCommand } from '../src/domain/causalFocus';
import { normalizeFocusSession } from '../src/domain/focusSession';
import { stableJson } from './syncProtocol';

const uuid = z.string().uuid();
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value));
const member = z.object({ mutationId: uuid, deviceId: z.string().min(1).max(128),
  entityType: z.enum(['tasks', 'stats', 'progress', 'goals', 'habits', 'task_events']), entityId: z.string().min(1).max(240),
  baseServerVersion: integer.nullable(), version: integer.min(1).max(2147483647), payload: z.custom<Record<string, any>>(object),
  updatedAt: timestamp, deletedAt: z.null(), resolvesConflictId: z.null().optional() }).strict();
const envelope = z.object({ schemaVersion: z.literal(2), epoch: uuid, type: z.literal('completion'),
  command: z.custom<FocusCommand>(object), changes: z.array(member).min(1).max(6) }).strict();
export type CausalCompletionOperation = z.infer<typeof envelope>;

function parseCompletionInput(accountId: string, input: unknown): CausalCompletionOperation {
  const operation = envelope.parse(input);
  validateFocusCommand(operation.command);
  if (operation.command.accountId !== accountId || operation.command.kind !== 'complete') throw new Error('The completion target is invalid.');
  const identities = new Set<string>(), entities = new Set<string>(), kinds = new Set<string>();
  let tasks = 0;
  for (const change of operation.changes) {
    const entity = `${change.entityType}:${change.entityId}`;
    if (identities.has(change.mutationId) || entities.has(entity) || kinds.has(change.entityType)
      || change.mutationId === operation.command.actionId) throw new Error('Completion member identities are not distinct.');
    identities.add(change.mutationId); entities.add(entity); kinds.add(change.entityType);
    if (change.entityType === 'tasks') {
      tasks++;
      if (change.entityId !== operation.command.taskId || change.payload.id !== operation.command.taskId
        || change.payload.completed !== true || change.payload.lifecycleStatus !== 'completed'
        || (change.payload.deletedAt !== null && change.payload.deletedAt !== undefined)) throw new Error('The completion task does not match its final state.');
    }
    if (['stats', 'progress'].includes(change.entityType) && change.entityId !== 'singleton') throw new Error('Completion effect identity is invalid.');
    if (change.entityType === 'task_events' && ((change.payload.taskId ?? change.payload.task_id) !== operation.command.taskId
      || (change.payload.eventType ?? change.payload.event_type) !== 'completed')) throw new Error('The completion event has a different target.');
  }
  if (tasks !== 1) throw new Error('Completion requires exactly one final task payload.');
  return operation;
}

export function parseCausalCompletion(accountId: string, input: unknown): CausalCompletionOperation {
  try { return parseCompletionInput(accountId, input); }
  catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new z.ZodError([{ code: 'custom', path: ['command'], message: 'Invalid atomic completion.' }]);
  }
}

/** Existing member receipts keep their exact payload/device/version/timestamp
 * contract. The outer receipt separately binds the complete logical action. */
export function assertCausalCompletionReceipt(accountId: string, operation: CausalCompletionOperation, value: unknown): Record<string, any> {
  // This exported boundary is also used with restored evidence. Do not rely on
  // a transport caller having checked the operation's authenticated scope.
  parseCausalCompletion(accountId, operation);
  const fail = () => { throw new Error('Synchronization did not prove the complete atomic focus receipt.'); };
  if (!object(value) || value.schemaVersion !== 2 || value.epoch !== operation.epoch || !integer.min(1).safeParse(value.projectionRevision).success
    || stableJson(value.operation) !== stableJson(operation) || typeof value.accepted !== 'boolean' || !object(value.outcome)
    || value.outcome.accepted !== value.accepted || !['APPLIED', 'STALE_TARGET', 'STALE_REVISION', 'TERMINAL', 'INVALID_PHASE', 'INVALID_RANGE', 'SESSION_EXISTS'].includes(value.outcome.code)
    || value.accepted !== (value.outcome.code === 'APPLIED') || !(value.outcome.revision === null || uuid.safeParse(value.outcome.revision).success)
    || (value.accepted && value.outcome.revision !== operation.command.actionId)) return fail();
  const record = value.record;
  if (!object(record) || record.user_id !== accountId || record.entity_type !== 'tracking' || record.entity_id !== 'singleton'
    || !integer.min(1).safeParse(record.version).success || !integer.min(1).safeParse(record.server_version).success
    || typeof record.device_id !== 'string' || !record.device_id.length || !object(record.payload)
    || !timestamp.safeParse(record.updated_at).success || record.deleted_at !== null || !Array.isArray(value.changes)) return fail();
  if (!value.accepted) { if (value.changes.length !== 0) return fail(); return value; }
  const focus = normalizeFocusSession(record.payload.focusSession);
  if (!focus || focus.phase !== 'completed' || focus.sessionId !== operation.command.sessionId || focus.taskId !== operation.command.taskId
    || value.changes.length !== operation.changes.length) return fail();
  let previousVersion = 0;
  for (let index = 0; index < operation.changes.length; index++) {
    const change = operation.changes[index], result = value.changes[index], item = result?.record;
    if (!object(result) || result.mutationId !== change.mutationId || result.accepted !== true
      || !integer.min(1).safeParse(result.serverVersion).success || result.serverVersion <= previousVersion || result.serverVersion >= record.server_version
      || (change.baseServerVersion !== null && change.baseServerVersion >= result.serverVersion)
      || result.replayMismatch === true || result.serverMissing === true || result.conflictId !== undefined
      || !object(item) || item.user_id !== accountId || item.entity_type !== change.entityType || item.entity_id !== change.entityId
      || item.device_id !== change.deviceId || item.version !== change.version || item.server_version !== result.serverVersion
      || stableJson(item.payload) !== stableJson(change.payload) || item.deleted_at !== null
      || typeof item.updated_at !== 'string' || Date.parse(item.updated_at) !== Date.parse(change.updatedAt)) return fail();
    previousVersion = result.serverVersion;
  }
  return value;
}
