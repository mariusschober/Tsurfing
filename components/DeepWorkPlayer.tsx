
import React, { useState, useEffect, useRef, useId } from 'react';
import ReactDOM from 'react-dom';
import { Modal } from './Modal';
import { somaFmChannels, SomaFmChannel } from '../utils/somaFmChannels';
import { Volume2Icon, VolumeXIcon, ChevronDownIcon } from './Icons';

interface DeepWorkPlayerProps {
  controlsTarget?: HTMLElement | null;
  presentation?: 'toolbar' | 'panel';
  controlsVisible?: boolean;
  onOpenChange?: (open: boolean) => void;
  fallbackFocusRef?: React.RefObject<HTMLElement>;
}

export const DeepWorkPlayer: React.FC<DeepWorkPlayerProps> = ({ controlsTarget, presentation = 'toolbar', controlsVisible = true, onOpenChange, fallbackFocusRef }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentStation, setCurrentStation] = useState<SomaFmChannel>(somaFmChannels[0]);
  const [volume, setVolume] = useState(0.5);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const pickerId = useId();
  const [error, setError] = useState<string | null>(null);
  
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const stationButtonRef = useRef<HTMLButtonElement>(null);

  // Initialize Audio
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "none";
    audio.volume = volume;
    audioRef.current = audio;

    const onPlay = () => {
        setIsLoading(false);
        setIsPlaying(true);
        setError(null);
    };
    
    const onPause = () => setIsPlaying(false);
    
    const onError = (e: Event) => {
        console.error("Stream Error", e);
        setIsLoading(false);
        setIsPlaying(false);
        setError("Stream unavailable");
    };

    const onWaiting = () => setIsLoading(true);
    const onCanPlay = () => setIsLoading(false);

    audio.addEventListener('playing', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('error', onError);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('canplay', onCanPlay);

    return () => {
        audio.pause();
        audio.removeEventListener('playing', onPlay);
        audio.removeEventListener('pause', onPause);
        audio.removeEventListener('error', onError);
        audio.removeEventListener('waiting', onWaiting);
        audio.removeEventListener('canplay', onCanPlay);
        audioRef.current = null;
    };
  }, []);

  // Sync Volume
  useEffect(() => {
      if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  const playStation = (station: SomaFmChannel) => {
      if (!audioRef.current) return;
      
      setIsLoading(true);
      setError(null);
      
      // Use standard mp3 stream. 
      const streamUrl = `https://ice1.somafm.com/${station.id}-128-mp3`;
      
      if (audioRef.current.src !== streamUrl) {
          audioRef.current.src = streamUrl;
          audioRef.current.load();
      }
      
      audioRef.current.play().catch(e => {
          console.error("Autoplay prevented or stream error", e);
          setIsLoading(false);
          setIsPlaying(false);
      });
  };

  // Handle Play/Pause Logic
  const togglePlay = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!audioRef.current) return;

      if (isPlaying) {
          audioRef.current.pause();
      } else {
          playStation(currentStation);
      }
  };

  const selectStation = (station: SomaFmChannel) => {
      setCurrentStation(station);
      playStation(station);
      setIsMenuOpen(false); 
      if (presentation === 'panel') stationButtonRef.current?.focus({ preventScroll: true });
  };

  const toggleMenu = () => setIsMenuOpen(open => !open);

  useEffect(() => { setIsMenuOpen(false); }, [presentation, controlsVisible]);
  useEffect(() => { onOpenChange?.(presentation === 'toolbar' && isMenuOpen); }, [isMenuOpen, presentation, onOpenChange]);

  // Global Keyboard Shortcut (M)
  const stateRef = useRef({ isPlaying, currentStation });
  useEffect(() => {
      stateRef.current = { isPlaying, currentStation };
  }, [isPlaying, currentStation]);

  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          const target = e.target as HTMLElement;
          if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) {
              return;
          }
          if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('[aria-modal="true"]')) return;

          if (e.key.toLowerCase() === 'm') {
              e.preventDefault();
              const { isPlaying: currentIsPlaying, currentStation: station } = stateRef.current;
              
              if (audioRef.current) {
                  if (currentIsPlaying) {
                      audioRef.current.pause();
                  } else {
                      playStation(station);
                  }
              }
          }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const stationPicker = (
    <div className="music-picker">
      <div className="p-4 bg-gray-50 dark:bg-slate-900/50 border-b border-gray-100 dark:border-slate-700">
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-semibold text-indigo-700 dark:text-indigo-300 break-words">{currentStation.title}</h4>
          {error && <span role="status" className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-gray-600 dark:text-gray-400">{currentStation.description}</p>
        <div className="music-volume mt-3">
          <button type="button" onClick={() => setVolume(volume === 0 ? 0.5 : 0)} aria-label={volume === 0 ? 'Unmute music' : 'Mute music'} className="header-control text-gray-600 dark:text-gray-300">
            {volume === 0 ? <VolumeXIcon className="h-5 w-5" aria-hidden="true" /> : <Volume2Icon className="h-5 w-5" aria-hidden="true" />}
          </button>
          <label className="min-w-0 flex-1 text-xs text-gray-600 dark:text-gray-300">Volume
            <input type="range" aria-label="Music volume" min="0" max="1" step="0.05" value={volume} onChange={e => setVolume(parseFloat(e.target.value))} className="block w-full min-h-11 accent-indigo-600" />
          </label>
        </div>
      </div>
      <div className="p-1" role="group" aria-label="Music stations">
        {somaFmChannels.map(station => <button type="button" key={station.id} onClick={() => selectStation(station)} aria-pressed={currentStation.id === station.id}
          className={`music-station ${currentStation.id === station.id ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700'}`}>
          <span className={`h-2 w-2 rounded-full shrink-0 ${currentStation.id === station.id ? 'bg-indigo-500' : 'bg-gray-300 dark:bg-slate-500'}`} aria-hidden="true" />
          <span className="min-w-0"><span className="block font-semibold">{station.title}</span><span className="block mt-1 text-xs text-gray-500 dark:text-gray-400">{station.description}</span></span>
        </button>)}
      </div>
      <p className="p-3 text-center text-xs text-gray-500 dark:text-gray-400">Powered by <a href="https://somafm.com" target="_blank" rel="noopener noreferrer" className="underline">SomaFM</a> · Ad-free</p>
    </div>
  );

  const controls = <div className="music-player">
    <div ref={buttonRef} className={`music-player__controls ${presentation === 'panel' ? 'music-player__controls--panel' : ''} rounded-xl border ${isPlaying ? 'music-player__controls--playing bg-indigo-600 border-indigo-600 text-white' : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-600 text-gray-700 dark:text-gray-300'}`}>
      <button type="button" onClick={togglePlay} aria-label={isPlaying ? 'Pause focus music' : 'Play focus music'} title={isPlaying ? 'Pause (M)' : 'Play Focus Music (M)'} className="header-control gap-2">
        {isLoading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : isPlaying ? <svg className="music-control-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1.25" /><rect x="14" y="4" width="4" height="16" rx="1.25" /></svg> : <svg className="music-control-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5a1 1 0 0 1 1.52-.85l11 6.5a2.15 2.15 0 0 1 0 3.7l-11 6.5A1 1 0 0 1 7 19.5z" /></svg>}
        {presentation === 'panel' && <span>{isPlaying ? 'Pause' : 'Play'}</span>}
      </button>
      <button ref={stationButtonRef} type="button" onClick={toggleMenu} aria-label="Select station" title="Select Station" aria-expanded={isMenuOpen} aria-controls={pickerId} aria-haspopup={presentation === 'toolbar' ? 'dialog' : undefined}
        className="header-control music-player__station-toggle">
        {presentation === 'panel' && <span className="truncate">{currentStation.title}</span>}
        <ChevronDownIcon className="music-control-icon" strokeWidth={2.5} aria-hidden="true" />
      </button>
    </div>
    {presentation === 'panel' && isMenuOpen && <div id={pickerId} className="mt-3 rounded-xl border border-gray-200 dark:border-slate-600">{stationPicker}</div>}
  </div>;

  return <>
    {controlsVisible && (controlsTarget === undefined ? controls : controlsTarget ? ReactDOM.createPortal(controls, controlsTarget) : null)}
    <Modal isOpen={controlsVisible && presentation === 'toolbar' && isMenuOpen} onClose={() => setIsMenuOpen(false)} title="Focus music" id={pickerId} variant="popover" anchorRef={buttonRef} returnFocusRef={stationButtonRef} fallbackFocusRef={fallbackFocusRef}>
      {stationPicker}
    </Modal>
  </>;
};
