import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchApiWithTimeout } from './authService';
import { ResponseTooLargeError } from './boundedResponse';
import { readFile } from 'node:fs/promises';

afterEach(() => vi.useRealTimers());

describe('bounded account API transport', () => {
  it('keeps the deadline active until the complete response body arrives', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as typeof fetch;

    const request = fetchApiWithTimeout('/api/v1/session', {}, 250, fetcher);
    const rejection = expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns a replayable in-memory response after a complete body', async () => {
    const response = await fetchApiWithTimeout(
      '/api/v1/session',
      {},
      250,
      vi.fn(async () => Response.json({ durable: true })) as typeof fetch
    );

    await expect(response.json()).resolves.toEqual({ durable: true });
  });

  it('rejects an oversized response before exposing a partial body', async () => {
    const fetcher = vi.fn(async () => new Response('12345', {
      status: 200,
      headers: { 'content-length': '5' }
    })) as typeof fetch;

    await expect(fetchApiWithTimeout('/api/v1/session', {}, 250, fetcher, 4))
      .rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('honors cancellation before starting a request', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('signed out', 'AbortError'));
    const fetcher = vi.fn();

    await expect(fetchApiWithTimeout('/api/v1/session', { signal: controller.signal }, 250, fetcher as typeof fetch))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes Supabase authentication requests through the bounded transport', async () => {
    const source = await readFile('services/authService.ts', 'utf8');
    expect(source).toContain('global: { fetch: (input, init) => fetchApiWithTimeout(input, init) }');
  });
});
