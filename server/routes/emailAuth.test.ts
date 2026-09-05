import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../config';
import { createEmailAuthRouter } from './emailAuth';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AUTHENTICATED_AT = 1_788_480_000;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const bearer = (method = 'otp'): string => [
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({
    session_id: SESSION_ID,
    amr: [{ method, timestamp: AUTHENTICATED_AT }]
  })).toString('base64url'),
  'verified-by-supabase-get-user'
].join('.');
const config = readConfig({ TURNSTILE_ENABLED: 'false' });

interface ServeOptions {
  confirmed?: boolean;
  creation?: Record<string, unknown>;
  deliveryError?: Error | null;
  markResult?: boolean;
  activationResult?: boolean;
  userMetadata?: Record<string, unknown>;
}

const serve = async (options: ServeOptions = {}) => {
  const signInWithOtp = vi.fn().mockResolvedValue({
    data: { user: null, session: null },
    error: options.deliveryError ?? null
  });
  const rpc = vi.fn().mockImplementation(async (name: string) => {
    if (name === 'goalflow_create_email_otp_attempt') {
      return {
        data: options.creation ?? { created: true, attemptId: ATTEMPT_ID, shouldCreateUser: true },
        error: null
      };
    }
    if (name === 'goalflow_mark_email_otp_delivery') {
      return { data: options.markResult ?? true, error: null };
    }
    if (name === 'activate_goalflow_email_otp') {
      return { data: options.activationResult ?? true, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const admin = { rpc } as unknown as SupabaseClient;
  const verifier = {
    auth: {
      signInWithOtp,
      getUser: vi.fn().mockResolvedValue({
        data: { user: {
          id: USER_ID,
          email: 'Beta@Example.invalid',
          email_confirmed_at: options.confirmed === false ? null : new Date().toISOString(),
          user_metadata: options.userMetadata ?? {}
        } },
        error: null
      })
    }
  } as unknown as SupabaseClient;
  const app = express();
  app.use(express.json());
  app.use('/auth', createEmailAuthRouter(config, admin, verifier));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    rpc,
    signInWithOtp
  };
};

describe('typed email OTP preflight', () => {
  it('advertises the disabled CAPTCHA policy without exposing credentials', async () => {
    const { origin } = await serve();
    const response = await fetch(`${origin}/auth/email/config`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ captchaRequired: false });
  });

  it('serves the public native challenge with a nonce-bound policy and no secret', async () => {
    const nativeConfig = readConfig({
      TURNSTILE_ENABLED: 'true',
      TURNSTILE_SECRET_KEY: 'server-secret-must-not-render',
      VITE_TURNSTILE_SITE_KEY: 'public-site-key'
    });
    const app = express();
    app.use('/auth', createEmailAuthRouter(nativeConfig));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const policy = await fetch(`${origin}/auth/email/config`);
    expect(await policy.json()).toEqual({ captchaRequired: true });
    const response = await fetch(`${origin}/auth/email/captcha`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[^']+'/);
    expect(page).toContain('public-site-key');
    expect(page).toContain('tsurfingCaptcha');
    expect(page).toContain('TsurfingNativeCaptcha');
    expect(page).not.toContain('server-secret-must-not-render');
  });

  it('binds an invite request to normalized email, CAPTCHA proof, and only token hashes', async () => {
    const { origin, rpc, signInWithOtp } = await serve();
    const response = await fetch(`${origin}/auth/email/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: ' Beta@Example.invalid ',
        purpose: 'activation',
        code: 'invite-secret',
        captchaToken: 'captcha-proof'
      })
    });

    expect(response.status).toBe(202);
    const body = await response.json() as { attemptToken: string; expiresInSeconds: number; resendAfterSeconds: number };
    expect(body.attemptToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresInSeconds).toBe(600);
    expect(body.resendAfterSeconds).toBe(60);
    expect(rpc).toHaveBeenNthCalledWith(1, 'goalflow_create_email_otp_attempt', expect.objectContaining({
      target_email: 'beta@example.invalid',
      target_purpose: 'activation',
      target_invite_code_hash: digest('invite-secret'),
      target_captcha_token_hash: digest('captcha-proof'),
      target_token_hash: digest(body.attemptToken)
    }));
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('invite-secret');
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(body.attemptToken);
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'beta@example.invalid',
      options: { shouldCreateUser: true, captchaToken: 'captcha-proof' }
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'goalflow_mark_email_otp_delivery', {
      target_attempt_id: ATTEMPT_ID,
      target_captcha_token_hash: digest('captcha-proof'),
      target_delivered: true
    });
  });

  it('never creates an Auth user for an existing-account sign-in request', async () => {
    const { origin, signInWithOtp } = await serve({
      creation: { created: true, attemptId: ATTEMPT_ID, shouldCreateUser: false }
    });
    const response = await fetch(`${origin}/auth/email/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.invalid', purpose: 'sign_in', captchaToken: 'captcha-proof' })
    });

    expect(response.status).toBe(202);
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'owner@example.invalid',
      options: { shouldCreateUser: false, captchaToken: 'captcha-proof' }
    });
  });

  it('returns the same generic envelope when cooldown or approval suppresses delivery', async () => {
    const { origin, signInWithOtp } = await serve({ creation: { created: false, reason: 'limited' } });
    const response = await fetch(`${origin}/auth/email/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.invalid', purpose: 'sign_in', captchaToken: 'captcha-proof' })
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, expiresInSeconds: 600, resendAfterSeconds: 60 });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it('does not disclose a Supabase delivery rejection', async () => {
    const { origin, rpc } = await serve({ deliveryError: new Error('account does not exist') });
    const response = await fetch(`${origin}/auth/email/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'unknown@example.invalid', purpose: 'sign_in', captchaToken: 'captcha-proof' })
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(rpc).toHaveBeenNthCalledWith(2, 'goalflow_mark_email_otp_delivery', expect.objectContaining({
      target_delivered: false
    }));
  });
});

