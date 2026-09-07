import { stableJson } from '../../services/syncProtocol';

export type CounterType = 'planViewCount' | 'dailyPostponeCount';
export interface CounterBaseline {
  schemaVersion: 1;
  baselineId: string;
  accountId: string;
  day: string;
  counts: Record<CounterType, number>;
  /** Immutable evidence already represented by this baseline, not new deltas. */
  evidenceIds: string[];
  [key: string]: unknown;
}

export interface CounterDelta {
  schemaVersion: 1;
  actionId: string;
  accountId: string;
  actorId: string;
  day: string;
  timeZone: string;
  counter: CounterType;
  delta: number;
  capturedAt: string;
  businessActionId: string | null;
  /** A correction is a distinct event; the referenced original never changes. */
  correctionOf: string | null;
  [key: string]: unknown;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const day = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export class CounterLedgerError extends Error {
  constructor(readonly code: 'INVALID_BASELINE' | 'INVALID_DELTA' | 'SCOPE_MISMATCH' | 'IDENTITY_MISMATCH' | 'RANGE', message: string) {
    super(message);
    this.name = 'CounterLedgerError';
  }
}

export function validateCounterBaseline(value: unknown): asserts value is CounterBaseline {
  if (!object(value) || value.schemaVersion !== 1 || !identity(value.baselineId)
    || !identity(value.accountId) || !day(value.day) || !object(value.counts)
    || !count(value.counts.planViewCount) || !count(value.counts.dailyPostponeCount)
    || !Array.isArray(value.evidenceIds) || value.evidenceIds.some(id => !identity(id))
    || new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    throw new CounterLedgerError('INVALID_BASELINE', 'The counter baseline needs explicit valid evidence. Nothing was reset.');
  }
}

export function validateCounterDelta(value: unknown): asserts value is CounterDelta {
  if (!object(value) || value.schemaVersion !== 1 || !identity(value.actionId)
    || !identity(value.accountId) || typeof value.actorId !== 'string' || value.actorId.length < 1 || value.actorId.length > 240
    || !day(value.day) || typeof value.timeZone !== 'string' || !/^[A-Za-z0-9_+./-]{1,128}$/.test(value.timeZone)
    || !['planViewCount', 'dailyPostponeCount'].includes(value.counter as string)
    || typeof value.delta !== 'number' || !Number.isSafeInteger(value.delta) || value.delta === 0
    || (value.correctionOf === null ? value.delta !== 1 : !identity(value.correctionOf))
    || (value.businessActionId !== null && !identity(value.businessActionId))
    || typeof value.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.capturedAt)
    || !Number.isFinite(Date.parse(value.capturedAt)) || new Date(value.capturedAt).toISOString() !== value.capturedAt) {
    throw new CounterLedgerError('INVALID_DELTA', 'The counter action is invalid and remains available for recovery.');
  }
}

/** Pure projection; callers establish/authenticate baselines and admit events
 * transactionally. Historical receipt IDs cannot be replayed as new actions.
 * Scope validation happens before deduplication, including other-day events.
 */
export function projectCounters(baseline: CounterBaseline, events: readonly CounterDelta[]): Record<CounterType, number> {
  validateCounterBaseline(baseline);
  const accepted = new Map<string, string>();
  const counts = { ...baseline.counts };
  const totals = { planViewCount: BigInt(counts.planViewCount), dailyPostponeCount: BigInt(counts.dailyPostponeCount) };
  for (const event of events) {
    validateCounterDelta(event);
    if (event.accountId !== baseline.accountId) throw new CounterLedgerError('SCOPE_MISMATCH', 'Counter evidence belongs to another account.');
    if (baseline.evidenceIds.includes(event.actionId)) throw new CounterLedgerError('IDENTITY_MISMATCH', 'Historical baseline evidence cannot become a new delta.');
    const fingerprint = stableJson(event);
    const previous = accepted.get(event.actionId);
    if (previous !== undefined && previous !== fingerprint) throw new CounterLedgerError('IDENTITY_MISMATCH', 'The same counter action identity has different payloads.');
    if (previous !== undefined) continue;
    accepted.set(event.actionId, fingerprint);
    if (event.day !== baseline.day) continue;
    totals[event.counter] += BigInt(event.delta);
  }
  for (const counter of ['planViewCount', 'dailyPostponeCount'] as const) {
    if (totals[counter] < 0n || totals[counter] > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CounterLedgerError('RANGE', 'The counter result is outside its supported range.');
    }
    counts[counter] = Number(totals[counter]);
  }
  return counts;
}
