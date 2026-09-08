import { confirmOrderSchema } from '../src/domain/deliberatePlanning';
import { assertPlanningDay, assertPlanningResponse, assertPlanningReview } from './deliberatePlanningProtocol';
import { readResponseBodyWithLimit } from './boundedResponse';
import { CausalTransportError } from './causalTransport';

type Runtime = {
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  timeoutMs?: number;
};
async function request(path: string, runtime: Runtime, body?: string): Promise<unknown> {
  runtime.signal?.throwIfAborted();
  const timeout = runtime.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new RangeError('Invalid planning request deadline.');
  const controller = new AbortController();
  const abort = () => controller.abort(runtime.signal?.reason);
  runtime.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    if (runtime.signal?.aborted) abort();
    const response = await runtime.authenticatedFetch(path, {
      method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CausalTransportError(response.status, [408, 425, 429].includes(response.status) || response.status >= 500);
    }
    const bytes = await readResponseBodyWithLimit(response, 16 * 1024 * 1024);
    controller.signal.throwIfAborted();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes ?? new ArrayBuffer(0)));
  } finally {
    clearTimeout(timer);
    runtime.signal?.removeEventListener('abort', abort);
  }
}
/** The durable command is sent unchanged on every attempt. Only its receipt can
 * retire reservations; HTTP success alone is insufficient. */
export async function sendPlanningConfirmation(accountId: string, savedRequest: string, runtime: Runtime) {
  const command = confirmOrderSchema.parse(JSON.parse(savedRequest));
  if (command.accountId !== accountId) throw new Error('Planning command belongs to another account.');
  return assertPlanningResponse(accountId, command,
    await request('/api/v1/sync/confirm-order', runtime, savedRequest));
}
export async function fetchPlanningDay(accountId: string, localDate: string, runtime: Runtime) {
  confirmOrderSchema.shape.localDate.parse(localDate);
  return assertPlanningDay(accountId, localDate,
    await request(`/api/v1/sync/planning?date=${encodeURIComponent(localDate)}`, runtime));
}

export async function fetchPlanningReview(accountId: string, savedRequest: string, runtime: Runtime) {
  const command = confirmOrderSchema.parse(JSON.parse(savedRequest));
  if (command.accountId !== accountId) throw new Error('Planning command belongs to another account.');
  return assertPlanningReview(accountId, command,
    await request('/api/v1/sync/planning-review', runtime, savedRequest));
}
