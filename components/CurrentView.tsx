
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Task, Goal, FlowState, HashtagConfig, CircadianState } from '../types';
import { useFocusTimer } from '../hooks/useFocusTimer';
import { useTickingSound } from '../hooks/useTickingSound';
import { CheckIcon, PlayIcon, PencilIcon, SkipIcon, BrainCircuit, Volume2Icon, VolumeXIcon, RefreshIcon, InfinityIcon, AxeIcon, PlusIcon, TrashIcon, CoffeeIcon } from './Icons';
import { Modal } from './Modal';
import { breakdownTaskWithGemini, getVisualizationPrompt, AiSubtask } from '../services/geminiService';
import { playAlarmSound, playSelectSound } from '../utils/audioUtils';
import { YellowPad } from './YellowPad';
import type { FocusSessionRecord } from '../src/domain/focusSession';

interface CurrentViewProps {
  currentTask: Task | null;
  goals: Goal[];
  allTasks: Task[];
  completeTask: (id: string, duration?: number, flowState?: FlowState, finalDescription?: string) => void;
  addSubtasks: (subtasks: {title: string, duration: number}[], parent: Task) => void;
  onFrogEaten: () => void;
  deprioritizeTask: (id: string) => void;
  openEditModal: (task: Task) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  hashtagConfigs: Record<string, HashtagConfig>;
  onSelectHashtag: (tag: string) => void;
  amalgam?: string;
  trackBreakTime: (minutes: number) => void;
  onAwardXp: (amount: number, message: string, type?: 'reward' | 'milestone') => void;
  focusSession?: FocusSessionRecord | null;
  onStartFocusSession?: (taskId: string, plannedDurationSeconds: number, observed: FocusSessionRecord | null) => void;
  onPauseFocusSession?: (observed: FocusSessionRecord | null) => void;
  onResumeFocusSession?: (observed: FocusSessionRecord | null) => void;
  onStopFocusSession?: (observed: FocusSessionRecord | null) => void;
  onExtendFocusSession?: (deltaSeconds: number, observed: FocusSessionRecord | null) => void;
  isAiEnabled?: boolean;
  circadianState?: CircadianState;
  isCircadianActive?: boolean;
  onOpenBioCheckIn?: () => void;
  onResetCircadian?: () => void;
}

