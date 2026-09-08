import crypto from "node:crypto";

export type MiniAppAuthErrorCode = "missing" | "invalid_hash" | "stale" | "future" | "invalid_format";

export class MiniAppAuthError extends Error {
  constructor(public readonly code: MiniAppAuthErrorCode, message: string) {
    super(message);
    this.name = "MiniAppAuthError";
  }
}

export interface ValidatedMiniAppData {
  telegramUserId: number;
  authDate: number;
  initDataHash: string;
}

export interface MiniAppValidationOptions {
  maxAgeSeconds: number;
  futureSkewSeconds: number;
  nowMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export const validateInitData = (
  initData: string,
  botToken: string,
  options: MiniAppValidationOptions
): ValidatedMiniAppData => {
  if (!initData) throw new MiniAppAuthError("missing", "Telegram authentication data is missing.");
  if (initData !== initData.trim() || initData.length > 8_192 || /[\r\n\0]/.test(initData)) {
    throw new MiniAppAuthError("invalid_format", "Telegram authentication data is malformed.");
  }
  const entries = [...new URLSearchParams(initData).entries()];
  const seen = new Set<string>();
  for (const [key] of entries) {
    if (!key || seen.has(key)) {
      throw new MiniAppAuthError("invalid_format", "Telegram authentication data has duplicate fields.");
    }
    seen.add(key);
  }
  const hash = entries.find(([key]) => key === "hash")?.[1];
  const authDateText = entries.find(([key]) => key === "auth_date")?.[1];
  const userText = entries.find(([key]) => key === "user")?.[1];
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash) || !authDateText || !/^\d{1,12}$/.test(authDateText) || !userText) {
    throw new MiniAppAuthError("invalid_format", "Telegram authentication data is incomplete.");
  }

  const dataCheckString = entries
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest();
  const provided = Buffer.from(hash, "hex");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new MiniAppAuthError("invalid_hash", "Telegram authentication data is invalid.");
  }

  const authDate = Number(authDateText);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    throw new MiniAppAuthError("invalid_format", "Telegram authentication time is invalid.");
  }
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
  if (authDate > nowSeconds + options.futureSkewSeconds) {
    throw new MiniAppAuthError("future", "Telegram authentication time is in the future.");
  }
  if (nowSeconds - authDate > options.maxAgeSeconds) {
    throw new MiniAppAuthError("stale", "Telegram authentication data has expired.");
  }

  let user: unknown;
  try { user = JSON.parse(userText); }
  catch { throw new MiniAppAuthError("invalid_format", "Telegram user data is malformed."); }
  const telegramUserId = isRecord(user) ? user.id : undefined;
  if (!Number.isSafeInteger(telegramUserId) || Number(telegramUserId) <= 0) {
    throw new MiniAppAuthError("invalid_format", "Telegram user identity is invalid.");
  }
  return {
    telegramUserId: Number(telegramUserId),
    authDate,
    // The signed HMAC is a canonical semantic fingerprint, so alternate URL
    // encodings cannot bypass one-time replay detection.
    initDataHash: hash.toLowerCase()
  };
};

export const initDataAuthorization = (request: { header(name: string): string | undefined }): string | null => {
  const authorization = request.header("authorization");
  const match = authorization?.match(/^tma (.+)$/);
  return match?.[1] ?? null;
};
