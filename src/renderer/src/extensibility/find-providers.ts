// The `find-provider` registrants and their resolution (P2-E17-02, §5.31, §5.23).
//
// Ctrl+F dispatches to the FOCUSED panel's provider. That sentence is the
// whole correctness argument: §5.31 rejects `webContents.findInPage` because
// it searches the entire webContents, so on a four-card grid it matches text
// in the three sessions you are not looking at. Here the only way to reach a
// surface is to name a card AND a panel (`lib/find-surfaces`), and the only
// card the bar ever names is the focused one — so "never matches another card"
// is a property of the plumbing rather than a filter to remember.
//
// THREE OF §5.31'S FOUR NAMED REGISTRANTS SHIP HERE, and the gap is
// deliberate, not an oversight (see docs/extensibility.md's roster):
//
//   • `panel-session` → the E17-01 transcript engine. The flagship.
//   • `panel-changes` → DELEGATES to Monaco's own find. §5.31 names it as a
//     thing not to reimplement, and half-reimplementing it would be worse than
//     either whole: our chrome over its search means two sets of keybindings
//     over one editor.
//   • `panel-terminal` → xterm's scrollback through `@xterm/addon-search`
//     (P2-E17-03). SCROLLBACK ONLY, and its label says so.
//   • the §5.30 document viewer — still absent, and for structural reasons
//     rather than effort; the recipe and the two blockers are at the bottom of
//     this file.
//
// GROUPS, NOT A WINNER (P2-E17-03, §5.31's first decision). One Ctrl+F covers
// the whole session and the bar reports each `bar` registrant as its own group:
// "14 in Session · 3 in Terminal (scrollback only)". Two providers see two
// different depths — the transcript is the session, the terminal is 5,000
// ring-buffered lines — so one number over both would be a small lie, and the
// group LABEL is where each surface declares what it can see.
//
// The FOCUSED panel still decides whether find runs at all (its
// `unavailableKey` is what greys the bar) and which group the first match is
// taken from. What it no longer decides is which surfaces get searched.
import type {
  FindContext,
  FindHit,
  FindProviderContribution,
  FindQuery,
  FindResults,
} from './contributions';
import { manifestFor } from './contributions';
import type { FeedFindSurface, MonacoFindSurface, TerminalFindSurface } from '../lib/find-surfaces';
import { snippetAround, type TerminalMatch } from '../lib/terminal-find';
import type { RendererRegistry } from './registry-instance';
import { safely } from './boundary';
import type { TranscriptSearchResult } from '../../../shared/transcripts';

const manifest = (id: string, displayName: string): ReturnType<typeof manifestFor> =>
  manifestFor(id, displayName, 'find.provide');

/** Providers in `order`. One definition of that rule, as with `listPanels`. */
export function listFindProviders(registry: RendererRegistry): FindProviderContribution[] {
  return [...registry.list('find-provider')].sort((a, b) => a.order - b.order);
}

/**
 * The provider for a panel, or null when that panel has none.
 *
 * Null is a REAL and expected answer — the History placeholder has no provider
 * and the Terminal has none until E17-03 — and it is what greys the bar with a
 * reason instead of letting Ctrl+F silently search the wrong surface.
 */
export function findProviderFor(
  registry: RendererRegistry,
  panelId: string,
): FindProviderContribution | null {
  return listFindProviders(registry).find((p) => p.panelId === panelId) ?? null;
}

/** `unavailableKey` through the boundary: a throw counts as "unavailable". */
export function findUnavailableKey(p: FindProviderContribution, ctx: FindContext): string | null {
  return safely(p.manifest.id, 'unavailableKey()', () => p.unavailableKey(ctx), 'find.unavailable.failed');
}

// ---------------------------------------------------------------------------
// Session view — the transcript engine (P2-E17-01)
// ---------------------------------------------------------------------------

function feedSurface(ctx: FindContext): FeedFindSurface | null {
  return ctx.surface?.kind === 'feed' ? (ctx.surface as FeedFindSurface) : null;
}

/**
 * `2026-08-13T09:41:07.113Z` → `09:41`.
 *
 * Formatted in the APP's language, not the OS's: every other user-facing
 * string here routes through i18next, and an interface running in `pseudo`
 * (or, later, a real second locale) that printed OS-locale times would be
 * quietly inconsistent with itself. Falls back to the platform default if the
 * tag is one `Intl` will not take, which is what makes this safe to call with
 * whatever `i18n.language` happens to be.
 */
