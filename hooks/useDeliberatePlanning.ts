import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../types';
import { storageService } from '../services/storage';
import { initialPlanningPolicy, nextReplanCost, reconcilePlanningOrder, relativeOrderChanged, type ConfirmOrder,
  type DailyPlanningPolicy, type PlanningDraft, type PlanningPenalty } from '../src/domain/deliberatePlanning';

export function useDeliberatePlanning(accountId: string, localDate: string, tasks: Task[], setting: PlanningPenalty,
  visible: boolean, ready: boolean) {
  const [policy, setPolicy] = useState<DailyPlanningPolicy>(() => initialPlanningPolicy(accountId, localDate));
  const [draft, setDraft] = useState<PlanningDraft | null>(null);
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [otherDates, setOtherDates] = useState<string[]>([]);
  const [review, setReview] = useState<Awaited<ReturnType<typeof storageService.readDailyPlanning>>['pending'][number] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<PlanningDraft | null>(null);
  const saveRef = useRef<Promise<unknown>>(Promise.resolve());
  const scope = `${accountId}:${localDate}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const wasVisible = useRef(visible);
  const retryRef = useRef<ConfirmOrder | null>(null);

  const refresh = useCallback(async () => {
    const capturedScope = scope;
    await saveRef.current;
    const state = await storageService.readDailyPlanning(accountId, localDate);
    if (scopeRef.current !== capturedScope) return;
    setReview(state.pending.find(item => item.review) ?? null);
    setOtherDates(state.otherDates);
    setPolicy(state.policy); setPending(state.pending.length > 0); setLoaded(true);
    draftRef.current = state.draft; setDraft(state.draft);
  }, [accountId, localDate, scope]);
  useEffect(() => {
    setPolicy(initialPlanningPolicy(accountId, localDate)); setDraft(null); draftRef.current = null;
    setActive(false); setLoaded(false); setError(null); setPending(false); retryRef.current = null;
    setBusy(false); setReview(null); setOtherDates([]); saveRef.current = Promise.resolve();
    if (!ready) return;
    void refresh().catch(error => { if (scopeRef.current === scope) setError(error.message); });
    const onCommit = (event: Event) => {
      if ((event as CustomEvent).detail?.userKey === accountId) void refresh().catch(error => {
        if (scopeRef.current === scope) setError(error.message);
      });
    };
    window.addEventListener('goalflow:committed', onCommit);
    window.addEventListener('goalflow:planning-change', onCommit);
    return () => {
      window.removeEventListener('goalflow:committed', onCommit);
      window.removeEventListener('goalflow:planning-change', onCommit);
    };
  }, [accountId, localDate, ready, refresh, scope]);
  useEffect(() => {
    if (wasVisible.current && !visible && draftRef.current) setActive(false);
    wasVisible.current = visible;
  }, [visible]);

  const cost = nextReplanCost(policy, setting);
  const staleDraft = Boolean(draft && draft.baselineRevision !== policy.revision);
  const persistDraft = useCallback((next: PlanningDraft) => {
    draftRef.current = next; setDraft(next); setError(null); retryRef.current = null;
    const capturedScope = scope;
    const saved = saveRef.current.catch(() => undefined).then(() => storageService.savePlanningDraft(next));
    saveRef.current = saved;
    void saved.catch(error => { if (scopeRef.current === capturedScope) setError(error.message); });
  }, [scope]);
  const begin = useCallback(() => {
    if (!loaded || busy || review) return null;
    const next = draftRef.current ?? { schemaVersion: 1 as const, accountId, localDate, baselineRevision: policy.revision,
      proposedOrder: tasks.map(task => task.id), ratings: [], priorityChanges: [], maximumAcceptedXp: cost, updatedAt: new Date().toISOString() };
    setActive(true); persistDraft(next); return next;
  }, [loaded, busy, review, accountId, localDate, policy.revision, tasks, cost, persistDraft]);
  const editing = loaded && !busy && !review && !staleDraft && (active || (!policy.revision && !draft));
  const projectedTasks = useMemo(() => {
    if (!draft || !active) return tasks;
    const ratings = new Map(draft.ratings.map(rating => [rating.taskId, rating]));
    const promoted = new Set(draft.priorityChanges?.map(change => change.taskId));
    const values = tasks.map(task => ({ ...task, ...(ratings.has(task.id) ? { excitement: ratings.get(task.id)!.excitement, roi: ratings.get(task.id)!.roi } : {}),
      ...(promoted.has(task.id) ? { isFrog: true } : {}) }));
    const byId = new Map(values.map(task => [task.id, task]));
    return reconcilePlanningOrder(draft.proposedOrder, values.map(task => ({ id: task.id,
      precedence: task.beforeFrog && task.habitId ? 0 : task.isFrog ? 1 : 2 }))).map((id, index) => ({ ...byId.get(id)!, plannedOrder: index }));
  }, [tasks, draft, active]);
  const confirmationCost = policy.revision && relativeOrderChanged(
    policy.confirmedOrder.filter(id => tasks.some(task => task.id === id)), projectedTasks.map(task => task.id)) ? cost : 0;
  const reorder = useCallback((taskId: string, index: number) => {
    if (!editing) return;
    const next = draftRef.current ?? begin();
    if (!next) return;
    const ids = projectedTasks.map(task => task.id).filter(id => id !== taskId);
    if (!projectedTasks.some(task => task.id === taskId)) return;
    ids.splice(Math.max(0, Math.min(index, ids.length)), 0, taskId);
    persistDraft({ ...next, proposedOrder: ids, updatedAt: new Date().toISOString() }); setActive(true);
  }, [editing, begin, projectedTasks, persistDraft]);
  const prioritize = useCallback((updates: Record<string, { excitement: number; roi: number }>) => {
    if (!editing) return;
    const next = draftRef.current ?? begin();
    if (!next) return;
    const ratings = new Map(next.ratings.map(rating => [rating.taskId, rating]));
    for (const [taskId, rating] of Object.entries(updates)) ratings.set(taskId, { taskId, ...rating });
    const order = [...projectedTasks].sort((a, b) => {
      const left = ratings.get(a.id) ?? a, right = ratings.get(b.id) ?? b;
      return ((right.excitement ?? 0) * 1.5 + (right.roi ?? 0)) - ((left.excitement ?? 0) * 1.5 + (left.roi ?? 0));
    }).map(task => task.id);
    persistDraft({ ...next, ratings: [...ratings.values()], proposedOrder: order, updatedAt: new Date().toISOString() }); setActive(true);
  }, [editing, begin, projectedTasks, persistDraft]);
  const promoteFrog = useCallback((taskId: string) => {
    const next = begin();
    if (!next) return;
    persistDraft({ ...next, priorityChanges: [...(next.priorityChanges ?? []).filter(change => change.taskId !== taskId), { taskId, isFrog: true }],
      updatedAt: new Date().toISOString() });
  }, [begin, persistDraft]);
  const discard = useCallback(async () => {
    const capturedScope = scope;
    setBusy(true);
    try {
      await saveRef.current.catch(() => undefined);
      await storageService.discardPlanningDraft(accountId, localDate);
      if (scopeRef.current !== capturedScope) return;
      draftRef.current = null; setDraft(null); setActive(false); setError(null); retryRef.current = null;
      saveRef.current = Promise.resolve();
    } catch (error) { if (scopeRef.current === capturedScope) setError(error instanceof Error ? error.message : 'The draft could not be discarded.'); }
    finally { if (scopeRef.current === capturedScope) setBusy(false); }
  }, [accountId, localDate, scope]);
  const reviewDraft = useCallback(async () => {
    const saved = draftRef.current;
    if (!saved || busy) return;
    const capturedScope = scope;
    setBusy(true);
    try {
      await saveRef.current;
      const next = { ...saved, baselineRevision: policy.revision, maximumAcceptedXp: cost, updatedAt: new Date().toISOString() };
      await storageService.savePlanningDraft(next);
      if (scopeRef.current !== capturedScope) return;
      draftRef.current = next; setDraft(next); setActive(true); setError(null); retryRef.current = null;
    } catch (error) {
      if (scopeRef.current === capturedScope) setError(error instanceof Error ? error.message : 'The saved order could not be opened for review.');
    } finally { if (scopeRef.current === capturedScope) setBusy(false); }
  }, [busy, scope, policy.revision, cost]);
  const confirm = useCallback(async () => {
    if (!loaded || busy || review || staleDraft) return false;
    const capturedScope = scope;
    const current = draftRef.current;
    const command: ConfirmOrder = retryRef.current ?? { schemaVersion: 1, operationId: crypto.randomUUID(), accountId, localDate,
      baselineRevision: current ? current.baselineRevision : policy.revision, proposedOrder: current?.proposedOrder ?? tasks.map(task => task.id),
      ratings: current?.ratings ?? [], priorityChanges: current?.priorityChanges ?? [], maximumAcceptedXp: confirmationCost, capturedAt: new Date().toISOString() };
    retryRef.current = command; setBusy(true); setError(null);
    try {
      await saveRef.current;
      const result = await storageService.confirmPlanningOrder(command);
      if (scopeRef.current !== capturedScope) return false;
      retryRef.current = null;
      await refresh();
      if (result.receipt.code !== 'APPLIED') {
        setError(result.receipt.code === 'STALE_REVISION' ? 'The confirmed order changed. Your draft is preserved for review.' : 'The replan cost changed. Review the cost before confirming.');
        return false;
      }
      setActive(false); return true;
    } catch (error) {
      if (scopeRef.current === capturedScope) setError(error instanceof Error ? error.message : 'Your order could not be confirmed.');
      return false;
    } finally { if (scopeRef.current === capturedScope) setBusy(false); }
  }, [loaded, busy, review, staleDraft, scope, accountId, localDate, policy.revision, tasks, confirmationCost, refresh]);
  const resolveReview = useCallback(async (choice: 'synced' | 'draft') => {
    if (!review || busy) return;
    const capturedScope = scope;
    setBusy(true); setError(null);
    try {
      await saveRef.current;
      await storageService.resolvePlanningReview(accountId, review.command.operationId, choice);
      if (scopeRef.current !== capturedScope) return;
      await refresh(); setActive(choice === 'draft'); retryRef.current = null;
    } catch (error) {
      if (scopeRef.current === capturedScope) setError(error instanceof Error ? error.message : 'The order could not be resolved.');
    } finally { if (scopeRef.current === capturedScope) setBusy(false); }
  }, [review, busy, scope, accountId, refresh]);
  const reviewCost = review?.reviewSnapshots?.length ? nextReplanCost(review.reviewSnapshots.at(-1)!.policy as DailyPlanningPolicy, setting) : null;
  return { otherDates, review, reviewCost, resolveReview, policy, draft, staleDraft, reviewDraft, active, pending, loaded, busy, error, cost, confirmationCost, editing, projectedTasks,
    begin, resume: () => setActive(true), reorder, prioritize, promoteFrog, discard, confirm };
}
