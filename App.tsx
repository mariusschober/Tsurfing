
import React, { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import { useGoalflow } from './hooks/useGoalflow';
import type { FocusSessionRecord } from './src/domain/focusSession';
import { CurrentView } from './components/CurrentView';
import { PlanningView, type PlanningMode } from './components/PlanningView';
import { DoneView } from './components/DoneView';
import { HabitsView } from './components/HabitsView';
import { Celebration } from './components/Celebration';
import { LevelUpModal } from './components/LevelUpModal';
import { AppHeader, type View } from './components/AppHeader';
import { ModeSelector } from './components/ModeSelector';
import { PlusIcon, ShieldIcon, ChevronDownIcon } from './components/Icons';
import { playCompleteSound, playFrogCompleteSound } from './utils/audioUtils';
import { Modal } from './components/Modal';
import { TaskForm } from './components/TaskForm';
import { SearchModal } from './components/SearchModal';
import { Task, FlowState, Session } from './types';
import { HashtagManager } from './components/HashtagManager';
import { GamificationToast } from './components/GamificationToast';
import { BioStateCheckIn } from './components/BioStateCheckIn';
import { getTodayYYYYMMDD } from './utils/dateUtils';
import { startCloudSync } from './services/cloudSync';
import { PwaLifecycle } from './components/PwaLifecycle';

type Theme = 'light' | 'dark';

const GoalsView = React.lazy(() => import('./components/GoalsView').then(module => ({ default: module.GoalsView })));
const StatsView = React.lazy(() => import('./components/StatsView').then(module => ({ default: module.StatsView })));
const GamificationView = React.lazy(() => import('./components/GamificationView').then(module => ({ default: module.GamificationView })));
const SettingsModal = React.lazy(() => import('./components/SettingsModal').then(module => ({ default: module.SettingsModal })));
const ViewFallback = () => <div className="flex min-h-[40vh] items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" /></div>;

interface AppProps {
  userEmail: string;
  userKey: string;
  userRole: 'owner' | 'beta';
  openAccountSetup?: boolean;
  onLogout: () => void;
}

const App: React.FC<AppProps> = ({ userEmail, userKey, userRole, openAccountSetup = false, onLogout }) => {
  const [currentLocalDay, setCurrentLocalDay] = useState(getTodayYYYYMMDD());
  const [currentView, setCurrentView] = useState<View>('current');
  const [planModeState, setPlanModeState] = useState<{ user: string; day: string; mode: PlanningMode }>(() => ({ user: userKey, day: currentLocalDay, mode: 'manual' }));
  const planMode: PlanningMode = planModeState.user === userKey && planModeState.day === currentLocalDay ? planModeState.mode : 'manual';
  const setPlanMode = useCallback((mode: PlanningMode) => setPlanModeState({ user: userKey, day: currentLocalDay, mode }), [userKey, currentLocalDay]);
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [taskToEdit, setTaskToEdit] = useState<Task | null>(null);
  const [taskDefaults, setTaskDefaults] = useState<{ session?: Session, dateAssigned?: string, title?: string }>({});
  
  const [showCelebration, setShowCelebration] = useState(false);
  const [theme, setTheme] = useState<Theme>('light');
  const [selectedHashtag, setSelectedHashtag] = useState<string | null>(null);
  const [isBioCheckInOpen, setIsBioCheckInOpen] = useState(false);
  const [isModeSelectorOpen, setIsModeSelectorOpen] = useState(false);
  const modeSelectorId = useId();
  const [isHeaderModalOpen, setIsHeaderModalOpen] = useState(false);
  
  const [openAssessmentOnGoalsMount, setOpenAssessmentOnGoalsMount] = useState(false);
  const [planningSaveError, setPlanningSaveError] = useState<string | null>(null);
  
  const {
    isLoading,
    hydrationError,
    retryHydration,
    tasks,
    goals,
    habits,
    currentTask,
    todayTasks,
    upcomingTasks,
    recentCompletedTasks,
    allCompletedTasks,
    stats,
    focusSession,
    startFocusSession,
    pauseFocusSession,
    resumeFocusSession,
    stopFocusSession,
    extendFocusSession,
    userProgress,
    hashtagConfigs,
    accountabilityConfig,
    trueNorthGoals, 
    amalgam, 
    justLeveledUp,
    setJustLeveledUp,
    addTask,
    addSubtasks,
    updateTask,
    deleteTask,
    setFrog,
    moveTaskToTopToday,
    completeTask,
    reorderTodayTasks,
    reorderGlobalToday,
    updateTaskPriorities,
    addGoal,
    updateGoal,
    deleteGoal,
    addHabit,
    updateHabit,
    deleteHabit,
    updateHashtagConfig,
    updateAccountabilityConfig,
    updateGoalPriorities,
    addTrueNorthGoal, 
    updateTrueNorthGoal, 
    deleteTrueNorthGoal, 
    updateAmalgam,
    trackBreakTime,
    markWontDo,
    overdueTasks,
    gamificationEvent,
    setGamificationEvent,
    planningWarning,
    setPlanningWarning,
    trackPlanVisit,
    rescheduleTask,
    awardSessionXp,
    circadianState,
    submitBioCheckIn,
    resetCircadianState,
    userSettings,
    updateUserSettings,
    dailyPlans,
    confirmDailyPlan: persistDailyPlan
  } = useGoalflow(userKey, userEmail);
  const todayPlanTaskIds = useMemo(() => todayTasks.map(task => task.id), [todayTasks]);
  const confirmedPlan = useMemo(
      () => dailyPlans.find(plan => plan.localDate === currentLocalDay),
      [dailyPlans, currentLocalDay]
  );

  useEffect(() => {
      const timer = window.setInterval(() => {
          const localDay = getTodayYYYYMMDD();
          setCurrentLocalDay(previous => previous === localDay ? previous : localDay);
      }, 60_000);
      return () => window.clearInterval(timer);
  }, []);

  useEffect(() => startCloudSync(userKey), [userKey]);

  useEffect(() => {
      if (openAccountSetup) setIsSettingsOpen(true);
  }, [openAccountSetup]);

  useEffect(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('view') === 'current') setCurrentView('current');
      if (params.get('capture') === 'task' || params.get('capture') === 'share') {
          const title = [params.get('title'), params.get('text'), params.get('url')].filter(Boolean).join(' ').trim();
          setTaskToEdit(null);
          setTaskDefaults({ title, dateAssigned: getTodayYYYYMMDD() });
          setIsTaskModalOpen(true);
          ['capture', 'title', 'text', 'url'].forEach(key => params.delete(key));
          const remainingQuery = params.toString();
          window.history.replaceState({}, document.title, `${window.location.pathname}${remainingQuery ? `?${remainingQuery}` : ''}`);
      }
  }, []);

  // Circadian Check Logic - Only active if checked in today
  const isCircadianActive = circadianState.lastCheckIn === getTodayYYYYMMDD();

  const handleNavigateToHabits = () => {
      setCurrentView('habits');
      setTimeout(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }));
      }, 100);
  };

  const handleNavigateToAddGoal = () => {
      setCurrentView('goals');
      setTimeout(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }));
      }, 100);
  };

  useEffect(() => {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      setTheme('dark');
    }
  }, []);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  const viewNavigation = useRef(0);
  const handleSetView = async (view: View) => {
      const navigation = ++viewNavigation.current;
      try {
          if (view === 'planning' && !await trackPlanVisit()) return;
          if (navigation === viewNavigation.current) setCurrentView(view);
      } catch (error) {
          window.dispatchEvent(new CustomEvent('goalflow:sync-state', { detail: { userKey,
              state: 'error', localFailure: true, message: error instanceof Error ? error.message : 'The planning visit could not be saved.' } }));
      }
  };

  const hasOverdue = overdueTasks.length > 0;
  const requiresMonthlyPlanning = overdueTasks.some(task => task.schedulePrecision === 'month');
  const dailyPlanConfirmed = !hasOverdue && (
      todayPlanTaskIds.length === 0 || confirmedPlan?.localDate === currentLocalDay
  );

  const confirmDailyPlan = async () => {
      if (hasOverdue) {
          setCurrentView('planning');
          return;
      }
      try {
          persistDailyPlan(currentLocalDay, todayPlanTaskIds);
          setPlanningSaveError(null);
          setCurrentView('current');
      } catch (error) {
          setPlanningSaveError(error instanceof Error ? error.message : 'The planning decision could not be saved durably.');
          setCurrentView('planning');
      }
  };

  const openAddTaskModal = useCallback((overrides?: { session?: Session, dateAssigned?: string, title?: string }) => {
    setTaskToEdit(null);
    setTaskDefaults(overrides || {});
    setIsTaskModalOpen(true);
  }, []);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isBioCheckInOpen || isModeSelectorOpen || isHeaderModalOpen || document.querySelector('[aria-modal="true"]')) return;

      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) {
        return;
      }
      
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (isTaskModalOpen || isSearchOpen || isSettingsOpen) return;

      switch (e.key.toLowerCase()) {
        case 'f':
          if (!hasOverdue) handleSetView('current');
          break;
        case 'p':
          handleSetView('planning');
          break;
        case 'h':
          if (!hasOverdue) handleSetView('habits');
          break;
        case 'g':
          if (!hasOverdue) handleSetView('goals');
          break;
        case 's':
          if (!hasOverdue) handleSetView('stats');
          break;
        case '/':
          e.preventDefault();
          setIsSearchOpen(true);
          break;
        case 'a':
          e.preventDefault();
          openAddTaskModal();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasOverdue, isTaskModalOpen, isSearchOpen, openAddTaskModal, isBioCheckInOpen, isSettingsOpen, isModeSelectorOpen, isHeaderModalOpen]);

  const handleCompleteTask = async (id: string, duration?: number, flowState?: FlowState, finalDescription?: string,
    observed?: FocusSessionRecord | null): Promise<boolean> => {
    const task = todayTasks.find(t => t.id === id) || upcomingTasks.find(t => t.id === id);
    try {
      if (!await completeTask(id, duration, flowState, finalDescription, observed)) return false;
    } catch (error) {
      window.dispatchEvent(new CustomEvent('goalflow:sync-state', { detail: { userKey,
        state: 'error', localFailure: true, message: error instanceof Error ? error.message : 'Completion could not be saved. Your notes remain available.' } }));
      return false;
    }

    // Feedback follows durable admission, including asynchronous causal work.
    if (task?.isFrog) {
        playFrogCompleteSound();
    } else {
        playCompleteSound();
    }

    setShowCelebration(true);
    setTimeout(() => setShowCelebration(false), 3000);
    return true;
  }

  const openEditTaskModal = useCallback((task: Task) => {
    setTaskToEdit(task);
    setTaskDefaults({});
    setIsTaskModalOpen(true);
  }, []);

  const closeModal = () => {
    setIsTaskModalOpen(false);
    setTaskToEdit(null);
    setTaskDefaults({});
  };

  const handleFormSubmit = (data: { title: string; description: string; dateAssigned: string, goalId?: string, isFrog: boolean, isRepetitive: boolean, schedulePrecision: 'day' | 'month', scheduledFor: string }) => {
    const finalData = { ...data, session: taskToEdit ? undefined : taskDefaults.session };

    if (taskToEdit) {
      updateTask(taskToEdit.id, data);
    } else {
      // @ts-ignore 
      addTask(finalData);
    }
    closeModal();
  };
  
  const handleNavigateToTrueNorth = () => {
      setOpenAssessmentOnGoalsMount(true);
      setCurrentView('goals');
  };
  
  const handleAssessmentOpened = () => {
      setOpenAssessmentOnGoalsMount(false);
  };

  if (isLoading) {
      return (
          <div className="min-h-screen bg-gray-50 dark:bg-slate-900 flex flex-col justify-center items-center gap-4">
              {hydrationError ? <div role="alert" className="max-w-md px-6 text-center">
                <h1 className="text-lg font-bold">Your saved data couldn’t be opened</h1>
                <p className="mt-2 text-gray-500">Your saved copies have been kept. Try again to resume loading.</p>
                <button type="button" onClick={retryHydration} className="mt-4 rounded-lg bg-indigo-600 px-5 py-2 text-white">Try again</button>
              </div> : <>
              <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-gray-500 dark:text-gray-400 animate-pulse text-sm font-bold uppercase tracking-widest">Loading your tasks...</p>
              </>}
          </div>
      );
  }

  return (
    <div className={`app-shell ${currentView === 'current' ? 'app-shell--current' : currentView === 'planning' ? 'app-shell--planning' : ''} bg-gray-50 dark:bg-slate-900 min-h-screen font-sans flex flex-col transition-colors duration-200 print:bg-white relative`}>
      <PwaLifecycle />
      {isBioCheckInOpen && (
          <BioStateCheckIn 
            onSubmit={(data, score, mode, solar) => {
               submitBioCheckIn(data, score, mode, solar);
               setIsBioCheckInOpen(false);
            }} 
            onClose={() => setIsBioCheckInOpen(false)}
          />
      )}
      
      {showCelebration && <Celebration />}
      
      {gamificationEvent && (
          <GamificationToast 
            type={gamificationEvent.type}
            message={gamificationEvent.message} 
            xp={gamificationEvent.amount} 
            onClose={() => setGamificationEvent(null)} 
          />
      )}

      <AppHeader currentView={currentView} hasOverdue={hasOverdue} userKey={userKey} userEmail={userEmail}
        userProgress={userProgress} theme={theme} onNavigate={handleSetView}
        onSearch={() => setIsSearchOpen(true)} onSettings={() => setIsSettingsOpen(true)} onLogout={onLogout}
        onToggleTheme={toggleTheme} onModalChange={setIsHeaderModalOpen} />
      
      {currentView === 'gamification' ? (
          <React.Suspense fallback={<ViewFallback />}>
          <GamificationView 
              userProgress={userProgress}
              trueNorthGoals={trueNorthGoals}
              tacticalGoals={goals}
              habits={habits}
              completedTasks={allCompletedTasks}
              onBack={() => setCurrentView('current')}
              onOpenTrueNorth={handleNavigateToTrueNorth}
              onNavigateToGoals={() => setCurrentView('goals')}
              onAddHabitClick={handleNavigateToHabits}
              onAddGoalClick={handleNavigateToAddGoal}
          />
          </React.Suspense>
      ) : (
        <main className="container mx-auto p-4 flex-grow relative print:p-0 print:w-full">
            {currentView === 'planning' && <>
            <PlanningView
                todayTasks={todayTasks}
                upcomingTasks={upcomingTasks}
                allTasks={tasks}
                goals={goals}
                setFrog={setFrog}
                openEditModal={openEditTaskModal}
                deleteTask={deleteTask}
                reorderTodayTasks={reorderTodayTasks}
                hashtagConfigs={hashtagConfigs}
                updateTaskPriorities={updateTaskPriorities}
                moveTaskToTopToday={moveTaskToTopToday}
                onSelectHashtag={setSelectedHashtag}
                overdueTasks={overdueTasks}
                markWontDo={markWontDo}
                onAddTask={openAddTaskModal}
                updateTask={updateTask} 
                onRescheduleTask={rescheduleTask}
                circadianState={isCircadianActive ? circadianState : { ...circadianState, sunriseTime: undefined, sunsetTime: undefined }}
                addSubtasks={addSubtasks}
                completeTask={handleCompleteTask}
                isAiEnabled={userSettings.enableAi}
                createTask={addTask}
                userKey={userKey}
                planningMode={planMode}
                onPlanningModeChange={setPlanMode}
                onSubmitBioCheckIn={submitBioCheckIn}
            />
            <div className="planning-confirmation border border-gray-200 bg-white/95 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-800/95">
                <p className="planning-confirmation__summary text-sm text-gray-600 dark:text-gray-300">
                    {requiresMonthlyPlanning ? 'Assign every current-month task to an exact day before starting today.' : hasOverdue ? 'Resolve every overdue task before starting today.' : `Confirm today's order, then start focus.`}
                </p>
                {planningSaveError && (
                    <p role="alert" className="mb-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200">
                        {planningSaveError}
                    </p>
                )}
                <button
                    type="button"
                    onClick={confirmDailyPlan}
                    disabled={hasOverdue}
                    className="w-full rounded-xl bg-indigo-600 px-5 py-3 font-bold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-slate-600"
                >
                    {requiresMonthlyPlanning ? 'Schedule monthly tasks first' : hasOverdue ? 'Resolve overdue tasks first' : 'Start focus'}
                </button>
            </div>
            </>}
            {currentView === 'habits' && 
                <HabitsView 
                    habits={habits} 
                    goals={goals}
                    addHabit={addHabit} 
                    updateHabit={updateHabit} 
                    deleteHabit={deleteHabit} 
                />
            }
            {currentView === 'done' && 
                <DoneView 
                    tasks={allCompletedTasks} 
                    hashtagConfigs={hashtagConfigs} 
                    onSelectHashtag={setSelectedHashtag}
                    onBack={() => setCurrentView('stats')}
                />
            }
            {currentView === 'goals' && 
                <React.Suspense fallback={<ViewFallback />}>
                <GoalsView 
                    goals={goals} 
                    addGoal={addGoal} 
                    updateGoal={updateGoal} 
                    deleteGoal={deleteGoal} 
                    addHabit={addHabit}
                    addTask={addTask}
                    updateGoalPriorities={updateGoalPriorities}
                    trueNorthGoals={trueNorthGoals}
                    addTrueNorthGoal={addTrueNorthGoal}
                    updateTrueNorthGoal={updateTrueNorthGoal}
                    deleteTrueNorthGoal={deleteTrueNorthGoal}
                    amalgam={amalgam}
                    updateAmalgam={updateAmalgam}
                    userProgress={userProgress}
                    openAssessmentOnMount={openAssessmentOnGoalsMount}
                    onAssessmentOpened={handleAssessmentOpened}
                    isAiEnabled={userSettings.enableAi}
                />
                </React.Suspense>
            }
            {currentView === 'stats' && 
                <React.Suspense fallback={<ViewFallback />}>
                <StatsView 
                    stats={stats} 
                    recentTasks={recentCompletedTasks} 
                    allTasks={tasks}
                    hashtagConfigs={hashtagConfigs}
                    onColorChange={updateHashtagConfig}
                    accountabilityConfig={accountabilityConfig}
                    onUpdateAccountability={updateAccountabilityConfig}
                    onViewDone={() => setCurrentView('done')}
                    onSelectHashtag={setSelectedHashtag}
                />
                </React.Suspense>
            }
            {currentView === 'current' && <div className="current-mode">
              <button type="button" onClick={event => { event.currentTarget.focus(); setIsModeSelectorOpen(true); }} aria-haspopup="dialog" aria-expanded={isModeSelectorOpen} aria-controls={modeSelectorId}
                className="header-control text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800">
                <span>Mode: {isCircadianActive ? 'Bio-Adaptive' : 'Manual'}</span><ChevronDownIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              </button>
            </div>}
            {currentView === 'current' && dailyPlanConfirmed &&
            <CurrentView
                currentTask={currentTask}
                goals={goals}
                allTasks={tasks}
                completeTask={handleCompleteTask}
                addSubtasks={addSubtasks}
                onFrogEaten={() => {}} 
                deprioritizeTask={(id) => reorderGlobalToday(id, Math.max(0, todayTasks.length - 1))}
                openEditModal={openEditTaskModal}
                updateTask={updateTask}
                hashtagConfigs={hashtagConfigs}
                onSelectHashtag={setSelectedHashtag}
                amalgam={amalgam}
                trackBreakTime={trackBreakTime}
                onAwardXp={awardSessionXp}
                isAiEnabled={userSettings.enableAi}
                focusSession={focusSession}
                onStartFocusSession={startFocusSession}
                onPauseFocusSession={pauseFocusSession}
                onResumeFocusSession={resumeFocusSession}
                onStopFocusSession={stopFocusSession}
                onExtendFocusSession={extendFocusSession}
            />
            }
            {currentView === 'current' && !dailyPlanConfirmed && (
                <section className="current-planning-gate mx-auto mt-16 max-w-xl rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-slate-700 dark:bg-slate-800">
                    <p className="mb-2 text-xs font-bold uppercase tracking-widest text-indigo-600 dark:text-indigo-300">{requiresMonthlyPlanning ? 'Monthly planning' : 'Daily planning'}</p>
                    <h1 className="mb-3 text-3xl font-bold text-gray-900 dark:text-white">Plan once. Then focus.</h1>
                    <p className="mb-6 text-gray-600 dark:text-gray-300">
                        {requiresMonthlyPlanning ? 'Assign each current-month task to an exact day. Then review today and return to one-task focus.' : `Review overdue work and today's order. Once confirmed, Tsurfing will show one task at a time.`}
                    </p>
                    <button type="button" onClick={() => handleSetView('planning')} className="rounded-xl bg-indigo-600 px-6 py-3 font-bold text-white transition hover:bg-indigo-700">
                        Open today's plan
                    </button>
                </section>
            )}

            <button 
                onClick={() => openAddTaskModal()}
                className="app-add-task fixed bottom-8 right-8 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full p-4 shadow-lg transform transition-transform hover:scale-110 z-30 active:scale-95 flex items-center justify-center print:hidden"
                title="Add new task (a)"
            >
                <PlusIcon className="w-8 h-8" />
            </button>
        </main>
      )}

      <Modal isOpen={isTaskModalOpen} onClose={closeModal} title={taskToEdit ? "Edit Task" : "New Task"}>
          <TaskForm 
            onSubmit={handleFormSubmit}
            initialData={taskToEdit}
            goals={goals}
            onClose={closeModal}
            existingTasks={tasks}
            initialOverrides={taskDefaults}
            isAiEnabled={userSettings.enableAi}
            onBreakdown={addSubtasks}
          />
      </Modal>
      
      {selectedHashtag && (
          <HashtagManager 
            hashtag={selectedHashtag}
            onClose={() => setSelectedHashtag(null)}
            tasks={tasks.filter(t => t.hashtags.includes(selectedHashtag))}
            goals={goals}
            config={hashtagConfigs[selectedHashtag]}
            onUpdateConfig={updateHashtagConfig}
            onUpdateTask={updateTask}
            onMoveToToday={moveTaskToTopToday}
            onAddSubtasks={addSubtasks}
            onOpenEditModal={openEditTaskModal}
            isAiEnabled={userSettings.enableAi}
          />
      )}

      {isSettingsOpen && (
        <React.Suspense fallback={null}>
          <SettingsModal
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
            settings={userSettings}
            onUpdateSettings={updateUserSettings}
            userEmail={userEmail}
            storageKey={userKey}
            isOwner={userRole === 'owner'}
          />
        </React.Suspense>
      )}

      <SearchModal 
        isOpen={isSearchOpen} 
        onClose={() => setIsSearchOpen(false)} 
        allTasks={tasks} 
      />

      <LevelUpModal 
        isOpen={justLeveledUp}
        onClose={() => setJustLeveledUp(false)}
        newLevel={userProgress.level}
      />
      
      <Modal isOpen={isModeSelectorOpen} onClose={() => setIsModeSelectorOpen(false)} title="Planning mode" variant="compact" id={modeSelectorId}>
        <div className="p-4"><ModeSelector active={isCircadianActive} mode={circadianState.mode}
          onManual={() => { setIsModeSelectorOpen(false); resetCircadianState(); }}
          onBioAdaptive={() => { setIsModeSelectorOpen(false); setIsBioCheckInOpen(true); }} /></div>
      </Modal>

      {/* Warning Modal for Planning Overuse */}
      <Modal isOpen={planningWarning} onClose={() => setPlanningWarning(false)} title="Decision Fatigue Warning">
          <div className="p-6 text-center">
              <div className="w-20 h-20 bg-orange-100 dark:bg-orange-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
                  <ShieldIcon className="w-10 h-10 text-orange-600 dark:text-orange-400" />
              </div>
              <h3 className="text-xl font-bold text-gray-800 dark:text-white mb-2">Stop Planning. Start Doing.</h3>
              <p className="text-gray-600 dark:text-gray-300 mb-6">
                  You have visited the planning screen 6 times today. Constant rescheduling is a form of procrastination.
              </p>
              <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 rounded-xl p-4 mb-6">
                  <p className="text-sm font-bold text-red-600 dark:text-red-400">
                      {(userSettings.penaltyMode ?? 'off') === 'off' ? 'XP penalties are turned off.' : 'Further visits to the Plan view will result in XP penalties.'}
                  </p>
              </div>
              <button onClick={() => { setPlanningWarning(false); handleSetView('current'); }} className="w-full py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition">
                  Return to Focus Mode
              </button>
          </div>
      </Modal>

      {currentView !== 'gamification' && (
        <footer className="text-center py-6 text-gray-400 dark:text-gray-600 text-xs print:hidden">
            <p>Tsurfing &copy; {new Date().getFullYear()} • Focus. Flow. Finish.</p>
        </footer>
      )}
    </div>
  );
};

export default App;
