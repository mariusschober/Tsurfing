import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { admitCausalOperation, assertCausalReceipt, parseCausalOperation } from './causalActions';

const owner = '11111111-1111-4111-8111-111111111111';
const action = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
const operation = () => ({ schemaVersion: 2, epoch, type: 'counter', command: {
  schemaVersion: 1, actionId: action, accountId: owner, actorId: 'test', day: '2026-09-08', timeZone: 'UTC',
  counter: 'planViewCount', delta: 1, capturedAt: '2026-09-08T00:00:00.000Z', businessActionId: null, correctionOf: null
} });
const receipt = (op = operation()) => ({ schemaVersion: 2, operation: op, epoch, accepted: true, projectionRevision: 1,
  outcome: { accepted: true, code: 'APPLIED', day: op.command.day, counts: { planViewCount: 28, dailyPostponeCount: 3 } },
  record: { user_id: owner, entity_type: 'tracking', entity_id: 'singleton', version: 2, server_version: 5,
    device_id: 'causal-action-v2', updated_at: '2026-09-08T00:00:00.123456+00:00', deleted_at: null,
    payload: { date: '2026-09-08', planViewCount: 28, dailyPostponeCount: 3, future: { preserved: true } } }
});

describe('causal API receipt boundary', () => {
  it('preserves exact unknown evidence and replays the same operation without a new ID', async () => {
    const op = operation();
    // define an own key; Object.assign's legacy setter is deliberately avoided.
    Object.defineProperty(op.command, '__proto__', { value: { evidence: true }, enumerable: true });
    const result = receipt(op);
    const rpc = vi.fn().mockResolvedValue({ data: result, error: null });
    for (let n = 0; n < 2; n++) expect(await admitCausalOperation({ rpc } as unknown as SupabaseClient, owner, op)).toBe(result);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith('goalflow_admit_action_v2', { target_user_id: owner, operation: op });
  });

  it.each([
    ['owner', (v: any) => { v.record.user_id = epoch; }],
    ['operation', (v: any) => { v.operation.command.actionId = epoch; }],
    ['epoch', (v: any) => { v.epoch = action; }],
    ['revision string', (v: any) => { v.projectionRevision = '1'; }],
    ['unsafe revision', (v: any) => { v.projectionRevision = Number.MAX_SAFE_INTEGER + 1; }],
    ['deleted record', (v: any) => { v.record.deleted_at = v.record.updated_at; }],
    ['wrong counts', (v: any) => { v.record.payload.planViewCount = 27; }],
    ['wrong day', (v: any) => { v.outcome.day = '2026-09-07'; }],
    ['false outcome', (v: any) => { v.outcome.accepted = false; }],
    ['missing record', (v: any) => { delete v.record; }]
  ])('retains pending intent when receipt has %s', (_name, change) => {
    const op = parseCausalOperation(owner, operation());
    const result = structuredClone(receipt()); change(result);
    expect(() => assertCausalReceipt(owner, op, result)).toThrow(/exact operation receipt/);
  });

  it('rejects malformed commands, cross-account scope and unsupported corrections before RPC', async () => {
    const rpc = vi.fn();
    for (const change of [
      (v: any) => { v.command.accountId = epoch; },
      (v: any) => { v.command.capturedAt = '2026-09-08T00:00:00.000000001Z'; },
      (v: any) => { v.command.correctionOf = epoch; },
      (v: any) => { v.userId = owner; },
      (v: any) => { v.command.day = '2026-02-30'; }
    ]) {
      const op = operation(); change(op);
      await expect(admitCausalOperation({ rpc } as unknown as SupabaseClient, owner, op)).rejects.toThrow();
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps delayed-day counts separate and validates a day selection baseline', async () => {
    const delayed = receipt(); delayed.record.payload.date = '2026-09-09'; delayed.record.payload.planViewCount = 0;
    expect(assertCausalReceipt(owner, parseCausalOperation(owner, operation()), delayed)).toBe(delayed);
    const op = { schemaVersion: 2, epoch, type: 'counterDay', command: { schemaVersion: 1, actionId: action,
      accountId: owner, actorId: 'test', kind: 'select', day: '2026-09-08', timeZone: 'UTC', capturedAt: '2026-09-08T00:00:00.000Z' } };
    const result: any = { ...receipt(), operation: op, counts: { planViewCount: 28, dailyPostponeCount: 3 },
      baseline: { schemaVersion: 1, baselineId: epoch, accountId: owner, day: '2026-09-08', counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [epoch] } };
    const rpc = vi.fn().mockResolvedValue({ data: result, error: null });
    expect(await admitCausalOperation({ rpc } as unknown as SupabaseClient, owner, op)).toBe(result);
    expect(rpc).toHaveBeenCalledWith('goalflow_counter_day_v2', { target_user_id: owner, operation: op });
    result.baseline.accountId = action;
    expect(() => assertCausalReceipt(owner, parseCausalOperation(owner, op), result)).toThrow();
  });

  it('retains rejected focus evidence and rejects an accepted wrong target or phase', () => {
    const op = parseCausalOperation(owner, { schemaVersion: 2, epoch, type: 'focus', command: {
      schemaVersion: 1, actionId: action, accountId: owner, actorId: 'test', kind: 'pause', sessionId: epoch,
      taskId: 'task', epoch, expectedRevision: epoch, expectedCurrentSessionId: epoch,
      capturedAt: '2026-09-08T00:00:00.000Z', durationSeconds: null
    } });
    const result: any = { ...receipt(), operation: op, accepted: false,
      outcome: { accepted: false, code: 'STALE_REVISION', revision: epoch } };
    expect(assertCausalReceipt(owner, op, result)).toBe(result);
    result.accepted = true; result.outcome = { accepted: true, code: 'APPLIED', revision: action };
    expect(() => assertCausalReceipt(owner, op, result)).toThrow();
    result.record.payload.focusSession = { schemaVersion: 1, sessionId: epoch, taskId: 'task', phase: 'paused',
      plannedDurationSeconds: 600, startedAt: '2026-09-07T23:59:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
      elapsedSeconds: 60, pausedAt: '2026-09-08T00:00:00.000Z', endedAt: null };
    expect(assertCausalReceipt(owner, op, result)).toBe(result);
    result.record.payload.focusSession.taskId = 'different';
    expect(() => assertCausalReceipt(owner, op, result)).toThrow();
  });
});
