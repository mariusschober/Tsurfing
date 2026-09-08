
import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Task, Goal } from '../types';
import { 
    FlameIcon, 
    WindIcon, 
    RepeatIcon, 
    SkullIcon, 
    ZapIcon, 
    AxeIcon, 
    TrashIcon,
    CheckIcon,
    InfinityIcon
} from './Icons';

interface ExcitementPlannerProps {
    dialogProps?: React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement>;
  items: (Task | Goal)[];
  mode?: 'task' | 'goal';
  onComplete: (ratings: Record<string, { excitement: number, roi: number }>) => void;
  onClose: () => void;
  onBreakdown: (item: Task | Goal) => void;
}

export const ExcitementPlanner: React.FC<ExcitementPlannerProps> = ({ items, mode = 'task', onComplete, onClose, onBreakdown, dialogProps }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [ratings, setRatings] = useState<Record<string, { excitement: number, roi: number }>>({});
  const [hoverCoords, setHoverCoords] = useState<{x: number, y: number} | null>(null);
  const [isPitTrapActive, setIsPitTrapActive] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            onClose();
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!items || items.length === 0) {
      return null;
  }

  // If we've gone past the last item, complete the process
  useEffect(() => {
      if (currentIndex >= items.length) {
          onComplete(ratings);
      }
  }, [currentIndex, items.length, onComplete, ratings]);

  const currentItem = items[currentIndex];
  if (!currentItem) return null; // Safety check

  const getItemTitle = (item: Task | Goal) => 'title' in item ? item.title : item.name;
  
  const getItemMetadata = (item: Task | Goal) => {
      if ('duration' in item) {
          const t = item as Task;
          const parts = [];
          if (t.duration) parts.push(`${t.duration}m`);
          if (t.hashtags && t.hashtags.length > 0) parts.push(`#${t.hashtags[0]}`);
          return parts.join(' • ') || 'Task';
      }
      return 'Goal';
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (isPitTrapActive) return;
      setDragActive(true);
      updateCoords(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragActive || isPitTrapActive) return;
      updateCoords(e);
  };

  const handlePointerUp = () => {
      if (!dragActive || isPitTrapActive) return;
      setDragActive(false);
      commitSelection();
  };

  const updateCoords = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!gridRef.current) return;
      const rect = gridRef.current.getBoundingClientRect();
      
      // Calculate raw x, y relative to the grid
      let x = e.clientX - rect.left;
      let y = e.clientY - rect.top;

      // Clamp coordinates to grid bounds
      x = Math.max(0, Math.min(rect.width, x));
      y = Math.max(0, Math.min(rect.height, y));

      setHoverCoords({ x, y });
  };

  const commitSelection = (coords = hoverCoords) => {
      if (!gridRef.current || !coords) return;
      
      const rect = gridRef.current.getBoundingClientRect();
      const xPct = (coords.x / rect.width) * 100;
      // Invert Y because typically graph Y=0 is bottom, but screen Y=0 is top
      const yPct = 100 - ((coords.y / rect.height) * 100);

      // Check Pit (Low Spark < 50, High Drag > 50)
      if (xPct > 50 && yPct < 50) {
          setIsPitTrapActive(true);
          return;
      }

      const newRatings = {
          ...ratings,
          [currentItem.id]: { excitement: Math.round(yPct), roi: Math.round(xPct) }
      };
      setRatings(newRatings);
      
      // Animate transition slightly? For now instant.
      setCurrentIndex(prev => prev + 1);
      setHoverCoords(null);
  };

  const handleBreakdownClick = () => {
      onBreakdown(currentItem);
      // Close planner so user can focus on breakdown in the main view
      onClose(); 
  };

  const handleForceSchedule = () => {
      const newRatings = {
          ...ratings,
          [currentItem.id]: { excitement: 10, roi: 90 }
      };
      setRatings(newRatings);
      setIsPitTrapActive(false);
      setHoverCoords(null);
      setCurrentIndex(prev => prev + 1);
  };

  const handleDiscard = () => {
      setIsPitTrapActive(false);
      setHoverCoords(null);
      setCurrentIndex(prev => prev + 1);
  };

  // Determine active quadrant info
  let quadrantInfo = {
      name: "CALIBRATE",
      description: "Drag to rate Spark vs Drag",
      color: "text-slate-400",
      borderColor: "border-slate-700",
      bgGradient: "radial-gradient(circle at center, rgba(30,41,59,0.3) 0%, rgba(2,6,23,0.8) 100%)",
      icon: <ZapIcon className="w-6 h-6" />
  };

  if (hoverCoords && gridRef.current) {
      const rect = gridRef.current.getBoundingClientRect();
      const xPct = (hoverCoords.x / rect.width) * 100;
      const yPct = 100 - ((hoverCoords.y / rect.height) * 100);

      if (xPct <= 50 && yPct > 50) {
          quadrantInfo = { 
              name: "THE FLOW", 
              description: "High Spark • Low Drag. Your Natural State.", 
              color: "text-cyan-400", 
              borderColor: "border-cyan-500",
              bgGradient: "radial-gradient(circle at top left, rgba(34,211,238,0.15) 0%, rgba(2,6,23,0.9) 70%)",
              icon: <WindIcon className="w-6 h-6" /> 
          };
      } else if (xPct > 50 && yPct > 50) {
          quadrantInfo = { 
              name: "THE BEAST", 
              description: "High Spark • High Drag. Morning Peak Only.", 
              color: "text-orange-500", 
              borderColor: "border-orange-500",
              bgGradient: "radial-gradient(circle at top right, rgba(249,115,22,0.15) 0%, rgba(2,6,23,0.9) 70%)",
              icon: <FlameIcon className="w-6 h-6" /> 
          };
      } else if (xPct <= 50 && yPct <= 50) {
          quadrantInfo = { 
              name: "THE SCRAPS", 
              description: "Low Spark • Low Drag. Zombie Mode.", 
              color: "text-emerald-400", 
              borderColor: "border-emerald-500",
              bgGradient: "radial-gradient(circle at bottom left, rgba(16,185,129,0.15) 0%, rgba(2,6,23,0.9) 70%)",
              icon: <RepeatIcon className="w-6 h-6" /> 
          };
      } else {
          quadrantInfo = { 
              name: "THE PIT", 
              description: "Low Spark • High Drag. TRAP DETECTED.", 
              color: "text-red-500", 
              borderColor: "border-red-500",
              bgGradient: "radial-gradient(circle at bottom right, rgba(239,68,68,0.15) 0%, rgba(2,6,23,0.9) 70%)",
              icon: <SkullIcon className="w-6 h-6" /> 
          };
      }
  }

  // --- RENDER ---
  return ReactDOM.createPortal(
      <div {...dialogProps} className="fixed inset-0 z-[9999] bg-[#020617] text-white font-sans flex flex-col overflow-hidden animate-fadeIn">
          
          {/* Dynamic Background */}
          <div 
            className="absolute inset-0 pointer-events-none transition-all duration-500"
            style={{ background: quadrantInfo.bgGradient }}
          />
          <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCI+CjxwYXRoIGQ9Ik0wIDBoNDB2NDBIMHoiIGZpbGw9Im5vbmUiLz4KPHBhdGggZD0iTTAgNDBoNDBNNDAgMHY0MCIgc3Ryb2tlPSJyZ2JhKDI1NSwgMjU1LDI1NSwgMC4wNSkiIHN0cm9rZS13aWR0aD0iMSIvPgo8L3N2Zz4=')] opacity-20 pointer-events-none"></div>

          {/* Header */}
          <div className="relative z-10 flex justify-between items-center p-6 border-b border-white/5 bg-[#020617]/50 backdrop-blur-md">
              <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-sm font-bold text-slate-300">
                      {currentIndex + 1}/{items.length}
                  </div>
                  <div>
                      <h2 className="text-lg font-heading font-bold tracking-widest uppercase text-white">Visceral Matrix</h2>
                      <p className="text-xs text-slate-500">Calibrate your biological engine</p>
                  </div>
              </div>
              <button onClick={onClose} className="text-xs font-bold text-slate-500 hover:text-white uppercase tracking-wider px-3 py-1 rounded hover:bg-white/10 transition">
                  Exit
              </button>
          </div>

          {/* Main Area */}
          <div className="flex-grow relative z-10 flex flex-col items-center justify-center p-4">
              
              {/* HUD / Task Card */}
              <div className="w-full max-w-md mb-8">
                  <div className={`bg-slate-900/80 backdrop-blur-md border-l-4 ${quadrantInfo.borderColor} rounded-r-xl p-6 shadow-2xl transition-all duration-300 relative overflow-hidden`}>
                        <div className="flex justify-between items-start mb-2 relative z-10">
                            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                                {getItemMetadata(currentItem)}
                            </span>
                        </div>
                        <h3 className="text-3xl font-bold text-white mb-4 leading-tight relative z-10 truncate">
                            {getItemTitle(currentItem)}
                        </h3>
                        
                        <div className="flex items-center gap-3 relative z-10">
                            <div className={`p-2 rounded-full bg-slate-950 border border-white/10 ${quadrantInfo.color} transition-colors duration-300`}>
                                {quadrantInfo.icon}
                            </div>
                            <div>
                                <p className={`text-sm font-black uppercase tracking-widest ${quadrantInfo.color} transition-colors duration-300`}>
                                    {quadrantInfo.name}
                                </p>
                                <p className="text-[10px] text-slate-400 font-medium tracking-wide">
                                    {quadrantInfo.description}
                                </p>
                            </div>
                        </div>
                  </div>
              </div>

              {/* THE GRID */}
              <div className="relative w-full max-w-[280px] sm:max-w-[360px] md:max-w-[400px] aspect-square select-none touch-none my-14 mx-auto sm:my-16 md:my-20">
                   
                   {/* Axis Labels - Positioned consistently outside */}
                   {/* Top: Spark High */}
                   <div className="absolute -top-12 sm:-top-16 left-0 right-0 text-center flex flex-col justify-end h-14 pointer-events-none">
                       <span className="text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.6)]">Electrifying / Vital</span>
                       <span className="text-[8px] sm:text-[9px] text-slate-500 font-medium mt-1">Does this light a fire in you?</span>
                   </div>
                   
                   {/* Bottom: Spark Low */}
                   <div className="absolute -bottom-12 sm:-bottom-16 left-0 right-0 text-center flex flex-col justify-start h-14 pointer-events-none">
                       <span className="text-[8px] sm:text-[9px] text-slate-500 font-medium mb-1">Or put it out?</span>
                       <span className="text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">Numbing / Dead</span>
                   </div>
                   
                   {/* Left: Drag Low */}
                   <div className="absolute -left-12 sm:-left-16 top-0 bottom-0 flex flex-col items-end justify-center w-14 pointer-events-none">
                       <div className="-rotate-90 flex flex-col items-center w-40 origin-center translate-x-12 sm:translate-x-8">
                           <span className="text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] text-cyan-400 drop-shadow-[0_0_8px_rgba(34,211,238,0.6)]">Effortless / Flow</span>
                           <span className="text-[8px] sm:text-[9px] text-slate-500 font-medium mt-1">Muscle memory?</span>
                       </div>
                   </div>
                   
                   {/* Right: Drag High */}
                   <div className="absolute -right-12 sm:-right-16 top-0 bottom-0 flex flex-col items-start justify-center w-14 pointer-events-none">
                       <div className="rotate-90 flex flex-col items-center w-40 origin-center -translate-x-12 sm:-translate-x-8">
                           <span className="text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] text-red-500 drop-shadow-[0_0_8px_rgba(239,68,68,0.6)]">Grueling / Heavy</span>
                           <span className="text-[8px] sm:text-[9px] text-slate-500 font-medium mt-1">Brain burn?</span>
                       </div>
                   </div>

                   {/* Interaction Surface */}
                   <div 
                        ref={gridRef}
                        tabIndex={dialogProps ? 0 : undefined}
                        role={dialogProps ? 'group' : undefined}
                        aria-label={dialogProps ? 'Task rating grid: arrows adjust Spark and Drag; Enter confirms' : undefined}
                        onKeyDown={dialogProps ? event => {
                            const rect = gridRef.current?.getBoundingClientRect();
                            if (!rect || isPitTrapActive) return;
                            const coords = hoverCoords || { x: rect.width / 2, y: rect.height / 2 };
                            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); commitSelection(coords); return; }
                            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                            event.preventDefault();
                            setHoverCoords({
                                x: Math.max(0, Math.min(rect.width, coords.x + (event.key === 'ArrowRight' ? .1 : event.key === 'ArrowLeft' ? -.1 : 0) * rect.width)),
                                y: Math.max(0, Math.min(rect.height, coords.y + (event.key === 'ArrowDown' ? .1 : event.key === 'ArrowUp' ? -.1 : 0) * rect.height)),
                            });
                        } : undefined}
                        className={`w-full h-full bg-[#0f172a]/60 rounded-3xl border transition-all duration-300 relative overflow-hidden shadow-2xl cursor-crosshair ${isPitTrapActive ? 'border-red-600 shadow-[0_0_50px_rgba(220,38,38,0.4)]' : 'border-slate-700 hover:border-slate-500'}`}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onPointerLeave={handlePointerUp} // Cancel drag if leaving
                   >
                        {/* Grid Lines */}
                        <div className="absolute inset-0 opacity-20 pointer-events-none" 
                            style={{
                                backgroundImage: `linear-gradient(rgba(255,255,255,0.2) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.2) 1px, transparent 1px)`,
                                backgroundSize: '25% 25%'
                            }}
                        ></div>
                        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/10 pointer-events-none"></div>
                        <div className="absolute top-1/2 left-0 right-0 h-px bg-white/10 pointer-events-none"></div>

                        {/* Quadrant Watermarks */}
                        <div className="absolute top-4 left-4 text-[10px] font-black uppercase tracking-widest text-cyan-500/10 pointer-events-none">Q2: Flow</div>
                        <div className="absolute top-4 right-4 text-[10px] font-black uppercase tracking-widest text-orange-500/10 pointer-events-none">Q1: Beast</div>
                        <div className="absolute bottom-4 left-4 text-[10px] font-black uppercase tracking-widest text-emerald-500/10 pointer-events-none">Q3: Scraps</div>
                        <div className="absolute bottom-4 right-4 text-[10px] font-black uppercase tracking-widest text-red-500/10 pointer-events-none">Q4: Pit</div>

                        {/* The Puck & Ghost Task */}
                        {hoverCoords && (
                            <div 
                                className="absolute pointer-events-none transform -translate-x-1/2 -translate-y-1/2 z-30 flex flex-col items-center gap-2"
                                style={{ left: hoverCoords.x, top: hoverCoords.y }}
                            >
                                <div className={`w-6 h-6 rounded-full ${quadrantInfo.color.replace('text-', 'bg-')} shadow-[0_0_20px_currentColor] animate-pulse relative z-10`}></div>
                                <div className={`absolute inset-[-10px] rounded-full border-2 ${quadrantInfo.color.replace('text-', 'border-')} opacity-50`}></div>
                                
                                {/* Ghost Task "In Hand" */}
                                <div className="bg-slate-900/80 backdrop-blur-md border border-white/10 px-3 py-2 rounded-lg shadow-xl min-w-[120px] max-w-[200px] text-center transform translate-y-2 animate-fadeIn">
                                    <p className="text-[10px] text-white font-bold truncate">
                                        {getItemTitle(currentItem)}
                                    </p>
                                    <p className={`text-[8px] font-bold uppercase tracking-wider ${quadrantInfo.color}`}>
                                        {quadrantInfo.name}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Hint Text (Only when not interacting) */}
                        {!dragActive && !hoverCoords && !isPitTrapActive && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <div className="bg-black/40 backdrop-blur-sm px-4 py-2 rounded-full border border-white/10 animate-pulse">
                                    <span className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                                        <ZapIcon className="w-4 h-4" /> Drag Puck to Rate
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* PIT TRAP OVERLAY */}
                        {isPitTrapActive && (
                            <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-sm flex flex-col items-center justify-center text-center p-6 animate-fadeIn">
                                <div className="w-16 h-16 rounded-full bg-red-500/20 border border-red-500 text-red-500 flex items-center justify-center mb-4 animate-bounce">
                                    <SkullIcon className="w-8 h-8" />
                                </div>
                                <h4 className="text-2xl font-black text-red-500 uppercase tracking-widest mb-2">Trap Detected</h4>
                                <p className="text-sm text-red-200 mb-6 font-medium leading-relaxed max-w-[200px]">
                                    High friction, low reward. Your brain will reject this task.
                                </p>
                                <button 
                                    onClick={handleBreakdownClick}
                                    className="w-full py-3 bg-gradient-to-r from-red-600 to-orange-600 rounded-xl font-bold text-white shadow-lg mb-3 flex items-center justify-center gap-2 hover:scale-105 transition-transform"
                                >
                                    <AxeIcon className="w-4 h-4" /> Slice It Down
                                </button>
                                <div className="flex gap-2 w-full">
                                    <button 
                                        onClick={handleDiscard}
                                        className="flex-1 py-2 bg-slate-800 rounded-lg text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 transition"
                                    >
                                        Skip
                                    </button>
                                    <button 
                                        onClick={handleForceSchedule}
                                        className="flex-1 py-2 bg-transparent border border-red-900/50 rounded-lg text-xs font-bold text-red-800 hover:text-red-500 transition"
                                    >
                                        Force It
                                    </button>
                                </div>
                            </div>
                        )}
                   </div>
              </div>
          </div>
      </div>
  , document.body);
};
