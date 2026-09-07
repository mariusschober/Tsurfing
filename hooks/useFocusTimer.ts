import { useState, useEffect, useRef, useCallback } from 'react';
import {
  focusSessionElapsedSeconds,
  focusSessionRemainingSeconds,
  type FocusSessionRecord
} from '../src/domain/focusSession';

type TimerType = 'countdown' | 'stopwatch';

interface TimerSettings {
  taskDurationInMinutes?: number;
  onExpire?: () => void;
  taskId?: string;
  /** Breaks retain their short-lived local timer until the break flow lands in the shared session model. */
  sharedSession?: boolean;
  focusSession?: FocusSessionRecord | null;
  onStart?: (taskId: string, plannedDurationSeconds: number) => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  onExtend?: (deltaSeconds: number) => void;
}

interface LocalTimerState {
  taskId: string | undefined;
  startTime: number;
  pausedAt: number | null;
  elapsedBeforePause: number;
  isActive: boolean;
  hasExpired: boolean;
}

const initialLocalState = (taskId: string | undefined): LocalTimerState => ({
  taskId,
  startTime: Date.now(),
  pausedAt: Date.now(),
  elapsedBeforePause: 0,
  isActive: false,
  hasExpired: false
});

/**
 * Renders a timer from the shared action record. The ticker only advances a
 * local display clock; it never writes a durable value. A small local mode is
 * retained for the existing break overlay, whose parent flow owns migration.
 */
