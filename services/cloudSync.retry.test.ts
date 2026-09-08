import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSyncWithRetry,
  isPermanentSyncFailure,
  SyncHttpError,
  SyncProtocolError,
  type CloudSyncDependencies
} from './cloudSync';
import { SessionAccountMismatchError } from './authService';
import { ResponseTooLargeError } from './boundedResponse';

const dependencies = (
  fetch: CloudSyncDependencies['fetch'],
  overrides: Partial<CloudSyncDependencies> = {}
): CloudSyncDependencies => ({
  fetch,
  isOnline: () => true,
  now: () => new Date('2026-09-03T00:00:00.000Z'),
  deviceId: () => 'retry-test-device',
  random: () => 0.4,
  ...overrides
});

afterEach(() => vi.useRealTimers());

describe('bounded synchronization transport', () => {
  it('uses capped exponential delays with jitter for transient responses', async () => {
    const delays: number[] = [];
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: {} }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: {} }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const response = await fetchSyncWithRetry('/sync', {}, dependencies(fetch, {
      maxAttempts: 3,
      sleep: async delay => { delays.push(delay); }
    }));

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([600, 1_100]);
  });

  it('aborts a request at the configured deadline', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as CloudSyncDependencies['fetch'];
    const request = fetchSyncWithRetry('/sync', {}, dependencies(fetch, {
      maxAttempts: 1,
      requestTimeoutMs: 250
    }));
    const rejection = expect(request).rejects.toMatchObject({ name: 'TimeoutError' });

    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the request deadline active after headers until the body completes', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as CloudSyncDependencies['fetch'];
    const request = fetchSyncWithRetry('/sync', {}, dependencies(fetch, {
      maxAttempts: 1,
      requestTimeoutMs: 250
    }));
    const rejection = expect(request).rejects.toMatchObject({ name: 'TimeoutError' });

    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('honors caller cancellation before any network attempt', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('signed out', 'AbortError'));
    const fetch = vi.fn();

    await expect(fetchSyncWithRetry('/sync', {}, dependencies(fetch, { signal: controller.signal })))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats an oversized response as permanent and does not retry it', async () => {
    const fetch = vi.fn(async () => new Response('12345', { status: 200 })) as CloudSyncDependencies['fetch'];

    await expect(fetchSyncWithRetry('/sync', {}, dependencies(fetch, {
      maxAttempts: 3,
      maxResponseBytes: 4,
      sleep: async () => undefined
    }))).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('classifies authorization and protocol errors as permanent, but not server outages', () => {
    expect(new SyncHttpError('revoked', 401, 'session_revoked').permanent).toBe(true);
    expect(new SyncHttpError('invalid', 422, 'invalid_request').permanent).toBe(true);
    expect(new SyncHttpError('busy', 503, 'unavailable').permanent).toBe(false);
    expect(isPermanentSyncFailure(new SyncProtocolError('bad receipt'))).toBe(true);
    expect(isPermanentSyncFailure(new ResponseTooLargeError())).toBe(true);
  });

  it('does not retry when the signed-in account no longer owns the local outbox', async () => {
    const fetch = vi.fn(async () => {
      throw new SessionAccountMismatchError();
    }) as CloudSyncDependencies['fetch'];

    await expect(fetchSyncWithRetry('/sync', {}, dependencies(fetch)))
      .rejects.toBeInstanceOf(SessionAccountMismatchError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
