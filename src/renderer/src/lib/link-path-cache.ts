// Which paths a reply named are really there (#1611).
//
// A path in a reply is drawn as a link only when it is a file or a folder that
// switchboard may read: a dead link is worse than none. But the decoration
// pass is SYNCHRONOUS (it runs inside `<Markdown>`'s memo, on a string), and
// the answer lives in main. So this keeps what main has said, per absolute
// path, and the pass only ever reads it:
//
//   - a path never asked about is UNKNOWN: not drawn, and queued;
//   - the queue goes to main in batches (`fs:statForLinks`, at most
//     `MAX_LINK_STATS` a call), off the render, on a timer;
//   - when an answer arrives, everyone subscribed is told, and a reply whose
//     own paths changed (`linkPathsKey`) decorates itself again.
//
// Nothing here is a boundary. Main answers inside the read scope only, and the
// click re-checks everything; this only decides what to OFFER.
import { MAX_LINK_STATS } from '../../../shared/ipc/fs';

export type KnownKind = 'file' | 'dir' | 'missing';

/**
 * How long "not there" is believed, in ms. A path named BEFORE the file was
 * written (an agent says where it will put something) becomes a link the next
 * time its reply is drawn after this, rather than never.
 */
export const MISSING_TTL_MS = 15_000;

/** The most answers kept; the oldest go first past it. */
export const MAX_CACHED_PATHS = 5_000;

type Bridge = (paths: readonly string[]) => Promise<unknown>;

interface Entry {
  kind: KnownKind;
  at: number;
}

const cache = new Map<string, Entry>();
const queued = new Set<string>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let bridgeOverride: Bridge | null | undefined;
let now: () => number = () => Date.now();

function bridge(): Bridge | undefined {
  if (bridgeOverride !== undefined) return bridgeOverride ?? undefined;
  const files = (window as unknown as { switchboard?: { files?: Record<string, unknown> } }).switchboard?.files;
  const stat = files?.statForLinks;
  return typeof stat === 'function' ? (stat as Bridge).bind(files) : undefined;
}

/** What main has said about `abs`, or undefined when it has not been asked (or "missing" went stale). */
export function knownKind(abs: string): KnownKind | undefined {
  const e = cache.get(abs);
  if (!e) return undefined;
  if (e.kind === 'missing' && now() - e.at > MISSING_TTL_MS) return undefined;
  return e.kind;
}

/**
 * Record an answer. `announce` tells the replies too: how a click that main
 * refused (the file went away since the link was drawn) takes its link away.
 */
export function rememberKind(abs: string, kind: KnownKind, announce = false): void {
  cache.delete(abs);
  cache.set(abs, { kind, at: now() });
  while (cache.size > MAX_CACHED_PATHS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  if (announce) notify();
}

/** Queue the paths main has not answered, to be asked off the render. */
export function askKinds(paths: readonly string[]): void {
  let added = false;
  for (const p of paths) {
    if (knownKind(p) !== undefined || queued.has(p) || inFlight.has(p)) continue;
    queued.add(p);
    added = true;
  }
  if (added && timer === null) timer = setTimeout(flush, 0);
}

function flush(): void {
  timer = null;
  const batch = [...queued].slice(0, MAX_LINK_STATS);
  for (const p of batch) {
    queued.delete(p);
    inFlight.add(p);
  }
  if (queued.size > 0) timer = setTimeout(flush, 0);
  if (batch.length === 0) return;
  const settle = (answers: unknown): void => {
    const list: readonly unknown[] = Array.isArray(answers) ? answers : [];
    batch.forEach((p, i) => {
      inFlight.delete(p);
      const a = list[i];
      rememberKind(p, a === 'file' || a === 'dir' ? a : 'missing');
    });
    notify();
  };
  const ask = bridge();
  if (!ask) {
    // no bridge (a window without the capability): nothing is a link
    settle([]);
    return;
  }
  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve(ask(batch));
  } catch {
    settle([]);
    return;
  }
  pending.then(settle, () => settle([]));
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** For `useSyncExternalStore`. */
export function subscribeLinkPaths(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The part of the cache one reply cares about, as a string: its paths that are
 * files or folders. Unknown and missing are left out, so a reply that names
 * nothing real never re-renders for an answer, and the key starts out ''.
 */
export function linkPathsKey(paths: readonly string[]): string {
  let key = '';
  for (const p of paths) {
    const k = knownKind(p);
    if (k === 'file' || k === 'dir') key += `${k[0]}${p}\n`;
  }
  return key;
}

/** Tests only: forget everything, and optionally swap the bridge and the clock. */
export function resetLinkPathCacheForTests(opts: { bridge?: Bridge | null; now?: () => number } = {}): void {
  cache.clear();
  queued.clear();
  inFlight.clear();
  listeners.clear();
  if (timer !== null) clearTimeout(timer);
  timer = null;
  bridgeOverride = opts.bridge;
  now = opts.now ?? (() => Date.now());
}
