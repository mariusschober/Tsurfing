import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { decodePendingCapture, ensurePendingCapture, type PendingCaptureRow } from "./pending";

const pendingInput = {
  kind: "text" as const,
  title: "Prepare launch",
  originalText: "Prepare launch 45m #work",
  schedulePrecision: "day" as const,
  scheduledFor: "2026-09-03",
  estimatedMinutes: 45,
  tags: ["work"],
  defaultedToToday: true
};

describe("Telegram durable pending captures", () => {
  it("round-trips rich state through the backed-up transcript field", () => {
    const row = {
      id: "11111111-1111-5111-8111-111111111111",
      user_id: "22222222-2222-4222-8222-222222222222",
      telegram_chat_id: 42,
      kind: "text",
      title: pendingInput.title,
      transcript: JSON.stringify({
        goalflowTelegramCapture: 1,
        originalText: pendingInput.originalText,
        defaultedToToday: true,
        estimatedMinutes: 45,
        tags: ["work"],
        notes: "Forwarded from Telegram:\n\nPrepare launch"
      }),
      schedule_precision: "day",
      scheduled_for: "2026-09-03",
      state: "pending",
      expires_at: "2099-01-01T00:00:00.000Z"
    } satisfies PendingCaptureRow;
    expect(decodePendingCapture(row)).toMatchObject({
      title: "Prepare launch", estimatedMinutes: 45, tags: ["work"],
      notes: "Forwarded from Telegram:\n\nPrepare launch", defaultedToToday: true
    });
  });

  it("rejects deterministic-ID reuse with different content", async () => {
    const existing = {
      id: "11111111-1111-5111-8111-111111111111",
      user_id: "22222222-2222-4222-8222-222222222222",
      telegram_chat_id: 42,
      kind: "text",
      title: "Different title",
      transcript: "{}",
      schedule_precision: "day",
      scheduled_for: "2026-09-03",
      state: "pending",
      expires_at: "2099-01-01T00:00:00.000Z"
    } satisfies PendingCaptureRow;
    const builder = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: existing, error: null }) };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    const database = { from: vi.fn().mockReturnValue(builder) } as unknown as SupabaseClient;
    await expect(ensurePendingCapture(database, existing.id, existing.user_id, 42, pendingInput))
      .rejects.toThrow(/reused for different content/);
  });
});
