import { z } from 'zod';
import { parseCausalCutover, assertCausalCutoverReceipt } from './causalCutoverProtocol';
import { stableJson } from './syncProtocol';

const initialization = z.object({ schemaVersion: z.literal(2), accountId: z.string().uuid(),
  initializationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  initialTracking: z.record(z.unknown()) }).strict();
export type CausalInitializationOperation = z.infer<typeof initialization>;

export function parseCausalInitialization(accountId: string, input: unknown): CausalInitializationOperation {
  const operation = initialization.parse(input);
  if (operation.accountId !== accountId || operation.initialTracking.planViewCount !== 0
    || operation.initialTracking.dailyPostponeCount !== 0 || operation.initialTracking.focusSession != null) {
    throw new z.ZodError([{ code: 'custom', path: ['initialTracking'], message: 'Initialization requires empty local defaults for this account.' }]);
  }
  // Reuse the same date, count, optional focus and unknown-field validation.
  parseCausalCutover(accountId, { schemaVersion: 2, accountId, cutoverId: operation.initializationId,
    expectedTrackingServerVersion: 1, expectedTrackingPayload: operation.initialTracking });
  return operation;
}

/** A separate receipt proves the exact initialization request. Its nested
 * cutover receipt retains the existing exact selected-record contract. */
export function assertCausalInitializationReceipt(accountId: string, operation: CausalInitializationOperation, input: unknown) {
  parseCausalInitialization(accountId, operation);
  const receipt = input as Record<string, any> | null;
  if (!receipt || receipt.schemaVersion !== 2 || receipt.type !== 'initialization' || typeof receipt.created !== 'boolean'
    || stableJson(receipt.operation) !== stableJson(operation)) throw new Error('Initialization did not prove the exact request.');
  const cutover = parseCausalCutover(accountId, receipt.cutoverReceipt?.operation);
  const verified = assertCausalCutoverReceipt(accountId, cutover, receipt.cutoverReceipt);
  if (cutover.cutoverId !== operation.initializationId || (receipt.created
    && (stableJson(cutover.expectedTrackingPayload) !== stableJson(operation.initialTracking)
      || verified.record.version !== 1 || verified.record.device_id !== 'causal-initialization-v2'))) {
    throw new Error('Initialization did not prove the selected baseline.');
  }
  return receipt;
}
