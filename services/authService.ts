import { createClient, type AuthChangeEvent, type Session } from '@supabase/supabase-js';
import { readResponseBodyWithLimit } from './boundedResponse';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
const apiOrigin = (import.meta.env.VITE_API_ORIGIN || '').replace(/\/$/, '');
const configuredTelegramProvider = import.meta.env.VITE_TELEGRAM_OIDC_PROVIDER_ID || 'custom:telegram';
export const telegramProvider = (configuredTelegramProvider.startsWith('custom:')
  ? configuredTelegramProvider
  : `custom:${configuredTelegramProvider}`) as `custom:${string}`;
const localDemo = import.meta.env.DEV && import.meta.env.VITE_ENABLE_LOCAL_DEMO === 'true';
const testBuild = import.meta.env.VITE_TEST_MODE === 'true';
const testCode = import.meta.env.VITE_TEST_CODE || '';
const testAccessStorageKey = 'goalflow-test-access';
const emailOtpAttemptStorageKey = 'goalflow_email_otp_attempt';
let emailOtpActivationInFlight = false;

export type EmailOtpPurpose = 'sign_in' | 'activation';

interface PendingEmailOtpAttempt {
  attemptToken: string;
  email: string;
  purpose: EmailOtpPurpose;
  expiresAt: number;
  resendAt: number;
  verifiedUserId?: string;
  verifiedSessionId?: string;
}

export interface ServerAccount {
  id: string;
  email: string;
  role: 'owner' | 'beta';
  status: 'active';
  assuranceLevel: 'aal1' | 'aal2';
}

export class SessionValidationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'SessionValidationError';
  }
}

export class SessionAccountMismatchError extends Error {
  constructor() {
    super('The signed-in account changed while synchronization was running. Local changes were not sent.');
    this.name = 'SessionAccountMismatchError';
  }
}

export const assertSessionMatchesUser = (session: Session, expectedUserId: string): void => {
  if (session.user.id !== expectedUserId) throw new SessionAccountMismatchError();
};

export const isTestBuild = (): boolean => testBuild;
export const isLocalDemo = (): boolean => localDemo || testBuild;
export const shouldDisableServiceWorker = (): boolean => localDemo;

export const hasTestAccess = (): boolean => testBuild
  && typeof window !== 'undefined'
  && window.localStorage.getItem(testAccessStorageKey) === 'granted';

export const unlockTestBuild = (code: string): boolean => {
  if (!testBuild || !testCode || code !== testCode || typeof window === 'undefined') return false;
  window.localStorage.setItem(testAccessStorageKey, 'granted');
  return true;
};

export const clearTestAccess = (): void => {
  if (typeof window !== 'undefined') window.localStorage.removeItem(testAccessStorageKey);
};

export const apiUrl = (input: RequestInfo | URL): RequestInfo | URL => {
  if (!apiOrigin) return input;
  const raw = input instanceof URL ? input.href : String(input);
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return input;
  return `${apiOrigin}${raw.startsWith('/') ? raw : `/${raw}`}`;
};

const responseWithoutBody = (status: number): boolean => status === 204 || status === 205 || status === 304;
const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Keeps the deadline active until the complete API response is locally readable. */
export const fetchApiWithTimeout = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
  fetcher: typeof fetch = globalThis.fetch,
  maximumResponseBytes = MAX_API_RESPONSE_BYTES
): Promise<Response> => {
  const parentSignal = init.signal;
  if (parentSignal?.aborted) throw parentSignal.reason ?? new DOMException('Request stopped.', 'AbortError');
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = globalThis.setTimeout(
    () => controller.abort(new DOMException('Request timed out.', 'TimeoutError')),
    Math.max(250, Math.min(120_000, timeoutMs))
  );
  try {
    const response = await fetcher(apiUrl(input), { ...init, signal: controller.signal });
    const body = responseWithoutBody(response.status)
      ? null
      : await readResponseBodyWithLimit(response, maximumResponseBytes);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } finally {
    globalThis.clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
};

export const supabase = supabaseUrl && supabasePublicKey
  ? createClient(supabaseUrl, supabasePublicKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      global: { fetch: (input, init) => fetchApiWithTimeout(input, init) }
    })
  : undefined;

