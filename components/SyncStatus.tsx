import React, { useEffect, useState, useRef, useId } from 'react';
import { Modal } from './Modal';
import { type SyncState } from '../services/cloudSync';
import { storageService, STORES } from '../services/storage';

interface StatusDetail {
  state: SyncState;
  lastSuccessfulSync?: string;
  conflictCount?: number;
  message?: string;
}

export const SyncStatus: React.FC<{ userKey: string; closeSignal?: string; onOpenChange?: (open: boolean) => void }> = ({ userKey, closeSignal, onOpenChange }) => {
  const [status, setStatus] = useState<StatusDetail>({ state: navigator.onLine ? 'saved-locally' : 'offline' });
  const [conflicts, setConflicts] = useState<Array<{ id: string; entityType: string; entityId: string; localPayload?: any }>>([]);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => { setOpen(false); }, [closeSignal]);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

  useEffect(() => {
    const onState = async (event: Event) => {
      const detail = (event as CustomEvent<StatusDetail>).detail;
      setStatus(detail);
      if (detail.conflictCount) {
        const meta = await storageService.get<{ conflicts?: Array<{ id: string; entityType: string; entityId: string; localPayload?: any }> }>(STORES.SYNC, userKey);
        setConflicts(meta?.conflicts || []);
      } else setConflicts([]);
    };
    window.addEventListener('goalflow:sync-state', onState);
    return () => window.removeEventListener('goalflow:sync-state', onState);
  }, [userKey]);

  const labels: Record<SyncState, string> = {
    'saved-locally': 'Saved locally', syncing: 'Syncing', synced: 'Synced', offline: 'Offline', error: 'Sync error', conflict: 'Syncing saved changes'
  };
  const color = status.state === 'synced' ? 'bg-emerald-500' : status.state === 'error' || status.state === 'conflict' ? 'bg-amber-500' : status.state === 'offline' ? 'bg-gray-400' : 'bg-indigo-500';

  return (
    <div className="min-w-0">
      <button ref={buttonRef} type="button" onClick={() => setOpen(value => !value)} aria-label={`Sync status: ${labels[status.state]}`} aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog" className="header-control sync-status-control text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-slate-700" title={status.lastSuccessfulSync ? `Last synced ${new Date(status.lastSuccessfulSync).toLocaleString()}` : status.message || labels[status.state]}>
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${color} ${status.state === 'syncing' ? 'animate-pulse' : ''}`} />
        <span className="app-header__sync-label">{labels[status.state]}</span>
      </button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="Sync status" variant="popover" id={panelId} anchorRef={buttonRef} returnFocusRef={buttonRef}>
        <div className="p-4 break-words">
          <p className="font-bold text-gray-900 dark:text-white">{labels[status.state]}</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{status.lastSuccessfulSync ? `Last successful sync: ${new Date(status.lastSuccessfulSync).toLocaleString()}` : status.message || 'Changes remain available on this device.'}</p>
          {status.state === 'error' && <button type="button"
            onClick={() => window.dispatchEvent(new Event('goalflow:sync-retry'))}
            className="mt-3 min-h-11 rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold text-gray-700 dark:border-slate-600 dark:text-gray-200">
            Retry sync
          </button>}
          {conflicts.length > 0 && <div className="mt-3 border-t border-gray-100 pt-3 dark:border-slate-700">
            <p className="text-sm text-gray-700 dark:text-gray-200">{conflicts.length} saved {conflicts.length === 1 ? 'change is' : 'changes are'} waiting to sync.</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">The cloud keeps the newest version automatically. You can keep working.</p>
            {status.state !== 'error' && <button type="button" onClick={() => window.dispatchEvent(new Event('goalflow:sync-retry'))}
              className="mt-2 min-h-11 rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold text-gray-700 dark:border-slate-600 dark:text-gray-200">Retry sync</button>}
          </div>}
        </div>
      </Modal>
    </div>
  );
};
