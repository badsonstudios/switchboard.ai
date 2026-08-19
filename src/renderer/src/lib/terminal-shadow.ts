// Searching MAIN'S RING BUFFER instead of the pane you happen to be looking at
// (#517, follow-up to P2-E17-03/#415, §5.31).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM THIS EXISTS FOR
//
// S-07's verdict is that a hidden terminal pane is INGEST-ONLY: main keeps the
// PTY's scrollback in a ring buffer, and the renderer's xterm is attached and
// fed only while its tab is on screen (`TerminalPane`). The Session view is the
// default tab, so on a card whose Terminal has never been opened the window's
// own copy of the output is genuinely EMPTY — while main's is complete and a
// second old.
//
// #516 shipped find against the renderer's xterm and reported that honestly:
// rather than print "0 in Terminal (scrollback only)" about a buffer with no
// lines, it withheld the group and said "open the Terminal tab". Honest, and
// narrower than it needed to be. This module searches the buffer that actually
// has the answer.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A TERMINAL AND NOT A `String.indexOf`
//
// What main holds is BYTES — the raw stream the CLI wrote, escape sequences,
// carriage-return overwrites, cursor jumps and all. `\x1b[32mERROR\x1b[0m` is
// not the text `ERROR`, a progress meter rewrites one row forty times, and a
// full-screen TUI addresses cells directly. Searching those bytes with a string
// scan would find matches the user never saw and miss ones they did.
//
// Turning that stream into lines is a terminal emulator's whole job, and the
// hard constraint is explicit about it: **the terminal is a transport — main's
// ring buffer is our copy of what the CLI printed; searching it is honest,
// interpreting it is not.** So we do not interpret. We replay the bytes into a
// REAL xterm — the same version, the same options, the same `SearchAddon` the
// visible pane uses — and search that. No second search implementation, no VT
// parser of our own, and by construction the same answer the pane would give if
// you opened the tab.
//
// THE TERMINAL IS OFF-SCREEN, NOT HEADLESS, and that is not a preference:
// `SearchAddon.findNext` calls `Terminal.select()`, which goes through the
// SELECTION SERVICE — a browser service that only exists after `open()`. Probed
// 2026-08-19 rather than assumed: on a terminal that was never opened,
// `findNext` throws `Cannot read properties of undefined (reading
// 'setSelection')`. So the host is a real element, positioned out of the
// viewport with a real size (a detached or `display:none` host measures 0x0,
// which is the NaN-dimensions hazard `TerminalPane`'s `safeFit` guards
// against), `inert` and `aria-hidden` so it is in neither the tab order nor the
// accessibility tree.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT COSTS, AND THE TWO THINGS THAT BOUND IT
//
// A refresh re-reads up to the ring buffer's whole 2 MB and re-parses it. Two
// bounds:
//
//  • FRESHNESS WINDOW. The find bar re-searches on a 200 ms debounce, i.e.
//    several times through a typed word, and refetching 2 MB per keystroke
//    would be absurd. A load is reused for `freshMs` (1 s by default), so a
//    burst of typing costs one or two. The consequence is stated rather than
//    hidden: an answer from this path can be up to a second stale. That is
//    three orders of magnitude better than the status quo it replaces (a buffer
//    that was empty forever), and the honesty label — "scrollback only" — is
//    unchanged.
//
// ONE ASYMMETRY, RECORDED RATHER THAN HIDDEN: this replay sees
// min(the ring buffer's 2 MB, 5,000 lines); the VISIBLE pane sees 5,000 lines
// of everything it received while it was attached, which can be more once bytes
// have aged out of the ring. At ~400 bytes a line of coloured TUI output — very
// ordinary for this CLI — 2 MB is about 5,000 lines, so above that the two
// paths can differ and a count can GROW when you open the tab. Both numbers are
// honest about their own depth, and the group's label says "scrollback only"
// either way; there is no third buffer to reconcile them against.
//
//  • LAZY AND SHORT-LIVED. Nothing is built until a hidden terminal is actually
//    searched, and `TerminalPane` disposes it when find clears or the pane
//    unmounts. A card nobody has searched pays nothing.
//
// Decorations are OFF on this path (`searchTerminal(..., decorate=false)`):
// painting up to 1,000 highlights onto a terminal with no viewport, which is
// about to be thrown away, buys nothing. The matches and the count are
// identical — it is the same walk the visible pane falls back to when the
// proposed API is unavailable.
import { Terminal } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import type { PtySnapshot } from '../../../shared/ipc/pty';
import {
  searchTerminal,
  TERMINAL_SCROLLBACK,
  type TerminalSearchOutcome,
  type TerminalSearchQuery,
} from './terminal-find';

