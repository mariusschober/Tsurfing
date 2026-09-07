import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { readConflictPage } from './conflictPages';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = id(9000);

describe('authenticated conflict keyset scans', () => {
  it('retains all 1003 conflicts despite a lower database cap and intervening resolution', async () => {
    const remaining = new Set(Array.from({ length: 1003 }, (_, n) => id(n + 1)));
    const visited: string[] = [];
    const database = createClient('https://synthetic.invalid', 'synthetic-key', {
      global: { fetch: async (input) => {
        const url = new URL(String(input));
        expect(url.searchParams.get('user_id')).toBe(`eq.${account}`);
        expect(url.searchParams.get('resolved_at')).toBe('is.null');
        expect(url.searchParams.get('order')).toBe('id.asc');
        expect(url.searchParams.get('limit')).toBe('20');
        const after = url.searchParams.get('id')?.slice(3) ?? '';
        const rows = [...remaining].sort().filter(value => value > after).slice(0, 7);
        return Response.json(rows.map(value => ({ id: value, local_payload: { retained: '🐸' } })));
      } }
    });
    let after: string | undefined;
    do {
      const page = await readConflictPage(database, account, { after });
      visited.push(...page.conflicts.map(row => row.id));
      // Removing already visited rows breaks offset paging, but not keyset paging.
      for (const row of page.conflicts) remaining.delete(row.id);
      after = page.nextAfter ?? undefined;
      if (!page.hasMore) break;
    } while (true);
    expect(visited).toEqual(Array.from({ length: 1003 }, (_, n) => id(n + 1)));
    expect(remaining.size).toBe(0);
  });

  it('rejects malformed cursors before querying and rejects backward pages', async () => {
    let calls = 0;
    const database = createClient('https://synthetic.invalid', 'synthetic-key', {
      global: { fetch: async () => { calls++; return Response.json([{ id: id(1) }]); } }
    });
    await expect(readConflictPage(database, account, { after: 'id.gt.0' })).rejects.toThrow();
    await expect(readConflictPage(database, account, { limit: 21 })).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(readConflictPage(database, account, { after: id(1) })).rejects.toThrow(/advance safely/);
  });
});
