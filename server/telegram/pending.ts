import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedCapture } from "./capture";

const CAPTURE_ENVELOPE_VERSION = 1;
const CAPTURE_COLUMNS = "id,user_id,telegram_chat_id,kind,title,transcript,schedule_precision,scheduled_for,state,expires_at";

export interface PendingCaptureInput extends ParsedCapture {
  kind: "text" | "voice";
  notes?: string;
  originalText: string;
}

export interface PendingCaptureRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  telegram_chat_id: number;
  kind: "text" | "voice";
  title: string;
  transcript: string | null;
  schedule_precision: "day" | "month";
  scheduled_for: string;
  state: "pending" | "confirmed" | "cancelled" | "expired";
  expires_at: string;
}

interface CaptureEnvelope {
  goalflowTelegramCapture: typeof CAPTURE_ENVELOPE_VERSION;
  originalText: string;
  defaultedToToday: boolean;
  scheduledTime?: string;
  estimatedMinutes?: number;
  tags?: string[];
  notes?: string;
}

const encodeEnvelope = (input: PendingCaptureInput): string => JSON.stringify({
  goalflowTelegramCapture: CAPTURE_ENVELOPE_VERSION,
  originalText: input.originalText.slice(0, 10_000),
  defaultedToToday: input.defaultedToToday,
  ...(input.scheduledTime ? { scheduledTime: input.scheduledTime } : {}),
  ...(input.estimatedMinutes ? { estimatedMinutes: input.estimatedMinutes } : {}),
  ...(input.tags?.length ? { tags: input.tags } : {}),
  ...(input.notes ? { notes: input.notes.slice(0, 10_000) } : {})
} satisfies CaptureEnvelope);

const decodeEnvelope = (value: unknown): CaptureEnvelope | null => {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const envelope = parsed as Partial<CaptureEnvelope>;
    if (envelope.goalflowTelegramCapture !== CAPTURE_ENVELOPE_VERSION
      || typeof envelope.originalText !== "string"
      || typeof envelope.defaultedToToday !== "boolean") return null;
    return envelope as CaptureEnvelope;
  } catch {
    return null;
  }
};

const normalizedStoredDay = (input: PendingCaptureInput): string =>
  input.schedulePrecision === "month" ? `${input.scheduledFor}-01` : input.scheduledFor;

const isSamePendingIntent = (row: PendingCaptureRow, input: PendingCaptureInput, chatId: number): boolean =>
  row.telegram_chat_id === chatId
  && row.kind === input.kind
  && row.title === input.title
  && row.schedule_precision === input.schedulePrecision
  && row.scheduled_for.slice(0, 10) === normalizedStoredDay(input)
  && row.transcript === encodeEnvelope(input);

export const findCapture = async (
  database: SupabaseClient,
  captureId: string,
  userId: string
): Promise<PendingCaptureRow | null> => {
  const { data, error } = await database.from("telegram_captures")
    .select(CAPTURE_COLUMNS).eq("id", captureId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data as PendingCaptureRow | null;
};

export const findPendingCapture = async (
  database: SupabaseClient,
  captureId: string,
  userId: string
): Promise<PendingCaptureRow | null> => {
  const row = await findCapture(database, captureId, userId);
  return row?.state === "pending" && row.expires_at > new Date().toISOString() ? row : null;
};

export const ensurePendingCapture = async (
  database: SupabaseClient,
  captureId: string,
  userId: string,
  chatId: number,
  input: PendingCaptureInput
): Promise<{ row: PendingCaptureRow; existing: boolean }> => {
  const existing = await findCapture(database, captureId, userId);
  if (existing) {
    if (!isSamePendingIntent(existing, input, chatId)) {
      throw new Error("Telegram capture identity was reused for different content.");
    }
    return { row: existing, existing: true };
  }
  const row = {
    id: captureId,
    user_id: userId,
    telegram_chat_id: chatId,
    kind: input.kind,
    title: input.title,
    transcript: encodeEnvelope(input),
    schedule_precision: input.schedulePrecision,
    scheduled_for: normalizedStoredDay(input),
    state: "pending",
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
  };
  const { data, error } = await database.from("telegram_captures")
    .insert(row).select(CAPTURE_COLUMNS).single();
  if (error) throw error;
  const stored = data as PendingCaptureRow | null;
  if (!stored || stored.id !== captureId || stored.user_id !== userId || stored.state !== "pending"
    || !isSamePendingIntent(stored, input, chatId)) {
    throw new Error("Telegram pending capture acknowledgment could not be verified.");
  }
  return { row: stored, existing: false };
};

export const decodePendingCapture = (row: PendingCaptureRow): ParsedCapture & { notes?: string } => {
  const envelope = decodeEnvelope(row.transcript);
  const scheduledFor = row.schedule_precision === "month"
    ? row.scheduled_for.slice(0, 7)
    : row.scheduled_for.slice(0, 10);
  return {
    title: row.title,
    schedulePrecision: row.schedule_precision,
    scheduledFor,
    ...(envelope?.scheduledTime ? { scheduledTime: envelope.scheduledTime } : {}),
    ...(envelope?.estimatedMinutes ? { estimatedMinutes: envelope.estimatedMinutes } : {}),
    ...(envelope?.tags?.length ? { tags: envelope.tags } : {}),
    ...(envelope?.notes ? { notes: envelope.notes } : {}),
    defaultedToToday: envelope?.defaultedToToday ?? false
  };
};

export const transitionPendingCapture = async (
  database: SupabaseClient,
  captureId: string,
  userId: string,
  state: "confirmed" | "cancelled"
): Promise<boolean> => {
  const { data, error } = await database.from("telegram_captures").update({ state })
    .eq("id", captureId).eq("user_id", userId).eq("state", "pending")
    .select("id,state").maybeSingle();
  if (error) throw error;
  return data?.id === captureId && data.state === state;
};
