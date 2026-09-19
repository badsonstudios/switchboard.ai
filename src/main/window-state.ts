// Pure window-geometry helpers. Persistence lives in the workspace store
// (P1-E2-04, workspace/store.ts) — these stay side-effect-free and testable.
import { Rectangle } from 'electron';

export interface WindowState {
  /** null = no usable saved bounds — let Electron center the window */
  bounds: Rectangle | null;
  isMaximized: boolean;
}

const DEFAULT_SIZE = { width: 1280, height: 800 };

/** Tolerant merge of possibly-corrupt persisted window state. */
export function mergeState(raw: unknown): WindowState {
  if (typeof raw !== 'object' || raw === null) return { bounds: null, isMaximized: false };
  const r = raw as { bounds?: Partial<Rectangle>; isMaximized?: unknown };
  const b = r.bounds;
  const boundsOk =
    !!b &&
    [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n)) &&
    (b.width as number) >= 400 &&
    (b.height as number) >= 300;
  return {
    // pick fields explicitly (corrupt files must not smuggle extra keys back
    // to disk) and round — Electron bounds want integers
    bounds: boundsOk
      ? {
          x: Math.round(b.x as number),
          y: Math.round(b.y as number),
          width: Math.round(b.width as number),
          height: Math.round(b.height as number),
        }
      : null,
    isMaximized: r.isMaximized === true,
  };
}

/** Is at least a usable corner of the window visible on some display? */
export function isOnAnyDisplay(bounds: Rectangle, workAreas: Rectangle[]): boolean {
  return workAreas.some(
    (a) =>
      bounds.x < a.x + a.width - 100 &&
      bounds.x + bounds.width > a.x + 100 &&
      bounds.y < a.y + a.height - 100 &&
      bounds.y + bounds.height > a.y + 40
  );
}

// ---------------------------------------------------------------------------
// Per-arrangement memory (#864)
//
// `isOnAnyDisplay` above answers the BOOT question: is the one saved rectangle
// usable on the displays we have now? That was the whole story while the only
// moment we cared about was launch. It is not enough for monitor sleep.
//
// A DisplayPort monitor powering down is usually a real detach, not a blank
// screen: the display leaves the list, Windows shuffles our window onto the
// primary, and — because `trackWindowGeometry` faithfully saves wherever the
// window is — that shoved position overwrites the only note we had. By the time
// the monitor comes back there is nothing left that remembers where the window
// belonged. Keeping bounds PER ARRANGEMENT is what makes the return possible:
// the two-monitor note survives the single-monitor interlude untouched.

/** Where the window sat, on one particular display arrangement. */
export interface ArrangementMemory {
  bounds: Rectangle;
  isMaximized: boolean;
}

/** display fingerprint -> the last bounds the window held on that arrangement */
export type ArrangementMemories = Record<string, ArrangementMemory>;

/**
 * How many arrangements we keep.
 *
 * Higher than the four real setups that motivate this (desk with externals,
 * laptop alone, one external, a projector) because a fingerprint is built from
 * WORK areas, and a work area moves when the taskbar is resized, repositioned
 * or auto-hidden, and on a DPI change. Each of those mints a distinct key, so a
 * cap sized to the number of physical setups would let a few taskbar toggles
 * push the genuine desk note out before the monitor ever came back.
 *
 * Fingerprinting on display bounds instead would be the cleaner fix, but
 * `displayFingerprint` is the shared identity the boot-time restore and its
 * existing tests are written against — changing what it means is its own
 * change, not a rider on this one.
 */
export const MAX_REMEMBERED_ARRANGEMENTS = 8;

/**
 * Record where the window is on the current arrangement, evicting the
 * least-recently-used note when full.
 *
 * LRU, not FIFO, and the difference is the whole point of the cap: the desk you
 * sit at every day is written to constantly, so an eviction order that ignored
 * re-use would drop exactly the note you most want kept. Re-recording therefore
 * DELETES the key before re-inserting it, which moves it to the end of the
 * insertion order — this used to spread over the top of it instead, which left
 * the key in its original position and made a daily-used arrangement the first
 * one evicted.
 *
 * Insertion order is the eviction order, which works because a fingerprint
 * always contains commas — JS object key ordering only promotes keys that look
 * like array indices, and none of these ever do.
 */