/** How long a load is reused before the ring buffer is read again. */
export const SHADOW_FRESH_MS = 1_000;

/**
 * Where the off-screen host is parked. Out of the viewport, out of the way.
 *
 * PHYSICAL `left`, not `inset-inline-start`, which is the one place in this
 * codebase that rule is inverted: under RTL the logical property resolves to
 * `right`, which would put the host 99999px past the body's right edge — and
 * that IS scrollable overflow, where a negative `left` is not.
 */
const HOST_STYLE =
  'position:absolute;top:0;left:-99999px;' +
  'inline-size:960px;block-size:600px;pointer-events:none;';

export interface TerminalShadowOptions {
  /** read main's ring buffer; `null` means there is no PTY to read */
  read: () => Promise<PtySnapshot | null>;
  /**
   * Which document the off-screen host belongs in.
   *
   * A popped-out card portals its whole tree into a SECOND OS window, and the
   * bar already learned that lesson the hard way (`FindBar` reads
   * `ownerDocument` for the same reason). Nothing breaks if this is wrong —
   * the shadow is invisible and self-consistent either way — but a scratch
   * element belongs in the window whose terminal it is standing in for.
   */
  doc?: () => Document;
  /** override the freshness window (tests) */
  freshMs?: number;
  /** override the clock (tests) */
  now?: () => number;
}

/**
 * An off-screen replay of one PTY's scrollback, searchable.
 *
 * One per terminal pane, owned by the pane. Every method is safe to call after
 * `dispose()` — a search then answers `null`, the same as "there is no PTY",
 * because a disposed shadow has not looked either.
 */
export class TerminalShadow {
  private host: HTMLDivElement | null = null;
  private term: Terminal | null = null;
  private addon: SearchAddon | null = null;
  private loadedAt = Number.NEGATIVE_INFINITY;
  /** serialises refreshes: two debounced searches must not interleave writes */
  private pending: Promise<boolean> | null = null;
  private disposed = false;
  /**
   * Is a replay currently being parsed?
   *
   * xterm slices a `write` into ~12 ms macrotasks, so a 2 MB replay is spread
   * over a few hundred milliseconds of timers — and its `WriteBuffer` has no
   * post-dispose guard, so disposing the terminal underneath one leaves those
   * timers calling the parser on a corpse. Out of our `try`, too: a throw
   * inside xterm's own `setTimeout` is not something a `catch` here can reach,
   * which turns a teardown race into the uncaught error fail-open exists to
   * prevent. So teardown WAITS for the write, and `load()` performs it.
   */
  private writing = false;

  constructor(private readonly opts: TerminalShadowOptions) {}

  /**
   * Every match in main's copy of the scrollback.
   *
   * `null` — deliberately not an empty outcome — when we could NOT look: no PTY
   * under that id, or the read failed. The caller must render that differently
   * from "we looked and found none", which is the whole lesson of #516's
   * blocker: a zero that means "we did not look" is the one answer §5.31 says
   * find must never give.
   */
  async search(query: TerminalSearchQuery): Promise<TerminalSearchOutcome | null> {
    if (this.disposed) return null;
    const ok = await this.refresh();
    if (!ok || this.disposed) return null;
    const term = this.term;
    const addon = this.addon;
    if (!term || !addon) return null;
    // undecorated: nothing can see this terminal (see the header)
    return searchTerminal(term, addon, query, undefined, undefined, false);
  }

  /**
   * Drop the terminal and its host. Idempotent, and safe DURING a replay.
   *
   * When a write is in flight the terminal is left standing and `load()` tears
   * it down the moment the parse finishes (see `writing`). The shadow is dead
   * either way — `disposed` is set here, so a search that was awaiting the
   * refresh answers `null` rather than reading a buffer nobody wants.
   */
  dispose(): void {
    this.disposed = true;
    this.pending = null;
    if (this.writing) return;
    this.teardown();
  }

