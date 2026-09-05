import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { SpeechProvider } from "../speech/types";
import { parseTelegramCapture, type ParsedCapture } from "./capture";
import { extractForwardCapture, isForwarded } from "./forward";
import {
  decodePendingCapture,
  ensurePendingCapture,
  findCapture,
  findPendingCapture,
  transitionPendingCapture,
  type PendingCaptureRow
} from "./pending";
import { identityFor, loadQueue, localDateFor } from "./queue";
import type {
  TelegramCallback,
  TelegramChat,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
  TelegramVoice
} from "./types";
import { v5 as uuidv5 } from "uuid";

const TELEGRAM_MUTATION_NAMESPACE = "af6e79e1-c616-4c61-bc96-7207d02c9a95";
const mutationIdForUpdate = (updateId: number, operation: string): string =>
  uuidv5(`${updateId}:${operation}`, TELEGRAM_MUTATION_NAMESPACE);

export type { TelegramCallback, TelegramChat, TelegramMessage, TelegramUpdate, TelegramUser, TelegramVoice } from "./types";

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const telegramRequest = async (config: AppConfig, method: string, payload: Record<string, unknown>) => {
  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed with status ${response.status}.`);
  const result = await response.json() as unknown;
  if (!isRecord(result) || result.ok !== true) throw new Error(`Telegram ${method} returned an unverified acknowledgment.`);
  return result as { ok: true; result?: unknown };
};

const send = (config: AppConfig, chatId: number, text: string, replyMarkup?: Record<string, unknown>) =>
  telegramRequest(config, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });

const answerCallback = (config: AppConfig, callbackId: string, text?: string) =>
  telegramRequest(config, "answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });

const existingApiReceipt = async (database: SupabaseClient, userId: string, mutationId: string) => {
  const { data, error } = await database.from("api_mutation_receipts")
    .select("operation,response")
    .eq("user_id", userId)
    .eq("mutation_id", mutationId)
    .maybeSingle();
  if (error) throw error;
  return data as { operation?: string; response?: Record<string, unknown> } | null;
};

const requireTaskMutationAck = (
  value: unknown,
  userId: string,
  expectedStatus: string,
  taskId?: string,
  previousRevision?: number
): Record<string, unknown> => {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || !UUID_PATTERN.test(value.id)
    || (taskId !== undefined && value.id !== taskId)
    || value.user_id !== userId
    || value.status !== expectedStatus
    || !Number.isSafeInteger(Number(value.revision))
    || Number(value.revision) <= (previousRevision ?? 0)) {
    throw new Error("Telegram task mutation acknowledgment could not be verified.");
  }
  return value;
};

const taskPayloadForCapture = (
  capture: ParsedCapture & { notes?: string },
  taskId: string
): Record<string, unknown> => ({
  taskId,
  title: capture.title,
  notes: capture.notes ?? "",
  tags: capture.tags ?? [],
  schedulePrecision: capture.schedulePrecision,
  scheduledFor: capture.scheduledFor,
  scheduledTime: capture.scheduledTime ?? null,
  plannedOrder: 0,
  isFrog: false,
  beforeFrog: false,
  source: "telegram",
  estimatedMinutes: capture.estimatedMinutes ?? 25
});

const requireCreateTaskAck = (
  data: unknown,
  userId: string,
  capture: ParsedCapture & { notes?: string },
  taskId: string
): Record<string, unknown> => {
  const expectedDate = capture.schedulePrecision === "month" ? `${capture.scheduledFor}-01` : capture.scheduledFor;
  const expectedTags = capture.tags ?? [];
  const actualTags = isRecord(data) && Array.isArray(data.tags) ? data.tags.map(String) : null;
  const actualTime = isRecord(data) && data.scheduled_time ? String(data.scheduled_time).slice(0, 5) : undefined;
  if (!isRecord(data)
    || data.id !== taskId
    || data.user_id !== userId
    || data.title !== capture.title
    || data.notes !== (capture.notes ?? "")
    || data.source !== "telegram"
    || data.status !== "open"
    || data.schedule_precision !== capture.schedulePrecision
    || String(data.scheduled_for).slice(0, 10) !== expectedDate
    || actualTime !== capture.scheduledTime
    || Number(data.estimated_minutes) !== (capture.estimatedMinutes ?? 25)
    || !actualTags
    || JSON.stringify(actualTags) !== JSON.stringify(expectedTags)
    || !Number.isSafeInteger(Number(data.revision))
    || Number(data.revision) <= 0) {
    throw new Error("Telegram task storage acknowledgment could not be verified.");
  }
  return data;
};

const createTask = async (
  database: SupabaseClient,
  userId: string,
  capture: ParsedCapture & { notes?: string },
  today: string,
  mutationId: string,
  taskId = mutationId
) => {
  const { data, error } = await database.rpc("goalflow_create_task_idempotent", {
    target_user_id: userId,
    target_mutation_id: mutationId,
    target_local_date: today,
    task_payload: taskPayloadForCapture(capture, taskId)
  });
  if (error) throw error;
  return requireCreateTaskAck(data, userId, capture, taskId);
};

const addedText = (capture: ParsedCapture): string => {
  const dateLabel = capture.schedulePrecision === "day" ? capture.scheduledFor : `month ${capture.scheduledFor}`;
  const details = [capture.scheduledTime, capture.estimatedMinutes ? `${capture.estimatedMinutes} min` : undefined]
    .filter(Boolean).join(" · ");
  const tags = capture.tags?.length ? ` ${capture.tags.map(tag => `#${escapeHtml(tag)}`).join(" ")}` : "";
  return `<b>Added:</b> ${escapeHtml(capture.title)}${tags}${details ? `\n${details}` : ""}\nScheduled for ${dateLabel}.`;
};

const pendingKeyboard = (captureId: string): Record<string, unknown> => ({
  inline_keyboard: [
    [
      { text: "Today", callback_data: `sch:today:${captureId}` },
      { text: "Tomorrow", callback_data: `sch:tomorrow:${captureId}` }
    ],
    [{ text: "Cancel", callback_data: `cancel:${captureId}` }]
  ]
});

const isActivePending = (row: PendingCaptureRow): boolean =>
  row.state === "pending" && row.expires_at > new Date().toISOString();

const captureText = async (
  config: AppConfig, database: SupabaseClient, userId: string, chatId: number,
  text: string, today: string, updateId: number
) => {
  const capture = parseTelegramCapture(text, today);
  if (capture.defaultedToToday) {
    const captureId = mutationIdForUpdate(updateId, "text-capture");
    const pending = await ensurePendingCapture(database, captureId, userId, chatId, {
      ...capture,
      kind: "text",
      originalText: text
    });
    if (!isActivePending(pending.row)) {
      if (pending.row.state === "pending") await send(config, chatId, "That capture expired. Send it again to restart safely.");
      return;
    }
    await send(config, chatId, `${escapeHtml(capture.title)}\n\nWhen?`, pendingKeyboard(captureId));
    return;
  }
  const task = await createTask(
    database, userId, capture, today, mutationIdForUpdate(updateId, "capture-task")
  );
  await send(config, chatId, addedText(capture), {
    inline_keyboard: [[
      { text: "Undo", callback_data: `undo:${task.id}:${task.revision}` },
      { text: "Change date", callback_data: `date:${task.id}` }
    ]]
  });
};

const sendPendingPrompt = async (
  config: AppConfig,
  chatId: number,
  captureId: string,
  title: string,
  lead = ""
) => send(
  config,
  chatId,
  `${lead}${escapeHtml(title)}\n\nWhen?`,
  pendingKeyboard(captureId)
);

const handleForward = async (
  config: AppConfig,
  database: SupabaseClient,
  userId: string,
  message: TelegramMessage,
  today: string,
  updateId: number
): Promise<boolean> => {
  if (!isForwarded(message)) return false;
  const forwarded = extractForwardCapture(message);
  if (!forwarded) {
    await send(config, message.chat.id, "Forwarded capture needs a text message or caption.");
    return true;
  }
  const captureId = mutationIdForUpdate(updateId, "forward-capture");
  const pending = await ensurePendingCapture(database, captureId, userId, message.chat.id, {
    kind: "text",
    title: forwarded.title,
    notes: forwarded.notes,
    originalText: message.text ?? message.caption ?? forwarded.title,
    schedulePrecision: "day",
    scheduledFor: today,
    defaultedToToday: true
  });
  if (isActivePending(pending.row)) {
    await sendPendingPrompt(config, message.chat.id, captureId, forwarded.title, "<b>Forwarded message</b>\n");
  } else if (pending.row.state === "pending") {
    await send(config, message.chat.id, "That forwarded capture expired. Forward it again to restart safely.");
  }
  return true;
};

const handleVoice = async (
  config: AppConfig, database: SupabaseClient, speech: SpeechProvider | undefined,
  userId: string, message: TelegramMessage, today: string, updateId: number
) => {
  if (!speech) { await send(config, message.chat.id, "Voice capture is not configured yet. Send the task as text."); return; }
  const captureId = mutationIdForUpdate(updateId, "voice-capture");
  const existingCapture = await findCapture(database, captureId, userId);
  if (existingCapture) {
    if (existingCapture.state !== "pending") return;
    if (!isActivePending(existingCapture)) {
      await send(config, message.chat.id, "That voice capture expired. Send it again to restart safely.");
      return;
    }
    const decoded = decodePendingCapture(existingCapture);
    if (decoded.defaultedToToday) {
      await sendPendingPrompt(config, message.chat.id, captureId, decoded.title, "<b>I heard:</b> ");
    } else {
      await send(config, message.chat.id, `<b>I heard:</b> ${escapeHtml(decoded.title)}\nScheduled for ${decoded.scheduledFor}. Confirm before I add it.`, {
        inline_keyboard: [[
          { text: "Add task", callback_data: `confirm:${captureId}` },
          { text: "Cancel", callback_data: `cancel:${captureId}` }
        ]]
      });
    }
    return;
  }
  const voice = message.voice!;
  if ((voice.file_size ?? 0) > config.TELEGRAM_MAX_VOICE_BYTES) {
    await send(config, message.chat.id, "That voice note is too large. Keep it under 19 MB."); return;
  }
  const file = await telegramRequest(config, "getFile", { file_id: voice.file_id }) as { result?: { file_path?: string; file_size?: number } };
  const path = file.result?.file_path;
  if (!path || (file.result?.file_size ?? 0) > config.TELEGRAM_MAX_VOICE_BYTES) throw new Error("Telegram voice file is unavailable or too large.");
  const response = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("Telegram voice download failed.");
  let audio: Uint8Array | undefined = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength > config.TELEGRAM_MAX_VOICE_BYTES) throw new Error("Telegram voice file exceeded the limit.");
  const transcript = await speech.transcribe({ audio, mimeType: voice.mime_type ?? "audio/ogg", fileName: "voice.ogg" });
  audio = undefined;
  const capture = parseTelegramCapture(transcript, today);
  await ensurePendingCapture(database, captureId, userId, message.chat.id, {
    ...capture,
    kind: "voice",
    originalText: transcript
  });
  if (capture.defaultedToToday) {
    await sendPendingPrompt(config, message.chat.id, captureId, capture.title, "<b>I heard:</b> ");
  } else {
    await send(config, message.chat.id, `<b>I heard:</b> ${escapeHtml(capture.title)}\nScheduled for ${capture.scheduledFor}. Confirm before I add it.`, {
      inline_keyboard: [[
        { text: "Add task", callback_data: `confirm:${captureId}` },
        { text: "Cancel", callback_data: `cancel:${captureId}` }
      ]]
    });
  }
};

const requireCapturedTask = async (
  database: SupabaseClient,
  taskId: string,
  userId: string
): Promise<Record<string, unknown>> => {
  const { data, error } = await database.from("tasks").select("id,user_id,source,status,revision,title")
    .eq("id", taskId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!isRecord(data) || data.id !== taskId || data.user_id !== userId || data.source !== "telegram") {
    throw new Error("A confirmed Telegram capture has no verifiable task.");
  }
  return data;
};

const finalizePendingCapture = async (
  database: SupabaseClient,
  row: PendingCaptureRow,
  userId: string,
  today: string,
  mutationId: string,
  scheduledFor?: string
) => {
  const stored = decodePendingCapture(row);
  const capture = scheduledFor ? {
    ...stored,
    schedulePrecision: "day" as const,
    scheduledFor,
    defaultedToToday: false
  } : stored;
  const { data, error } = await database.rpc("goalflow_confirm_telegram_capture", {
    target_user_id: userId,
    target_capture_id: row.id,
    target_mutation_id: mutationId,
    target_local_date: today,
    task_payload: taskPayloadForCapture(capture, row.id)
  });
  if (error) throw error;
  const task = requireCreateTaskAck(data, userId, capture, row.id);
  const current = await findCapture(database, row.id, userId);
  if (current?.state !== "confirmed") {
    throw new Error("Telegram capture state acknowledgment could not be verified.");
  }
  return { capture, task };
};

const handleScheduleCallback = async (
  config: AppConfig,
  database: SupabaseClient,
  callback: TelegramCallback,
  userId: string,
  today: string,
  updateId: number,
  choice: string,
  captureId: string
) => {
  if (!UUID_PATTERN.test(captureId) || !["today", "tomorrow"].includes(choice)) {
    await answerCallback(config, callback.id, "Invalid scheduling choice");
    return;
  }
  const existing = await findCapture(database, captureId, userId);
  if (existing?.state === "confirmed") {
    await requireCapturedTask(database, captureId, userId);
    await answerCallback(config, callback.id, "Task already added");
    return;
  }
  const pending = await findPendingCapture(database, captureId, userId);
  if (!pending) {
    await answerCallback(config, callback.id, existing?.state === "cancelled" ? "Capture cancelled" : "Capture expired");
    return;
  }
  const scheduledFor = choice === "today"
    ? today
    : parseTelegramCapture("Schedule tomorrow", today).scheduledFor;
  const { capture, task } = await finalizePendingCapture(
    database,
    pending,
    userId,
    today,
    mutationIdForUpdate(updateId, "schedule-capture-task"),
    scheduledFor
  );
  await answerCallback(config, callback.id, "Task added");
  if (callback.message) {
    await send(config, callback.message.chat.id, addedText(capture), {
      inline_keyboard: [[
        { text: "Undo", callback_data: `undo:${task.id}:${task.revision}` },
        { text: "Change date", callback_data: `date:${task.id}` }
      ]]
    });
  }
};

export const createTelegramProcessor = (
  config: AppConfig, database: SupabaseClient, speech: SpeechProvider | undefined, logger: Logger
) => async (update: TelegramUpdate) => {
  const callback = update.callback_query;
  const message = update.message ?? callback?.message;
  const from = update.message?.from ?? callback?.from;
  if (!message || !from) return;
  const identity = await identityFor(database, from.id);
  if (!identity?.bot_access_granted) {
    await send(config, message.chat.id, `Link this Telegram account in Tsurfing first: ${config.APP_ORIGIN}`);
    return;
  }
  const { data: updatedIdentity, error: identityUpdateError } = await database.from("telegram_identities")
    .update({ telegram_chat_id: message.chat.id, updated_at: new Date().toISOString() })
    .eq("telegram_user_id", from.id).eq("user_id", identity.user_id)
    .select("user_id").maybeSingle();
  if (identityUpdateError || updatedIdentity?.user_id !== identity.user_id) {
    throw identityUpdateError ?? new Error("Telegram identity update was not acknowledged.");
  }
  const userId = String(identity.user_id);
  const today = await localDateFor(database, userId);

  if (callback?.data) {
    if (callback.data.startsWith("sch:")) {
      const match = callback.data.match(/^sch:(today|tomorrow):(.+)$/);
      if (!match) {
        await answerCallback(config, callback.id, "Invalid scheduling choice");
        return;
      }
      await handleScheduleCallback(config, database, callback, userId, today, update.update_id, match[1], match[2]);
      return;
    }
    const [action, id, revisionText, ...extra] = callback.data.split(":");
    if (action === "undo") {
      const expected = Number(revisionText);
      if (!UUID_PATTERN.test(id) || extra.length || !Number.isSafeInteger(expected) || expected <= 0) {
        await answerCallback(config, callback.id, "Task changed; open Tsurfing before removing it."); return;
      }
      const { data: task, error: taskError } = await database.from("tasks")
        .select("id,user_id,source,status,revision,deleted_at").eq("id", id).eq("user_id", userId).maybeSingle();
      if (taskError) throw taskError;
      if (!isRecord(task) || task.id !== id || task.user_id !== userId || task.source !== "telegram"
        || task.status !== "open" || task.deleted_at || Number(task.revision) !== expected) {
        await answerCallback(config, callback.id, "Task changed; nothing was removed."); return;
      }
      const { data: dropped, error: dropError } = await database.rpc("goalflow_drop_task_idempotent", {
        target_user_id: userId,
        target_mutation_id: mutationIdForUpdate(update.update_id, "undo-task"),
        target_task_id: id,
        target_local_date: today,
        target_expected_revision: expected
      });
      if (dropError) {
        await answerCallback(config, callback.id, "Task changed; nothing was removed."); return;
      }
      if (!isRecord(dropped) || dropped.id !== id || dropped.user_id !== userId || dropped.status !== "dropped") {
        throw new Error("Telegram undo acknowledgment could not be verified.");
      }
      await answerCallback(config, callback.id, "Task removed"); return;
    }
    if (action === "date") {
      if (!UUID_PATTERN.test(id) || revisionText !== undefined) {
        await answerCallback(config, callback.id, "Invalid task"); return;
      }
      await answerCallback(config, callback.id);
      await send(config, message.chat.id, `Use <code>/move ${id} YYYY-MM-DD</code>.`); return;
    }
    if (action === "cancel") {
      if (!UUID_PATTERN.test(id) || revisionText !== undefined) {
        await answerCallback(config, callback.id, "Invalid capture"); return;
      }
      const cancelled = await transitionPendingCapture(database, id, userId, "cancelled");
      if (!cancelled) {
        const current = await findCapture(database, id, userId);
        await answerCallback(config, callback.id, current?.state === "cancelled" ? "Capture already cancelled" : "Capture is no longer pending");
        return;
      }
      await answerCallback(config, callback.id, "Capture cancelled"); return;
    }
    if (action === "confirm") {
      if (!UUID_PATTERN.test(id) || revisionText !== undefined) {
        await answerCallback(config, callback.id, "Invalid capture"); return;
      }
      const existing = await findCapture(database, id, userId);
      if (existing?.state === "confirmed") {
        await requireCapturedTask(database, id, userId);
        await answerCallback(config, callback.id, "Task already added"); return;
      }
      const pending = await findPendingCapture(database, id, userId);
      if (!pending) { await answerCallback(config, callback.id, existing?.state === "cancelled" ? "Capture cancelled" : "Capture expired"); return; }
      await finalizePendingCapture(
        database,
        pending,
        userId,
        today,
        mutationIdForUpdate(update.update_id, "confirm-capture-task")
      );
      await answerCallback(config, callback.id, "Task added"); return;
    }
    await answerCallback(config, callback.id, "Unsupported action");
    return;
  }

  if (await handleForward(config, database, userId, message, today, update.update_id)) return;
  if (message.voice) { await handleVoice(config, database, speech, userId, message, today, update.update_id); return; }
  const text = message.text?.trim(); if (!text) return;
  const [commandWithBot, ...parts] = text.split(/\s+/); const command = commandWithBot.toLowerCase().split("@")[0];
  if (command === "/start" || command === "/help") {
    await send(config, message.chat.id, "<b>Tsurfing</b>\n/current - one task\n/today - today's ordered queue\n/add Task title - capture\n/done - complete Current\n/skip - rotate Current\nSend plain text or a voice note to capture quickly."); return;
  }
  if (command === "/current" || command === "/today" || command === "/done" || command === "/skip") {
    const commandMutationId = command === "/done"
      ? mutationIdForUpdate(update.update_id, "complete-current")
      : command === "/skip"
        ? mutationIdForUpdate(update.update_id, "skip-current")
        : undefined;
    if (commandMutationId) {
      const receipt = await existingApiReceipt(database, userId, commandMutationId);
      if (receipt?.response) {
        const expectedOperation = command === "/done" ? "complete-task" : "skip-task";
        if (receipt.operation !== expectedOperation) {
          throw new Error("Telegram mutation receipt operation did not match the request.");
        }
        const acknowledged = requireTaskMutationAck(
          receipt.response,
          userId,
          command === "/done" ? "completed" : "open"
        );
        const title = escapeHtml(String(acknowledged.title ?? "task"));
        await send(config, message.chat.id, command === "/done" ? `Completed: ${title}` : `Moved to the end of today: ${title}`);
        return;
      }
    }
    const { gate, queue } = await loadQueue(database, userId, today);
    if (command === "/today") {
      await send(config, message.chat.id, queue.length ? queue.map((task, index) => `${index + 1}. ${task.isFrog ? "🐸 " : ""}${escapeHtml(task.title)}`).join("\n") : "Nothing is scheduled for today."); return;
    }
    if (gate.state !== "ready" || !gate.queue[0]) {
      await send(config, message.chat.id, gate.state === "empty" ? "Nothing is scheduled for today." : `Planning is required before Current is available. Open ${config.APP_ORIGIN}`); return;
    }
    const current = gate.queue[0];
    if (command === "/current") {
      await send(config, message.chat.id, `<b>Current</b>\n${escapeHtml(current.title)}${current.notes ? `\n${escapeHtml(current.notes)}` : ""}\n${gate.queue.length} remaining today.`); return;
    }
    if (command === "/done") {
      const { data, error } = await database.rpc('goalflow_complete_task_idempotent', {
        target_user_id: userId,
        target_mutation_id: mutationIdForUpdate(update.update_id, "complete-current"),
        target_task_id: current.id,
        target_local_date: today,
        target_expected_revision: current.version
      });
      if (error) {
        await send(config, message.chat.id, "The task could not be completed."); return;
      }
      requireTaskMutationAck(data, userId, "completed", current.id, current.version);
      await send(config, message.chat.id, `Completed: ${escapeHtml(current.title)}`); return;
    }
    const { data, error } = await database.rpc("goalflow_skip_task_idempotent", {
      target_user_id: userId,
      target_mutation_id: mutationIdForUpdate(update.update_id, "skip-current"),
      target_task_id: current.id,
      target_day: today,
      target_expected_revision: current.version
    });
    if (error) await send(config, message.chat.id, current.isFrog ? "A frog cannot be skipped. Complete it, break it down, or drop it explicitly." : "This task could not be skipped.");
    else {
      requireTaskMutationAck(data, userId, "open", current.id, current.version);
      await send(config, message.chat.id, `Moved to the end of today: ${escapeHtml(current.title)}`);
    }
    return;
  }
  if (command === "/move") {
    const [id, date] = parts;
    if (!id || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      await send(config, message.chat.id, "Use <code>/move TASK_ID YYYY-MM-DD</code>.");
      return;
    }
    const moveMutationId = mutationIdForUpdate(update.update_id, "move-task");
    const existingMove = await existingApiReceipt(database, userId, moveMutationId);
    if (existingMove?.response) {
      if (existingMove.operation !== "reschedule-task") {
        throw new Error("Telegram mutation receipt operation did not match the request.");
      }
      const acknowledged = requireTaskMutationAck(existingMove.response, userId, "open", id);
      const acknowledgedDate = String(acknowledged.scheduled_for).slice(0, 10);
      if (acknowledgedDate !== date) throw new Error("Telegram reschedule receipt did not match the requested date.");
      await send(config, message.chat.id, `Moved to ${acknowledgedDate}.`); return;
    }
    const { data: taskToMove, error: taskError } = await database.from("tasks")
      .select("revision,status,deleted_at").eq("id", id).eq("user_id", userId).maybeSingle();
    if (taskError) throw taskError;
    if (!taskToMove || taskToMove.status !== "open" || taskToMove.deleted_at) {
      await send(config, message.chat.id, "The task no longer exists or is no longer open."); return;
    }
    const parsed = parseTelegramCapture(`Move ${date ?? ""}`, today);
    const { data, error } = await database.rpc('goalflow_reschedule_task_idempotent', {
      target_user_id: userId,
      target_mutation_id: moveMutationId,
      target_task_id: id, target_local_date: today,
      target_schedule_precision: 'day', target_scheduled_for: parsed.scheduledFor, target_scheduled_time: null,
      target_expected_revision: Number(taskToMove.revision)
    });
    if (error) {
      await send(config, message.chat.id, "The task could not be moved."); return;
    }
    const moved = requireTaskMutationAck(data, userId, "open", id, Number(taskToMove.revision));
    if (String(moved.scheduled_for).slice(0, 10) !== parsed.scheduledFor) {
      throw new Error("Telegram reschedule acknowledgment did not match the requested date.");
    }
    await send(config, message.chat.id, `Moved to ${parsed.scheduledFor}.`); return;
  }
  const captureTextValue = command === "/add" ? parts.join(" ") : text;
  try { await captureText(config, database, userId, message.chat.id, captureTextValue, today, update.update_id); }
  catch (error) {
    logger.warn("telegram.capture_rejected", { updateId: update.update_id, userId, category: error instanceof Error ? error.name : "unknown" });
    await send(config, message.chat.id, "The task was not acknowledged. Telegram will retry it safely; do not resend it yet.");
    throw error;
  }
};