describe('typed email OTP activation', () => {
  it('derives identity from the verified bearer token and ignores mutable metadata', async () => {
    const metadataToken = 'Z'.repeat(43);
    const attemptToken = 'A'.repeat(43);
    const { origin, rpc } = await serve({
      userMetadata: { goalflow_beta_activation_id: metadataToken, approval: 'owner' }
    });
    const response = await fetch(`${origin}/auth/email/activate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attemptToken })
    });

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('activate_goalflow_email_otp', {
      target_token_hash: digest(attemptToken),
      target_user_id: USER_ID,
      target_email: 'beta@example.invalid',
      target_session_id: SESSION_ID,
      target_authenticated_at: new Date(AUTHENTICATED_AT * 1_000).toISOString()
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(metadataToken);
  });

  it('refuses activation before Supabase confirms the email address', async () => {
    const { origin, rpc } = await serve({ confirmed: false });
    const response = await fetch(`${origin}/auth/email/activate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attemptToken: 'A'.repeat(43) })
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'email_not_verified' } });
    expect(rpc.mock.calls.some(([name]) => name === 'activate_goalflow_email_otp')).toBe(false);
  });

  it('refuses a valid non-OTP session so an existing login cannot skip the typed code', async () => {
    const { origin, rpc } = await serve();
    const response = await fetch(`${origin}/auth/email/activate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer('oauth')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attemptToken: 'A'.repeat(43) })
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'email_code_session_required' } });
    expect(rpc.mock.calls.some(([name]) => name === 'activate_goalflow_email_otp')).toBe(false);
  });

  it('rejects malformed or replay-incompatible request authority before database access', async () => {
    const { origin, rpc } = await serve();
    const response = await fetch(`${origin}/auth/email/activate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attemptToken: 'short', userId: USER_ID })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'activation_rejected' } });
    expect(rpc.mock.calls.some(([name]) => name === 'activate_goalflow_email_otp')).toBe(false);
  });
});
