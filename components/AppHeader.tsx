import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { UserProgress } from '../types';
import { Logo } from './Logo';
import { DeepWorkPlayer } from './DeepWorkPlayer';
import { SyncStatus } from './SyncStatus';
import { XPDisplay } from './XPDisplay';
import { Modal } from './Modal';
import { CalendarIcon, InboxIcon, RepeatIcon, TrophyIcon, StatsIcon, SearchIcon, SunIcon, MoonIcon, SettingsIcon, ChevronDownIcon } from './Icons';

export type View = 'current' | 'planning' | 'goals' | 'stats' | 'done' | 'habits' | 'gamification';
type HeaderLayout = 'compact' | 'standard' | 'wide';

const destinations = [
  { view: 'current', label: 'Current', hotkey: 'f', Icon: CalendarIcon },
  { view: 'planning', label: 'Plan', hotkey: 'p', Icon: InboxIcon },
  { view: 'habits', label: 'Habits', hotkey: 'h', Icon: RepeatIcon },
  { view: 'goals', label: 'Goals', hotkey: 'g', Icon: TrophyIcon },
  { view: 'stats', label: 'Insights', hotkey: 's', Icon: StatsIcon },
] as const;

const PrimaryNavigation: React.FC<{ currentView: View; hasOverdue: boolean; onNavigate: (view: View) => void; inPanel?: boolean }> = ({ currentView, hasOverdue, onNavigate, inPanel = false }) => {
  const reasonId = useId();
  return <nav aria-label="Primary" className={inPanel ? 'navigation-destinations' : 'app-header__destinations'}>
    {destinations.map(({ view, label, hotkey, Icon }) => {
      const active = currentView === view || (view === 'stats' && currentView === 'done');
      const disabled = hasOverdue && view !== 'planning';
      return <button key={view} type="button" disabled={disabled} aria-label={label}
        aria-current={active ? 'page' : undefined} aria-describedby={disabled && inPanel ? reasonId : undefined}
        title={disabled ? 'Complete overdue tasks first' : `Shortcut: ${hotkey}`}
        onClick={() => onNavigate(view)}
        className={`navigation-destination ${active ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200 font-semibold' : disabled ? 'text-gray-400 dark:text-gray-500 cursor-not-allowed' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700'}`}>
        <Icon className="h-5 w-5 shrink-0" aria-hidden="true" /><span>{label}</span>
      </button>;
    })}
    {inPanel && hasOverdue && <p id={reasonId} className="mt-2 text-sm text-gray-600 dark:text-gray-300">Complete overdue tasks in Plan to unlock the other views.</p>}
  </nav>;
};

