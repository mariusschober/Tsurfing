import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyOtp: vi.fn(),
  signOut: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth }))
}));

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLD_SESSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTP_SESSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ATTEMPT_TOKEN = 'A'.repeat(43);

const jwt = (sessionId: string): string => [
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({ sub: USER_ID, session_id: sessionId })).toString('base64url'),
  'synthetic-signature'
].join('.');

const session = (sessionId: string) => ({
  access_token: jwt(sessionId),
  refresh_token: 'refresh-token',
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: USER_ID, email: 'person@example.invalid' }
});

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; }
  };
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test_value');
  vi.stubEnv('VITE_API_ORIGIN', 'https://app.tsurfing.test');
  vi.stubEnv('VITE_ENABLE_LOCAL_DEMO', 'false');
  auth.getSession.mockReset();
  auth.verifyOtp.mockReset();
  auth.signOut.mockReset().mockResolvedValue({ error: null });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage() });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: vi.fn(), location: { origin: 'https://app.tsurfing.test' } }
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'sessionStorage');
  Reflect.deleteProperty(globalThis, 'window');
});

describe('web typed email OTP binding', () => {
  it('restores the exact server-issued resend deadline after a restart', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      accepted: true,
      attemptToken: ATTEMPT_TOKEN,
      expiresInSeconds: 600,
      resendAfterSeconds: 60
    }, { status: 202 })));
    const { pendingEmailOtpRequest, requestEmailOtp } = await import('./authService');

    await requestEmailOtp('person@example.invalid', 'sign_in', '', 'captcha-token');

    expect(pendingEmailOtpRequest()).toEqual({
      email: 'person@example.invalid',
      purpose: 'sign_in',
      expiresAt: 1_600_000,
      resendAt: 1_060_000
    });
    now.mockRestore();
  });

  it('does not let a pre-existing session bypass code verification', async () => {
    const oldSession = session(OLD_SESSION_ID);
    const otpSession = session(OTP_SESSION_ID);
    auth.getSession.mockResolvedValue({ data: { session: oldSession }, error: null });
    auth.verifyOtp.mockResolvedValue({ data: { session: otpSession }, error: null });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/auth/email/preflight')) {
        return Response.json({
          accepted: true,
          attemptToken: ATTEMPT_TOKEN,
          expiresInSeconds: 600,
          resendAfterSeconds: 60
        }, { status: 202 });
      }
      if (url.endsWith('/api/v1/auth/email/activate')) {
        return Response.json({ activated: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const { requestEmailOtp, verifyEmailOtp } = await import('./authService');

    await requestEmailOtp('person@example.invalid', 'activation', 'invite-code', 'captcha-token');
    const result = await verifyEmailOtp('person@example.invalid', '123456');

    expect(result).toBe(otpSession);
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: 'person@example.invalid', token: '123456', type: 'email'
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries a lost activation acknowledgement without reusing the OTP', async () => {
    const otpSession = session(OTP_SESSION_ID);
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    auth.verifyOtp.mockResolvedValue({ data: { session: otpSession }, error: null });
    let activationCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/auth/email/preflight')) {
        return Response.json({
          accepted: true,
          attemptToken: ATTEMPT_TOKEN,
          expiresInSeconds: 600,
          resendAfterSeconds: 60
        }, { status: 202 });
      }
      if (url.endsWith('/api/v1/auth/email/activate')) {
        activationCount += 1;
        return activationCount === 1
          ? Response.json({ error: { code: 'unavailable' } }, { status: 503 })
          : Response.json({ activated: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { requestEmailOtp, resumePendingEmailOtpActivation, verifyEmailOtp } = await import('./authService');

    await requestEmailOtp('person@example.invalid', 'sign_in', '', 'captcha-token');
    await expect(verifyEmailOtp('person@example.invalid', '123456')).rejects.toMatchObject({
      code: 'activation_retryable'
    });
    await expect(resumePendingEmailOtpActivation(otpSession as never)).resolves.toBe(otpSession);

    expect(auth.verifyOtp).toHaveBeenCalledTimes(1);
    expect(activationCount).toBe(2);
  });
});