export function rememberArrangement(
  memories: ArrangementMemories,
  fingerprint: string,
  entry: ArrangementMemory
): ArrangementMemories {
  const next: ArrangementMemories = { ...memories };
  // re-insert at the end rather than in place: see the LRU note above
  delete next[fingerprint];
  // Deep, and its own test caught that it wasn't: a shallow `{ ...entry }`
  // leaves `bounds` pointing at the CALLER's rectangle, so anyone reusing one
  // object across saves would be editing a note they had already handed over.
  next[fingerprint] = { bounds: { ...entry.bounds }, isMaximized: entry.isMaximized };
  const keys = Object.keys(next);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_ARRANGEMENTS))) {
    delete next[stale];
  }
  return next;
}

/** Same rectangle, allowing for the pixel Windows sometimes rounds differently. */
function sameRect(a: Rectangle, b: Rectangle): boolean {
  return (
    Math.abs(a.x - b.x) <= 2 &&
    Math.abs(a.y - b.y) <= 2 &&
    Math.abs(a.width - b.width) <= 2 &&
    Math.abs(a.height - b.height) <= 2
  );
}

/**
 * Should the main window be moved back, now that the displays have changed?
 *
 * Returns the bounds to restore, or null for "leave it alone" — and the null
 * cases are the interesting ones, because moving a window the user did not ask
 * to have moved is a worse bug than the one this fixes:
 *
 * - **An arrangement we have never seen**: we have no opinion. This is E8-06's
 *   projector worry, and it stays honoured — a brand-new display never attracts
 *   the window. Only a return to somewhere it has already lived moves it.
 * - **Remembered bounds that aren't visible now**: the note is stale relative to
 *   what is actually attached, and the boot-time rescue rules apply instead.
 * - **Already there**: no redundant `setBounds`, which would otherwise fight a
 *   user who nudged the window between the two events of a hotplug.
 *
 * Note this deliberately does NOT gate on consent, unlike the popout restore
 * offer (E8-06 §7). Returning the main window to the monitor it was already on
 * is what every other window on the machine does; an offer after every monitor
 * wake would be more intrusive than the defect.
 */
export function decideDisplayRestore(args: {
  memories: ArrangementMemories;
  fingerprint: string;
  currentBounds: Rectangle;
  workAreas: Rectangle[];
}): ArrangementMemory | null {
  const remembered = args.memories[args.fingerprint];
  if (!remembered) return null;
  if (!isOnAnyDisplay(remembered.bounds, args.workAreas)) return null;
  if (sameRect(remembered.bounds, args.currentBounds)) return null;
  return { bounds: { ...remembered.bounds }, isMaximized: remembered.isMaximized };
}

/** The work area this rectangle's centre falls in, or null if it is off them all. */
function displayOf(bounds: Rectangle, workAreas: Rectangle[]): Rectangle | null {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return (
    workAreas.find((a) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height) ??
    null
  );
}

/** What the caller should actually DO to the window — see `planDisplayRestore`. */
export interface RestorePlan {
  bounds: Rectangle;
  /** drop out of maximize first: `setBounds` on a maximized window is ignored on Windows */
  unmaximizeFirst: boolean;
  maximizeAfter: boolean;
}

/**
 * `decideDisplayRestore` plus the maximize dance, as a plan the caller can
 * carry out with three Electron verbs and no decisions of its own.
 *
 * Split out so the dance is testable on CI, which has one display and no way to
 * detach it: everything here is arithmetic on rectangles, and the only thing
 * left in the main process is `unmaximize()` / `setBounds()` / `maximize()`.
 *
 * The early-out matters more than it looks. A maximized window that is already
 * on the right display would otherwise be unmaximized and re-maximized on every
 * qualifying display event — a visible flash, for no movement at all.
 */
export function planDisplayRestore(args: {
  memories: ArrangementMemories;
  fingerprint: string;
  currentBounds: Rectangle;
  workAreas: Rectangle[];
  isMaximized: boolean;
}): RestorePlan | null {
  const target = decideDisplayRestore(args);
  if (!target) return null;
  if (args.isMaximized && target.isMaximized) {
    const here = displayOf(args.currentBounds, args.workAreas);
    const there = displayOf(target.bounds, args.workAreas);
    // already maximized on the display we would send it to: nothing to do
    if (here && there && here.x === there.x && here.y === there.y) return null;
  }
  return {
    bounds: target.bounds,
    unmaximizeFirst: args.isMaximized,
    maximizeAfter: target.isMaximized,
  };
}

export function windowOptionsFrom(state: WindowState): {
  width: number;
  height: number;
  x?: number;
  y?: number;
} {
  if (!state.bounds) return { ...DEFAULT_SIZE };
  return {
    width: state.bounds.width,
    height: state.bounds.height,
    x: state.bounds.x,
    y: state.bounds.y,
  };
}
