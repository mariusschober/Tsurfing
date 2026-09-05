import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { readConfig } from "./config";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

const config = () => readConfig({
  NODE_ENV: "production",
  APP_ORIGIN: "https://beta.goalflow.example",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_value",
  SUPABASE_SECRET_KEY: "sb_secret_test_value",
  OWNER_USER_ID: "00000000-0000-4000-8000-000000000001",
  RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  LOG_LEVEL: "error"
});

const serve = async (ready: boolean) => {
  const app = await createApp(config(), { readinessProbe: async () => ready });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return { app, origin: `http://127.0.0.1:${address.port}` };
};

describe("public server boundary", () => {
  it("separates process liveness from dependency readiness", async () => {
    const { origin } = await serve(false);
    const live = await fetch(`${origin}/api/v1/health/live`);
    const ready = await fetch(`${origin}/api/v1/health/ready`);
    const legacy = await fetch(`${origin}/api/v1/health`);
    expect(await live.json()).toEqual({ status: "alive" });
    expect(live.status).toBe(200);
    expect(live.headers.get("x-tsurfing-revision")).toBe("a".repeat(40));
    expect(ready.status).toBe(503);
    expect(ready.headers.get("x-tsurfing-revision")).toBe("a".repeat(40));
    expect(await ready.json()).toMatchObject({ status: "not_ready" });
    expect(legacy.status).toBe(503);
  });

  it("returns ready only after the dependency probe succeeds", async () => {
    const { origin } = await serve(true);
    const response = await fetch(`${origin}/api/v1/health/ready`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-tsurfing-revision")).toBe("a".repeat(40));
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("permits the configured Supabase HTTPS and secure Realtime origins", async () => {
    const { origin } = await serve(true);
    const response = await fetch(`${origin}/api/v1/health/live`);
    const policy = response.headers.get("content-security-policy");
    expect(policy).toContain("https://example.supabase.co");
    expect(policy).toContain("wss://example.supabase.co");
    expect(policy).not.toContain("ws://example.supabase.co");
  });

  it("rejects untrusted browser origins before an API route can run", async () => {
    const { origin } = await serve(true);
    const response = await fetch(`${origin}/api/v1/health/live`, {
      headers: { origin: "https://attacker.example" }
    });
    const body = await response.json() as { error: { code: string; requestId: string } };
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("origin_not_allowed");
    expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
  });

  it("sanitizes caller-provided request IDs and includes the safe ID in public errors", async () => {
    const { origin } = await serve(true);
    const response = await fetch(`${origin}/api/v2/does-not-exist`, {
      headers: { "x-request-id": "not valid spaces" }
    });
    const requestId = response.headers.get("x-request-id");
    const body = await response.json() as { error: { code: string; requestId: string } };
    expect(response.status).toBe(404);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.error).toMatchObject({ code: "not_found", requestId });
  });

  it("returns a safe 400 response for malformed JSON", async () => {
    const { origin } = await serve(true);
    const response = await fetch(`${origin}/api/v1/does-not-exist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    const body = await response.json() as { error: { code: string; requestId: string } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_json");
    expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
  });

  it("enforces the tighter Telegram body limit with a safe public error", async () => {
    const { origin } = await serve(true);
    const response = await fetch(`${origin}/api/v1/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1, padding: "x".repeat(129 * 1024) })
    });
    const body = await response.json() as { error: { code: string; requestId: string } };
    expect(response.status).toBe(413);
    expect(body.error.code).toBe("payload_too_large");
    expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
  });

  it("trusts exactly one Railway edge proxy hop in production", async () => {
    const { app } = await serve(true);
    expect(app.get("trust proxy")).toBe(1);
  });
});
