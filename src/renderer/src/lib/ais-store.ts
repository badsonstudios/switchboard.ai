// Which AIs exist, as the renderer draws them (E40 item 10, #1293).
//
// One small cache over the preload's `ais.list()` / `ais.onChanged`, so every
// tab, rail card, header and the status bar read ONE answer instead of each
// asking main. Started lazily by the first subscriber, and never stopped: the
// list is a property of the app run, not of any one component.
//
// FAIL-OPEN, all the way down (PHILOSOPHY §4): no bridge (a unit test, an old
// preload), a refused call or a rejected promise all leave the snapshot at
// "no list". Every reader treats that as "draw the neutral glyph and keep the
// ring and the words", never as an error.
import { AI_ICON_BASE, type AiListItem, type AisSnapshot } from '../../../shared/ais';
import { answered } from '../../../shared/ipc/refusal';

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
}

const EMPTY: AisState = Object.freeze({ items: null, defaultId: null });

let state: AisState = EMPTY;
let started = false;
/** a push has landed, so a slower first `list()` answer must not overwrite it */
let pushed = false;
const listeners = new Set<() => void>();

type AisBridge = {
  list?: () => Promise<AiListItem[]>;
  default?: () => Promise<{ id: string }>;
  onChanged?: (cb: (snap: AisSnapshot) => void) => unknown;
};

function bridge(): AisBridge | undefined {
  try {
    return (globalThis as { switchboard?: { ais?: AisBridge } }).switchboard?.ais;
  } catch {
    return undefined;
  }
}

function set(next: AisState): void {
  state = next;
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // a reader's throw is its own problem; the rest still hear
    }
  }
}

function start(): void {
  if (started) return;
  started = true;
  const ais = bridge();
  if (!ais) return;
  try {
    ais.onChanged?.((snap) => {
      if (!snap || !Array.isArray(snap.items)) return;
      pushed = true;
      set({ items: snap.items, defaultId: snap.default?.id ?? null });
    });
  } catch {
    // no push channel: the one read below is all there is
  }
  void Promise.all([
    Promise.resolve()
      .then(() => ais.list?.())
      .catch(() => undefined),
    Promise.resolve()
      .then(() => ais.default?.())
      .catch(() => undefined),
  ]).then(([list, def]) => {
    if (pushed) return;
    const items = answered(list);
    if (!Array.isArray(items)) return;
    const d = answered(def);
    set({ items, defaultId: typeof d?.id === 'string' ? d.id : null });
  });
}

/** `useSyncExternalStore`'s subscribe. The first subscriber starts the cache. */
export function subscribeAis(cb: () => void): () => void {
  listeners.add(cb);
  start();
  return () => {
    listeners.delete(cb);
  };
}

/** The current snapshot; a stable object until something changes. */
export function getAisState(): AisState {
  return state;
}

/** The list item that hosts this provider id, if the list has one. */
export function aiItemFor(items: readonly AiListItem[] | null, providerId: string | undefined): AiListItem | undefined {
  if (!items || !providerId) return undefined;
  return (
    items.find((i) => i.providerId === providerId) ??
    // a catalog AI with no provider registered still has its own id
    items.find((i) => i.entry.id === providerId)
  );
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
  };
}

/** Tests only: forget everything, so the next subscriber starts again. */
export function resetAisStoreForTests(next: AisState = EMPTY): void {
  state = next;
  started = next !== EMPTY;
  pushed = false;
  listeners.clear();
}