export const getSession = async (): Promise<Session | null> => {
  if (localDemo) return null;
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
};

export const onSessionChange = (callback: (session: Session | null, event: AuthChangeEvent) => void) => {
  if (!supabase) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      // Authentication artifacts are removed, but the per-account durable
      // outbox remains intact for a later sign-in and retry.
      try {
        sessionStorage.removeItem('goalflow_telegram_attempt');
        sessionStorage.removeItem('goalflow_telegram_state');
        sessionStorage.removeItem('goalflow_telegram_verifier');
        sessionStorage.removeItem('goalflow_owner_telegram_link');
        sessionStorage.removeItem(emailOtpAttemptStorageKey);
      } catch {}
    }
    if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
      // Proactive refresh succeeded, clear any quarantine
    }
    callback(session, event);
  });
  return () => data.subscription.unsubscribe();
};

export const refreshSession = async (): Promise<Session | null> => {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.refreshSession();
  if (error) throw error;
  return data.session;
};

export const requestEmailOtp = async (
  email: string,
  purpose: EmailOtpPurpose,
  inviteCode = '',
  captchaToken = ''
): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }> => {
  if (!supabase) throw new Error('Authentication is not configured.');
  const normalizedEmail = email.trim().toLowerCase();
  const preflight = await fetchApiWithTimeout('/api/v1/auth/email/preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: normalizedEmail, purpose, code: inviteCode.trim(), captchaToken })
  });
  const preflightBody = await preflight.json() as {
    accepted?: boolean;
    attemptToken?: string;
    expiresInSeconds?: number;
    resendAfterSeconds?: number;
    error?: { message?: string };
  };
  if (!preflight.ok
    || preflightBody.accepted !== true
    || !preflightBody.attemptToken?.match(/^[A-Za-z0-9_-]{43}$/)) {
    throw new Error(preflightBody.error?.message || 'Email code delivery could not be started.');
  }
  const expiresInSeconds = Math.max(1, Math.min(600, preflightBody.expiresInSeconds ?? 600));
  const resendAfterSeconds = Math.max(60, Math.min(600, preflightBody.resendAfterSeconds ?? 60));
  const pending: PendingEmailOtpAttempt = {
    attemptToken: preflightBody.attemptToken,
    email: normalizedEmail,
    purpose,
    expiresAt: Date.now() + expiresInSeconds * 1_000,
    resendAt: Date.now() + resendAfterSeconds * 1_000
  };
  sessionStorage.setItem(emailOtpAttemptStorageKey, JSON.stringify(pending));
  return { expiresInSeconds, resendAfterSeconds };
};

const pendingEmailOtpAttempt = (): PendingEmailOtpAttempt | null => {
  try {
    const encoded = sessionStorage.getItem(emailOtpAttemptStorageKey);
    if (!encoded) return null;
    const value = JSON.parse(encoded) as Partial<PendingEmailOtpAttempt>;
    const hasVerifiedIdentity = value.verifiedUserId != null || value.verifiedSessionId != null;
    if (!value.attemptToken?.match(/^[A-Za-z0-9_-]{43}$/)
      || typeof value.email !== 'string'
      || (value.purpose !== 'sign_in' && value.purpose !== 'activation')
      || typeof value.expiresAt !== 'number'
      || typeof value.resendAt !== 'number'
      || (hasVerifiedIdentity && (
        !value.verifiedUserId?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
        || !value.verifiedSessionId?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      ))) {
      sessionStorage.removeItem(emailOtpAttemptStorageKey);
      return null;
    }
    return value as PendingEmailOtpAttempt;
  } catch {
    sessionStorage.removeItem(emailOtpAttemptStorageKey);
    return null;
  }
};

export const pendingEmailOtpRequest = (): Pick<PendingEmailOtpAttempt, 'email' | 'purpose' | 'expiresAt' | 'resendAt'> | null => {
  const pending = pendingEmailOtpAttempt();
  if (!pending || pending.expiresAt <= Date.now()) return null;
  return {
    email: pending.email,
    purpose: pending.purpose,
    expiresAt: pending.expiresAt,
    resendAt: pending.resendAt
  };
};

