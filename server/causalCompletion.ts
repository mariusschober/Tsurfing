import type { SupabaseClient } from '@supabase/supabase-js';
import { assertCausalCompletionReceipt, parseCausalCompletion } from '../services/causalCompletionProtocol';

export async function completeCausalFocus(database: SupabaseClient, accountId: string, input: unknown) {
  const operation = parseCausalCompletion(accountId, input);
  const { data, error } = await database.rpc('goalflow_complete_focus_v2', { target_user_id: accountId, operation });
  if (error) throw error;
  return assertCausalCompletionReceipt(accountId, operation, data);
}
