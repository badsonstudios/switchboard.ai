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
// TWO OF §5.31'S FOUR NAMED REGISTRANTS SHIP HERE, and the gap is deliberate,
// not an oversight (see docs/extensibility.md's roster):
//
//   • `panel-session` → the E17-01 transcript engine. The flagship.
//   • `panel-changes` → DELEGATES to Monaco's own find. §5.31 names it as a
//     thing not to reimplement, and half-reimplementing it would be worse than
//     either whole: our chrome over its search means two sets of keybindings
//     over one editor.
//   • the §5.30 document viewer — its PR is not merged; the registrant is a
//     three-line addition on top of this file (see the module footer).
//   • the Terminal — P2-E17-03's item, which depends on this one.
//
// Both absent registrants have a written registration recipe at the bottom of
// this file rather than a promise in a plan.
import type {
  FindContext,
  FindHit,
  FindProviderContribution,
  FindQuery,
  FindResults,
} from './contributions';
import { manifestFor } from './contributions';
import type { FeedFindSurface, MonacoFindSurface } from '../lib/find-surfaces';
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

export const findProviders: FindProviderContribution[] = [sessionFindProvider, changesFindProvider];

// ---------------------------------------------------------------------------
// REGISTERING THE TWO THAT ARE NOT HERE YET
//
// Both are additions to this file plus a `publishFindSurface` effect in the
// panel's own component. Nothing in the bar, the point or `bootstrap.ts`
// changes shape.
//
// **Terminal (P2-E17-03, #415).** `mode: 'bar'`, `panelId: 'terminal'`.
// `TerminalPane` publishes `{ kind: 'terminal', … }` under
// `findSurfaceKey(cardId, 'terminal')` wrapping `@xterm/addon-search` —
// which means `TerminalPane` needs the `cardId` prop it does not take today
// (`panels.tsx` has it on the PanelContext). Two things that item must NOT
// inherit by accident:
//   1. `unavailableKey` must return a reason for a STREAM session — there is
//      no PTY, so there is no scrollback, and the panel already renders a
//      notice instead of a terminal.
//   2. The bar must label that group "scrollback only" (§5.31): xterm sees
//      5,000 lines behind a byte cap and the transcript sees everything, so
//      one number over two depths would be a small lie. `labelKey` is the
//      hook — point it at a key that says so.
// Note also that **Ctrl+F does not currently reach a focused xterm at all**:
// `lib/commands.classifyTarget` gives the terminal every key it can see, and
// only the chords claimed in the browser process (`shared/terminal-accelerators`)
// survive that. Adding `Mod+F` to that allowlist belongs to E17-03, with the
// find command's `dispatchAccelerator` path, and is deliberately not done here.
//
// **Document viewer (§5.30, the #433 follow-up).** `mode: 'bar'` over the
// rendered document, or `mode: 'delegated'` if the viewer ends up embedding an
// editor with a find of its own. It publishes under
// `findSurfaceKey(cardId, '<its panel id>')`; `unavailableKey` should name the
// "no document open" state rather than returning a provider that finds nothing.
// ---------------------------------------------------------------------------
