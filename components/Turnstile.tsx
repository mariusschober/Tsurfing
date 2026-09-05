import React, { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: Record<string, unknown>) => string;
      remove: (widgetId: string) => void;
    };
  }
}

export const Turnstile: React.FC<{ onToken: (token: string) => void; action?: string }> = ({
  onToken,
  action = 'beta-signup'
}) => {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!siteKey || !container.current) return;
    let widgetId: string | undefined;
    const render = () => {
      if (window.turnstile && container.current && !widgetId) {
        widgetId = window.turnstile.render(container.current, {
          sitekey: siteKey,
          theme: 'light',
          action,
          callback: onToken,
          'expired-callback': () => onToken(''),
          'error-callback': () => onToken('')
        });
      }
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-goalflow-turnstile]');
    if (existing) render();
    else {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.goalflowTurnstile = 'true';
      script.addEventListener('load', render, { once: true });
      document.head.appendChild(script);
    }
    return () => { if (widgetId && window.turnstile) window.turnstile.remove(widgetId); };
  }, [action, onToken, siteKey]);

  if (!siteKey) return null;
  return <div ref={container} aria-label="Human verification" />;
};
