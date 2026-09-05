import React, { useEffect, useState } from 'react';
import { supabase } from '../services/authService';

type Enrollment = { factorId: string; qrCode: string; secret: string };

export const MfaGate: React.FC<{
  required?: boolean;
  onComplete: () => void;
}> = ({ required = false, onComplete }) => {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [needsEnrollment, setNeedsEnrollment] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState(true);

  useEffect(() => {
    let active = true;
    const inspect = async () => {
      if (!supabase) return onComplete();
      const [{ data: factors, error: factorsError }, { data: assurance, error: assuranceError }] = await Promise.all([
        supabase.auth.mfa.listFactors(),
        supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      ]);
      if (!active) return;
      setInspecting(false);
      if (factorsError || assuranceError) {
        setError(factorsError?.message || assuranceError?.message || 'Could not verify account security.');
        return;
      }
      const verified = factors.totp.find(factor => factor.status === 'verified');
      if (assurance.currentLevel === 'aal2') {
        onComplete();
      } else if (verified) {
        setFactorId(verified.id);
      } else if (required) {
        setNeedsEnrollment(true);
      } else {
        onComplete();
      }
    };
    void inspect();
    return () => { active = false; };
  }, [onComplete, required]);

  const startEnrollment = async () => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    try {
      const { data, error: enrollmentError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Tsurfing owner'
      });
      if (enrollmentError) throw enrollmentError;
      setEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
      setFactorId(data.id);
      setNeedsEnrollment(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start authenticator setup.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!supabase || !factorId || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeError) throw challengeError;
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code
      });
      if (verifyError) throw verifyError;
      onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The verification code was not accepted.');
    } finally {
      setBusy(false);
    }
  };

  if (inspecting) return <div className="min-h-screen bg-gray-50 flex items-center justify-center"><div className="w-10 h-10 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-16 dark:bg-slate-900">
      <section className="mx-auto max-w-md rounded-xl border border-gray-200 bg-white p-8 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <p className="text-xs font-bold uppercase tracking-widest text-indigo-600 dark:text-indigo-300">Account security</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">
          {needsEnrollment ? 'Protect the owner account' : 'Enter your authenticator code'}
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          {needsEnrollment
            ? 'Owner administration requires a verified authenticator before Tsurfing data can be opened.'
            : 'Open your authenticator app and enter the current six-digit code.'}
        </p>

        {needsEnrollment && <button type="button" onClick={() => void startEnrollment()} disabled={busy}
          className="mt-6 w-full rounded-lg bg-indigo-600 px-4 py-3 font-bold text-white disabled:opacity-50">
          {busy ? 'Starting…' : 'Set up authenticator'}
        </button>}

        {enrollment && <div className="mt-6 rounded-lg border border-gray-200 p-4 dark:border-slate-600">
          <img src={enrollment.qrCode} alt="Authenticator enrollment QR code" className="mx-auto h-48 w-48 bg-white p-2" />
          <details className="mt-3 text-sm text-gray-500"><summary>Enter setup key manually</summary><code className="mt-2 block break-all">{enrollment.secret}</code></details>
        </div>}

        {factorId && <>
          <input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
            value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))}
            onKeyDown={event => { if (event.key === 'Enter') void verify(); }}
            aria-label="Six-digit authenticator code"
            className="mt-6 w-full rounded-lg border border-gray-200 px-4 py-3 text-center text-xl tracking-[0.35em] dark:border-slate-600 dark:bg-slate-900 dark:text-white" />
          <button type="button" onClick={() => void verify()} disabled={busy || code.length !== 6}
            className="mt-4 w-full rounded-lg bg-indigo-600 px-4 py-3 font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? 'Verifying…' : 'Continue'}
          </button>
        </>}
        {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </section>
    </main>
  );
};
