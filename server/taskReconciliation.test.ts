import { expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reconcileLegacyTasks } from './taskReconciliation';

it('preserves complete final notes in the compatibility projection instead of truncating them', async () => {
  const owner = crypto.randomUUID(), notes = '🧭'.repeat(12000); let written: any;
  const builder = {
    select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null, error: null }; },
    async upsert(row: unknown) { written = row; return { error: null }; }
  };
  const database = { from: () => builder } as unknown as SupabaseClient;
  await reconcileLegacyTasks(database, owner, { id: 'synthetic', title: 'Final notes', scheduledFor: '2026-09-08', completed: true, description: notes }, { serverVersion: 5, updatedAt: '2026-09-08T00:05:00.000Z' });
  expect(written.notes).toBe(notes); expect(written.user_id).toBe(owner); expect(written.status).toBe('completed');
});
