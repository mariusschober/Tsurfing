
import React, { useState, useMemo } from 'react';
import { Stats, Task, HashtagConfig, TimeFrame, AccountabilityConfig, FlowState, AccountabilityPartner } from '../types';
import { CheckIcon, ClockIcon, PrinterIcon, MailIcon, ClipboardCheckIcon, InfinityIcon, SparklesIcon, SunIcon, MoonIcon, BrainCircuit, TrophyIcon, FlameIcon, ZapIcon, ActivityIcon, PlusIcon, TrashIcon, CopyIcon } from './Icons';
import { getStartOfWeek, getStartOfMonth } from '../utils/dateUtils';

interface StatsViewProps {
  stats: Stats;
  recentTasks?: Task[];
  allTasks?: Task[];
  hashtagConfigs?: Record<string, HashtagConfig>;
  onColorChange?: (tag: string, updates: Partial<HashtagConfig>) => void;
  accountabilityConfig?: AccountabilityConfig;
  onUpdateAccountability?: (updates: Partial<AccountabilityConfig>) => void;
  onViewDone?: () => void;
  onSelectHashtag: (tag: string) => void;
}

// --- Helper Functions for Charts ---

const getSparklineData = (tasks: Task[], timeFrame: TimeFrame, metric: 'count' | 'duration'): number[] => {
    const now = new Date();
    let buckets: number[] = [];
    const bucketCount = 7; // Default to 7 points for smoothness

    // Helper to get day key
    const getDayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

    if (timeFrame === 'today') {
        // Hourly buckets (last 8 hours)
        buckets = new Array(8).fill(0);
        tasks.forEach(t => {
            if (!t.completedAt) return;
            const hourDiff = now.getHours() - new Date(t.completedAt).getHours();
            if (hourDiff >= 0 && hourDiff < 8) {
                const val = metric === 'count' ? 1 : (t.actualDuration || t.duration || 0);
                buckets[7 - hourDiff] += val;
            }
        });
    } else {
        // Daily buckets
        const map: Record<string, number> = {};
        for(let i=0; i<bucketCount; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            map[getDayKey(d)] = 0;
        }
        
        tasks.forEach(t => {
            if (!t.completedAt) return;
            const key = getDayKey(new Date(t.completedAt));
            if (map[key] !== undefined) {
                const val = metric === 'count' ? 1 : (t.actualDuration || t.duration || 0);
                map[key] += val;
            }
        });
        // Reverse to show oldest to newest
        buckets = Object.values(map).reverse();
    }
    return buckets;
};

const Sparkline: React.FC<{ data: number[], color: string }> = ({ data, color }) => {
    const max = Math.max(...data, 1);
    const min = 0;
    const height = 40;
    const width = 100;
    const step = data.length > 1 ? width / (data.length - 1) : 0;

    const points = data.map((val, i) => {
        const x = i * step;
        const y = height - ((val - min) / (max - min)) * height;
        return `${x},${y}`;
    }).join(' ');

    return (
        <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="overflow-visible">
            <polyline
                points={points}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={color}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
            />
            {/* Fill Area */}
            <polyline
                points={`${0},${height} ${points} ${width},${height}`}
                fill="currentColor"
                className={color}
                style={{ opacity: 0.1 }}
                stroke="none"
            />
        </svg>
    );
};

