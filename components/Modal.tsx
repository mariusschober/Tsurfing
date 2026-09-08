
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  variant?: 'default' | 'navigation' | 'compact' | 'popover' | 'planned';
  headerControls?: React.ReactNode;
  id?: string;
  anchorRef?: React.RefObject<HTMLElement>;
  returnFocusRef?: React.RefObject<HTMLElement>;
  fallbackFocusRef?: React.RefObject<HTMLElement>;
}

const modalStack: HTMLDivElement[] = [];

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, variant = 'default', id, anchorRef, returnFocusRef, fallbackFocusRef, headerControls }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [position, setPosition] = useState<React.CSSProperties>({});
  const [layer, setLayer] = useState(10000);
  const titleId = useId();
  const openingFocusRef = useRef<HTMLElement | null>(null);
  const renderedOpenRef = useRef(false);
  // Capture before child autofocus runs during the DOM commit. This matters
  // when a task form opens above another dialog.
  if (isOpen && !renderedOpenRef.current) openingFocusRef.current = document.activeElement as HTMLElement | null;
  renderedOpenRef.current = isOpen;
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useLayoutEffect(() => {
    if (!isOpen || variant !== 'popover') return;
    const place = () => {
      const anchor = anchorRef?.current;
      const panel = dialogRef.current;
      const overlay = overlayRef.current;
      if (!anchor || !panel || !overlay) return;
      if (!anchor.getClientRects().length) { onCloseRef.current(); return; }
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? document.documentElement.clientWidth;
      const height = viewport?.height ?? window.innerHeight;
      const padding = getComputedStyle(overlay);
      const leftEdge = x + parseFloat(padding.paddingLeft);
      const rightEdge = x + width - parseFloat(padding.paddingRight);
      const topEdge = y + parseFloat(padding.paddingTop);
      const bottomEdge = y + height - parseFloat(padding.paddingBottom);
      const rect = anchor.getBoundingClientRect();
      const panelWidth = Math.min(320, rightEdge - leftEdge);
      const panelHeight = Math.min(panel.getBoundingClientRect().height, bottomEdge - topEdge);
      const left = Math.max(leftEdge, Math.min(rect.right - panelWidth, rightEdge - panelWidth));
      const top = Math.max(topEdge, Math.min(rect.bottom + 8, bottomEdge - panelHeight));
      const next = { left, top, width: panelWidth, maxHeight: Math.max(0, bottomEdge - top) };
      setPosition(previous => Object.entries(next).every(([key, value]) => previous[key] === value) ? previous : next);
    };
    place();
    const observer = new ResizeObserver(place);
    if (anchorRef?.current) observer.observe(anchorRef.current);
    if (dialogRef.current) observer.observe(dialogRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [isOpen, variant, anchorRef]);

  useLayoutEffect(() => {
    const keyTarget = variant === 'default' ? window : document;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== dialogRef.current) return;
      // The navigation dialog handles keys after its controls, before background view shortcuts on window.
      if (variant !== 'default') e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
          .filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'));
        if (!focusable.length) { e.preventDefault(); dialogRef.current.focus(); return; }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
    };

    if (isOpen) {
      const panel = dialogRef.current!;
      modalStack.push(panel);
      setLayer(10000 + modalStack.length);
      const previousFocus = openingFocusRef.current;
      const previousOverflow = document.body.style.overflow;
      // New navigation surfaces are modal, including for pointer and assistive technology users.
      const background = Array.from(document.body.children)
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlayRef.current)
        .map(element => ({ element, inert: element.inert }));
      background.forEach(({ element }) => { element.inert = true; });
      keyTarget.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
      const focusTimer = window.setTimeout(() => {
        const initial = dialogRef.current?.querySelector<HTMLElement>('[autofocus], input:not([disabled]), textarea:not([disabled]), button:not([disabled])');
        (initial || dialogRef.current)?.focus();
      }, 0);
      return () => {
        const index = modalStack.indexOf(panel);
        if (index >= 0) modalStack.splice(index, 1);
        window.clearTimeout(focusTimer);
        keyTarget.removeEventListener('keydown', handleKeyDown);
        background.forEach(({ element, inert }) => { element.inert = inert; });
        document.body.style.overflow = previousOverflow;
        const target = [returnFocusRef?.current ?? previousFocus, fallbackFocusRef?.current]
          .find(element => element?.isConnected && element.getClientRects().length && !element.closest('[inert]'));
        target?.focus({ preventScroll: true });
      };
    }
    return () => keyTarget.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, variant, returnFocusRef, fallbackFocusRef]);

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <div 
      ref={overlayRef}
      style={{ zIndex: layer }}
      className={variant === 'default' ? 'fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-[9999] flex justify-center items-center p-4 sm:p-6 animate-fadeIn' : `navigation-overlay navigation-overlay--${variant}`}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div 
        ref={dialogRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={variant === 'default' ? 'bg-white dark:bg-slate-800 rounded-xl shadow-lg w-full max-w-5xl max-h-[calc(100dvh-2rem)] flex flex-col relative overflow-hidden animate-scaleIn border border-gray-200 dark:border-slate-700' : `navigation-panel navigation-panel--${variant} bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 shadow-xl`}
        style={variant === 'popover' ? position : undefined}
        onClick={e => e.stopPropagation()}
      >
        <div className={variant === 'default' ? 'flex justify-between items-center p-6 pb-4 border-b border-gray-100 dark:border-slate-700 shrink-0 bg-white/50 dark:bg-slate-800/50 backdrop-blur-sm z-10' : 'navigation-panel__heading border-b border-gray-100 dark:border-slate-700'}>
          <h3 id={titleId} className="text-2xl font-heading font-bold text-gray-900 dark:text-white tracking-wide">{title}</h3>
          {headerControls}
          <button type="button" onClick={onClose} aria-label={variant === 'default' ? 'Close dialog' : `Close ${title}`}
            className={variant === 'default' ? 'text-gray-400 hover:text-gray-800 dark:hover:text-white transition-colors p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700' : 'min-h-11 min-w-11 shrink-0 text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white transition-colors p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center justify-center'}>
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className={`flex-1 overflow-y-auto relative flex flex-col min-h-0 text-gray-900 dark:text-gray-100 ${variant === 'default' ? '' : 'navigation-panel__body'}`}>
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
};
