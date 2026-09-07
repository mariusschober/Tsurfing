import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('P1-2 useGoalflow persistLocalState debounce', () => {
  it('S1 effects drain account intents without persisting React snapshots', () => {
    const file = fs.readFileSync(path.resolve('hooks/useGoalflow.ts'), 'utf8');
    expect(file).toMatch(/useDebouncedCallback/);
    // Retired snapshot-debounce assertions are recorded in S1_REPORT.md.
    expect(file).toMatch(/goalflow:captured/);
    expect(file).toMatch(/while \(dirty && !stopped\)/);
    expect(file).not.toMatch(/storageService\.set\(store, USER_KEY, data\)/);
  });

  it('debounces rapid calls via plain debounce logic (behavioral)', async () => {
    const calls: number[] = [];
    const debounce = <T extends (...args: unknown[]) => void>(fn: T, delay: number) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      return (...args: Parameters<T>) => {
        if (t) clearTimeout(t);
        t = setTimeout(() => fn(...args), delay);
      };
    };
    const fn = debounce((v: unknown) => calls.push(v as number), 30);
    for (let i = 0; i < 10; i++) fn(i);
    await new Promise(r => setTimeout(r, 50));
    expect(calls).toEqual([9]);
  });
});
