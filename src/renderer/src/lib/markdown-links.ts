// What a click on a link in rendered markdown means (#527).
//
// THE BUG THIS EXISTS FOR: a reply containing a link rendered as a link, in
// link colours, with a link cursor — and clicking it did nothing at all. Two
// halves that never met. Main correctly refuses to let the top frame navigate
// away from our own origin (`will-navigate` in `main/index.ts`), so the click
// was swallowed in silence; and the feed, which is the surface that renders
// assistant prose, never added a handler to do anything else with it. The
// plumbing to open a browser had existed since P2-E16-01 (`fs:openExternal`,
// scheme-allowlisted in main) and nothing in the conversation called it.
//
// WHY IT IS A MODULE AND NOT SIX LINES IN THE COMPONENT: the decision is a
// security decision on author-supplied input, and #465's lesson is one guard,
// N surfaces. The href in a reply is written by whoever the agent was reading;
// `<a href>` survives sanitization by design (`markdown.test.tsx` pins that
// ordinary links live), so the scheme check is the only thing between a click
// and `shell.openExternal`.
//
// WHICH SURFACES USE IT, and which deliberately do not — the app has three
// rendered-markdown surfaces and they do NOT share one policy:
//
//   * THE FEED (`extensibility/feed-blocks.tsx`) — this module. Anything on
//     the app-wide allowlist goes to the browser.
//   * THE DOCUMENT VIEWER — its own, RICHER path (`document-link.ts` +
//     `document-render.ts`), because a link in a file on disk can also be a
//     relative path to another file, which the viewer navigates to itself. It
//     goes further than this module too: it strips the `href` outright, so
//     there is nothing for a middle-click or a context menu to navigate. Same
//     scheme list (`shared/link-schemes.ts`), different verbs.
//   * THE UPDATE DIALOG's release notes — a DELIBERATELY NARROWER policy
//     (`update:openExternal` accepts GitHub URLs and nothing else), because
//     that text comes off the network rather than off this machine. Routing it
//     through here would widen it to any http(s) URL, which is why it keeps
//     its own handler.
//
// THE `href` STAYS IN THE DOM for the feed, unlike the viewer. A click and a
// keyboard Enter both arrive here and are both prevented; a MIDDLE-click
// arrives as `auxclick` (hence the two listeners at the call site); and the
// context menu's "open in new window" goes to main's `setWindowOpenHandler`,
// which opens http(s) externally and denies everything else. Keeping the href
// is what makes a link readable to a screen reader and hoverable at all — and
// the sanitizer has already removed the hrefs that matter (`javascript:`,
// `data:`, `file:`, `vbscript:` are all outside DOMPurify's URI regexp). We do
// not RELY on that, which is what the scheme check below is for.
import { isIpcRefusal } from '../../../shared/ipc/refusal';
import { isAllowedLinkUrl } from '../../../shared/link-schemes';

/**
 * The bridge's opener, or undefined in a window that has no bridge.
 *
 * Looked up per click rather than captured once: the preload may not have run
 * yet when a module is first evaluated, and a window without capabilities
 * (§P2-E15-04) legitimately has nothing here. `handleMarkdownLinkClick` takes
 * it as a dependency so its tests need no `window`, and this is the one place
 * the real lookup is spelled.
 */
export function openExternalBridge(): ((url: string) => Promise<unknown>) | undefined {
  const files = (window as unknown as { switchboard?: { files?: Record<string, unknown> } })
    .switchboard?.files;
  const open = files?.openExternal;
  return typeof open === 'function' ? (open as (url: string) => Promise<unknown>).bind(files) : undefined;
}

/** What happened to a click on a rendered-markdown surface. */
export type LinkClickVerdict =
  /** not a link at all — the surface's other handlers get their turn */
  | 'ignored'
  /** an in-document `#fragment`: prevented, and nothing else (see below) */
  | 'fragment'
  /** a scheme that is not on the allowlist: prevented, logged, inert */
  | 'blocked'
  /** handed to main, which said it opened it */
  | 'opened'
  /** handed to main, which did NOT open it — or refused the call outright */
  | 'refused';

