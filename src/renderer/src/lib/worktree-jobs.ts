// The window's copy of the worktree builds main is running (E42 step 2, #1506).
// Read once at start, then kept current by `projects:jobChanged`. The project
// card draws them; App starts the session when one is ready.
import * as React from 'react';
import type { WorktreeJob } from '../../../shared/projects';

let jobs: readonly WorktreeJob[] = [];
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of listeners) l();
};

/** Apply one change from main: a `done` job leaves the list. */
export function applyJob(job: WorktreeJob): void {
  const rest = jobs.filter((j) => j.id !== job.id);
  jobs = job.phase === 'done' ? rest : [...rest, job];
  emit();
}

export function setJobs(list: readonly WorktreeJob[]): void {
  jobs = list.filter((j) => j.phase !== 'done');
  emit();
}

export function getJobs(): readonly WorktreeJob[] {
  return jobs;
}

export function useWorktreeJobs(): readonly WorktreeJob[] {
  return React.useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => jobs,
    () => jobs
  );
}

/** Tests only. */
export function resetJobsForTests(): void {
  jobs = [];
  emit();
}
