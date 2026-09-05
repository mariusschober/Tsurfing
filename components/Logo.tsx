
import React from 'react';

interface LogoProps {
    onReset?: () => void;
}

export const Logo: React.FC<LogoProps> = ({ onReset }) => {
    const handleClick = () => {
        if (onReset) {
            onReset();
        } else {
            window.location.reload();
        }
    };

    return (
        <div className="flex items-center space-x-2 cursor-pointer select-none group" onClick={handleClick} title="Reset View">
            <svg width="32" height="32" viewBox="0 0 100 100" className="w-8 h-8 text-indigo-600 dark:text-indigo-400 group-hover:rotate-12 transition-transform duration-300">
                <path d="M20 50 L50 80 L90 20" stroke="currentColor" strokeWidth="12" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <h1 className="text-4xl font-heading font-semibold text-gray-800 dark:text-white tracking-wide">Tsurfing</h1>
        </div>
    );
};