/** The one thing this needs from the app: the bridge, and somewhere to warn. */
export interface MarkdownLinkDeps {
  /** `window.switchboard.files.openExternal` — absent in a window without it */
  openExternal?: (url: string) => Promise<unknown>;
  /** defaults to `console.warn`, which main copies into the app log */
  warn?: (message: string) => void;
}

/** The parts of a click this needs, so a test does not have to build an Event. */
export interface MarkdownLinkEvent {
  readonly target: EventTarget | null;
  preventDefault(): void;
}

/** The clicked anchor's href, or null when the click was not on a link. */
function hrefFrom(target: EventTarget | null): string | null {
  const el = target as Element | null;
  const anchor = el?.closest?.('a');
  if (!anchor) return null;
  // The ATTRIBUTE, not `anchor.href`: the property resolves a relative href
  // against the renderer's own origin, which would turn `./notes.md` into an
  // `app://…/notes.md` that looks allowlisted-adjacent and is not the string
  // the author wrote. The raw attribute is what we judge.
  return anchor.getAttribute('href');
}

/**
 * Handle a click on a link inside rendered markdown.
 *
 * `preventDefault()` FIRST AND UNCONDITIONALLY for every anchor, before any
 * scheme is looked at and before the first `await`. That ordering is the
 * security property, not tidiness: a `file:` or `data:` href that reached the
 * DOM must not navigate this window while we are deciding what to do about it,
 * and an async function only runs synchronously up to its first `await`.
 * Main's `will-navigate` is the backstop, not the plan.
 *
 * A BARE `#fragment` DOES NOTHING HERE, deliberately. The conversation is not a
 * document: its blocks stream in and out, it has no heading ids to scroll to,
 * and the ids it DOES carry are the feed's own decoration protocol (#465). So
 * a `#fragment` in a reply is prevented and dropped. The document viewer, which
 * has real headings and its own handler, scrolls to them instead — the two
 * behaviours differ because the two surfaces do.
 *
 * Returns the verdict for tests and for a caller that wants to know; every
 * outcome that is not "opened" also leaves a line in the renderer console,
 * which main copies into the app log next to its own refusal line.
 */
export async function handleMarkdownLinkClick(
  e: MarkdownLinkEvent,
  deps: MarkdownLinkDeps
): Promise<LinkClickVerdict> {
  const href = hrefFrom(e.target);
  if (href === null) return 'ignored';
  e.preventDefault();

  const url = href.trim();
  if (url.startsWith('#')) return 'fragment';
  if (!isAllowedLinkUrl(url)) {
    warn(deps, `[links] refused a link that is not http(s) or mailto: ${clip(url)}`);
    return 'blocked';
  }

  const result = await deps.openExternal?.(url);
  // #440: a REFUSAL IS TRUTHY. `fs:openExternal` answers `true`/`false`, but a
  // caller without the capability gets an `IpcRefusal` OBJECT instead, and a
  // window with no bridge at all gets `undefined` — so `if (result)` would read
  // "you were not allowed to do that" as "done". Only `true` is done.
  if (result === true) return 'opened';
  warn(
    deps,
    isIpcRefusal(result)
      ? `[links] opening a link was refused by the broker (${result.reason}) — nothing happened`
      : `[links] main did not open the link — nothing happened (the reason is in the app log)`
  );
  return 'refused';
}

function warn(deps: MarkdownLinkDeps, message: string): void {
  (deps.warn ?? ((m: string) => console.warn(m)))(message);
}

/** Hostile hrefs are unbounded; a log line is not the place to find that out. */
function clip(url: string): string {
  return url.length > 200 ? `${url.slice(0, 200)}…` : url;
}
