import type { SupabaseClient } from '@supabase/supabase-js';
import { assertCausalHistoryChunk, causalHistoryPosition } from '../services/causalHistoryProtocol';

export async function readCausalHistoryChunk(database: SupabaseClient, accountId: string, input: unknown) {
  const position = causalHistoryPosition.parse(input);
  const { data, error } = await database.rpc('goalflow_causal_history_chunk_v2', {
    target_user_id: accountId, target_epoch: position.epoch, target_revision: position.revision,
    through_revision: position.throughRevision, target_offset: position.offset
  });
  if (error) throw error;
  return assertCausalHistoryChunk(accountId, position, data);
}
