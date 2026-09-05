import React, { useEffect, useState } from 'react';
import {
  beginTelegramLink,
  disableTelegramBotAccess,
  enableTelegramBotAccess,
  getTelegramBotStatus,
  logoutEverywhere,
  supabase,
  telegramProvider
} from '../services/authService';

type TotpEnrollment = {
  factorId: string;
  qrCode: string;
  secret: string;
};

export const AccountSecurity: React.FC<{ userEmail: string; isOwner: boolean }> = ({ userEmail, isOwner }) => {
  const [assuranceLevel, setAssuranceLevel] = useState<string>('aal1');
  const [verifiedFactorId, setVerifiedFactorId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [recoveryEmail, setRecoveryEmail] = useState(userEmail.includes('@') ? userEmail : '');
  const [telegramLinked, setTelegramLinked] = useState(false);
  const [telegramIdentityAvailable, setTelegramIdentityAvailable] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const telegramChangeRequiresMfa = isOwner && assuranceLevel !== 'aal2';

  const refresh = async () => {
    if (!supabase) return;
    const [{ data: factors }, { data: assurance }, { data: identities }, botStatus] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.getUserIdentities(),
      getTelegramBotStatus().catch(() => null)
    ]);
    setVerifiedFactorId(factors?.totp.find(factor => factor.status === 'verified')?.id || null);
    setAssuranceLevel(assurance?.currentLevel || 'aal1');
    const providerId = telegramProvider.replace(/^custom:/, '');
    setTelegramIdentityAvailable(Boolean(identities?.identities.some(identity => identity.provider === telegramProvider || identity.provider === providerId)));
    setTelegramLinked(botStatus?.linked === true);
  };

  useEffect(() => {
    if (supabase) void refresh();
  }, []);

  const startEnrollment = async () => {
    if (!supabase) return;
    setBusy(true);
    setMessage(null);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Tsurfing' });
      if (error) throw error;
      setEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not start authenticator setup.');
    } finally {
      setBusy(false);
    }
  };

  const verifyEnrollment = async () => {
    if (!supabase || !enrollment || code.length !== 6) return;
    setBusy(true);
    setMessage(null);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: enrollment.factorId });
      if (challengeError) throw challengeError;
      const { error } = await supabase.auth.mfa.verify({
        factorId: enrollment.factorId,
        challengeId: challenge.id,
        code
      });
      if (error) throw error;
      setEnrollment(null);
      setCode('');
      setMessage('Authenticator verification is active.');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The verification code was not accepted.');
    } finally {
      setBusy(false);
    }
  };

  const saveRecoveryEmail = async () => {
    if (!supabase || !recoveryEmail.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabase.auth.updateUser({ email: recoveryEmail.trim() });
      if (error) throw error;
      setMessage('Check the new address to confirm your recovery email.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The recovery email could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const linkTelegram = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (telegramIdentityAvailable) {
        if (!await enableTelegramBotAccess()) return;
        await refresh();
        setMessage('Telegram bot access is active.');
        setBusy(false);
      } else {
        await beginTelegramLink();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Telegram could not be linked.');
      setBusy(false);
    }
  };

  const unlinkTelegram = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await disableTelegramBotAccess();
      setTelegramLinked(false);
      setMessage('Telegram bot and Mini App access was revoked. Your login identity remains available.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Telegram access could not be revoked.');
    } finally { setBusy(false); }
  };

  const signOutEverywhere = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await logoutEverywhere();
      window.location.assign('/');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The sessions could not be revoked.');
      setBusy(false);
    }
  };

  if (!supabase) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Account security becomes available when Supabase is configured.</p>;
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-bold text-gray-900 dark:text-white">Recovery email</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Use a verified email when Telegram is unavailable.</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input type="email" value={recoveryEmail} onChange={event => setRecoveryEmail(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-slate-600 dark:bg-slate-800 dark:text-white" autoComplete="email" />
          <button type="button" onClick={saveRecoveryEmail} disabled={busy} className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-gray-200">Update</button>
        </div>
      </div>

      {import.meta.env.VITE_TELEGRAM_ENABLED === 'true' && <div className="border-t border-gray-200 pt-5 dark:border-slate-700">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-bold text-gray-900 dark:text-white">Telegram & bot</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Link this account to use the bot and Mini App.{isOwner ? ' Owner changes require two-factor authentication.' : ''}</p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${telegramLinked ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-gray-300'}`}>{telegramLinked ? 'Linked' : 'Not linked'}</span>
        </div>
        {!telegramLinked && <button type="button" onClick={linkTelegram} disabled={busy || telegramChangeRequiresMfa} className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">Link Telegram</button>}
        {telegramLinked && <button type="button" onClick={() => void unlinkTelegram()} disabled={busy || telegramChangeRequiresMfa} className="mt-3 rounded-lg border border-red-200 px-4 py-2 text-sm font-bold text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400">Disconnect bot access</button>}
        {telegramChangeRequiresMfa && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Verify your authenticator in this session before changing Telegram access.</p>}
      </div>}

      <div className="border-t border-gray-200 pt-5 dark:border-slate-700">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-bold text-gray-900 dark:text-white">Authenticator app</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Required for owner administration and recommended for every account.</p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${verifiedFactorId ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-gray-300'}`}>{verifiedFactorId ? `Active (${assuranceLevel})` : 'Not configured'}</span>
        </div>

        {!verifiedFactorId && !enrollment && <button type="button" onClick={startEnrollment} disabled={busy} className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">Set up authenticator</button>}

        {enrollment && (
          <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-slate-600 dark:bg-slate-800">
            <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">Scan this QR code, then enter the six-digit code.</p>
            <img src={enrollment.qrCode} alt="Authenticator enrollment QR code" className="h-48 w-48 rounded-lg bg-white p-2" />
            <details className="mt-3 text-sm text-gray-500 dark:text-gray-400"><summary>Enter setup key manually</summary><code className="mt-2 block break-all rounded bg-gray-100 p-2 dark:bg-slate-700">{enrollment.secret}</code></details>
            <div className="mt-3 flex gap-2">
              <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} aria-label="Six-digit authenticator code" className="w-40 rounded-lg border border-gray-200 px-3 py-2 tracking-[0.25em] dark:border-slate-600 dark:bg-slate-900 dark:text-white" />
              <button type="button" onClick={verifyEnrollment} disabled={busy || code.length !== 6} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Verify</button>
            </div>
          </div>
        )}
      </div>

      {message && <p role="status" className="text-sm text-indigo-700 dark:text-indigo-300">{message}</p>}
      <div className="border-t border-gray-200 pt-5 dark:border-slate-700">
        <h3 className="text-base font-bold text-gray-900 dark:text-white">Active sessions</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Revoke refresh tokens on every device. Tsurfing also rejects their existing access tokens immediately.</p>
        <button type="button" onClick={() => void signOutEverywhere()} disabled={busy} className="mt-3 rounded-lg border border-red-200 px-4 py-2 text-sm font-bold text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20">Sign out all devices</button>
      </div>
      <div className="border-t border-gray-200 pt-5 dark:border-slate-700">
        <h3 className="text-base font-bold text-gray-900 dark:text-white">Delete account</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Self-service deletion is temporarily disabled during beta until database and encrypted-backup removal can be transactionally coordinated. Account export remains available.</p>
      </div>
    </div>
  );
};
