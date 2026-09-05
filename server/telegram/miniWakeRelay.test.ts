import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { subscribeMiniWakeups } from "./miniWakeRelay";

describe("Telegram Mini App private wake subscription", () => {
  it("subscribes to only the exact private UUID topic and discards the broadcast body", async () => {
    let broadcast: ((payload: unknown) => void) | undefined;
    let status: ((value: string) => void) | undefined;
    const channel = {
      on: vi.fn((_type: string, _filter: unknown, callback: (payload: unknown) => void) => {
        broadcast = callback;
        return channel;
      }),
      subscribe: vi.fn((callback: (value: string) => void) => {
        status = callback;
        queueMicrotask(() => callback("SUBSCRIBED"));
        return channel;
      })
    } as unknown as RealtimeChannel;
    const database = {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(async () => "ok")
    } as unknown as SupabaseClient;
    const wake = vi.fn();
    const disconnected = vi.fn();
    const userId = "11111111-1111-4111-8111-111111111111";

    const subscription = await subscribeMiniWakeups(database, userId, wake, disconnected);
    expect(database.channel).toHaveBeenCalledWith(`tsurfing:user:${userId}`, {
      config: { private: true }
    });
    expect(channel.on).toHaveBeenCalledWith("broadcast", { event: "sync_wakeup" }, expect.any(Function));

    broadcast!({ payload: { title: "must be discarded", userId: "attacker" } });
    expect(wake).toHaveBeenCalledWith();
    status!("CHANNEL_ERROR");
    expect(disconnected).toHaveBeenCalledTimes(1);

    await subscription.close();
    await subscription.close();
    expect(database.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("rejects mutable or malformed identities before opening a channel", async () => {
    const database = { channel: vi.fn() } as unknown as SupabaseClient;
    await expect(subscribeMiniWakeups(database, "owner@tsurfing.com", vi.fn(), vi.fn()))
      .rejects.toThrow(/UUID/);
    await expect(subscribeMiniWakeups(database, "{11111111-1111-4111-8111-111111111111}", vi.fn(), vi.fn()))
      .rejects.toThrow(/UUID/);
    expect(database.channel).not.toHaveBeenCalled();
  });
});
