import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { initDataAuthorization, MiniAppAuthError, validateInitData } from "./miniAppAuth";

const botToken = "100000:TEST_ONLY_BOT_TOKEN_NOT_A_SECRET";
const nowMs = 1_800_000_000_000;
const nowSeconds = Math.floor(nowMs / 1_000);

const buildInitData = (values: Record<string, string>) => {
  const dataCheckString = Object.keys(values).sort().map(key => `${key}=${values[key]}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...values, hash }).toString();
};

const valid = (authDate = nowSeconds) => buildInitData({
  auth_date: String(authDate),
  query_id: "TEST_QUERY_ID",
  user: JSON.stringify({ id: 42, first_name: "Test" })
});
const options = { maxAgeSeconds: 300, futureSkewSeconds: 30, nowMs };

describe("Telegram Mini App initData verification", () => {
  it("validates the documented HMAC and returns only a canonical fingerprint", () => {
    const result = validateInitData(valid(), botToken, options);
    expect(result).toMatchObject({ telegramUserId: 42, authDate: nowSeconds });
    expect(result.initDataHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result).not.toHaveProperty("initData");
  });

  it("rejects tampering with a timing-safe hash comparison", () => {
    const tampered = valid().replace("first_name%22%3A%22Test", "first_name%22%3A%22Changed");
    expect(() => validateInitData(tampered, botToken, options)).toThrowError(MiniAppAuthError);
    try { validateInitData(tampered, botToken, options); }
    catch (error) { expect((error as MiniAppAuthError).code).toBe("invalid_hash"); }
  });

  it("rejects stale and materially future authentication times", () => {
    expect(() => validateInitData(valid(nowSeconds - 301), botToken, options)).toThrowError(/expired/i);
    expect(() => validateInitData(valid(nowSeconds + 31), botToken, options)).toThrowError(/future/i);
  });

  it("rejects duplicate fields and unsafe Telegram user IDs", () => {
    expect(() => validateInitData(`${valid()}&user=%7B%22id%22%3A42%7D`, botToken, options)).toThrowError(/duplicate/i);
    const unsafe = buildInitData({ auth_date: String(nowSeconds), user: JSON.stringify({ id: 9_007_199_254_740_992 }) });
    expect(() => validateInitData(unsafe, botToken, options)).toThrowError(/identity/i);
  });

  it("accepts initData only from the exact authorization header, never a query fallback", () => {
    const initData = valid();
    expect(initDataAuthorization({ header: name => name === "authorization" ? `tma ${initData}` : undefined })).toBe(initData);
    expect(initDataAuthorization({ header: () => undefined })).toBeNull();
    expect(initDataAuthorization({ header: () => `Bearer ${initData}` })).toBeNull();
  });
});
