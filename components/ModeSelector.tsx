import React from 'react';
import type { CircadianState } from '../types';

interface ModeSelectorProps {
  active: boolean;
  mode: CircadianState['mode'];
  onManual: () => void;
  onBioAdaptive: () => void;
}

export const ModeSelector: React.FC<ModeSelectorProps> = ({ active, mode, onManual, onBioAdaptive }) => (
  <div className="mode-selector">
    <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">Planning mode</span>
    <div role="group" aria-label="Planning mode" className="mode-selector__options bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-600">
      <button type="button" aria-pressed={!active} onClick={onManual}
        className={`mode-selector__option ${!active ? 'bg-white dark:bg-slate-600 text-indigo-700 dark:text-white shadow-sm' : 'text-gray-600 dark:text-gray-300 hover:bg-white/60 dark:hover:bg-slate-700'}`}>Manual</button>
      <button type="button" aria-pressed={active} onClick={onBioAdaptive}
        className={`mode-selector__option ${active ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-600 dark:text-gray-300 hover:bg-white/60 dark:hover:bg-slate-700'}`}>Bio-Adaptive</button>
    </div>
    {active && <span className="text-xs text-gray-600 dark:text-gray-300">{mode === 'apex' ? 'Apex' : mode === 'recovery' ? 'Recovery' : 'Maintenance'}</span>}
  </div>
);
