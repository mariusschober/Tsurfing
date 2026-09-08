import React, { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const PwaLifecycle: React.FC = () => {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosHelp, setShowIosHelp] = useState(false);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW();

  useEffect(() => {
    const capture = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', capture);
    return () => window.removeEventListener('beforeinstallprompt', capture);
  }, []);

  if (standalone && !needRefresh) return null;
  if (!needRefresh && !installPrompt && !/iPad|iPhone|iPod/.test(navigator.userAgent)) return null;

  return (
    <aside className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-[70] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-xl border border-gray-200 bg-white p-4 shadow-lg dark:border-slate-700 dark:bg-slate-800" aria-live="polite">
      {needRefresh ? (
        <div className="flex items-center gap-3"><p className="flex-1 text-sm font-medium text-gray-700 dark:text-gray-200">A Tsurfing update is ready.</p><button type="button" onClick={() => void updateServiceWorker(true)} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white">Update</button><button type="button" onClick={() => setNeedRefresh(false)} className="text-sm text-gray-500">Later</button></div>
      ) : installPrompt ? (
        <div className="flex items-center gap-3"><p className="flex-1 text-sm font-medium text-gray-700 dark:text-gray-200">Install Tsurfing for fast, offline access.</p><button type="button" onClick={() => void installPrompt.prompt().then(() => setInstallPrompt(null))} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white">Install</button><button type="button" onClick={() => setInstallPrompt(null)} className="text-sm text-gray-500">Not now</button></div>
      ) : (
        <div><button type="button" onClick={() => setShowIosHelp(value => !value)} className="text-sm font-bold text-indigo-700 dark:text-indigo-300">Install Tsurfing</button>{showIosHelp && <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">In Safari, tap Share, then Add to Home Screen.</p>}</div>
      )}
    </aside>
  );
};
