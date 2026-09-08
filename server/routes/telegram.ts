import crypto from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { SpeechProvider } from "../speech/types";
import { createTelegramProcessor, type TelegramUpdate } from "../telegram/bot";

export type TelegramProcessor = (update: TelegramUpdate) => Promise<void>;

export const createTelegramRouter = (
  config: AppConfig,
  database: SupabaseClient | undefined,
  speech: SpeechProvider | undefined,
  logger: Logger,
  processorOverride?: TelegramProcessor
) => {
  const router = Router();
  const processor = processorOverride ?? (database ? createTelegramProcessor(config, database, speech, logger) : undefined);
  const webhookLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, response) => response.status(429).json({
      error: { code: "telegram_rate_limited", message: "Too many Telegram requests. Try again shortly." }
    })
  });
  router.post("/webhook", webhookLimiter, async (request, response) => {
    if (config.TELEGRAM_ENABLED !== "true" || !config.TELEGRAM_WEBHOOK_SECRET || !config.TELEGRAM_BOT_TOKEN || !processor || !database) {
      response.status(503).json({ error: { code: "telegram_not_configured", message: "Telegram is not configured." } }); return;
    }
    const providedSecret = request.header("x-telegram-bot-api-secret-token") ?? "";
    const expectedSecret = config.TELEGRAM_WEBHOOK_SECRET;
    const providedBuffer = Buffer.from(providedSecret);
    const expectedBuffer = Buffer.from(expectedSecret);
    const secretsMatch = providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
    if (!secretsMatch) {
      response.status(401).json({ error: { code: "invalid_webhook_secret", message: "Webhook authentication failed." } }); return;
    }
    const update = request.body as TelegramUpdate;
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
      response.status(400).json({ error: { code: "invalid_update", message: "Telegram update is invalid." } }); return;
    }
    const telegramUserId = update.message?.from?.id ?? update.callback_query?.from?.id;
    if (telegramUserId !== undefined && (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0)) {
      response.status(400).json({ error: { code: "invalid_update", message: "Telegram update is invalid." } }); return;
    }
    const leaseId = crypto.randomUUID();
    const { data: claim, error: claimError } = await database.rpc("goalflow_claim_telegram_update", {
      target_update_id: update.update_id,
      target_telegram_user_id: telegramUserId ?? null,
      target_payload: update,
      target_lease_id: leaseId,
      target_lease_seconds: 60
    });
    if (claimError || claim === "unavailable") {
      response.status(503).json({ error: { code: "deduplication_unavailable", message: "Update could not be claimed." } }); return;
    }
    if (claim === "collision") {
      response.status(409).json({ error: { code: "update_id_collision", message: "The Telegram update id was reused for different data." } }); return;
    }
    if (claim === "duplicate") { response.status(200).json({ ok: true, duplicate: true }); return; }
    if (claim === "busy") {
      response.status(503).json({ error: { code: "update_in_progress", message: "Update processing is still in progress." } }); return;
    }
    if (claim !== "claimed") {
      response.status(503).json({ error: { code: "deduplication_unavailable", message: "Update could not be claimed." } }); return;
    }
    try {
      await processor(update);
      const { data: completed, error: completionError } = await database.rpc("goalflow_complete_telegram_update", {
        target_update_id: update.update_id,
        target_lease_id: leaseId,
        target_outcome: "processed",
        target_error_code: null
      });
      if (completionError || completed !== true) throw completionError ?? new Error("Telegram update lease was lost before acknowledgment.");
      response.status(200).json({ ok: true });
    } catch (processingError) {
      logger.error("telegram.update_failed", { updateId: update.update_id, category: processingError instanceof Error ? processingError.name : "unknown" });
      await database.rpc("goalflow_complete_telegram_update", {
        target_update_id: update.update_id,
        target_lease_id: leaseId,
        target_outcome: "error",
        target_error_code: "processing_failed"
      });
      response.status(503).json({ error: { code: "processing_failed", message: "Update will be retried safely." } });
    }
  });
  return router;
};
