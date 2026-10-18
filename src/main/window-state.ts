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

/**
 * How far above a work area's top a window's top edge may sit and still have a
 * title bar a hand can reach (#1277). Windows 10/11 frames carry an invisible
 * resize border (7 px at 100% scaling, about 11 px at 150%), and a little more
 * covers DIP rounding across monitors.
 */
export const TITLE_BAR_SLACK_PX = 16;
/** The strip of the window's top edge that has to be grabbable. */
const TITLE_BAR_HEIGHT_PX = 32;
/** How much of that strip has to be over one work area, horizontally. */
const TITLE_BAR_GRAB_PX = 100;

/**
 * Is the window's TITLE BAR on an attached work area? (#1277)
 *
 * Stricter than `isOnAnyDisplay`, and the difference is the regression #1277
 * reported against #864. `isOnAnyDisplay` asks "is a usable chunk of the window
 * visible?", which a rectangle whose title bar hangs off the top of the screen
 * still passes — and a window with no reachable title bar is one the user cannot
 * drag back.
 *
 * The STRIP, not the top-left corner (review). A window spanning two monitors
 * of different heights can have its corner in the dead zone beside the shorter
 * one while its title bar runs across the taller one; a window pushed half off
 * the left edge has its corner off every display and a perfectly good title bar.
 * Both are positions people choose, and both are fine.
 */
export function titleBarReachable(bounds: Rectangle, workAreas: Rectangle[]): boolean {
  const grab = Math.min(TITLE_BAR_GRAB_PX, bounds.width);
  return workAreas.some((a) => {
    const overlap = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    return (
      overlap >= grab &&
      bounds.y >= a.y - TITLE_BAR_SLACK_PX &&
      bounds.y <= a.y + a.height - TITLE_BAR_HEIGHT_PX
    );
  });
}