  private teardown(): void {
    try {
      this.term?.dispose();
    } catch {
      /* fail-open: a failed teardown must not take find (or the pane) with it */
    }
    this.term = null;
    this.addon = null;
    this.host?.remove();
    this.host = null;
  }

  /** Test seam: has a terminal been built yet? */
  get built(): boolean {
    return !!this.term;
  }

  /**
   * Bring the replay up to date, at most once per freshness window.
   *
   * Returns whether there is something to search. Concurrent callers share one
   * in-flight refresh — the bar can issue a second search while the first is
   * still writing, and two `reset()`-then-`write()` pairs interleaved would
   * produce a buffer that is neither snapshot.
   */
  private refresh(): Promise<boolean> {
    if (this.pending) return this.pending;
    const now = this.opts.now ?? Date.now;
    const fresh = this.opts.freshMs ?? SHADOW_FRESH_MS;
    if (this.term && now() - this.loadedAt < fresh) return Promise.resolve(true);
    const run = this.load().finally(() => {
      if (this.pending === run) this.pending = null;
    });
    this.pending = run;
    return run;
  }

  private async load(): Promise<boolean> {
    let snap: PtySnapshot | null = null;
    try {
      snap = await this.opts.read();
    } catch (err) {
      // fail-open, and fail HONESTLY: `false` becomes "could not search", never
      // a zero (#516's blocker, one layer down)
      console.warn('[find] could not read the terminal scrollback', err);
      return false;
    }
    if (!snap || this.disposed) return false;
    const term = this.ensureTerminal(snap);
    if (!term) return false;
    // Replay at the width the CLI wrote for. A resize is cheaper than a rebuild
    // and keeps the addon loaded, and it happens BEFORE the write so no row is
    // ever reflowed after the positions the search reports were taken.
    try {
      if (term.cols !== snap.cols || term.rows !== snap.rows) term.resize(snap.cols, snap.rows);
    } catch (err) {
      // a geometry we cannot take is not worth losing the search over: the
      // wrapping may differ from the pane's, the matches are still real
      console.warn('[find] shadow terminal resize refused', err);
    }
    try {
      this.writing = true;
      term.reset(); // the snapshot is the WHOLE buffer, not a delta
      await new Promise<void>((resolve) => term.write(snap.snapshot, resolve));
    } catch (err) {
      console.warn('[find] could not replay the terminal scrollback', err);
      return false;
    } finally {
      this.writing = false;
      // a `dispose()` that arrived mid-parse deferred to us; do it now that the
      // parser has stopped touching this terminal
      if (this.disposed) this.teardown();
    }
    if (this.disposed) return false;
    this.loadedAt = (this.opts.now ?? Date.now)();
    return true;
  }

  private ensureTerminal(snap: PtySnapshot): Terminal | null {
    if (this.term) return this.term;
    let host: HTMLDivElement | null = null;
    let term: Terminal | null = null;
    const doc = this.opts.doc?.() ?? document;
    try {
      host = doc.createElement('div');
      host.setAttribute('style', HOST_STYLE);
      // not in the tab order, not in the a11y tree: this is scratch space, not
      // a second terminal the user can land in
      host.setAttribute('aria-hidden', 'true');
      host.inert = true;
      doc.body.appendChild(host);
      term = new Terminal({
        cols: snap.cols,
        rows: snap.rows,
        // the SAME depth as the visible pane, from one constant: the group
        // promises "scrollback only", which is one depth and not two
        scrollback: TERMINAL_SCROLLBACK,
        // the same flag the visible pane sets, for the same reason: without it
        // the addon THROWS rather than degrading (see `lib/terminal-find.ts`).
        // We never ask for decorations here, but the flag gates API checks
        // only and costs nothing.
        allowProposedApi: true,
      });
      const addon = new SearchAddon();
      term.loadAddon(addon);
      term.open(host);
      this.host = host;
      this.term = term;
      this.addon = addon;
      return term;
    } catch (err) {
      // half-built is still built: a `Terminal` that was constructed (and
      // possibly `open()`ed) before the throw owns timers and listeners of its
      // own, and dropping the reference does not stop them
      console.warn('[find] could not build the off-screen terminal', err);
      try {
        term?.dispose();
      } catch {
        /* fail-open */
      }
      host?.remove();
      this.host = null;
      return null;
    }
  }
}
