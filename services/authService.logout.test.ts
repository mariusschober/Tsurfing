import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth }))
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://goalflow-staging.invalid');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'synthetic-publishable-key');
  vi.stubEnv('VITE_ENABLE_LOCAL_DEMO', 'false');
  auth.getSession.mockReset();
  auth.signOut.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('verified web session termination', () => {
  it('does not silently interpret a failed session read as signed out', async () => {
    const sessionError = new Error('session storage could not be read');
    auth.getSession.mockResolvedValue({ data: { session: null }, error: sessionError });
    const { getSession } = await import('./authService');

    await expect(getSession()).rejects.toBe(sessionError);
  });

  it('requires a successful local sign-out acknowledgment', async () => {
    const signOutError = new Error('local sign-out was not acknowledged');
    auth.signOut.mockResolvedValue({ error: signOutError });
    const { logout } = await import('./authService');

    await expect(logout()).rejects.toBe(signOutError);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('requires a successful global revocation acknowledgment', async () => {
    const revokeError = new Error('global revocation was not acknowledged');
    auth.signOut.mockResolvedValue({ error: revokeError });
    const { logoutEverywhere } = await import('./authService');

    await expect(logoutEverywhere()).rejects.toBe(revokeError);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
  });

  it('completes only after the requested sign-out scope succeeds', async () => {
    auth.signOut.mockResolvedValue({ error: null });
    const { logout, logoutEverywhere } = await import('./authService');

    await expect(logout()).resolves.toBeUndefined();
    await expect(logoutEverywhere()).resolves.toBeUndefined();
    expect(auth.signOut.mock.calls).toEqual([
      [{ scope: 'local' }],
      [{ scope: 'global' }]
    ]);
  });
});
