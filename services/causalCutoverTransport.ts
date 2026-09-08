import { parseCausalCutover, assertCausalCutoverReceipt } from './causalCutoverProtocol';
import { prepareStagedBody, verifyReconciliationChunkAck } from './reconciliationStaging';
import { readResponseBodyWithLimit } from './boundedResponse';
import { CausalTransportError } from './causalTransport';
import { parseCausalInitialization, assertCausalInitializationReceipt } from './causalInitializationProtocol';

type EnrollmentRuntime = {
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal; timeoutMs?: number;
};

/** Sends previously durable bytes. Chunk retries preserve the complete
 * cutover baseline and identity; no local evidence is retired here. */
export async function sendCausalCutover(accountId: string, savedRequest: string, runtime: EnrollmentRuntime) {
  const operation = parseCausalCutover(accountId, JSON.parse(savedRequest));
  return assertCausalCutoverReceipt(accountId, operation, await sendEnrollment(savedRequest, runtime, 'causal-cutover'));
}

export async function sendCausalInitialization(accountId: string, savedRequest: string, runtime: EnrollmentRuntime) {
  const operation = parseCausalInitialization(accountId, JSON.parse(savedRequest));
  return assertCausalInitializationReceipt(accountId, operation, await sendEnrollment(savedRequest, runtime, 'causal-initialize'));
}

async function sendEnrollment(savedRequest: string, runtime: EnrollmentRuntime, route: 'causal-cutover' | 'causal-initialize') {
  runtime.signal?.throwIfAborted();
  const timeout = runtime.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new RangeError('Invalid cutover request deadline.');
  const upload = await prepareStagedBody(savedRequest);
  async function request(path: string, body: string, maximumBytes: number): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort(runtime.signal?.reason);
    runtime.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      if (runtime.signal?.aborted) abort();
      controller.signal.throwIfAborted();
      const response = await runtime.authenticatedFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new CausalTransportError(response.status, [408, 425, 429].includes(response.status) || response.status >= 500);
      }
      const bytes = await readResponseBodyWithLimit(response, maximumBytes);
      controller.signal.throwIfAborted();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes ?? new ArrayBuffer(0)));
    } finally { clearTimeout(timer); runtime.signal?.removeEventListener('abort', abort); }
  }
  for (const chunk of upload.chunks) {
    const ack = await request('/api/v1/sync/conflicts/stage', JSON.stringify(chunk), 16 * 1024);
    verifyReconciliationChunkAck(chunk, ack);
  }
  return await request(`/api/v1/sync/${route}${upload.manifest ? '-staged' : ''}`,
    upload.manifest ? JSON.stringify(upload.manifest) : savedRequest, 16 * 1024 * 1024);
}
