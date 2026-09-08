
import React, { useState, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { 
    SunIcon, MoonIcon, BrainCircuit, FlameIcon, CheckIcon, BatteryIcon, 
    ClockIcon, CoffeeIcon, PillIcon, BoltIcon, MapIcon, ChevronRightIcon, UtensilsIcon 
} from './Icons';
import { CircadianMode, StimulantType, MentalState } from '../types';
import { getSunTimes } from '../utils/sunUtils';
import { resolveUserLocation } from '../utils/locationUtils';

interface BioStateCheckInProps {
    dialogProps?: React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement>;
    onSubmit: (data: any, score: number, mode: CircadianMode, solar?: { sunrise?: string, sunset?: string, solarNoon?: string }) => void;
    onClose?: () => void;
}

export const BioStateCheckIn: React.FC<BioStateCheckInProps> = ({ onSubmit, onClose, dialogProps }) => {
    const [stepIndex, setStepIndex] = useState(0);
    const [geoError, setGeoError] = useState(false);
    const [locationRequested, setLocationRequested] = useState(false);
    const [locationLoading, setLocationLoading] = useState(false);
    
    // Data State
    const [wakeTime, setWakeTime] = useState("07:00");
    const [morningLight, setMorningLight] = useState<boolean | null>(null);
    const [eatingWindowDuration, setEatingWindowDuration] = useState<number>(10);
    const [firstMealTime, setFirstMealTime] = useState("08:00");
    const [currentState, setCurrentState] = useState(5); // Combined Energy/Focus 1-10
    
    // Location Fallback
    const [manualLat, setManualLat] = useState("");
    const [manualLng, setManualLng] = useState("");
    const [locationMeta, setLocationMeta] = useState<{ source?: string; cityName?: string; countryName?: string }>({});

    // Calculated
    const [score, setScore] = useState(0);
    const [mode, setMode] = useState<CircadianMode>('maintenance');
    const [solarTimes, setSolarTimes] = useState<{ sunrise?: string, sunset?: string, solarNoon?: string }>({});
    const [scanText, setScanText] = useState("Aligning Solar Rhythm...");

    const requestLocation = useCallback(() => {
        setLocationRequested(true);
        setLocationLoading(true);
        resolveUserLocation(5000)
            .then((coords) => {
                setLocationMeta({
                    source: coords.source,
                    cityName: coords.cityName,
                    countryName: coords.countryName
                });
                const times = getSunTimes(new Date(), coords.latitude, coords.longitude);
                if (times.sunrise && times.sunset) {
                    setSolarTimes({ 
                        sunrise: times.sunrise, 
                        sunset: times.sunset,
                        solarNoon: times.solarNoon
                    });
                } else {
                    setGeoError(true);
                }
            })
            .catch((e) => {
                console.error("Failed to resolve approved location:", e);
                setGeoError(true);
            })
            .finally(() => setLocationLoading(false));
    }, []);

    const next = () => setStepIndex(prev => prev + 1);

    const handleManualLocation = () => {
        const lat = parseFloat(manualLat);
        const lng = parseFloat(manualLng);
        if (!isNaN(lat) && !isNaN(lng)) {
            const times = getSunTimes(new Date(), lat, lng);
            setSolarTimes({ 
                sunrise: times.sunrise || "06:00", 
                sunset: times.sunset || "18:00",
                solarNoon: times.solarNoon || "12:00"
            });
            setGeoError(false);
        }
    };

    const calculateLastMeal = () => {
        if (!firstMealTime) return "--:--";
        const [h, m] = firstMealTime.split(':').map(Number);
        const endH = (h + eatingWindowDuration) % 24;
        return `${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const calculate = () => {
        let rawScore = 0;
        
        // 1. Morning Light (30 pts)
        if (morningLight) rawScore += 30;
        
        // 2. Eating Window (30 pts)
        // Bonus for < 11h window
        if (eatingWindowDuration <= 10) rawScore += 30;
        else if (eatingWindowDuration <= 12) rawScore += 20;
        else rawScore += 10;

        // 3. Current State (40 pts)
        rawScore += (currentState * 4); 

        const finalScore = Math.min(100, Math.round(rawScore));
        setScore(finalScore);

        if (finalScore < 50) setMode('recovery');
        else if (finalScore >= 80) setMode('apex');
        else setMode('maintenance');

        next(); // Move to scanning
    };

    // Scanning Effect
    useEffect(() => {
        if (stepIndex === 4) { // Scanning Step
            const texts = ["Calculating Sunrise Offset...", "Optimizing Metabolic Window...", "Calibrating Peak Zones..."];
            let idx = 0;
            const interval = setInterval(() => {
                if (idx < texts.length) setScanText(texts[idx++]);
                else {
                    clearInterval(interval);
                    next();
                }
            }, 800);
            return () => clearInterval(interval);
        }
    }, [stepIndex]);

    const handleFinalize = useCallback(() => {
        // Interpret Combined State
        // High score = High Energy, High Clarity
        const energyVal = currentState; 
        const clarityVal = currentState;
        
        onSubmit({
            sunrise: morningLight!,
            sleepHours: 8, // Default, assumed handled in settings later
            energy: energyVal,
            clarity: clarityVal,
            interest: 5, // Default
            wakeTime,
            eatingWindow: eatingWindowDuration,
            firstMealTime,
            stimulant: 'none', // Removed from quiz for speed
            mentalState: currentState > 7 ? 'hyperfocus' : currentState < 4 ? 'sluggish' : 'flow',
            locationOverride: manualLat ? { lat: parseFloat(manualLat), lng: parseFloat(manualLng) } : undefined
        }, score, mode, solarTimes);
    }, [morningLight, currentState, wakeTime, eatingWindowDuration, firstMealTime, manualLat, manualLng, score, mode, solarTimes, onSubmit]);

    // Keyboard support for result screen
    useEffect(() => {
        if (stepIndex === 5) {
            const handleKey = (e: KeyboardEvent) => {
                if (e.key === 'Enter') handleFinalize();
            }
            window.addEventListener('keydown', handleKey);
            return () => window.removeEventListener('keydown', handleKey);
        }
    }, [stepIndex, handleFinalize]);

    return ReactDOM.createPortal(
        <div {...dialogProps} className="fixed inset-0 z-[9999] bg-[#020617] text-white flex flex-col font-sans animate-fadeIn select-none overflow-hidden">
            
            {/* Dynamic Background */}
            <div className="absolute inset-0 pointer-events-none">
                <div className={`absolute top-[-50%] left-[-50%] w-[200%] h-[200%] bg-gradient-radial from-amber-900/20 via-transparent to-transparent opacity-60 blur-3xl transition-all duration-1000 
                    ${stepIndex === 5 && mode === 'apex' ? 'from-red-600/30' : ''}
                    ${stepIndex === 5 && mode === 'recovery' ? 'from-emerald-600/30' : ''}
                `}></div>
            </div>

            {/* Header */}
            <div className="p-6 relative z-10 flex justify-between items-center">
                <div className="flex items-center gap-2">
                    <div className="h-1 w-20 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-amber-500 transition-all duration-500" style={{ width: `${(stepIndex / 5) * 100}%` }}></div>
                    </div>
                    <span className="text-xs font-bold text-slate-500">SOLAR SYNC</span>
                </div>
                {onClose && <button onClick={onClose} className="text-slate-500 hover:text-white transition">Exit</button>}
            </div>

            {/* Content Area */}
            <div className="flex-grow flex flex-col items-center justify-center p-6 relative z-10">
                
                {/* Step 0: Location Fallback (Only if Error) */}
                {geoError && stepIndex === 0 && (
                    <div className="w-full max-w-md animate-slideIn text-center">
                        <MapIcon className="w-12 h-12 text-amber-500 mx-auto mb-6" />
                        <h3 className="text-xl font-bold mb-2">Location Required</h3>
                        <p className="text-slate-400 text-sm mb-6">To calculate solar noon and UV windows, we need your coordinates.</p>
                        
                        <div className="flex gap-2 mb-4">
                            <input 
                                type="number" placeholder="Lat" 
                                value={manualLat} onChange={e => setManualLat(e.target.value)}
                                className="w-1/2 p-3 bg-slate-800 border border-slate-700 rounded-xl text-center focus:border-amber-500 outline-none"
                            />
                            <input 
                                type="number" placeholder="Lng" 
                                value={manualLng} onChange={e => setManualLng(e.target.value)}
                                className="w-1/2 p-3 bg-slate-800 border border-slate-700 rounded-xl text-center focus:border-amber-500 outline-none"
                            />
                        </div>
                        <button 
                            onClick={handleManualLocation}
                            disabled={!manualLat || !manualLng}
                            className="w-full py-4 bg-white text-slate-900 font-bold rounded-xl disabled:opacity-50"
                        >
                            Set Coordinates
                        </button>
                    </div>
                )}

                {/* Step 1: Wake Time (Solar Anchor) */}
                {(!geoError || solarTimes.sunrise) && stepIndex === 0 && (
                    <div className="w-full max-w-sm animate-slideIn text-center">
                        <ClockIcon className="w-12 h-12 text-amber-400 mx-auto mb-4" />
                        <h3 className="text-2xl font-bold uppercase mb-2">Wake Time</h3>
                        <p className="text-slate-400 mb-6 text-sm">Your biological anchor point.</p>
                        {!locationRequested && (
                            <div className="mb-5 rounded-xl border border-slate-700 bg-slate-800/70 p-4 text-left">
                                <p className="text-sm text-slate-300">Optional: use your precise location to calculate sunrise and solar noon. It stays on this device and no IP-location service is used.</p>
                                <button type="button" onClick={requestLocation} className="mt-3 rounded-lg border border-slate-600 px-3 py-2 text-sm font-bold text-white">Use my location</button>
                            </div>
                        )}
                        {locationLoading && <p className="mb-4 text-sm text-slate-400">Requesting location...</p>}
                        <input 
                            type="time" 
                            value={wakeTime}
                            onChange={(e) => setWakeTime(e.target.value)}
                            className="bg-slate-800 text-5xl font-mono text-center p-6 rounded-3xl border-2 border-amber-500/50 focus:border-amber-500 outline-none w-full text-white color-scheme-dark shadow-xl"
                        />
                        <button onClick={next} className="w-full mt-8 py-4 bg-white text-slate-900 font-bold rounded-xl hover:bg-slate-200 transition">Next</button>
                    </div>
                )}

                {/* Step 2: Morning Light */}
                {stepIndex === 1 && (
                    <div className="w-full max-w-md animate-slideIn text-center">
                        <SunIcon className="w-16 h-16 text-amber-400 mx-auto mb-4 animate-pulse" />
                        <h3 className="text-2xl font-bold uppercase mb-2">Morning Light?</h3>
                        <p className="text-slate-400 mb-8 text-sm">Did you get bright light within 2h of waking?</p>
                        <div className="grid grid-cols-2 gap-4">
                            <button onClick={() => { setMorningLight(false); next(); }} className="p-6 bg-slate-800 border-2 border-slate-700 hover:border-slate-500 rounded-2xl transition group hover:bg-slate-700">
                                <span className="text-4xl mb-2 block">🌙</span>
                                <span className="font-bold text-slate-300 group-hover:text-white block">No / Indoors</span>
                            </button>
                            <button onClick={() => { setMorningLight(true); next(); }} className="p-6 bg-slate-800 border-2 border-slate-700 hover:border-amber-500/50 rounded-2xl transition group hover:bg-amber-900/10">
                                <span className="text-4xl mb-2 block">☀️</span>
                                <span className="font-bold text-slate-300 group-hover:text-amber-200 block">Yes</span>
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 3: Eating Window Setup */}
                {stepIndex === 2 && (
                    <div className="w-full max-w-md animate-slideIn text-center">
                        <UtensilsIcon className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
                        <h3 className="text-2xl font-bold uppercase mb-2">Eating Window</h3>
                        
                        <div className="bg-slate-800/50 p-6 rounded-2xl border border-white/5 mb-6">
                            <div className="mb-6">
                                <div className="flex justify-between text-xs font-bold uppercase text-slate-400 mb-2">
                                    <span>Duration</span>
                                    <span className="text-emerald-400">{eatingWindowDuration} Hours</span>
                                </div>
                                <input 
                                    type="range" min="4" max="14" step="1"
                                    value={eatingWindowDuration}
                                    onChange={(e) => setEatingWindowDuration(parseInt(e.target.value))}
                                    className="w-full h-3 bg-slate-700 rounded-full appearance-none cursor-pointer accent-emerald-500"
                                />
                                <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                                    <span>OMAD (4h)</span>
                                    <span>Standard (12h)</span>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-bold uppercase text-slate-400 mb-2">First Meal Time</label>
                                <input 
                                    type="time" 
                                    value={firstMealTime}
                                    onChange={(e) => setFirstMealTime(e.target.value)}
                                    className="bg-slate-900 text-2xl font-mono text-center p-3 rounded-xl border border-slate-600 focus:border-emerald-500 outline-none w-full text-white"
                                />
                            </div>
                        </div>

                        <div className="flex justify-center items-center gap-2 text-sm text-slate-400 mb-6">
                            <span>Last Meal:</span>
                            <span className="font-mono font-bold text-emerald-200">{calculateLastMeal()}</span>
                            <span className="text-xs bg-slate-800 px-2 py-0.5 rounded text-slate-500">({24 - eatingWindowDuration}h Fast)</span>
                        </div>

                        <button onClick={next} className="w-full py-4 bg-white text-slate-900 font-bold rounded-xl hover:bg-slate-200 transition">Next</button>
                    </div>
                )}

                {/* Step 4: Current State */}
                {stepIndex === 3 && (
                    <div className="w-full max-w-md animate-slideIn text-center">
                        <BatteryIcon className="w-12 h-12 text-cyan-400 mx-auto mb-4" />
                        <h3 className="text-2xl font-bold uppercase mb-2">Current State</h3>
                        <p className="text-slate-400 mb-8 text-sm">How do you feel right now?</p>

                        <div className="relative h-16 w-full touch-none mb-8">
                            <div className="absolute top-1/2 left-0 right-0 h-3 bg-slate-800 rounded-full overflow-hidden">
                                <div className="h-full bg-gradient-to-r from-slate-600 via-cyan-500 to-white transition-all duration-100" style={{ width: `${(currentState / 10) * 100}%` }}></div>
                            </div>
                            <input 
                                type="range" min="1" max="10" step="1"
                                value={currentState}
                                onChange={(e) => setCurrentState(parseInt(e.target.value))}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                            />
                            <div className="absolute top-1/2 -mt-5 h-10 w-10 bg-white rounded-full shadow-lg pointer-events-none transition-all duration-100 flex items-center justify-center text-slate-900 font-bold text-lg" style={{ left: `calc(${((currentState - 1) / 9) * 100}% - 20px)` }}>
                                {currentState}
                            </div>
                        </div>

                        <div className="flex justify-between text-xs font-bold uppercase text-slate-500 tracking-wider mb-8">
                            <span>Drained / Foggy</span>
                            <span>Sharp / Charged</span>
                        </div>

                        <button onClick={calculate} className="w-full py-4 bg-white text-slate-900 font-bold rounded-xl hover:bg-slate-200 transition">Calibrate</button>
                    </div>
                )}

                {/* Step 5: Scanning Animation */}
                {stepIndex === 4 && (
                    <div className="text-center animate-fadeIn">
                        <div className="relative w-32 h-32 mb-8 mx-auto">
                            <div className="absolute inset-0 border-4 border-slate-800 rounded-full"></div>
                            <div className="absolute inset-0 border-4 border-t-amber-500 border-r-transparent border-b-transparent border-l-transparent rounded-full animate-spin"></div>
                            <BrainCircuit className="absolute inset-0 m-auto w-12 h-12 text-white animate-pulse" />
                        </div>
                        <h3 className="text-xl font-mono font-bold text-amber-400 animate-pulse">{scanText}</h3>
                    </div>
                )}

                {/* Step 6: Result */}
                {stepIndex === 5 && (
                    <div className="w-full flex flex-col items-center animate-scaleIn">
                        {/* Score Ring */}
                        <div className="relative mb-10 w-64 h-64 flex-shrink-0">
                            <svg className="w-full h-full transform -rotate-90 relative z-10" viewBox="0 0 256 256">
                                <circle cx="128" cy="128" r="110" stroke="#1e293b" strokeWidth="16" fill="none" />
                                <circle 
                                    cx="128" 
                                    cy="128" 
                                    r="110" 
                                    stroke={mode === 'apex' ? '#ef4444' : mode === 'recovery' ? '#10b981' : '#3b82f6'} 
                                    strokeWidth="16" 
                                    fill="#0f172a" 
                                    strokeDasharray={2 * Math.PI * 110} 
                                    strokeDashoffset={2 * Math.PI * 110 * (1 - score / 100)} 
                                    strokeLinecap="round" 
                                    className="transition-all duration-1000 ease-out"
                                />
                            </svg>
                            <div className="absolute inset-0 flex flex-col items-center justify-center z-20">
                                <span className="text-8xl font-black font-heading text-white drop-shadow-2xl leading-none mb-2">{score}</span>
                                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Alignment Score</span>
                            </div>
                        </div>

                        <h2 className={`text-4xl font-heading font-black uppercase tracking-wide mb-4 text-center ${mode === 'apex' ? 'text-red-500' : mode === 'recovery' ? 'text-emerald-400' : 'text-blue-400'}`}>
                            {mode === 'apex' ? 'Apex Predator' : mode === 'recovery' ? 'Recovery Mode' : 'Maintenance'}
                        </h2>

                        <p className="text-slate-400 text-center max-w-xs mb-10 text-sm">
                            {mode === 'apex' ? "Physiology optimized. Attack high-leverage tasks." : mode === 'recovery' ? "System misaligned. Focus on regeneration." : "Systems nominal. Proceed with plan."}
                        </p>

                        <button 
                            onClick={handleFinalize}
                            className={`px-12 py-4 rounded-xl font-bold text-white shadow-xl hover:scale-105 active:scale-95 transition flex items-center gap-3 text-lg ${mode === 'apex' ? 'bg-red-600 hover:bg-red-500' : mode === 'recovery' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-blue-600 hover:bg-blue-500'}`}
                        >
                            Enter Timeline <ChevronRightIcon className="w-5 h-5" />
                        </button>
                    </div>
                )}

            </div>
        </div>,
        document.body
    );
};
