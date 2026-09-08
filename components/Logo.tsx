
import React from 'react';

interface LogoProps {
    onReset?: () => void;
    compact?: boolean;
}

export const Logo: React.FC<LogoProps> = ({ onReset, compact = false }) => {
    const handleClick = () => {
        if (onReset) {
            onReset();
        } else {
            window.location.reload();
        }
    };

    if (!compact) return (
        <div className="flex items-center space-x-2 cursor-pointer select-none group" onClick={handleClick} title="Reset View">
            <svg width="32" height="32" viewBox="0 0 100 100" className="w-8 h-8 text-indigo-600 dark:text-indigo-400 group-hover:rotate-12 transition-transform duration-300">
                <path d="M20 50 L50 80 L90 20" stroke="currentColor" strokeWidth="12" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <h1 className="text-4xl font-heading font-semibold text-gray-800 dark:text-white tracking-wide">Tsurfing</h1>
        </div>
    );

    return (
        <button type="button" className={`flex items-center space-x-2 cursor-pointer select-none group ${compact ? 'app-header__brand' : ''}`} onClick={handleClick} title="Reset View" aria-label={onReset ? 'Tsurfing — go to Current' : 'Tsurfing'}>
            <svg aria-hidden="true" width="32" height="32" viewBox="0 0 100 100" className="w-8 h-8 shrink-0 text-indigo-600 dark:text-indigo-400 group-hover:rotate-12 transition-transform duration-300">
                <path d="M20 50 L50 80 L90 20" stroke="currentColor" strokeWidth="12" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className={`font-heading font-semibold text-gray-800 dark:text-white tracking-wide ${compact ? 'app-header__wordmark' : 'text-4xl'}`}>Tsurfing</span>
        </button>
    );
};
