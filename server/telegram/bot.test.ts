import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import { createTelegramProcessor } from "./bot";

type Row = Record<string, unknown>;

const USER_ID = "11111111-1111-4111-8111-111111111111";

const fakeDatabase = (invalidTaskAck = false) => {
  const captures = new Map<string, Row>();
  const tasks = new Map<string, Row>();
  const calls: { name: string; args: Row }[] = [];
  const identity: Row = {
    user_id: USER_ID,
    telegram_user_id: 42,
    telegram_chat_id: null,
    bot_access_granted: true
  };

  const matches = (row: Row, filters: Row, greaterThan: Row): boolean =>
    Object.entries(filters).every(([key, value]) => String(row[key]) === String(value))
    && Object.entries(greaterThan).every(([key, value]) => String(row[key] ?? "") > String(value));

  const builderFor = (table: string) => {
    let operation: "select" | "insert" | "update" = "select";
    let filters: Row = {};
    let greaterThan: Row = {};
    let inserted: Row | null = null;
    let patch: Row | null = null;
    let selected = "";
    const builder = {
      select(fields: string) { selected = fields; return this; },
      insert(row: Row) { operation = "insert"; inserted = { ...row }; return this; },
      update(value: Row) { operation = "update"; patch = value; return this; },
      eq(field: string, value: unknown) { filters[field] = value; return this; },
      gt(field: string, value: unknown) { greaterThan[field] = value; return this; },
      is(field: string, value: unknown) { filters[field] = value; return this; },
      async maybeSingle() {
        if (table === "telegram_identities") {
          if (!matches(identity, filters, greaterThan)) return { data: null, error: null };
          if (operation === "update" && patch) Object.assign(identity, patch);
          return { data: { ...identity }, error: null };
        }
        if (table === "profiles") {
          return { data: selected.includes("timezone") ? { timezone: "UTC" } : { status: "active" }, error: null };
        }
        const collection = table === "telegram_captures" ? captures : table === "tasks" ? tasks : null;
        if (!collection) return { data: null, error: null };
        const row = [...collection.values()].find(value => matches(value, filters, greaterThan));
        if (!row) return { data: null, error: null };
        if (operation === "update" && patch) Object.assign(row, patch);
        return { data: { ...row }, error: null };
      },
      async single() {
        if (operation !== "insert" || !inserted) return { data: null, error: new Error("No insert") };
        const collection = table === "telegram_captures" ? captures : table === "tasks" ? tasks : null;
        if (!collection || typeof inserted.id !== "string") return { data: null, error: new Error("Invalid insert") };
        collection.set(inserted.id, inserted);
        return { data: { ...inserted }, error: null };
      }
    };
    return builder;
  };

  const database = {
    from: vi.fn((table: string) => builderFor(table)),
    rpc: vi.fn(async (name: string, args: Row) => {
      calls.push({ name, args });
      if (name !== "goalflow_create_task_idempotent" && name !== "goalflow_confirm_telegram_capture") {
        return { data: null, error: null };
      }
      const payload = args.task_payload as Row;
      const row = {
        id: String(payload.taskId),
        user_id: invalidTaskAck ? "22222222-2222-4222-8222-222222222222" : String(args.target_user_id),
        title: payload.title,
        notes: payload.notes,
        tags: payload.tags,
        schedule_precision: payload.schedulePrecision,
        scheduled_for: payload.schedulePrecision === "month" ? `${payload.scheduledFor}-01` : payload.scheduledFor,
        scheduled_time: payload.scheduledTime,
        estimated_minutes: payload.estimatedMinutes,
        source: "telegram",
        status: "open",
        revision: 7
      };
      tasks.set(row.id, row);
      if (name === "goalflow_confirm_telegram_capture") {
        const capture = captures.get(String(args.target_capture_id));
        if (capture) capture.state = "confirmed";
      }
      return { data: row, error: null };
    })
  } as unknown as SupabaseClient;
  return { database, captures, tasks, calls };
};

describe("Telegram bot durable capture", () => {
  const config = {
    TELEGRAM_BOT_TOKEN: "clearly-synthetic-telegram-token",
    APP_ORIGIN: "https://goalflow.invalid",
    TELEGRAM_MAX_VOICE_BYTES: 19_000_000
  } as AppConfig;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) } as Response));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does not silently schedule undated text and keeps identical intended captures distinct", async () => {
    const fake = fakeDatabase();
    const process = createTelegramProcessor(config, fake.database, undefined, logger);
    const message = { message_id: 1, from: { id: 42 }, chat: { id: 100 }, text: "Draft launch 45m #work" };
    await process({ update_id: 1001, message });
    await process({ update_id: 1002, message: { ...message, message_id: 2 } });

    expect(fake.captures.size).toBe(2);
    expect(fake.calls).toHaveLength(0);
    for (const row of fake.captures.values()) {
      expect(row.state).toBe("pending");
      expect(String(row.transcript)).toContain('"estimatedMinutes":45');
      expect(String(row.transcript)).toContain('"tags":["work"]');
    }
  });

  it("creates a pending task once with the chosen day and rich fields", async () => {
    const fake = fakeDatabase();
    const process = createTelegramProcessor(config, fake.database, undefined, logger);
    await process({
      update_id: 2001,
      message: { message_id: 1, from: { id: 42 }, chat: { id: 100 }, text: "Draft launch 45m #work" }
    });
    const captureId = String([...fake.captures.keys()][0]);
    await process({
      update_id: 2002,
      callback_query: {
        id: "synthetic-callback",
        from: { id: 42 },
        message: { message_id: 2, chat: { id: 100 } },
        data: `sch:tomorrow:${captureId}`
      }
    });

    expect(fake.captures.get(captureId)?.state).toBe("confirmed");
    const call = fake.calls.find(value => value.name === "goalflow_confirm_telegram_capture");
    expect(call?.args.task_payload).toMatchObject({
      taskId: captureId,
      title: "Draft launch",
      tags: ["work"],
      scheduledFor: expect.any(String),
      estimatedMinutes: 45,
      source: "telegram"
    });
  });

  it("stores forwarded content in task notes atomically without retaining a hidden sender", async () => {
    const fake = fakeDatabase();
    const process = createTelegramProcessor(config, fake.database, undefined, logger);
    await process({
      update_id: 3001,
      message: {
        message_id: 1,
        from: { id: 42 },
        chat: { id: 100 },
        text: "Review private proposal",
        forward_origin: { type: "hidden_user", sender_user_name: "Private Person" }
      }
    });
    const captureId = String([...fake.captures.keys()][0]);
    await process({
      update_id: 3002,
      callback_query: {
        id: "synthetic-forward-callback",
        from: { id: 42 },
        message: { message_id: 2, chat: { id: 100 } },
        data: `sch:today:${captureId}`
      }
    });
    const payload = fake.calls.find(value => value.name === "goalflow_confirm_telegram_capture")?.args.task_payload as Row;
    expect(payload.notes).toBe("Forwarded from Telegram:\n\nReview private proposal");
    expect(JSON.stringify(payload)).not.toContain("Private Person");
  });

  it("rejects an unverified task response instead of sending success", async () => {
    const fake = fakeDatabase(true);
    const process = createTelegramProcessor(config, fake.database, undefined, logger);
    await expect(process({
      update_id: 4001,
      message: { message_id: 1, from: { id: 42 }, chat: { id: 100 }, text: "Publish notes 2099-01-01" }
    })).rejects.toThrow(/acknowledgment could not be verified/);
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("sendMessage"),
      expect.objectContaining({ body: expect.stringContaining("Added") })
    );
  });
});
