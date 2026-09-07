import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyFocusCommand, initialFocusJournal, type FocusCommand } from './causalFocus';
import { normalizeFocusSession, startFocusSession, focusSessionElapsedSeconds } from './focusSession';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/s2/focus-v1.json', import.meta.url), 'utf8'));

describe('shared S2 causal focus transitions', () => {
  for (const scenario of fixture.cases) it(scenario.name, () => {
    let journal = initialFocusJournal(fixture.accountId);
    scenario.commands.forEach((command: FocusCommand, index: number) => {
      const snapshot = JSON.stringify(journal);
      const reply = applyFocusCommand(journal, command);
      expect(JSON.stringify(journal)).toBe(snapshot);
      expect(reply.outcome.code).toBe(scenario.outcomeCodes[index]);
      journal = reply.journal;
      expect(normalizeFocusSession(journal.sessions[journal.currentSessionId!].projection)).not.toBeNull();
    });
    expect(journal.sessions[journal.currentSessionId!].projection).toMatchObject(scenario.expected);
    expect(Object.keys(journal.operations)).toHaveLength(new Set(scenario.commands.map((c: FocusCommand) => c.actionId)).size);
    if (scenario.name === 'completed-F-never-revives-after-G') {
      expect(journal.sessions['ffffffff-ffff-4fff-8fff-ffffffffffff'].projection.phase).toBe('completed');
    }
  });

  it('retains unknown baseline fields and the original measurement anchor', () => {
    const baseline = { ...startFocusSession('task-F', 600, new Date('2026-09-07T12:00:00Z'), 'ffffffff-ffff-4fff-8fff-ffffffffffff'), future: { retained: true } };
    const initial = initialFocusJournal(fixture.accountId, baseline);
    const pause = { ...fixture.cases[2].commands[1], epoch: baseline.sessionId, expectedRevision: baseline.sessionId };
    const { journal } = applyFocusCommand(initial, pause);
    expect(journal.sessions[baseline.sessionId].projection.future).toEqual({ retained: true });
    expect(journal.sessions[baseline.sessionId].initialProjection).toEqual(baseline);
  });

  it('treats ticks as reads and continues overtime without creating operations', () => {
    const { journal } = applyFocusCommand(initialFocusJournal(fixture.accountId), fixture.cases[0].commands[0]);
    const before = JSON.stringify(journal);
    expect(focusSessionElapsedSeconds(journal.sessions[journal.currentSessionId!].projection, new Date('2026-09-07T13:00:00Z'))).toBe(3600);
    expect(JSON.stringify(journal)).toBe(before);
  });

  it('rejects changed payloads under one action identity and cross-account requests', () => {
    const command = fixture.cases[0].commands[0];
    const { journal } = applyFocusCommand(initialFocusJournal(fixture.accountId), command);
    expect(() => applyFocusCommand(journal, { ...command, durationSeconds: 700 })).toThrow(/different payload/);
    expect(() => applyFocusCommand(journal, { ...command, accountId: '22222222-2222-4222-8222-222222222222' })).toThrow(/scope mismatch/);
  });

  it('does not turn a malformed optional baseline into a new active session', () => {
    expect(() => initialFocusJournal(fixture.accountId, { phase: 'active' })).toThrow(/damaged/);
    const baseline = startFocusSession('task-F', 600, new Date('2026-09-07T12:00:00Z'));
    expect(() => initialFocusJournal(fixture.accountId, { ...baseline, phase: 'completed', endedAt: baseline.startedAt, pausedAt: baseline.startedAt })).toThrow(/damaged/);
    expect(() => initialFocusJournal(fixture.accountId, { ...baseline, elapsedSeconds: 9007199254740992 })).toThrow(/damaged/);
  });
});