const verifiedSessionIdentity = (session: Session): { userId: string; sessionId: string } | null => {
  try {
    const encodedPayload = session.access_token.split('.')[1];
    if (!encodedPayload) return null;
    const paddedPayload = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(encodedPayload.length / 4) * 4, '=');
    const payload = JSON.parse(atob(paddedPayload)) as { sub?: unknown; session_id?: unknown };
    const userId = typeof payload.sub === 'string' ? payload.sub.toLowerCase() : '';
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id.toLowerCase() : '';
    if (userId !== session.user.id.toLowerCase()
      || !sessionId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)) return null;
    return { userId, sessionId };
  } catch {
    return null;
  }
};

const attemptMatchesVerifiedSession = (pending: PendingEmailOtpAttempt, session: Session): boolean => {
  const identity = verifiedSessionIdentity(session);
  return identity != null
    && pending.verifiedUserId === identity.userId
    && pending.verifiedSessionId === identity.sessionId;
};

export const isEmailOtpActivationInFlight = (): boolean => emailOtpActivationInFlight;

const isRetryableActivationStatus = (status: number): boolean =>
  status >= 500 || status === 408 || status === 425 || status === 429;

const activatePendingEmailOtp = async (
  session: Session,
  pending: PendingEmailOtpAttempt
): Promise<Session> => {
  if (session.user.email?.trim().toLowerCase() !== pending.email
    || !attemptMatchesVerifiedSession(pending, session)) {
    sessionStorage.removeItem(emailOtpAttemptStorageKey);
    await supabase?.auth.signOut({ scope: 'local' }).catch(() => undefined);
    throw new SessionValidationError(
      'The verified account does not match this email-code request.',
      400,
      'activation_account_mismatch'
    );
  }

  emailOtpActivationInFlight = true;
  try {
    const activation = await fetchApiWithTimeout('/api/v1/auth/email/activate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ attemptToken: pending.attemptToken })
    });
    const result = await activation.json().catch(() => ({})) as {
      activated?: boolean;
      error?: { code?: string; message?: string };
    };
    if (!activation.ok || result.activated !== true) {
      if (isRetryableActivationStatus(activation.status)) {
        throw new SessionValidationError(
          'Account activation is temporarily unavailable. Tsurfing will retry without using another email code.',
          503,
          'activation_retryable'
        );
      }
      sessionStorage.removeItem(emailOtpAttemptStorageKey);
      await supabase?.auth.signOut({ scope: 'local' }).catch(() => undefined);
      throw new SessionValidationError(
        result.error?.message || 'This code request is invalid or expired.',
        activation.status,
        result.error?.code || 'activation_rejected'
      );
    }
    sessionStorage.removeItem(emailOtpAttemptStorageKey);
    window.dispatchEvent(new Event('goalflow:email-otp-activated'));
    return session;
  } finally {
    emailOtpActivationInFlight = false;
  }
};

/** Completes a lost-acknowledgement activation without reusing the one-use OTP. */
export const resumePendingEmailOtpActivation = async (session: Session): Promise<Session> => {
  const pending = pendingEmailOtpAttempt();
  if (!pending) return session;
  if (!attemptMatchesVerifiedSession(pending, session)) {
    throw new SessionValidationError(
      'Enter the current email code to finish this sign-in.',
      425,
      'email_code_required'
    );
  }
  // The server decides expiry. A previously committed activation remains an
  // idempotent success even after the local ten-minute display timer elapsed.
  return activatePendingEmailOtp(session, pending);
};

