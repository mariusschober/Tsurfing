import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PlanningView } from '../components/PlanningView';
import type { Task } from '../types';

const renderPlanner = (tasks: Task[]) => renderToStaticMarkup(<PlanningView
    todayTasks={[]} upcomingTasks={[]} allTasks={tasks} goals={[]}
    setFrog={vi.fn()} openEditModal={vi.fn()} deleteTask={vi.fn()}
    reorderTodayTasks={vi.fn()} hashtagConfigs={{}} updateTaskPriorities={vi.fn()}
    moveTaskToTopToday={vi.fn()} onSelectHashtag={vi.fn()} overdueTasks={tasks}
    markWontDo={vi.fn()} onAddTask={vi.fn()} updateTask={vi.fn()}
    onRescheduleTask={vi.fn(() => true)} circadianState={{ lastCheckIn: '' } as any}
    addSubtasks={vi.fn()} completeTask={vi.fn()} userKey="plan-test" planningMode="manual" onPlanningModeChange={vi.fn()} onSubmitBioCheckIn={vi.fn()}
/>);

const task = (extra: Partial<Task> = {}) => ({
    id: 'overdue-task', title: 'Retained overdue work', dateAssigned: '2026-09-05',
    createdAt: 1, completed: false, duration: 25, ...extra,
} as Task);

describe('planning overdue decisions', () => {
    it('renders blocking work even when today and upcoming are empty', () => {
        const html = renderPlanner([task()]);
        expect(html).toContain('Retained overdue work');
        for (const action of ['Do today', 'Reschedule', 'Mark complete', 'Won’t do']) expect(html).toContain(action);
        expect(html).toContain('Needs your decision (1)');
    });
    it('shows month-only work with an explicit day-selection prompt', () => {
        expect(renderPlanner([task({schedulePrecision: 'month', scheduledFor: '2026-09'})])).toContain('Choose a day · 2026-09');
    });
    it('keeps overdue frogs actionable without offering prohibited postponement', () => {
        const html = renderPlanner([task({isFrog: true})]);
        expect(html).toContain('Do today');
        expect(html).toContain('Mark complete');
        expect(html).not.toContain('>Reschedule</button>');
    });
    it('does not show a decision section when no tasks block planning', () => {
        expect(renderPlanner([])).not.toContain('Needs your decision');
    });
});
