

import { useState, useEffect, useCallback, useRef, useMemo, type Dispatch, type SetStateAction } from 'react';
import { Task, Stats, Session, Goal, UserProgress, FlowState, HashtagConfig, Habit, AccountabilityConfig, TrueNorthGoal, GamificationEvent, CircadianState } from '../types';
import { getTodayYYYYMMDD } from '../utils/dateUtils';
import { parseTitleForExtras } from '../utils/timeAndTagParser';
import { storageService, STORES } from '../services/storage';
import { assertSchedule, compareQueueCandidates } from '../src/domain/scheduling';
import { v5 as uuidv5 } from 'uuid';

const HABIT_TASK_NAMESPACE = 'c3e4bcbb-9f56-4ff5-a3a8-9f7478284169';

export interface UserSettings {
    enableAi: boolean;
    penaltyMode?: 'off' | 'gentle' | 'classic';
}

const XP_PER_TASK = 10;
const XP_PER_FROG_MULTIPLIER = 3; 
const XP_GOAL_SYNERGY_BONUS = 15;

// P1-2: debounced persist to avoid IndexedDB flood on rapid keystrokes
export function useDebouncedCallback<T extends (...args: Parameters<T>) => ReturnType<T>>(callback: T, delay: number): T {
  const timerRef = useRef<number | undefined>(undefined);
  const callbackRef = useRef(callback);
  useEffect(() => { callbackRef.current = callback; }, [callback]);
  const debounced = useCallback((...args: Parameters<T>) => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => callbackRef.current(...args), delay) as unknown as number;
  }, [delay]) as T;
  useEffect(() => () => { if (timerRef.current !== undefined) window.clearTimeout(timerRef.current); }, []);
  return debounced;
} 
const XP_HABIT_SETUP_BONUS = 50;
const BASE_XP_FOR_LEVEL = 100;

interface DailyTracking {
    date: string;
    planViewCount: number;
    dailyPostponeCount: number;
}

export interface DurableDailyPlan {
    id: string;
    localDate: string;
    taskIds: string[];
    confirmedAt: number;
}

const isRealLocalDate = (value: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const normalizeDailyPlans = (value: unknown): DurableDailyPlan[] => {
    if (!Array.isArray(value)) throw new Error('Stored daily planning decisions are damaged. They were not discarded.');
    const seen = new Set<string>();
    return value.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`Stored daily planning decision ${index} is invalid.`);
        }
        const record = item as Record<string, unknown>;
        const localDate = String(record.localDate ?? record.id ?? '');
        const taskIds = record.taskIds;
        const confirmedAt = Number(record.confirmedAt);
        if (!isRealLocalDate(localDate) || record.id !== localDate || seen.has(localDate)
            || !Array.isArray(taskIds) || taskIds.some(id => typeof id !== 'string' || !id)
            || !Number.isSafeInteger(confirmedAt) || confirmedAt <= 0) {
            throw new Error(`Stored daily planning decision ${index} is invalid or duplicated.`);
        }
        seen.add(localDate);
        return { id: localDate, localDate, taskIds: taskIds.map(String), confirmedAt };
    });
};

const parseLegacyDailyPlan = (raw: string, confirmedAt: number): DurableDailyPlan | null => {
    let value: unknown;
    try { value = JSON.parse(raw); } catch (_) { value = raw; }
    if (typeof value === 'string') {
        if (!isRealLocalDate(value)) throw new Error('A legacy daily planning decision is damaged. It was not discarded.');
        return { id: value, localDate: value, taskIds: [], confirmedAt };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('A legacy daily planning decision is damaged. It was not discarded.');
    }
    const record = value as Record<string, unknown>;
    const localDate = String(record.localDate ?? record.date ?? '');
    if (!isRealLocalDate(localDate) || !Array.isArray(record.taskIds)
        || record.taskIds.some(id => typeof id !== 'string' || !id)) {
        throw new Error('A legacy daily planning decision is damaged. It was not discarded.');
    }
    return { id: localDate, localDate, taskIds: record.taskIds.map(String), confirmedAt };
};

const calculateXpToNextLevel = (level: number) => level * BASE_XP_FOR_LEVEL;

const emptyStats = (): Stats => ({
  tasksCompleted: 0,
  frogsEaten: 0,
  timeFocused: 0,
  totalBreakMinutes: 0
});

/**
 * A persistent state transition is staged in a synchronous, read-verified WAL
 * before React is allowed to render it. Hydration and cloud application use
 * the raw setter so they do not manufacture a second local mutation.
 */
const useDurableStoredState = <T,>(initialValue: T, storeName: string, userKey: string): [
  T,
  Dispatch<SetStateAction<T>>,
  Dispatch<SetStateAction<T>>,
  () => T
] => {
  const [value, setRawState] = useState<T>(initialValue);
  const valueRef = useRef(value);

  const setFromStorage = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const next = typeof action === 'function'
      ? (action as (previous: T) => T)(valueRef.current)
      : action;
    valueRef.current = next;
    setRawState(next);
  }, []);

  const setDurably = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const previous = valueRef.current;
    const next = typeof action === 'function'
      ? (action as (current: T) => T)(previous)
      : action;
    storageService.stageLocalValue(storeName, userKey, previous, next);
    valueRef.current = next;
    setRawState(next);
  }, [storeName, userKey]);

  const getCurrent = useCallback(() => valueRef.current, []);
  return [value, setDurably, setFromStorage, getCurrent];
};

/**
 * Daily statistics are persisted as one date-keyed record. Keep that complete
 * record and the active-day view in the same synchronous write-ahead
 * transition so a process death cannot preserve a completion while silently
 * losing its counters.
 */
const useDurableDailyStats = (userKey: string): [
  Stats,
  Dispatch<SetStateAction<Stats>>,
  Record<string, Stats>,
  (value: Record<string, Stats>) => void,
  () => Record<string, Stats>
] => {
  const initial = emptyStats();
  const [stats, setRawStats] = useState<Stats>(initial);
  const [allStats, setRawAllStats] = useState<Record<string, Stats>>({});
  const statsRef = useRef(initial);
  const allStatsRef = useRef<Record<string, Stats>>({});
  const statsDateRef = useRef(getTodayYYYYMMDD());

  const setFromStorage = useCallback((value: Record<string, Stats>) => {
    const nextAll = value || {};
    const today = getTodayYYYYMMDD();
    const nextStats = nextAll[today] || emptyStats();
    allStatsRef.current = nextAll;
    statsRef.current = nextStats;
    statsDateRef.current = today;
    setRawAllStats(nextAll);
    setRawStats(nextStats);
  }, []);

  const setDurably = useCallback<Dispatch<SetStateAction<Stats>>>((action) => {
    const today = getTodayYYYYMMDD();
    const current = statsDateRef.current === today
      ? statsRef.current
      : allStatsRef.current[today] || emptyStats();
    const next = typeof action === 'function'
      ? (action as (previous: Stats) => Stats)(current)
      : action;
    const previousAll = allStatsRef.current;
    const nextAll = { ...previousAll, [today]: next };
    storageService.stageLocalValue(STORES.STATS, userKey, previousAll, nextAll);
    allStatsRef.current = nextAll;
    statsRef.current = next;
    statsDateRef.current = today;
    setRawAllStats(nextAll);
    setRawStats(next);
  }, [userKey]);

  const getCurrent = useCallback(() => allStatsRef.current, []);
  return [stats, setDurably, allStats, setFromStorage, getCurrent];
};

