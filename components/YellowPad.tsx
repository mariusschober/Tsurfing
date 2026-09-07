
import React, { useState, useEffect, useRef } from 'react';
import Markdown from 'react-markdown';

interface YellowPadProps {
  content: string;
  onChange: (val: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
}

export const YellowPad: React.FC<YellowPadProps> = ({ content, onChange, onBlur, placeholder, className = "", readOnly = false, autoFocus = false }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && !readOnly) {
      setIsEditing(true);
    }
  }, []); // Run once on mount

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
        // move cursor to end
        textareaRef.current.selectionStart = textareaRef.current.value.length;
        textareaRef.current.selectionEnd = textareaRef.current.value.length;
        textareaRef.current.focus();
    }
  }, [isEditing]);

  const save = (): boolean => {
      try {
          onBlur?.();
          setSaveError(null);
          return true;
      } catch (error) {
          setSaveError(error instanceof Error ? error.message : 'The note was not captured. Your text is still here.');
          return false;
      }
  };

  const handleMouseLeave = () => {
      if (!isEditing) return;
      if (save()) setIsEditing(false);
  };

  const handleClick = () => {
      if (!readOnly && !isEditing) {
          setIsEditing(true);
      }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      const textarea = e.currentTarget;
      const { selectionStart, value } = textarea;
      
      // Find start of current line
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
      const currentLine = value.substring(lineStart, selectionStart);
      
      // Regex to match list markers: "- ", "* ", "1. "
      // Captures: 1=indent, 2=marker
      const match = currentLine.match(/^(\s*)([-*]|\d+\.)\s/);
      
      if (match) {
        const indent = match[1];
        const marker = match[2];
        
        // If line contains ONLY the bullet (and whitespace), delete it (exit list mode)
        if (currentLine.trim() === marker || (marker.endsWith('.') && currentLine.trim() === marker)) {
             e.preventDefault();
             const newValue = value.substring(0, lineStart) + value.substring(selectionStart);
             onChange(newValue);
             // Reset cursor to start of line (effectively deleting the line content)
             setTimeout(() => {
                 if (textareaRef.current) {
                     textareaRef.current.selectionStart = textareaRef.current.selectionEnd = lineStart;
                 }
             }, 0);
             return;
        }

        e.preventDefault();
        
        let nextMarker = marker;
        // Handle numbered lists increment
        if (/^\d+\.$/.test(marker)) {
            const num = parseInt(marker);
            if (!isNaN(num)) {
                nextMarker = `${num + 1}.`;
            }
        }
        
        const insertion = `\n${indent}${nextMarker} `;
        const newValue = value.substring(0, selectionStart) + insertion + value.substring(textarea.selectionEnd);
        
        onChange(newValue);
        
        setTimeout(() => {
            if (textareaRef.current) {
                const newCursorPos = selectionStart + insertion.length;
                textareaRef.current.selectionStart = textareaRef.current.selectionEnd = newCursorPos;
            }
        }, 0);
      }
    }
  };

  // Pre-process content to auto-link URLs and handle highlighting
  const processContent = (text: string) => {
      if (!text) return "";
      
      // 1. Auto-link URLs that aren't already in markdown format
      let processed = text.replace(
          /(?<!\]\(|["'])(https?:\/\/[^\s]+|www\.[^\s]+)/g, 
          (url) => {
              const href = url.startsWith('www') ? `https://${url}` : url;
              return `[${url}](${href})`;
          }
      );

      return processed;
  };

  return (
    <div 
        className={`bg-[#fdfbf7] dark:bg-[#1e293b] relative flex flex-col group ${className}`}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
    >
      
      {/* Left Binding Strip */}
      <div className="absolute left-0 top-0 bottom-0 w-12 bg-gray-100 dark:bg-slate-800/50 border-r border-gray-200 dark:border-slate-700/50 z-20 flex flex-col pt-12 items-center gap-12 pointer-events-none">
        {[1, 2, 3, 4, 5, 6].map(i => (
          <div key={i} className="w-3 h-3 rounded-full bg-gray-300 dark:bg-slate-600 shadow-inner"></div>
        ))}
      </div>

      {/* Header */}
      <div className="h-16 flex items-center justify-between pl-16 pr-6 shrink-0 border-b border-gray-100 dark:border-slate-700/50">
        <span className="font-handwriting text-gray-400 dark:text-slate-500 text-2xl font-bold select-none opacity-50">Notes</span>
        <div className="flex gap-2">
            {!readOnly && (
                <span className={`text-[10px] uppercase font-bold tracking-wider transition-opacity duration-300 ${isEditing ? 'text-indigo-400 opacity-100' : 'text-gray-300 opacity-0'}`}>
                    Editing...
                </span>
            )}
        </div>
      </div>

      {/* Paper Body */}
      <div className="flex-grow relative overflow-hidden bg-[#fffefc] dark:bg-[#1a2438]">
        {/* Lines Pattern */}
        <div className="absolute inset-0 pointer-events-none z-0"
          style={{
            backgroundImage: 'linear-gradient(transparent 31px, rgba(0,0,0,0.05) 32px)',
            backgroundSize: '100% 32px',
            marginTop: '0px',
          }}>
        </div>

        {/* Margin Line */}
        <div className="absolute top-0 bottom-0 left-16 w-px bg-red-400/20 dark:bg-red-500/10 z-0 pointer-events-none"></div>

        {/* Content Area */}
        <div className="absolute inset-0 overflow-y-auto custom-scrollbar z-10 pl-20 pr-6 py-1">
          {isEditing && !readOnly ? (
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => onChange(e.target.value)}
              onBlur={() => { save(); }}
              onKeyDown={handleKeyDown}
              className="w-full min-h-full bg-transparent text-gray-900 dark:text-gray-100 text-lg leading-[32px] focus:outline-none resize-none font-handwriting placeholder-gray-300 dark:placeholder-slate-600 py-0 -ml-1 pb-32"
              placeholder={placeholder || "Type here... (Markdown supported, use _text_ to highlight)"}
              spellCheck={false}
            />
          ) : (
            <div 
                className={`w-full min-h-full text-gray-900 dark:text-gray-100 text-lg leading-[32px] font-handwriting py-0 pb-32 max-w-none ${readOnly ? 'cursor-default' : 'cursor-text'}`}
            >
                {content ? (
                   <Markdown
                      components={{
                        // Headers
                        h1: ({node, ...props}) => <h1 className="text-2xl font-bold border-b border-gray-200 dark:border-slate-700/50 mb-1 mt-2 text-indigo-900 dark:text-indigo-200" {...props} />,
                        h2: ({node, ...props}) => <h2 className="text-xl font-bold mb-1 mt-2 text-indigo-800 dark:text-indigo-300" {...props} />,
                        h3: ({node, ...props}) => <h3 className="text-lg font-bold mb-1 mt-1 text-gray-800 dark:text-gray-200" {...props} />,
                        
                        // Links (Clickable everywhere)
                        a: ({node, ...props}) => <a className="text-blue-600 dark:text-blue-400 underline decoration-blue-300 dark:decoration-blue-700 hover:text-blue-800 dark:hover:text-blue-300 hover:decoration-2 transition-all relative z-50 cursor-pointer" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} {...props} />,
                        
                        // Lists
                        ul: ({node, ...props}) => <ul className="list-disc pl-5 space-y-0 marker:text-gray-400" {...props} />,
                        ol: ({node, ...props}) => <ol className="list-decimal pl-5 space-y-0 marker:text-gray-400" {...props} />,
                        li: ({node, ...props}) => <li className="pl-1" {...props} />,
                        
                        // Highlighting (Using underscore `_text_` which maps to em)
                        em: ({node, ...props}) => <span className="bg-yellow-200 dark:bg-yellow-600/60 text-gray-900 dark:text-white px-1 rounded-sm box-decoration-clone not-italic" {...props} />,
                        
                        // Code (Backticks) - Standard monospace
                        code: ({node, ...props}) => <code className="font-mono text-sm bg-gray-100 dark:bg-slate-700 px-1 rounded text-pink-600 dark:text-pink-400" {...props} />,
                        
                        // Bold
                        strong: ({node, ...props}) => <strong className="font-bold text-gray-950 dark:text-white" {...props} />,
                        
                        // Blockquote
                        blockquote: ({node, ...props}) => <blockquote className="border-l-4 border-gray-300 pl-4 py-1 my-2 italic text-gray-500 bg-gray-50/50 dark:bg-slate-800/50 rounded-r" {...props} />,
                        
                        // Paragraphs (Maintain line height for ruled paper effect)
                        p: ({node, ...props}) => <p className="mb-0" {...props} />,
                      }}
                   >
                     {processContent(content)}
                   </Markdown>
                ) : (
                    <span className="text-gray-300 dark:text-slate-600 italic select-none">{placeholder || "Click to add notes..."}</span>
                )}
            </div>
          )}
        </div>
      </div>
      {saveError && <p role="alert" className="px-6 py-2 text-sm text-red-700 dark:text-red-300">{saveError}</p>}
      
      {/* Helper Footer */}
      <div className="absolute bottom-2 right-6 text-[9px] text-gray-300 dark:text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none select-none">
          **bold** _highlight_ [link](url) - list
      </div>
    </div>
  );
};