function hitTime(ts: string | undefined, locale?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleTimeString(locale || undefined, { timeStyle: 'short' });
  } catch {
    return d.toLocaleTimeString(undefined, { timeStyle: 'short' });
  }
}

/**
 * The engine's answer, in the bar's vocabulary.
 *
 * The one rule that matters here: **`seq === undefined` (with the session's
 * group aligned) is the ONLY "cannot jump" signal**, and it is NOT the same
 * question as `earlierThanLoaded`. E17-01's wire comment spells out the three
 * ways a hit arrives with no seq — evicted, newer than the drained window, or
 * alignment refused — and only the first earns the "earlier than the loaded
 * view" marker. Marking the other two would be a confident lie about where in
 * the session the user is standing.
 */
export function hitsFromTranscript(
  res: TranscriptSearchResult,
  sessionId: string,
  locale?: string,
): FindResults {
  const group = res.groups.find((g) => g.sessionId === sessionId);
  const hits: FindHit[] = res.hits
    .filter((h) => h.sessionId === sessionId)
    .map((h, i) => {
      const time = hitTime(h.ts, locale);
      const hit: FindHit = {
        // POSITIONAL, and it has to be: `matchStart` is an offset into the
        // SNIPPET, not into the field, so the engine's 120-character context
        // window pins it at 121 for every match past the first 120 characters
        // of a long tool output — three matches in one `tool.out` would share
        // one id and collide as React keys. Unique within one result set is
        // all this promises, and all the bar needs.
        id: `${h.blockIndex}:${h.field}:${i}`,
        snippet: h.snippet,
        matchStart: h.matchStart,
        matchLength: h.matchLength,
        jumpable: typeof h.seq === 'number',
        earlierThanLoaded: h.earlierThanLoaded,
        metaKey: time ? 'find.hitMeta' : 'find.hitMetaNoTime',
        metaParams: time ? { kind: h.kind, time } : { kind: h.kind },
        ref: h.seq,
      };
      return hit;
    });

  // Order matters: the loudest true thing wins the one line the bar has.
  let notice: FindResults['notice'];
  if (res.error?.code === 'bad-pattern') {
    notice = { key: 'find.notice.badPattern', tone: 'error' };
  } else if (res.error?.code === 'timed-out') {
    notice = { key: 'find.notice.timedOut', tone: 'error' };
  } else if (group && !group.searched) {
    notice = { key: 'find.notice.noTranscript', tone: 'info' };
  } else if (group && !group.aligned && hits.length > 0) {
    // Every hit is snippet-only. Today this is the NORMAL case for a Direct
    // (stream) session — E17-01 records why: `StreamFeed` stamps blocks with
    // their arrival time rather than the CLI's, so the file and the feed
    // cannot be lined up. Saying so is the difference between a boundary and
    // a dead click.
    notice = { key: 'find.notice.cannotJump', tone: 'info' };
  } else if (res.truncated) {
    notice = { key: 'find.notice.truncated', params: { shown: hits.length }, tone: 'info' };
  }

  return { hits, total: group?.hits ?? hits.length, truncated: res.truncated, notice };
}

export const sessionFindProvider: FindProviderContribution = {
  manifest: manifest('find-session', 'Session view find'),
  panelId: 'feed',
  labelKey: 'grid.viewSession',
  order: 10,
  mode: 'bar',
  unavailableKey: (ctx) => (ctx.sessionId ? null : 'find.unavailable.noSession'),
  async search(ctx: FindContext, query: FindQuery): Promise<FindResults> {
    // Scope is a LIST in the wire type (§5.31's fourth decision — §10's global
    // search is this call with more ids). The bar passes exactly one, and that
    // one is the focused card's: the "never matches another card" guarantee
    // reduced to a single expression.
    const res = await window.switchboard.transcripts.search({
      sessionIds: [ctx.sessionId],
      query: { term: query.term, caseSensitive: query.caseSensitive, wholeWord: query.wholeWord },
      limit: 500,
    });
    // A refused capability resolves to a non-result rather than rejecting
    // (shared/ipc/refusal) — treat anything that is not the shape we asked for
    // as "could not search", never as "no matches".
    if (!res || !Array.isArray(res.hits)) {
      return { hits: [], total: 0, truncated: false, notice: { key: 'find.notice.failed', tone: 'error' } };
    }
    return hitsFromTranscript(res, ctx.sessionId, ctx.locale);
  },
  reveal(ctx: FindContext, hit: FindHit): boolean {
    if (typeof hit.ref !== 'number') return false;
    return feedSurface(ctx)?.jumpTo(hit.ref) ?? false;
  },
  clear(ctx: FindContext): void {
    feedSurface(ctx)?.clear();
  },
};

