import { describe, expect, it, vi } from 'vitest';
import { sendCausalAction } from './causalTransport';

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

describe('saved causal request transport', () => {
  it('retries byte-identical saved JSON and retains unknown receipt evidence', async () => {
    const op = operation();
    Object.defineProperty(op.command, '__proto__', { value: { evidence: true }, enumerable: true });
    const saved = JSON.stringify(op, null, 2);
    const fetch = vi.fn().mockImplementation(async () => Response.json(receipt(op)));
    for (let i = 0; i < 2; i++) {
      const result = await sendCausalAction(owner, saved, { authenticatedFetch: fetch });
      expect(result.operation).toEqual(op);
      expect(result.record.updated_at).toBe('2026-09-08T00:00:00.123456+00:00');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      expect(call[0]).toBe('/api/v1/sync/actions');
      expect(call[1].body).toBe(saved);
    }
  });
  it('does not turn an altered receipt into acknowledgment', async () => {
    const result = receipt(); result.operation.command.actionId = epoch;
    await expect(sendCausalAction(owner, JSON.stringify(operation()), {
      authenticatedFetch: async () => Response.json(result)
    })).rejects.toThrow(/exact operation receipt/);
  });
  it.each([409, 413, 429, 503])('classifies HTTP %i without exposing server diagnostics', async status => {
    await expect(sendCausalAction(owner, JSON.stringify(operation()), {
      authenticatedFetch: async () => new Response('private upstream contents', { status })
    })).rejects.toMatchObject({ status, retryable: status === 429 || status === 503 });
  });
  it('checks complete UTF-8 size before sending and does not truncate', async () => {
    const op: any = operation(); op.command.future = '界'.repeat(90_000);
    const saved = JSON.stringify(op);
    expect(saved.length).toBeLessThan(256 * 1024);
    const fetch = vi.fn();
    await expect(sendCausalAction(owner, saved, { authenticatedFetch: fetch })).rejects.toMatchObject({ status: 413 });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(saved).command.future).toBe(op.command.future);
  });
  it('rejects wrong account before fetching and respects prior cancellation', async () => {
    const fetch = vi.fn(); const saved = JSON.stringify(operation());
    await expect(sendCausalAction(epoch, saved, { authenticatedFetch: fetch })).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(sendCausalAction(owner, saved, { authenticatedFetch: fetch, signal: controller.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds streamed response bytes and cancels excess data', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel
    }));
    await expect(sendCausalAction(owner, JSON.stringify(operation()), {
      authenticatedFetch: async () => response
    })).rejects.toThrow(/safe client limit/);
    expect(cancel).toHaveBeenCalled();
  });
  it('keeps its deadline active until response body reading finishes', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError'))); }
    })));
    await expect(sendCausalAction(owner, JSON.stringify(operation()), {
      authenticatedFetch: fetch, timeoutMs: 5
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
