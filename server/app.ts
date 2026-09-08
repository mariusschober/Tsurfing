import crypto from "node:crypto";
import path from "node:path";
import express, { type ErrorRequestHandler } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createAuthMiddleware, requireOwnerMfa } from "./auth";
import { createDeepSeekProvider } from "./ai/deepseek";
import type { AppConfig } from "./config";
import { createLogger } from "./logger";
import { createAiRouter } from "./routes/ai";
import { createTaskRouter } from "./routes/tasks";
import { createTelegramRouter } from "./routes/telegram";
import { createTelegramMiniRouter } from "./routes/telegramMini";
import { createTelegramAuthRouter } from "./routes/telegramAuth";
import { createEmailAuthRouter } from "./routes/emailAuth";
import { createSyncRouter } from "./routes/sync";
import { createAdminInviteRouter } from "./routes/adminInvites";
import { createAccountRouter } from './routes/account';
import { createOpenAiSpeechProvider } from "./speech/openai";
import { createAdminClient } from "./supabase";
import { checkSupabaseDependencies, createReadinessProbe, type ReadinessProbe } from "./readiness";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export interface AppDependencies {
  admin?: SupabaseClient;
  readinessProbe?: ReadinessProbe;
}

export const createApp = async (config: AppConfig, dependencies: AppDependencies = {}) => {
  const app = express();
  const logger = createLogger(config);
  const admin = dependencies.admin ?? createAdminClient(config);
  const auth = createAuthMiddleware(config, admin);
  const ai = config.AI_ENABLED === "true" ? createDeepSeekProvider(config) : undefined;
  const speech = config.VOICE_ENABLED === "true" ? createOpenAiSpeechProvider(config) : undefined;
  const localOnly = config.NODE_ENV !== 'production' && config.ENABLE_LOCAL_DEMO === 'true';
  const publicOriginUsesTls = new URL(config.APP_ORIGIN).protocol === 'https:';
  const supabaseRealtimeOrigin = config.SUPABASE_URL
    ? config.SUPABASE_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
    : '';
  const readinessProbe = dependencies.readinessProbe ?? createReadinessProbe(
    config,
    () => checkSupabaseDependencies(config, admin)
  );
  const allowedOrigins = new Set([
    config.APP_ORIGIN,
    ...(config.NODE_ENV === "production" ? [] : ['http://localhost:3000', 'https://localhost', 'capacitor://localhost']),
    ...config.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  ]);

  app.disable("x-powered-by");
  // Railway terminates TLS at one trusted edge hop. This also makes IP-based
  // limits use the actual client rather than a shared proxy address.
  app.set("trust proxy", config.NODE_ENV === "production" ? 1 : false);
  app.use((request, response, next) => {
    const startedAt = Date.now();
    const providedRequestId = request.header("x-request-id") ?? "";
    request.requestId = /^[A-Za-z0-9._:-]{1,128}$/.test(providedRequestId)
      ? providedRequestId
      : crypto.randomUUID();
    response.setHeader("x-request-id", request.requestId);
    const sendJson = response.json.bind(response);
    response.json = ((body: unknown) => {
      if (response.statusCode >= 400 && isRecord(body) && isRecord(body.error)) {
        return sendJson({ ...body, error: { ...body.error, requestId: request.requestId } });
      }
      return sendJson(body);
    }) as typeof response.json;
    response.on("finish", () => logger.info("http.request", {
      requestId: request.requestId, method: request.method, path: request.path,
      status: response.statusCode, durationMs: Date.now() - startedAt, userId: request.user?.id
    }));
    next();
  });
  app.use((request, response, next) => {
    const origin = request.header('origin');
    if (origin) response.vary('Origin');
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).json({ error: { code: 'origin_not_allowed', message: 'This application origin is not allowed.' } });
      return;
    }
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('access-control-allow-headers', 'authorization,content-type,idempotency-key,x-request-id');
      response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'", ...(localOnly ? ["'unsafe-inline'"] : []), "https://challenges.cloudflare.com", "https://telegram.org"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "https://api.telegram.org", "https://ice1.somafm.com", "https://ice2.somafm.com", "https://ice4.somafm.com", ...(config.SUPABASE_URL ? [config.SUPABASE_URL, supabaseRealtimeOrigin] : [])],
        mediaSrc: ["'self'", "blob:", "https://ice1.somafm.com", "https://ice2.somafm.com", "https://ice4.somafm.com"],
        fontSrc: ["'self'"], frameSrc: ["https://challenges.cloudflare.com"], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"],
        // WebKit upgrades every relative asset request when this directive is
        // served over a deliberate HTTP origin, then fails against the plain
        // HTTP listener. Keep the production protection for HTTPS origins.
        ...(publicOriginUsesTls ? {} : { upgradeInsecureRequests: null })
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use("/api/v1/telegram", express.json({ limit: "128kb" }));
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", rateLimit({
    windowMs: 60_000,
    limit: 180,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (request, response) => response.status(429).json({
      error: { code: "rate_limited", message: "Too many requests. Try again shortly.", requestId: request.requestId }
    })
  }));

  const exposeReleaseRevision = (response: express.Response): void => {
    if (config.RAILWAY_GIT_COMMIT_SHA) {
      response.setHeader("x-tsurfing-revision", config.RAILWAY_GIT_COMMIT_SHA.toLowerCase());
    }
  };

  app.get("/api/v1/health/live", (_request, response) => {
    exposeReleaseRevision(response);
    response.json({ status: "alive" });
  });
  const ready = async (_request: express.Request, response: express.Response) => {
    let isReady = false;
    try {
      isReady = await readinessProbe();
    } catch {
      isReady = false;
    }
    exposeReleaseRevision(response);
    response.status(isReady ? 200 : 503).json({ status: isReady ? "ready" : "not_ready" });
  };
  app.get("/api/v1/health/ready", ready);
  // Backwards-compatible alias that now has fail-closed readiness semantics.
  app.get("/api/v1/health", ready);

  app.use("/api/v1/auth", createEmailAuthRouter(config, admin), createTelegramAuthRouter(config, admin));
  app.use("/api/v1/telegram", createTelegramRouter(config, admin, speech, logger), createTelegramMiniRouter(config, admin, logger));
  app.get("/api/v1/session", auth, (request, response) => response.json({
    user: {
      id: request.user!.id,
      email: request.user!.email,
      role: request.user!.role,
      status: request.user!.status
    },
    assuranceLevel: request.user!.aal
  }));
  app.use("/api/v1", auth, requireOwnerMfa, createAdminInviteRouter(admin), createAccountRouter(admin, config.TELEGRAM_OIDC_PROVIDER_ID, config.TELEGRAM_ENABLED === "true"), createSyncRouter(admin), createTaskRouter(admin));
  app.use("/api/v1/ai", auth, requireOwnerMfa, createAiRouter(config, admin, ai, logger));
  app.use("/api/gemini", auth, requireOwnerMfa, createAiRouter(config, admin, ai, logger));
  app.all("/api/{*splat}", (_request, response) => {
    response.status(404).json({ error: { code: "not_found", message: "The requested API route does not exist." } });
  });

  if (config.NODE_ENV === "production") {
    const clientPath = path.resolve(process.cwd(), "dist/client");
    const miniPath = path.resolve(process.cwd(), "dist/mini");
    app.use("/mini", express.static(miniPath, { index: "index.html", maxAge: "1y", immutable: true, setHeaders(response, filePath) {
      if (filePath.endsWith("index.html")) response.setHeader("cache-control", "no-cache");
    }}));
    app.use(express.static(clientPath, { index: false, maxAge: "1y", immutable: true, setHeaders(response, filePath) {
      if (filePath.endsWith("index.html") || filePath.endsWith("sw.js") || filePath.endsWith("manifest.webmanifest")) response.setHeader("cache-control", "no-cache");
    }}));
    app.get("/{*splat}", (_request, response) => {
      response.setHeader("cache-control", "no-cache");
      response.sendFile(path.join(clientPath, "index.html"));
    });
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    logger.error("http.unhandled_error", { requestId: request.requestId, category: error instanceof Error ? error.name : "unknown" });
    const invalidJson = isRecord(error) && error.type === "entity.parse.failed";
    const payloadTooLarge = isRecord(error) && error.type === "entity.too.large";
    response.status(invalidJson ? 400 : payloadTooLarge ? 413 : 500).json({ error: {
      code: invalidJson ? "invalid_json" : payloadTooLarge ? "payload_too_large" : "internal_error",
      message: invalidJson
        ? "The request body is not valid JSON."
        : payloadTooLarge
          ? "The request body is too large."
          : "The request could not be completed."
    } });
  };
  app.use(errorHandler);
  return app;
};