// ---------------------------------------------------------------------------
// Changes — Monaco's own find, delegated
// ---------------------------------------------------------------------------

function monacoSurface(ctx: FindContext): MonacoFindSurface | null {
  return ctx.surface?.kind === 'monaco' ? (ctx.surface as MonacoFindSurface) : null;
}

export const changesFindProvider: FindProviderContribution = {
  manifest: manifest('find-changes', 'Changes find (Monaco)'),
  panelId: 'diff',
  labelKey: 'grid.viewDiff',
  order: 20,
  // The one `delegated` registrant, and the reason the mode exists. Monaco's
  // find is a mature editor find — regex, whole word, replace, match
  // decorations down the scrollbar. Wrapping our bar around it would give the
  // user two Escape targets and two match counts over one document.
  mode: 'delegated',
  // The pane builds its editor on mount but selects no file, so "a surface
  // exists" is NOT the same question as "there is something to search". Asking
  // the surface itself is what keeps the greyed message honest — and reachable:
  // without `ready()` the default state of the tab would delegate successfully
  // into a model-less editor, close our bar, and open nothing at all.
  unavailableKey: (ctx) => (monacoSurface(ctx)?.ready() ? null : 'find.unavailable.diffNotReady'),
  delegate(ctx: FindContext, query: FindQuery): boolean {
    return monacoSurface(ctx)?.openFind(query.term) ?? false;
  },
};

// ---------------------------------------------------------------------------
// Terminal — xterm's scrollback (P2-E17-03)
// ---------------------------------------------------------------------------

function terminalSurface(ctx: FindContext): TerminalFindSurface | null {
  return ctx.surface?.kind === 'terminal' ? (ctx.surface as TerminalFindSurface) : null;
}

export const terminalFindProvider: FindProviderContribution = {
  manifest: manifest('find-terminal', 'Terminal find (scrollback)'),
  panelId: 'terminal',
  // NOT `grid.viewTerminal` ("Terminal"), which is what the tab is called.
  // §5.31's done-when is that a **0 in this group never implies absence**: the
  // terminal holds 5,000 ring-buffered lines and the transcript holds the
  // session, so "0 in Terminal" next to "12 in Session" would read as "it
  // isn't in the terminal" when the truth is "it isn't in the last 5,000
  // lines". The label carries the depth.
  labelKey: 'find.group.terminal',
  order: 30,
  mode: 'bar',
  // A STREAM session has no PTY and renders a notice instead of an xterm
  // (`panels.tsx`), so it never publishes a surface at all — there is nothing
  // to search and the reason has to say so rather than reporting a confident 0.
  unavailableKey: (ctx) => (terminalSurface(ctx)?.ready() ? null : 'find.unavailable.noTerminal'),
  search(ctx: FindContext, query: FindQuery): Promise<FindResults> {
    const surface = terminalSurface(ctx);
    if (!surface) {
      return Promise.resolve({
        hits: [],
        total: 0,
        truncated: false,
        notice: { key: 'find.notice.failed', tone: 'error' },
      });
    }
    // Synchronous — the buffer is in this process. The promise is the seam's
    // shape, not a round trip.
    const out = surface.search({
      term: query.term,
      caseSensitive: query.caseSensitive,
      wholeWord: query.wholeWord,
    });
    const hits: FindHit[] = out.matches.map((m) => {
      const { snippet, matchStart } = snippetAround(m.line, m.offset, m.length);
      return {
        // (row, col) is unique per match within one buffer, and unlike the
        // transcript's ids it is not positional — so it survives a re-search
        // that finds one fewer match above it
        id: `t${m.row}:${m.col}`,
        snippet,
        matchStart,
        matchLength: m.length,
        // every terminal hit IS on screen-able: xterm keeps the whole
        // scrollback and `scrollToLine` reaches all of it. This is the one
        // group with no §5.31 v1 boundary.
        jumpable: true,
        earlierThanLoaded: false,
        metaKey: 'find.hitMetaTerminal',
        metaParams: { line: m.row + 1 },
        ref: m,
      };
    });
    return Promise.resolve({
      hits,
      total: out.total,
      truncated: out.truncated,
      notice: out.truncated
        ? { key: 'find.notice.truncated', params: { shown: hits.length }, tone: 'info' }
        : undefined,
    });
  },
  reveal(ctx: FindContext, hit: FindHit): boolean {
    const m = hit.ref as TerminalMatch | undefined;
    if (!m || typeof m.row !== 'number') return false;
    return terminalSurface(ctx)?.reveal(m) ?? false;
  },
  clear(ctx: FindContext): void {
    terminalSurface(ctx)?.clear();
  },
};

