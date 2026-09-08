import React, { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Logo } from './Logo';
import {
  beginTelegramSignIn,
  beginTelegramSignup,
  pendingEmailOtpRequest,
  requestEmailOtp,
  verifyEmailOtp,
  type EmailOtpPurpose
} from '../services/authService';
import { Turnstile } from './Turnstile';

type AuthStage = 'request' | 'verify';

export const Auth: React.FC<{ activationError?: string | null }> = ({ activationError }) => {
  const [restoredRequest] = useState(() => pendingEmailOtpRequest());
  const [purpose, setPurpose] = useState<EmailOtpPurpose>(restoredRequest?.purpose ?? 'sign_in');
  const [stage, setStage] = useState<AuthStage>(restoredRequest ? 'verify' : 'request');
  const [inviteCode, setInviteCode] = useState('');
  const [email, setEmail] = useState(restoredRequest?.email ?? '');
  const [requestedEmail, setRequestedEmail] = useState(restoredRequest?.email ?? '');
  const [otp, setOtp] = useState('');
  const [message, setMessage] = useState(activationError || '');
  const [pending, setPending] = useState(false);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaRevision, setCaptchaRevision] = useState(0);
  const [resendAt, setResendAt] = useState(restoredRequest?.resendAt ?? 0);
  const [, setClock] = useState(Date.now());
  const telegramEnabled = import.meta.env.VITE_TELEGRAM_ENABLED === 'true';
  const captchaRequired = Boolean(import.meta.env.VITE_TURNSTILE_SITE_KEY);
  const onCaptchaToken = useCallback((token: string) => setCaptchaToken(token), []);
  const resendSeconds = Math.max(0, Math.ceil((resendAt - Date.now()) / 1_000));

  useEffect(() => {
    if (stage !== 'verify' || resendAt <= Date.now()) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [resendAt, stage]);

  const resetCaptcha = () => {
    setCaptchaToken('');
    setCaptchaRevision(revision => revision + 1);
  };

  const requestCode = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    const result = await requestEmailOtp(
      normalizedEmail,
      purpose,
      purpose === 'activation' ? inviteCode : '',
      captchaToken
    );
    setRequestedEmail(normalizedEmail);
    setResendAt(Date.now() + result.resendAfterSeconds * 1_000);
    setOtp('');
    setStage('verify');
    setMessage('If this address is approved, a six-digit code will arrive. It expires in 10 minutes.');
    resetCaptcha();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      if (stage === 'request') {
        await requestCode();
      } else {
        await verifyEmailOtp(requestedEmail, otp);
        setMessage('Email verified. Tsurfing is opening your account.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authentication could not be completed.');
      if (stage === 'request') resetCaptcha();
    } finally {
      setPending(false);
    }
  };

  const telegram = async () => {
    setPending(true);
    setMessage('');
    try {
      if (purpose === 'activation') {
        await beginTelegramSignup(inviteCode.trim(), captchaToken);
      } else {
        await beginTelegramSignIn();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Telegram signup failed.');
      resetCaptcha();
      setPending(false);
    }
  };

  const selectPurpose = (nextPurpose: EmailOtpPurpose) => {
    setPurpose(nextPurpose);
    setStage('request');
    setRequestedEmail('');
    setOtp('');
    setMessage('');
    resetCaptcha();
  };

  const changeEmail = () => {
    setStage('request');
    setRequestedEmail('');
    setOtp('');
    setMessage('');
    resetCaptcha();
  };

  return (
    <main className="min-h-screen bg-[#F7F8FA] flex items-center justify-center p-4 font-sans">
      <section className="w-full max-w-md bg-white border border-[#E4E7EC] rounded-xl p-8 shadow-sm">
        <div className="mb-8"><Logo /></div>
        <h1 className="text-3xl font-semibold text-[#111827]">Plan, then focus on one task.</h1>
        <p className="mt-2 text-[#667085]">Tsurfing is an invite-only beta.</p>

        <nav className="mt-6 grid grid-cols-2 gap-1 rounded-lg bg-[#F2F4F7] p-1" aria-label="Account access">
          {([['sign_in', 'Sign in'], ['activation', 'Join beta']] as const).map(([id, label]) => (
            <button key={id} type="button" disabled={pending} onClick={() => selectPurpose(id)}
              aria-current={purpose === id ? 'page' : undefined}
              className={`rounded-md px-3 py-2 text-sm font-medium ${purpose === id ? 'bg-white text-[#344054] shadow-sm' : 'text-[#667085]'}`}>
              {label}
            </button>
          ))}
        </nav>

        <form onSubmit={submit} className="mt-6 space-y-3">
          {stage === 'request' ? <>
            <label className="block text-sm font-medium text-[#344054]" htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" required value={email}
              onChange={event => setEmail(event.target.value)}
              className="w-full rounded-lg border border-[#D0D5DD] px-3 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500" />

            {purpose === 'activation' && <>
              <label className="block text-sm font-medium text-[#344054]" htmlFor="invite">Beta invite code</label>
              <input id="invite" required minLength={6} maxLength={128} value={inviteCode}
                onChange={event => setInviteCode(event.target.value)}
                className="w-full rounded-lg border border-[#D0D5DD] px-3 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </>}

            <Turnstile key={captchaRevision} onToken={onCaptchaToken} action="email-otp" />

            <button disabled={pending || (captchaRequired && !captchaToken)}
              className="w-full rounded-lg bg-[#4F46E5] px-4 py-3 font-medium text-white disabled:opacity-50">
              {pending ? 'Requesting…' : 'Send email code'}
            </button>
          </> : <>
            <p className="text-sm text-[#475467]">
              Enter the six-digit code sent to <strong>{requestedEmail}</strong>.
            </p>
            <label className="block text-sm font-medium text-[#344054]" htmlFor="email-code">Email code</label>
            <input id="email-code" type="text" inputMode="numeric" autoComplete="one-time-code"
              pattern="[0-9]{6}" minLength={6} maxLength={6} required autoFocus value={otp}
              onChange={event => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
              className="w-full rounded-lg border border-[#D0D5DD] px-3 py-3 text-center text-2xl tracking-[0.35em] focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <button disabled={pending || otp.length !== 6}
              className="w-full rounded-lg bg-[#4F46E5] px-4 py-3 font-medium text-white disabled:opacity-50">
              {pending ? 'Verifying…' : 'Verify code'}
            </button>
            <button type="button" onClick={changeEmail} disabled={pending || resendSeconds > 0}
              className="w-full rounded-lg border border-[#D0D5DD] px-4 py-2 text-sm font-medium text-[#475467] disabled:opacity-50">
              {resendSeconds > 0 ? `Request another code in ${resendSeconds}s` : 'Request another code'}
            </button>
          </>}
        </form>

        {telegramEnabled && stage === 'request' && <button type="button"
          onClick={() => void telegram()} disabled={pending || (purpose === 'activation' && (!inviteCode || (captchaRequired && !captchaToken)))}
          className="mt-3 w-full rounded-lg border border-[#D0D5DD] px-4 py-3 font-medium text-[#344054] disabled:opacity-50">
          Continue with Telegram
        </button>}

        {message && <p className="mt-4 text-sm text-[#475467]" role="status">{message}</p>}
      </section>
    </main>
  );
};
