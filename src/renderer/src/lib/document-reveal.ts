// "Open this file AT THIS LINE" (#1384) — the diff panel's Open file button.
//
// `openDocument` takes a path and nothing else, and the thing that opens a panel
// is a dockview call three modules away that either FOCUSES a viewer already on
// that file or ADDS one. Threading a line through the opener, the grid
// controller, the panel's persisted `params` and the focus branch would have
// touched four surfaces for one number — and put a line into `params`, which is
// frozen into the saved layout (see `openDocumentPanel`'s note on `sessionId`).
//
// So the line travels BESIDE the open, not through it: the caller leaves a
// request here and then calls `openDocument` as every other surface does; the
// viewer showing that path takes it — on mount for a new viewer, on the
// announcement for one already open. `document-open`'s own header records the
// same choice for the same reason: a module seam, not another prop.
//
// A request is CONSUMED, and it EXPIRES. Consumed, so a viewer that remounts
// later (a popout, a dock-back) does not jump the reader back to a line they
// left. Expiring, so a request nobody took — the open failed, the file is
// binary — cannot ambush the next viewer opened on that file an hour later.
import { documentKey } from './document-panels';

/** How long an untaken request stays good. Generous: a viewer mounts in ms. */
export const REVEAL_TTL_MS = 10_000;

interface Pending {
  line: number;
  at: number;
}

const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();

/** Ask the viewer of `absolutePath` to put `line` in view. */
export function requestDocumentLine(absolutePath: string, line: number, now: number = Date.now()): void {
  if (!absolutePath || !Number.isFinite(line) || line < 1) return;
  pending.set(documentKey(absolutePath), { line: Math.floor(line), at: now });
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* fail-open: one viewer's throw costs only that viewer */
    }
  }
}

/** Take the request for this path, if there is a fresh one. One taker only. */
export function takeDocumentLine(absolutePath: string, now: number = Date.now()): number | null {
  const key = documentKey(absolutePath);
  const p = pending.get(key);
  if (!p) return null;
  pending.delete(key);
  return now - p.at <= REVEAL_TTL_MS ? p.line : null;
}

/** Fires on every request; a viewer then tries `takeDocumentLine` for its path. */
export function subscribeDocumentLine(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** For tests. */
export function resetDocumentLines(): void {
  pending.clear();
}
