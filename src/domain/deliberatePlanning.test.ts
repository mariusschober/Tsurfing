import { describe, expect, it } from 'vitest';
import { confirmPlanningOrder, initialPlanningPolicy, nextReplanCost, reconcilePlanningOrder, relativeOrderChanged,
  type ConfirmOrder, type DailyPlanningPolicy } from './deliberatePlanning';

const accountId = 'account-a', localDate = '2026-09-08';
const available = ['a', 'b', 'c'].map(id => ({ id, precedence: 2 }));
let sequence = 0;
const command = (policy: DailyPlanningPolicy, proposedOrder = ['a', 'b', 'c'], maximumAcceptedXp = 50): ConfirmOrder => ({
  schemaVersion: 1, operationId: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  accountId, localDate, baselineRevision: policy.revision, proposedOrder, ratings: [], maximumAcceptedXp,
  capturedAt: '2026-09-08T17:00:00.000Z',
});
const locked = () => confirmPlanningOrder(initialPlanningPolicy(accountId, localDate),
  command(initialPlanningPolicy(accountId, localDate)), available, 100, 'classic').policy;

describe('deliberate daily order confirmation', () => {
  it.each([['classic', 50], ['gentle', 25], ['off', 0]] as const)('charges only the fourth changed confirmation in %s', (setting, cost) => {
    let policy = locked(), xp = 200;
    for (let i = 1; i <= 5; i++) {
      const result = confirmPlanningOrder(policy, command(policy, i % 2 ? ['b', 'a', 'c'] : ['a', 'b', 'c']), available, xp, setting);
      expect(result.receipt.actualDebit).toBe(i <= 3 ? 0 : cost);
      expect(result.policy.acceptedReplans).toBe(i);
      policy = result.policy; xp = result.xp;
    }
  });
  it('migrates confirmed plans with all three free replans and no visit debt', () => {
    const policy = initialPlanningPolicy(accountId, localDate, { taskIds: ['a', 'b'], confirmedAt: 1000 });
    expect(policy.revision).not.toBeNull();
    expect(policy.acceptedReplans).toBe(0);
    expect(nextReplanCost(policy, 'classic')).toBe(0);
  });
  it('ignores additions, removals, and a draft restored to its starting order', () => {
    const policy = locked();
    for (const proposed of [['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'c', 'd']]) {
      const tasks = proposed.map(id => ({ id, precedence: 2 }));
      const result = confirmPlanningOrder(policy, command(policy, proposed), tasks, 100, 'classic');
      expect(result.policy.acceptedReplans).toBe(0);
      expect(result.xp).toBe(100);
    }
    expect(relativeOrderChanged(['a', 'b', 'c'], ['b', 'd', 'c'])).toBe(false);
    expect(relativeOrderChanged(['a', 'b', 'c'], ['c', 'd', 'b'])).toBe(true);
  });
  it('replays an accepted operation without debiting or incrementing twice, even after another confirmation', () => {
    const policy = { ...locked(), acceptedReplans: 3 };
    const request = command(policy, ['b', 'a', 'c']);
    const accepted = confirmPlanningOrder(policy, request, available, 100, 'classic');
    const later = confirmPlanningOrder(accepted.policy, command(accepted.policy), available, accepted.xp, 'classic');
    const replay = confirmPlanningOrder(later.policy, request, available, later.xp, 'classic');
    expect(replay.replay).toBe(true);
    expect(replay.receipt).toEqual(accepted.receipt);
    expect(replay.policy).toEqual(later.policy);
    expect(replay.xp).toBe(later.xp);
    expect(() => confirmPlanningOrder(later.policy, { ...request, maximumAcceptedXp: 0 }, available, 0, 'classic')).toThrow(/identity/);
  });
  it('retains stale proposed and synced orders without spending allowance or XP', () => {
    const policy = locked(), request = command(policy, ['c', 'b', 'a']);
    const other = confirmPlanningOrder(policy, command(policy, ['b', 'a', 'c']), available, 100, 'classic');
    const stale = confirmPlanningOrder(other.policy, request, available, other.xp, 'classic');
    expect(stale.receipt.code).toBe('STALE_REVISION');
    expect(stale.receipt.command.proposedOrder).toEqual(['c', 'b', 'a']);
    expect(stale.receipt.order).toEqual(['b', 'a', 'c']);
    expect(stale.policy.acceptedReplans).toBe(1);
    expect(stale.xp).toBe(100);
    expect(confirmPlanningOrder(stale.policy, request, available, 100, 'classic').replay).toBe(true);
  });
  it('requires renewed consent when the applicable cost exceeds the accepted maximum', () => {
    const policy = { ...locked(), acceptedReplans: 3 };
    const result = confirmPlanningOrder(policy, command(policy, ['b', 'a', 'c'], 25), available, 100, 'classic');
    expect(result.receipt.code).toBe('COST_CHANGED');
    expect(result.receipt.requiredCost).toBe(50);
    expect(result.xp).toBe(100);
    expect(result.policy.confirmedOrder).toEqual(policy.confirmedOrder);
  });
  it('preserves the XP floor and does not allow a low balance to bypass consent', () => {
    const policy = { ...locked(), acceptedReplans: 3 };
    expect(confirmPlanningOrder(policy, command(policy, ['b', 'a', 'c'], 0), available, 0, 'classic').receipt.code).toBe('COST_CHANGED');
    const result = confirmPlanningOrder(policy, command(policy, ['b', 'a', 'c']), available, 12, 'classic');
    expect(result.receipt.actualDebit).toBe(12);
    expect(result.xp).toBe(0);
  });
  it('does not resurrect completed tasks or apply their draft ratings', () => {
    const policy = locked(), request = command(policy, ['c', 'a', 'b']);
    request.ratings = [{ taskId: 'c', excitement: 100, roi: 100 }, { taskId: 'a', excitement: 70, roi: 50 }];
    const result = confirmPlanningOrder(policy, request, available.slice(0, 2), 100, 'classic');
    expect(result.receipt.order).toEqual(['a', 'b']);
    expect(result.policy.acceptedReplans).toBe(0);
    expect(result.ratings.map(r => r.taskId)).toEqual(['a']);
  });
  it('appends new tasks within precedence groups while preserving existing relative order', () => {
    expect(reconcilePlanningOrder(['b', 'a', 'frog'], [
      { id: 'new', precedence: 2 }, { id: 'a', precedence: 2 }, { id: 'frog', precedence: 1 },
      { id: 'b', precedence: 2 }, { id: 'before', precedence: 0 },
    ])).toEqual(['before', 'frog', 'b', 'a', 'new']);
  });
  it('keeps previous-day operations scoped and rejects a different account or day', () => {
    const policy = locked(), request = command(policy);
    expect(() => confirmPlanningOrder(initialPlanningPolicy(accountId, '2026-09-09'), request, available, 100, 'classic')).toThrow(/scope/);
    expect(() => confirmPlanningOrder({ ...policy, accountId: 'account-b' }, request, available, 100, 'classic')).toThrow(/scope/);
    expect(confirmPlanningOrder(policy, request, available, 100, 'classic').policy.localDate).toBe(localDate);
  });
  it('rejects malformed commands before retaining any effect', () => {
    const policy = locked();
    for (const patch of [{ proposedOrder: ['a', 'a'] }, { localDate: '2026-02-29' }, { maximumAcceptedXp: -1 }]) {
      expect(() => confirmPlanningOrder(policy, { ...command(policy), ...patch }, available, 100, 'classic')).toThrow();
    }
  });
});

it('matches the shared native planning contract fixtures including duplicate delivery', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/planning/deliberate-v1.json', import.meta.url), 'utf8'));
  for (const scenario of fixture.cases) {
    const result = confirmPlanningOrder(scenario.policy, scenario.command, scenario.available, scenario.xp, scenario.setting);
    const { command: _command, ...receipt } = result.receipt;
    expect({ ...receipt, xp: result.xp }, scenario.name).toEqual(scenario.expected);
    const replay = confirmPlanningOrder(result.policy, scenario.command, scenario.available, result.xp, scenario.setting);
    expect(replay.replay).toBe(true); expect(replay.xp).toBe(result.xp); expect(replay.receipt).toEqual(result.receipt);
  }
});
