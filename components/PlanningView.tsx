
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Task, Session, Goal, HashtagConfig, CircadianState, FlowState, BioMetrics } from '../types';
import { PencilIcon, RepeatIcon, CompassIcon, ArrowUpCircleIcon, PlusIcon, SunIcon, TrashIcon, AxeIcon, MoonIcon, ZapIcon, CoffeeIcon, FlameIcon, StickyNoteIcon, CalendarIcon, CheckIcon, InfinityIcon, UtensilsIcon, BrainCircuit, ActivityIcon } from './Icons';
import { formatDuration } from '../utils/timeAndTagParser';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { formatDisplayDate, getTodayYYYYMMDD, getTomorrowYYYYMMDD, toYYYYMMDD } from '../utils/dateUtils';
import { Modal } from './Modal';
import { ExcitementPlanner } from './ExcitementPlanner';
import { YellowPad } from './YellowPad';
import { DatePicker } from './DatePicker';
import { getPhotoperiod, getSeasonalSleepRecommendation } from '../utils/sunUtils';

// --- Types & Interfaces ---

interface PlanningViewProps {
    modeControl?: React.ReactNode;
    todayTasks: Task[];
    upcomingTasks: Task[];
    allTasks: Task[];
    goals: Goal[];
    setFrog: (id: string) => void;
    openEditModal: (task: Task) => void;
    deleteTask: (id: string) => void;
    reorderTodayTasks: (taskId: string, sourceSession: any, sourceIndex: number, destSession: any, destIndex: number) => void;
    hashtagConfigs: Record<string, HashtagConfig>;
    updateTaskPriorities: (updates: Record<string, { excitement: number, roi: number }>) => void;
    moveTaskToTopToday: (id: string) => void;
    onSelectHashtag: (tag: string) => void;
    overdueTasks: Task[];
    markWontDo: (id: string) => void;
    onAddTask: (overrides?: { session?: Session, dateAssigned?: string, isBreak?: boolean }) => void;
    updateTask: (id: string, updates: Partial<Task>) => void;
    onRescheduleTask: (id: string, date: string) => boolean;
    circadianState: CircadianState;
    addSubtasks: (subtasks: {title: string, duration: number}[], parent: Task) => void;
    completeTask: (id: string, duration?: number, flowState?: FlowState, finalDescription?: string) => void;
    isAiEnabled?: boolean;
    createTask?: (task: { title: string; description?: string; dateAssigned: string, goalId?: string, isFrog?: boolean, isRepetitive?: boolean, duration?: number, isBreak?: boolean }) => void;
    sortTodayTasksCircadian: () => void;
}

// ... (BreakCreationModal, DurationEstimatorModal, NoteEditorModal, RescheduleDropModal, HorizonTaskCard remain the same as previous)

const BreakCreationModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onSave: (duration: number) => void;
}> = ({ isOpen, onClose, onSave }) => {
    const [duration, setDuration] = useState(15);
    
    if (!isOpen) return null;

    const handleSave = () => {
        onSave(duration);
        onClose();
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Schedule Break">
            <div className="p-6 flex flex-col gap-8">
                {/* Duration Selection */}
                <div>
                    <div className="flex justify-between items-end mb-4">
                        <label className="text-xs font-bold uppercase text-gray-400 tracking-wider">Duration</label>
                        <span className="text-4xl font-heading font-bold text-teal-600 dark:text-teal-400">{duration}m</span>
                    </div>
                    
                    <input 
                        type="range" 
                        min="5" 
                        max="120" 
                        step="5" 
                        value={duration}
                        onChange={(e) => setDuration(parseInt(e.target.value))}
                        className="w-full h-4 bg-gray-200 dark:bg-slate-700 rounded-full appearance-none cursor-pointer accent-teal-500 mb-6"
                    />
                    
                    <div className="grid grid-cols-4 gap-3">
                        {[5, 10, 15, 30, 45, 60, 90, 120].map(m => (
                            <button 
                                key={m}
                                onClick={() => setDuration(m)}
                                className={`py-3 rounded-xl font-bold text-sm border-2 transition-all ${duration === m ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 shadow-sm' : 'border-transparent bg-gray-50 dark:bg-slate-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-600'}`}
                            >
                                {m}m
                            </button>
                        ))}
                    </div>
                </div>

                <button 
                    onClick={handleSave}
                    className="w-full py-4 bg-teal-600 text-white font-bold rounded-xl hover:bg-teal-500 transition shadow-lg shadow-teal-500/20 dark:shadow-none text-lg flex items-center justify-center gap-2 transform active:scale-[0.98]"
                >
                    <CoffeeIcon className="w-6 h-6" />
                    Schedule Break
                </button>
            </div>
        </Modal>
    );
};

const DurationEstimatorModal: React.FC<{ 
    isOpen: boolean; 
    onClose: () => void; 
    task: Task | null; 
    onSave: (id: string, duration: number) => void; 
}> = ({ isOpen, onClose, task, onSave }) => {
    const [duration, setDuration] = useState(25);
    
    useEffect(() => {
        if (isOpen && task) {
            setDuration(task.duration && task.duration > 0 ? task.duration : 25);
        }
    }, [isOpen, task]);

    if (!isOpen || !task) return null;

    const handleSave = () => {
        onSave(task.id, duration);
        onClose();
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={task.isBreak ? "Break Duration" : "Estimate Duration"}>
            <div className="p-6 flex flex-col gap-8">
                <div className="text-center">
                    <h3 className="text-xl font-bold text-gray-800 dark:text-white mb-2 line-clamp-2">"{task.title}"</h3>
                    <p className="text-gray-500 dark:text-gray-400">How long will this take?</p>
                </div>

                {/* Quickie Button */}
                {!task.isBreak && (
                    <button 
                        onClick={() => { onSave(task.id, 2); onClose(); }}
                        className="w-full py-4 bg-yellow-50 dark:bg-yellow-900/20 border-2 border-yellow-400/50 hover:border-yellow-400 rounded-2xl flex items-center justify-center gap-3 transition-all group hover:shadow-lg hover:shadow-yellow-400/20"
                    >
                        <div className="w-10 h-10 rounded-full bg-yellow-400 text-yellow-900 flex items-center justify-center font-bold animate-pulse group-hover:scale-110 transition-transform">
                            <ZapIcon className="w-6 h-6" />
                        </div>
                        <div className="text-left">
                            <span className="block font-bold text-yellow-700 dark:text-yellow-400 text-lg">Quickie</span>
                            <span className="text-xs font-bold uppercase tracking-wider text-yellow-600/70 dark:text-yellow-500/70">~2 Minutes</span>
                        </div>
                    </button>
                )}

                <div className="space-y-2">
                    <div className="flex justify-between items-end mb-4">
                        <span className="text-xs font-bold uppercase text-gray-400 tracking-wider">Duration</span>
                        <span className="text-4xl font-heading font-bold text-indigo-600 dark:text-indigo-400">{duration}m</span>
                    </div>
                    
                    <input 
                        type="range" 
                        min="5" 
                        max="120" 
                        step="5" 
                        value={duration}
                        onChange={(e) => setDuration(parseInt(e.target.value))}
                        className="w-full h-4 bg-gray-200 dark:bg-slate-700 rounded-full appearance-none cursor-pointer accent-indigo-600"
                    />
                    <div className="flex justify-between text-[10px] font-bold text-gray-400 uppercase mt-2">
                        <span>5m</span>
                        <span>30m</span>
                        <span>60m</span>
                        <span>90m</span>
                        <span>120m</span>
                    </div>
                </div>

                <div className="grid grid-cols-4 gap-2">
                    {[5, 15, 25, 30, 45, 60, 90].map(m => (
                        <button 
                            key={m}
                            onClick={() => setDuration(m)}
                            className={`py-2 rounded-xl font-bold text-sm border-2 transition-all ${duration === m ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300' : 'border-transparent bg-gray-100 dark:bg-slate-700 text-gray-500 hover:bg-gray-200 dark:hover:bg-slate-600'}`}
                        >
                            {m}m
                        </button>
                    ))}
                </div>

                <button 
                    onClick={handleSave}
                    className="w-full py-4 bg-indigo-600 text-white font-bold rounded-xl shadow-lg hover:bg-indigo-700 transition transform active:scale-95 text-lg"
                >
                    Set Duration
                </button>
            </div>
        </Modal>
    );
};

const NoteEditorModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    task: Task | null;
    onSave: (taskId: string, content: string) => void;
}> = ({ isOpen, onClose, task, onSave }) => {
    const [content, setContent] = useState('');

    useEffect(() => {
        if (isOpen && task) {
            setContent(task.description || '');
        }
    }, [isOpen, task]);

    const handleClose = () => {
        if (task) {
            onSave(task.id, content);
        }
        onClose();
    };

    if (!isOpen || !task) return null;

    return (
        <Modal isOpen={isOpen} onClose={handleClose} title="Task Notes">
            <div className="h-[60vh] flex flex-col">
                <div className="px-6 py-2 border-b border-gray-100 dark:border-slate-700 bg-gray-50/50 dark:bg-slate-800/50 flex justify-between items-center">
                    <span className="font-bold text-sm text-gray-600 dark:text-gray-300 truncate max-w-[200px] sm:max-w-md">
                        {task.title}
                    </span>
                    <span className="text-xs text-green-500 font-bold uppercase tracking-wider animate-pulse">Auto-saving</span>
                </div>
                <div className="flex-grow relative">
                    <YellowPad 
                        content={content} 
                        onChange={setContent} 
                        placeholder="Type your notes here..." 
                        className="h-full"
                        autoFocus={true}
                    />
                </div>
                <div className="p-4 border-t border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800 flex justify-end">
                    <button 
                        onClick={handleClose} 
                        className="px-6 py-2 bg-indigo-600 text-white font-bold rounded-lg hover:bg-indigo-700 transition"
                    >
                        Done
                    </button>
                </div>
            </div>
        </Modal>
    );
};

const RescheduleDropModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    task: Task | null;
    onReschedule: (id: string, date: string) => void;
}> = ({ isOpen, onClose, task, onReschedule }) => {
    
    if (!isOpen || !task) return null;

    const handleQuickSelect = (daysOffset: number) => {
        const d = new Date();
        d.setDate(d.getDate() + daysOffset);
        onReschedule(task.id, toYYYYMMDD(d));
        onClose();
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Reschedule Task">
            <div className="p-6">
                <div className="text-center mb-6">
                    <div className="w-16 h-16 bg-indigo-50 dark:bg-indigo-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                        <CalendarIcon className="w-8 h-8 text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <h3 className="text-lg font-bold text-gray-800 dark:text-white line-clamp-2">"{task.title}"</h3>
                    <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">When do you want to move this task to?</p>
                </div>

                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        <button 
                            onClick={() => handleQuickSelect(1)}
                            className="p-4 bg-gray-50 dark:bg-slate-700/50 border border-gray-200 dark:border-slate-600 rounded-xl font-bold text-gray-700 dark:text-gray-200 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:border-indigo-200 dark:hover:border-indigo-800 transition"
                        >
                            Tomorrow
                        </button>
                        <button 
                            onClick={() => handleQuickSelect(2)}
                            className="p-4 bg-gray-50 dark:bg-slate-700/50 border border-gray-200 dark:border-slate-600 rounded-xl font-bold text-gray-700 dark:text-gray-200 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:border-indigo-200 dark:hover:border-indigo-800 transition"
                        >
                            In 2 Days
                        </button>
                    </div>
                    <button 
                        onClick={() => handleQuickSelect(7)}
                        className="w-full p-4 bg-gray-50 dark:bg-slate-700/50 border border-gray-200 dark:border-slate-600 rounded-xl font-bold text-gray-700 dark:text-gray-200 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:border-indigo-200 dark:border-indigo-800 transition"
                    >
                        Next Week
                    </button>
                    
                    <div className="relative pt-2">
                        <div className="absolute inset-0 flex items-center" aria-hidden="true">
                            <div className="w-full border-t border-gray-200 dark:border-slate-700"></div>
                        </div>
                        <div className="relative flex justify-center">
                            <span className="px-2 bg-white dark:bg-slate-800 text-xs text-gray-400 font-bold uppercase">Or Pick Date</span>
                        </div>
                    </div>

                    <DatePicker 
                        date=""
                        onChange={(date) => { onReschedule(task.id, date); onClose(); }}
                        customTrigger={(onClick, isOpen) => (
                            <button
                                onClick={onClick}
                                className={`w-full p-4 rounded-xl font-bold text-white transition flex items-center justify-center gap-2 ${isOpen ? 'bg-indigo-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
                            >
                                <CalendarIcon className="w-5 h-5" />
                                Select Specific Date
                            </button>
                        )}
                    />
                </div>
            </div>
        </Modal>
    );
};

const HorizonTaskCard: React.FC<{
    task: Task;
    goal?: Goal;
    setFrog: (id: string) => void;
    openEditModal: (task: Task) => void;
    deleteTask: (id: string) => void;
    onMoveToToday: (id: string) => void;
    onTimeClick: (task: Task) => void;
    onEditNote: (task: Task) => void;
    hashtagConfigs: Record<string, HashtagConfig>;
}> = ({ task, goal, setFrog, openEditModal, deleteTask, onMoveToToday, onTimeClick, onEditNote, hashtagConfigs }) => {
    const primaryTag = task.hashtags && task.hashtags[0];
    const tagConfig = primaryTag ? hashtagConfigs[primaryTag] : undefined;
    const isHabit = !!task.habitId;
    const isLoop = !!task.isRepetitive;
    const hasNotes = !!task.description && task.description.trim().length > 0;

    let backgroundStyle = {};
    if (tagConfig?.color) {
        backgroundStyle = { backgroundColor: tagConfig.color + '15' };
    }

    return (
        <div 
            className="bg-white dark:bg-slate-800 p-3 rounded-xl border border-gray-100 dark:border-slate-700 shadow-sm hover:shadow-md transition-all group relative overflow-hidden"
            style={backgroundStyle}
        >
            {/* Note Indicator */}
            {hasNotes && (
                <div 
                    className="absolute top-0 right-0 w-6 h-6 cursor-pointer hover:scale-110 transition-transform z-20"
                    onClick={(e) => { e.stopPropagation(); onEditNote(task); }}
                    title="View Note"
                >
                    <div className="absolute top-0 right-0 w-0 h-0 border-t-[20px] border-l-[20px] border-t-yellow-200 dark:border-t-yellow-600 border-l-transparent hover:border-t-yellow-300 transition-colors"></div>
                </div>
            )}

            <div className="flex justify-between items-start">
                <div className="min-w-0 pr-16 w-full">
                    <div className="flex items-center gap-2">
                        {isLoop ? (
                            <InfinityIcon className="w-3 h-3 text-blue-500 shrink-0" />
                        ) : isHabit ? (
                            <RepeatIcon className="w-3 h-3 text-indigo-400 shrink-0" />
                        ) : null}
                        <p className="font-bold text-gray-700 dark:text-gray-300 text-sm truncate">{task.title}</p>
                    </div>
                    
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                        {task.isFrog && <span className="text-xs">🐸</span>}
                        <button 
                            onClick={() => onTimeClick(task)}
                            className="text-[10px] text-gray-400 font-mono bg-gray-50 dark:bg-slate-700/50 px-1.5 py-0.5 rounded hover:bg-indigo-100 dark:hover:bg-indigo-900/30 hover:text-indigo-600 transition-colors"
                        >
                            {formatDuration(task.duration || 25)}
                        </button>
                        {goal && <div className="w-1.5 h-1.5 rounded-full" style={{backgroundColor: goal.color}} title={goal.name}></div>}
                        
                        {task.hashtags && task.hashtags.length > 0 && (
                            <div className="flex gap-1">
                                {task.hashtags.map(tag => (
                                    <span 
                                        key={tag} 
                                        className="text-[8px] font-bold px-1 rounded opacity-70"
                                        style={{ color: hashtagConfigs[tag]?.color || '#6b7280' }}
                                    >
                                        #{tag}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
                
                {/* Action Row - Visible on Hover */}
                <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-white/90 dark:bg-slate-800/90 p-1 rounded-lg backdrop-blur-sm z-10">
                    <button 
                        onClick={() => onMoveToToday(task.id)}
                        className="p-1.5 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-lg hover:scale-110 transition-transform"
                        title="Move to Today"
                    >
                        <ArrowUpCircleIcon className="w-4 h-4" />
                    </button>
                    <div className="w-px h-4 bg-gray-200 dark:bg-slate-600 mx-1"></div>
                    <button 
                        onClick={(e) => { e.stopPropagation(); onEditNote(task); }}
                        className="p-1.5 text-gray-400 hover:text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 rounded-lg transition" 
                        title="Add Note"
                    >
                        <StickyNoteIcon className="w-4 h-4" />
                    </button>
                    <button 
                        onClick={() => setFrog(task.id)}
                        className={`p-1.5 rounded-lg transition ${task.isFrog ? 'text-green-600 bg-green-50' : 'text-gray-400 hover:text-green-500'}`}
                        title="Toggle Frog"
                    >
                        <span className="text-xs leading-none">🐸</span>
                    </button>
                    <button onClick={() => openEditModal(task)} className="p-1.5 text-gray-400 hover:text-indigo-500 rounded-lg transition" title="Edit">
                        <PencilIcon className="w-4 h-4" />
                    </button>
                    <button onClick={() => deleteTask(task.id)} className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg transition" title="Delete">
                        <TrashIcon className="w-4 h-4" />
                    </button>
                </div>
            </div>
        </div>
    );
};

// --- Timeline Task Card (Updated for Bio-Adaptive) ---

const TimelineTaskCard = React.memo<{ 
    task: Task;
    goal: Goal | undefined;
    setFrog: (id: string) => void;
    openEditModal: (task: Task) => void;
    deleteTask: (id: string) => void;
    hashtagConfigs: Record<string, HashtagConfig>;
    onSelectHashtag: (tag: string) => void;
    isDragging?: boolean;
    startTime: string;
    endTime: string;
    onTimeClick: (task: Task) => void;
    onEditNote: (task: Task) => void;
    bioContext?: {
        isDeepWork?: boolean;
        isWorkout?: boolean;
        isEating?: boolean;
        isDip?: boolean;
    };
    markers?: Array<{ type: 'sunrise' | 'sunset' | 'noon' | 'sleep', time: string }>;
}>(({ 
    task, goal, setFrog, openEditModal, deleteTask, hashtagConfigs, onSelectHashtag, isDragging, startTime, endTime, onTimeClick, onEditNote, bioContext, markers
}) => {
    if (!task) return null;

    const primaryTag = task.hashtags && task.hashtags[0];
    const tagConfig = primaryTag ? hashtagConfigs[primaryTag] : undefined;
    const strikes = task.strikes || 0;
    const isLocked = strikes >= 4;
    const isQuickie = (task.duration || 25) <= 2;
    const isHabit = !!task.habitId;
    const isLoop = !!task.isRepetitive;
    const hasNotes = !!task.description && task.description.trim().length > 0;
    
    const duration = task.duration || 25;
    const cardHeight = Math.max(64, Math.min(320, duration * 3));

    // Bio-Adaptive Styles
    let bioStyle = '';
    if (bioContext?.isDeepWork) bioStyle = 'ring-2 ring-indigo-400/30 dark:ring-indigo-500/30 bg-indigo-50/50 dark:bg-indigo-900/10';
    if (bioContext?.isWorkout) bioStyle = 'ring-2 ring-blue-400/30 dark:ring-blue-500/30 bg-blue-50/50 dark:bg-blue-900/10';
    if (bioContext?.isDip) bioStyle = 'opacity-80 bg-yellow-50/30 dark:bg-yellow-900/5';

    // Style logic
    let borderStyle = isLocked ? 'border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-900/10' : 
                        isDragging ? 'border-indigo-500 bg-white dark:bg-slate-800 shadow-xl ring-2 ring-indigo-500/50' : 
                        `border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 ${bioStyle}`;
    
    let contentStyle = "";
    let backgroundStyle = {};

    if (task.isBreak) {
        borderStyle = 'border-teal-200 dark:border-teal-800 bg-teal-50/50 dark:bg-teal-900/20 border-dashed mx-4';
        contentStyle = "opacity-80";
    } else if (task.isFrog && !isLocked && !isDragging) {
        borderStyle = 'border-green-400/50 dark:border-green-600/50 bg-green-50 dark:bg-green-900/20 hover:border-green-400 dark:hover:border-green-500';
    } else if (isLoop && !isLocked && !isDragging) {
        borderStyle = 'border-blue-400/50 dark:border-blue-600/50 bg-blue-50 dark:bg-blue-900/20 hover:border-blue-400 dark:hover:border-blue-500';
    } else if (isQuickie && !isLocked && !isDragging) {
        borderStyle = 'border-yellow-400/50 dark:border-yellow-600/50 bg-yellow-50 dark:bg-yellow-900/20 hover:border-yellow-400 dark:hover:border-yellow-500';
    } else if (tagConfig?.color) {
        backgroundStyle = {
            backgroundColor: tagConfig.color + '15',
        };
    }

    const accentColor = task.isBreak ? 'transparent' : tagConfig ? tagConfig.color : (task.isFrog ? '#22c55e' : (goal ? goal.color : 'transparent'));
    let BreakIcon = CoffeeIcon;
    
    return (
        <div className="flex gap-4 group relative" style={{ height: `${cardHeight}px` }}>
            {/* Left Timeline Track */}
            <div className="flex flex-col items-center w-16 pt-2 relative flex-shrink-0">
                <button 
                    onClick={() => onTimeClick(task)}
                    className="text-xs font-mono font-bold text-gray-400 hover:text-indigo-600 dark:text-gray-500 dark:hover:text-indigo-400 transition-colors mb-1"
                >
                    {startTime}
                </button>
                <div className="w-0.5 flex-grow bg-gray-200 dark:bg-slate-700 relative">
                    {/* Markers */}
                    {markers && markers.map((m, idx) => (
                        <div key={idx} className="absolute left-1/2 transform -translate-x-1/2 z-20 flex items-center justify-center w-6 h-6" style={{ top: `${(idx + 1) * 20}%` }}> 
                             {/* Simple positioning hack, real positioning is complex in list view without absolute time mapping */}
                             <div className={`w-5 h-5 rounded-full flex items-center justify-center shadow-md border border-white dark:border-slate-900 bg-slate-800 text-white`}>
                                {m.type === 'sunrise' && <SunIcon className="w-3 h-3 text-amber-400" />}
                                {m.type === 'sunset' && <MoonIcon className="w-3 h-3 text-indigo-300" />}
                                {m.type === 'noon' && <SunIcon className="w-3 h-3 text-orange-500" />}
                                {m.type === 'sleep' && <MoonIcon className="w-3 h-3 text-slate-400" />}
                             </div>
                        </div>
                    ))}
                </div>
                <span className="text-[10px] text-gray-300 dark:text-gray-600 mt-1">{endTime}</span>
            </div>

            {/* Right Task Card */}
            <div 
                className={`flex-grow flex relative rounded-2xl border transition-all duration-200 select-none overflow-hidden shadow-sm ${borderStyle} ${isDragging ? 'rotate-1 z-50' : ''}`}
                style={!task.isBreak ? backgroundStyle : undefined}
            >
                {/* Bio Indicators (Subtle Icons) */}
                {bioContext?.isDeepWork && (
                    <div className="absolute top-2 right-2 opacity-20 pointer-events-none">
                        <BrainCircuit className="w-12 h-12 text-indigo-500" />
                    </div>
                )}
                {bioContext?.isWorkout && (
                    <div className="absolute top-2 right-2 opacity-20 pointer-events-none">
                        <ActivityIcon className="w-12 h-12 text-blue-500" />
                    </div>
                )}

                {hasNotes && !task.isBreak && (
                    <div 
                        className="absolute top-0 right-0 w-8 h-8 cursor-pointer hover:scale-110 transition-transform z-20"
                        title="View Note"
                        onClick={(e) => { e.stopPropagation(); onEditNote(task); }}
                    >
                        <div className="absolute top-0 right-0 w-0 h-0 border-t-[32px] border-l-[32px] border-t-yellow-200 dark:border-t-yellow-600 border-l-transparent shadow-sm hover:border-t-yellow-300 dark:hover:border-t-yellow-500 transition-colors"></div>
                        <div className="absolute top-1 right-1 text-yellow-600 dark:text-yellow-200">
                            <StickyNoteIcon className="w-3 h-3" />
                        </div>
                    </div>
                )}

                {!task.isBreak && <div className="w-1.5 h-full shrink-0" style={{ backgroundColor: accentColor }}></div>}

                <div className={`flex-grow p-4 flex flex-col justify-center min-w-0 relative ${contentStyle}`}>
                    <div className={`flex items-center gap-3 ${task.isBreak ? 'justify-center' : 'pr-8'}`}>
                        {task.isBreak ? (
                            <BreakIcon className="w-5 h-5 text-teal-500 shrink-0" />
                        ) : isLoop ? (
                            <InfinityIcon className="w-4 h-4 text-blue-500 shrink-0" />
                        ) : isQuickie ? (
                            <ZapIcon className="w-4 h-4 text-yellow-500 shrink-0" />
                        ) : isHabit ? (
                            <RepeatIcon className="w-4 h-4 text-indigo-400 shrink-0" />
                        ) : null}
                        
                        <div className="min-w-0 text-center sm:text-left flex-grow">
                            <div className="flex items-center gap-2 mb-1 justify-center sm:justify-start">
                                {task.isFrog && <span className="text-lg animate-bounce leading-none" title="Eat The Frog">🐸</span>}
                                <h4 className={`font-bold text-sm truncate ${isLocked ? 'text-red-800 dark:text-red-300' : task.isBreak ? 'text-teal-700 dark:text-teal-300' : 'text-gray-800 dark:text-gray-200'}`}>
                                    {task.title}
                                </h4>
                            </div>
                            
                            {!task.isBreak && (
                                <div className="flex flex-wrap items-center text-xs text-gray-400 dark:text-gray-500 gap-2">
                                    <button 
                                        onClick={(e) => { e.stopPropagation(); onTimeClick(task); }}
                                        className="font-mono bg-gray-100 dark:bg-slate-700/50 px-1.5 py-0.5 rounded text-[10px] hover:bg-indigo-100 dark:hover:bg-indigo-900/50 hover:text-indigo-600 transition-colors"
                                    >
                                        {formatDuration(task.duration || 25)}
                                    </button>
                                    {goal && <span style={{ color: goal.color }} className="flex items-center gap-1 font-medium"><span className="w-1.5 h-1.5 rounded-full" style={{backgroundColor: goal.color}}></span>{goal.name}</span>}
                                    
                                    {task.hashtags && task.hashtags.length > 0 && (
                                        <div className="flex gap-1">
                                            {task.hashtags.map(tag => (
                                                <span 
                                                    key={tag} 
                                                    className="px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                                                    style={{ 
                                                        backgroundColor: hashtagConfigs[tag]?.color ? hashtagConfigs[tag].color + '20' : '#e5e7eb',
                                                        color: hashtagConfigs[tag]?.color || '#6b7280'
                                                    }}
                                                >
                                                    #{tag}
                                                </span>
                                            ))}
                                        </div>
                                    )}

                                    {strikes > 0 && <span className="text-red-500 font-bold">{strikes} strikes</span>}
                                </div>
                            )}
                            {task.isBreak && (
                                <button 
                                    onClick={(e) => { e.stopPropagation(); onTimeClick(task); }}
                                    className="text-xs text-teal-600 dark:text-teal-400 font-bold hover:underline"
                                >
                                    {task.duration}m
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="absolute top-1/2 right-4 transform -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all duration-200 translate-x-4 group-hover:translate-x-0 bg-white/90 dark:bg-slate-800/90 backdrop-blur-sm p-1 rounded-xl shadow-sm border border-gray-100 dark:border-slate-700 z-10">
                        {!task.isBreak && (
                            <>
                                <button 
                                    onClick={(e) => { e.stopPropagation(); onEditNote(task); }}
                                    className="p-1.5 text-gray-400 hover:text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 rounded-lg transition" 
                                    title={hasNotes ? "Edit Note" : "Add Note"}
                                >
                                    <StickyNoteIcon className="w-4 h-4" />
                                </button>
                                <button 
                                    onClick={(e) => { e.stopPropagation(); setFrog(task.id); }} 
                                    className={`p-1.5 rounded-lg transition ${task.isFrog ? 'bg-green-100 text-green-600' : 'hover:bg-green-50 text-gray-400 hover:text-green-500'}`} 
                                    title="Toggle Frog"
                                >
                                    <span className="text-sm leading-none">🐸</span>
                                </button>
                            </>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); openEditModal(task); }} className="p-1.5 text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-slate-700 rounded-lg transition" title="Edit">
                            <PencilIcon className="w-4 h-4" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); deleteTask(task.id); }} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition" title="Delete">
                            <TrashIcon className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}, (prev, next) => prev.task.id === next.task.id
    && (prev.task as unknown as { status?: string }).status === (next.task as unknown as { status?: string }).status
    && (prev.task as unknown as { lifecycleStatus?: string }).lifecycleStatus === (next.task as unknown as { lifecycleStatus?: string }).lifecycleStatus
    && (prev.task as unknown as { completed?: boolean }).completed === (next.task as unknown as { completed?: boolean }).completed
    && (prev.task as unknown as { isFrog?: boolean }).isFrog === (next.task as unknown as { isFrog?: boolean }).isFrog
    && prev.task.title === next.task.title
    && prev.task.duration === next.task.duration
    && prev.bioContext?.isDeepWork === next.bioContext?.isDeepWork
    && prev.bioContext?.isWorkout === next.bioContext?.isWorkout
    && prev.bioContext?.isDip === next.bioContext?.isDip
    && prev.startTime === next.startTime
    && prev.endTime === next.endTime
    && prev.isDragging === next.isDragging);

export const PlanningView: React.FC<PlanningViewProps> = ({ 
    todayTasks, upcomingTasks, allTasks, goals, setFrog, openEditModal, deleteTask, reorderTodayTasks, 
    hashtagConfigs, updateTaskPriorities, moveTaskToTopToday, onSelectHashtag, overdueTasks, markWontDo, onAddTask,
    updateTask, onRescheduleTask, circadianState, addSubtasks, completeTask, isAiEnabled = false, createTask,
    sortTodayTasksCircadian, modeControl
}) => {
    const [isPlannerOpen, setIsPlannerOpen] = useState(false);
    const [isEstimatorOpen, setIsEstimatorOpen] = useState(false);
    const [isBreakModalOpen, setIsBreakModalOpen] = useState(false);
    const [noteModalTask, setNoteModalTask] = useState<Task | null>(null);
    const [taskToEstimate, setTaskToEdit] = useState<Task | null>(null);
    const [rescheduleTaskDropId, setRescheduleTaskDropId] = useState<string | null>(null);
    const [isStrictEnabled, setIsStrictEnabled] = useState(false);
    
    useEffect(() => {
        const animation = requestAnimationFrame(() => setIsStrictEnabled(true));
        return () => {
            cancelAnimationFrame(animation);
            setIsStrictEnabled(false);
        };
    }, []);

    const isCircadianActive = circadianState.lastCheckIn === getTodayYYYYMMDD();

    // --- CIRCADIAN CALCULATIONS ---
    const circadianContext = useMemo(() => {
        if (!isCircadianActive || !circadianState.metrics.wakeTime) return null;

        const parseTime = (t: string) => {
            const [h, m] = t.split(':').map(Number);
            return h * 60 + m; // Minutes from midnight
        };

        const wake = parseTime(circadianState.metrics.wakeTime);
        const sunrise = circadianState.sunriseTime ? parseTime(circadianState.sunriseTime) : 6 * 60; // fallback 6am
        const sunset = circadianState.sunsetTime ? parseTime(circadianState.sunsetTime) : 18 * 60; // fallback 6pm
        
        // Solar Noon approx
        const solarNoon = circadianState.solarNoonTime ? parseTime(circadianState.solarNoonTime) : (sunrise + (sunset - sunrise) / 2);

        // Windows (in minutes from midnight)
        const windows = {
            sunrise: { start: sunrise - 30, end: sunrise + 90 },
            morningLight: { start: sunrise, end: sunrise + 120 },
            deepWork1: { start: wake + 120, end: wake + 240 }, // 2-4h after wake
            deepWork2: { start: wake + 540, end: wake + 660 }, // 9-11h after wake
            dip: { start: wake + 360, end: wake + 480 }, // 6-8h after wake (lunch dip)
            workoutMorning: { start: sunrise + 90, end: sunrise + 180 },
            workoutEvening: { start: sunrise + 600, end: sunrise + 720 },
            eating: { 
                start: parseTime(circadianState.metrics.firstMealTime || "08:00"), 
                end: parseTime(circadianState.metrics.firstMealTime || "08:00") + ((circadianState.metrics.eatingWindow || 10) * 60) 
            },
            solarNoon: { start: solarNoon - 60, end: solarNoon + 60 },
            windDown: { start: sunset, end: sunset + 180 },
            sleepTarget: { start: sunset + 210, end: sunset + 240 } // ~3.5h after sunset
        };

        return { windows, sunrise, sunset };
    }, [isCircadianActive, circadianState]);

    const roundedStart = useMemo(() => new Date(Math.ceil(new Date().getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000)), []);
    const { timelineTasks, totalWorkMinutes } = useMemo(() => {
        let cumulativeTime = roundedStart.getTime();
        let total = 0;
        const tasks = todayTasks.map(task => {
            const start = new Date(cumulativeTime);
            const duration = task.duration || 25;
            if (!task.isBreak) total += duration;
            cumulativeTime += duration * 60 * 1000;
            const end = new Date(cumulativeTime);
            const startMins = start.getHours() * 60 + start.getMinutes();
            const endMins = end.getHours() * 60 + end.getMinutes();
            const format = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            // P1-6: memoize bioContext per task to avoid new object busting React.memo
            const bioContext = (() => {
                const ctx = { isDeepWork: false, isWorkout: false, isEating: false, isDip: false } as { isDeepWork: boolean; isWorkout: boolean; isEating: boolean; isDip: boolean };
                if (!circadianContext) return ctx;
                const { windows } = circadianContext;
                const check = (w: { start: number; end: number }) => (startMins < w.end && endMins > w.start);
                if (check(windows.deepWork1) || check(windows.deepWork2)) ctx.isDeepWork = true;
                if (check(windows.workoutMorning) || check(windows.workoutEvening)) ctx.isWorkout = true;
                if (check(windows.eating)) ctx.isEating = true;
                if (check(windows.dip)) ctx.isDip = true;
                return ctx;
            })();
            let markers: Array<{ type: 'sunrise' | 'sunset' | 'noon' | 'sleep', time: string }> = [];
            if (circadianContext) {
                const formatMarker = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const checkPoint = (time: number) => (startMins <= time && endMins > time);
                if (checkPoint(circadianContext.sunrise)) markers.push({ type: 'sunrise', time: formatMarker(new Date(start.setHours(0,0,0,0) + circadianContext.sunrise * 60000)) });
                if (checkPoint(circadianContext.windows.solarNoon.start + 60)) markers.push({ type: 'noon', time: 'Noon' });
                if (checkPoint(circadianContext.sunset)) markers.push({ type: 'sunset', time: formatMarker(new Date(start.setHours(0,0,0,0) + circadianContext.sunset * 60000)) });
                if (checkPoint(circadianContext.windows.sleepTarget.start)) markers.push({ type: 'sleep', time: 'Sleep' });
            }
            return {
                ...task,
                _startTime: new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
                _endTime: new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
                _bioContext: bioContext,
                _markers: markers
            };
        });
        return { timelineTasks: tasks, totalWorkMinutes: total };
    }, [todayTasks, circadianContext, roundedStart]);

    // Dynamic Gradient Calculation
    const timelineGradient = useMemo(() => {
        if (!isCircadianActive || !circadianContext) return '';
        // Very simplified approximation for visual flair
        return 'linear-gradient(to bottom, rgba(255,220,180,0.1) 0%, rgba(255,255,255,0) 20%, rgba(200,220,255,0.1) 80%, rgba(100,120,180,0.1) 100%)';
    }, [isCircadianActive, circadianContext]);

    // ... (rest of drag handler and helpers logic remains)
    const onDragEnd = (result: DropResult) => {
        const { source, destination, draggableId } = result;
        if (!destination) return;
        if (destination.droppableId === 'horizon-drop-zone') {
            setRescheduleTaskDropId(draggableId);
            return;
        }
        if (source.droppableId === 'today-list' && destination.droppableId === 'today-list') {
            reorderTodayTasks(draggableId, 'unassigned', source.index, 'unassigned', destination.index);
        }
    };

    const handleEstimateClick = (task: Task) => {
        setTaskToEdit(task);
        setIsEstimatorOpen(true);
    };

    const handleEditNote = (task: Task) => {
        setNoteModalTask(task);
    };

    const handleSaveNote = (taskId: string, content: string) => {
        updateTask(taskId, { description: content });
    };

    const handleDurationSave = (id: string, duration: number) => {
        updateTask(id, { duration });
    };

    const handlePlanPrioritize = (ratings: Record<string, { excitement: number, roi: number }>) => {
        updateTaskPriorities(ratings);
        setIsPlannerOpen(false);
    };
    
    const confirmAddBreak = (duration: number) => {
        if (createTask) {
             createTask({
                title: "Break", 
                duration: duration,
                dateAssigned: getTodayYYYYMMDD(),
                isBreak: true,
                isFrog: false
            });
        }
    };

    const groupedUpcoming = useMemo(() => {
        const grouped: Record<string, Task[]> = {};
        upcomingTasks.forEach(task => {
            const date = task.dateAssigned;
            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(task);
        });
        return Object.keys(grouped).sort().map(date => ({
            date,
            tasks: grouped[date]
        }));
    }, [upcomingTasks]);

    const totalHours = Math.floor(totalWorkMinutes / 60);
    const totalMins = totalWorkMinutes % 60;
    const dropTask = rescheduleTaskDropId ? allTasks.find(t => t.id === rescheduleTaskDropId) : null;

    return (
        <div className="max-w-6xl mx-auto p-4 sm:p-8 space-y-12 pb-32">
            
            {/* Header Area */}
            <div className="planning-heading">
                <div className="planning-heading__identity">
                  <div>
                    <h2 className="text-4xl font-heading font-bold text-gray-800 dark:text-white">Plan</h2>
                    <p className="text-gray-500 dark:text-gray-400 mt-1">Design your flow.</p>
                  </div>
                  {modeControl}
                </div>
                {/* Circadian Score Badge */}
                {isCircadianActive && (
                    <div className="flex items-center gap-2 px-4 py-2 bg-indigo-50 dark:bg-slate-800 rounded-full border border-indigo-100 dark:border-slate-700 animate-fadeIn">
                        <ZapIcon className="w-4 h-4 text-amber-500" />
                        <span className="text-xs font-bold uppercase text-slate-500 dark:text-slate-400">Circadian Score:</span>
                        <span className="font-bold text-indigo-600 dark:text-indigo-400">{circadianState.score}%</span>
                    </div>
                )}
                <div className="planning-heading__actions">
                    {isCircadianActive && (
                        <button 
                            onClick={() => setIsPlannerOpen(true)}
                            disabled={todayTasks.length === 0}
                            className={`flex items-center gap-2 px-5 py-3 rounded-xl font-bold shadow-sm transition-all ${todayTasks.length === 0 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 hover:bg-indigo-200'}`}
                        >
                            <CompassIcon className="w-5 h-5" /> Prioritize
                        </button>
                    )}
                    <button 
                        onClick={() => onAddTask()}
                        className="flex items-center gap-2 px-5 py-3 bg-gray-900 dark:bg-indigo-600 text-white rounded-xl font-bold shadow-lg hover:bg-gray-800 dark:hover:bg-indigo-700 transition transform hover:-translate-y-0.5"
                    >
                        <PlusIcon className="w-5 h-5" /> Add Task
                    </button>
                </div>
            </div>

            {overdueTasks.length > 0 && (
                <section aria-labelledby="overdue-heading" className="rounded-3xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-800 dark:bg-amber-950/20">
                    <h3 id="overdue-heading" className="text-xl font-bold text-gray-800 dark:text-white">Needs your decision ({overdueTasks.length})</h3>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Choose what to do with each overdue or monthly task before starting today.</p>
                    <ul className="mt-4 space-y-3">
                        {overdueTasks.map(task => (
                            <li key={task.id} className="rounded-2xl bg-white p-4 dark:bg-slate-900">
                                <h4 className="font-bold text-gray-800 dark:text-white">{task.title}</h4>
                                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                                    {task.schedulePrecision === 'month' ? `Choose a day · ${task.scheduledFor || task.dateAssigned.slice(0, 7)}` : `Overdue · ${formatDisplayDate(task.dateAssigned)}`}
                                </p>
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <button onClick={() => moveTaskToTopToday(task.id)} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-bold text-white hover:bg-indigo-700">Do today</button>
                                    {!task.isFrog && <button onClick={() => setRescheduleTaskDropId(task.id)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-slate-600 dark:text-white">Reschedule</button>}
                                    <button onClick={() => completeTask(task.id)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-slate-600 dark:text-white">Mark complete</button>
                                    <button onClick={() => markWontDo(task.id)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-slate-600 dark:text-white">Won’t do</button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {isStrictEnabled && (
                <DragDropContext onDragEnd={onDragEnd}>
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                        
                        {/* Left Column: Today's Timeline */}
                        <div className="lg:col-span-2 space-y-6">
                            <div className="flex justify-between items-end">
                                <div className="flex items-center gap-3">
                                    <h3 className="text-2xl font-bold text-gray-800 dark:text-white">
                                        Today's Flow
                                    </h3>
                                    {totalWorkMinutes > 0 && (
                                        <span className="px-3 py-1 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-xs font-bold border border-indigo-200 dark:border-indigo-800/50">
                                            {totalHours}h {totalMins}m
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-4">
                                    <button 
                                        onClick={() => setIsBreakModalOpen(true)}
                                        className="text-xs font-bold text-teal-600 dark:text-teal-400 flex items-center gap-1 hover:underline"
                                    >
                                        <PlusIcon className="w-3 h-3" /> Insert Break
                                    </button>
                                </div>
                            </div>

                            <div 
                                className="bg-white dark:bg-slate-900/50 rounded-[2rem] p-6 min-h-[600px] border border-gray-100 dark:border-slate-800 shadow-xl shadow-indigo-100/20 dark:shadow-none relative overflow-hidden transition-all duration-1000"
                                style={{ backgroundImage: timelineGradient }}
                            >
                                {/* Timeline Spine Background */}
                                <div className="absolute left-[3.5rem] top-6 bottom-6 w-px bg-gray-100 dark:bg-slate-800 z-0"></div>

                                <Droppable droppableId="today-list">
                                    {(provided, snapshot) => (
                                        <div 
                                            {...provided.droppableProps} 
                                            ref={provided.innerRef} 
                                            className={`space-y-4 relative z-10 transition-colors ${snapshot.isDraggingOver ? 'bg-indigo-50/10 rounded-xl' : ''}`}
                                        >
                                            {timelineTasks.map((task, index) => (
                                                <Draggable key={task.id} draggableId={task.id} index={index}>
                                                    {(provided, snapshot) => (
                                                        <div
                                                            ref={provided.innerRef}
                                                            {...provided.draggableProps}
                                                            {...provided.dragHandleProps}
                                                            style={provided.draggableProps.style}
                                                            className="outline-none"
                                                        >
                                                            <TimelineTaskCard 
                                                                task={task}
                                                                goal={goals.find(g => g.id === task.goalId)}
                                                                setFrog={setFrog}
                                                                openEditModal={openEditModal}
                                                                onTimeClick={handleEstimateClick}
                                                                onEditNote={handleEditNote}
                                                                deleteTask={deleteTask}
                                                                hashtagConfigs={hashtagConfigs}
                                                                onSelectHashtag={onSelectHashtag}
                                                                isDragging={snapshot.isDragging}
                                                                startTime={task._startTime}
                                                                endTime={task._endTime}
                                                                bioContext={task._bioContext}
                                                                markers={task._markers}
                                                            />
                                                        </div>
                                                    )}
                                                </Draggable>
                                            ))}
                                            {provided.placeholder}
                                            
                                            <button
                                                onClick={() => onAddTask({ dateAssigned: getTodayYYYYMMDD() })}
                                                className="w-full py-4 border-2 border-dashed border-gray-200 dark:border-slate-700 rounded-2xl flex items-center justify-center gap-3 text-gray-400 hover:text-indigo-500 hover:border-indigo-200 dark:hover:border-indigo-900/50 hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-all group ml-[4.5rem] mt-4"
                                                style={{ width: 'calc(100% - 4.5rem)' }}
                                            >
                                                <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-slate-700 group-hover:bg-indigo-100 dark:group-hover:bg-indigo-900/30 flex items-center justify-center transition-colors">
                                                    <PlusIcon className="w-5 h-5 group-hover:text-indigo-600 dark:group-hover:text-indigo-400" />
                                                </div>
                                                <span className="font-bold text-sm">Add Task</span>
                                            </button>
                                        </div>
                                    )}
                                </Droppable>
                            </div>
                        </div>

                        {/* Right Column: Upcoming (Compact) + Drop Zone */}
                        <Droppable droppableId="horizon-drop-zone">
                            {(provided, snapshot) => (
                                <div 
                                    ref={provided.innerRef} 
                                    {...provided.droppableProps}
                                    className={`lg:col-span-1 space-y-6 transition-all duration-300 rounded-3xl p-4 -m-4 ${snapshot.isDraggingOver ? 'bg-indigo-50 dark:bg-indigo-900/20 border-2 border-dashed border-indigo-300 dark:border-indigo-700 shadow-xl scale-[1.02]' : ''}`}
                                >
                                    {/* Circadian Zone Recommender / Alignment Optimizer */}
                                    {isCircadianActive && !snapshot.isDraggingOver && (
                                        <div className="bg-slate-900 text-white rounded-3xl p-6 border border-indigo-500/30 shadow-[0_0_20px_rgba(99,102,241,0.1)] space-y-4 mb-2 animate-fadeIn">
                                            <div className="flex items-center gap-2 text-indigo-400">
                                                <ActivityIcon className="w-5 h-5 text-indigo-400" />
                                                <h4 className="text-xs font-bold uppercase tracking-widest">
                                                    Circadian Chronon Optimizer
                                                </h4>
                                            </div>

                                            <div className="space-y-3">
                                                <p className="text-xs text-indigo-200/80 leading-relaxed">
                                                    Wake time: <strong className="text-white">{circadianState.metrics.wakeTime || "07:00"}</strong> • System state: <strong className="text-white font-semibold">{circadianState.mode.toUpperCase()}</strong>
                                                </p>
                                                
                                                {/* Alignment analysis list */}
                                                <div className="text-[11px] space-y-2 border-t border-white/5 pt-3">
                                                    {todayTasks.filter(t => t.isFrog).length > 0 && todayTasks.findIndex(t => t.isFrog) === 0 ? (
                                                        <div className="flex items-start gap-2 text-emerald-400">
                                                            <span className="text-sm leading-none">✅</span>
                                                            <span className="leading-relaxed"><strong>Frog Aligned:</strong> Your primary high-willpower task is placed at the start of your peak focus zone!</span>
                                                        </div>
                                                    ) : todayTasks.filter(t => t.isFrog).length > 0 ? (
                                                        <div className="flex items-start gap-2 text-amber-400">
                                                            <span className="text-sm leading-none">⚠️</span>
                                                            <span className="leading-relaxed"><strong>Rearrange:</strong> Frog tasks are placed lower in the stack. Move frogs to the top to complete during morning cognitive peaks.</span>
                                                        </div>
                                                    ) : (
                                                        <div className="flex items-start gap-2 text-indigo-300">
                                                            <span className="text-sm leading-none">💡</span>
                                                            <span className="leading-relaxed"><strong>Peak Optimization:</strong> No frog task is defined for today. Mark an action as a Frog to highlight it.</span>
                                                        </div>
                                                    )}

                                                    {todayTasks.length > 4 && todayTasks.filter(t => t.isBreak).length === 0 && (
                                                        <div className="flex items-start gap-2 text-amber-400">
                                                            <span className="text-sm leading-none">⚠️</span>
                                                            <span className="leading-relaxed"><strong>Fatigue Warning:</strong> You have {todayTasks.length} tasks planned without structured breaks. Fatigue accumulates fast.</span>
                                                        </div>
                                                    )}
                                                </div>

                                                <button
                                                    onClick={() => sortTodayTasksCircadian()}
                                                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-xl transition flex items-center justify-center gap-1.5 focus:outline-none"
                                                >
                                                    <ZapIcon className="w-4 h-4 text-amber-300" />
                                                    Auto-Align Chronology (Frogs First)
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    <h3 className={`text-xl font-bold text-gray-800 dark:text-white pl-2 transition-opacity ${snapshot.isDraggingOver ? 'opacity-0 h-0 overflow-hidden' : ''}`}>On The Horizon</h3>
                                    
                                    {snapshot.isDraggingOver && (
                                        <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-indigo-500 animate-pulse">
                                            <div className="w-20 h-20 bg-indigo-100 dark:bg-indigo-900/50 rounded-full flex items-center justify-center mb-4">
                                                <CalendarIcon className="w-10 h-10" />
                                            </div>
                                            <span className="font-bold text-xl uppercase tracking-wider">Drop to Reschedule</span>
                                            <span className="text-sm mt-2 text-indigo-400">Move out of Today</span>
                                        </div>
                                    )}

                                    <div className={snapshot.isDraggingOver ? 'hidden' : ''}>
                                        {groupedUpcoming.length === 0 ? (
                                            <div className="bg-gray-50 dark:bg-slate-800/50 rounded-3xl p-8 text-center border border-dashed border-gray-200 dark:border-slate-700">
                                                <p className="text-gray-400 text-sm">No upcoming tasks.</p>
                                                <button onClick={() => onAddTask({ dateAssigned: getTomorrowYYYYMMDD() })} className="mt-4 text-xs font-bold text-indigo-500 hover:underline">
                                                    Plan Tomorrow
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="space-y-8 pl-4 border-l border-gray-200 dark:border-slate-800">
                                                {groupedUpcoming.map(group => (
                                                    <div key={group.date} className="relative">
                                                        <div className="absolute -left-[21px] top-1 w-3 h-3 bg-gray-300 dark:bg-slate-600 rounded-full border-2 border-white dark:border-slate-900"></div>
                                                        <h4 className="text-sm font-bold text-gray-500 dark:text-gray-400 mb-3 uppercase tracking-wider">{formatDisplayDate(group.date)}</h4>
                                                        <div className="space-y-3">
                                                            {group.tasks.map(task => (
                                                                <HorizonTaskCard 
                                                                    key={task.id}
                                                                    task={task}
                                                                    goal={goals.find(g => g.id === task.goalId)}
                                                                    setFrog={setFrog}
                                                                    openEditModal={openEditModal}
                                                                    deleteTask={deleteTask}
                                                                    onMoveToToday={moveTaskToTopToday}
                                                                    onTimeClick={handleEstimateClick}
                                                                    onEditNote={handleEditNote}
                                                                    hashtagConfigs={hashtagConfigs}
                                                                />
                                                            ))}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    {provided.placeholder}
                                </div>
                            )}
                        </Droppable>
                    </div>
                </DragDropContext>
            )}

            {/* Modals remain essentially same */}
            <DurationEstimatorModal 
                isOpen={isEstimatorOpen}
                onClose={() => setIsEstimatorOpen(false)}
                task={taskToEstimate}
                onSave={handleDurationSave}
            />
            
            <BreakCreationModal 
                isOpen={isBreakModalOpen}
                onClose={() => setIsBreakModalOpen(false)}
                onSave={confirmAddBreak}
            />

            <NoteEditorModal 
                isOpen={!!noteModalTask}
                onClose={() => setNoteModalTask(null)}
                task={noteModalTask}
                onSave={handleSaveNote}
            />
            
            <RescheduleDropModal 
                isOpen={!!dropTask}
                onClose={() => setRescheduleTaskDropId(null)}
                task={dropTask}
                onReschedule={onRescheduleTask}
            />

            {isPlannerOpen && (
                <ExcitementPlanner 
                    items={todayTasks} 
                    mode="task"
                    onComplete={handlePlanPrioritize} 
                    onClose={() => setIsPlannerOpen(false)}
                    onBreakdown={() => setIsPlannerOpen(false)}
                />
            )}
        </div>
    );
};
