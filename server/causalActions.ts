import type { SupabaseClient } from '@supabase/supabase-js';
import { assertCausalReceipt, parseCausalOperation } from '../services/causalProtocol';
export { assertCausalReceipt, parseCausalOperation, type CausalOperation } from '../services/causalProtocol';

export async function admitCausalOperation(database: SupabaseClient, userId: string, input: unknown) {
  const operation = parseCausalOperation(userId, input);
  const { data, error } = await database.rpc(operation.type === 'counterDay' ? 'goalflow_counter_day_v2' : 'goalflow_admit_action_v2', {
    target_user_id: userId, operation
  });
  if (error) throw error;
  return assertCausalReceipt(userId, operation, data);
}
