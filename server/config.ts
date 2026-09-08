import { z } from "zod";

const optionalString = (schema: z.ZodString = z.string().trim().min(1)) =>
  z.preprocess(
    value => typeof value === "string" && value.trim() === "" ? undefined : value,
    schema.optional()
  );

const enabledFlag = z.enum(["true", "false"]).default("false");

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default(""),
  OWNER_EMAIL: z.string().email().default("owner@tsurfing.local"),
  OWNER_USER_ID: optionalString(z.string().uuid()),
  RAILWAY_GIT_COMMIT_SHA: optionalString(z.string().regex(/^[0-9a-f]{40}$/i)),
  ENABLE_LOCAL_DEMO: enabledFlag,
  SUPABASE_URL: optionalString(z.string().url()),
  // Opaque sb_publishable_/sb_secret_ keys are the current Supabase convention.
  // Legacy anon/service_role keys remain accepted during the staged migration.
  SUPABASE_PUBLISHABLE_KEY: optionalString(),
  SUPABASE_SECRET_KEY: optionalString(),
  SUPABASE_ANON_KEY: optionalString(),
  SUPABASE_SERVICE_ROLE_KEY: optionalString(),
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(250).max(15_000).default(3_000),
  READINESS_CACHE_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  AI_ENABLED: enabledFlag,
  DEEPSEEK_API_KEY: optionalString(),
  DEEPSEEK_API_BASE: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().default("deepseek-v4-flash"),
  AI_OWNER_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(100),
  AI_BETA_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(20),
  AI_GLOBAL_DAILY_LIMIT: z.coerce.number().int().min(1).max(100_000).default(300),
  TELEGRAM_ENABLED: enabledFlag,
  TELEGRAM_BOT_TOKEN: optionalString(z.string().min(20)),
  TELEGRAM_BOT_USERNAME: optionalString(z.string().regex(/^@?[A-Za-z0-9_]{3,64}$/)),
  TELEGRAM_WEBHOOK_SECRET: optionalString(z.string().regex(/^[A-Za-z0-9_-]{32,256}$/)),
  TELEGRAM_OIDC_PROVIDER_ID: z.string().regex(/^custom:[a-z0-9:-]+$/).default("custom:telegram"),
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS: z.coerce.number().int().min(0).max(60).default(30),
  TELEGRAM_MINI_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(600),
  VOICE_ENABLED: enabledFlag,
  OPENAI_API_KEY: optionalString(z.string().min(20)),
  OPENAI_API_BASE: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  TELEGRAM_MAX_VOICE_BYTES: z.coerce.number().int().min(1_024).max(20_000_000).default(19_000_000),
  TURNSTILE_ENABLED: enabledFlag,
  TURNSTILE_SECRET_KEY: optionalString(),
  VITE_TURNSTILE_SITE_KEY: optionalString(),
  BACKUPS_ENABLED: enabledFlag,
  BACKUP_MASTER_KEY: optionalString(z.string().min(32)),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info")
});

export type AppConfig = z.infer<typeof environmentSchema>;

export const readConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig =>
  environmentSchema.parse(environment);

export const supabasePublicKey = (config: AppConfig): string | undefined =>
  config.SUPABASE_PUBLISHABLE_KEY ?? config.SUPABASE_ANON_KEY;

export const supabaseServerKey = (config: AppConfig): string | undefined =>
  config.SUPABASE_SECRET_KEY ?? config.SUPABASE_SERVICE_ROLE_KEY;

const validBackupKey = (value: string | undefined): boolean => {
  if (!value) return false;
  try {
    const decoded = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
    return decoded.length === 32;
  } catch {
    return false;
  }
};

const legacySupabaseRole = (value: string): string | undefined => {
  const segments = value.split(".");
  if (segments.length !== 3 || segments.some(segment => !segment)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : undefined;
  } catch {
    return undefined;
  }
};

const isSupabasePublicKey = (value: string): boolean =>
  value.startsWith("sb_publishable_") || legacySupabaseRole(value) === "anon";

const isSupabaseServerKey = (value: string): boolean =>
  value.startsWith("sb_secret_") || legacySupabaseRole(value) === "service_role";

const isExactOrigin = (value: string): boolean => {
  const url = new URL(value);
  return value.replace(/\/$/, "") === url.origin;
};

/**
 * Safe machine-readable reasons used in logs and tests. Health responses expose
 * only ready/not_ready, never configuration details or credential material.
 */
export const productionConfigurationProblems = (config: AppConfig): string[] => {
  if (config.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  if (new URL(config.APP_ORIGIN).protocol !== "https:") problems.push("public_origin_must_use_https");
  if (!isExactOrigin(config.APP_ORIGIN)) problems.push("public_origin_must_be_exact");
  if (config.ENABLE_LOCAL_DEMO === "true") problems.push("local_demo_forbidden");
  if (!config.SUPABASE_URL) problems.push("supabase_url_missing");
  else {
    if (new URL(config.SUPABASE_URL).protocol !== "https:") problems.push("supabase_url_must_use_https");
    if (!isExactOrigin(config.SUPABASE_URL)) problems.push("supabase_url_must_be_exact");
  }
  const publicKey = supabasePublicKey(config);
  const serverKey = supabaseServerKey(config);
  if (!publicKey) problems.push("supabase_public_key_missing");
  else if (!isSupabasePublicKey(publicKey)) problems.push("supabase_public_key_invalid");
  if (!serverKey) problems.push("supabase_server_key_missing");
  else if (!isSupabaseServerKey(serverKey)) problems.push("supabase_server_key_invalid");
  if (!config.OWNER_USER_ID) problems.push("owner_user_id_missing");

  if (config.TELEGRAM_ENABLED === "true") {
    if (!config.TELEGRAM_BOT_TOKEN) problems.push("telegram_bot_token_missing");
    if (!config.TELEGRAM_BOT_USERNAME) problems.push("telegram_bot_username_missing");
    if (!config.TELEGRAM_WEBHOOK_SECRET) problems.push("telegram_webhook_secret_missing");
  }
  if (config.AI_ENABLED === "true" && !config.DEEPSEEK_API_KEY) problems.push("ai_key_missing");
  if (config.VOICE_ENABLED === "true") {
    if (config.TELEGRAM_ENABLED !== "true") problems.push("voice_requires_telegram");
    if (!config.OPENAI_API_KEY) problems.push("voice_key_missing");
  }
  if (config.TURNSTILE_ENABLED === "true") {
    if (!config.TURNSTILE_SECRET_KEY) problems.push("turnstile_secret_missing");
    if (!config.VITE_TURNSTILE_SITE_KEY) problems.push("turnstile_site_key_missing");
  }
  if (config.BACKUPS_ENABLED === "true" && !validBackupKey(config.BACKUP_MASTER_KEY)) {
    problems.push("backup_key_invalid");
  }
  return problems;
};