export const verifyEmailOtp = async (email: string, token: string): Promise<Session> => {
  if (!supabase) throw new Error('Authentication is not configured.');
  const normalizedEmail = email.trim().toLowerCase();
  const cleanToken = token.trim();
  const pending = pendingEmailOtpAttempt();
  if (!pending
    || pending.email !== normalizedEmail
    || pending.expiresAt <= Date.now()
    || !/^\d{6}$/.test(cleanToken)) {
    sessionStorage.removeItem(emailOtpAttemptStorageKey);
    throw new SessionValidationError('This code request is invalid or expired. Request a new code.', 400, 'activation_rejected');
  }

  const existing = await getSession();
  if (existing && attemptMatchesVerifiedSession(pending, existing)) {
    return activatePendingEmailOtp(existing, pending);
  }

  emailOtpActivationInFlight = true;
  let session: Session;
  try {
    const { data, error } = await supabase.auth.verifyOtp({
      email: normalizedEmail,
      token: cleanToken,
      type: 'email'
    });
    if (error || !data.session || data.session.user.email?.trim().toLowerCase() !== normalizedEmail) {
      throw new SessionValidationError('The code is invalid or expired.', 400, 'otp_rejected');
    }
    session = data.session;
    const identity = verifiedSessionIdentity(session);
    if (!identity) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      throw new SessionValidationError('The verified session was invalid.', 400, 'otp_session_invalid');
    }
    const verifiedPending: PendingEmailOtpAttempt = {
      ...pending,
      verifiedUserId: identity.userId,
      verifiedSessionId: identity.sessionId
    };
    sessionStorage.setItem(emailOtpAttemptStorageKey, JSON.stringify(verifiedPending));
    return activatePendingEmailOtp(session, verifiedPending);
  } finally {
    emailOtpActivationInFlight = false;
  }
};

export const requestPasswordReset = async (email: string): Promise<void> => {
  if (!supabase) throw new Error('Authentication is not configured.');
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo: `${window.location.origin}/?auth=recovery`
  });
  if (error) throw error;
};

export const updateRecoveredPassword = async (password: string): Promise<void> => {
  if (!supabase) throw new Error('Authentication is not configured.');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  const { error: revokeError } = await supabase.auth.signOut({ scope: 'global' });
  if (revokeError) {
    throw new Error('The password was updated, but other sessions could not be revoked. Sign out all devices before continuing.');
  }
};

export const validateServerSession = async (session: Session): Promise<ServerAccount> => {
  const response = await fetchApiWithTimeout('/api/v1/session', {
    headers: { authorization: `Bearer ${session.access_token}` }
  });
  const result = await response.json() as {
    user?: Omit<ServerAccount, 'assuranceLevel'>;
    assuranceLevel?: 'aal1' | 'aal2';
    error?: { code?: string; message?: string };
  };
  if (!response.ok || !result.user || !result.assuranceLevel) {
    throw new SessionValidationError(
      result.error?.message || 'Account access could not be verified.',
      response.status,
      result.error?.code || 'session_validation_failed'
    );
  }
  return { ...result.user, assuranceLevel: result.assuranceLevel };
};

const startTelegramOAuth = async (callback: 'telegram' | 'telegram-sign-in'): Promise<void> => {
  if (!supabase) throw new Error('Authentication is not configured.');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: telegramProvider,
    options: {
      redirectTo: `${window.location.origin}/?auth=${callback}`,
      scopes: 'openid profile telegram:bot_access'
    }
  });
  if (error) throw error;
};

export const beginTelegramSignIn = async (): Promise<void> => {
  await startTelegramOAuth('telegram-sign-in');
};

export const beginTelegramSignup = async (inviteCode: string, captchaToken = ''): Promise<void> => {
  if (!supabase) throw new Error('Authentication is not configured.');
  const response = await fetchApiWithTimeout('/api/v1/auth/telegram/preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: inviteCode, captchaToken })
  });
  const result = await response.json() as { attemptToken?: string; provider?: string; error?: { message?: string } };
  if (!response.ok
    || !result.attemptToken?.match(/^[A-Za-z0-9_-]{43}$/)
    || result.provider !== telegramProvider) {
    throw new Error(result.error?.message || 'Telegram signup could not be started.');
  }
  sessionStorage.setItem('goalflow_telegram_attempt', result.attemptToken);
  try {
    await startTelegramOAuth('telegram');
  } catch (error) {
    sessionStorage.removeItem('goalflow_telegram_attempt');
    throw error;
  }
};