const FocusScoreRing: React.FC<{ score: number }> = ({ score }) => {
    const radius = 60; // Base coordinate space radius
    const stroke = 12;
    const normalizedRadius = radius - stroke / 2;
    const circumference = normalizedRadius * 2 * Math.PI;
    const strokeDashoffset = circumference - (score / 100) * circumference;

    let color = 'text-red-500';
    if (score >= 50) color = 'text-yellow-500';
    if (score >= 75) color = 'text-indigo-500';
    if (score >= 90) color = 'text-purple-500';

    return (
        <div className="relative flex items-center justify-center w-full h-full">
            <svg 
                viewBox={`0 0 ${radius * 2} ${radius * 2}`} 
                className="transform -rotate-90 w-40 h-40"
            >
                <circle
                    stroke="currentColor"
                    fill="transparent"
                    strokeWidth={stroke}
                    r={normalizedRadius}
                    cx={radius}
                    cy={radius}
                    className="text-gray-100 dark:text-slate-700"
                />
                <circle
                    stroke="currentColor"
                    fill="transparent"
                    strokeWidth={stroke}
                    strokeDasharray={circumference + ' ' + circumference}
                    style={{ strokeDashoffset }}
                    strokeLinecap="round"
                    r={normalizedRadius}
                    cx={radius}
                    cy={radius}
                    className={`${color} transition-all duration-1000 ease-out drop-shadow-sm`}
                />
            </svg>
            <div className="absolute flex flex-col items-center justify-center inset-0">
                <span className={`text-4xl font-black ${color} drop-shadow-sm`}>{score}</span>
                <span className="text-[10px] font-bold uppercase text-gray-400 tracking-widest mt-1">Score</span>
            </div>
        </div>
    );
};

// --- Sub Components ---

const StatCard: React.FC<{ 
    icon: React.ReactNode, 
    title: string, 
    value: string | number, 
    subValue?: string,
    color: string, 
    data?: number[] 
}> = ({ icon, title, value, subValue, color, data }) => {
    return (
        <div className="bg-white dark:bg-slate-800 p-5 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 flex flex-col justify-between relative overflow-hidden group hover:shadow-md transition-all h-[160px]">
            <div className="flex justify-between items-start z-10">
                <div>
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">{title}</p>
                    <p className="text-3xl font-heading font-bold text-gray-900 dark:text-white tracking-tight">{value}</p>
                    {subValue && <p className="text-xs font-medium text-gray-500 mt-1">{subValue}</p>}
                </div>
                <div className={`p-3 rounded-2xl bg-opacity-10 dark:bg-opacity-20 ${color.replace('text-', 'bg-')}`}>
                    {React.cloneElement(icon as React.ReactElement<any>, { className: `w-6 h-6 ${color}` })}
                </div>
            </div>
            
            {data && data.length > 0 && (
                <div className="h-12 w-full mt-4 opacity-50 group-hover:opacity-100 transition-opacity z-10">
                    <Sparkline data={data} color={color} />
                </div>
            )}

            {/* Background Decor */}
            <div className={`absolute -bottom-4 -right-4 w-24 h-24 rounded-full opacity-5 pointer-events-none transition-transform group-hover:scale-150 ${color.replace('text-', 'bg-')}`}></div>
        </div>
    );
};

