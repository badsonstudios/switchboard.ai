// ONE copy of "which AIs exist" for the renderer (E40 item 09, #1292).
//
// Main owns the model (`src/main/ai-catalog/`, #1291) and pushes every change
// as `ais:changed`. This module holds the last snapshot it was told about, so
// the AIs tab and the Add-an-AI dialog read the same object, and a tab opened
// twice does not ask twice.
//
// FAIL-OPEN (litmus #3). A call that fails, or a bridge that is not there (an
// older preload, a unit test that did not stub one), leaves the last good
// snapshot standing and records a notice. The tab then shows what it last knew
// and says it could not refresh; it is never blank because an IPC call failed.
//
// `globalThis`, not `window`, for `git-status-store.ts`'s reason: a pure test
// of this module runs where a bare `window` is a ReferenceError.
import { answered } from '../../../shared/ipc/refusal';
import type { AisSnapshot, DefaultAiState } from '../../../shared/ais';
import type { SwitchboardApi } from '../../../preload';

export type AisBridge = SwitchboardApi['ais'];

export interface AisView {
  /** the last snapshot main gave; `null` until the first answer */
  snapshot: AisSnapshot | null;
  /** the last call failed: the snapshot (if any) is what was known before */
  failed: boolean;
}

let view: AisView = { snapshot: null, failed: false };
const listeners = new Set<() => void>();
let started = false;
let unsubscribe: (() => void) | null = null;
/** bumped by every push, so a slower first fetch never overwrites a newer push */
let generation = 0;

export function aisBridge(): AisBridge | undefined {
  const b = (globalThis as { switchboard?: { ais?: AisBridge } }).switchboard?.ais;
  return b && typeof b.list === 'function' ? b : undefined;
}

function set(next: AisView): void {
  view = next;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a bad subscriber costs its own update, not everyone's */
    }
  }
}

/** Record that a call failed, keeping what was known. */
export function noteAisFailure(): void {
  set({ snapshot: view.snapshot, failed: true });
}

/** Take a snapshot main handed back (a push, or Look again's answer). */
export function acceptAisSnapshot(raw: unknown): void {
  const s = answered(raw) as AisSnapshot | undefined;
  if (!s || !Array.isArray(s.items) || !s.default) {
    noteAisFailure();
    return;
  }
  generation += 1;
  set({ snapshot: s, failed: false });
}

/** Take a new default from `setDefault`'s answer, before the push arrives. */
export function acceptAisDefault(d: DefaultAiState): void {
  if (!view.snapshot) return;
  set({ snapshot: { ...view.snapshot, default: d }, failed: false });
}

/**
 * Start listening, and fetch the first snapshot. Idempotent: the first
 * reader starts it, every later one shares it.
 */
export function startAis(): void {
  if (started) return;
  const bridge = aisBridge();
  if (!bridge) {
    noteAisFailure();
    return;
  }
  started = true;
  try {
    unsubscribe = bridge.onChanged((s) => acceptAisSnapshot(s));
  } catch {
    unsubscribe = null;
  }
  void refreshAis();
}

/** Ask main for the list and the default again (no detection is run). */
export async function refreshAis(): Promise<void> {
  const bridge = aisBridge();
  if (!bridge) {
    noteAisFailure();
    return;
  }
  const asked = generation;
  try {
    const [items, def] = await Promise.all([bridge.list(), bridge.default()]);
    const list = answered(items);
    const d = answered(def);
    // A push that arrived while this was in flight is newer: keep it, and do
    // not call it a failure either.
    if (generation !== asked) return;
    if (!Array.isArray(list) || !d) {
      noteAisFailure();
      return;
    }
    set({
      // `list` + `default` do not say whether a run is in flight; the rows say
      // "checking…" on their own while their detection is missing.
      snapshot: { items: list, default: d, detecting: view.snapshot?.detecting ?? false },
      failed: false,
    });
  } catch {
    if (generation === asked) noteAisFailure();
  }
}

export function subscribeAis(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getAisView(): AisView {
  return view;
}

/** Tests only: a module outlives the test that used it. */
export function resetAisStoreForTests(): void {
  try {
    unsubscribe?.();
  } catch {
    /* nothing to undo */
  }
  unsubscribe = null;
  started = false;
  generation = 0;
  view = { snapshot: null, failed: false };
  listeners.clear();
}
