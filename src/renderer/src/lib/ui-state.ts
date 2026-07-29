// Renderer UI state that must survive relaunch (P2-E12-08, §5.25): focused
// card, per-card view tabs, small prefs. Backed by the workspace store over
// IPC — NOT localStorage: the packaged renderer is served from a random
// loopback port, so its origin (and localStorage) changes every launch.
// App.tsx awaits loadUiState() once at boot; afterwards reads are sync.
let cache: Record<string, unknown> = {};

export async function loadUiState(): Promise<void> {
  try {
    const raw = await window.switchboard.workspace.getUi();
    cache = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  } catch {
    cache = {}; // fail-open: prefs are nice-to-have, never a boot blocker
  }
  // one-time migration from the old localStorage home (dev origin keeps it)
  const legacyAutonomy = localStorage.getItem('switchboard.autonomy');
  if (legacyAutonomy && cache['autonomy'] === undefined) cache['autonomy'] = legacyAutonomy;
}

export function uiGet<T>(key: string, fallback: T): T {
  const v = cache[key];
  return v === undefined ? fallback : (v as T);
}

export function uiSet(key: string, value: unknown): void {
  cache[key] = value;
  try {
    window.switchboard.workspace.setUi(cache);
  } catch {
    /* fail-open */
  }
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
  try {
    window.switchboard.workspace.setUi(cache);
  } catch {
    /* fail-open */
  }
}
