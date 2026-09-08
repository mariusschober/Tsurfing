import { describe, expect, it } from 'vitest';
import {
  completeFocusSession,
  extendAndResumeFocusSession,
  extendFocusSession,
  focusSessionElapsedSeconds,
  focusSessionOvertimeSeconds,
  focusSessionRemainingSeconds,
  normalizeFocusSession,
  pauseFocusSession,
  resumeFocusSession,
  startFocusSession,
  stopFocusSession
} from './focusSession';

const at = (seconds: number): Date => new Date(seconds * 1_000);
const sessionId = '11111111-1111-4111-8111-111111111111';

describe('shared focus session domain', () => {
  it('derives active elapsed, remaining, and overtime from the clock', () => {
    const session = startFocusSession('task-1', 60, at(100), sessionId);
    expect(focusSessionElapsedSeconds(session, at(125))).toBe(25);
    expect(focusSessionRemainingSeconds(session, at(125))).toBe(35);
    expect(focusSessionOvertimeSeconds(session, at(175))).toBe(15);
  });

  it('freezes elapsed time at pause and resumes from the frozen anchor', () => {
    const active = startFocusSession('task-1', 600, at(100), sessionId);
    const paused = pauseFocusSession(active, at(145));
    expect(paused.elapsedSeconds).toBe(45);
    expect(focusSessionElapsedSeconds(paused, at(200))).toBe(45);

    const resumed = resumeFocusSession(paused, at(200));
    expect(resumed.elapsedSeconds).toBe(45);
    expect(focusSessionElapsedSeconds(resumed, at(210))).toBe(55);
  });

  it('keeps explicit terminal phases stable and never auto-completes at expiry', () => {
    const active = startFocusSession('task-1', 60, at(100), sessionId);
    expect(focusSessionElapsedSeconds(active, at(200))).toBe(100);
    expect(active.phase).toBe('active');
    const stopped = stopFocusSession(active, at(200));
    expect(stopped.phase).toBe('stopped');
    expect(stopped.elapsedSeconds).toBe(100);
    expect(stopFocusSession(stopped, at(300))).toEqual(stopped);
    const completed = completeFocusSession(stopped, at(250));
    expect(completed.phase).toBe('completed');
    expect(completed.elapsedSeconds).toBe(100);
  });

  it('extends a plan without writing ticker updates', () => {
    const active = startFocusSession('task-1', 60, at(100), sessionId);
    const extended = extendFocusSession(active, 120, at(125));
    expect(extended.plannedDurationSeconds).toBe(180);
    expect(extended.elapsedSeconds).toBe(0);
    expect(extended.updatedAt).toBe(at(125).toISOString());
  });

  it('coalesces paused extension and resume into one causally newer transition', () => {
    const active = startFocusSession('task-1', 600, at(100), sessionId);
    const paused = pauseFocusSession(active, at(145));
    const resumed = extendAndResumeFocusSession(paused, 120, at(145));

    expect(resumed.phase).toBe('active');
    expect(resumed.plannedDurationSeconds).toBe(720);
    expect(resumed.elapsedSeconds).toBe(45);
    expect(resumed.startedAt).toBe(at(145).toISOString());
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.endedAt).toBeNull();
    expect(resumed.updatedAt).toBe(at(145.001).toISOString());
    expect(Date.parse(resumed.updatedAt)).toBeGreaterThan(Date.parse(paused.updatedAt));
  });

  it('rejects malformed, contradictory, and too-short remote records', () => {
    expect(normalizeFocusSession({ schemaVersion: 1 })).toBeNull();
    expect(normalizeFocusSession({
      schemaVersion: 1, sessionId, taskId: 'task-1', phase: 'active',
      plannedDurationSeconds: 30, startedAt: at(100).toISOString(), elapsedSeconds: 0,
      pausedAt: null, endedAt: null, updatedAt: at(100).toISOString()
    })).toBeNull();
    expect(normalizeFocusSession({
      schemaVersion: 1, sessionId, taskId: 'task-1', phase: 'paused',
      plannedDurationSeconds: 60, startedAt: at(100).toISOString(), elapsedSeconds: 0,
      pausedAt: null, endedAt: null, updatedAt: at(100).toISOString()
    })).toBeNull();
  });
});
