import { useMemo } from 'react';
import type { Task } from '../types';
import type { PlanningPenalty } from '../src/domain/deliberatePlanning';
import { useDeliberatePlanning } from '../hooks/useDeliberatePlanning';
import { compareQueueCandidates } from '../src/domain/scheduling';
import { Modal } from './Modal';

/** A saved day keeps its own scope, allowance and confirmation identity. */
export function SavedPlanningDay({ accountId, localDate, tasks, setting, onClose }: {
  accountId: string; localDate: string; tasks: Task[]; setting: PlanningPenalty; onClose: () => void;
}) {
  const available = useMemo(() => tasks.filter(task => !task.completed && !task.wontDo && !task.deletedAt
    && (!task.lifecycleStatus || task.lifecycleStatus === 'open') && task.schedulePrecision !== 'month'
    && (task.scheduledFor ?? task.dateAssigned) === localDate).sort(compareQueueCandidates), [tasks, localDate]);
  const planning = useDeliberatePlanning(accountId, localDate, available, setting, true, true);
  const buttonClass = 'min-h-11 rounded-lg border px-3 py-2 disabled:opacity-50';
  return <Modal isOpen onClose={onClose} title={`Saved order · ${localDate}`} variant="navigation">
    <div className="space-y-4">
      <p className="text-sm">Changes here belong to {localDate}. Today’s order and allowance stay separate.</p>
      {planning.review ? <>
        <p>Both orders are saved. Reviewing your proposal costs nothing. A changed confirmation may cost {planning.reviewCost ?? '…'} XP.</p>
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} disabled={planning.busy || planning.reviewCost === null} onClick={() => void planning.resolveReview('synced')}>Keep synced order</button>
          <button className={buttonClass} disabled={planning.busy || planning.reviewCost === null} onClick={() => void planning.resolveReview('draft')}>Review my order</button>
        </div>
      </> : planning.draft ? <>
        {!planning.active && <button className={buttonClass} disabled={planning.busy} onClick={() => planning.staleDraft ? void planning.reviewDraft() : planning.resume()}>Review saved order</button>}
        {planning.active && <>
          <ol className="list-decimal space-y-2 pl-6">{planning.projectedTasks.map(task => <li key={task.id}>{task.title}</li>)}</ol>
          {!planning.projectedTasks.length && <p>No open tasks remain on this date.</p>}
          <p className="text-sm">Confirming this order costs {planning.confirmationCost} XP. Completed or rescheduled tasks are excluded.</p>
          <button className={buttonClass} disabled={planning.busy || planning.staleDraft} onClick={() => void planning.confirm()}>Confirm order for {localDate}</button>
        </>}
        <button className={buttonClass} disabled={planning.busy} onClick={() => void planning.discard()}>Discard saved changes</button>
      </> : <p>{planning.pending ? 'This date’s confirmed order is waiting to sync.' : planning.loaded ? 'No unresolved order changes remain for this date.' : 'Loading saved order…'}</p>}
      {planning.error && <p role="alert" className="text-red-700 dark:text-red-300">{planning.error}</p>}
    </div>
  </Modal>;
}
