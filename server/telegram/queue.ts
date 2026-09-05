import type { SupabaseClient } from "@supabase/supabase-js";
import { buildTodayQueue, getPlanningGate, type DailyPlan, type ScheduledTask } from "../../src/domain/scheduling";

export const rowToTask = (row: Record<string, unknown>): ScheduledTask => ({
  id: String(row.id),
  userId: String(row.user_id),
  title: String(row.title),
  notes: String(row.notes ?? ""),
  tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
  schedulePrecision: row.schedule_precision as "day" | "month",
  scheduledFor: row.schedule_precision === "month"
    ? String(row.scheduled_for).slice(0, 7)
    : String(row.scheduled_for).slice(0, 10),
  scheduledTime: row.scheduled_time ? String(row.scheduled_time).slice(0, 5) : undefined,
  plannedOrder: Number(row.planned_order ?? 0),
  status: row.status as ScheduledTask["status"],
  isFrog: Boolean(row.is_frog),
  frogFailures: Number(row.frog_failures ?? 0),
  beforeFrog: Boolean(row.before_frog),
  source: row.source as ScheduledTask["source"],
  parentTaskId: row.parent_task_id ? String(row.parent_task_id) : undefined,
  habitId: row.habit_id ? String(row.habit_id) : undefined,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
  version: Number(row.revision ?? 1)
});

export const identityFor = async (database: SupabaseClient, telegramUserId: number) => {
  const { data: identity, error: identityError } = await database.from("telegram_identities")
    .select("user_id,telegram_chat_id,bot_access_granted")
    .eq("telegram_user_id", telegramUserId).maybeSingle();
  if (identityError) throw identityError;
  if (!identity?.bot_access_granted || typeof identity.user_id !== "string") return null;
  const { data: profile, error: profileError } = await database.from("profiles")
    .select("status").eq("user_id", identity.user_id).maybeSingle();
  if (profileError) throw profileError;
  return profile?.status === "active" ? identity : null;
};

export const localDateFor = async (database: SupabaseClient, userId: string, at = new Date()): Promise<string> => {
  const { data, error } = await database.from("profiles").select("timezone").eq("user_id", userId).maybeSingle();
  if (error || typeof data?.timezone !== "string" || !data.timezone) {
    throw new Error("The account timezone could not be verified.");
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: data.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(at);
  } catch {
    throw new Error("The account timezone is invalid.");
  }
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  if (!/^\d{4}$/.test(value.year ?? "") || !/^\d{2}$/.test(value.month ?? "") || !/^\d{2}$/.test(value.day ?? "")) {
    throw new Error("The account local date could not be determined.");
  }
  return `${value.year}-${value.month}-${value.day}`;
};

export const loadQueue = async (database: SupabaseClient, userId: string, today: string) => {
  const [{ data: rows, error }, { data: planRow, error: planError }] = await Promise.all([
    database.from("tasks").select("*").eq("user_id", userId).eq("status", "open").is("deleted_at", null),
    database.from("daily_plans").select("local_date,confirmed_at,task_ids")
      .eq("user_id", userId).eq("local_date", today).maybeSingle()
  ]);
  if (error) throw error;
  if (planError) throw planError;
  const tasks = (rows ?? []).map(row => rowToTask(row as Record<string, unknown>));
  const plan: DailyPlan | undefined = planRow ? {
    localDate: String(planRow.local_date),
    confirmedAt: String(planRow.confirmed_at),
    taskIds: (planRow.task_ids ?? []).map(String)
  } : undefined;
  return { tasks, gate: getPlanningGate(tasks, today, plan), queue: buildTodayQueue(tasks, today) };
};