export const findProviders: FindProviderContribution[] = [
  sessionFindProvider,
  changesFindProvider,
  terminalFindProvider,
];

// ---------------------------------------------------------------------------
// CTRL+F INSIDE A FOCUSED TERMINAL: STILL NOT CLAIMED, AND THAT IS THE ANSWER
// (P2-E17-03, #415 — decided, not deferred).
//
// E17-02's note here said adding `Mod+F` to `shared/terminal-accelerators.ts`
// "belongs to E17-03". This is E17-03, and the answer is **no**: that file's
// growth rule is written down, and Ctrl+F fails four of its five clauses.
//
//   Rule 2 names the control keys a terminal line editor owns and lists
//     Ctrl+F among them, by name.
//   Rule 1 fails on evidence, not on principle. Read off the shipped binary
//     (claude 2.1.226, 2026-08-13) the same way #90 read it: its keybinding
//     table contains `"ctrl+f":"scroll:fullPageDown"`, next to ctrl+b/d/u for
//     the other three page moves. The CLI does want this key, and claiming it
//     would silently break paging in every hosted session.
//   Rule 3 asks that the command be otherwise unreachable from a terminal;
//     it is not (see below).
//   Rule 4 asks why the palette is not good enough; it is.
//
// "If any of the five is arguable, the answer is no." Claiming it would take a
// working keystroke away from every hosted CLI for the rest of the product's
// life, which is the exact tax P7 exists to refuse.
//
// SO WHAT REACHES THE TERMINAL GROUP INSTEAD, and it is not a consolation
// prize: the bar searches EVERY registrant on the card, so Ctrl+F pressed
// anywhere else on the card — the feed, the composer, the tab strip — counts
// and steps the terminal's scrollback too. From inside the xterm itself,
// Ctrl+Shift+P → "Find in session" is the route, which is the one chord the
// allowlist exists to preserve. Documented in `docs/manual/16-find.md` so it
// is a boundary the user is told about, not one they discover.
//
// ---------------------------------------------------------------------------
// REGISTERING THE ONE THAT IS NOT HERE YET
//
// It is an addition to this file plus a `publishFindSurface` effect in the
// panel's own component. Nothing in the bar, the point or `bootstrap.ts`
// changes shape.
//
// **Document viewer (§5.30).** It IS on main now (#433 / P2-E16-02), and it
// already has a working Ctrl+F of its own — correctly scoped to its own
// container, for the same reason this point exists: its `lib/document-find.ts`
// header cites §5.30's correction that `findInPage` "would cheerfully match
// text in three other sessions' panes". So there is **no user-visible gap**
// here, only a seam not yet joined, and that module says out loud that it is
// meant to become the body of this provider.
//
// It is NOT wired here, because it is not the ~15-line addition the rest of
// this recipe describes — two structural things are in the way, and both are
// bigger than a registrant:
//   1. **The viewer is not a session-card tab.** It is its own dockview panel
//      (`SessionGrid`'s `documentViewer` component), so there is no `PanelId`
//      for `findProviderFor` to match, `GridController.activeCardId()` answers
//      null while it has focus (its panel id is not `session-*`), and the bar
//      is rendered by `SessionCardPanel` from a session's context. Dispatching
//      to a non-card panel means teaching the command what "the focused
//      surface" is when it is not a session — a §5.8 question, not a find one.
//   2. Doing it right also **deletes ~90 lines of working UI** from the viewer
//      (its own bar, four pieces of state and a keydown handler) and re-hangs
//      them on `FindSurface`. That is a change to the viewer's own component,
//      which is its owner's call rather than a merge-time drive-by.
// Both belong on P2-E16's follow-up (#411), with this file's contract as the
// target. When it lands, `applyMatches` / `focusMatch` / `clearMatches` are
// the provider's `search` and `reveal` almost verbatim.
// ---------------------------------------------------------------------------
