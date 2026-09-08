import { describe, expect, it, vi } from 'vitest';
import {
  createCoalescedSyncRunner,
  createPeriodicSyncHealthCheck,
  createRetryableOneTimeInitializer,
  FOREGROUND_SYNC_INTERVAL_MS,
  SYNC_HEALTH_INTERVAL_MS,
  subscribeToSyncWakeups,
  syncWakeupTopicForUser
} from './cloudSync';
import { supabase } from './authService';

type ConfiguredSupabaseClient = NonNullable<typeof supabase>;

class FakeRealtimeChannel {
  eventType: string | null = null;
  eventFilter: { event: string } | null = null;
  wakeHandler: (() => void) | null = null;
  statusHandler: ((status: string) => void) | null = null;

  on(type: string, filter: { event: string }, handler: () => void) {
    this.eventType = type;
    this.eventFilter = filter;
    this.wakeHandler = handler;
    return this;
  }

  subscribe(handler: (status: string) => void) {
    this.statusHandler = handler;
    return this;
  }
}

describe('Web Realtime sync wake-ups', () => {
  it('runs legacy local-data initialization once and retries a failed first attempt', async () => {
    const initialize = vi.fn()
      .mockRejectedValueOnce(new Error('storage temporarily unavailable'))
      .mockResolvedValue(undefined);
    const ensureInitialized = createRetryableOneTimeInitializer(initialize);

    await expect(ensureInitialized()).rejects.toThrow('storage temporarily unavailable');
    await ensureInitialized();
    await ensureInitialized();
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('runs one follow-up cycle when changes arrive during an active sync', async () => {
    let releaseFirst: () => void = () => undefined;
    const firstCycle = new Promise<void>(resolve => { releaseFirst = resolve; });
    const runOnce = vi.fn()
      .mockImplementationOnce(() => firstCycle)
      .mockResolvedValue(undefined);
    const requestSync = createCoalescedSyncRunner(() => true, runOnce);

    const first = requestSync();
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(1));
    const second = requestSync();
    const third = requestSync();
    expect(runOnce).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second, third]);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it('derives only the exact immutable UUID topic', () => {
    expect(syncWakeupTopicForUser('AAAAAAAA-1111-4111-8111-111111111111'))
      .toBe('tsurfing:user:aaaaaaaa-1111-4111-8111-111111111111');
    expect(syncWakeupTopicForUser('owner@tsurfing.com')).toBeNull();
    expect(syncWakeupTopicForUser('tsurfing:user:aaaaaaaa-1111-4111-8111-111111111111')).toBeNull();
  });

  it('uses a private receive-only Broadcast subscription and pulls on wake and rejoin', async () => {
    const channel = new FakeRealtimeChannel();
    const client = {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(async () => 'ok')
    };
    const pull = vi.fn();
    const stop = subscribeToSyncWakeups(
      client as unknown as ConfiguredSupabaseClient,
      'aaaaaaaa-1111-4111-8111-111111111111',
      pull
    );

    expect(client.channel).toHaveBeenCalledWith(
      'tsurfing:user:aaaaaaaa-1111-4111-8111-111111111111',
      { config: { private: true } }
    );
    expect(channel.eventType).toBe('broadcast');
    expect(channel.eventFilter).toEqual({ event: 'sync_wakeup' });

    channel.wakeHandler?.();
    channel.statusHandler?.('SUBSCRIBED');
    channel.statusHandler?.('CHANNEL_ERROR');
    expect(pull).toHaveBeenCalledTimes(2);

    stop();
    await Promise.resolve();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
  });

  it('does not subscribe with mutable or malformed identity input', () => {
    const client = {
      channel: vi.fn(),
      removeChannel: vi.fn(async () => 'ok')
    };
    const stop = subscribeToSyncWakeups(
      client as unknown as ConfiguredSupabaseClient,
      'owner@tsurfing.com',
      vi.fn()
    );
    stop();
    expect(client.channel).not.toHaveBeenCalled();
    expect(client.removeChannel).not.toHaveBeenCalled();
  });

  it('keeps the foreground safety pull bounded to thirty seconds', () => {
    expect(FOREGROUND_SYNC_INTERVAL_MS).toBe(30_000);
  });

  it('keeps the diagnostic health probe out of bursty durable sync traffic', async () => {
    let now = 0;
    const check = vi.fn()
      .mockRejectedValueOnce(new Error('diagnostic unavailable'))
      .mockResolvedValue(undefined);
    const checkPeriodically = createPeriodicSyncHealthCheck(check, () => now);

    await checkPeriodically();
    await checkPeriodically();
    now = SYNC_HEALTH_INTERVAL_MS - 1;
    await checkPeriodically();
    expect(check).toHaveBeenCalledTimes(1);

    now = SYNC_HEALTH_INTERVAL_MS;
    await checkPeriodically();
    expect(check).toHaveBeenCalledTimes(2);
  });
});
