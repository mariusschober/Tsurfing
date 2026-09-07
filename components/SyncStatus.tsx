import React, { useEffect, useState, useRef } from 'react';
import { type SyncState } from '../services/cloudSync';
import { storageService, STORES } from '../services/storage';

interface StatusDetail {
  state: SyncState;
  userKey?: string;
  lastSuccessfulSync?: string;
  conflictCount?: number;
  message?: string;
  localFailure?: boolean;
  localRecovery?: boolean;
}

export const SyncStatus: React.FC<{ userKey: string }> = ({ userKey }) => {
  const [status, setStatus] = useState<StatusDetail>({ state: navigator.onLine ? 'saved-locally' : 'offline' });
  const [conflicts, setConflicts] = useState<Array<{ id: string; entityType: string; entityId: string; localPayload?: any }>>([]);
  const [open, setOpen] = useState(false);
  const renderedGeneration = useRef(-1);
  const pendingSynced = useRef<{ detail: StatusDetail; generation: number } | null>(null);

  useEffect(() => {
    let stateRevision = 0;
    let stopped = false;
    let lastErrorWasLocal = false;
    renderedGeneration.current = -1;
    pendingSynced.current = null;
    setStatus({ state: navigator.onLine ? 'saved-locally' : 'offline' });
    setConflicts([]);
    const onState = async (event: Event) => {
      const detail = (event as CustomEvent<StatusDetail>).detail;
      if (stopped || detail.userKey !== userKey) return;
      if (detail.localRecovery && !lastErrorWasLocal) return;
      if (detail.state === 'error') lastErrorWasLocal = detail.localFailure === true;
      else lastErrorWasLocal = false;
      const revision = ++stateRevision;
      if (detail.state === 'synced') {
        const snapshot = await storageService.readCommittedSnapshot(userKey).catch(error => {
          if (!stopped && revision === stateRevision) { lastErrorWasLocal = true; setStatus({ state: 'error', message: error instanceof Error ? error.message : 'Local state could not be verified.' }); }
          return null;
        });
        if (stopped || !snapshot || revision !== stateRevision) return;
        if (snapshot.pendingCount || snapshot.meta.outbox.length || snapshot.meta.conflicts.length
          || Object.keys(snapshot.meta.localState?.blocked ?? {}).length) {
          setStatus({ ...detail, state: Object.keys(snapshot.meta.localState?.blocked ?? {}).length ? 'error' : 'saved-locally' });
          return;
        }
        // The commit is durable, but React acknowledges visibility separately.
        setStatus({ ...detail, state: renderedGeneration.current >= snapshot.generation ? 'synced' : 'syncing' });
        pendingSynced.current = { detail, generation: snapshot.generation };
      } else {
        pendingSynced.current = null;
        setStatus(detail);
      }
      if (detail.conflictCount) {
        const meta = await storageService.get<{ conflicts?: Array<{ id: string; entityType: string; entityId: string; localPayload?: any }> }>(STORES.SYNC, userKey);
        if (!stopped && revision === stateRevision) setConflicts(meta?.conflicts || []);
      } else setConflicts([]);
    };
    const onHydrated = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.userKey !== userKey) return;
      if (!Number.isSafeInteger(detail.generation) || detail.generation < renderedGeneration.current) return;
      renderedGeneration.current = detail.generation;
      if (pendingSynced.current && detail.generation >= pendingSynced.current.generation) {
        void onState(new CustomEvent('goalflow:sync-state', { detail: pendingSynced.current.detail }));
      }
    };
    const onCaptured = (event: Event) => {
      if ((event as CustomEvent).detail?.userKey !== userKey) return;
      stateRevision++;
      pendingSynced.current = null;
      setStatus(previous => previous.state === 'error' ? previous : { state: 'saved-locally', message: 'Captured locally; committing.' });
    };
    const onCommit = async (event: Event) => {
      if ((event as CustomEvent).detail?.userKey !== userKey) return;
      const revision = ++stateRevision;
      pendingSynced.current = null;
      setStatus(previous => previous.state === 'synced' ? { ...previous, state: 'syncing', message: 'Updating local view.' } : previous);
      const snapshot = await storageService.readCommittedSnapshot(userKey).catch(error => {
          if (!stopped && revision === stateRevision) { lastErrorWasLocal = true; setStatus({ state: 'error', message: error instanceof Error ? error.message : 'Local state could not be verified.' }); }
          return null;
        });
        if (stopped || !snapshot || revision !== stateRevision) return;
      const blocked = Object.values<string>(snapshot.meta.localState?.blocked ?? {});
      if (blocked.length) { lastErrorWasLocal = true; setStatus({ state: 'error', message: blocked[0] }); }
      else if (snapshot.pendingCount || snapshot.meta.outbox.length || snapshot.meta.conflicts.length) setStatus(previous => previous.state === 'error' ? previous : { state: 'saved-locally', message: 'Waiting for cloud acknowledgment.' });
    };
    window.addEventListener('goalflow:sync-state', onState);
    window.addEventListener('goalflow:view-hydrated', onHydrated);
    window.addEventListener('goalflow:captured', onCaptured);
    window.addEventListener('goalflow:committed', onCommit);
    return () => {
      stopped = true;
      stateRevision++;
      window.removeEventListener('goalflow:sync-state', onState);
      window.removeEventListener('goalflow:view-hydrated', onHydrated);
      window.removeEventListener('goalflow:captured', onCaptured);
      window.removeEventListener('goalflow:committed', onCommit);
    };
  }, [userKey]);

  const labels: Record<SyncState, string> = {
    'saved-locally': 'Saved locally', syncing: 'Syncing', synced: 'Synced', offline: 'Offline', error: 'Sync error', conflict: 'Syncing saved changes'
  };
  const color = status.state === 'synced' ? 'bg-emerald-500' : status.state === 'error' || status.state === 'conflict' ? 'bg-amber-500' : status.state === 'offline' ? 'bg-gray-400' : 'bg-indigo-500';

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(value => !value)} className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs font-bold text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-slate-700" title={status.message || (status.lastSuccessfulSync ? `Last synced ${new Date(status.lastSuccessfulSync).toLocaleString()}` : undefined)}>
        <span className={`h-2 w-2 rounded-full ${color} ${status.state === 'syncing' ? 'animate-pulse' : ''}`} />
        <span className="hidden lg:inline">{labels[status.state]}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-gray-200 bg-white p-4 shadow-lg dark:border-slate-700 dark:bg-slate-800">
          <p className="font-bold text-gray-900 dark:text-white">{labels[status.state]}</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{status.message || (status.lastSuccessfulSync ? `Last successful sync: ${new Date(status.lastSuccessfulSync).toLocaleString()}` : 'Changes remain available on this device.')}</p>
          {status.state === 'error' && <button type="button"
            onClick={() => window.dispatchEvent(new Event('goalflow:sync-retry'))}
            className="mt-3 rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold text-gray-700 dark:border-slate-600 dark:text-gray-200">
            Retry sync
          </button>}
          {conflicts.length > 0 && <div className="mt-3 border-t border-gray-100 pt-3 dark:border-slate-700">
            <p className="text-sm text-gray-700 dark:text-gray-200">{conflicts.length} saved {conflicts.length === 1 ? 'change is' : 'changes are'} waiting to sync.</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">The cloud keeps the newest version automatically. You can keep working.</p>
            {status.state !== 'error' && <button type="button" onClick={() => window.dispatchEvent(new Event('goalflow:sync-retry'))}
              className="mt-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold text-gray-700 dark:border-slate-600 dark:text-gray-200">Retry sync</button>}
          </div>}
        </div>
      )}
    </div>
  );
};
