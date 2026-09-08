import { assertCausalReceipt, parseCausalOperation } from './causalProtocol';
import { readResponseBodyWithLimit } from './boundedResponse';

export class CausalTransportError extends Error {
  constructor(public readonly status: number, public readonly retryable: boolean) {
    super(retryable ? 'Retry the exact saved causal action.' : 'The saved causal action needs review. Its contents must be retained.');
    this.name = 'CausalTransportError';
  }
}

/** One attempt against the existing authenticated transport. The caller saves
 * the serialized request before calling and retires it only in a durable
 * receipt transaction. This function neither enrolls accounts nor changes any
 * journal, projection, action identity or cursor. */
export async function sendCausalAction(
  accountId: string,
  savedRequest: string,
  runtime: {
    authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }
): Promise<Record<string, any>> {
  // Express's 256 KiB limit applies to the complete UTF-8 JSON body.
  if (new TextEncoder().encode(savedRequest).byteLength > 256 * 1024) {
    throw new CausalTransportError(413, false);
  }
  const operation = parseCausalOperation(accountId, JSON.parse(savedRequest));
  const timeoutMs = runtime.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new RangeError('Invalid request deadline.');
  const controller = new AbortController();
  const abort = () => controller.abort(runtime.signal?.reason);
  runtime.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (runtime.signal?.aborted) abort();
    controller.signal.throwIfAborted();
    const response = await runtime.authenticatedFetch('/api/v1/sync/actions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: savedRequest, signal: controller.signal
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CausalTransportError(response.status,
        [408, 425, 429].includes(response.status) || response.status >= 500);
    }
    // Includes tracking projection plus exact command evidence. Oversized
    // historical responses remain pending rather than consuming unbounded RAM.
    const bytes = await readResponseBodyWithLimit(response, 8 * 1024 * 1024);
    controller.signal.throwIfAborted();
    const receipt: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes ?? new ArrayBuffer(0)));
    return assertCausalReceipt(accountId, operation, receipt);
  } finally {
    clearTimeout(timer);
    runtime.signal?.removeEventListener('abort', abort);
  }
}
