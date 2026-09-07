import { normalizeFocusSession, type FocusSessionRecord } from './focusSession';
import { stableJson } from '../../services/syncProtocol';

export type FocusCommandKind = 'start' | 'pause' | 'resume' | 'extend' | 'extendAndResume' | 'stop' | 'complete';
export interface FocusCommand {
  schemaVersion: 1;
  actionId: string;
  accountId: string;
  actorId: string;
  kind: FocusCommandKind;
  sessionId: string;
  taskId: string;
  /** Start action ID identifies the epoch; an imported baseline uses its session ID. */
  epoch: string;
  expectedRevision: string | null;
  expectedCurrentSessionId: string | null;
  capturedAt: string;
  durationSeconds: number | null;
  [key: string]: unknown;
}

interface SessionRevision {
  projection: FocusSessionRecord;
  initialProjection: FocusSessionRecord;
  epoch: string;
  revision: string;
  /** Actual admitted parents, separate from the parent originally requested. */
  parents: Record<string, { parent: string | null; kind: FocusCommandKind | 'baseline' }>;
}
export interface FocusJournal {
  schemaVersion: 1;
  accountId: string;
  currentSessionId: string | null;
  sessions: Record<string, SessionRevision>;
  operations: Record<string, { command: FocusCommand; outcome: FocusOutcome }>;
}
export interface FocusOutcome {
  accepted: boolean;
  code: 'APPLIED' | 'STALE_TARGET' | 'STALE_REVISION' | 'TERMINAL' | 'INVALID_PHASE' | 'INVALID_RANGE' | 'SESSION_EXISTS';
  revision: string | null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const kinds: FocusCommandKind[] = ['start', 'pause', 'resume', 'extend', 'extendAndResume', 'stop', 'complete'];
const canonicalTime = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function validateFocusCommand(command: FocusCommand): void {
  if (!command || command.schemaVersion !== 1 || !isId(command.actionId) || !isId(command.accountId)
    || !isId(command.sessionId) || !isId(command.epoch) || !kinds.includes(command.kind)
    || typeof command.actorId !== 'string' || !command.actorId.length || command.actorId.length > 240
    || typeof command.taskId !== 'string' || !command.taskId.trim() || command.taskId.length > 240
    || (command.expectedRevision !== null && !isId(command.expectedRevision))
    || (command.expectedCurrentSessionId !== null && !isId(command.expectedCurrentSessionId))
    || !canonicalTime(command.capturedAt)
    || (['start', 'extend', 'extendAndResume'].includes(command.kind)
      ? !Number.isSafeInteger(command.durationSeconds) || command.durationSeconds <= 0
      : command.durationSeconds !== null)
    || (command.kind === 'start' && command.epoch !== command.actionId)) {
    throw new Error('The focus command is invalid. It was not admitted.');
  }
}

/** Baseline admission belongs to the local/server coordinator. This helper
 * does not establish trust in supplied history or replace existing evidence. */
export function initialFocusJournal(accountId: string, baseline: unknown = null): FocusJournal {
  if (!isId(accountId)) throw new Error('A focus journal needs an immutable account identity.');
  const journal: FocusJournal = { schemaVersion: 1, accountId, currentSessionId: null, sessions: {}, operations: {} };
  if (baseline === null || baseline === undefined) return journal;
  const focus = normalizeFocusSession(baseline);
  if (!focus) throw new Error('The optional focus baseline is damaged. Its original value must remain inspectable.');
  journal.currentSessionId = focus.sessionId;
  journal.sessions[focus.sessionId] = { projection: structuredClone(focus), initialProjection: structuredClone(focus), epoch: focus.sessionId,
    revision: focus.sessionId, parents: { [focus.sessionId]: { parent: null, kind: 'baseline' } } };
  return journal;
}

/** Deterministic domain admission. Persistence, task eligibility, final-note
 * storage and enqueue must share one transaction around this transition. */
export function applyFocusCommand(input: FocusJournal, command: FocusCommand): { journal: FocusJournal; outcome: FocusOutcome; duplicate: boolean } {
  validateFocusCommand(command);
  if (input.schemaVersion !== 1 || input.accountId !== command.accountId) throw new Error('Focus account scope mismatch.');
  const prior = input.operations[command.actionId];
  if (prior) {
    if (stableJson(prior.command) !== stableJson(command)) throw new Error('Focus action identity has a different payload.');
    return { journal: input, outcome: prior.outcome, duplicate: true };
  }
  const journal = structuredClone(input);
  const session = journal.sessions[command.sessionId];
  const finish = (accepted: boolean, code: FocusOutcome['code'], revision: string | null = session?.revision ?? null) => {
    const outcome = { accepted, code, revision };
    journal.operations[command.actionId] = { command: structuredClone(command), outcome };
    return { journal, outcome, duplicate: false };
  };
  if (command.kind === 'start') {
    if (session) return finish(false, 'SESSION_EXISTS');
    if (journal.currentSessionId !== command.expectedCurrentSessionId) return finish(false, 'STALE_TARGET');
    const current = journal.currentSessionId ? journal.sessions[journal.currentSessionId] : null;
    if ((current?.revision ?? null) !== command.expectedRevision) return finish(false, 'STALE_REVISION');
    if (command.durationSeconds < 60 || command.durationSeconds > 86400) return finish(false, 'INVALID_RANGE');
    const projection: FocusSessionRecord = { schemaVersion: 1, sessionId: command.sessionId, taskId: command.taskId,
      phase: 'active', plannedDurationSeconds: command.durationSeconds, startedAt: command.capturedAt,
      updatedAt: command.capturedAt, elapsedSeconds: 0, pausedAt: null, endedAt: null };
    journal.sessions[command.sessionId] = {
      epoch: command.epoch, revision: command.actionId,
      parents: { [command.actionId]: { parent: null, kind: 'start' } },
      projection, initialProjection: structuredClone(projection)
    };
    journal.currentSessionId = command.sessionId;
    return finish(true, 'APPLIED', command.actionId);
  }
  if (!session || journal.currentSessionId !== command.sessionId
    || command.expectedCurrentSessionId !== command.sessionId || session.epoch !== command.epoch
    || session.projection.taskId !== command.taskId) return finish(false, 'STALE_TARGET');
  const focus = normalizeFocusSession(session.projection);
  if (!focus) throw new Error('The admitted focus projection is damaged. Nothing was replaced.');
  if (focus.phase === 'stopped' || focus.phase === 'completed') return finish(false, 'TERMINAL');
  if (session.revision !== command.expectedRevision) {
    // Only a plain extension commutes over already-admitted plain extensions.
    // Pause/resume/start/completion must never be inferred during rehydration.
    let parent: string | null = session.revision;
    const visited = new Set<string>();
    while (parent && parent !== command.expectedRevision && !visited.has(parent)) {
      visited.add(parent);
      const step = session.parents[parent];
      if (!step || step.kind !== 'extend') break;
      parent = step.parent;
    }
    if (command.kind !== 'extend' || !command.expectedRevision || parent !== command.expectedRevision) return finish(false, 'STALE_REVISION');
  }
  if ((command.kind === 'pause' && focus.phase !== 'active')
    || (['resume', 'extendAndResume'].includes(command.kind) && focus.phase !== 'paused')) return finish(false, 'INVALID_PHASE');
  const next = { ...focus };
  if (command.kind === 'extend' || command.kind === 'extendAndResume') {
    const duration = focus.plannedDurationSeconds + command.durationSeconds;
    if (!Number.isSafeInteger(duration) || duration > 86400) return finish(false, 'INVALID_RANGE');
    next.plannedDurationSeconds = duration;
  }
  const now = Date.parse(command.capturedAt);
  const elapsed = focus.elapsedSeconds + (focus.phase === 'active' ? Math.max(0, Math.floor((now - Date.parse(focus.startedAt)) / 1000)) : 0);
  if (!Number.isSafeInteger(elapsed)) return finish(false, 'INVALID_RANGE');
  if (['pause', 'stop', 'complete'].includes(command.kind)) {
    next.elapsedSeconds = elapsed;
    // A clock setback closes the old measurement interval at zero additional
    // seconds. The real captured instant becomes the new anchor, never a
    // synthesized logical timestamp. The original anchor remains in history.
    next.startedAt = command.capturedAt;
    next.phase = command.kind === 'pause' ? 'paused' : command.kind === 'stop' ? 'stopped' : 'completed';
    next.pausedAt = command.kind === 'pause' ? command.capturedAt : null;
    next.endedAt = command.kind === 'pause' ? null : command.capturedAt;
  } else if (command.kind === 'resume' || command.kind === 'extendAndResume') {
    next.startedAt = command.capturedAt;
    next.phase = 'active';
    next.pausedAt = null;
    next.endedAt = null;
  }
  // Compatibility metadata only; action revisions carry causal order.
  next.updatedAt = new Date(Math.max(now, Date.parse(focus.updatedAt))).toISOString();
  if (!normalizeFocusSession(next)) throw new Error('The focus transition is invalid. Nothing was admitted.');
  session.parents[command.actionId] = { parent: session.revision, kind: command.kind };
  session.projection = next;
  session.revision = command.actionId;
  return finish(true, 'APPLIED', command.actionId);
}
