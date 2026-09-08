import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../types';
import { Modal } from './Modal';
import { PlusIcon } from './Icons';
import { getTodayYYYYMMDD } from '../utils/dateUtils';
import { groupPlannedTasks } from '../src/domain/plannedTasks';

const monthLabel = (month: string) => new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shiftMonth = (month: string, delta: number) => {
  const date = new Date(`${month}-01T12:00:00`);
  date.setMonth(date.getMonth() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

export function PlannedTaskBrowser({ isOpen, onClose, tasks, onAddTask, renderTask }: {
  isOpen: boolean; onClose: () => void; tasks: Task[]; onAddTask: (date: string) => void;
  renderTask: (task: Task) => React.ReactNode;
}) {
  const today = getTodayYYYYMMDD();
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selectedDay, setSelectedDay] = useState(today);
  const [visibleCount, setVisibleCount] = useState(100);
  const listRef = useRef<HTMLDivElement>(null), calendarRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLButtonElement>(null);
  const scrollPositions = useRef({ list: 0, calendar: 0 });
  const wasOpen = useRef(false);
  const groups = useMemo(() => groupPlannedTasks(tasks), [tasks]);
  const allSorted = useMemo(() => groups.flatMap(group => group.tasks), [groups]);
  const visibleGroups = useMemo(() => groupPlannedTasks(allSorted.slice(0, visibleCount)), [allSorted, visibleCount]);
  const dayTasks = useMemo(() => new Map(groups.filter(group => !group.monthOnly).map(group => [group.key, group.tasks])), [groups]);
  const monthTasks = groups.find(group => group.key === `${month}-month`)?.tasks ?? [];
  const first = new Date(`${month}-01T12:00:00`);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setView('list'); setMonth(today.slice(0, 7)); setSelectedDay(today); setVisibleCount(100);
      scrollPositions.current = { list: 0, calendar: 0 };
    }
    wasOpen.current = isOpen;
  }, [isOpen, today]);
  useLayoutEffect(() => {
    const node = view === 'list' ? listRef.current : calendarRef.current;
    if (node) node.scrollTop = scrollPositions.current[view];
  }, [view, isOpen]);
  useEffect(() => {
    if (!isOpen || view !== 'list' || !sentinelRef.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisibleCount(count => Math.min(tasks.length, count + 100));
    }, { root: listRef.current, rootMargin: '300px' });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [isOpen, view, visibleCount, tasks.length]);
  const selectView = (next: 'list' | 'calendar') => {
    const node = view === 'list' ? listRef.current : calendarRef.current;
    if (node) scrollPositions.current[view] = node.scrollTop;
    setView(next);
  };
  const navigateMonth = (next: string) => {
    setMonth(next); setSelectedDay(next === today.slice(0, 7) ? today : `${next}-01`);
  };
  const renderGroup = (key: string, label: string, items: Task[]) => <section key={key} className="planned-task-group" aria-label={label}>
    <h4 className="font-bold text-sm text-gray-600 dark:text-gray-300">{label}</h4>
    <div className="grid gap-3">{items.map(task => <React.Fragment key={task.id}>{renderTask(task)}</React.Fragment>)}</div>
  </section>;

  return <Modal isOpen={isOpen} onClose={onClose} title="Planned tasks" variant="planned" headerControls={
    <div role="group" aria-label="Planned task view" className="plan-density border border-gray-200 dark:border-slate-600">
      {(['list', 'calendar'] as const).map(option => <button key={option} type="button" aria-pressed={view === option}
        className={view === option ? 'bg-gray-100 text-gray-900 dark:bg-slate-700 dark:text-white' : 'text-gray-500 dark:text-gray-400'}
        onClick={() => selectView(option)}>{option === 'list' ? 'List' : 'Calendar'}</button>)}
    </div>}>
    <div ref={listRef} hidden={view !== 'list'} className="planned-browser-scroll" onScroll={event => { scrollPositions.current.list = event.currentTarget.scrollTop; }}>
      <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">{tasks.length} planned {tasks.length === 1 ? 'task' : 'tasks'}</p>
      {visibleGroups.map(group => renderGroup(group.key, group.monthOnly ? `${monthLabel(group.key.slice(0, 7))} · No day assigned` : dayLabel(group.key), group.tasks))}
      {tasks.length === 0 && <p className="text-gray-500 dark:text-gray-400">No future tasks planned.</p>}
      {visibleCount < tasks.length && <button type="button" ref={sentinelRef} onClick={() => setVisibleCount(count => count + 100)}
        className="min-h-11 w-full rounded-xl text-indigo-600 dark:text-indigo-300">Show more tasks</button>}
    </div>
    <div ref={calendarRef} hidden={view !== 'calendar'} className="planned-browser-scroll" onScroll={event => { scrollPositions.current.calendar = event.currentTarget.scrollTop; }}>
      <div className="planned-calendar-heading">
        <h4 className="font-bold text-lg" aria-live="polite">{monthLabel(month)}</h4>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous month" onClick={() => navigateMonth(shiftMonth(month, -1))} className="planned-calendar-nav">Previous</button>
          <button type="button" onClick={() => navigateMonth(today.slice(0, 7))} className="planned-calendar-nav">This month</button>
          <button type="button" aria-label="Next month" onClick={() => navigateMonth(shiftMonth(month, 1))} className="planned-calendar-nav">Next</button>
        </div>
      </div>
      <div className="planned-calendar-weekdays" aria-hidden="true">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <span key={day}>{day}</span>)}</div>
      <div className="planned-calendar-grid" aria-label={monthLabel(month)}>
        {Array.from({ length: offset }, (_, index) => <div key={`empty-${index}`} aria-hidden="true" className="planned-calendar-empty" />)}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const day = `${month}-${String(index + 1).padStart(2, '0')}`, items = dayTasks.get(day) ?? [];
          return <div key={day} className={`planned-calendar-day ${selectedDay === day ? 'is-selected' : ''} ${day === today ? 'is-today' : ''}`}>
            <button type="button" data-calendar-date={day} aria-pressed={selectedDay === day} aria-current={day === today ? 'date' : undefined}
              aria-label={`${dayLabel(day)}, ${items.length} ${items.length === 1 ? 'task' : 'tasks'}`} onClick={() => setSelectedDay(day)}
              onKeyDown={event => {
                const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
                if (delta === undefined) return;
                const next = index + 1 + delta;
                if (next < 1 || next > daysInMonth) return;
                event.preventDefault();
                const nextDay = `${month}-${String(next).padStart(2, '0')}`;
                calendarRef.current?.querySelector<HTMLButtonElement>(`[data-calendar-date="${nextDay}"]`)?.focus();
                setSelectedDay(nextDay);
              }} className="planned-calendar-select">
              <span className="font-semibold">{index + 1}</span>
              <span className="planned-calendar-titles">{items.slice(0, 3).map(task => <span key={task.id} className="truncate">{task.title}</span>)}
                {items.length > 3 && <span className="font-semibold">+{items.length - 3} more</span>}</span>
              {items.length > 0 && <span className="planned-calendar-count">{items.length}</span>}
            </button>
            {day >= today && <button type="button" aria-label={`Add task on ${dayLabel(day)}`} onClick={event => { event.currentTarget.focus(); onAddTask(day); }} className="planned-calendar-add">
              <PlusIcon className="w-4 h-4" /><span className="sr-only">Add</span>
            </button>}
          </div>;
        })}
      </div>
      <div className="mt-6" aria-live="polite">
        {renderGroup(selectedDay, dayLabel(selectedDay), dayTasks.get(selectedDay) ?? [])}
        {!dayTasks.get(selectedDay)?.length && <p className="text-sm text-gray-500 dark:text-gray-400">No tasks planned for this day.</p>}
        {selectedDay >= today && <button type="button" onClick={event => { event.currentTarget.focus(); onAddTask(selectedDay); }} className="min-h-11 mt-3 text-sm font-semibold text-indigo-600 dark:text-indigo-300">Add task on this day</button>}
      </div>
      {monthTasks.length > 0 && renderGroup(`${month}-month`, `${monthLabel(month)} · No day assigned`, monthTasks)}
    </div>
  </Modal>;
}
