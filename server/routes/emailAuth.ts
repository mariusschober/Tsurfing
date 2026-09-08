import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { bearerToken, tokenClaims } from '../auth';
import { supabaseServerKey, type AppConfig } from '../config';
import { createUserVerifierClient } from '../supabase';

const hash = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');
const normalizeEmail = (value: string): string => value.trim().toLowerCase();
const fallbackRateLimitKey = crypto.randomBytes(32);
const opaqueToken = (): string => crypto.randomBytes(32).toString('base64url');

const preflightBody = z.object({
  email: z.string().trim().email().max(320),
  purpose: z.enum(['sign_in', 'activation']),
  code: z.string().trim().max(128).default(''),
  captchaToken: z.string().max(4096).default('')
}).strict().superRefine((value, context) => {
  if (value.purpose === 'activation' && value.code.length < 6) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['code'], message: 'Invite required' });
  }
});
const activationBody = z.object({
  attemptToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict();

const requestIpHash = (config: AppConfig, remoteIp: string | undefined): string =>
  crypto.createHmac('sha256', supabaseServerKey(config) ?? fallbackRateLimitKey)
    .update('tsurfing-email-otp-ip\0')
    .update(remoteIp || 'unknown')
    .digest('hex');

const genericPreflightResponse = (attemptToken: string) => ({
  accepted: true,
  attemptToken,
  expiresInSeconds: 600,
  resendAfterSeconds: 60
});

const nativeCaptchaPage = (siteKey: string, nonce: string): string => {
  const encodedSiteKey = JSON.stringify(siteKey).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tsurfing verification</title></head><body>
<main><div id="challenge" aria-label="Human verification"></div><p id="status">Loading secure verification…</p></main>
<script nonce="${nonce}">
(() => {
  const send = (token) => {
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return;
    if (window.TsurfingNativeCaptcha && typeof window.TsurfingNativeCaptcha.complete === 'function') {
      window.TsurfingNativeCaptcha.complete(token);
    }
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tsurfingCaptcha) {
      window.webkit.messageHandlers.tsurfingCaptcha.postMessage(token);
    }
    document.getElementById('status').textContent = 'Verification complete. Return to Tsurfing.';
  };
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.defer = true;
  script.onload = () => window.turnstile.render('#challenge', {
    sitekey: ${encodedSiteKey}, action: 'email-otp', theme: 'light', callback: send,
    'expired-callback': () => document.getElementById('status').textContent = 'Verification expired. Reload and try again.',
    'error-callback': () => document.getElementById('status').textContent = 'Verification could not load. Check the connection.'
  });
  script.onerror = () => document.getElementById('status').textContent = 'Verification could not load. Check the connection.';
  document.head.appendChild(script);
})();
</script></body></html>`;
};

export const createEmailAuthRouter = (
  config: AppConfig,
  admin?: SupabaseClient,
  verifier: SupabaseClient | undefined = createUserVerifierClient(config)
) => {
  const router = Router();
  router.use(rateLimit({
    windowMs: 60_000,
    limit: 8,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_request, response) => response.status(429).json({
      error: { code: 'rate_limited', message: 'Please wait before requesting another code.' }
    })
  }));

  router.get('/email/config', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ captchaRequired: config.TURNSTILE_ENABLED === 'true' });
  });

  router.get('/email/captcha', (_request, response) => {
    if (config.TURNSTILE_ENABLED !== 'true' || !config.VITE_TURNSTILE_SITE_KEY) {
      response.status(404).json({ error: { code: 'captcha_not_configured' } });
      return;
    }
    const nonce = crypto.randomBytes(18).toString('base64');
    response.set({
      'Cache-Control': 'no-store, max-age=0',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    });
    response.status(200).type('html').send(nativeCaptchaPage(config.VITE_TURNSTILE_SITE_KEY, nonce));
  });

  router.post('/email/preflight', async (request, response) => {
    if (!admin || !verifier) {
      response.status(503).json({ error: { code: 'auth_not_configured', message: 'Email sign-in is not configured.' } });
      return;
    }
    try {
      const input = preflightBody.parse(request.body);
      if (config.TURNSTILE_ENABLED === 'true' && !input.captchaToken) {
        response.status(400).json({ error: { code: 'captcha_required', message: 'Complete human verification before requesting a code.' } });
        return;
      }
      const normalizedEmail = normalizeEmail(input.email);
      const attemptToken = opaqueToken();
      const captchaTokenHash = hash(input.captchaToken);
      const { data: creation, error: creationError } = await admin.rpc('goalflow_create_email_otp_attempt', {
        target_token_hash: hash(attemptToken),
        target_email: normalizedEmail,
        target_purpose: input.purpose,
        target_invite_code_hash: hash(input.code),
        target_captcha_token_hash: captchaTokenHash,
        target_request_ip_hash: requestIpHash(config, request.ip)
      });
      if (creationError) {
        response.status(503).json({ error: { code: 'auth_unavailable', message: 'Email sign-in is temporarily unavailable.' } });
        return;
      }
      const created = Boolean(creation && typeof creation === 'object' && 'created' in creation && creation.created === true);
      const attemptId = created && 'attemptId' in creation && typeof creation.attemptId === 'string'
        ? creation.attemptId
        : undefined;
      const shouldCreateUser = created && 'shouldCreateUser' in creation && creation.shouldCreateUser === true;
      if (!attemptId) {
        // Cooldowns, exhausted invites, and unknown accounts deliberately have
        // the same response shape as an accepted delivery request.
        response.status(202).json(genericPreflightResponse(attemptToken));
        return;
      }

      // Supabase performs the single authoritative Turnstile validation. A
      // Turnstile token is one-use, so validating it a second time here would
      // reject an otherwise valid request as a replay. The database records a
      // CAPTCHA-backed delivery only after this call succeeds.
      const { error: deliveryError } = await verifier.auth.signInWithOtp({
        email: normalizedEmail,
        options: {
          shouldCreateUser,
          captchaToken: input.captchaToken || undefined
        }
      });
      const { data: marked, error: markError } = await admin.rpc('goalflow_mark_email_otp_delivery', {
        target_attempt_id: attemptId,
        target_captcha_token_hash: captchaTokenHash,
        target_delivered: !deliveryError
      });
      if (!deliveryError && (markError || marked !== true)) {
        response.status(503).json({ error: { code: 'auth_unavailable', message: 'Email sign-in is temporarily unavailable.' } });
        return;
      }
      response.status(202).json(genericPreflightResponse(attemptToken));
    } catch (error) {
      if (error instanceof z.ZodError) {
        response.status(400).json({ error: { code: 'invalid_request', message: 'Enter a valid email address and beta invite.' } });
        return;
      }
      response.status(500).json({ error: { code: 'preflight_failed', message: 'Email sign-in could not be started.' } });
    }
  });

  router.post('/email/activate', async (request, response) => {
    if (!admin || !verifier) {
      response.status(503).json({ error: { code: 'auth_not_configured', message: 'Email signup is not configured.' } });
      return;
    }
    try {
      const input = activationBody.parse(request.body);
      const token = bearerToken(request);
      if (!token) {
        response.status(401).json({ error: { code: 'unauthorized', message: 'A verified email session is required.' } });
        return;
      }
      const { data, error } = await verifier.auth.getUser(token);
      const user = data.user;
      if (error || !user?.email || !user.email_confirmed_at) {
        response.status(401).json({ error: { code: 'email_not_verified', message: 'Verify this email address before activating Tsurfing.' } });
        return;
      }
      const claims = tokenClaims(token);
      if (!claims.sessionId || claims.emailOtpAuthenticatedAt == null) {
        response.status(401).json({
          error: { code: 'email_code_session_required', message: 'Verify the current email code before activating Tsurfing.' }
        });
        return;
      }
      const { data: activated, error: activateError } = await admin.rpc('activate_goalflow_email_otp', {
        target_token_hash: hash(input.attemptToken),
        target_user_id: user.id,
        target_email: normalizeEmail(user.email),
        target_session_id: claims.sessionId,
        target_authenticated_at: new Date(claims.emailOtpAuthenticatedAt * 1_000).toISOString()
      });
      if (activateError) throw activateError;
      if (!activated) {
        response.status(400).json({ error: { code: 'activation_rejected', message: 'This activation is invalid or expired.' } });
        return;
      }
      response.status(200).json({ activated: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        response.status(400).json({ error: { code: 'activation_rejected', message: 'This activation is invalid or expired.' } });
        return;
      }
      response.status(500).json({ error: { code: 'activation_failed', message: 'Email signup could not be activated.' } });
    }
  });

  return router;
};