export const beginTelegramLink = async (): Promise<void> => {
  if (!supabase) throw new Error('Authentication is not configured.');
  sessionStorage.setItem('goalflow_owner_telegram_link', 'pending');
  const { error } = await supabase.auth.linkIdentity({
    provider: telegramProvider,
    options: {
      redirectTo: `${window.location.origin}/?auth=telegram-link`,
      scopes: 'openid profile telegram:bot_access'
    }
  });
  if (error) {
    sessionStorage.removeItem('goalflow_owner_telegram_link');
    throw error;
  }
};

export interface TelegramBotStatus {
  enabled: boolean;
  linked: boolean;
  username: string | null;
}

export const getTelegramBotStatus = async (): Promise<TelegramBotStatus> => {
  const response = await authenticatedFetch('/api/v1/account/telegram');
  const result = await response.json() as TelegramBotStatus & { error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message || 'Telegram status could not be loaded.');
  return { enabled: result.enabled === true, linked: result.linked === true, username: result.username ?? null };
};

// false means a fresh provider authorization is in progress, not a completed link.
export const enableTelegramBotAccess = async (): Promise<boolean> => {
  const response = await authenticatedFetch('/api/v1/account/telegram/link', { method: 'POST' });
  const result = await response.json() as { linked?: boolean; error?: { code?: string; message?: string } };
  if (response.status === 409 && result.error?.code === 'telegram_identity_missing') {
    await beginTelegramLink();
    return false;
  }
  if (!response.ok || result.linked !== true) throw new Error(result.error?.message || 'Telegram could not be linked.');
  return true;
};

export const disableTelegramBotAccess = async (): Promise<void> => {
  const response = await authenticatedFetch('/api/v1/account/telegram/link', { method: 'DELETE' });
  const result = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message || 'Telegram access could not be revoked.');
};

export const activateOwnerTelegramLink = async (session: Session): Promise<void> => {
  if (sessionStorage.getItem('goalflow_owner_telegram_link') !== 'pending') return;
  const response = await fetchApiWithTimeout('/api/v1/account/telegram/link', {
    method: 'POST',
    headers: { authorization: `Bearer ${session.access_token}` }
  });
  const result = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message || 'Telegram could not be linked to the owner account.');
  sessionStorage.removeItem('goalflow_owner_telegram_link');
  const url = new URL(window.location.href);
  url.searchParams.delete('auth');
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}`);
};

export const activateTelegramSignup = async (session: Session): Promise<boolean> => {
  const attemptToken = sessionStorage.getItem('goalflow_telegram_attempt');
  if (!attemptToken) return !session.user.email;
  const response = await fetchApiWithTimeout('/api/v1/auth/telegram/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ attemptToken })
  });
  const result = await response.json() as { recoveryEmailRequired?: boolean; error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message || 'Telegram signup could not be activated.');
  sessionStorage.removeItem('goalflow_telegram_attempt');
  sessionStorage.removeItem('goalflow_telegram_state');
  sessionStorage.removeItem('goalflow_telegram_verifier');
  const url = new URL(window.location.href);
  url.searchParams.delete('auth');
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}`);
  return Boolean(result.recoveryEmailRequired);
};

export const getLocalDemoUser = (): string | null => {
  if (testBuild) return 'test@goalflow.local';
  return localDemo ? (import.meta.env.VITE_OWNER_EMAIL || 'owner@tsurfing.local') : null;
};

export const authenticatedFetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const session = await getSession();
  const token = session?.access_token || (localDemo ? 'local-demo' : undefined);
  if (!token) throw new Error('A signed-in session is required.');
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return fetchApiWithTimeout(input, { ...init, headers });
};

export const authenticatedFetchForUser = async (
  expectedUserId: string,
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> => {
  const session = await getSession();
  if (!session) throw new Error('A signed-in session is required.');
  assertSessionMatchesUser(session, expectedUserId);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${session.access_token}`);
  return fetchApiWithTimeout(input, { ...init, headers });
};

export const logout = async (): Promise<void> => {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw error;
};

export const logoutEverywhere = async (): Promise<void> => {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut({ scope: 'global' });
  if (error) throw error;
};
