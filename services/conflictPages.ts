import type { RemoteServerConflict } from './syncProtocol';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validateConflictPage(value: unknown, after: string | null): {
  conflicts: RemoteServerConflict[]; nextAfter: string | null;
} {
  const fail = () => { throw new Error('Sync conflict page was invalid. Saved recovery evidence was retained.'); };
  if (!value || typeof value !== 'object') return fail();
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.conflicts) || page.conflicts.length > 20 || typeof page.hasMore !== 'boolean') return fail();
  let previous = after ?? '';
  for (const row of page.conflicts) {
    if (!row || typeof row.id !== 'string' || !uuid.test(row.id) || row.id <= previous) return fail();
    previous = row.id;
  }
  if (page.conflicts.length === 0) {
    if (page.hasMore !== false || page.nextAfter !== null) return fail();
  } else if (page.hasMore !== true || page.nextAfter !== previous) return fail();
  return { conflicts: page.conflicts, nextAfter: page.nextAfter as string | null };
}