const ChronotypeChart: React.FC<{ tasks: Task[] }> = ({ tasks }) => {
    const analysis = useMemo(() => {
        const hourlyData = Array.from({ length: 24 }, () => ({ total: 0, flowScore: 0 }));
        let totalRated = 0;
        const flowMap: Record<string, number> = { 'distracted': 1, 'good': 2, 'high': 3, 'flow': 4 };

        tasks.forEach(t => {
            if (!t.completedAt || !t.flowState) return;
            const hour = new Date(t.completedAt).getHours();
            hourlyData[hour].total++;
            hourlyData[hour].flowScore += (flowMap[t.flowState] || 0);
            totalRated++;
        });

        const maxTotal = Math.max(...hourlyData.map(d => d.total), 1);
        
        // Peak Detection
        let bestHour = -1;
        let bestScore = -1;
        
        hourlyData.forEach((h, i) => {
            const avg = h.total > 0 ? h.flowScore / h.total : 0;
            if (h.total > 1 && avg > bestScore) {
                bestScore = avg;
                bestHour = i;
            }
        });

        return { hourlyData, maxTotal, bestHour, totalRated };
    }, [tasks]);

    if (analysis.totalRated < 3) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-center p-6 bg-white dark:bg-slate-800 rounded-3xl border border-gray-100 dark:border-slate-700 border-dashed">
                <BrainCircuit className="w-8 h-8 text-gray-300 dark:text-slate-600 mb-2" />
                <p className="text-sm text-gray-400">Complete more rated tasks to unlock Chronotype Analysis.</p>
            </div>
        );
    }

    const formatTime = (h: number) => {
        const ampm = h >= 12 ? 'pm' : 'am';
        const h12 = h % 12 || 12;
        return `${h12}${ampm}`;
    };

    return (
        <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 h-full flex flex-col">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                        <BrainCircuit className="w-5 h-5 text-indigo-500" />
                        Chronotype Rhythm
                    </h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Flow state density by hour.</p>
                </div>
                {analysis.bestHour !== -1 && (
                    <div className="text-right">
                        <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">Peak Window</span>
                        <p className="text-sm font-bold text-indigo-500">{formatTime(analysis.bestHour)} - {formatTime((analysis.bestHour + 2) % 24)}</p>
                    </div>
                )}
            </div>

            <div className="flex-grow flex items-end justify-between gap-1 relative min-h-[120px]">
                {analysis.hourlyData.map((data, i) => {
                    const heightPct = (data.total / analysis.maxTotal) * 100;
                    const avgScore = data.total > 0 ? data.flowScore / data.total : 0;
                    
                    // Color based on avg score
                    let barColor = 'bg-gray-200 dark:bg-slate-700';
                    if (data.total > 0) {
                        if (avgScore >= 3.5) barColor = 'bg-purple-500';
                        else if (avgScore >= 2.5) barColor = 'bg-indigo-500';
                        else if (avgScore >= 1.5) barColor = 'bg-blue-400';
                        else barColor = 'bg-red-400';
                    }

                    const isMajorTick = i % 6 === 0;

                    return (
                        <div key={i} className="flex-1 flex flex-col items-center group relative h-full justify-end">
                            <div 
                                className={`w-full rounded-t-sm transition-all duration-500 ${barColor} ${i === analysis.bestHour ? 'shadow-[0_0_10px_rgba(99,102,241,0.5)] z-10' : ''}`}
                                style={{ height: `${Math.max(heightPct, 4)}%`, opacity: data.total > 0 ? 1 : 0.3 }}
                            ></div>
                            
                            {/* Hover Tooltip */}
                            <div className="absolute bottom-full mb-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20">
                                <div className="bg-slate-900 text-white text-[10px] rounded px-2 py-1 whitespace-nowrap shadow-xl">
                                    {formatTime(i)}: {data.total} tasks
                                </div>
                            </div>

                            {/* X-Axis */}
                            <div className="mt-2 h-3">
                                {isMajorTick && (
                                    <span className="text-[9px] text-gray-400 dark:text-slate-600 font-mono absolute transform -translate-x-1/2">
                                        {formatTime(i)}
                                    </span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

const AccountabilityCard: React.FC<{ 
    config?: AccountabilityConfig; 
    onUpdate?: (updates: Partial<AccountabilityConfig>) => void;
    allTasks?: Task[];
}> = ({ config, onUpdate, allTasks }) => {
    const [newEmail, setNewEmail] = useState('');
    const [newFreq, setNewFreq] = useState<'daily' | 'weekly'>('daily');
    const [copied, setCopied] = useState(false);

    const handleCopyReport = () => {
        if (!allTasks) return;
        const today = new Date().toISOString().split('T')[0];
        
        // Filter tasks assigned to today or completed today
        const todaysTasks = allTasks.filter(t => t.dateAssigned === today || (t.completedAt && new Date(t.completedAt).toISOString().split('T')[0] === today));
        
        const completed = todaysTasks.filter(t => t.completed);
        const pending = todaysTasks.filter(t => !t.completed);
        
        let report = `## 🎯 Tsurfing Progress Report (${today})\n\n`;
        report += `Here is a summary of my progress today to keep me aligned and accountable!\n\n`;
        
        report += `### ✅ Completed Tasks (${completed.length})\n`;
        if (completed.length === 0) {
            report += `- No tasks completed yet.\n`;
        } else {
            completed.forEach(t => {
                const durationText = t.actualDuration ? ` (${t.actualDuration}m spent)` : '';
                const frogTag = t.isFrog ? ' [🐸 Frog Task]' : '';
                report += `- **${t.title}**${durationText}${frogTag}\n`;
            });
        }
        
        report += `\n### ⏳ Active / Upcoming Tasks (${pending.length})\n`;
        if (pending.length === 0) {
            report += `- All active tasks for today are completed!\n`;
        } else {
            pending.forEach(t => {
                const estText = t.duration ? ` (Est: ${t.duration}m)` : '';
                const sessionText = t.session ? ` [Session: ${t.session}]` : '';
                const frogText = t.isFrog ? ' [🐸 Frog]' : '';
                report += `- ${t.title}${estText}${sessionText}${frogText}\n`;
            });
        }
        
        report += `\n*Sent with commitment via Tsurfing* 💫`;
        
        navigator.clipboard.writeText(report).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }).catch(err => {
            console.error('Failed to copy report', err);
        });
    };

    const handleAddPartner = (e: React.FormEvent) => {
        e.preventDefault();
        if (!newEmail.trim() || !onUpdate) return;
        
        const currentPartners = config?.partners || [];
        // Prevent dupes
        if (currentPartners.some(p => p.email === newEmail.trim())) {
            alert('Partner already added.');
            return;
        }

        const updatedPartners = [...currentPartners, { email: newEmail.trim(), frequency: newFreq }];
        onUpdate({ partners: updatedPartners });
        setNewEmail('');
    };

    const handleRemovePartner = (email: string) => {
        if (!onUpdate) return;
        const updatedPartners = (config?.partners || []).filter(p => p.email !== email);
        onUpdate({ partners: updatedPartners });
    };

    const handleToggleFreq = (email: string) => {
        if (!onUpdate) return;
        const updatedPartners = (config?.partners || []).map(p => 
            p.email === email ? { ...p, frequency: p.frequency === 'daily' ? 'weekly' : 'daily' as 'daily'|'weekly' } : p
        );
        onUpdate({ partners: updatedPartners });
    };

    return (
        <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 flex flex-col h-full lg:col-span-1 min-h-[300px]">
            <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-2">
                    <div className="p-2 bg-pink-50 dark:bg-pink-900/20 text-pink-500 rounded-xl">
                        <MailIcon className="w-5 h-5" />
                    </div>
                    <div>
                        <span className="font-bold text-gray-900 dark:text-white block leading-tight">Commitment</span>
                        <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Protocol</span>
                    </div>
                </div>
                
                {/* Global Toggle */}
                <div className="relative inline-flex items-center cursor-pointer">
                    <input 
                        type="checkbox" 
                        checked={config?.enabled || false} 
                        onChange={e => onUpdate && onUpdate({ enabled: e.target.checked })} 
                        className="sr-only peer" 
                    />
                    <div className="w-9 h-5 bg-gray-200 dark:bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-pink-500"></div>
                </div>
            </div>
            
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 leading-relaxed">
                External accountability increases success rates by 65%.
            </p>

            {config?.enabled && allTasks && (
                <button
                    onClick={handleCopyReport}
                    className="w-full py-2 mb-3 text-xs font-bold text-pink-600 hover:text-white dark:text-pink-400 dark:hover:text-white hover:bg-pink-500 dark:hover:bg-pink-500 border border-pink-200 dark:border-pink-800/60 rounded-xl transition-all flex items-center justify-center gap-1.5 focus:outline-none"
                >
                    <CopyIcon className="w-3.5 h-3.5" />
                    {copied ? 'Copied Report!' : 'Copy Progress Report'}
                </button>
            )}

            <div className="flex-grow overflow-y-auto custom-scrollbar pr-1 mb-4 space-y-2 max-h-[120px]">
                {(!config?.partners || config.partners.length === 0) && (
                    <div className="text-center py-4 text-xs text-gray-400 italic border border-dashed border-gray-200 dark:border-slate-700 rounded-xl">
                        No partners added yet.
                    </div>
                )}
                {config?.partners?.map(p => (
                    <div key={p.email} className="flex items-center justify-between bg-gray-50 dark:bg-slate-700/30 p-2 rounded-lg border border-gray-100 dark:border-slate-700 group">
                        <div className="min-w-0">
                            <p className="text-xs font-bold text-gray-700 dark:text-gray-300 truncate">{p.email}</p>
                            <button 
                                onClick={() => handleToggleFreq(p.email)}
                                className="text-[9px] uppercase font-bold text-pink-500 hover:text-pink-600"
                            >
                                {p.frequency} Report
                            </button>
                        </div>
                        <button 
                            onClick={() => handleRemovePartner(p.email)}
                            className="text-gray-400 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                            <TrashIcon className="w-3.5 h-3.5" />
                        </button>
                    </div>
                ))}
            </div>

            <form onSubmit={handleAddPartner} className="mt-auto pt-4 border-t border-gray-100 dark:border-slate-700">
                <div className="flex gap-2 mb-2">
                    <input 
                        type="email" 
                        value={newEmail}
                        onChange={e => setNewEmail(e.target.value)}
                        placeholder="Partner Email"
                        className="flex-grow w-full text-xs p-2 bg-gray-50 dark:bg-slate-700/50 border border-transparent focus:border-pink-500 rounded-lg outline-none transition-all dark:text-white"
                        required
                    />
                    <select 
                        value={newFreq}
                        onChange={(e) => setNewFreq(e.target.value as 'daily'|'weekly')}
                        className="text-xs bg-gray-50 dark:bg-slate-700/50 rounded-lg border-transparent focus:border-pink-500 outline-none text-gray-600 dark:text-gray-300"
                    >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                    </select>
                </div>
                <button 
                    type="submit"
                    className="w-full py-2 text-xs font-bold text-white bg-pink-500 hover:bg-pink-600 rounded-lg transition-colors flex items-center justify-center gap-1 shadow-md shadow-pink-200 dark:shadow-none"
                >
                    <PlusIcon className="w-3 h-3" /> Add Partner
                </button>
            </form>
        </div>
    );
};

export const StatsView: React.FC<StatsViewProps> = ({ stats, recentTasks = [], allTasks = [], hashtagConfigs = {}, onColorChange, accountabilityConfig, onUpdateAccountability, onViewDone, onSelectHashtag }) => {
  const [timeFrame, setTimeFrame] = useState<TimeFrame>('week');

  const filteredTasks = useMemo(() => {
      const now = new Date();
      if (timeFrame === 'all') return allTasks;

      let startTimestamp = 0;
      const todayStart = new Date(now.setHours(0,0,0,0)).getTime();

      if (timeFrame === 'today') startTimestamp = todayStart;
      else if (timeFrame === 'week') startTimestamp = getStartOfWeek(new Date()).getTime();
      else if (timeFrame === 'month') startTimestamp = getStartOfMonth(new Date()).getTime();
      else if (timeFrame === 'year') startTimestamp = new Date(new Date().getFullYear(), 0, 1).getTime();

      return allTasks.filter(t => t.completedAt && t.completedAt >= startTimestamp);
  }, [allTasks, timeFrame]);

  // Calculations
  const derivedStats = useMemo(() => {
      const completed = filteredTasks.filter(t => t.completed);
      const totalBreakMins = filteredTasks.reduce((acc, t) => acc + (t.isBreak ? (t.actualDuration || t.duration || 0) : 0), 0);
      const totalFocusMins = completed.reduce((acc, t) => acc + (!t.isBreak ? (t.actualDuration || t.duration || 0) : 0), 0);
      
      return {
          tasksCompleted: completed.length,
          frogsEaten: completed.filter(t => t.isFrog).length,
          timeFocused: totalFocusMins,
          timeBreaks: totalBreakMins,
          completedList: completed
      };
  }, [filteredTasks]);

  const flowMetrics = useMemo(() => {
      const counts = { flow: 0, high: 0, good: 0, distracted: 0, unknown: 0 };
      let totalScore = 0;
      let ratedCount = 0;

      derivedStats.completedList.forEach(t => {
          if (t.isBreak) return;
          if (t.flowState) {
              counts[t.flowState]++;
              if (t.flowState === 'flow') totalScore += 100;
              else if (t.flowState === 'high') totalScore += 75;
              else if (t.flowState === 'good') totalScore += 50;
              else if (t.flowState === 'distracted') totalScore += 25;
              ratedCount++;
          } else {
              counts.unknown++;
          }
      });

      const focusScore = ratedCount > 0 ? Math.round(totalScore / ratedCount) : 0;
      return { counts, focusScore, ratedCount };
  }, [derivedStats.completedList]);

  const hashtagAnalytics = useMemo(() => {
      const map: Record<string, { count: number, totalFlow: number, ratedCount: number }> = {};
      const scoreMap: Record<string, number> = { 'distracted': 1, 'good': 2, 'high': 3, 'flow': 4 };

      derivedStats.completedList.forEach(t => {
          t.hashtags.forEach(tag => {
              if (!map[tag]) map[tag] = { count: 0, totalFlow: 0, ratedCount: 0 };
              map[tag].count++;
              if (t.flowState) {
                  map[tag].totalFlow += scoreMap[t.flowState];
                  map[tag].ratedCount++;
              }
          });
      });

      return Object.entries(map)
        .map(([tag, d]) => ({
            tag,
            count: d.count,
            efficiency: d.ratedCount > 0 ? (d.totalFlow / d.ratedCount / 4) * 100 : 0
        }))
        .sort((a, b) => b.count - a.count); // Sort by volume primarily
  }, [derivedStats.completedList]);

  const sparklines = useMemo(() => ({
      completed: getSparklineData(derivedStats.completedList, timeFrame, 'count'),
      focus: getSparklineData(derivedStats.completedList.filter(t => !t.isBreak), timeFrame, 'duration')
  }), [derivedStats.completedList, timeFrame]);

  const formatTime = (mins: number) => {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m`;
  };

  const handlePrint = () => window.print();

  return (
    <div className="max-w-7xl mx-auto pb-12 px-4 sm:px-6">
        <style>{`
            @media print {
                body { background: white !important; color: black !important; }
                .no-print, header, nav { display: none !important; }
                .print-container { box-shadow: none !important; border: 1px solid #ccc !important; }
            }
        `}</style>

        {/* Header Area */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 mt-4">
            <div>
                <h2 className="text-4xl font-heading font-bold text-gray-800 dark:text-white">Analytics</h2>
                <p className="text-gray-500 dark:text-gray-400 mt-1">Measure your mind, master your time.</p>
            </div>
            
            <div className="flex items-center gap-3 no-print">
                <div className="bg-white dark:bg-slate-800 p-1.5 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 flex relative">
                    {(['today', 'week', 'month', 'all'] as TimeFrame[]).map((tf) => (
                        <button
                            key={tf}
                            onClick={() => setTimeFrame(tf)}
                            className={`px-4 py-2 rounded-xl text-sm font-bold capitalize transition-all duration-300 relative z-10 ${timeFrame === tf ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-slate-700 dark:text-gray-400'}`}
                        >
                            {tf}
                        </button>
                    ))}
                </div>
                <button onClick={handlePrint} className="p-3 bg-white dark:bg-slate-800 text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 transition">
                    <PrinterIcon className="w-5 h-5" />
                </button>
            </div>
        </div>

        {/* Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
            
            {/* Top Row: Metrics */}
            <StatCard 
                icon={<CheckIcon />} 
                title="Completed" 
                value={derivedStats.tasksCompleted} 
                color="text-blue-600" 
                data={sparklines.completed}
            />
            <StatCard 
                icon={<TrophyIcon />} // Frog icon is literal char
                title="Frogs Eaten" 
                value={derivedStats.frogsEaten} 
                subValue="High Impact Tasks"
                color="text-green-600" 
            />
            <StatCard 
                icon={<ClockIcon />} 
                title="Deep Work" 
                value={formatTime(derivedStats.timeFocused)} 
                color="text-indigo-600" 
                data={sparklines.focus}
            />
            <StatCard 
                icon={<InfinityIcon />} 
                title="Recharge" 
                value={formatTime(derivedStats.timeBreaks)} 
                color="text-teal-500" 
            />

            {/* Row 2: Deep Analysis */}
            
            {/* Focus Score (Square) */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 flex flex-col items-center justify-center relative overflow-hidden lg:col-span-1 min-h-[300px]">
                <div className="absolute top-6 left-6 flex items-center gap-2 z-20">
                    <ZapIcon className="w-5 h-5 text-indigo-500" />
                    <span className="text-sm font-bold text-gray-900 dark:text-white">Focus Score</span>
                </div>
                
                <div className="flex-grow flex items-center justify-center w-full">
                    <FocusScoreRing score={flowMetrics.focusScore} />
                </div>
                
                <div className="absolute bottom-6 left-0 right-0 px-8">
                    <div className="flex gap-1 h-1.5 w-full rounded-full overflow-hidden bg-gray-100 dark:bg-slate-700">
                        <div style={{ width: `${(flowMetrics.counts.flow / Math.max(1, flowMetrics.ratedCount)) * 100}%` }} className="bg-purple-500 h-full" title="Flow"></div>
                        <div style={{ width: `${(flowMetrics.counts.high / Math.max(1, flowMetrics.ratedCount)) * 100}%` }} className="bg-indigo-500 h-full" title="High"></div>
                        <div style={{ width: `${(flowMetrics.counts.good / Math.max(1, flowMetrics.ratedCount)) * 100}%` }} className="bg-blue-400 h-full" title="Good"></div>
                        <div style={{ width: `${(flowMetrics.counts.distracted / Math.max(1, flowMetrics.ratedCount)) * 100}%` }} className="bg-red-400 h-full" title="Distracted"></div>
                    </div>
                    <div className="flex justify-between text-[10px] text-gray-400 mt-1 w-full font-medium uppercase tracking-wider">
                        <span>Flow</span>
                        <span>Distracted</span>
                    </div>
                </div>
            </div>

            {/* Chronotype (Wide) */}
            <div className="lg:col-span-2 min-h-[300px]">
                <ChronotypeChart tasks={filteredTasks} />
            </div>

            {/* Accountability (Tall or Square) */}
            <AccountabilityCard 
                config={accountabilityConfig} 
                onUpdate={onUpdateAccountability} 
                allTasks={allTasks}
            />

            {/* Row 3: Breakdown */}

            {/* Hashtag Efficiency */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 lg:col-span-2 max-h-[400px] flex flex-col">
                <div className="flex justify-between items-center mb-6 shrink-0">
                    <h3 className="font-bold text-gray-900 dark:text-white flex items-center gap-2">
                        <ActivityIcon className="w-5 h-5 text-emerald-500" />
                        Tag Efficiency
                    </h3>
                    <span className="text-xs text-gray-400">Vol / Focus</span>
                </div>
                
                <div className="flex-grow overflow-y-auto custom-scrollbar pr-2 space-y-3">
                    {hashtagAnalytics.length === 0 ? (
                        <p className="text-center text-gray-400 text-sm py-10">No tags used yet.</p>
                    ) : (
                        hashtagAnalytics.map(stat => (
                            <div key={stat.tag} className="flex items-center gap-3 group">
                                <div className="w-24 shrink-0">
                                    <button 
                                        onClick={() => onSelectHashtag(stat.tag)}
                                        className="text-xs font-bold text-gray-600 dark:text-gray-300 hover:text-indigo-500 truncate text-left block w-full"
                                    >
                                        #{stat.tag}
                                    </button>
                                </div>
                                
                                <div className="flex-grow bg-gray-100 dark:bg-slate-700 h-2 rounded-full overflow-hidden relative">
                                    {/* Efficiency Bar */}
                                    <div 
                                        className="h-full rounded-full transition-all duration-500"
                                        style={{ 
                                            width: `${stat.efficiency}%`,
                                            backgroundColor: hashtagConfigs[stat.tag]?.color || '#3b82f6'
                                        }}
                                    ></div>
                                </div>
                                
                                <div className="w-16 shrink-0 text-right">
                                    <span className="text-[10px] font-mono text-gray-400">{stat.count} tasks</span>
                                </div>
                                
                                <input 
                                    type="color" 
                                    value={hashtagConfigs[stat.tag]?.color || '#3b82f6'}
                                    onChange={(e) => onColorChange && onColorChange(stat.tag, { color: e.target.value })}
                                    className="w-4 h-4 rounded-full border-none p-0 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                                />
                            </div>
                        ))
                    )}
                </div>
            </div>

            {/* Recent Activity Log */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 lg:col-span-2 max-h-[400px] flex flex-col">
                <div className="flex justify-between items-center mb-6 shrink-0">
                    <h3 className="font-bold text-gray-900 dark:text-white flex items-center gap-2">
                        <ClipboardCheckIcon className="w-5 h-5 text-gray-400" />
                        Activity Stream
                    </h3>
                    {onViewDone && (
                        <button onClick={onViewDone} className="text-xs font-bold text-indigo-500 hover:underline">
                            View All
                        </button>
                    )}
                </div>

                <div className="flex-grow overflow-y-auto custom-scrollbar pr-2 space-y-4 relative">
                    {/* Timeline Spine */}
                    <div className="absolute left-2.5 top-2 bottom-2 w-px bg-gray-100 dark:bg-slate-700"></div>

                    {filteredTasks.slice(0, 20).map(task => (
                        <div key={task.id} className="relative pl-8 group">
                            <div className={`absolute left-0 top-1.5 w-5 h-5 rounded-full border-2 flex items-center justify-center bg-white dark:bg-slate-800 z-10 ${task.completed ? 'border-green-500' : 'border-gray-300 dark:border-slate-600'}`}>
                                {task.completed && <div className="w-2 h-2 bg-green-500 rounded-full"></div>}
                            </div>
                            
                            <div className="flex justify-between items-start">
                                <div>
                                    <p className={`text-sm font-medium ${task.completed ? 'text-gray-800 dark:text-gray-200' : 'text-gray-400'}`}>
                                        {task.title}
                                    </p>
                                    <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-[10px] text-gray-400">
                                            {task.completedAt ? new Date(task.completedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Pending'}
                                        </span>
                                        {task.hashtags.map(t => (
                                            <span key={t} className="text-[10px] text-indigo-400">#{t}</span>
                                        ))}
                                    </div>
                                </div>
                                {task.flowState && (
                                    <span className="text-[10px] uppercase font-bold text-gray-300 bg-gray-50 dark:bg-slate-700 px-1.5 py-0.5 rounded">
                                        {task.flowState}
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                    {filteredTasks.length === 0 && (
                        <p className="text-center text-gray-400 text-sm py-10">No activity recorded for this period.</p>
                    )}
                </div>
            </div>

        </div>
    </div>
  );
};
