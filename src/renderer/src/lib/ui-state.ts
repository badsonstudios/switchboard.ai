// Renderer UI state that must survive relaunch (P2-E12-08, §5.25): focused
// card, per-card view tabs, small prefs. Backed by the workspace store over
// IPC — NOT localStorage: the packaged renderer is served from a random
// loopback port, so its origin (and localStorage) changes every launch.
// App.tsx awaits loadUiState() once at boot; afterwards reads are sync.
let cache: Record<string, unknown> = {};

export async function loadUiState(): Promise<void> {
  // A pending `uiSetSoon` would otherwise outlive the object it was written
  // into and then push the RELOADED blob, silently dropping the change it was
  // scheduled for. Unreachable today — the shell is gated on `uiReady`, so no
  // composer exists before the second call — and one line to keep it that way.
  cancelPendingPush();
  try {
    const raw = await window.switchboard.workspace.getUi();
    cache = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  } catch {
    cache = {}; // fail-open: prefs are nice-to-have, never a boot blocker
  }
  // One-time migration from the old localStorage home. It only ever finds
  // anything in DEV: Vite serves from a fixed origin, so a developer's stored
  // prefs are still there — the packaged app's origin changed port every
  // launch, which is the whole reason these moved (P2-E15-06 / AR-P0-3).
  for (const [key, legacy] of LEGACY_KEYS) {
    if (cache[key] !== undefined) continue;
    try {
      const v = localStorage.getItem(legacy);
      if (v) cache[key] = v;
    } catch {
      /* fail-open: a throwing store costs the migration, not the boot */
    }
  }
}

/** ui-blob key -> the localStorage key it used to live under */
const LEGACY_KEYS: ReadonlyArray<[string, string]> = [
  ['autonomy', 'switchboard.autonomy'],
  ['theme', 'switchboard.theme'],
  ['language', 'switchboard.language'],
];

export function uiGet<T>(key: string, fallback: T): T {
  const v = cache[key];
  return v === undefined ? fallback : (v as T);
}

export function uiSet(key: string, value: unknown): void {
  cache[key] = value;
  push();
}

/**
 * How long a `uiSetSoon` write waits before it leaves the renderer.
 *
 * Short enough that a quit a moment after the last keystroke still carries it
 * (main's store then debounces the DISK write behind its own timer and flushes
 * on close), long enough that a fast typist does not send the whole blob on
 * every character.
 */
export const UI_PUSH_DELAY_MS = 400;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingPush(): void {
  if (!pushTimer) return;
  clearTimeout(pushTimer);
  pushTimer = null;
}

function push(): void {
  cancelPendingPush(); // whatever was pending is in this same blob
  try {
    window.switchboard.workspace.setUi(cache);
  } catch {
    /* fail-open: prefs are nice-to-have, never a reason to break a gesture */
  }
}

/**
 * Write the cache NOW; push to main SOON — for values that change on every
 * keystroke, like the composer draft (#485).
 *
 * THE SPLIT IS THE POINT, and it is what makes a remount survivable. The cache
 * is a module-level object in this bundle, so it is correct the instant the
 * value changes: a component that unmounts and mounts again a tick later — a
 * card popped out, a view tab switched — reads back exactly what the user
 * typed, with no round trip to wait for. Only the IPC is delayed, and only the
 * relaunch case depends on it.
 *
 * The delay is measured from the FIRST unsent change, not reset by each new
 * one: a trailing debounce can be starved for ever by someone who keeps typing,
 * and "your draft is safe once you pause" is a worse promise than "your draft
 * reaches main within 400ms, always". MAIN, note, not disk — main's own
 * `saveSoon()` is a RESETTING 500ms debounce, so a continuous typist keeps
 * pushing it out and the file is written when the window closes. That is the
 * right trade for a quit and the wrong one for a power cut; nothing here
 * promises to survive the second.
 *
 * `undefined` DELETES the key rather than storing an explicit undefined, so a
 * draft the user emptied leaves nothing behind (JSON would drop it on the way
 * out anyway, but reads in THIS session would still see the key).
 */
export function uiSetSoon(key: string, value: unknown): void {
  if (value === undefined) delete cache[key];
  else cache[key] = value;
  if (pushTimer) return; // already scheduled; this write rides it
  pushTimer = setTimeout(() => {
    pushTimer = null;
    try {
      window.switchboard.workspace.setUi(cache);
    } catch {
      /* fail-open */
    }
  }, UI_PUSH_DELAY_MS);
  // and note the bonus: any ordinary `uiSet` — a focus change, a tab switch —
  // pushes the whole cache and cancels this timer, so 400ms is the worst case
  // rather than the usual one.
}

/**
 * Send anything `uiSetSoon` is still holding, now.
 *
 * For the moments where waiting is a risk rather than an economy — the composer
 * losing focus, which is what a click on the window's ✕ starts with.
 */
export function uiFlush(): void {
  if (pushTimer) push();
}

/** The whole blob, for readers that migrate keys they can't name up front
 *  (the per-card `viewTab.<cardId>` keys — see lib/presentation.ts). */
export function uiAll(): Readonly<Record<string, unknown>> {
  return cache;
}

/** Forget a key outright. `uiSet(k, undefined)` would leave it in the blob as
 *  an explicit undefined and JSON would drop it on the way out anyway — but
 *  reads in THIS session would still see the key present. */
export function uiDelete(keys: string[]): void {
  if (keys.length === 0) return;
  for (const k of keys) delete cache[k];
  push();
}
