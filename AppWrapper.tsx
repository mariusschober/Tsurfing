import React, { useCallback, useEffect, useState } from 'react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import App from './App';
import { Auth } from './components/Auth';
import { MfaGate } from './components/MfaGate';
import { TestAccessGate } from './components/TestAccessGate';
import * as authService from './services/authService';

const displayIdentity = (session: Session): string =>
  session.user.email
  || String(session.user.user_metadata?.preferred_username || session.user.user_metadata?.username || `telegram-${session.user.id}`);

const Loading = () => (
  <div className="min-h-screen bg-gray-50 flex items-center justify-center" aria-label="Verifying account">
    <div className="w-10 h-10 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
  </div>
);

const AppWrapper: React.FC = () => {
  const testBuild = authService.isTestBuild();
  const [session, setSession] = useState<Session | null>(null);
  const [account, setAccount] = useState<authService.ServerAccount | null>(null);
  const [localUser] = useState(authService.getLocalDemoUser());
  const [testUnlocked, setTestUnlocked] = useState(() => !testBuild || authService.hasTestAccess());
  const [isLoading, setIsLoading] = useState(true);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [mfaReady, setMfaReady] = useState(false);
  const [recoveryEmailRequired, setRecoveryEmailRequired] = useState(false);
  const completeMfa = useCallback(() => setMfaReady(true), []);

  useEffect(() => {
    if (!authService.shouldDisableServiceWorker() || !('serviceWorker' in navigator)) return;

    // The development-only local demo never needs an offline worker. The isolated
    // production-mode test build keeps it enabled so CI can exercise offline PWA behavior.
    void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
      await Promise.all(registrations.map((registration) => registration.unregister()));
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
      }
    });
  }, []);

  useEffect(() => {
    if (testBuild) {
      setIsLoading(false);
      return;
    }
    let active = true;
    let validationVersion = 0;
    let unsubscribe = () => undefined;

    const rejectSession = async (error: unknown, version: number) => {
      if (!active || version !== validationVersion) return;
      const terminal = error instanceof authService.SessionValidationError
        && error.status >= 400
        && error.status < 500
        && ![408, 425, 429].includes(error.status);
      setActivationError(error instanceof Error ? error.message : 'Account access could not be verified.');
      setSession(null);
      setAccount(null);
      setMfaReady(false);
      setIsLoading(false);
      if (terminal) await authService.logout().catch(() => undefined);
    };

    const acceptSession = async (nextSession: Session | null, handleRedirect: boolean) => {
      const version = ++validationVersion;
      if (!nextSession) {
        if (!active || version !== validationVersion) return;
        setSession(null);
        setAccount(null);
        setMfaReady(false);
        setIsLoading(false);
        return;
      }
      try {
        const authAction = handleRedirect
          ? new URLSearchParams(window.location.search).get('auth')
          : null;
        if (authAction === 'recovery') {
          throw new authService.SessionValidationError(
            'Password links are no longer accepted. Request a new email code.',
            400,
            'password_recovery_disabled'
          );
        }
        if (authAction === 'telegram') {
          setRecoveryEmailRequired(await authService.activateTelegramSignup(nextSession));
        } else if (authAction === 'telegram-link') {
          await authService.activateOwnerTelegramLink(nextSession);
        } else {
          await authService.resumePendingEmailOtpActivation(nextSession);
        }
        if (nextSession.user.email == null) setRecoveryEmailRequired(true);
        const validatedAccount = await authService.validateServerSession(nextSession);
        if (!active || version !== validationVersion) return;
        setActivationError(null);
        setSession(nextSession);
        setAccount(validatedAccount);
        setIsLoading(false);
      } catch (error) {
        await rejectSession(error, version);
      }
    };

    const sessionChanged = (nextSession: Session | null, event: AuthChangeEvent) => {
      if (event === 'INITIAL_SESSION') return;
      if (event === 'SIGNED_IN' && authService.isEmailOtpActivationInFlight()) return;
      if (event === 'PASSWORD_RECOVERY') {
        validationVersion += 1;
        setActivationError('Password links are no longer accepted. Request a new email code.');
        setSession(null);
        setAccount(null);
        setMfaReady(false);
        setIsLoading(false);
        void authService.logout().catch(() => undefined);
        return;
      }
      if (event === 'SIGNED_OUT' || !nextSession) {
        validationVersion += 1;
        setSession(null);
        setAccount(null);
        setMfaReady(false);
        setIsLoading(false);
        return;
      }
      if (event === 'SIGNED_IN') {
        setMfaReady(false);
        setIsLoading(true);
      }
      void acceptSession(nextSession, false);
    };

    const sessionRejected = () => {
      void authService.getSession()
        .then(nextSession => acceptSession(nextSession, false))
        .catch(error => rejectSession(error, ++validationVersion));
    };
    const emailOtpActivated = () => {
      setIsLoading(true);
      void authService.getSession()
        .then(nextSession => acceptSession(nextSession, false))
        .catch(error => rejectSession(error, ++validationVersion));
    };

    // Subscribe before the first asynchronous lookup/validation. A cross-tab
    // sign-out or account switch must invalidate that in-flight result instead
    // of being missed between getSession() and subscription setup.
    unsubscribe = authService.onSessionChange(sessionChanged);
    window.addEventListener('goalflow:session-rejected', sessionRejected);
    window.addEventListener('goalflow:email-otp-activated', emailOtpActivated);
    window.addEventListener('online', sessionRejected);
    window.addEventListener('focus', sessionRejected);
    void (async () => {
      await acceptSession(await authService.getSession(), true);
    })().catch(async error => {
      const version = ++validationVersion;
      await rejectSession(error, version);
    });
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('goalflow:session-rejected', sessionRejected);
      window.removeEventListener('goalflow:email-otp-activated', emailOtpActivated);
      window.removeEventListener('online', sessionRejected);
      window.removeEventListener('focus', sessionRejected);
    };
  }, [testBuild]);

  if (isLoading) return <Loading />;
  if (testBuild && !testUnlocked) return <TestAccessGate onUnlock={() => setTestUnlocked(true)} />;
  if (!session && !localUser) return <Auth activationError={activationError} />;
  if (session && account && !mfaReady) return <MfaGate
    required={account.role === 'owner'}
    onComplete={completeMfa}
  />;
  if (session && !account) return <Loading />;
  const identity = localUser || account?.email || displayIdentity(session!);
  const userKey = localUser || account?.id || session!.user.id;
  const userRole = account?.role ?? 'owner';
  return <>
    <App key={userKey} userEmail={identity} userKey={userKey} userRole={userRole}
      openAccountSetup={recoveryEmailRequired} onLogout={() => {
        if (testBuild) {
          authService.clearTestAccess();
          setTestUnlocked(false);
        } else {
          void authService.logout().then(() => {
            setSession(null);
            setAccount(null);
          }).catch(error => {
            setActivationError(error instanceof Error ? error.message : 'Sign out could not be verified.');
          });
        }
      }} />
    {activationError && <div role="alert" className="fixed left-1/2 top-4 z-[100] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-lg border border-red-200 bg-white px-4 py-3 text-sm text-red-700 shadow-lg">{activationError}<button type="button" onClick={() => setActivationError(null)} className="ml-3 font-bold">Dismiss</button></div>}
  </>;
};

export default AppWrapper;
