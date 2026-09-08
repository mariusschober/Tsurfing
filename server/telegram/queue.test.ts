import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { identityFor, localDateFor } from "./queue";

const query = (result: { data: Record<string, unknown> | null; error: unknown }) => {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue(result)
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  return builder;
};

describe("Telegram account and timezone boundary", () => {
  it("requires both an enabled link and an active Tsurfing profile", async () => {
    const identity = query({ data: { user_id: "user-a", bot_access_granted: true }, error: null });
    const suspended = query({ data: { status: "suspended" }, error: null });
    const database = { from: vi.fn().mockReturnValueOnce(identity).mockReturnValueOnce(suspended) } as unknown as SupabaseClient;
    expect(await identityFor(database, 42)).toBeNull();

    const enabled = query({ data: { user_id: "user-a", bot_access_granted: true }, error: null });
    const active = query({ data: { status: "active" }, error: null });
    const activeDatabase = { from: vi.fn().mockReturnValueOnce(enabled).mockReturnValueOnce(active) } as unknown as SupabaseClient;
    expect(await identityFor(activeDatabase, 42)).toMatchObject({ user_id: "user-a" });
  });

  it("interprets dates in the configured user timezone and never silently falls back", async () => {
    const timezone = query({ data: { timezone: "Pacific/Kiritimati" }, error: null });
    const database = { from: vi.fn().mockReturnValue(timezone) } as unknown as SupabaseClient;
    expect(await localDateFor(database, "user-a", new Date("2027-01-01T11:30:00.000Z"))).toBe("2027-01-02");

    const invalid = query({ data: { timezone: "Not/A_Timezone" }, error: null });
    const invalidDatabase = { from: vi.fn().mockReturnValue(invalid) } as unknown as SupabaseClient;
    await expect(localDateFor(invalidDatabase, "user-a")).rejects.toThrow(/timezone is invalid/i);
  });
});