interface AppHeaderProps {
  currentView: View;
  hasOverdue: boolean;
  userKey: string;
  userEmail: string;
  userProgress: UserProgress;
  theme: 'light' | 'dark';
  onNavigate: (view: View) => void;
  onSearch: () => void;
  onSettings: () => void;
  onLogout: () => void;
  onToggleTheme: () => void;
  onModalChange: (open: boolean) => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({ currentView, hasOverdue, userKey, userEmail, userProgress, theme, onNavigate, onSearch, onSettings, onLogout, onToggleTheme, onModalChange }) => {
  const innerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [layout, setLayout] = useState<HeaderLayout>('compact');
  const [menuOpen, setMenuOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [musicOpen, setMusicOpen] = useState(false);
  const [desktopPlayerTarget, setDesktopPlayerTarget] = useState<HTMLDivElement | null>(null);
  const [panelPlayerTarget, setPanelPlayerTarget] = useState<HTMLDivElement | null>(null);
  const hidden = currentView === 'gamification';

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    // CSS is the single authority for breakpoints, including rem units and safe-area width.
    const update = () => setLayout(getComputedStyle(inner).getPropertyValue('--header-layout').trim() as HeaderLayout || 'compact');
    update();
    const observer = new ResizeObserver(update);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { setMenuOpen(false); }, [layout, hidden]);
  useEffect(() => { onModalChange(menuOpen || syncOpen || musicOpen); }, [menuOpen, syncOpen, musicOpen, onModalChange]);

  const act = (action: () => void) => { setMenuOpen(false); action(); };
  const themeButton = (labelled: boolean) => <button type="button" onClick={onToggleTheme}
    title="Toggle Theme" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    className={`header-control text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 ${labelled ? 'header-control--labelled' : ''}`}>
    {theme === 'light' ? <MoonIcon className="h-5 w-5 shrink-0" aria-hidden="true" /> : <SunIcon className="h-5 w-5 shrink-0" aria-hidden="true" />}
    {labelled && <span>{theme === 'dark' ? 'Dark appearance' : 'Light appearance'}</span>}
  </button>;

  return <>
    <header className={`app-header sticky top-0 z-20 border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 print:hidden ${hidden ? 'hidden' : ''}`} data-layout={layout}>
      <div ref={innerRef} className="app-header__inner">
        <Logo onReset={() => onNavigate('current')} compact />
        <div className="app-header__primary"><PrimaryNavigation currentView={currentView} hasOverdue={hasOverdue} onNavigate={onNavigate} /></div>
        <div className="app-header__utilities">
          <div ref={setDesktopPlayerTarget} className="app-header__wide" />
          <div className="app-header__wide">{themeButton(false)}</div>
          <button type="button" onClick={event => { event.currentTarget.focus(); onSearch(); }} aria-label="Search" title="Search (/)" className="header-control text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700"><SearchIcon className="h-5 w-5" aria-hidden="true" /></button>
          <SyncStatus userKey={userKey} closeSignal={`${layout}:${hidden}`} onOpenChange={setSyncOpen} />
          <div className="app-header__wide"><XPDisplay userProgress={userProgress} onClick={() => onNavigate('gamification')} /></div>
          <button ref={menuButtonRef} type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls={menuId}
            className="header-control header-control--menu border border-gray-200 dark:border-slate-600 text-gray-700 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-slate-700"><span>Menu</span><ChevronDownIcon className="h-4 w-4 shrink-0" aria-hidden="true" /></button>
        </div>
      </div>
    </header>

    <Modal isOpen={menuOpen && !hidden} onClose={() => setMenuOpen(false)} title="Menu" id={menuId} variant="navigation" returnFocusRef={menuButtonRef}>
      <div className="navigation-sections">
        {layout === 'compact' && <section><h4 className="navigation-section-label">Navigate</h4><PrimaryNavigation currentView={currentView} hasOverdue={hasOverdue} onNavigate={view => act(() => onNavigate(view))} inPanel /></section>}
        {layout !== 'wide' && <>
          <section><h4 className="navigation-section-label">Focus music</h4><div ref={setPanelPlayerTarget} /></section>
          <section><h4 className="navigation-section-label">Appearance</h4>{themeButton(true)}</section>
          <section className="navigation-progress"><h4 className="navigation-section-label">Your progress</h4><XPDisplay userProgress={userProgress} onClick={() => act(() => onNavigate('gamification'))} /></section>
        </>}
        <section><h4 className="navigation-section-label">Account</h4>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-300 break-all">{userEmail}</p>
          <button type="button" onClick={() => act(onSettings)} className="header-control header-control--labelled text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700"><SettingsIcon className="h-5 w-5 shrink-0" aria-hidden="true" />Settings</button>
          <div className="mt-3 border-t border-gray-200 dark:border-slate-700 pt-3"><button type="button" onClick={() => act(onLogout)} className="header-control header-control--labelled text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-slate-700">Sign out</button></div>
        </section>
      </div>
    </Modal>

    {/* The owner of Audio and its listeners never unmounts when controls move. */}
    <DeepWorkPlayer controlsTarget={layout === 'wide' ? desktopPlayerTarget : panelPlayerTarget}
      presentation={layout === 'wide' ? 'toolbar' : 'panel'} controlsVisible={!hidden && (layout === 'wide' || menuOpen)} onOpenChange={setMusicOpen} fallbackFocusRef={menuButtonRef} />
  </>;
};
