import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthMiddleware } from './auth';
import { readConfig } from './config';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

const config = readConfig({
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://beta.goalflow.example',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value',
  SUPABASE_SECRET_KEY: 'sb_secret_test_value',
  OWNER_USER_ID: '00000000-0000-4000-8000-000000000001'
});

const token = (sessionId: string): string => [
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({ session_id: sessionId, aal: 'aal1' })).toString('base64url'),
  'synthetic-signature'
].join('.');

const serve = async (
  active: boolean,
  profile: { email: string; role: string; status: string } | null = {
    email: 'a@example.invalid', role: 'beta', status: 'active'
  },
  claimsPatch: Record<string, unknown> = {}
) => {
  const getClaims = vi.fn(async (jwt: string) => ({
    data: {
      claims: {
        ...JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')),
        sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        email: 'a@example.invalid',
        iss: 'https://example.supabase.co/auth/v1',
        aud: 'authenticated',
        ...claimsPatch
      }
    },
    error: null
  }));
  const maybeSingle = vi.fn().mockResolvedValue({
    data: profile,
    error: null
  });
  const admin = {
    rpc: vi.fn().mockResolvedValue({ data: active, error: null }),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle })
      })
    })
  } as unknown as SupabaseClient;
  const verifier = { auth: { getClaims } } as unknown as SupabaseClient;
  const app = express();
  app.use(createAuthMiddleware(config, admin, verifier));
  app.get('/private', (request, response) => response.json({ user: request.user }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, admin };
};

describe('authenticated API session boundary', () => {
  it.each([
    ['wrong project issuer', { iss: 'https://other.supabase.co/auth/v1' }],
    ['wrong audience', { aud: 'anon' }],
    ['mutable subject', { sub: 'owner@example.invalid' }]
  ])('rejects verified claims with a %s', async (_label, claimsPatch) => {
    const { origin, admin } = await serve(true, {
      email: 'a@example.invalid', role: 'beta', status: 'active'
    }, claimsPatch);
    const response = await fetch(`${origin}/private`, {
      headers: { authorization: `Bearer ${token('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')}` }
    });
    expect(response.status).toBe(401);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('rejects a cryptographically valid token after its Auth session is revoked', async () => {
    const { origin, admin } = await serve(false);
    const response = await fetch(`${origin}/private`, {
      headers: { authorization: `Bearer ${token('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')}` }
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'session_revoked' } });
    expect(admin.rpc).toHaveBeenCalledWith('goalflow_session_is_active', {
      target_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      target_session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    });
  });

  it('accepts only the profile belonging to the verified token user', async () => {
    const { origin } = await serve(true);
    const response = await fetch(`${origin}/private`, {
      headers: { authorization: `Bearer ${token('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')}` }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'beta', status: 'active' }
    });
  });

  it('rejects a verified Auth session until one-use beta activation creates its profile', async () => {
    const { origin } = await serve(true, null);
    const response = await fetch(`${origin}/private`, {
      headers: { authorization: `Bearer ${token('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')}` }
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'account_inactive' } });
  });

  it('rejects tokens without a valid session_id claim', async () => {
    const { origin, admin } = await serve(true);
    const response = await fetch(`${origin}/private`, {
      headers: { authorization: `Bearer ${token('not-a-uuid')}` }
    });
    expect(response.status).toBe(401);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});
