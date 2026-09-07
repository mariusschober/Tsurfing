/**
 * The durable focus-session projection shared by Web, Android, and macOS.
 *
 * A session stores action anchors only. Clients derive the live elapsed and
 * remaining values from `startedAt` and the current clock; the ticker never
 * writes this record.
 */
export const FOCUS_SESSION_SCHEMA_VERSION = 1 as const;
export type FocusSessionPhase = 'active' | 'paused' | 'stopped' | 'completed';

export interface FocusSessionRecord {
  schemaVersion: typeof FOCUS_SESSION_SCHEMA_VERSION;
  sessionId: string;
  taskId: string;
  phase: FocusSessionPhase;
  plannedDurationSeconds: number;
  startedAt: string;
  elapsedSeconds: number;
  pausedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 1_440 * 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const isValidInstant = (value: unknown): value is string =>
  typeof value === 'string' && ISO_INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value));

const asDuration = (value: unknown): number | null => {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= MIN_DURATION_SECONDS
    && value <= MAX_DURATION_SECONDS
    ? value : null;
};

const asElapsed = (value: unknown): number | null => {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER
    ? value : null;
};

/** Validate an optional remote value without accepting malformed timer data. */
export const normalizeFocusSession = (value: unknown): FocusSessionRecord | null => {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)
    || value.schemaVersion !== FOCUS_SESSION_SCHEMA_VERSION
    || typeof value.sessionId !== 'string' || !UUID_PATTERN.test(value.sessionId)
    || typeof value.taskId !== 'string' || value.taskId.trim().length === 0 || value.taskId.length > 240
    || typeof value.phase !== 'string' || !['active', 'paused', 'stopped', 'completed'].includes(value.phase)
    || asDuration(value.plannedDurationSeconds) === null
    || !isValidInstant(value.startedAt)
    || asElapsed(value.elapsedSeconds) === null
    || (value.pausedAt !== null && !isValidInstant(value.pausedAt))
    || (value.endedAt !== null && !isValidInstant(value.endedAt))
    || !isValidInstant(value.updatedAt)) return null;
  const phase = value.phase as FocusSessionPhase;
  const pausedAt = value.pausedAt as string | null;
  const endedAt = value.endedAt as string | null;
  const startedTime = Date.parse(value.startedAt);
  const updatedTime = Date.parse(value.updatedAt);
  const pausedTime = pausedAt === null ? null : Date.parse(pausedAt);
  const endedTime = endedAt === null ? null : Date.parse(endedAt);
  if (startedTime > updatedTime
    || (pausedTime !== null && (pausedTime < startedTime || pausedTime > updatedTime))
    || (endedTime !== null && (endedTime < startedTime || endedTime > updatedTime))) return null;
  if (phase === 'active' && (pausedAt !== null || endedAt !== null)) return null;
  if (phase === 'paused' && (pausedAt === null || endedAt !== null)) return null;
  if ((phase === 'stopped' || phase === 'completed') && endedAt === null) return null;
  return {
    schemaVersion: FOCUS_SESSION_SCHEMA_VERSION,
    sessionId: value.sessionId,
    taskId: value.taskId,
    phase,
    plannedDurationSeconds: Number(value.plannedDurationSeconds),
    startedAt: value.startedAt,
    elapsedSeconds: Number(value.elapsedSeconds),
    pausedAt,
    endedAt,
    updatedAt: value.updatedAt
  };
};

export const focusSessionElapsedSeconds = (
  session: FocusSessionRecord,
  now: Date = new Date()
): number => {
  const base = Math.max(0, session.elapsedSeconds);
  if (session.phase !== 'active') return base;
  const start = Date.parse(session.startedAt);
  const nowMillis = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(nowMillis)) return base;
  return base + Math.max(0, Math.floor((nowMillis - start) / 1_000));
};

export const focusSessionRemainingSeconds = (
  session: FocusSessionRecord,
  now: Date = new Date()
): number => Math.max(0, session.plannedDurationSeconds - focusSessionElapsedSeconds(session, now));

export const focusSessionOvertimeSeconds = (
  session: FocusSessionRecord,
  now: Date = new Date()
): number => session.phase === 'active'
  ? Math.max(0, focusSessionElapsedSeconds(session, now) - session.plannedDurationSeconds)
  : 0;

