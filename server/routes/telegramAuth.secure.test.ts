import crypto from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../config";
import { createTelegramAuthRouter, telegramIdentity } from "./telegramAuth";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const INVITE_ID = "22222222-2222-4222-8222-222222222222";
const servers: Server[] = [];
const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

const config = readConfig({
  TELEGRAM_ENABLED: "true",
  TELEGRAM_OIDC_PROVIDER_ID: "custom:telegram",
  TURNSTILE_ENABLED: "false"
});

const authUser = {
  id: USER_ID,
  email: "telegram@example.invalid",
  identities: [{ id: "42", provider: "telegram", identity_data: { id: "42", username: "linked" } }]
} as unknown as User;

const serve = async (activationResult = true) => {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: { id: INVITE_ID, use_count: 0, max_uses: 1 },
    error: null
  });
  const inviteQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "is", "gt"]) {
    inviteQuery[method] = vi.fn(() => inviteQuery);
  }
  inviteQuery.maybeSingle = maybeSingle;
  const insert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) => table === "invite_codes" ? inviteQuery : { insert });
  const rpc = vi.fn().mockResolvedValue({ data: activationResult, error: null });
  const getUser = vi.fn().mockResolvedValue({ data: { user: authUser }, error: null });
  const admin = { from, rpc } as unknown as SupabaseClient;
  const verifier = { auth: { getUser } } as unknown as SupabaseClient;
  const app = express();
  app.use(express.json());
  app.use("/auth", createTelegramAuthRouter(config, admin, verifier));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    from,
    insert,
    rpc,
    getUser
  };
};

describe("secure callback flow — telegramAuth", () => {
  it("accepts only the exact configured provider identity and an explicit numeric bot user ID", () => {
    expect(telegramIdentity(authUser, "custom:telegram")).toEqual({ id: 42, username: "linked" });

    const forgedMetadata = { user_metadata: { telegram_user_id: "42" }, identities: [] } as unknown as User;
    expect(telegramIdentity(forgedMetadata, "custom:telegram")).toBeUndefined();
    const lookalikeProvider = {
      identities: [{ id: "42", provider: "attacker-telegram-copy", identity_data: { id: "42" } }]
    } as unknown as User;
    expect(telegramIdentity(lookalikeProvider, "custom:telegram")).toBeUndefined();
    const partialSubject = {
      identities: [{ id: "telegram-42", provider: "telegram", identity_data: { sub: "telegram-42" } }]
    } as unknown as User;
    expect(telegramIdentity(partialSubject, "custom:telegram")).toBeUndefined();
  });

  it("uses the allowlisted signed bot ID and preserves the distinct OIDC subject", () => {
    const verified = {
      identities: [{ id: "identity-uuid", provider: "custom:telegram", identity_data: {
        sub: "1234123412341234123", preferred_username: "linked", custom_claims: { id: 42 }
      } }]
    } as unknown as User;
    expect(telegramIdentity(verified, "custom:telegram")).toEqual({ id: 42, username: "linked" });
  });

  it.each(["42", "1234123412341234123"])("never substitutes an OIDC subject or identity key for bot ID (%s)", sub => {
    const missingBotId = {
      identities: [{ id: "42", provider: "custom:telegram", identity_data: { sub } }]
    } as unknown as User;
    expect(telegramIdentity(missingBotId, "custom:telegram")).toBeUndefined();
  });

  it.each([0, -42, 1.5, true, "42suffix", "9007199254740992", {}, null])("rejects malformed signed bot IDs (%j)", id => {
    const malformed = {
      identities: [{ provider: "custom:telegram", identity_data: { sub: "42", custom_claims: { id } } }]
    } as unknown as User;
    expect(telegramIdentity(malformed, "custom:telegram")).toBeUndefined();
  });

  it("stores only a hashed opaque invite attempt and never client OAuth state or PKCE material", async () => {
    const { origin, insert } = await serve();
    const response = await fetch(`${origin}/auth/telegram/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "invite-secret", captchaToken: "captcha-proof" })
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { attemptToken: string; provider: string; expiresInSeconds: number };
    expect(body).toMatchObject({ provider: "custom:telegram", expiresInSeconds: 600 });
    expect(body.attemptToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      token_hash: hash(body.attemptToken),
      invite_id: INVITE_ID
    }));
    const inserted = insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted).not.toHaveProperty("oauth_state_hash");
    expect(inserted).not.toHaveProperty("code_challenge");
    expect(inserted).not.toHaveProperty("code_challenge_method");
    expect(JSON.stringify(inserted)).not.toContain("invite-secret");
    expect(JSON.stringify(inserted)).not.toContain(body.attemptToken);
  });

  it("rejects manually injected reserved provider parameters before database access", async () => {
    const { origin, from } = await serve();
    const response = await fetch(`${origin}/auth/telegram/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "invite-secret",
        captchaToken: "captcha-proof",
        state: "client-state-is-forbidden",
        codeChallenge: "A".repeat(43),
        codeChallengeMethod: "S256"
      })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(from).not.toHaveBeenCalled();
  });

  it("derives activation identity only from the verified Supabase provider identity", async () => {
    const { origin, rpc } = await serve();
    const attemptToken = "A".repeat(43);
    const response = await fetch(`${origin}/auth/telegram/activate`, {
      method: "POST",
      headers: { authorization: "Bearer verified-session", "content-type": "application/json" },
      body: JSON.stringify({ attemptToken })
    });

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("activate_telegram_beta", {
      target_token_hash: hash(attemptToken),
      target_user_id: USER_ID,
      target_telegram_user_id: 42,
      target_telegram_username: "linked",
      target_email: "telegram@example.invalid",
      target_oauth_state: null
    });
  });

  it("rejects legacy oauthState replay input before token verification", async () => {
    const { origin, getUser, rpc } = await serve();
    const response = await fetch(`${origin}/auth/telegram/activate`, {
      method: "POST",
      headers: { authorization: "Bearer verified-session", "content-type": "application/json" },
      body: JSON.stringify({ attemptToken: "A".repeat(43), oauthState: "attacker-controlled" })
    });

    expect(response.status).toBe(400);
    expect(getUser).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reports a consumed or cross-account attempt as rejected", async () => {
    const { origin } = await serve(false);
    const response = await fetch(`${origin}/auth/telegram/activate`, {
      method: "POST",
      headers: { authorization: "Bearer verified-session", "content-type": "application/json" },
      body: JSON.stringify({ attemptToken: "A".repeat(43) })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "activation_expired" } });
  });

  it("compares the webhook secret in constant time after equalizing lengths", () => {
    const content = fs.readFileSync("server/routes/telegram.ts", "utf8");
    expect(content).toContain("timingSafeEqual");
    expect(content).toContain("providedBuffer.length === expectedBuffer.length");
  });
});
