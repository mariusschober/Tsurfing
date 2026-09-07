import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const conflictPageQuery = z.object({
  after: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20)
}).strict();

/** A scan cursor, never a durable sync high-water mark. Restart every sync. */
export async function readConflictPage(database: SupabaseClient, userId: string, input: unknown) {
  const { after, limit } = conflictPageQuery.parse(input);
  let query = database.from('sync_conflicts').select('*')
    .eq('user_id', userId).is('resolved_at', null)
    .order('id', { ascending: true }).limit(limit);
  if (after) query = query.gt('id', after);
  const { data, error } = await query;
  if (error) throw error;
  const conflicts = data ?? [];
  let previous = after?.toLowerCase() ?? '';
  for (const conflict of conflicts) {
    const id = z.string().uuid().parse(conflict.id).toLowerCase();
    if (id <= previous) throw new Error('Conflict scan did not advance safely.');
    previous = id;
  }
  // Probe with a subsequent request even for a short page. A deployment's
  // PostgREST row cap may be lower than our requested limit.
  return { conflicts, nextAfter: conflicts.length ? previous : null, hasMore: conflicts.length > 0 };
}