export const useFocusTimer = (settings: TimerSettings) => {
  const {
    taskDurationInMinutes,
    onExpire,
    taskId,
    sharedSession = true,
    focusSession,
    onStart,
    onPause,
    onResume,
    onStop,
    onExtend
  } = settings;
  const timerType: TimerType = typeof taskDurationInMinutes === 'number' && taskDurationInMinutes > 0
    ? 'countdown'
    : 'stopwatch';
  const plannedDurationSeconds = Math.max(60, Math.round((taskDurationInMinutes || 25) * 60));
  const [localState, setLocalState] = useState<LocalTimerState>(() => initialLocalState(taskId));
  const [nowMillis, setNowMillis] = useState(() => Date.now());
  const expiryNotifiedRef = useRef<string | null>(null);

  const activeSession = sharedSession ? focusSession ?? null : null;
  const matchingSession = activeSession?.taskId === taskId ? activeSession : null;
  const sharedElapsedSeconds = matchingSession ? focusSessionElapsedSeconds(matchingSession, new Date(nowMillis)) : 0;
  const sharedRemainingSeconds = matchingSession
    ? focusSessionRemainingSeconds(matchingSession, new Date(nowMillis))
    : plannedDurationSeconds;
  const localElapsedSeconds = localState.elapsedBeforePause + (!localState.pausedAt
    ? Math.max(0, Math.floor((nowMillis - localState.startTime) / 1_000))
    : 0);
  const elapsedSeconds = sharedSession ? sharedElapsedSeconds : localElapsedSeconds;
  const isActive = sharedSession ? matchingSession?.phase === 'active' : localState.isActive && !localState.pausedAt;
  const hasExpired = sharedSession
    ? Boolean(matchingSession?.phase === 'active' && sharedRemainingSeconds <= 0)
    : localState.hasExpired;
  const displaySeconds = timerType === 'countdown'
    ? Math.max(0, sharedSession ? sharedRemainingSeconds : plannedDurationSeconds - localElapsedSeconds)
    : Math.max(0, elapsedSeconds);

  // The timer's clock is intentionally ephemeral. A passive client may show
  // overtime but cannot publish pause, stop, or completion at expiry.
  useEffect(() => {
    if (!isActive) {
      setNowMillis(Date.now());
      return undefined;
    }
    const tick = window.setInterval(() => setNowMillis(Date.now()), 250);
    return () => window.clearInterval(tick);
  }, [isActive]);

  useEffect(() => {
    if (!sharedSession || !matchingSession || !hasExpired || timerType !== 'countdown') return;
    if (expiryNotifiedRef.current === matchingSession.sessionId) return;
    expiryNotifiedRef.current = matchingSession.sessionId;
    onExpire?.();
  }, [sharedSession, matchingSession, hasExpired, timerType, onExpire]);

  useEffect(() => {
    if (!sharedSession && localState.isActive && timerType === 'countdown'
      && taskDurationInMinutes && localElapsedSeconds >= taskDurationInMinutes * 60
      && !localState.hasExpired) {
      setLocalState(previous => ({
        ...previous,
        isActive: false,
        pausedAt: Date.now(),
        elapsedBeforePause: localElapsedSeconds,
        hasExpired: true
      }));
      onExpire?.();
    }
  }, [sharedSession, localState.isActive, localState.hasExpired, timerType, taskDurationInMinutes, localElapsedSeconds, onExpire]);

  useEffect(() => {
    if (localState.taskId !== taskId) setLocalState(initialLocalState(taskId));
  }, [localState.taskId, taskId]);

  const toggleTimer = useCallback(() => {
    if (sharedSession) {
      if (!taskId) return;
      if (activeSession && activeSession.taskId !== taskId
        && (activeSession.phase === 'active' || activeSession.phase === 'paused')) return;
      if (!matchingSession || matchingSession.phase === 'stopped' || matchingSession.phase === 'completed') {
        onStart?.(taskId, plannedDurationSeconds);
      } else if (matchingSession.phase === 'active') {
        onPause?.();
      } else if (matchingSession.phase === 'paused') {
        onResume?.();
      }
      return;
    }
    setLocalState(previous => {
      const now = Date.now();
      if (previous.isActive && !previous.pausedAt) {
        return {
          ...previous,
          isActive: false,
          pausedAt: now,
          elapsedBeforePause: previous.elapsedBeforePause + Math.max(0, Math.floor((now - previous.startTime) / 1_000))
        };
      }
      return { ...previous, isActive: true, pausedAt: null, startTime: now, hasExpired: false };
    });
  }, [sharedSession, taskId, activeSession, matchingSession, plannedDurationSeconds, onStart, onPause, onResume]);

  const pause = useCallback(() => {
    if (sharedSession) onPause?.();
    else setLocalState(previous => {
      if (!previous.isActive || previous.pausedAt) return previous;
      const now = Date.now();
      return {
        ...previous,
        isActive: false,
        pausedAt: now,
        elapsedBeforePause: previous.elapsedBeforePause + Math.max(0, Math.floor((now - previous.startTime) / 1_000))
      };
    });
  }, [sharedSession, onPause]);

  const resume = useCallback(() => {
    if (sharedSession) onResume?.();
    else toggleTimer();
  }, [sharedSession, onResume, toggleTimer]);

  const resetTimer = useCallback(() => {
    if (sharedSession) {
      onStop?.();
      return;
    }
    setLocalState(initialLocalState(taskId));
  }, [sharedSession, onStop, taskId]);

  const addTime = useCallback((minutes: number) => {
    const deltaSeconds = Math.round(minutes * 60);
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    if (sharedSession) {
      onExtend?.(deltaSeconds);
      if (matchingSession?.phase === 'paused') onResume?.();
      return;
    }
    setLocalState(previous => ({
      ...previous,
      elapsedBeforePause: Math.max(0, previous.elapsedBeforePause - deltaSeconds),
      hasExpired: false,
      isActive: true,
      pausedAt: null,
      startTime: Date.now()
    }));
  }, [sharedSession, onExtend, matchingSession, onResume]);

  return {
    displaySeconds,
    elapsedSeconds,
    isActive: Boolean(isActive),
    hasExpired,
    timerType,
    toggleTimer,
    pause,
    resume,
    resetTimer,
    addTime
  };
};
