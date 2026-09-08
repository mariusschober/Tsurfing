import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const subscribeTimeoutMs = 10_000;

export interface MiniWakeSubscription {
  close(): Promise<void>;
}

export type MiniWakeSubscriber = (
  database: SupabaseClient,
  userId: string,
  onWake: () => void,
  onDisconnect: () => void
) => Promise<MiniWakeSubscription>;

const removeChannel = async (database: SupabaseClient, channel: RealtimeChannel): Promise<void> => {
  try {
    await database.removeChannel(channel);
  } catch {
    // The HTTP response is already closing. Realtime will also discard the
    // channel when its underlying socket goes away.
  }
};

/**
 * Subscribe with the server's privileged Supabase client. The browser never
 * receives a project secret, access token, user id, Realtime topic, or
 * broadcast body; it receives only an empty wake event from the HTTP relay.
 */
export const subscribeMiniWakeups: MiniWakeSubscriber = async (
  database,
  userId,
  onWake,
  onDisconnect
) => {
  if (!userIdPattern.test(userId)) throw new Error("A canonical account UUID is required.");
  const topic = `tsurfing:user:${userId.toLowerCase()}`;
  const channel = database
    .channel(topic, { config: { private: true } })
    .on("broadcast", { event: "sync_wakeup" }, () => onWake());

  let subscribed = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Realtime subscription timed out.")), subscribeTimeoutMs);
      timer.unref();
      channel.subscribe(status => {
        if (status === "SUBSCRIBED") {
          subscribed = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          clearTimeout(timer);
          if (subscribed) onDisconnect();
          else reject(new Error("Realtime subscription was rejected."));
        }
      });
    });
  } catch (error) {
    await removeChannel(database, channel);
    throw error;
  }

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      await removeChannel(database, channel);
    }
  };
};
