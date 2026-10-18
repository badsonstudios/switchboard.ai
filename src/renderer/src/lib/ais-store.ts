// ONE copy of "which AIs exist" for the renderer (E40 items 09 and 10, #1292
// and #1293).
//
// Main owns the model (`src/main/ai-catalog/`, #1291) and pushes every change
// as `ais:changed`. This module holds the last snapshot it was told about, so
// the AIs tab, the Add-an-AI dialog, and every tab, rail card, header and the
// status bar read the same object, and nothing asks main twice.
//
// TWO VIEWS OF THE ONE SNAPSHOT (merged on the 2026-10-16 train: both PRs had
// written this module independently):
//   - `getAisView()` — the whole snapshot plus `failed` (#1292's Settings tab);
//   - `getAisState()` — `{items, defaultId}`, derived from it (#1293's badge,
//     icon and status bar). A stable object until the snapshot changes.
//
// Started by `startAis()` (the AIs tab) or lazily by the first `subscribeAis`
// (any reader), and never stopped: the list is a property of the app run, not
// of any one component.
//
// FAIL-OPEN (litmus #3). A call that fails, or a bridge that is not there (an
// older preload, a unit test that did not stub one), leaves the last good
// snapshot standing and records a notice. The tab then shows what it last knew
// and says it could not refresh; a badge with no list draws the neutral glyph
// and keeps the ring and the words. Nothing is blank because an IPC call failed.
//
// `globalThis`, not `window`, for `git-status-store.ts`'s reason: a pure test
// of this module runs where a bare `window` is a ReferenceError.
import { answered } from '../../../shared/ipc/refusal';
import { AI_ICON_BASE, type AiListItem, type AisSnapshot, type DefaultAiState } from '../../../shared/ais';
import type { SwitchboardApi } from '../../../preload';
import { aiInk, NEUTRAL_AI_INK } from './ai-ink';

export type AisBridge = SwitchboardApi['ais'];

export interface AisView {
  /** the last snapshot main gave; `null` until the first answer */
  snapshot: AisSnapshot | null;
  /** the last call failed: the snapshot (if any) is what was known before */
  failed: boolean;
}

/** What the renderer knows, or `items: null` before (or instead of) an answer. */
export interface AisState {
  readonly items: readonly AiListItem[] | null;
  /** the provider id new sessions start on, which the health poller watches */
  readonly defaultId: string | null;
}

/** How one AI is drawn. */
export interface AiLook {
  /** the AI's display name, or the provider id when the list has no entry */
  name: string;
  /** the icon's URL under the renderer's own origin; absent = draw `initial` */
  iconUrl?: string;
  /** the neutral glyph's letter */
  initial: string;
  /**
   * the CSS colour the icon is painted in (#1326): the AI's own per-theme ink,
   * or `--text` for an AI with none. Absent = `--text`.
   */
  ink?: string;
}

const EMPTY_STATE: AisState = Object.freeze({ items: null, defaultId: null });

let view: AisView = { snapshot: null, failed: false };
const listeners = new Set<() => void>();
let started = false;
let unsubscribe: (() => void) | null = null;
/** bumped by every push, so a slower first fetch never overwrites a newer push */
let generation = 0;
/** `getAisState`'s memo: the snapshot it was derived from, and the answer */
let derived: { from: AisSnapshot | null; state: AisState } = { from: null, state: EMPTY_STATE };

export function aisBridge(): AisBridge | undefined {
  try {
    const b = (globalThis as { switchboard?: { ais?: AisBridge } }).switchboard?.ais;
    return b && typeof b.list === 'function' ? b : undefined;
  } catch {
    return undefined;
  }
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

/**
 * `useSyncExternalStore`'s subscribe. The first subscriber with a bridge
 * starts the cache (#1293's lazy start); with no bridge there is nothing to
 * start, and a mere subscription records no failure.
 */
export function subscribeAis(fn: () => void): () => void {
  listeners.add(fn);
  if (!started && aisBridge()) startAis();
  return () => {
    listeners.delete(fn);
  };
}

export function getAisView(): AisView {
  return view;
}

/** `{items, defaultId}` off the current snapshot; a stable object until it changes. */
export function getAisState(): AisState {
  if (derived.from !== view.snapshot) {
    const s = view.snapshot;
    derived = {
      from: s,
      state: s ? Object.freeze({ items: s.items, defaultId: s.default?.id ?? null }) : EMPTY_STATE,
    };
  }
  return derived.state;
}

/** The list item that hosts this provider id, if the list has one. */
export function aiItemFor(items: readonly AiListItem[] | null, providerId: string | undefined): AiListItem | undefined {
  if (!items || !providerId) return undefined;
  const hosting = items.find((i) => i.providerId === providerId);
  if (hosting && hosting.kind !== 'provider') return hosting;
  // A catalog AI with no provider named for it still has its own id — and it
  // is the better answer than a provider-only row of the same id: that row
  // means "the catalog has no entry for this provider", which is not true when
  // one carries the id (#1326; a provider registered under a registry id, as
  // the manual's AI-colours picture does for Gemini).
  return items.find((i) => i.kind === 'catalog' && i.entry.id === providerId) ?? hosting;
}

/**
 * An icon's URL, made ABSOLUTE against the main window's page. A popout is a
 * second document driven by this same script (memory: "a popout is a second
 * document"), and a relative `src` there resolves against the popout's own
 * URL, which is not where `ai-icons/` is served.
 */
function iconUrl(file: string): string {
  const rel = AI_ICON_BASE + file;
  try {
    const here = (globalThis as { location?: { href?: string } }).location?.href;
    return here ? new URL(rel, here).href : rel;
  } catch {
    return rel;
  }
}

/** How to draw the AI this provider id names. `fallbackName` when nothing is known. */
export function aiLook(state: AisState, providerId: string | undefined, fallbackName: string): AiLook {
  const item = aiItemFor(state.items, providerId);
  const name = item?.entry.name || providerId || fallbackName;
  const icon = item?.kind === 'catalog' ? item.entry.icon : undefined;
  return {
    name,
    iconUrl: icon ? iconUrl(icon) : undefined,
    initial: (name.trim()[0] ?? '?').toUpperCase(),
    ink: item?.kind === 'catalog' ? aiInk(item.entry.id) : NEUTRAL_AI_INK,
  };
}

/**
 * Tests only: a module outlives the test that used it. With `seed`, the
 * derived `getAisState()` answers it (and the cache counts as started, so a
 * subscriber fetches nothing) until a real snapshot replaces it.
 */
export function resetAisStoreForTests(seed?: AisState): void {
  try {
    unsubscribe?.();
  } catch {
    /* nothing to undo */
  }
  unsubscribe = null;
  started = seed !== undefined;
  generation = 0;
  view = { snapshot: null, failed: false };
  derived = { from: null, state: seed ?? EMPTY_STATE };
  listeners.clear();
}