export const useGoalflow = (userKey: string, legacyUserKey = userKey) => {
  // Keys for DB retrieval (User scoped)
  const USER_KEY = userKey;

  // --- State Definitions ---
  const [isLoading, setIsLoading] = useState(true);
  
  const [tasks, setTasks, setTasksFromStorage, getTasks] = useDurableStoredState<Task[]>([], STORES.TASKS, USER_KEY);
  const [goals, setGoals, setGoalsFromStorage, getGoals] = useDurableStoredState<Goal[]>([], STORES.GOALS, USER_KEY);
  const [habits, setHabits, setHabitsFromStorage, getHabits] = useDurableStoredState<Habit[]>([], STORES.HABITS, USER_KEY);
  const [trueNorthGoals, setTrueNorthGoals, setTrueNorthGoalsFromStorage, getTrueNorthGoals] = useDurableStoredState<TrueNorthGoal[]>([], STORES.TRUE_NORTH, USER_KEY);
  const [amalgam, setAmalgam, setAmalgamFromStorage] = useDurableStoredState<string>("My world takes care of me", STORES.AMALGAM, USER_KEY);
  const [hashtagConfigs, setHashtagConfigs, setHashtagConfigsFromStorage] = useDurableStoredState<Record<string, HashtagConfig>>({}, STORES.HASHTAGS, USER_KEY);
  const [stats, setStats, allStats, setAllStatsFromStorage, getAllStats] = useDurableDailyStats(USER_KEY);
  
  const [userProgress, setUserProgress, setUserProgressFromStorage, getUserProgress] = useDurableStoredState<UserProgress>({ level: 1, xp: 0, xpToNextLevel: BASE_XP_FOR_LEVEL }, STORES.PROGRESS, USER_KEY);
  const [dailyTracking, setDailyTracking, setDailyTrackingFromStorage, getDailyTracking] = useDurableStoredState<DailyTracking>({ date: getTodayYYYYMMDD(), planViewCount: 0, dailyPostponeCount: 0 }, STORES.TRACKING, USER_KEY);
  const [accountabilityConfig, setAccountabilityConfig, setAccountabilityConfigFromStorage] = useDurableStoredState<AccountabilityConfig>({ enabled: false, partners: [], scope: 'all', targetHashtags: [] }, STORES.ACCOUNTABILITY, USER_KEY);
  const [circadianState, setCircadianState, setCircadianStateFromStorage, getCircadianState] = useDurableStoredState<CircadianState>({
      lastCheckIn: '', score: 0, mode: 'maintenance', metrics: { sunrise: false, sleepHours: 0, energy: 0, clarity: 0, interest: 0 }
  }, STORES.CIRCADIAN, USER_KEY);
  const [userSettings, setUserSettings, setUserSettingsFromStorage] = useDurableStoredState<UserSettings>({ enableAi: false, penaltyMode: 'off' }, STORES.SETTINGS, USER_KEY);
  const [dailyPlans, setDailyPlans, setDailyPlansFromStorage] = useDurableStoredState<DurableDailyPlan[]>([], STORES.DAILY_PLANS, USER_KEY);
  const cloudAppliedStores = useRef(new Set<string>());

  // Transient State
  const [justLeveledUp, setJustLeveledUp] = useState(false);
  const [gamificationEvent, setGamificationEvent] = useState<GamificationEvent | null>(null);
  const [planningWarning, setPlanningWarning] = useState(false);
  const completedTaskIds = useRef(new Set<string>());

  // --- Initialization (Hydration) ---
  useEffect(() => {
    const loadData = async () => {
      try {
        await storageService.migrateUserKey(legacyUserKey, USER_KEY);
        const [
            lTasks, lGoals, lHabits, lTrueNorth, lAmalgam, lHashtags, lAllStats, lProgress, lDaily, lAccountability, lCircadian, lSettings,
            lDailyPlans
        ] = await Promise.all([
            storageService.migrateFromLocalStorage<Task[]>(STORES.TASKS, USER_KEY, `goalflow_tasks_${legacyUserKey}`, []),
            storageService.migrateFromLocalStorage<Goal[]>(STORES.GOALS, USER_KEY, `goalflow_goals_${legacyUserKey}`, []),
            storageService.migrateFromLocalStorage<Habit[]>(STORES.HABITS, USER_KEY, `goalflow_habits_${legacyUserKey}`, []),
            storageService.migrateFromLocalStorage<TrueNorthGoal[]>(STORES.TRUE_NORTH, USER_KEY, `goalflow_truenorth_${legacyUserKey}`, []),
            storageService.migrateFromLocalStorage<string>(STORES.AMALGAM, USER_KEY, `goalflow_amalgam_${legacyUserKey}`, "My world takes care of me"),
            storageService.migrateFromLocalStorage<any>(STORES.HASHTAGS, USER_KEY, `goalflow_hashtags_${legacyUserKey}`, {}),
            storageService.migrateFromLocalStorage<{ [date: string]: Stats }>(STORES.STATS, USER_KEY, `goalflow_stats_${legacyUserKey}`, {}),
            storageService.migrateFromLocalStorage<UserProgress>(STORES.PROGRESS, USER_KEY, `goalflow_progress_${legacyUserKey}`, { level: 1, xp: 0, xpToNextLevel: BASE_XP_FOR_LEVEL }),
            storageService.migrateFromLocalStorage<DailyTracking>(STORES.TRACKING, USER_KEY, `goalflow_tracking_${legacyUserKey}`, { date: getTodayYYYYMMDD(), planViewCount: 0, dailyPostponeCount: 0 }),
            storageService.migrateFromLocalStorage<AccountabilityConfig>(STORES.ACCOUNTABILITY, USER_KEY, `goalflow_accountability_${legacyUserKey}`, { enabled: false, partners: [], scope: 'all', targetHashtags: [] }),
            storageService.migrateFromLocalStorage<CircadianState>(STORES.CIRCADIAN, USER_KEY, `goalflow_circadian_${legacyUserKey}`, { lastCheckIn: '', score: 0, mode: 'maintenance', metrics: { sunrise: false, sleepHours: 0, energy: 0, clarity: 0, interest: 0 } }),
            storageService.migrateFromLocalStorage<UserSettings>(STORES.SETTINGS, USER_KEY, `goalflow_settings_${legacyUserKey}`, { enableAi: false, penaltyMode: 'off' }),
            (async (): Promise<DurableDailyPlan[]> => {
                const current = await storageService.get<unknown>(STORES.DAILY_PLANS, USER_KEY);
                if (current !== undefined) return normalizeDailyPlans(current);
                const migrationTime = Date.now();
                const legacyKeys = Array.from(new Set([
                    `goalflow-daily-plan:${USER_KEY}`,
                    `goalflow-daily-plan:${legacyUserKey}`
                ]));
                const migrated = new Map<string, DurableDailyPlan>();
                for (const legacyKey of legacyKeys) {
                    const raw = window.localStorage.getItem(legacyKey);
                    if (raw === null) continue;
                    const plan = parseLegacyDailyPlan(raw, migrationTime);
                    if (!plan) continue;
                    const existing = migrated.get(plan.id);
                    if (existing && JSON.stringify(existing.taskIds) !== JSON.stringify(plan.taskIds)) {
                        throw new Error('Legacy daily planning decisions disagree. Neither was discarded.');
                    }
                    migrated.set(plan.id, plan);
                }
                const plans = Array.from(migrated.values());
                if (plans.length) {
                    storageService.stageLocalValue(STORES.DAILY_PLANS, USER_KEY, undefined, plans);
                    await storageService.set(STORES.DAILY_PLANS, USER_KEY, plans);
                }
                return plans;
            })(),
        ]);

        await storageService.createLocalSnapshot(USER_KEY, 'before-migration');
        const normalizedTasks = lTasks.map(task => {
            const migratedLoopNote = task.isRepetitive
                ? `${task.description ? `${task.description}\n\n` : ''}This was migrated from a Loop task. Complete it consciously, then create the next occurrence or convert it to a habit.`
                : task.description;
            return {
                ...task,
                description: migratedLoopNote,
                isRepetitive: false,
                schedulePrecision: task.schedulePrecision || 'day',
                scheduledFor: task.scheduledFor || task.dateAssigned,
                plannedOrder: task.plannedOrder ?? task.createdAt,
                frogFailures: task.frogFailures ?? task.rescheduleCount ?? 0,
                source: task.source || 'migration',
                lifecycleStatus: task.lifecycleStatus || (task.completed ? 'completed' : task.wontDo ? 'dropped' : 'open')
            } as Task;
        });
        setTasksFromStorage(normalizedTasks);
        setGoalsFromStorage(lGoals);
        setHabitsFromStorage(lHabits);
        setTrueNorthGoalsFromStorage(lTrueNorth);
        setAmalgamFromStorage(lAmalgam);
        setHashtagConfigsFromStorage(lHashtags);
        setAllStatsFromStorage(lAllStats);

        const today = getTodayYYYYMMDD();

        // Ensure Progress calculations
        setUserProgressFromStorage({ ...lProgress, xpToNextLevel: calculateXpToNextLevel(lProgress.level) });
        
        // Hydrate the durable baseline before staging a new-day reset. The
        // initial React value already uses today and is not the saved value.
        setDailyTrackingFromStorage(lDaily);
        if (lDaily.date !== today) {
            setDailyTracking({ date: today, planViewCount: 0, dailyPostponeCount: 0 });
        }

        setAccountabilityConfigFromStorage(lAccountability);
        setCircadianStateFromStorage(lCircadian);
        setUserSettingsFromStorage(lSettings);
        setDailyPlansFromStorage(lDailyPlans);
        setIsLoading(false);
      } catch (err) {
          console.error("Failed to hydrate data. Persistence remains blocked so existing data is not overwritten.", err);
      }
    };

    loadData();
  }, [userKey, legacyUserKey]);

  // --- Persistence Wrappers ---
  // Using useRef to prevent effect loops when saving, saving is triggered by state changes.
  // We use a custom hook-like structure inside useEffect to handle debouncing.

  const persist = useCallback(async (store: string, data: any) => {
      try {
          await storageService.set(store, USER_KEY, data);
      } catch (e) {
          console.error(`Failed to persist ${store}`, e);
      }
  }, [USER_KEY]);

  const debouncedPersist = useDebouncedCallback((store: string, data: any) => {
      void persist(store, data);
  }, 300);

  const persistLocalState = useCallback((store: string, data: any) => {
      if (cloudAppliedStores.current.delete(store)) return;
      debouncedPersist(store, data);
  }, [debouncedPersist]);

  // Watchers
  useEffect(() => { if (!isLoading) persistLocalState(STORES.TASKS, tasks); }, [tasks, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.GOALS, goals); }, [goals, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.HABITS, habits); }, [habits, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.TRUE_NORTH, trueNorthGoals); }, [trueNorthGoals, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.AMALGAM, amalgam); }, [amalgam, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.HASHTAGS, hashtagConfigs); }, [hashtagConfigs, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.PROGRESS, userProgress); }, [userProgress, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.TRACKING, dailyTracking); }, [dailyTracking, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.ACCOUNTABILITY, accountabilityConfig); }, [accountabilityConfig, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.CIRCADIAN, circadianState); }, [circadianState, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.SETTINGS, userSettings); }, [userSettings, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.STATS, allStats); }, [allStats, isLoading, persistLocalState]);
  useEffect(() => { if (!isLoading) persistLocalState(STORES.DAILY_PLANS, dailyPlans); }, [dailyPlans, isLoading, persistLocalState]);

  useEffect(() => {
      const applyCloudChange = (event: Event) => {
          const { storeName, value } = (event as CustomEvent<{ storeName: string; value: any }>).detail;
          cloudAppliedStores.current.add(storeName);
          if (storeName === STORES.TASKS) setTasksFromStorage(value || []);
          else if (storeName === STORES.GOALS) setGoalsFromStorage(value || []);
          else if (storeName === STORES.HABITS) setHabitsFromStorage(value || []);
          else if (storeName === STORES.TRUE_NORTH) setTrueNorthGoalsFromStorage(value || []);
          else if (storeName === STORES.AMALGAM) setAmalgamFromStorage(value || 'My world takes care of me');
          else if (storeName === STORES.HASHTAGS) setHashtagConfigsFromStorage(value || {});
          else if (storeName === STORES.PROGRESS) setUserProgressFromStorage(value);
          else if (storeName === STORES.TRACKING) setDailyTrackingFromStorage(value);
          else if (storeName === STORES.ACCOUNTABILITY) setAccountabilityConfigFromStorage(value);
          else if (storeName === STORES.CIRCADIAN) setCircadianStateFromStorage(value);
          else if (storeName === STORES.SETTINGS) setUserSettingsFromStorage(value);
          else if (storeName === STORES.DAILY_PLANS) setDailyPlansFromStorage(normalizeDailyPlans(value || []));
          else if (storeName === STORES.STATS) {
              setAllStatsFromStorage(value || {});
          }
      };
      window.addEventListener('goalflow:cloud-change', applyCloudChange);
      return () => window.removeEventListener('goalflow:cloud-change', applyCloudChange);
  }, [setAllStatsFromStorage, setTasksFromStorage, setGoalsFromStorage, setHabitsFromStorage,
      setTrueNorthGoalsFromStorage, setAmalgamFromStorage, setHashtagConfigsFromStorage,
      setUserProgressFromStorage, setDailyTrackingFromStorage, setAccountabilityConfigFromStorage,
      setCircadianStateFromStorage, setUserSettingsFromStorage, setDailyPlansFromStorage]);

  // --- Logic Exports ---

  const submitBioCheckIn = useCallback((data: CircadianState['metrics'], score: number, mode: CircadianState['mode'], solar?: { sunrise?: string, sunset?: string }) => {
      const previousCircadian = getCircadianState();
      const nextCircadian: CircadianState = {
          lastCheckIn: getTodayYYYYMMDD(),
          metrics: data,
          score,
          mode,
          sunriseTime: solar?.sunrise,
          sunsetTime: solar?.sunset
      };
      const today = getTodayYYYYMMDD();
      const previousAllStats = getAllStats();
      const nextAllStats = {
          ...previousAllStats,
          [today]: {
              ...(previousAllStats[today] || emptyStats()),
              bioLog: data,
              circadianScore: score
          }
      };
      storageService.stageLocalValues(USER_KEY, [
          { storeName: STORES.CIRCADIAN, previousValue: previousCircadian, nextValue: nextCircadian },
          { storeName: STORES.STATS, previousValue: previousAllStats, nextValue: nextAllStats }
      ]);
      setCircadianStateFromStorage(nextCircadian);
      setAllStatsFromStorage(nextAllStats);
      void storageService.flushPendingLocalChanges(USER_KEY).catch(error => {
          console.error('Failed to flush the durable biological check-in transaction.', error);
      });
  }, [USER_KEY, getAllStats, getCircadianState, setAllStatsFromStorage, setCircadianStateFromStorage]);

  const resetCircadianState = useCallback(() => {
      setCircadianState(prev => ({ ...prev, lastCheckIn: '' }));
  }, []);

  const updateUserSettings = useCallback((updates: Partial<UserSettings>) => {
      setUserSettings(prev => ({ ...prev, ...updates }));
  }, []);

  const confirmDailyPlan = useCallback((localDate: string, taskIds: string[]) => {
      if (!isRealLocalDate(localDate) || taskIds.some(id => typeof id !== 'string' || !id)) {
          throw new Error('The daily planning decision is invalid and was not saved.');
      }
      const plan: DurableDailyPlan = {
          id: localDate,
          localDate,
          taskIds: [...taskIds],
          confirmedAt: Date.now()
      };
      setDailyPlans(previous => [...previous.filter(item => item.id !== localDate), plan]);
  }, [setDailyPlans]);

  const clearDailyPlan = useCallback((localDate: string) => {
      setDailyPlans(previous => previous.filter(item => item.id !== localDate));
  }, [setDailyPlans]);

   // --- Habit Generation & Streak Break Logic (P0-3: guard against infinite loop) ---
   const prevHabitGenRef = useRef<{ habitsLen: number; tasksLen: number; today: string } | null>(null);
   useEffect(() => {
       if (isLoading) return;
       const today = getTodayYYYYMMDD();
       const todayDate = new Date();
       const dayOfWeek = todayDate.getDay();
       const prev = prevHabitGenRef.current;
       if (prev && prev.habitsLen === habits.length && prev.tasksLen === tasks.length && prev.today === today) return;
       prevHabitGenRef.current = { habitsLen: habits.length, tasksLen: tasks.length, today };
      
      let newTasks: Task[] = [];
      let habitsUpdated = false;

      let updatedHabits = habits.map(h => ({ ...h }));
      
      const todaysTasks = tasks.filter(t => t.dateAssigned === today);
      const minCreatedAt = todaysTasks.length > 0 
          ? Math.min(...todaysTasks.map(t => t.createdAt)) 
          : Date.now();
      let prependCounter = 1;

      updatedHabits.forEach((habit, index) => {
          if (!habit) return; 

          if (habit.lastCompletedDate) {
              const [lastYear, lastMonth, lastDay] = habit.lastCompletedDate.split('-').map(Number);
              const lastDate = new Date(lastYear, lastMonth - 1, lastDay);
              const diffTime = todayDate.getTime() - lastDate.getTime();
              const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
              
              if (habit.frequency === 'daily' && diffDays > 1) {
                  if (habit.streak > 0) {
                      updatedHabits[index].streak = 0;
                      habitsUpdated = true;
                  }
              }
          }

          let isDue = false;
          if (habit.frequency === 'daily') isDue = true;
          if (habit.frequency === 'specific_days' && habit.specificDays?.includes(dayOfWeek)) isDue = true;

          if (isDue) {
              const exists = tasks.some(t => t && t.habitId === habit.id && t.dateAssigned === today);
              if (!exists) {
                   const newTask: Task = {
                      id: uuidv5(`${habit.id}:${today}`, HABIT_TASK_NAMESPACE),
                      title: habit.title,
                      description: "", 
                      dateAssigned: today,
                      completed: false,
                      isFrog: false,
                      createdAt: habit.isHighPriority ? (minCreatedAt - (prependCounter++ * 1000)) : Date.now(),
                      habitId: habit.id,
                      goalId: habit.goalId, 
                      hashtags: ['habit', ...(habit.hashtags || [])],
                      duration: habit.duration || 25,
                      strikes: 0,
                      rescheduleCount: 0,
                      schedulePrecision: 'day',
                      scheduledFor: today,
                      plannedOrder: 0,
                      frogFailures: 0,
                      beforeFrog: !!habit.beforeFrog,
                      source: 'habit',
                      lifecycleStatus: 'open'
                  };
                  newTasks.push(newTask);
              }
          }
      });

      if (newTasks.length > 0) {
          setTasks(prev => {
              const existingIds = new Set(prev.map(task => task.id));
              return [...prev, ...newTasks.filter(task => !existingIds.has(task.id))];
          });
      }
      if (habitsUpdated) {
          setHabits(updatedHabits);
      }
  }, [habits, tasks, isLoading]); 

  // --- Helper Functions ---
  const checkLevelUp = (currentXp: number, currentLevel: number, currentNext: number) => {
      let xp = currentXp;
      let level = currentLevel;
      let next = currentNext;
      let leveledUp = false;

      while (xp >= next) {
          level += 1;
          xp -= next;
          next = calculateXpToNextLevel(level);
          leveledUp = true;
      }
      return { xp, level, next, leveledUp };
  };

  const applyPenalty = (amount: number, message: string) => {
      if ((userSettings.penaltyMode || 'off') === 'off') return;
      const appliedAmount = userSettings.penaltyMode === 'gentle' ? Math.ceil(amount / 2) : amount;
      setUserProgress(prev => ({
          ...prev,
          xp: Math.max(0, prev.xp - appliedAmount)
      }));
      setGamificationEvent({ type: 'penalty', amount: appliedAmount, message });
  };

  const awardSessionXp = useCallback((amount: number, message: string, type: 'reward' | 'milestone' = 'reward') => {
      setUserProgress(prev => {
          const { xp, level, next, leveledUp } = checkLevelUp(prev.xp + amount, prev.level, prev.xpToNextLevel);
          if (leveledUp) setJustLeveledUp(true);
          return { level, xp, xpToNextLevel: next };
      });
      setGamificationEvent({ type, amount, message });
  }, []);

  const trackPlanVisit = () => {
      setDailyTracking(prev => {
          const newCount = prev.planViewCount + 1;
          if (newCount === 6) setPlanningWarning(true);
          else if (newCount > 6) applyPenalty(50, "Stop Planning. Start Doing.");
          return { ...prev, planViewCount: newCount };
      });
  };

  const rescheduleTask = (taskId: string, newDate: string): boolean => {
      const currentTasks = getTasks();
      const task = currentTasks.find(t => t.id === taskId);
      if (!task) return false;
      if (task.isFrog) return false;

      const today = getTodayYYYYMMDD();
      const wasToday = task.dateAssigned === today;
      const isPushingToFuture = newDate > task.dateAssigned;

      let becomeFrog = false;

      const previousTracking = getDailyTracking();
      const nextTracking = {
          ...previousTracking,
          dailyPostponeCount: previousTracking.dailyPostponeCount + (wasToday && isPushingToFuture ? 1 : 0)
      };

      const newRescheduleCount = (task.rescheduleCount || 0) + (isPushingToFuture ? 1 : 0);
      if (newRescheduleCount >= 2) {
          becomeFrog = true;
          setGamificationEvent({ type: 'penalty', amount: 0, message: "Task hardened into a Frog." });
      }

      const nextTasks: Task[] = currentTasks.map(t => t.id === taskId ? {
          ...t,
          dateAssigned: newDate,
          schedulePrecision: 'day' as const,
          scheduledFor: newDate,
          plannedOrder: 0,
          session: undefined,
          rescheduleCount: newRescheduleCount,
          frogFailures: newRescheduleCount,
          isFrog: becomeFrog ? true : t.isFrog
      } : t);
      storageService.stageLocalValues(USER_KEY, [
          { storeName: STORES.TASKS, previousValue: currentTasks, nextValue: nextTasks },
          { storeName: STORES.TRACKING, previousValue: previousTracking, nextValue: nextTracking }
      ]);
      setTasksFromStorage(nextTasks);
      setDailyTrackingFromStorage(nextTracking);
      void storageService.flushPendingLocalChanges(USER_KEY).catch(error => {
          console.error('Failed to flush the durable reschedule transaction.', error);
      });
      return true;
  };

  const addTask = useCallback((taskData: any) => {
    const { title, description, dateAssigned, goalId, isFrog, isRepetitive, session, duration, isBreak, schedulePrecision = 'day', scheduledFor } = taskData;
    if (!title.trim()) return;

    const { cleanTitle, duration: pDur, hashtags, dateAssigned: pDate, session: pSess, isFrog: pFrog, isQuickie } = parseTitleForExtras(title);
    
    const finalDate = pDate || dateAssigned || getTodayYYYYMMDD();
    const finalSchedulePrecision: 'day' | 'month' = pDate ? 'day' : schedulePrecision;
    const finalScheduledFor = pDate || scheduledFor || (finalSchedulePrecision === 'month' ? finalDate.slice(0, 7) : finalDate);
    assertSchedule(finalSchedulePrecision, finalScheduledFor, getTodayYYYYMMDD());
    const finalIsFrog = !!isFrog || !!pFrog;
    const finalDuration = duration || pDur || 25; 

    let finalGoalId = goalId;
    if (!finalGoalId && hashtags && hashtags.length > 0) {
        for (const tag of hashtags) {
            if (hashtagConfigs[tag]?.linkedGoalId) {
                finalGoalId = hashtagConfigs[tag].linkedGoalId;
                break;
            }
        }
    }

    setTasks(prev => {
        const isToday = finalDate === getTodayYYYYMMDD();
        let creationTime = Date.now();
        if (isToday && finalIsFrog) {
            const todaysTasks = prev.filter(t => t.dateAssigned === finalDate);
            const minCreatedAt = todaysTasks.length > 0 ? Math.min(...todaysTasks.map(t => t.createdAt)) : Date.now();
            creationTime = minCreatedAt - 1000;
        }

        const newTask: Task = {
          id: crypto.randomUUID(),
          title: cleanTitle,
          description: description,
          dateAssigned: finalDate,
          completed: false,
          isFrog: finalIsFrog,
          isRepetitive: !!isRepetitive,
          isQuickie: !!isQuickie,
          isBreak: !!isBreak,
          createdAt: creationTime,
          duration: finalDuration,
          hashtags,
          goalId: finalGoalId,
          session: session || pSess || (finalIsFrog ? 'morning' : undefined),
          strikes: 0,
          rescheduleCount: 0,
          schedulePrecision: finalSchedulePrecision,
          scheduledFor: finalScheduledFor,
          plannedOrder: 0,
          frogFailures: 0,
          beforeFrog: false,
          source: 'manual',
          lifecycleStatus: 'open'
        };
        return [...prev, newTask];
    });
    
    setHashtagConfigs(prev => {
        if (!hashtags || hashtags.length === 0) return prev;
        const next = { ...prev };
        let changed = false;
        hashtags.forEach((tag: string) => {
            if (!next[tag]) {
                const hue = Math.floor(Math.random() * 360);
                next[tag] = { color: `hsl(${hue}, 70%, 50%)` };
                changed = true;
            }
        });
        return changed ? next : prev;
    });
  }, [hashtagConfigs]);

  const addSubtasks = useCallback((subtasks: any[], parentTask: Task) => {
     const newTasks: Task[] = subtasks.map((st, index) => {
       const schedulePrecision = st.schedulePrecision || parentTask.schedulePrecision || 'day';
       const scheduledFor = st.scheduledFor || (schedulePrecision === 'month'
           ? (parentTask.scheduledFor || parentTask.dateAssigned).slice(0, 7)
           : st.dateAssigned || parentTask.scheduledFor || parentTask.dateAssigned);
       return {
         id: crypto.randomUUID(),
         title: st.title,
         duration: st.duration,
         dateAssigned: schedulePrecision === 'month' ? `${scheduledFor}-01` : scheduledFor,
         session: parentTask.session,
         goalId: parentTask.goalId,
         hashtags: parentTask.hashtags,
         completed: false,
         isFrog: false,
         isQuickie: st.duration <= 2,
         createdAt: Date.now() + index,
         strikes: 0,
         rescheduleCount: 0,
         schedulePrecision,
         scheduledFor,
         plannedOrder: (parentTask.plannedOrder || 0) + index,
         frogFailures: 0,
         beforeFrog: false,
         source: 'manual',
         parentTaskId: parentTask.id,
         lifecycleStatus: 'open'
       } as Task;
     });
     setTasks(prev => [
         ...prev.map(t => t.id === parentTask.id ? {
             ...t,
             completed: true,
             completedAt: Date.now(),
             lifecycleStatus: 'broken_down' as const
         } : t),
         ...newTasks
     ]);
  }, []);

  const updateTask = useCallback((taskId: string, updates: any) => {
    let parsedUpdates = { ...updates };
    const existingTask = tasks.find(task => task.id === taskId);
    if (existingTask?.isFrog) {
        parsedUpdates.isFrog = true;
        const nextScheduledFor = parsedUpdates.scheduledFor || parsedUpdates.dateAssigned || existingTask.scheduledFor || existingTask.dateAssigned;
        const currentScheduledFor = existingTask.scheduledFor || existingTask.dateAssigned;
        if (nextScheduledFor > currentScheduledFor) {
            parsedUpdates.schedulePrecision = existingTask.schedulePrecision;
            parsedUpdates.scheduledFor = existingTask.scheduledFor;
            parsedUpdates.dateAssigned = existingTask.dateAssigned;
        }
    }
    if (updates.title) {
        const { cleanTitle, duration, hashtags } = parseTitleForExtras(updates.title);
        parsedUpdates.title = cleanTitle;
        if (updates.duration === undefined && duration !== undefined) parsedUpdates.duration = duration;
        if (updates.hashtags === undefined) {
             parsedUpdates.hashtags = hashtags;
             if (hashtags.length > 0 && !parsedUpdates.goalId) {
                 for (const tag of hashtags) {
                    if (hashtagConfigs[tag]?.linkedGoalId) {
                        parsedUpdates.goalId = hashtagConfigs[tag].linkedGoalId;
                        break;
                    }
                }
             }
        }
    }
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...parsedUpdates } : t));
  }, [hashtagConfigs, tasks]);

  const deleteTask = useCallback((taskId: string) => {
    const previousTasks = getTasks();
    const task = previousTasks.find(candidate => candidate.id === taskId);
    if (!task || task.deletedAt) return;
    const previousHabits = getHabits();
    const nextTasks = previousTasks.map(candidate => candidate.id === taskId ? {
            // Keep a tombstone in the synced collection. Filtering the row
            // locally would let an old client resurrect it.
            ...candidate,
            completed: true,
            wontDo: true,
            lifecycleStatus: 'archived' as const,
            deletedAt: new Date().toISOString(),
            completedAt: candidate.completedAt || Date.now()
        } : candidate);
    const nextHabits = task.habitId
        ? previousHabits.map(habit => habit.id === task.habitId ? { ...habit, streak: 0 } : habit)
        : previousHabits;
    storageService.stageLocalValues(USER_KEY, [
        { storeName: STORES.TASKS, previousValue: previousTasks, nextValue: nextTasks },
        { storeName: STORES.HABITS, previousValue: previousHabits, nextValue: nextHabits }
    ]);
    setTasksFromStorage(nextTasks);
    if (nextHabits !== previousHabits) setHabitsFromStorage(nextHabits);
    void storageService.flushPendingLocalChanges(USER_KEY).catch(error => {
        console.error('Failed to flush the durable task deletion transaction.', error);
    });
  }, [USER_KEY, getHabits, getTasks, setHabitsFromStorage, setTasksFromStorage]);

  const markWontDo = useCallback((taskId: string) => {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, completed: true, wontDo: true, lifecycleStatus: 'dropped', completedAt: Date.now() } : t));
  }, []);

  const setFrog = useCallback((taskId: string) => {
    setTasks(prev => prev.map(t => t.id === taskId ? {...t, isFrog: true } : t));
  }, []);
  
  const moveTaskToTopToday = useCallback((taskId: string) => {
    setTasks(prev => {
        const today = getTodayYYYYMMDD();
        const todaysTasks = prev.filter(t => t.dateAssigned === today && !t.completed && !t.wontDo);
        const minCreatedAt = todaysTasks.length > 0 ? Math.min(...todaysTasks.map(t => t.createdAt)) : Date.now();
        return prev.map(t => t.id === taskId ? { ...t, dateAssigned: today, createdAt: minCreatedAt - 1000, session: undefined } : t);
    });
  }, []);

  const completeTask = useCallback((taskId: string, actualDuration?: number, flowState?: FlowState, finalDescription?: string) => {
    if (completedTaskIds.current.has(taskId)) return;
    const previousTasks = getTasks();
    const task = previousTasks.find(t => t.id === taskId);
    if (!task || task.completed || task.wontDo || task.deletedAt) return;
    const nextTasks: Task[] = previousTasks.map(t => t.id === taskId ? {
        ...t, completed: true, lifecycleStatus: 'completed' as const, completedAt: Date.now(), actualDuration, flowState, description: finalDescription || t.description
    } : t);
    const today = getTodayYYYYMMDD();
    const previousAllStats = getAllStats();
    const currentStats = previousAllStats[today] || emptyStats();
    const nextAllStats = {
        ...previousAllStats,
        [today]: {
            ...currentStats,
            tasksCompleted: currentStats.tasksCompleted + 1,
            frogsEaten: currentStats.frogsEaten + (task.isFrog ? 1 : 0),
            timeFocused: currentStats.timeFocused + (actualDuration || task.duration || 0)
        }
    };
    const previousGoals = getGoals();
    const nextGoals = task.goalId
        ? previousGoals.map(goal => goal.id === task.goalId
            ? { ...goal, completedTasks: goal.completedTasks + 1 }
            : goal)
        : previousGoals;
    const previousHabits = getHabits();
    let habitStreak = 0;
    const nextHabits = task.habitId
        ? previousHabits.map(habit => {
            if (habit.id !== task.habitId) return habit;
            habitStreak = habit.streak + 1;
            return {
                ...habit,
                streak: habitStreak,
                bestStreak: Math.max(habit.bestStreak, habitStreak),
                lastCompletedDate: today
            };
        })
        : previousHabits;

    let earnedXp = task.isFrog ? XP_PER_TASK * XP_PER_FROG_MULTIPLIER : XP_PER_TASK;
    if (task.habitId) earnedXp += habitStreak * 2;
    if (task.goalId || task.habitId) earnedXp += XP_GOAL_SYNERGY_BONUS;
    if (flowState === 'flow') earnedXp += 15;
    if (flowState === 'high') earnedXp += 10;
    const dayComplete = previousTasks.every(candidate => candidate.id === taskId
        || candidate.dateAssigned !== today || candidate.completed || candidate.wontDo);
    if (dayComplete) earnedXp += 50;
    const previousProgress = getUserProgress();
    const progressResult = checkLevelUp(
        previousProgress.xp + earnedXp,
        previousProgress.level,
        previousProgress.xpToNextLevel
    );
    const nextProgress = {
        level: progressResult.level,
        xp: progressResult.xp,
        xpToNextLevel: progressResult.next
    };

    storageService.stageLocalValues(USER_KEY, [
        { storeName: STORES.TASKS, previousValue: previousTasks, nextValue: nextTasks },
        { storeName: STORES.STATS, previousValue: previousAllStats, nextValue: nextAllStats },
        { storeName: STORES.GOALS, previousValue: previousGoals, nextValue: nextGoals },
        { storeName: STORES.HABITS, previousValue: previousHabits, nextValue: nextHabits },
        { storeName: STORES.PROGRESS, previousValue: previousProgress, nextValue: nextProgress }
    ]);
    // React only sees the completion after the complete logical action exists
    // in one read-verified WAL entry. A quota/error leaves every state untouched
    // and the completion tap retryable.
    setTasksFromStorage(nextTasks);
    setAllStatsFromStorage(nextAllStats);
    if (nextGoals !== previousGoals) setGoalsFromStorage(nextGoals);
    if (nextHabits !== previousHabits) setHabitsFromStorage(nextHabits);
    setUserProgressFromStorage(nextProgress);
    completedTaskIds.current.add(taskId);
    if (progressResult.leveledUp) setJustLeveledUp(true);
    if (dayComplete) {
        setTimeout(() => setGamificationEvent({ type: 'reward', amount: 50, message: "Day Complete!" }), 500);
    }
    void storageService.flushPendingLocalChanges(USER_KEY).catch(error => {
        console.error('Failed to flush the durable completion transaction.', error);
    });
  }, [getAllStats, getGoals, getHabits, getTasks, getUserProgress, setAllStatsFromStorage,
      setGoalsFromStorage, setHabitsFromStorage, setTasksFromStorage, setUserProgressFromStorage, USER_KEY]);

  const trackBreakTime = useCallback((minutes: number) => {
      setStats(prev => ({ ...prev, totalBreakMinutes: (prev.totalBreakMinutes || 0) + minutes }));
  }, []);

  const addHabit = useCallback((habitData: any) => {
      const { cleanTitle, duration, hashtags } = parseTitleForExtras(habitData.title);
      const newHabit: Habit = {
          ...habitData, title: cleanTitle, duration: habitData.duration || duration || 25, hashtags: [...(habitData.hashtags || []), ...hashtags],
          id: crypto.randomUUID(), streak: 0, bestStreak: 0, createdAt: Date.now(), beforeFrog: !!habitData.beforeFrog
      };
      const previousHabits = getHabits();
      const nextHabits = [...previousHabits, newHabit];
      const previousProgress = getUserProgress();
      const newXp = previousProgress.xp + XP_HABIT_SETUP_BONUS;
      const leveledUp = newXp >= previousProgress.xpToNextLevel;
      const nextProgress = leveledUp
          ? {
              level: previousProgress.level + 1,
              xp: newXp - previousProgress.xpToNextLevel,
              xpToNextLevel: calculateXpToNextLevel(previousProgress.level + 1)
          }
          : { ...previousProgress, xp: newXp };
      storageService.stageLocalValues(USER_KEY, [
          { storeName: STORES.HABITS, previousValue: previousHabits, nextValue: nextHabits },
          { storeName: STORES.PROGRESS, previousValue: previousProgress, nextValue: nextProgress }
      ]);
      setHabitsFromStorage(nextHabits);
      setUserProgressFromStorage(nextProgress);
      if (leveledUp) setJustLeveledUp(true);
      void storageService.flushPendingLocalChanges(USER_KEY).catch(error => {
          console.error('Failed to flush the durable habit creation transaction.', error);
      });
  }, [USER_KEY, getHabits, getUserProgress, setHabitsFromStorage, setUserProgressFromStorage]);

  const deleteHabit = useCallback((id: string) => {
      const previousHabits = getHabits();
      if (!previousHabits.some(habit => habit.id === id)) return;
      const previousTasks = getTasks();
      const nextHabits = previousHabits.filter(habit => habit.id !== id);
      const nextTasks = previousTasks.map(task => task.habitId === id ? { ...task, habitId: undefined } : task);
      storageService.stageLocalValues(USER_KEY, [
          { storeName: STORES.HABITS, previousValue: previousHabits, nextValue: nextHabits },
          { storeName: STORES.TASKS, previousValue: previousTasks, nextValue: nextTasks }
      ]);
      setHabitsFromStorage(nextHabits);
      setTasksFromStorage(nextTasks);
      void storageService.flushPendingLocalChanges(USER_KEY).catch(error => {
          console.error('Failed to flush the durable habit deletion transaction.', error);
      });
  }, [USER_KEY, getHabits, getTasks, setHabitsFromStorage, setTasksFromStorage]);

  const updateHabit = useCallback((id: string, updates: any) => {
      let parsed = { ...updates };
      if (updates.title) {
          const { cleanTitle, duration, hashtags } = parseTitleForExtras(updates.title);
          parsed.title = cleanTitle;
          if (duration) parsed.duration = duration;
          if (hashtags.length) parsed.hashtags = hashtags;
      }
      setHabits(prev => prev.map(h => h.id === id ? { ...h, ...parsed } : h));
  }, []);

  const addGoal = useCallback((data: any) => {
    const id = crypto.randomUUID();
    setGoals(prev => [...prev, { ...data, id, completedTasks: 0, createdAt: Date.now() }]);
    return id;
  }, []);

  const updateGoal = useCallback((id: string, updates: any) => setGoals(prev => prev.map(g => g.id === id ? { ...g, ...updates } : g)), []);
  const deleteGoal = useCallback((id: string) => {
    const previousGoals = getGoals();
    if (!previousGoals.some(goal => goal.id === id)) return;
    const previousTasks = getTasks();
    const previousHabits = getHabits();
    const nextGoals = previousGoals.filter(goal => goal.id !== id);
    const nextTasks = previousTasks.map(task => task.goalId === id ? { ...task, goalId: undefined } : task);
    const nextHabits = previousHabits.map(habit => habit.goalId === id ? { ...habit, goalId: undefined } : habit);
    storageService.stageLocalValues(USER_KEY, [
        { storeName: STORES.GOALS, previousValue: previousGoals, nextValue: nextGoals },
        { storeName: STORES.TASKS, previousValue: previousTasks, nextValue: nextTasks },
        { storeName: STORES.HABITS, previousValue: previousHabits, nextValue: nextHabits }
    ]);
    setGoalsFromStorage(nextGoals);
    setTasksFromStorage(nextTasks);
    setHabitsFromStorage(nextHabits);
    void storageService.flushPendingLocalChanges(USER_KEY).catch(error => {
        console.error('Failed to flush the durable goal deletion transaction.', error);
    });
  }, [USER_KEY, getGoals, getHabits, getTasks, setGoalsFromStorage, setHabitsFromStorage, setTasksFromStorage]);

  const addTrueNorthGoal = useCallback((data: any) => {
    const id = crypto.randomUUID();
    setTrueNorthGoals(prev => [{ ...data, id, createdAt: Date.now() }, ...prev]);
    return id;
  }, []);
  const updateTrueNorthGoal = useCallback((id: string, updates: any) => setTrueNorthGoals(prev => prev.map(g => g.id === id ? { ...g, ...updates } : g)), []);
  const deleteTrueNorthGoal = useCallback((id: string) => {
    const previousTrueNorthGoals = getTrueNorthGoals();
    if (!previousTrueNorthGoals.some(goal => goal.id === id)) return;
    const previousTasks = getTasks();
    const previousHabits = getHabits();
    const nextTrueNorthGoals = previousTrueNorthGoals.filter(goal => goal.id !== id);
    const nextTasks = previousTasks.map(task => task.goalId === id ? { ...task, goalId: undefined } : task);
    const nextHabits = previousHabits.map(habit => habit.goalId === id ? { ...habit, goalId: undefined } : habit);
    storageService.stageLocalValues(USER_KEY, [
        { storeName: STORES.TRUE_NORTH, previousValue: previousTrueNorthGoals, nextValue: nextTrueNorthGoals },
        { storeName: STORES.TASKS, previousValue: previousTasks, nextValue: nextTasks },
        { storeName: STORES.HABITS, previousValue: previousHabits, nextValue: nextHabits }
    ]);
    setTrueNorthGoalsFromStorage(nextTrueNorthGoals);
    setTasksFromStorage(nextTasks);
    setHabitsFromStorage(nextHabits);
    void storageService.flushPendingLocalChanges(USER_KEY).catch(error => {
        console.error('Failed to flush the durable True North deletion transaction.', error);
    });
  }, [USER_KEY, getHabits, getTasks, getTrueNorthGoals, setHabitsFromStorage,
      setTasksFromStorage, setTrueNorthGoalsFromStorage]);

  const updateAmalgam = useCallback((text: string) => setAmalgam(text), []);
  const updateHashtagConfig = useCallback((tag: string, updates: any) => setHashtagConfigs(prev => ({ ...prev, [tag]: { ...prev[tag], ...updates } })), []);
  const updateAccountabilityConfig = useCallback((updates: any) => setAccountabilityConfig(prev => ({ ...prev, ...updates })), []);
  
  const updateGoalPriorities = useCallback((updates: any) => {
      setGoals(prev => {
          const updated = prev.map(g => updates[g.id] ? { ...g, ...updates[g.id] } : g);
          return updated.sort((a, b) => ((b.excitement || 0) + (b.roi || 0)) - ((a.excitement || 0) + (a.roi || 0)));
      });
  }, []);

  const reorderGlobalToday = useCallback((taskId: string, newIndex: number) => {
      setTasks(prev => {
          const today = getTodayYYYYMMDD();
          const todaysTasks = prev.filter(t => t && t.dateAssigned === today && !t.completed && !t.wontDo);
          todaysTasks.sort(compareQueueCandidates);
          const taskIndex = todaysTasks.findIndex(t => t.id === taskId);
          if (taskIndex === -1) return prev;
          const [movedTask] = todaysTasks.splice(taskIndex, 1);
          todaysTasks.splice(newIndex, 0, movedTask);
          const reorderedUpdates = todaysTasks.map((t, i) => ({ ...t, plannedOrder: i, session: undefined }));
          const otherTasks = prev.filter(t => !t || t.dateAssigned !== today || t.completed || t.wontDo);
          return [...otherTasks, ...reorderedUpdates];
      });
  }, []);

  const reorderTodayTasks = useCallback((tid: string, s1: any, sIdx: number, s2: any, dIdx: number) => reorderGlobalToday(tid, dIdx), [reorderGlobalToday]); 
  
  const updateTaskPriorities = useCallback((updates: any) => {
      setTasks(prev => {
          const today = getTodayYYYYMMDD();
          const todaysTasks = prev.filter(t => t && !t.completed && t.dateAssigned === today && !t.wontDo);
          const otherTasks = prev.filter(t => t && (t.completed || t.wontDo || t.dateAssigned !== today));
          const updatedToday = todaysTasks.map(t => updates[t.id] ? { ...t, ...updates[t.id] } : t);
          updatedToday.sort((a, b) => ((b.excitement||0)*1.5 + (b.roi||0)) - ((a.excitement||0)*1.5 + (a.roi||0)));
          return [...otherTasks, ...updatedToday.map((t, i) => ({ ...t, plannedOrder: i }))];
      });
  }, []);

  const sortTodayTasksCircadian = useCallback(() => {
      setTasks(prev => {
          const today = getTodayYYYYMMDD();
          const todaysTasks = prev.filter(t => t && !t.completed && t.dateAssigned === today && !t.wontDo);
          const otherTasks = prev.filter(t => t && (t.completed || t.wontDo || t.dateAssigned !== today));
          
          const sortedToday = [...todaysTasks].sort((a, b) => {
              // Circadian recommendations may reorder only inside the allowed precedence group.
              const aGroup = a.beforeFrog && a.habitId ? 0 : a.isFrog ? 1 : 2;
              const bGroup = b.beforeFrog && b.habitId ? 0 : b.isFrog ? 1 : 2;
              if (aGroup !== bGroup) return compareQueueCandidates(a, b);
              
              // 2. Breaks last
              if (a.isBreak && !b.isBreak) return 1;
              if (!a.isBreak && b.isBreak) return -1;
              
              // 3. Priority by excitement & ROI
              const aVal = (a.excitement || 0) * 1.5 + (a.roi || 0);
              const bVal = (b.excitement || 0) * 1.5 + (b.roi || 0);
              return bVal - aVal;
          });
          
          const reorderedToday = sortedToday.map((t, i) => ({ ...t, plannedOrder: i, session: undefined }));
          return [...otherTasks, ...reorderedToday];
      });
  }, []);

  const uncompletedTasks = useMemo(() => tasks.filter(task => task && !task.completed && !task.wontDo), [tasks]);
  const overdueTasks = useMemo(() => {
      const today = getTodayYYYYMMDD();
      const currentMonth = today.slice(0, 7);
      return tasks.filter(t => t && !t.completed && !t.wontDo && (
          t.schedulePrecision === 'month'
              ? (t.scheduledFor || t.dateAssigned.slice(0, 7)) <= currentMonth
              : t.dateAssigned < today
      ));
  }, [tasks]);

  const todayStr = getTodayYYYYMMDD();
  const todayTasks = useMemo(() => uncompletedTasks
      .filter(task => task.schedulePrecision !== 'month' && task.dateAssigned === todayStr)
      .sort(compareQueueCandidates), [uncompletedTasks, todayStr]);
  const upcomingTasks = useMemo(() => uncompletedTasks.filter(task => task.schedulePrecision === 'month'
      ? (task.scheduledFor || task.dateAssigned.slice(0, 7)) > todayStr.slice(0, 7)
      : task.dateAssigned > todayStr
  ).sort((a, b) => a.dateAssigned.localeCompare(b.dateAssigned) || a.createdAt - b.createdAt), [uncompletedTasks, todayStr]);
  const recentCompletedTasks = useMemo(() => tasks.filter(t => t && t.completed && !t.deletedAt).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)).slice(0, 20), [tasks]);
  const allCompletedTasks = useMemo(() => tasks.filter(t => t && (t.completed || t.wontDo) && !t.deletedAt).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)), [tasks]);
  const currentTask = useMemo(() => todayTasks.length > 0 ? todayTasks[0] : null, [todayTasks]);

  return {
    isLoading,
    tasks, goals, habits, trueNorthGoals, amalgam,
    dailyPlans, confirmDailyPlan, clearDailyPlan,
    currentTask, todayTasks, upcomingTasks, overdueTasks, recentCompletedTasks, allCompletedTasks, 
    stats, userProgress, hashtagConfigs, accountabilityConfig, justLeveledUp, setJustLeveledUp,
    gamificationEvent, setGamificationEvent, planningWarning, setPlanningWarning,
    trackPlanVisit, rescheduleTask, awardSessionXp,
    addTask, addSubtasks, updateTask, deleteTask, markWontDo, setFrog, moveTaskToTopToday, completeTask,
    trackBreakTime, reorderTodayTasks, updateTaskPriorities, reorderGlobalToday, sortTodayTasksCircadian,
    addGoal, updateGoal, deleteGoal, addHabit, updateHabit, deleteHabit,
    updateHashtagConfig, updateAccountabilityConfig, updateGoalPriorities,
    addTrueNorthGoal, updateTrueNorthGoal, deleteTrueNorthGoal, updateAmalgam,
    circadianState, submitBioCheckIn, resetCircadianState,
    userSettings, updateUserSettings
  };
};
