import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { confirmOrderSchema } from '../src/domain/deliberatePlanning';
import { assertPlanningDay, assertPlanningResponse, assertPlanningReview } from '../services/deliberatePlanningProtocol';

export async function confirmOrder(database: SupabaseClient, accountId: string, input: unknown) {
  const command = confirmOrderSchema.parse(input);
  if (command.accountId !== accountId) throw new z.ZodError([{ code: 'custom', path: ['accountId'], message: 'Planning account does not match authentication.' }]);
  const { data, error } = await database.rpc('goalflow_confirm_order_v1', { target_user_id: accountId, command });
  if (error) throw error;
  return assertPlanningResponse(accountId, command, data);
}
export async function readPlanningDay(database: SupabaseClient, accountId: string, date: unknown) {
  const localDate = confirmOrderSchema.shape.localDate.parse(date);
  const { data, error } = await database.rpc('goalflow_planning_day_v1', { target_user_id: accountId, target_day: localDate });
  if (error) throw error;
  return assertPlanningDay(accountId, localDate, data);
}

export async function readPlanningReview(database: SupabaseClient, accountId: string, input: unknown) {
  const command = confirmOrderSchema.parse(input);
  if (command.accountId !== accountId) throw new z.ZodError([{ code: 'custom', path: ['accountId'], message: 'Planning account does not match authentication.' }]);
  const { data, error } = await database.rpc('goalflow_planning_review_v1', {
    target_user_id: accountId, target_operation_id: command.operationId,
  });
  if (error) throw error;
  return assertPlanningReview(accountId, command, data);
}
