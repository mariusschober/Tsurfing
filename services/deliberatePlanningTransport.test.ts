import { expect, it, vi } from 'vitest';
import { sendPlanningConfirmation, fetchPlanningDay } from './deliberatePlanningTransport';
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const command = { schemaVersion: 1, operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', accountId,
  localDate: '2026-09-08', baselineRevision: null, proposedOrder: [], ratings: [], maximumAcceptedXp: 0,
  capturedAt: '2026-09-08T18:00:00.000Z' };
it('retries the exact durable command and rejects HTTP success without complete evidence', async () => {
  const authenticatedFetch = vi.fn(async () => new Response('{}'));
  const bytes = JSON.stringify(command);
  for (let i = 0; i < 2; i++) await expect(sendPlanningConfirmation(accountId, bytes, { authenticatedFetch })).rejects.toThrow();
  expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  for (const call of authenticatedFetch.mock.calls as unknown as [string, RequestInit][]) {
    expect(call[0]).toBe('/api/v1/sync/confirm-order'); expect(call[1].body).toBe(bytes);
  }
});
it('does not transmit another account command or an already aborted request', async () => {
  const authenticatedFetch = vi.fn();
  await expect(sendPlanningConfirmation('cccccccc-cccc-4ccc-8ccc-cccccccccccc', JSON.stringify(command), { authenticatedFetch })).rejects.toThrow('another account');
  const controller = new AbortController(); controller.abort();
  await expect(sendPlanningConfirmation(accountId, JSON.stringify(command), { authenticatedFetch, signal: controller.signal })).rejects.toThrow();
  expect(authenticatedFetch).not.toHaveBeenCalled();
});
it('retains rate limits as retryable and validates the fetched policy account and day', async () => {
  await expect(sendPlanningConfirmation(accountId, JSON.stringify(command), {
    authenticatedFetch: async () => new Response('', { status: 429 }),
  })).rejects.toMatchObject({ status: 429 });
  await expect(fetchPlanningDay(accountId, '2026-09-08', {
    authenticatedFetch: async () => Response.json({ schemaVersion: 1, accountId,
      enforcementEnabled: false, policy: { schemaVersion: 1, accountId, localDate: '2026-09-09',
        revision: null, confirmedOrder: [], acceptedReplans: 0, history: [] } }),
  })).rejects.toThrow('another account or day');
});
