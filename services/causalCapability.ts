import { z } from 'zod';
import { readResponseBodyWithLimit } from './boundedResponse';
import { CausalTransportError } from './causalTransport';

const common = { schemaVersion: z.literal(2), accountId: z.string().uuid(), rolloutReady: z.literal(false) };
const capability = z.discriminatedUnion('enrolled', [
  z.object({ ...common, enrolled: z.literal(false), epoch: z.null(), projectionRevision: z.null() }).strict(),
  z.object({ ...common, enrolled: z.literal(true), epoch: z.string().uuid(), projectionRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()
]);
export type CausalCapability = z.infer<typeof capability>;
export function assertCausalCapability(accountId: string, input: unknown): CausalCapability {
  const parsed = capability.safeParse(input);
  if (!parsed.success || parsed.data.accountId !== accountId) throw new Error('The causal capability does not match the authenticated account.');
  return parsed.data;
}

/** Read-only discovery through the caller's authenticated transport. */
export async function fetchCausalCapability(accountId: string, runtime: {
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal; timeoutMs?: number;
}): Promise<CausalCapability> {
  if (!z.string().uuid().safeParse(accountId).success) throw new Error('An account UUID is required.');
  const timeout = runtime.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new RangeError('Invalid request deadline.');
  const controller = new AbortController();
  const abort = () => controller.abort(runtime.signal?.reason);
  runtime.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    if (runtime.signal?.aborted) abort();
    controller.signal.throwIfAborted();
    const response = await runtime.authenticatedFetch('/api/v1/sync/causal-capability', { method: 'GET', cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CausalTransportError(response.status, [408, 425, 429].includes(response.status) || response.status >= 500);
    }
    const bytes = await readResponseBodyWithLimit(response, 16 * 1024);
    controller.signal.throwIfAborted();
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes ?? new ArrayBuffer(0))); }
    catch (_) { throw new Error('The causal capability response is invalid.'); }
    return assertCausalCapability(accountId, decoded);
  } finally { clearTimeout(timer); runtime.signal?.removeEventListener('abort', abort); }
}