const CircularTimer = React.memo<{ 
    seconds: number, 
    totalSeconds: number,
    flowOffset: number,
    isActive: boolean, 
    timerType: 'countdown' | 'stopwatch', 
    onTimeClick: () => void, 
    primaryColor?: string,
    isBreak?: boolean
}>(({ seconds, totalSeconds, flowOffset, isActive, timerType, onTimeClick, primaryColor, isBreak }) => {
    // Configuration for the SVG
    const size = 380; 
    const center = size / 2;
    const strokeWidth = 12; 
    const radius = center - strokeWidth - 20; 
    const circumference = 2 * Math.PI * radius;
    
    // Smooth progress calculation
    let progress = 0;
    if (timerType === 'countdown' && totalSeconds > 0) {
        progress = Math.max(0, Math.min(1, seconds / totalSeconds));
    } else {
        progress = 1; 
    }
    
    // Invert progress for countdown (start full, go to empty)
    const strokeDashoffset = circumference * (1 - progress);
    
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    // Determine colors
    const activeColor = isBreak ? '#14b8a6' : (primaryColor || '#6366f1'); 

    // Gamified Flow State Logic
    const effectiveSeconds = seconds + flowOffset;
    const elapsedMinutes = timerType === 'stopwatch' 
        ? effectiveSeconds / 60 
        : (totalSeconds - seconds + flowOffset) / 60;

    let flowStateConfig = {
        label: 'Ready',
        style: 'bg-gray-50 dark:bg-slate-800/50 text-gray-400 dark:text-gray-500 border-transparent',
        dotColor: 'bg-gray-300'
    };

    if (isBreak) {
        flowStateConfig = {
            label: 'Recharging',
            style: 'bg-teal-50 dark:bg-teal-900/20 text-teal-600 dark:text-teal-400 border-teal-100 dark:border-teal-800 animate-pulse',
            dotColor: 'bg-teal-500'
        };
    } else if (isActive) {
        if (elapsedMinutes < 5) {
            flowStateConfig = {
                label: 'Entering Flow',
                style: 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-300 border-blue-100 dark:border-blue-800 animate-pulse',
                dotColor: 'bg-blue-500'
            };
        } else if (elapsedMinutes < 20) {
            flowStateConfig = {
                label: 'Deep Focus',
                style: 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-300 border-indigo-100 dark:border-indigo-800',
                dotColor: 'bg-indigo-500'
            };
        } else {
            flowStateConfig = {
                label: 'Flow State',
                style: 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-300 border-purple-100 dark:border-purple-800 shadow-[0_0_15px_rgba(147,51,234,0.3)]',
                dotColor: 'bg-purple-500'
            };
        }
    } else if (elapsedMinutes > 0) {
        flowStateConfig = {
            label: 'Paused',
            style: 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-300 border-yellow-100 dark:border-yellow-800',
            dotColor: 'bg-yellow-500'
        };
    }

    return (
        <div className="relative flex justify-center items-center my-8 group z-10 w-full max-w-[280px] sm:max-w-[340px] md:max-w-[380px] aspect-square flex-shrink-0">
            
            <svg aria-hidden="true" viewBox={`0 0 ${size} ${size}`} className="w-full h-full transform -rotate-90 relative z-10 overflow-visible pointer-events-none">
                <defs>
                    <filter id="glow-shadow" x="-50%" y="-50%" width="200%" height="200%">
                        <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor={activeColor} floodOpacity="0.5" />
                    </filter>
                </defs>

                <circle 
                    cx={center} 
                    cy={center} 
                    r={radius} 
                    stroke="currentColor" 
                    className="text-gray-100 dark:text-slate-800/50 transition-colors duration-300" 
                    strokeWidth={strokeWidth} 
                    fill="transparent" 
                />
                
                {(timerType === 'countdown' || isActive) && (
                     <circle 
                        cx={center} 
                        cy={center} 
                        r={radius} 
                        stroke={activeColor}
                        strokeWidth={strokeWidth} 
                        fill="transparent" 
                        strokeDasharray={circumference} 
                        strokeDashoffset={timerType === 'countdown' ? strokeDashoffset : 0} 
                        strokeLinecap="round" 
                        className="transition-all duration-1000 ease-linear"
                        style={{ filter: isActive ? 'url(#glow-shadow)' : 'none' }}
                    />
                )}
            </svg>
            
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-auto">
                 <button 
                    className="focus:outline-none transition-transform active:scale-95 mb-6"
                    onClick={onTimeClick}
                    title="Edit Duration"
                    disabled={isBreak}
                 >
                    <div className={`text-6xl sm:text-7xl md:text-8xl font-bold tracking-tighter font-sans tabular-nums transition-all duration-300 ${isActive ? 'text-gray-900 dark:text-white drop-shadow-sm' : 'text-gray-300 dark:text-gray-600'}`}>
                        {String(minutes).padStart(2, '0')}:{String(remainingSeconds).padStart(2, '0')}
                    </div>
                 </button>
                 
                 <div className={`px-5 py-2 rounded-full flex items-center gap-2 text-xs font-bold uppercase tracking-[0.15em] transition-all duration-500 border ${flowStateConfig.style}`}>
                    <span className="relative flex h-2 w-2">
                        {isActive && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${flowStateConfig.dotColor}`}></span>}
                        <span className={`relative inline-flex rounded-full h-2 w-2 ${flowStateConfig.dotColor}`}></span>
                    </span>
                    {flowStateConfig.label}
                </div>
            </div>
        </div>
    );
});

const BreakOverlay: React.FC<{ duration: number, onEnd: (elapsedMinutes: number) => void }> = ({ duration, onEnd }) => {
    const [seconds, setSeconds] = useState(duration > 0 ? duration * 60 : 0);
    const [elapsedOpen, setElapsedOpen] = useState(0);
    
    useEffect(() => {
        const timer = setInterval(() => {
            if (duration > 0) {
                setSeconds(prev => {
                    if (prev <= 1) {
                        clearInterval(timer);
                        playAlarmSound();
                        return 0;
                    }
                    return prev - 1;
                });
            } else {
                setSeconds(prev => prev + 1);
                setElapsedOpen(prev => prev + 1);
            }
        }, 1000);
        
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                handleEnd();
            }
        };
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            clearInterval(timer);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [duration]);
    
    useEffect(() => {
        if (duration > 0 && seconds === 0) {
             const timeout = setTimeout(() => {
                 onEnd(duration);
             }, 2000);
             return () => clearTimeout(timeout);
        }
    }, [seconds, duration, onEnd]);
    
    const displaySeconds = duration > 0 ? seconds : elapsedOpen;
    const mins = Math.floor(displaySeconds / 60);
    const secs = displaySeconds % 60;
    
    const handleEnd = () => {
        if (duration > 0) {
            const taken = Math.ceil((duration * 60 - seconds) / 60);
            onEnd(taken > 0 ? taken : 1);
        } else {
            const taken = Math.ceil(elapsedOpen / 60);
            onEnd(taken > 0 ? taken : 1);
        }
    };
    
    return (
        <div className="fixed inset-0 bg-slate-900 z-[200] flex flex-col items-center justify-center text-white animate-fadeIn">
            <h2 className="text-5xl font-heading mb-10 tracking-[0.2em] text-indigo-400">
                {duration > 0 ? 'RECHARGE' : 'BREAK TIME'}
            </h2>
            <div className="text-[12rem] leading-none font-sans font-bold tabular-nums mb-12 bg-gradient-to-b from-white to-gray-400 bg-clip-text text-transparent drop-shadow-2xl">
                {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
            </div>
            <p className="text-slate-400 animate-pulse text-xl font-light mb-8">
                {duration > 0 ? "Breathe. Relax. Reset." : "Taking a moment..."}
            </p>
            
            <div className="text-xs text-slate-600 uppercase tracking-widest font-bold mb-4">Press ESC to End Break Early</div>

            <button 
                onClick={handleEnd} 
                className="px-8 py-3 border border-slate-600 rounded-full hover:bg-white hover:text-slate-900 transition font-bold tracking-wide flex items-center gap-2"
            >
                {duration > 0 ? (
                    <>End Break Early</>
                ) : (
                    <>
                        <PlayIcon className="w-5 h-5" /> Back to Flow
                    </>
                )}
            </button>
        </div>
    );
};

export const CurrentView: React.FC<CurrentViewProps> = ({ currentTask, goals, allTasks, completeTask, addSubtasks, onFrogEaten, deprioritizeTask, openEditModal, updateTask, hashtagConfigs, onSelectHashtag, amalgam, trackBreakTime, onAwardXp, isAiEnabled = false, focusSession = null, onStartFocusSession, onPauseFocusSession, onResumeFocusSession, onStopFocusSession, onExtendFocusSession }) => {
    
    const [isExpiryModalOpen, setIsExpiryModalOpen] = useState(false);
    const [isFlowModalOpen, setIsFlowModalOpen] = useState(false);
    const [isBreakSetupOpen, setIsBreakSetupOpen] = useState(false);
    const [isBreakdownModalOpen, setIsBreakdownModalOpen] = useState(false);
    const [showYellowPad, setShowYellowPad] = useState(false);
    const [padContent, setPadContent] = useState('');
    const noteDrafts = useRef(new Map<string, { text: string; base: string }>());
    const noteTaskId = useRef<string | null>(null);
    const [isTimeAdjOpen, setIsTimeAdjOpen] = useState(false);
    const [customDurationInput, setCustomDurationInput] = useState('');
    
    // Breakdown State
    const [breakdownLoading, setBreakdownLoading] = useState(false);
    const [breakdownSuggestions, setBreakdownSuggestions] = useState<AiSubtask[]>([]);
    const [stagedSubtasks, setStagedSubtasks] = useState<{title: string, duration: number}[]>([]);
    const [manualSubtaskInput, setManualSubtaskInput] = useState('');

    const [isTickingMuted, setIsTickingMuted] = useState(false);
    const [tickingVolume, setTickingVolume] = useState(1.0);
    const lastTickSecondsRef = useRef<number | null>(null);
    

    const [breakMode, setBreakMode] = useState<{active: boolean, duration: number}>({ active: false, duration: 5 });
    const [defaultBreakDuration, setDefaultBreakDuration] = useState(5);

    const [isReframeOpen, setIsReframeOpen] = useState(false);
    const [visualizationPrompt, setVisualizationPrompt] = useState<string | null>(null);
    
    const [lastSessionData, setLastSessionData] = useState<{ duration: number, rating: FlowState } | null>(null);
    const [flowOffset, setFlowOffset] = useState(0);
    const lastCheckpointRef = useRef<number>(0);

    // Auto Next State
    const [autoNextProgress, setAutoNextProgress] = useState(0);
    const [isAutoNext, setIsAutoNext] = useState(false);
    const autoNextAnimationRef = useRef<number | undefined>(undefined);
    const autoNextStartTimeRef = useRef<number>(0);
    
    // Countdown for Auto-Start Break
    const [autoStartCountdown, setAutoStartCountdown] = useState<number | null>(null);

    // Calculate Recommendation Logic early for use in auto-next
    let breakRecommendation = { type: 'break', message: 'Time to recharge.' };
    let primaryActionIsFlow = false;

    if (lastSessionData) {
        const { duration, rating } = lastSessionData;
        if (duration < 25) {
            if (rating === 'distracted') {
                breakRecommendation = { type: 'break', message: 'Distracted? Reset with a short break.' };
            } else {
                breakRecommendation = { type: 'flow', message: 'Momentum is high! Keep flowing.' };
                primaryActionIsFlow = true;
            }
        } else if (duration >= 50) {
            breakRecommendation = { type: 'break', message: 'Long session. Take a solid break.' };
        } else {
            breakRecommendation = { type: 'break', message: 'Good session. Take a breather.' };
        }
    }

    const handleTimerExpire = useCallback(() => {
        playAlarmSound();
        if (currentTask?.isBreak) {
            completeTask(currentTask.id, currentTask.duration, undefined, "Break completed");
            setIsExpiryModalOpen(true);
        } else {
            setIsExpiryModalOpen(true);
        }
    }, [currentTask, completeTask]);

    // Initialize Timer Hook Locally
    const timer = useFocusTimer({
        taskDurationInMinutes: currentTask?.duration || 25, // Default to 25 if undefined
        onExpire: handleTimerExpire,
        taskId: currentTask?.id,
        sharedSession: !currentTask?.isBreak,
        focusSession,
        onStart: onStartFocusSession,
        onPause: onPauseFocusSession,
        onResume: onResumeFocusSession,
        onStop: onStopFocusSession,
        onExtend: onExtendFocusSession
    });

    const { displaySeconds, elapsedSeconds, isActive, timerType, toggleTimer, addTime, hasExpired } = timer;

    const padContentRef = useRef(padContent);
    const currentTaskRef = useRef(currentTask);
    const openEditModalRef = useRef(openEditModal);
    const breakModeRef = useRef(breakMode);

    useEffect(() => { padContentRef.current = padContent; }, [padContent]);
    useEffect(() => { currentTaskRef.current = currentTask; }, [currentTask]);
    useEffect(() => { openEditModalRef.current = openEditModal; }, [openEditModal]);
    useEffect(() => { breakModeRef.current = breakMode; }, [breakMode]);

    // Auto-Start Break Logic
    useEffect(() => {
        if (currentTask?.isBreak && !isActive && elapsedSeconds === 0) {
            // Start countdown from 3
            if (autoStartCountdown === null) setAutoStartCountdown(3);
            
            const timer = setTimeout(() => {
                if (autoStartCountdown !== null && autoStartCountdown > 0) {
                    setAutoStartCountdown(prev => (prev || 0) - 1);
                } else if (autoStartCountdown === 0) {
                    toggleTimer();
                    setAutoStartCountdown(null);
                }
            }, 1000);
            return () => clearTimeout(timer);
        }
    }, [currentTask, isActive, elapsedSeconds, toggleTimer, autoStartCountdown]);

    // Reset flow offset if queue is empty or context switch
    useEffect(() => {
        if (!currentTask) {
            setFlowOffset(0);
            lastCheckpointRef.current = 0;
        }
    }, [currentTask]);

    // Continuous Work Rewards Logic
    useEffect(() => {
        if (currentTask?.isBreak) return;

        // Calculate total elapsed including offset
        const totalElapsed = elapsedSeconds + flowOffset;
        const totalMinutes = Math.floor(totalElapsed / 60);

        if (totalMinutes === 10 && lastCheckpointRef.current < 10) {
            onAwardXp(5, "10 min momentum! Keep flowing.", "milestone");
            lastCheckpointRef.current = 10;
        } else if (totalMinutes === 25 && lastCheckpointRef.current < 25) {
            onAwardXp(15, "25 min Deep Work! You're crushing it.", "reward");
            lastCheckpointRef.current = 25;
        } else if (totalMinutes === 50 && lastCheckpointRef.current < 50) {
            onAwardXp(30, "50 min Mastery! Time to celebrate.", "reward");
            lastCheckpointRef.current = 50;
        }
    }, [elapsedSeconds, flowOffset, onAwardXp, currentTask]);

    useEffect(() => {
        if (hasExpired) {
             setIsExpiryModalOpen(true);
        }
    }, [hasExpired]);

    const savePadContent = useCallback(() => {
        const task = currentTaskRef.current;
        const content = padContentRef.current;
        if (task && content !== task.description) {
            updateTask(task.id, { description: content });
        }
    }, [updateTask]);

    const handleDoneClick = useCallback(() => {
        savePadContent();
        if (currentTask?.isBreak) {
            completeTask(currentTask.id, Math.ceil(elapsedSeconds / 60), undefined, "Break finished");
            return;
        }
        setIsFlowModalOpen(true);
    }, [savePadContent, currentTask, completeTask, elapsedSeconds]);

    const handleDoneClickRef = useRef(handleDoneClick);
    useEffect(() => { handleDoneClickRef.current = handleDoneClick; }, [handleDoneClick]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (breakModeRef.current.active) return; 

            const target = e.target as HTMLElement;
            const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
            
            if (isInput) return;

            if (e.code === 'Space') {
                e.preventDefault();
                // Only allow toggling if there is a task
                if (currentTaskRef.current) {
                    toggleTimer();
                } 
            } else if (e.key.toLowerCase() === 'n') {
                e.preventDefault();
                setShowYellowPad(prev => !prev);
            } else if (e.key.toLowerCase() === 'e') {
                e.preventDefault();
                if (currentTaskRef.current) openEditModalRef.current(currentTaskRef.current);
            } else if (e.key.toLowerCase() === 'd') {
                e.preventDefault();
                if (currentTaskRef.current) handleDoneClickRef.current();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [toggleTimer]); 

    const { playTick } = useTickingSound();

    useEffect(() => {
        // Safe check: Only tick if active, not muted, AND there is a current task.
        if(isActive && !isTickingMuted && currentTask && !currentTask.isBreak) {
            if (displaySeconds !== lastTickSecondsRef.current) {
                playTick(tickingVolume);
                lastTickSecondsRef.current = displaySeconds;
            }
        }
    }, [displaySeconds, isActive, playTick, isTickingMuted, tickingVolume, currentTask]);
    
    useEffect(() => {
        if (currentTask) {
             const priorId = noteTaskId.current;
             if (priorId && priorId !== currentTask.id) {
                 const draft = noteDrafts.current.get(priorId);
                 if (draft) draft.text = padContentRef.current;
             }
             const draft = noteDrafts.current.get(currentTask.id) ?? { text: currentTask.description || '', base: currentTask.description || '' };
             noteDrafts.current.set(currentTask.id, draft);
             noteTaskId.current = currentTask.id;
             padContentRef.current = draft.text;
             setPadContent(draft.text);
             if (currentTask.description) setShowYellowPad(true);
             setVisualizationPrompt(null);
        }
    }, [currentTask?.id]); 
    
    useEffect(() => {
        if (isAiEnabled && isActive && currentTask && !currentTask.isBreak && !visualizationPrompt) {
            getVisualizationPrompt(currentTask.title).then(prompt => {
                if (isActive) setVisualizationPrompt(prompt);
            });
        }
    }, [isActive, currentTask, isAiEnabled]);

    const confirmCompletion = useCallback((flow: FlowState) => {
        setIsFlowModalOpen(false);
        
        if (currentTask?.isFrog) onFrogEaten();

        if (currentTask) {
            const durationInMinutes = Math.ceil(elapsedSeconds / 60);
            const finalDuration = durationInMinutes > 0 ? durationInMinutes : 1;
            
            setLastSessionData({ duration: finalDuration, rating: flow });
            
            if (finalDuration >= 50) setDefaultBreakDuration(15);
            else setDefaultBreakDuration(5);

            completeTask(currentTask.id, finalDuration, flow, padContent);
            setIsBreakSetupOpen(true);
        }
    }, [currentTask, elapsedSeconds, padContent, onFrogEaten, completeTask]);

    const startImmediateBreak = useCallback((duration: number) => {
        setIsBreakSetupOpen(false);
        setBreakMode({ active: true, duration });
    }, []);

    const handleContinueFlowing = useCallback(() => {
        if (lastSessionData) {
            // Accumulate flow offset (convert minutes to seconds)
            setFlowOffset(prev => prev + (lastSessionData.duration * 60));
        }
        setIsBreakSetupOpen(false);
        // Automatically start the next task only if it exists
        // We use the prop directly here to ensure we are checking the latest state after re-render
        if (currentTask) {
            toggleTimer(); 
        }
    }, [lastSessionData, toggleTimer, currentTask]);

    // --- AUTO NEXT FEATURE ---
    const stopAutoNext = useCallback(() => {
        setIsAutoNext(false);
        setAutoNextProgress(0);
        if (autoNextAnimationRef.current) cancelAnimationFrame(autoNextAnimationRef.current);
    }, []);

    const executeDefaultRef = useRef<() => void>(() => {});

    useEffect(() => {
        executeDefaultRef.current = () => {
            if (primaryActionIsFlow) handleContinueFlowing();
            else startImmediateBreak(defaultBreakDuration);
        };
    }, [primaryActionIsFlow, handleContinueFlowing, startImmediateBreak, defaultBreakDuration]);

    useEffect(() => {
        if (isBreakSetupOpen) {
            setIsAutoNext(true);
            setAutoNextProgress(0);
            autoNextStartTimeRef.current = Date.now();
            const duration = 5000;

            const loop = () => {
                const now = Date.now();
                const elapsed = now - autoNextStartTimeRef.current;
                const p = Math.min(100, (elapsed / duration) * 100);
                
                setAutoNextProgress(p);

                if (elapsed < duration) {
                    autoNextAnimationRef.current = requestAnimationFrame(loop);
                } else {
                    executeDefaultRef.current();
                    setIsAutoNext(false);
                }
            };
            autoNextAnimationRef.current = requestAnimationFrame(loop);
        } else {
            stopAutoNext();
        }
        return () => {
            if (autoNextAnimationRef.current) cancelAnimationFrame(autoNextAnimationRef.current);
        }
    }, [isBreakSetupOpen, stopAutoNext]); 

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isFlowModalOpen) {
                const keyMap: Record<string, FlowState> = {
                    '1': 'distracted',
                    '2': 'good',
                    '3': 'high',
                    '4': 'flow'
                };
                if (keyMap[e.key]) {
                    e.preventDefault();
                    confirmCompletion(keyMap[e.key]);
                }
            }
            
            if (isBreakSetupOpen) {
                if (e.key === '1') { e.preventDefault(); startImmediateBreak(5); }
                if (e.key === '2') { e.preventDefault(); startImmediateBreak(10); }
                if (e.key === '3') { e.preventDefault(); startImmediateBreak(20); }
                if (e.key === '4') { e.preventDefault(); startImmediateBreak(0); } // Open Ended
                
                if (e.key === 'Enter') {
                    e.preventDefault();
                    executeDefaultRef.current();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isFlowModalOpen, isBreakSetupOpen, confirmCompletion, startImmediateBreak]);

    const handleBreakComplete = (takenMinutes: number) => {
        setBreakMode({active: false, duration: 5});
        trackBreakTime(takenMinutes);
        // Reset flow offset on real break
        setFlowOffset(0);
        lastCheckpointRef.current = 0;
    };
    
    const handleSkip = () => {
        if (currentTask) {
            if (currentTask.isFrog) {
                 handleOpenBreakdown();
                 return;
            }
            savePadContent();
            deprioritizeTask(currentTask.id);
            setFlowOffset(0);
            lastCheckpointRef.current = 0;
        }
    };

    const handleOpenBreakdown = async () => {
        if (!currentTask) return;
        setIsBreakdownModalOpen(true);
        setBreakdownSuggestions([]);
        setStagedSubtasks([]);
        
        // Auto-fetch suggestions if empty and AI is enabled
        if (isAiEnabled) {
            setBreakdownLoading(true);
            try {
                const subtasks = await breakdownTaskWithGemini(currentTask.title);
                setBreakdownSuggestions(subtasks);
            } catch (e) {
                console.error(e);
            } finally {
                setBreakdownLoading(false);
            }
        }
    };

    const stageSubtask = (subtask: AiSubtask) => {
        setStagedSubtasks(prev => [...prev, { title: subtask.title, duration: subtask.estimatedDuration }]);
        setBreakdownSuggestions(prev => prev.filter(s => s.title !== subtask.title));
    };

    const stageManualSubtask = (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        if (!manualSubtaskInput.trim()) return;
        
        let duration = 30; 
        let cleanTitle = manualSubtaskInput;
        const durationMatch = manualSubtaskInput.match(/@(\d+)m/);
        if (durationMatch) {
            duration = parseInt(durationMatch[1]);
            cleanTitle = manualSubtaskInput.replace(durationMatch[0], '').trim();
        }
        
        setStagedSubtasks(prev => [...prev, { title: cleanTitle, duration }]);
        setManualSubtaskInput('');
    };

    const removeStagedSubtask = (index: number) => {
        setStagedSubtasks(prev => prev.filter((_, i) => i !== index));
    };

    const confirmBreakdown = () => {
        if (!currentTask) return;
        
        // Breakdown closes the parent without completion statistics or XP.
        addSubtasks(stagedSubtasks, currentTask);
        
        setIsBreakdownModalOpen(false);
        // Reset flow offset as context switched
        setFlowOffset(0);
        lastCheckpointRef.current = 0;
    };
    
    const handleEditDuration = () => {
        if (!currentTask) return;
        setIsTimeAdjOpen(true);
    };
    
    const handleCustomDurationUpdate = (e: React.FormEvent) => {
        e.preventDefault();
        const min = parseInt(customDurationInput, 10);
        if (!isNaN(min) && min > 0 && currentTask) {
            updateTask(currentTask.id, { duration: min });
            setCustomDurationInput('');
            setIsTimeAdjOpen(false);
        }
    };

    const totalDurationSeconds = (currentTask?.duration || 25) * 60; // Default to 25m
    const isLocked = (currentTask?.strikes || 0) >= 4 || (currentTask?.rescheduleCount || 0) >= 3;

    const primaryTag = currentTask?.hashtags[0];
    const primaryTagColor = primaryTag && hashtagConfigs[primaryTag] ? hashtagConfigs[primaryTag].color : undefined;

    if (breakMode.active) {
        return <BreakOverlay duration={breakMode.duration} onEnd={handleBreakComplete} />;
    }

    const breakOptions = [
        { val: 5, label: '5m', key: '1' },
        { val: 10, label: '10m', key: '2' },
        { val: 20, label: '20m', key: '3' },
        { val: 0, label: 'Open', key: '4' },
    ];

    const isBreak = currentTask?.isBreak;
    const isQuickie = (currentTask?.duration || 25) <= 2;

    return (
        <div className="max-w-5xl mx-auto relative rounded-[2.5rem] p-1 flex-grow flex flex-col">
            {currentTask ? (
                // CONDITIONAL RENDER: Check if Current Task is a Break
                isBreak ? (
                    <div className="flex flex-col items-center justify-center flex-grow w-full bg-teal-950 rounded-[2rem] border border-teal-900 relative overflow-hidden animate-fadeIn backdrop-blur-md min-h-[500px] p-8">
                        {/* Auto Start Indicator */}
                        {!isActive && autoStartCountdown !== null && autoStartCountdown > 0 && (
                            <div className="absolute top-10 left-1/2 transform -translate-x-1/2 bg-teal-500 text-white px-6 py-2 rounded-full font-bold text-sm shadow-lg animate-pulse z-20">
                                Starting in {autoStartCountdown}...
                            </div>
                        )}

                        <div className="text-center z-10 w-full max-w-lg">
                            <h2 className="text-4xl sm:text-6xl font-heading font-bold text-teal-100 mb-2 tracking-wide uppercase leading-tight break-words">
                                {currentTask.title}
                            </h2>
                            <p className="text-teal-400 text-lg font-medium tracking-widest uppercase mb-8 opacity-80">
                                Relax. Unplug. Recharge.
                            </p>
                            
                            <div className="flex justify-center mb-8">
                                <CircularTimer 
                                    seconds={displaySeconds} 
                                    totalSeconds={totalDurationSeconds} 
                                    flowOffset={0}
                                    isActive={isActive} 
                                    timerType={timerType}
                                    onTimeClick={() => {}} // No editing for break timer
                                    primaryColor="#14b8a6"
                                    isBreak={true}
                                />
                            </div>
                            
                            <button 
                                onClick={handleDoneClick}
                                className="px-10 py-4 bg-teal-600 text-white font-bold text-lg rounded-full hover:bg-teal-500 transition-all shadow-xl shadow-teal-900/50 hover:scale-105 active:scale-95 flex items-center gap-3 mx-auto border border-teal-400/20"
                            >
                                <CheckIcon className="w-6 h-6" />
                                Finish Break
                            </button>
                        </div>
                        
                        {/* Background Elements */}
                        <div className="absolute inset-0 pointer-events-none opacity-20">
                             <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-teal-600 rounded-full blur-[120px]"></div>
                             <div className="absolute bottom-[-20%] right-[-10%] w-[60%] h-[60%] bg-cyan-700 rounded-full blur-[120px]"></div>
                        </div>
                    </div>
                ) : (
                    // STANDARD TASK VIEW
                    <div className="bg-white/80 dark:bg-slate-800/80 backdrop-blur-md rounded-[2rem] shadow-xl shadow-indigo-100/50 dark:shadow-none overflow-hidden border border-white dark:border-slate-700 relative z-10 flex flex-col md:flex-row min-h-[600px] transition-colors duration-500 flex-grow">
                        
                        <div className={`flex-grow flex flex-col transition-all duration-300 ${showYellowPad ? 'md:w-3/5' : 'w-full'} relative z-10`}>
                            {amalgam && (
                                <div className="w-full bg-indigo-50/50 dark:bg-slate-900/50 border-b border-indigo-100/20 dark:border-slate-700 py-2 text-center backdrop-blur-sm shrink-0">
                                    <span className="text-[10px] font-bold tracking-[0.2em] text-indigo-400/80 uppercase animate-pulse">
                                        {amalgam}
                                    </span>
                                </div>
                            )}

                            <div className="p-6 flex justify-between items-center relative">
                                <div className="flex gap-2">
                                    <button onClick={() => setIsReframeOpen(true)} className="px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/40 transition flex items-center">
                                        <RefreshIcon className="w-3 h-3 mr-1"/> Reframe
                                    </button>
                                </div>

                                <div className="absolute left-1/2 transform -translate-x-1/2 flex items-center gap-2 bg-gray-50 dark:bg-slate-700/50 rounded-full px-3 py-1 border border-gray-100 dark:border-slate-600 shadow-sm">
                                    <button 
                                        onClick={() => setIsTickingMuted(!isTickingMuted)}
                                        className="text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                                        title={isTickingMuted ? "Unmute Ticking" : "Mute Ticking"}
                                    >
                                        {isTickingMuted ? <VolumeXIcon className="w-4 h-4"/> : <Volume2Icon className="w-4 h-4"/>}
                                    </button>
                                    <input 
                                        type="range" 
                                        min="0" 
                                        max="3" 
                                        step="0.1" 
                                        value={tickingVolume}
                                        onChange={(e) => setTickingVolume(parseFloat(e.target.value))}
                                        className="w-16 h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-600 accent-indigo-500"
                                    />
                                </div>

                                <div className="flex gap-2">
                                    <button onClick={() => setShowYellowPad(!showYellowPad)} className={`p-2 rounded-full transition ${showYellowPad ? 'bg-yellow-100 text-yellow-700' : 'text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-slate-700 dark:hover:text-indigo-400'}`} title="Toggle Notes (N)">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                                    </button>
                                    <button onClick={() => openEditModal(currentTask)} className="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-slate-700 dark:hover:text-indigo-400 rounded-full transition" title="Edit Task (E)">
                                        <PencilIcon className="w-5 h-5" />
                                    </button>
                                </div>
                            </div>

                            <div className="px-8 pb-10 flex flex-col items-center justify-center flex-grow">
                                {isLocked && isAiEnabled && (
                                    <div className="mb-4 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-300 px-4 py-2 rounded-xl text-center font-bold text-sm animate-pulse border border-red-200 dark:border-red-800">
                                        🛑 Task Hardened: Breakdown Required
                                    </div>
                                )}

                                <CircularTimer 
                                    seconds={displaySeconds} 
                                    totalSeconds={totalDurationSeconds} 
                                    flowOffset={flowOffset}
                                    isActive={isActive} 
                                    timerType={timerType}
                                    onTimeClick={handleEditDuration}
                                    primaryColor={primaryTagColor}
                                    isBreak={false}
                                />

                                {isAiEnabled && isActive && (
                                    <div className="text-center mb-8 px-4 animate-[fadeIn_1s_ease-out_forwards] z-10 max-w-lg mx-auto opacity-0 animate-[fadeIn_1s_ease-out_forwards_0.5s]">
                                        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-slate-700 dark:to-slate-800 p-4 rounded-xl border border-indigo-100 dark:border-slate-600 shadow-sm">
                                            <p className="text-sm font-medium text-indigo-900 dark:text-indigo-100 max-w-md mx-auto leading-relaxed italic">
                                                "{visualizationPrompt || "Imagine completing this task easily and gracefully."}"
                                            </p>
                                        </div>
                                    </div>
                                )}

                                <h2 className="text-4xl sm:text-5xl font-heading font-semibold text-gray-900 dark:text-white leading-tight mb-4 px-4 text-center z-10">{currentTask.title}</h2>
                                
                                <div className="flex flex-wrap items-center justify-center gap-2 mb-10 z-10">
                                    {currentTask.isFrog && (
                                        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-100 dark:border-green-800">
                                        🐸 Frog
                                        </span>
                                    )}
                                    {isQuickie && (
                                        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 border border-yellow-100 dark:border-yellow-800">
                                        ⚡️ Quickie
                                        </span>
                                    )}
                                    {(currentTask.strikes || 0) > 0 && (
                                        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-800">
                                        {currentTask.strikes} Strikes
                                        </span>
                                    )}
                                    {currentTask.hashtags.map(tag => (
                                        <button 
                                            key={tag} 
                                            onClick={() => onSelectHashtag(tag)}
                                            className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide border transition shadow-sm hover:shadow-md"
                                            style={{ 
                                                backgroundColor: hashtagConfigs[tag]?.color || '#eff6ff', 
                                                borderColor: hashtagConfigs[tag]?.color || '#dbeafe',
                                                color: hashtagConfigs[tag] ? '#fff' : '#2563eb'
                                            }}
                                        >
                                            #{tag}
                                        </button>
                                    ))}
                                </div>

                                <div className="flex items-center justify-center gap-8 w-full max-w-md mt-auto z-10">
                                    {isLocked && isAiEnabled ? (
                                        <button 
                                            onClick={handleOpenBreakdown}
                                            className="w-full py-4 bg-red-600 text-white rounded-2xl font-bold text-lg hover:bg-red-700 transition shadow-lg shadow-red-200 dark:shadow-none animate-pulse flex items-center justify-center gap-2"
                                        >
                                            <AxeIcon className="w-6 h-6" /> Break Down Now
                                        </button>
                                    ) : (
                                        <>
                                            {currentTask.isFrog ? <button onClick={handleOpenBreakdown} className="flex flex-col items-center gap-3 group w-20" title="Frogs cannot be skipped">
                                                <div className="w-14 h-14 rounded-2xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 flex items-center justify-center text-red-600 dark:text-red-400 transition shadow-sm transform group-active:scale-95"><AxeIcon className="w-6 h-6" /></div>
                                                <span className="text-xs font-bold text-red-600 dark:text-red-400 uppercase tracking-widest">Break down</span>
                                            </button> : <button onClick={handleSkip} className="flex flex-col items-center gap-3 group w-20">
                                                <div className="w-14 h-14 rounded-2xl bg-white dark:bg-slate-700 border border-gray-200 dark:border-slate-600 flex items-center justify-center text-gray-400 dark:text-gray-500 group-hover:border-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition shadow-sm transform group-active:scale-95">
                                                    <SkipIcon className="w-6 h-6" />
                                                </div>
                                                <span className="text-xs font-bold text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 uppercase tracking-widest">Later</span>
                                            </button>}

                                            <button 
                                                onClick={toggleTimer} 
                                                className={`w-24 h-24 rounded-3xl flex items-center justify-center text-white shadow-xl shadow-indigo-200 dark:shadow-none transform transition-all hover:scale-105 active:scale-95 ${isActive ? 'bg-amber-500 hover:bg-amber-600' : 'bg-indigo-600 hover:bg-indigo-700'}`} 
                                                title={isActive ? "Pause Timer (Space)" : "Start Focus (Space)"}
                                            >
                                                {isActive ? 
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="2"></rect><rect x="14" y="4" width="4" height="16" rx="2"></rect></svg>
                                                    :
                                                    <PlayIcon className="w-10 h-10 ml-1" fill="currentColor" />
                                                }
                                            </button>

                                            <button onClick={handleDoneClick} className="flex flex-col items-center gap-3 group w-20" title="Done (D)">
                                                <div className="w-14 h-14 rounded-2xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 flex items-center justify-center text-green-600 dark:text-green-500 group-hover:bg-green-100 dark:group-hover:bg-green-900/40 group-hover:border-green-300 transition shadow-sm transform group-active:scale-95">
                                                    <CheckIcon className="w-7 h-7" />
                                                </div>
                                                <span className="text-xs font-bold text-gray-400 group-hover:text-green-700 dark:group-hover:text-green-400 uppercase tracking-widest">Done</span>
                                            </button>
                                        </>
                                    )}
                                </div>
                                
                                {(!isLocked || !isAiEnabled) && (
                                    <button 
                                        onClick={handleOpenBreakdown}
                                        className="absolute bottom-6 right-6 p-3 bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-full text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:shadow-md transition z-20 group"
                                        title="Breakdown Task"
                                    >
                                        <AxeIcon className="w-5 h-5 group-hover:rotate-12 transition-transform" />
                                    </button>
                                )}
                            </div>
                        </div>

                        {showYellowPad && (
                            <div className="w-full md:w-2/5 border-t md:border-t-0 md:border-l border-gray-100 dark:border-slate-700 h-[500px] md:h-auto animate-slideIn z-20">
                                <YellowPad 
                                    key={currentTask.id} 
                                    content={padContent} 
                                    onChange={text => {
                                        padContentRef.current = text;
                                        const draft = noteDrafts.current.get(currentTask.id);
                                        if (draft) draft.text = text;
                                        setPadContent(text);
                                    }}
                                    onBlur={savePadContent}
                                    className="h-full"
                                    placeholder="Add session notes..."
                                    autoFocus={true}
                                />
                            </div>
                        )}
                    </div>
                )
            ) : (
                 <div className="flex flex-col justify-center items-center h-[60vh] text-center px-4 animate-fadeIn flex-grow">
                    <div className="w-32 h-32 bg-green-50 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-8 animate-bounce shadow-xl shadow-green-100/50 dark:shadow-none border border-green-100 dark:border-green-800">
                        <CheckIcon className="w-16 h-16 text-green-600 dark:text-green-400" />
                    </div>
                    <h2 className="text-6xl font-heading font-bold text-gray-800 dark:text-white mb-4 tracking-wide">All Clear!</h2>
                    <p className="text-xl text-gray-500 dark:text-gray-400 max-w-md leading-relaxed">
                        Zero tasks remaining in your queue. <br/>
                        <span className="text-indigo-600 dark:text-indigo-400 font-bold">You're unstoppable.</span>
                    </p>
                </div>
            )}

            {/* --- MODALS --- */}
            
            {/* BREAKDOWN MODE MODAL - Reusing existing structure */}
            <Modal isOpen={isBreakdownModalOpen} onClose={() => setIsBreakdownModalOpen(false)} title="Break It Down">
                <div className="p-6 flex flex-col h-[70vh]">
                    <div className="mb-4">
                        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-1">"{currentTask?.title}"</h3>
                        <p className="text-gray-500 dark:text-gray-400 text-sm">
                            {(isAiEnabled && (breakdownLoading || breakdownSuggestions.length > 0)) 
                                ? "Select suggestions or add steps manually. Original task will be marked as broken down." 
                                : "Add subtasks below manually. Original task will be marked as broken down."}
                        </p>
                    </div>

                    <div className="flex-grow overflow-y-auto custom-scrollbar space-y-6 pr-2">
                        {/* Staging Area */}
                        <div className="p-5 bg-indigo-50/50 dark:bg-indigo-900/20 rounded-2xl border border-indigo-100 dark:border-indigo-800">
                            <div className="flex justify-between items-center mb-3">
                                <h4 className="font-bold text-indigo-900 dark:text-indigo-300 flex items-center text-xs uppercase tracking-wider">
                                    <AxeIcon className="w-4 h-4 mr-2 text-indigo-500" />
                                    New Subtasks
                                </h4>
                                <span className="text-xs font-bold text-indigo-400 bg-white dark:bg-slate-800 px-2 py-0.5 rounded-full shadow-sm">{stagedSubtasks.length}</span>
                            </div>
                            
                            <div className="space-y-2 mb-4">
                                {stagedSubtasks.map((st, i) => (
                                    <div key={i} className="flex items-center justify-between p-3 bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-indigo-100 dark:border-indigo-900/50 group">
                                        <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{st.title}</span>
                                        <div className="flex items-center gap-3">
                                            <span className="text-[10px] font-bold text-gray-400 bg-gray-50 dark:bg-slate-700 px-1.5 py-0.5 rounded">{st.duration}m</span>
                                            <button 
                                                type="button" 
                                                onClick={() => removeStagedSubtask(i)}
                                                className="text-red-400 hover:text-red-600 transition opacity-0 group-hover:opacity-100"
                                            >
                                                <TrashIcon className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                                {stagedSubtasks.length === 0 && (
                                    <div className="text-center py-4 text-gray-400 dark:text-gray-500 text-sm italic border-2 border-dashed border-indigo-100 dark:border-indigo-900/30 rounded-xl">
                                        Add subtasks below manually{(isAiEnabled && (breakdownLoading || breakdownSuggestions.length > 0)) ? " or use AI suggestions" : ""}.
                                    </div>
                                )}
                            </div>

                            {/* Manual Input */}
                            <div className="flex gap-2">
                                <input 
                                    type="text"
                                    value={manualSubtaskInput}
                                    onChange={(e) => setManualSubtaskInput(e.target.value)}
                                    placeholder="Add a step (e.g., Research @15m)..."
                                    className="flex-grow p-3 text-sm rounded-xl border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none dark:text-white"
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stageManualSubtask(); }}}
                                    autoFocus
                                />
                                <button 
                                    type="button"
                                    onClick={(e) => stageManualSubtask(e)}
                                    className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-4 transition"
                                >
                                    <PlusIcon className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        {/* AI Suggestions (Only if Enabled and has content/loading) */}
                        {isAiEnabled && (breakdownLoading || breakdownSuggestions.length > 0) && (
                            <div className="p-4 bg-purple-50/50 dark:bg-purple-900/10 rounded-2xl border border-purple-100 dark:border-purple-800/30">
                                <h4 className="font-bold text-purple-900 dark:text-purple-300 flex items-center text-xs uppercase tracking-wider mb-3">
                                    <BrainCircuit className="w-4 h-4 mr-2 text-purple-500" />
                                    AI Suggestions
                                </h4>
                                
                                {breakdownLoading ? (
                                    <div className="text-center py-8">
                                        <div className="inline-block w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                                        <p className="text-xs text-purple-400 mt-2">Generating ideas...</p>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 gap-2">
                                        {breakdownSuggestions.map((subtask, index) => (
                                        <div 
                                            key={index} 
                                            className="flex items-center justify-between p-3 bg-white dark:bg-slate-800 rounded-xl border border-purple-50 dark:border-slate-700 hover:border-purple-300 hover:shadow-sm transition group cursor-pointer" 
                                            onClick={() => stageSubtask(subtask)}
                                        >
                                            <div className="flex items-center gap-3">
                                                <span className="font-medium text-gray-700 dark:text-gray-300 text-sm">{subtask.title}</span>
                                                <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-slate-700 px-1.5 py-0.5 rounded">
                                                    {subtask.estimatedDuration}m
                                                </span>
                                            </div>
                                            <PlusIcon className="w-4 h-4 text-purple-400 group-hover:text-purple-600" />
                                        </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="pt-4 border-t border-gray-100 dark:border-slate-700 mt-auto">
                        <button 
                            onClick={confirmBreakdown}
                            disabled={stagedSubtasks.length === 0}
                            className={`w-full py-4 bg-indigo-600 text-white rounded-xl font-bold text-lg hover:bg-indigo-700 transition shadow-lg flex items-center justify-center gap-2 ${stagedSubtasks.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            <AxeIcon className="w-5 h-5" />
                            {stagedSubtasks.length > 0 ? `Create ${stagedSubtasks.length} Subtasks` : 'Add tasks to proceed'}
                        </button>
                    </div>
                </div>
            </Modal>

            <Modal isOpen={isTimeAdjOpen} onClose={() => setIsTimeAdjOpen(false)} title="Adjust Duration">
                <div className="p-6">
                    <p className="text-center text-gray-500 dark:text-gray-400 mb-6">Modify the remaining time for this session.</p>
                    
                    <div className="grid grid-cols-3 gap-4 mb-6">
                        <button onClick={() => { addTime(5); setIsTimeAdjOpen(false); }} className="py-4 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-xl font-bold hover:bg-indigo-100 dark:hover:bg-indigo-900/40 border border-indigo-200 dark:border-indigo-800 transition">
                            +5m
                        </button>
                        <button onClick={() => { addTime(10); setIsTimeAdjOpen(false); }} className="py-4 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-xl font-bold hover:bg-indigo-100 dark:hover:bg-indigo-900/40 border border-indigo-200 dark:border-indigo-800 transition">
                            +10m
                        </button>
                        <button onClick={() => { addTime(-5); setIsTimeAdjOpen(false); }} className="py-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl font-bold hover:bg-red-100 dark:hover:bg-red-900/40 border border-red-200 dark:border-red-800 transition">
                            -5m
                        </button>
                    </div>
                    
                    <form onSubmit={handleCustomDurationUpdate} className="flex gap-2">
                        <input 
                            type="number" 
                            placeholder="Set total duration (min)" 
                            value={customDurationInput}
                            onChange={(e) => setCustomDurationInput(e.target.value)}
                            className="flex-grow p-4 bg-gray-50 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 dark:text-white font-medium"
                            autoFocus
                        />
                        <button type="submit" className="px-6 bg-gray-900 dark:bg-indigo-600 text-white font-bold rounded-xl hover:bg-gray-800 dark:hover:bg-indigo-700 transition">
                            Set
                        </button>
                    </form>
                </div>
            </Modal>

            {/* ... other modals (Expiry, Flow, Reschedule, BreakSetup, Reframe) remain mostly the same ... */}
            <Modal isOpen={isExpiryModalOpen} onClose={() => setIsExpiryModalOpen(false)} title="Time's Up!">
                <div className="p-8 text-center">
                    <div className="relative w-24 h-24 mx-auto mb-6">
                        <div className="absolute inset-0 bg-amber-200 rounded-full animate-ping opacity-50"></div>
                        <div className="relative w-24 h-24 bg-amber-100 dark:bg-amber-900/30 text-amber-500 rounded-full flex items-center justify-center border-4 border-white dark:border-slate-800 shadow-xl">
                            <InfinityIcon className="w-10 h-10 animate-bounce" />
                        </div>
                    </div>
                    
                    <h3 className="text-2xl font-bold text-gray-800 dark:text-white mb-2">{isBreak ? 'Break Over' : 'Session Complete'}</h3>
                    <p className="text-gray-500 dark:text-gray-400 mb-8 max-w-sm mx-auto">
                        {isBreak ? "Hope you feel recharged. Ready to dive back in?" : "Great focus! Do you need more time to finish, or is it time to break it down?"}
                    </p>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                        <button onClick={() => { addTime(5); setIsExpiryModalOpen(false); }} className="group p-4 bg-white dark:bg-slate-800 border-2 border-indigo-100 dark:border-slate-700 rounded-2xl hover:border-indigo-500 dark:hover:border-indigo-500 hover:shadow-lg transition-all flex items-center justify-center gap-2">
                            <span className="w-8 h-8 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-xs font-bold group-hover:bg-indigo-600 group-hover:text-white transition-colors">+5</span>
                            <span className="font-bold text-gray-600 dark:text-gray-300 group-hover:text-indigo-600 dark:group-hover:text-indigo-400">Add 5 Mins</span>
                        </button>
                         <button onClick={() => { addTime(15); setIsExpiryModalOpen(false); }} className="group p-4 bg-white dark:bg-slate-800 border-2 border-indigo-100 dark:border-slate-700 rounded-2xl hover:border-indigo-500 dark:hover:border-indigo-500 hover:shadow-lg transition-all flex items-center justify-center gap-2">
                            <span className="w-8 h-8 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-xs font-bold group-hover:bg-indigo-600 group-hover:text-white transition-colors">+15</span>
                            <span className="font-bold text-gray-600 dark:text-gray-300 group-hover:text-indigo-600 dark:group-hover:text-indigo-400">Add 15 Mins</span>
                        </button>
                    </div>
                    
                    {!isBreak && (
                        <button onClick={() => { setIsExpiryModalOpen(false); handleOpenBreakdown(); }} className="w-full p-4 bg-gray-50 dark:bg-slate-700/50 text-gray-500 dark:text-gray-400 rounded-xl font-bold hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:text-purple-600 dark:hover:text-purple-300 transition flex items-center justify-center gap-2">
                            <AxeIcon className="w-5 h-5" /> I'm stuck, help me break it down
                        </button>
                    )}
                </div>
            </Modal>

             <Modal isOpen={isFlowModalOpen} onClose={() => setIsFlowModalOpen(false)} title="Check Out">
                <div className="text-center p-8">
                    <p className="text-gray-600 dark:text-gray-300 mb-8 font-medium">How was your focus during this session?</p>
                    <div className="grid grid-cols-2 gap-6 mb-4">
                        <button onClick={() => confirmCompletion('distracted')} className="relative p-6 border-2 border-gray-100 dark:border-slate-700 rounded-2xl hover:border-red-200 hover:bg-red-50 dark:hover:bg-red-900/20 transition flex flex-col items-center gap-3">
                            <span className="absolute top-2 right-2 text-[10px] font-mono text-gray-300 dark:text-gray-600">[1]</span>
                            <span className="text-4xl">😫</span>
                            <span className="text-sm font-bold text-gray-600 dark:text-gray-300">Distracted</span>
                        </button>
                         <button onClick={() => confirmCompletion('good')} className="relative p-6 border-2 border-gray-100 dark:border-slate-700 rounded-2xl hover:border-blue-200 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition flex flex-col items-center gap-3">
                            <span className="absolute top-2 right-2 text-[10px] font-mono text-gray-300 dark:text-gray-600">[2]</span>
                            <span className="text-4xl">🙂</span>
                            <span className="text-sm font-bold text-gray-600 dark:text-gray-300">Good Focus</span>
                        </button>
                         <button onClick={() => confirmCompletion('high')} className="relative p-6 border-2 border-gray-100 dark:border-slate-700 rounded-2xl hover:border-indigo-200 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition flex flex-col items-center gap-3">
                            <span className="absolute top-2 right-2 text-[10px] font-mono text-gray-300 dark:text-gray-600">[3]</span>
                            <span className="text-4xl">🚀</span>
                            <span className="text-sm font-bold text-gray-600 dark:text-gray-300">Highly Focused</span>
                        </button>
                         <button onClick={() => confirmCompletion('flow')} className="relative p-6 border-2 border-gray-100 dark:border-slate-700 rounded-2xl hover:border-purple-200 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition flex flex-col items-center gap-3">
                            <span className="absolute top-2 right-2 text-[10px] font-mono text-gray-300 dark:text-gray-600">[4]</span>
                            <span className="text-4xl">🌊</span>
                            <span className="text-sm font-bold text-gray-600 dark:text-gray-300">Flow State</span>
                        </button>
                    </div>
                </div>
            </Modal>
            
            <Modal isOpen={isBreakSetupOpen} onClose={() => setIsBreakSetupOpen(false)} title="Session Complete">
                <div className="p-6 text-center">
                     <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 animate-scaleIn ${breakRecommendation.type === 'flow' ? 'bg-indigo-100 dark:bg-indigo-900/30' : 'bg-green-100 dark:bg-green-900/30'}`}>
                        <span className="text-4xl">{breakRecommendation.type === 'flow' ? '🌊' : '☕'}</span>
                     </div>
                     <h3 className="text-xl font-bold text-gray-800 dark:text-white mb-2">{breakRecommendation.type === 'flow' ? 'Keep the momentum?' : 'Time to recharge?'}</h3>
                     <p className="text-gray-500 dark:text-gray-400 mb-8">{breakRecommendation.message}</p>
                     
                     <div 
                        className="grid grid-cols-4 gap-3 mb-8"
                        onMouseEnter={stopAutoNext}
                     >
                        {breakOptions.map((opt) => (
                            <button
                                key={opt.key}
                                onClick={() => startImmediateBreak(opt.val)}
                                className={`py-3 rounded-xl font-bold transition-all relative bg-gray-50 dark:bg-slate-700 text-gray-600 dark:text-gray-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:text-indigo-600 dark:hover:text-indigo-300 hover:scale-105 hover:shadow-md border border-transparent hover:border-indigo-100 dark:hover:border-slate-600`}
                            >
                                <span className="absolute top-1 right-1 text-[8px] opacity-50 font-mono">[{opt.key}]</span>
                                {opt.label}
                            </button>
                        ))}
                     </div>
                     
                     <div className="relative">
                         <div className="absolute inset-x-0 top-1/2 h-px bg-gray-200 dark:bg-slate-700"></div>
                         <span className="relative bg-white dark:bg-slate-800 px-3 text-xs font-bold text-gray-400 uppercase">Or</span>
                     </div>

                     <div className="mt-8" onMouseEnter={stopAutoNext}>
                        <button 
                            onClick={handleContinueFlowing}
                            className={`w-full py-4 bg-gray-900 dark:bg-indigo-600 text-white rounded-xl font-bold shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all flex items-center justify-center gap-3 group relative overflow-hidden`}
                        >
                            {isAutoNext && (
                                <div className="absolute bottom-0 left-0 h-1 bg-white/30 transition-all duration-100 ease-linear" style={{ width: `${autoNextProgress}%` }}></div>
                            )}
                            <span className="relative z-10 text-lg">Continue Flowing</span>
                            <span className="relative z-10 text-xs font-mono opacity-60 ml-1">[Enter]</span>
                            <PlayIcon className="w-5 h-5 relative z-10 group-hover:translate-x-1 transition-transform" />
                        </button>
                     </div>
                </div>
            </Modal>
        </div>
    );
};