const iso = (now: Date): string => now.toISOString();

const requireTask = (taskId: string): void => {
  if (typeof taskId !== 'string' || taskId.trim().length === 0) throw new Error('A focus session needs a task identity.');
};

const requireNow = (now: Date): void => {
  if (!Number.isFinite(now.getTime())) throw new Error('A focus session needs a valid clock instant.');
};

const requireSession = (session: FocusSessionRecord): void => {
  if (!normalizeFocusSession(session)) throw new Error('The focus session is damaged. The timer action was not applied.');
};

export const startFocusSession = (
  taskId: string,
  plannedDurationSeconds: number,
  now: Date = new Date(),
  sessionId: string = crypto.randomUUID()
): FocusSessionRecord => {
  requireTask(taskId); requireNow(now);
  const duration = asDuration(plannedDurationSeconds);
  if (duration === null) throw new Error('The focus session duration is invalid.');
  if (!UUID_PATTERN.test(sessionId)) throw new Error('The focus session identity is invalid.');
  return {
    schemaVersion: FOCUS_SESSION_SCHEMA_VERSION,
    sessionId,
    taskId,
    phase: 'active',
    plannedDurationSeconds: duration,
    startedAt: iso(now),
    elapsedSeconds: 0,
    pausedAt: null,
    endedAt: null,
    updatedAt: iso(now)
  };
};

const transition = (
  session: FocusSessionRecord,
  phase: FocusSessionPhase,
  now: Date,
  elapsedSeconds: number,
  overrides: Partial<FocusSessionRecord> = {}
): FocusSessionRecord => {
  requireSession(session); requireNow(now);
  const next: FocusSessionRecord = {
    ...session,
    ...overrides,
    phase,
    elapsedSeconds: Math.max(0, Math.floor(elapsedSeconds)),
    updatedAt: iso(now)
  };
  const normalized = normalizeFocusSession(next);
  if (!normalized) throw new Error('The focus session transition is invalid.');
  return normalized;
};

export const pauseFocusSession = (session: FocusSessionRecord, now: Date = new Date()): FocusSessionRecord => {
  if (session.phase !== 'active') return session;
  return transition(session, 'paused', now, focusSessionElapsedSeconds(session, now), { pausedAt: iso(now), endedAt: null });
};

export const resumeFocusSession = (session: FocusSessionRecord, now: Date = new Date()): FocusSessionRecord => {
  if (session.phase !== 'paused') return session;
  return transition(session, 'active', now, focusSessionElapsedSeconds(session, now), {
    startedAt: iso(now), pausedAt: null, endedAt: null
  });
};

export const stopFocusSession = (session: FocusSessionRecord, now: Date = new Date()): FocusSessionRecord => {
  if (session.phase === 'stopped' || session.phase === 'completed') return session;
  return transition(session, 'stopped', now, focusSessionElapsedSeconds(session, now), { pausedAt: null, endedAt: iso(now) });
};

export const completeFocusSession = (session: FocusSessionRecord, now: Date = new Date()): FocusSessionRecord => {
  if (session.phase === 'completed') return session;
  return transition(session, 'completed', now, focusSessionElapsedSeconds(session, now), { pausedAt: null, endedAt: iso(now) });
};

export const extendFocusSession = (session: FocusSessionRecord, deltaSeconds: number, now: Date = new Date()): FocusSessionRecord => {
  requireSession(session); requireNow(now);
  const delta = Number(deltaSeconds);
  if (!Number.isSafeInteger(delta) || delta <= 0) return session;
  const duration = asDuration(Math.min(MAX_DURATION_SECONDS, session.plannedDurationSeconds + delta));
  if (duration === null) return session;
  return { ...session, plannedDurationSeconds: duration, updatedAt: iso(now) };
};

/**
 * Preserve a local focus session when legacy daily-tracking writers omit it.
 * An explicit null is treated as omission for compatibility: terminal session
 * records are the only durable clear, so a stale client cannot erase focus.
 */
export const mergeTrackingFocusSession = (previous: unknown, next: unknown): unknown => {
  if (!isRecord(next)) return next;
  if (!isRecord(previous) || !Object.prototype.hasOwnProperty.call(previous, 'focusSession')) return next;
  if (next.focusSession !== undefined && next.focusSession !== null) return next;
  return { ...next, focusSession: previous.focusSession };
};