function intersection(a: Rectangle, b: Rectangle): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where to actually put a remembered rectangle on these displays (#1277), or
 * null if it is not on them at all.
 *
 * A CLAMP, not a refusal. A rectangle that is visible but whose title bar is out
 * of reach (the owner's `-2296,-21`) is SLID onto the work area it mostly
 * covers, keeping its size where it fits, so the window comes back where it was
 * and can be grabbed. Refusing instead would leave the window wherever the OS
 * shoved it, which is the #864 bug, and would throw the user's chosen size away
 * at boot (a rescue is centred at the default size).
 */
export function clampIntoArrangement(bounds: Rectangle, workAreas: Rectangle[]): Rectangle | null {
  if (!isOnAnyDisplay(bounds, workAreas)) return null;
  if (titleBarReachable(bounds, workAreas)) return { ...bounds };
  let best: Rectangle | null = null;
  let bestArea = 0;
  for (const a of workAreas) {
    const i = intersection(bounds, a);
    if (i > bestArea) {
      best = a;
      bestArea = i;
    }
  }
  if (!best) return null;
  const width = Math.min(bounds.width, best.width);
  const height = Math.min(bounds.height, best.height);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    x: clamp(bounds.x, best.x, best.x + best.width - width),
    y: clamp(bounds.y, best.y, best.y + best.height - height),
    width,
    height,
  };
}

/**
 * Is this exactly where Electron puts a window it was given no position for?
 * (#1277)
 *
 * A boot rescue (`bounds: null`) is created at `DEFAULT_SIZE`, centred on the
 * primary work area. Nobody chose that rectangle, and it is the `640,296
 * 1280x800` in the owner's log: saved as the note for his three-monitor desk
 * and then restored to on every wake, which is "the window went to the main
 * monitor". So it is never recorded as a note, and an existing one is ignored.
 * A user who genuinely wants a 1280x800 window dead centre loses only the
 * automatic return, and only until they nudge it by a pixel.
 */
export function looksLikeBootRescue(bounds: Rectangle, workAreas: Rectangle[]): boolean {
  if (bounds.width !== DEFAULT_SIZE.width || bounds.height !== DEFAULT_SIZE.height) return false;
  return workAreas.some(
    (a) =>
      Math.abs(bounds.x - (a.x + Math.round((a.width - DEFAULT_SIZE.width) / 2))) <= 2 &&
      Math.abs(bounds.y - (a.y + Math.round((a.height - DEFAULT_SIZE.height) / 2))) <= 2
  );
}

/**
 * Does a `display-metrics-changed` call for the #864 restore? (#1277)
 *
 * Only if something other than the WORK AREA changed. A work-area-only change
 * is a taskbar appearing, moving, resizing or auto-hiding: it never moves a
 * window between monitors, but it mints a new fingerprint, so treating it as a
 * hotplug restored the window to whatever note that fingerprint held — the
 * second half of every wake in the owner's log, since a monitor's taskbar
 * lands a beat after the monitor does.
 *
 * AN EMPTY LIST is not one either. Measured on the owner's desktop (three
 * monitors at 150%): Electron raises this at EVERY BOOT, once per display, with
 * `changed: []`. A missing list is treated the same way — nothing reported,
 * nothing to restore.
 */
export function metricsChangeRestores(changed: readonly string[] | undefined): boolean {
  return (changed ?? []).some((m) => m !== 'workArea');
}

/**
 * The work areas a display fingerprint was built from (#1277), or null if the
 * string is not one.
 *
 * `displayFingerprint` (workspace/store.ts) is the sorted list of work areas as
 * `x,y,w,h` joined by `|`, so the arrangement a note is filed under can be
 * checked against the note itself — which is what lets the store refuse a note
 * the window was never actually on. Null rather than a partial list: a
 * fingerprint we cannot fully read is one we have no opinion about.
 */
export function workAreasOfFingerprint(fingerprint: string): Rectangle[] | null {
  if (fingerprint === '') return null;
  const out: Rectangle[] = [];
  for (const part of fingerprint.split('|')) {
    const n = part.split(',').map(Number);
    if (n.length !== 4 || !n.every((v) => Number.isFinite(v))) return null;
    out.push({ x: n[0], y: n[1], width: n[2], height: n[3] });
  }
  return out;
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
  /**
   * Told why a remembered note was REFUSED (#1277) — not called for "no note"
   * or "already there", which are ordinary. A refusal is the case the log has
   * to show, because it means the memory held a rectangle nobody could reach.
   */
  onRefused?: (why: string, bounds: Rectangle) => void;
  /** told when a note was SLID back within reach rather than used as-is (#1277) */
  onClamped?: (from: Rectangle, to: Rectangle) => void;
}): ArrangementMemory | null {
  const remembered = args.memories[args.fingerprint];
  if (!remembered) return null;
  // Nobody chose it — see `looksLikeBootRescue`. The owner's second restore of
  // every wake went to exactly this rectangle.
  if (looksLikeBootRescue(remembered.bounds, args.workAreas)) {
    args.onRefused?.('it is the boot-time default position, not one anybody chose', remembered.bounds);
    return null;
  }
  // THE CLAMP (#1277). `isOnAnyDisplay` alone let `-2296,-21` through: most of
  // the window was on a monitor, its title bar was not. Not visible at all is
  // stale relative to what is attached now, and is left alone; visible with an
  // unreachable title bar is slid back into reach.
  const target = clampIntoArrangement(remembered.bounds, args.workAreas);
  if (!target) {
    args.onRefused?.('not visible on any attached display', remembered.bounds);
    return null;
  }
  if (!sameRect(target, remembered.bounds)) args.onClamped?.(remembered.bounds, target);
  if (sameRect(target, args.currentBounds)) return null;
  return { bounds: target, isMaximized: remembered.isMaximized };
}

/**
 * A main window that is off every attached display, put back where a person can
 * reach it (#1277), or null if it is fine where it is.
 *
 * The runtime twin of the boot rescue. #864's restore only ever moves the window
 * to a NOTE; with no usable note it left the window wherever the OS put it — and
 * if that was off every display, nothing ever brought it back, while the
 * permission gate denied every request because nobody could see it. Same size
 * where it fits, centred on the primary work area, which is where the boot
 * rescue sends it too.
 *
 * AND THE SAME CLAMP AS A NOTE GETS (review). A window the OS left visible but
 * with its title bar out of reach — the owner's `-2296,-21` shape — is slid back
 * within reach where it is (`how: 'clamped'`), not left there because some of it
 * shows. Only a window off every display is moved to the primary
 * (`how: 'centred'`).
 */
export function rescueOffscreen(
  current: Rectangle,
  workAreas: Rectangle[],
  primary: Rectangle
): { bounds: Rectangle; how: 'clamped' | 'centred' } | null {
  if (workAreas.length === 0) return null;
  if (isOnAnyDisplay(current, workAreas)) {
    const slid = clampIntoArrangement(current, workAreas);
    return slid && !sameRect(slid, current) ? { bounds: slid, how: 'clamped' } : null;
  }
  const width = Math.min(current.width, primary.width);
  const height = Math.min(current.height, primary.height);
  return {
    bounds: {
      x: primary.x + Math.round((primary.width - width) / 2),
      y: primary.y + Math.round((primary.height - height) / 2),
      width,
      height,
    },
    how: 'centred',
  };
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
  onRefused?: (why: string, bounds: Rectangle) => void;
  onClamped?: (from: Rectangle, to: Rectangle) => void;
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
