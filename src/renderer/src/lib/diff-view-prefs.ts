// The diff panel's three view toggles (#1384): ignore whitespace, collapse
// unchanged regions, word wrap.
//
// ── THE SAME HOME AS THE LAYOUT TOGGLE, ON PURPOSE ──────────────────────────
//
// The issue's rule is "each toggle remembers its last setting, the same way the
// layout toggle does", so this is `lib/diff-layout`'s shape three times over: a
// key in the workspace `ui` blob (NOT localStorage — the packaged renderer's
// origin changes port every launch), read through `uiGet` on every call, a
// module-level subscriber set, and `useSyncExternalStore` in the components.
// Workspace-wide rather than per panel for the reason #532 gave: "how I read a
// diff" is a habit, not a property of one comparison.
//
// Each getter returns a BOOLEAN, so the snapshot `useSyncExternalStore`
// compares is a primitive and there is nothing to cache or keep in step.
//
// ── WHERE THEY APPLY ────────────────────────────────────────────────────────
//
// Only in the diff panel, which is the one surface that DRAWS the toggles. The
// Changes tab's in-place preview and the all-changes stack keep Monaco's
// defaults (whitespace ignored, nothing collapsed, no wrap — exactly what they
// showed before this item). A setting that silently changed a surface with no
// control to show it is #532's defect in another coat: a rule the reader
// cannot see.
import { uiGet, uiSet } from './ui-state';

export type DiffViewToggle = 'ignoreWhitespace' | 'collapseUnchanged' | 'wordWrap';

export const DIFF_VIEW_TOGGLES: readonly DiffViewToggle[] = [
  'ignoreWhitespace',
  'collapseUnchanged',
  'wordWrap',
];

/** ui-blob key per toggle. Named, because a key is a contract on disk. */
export const DIFF_VIEW_KEYS: Readonly<Record<DiffViewToggle, string>> = {
  ignoreWhitespace: 'diffIgnoreWhitespace',
  collapseUnchanged: 'diffCollapseUnchanged',
  wordWrap: 'diffWordWrap',
};

/**
 * What a workspace that has never been told gets.
 *
 * `ignoreWhitespace` is ON because it is Monaco's own default
 * (`ignoreTrimWhitespace: true`) and therefore what every diff in this app has
 * shown since P1-E5-02 — defaulting it off would have changed every diff the
 * day this shipped, and put a reformat's noise back in front of the reader.
 */
export const DIFF_VIEW_DEFAULTS: Readonly<Record<DiffViewToggle, boolean>> = {
  ignoreWhitespace: true,
  collapseUnchanged: false,
  wordWrap: false,
};

/** Anything that is not a real boolean is the default: a blob outlives the code. */
export function parseDiffViewToggle(which: DiffViewToggle, raw: unknown): boolean {
  return typeof raw === 'boolean' ? raw : DIFF_VIEW_DEFAULTS[which];
}

export function getDiffViewToggle(which: DiffViewToggle): boolean {
  return parseDiffViewToggle(which, uiGet<unknown>(DIFF_VIEW_KEYS[which], undefined));
}

const listeners = new Set<() => void>();

/** Set and persist. A no-op write announces nothing. */
export function setDiffViewToggle(which: DiffViewToggle, next: boolean): boolean {
  if (getDiffViewToggle(which) === next) return next;
  uiSet(DIFF_VIEW_KEYS[which], next);
  // copy first: a listener that unsubscribes during the walk would mutate the set
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* fail-open: a bad subscriber costs its own update, not everyone's */
    }
  }
  return next;
}

export function toggleDiffViewToggle(which: DiffViewToggle): boolean {
  return setDiffViewToggle(which, !getDiffViewToggle(which));
}

/** Fires whenever ANY of the three changes (for `useSyncExternalStore`). */
export function subscribeDiffViewPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The three, as the editor wants them. */
export interface DiffViewOptions {
  ignoreWhitespace: boolean;
  collapseUnchanged: boolean;
  wordWrap: boolean;
}

/**
 * The Monaco diff-editor options for a set of toggles.
 *
 * Pure and here rather than in `MonacoDiff` so the mapping is tested without
 * Monaco: `diffWordWrap` (not `wordWrap`) is the diff editor's own switch and
 * covers both sides, and `hideUnchangedRegions` is an object whose other fields
 * keep Monaco's defaults.
 */
export function monacoDiffViewOptions(v: DiffViewOptions): {
  ignoreTrimWhitespace: boolean;
  hideUnchangedRegions: { enabled: boolean };
  diffWordWrap: 'on' | 'off';
} {
  return {
    ignoreTrimWhitespace: v.ignoreWhitespace,
    hideUnchangedRegions: { enabled: v.collapseUnchanged },
    diffWordWrap: v.wordWrap ? 'on' : 'off',
  };
}
