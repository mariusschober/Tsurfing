import type { SupabaseClient } from "@supabase/supabase-js";
import { loadQueue } from "./queue";

export const getMiniCurrent = async (database: SupabaseClient, userId: string, today: string) => {
  const { gate, queue } = await loadQueue(database, userId, today);
  return { gate, queue, current: gate.state === "ready" ? gate.queue[0] ?? null : null };
};

export const getMiniToday = async (database: SupabaseClient, userId: string, today: string) => {
  const { queue, gate } = await loadQueue(database, userId, today);
  return { gate, queue };
};

export const createMiniTask = async (
  database: SupabaseClient,
  userId: string,
  today: string,
  mutationId: string,
  payload: {
    title: string;
    schedulePrecision: "day" | "month";
    scheduledFor: string;
    scheduledTime?: string;
    estimatedMinutes?: number;
    tags?: string[];
  }
) => {
  const { data, error } = await database.rpc("goalflow_create_task_idempotent", {
    target_user_id: userId,
    target_mutation_id: mutationId,
    target_local_date: today,
    task_payload: {
      taskId: mutationId,
      title: payload.title,
      notes: "",
      tags: payload.tags ?? [],
      schedulePrecision: payload.schedulePrecision,
      scheduledFor: payload.scheduledFor,
      scheduledTime: payload.scheduledTime ?? null,
      plannedOrder: 0,
      isFrog: false,
      beforeFrog: false,
      source: "telegram",
      estimatedMinutes: payload.estimatedMinutes ?? 25
    }
  });
  if (error) throw error;
  return data;
};
