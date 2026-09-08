import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

type LegacyTask = Record<string, unknown>;

const deterministicUuid = (userId: string, namespace: string, value: string): string => {
  const bytes = crypto.createHash('sha256').update(`${userId}:${namespace}:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const validUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const canonicalStatus = (task: LegacyTask): 'open' | 'completed' | 'broken_down' | 'dropped' | 'archived' => {
  if (task.lifecycleStatus === 'broken_down') return 'broken_down';
  if (task.lifecycleStatus === 'archived') return 'archived';
  if (task.wontDo || task.lifecycleStatus === 'dropped') return 'dropped';
  if (task.completed || task.lifecycleStatus === 'completed') return 'completed';
  return 'open';
};

const safeInstant = (value: unknown, fallback: string): string => {
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value ?? ''));
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
};

export interface ReconcileTaskOptions {
  entityId?: string;
  serverVersion?: number;
  deletedAt?: string | null;
  updatedAt?: string;
}
/**
 * Backward-compatible projection into canonical tasks. The database migration
 * performs the same projection transactionally inside push_sync_mutation; this
 * adapter is retained for an old database during a rolling deployment and is
 * guarded by sync_server_version so a replay cannot overwrite newer state.
 */
export const reconcileLegacyTasks = async (
  database: SupabaseClient,
  userId: string,
  payload: unknown,
  options: ReconcileTaskOptions = {}
): Promise<void> => {
  const values = Array.isArray(payload) ? payload.slice(0, 10_000) : [payload];
  const serverVersion = Number.isSafeInteger(options.serverVersion) && Number(options.serverVersion) > 0
    ? Number(options.serverVersion)
    : undefined;
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const task = value as LegacyTask;
    const legacyId = String(task.id || options.entityId || '').slice(0, 240);
    if (!legacyId) continue;
    const cloudId = validUuid(task.cloudId) ? task.cloudId : validUuid(legacyId) ? legacyId : undefined;

    let existing: { id: string; user_id: string; sync_server_version?: number | null } | null = null;
    if (cloudId) {
      const { data, error } = await database.from('tasks').select('id,user_id,sync_server_version')
        .eq('id', cloudId).maybeSingle();
      if (error && !String(error.message || '').includes('sync_server_version')) throw error;
      if (data && data.user_id !== userId) throw new Error('A task identifier belongs to another user.');
      existing = data as typeof existing;
    }
    if (!existing) {
      const { data, error } = await database.from('tasks').select('id,user_id,sync_server_version')
        .eq('user_id', userId).eq('legacy_entity_id', legacyId).maybeSingle();
      if (error && !String(error.message || '').includes('sync_server_version')) throw error;
      existing = data as typeof existing;
    }
    if (serverVersion && Number(existing?.sync_server_version ?? 0) >= serverVersion) continue;

    const deletedAt = options.deletedAt ?? (task.deletedAt ? safeInstant(task.deletedAt, options.updatedAt || new Date(0).toISOString()) : null);
    if (deletedAt) {
      if (!existing) continue;
      let query = database.from('tasks').update({ deleted_at: deletedAt, sync_server_version: serverVersion ?? null })
        .eq('id', existing.id).eq('user_id', userId);
      if (serverVersion) query = query.or(`sync_server_version.is.null,sync_server_version.lt.${serverVersion}`);
      const { error } = await query;
      if (error && String(error.message || '').includes('sync_server_version')) {
        const { error: legacyError } = await database.from('tasks').update({ deleted_at: deletedAt })
          .eq('id', existing.id).eq('user_id', userId);
        if (legacyError) throw legacyError;
      } else if (error) throw error;
      continue;
    }

    const title = String(task.title || '').trim().slice(0, 240);
    if (!title) continue;
    const precision = task.schedulePrecision === 'month' ? 'month' : 'day';
    const scheduleValue = String(task.scheduledFor || task.dateAssigned || '');
    if (precision === 'day' && !/^\d{4}-\d{2}-\d{2}$/.test(scheduleValue)) continue;
    if (precision === 'month' && !/^\d{4}-\d{2}$/.test(scheduleValue)) continue;
    const status = canonicalStatus(task);
    const habitId = task.habitId ? deterministicUuid(userId, 'habit', String(task.habitId)) : null;
    const fallbackInstant = options.updatedAt || new Date(0).toISOString();
    const row = {
      ...(existing?.id ? { id: existing.id } : cloudId ? { id: cloudId } : {}),
      user_id: userId,
      legacy_entity_id: (existing?.id || cloudId) === legacyId ? null : legacyId,
      title,
      notes: String(task.description ?? task.notes ?? ''),
      tags: Array.isArray(task.hashtags) ? task.hashtags.map(String).slice(0, 20) : [],
      schedule_precision: precision,
      scheduled_for: precision === 'month' ? `${scheduleValue}-01` : scheduleValue,
      scheduled_time: typeof task.scheduledTime === 'string' ? task.scheduledTime : null,
      planned_order: Math.max(0, Math.floor(Number(task.plannedOrder || 0))),
      status,
      completed_at: status === 'completed' ? safeInstant(task.completedAt ?? task.updatedAt, fallbackInstant) : null,
      is_frog: Boolean(task.isFrog),
      frog_failures: Math.max(0, Math.floor(Number(task.frogFailures ?? task.rescheduleCount ?? 0))),
      before_frog: Boolean(task.beforeFrog && habitId),
      source: ['manual', 'habit', 'telegram', 'share', 'ai', 'migration'].includes(String(task.source)) ? task.source : 'migration',
      habit_id: habitId,
      estimated_minutes: Math.min(1_440, Math.max(1, Math.floor(Number(task.duration || task.estimatedMinutes || 25)))),
      deleted_at: null,
      sync_server_version: serverVersion ?? null
    };
    const { error } = await database.from('tasks').upsert(row, { onConflict: 'id' });
    if (error && String(error.message || '').includes('sync_server_version')) {
      const { sync_server_version: _ignored, ...legacyRow } = row;
      const { error: legacyError } = await database.from('tasks').upsert(legacyRow, { onConflict: 'id' });
      if (legacyError) throw legacyError;
    } else if (error) throw error;
  }
};
