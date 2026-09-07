import { describe, expect, it } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { isSameAuthSession } from '../services/authService';
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const login = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const session = (sub = user, sessionId = login, expiry = 1): Session => ({
  user: { id: sub },
  access_token: `fixture.${Buffer.from(JSON.stringify({ sub, session_id: sessionId, exp: expiry })).toString('base64url')}.fixture`
} as Session);
describe('session continuity for preserving mounted drafts', () => {
  it('retains the same login across changed refresh tokens', () => expect(isSameAuthSession(session(), session(user, login, 2))).toBe(true));
  it('resets for a new login by the same account', () => expect(isSameAuthSession(session(), session(user, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'))).toBe(false));
  it('resets for another account', () => expect(isSameAuthSession(session(), session('dddddddd-dddd-4ddd-8ddd-dddddddddddd'))).toBe(false));
  it('resets without a previous session or with malformed identity', () => {
    expect(isSameAuthSession(null, session())).toBe(false);
    expect(isSameAuthSession(session(), session(user, 'invalid'))).toBe(false);
    expect(isSameAuthSession(session(), {...session(), access_token:'invalid'})).toBe(false);
    expect(isSameAuthSession(session(), {...session(), user:{id:'other'}} as Session)).toBe(false);
  });
});
