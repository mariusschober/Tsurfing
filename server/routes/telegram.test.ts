import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../config";
import type { Logger } from "../logger";
import { createTelegramRouter, type TelegramProcessor } from "./telegram";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

const webhookSecret = "TEST_ONLY_WEBHOOK_SECRET_32_CHARS";
const config = readConfig({
  NODE_ENV: "test",
  TELEGRAM_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "100000:TEST_ONLY_BOT_TOKEN_NOT_A_SECRET",
  TELEGRAM_BOT_USERNAME: "goalflow_test_bot",
  TELEGRAM_WEBHOOK_SECRET: webhookSecret,
  LOG_LEVEL: "error"
});
const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const serve = async (rpc: ReturnType<typeof vi.fn>, processor: TelegramProcessor) => {
  const app = express();
  app.use(express.json({ limit: "128kb" }));
  app.use(createTelegramRouter(config, { rpc } as unknown as SupabaseClient, undefined, logger, processor));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const deliver = (origin: string, secret = webhookSecret) => fetch(`${origin}/webhook`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
  body: JSON.stringify({ update_id: 101, message: { message_id: 7, from: { id: 42 }, chat: { id: 42 }, text: "Capture" } })
});

describe("Telegram webhook durable update claims", () => {
  it("reports success only after the exact processing lease is durably completed", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: "claimed", error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    const processor = vi.fn().mockResolvedValue(undefined);
    const response = await deliver(await serve(rpc, processor));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(processor).toHaveBeenCalledOnce();
    const leaseId = rpc.mock.calls[0][1].target_lease_id;
    expect(leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rpc.mock.calls[1]).toEqual(["goalflow_complete_telegram_update", expect.objectContaining({
      target_update_id: 101,
      target_lease_id: leaseId,
      target_outcome: "processed"
    })]);
  });

  it.each([
    ["duplicate", 200, true],
    ["busy", 503, false],
    ["collision", 409, false]
  ] as const)("maps a %s claim without processing it again", async (claim, status, duplicate) => {
    const rpc = vi.fn().mockResolvedValue({ data: claim, error: null });
    const processor = vi.fn().mockResolvedValue(undefined);
    const response = await deliver(await serve(rpc, processor));

    expect(response.status).toBe(status);
    expect(processor).not.toHaveBeenCalled();
    if (duplicate) expect(await response.json()).toEqual({ ok: true, duplicate: true });
  });

  it("fails closed when processing succeeded but durable completion was not verified", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: "claimed", error: null })
      .mockResolvedValueOnce({ data: false, error: null })
      .mockResolvedValueOnce({ data: false, error: null });
    const processor = vi.fn().mockResolvedValue(undefined);
    const response = await deliver(await serve(rpc, processor));

    expect(processor).toHaveBeenCalledOnce();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "processing_failed" } });
  });

  it("rejects an invalid webhook secret before touching deduplication state", async () => {
    const rpc = vi.fn();
    const processor = vi.fn();
    const response = await deliver(await serve(rpc, processor), "WRONG_TEST_ONLY_WEBHOOK_SECRET");

    expect(response.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();
  });
});
