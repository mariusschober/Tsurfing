import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../config";
import type { Logger } from "../logger";
import { createTelegramMiniRouter, type TelegramMiniDependencies } from "./telegramMini";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

const botToken = "100000:TEST_ONLY_BOT_TOKEN_NOT_A_SECRET";
const now = new Date("2027-01-15T12:00:00.000Z");
const userId = "11111111-1111-4111-8111-111111111111";
const sessionToken = "T".repeat(43);
const sessionCookie = `__Host-tsurfing-mini=${sessionToken}`;
const operationId = "22222222-2222-4222-8222-222222222222";
const config = readConfig({
  NODE_ENV: "test",
  TELEGRAM_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: botToken,
  TELEGRAM_BOT_USERNAME: "goalflow_test_bot",
  TELEGRAM_WEBHOOK_SECRET: "TEST_ONLY_WEBHOOK_SECRET_32_CHARS",
  LOG_LEVEL: "error"
});
const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const appOrigin = new URL(config.APP_ORIGIN).origin;
const sessionExpiresAt = new Date(now.getTime() + config.TELEGRAM_MINI_SESSION_TTL_SECONDS * 1_000).toISOString();
const activeSession = { userId, telegramUserId: 42, expiresAt: sessionExpiresAt };

const buildInitData = () => {
  const values = {
    auth_date: String(Math.floor(now.getTime() / 1_000)),
    query_id: "TEST_QUERY_ID",
    user: JSON.stringify({ id: 42, first_name: "Test" })
  };
  const dataCheckString = Object.keys(values).sort().map(key => `${key}=${values[key as keyof typeof values]}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...values, hash }).toString();
};

const serve = async (rpc: ReturnType<typeof vi.fn>, dependencies: TelegramMiniDependencies = {}) => {
  const app = express();
  app.use(express.json({ limit: "128kb" }));
  app.use(createTelegramMiniRouter(config, { rpc } as unknown as SupabaseClient, logger, { now: () => now, ...dependencies }));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe("Telegram Mini App server boundary", () => {
  it("exchanges fresh initData exactly once without persisting the raw credential", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { state: "created", userId, telegramUserId: 42 }, error: null });
    const response = await fetch(`${await serve(rpc)}/mini/session`, {
      method: "POST",
      headers: { authorization: `tma ${buildInitData()}`, origin: appOrigin }
    });
    const body = await response.json() as { expiresAt: string; token?: string };

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.expiresAt).toBe(sessionExpiresAt);
    expect(body).not.toHaveProperty("token");
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-tsurfing-mini=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Strict; Priority=High$/
    );
    expect(rpc.mock.calls[0][0]).toBe("goalflow_create_telegram_mini_session");
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("target_init_data");
    expect(rpc.mock.calls[0][1].target_init_data_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects replay and never accepts a query-string initData fallback", async () => {
    const replayRpc = vi.fn().mockResolvedValue({ data: { state: "replay" }, error: null });
    const replay = await fetch(`${await serve(replayRpc)}/mini/session`, {
      method: "POST",
      headers: { authorization: `tma ${buildInitData()}`, origin: appOrigin }
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: { code: "init_data_replayed" } });

    const queryRpc = vi.fn();
    const query = await fetch(`${await serve(queryRpc)}/mini/session?initData=${encodeURIComponent(buildInitData())}`, {
      method: "POST",
      headers: { origin: appOrigin }
    });
    expect(query.status).toBe(401);
    expect(queryRpc).not.toHaveBeenCalled();
  });

  it("requires a caller-generated operation UUID and returns only an exact durable acknowledgment", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: activeSession, error: null });
    const createTask = vi.fn().mockResolvedValue({
      id: operationId,
      user_id: userId,
      title: "Ship beta",
      source: "telegram",
      schedule_precision: "day",
      scheduled_for: "2027-01-15",
      tags: [],
      is_frog: false,
      status: "open"
    });
    const origin = await serve(rpc, { localDate: async () => "2027-01-15", createTask });
    const missingOperation = await fetch(`${origin}/mini/capture`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: appOrigin, "content-type": "application/json" },
      body: JSON.stringify({ title: "Ship beta", schedulePrecision: "day", scheduledFor: "2027-01-15" })
    });
    expect(missingOperation.status).toBe(400);
    expect(createTask).not.toHaveBeenCalled();

    const accepted = await fetch(`${origin}/mini/capture`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: appOrigin, "content-type": "application/json", "idempotency-key": operationId },
      body: JSON.stringify({ title: "Ship beta", schedulePrecision: "day", scheduledFor: "2027-01-15" })
    });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ operationId, task: { id: operationId, title: "Ship beta" } });
    expect(createTask).toHaveBeenCalledWith(expect.anything(), userId, "2027-01-15", operationId, expect.objectContaining({ title: "Ship beta" }));
  });

  it("does not report success for a task acknowledgment bound to another user", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: activeSession, error: null });
    const createTask = vi.fn().mockResolvedValue({
      id: operationId,
      user_id: "33333333-3333-4333-8333-333333333333",
      title: "Wrong owner",
      source: "telegram"
    });
    const origin = await serve(rpc, { localDate: async () => "2027-01-15", createTask });
    const response = await fetch(`${origin}/mini/capture`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: appOrigin, "content-type": "application/json", "idempotency-key": operationId },
      body: JSON.stringify({ title: "Ship beta", schedulePrecision: "day", scheduledFor: "2027-01-15" })
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "durable_ack_unverified" } });
  });

  it("rejects an expired, revoked, disabled, or unlinked cached Mini session", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const response = await fetch(`${await serve(rpc)}/mini/current`, {
      headers: { cookie: sessionCookie }
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "mini_session_invalid" } });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("never accepts the retired JavaScript bearer session", async () => {
    const rpc = vi.fn();
    const response = await fetch(`${await serve(rpc)}/mini/current`, {
      headers: { authorization: `Bearer ${sessionToken}` }
    });
    expect(response.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("streams only empty wake events after exact-origin cookie authentication", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: activeSession, error: null });
    let wake: (() => void) | undefined;
    const close = vi.fn(async () => {});
    const subscribeWakeups = vi.fn(async (
      _database: SupabaseClient,
      subscribedUserId: string,
      onWake: () => void
    ) => {
      expect(subscribedUserId).toBe(userId);
      wake = onWake;
      return { close };
    });
    const controller = new AbortController();
    const response = await fetch(`${await serve(rpc, { subscribeWakeups })}/mini/events`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: appOrigin, accept: "text/event-stream" },
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(": connected\n\n");

    wake!();
    const event = decoder.decode((await reader.read()).value);
    expect(event).toBe("event: wake\ndata: {}\n\n");
    expect(event).not.toContain(userId);
    expect(event).not.toMatch(/title|task|record|mutation/i);
    expect(rpc).toHaveBeenCalledTimes(2);
    controller.abort();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("rejects a wake stream without the exact configured origin", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: activeSession, error: null });
    const subscribeWakeups = vi.fn();
    const response = await fetch(`${await serve(rpc, { subscribeWakeups })}/mini/events`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: "https://attacker.invalid" }
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "mini_origin_invalid" } });
    expect(subscribeWakeups).not.toHaveBeenCalled();
  });

  it("closes an established stream before emitting a wake after revocation", async () => {
    let validation = 0;
    const rpc = vi.fn().mockImplementation(async () => ({
      data: validation++ === 0 ? activeSession : null,
      error: null
    }));
    let wake: (() => void) | undefined;
    const close = vi.fn(async () => {});
    const controller = new AbortController();
    const response = await fetch(`${await serve(rpc, {
      subscribeWakeups: async (_database, _userId, onWake) => {
        wake = onWake;
        return { close };
      }
    })}/mini/events`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: appOrigin },
      signal: controller.signal
    });
    const reader = response.body!.getReader();
    await reader.read();
    wake!();
    const afterRevocation = await reader.read();
    expect(afterRevocation.done).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    controller.abort();
  });

  it("enforces a per-user wake connection limit", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: activeSession, error: null });
    const close = vi.fn(async () => {});
    const subscribeWakeups = vi.fn(async () => ({ close }));
    const firstController = new AbortController();
    const origin = await serve(rpc, { subscribeWakeups, ssePerUserLimit: 1 });
    const first = await fetch(`${origin}/mini/events`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: appOrigin },
      signal: firstController.signal
    });
    expect(first.status).toBe(200);
    await first.body!.getReader().read();

    const second = await fetch(`${origin}/mini/events`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: appOrigin }
    });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: { code: "mini_stream_limit" } });
    expect(subscribeWakeups).toHaveBeenCalledTimes(1);
    firstController.abort();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
