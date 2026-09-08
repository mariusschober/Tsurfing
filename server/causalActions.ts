import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { validateFocusCommand, type FocusCommand } from '../src/domain/causalFocus';
import { validateCounterBaseline, validateCounterDelta } from '../src/domain/counterLedger';
import { normalizeFocusSession } from '../src/domain/focusSession';
import { stableJson } from '../services/syncProtocol';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const envelope = z.object({ schemaVersion: z.literal(2), epoch: uuid,
  type: z.enum(['focus', 'counter', 'counterDay']), command: z.custom<Record<string, unknown>>(object) }).strict();
const timestamp = z.string().refine(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const day = z.string().refine(value => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00.000Z'))
  && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value);
const dayCommand = z.object({ schemaVersion: z.literal(1), actionId: uuid, accountId: uuid,
  actorId: z.string().min(1).max(240).refine(value => value.trim().length > 0),
  kind: z.enum(['establish', 'select']), day, timeZone: z.string().regex(/^[A-Za-z0-9_+./-]{1,128}$/), capturedAt: timestamp }).passthrough();
export type CausalOperation = z.infer<typeof envelope>;

/** Validate without normalizing or dropping unknown command evidence. SQL is
 * authoritative for epoch, timezone, task eligibility and causal history. */
export function parseCausalOperation(userId: string, input: unknown): CausalOperation {
  const operation = envelope.parse(input);
  try {
    if (operation.command.accountId !== userId) throw new Error('scope');
    if (operation.type === 'focus') {
      validateFocusCommand(operation.command as FocusCommand);
      if (operation.command.kind === 'complete') throw new Error('atomic completion required');
    } else if (operation.type === 'counter') {
      validateCounterDelta(operation.command);
      if (operation.command.correctionOf !== null) throw new Error('verified recovery required');
    } else dayCommand.parse(operation.command);
  } catch (_) {
    // Never reflect supplied command contents in diagnostics.
    throw new z.ZodError([{ code: 'custom', path: ['command'], message: 'Invalid causal command.' }]);
  }
  return operation;
}

/** New receipts prove the exact operation and canonical revision, separately
 * from legacy payload acceptance. Preserve the RPC object byte-semantically. */
export function assertCausalReceipt(userId: string, operation: CausalOperation, value: unknown): Record<string, any> {
  const fail = () => { throw new Error('Causal synchronization did not prove the exact operation receipt.'); };
  if (!object(value) || value.schemaVersion !== 2 || value.epoch !== operation.epoch
    || stableJson(value.operation) !== stableJson(operation) || typeof value.accepted !== 'boolean'
    || !integer.min(1).safeParse(value.projectionRevision).success) return fail();
  const record = value.record;
  if (!object(record) || record.user_id !== userId || record.entity_type !== 'tracking' || record.entity_id !== 'singleton'
    || !integer.min(1).safeParse(record.version).success || !integer.min(1).safeParse(record.server_version).success
    || typeof record.device_id !== 'string' || !record.device_id.length || !object(record.payload)
    || typeof record.updated_at !== 'string' || !Number.isFinite(Date.parse(record.updated_at)) || record.deleted_at !== null) return fail();
  if (operation.type === 'focus') {
    const outcome = value.outcome;
    if (!object(outcome) || outcome.accepted !== value.accepted
      || !['APPLIED', 'STALE_TARGET', 'STALE_REVISION', 'TERMINAL', 'INVALID_PHASE', 'INVALID_RANGE', 'SESSION_EXISTS'].includes(outcome.code)
      || (outcome.accepted !== (outcome.code === 'APPLIED'))
      || !(outcome.revision === null || uuid.safeParse(outcome.revision).success)
      || (outcome.accepted && outcome.revision !== operation.command.actionId)) return fail();
    if (outcome.accepted) {
      const focus = normalizeFocusSession(record.payload.focusSession);
      const phase = operation.command.kind === 'stop' ? 'stopped' : operation.command.kind === 'pause' ? 'paused'
        : operation.command.kind === 'extend' ? null : 'active';
      if (!focus || focus.sessionId !== operation.command.sessionId || focus.taskId !== operation.command.taskId
        || (phase !== null && focus.phase !== phase) || !['active', 'paused', 'stopped'].includes(focus.phase)) return fail();
    }
  } else {
    const counts = operation.type === 'counter' ? value.outcome?.counts : value.counts;
    if (!value.accepted || !object(counts) || !integer.safeParse(counts.planViewCount).success
      || !integer.safeParse(counts.dailyPostponeCount).success) return fail();
    if (operation.type === 'counter') {
      if (!object(value.outcome) || value.outcome.accepted !== true || value.outcome.code !== 'APPLIED'
        || value.outcome.day !== operation.command.day) return fail();
    } else {
      try { validateCounterBaseline(value.baseline); } catch (_) { return fail(); }
      if (value.baseline.accountId !== userId || value.baseline.day !== operation.command.day) return fail();
    }
    if (record.payload.date === operation.command.day
      && (record.payload.planViewCount !== counts.planViewCount || record.payload.dailyPostponeCount !== counts.dailyPostponeCount)) return fail();
    if (operation.type === 'counterDay' && operation.command.kind === 'select' && record.payload.date !== operation.command.day) return fail();
  }
  return value;
}

export async function admitCausalOperation(database: SupabaseClient, userId: string, input: unknown) {
  const operation = parseCausalOperation(userId, input);
  const { data, error } = await database.rpc(operation.type === 'counterDay' ? 'goalflow_counter_day_v2' : 'goalflow_admit_action_v2', {
    target_user_id: userId, operation
  });
  if (error) throw error;
  return assertCausalReceipt(userId, operation, data);
}
