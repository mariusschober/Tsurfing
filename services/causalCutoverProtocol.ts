import { z } from 'zod';
import { assertCausalHistoryEntry } from './causalHistoryProtocol';
import { stableJson } from './syncProtocol';

const cutover = z.object({
  schemaVersion: z.literal(2),
  accountId: z.string().uuid(),
  cutoverId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  expectedTrackingServerVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  expectedTrackingPayload: z.custom<Record<string, unknown>>(value =>
    value !== null && typeof value === 'object' && !Array.isArray(value))
}).strict();

export type CausalCutoverOperation = z.infer<typeof cutover>;

/** A compare-and-establish request, never a replacement tracking snapshot.
 * Preserve the payload verbatim; the database validates its baseline and focus. */
export function parseCausalCutover(accountId: string, input: unknown): CausalCutoverOperation {
  const operation = cutover.parse(input);
  if (operation.accountId !== accountId) {
    throw new z.ZodError([{ code: 'custom', path: ['accountId'], message: 'Invalid cutover account.' }]);
  }
  return operation;
}

/** Revision-zero history proves the baseline; equality additionally proves this
 * particular attempted request, including unknown preserved payload fields. */
export function assertCausalCutoverReceipt(accountId: string, operation: CausalCutoverOperation, input: unknown) {
  parseCausalCutover(accountId, operation);
  const entry = assertCausalHistoryEntry(accountId, operation.cutoverId, 0, {
    schemaVersion: 2, accountId, epoch: operation.cutoverId, revision: 0, receipt: input
  });
  if (stableJson(entry.receipt.operation) !== stableJson(operation)) {
    throw new Error('Causal enrollment did not prove the exact attempted cutover.');
  }
  return entry.receipt as Record<string, any>;
}
