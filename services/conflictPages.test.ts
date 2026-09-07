import { describe, expect, it } from 'vitest';
import { validateConflictPage } from './conflictPages';

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
describe('conflict page continuation validation', () => {
  it('requires an explicit empty terminal page', () => {
    expect(validateConflictPage({ conflicts: [{ id: b }], hasMore: true, nextAfter: b }, a).nextAfter).toBe(b);
    expect(validateConflictPage({ conflicts: [], hasMore: false, nextAfter: null }, b).nextAfter).toBeNull();
  });
  it.each([
    { conflicts: [] },
    { conflicts: [], hasMore: true, nextAfter: b },
    { conflicts: [{ id: b }], hasMore: false, nextAfter: null },
    { conflicts: [{ id: b }], hasMore: true, nextAfter: a },
    { conflicts: [{ id: a }], hasMore: true, nextAfter: a },
    { conflicts: [{ id: b }, { id: b }], hasMore: true, nextAfter: b },
    { conflicts: [{ id: 'invalid' }], hasMore: true, nextAfter: 'invalid' },
  ])('rejects omitted, skipping, backward and duplicated cursors: %j', page => {
    expect(() => validateConflictPage(page, a)).toThrow(/invalid/);
  });
});
