import { parseNaturalSchedule } from '../utils/naturalSchedule';

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { PlusIcon, BrainCircuit, TrophyIcon, AxeIcon, TrashIcon, ShieldIcon, CalendarIcon } from './Icons';
import { breakdownTaskWithGemini, AiSubtask, validateTaskActionability } from '../services/geminiService';
import { Task, Goal } from '../types';
import { getTodayYYYYMMDD } from '../utils/dateUtils';
import { YellowPad } from './YellowPad';
import { DatePicker } from './DatePicker';

interface TaskFormProps {
  onSubmit: (data: { title: string; description: string; dateAssigned: string, goalId?: string, isFrog: boolean, isRepetitive: boolean, schedulePrecision: 'day' | 'month', scheduledFor: string }) => void;
  initialData?: Task | null;
  goals: Goal[];
  onClose: () => void;
  existingTasks?: Task[];
  initialOverrides?: { session?: any, dateAssigned?: string, title?: string };
  isAiEnabled?: boolean;
  onBreakdown?: (subtasks: { title: string; duration: number; dateAssigned?: string; schedulePrecision?: 'day' | 'month'; scheduledFor?: string }[], parent: Task) => void;
}

export const TaskForm: React.FC<TaskFormProps> = ({ onSubmit, initialData, goals, onClose, existingTasks = [], initialOverrides, isAiEnabled = false, onBreakdown }) => {
  const today = getTodayYYYYMMDD();
  const [todayYear, todayMonth] = today.split('-').map(Number);
  const nextMonth = todayMonth === 12
      ? `${todayYear + 1}-01`
      : `${todayYear}-${String(todayMonth + 1).padStart(2, '0')}`;
  const tomorrow = (() => {
      const value = new Date(todayYear, todayMonth - 1, Number(today.slice(8, 10)) + 1);
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  })();
  const [title, setTitle] = useState(initialData?.title || initialOverrides?.title || '');
  const [description, setDescription] = useState(initialData?.description || '');
  const [dateAssigned, setDateAssigned] = useState(initialData?.dateAssigned || initialOverrides?.dateAssigned || getTodayYYYYMMDD());
  const [schedulePrecision, setSchedulePrecision] = useState<'day' | 'month'>(initialData?.schedulePrecision || 'day');
  const [scheduledMonth, setScheduledMonth] = useState(initialData?.schedulePrecision === 'month' ? initialData.scheduledFor?.slice(0, 7) || nextMonth : nextMonth);
  const [goalId, setGoalId] = useState(initialData?.goalId || '');
  const [isFrog, setIsFrog] = useState(initialData?.isFrog || false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(Boolean(initialData));
  
  // Breakdown State
  const [isAiBreakdownLoading, setIsAiBreakdownLoading] = useState(false);
  const [suggestedSubtasks, setSuggestedSubtasks] = useState<AiSubtask[]>([]);
  const [stagedSubtasks, setStagedSubtasks] = useState<{title: string, duration: number}[]>([]);
  const [manualSubtaskInput, setManualSubtaskInput] = useState('');
  const [isBreakdownMode, setIsBreakdownMode] = useState(false);

  // Validation / Icky Filter State
  const [validationStatus, setValidationStatus] = useState<'idle' | 'validating' | 'rejected' | 'approved'>('idle');
  const [ickyReason, setIckyReason] = useState<string>('');
  const [ickySuggestions, setIckySuggestions] = useState<string[]>([]);
  
  // Debounce logic for validation
  const validationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Extract unique hashtags from existing tasks for suggestion
  const uniqueHashtags = useMemo(() => {
      const tags = new Set<string>();
      existingTasks.forEach(t => {
          if (t && t.hashtags) {
            t.hashtags.forEach(h => tags.add(h));
          }
      });
      return Array.from(tags);
  }, [existingTasks]);

  // Calculate top 5 used durations
  const topDurations = useMemo(() => {
    const counts: Record<number, number> = {};
    existingTasks.forEach(t => {
        if (t && t.duration && t.duration > 0) {
            counts[t.duration] = (counts[t.duration] || 0) + 1;
        }
    });

    const sortedFromHistory = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(entry => parseInt(entry[0]));

    const defaults = [15, 25, 45, 60, 90];
    const merged = Array.from(new Set([...sortedFromHistory, ...defaults]));
    return merged.slice(0, 5);
  }, [existingTasks]);

  useEffect(() => {
    const timer = setTimeout(() => {
        if (inputRef.current) {
            inputRef.current.focus();
            adjustHeight();
        }
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  const adjustHeight = () => {
      if (inputRef.current) {
          inputRef.current.style.height = 'auto';
          inputRef.current.style.height = inputRef.current.scrollHeight + 'px';
      }
  };

  useEffect(() => {
      adjustHeight();
  }, [title]);
  
  // Background Validation Logic
  const runValidation = useCallback(async (text: string) => {
      if (!isAiEnabled || text.length < 10) return;
      
      setValidationStatus('validating');
      try {
          const result = await validateTaskActionability(text);
          if (result.isActionable) {
              setValidationStatus('approved');
          } else {
              setValidationStatus('rejected');
              setIckyReason(result.reason || "This looks like a project, not a task.");
              setIckySuggestions(result.suggestions || []);
          }
      } catch (e) {
          setValidationStatus('idle'); // Fallback silently
      }
  }, [isAiEnabled]);

  useEffect(() => {
      const detected = parseNaturalSchedule(title);
      if (detected.scheduledFor) {
          setSchedulePrecision(detected.schedulePrecision!);
          if (detected.schedulePrecision === 'month') setScheduledMonth(detected.scheduledFor);
          else setDateAssigned(detected.scheduledFor);
      }
  }, [title]);

  const isEditing = !!initialData;

  const handleTitleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newTitle = e.target.value;
      setTitle(newTitle);
      
      // Clear previous rejection immediately on edit to remove friction
      if (validationStatus === 'rejected') {
          setValidationStatus('idle');
      }
      
      // Debounce Validation
      if (validationTimeoutRef.current) clearTimeout(validationTimeoutRef.current);
      
      if (isAiEnabled && newTitle.trim().length > 10) {
          validationTimeoutRef.current = setTimeout(() => {
              runValidation(newTitle);
          }, 1000); // 1 second debounce
      }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSubmit(e);
      }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!parseNaturalSchedule(title).cleanTitle.trim()) {
        setSubmissionError('A task needs an actionable title.');
        return;
    }

    const targetSchedule = schedulePrecision === 'day' ? dateAssigned : scheduledMonth;
    const originalSchedule = initialData?.scheduledFor || initialData?.dateAssigned;
    if (initialData?.isFrog && originalSchedule && targetSchedule > originalSchedule) {
        setSubmissionError('A frog cannot be moved forward. Complete it, break it down, or explicitly drop it from Plan.');
        return;
    }
    setSubmissionError(null);

    if (stagedSubtasks.length > 0) {
        if (initialData && onBreakdown) {
            onBreakdown(stagedSubtasks.map(subtask => ({
                ...subtask,
                dateAssigned: schedulePrecision === 'day' ? dateAssigned : `${scheduledMonth}-01`,
                schedulePrecision,
                scheduledFor: targetSchedule
            })), initialData);
            onClose();
            return;
        }
        stagedSubtasks.forEach(st => {
            const titleWithDuration = `${st.title} @${st.duration}m`;
            const hashtags = title.match(/#[a-zA-Z0-9_]+/g);
            let finalTitle = titleWithDuration;
            if (hashtags) {
                finalTitle += ` ${hashtags.join(' ')}`;
            }
            onSubmit({ 
                title: finalTitle, 
                description: description,
                dateAssigned: schedulePrecision === 'day' ? dateAssigned : `${scheduledMonth}-01`,
                goalId, 
                isFrog: false, 
                isRepetitive: false,
                schedulePrecision,
                scheduledFor: schedulePrecision === 'day' ? dateAssigned : scheduledMonth
            });
        });
        onClose();
        return;
    }

    // Only block if explicitly rejected. If validating or idle, let it pass (Optimistic)
    if (validationStatus === 'rejected') {
        // User is trying to submit despite rejection, this is allowed via "Force Create" but not via Enter usually
        // unless we want to block them.
        // We will show the rejection UI which has the Force Create button.
        return; 
    }

    if (title.trim()) {
      onSubmit({ title, description, dateAssigned: schedulePrecision === 'day' ? dateAssigned : `${scheduledMonth}-01`, goalId, isFrog: Boolean(initialData?.isFrog || isFrog), isRepetitive: false, schedulePrecision, scheduledFor: targetSchedule });
      onClose();
    }
  };

  const handleForceSubmit = () => {
      const targetSchedule = schedulePrecision === 'day' ? dateAssigned : scheduledMonth;
      const originalSchedule = initialData?.scheduledFor || initialData?.dateAssigned;
      if (initialData?.isFrog && originalSchedule && targetSchedule > originalSchedule) {
          setSubmissionError('A frog cannot be moved forward. Complete it, break it down, or explicitly drop it from Plan.');
          return;
      }
      onSubmit({ title, description, dateAssigned: schedulePrecision === 'day' ? dateAssigned : `${scheduledMonth}-01`, goalId, isFrog: Boolean(initialData?.isFrog || isFrog), isRepetitive: false, schedulePrecision, scheduledFor: targetSchedule });
      onClose();
  };

  const useSuggestion = (suggestion: string) => {
      setTitle(suggestion);
      setValidationStatus('approved');
      setIckySuggestions([]);
      inputRef.current?.focus();
  };

  const addHashtag = (tag: string) => {
      setTitle(prev => `${prev} #${tag} `);
      inputRef.current?.focus();
  };

  const addDuration = (minutes: number) => {
      setTitle(prev => `${prev} @${minutes}m `);
      inputRef.current?.focus();
  };

  const handleAiBreakdown = async () => {
    if (!title.trim() || isAiBreakdownLoading) return;
    setIsBreakdownMode(true);
    setIsAiBreakdownLoading(true);
    setSuggestedSubtasks([]);
    try {
      const subtasks = await breakdownTaskWithGemini(title);
      setSuggestedSubtasks(subtasks);
    } catch (error) {
      alert(error instanceof Error ? error.message : "An unknown error occurred.");
    } finally {
      setIsAiBreakdownLoading(false);
    }
  };

  const stageSubtask = (subtask: AiSubtask) => {
    setStagedSubtasks(prev => [...prev, { title: subtask.title, duration: subtask.estimatedDuration }]);
    setSuggestedSubtasks(prev => prev.filter(s => s.title !== subtask.title));
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

  const selectedGoal = goals.find(g => g && g.id === goalId);

  return (
    <div className="flex flex-col lg:flex-row h-full bg-white dark:bg-slate-800 overflow-hidden">
      
      <div className="flex-1 flex flex-col p-6 lg:p-8 overflow-y-auto custom-scrollbar relative">
        <form onSubmit={handleSubmit} className="flex flex-col gap-6 flex-grow">
            
            {/* HERO INPUT */}
            <div className="space-y-2 mt-2">
                <textarea
                    ref={inputRef}
                    value={title}
                    onChange={handleTitleChange}
                    onKeyDown={handleKeyDown}
                    rows={1}
                    placeholder="What is the next action?"
                    className={`w-full text-2xl md:text-3xl font-bold text-gray-900 dark:text-white placeholder-gray-300 dark:placeholder-slate-600 border-none focus:ring-0 p-0 bg-transparent leading-tight tracking-tight resize-none overflow-hidden ${validationStatus === 'rejected' ? 'text-red-500 dark:text-red-400' : ''}`}
                    autoFocus
                />
                
                {/* Visual Feedback Line */}
                <div className={`h-1.5 w-16 rounded-full transition-all duration-500 ${
                    validationStatus === 'rejected' ? 'bg-red-500 w-full' : 
                    validationStatus === 'approved' ? 'bg-green-500 w-full' : 
                    validationStatus === 'validating' ? 'bg-indigo-400 w-1/2 animate-pulse' :
                    'bg-gradient-to-r from-indigo-500 to-purple-500'
                }`}></div>
            </div>

            {/* QUICK SUGGESTIONS */}
            {showDetails && validationStatus !== 'rejected' && (
                <div className="flex items-center gap-2 overflow-x-auto pb-2 custom-scrollbar no-scrollbar">
                    {topDurations.map(min => (
                        <button 
                            key={min} 
                            type="button" 
                            onClick={() => addDuration(min)}
                            className="px-3 py-1.5 bg-gray-50 dark:bg-slate-700/50 text-gray-600 dark:text-gray-400 rounded-lg text-xs font-bold hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-slate-600 transition shrink-0 border border-transparent hover:border-indigo-200 dark:hover:border-slate-500"
                        >
                            @{min}m
                        </button>
                    ))}
                    {uniqueHashtags.slice(0, 5).map(tag => (
                        <button 
                            key={tag} 
                            type="button" 
                            onClick={() => addHashtag(tag)}
                            className="px-3 py-1.5 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-lg text-xs font-bold hover:bg-blue-100 dark:hover:bg-blue-900/40 transition shrink-0"
                        >
                            #{tag}
                        </button>
                    ))}
                </div>
            )}

            {/* CONTROLS ROW - UNIFIED STYLE */}
            <div className="flex flex-wrap gap-3 items-center">
                {/* Goal Selector Pill */}
                {showDetails && <div className="relative group">
                     <div className={`flex items-center rounded-xl px-4 py-3 transition-all cursor-pointer border ${goalId ? 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800' : 'bg-gray-50 dark:bg-slate-700/50 border-transparent hover:bg-gray-100 dark:hover:bg-slate-700'}`}>
                         <TrophyIcon className={`w-5 h-5 mr-2 ${goalId ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400'}`} />
                         <select
                            value={goalId}
                            onChange={(e) => setGoalId(e.target.value)}
                            className="appearance-none bg-transparent border-none p-0 pr-6 text-sm font-bold focus:ring-0 cursor-pointer w-full text-gray-700 dark:text-gray-200 outline-none"
                         >
                            <option value="" className="dark:bg-slate-800">No Goal</option>
                            {goals.map(goal => (
                                <option key={goal.id} value={goal.id} className="dark:bg-slate-800">{goal.name}</option>
                            ))}
                         </select>
                         {selectedGoal && <div className="w-2 h-2 rounded-full absolute right-3 top-1/2 -translate-y-1/2" style={{ backgroundColor: selectedGoal.color }}></div>}
                    </div>
                </div>}

                <div className="flex rounded-xl bg-gray-50 dark:bg-slate-700/50 p-1" aria-label="Task schedule">
                    <button type="button" onClick={() => { setSchedulePrecision('day'); setDateAssigned(today); }} className={`px-3 py-2 rounded-lg text-sm font-bold ${schedulePrecision === 'day' && dateAssigned === today ? 'bg-white dark:bg-slate-600 shadow-sm text-indigo-700 dark:text-indigo-200' : 'text-gray-500 dark:text-gray-400'}`}>Today</button>
                    <button type="button" onClick={() => { setSchedulePrecision('day'); setDateAssigned(tomorrow); }} className={`px-3 py-2 rounded-lg text-sm font-bold ${schedulePrecision === 'day' && dateAssigned === tomorrow ? 'bg-white dark:bg-slate-600 shadow-sm text-indigo-700 dark:text-indigo-200' : 'text-gray-500 dark:text-gray-400'}`}>Tomorrow</button>
                    <button type="button" onClick={() => setSchedulePrecision('month')} className={`px-3 py-2 rounded-lg text-sm font-bold ${schedulePrecision === 'month' ? 'bg-white dark:bg-slate-600 shadow-sm text-indigo-700 dark:text-indigo-200' : 'text-gray-500 dark:text-gray-400'}`}>Month</button>
                </div>

                {/* Date or future-month schedule */}
                {schedulePrecision === 'day' ? <div className="w-40">
                    <DatePicker 
                        date={dateAssigned}
                        onChange={setDateAssigned}
                        customTrigger={(onClick, isOpen) => (
                            <button
                                type="button"
                                onClick={onClick}
                                className={`flex items-center gap-2 w-full px-4 py-3 rounded-xl border transition-all ${isOpen ? 'bg-white dark:bg-slate-800 border-indigo-500 ring-2 ring-indigo-500/20' : 'bg-gray-50 dark:bg-slate-700/50 border-transparent hover:bg-gray-100 dark:hover:bg-slate-700'}`}
                            >
                                <CalendarIcon className="w-5 h-5 text-gray-400" />
                                <span className="text-sm font-bold text-gray-700 dark:text-gray-200 truncate">{dateAssigned === getTodayYYYYMMDD() ? 'Today' : dateAssigned}</span>
                            </button>
                        )}
                    />
                </div> : (
                    <label className="flex items-center gap-2 px-4 py-3 rounded-xl bg-gray-50 dark:bg-slate-700/50 text-sm font-bold text-gray-700 dark:text-gray-200">
                        <CalendarIcon className="w-5 h-5 text-gray-400" />
                        <input
                            type="month"
                            min={nextMonth}
                            value={scheduledMonth}
                            onChange={(event) => setScheduledMonth(event.target.value)}
                            className="bg-transparent border-0 p-0 focus:ring-0"
                            required
                        />
                    </label>
                )}

                {/* Toggles */}
                {showDetails && <button
                    type="button"
                    onClick={() => { if (!initialData?.isFrog) setIsFrog(!isFrog); }}
                    disabled={Boolean(initialData?.isFrog)}
                    className={`flex items-center px-4 py-3 rounded-xl border transition-all ${isFrog ? 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800 text-green-700 dark:text-green-400' : 'bg-gray-50 dark:bg-slate-700/50 border-transparent hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400'}`}
                >
                    <AxeIcon className="mr-2 h-4 w-4" />
                    <span className="text-sm font-bold">{initialData?.isFrog ? 'Frog locked' : 'Mark as frog'}</span>
                </button>}

            </div>
            <button type="button" aria-expanded={showDetails} onClick={() => setShowDetails(value => !value)} className="w-fit rounded-lg px-2 py-1 text-sm font-bold text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-900/30">
                {showDetails ? 'Fewer options' : 'More options'}
            </button>
            {submissionError && <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">{submissionError}</p>}

            {/* BREAKDOWN & AI AREA */}
            {(isBreakdownMode || stagedSubtasks.length > 0) && (
                <div className="animate-scaleIn p-5 bg-indigo-50/50 dark:bg-indigo-900/10 rounded-2xl border border-indigo-100 dark:border-indigo-800/50 mt-2">
                    <div className="flex justify-between items-center mb-3">
                        <h4 className="font-bold text-indigo-900 dark:text-indigo-300 flex items-center text-xs uppercase tracking-wider">
                            <AxeIcon className="w-4 h-4 mr-2" />
                            Subtasks ({stagedSubtasks.length})
                        </h4>
                    </div>
                    
                    <div className="space-y-2 mb-4">
                        {stagedSubtasks.map((st, i) => (
                            <div key={i} className="flex items-center justify-between p-3 bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-indigo-100 dark:border-slate-700 group">
                                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{st.title}</span>
                                <div className="flex items-center gap-3">
                                    <span className="text-[10px] font-bold text-gray-400 bg-gray-50 dark:bg-slate-700 px-1.5 py-0.5 rounded">{st.duration}m</span>
                                    <button onClick={() => removeStagedSubtask(i)} className="text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition"><TrashIcon className="w-4 h-4" /></button>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="flex gap-2">
                        <input 
                            type="text"
                            value={manualSubtaskInput}
                            onChange={(e) => setManualSubtaskInput(e.target.value)}
                            placeholder="Add subtask..."
                            className="flex-grow px-4 py-2 text-sm rounded-xl border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none dark:text-white"
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stageManualSubtask(); }}}
                        />
                        <button type="button" onClick={(e) => stageManualSubtask(e)} className="bg-indigo-600 text-white rounded-xl px-4 hover:bg-indigo-700 transition"><PlusIcon className="w-5 h-5" /></button>
                    </div>

                    {isAiEnabled && suggestedSubtasks.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-indigo-100 dark:border-slate-700">
                            <p className="text-xs font-bold text-indigo-400 uppercase mb-2">AI Suggestions</p>
                            <div className="grid grid-cols-1 gap-2">
                                {suggestedSubtasks.map((subtask, index) => (
                                <div key={index} className="flex items-center justify-between p-2 hover:bg-white dark:hover:bg-slate-700 rounded-lg cursor-pointer group transition-colors" onClick={() => stageSubtask(subtask)}>
                                    <span className="text-sm text-gray-600 dark:text-gray-300">{subtask.title}</span>
                                    <PlusIcon className="w-4 h-4 text-indigo-400 opacity-0 group-hover:opacity-100" />
                                </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ICKY FILTER */}
            {isAiEnabled && validationStatus === 'rejected' && (
                <div className="animate-slideIn p-5 bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 rounded-r-xl">
                    <div className="flex items-start gap-3">
                        <ShieldIcon className="w-6 h-6 text-red-500 shrink-0" />
                        <div>
                            <h4 className="text-lg font-bold text-red-700 dark:text-red-300">Wait! This looks like a Project.</h4>
                            <p className="text-sm text-red-600 dark:text-red-200 mt-1">{ickyReason}</p>
                            <div className="flex flex-wrap gap-2 mt-3">
                                {ickySuggestions.map((sug, i) => (
                                    <button key={i} type="button" onClick={() => useSuggestion(sug)} className="px-3 py-1 bg-white dark:bg-slate-800 border border-red-200 dark:border-red-800 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:border-red-400">{sug}</button>
                                ))}
                            </div>
                            <button type="button" onClick={handleForceSubmit} className="text-xs text-red-400 hover:text-red-600 underline mt-3">Force Create</button>
                        </div>
                    </div>
                </div>
            )}

            <div className="flex-grow"></div>

            {/* ACTION BAR */}
            <div className="flex items-center justify-between pt-4 mt-auto">
                 {showDetails && isAiEnabled && !isBreakdownMode && stagedSubtasks.length === 0 && (
                     <button
                        type="button"
                        onClick={handleAiBreakdown}
                        disabled={!title.trim() || isAiBreakdownLoading}
                        className={`text-sm font-bold flex items-center gap-2 px-4 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-700 transition ${!title.trim() ? 'text-gray-300 cursor-not-allowed' : 'text-gray-500 dark:text-gray-400 hover:text-indigo-600'}`}
                    >
                        {isAiBreakdownLoading ? <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div> : <AxeIcon className="w-5 h-5" />}
                        <span>Breakdown</span>
                    </button>
                 )}
                
                <button 
                    type="submit" 
                    disabled={!title.trim() && stagedSubtasks.length === 0}
                    className={`flex items-center px-8 py-4 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200 dark:shadow-none transition transform active:scale-95 text-lg ml-auto ${(!title.trim() && stagedSubtasks.length === 0) ? 'bg-gray-200 dark:bg-slate-700 cursor-not-allowed shadow-none' : 'bg-gray-900 dark:bg-indigo-600 hover:bg-gray-800 dark:hover:bg-indigo-700'}`}
                >
                    {validationStatus === 'validating' ? (
                        <div className="w-5 h-5 border-2 border-white/50 border-t-white rounded-full animate-spin mr-2"></div>
                    ) : (
                        <PlusIcon className="w-5 h-5 mr-2" />
                    )}
                    <span>{isEditing ? 'Save' : 'Create Task'}</span>
                </button>
            </div>
        </form>
      </div>

      {/* NOTES PAD */}
      {showDetails && <div className="hidden lg:block lg:w-[45%] xl:w-[40%] border-l border-gray-100 dark:border-slate-700 shadow-[inset_10px_0_20px_-10px_rgba(0,0,0,0.05)] z-10">
          <YellowPad 
            content={description} 
            onChange={setDescription} 
            placeholder="Notes, ideas, links..." 
            className="h-full"
          />
      </div>}
      
       {showDetails && <div className="lg:hidden h-48 border-t border-gray-200 dark:border-slate-700 shrink-0 shadow-inner">
           <YellowPad 
            content={description} 
            onChange={setDescription} 
            placeholder="Tap to add notes..." 
            className="h-full"
          />
       </div>}
    </div>
  );
};
