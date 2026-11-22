// The busy-folder prompt (E42 step 2, #1506; decision 6 on #1636; mockup
// screen F): starting a plain session in a folder whose CHECKOUT another live
// session is already using asks "new worktree, or share this folder?".
//
// Never a silent worktree: "Always new worktree" still opens the new-worktree
// dialog, it only skips the question. Asked only when it can matter: the same
// checkout (git's toplevel, so a session at the repo root and one in a
// subfolder are the same checkout; two worktrees of one repo are not) and a
// session there that is still running. Not asked for the explicit "here"
// gestures (a worktree's ⊕, a group's ⊕, Duplicate): choosing a folder that
// already has a session in it IS choosing to share it.
//
// The setting is how the window behaves, so it lives in the renderer's ui blob
// (like the group style), Settings ▸ General ▸ Projects.
import * as React from 'react';
import { pathKey } from '../../../shared/projects';
import type { RailSession } from '../model/types';
import { uiGet, uiSet } from './ui-state';

export type BusyFolderChoice = 'ask' | 'share' | 'worktree';

export const BUSY_FOLDER_KEY = 'busyFolder';

export function busyFolderOf(raw: unknown): BusyFolderChoice {
  return raw === 'share' || raw === 'worktree' ? raw : 'ask';
}

/** A card whose process is still there: it can still change files under another. */
const LIVE = new Set(['starting', 'working', 'needs-input', 'needs-permission', 'idle', 'done']);

/** The live sessions already in the checkout at `toplevel` (git's answer, so 8.3 names match). */
export function liveInCheckout(sessions: readonly RailSession[], toplevel: string): RailSession[] {
  const key = pathKey(toplevel);
  return sessions.filter((s) => !!s.status && LIVE.has(s.status) && !!s.autoKey && pathKey(s.autoKey) === key);
}

/**
 * Which answer the prompt leans to (screen F): a worktree when another session
 * is working right now or there are uncommitted changes, else sharing, which
 * is fine for questions and reading.
 */
export function recommendWorktree(others: readonly RailSession[], dirty: number | null): boolean {
  return others.some((s) => s.status === 'working' || s.status === 'needs-permission') || (dirty ?? 0) > 0;
}

let current: BusyFolderChoice = 'ask';
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of listeners) l();
};

export function initBusyFolder(): void {
  current = busyFolderOf(uiGet<unknown>(BUSY_FOLDER_KEY, undefined));
  emit();
}

export function getBusyFolder(): BusyFolderChoice {
  return current;
}

export function setBusyFolder(choice: BusyFolderChoice): void {
  current = busyFolderOf(choice);
  uiSet(BUSY_FOLDER_KEY, current);
  emit();
}

export function useBusyFolder(): BusyFolderChoice {
  return React.useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => 'ask'
  );
}
