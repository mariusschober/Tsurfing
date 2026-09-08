import type { Task } from '../../types';

export function plannedDateKey(task: Task): string {
  return task.schedulePrecision === 'month' ? `${(task.scheduledFor || task.dateAssigned).slice(0, 7)}-month` : task.dateAssigned;
}
export function comparePlannedTasks(a: Task, b: Task): number {
  return plannedDateKey(a).localeCompare(plannedDateKey(b)) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}
export function groupPlannedTasks(tasks: readonly Task[]): { key: string; monthOnly: boolean; tasks: Task[] }[] {
  const groups = new Map<string, Task[]>();
  for (const task of [...tasks].sort(comparePlannedTasks)) {
    const key = plannedDateKey(task);
    const group = groups.get(key) ?? [];
    group.push(task); groups.set(key, group);
  }
  return [...groups].map(([key, tasks]) => ({ key, monthOnly: key.endsWith('-month'), tasks }));
}
export function horizonTasks(tasks: readonly Task[], tomorrow: string): Task[] {
  const sorted = [...tasks].sort(comparePlannedTasks);
  return [...sorted.filter(task => task.schedulePrecision !== 'month' && task.dateAssigned === tomorrow),
    ...sorted.filter(task => task.schedulePrecision === 'month' || task.dateAssigned > tomorrow).slice(0, 3)];
}
