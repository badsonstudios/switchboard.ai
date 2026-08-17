// Feed view v1 (P2-E12-06, §5.10): the rendered, READ-ONLY view of a session,
// built from transcript-derived blocks. Assistant prose renders as sanitized
// markdown; tool calls are one-line collapsed rows (click to expand); thinking
// is folded; sidechain (subagent) blocks indent behind a dashed border.
// Guardrail (§5.10 Non-Goals): no input surface of any kind lives here.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { blockVisible, FeedBlockDto, showsTimelineDot, upsertBlock, Verbosity } from '../lib/feed';
import { feedKeyAction, FEED_STOP_SELECTOR } from '../lib/feed-keys';
import {
  FeedReveal,
  FeedRevealProvider,
  FEED_SEQ_ATTR,
  NO_REVEAL,
  useCurrentHit,
} from '../lib/feed-reveal';
import { findSurfaceKey, publishFindSurface, type FeedFindSurface } from '../lib/find-surfaces';
import { clearFeedMarks, markFeedMatches, moveCurrentMark, sameFindQuery } from '../lib/feed-marks';
import type { FindQuery } from '../extensibility/contributions';
import { emptyStateCopy } from '../lib/binding-copy';
import { terminalHandoff, TerminalHandoff, toneToken } from '../lib/terminal-handoff';
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestion } from '../../../shared/ask-user-question';
import { QuestionPanel } from './QuestionPanel';
import type { BindingDiagnostics, BindingState } from '../../../shared/transcripts';
import { rendererRegistry } from '../extensibility/registry-instance';
import { renderFeedBlock } from '../extensibility/feed-render';
import { uiFlush, uiGet, uiSet } from '../lib/ui-state';
import { clearDraft, loadDraft, saveDraft } from '../lib/composer-draft';
import { interruptSession, submitPrompt } from '../lib/composer';
import { ComposerAttachments } from './ComposerAttachments';
import {
  Attachment,
  AttachmentRejection,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_PAYLOAD_BYTES,
  MAX_ENCODED_FILE_BYTES,
  filesFrom,
  filesFromDrop,
  formatBytes,
  hasPlainText,
  readAttachments,
  toPromptAttachments,
} from '../lib/composer-attachments';
import {
  COMPOSER_FONT_SIZE,
  COMPOSER_LINE_RATIO,
  composerSize,
  resolveLineHeight,
} from '../lib/composer-size';
import { argumentSummary } from '../lib/permission-batches';
import {
  filterCommands,
  insertCommand,
  isCompleteCommand,
  SlashCommand,
  slashToken,
} from '../../../shared/slash-commands';

export type { FeedBlockDto } from '../lib/feed';

function Block({ b }: { b: FeedBlockDto }): React.JSX.Element {
  // Resolved, not switched (§5.23): this used to be a seven-branch ternary
  // naming every renderer. A new block shape is now a contribution plus a
  // bootstrap line, and this file is not touched.
  const inner = renderFeedBlock(rendererRegistry, b);
  const dot = showsTimelineDot(b.kind);
  // The block find is sitting on (P2-E17-02). An OUTLINE rather than a
  // background: the block already paints its own surfaces (tool boxes, diff
  // rows) and tinting behind them would recolour half of them and none of the
  // rest. `outline` also costs no layout, so landing on a hit does not reflow
  // the conversation under the user's eye.
  const hit = useCurrentHit(b.seq);
  return (
    <div
      data-feed-block={b.kind}
      // how a jump finds this block's element — see `FeedFindSurface.jumpTo`
      {...{ [FEED_SEQ_ATTR]: String(b.seq) }}
      style={{
        display: 'flex',
        gap: 8,
        padding: '4px 8px',
        ...(hit
          ? {
              outline: '2px solid var(--status-working-ink)',
              outlineOffset: -2,
              borderRadius: 'var(--radius-chip)',
            }
          : {}),
        ...(b.sidechain
          ? {
              marginInlineStart: 14,
              borderInlineStart: '1px dashed var(--faint)',
              opacity: 0.85,
            }
          : {}),
      }}
    >
      {/* Timeline dot gutter (E10-06, extension reference). The GUTTER is
          unconditional and the DOT is not (#91): assistant prose gets the same
          6px of reserved column so the left edge stays flush with the boxed
          blocks above it, but no marker — see `showsTimelineDot`. */}
      <span
        {...(dot ? { 'data-feed-dot': b.kind } : {})}
        aria-hidden
        style={{
          inlineSize: 6,
          blockSize: 6,
          flexShrink: 0,
          marginBlockStart: 5,
          ...(dot
            ? {
                borderRadius: '50%',
                background: b.kind === 'user' ? 'var(--status-needs-input)' : 'var(--faint)',
              }
            : {}),
        }}
      />
      <div style={{ flex: 1, minInlineSize: 0 }}>{inner}</div>
    </div>
  );
}

/**
 * What an empty Session view says (P2-E15-10, §5.26). It used to say one thing
 * — "No activity yet" — whether the session had never been prompted, was still
 * being located, or had failed to bind at all. That is the primary working
 * surface staying silent about its own plumbing (AR-P1-8), so it now names
 * which of the three it is, and only the last one looks like a problem.
 */
function EmptyState({
  binding,
  diag,
  transport,
}: {
  binding: BindingState;
  diag: BindingDiagnostics | null;
  /** which transport hosts the session (#447) — the fail-open line must not
   *  send a Direct user to a Terminal tab that has no terminal in it */
  transport?: 'pty' | 'stream';
}): React.JSX.Element {
  const { t } = useTranslation();
  const copy = emptyStateCopy(binding, diag, transport);
  const path = diag?.projectsRoot ?? '';
  return (
    <div
      data-binding={binding}
      style={{
        color: 'var(--faint)',
        fontSize: 11,
        textAlign: 'center',
        marginBlockStart: 24,
        marginInline: 'auto',
        maxInlineSize: 420,
        paddingInline: 12,
        lineHeight: 1.6,
      }}
    >
      <div
        style={{
          // `-ink`, not the plain hue: tokens.css says in as many words that
          // the --status-* colours are tuned for DOTS AND RINGS and that text
          // needs its own per-theme value. This is 11px bold body copy, and
          // the raw hue measures ~3.2:1 on daylight — below the 4.5:1 the
          // token drift test enforces for exactly this token.
          color: copy.problem ? 'var(--status-crashed-ink)' : 'var(--muted)',
          fontWeight: copy.problem ? 700 : 400,
          marginBlockEnd: 4,
        }}
      >
        {t(copy.title)}
      </div>
      <div style={{ wordBreak: 'break-word' }}>{t(copy.detail, { path })}</div>
      {/* fail-open, said out loud: our binding failing never stops the CLI, and
          a user staring at an error needs to know where the session still is.
          WHICH sentence that is depends on the transport — see `binding-copy` */}
      {copy.fallback && <div style={{ marginBlockStart: 6 }}>{t(copy.fallback)}</div>}
    </div>
  );
}

export function FeedView(props: {
  sessionId: string;
  /** durable key for per-card preferences (the live id churns on resume) */
  cardId?: string;
  /**
   * The session's title (#196). It NAMES the conversation landmark: several
   * cards are visible at once, and a landmark called "Conversation" on every
   * one of them leaves a screen-reader user with N identical entries in the
   * landmark list and no way to tell which session they are about to read.
   *
   * Absent — or empty, which a workspace written before #294 can still hold —
   * falls back to the bare name. An honest generic beats a landmark called
   * "undefined", and beats announcing a title that is not there.
   */
  title?: string;
  visible: boolean;
  /** bumped when dockview reattached this panel's DOM (#555) — see
   *  `PanelContext.dockEpoch`, and the effect that reads it below */
  dockEpoch?: number;
  /** current session status — drives the working banner and the handoff bar */
  status?: string;
  /** an approval was answered moments ago and the status has not caught up
   *  (P2 #125) — suppresses the handoff bar so clicking Allow never flashes
   *  "switchboard can't answer this" where the button just was */
  recentlyDecided?: boolean;
  /** transcript binding state (P2-E15-10) — decides what an EMPTY feed says */
  binding?: BindingState;
  bindingDiag?: BindingDiagnostics | null;
  /** the Feed never accepts input; this jumps to the Terminal tab (§5.10) */
  onJumpToTerminal?: () => void;
  /** composer options row data (E10-05) */
  autonomy?: string;
  model?: string;
  onCycleAutonomy?: () => void;
  /** held permission (E10-04) — the bar renders just above the composer */
  approval?: {
    requestId: string;
    tool: string;
    input: Record<string, unknown>;
    /** stream transport only (P2-E18-07) */
    reason?: string;
  } | null;
  /** more holds waiting behind this one (review P0#4) */
  approvalQueued?: number;
  /** a held request of this session's is on §5.8's grouped prompt instead
   *  (P2-E9-11) — the question IS answerable, just not from here */
  approvalBatched?: boolean;
  /** which transport hosts this session — the handoff bar must not point at a
   *  terminal that does not exist (P2 #153 follow-up) */
  transport?: 'pty' | 'stream';
  /**
   * `updatedInput` is the `AskUserQuestion` answer (#563) and rides the same
   * decision path everything else uses — a question is answered by allowing the
   * tool call with the answers written into its input, which is the CLI's own
   * design and not a side channel we invented.
   */
  onDecide?: (decision: 'allow' | 'deny', allowAll?: boolean, updatedInput?: unknown) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [blocks, setBlocks] = React.useState<FeedBlockDto[]>([]);
  // /clear executes SILENTLY (empty local-command stdout, no assistant reply
  // — verified vs claude 2.1.218), so without an explicit marker a cleared
  // conversation reads as "nothing happened" (Dan 2026-07-24)
  const [cleared, setCleared] = React.useState(false);
  const [verbosity, setVerbosity] = React.useState<Verbosity>(() => {
    const v = uiGet<string>(`feedVerbosity.${props.cardId ?? ''}`, 'normal');
    return v === 'quiet' || v === 'firehose' ? v : 'normal';
  });
  const pickVerbosity = (v: Verbosity): void => {
    setVerbosity(v);
    if (props.cardId) uiSet(`feedVerbosity.${props.cardId}`, v);
  };
  const bottom = React.useRef<HTMLDivElement | null>(null);
  const pinned = React.useRef(true); // stick to the tail unless the user scrolls up
  const scroller = React.useRef<HTMLDivElement | null>(null);
  // a session stuck in 'starting' usually means the CLI is showing a startup
  // TUI dialog only the Terminal can render (e.g. 2.1.x's resume-from-summary
  // picker — Dan round 4: it was invisible from the Session tab and his
  // composer Enter blindly confirmed it). Hooks aren't up yet, so 'starting'
  // that outlives a normal boot is the only signal we get.
  const [startingLong, setStartingLong] = React.useState(false);
  React.useEffect(() => {
    if (props.status !== 'starting') {
      setStartingLong(false);
      return;
    }
    const id = setTimeout(() => setStartingLong(true), 8_000);
    return () => clearTimeout(id);
  }, [props.status]);
  // Is the held request the CLI's own CHOOSER rather than a permission (#563)?
  //
  // Memoised on the request ID, not on the input object, and the memo is
  // load-bearing rather than an optimisation: `parseAskUserQuestion` returns a
  // FRESH ARRAY every call, and the panel re-seeds its selections whenever that
  // array's identity changes — so parsing inline would wipe a half-answered
  // panel on every unrelated re-render of this component.
  //
  // Keying on the id is sound because a held request is immutable: the id is
  // `stream:<sessionId>:<native>`, unique per request, and its input never
  // changes between arriving and being answered. (`approvalInput` is
  // deliberately not in the deps; eslint's exhaustive-deps plugin isn't
  // installed in this repo, so there is nothing to silence — see App.tsx:473.)
  const approvalId = props.approval?.requestId;
  const approvalTool = props.approval?.tool;
  const approvalInput = props.approval?.input;
  const askQuestions = React.useMemo(
    () =>
      approvalTool === ASK_USER_QUESTION_TOOL ? parseAskUserQuestion(approvalInput ?? {}) : null,
    [approvalId, approvalTool]
  );
  // The CLI is waiting on something we are not allowed to answer for it — a
  // decision it kept (P7), or one our hook path never saw. Rendered as a BAR
  // above the composer (#125), not the 10px header chip it used to be.
  const handoff = terminalHandoff({
    status: props.status,
    // The SAME predicate the approval bar renders on, deliberately written as
    // one expression: if these two ever disagree, the user gets neither
    // surface and is stranded with no affordance at all.
    //
    // …OR the grouped prompt is showing it (P2-E9-11). The question the handoff
    // bar answers is "does the user have somewhere to answer this?", not "is
    // the bar below me drawing it": a batched request has a surface, it is just
    // one card up in the shell. Without this clause a session whose only held
    // request had been grouped would read "switchboard can't answer it, go to
    // the Terminal" while its Allow button sat a few pixels away — #125's
    // defect, one surface over.
    hasApproval: !!(props.approval && props.onDecide) || !!props.approvalBatched,
    // `startingLong` is cleared by an effect, so the first render that sees a
    // new status still has the old flag — without this, one frame can paint
    // the working banner and a "still starting" handoff together.
    startingLong: props.status === 'starting' && startingLong,
    recentlyDecided: !!props.recentlyDecided,
    transport: props.transport,
  });

  React.useEffect(() => {
    let cancelled = false;
    void window.switchboard.transcripts.blocks(props.sessionId).then((b) => {
      if (!cancelled) setBlocks(b as FeedBlockDto[]);
    });
    const off = window.switchboard.transcripts.onBlock((p) => {
      if (p.sessionId !== props.sessionId) return;
      // upsert: the watcher re-emits a block when its OUT / duration lands
      setBlocks((prev) => upsertBlock(prev, p.block as FeedBlockDto));
    });
    // a corrected mis-bind (or /clear) restarts the stream from seq 1 — drop
    // the stolen blocks or the shorter correct transcript leaves the old tail
    const offReset = window.switchboard.transcripts.onReset((p) => {
      if (p.sessionId !== props.sessionId) return;
      setBlocks([]);
      setCleared(p.cause === 'clear'); // a plain rebind clears any stale marker
    });
    return () => {
      cancelled = true;
      off();
      offReset();
    };
  }, [props.sessionId]);
  React.useEffect(() => {
    setCleared(false);
  }, [props.sessionId]);

  // Stay glued to the tail: on backlog load, on every streamed block, and
  // when the card becomes visible again — unless the user scrolled up.
  // Direct scrollTop after a layout frame; scrollIntoView proved flaky for
  // restored sessions with big replayed histories (Dan 2026-07-23: opening
  // a restored card landed at the TOP).
  const autoPin = React.useRef(false); // our own scrolls must not unpin
  const content = React.useRef<HTMLDivElement | null>(null);
  // Where the user was reading. Dockview HIDES a background panel, and a hidden
  // element's scrollTop is reset to 0 by the browser — so coming back to a
  // session you had scrolled up in used to dump you at the very top, with
  // nothing to put you back (the tail-pin only ever knew how to reach the
  // BOTTOM). Dan, 2026-07-26: clicking an Events row scrolled the session to
  // the top. Probed: read at 7014 → switch away → return at 0, and it stayed
  // there because an unpinned view was never restored.
  const lastTop = React.useRef(0);
  // set while a re-shown panel still owes the user their position back
  const owesRestore = React.useRef(false);
  // the scroller had zero height last time we looked — i.e. it was hidden
  const wasCollapsed = React.useRef(false);
  // When the user last actually TOUCHED the scroller. `pinned` used to be
  // derived from a raw measurement, which cannot tell "the user scrolled up"
  // apart from "something above the fold got taller". Dan, 2026-07-26: after
  // allowing a permission the feed sat short of the bottom with output cut
  // off. Probed — the approval bar docks BELOW the scroller, so it shrinks the
  // viewport by ~95px, and any scroll event sampled in that window reads as
  // "95px from the bottom → they must have scrolled up" and unpins the tail
  // for good. Real Claude output reflows constantly (markdown, code, tool
  // results), so it only takes one unlucky sample. Only a real gesture may
  // change the pin now.
  const lastGesture = React.useRef(0);
  const GESTURE_MS = 500;
  const markGesture = React.useCallback(() => {
    lastGesture.current = Date.now();
  }, []);
  /**
   * The way back (#442).
   *
   * `pinned` is a ref, so React cannot see it and nothing on screen ever said
   * whether the view was following the conversation or had been left behind.
   * MEASURED at the CI runner's geometry (1010x657 window, 288px feed, a
   * 2,313px conversation): entering the #174 keyboard walk unpins the tail —
   * `onFeedKeyDown` marks a gesture and the focus scroll is then read as the
   * user's own, which is the rule working as designed — and after that the
   * ONLY ways back are a scroll gesture that lands within 40px of the bottom
   * (mouse wheel, or End/PageDown with focus on the region itself). Inside the
   * walk there is no key that returns to the tail at all: `End` moves to the
   * last EXPANDER, which in a conversation whose tail is prose is nowhere near
   * the last block (measured: scrollTop stayed 0 of 2,201).
   *
   * None of that is wrong — unpinning on a jump is deliberate, and `jumpTo`
   * does it explicitly — but it left a state with no visible exit. This mirror
   * of the ref is what lets one appear.
   */
  const [offTail, setOffTail] = React.useState(false);
  const syncOffTail = React.useCallback((): void => {
    const el = scroller.current;
    if (!el) return;
    // Only when there is somewhere to go back TO. A conversation that fits its
    // pane IS at its tail, so a chip there would be a control that does
    // nothing — and 40px is the same slack the pin rule itself uses, so the
    // two can never disagree about whether the feed overflows.
    setOffTail(!pinned.current && el.scrollHeight > el.clientHeight + 40);
  }, []);
  const pin = React.useCallback((): void => {
    const el = scroller.current;
    if (!el) return;
    autoPin.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => (autoPin.current = false));
  }, []);
  /**
   * What the chip does: take the wheel back. Deliberately NOT `markGesture()` —
   * a gesture window opened here would let the next layout scroll re-derive the
   * pin from raw distance, which is the very trap that strands the view.
   */
  const jumpToLatest = React.useCallback((): void => {
    pinned.current = true;
    owesRestore.current = false;
    lastTop.current = scroller.current?.scrollHeight ?? 0;
    pin();
    setOffTail(false);
    // The control REMOVES ITSELF on success, so something has to catch the
    // focus it was holding — otherwise a keyboard user lands on `<body>` and
    // their next Tab starts from the top of the window (§5.32). The
    // conversation is where they came from and where the news is.
    // `preventScroll`, because focusing the scroller must not undo the scroll
    // this function just performed.
    scroller.current?.focus({ preventScroll: true });
  }, [pin]);
  /** put the scroller where THIS session belongs: glued to the tail if that's
   *  where the user was, otherwise back at the offset they were reading. */
  const restore = React.useCallback((): void => {
    const el = scroller.current;
    // no layout yet (hidden panel, mid-relayout): a write would be a silent
    // no-op, so leave the debt outstanding and let the observer retry
    if (!el || el.clientHeight === 0) return;
    autoPin.current = true;
    el.scrollTop = pinned.current ? el.scrollHeight : lastTop.current;
    requestAnimationFrame(() => (autoPin.current = false));
    owesRestore.current = false;
  }, []);
  React.useEffect(() => {
    if (!props.visible || !pinned.current) return;
    const id = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(id);
  }, [blocks, props.visible, pin]);
  // becoming visible again is when the position was lost — claim the debt and
  // pay it as soon as there's layout to pay it with
  React.useEffect(() => {
    if (!props.visible) return;
    owesRestore.current = true;
    const id = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(id);
  }, [props.visible, restore]);
  /**
   * Put the view back where this session belongs, from whatever just happened
   * to it — the ONE rule, so the resize path and the dock-move path below
   * cannot drift into two different answers about the same scroller (#555).
   */
  const reconcile = React.useCallback((): void => {
    const s = scroller.current;
    if (!s) return;
    // COLLAPSE is the real signal that a position is about to be lost, not
    // props.visible: dockview hides a background panel by collapsing an
    // ANCESTOR, so our visible prop never changes and React never learns the
    // panel went away — but the scroller's own height drops to 0 and comes
    // back, which the resize observer does see.
    if (s.clientHeight === 0) {
      wasCollapsed.current = true;
      return;
    }
    if (wasCollapsed.current) {
      wasCollapsed.current = false;
      owesRestore.current = true;
    }
    if (pinned.current) pin();
    // only while a restore is owed: otherwise every markdown reflow would
    // yank a reading user back to where they started
    else if (owesRestore.current) restore();
    // Backstop for the case above that we CAN'T observe: dockview detaches a
    // background panel outright, and a detached element neither keeps its
    // scrollTop nor reports a zero-height frame — it simply reappears at full
    // height, already back at 0. A remembered position with the scroller
    // sitting at 0 means it was destroyed, not chosen: a user who genuinely
    // scrolls to the top records lastTop 0 through the scroll handler, so
    // this can't fight them.
    else if (lastTop.current > 0 && s.scrollTop === 0 && s.scrollHeight > s.clientHeight) {
      restore();
    }
    // A conversation that GROWS past its pane while the reader is parked is
    // exactly when the way back has to appear, and no scroll event fires for
    // it (#442).
    syncOffTail();
  }, [pin, restore, syncOffTail]);
  // Self-healing pin (Dan round 5: cards you SWITCH to sat at the top after
  // app start): a one-shot pin can land while the panel has no layout yet —
  // dockview shows background panels a frame later, restore relayouts, and
  // markdown reflows — so scrollHeight was 0 and the write was a no-op with
  // nothing left to retry it. Observing the scroller AND its content re-pins
  // on ANY size change while the view is tail-pinned, and settles an
  // outstanding restore the same way.
  React.useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(reconcile);
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [reconcile]);
  /**
   * The move the observers above are blind to (#555).
   *
   * Dockview reattaches a panel's DOM for things that are not renders:
   * activating a group re-runs `openPanel`, which detaches this subtree and
   * appends it again, and a move between groups relocates it wholesale. The
   * browser drops the scrollTop of every scroll container on the way through.
   * React never re-renders — the same elements come back — and NOTHING here
   * hears about it: no scroll event fires, and the panel returns at exactly the
   * size it left, so the resize observer above never delivers and takes its own
   * detach backstop with it.
   *
   * MEASURED, two docked groups and a click on a card's own rail row: scrollTop
   * 1491 -> 0, a `MutationObserver` on the document saw DETACHED/REATTACHED,
   * an `IntersectionObserver` on this element fired once at startup and never
   * again, and the resize observer never fired at all. `pinned` stayed true, so
   * `offTail` stayed false and #442's way back never appeared either — the
   * conversation simply sat at its first message with nothing admitting it.
   *
   * So the card tells us, because the card is what dockview talks to. Twice, a
   * frame apart: the event can land on either side of the DOM move, and the
   * cheap way to be right in both cases is to reconcile now and again after the
   * browser has finished. A reconcile with nothing to fix writes the scrollTop
   * the scroller is already at.
   */
  React.useEffect(() => {
    if (props.dockEpoch === undefined) return;
    reconcile();
    const id = requestAnimationFrame(reconcile);
    return () => cancelAnimationFrame(id);
  }, [props.dockEpoch, reconcile]);

  // Keyboard path into the conversation (#174, §5.32 "keyboard-complete").
  //
  // The scroller is ONE tab stop — a labelled region — and the arrow keys move
  // between the operable controls inside it: the expanders (`FeedExpander`) and,
  // since #477, the copy buttons on code. `FEED_STOP_SELECTOR` is that list, and
  // it lives in `feed-keys.ts` next to the keys so a renderer adding a control
  // has one place to look. The list is read off the DOM at keystroke time rather
  // than kept in state: the DOM already holds every stop in exactly the order
  // the eye reads them, and blocks stream in and out constantly, so any registry
  // we kept would be a second copy to get wrong.
  const [inFeed, setInFeed] = React.useState(false);
  const onFeedKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    markGesture();
    const root = scroller.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>(FEED_STOP_SELECTOR));
    const active = root.ownerDocument.activeElement as HTMLElement | null;
    const action = feedKeyAction(e.key, {
      count: els.length,
      current: active ? els.indexOf(active) : -1,
    });
    if (!action) return; // not ours: the button or the scroller gets it
    e.preventDefault();
    if (action.kind === 'exit') root.focus();
    else els[action.index]?.focus();
  }, [markGesture]);

  // ── Session find (P2-E17-02, §5.31) ─────────────────────────────────────
  //
  // What the feed owes the find bar: take me to block `seq`, expanding
  // whatever the view was hiding. The SEARCH itself is main's (E17-01) and the
  // bar's; this is only the "and show me" half.
  const [reveal, setReveal] = React.useState<FeedReveal>(NO_REVEAL);
  // What the marks are painted from (#520). NOT in `FeedReveal`, which is a
  // context every block renderer reads: the term changes on every keystroke and
  // putting it there would re-render the whole conversation to repaint marks
  // the DOM pass writes anyway. Held as state rather than a ref because the
  // layout effect below has to re-run when it changes — a new term over the
  // same landed block is the common case while typing.
  const [markQuery, setMarkQuery] = React.useState<FindQuery | null>(null);
  // read by `jumpTo`, which is called from the bar OUTSIDE React's commit and
  // must therefore not close over a render's `blocks`
  const blocksRef = React.useRef(blocks);
  blocksRef.current = blocks;
  const jumpTo = React.useCallback(
    (seq: number, query?: FindQuery): boolean => {
      // The block is not in the view buffer — evicted, or not drained yet.
      // Refusing is the point: the caller renders the hit as snippet-only
      // rather than scrolling somewhere arbitrary and calling it the match.
      if (!blocksRef.current.some((b) => b.seq === seq)) return false;
      // same question, same object: React bails out of an identical state, so
      // stepping between hits of ONE search does not re-run the marking pass
      // for the term half — only for the block it moved to
      setMarkQuery((prev) => (sameFindQuery(prev, query ?? null) ? prev : (query ?? null)));
      setReveal((prev) => {
        const next = new Set(prev.revealed);
        next.add(seq);
        return { revealed: next, current: seq };
      });
      // The tail-pin would fight us: an unattributed scroll more than 40px
      // from the bottom is read as "layout moved it" and yanked back (see
      // onScroll). Both halves are needed — the gesture claims the scroll as
      // the user's, and unpinning stops the next streamed block dragging them
      // away from the hit they just asked for.
      markGesture();
      pinned.current = false;
      // The SCROLL is not done here — see the layout effect below.
      return true;
    },
    [markGesture],
  );
  /**
   * Take the view to the revealed block, after React has committed it.
   *
   * A layout effect rather than a frame scheduled inside `jumpTo`, and the
   * difference is not cosmetic: a verbosity-hidden block does not EXIST in the
   * DOM until the reveal commits, and an expanded one is taller than the one
   * we would have measured. `jumpTo` is called from two places with different
   * scheduling — a keypress (React flushes synchronously) and the continuation
   * of an awaited search (normal priority, which React may split across
   * frames) — so a one-frame guess is right in one of them and a silent no-op
   * in the other, having already unpinned the tail. A layout effect runs after
   * commit in both, by construction, which is also what makes it testable.
   */
  const jumpedTo = reveal.current;
  // what the marks on the page were painted from, so a STEP does not repeat a
  // pass whose only different answer is which mark is current
  const painted = React.useRef<FindQuery | null>(null);
  React.useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    // Marking happens HERE and nowhere else (#520). This effect is the single
    // writer of feed marks, so "the bar closed" (`jumpedTo` back to null) and
    // "the term changed" are the same code path as "we jumped", and no exit
    // leaves paint behind. In the layout phase rather than an effect CLEANUP on
    // purpose: cleanups run inside React's mutation phase, interleaved with the
    // DOM writes of the very children whose text we would be un-splitting.
    if (jumpedTo === null) {
      clearFeedMarks(root);
      painted.current = null;
      return;
    }
    const el = root.querySelector<HTMLElement>(`[${FEED_SEQ_ATTR}="${jumpedTo}"]`);
    // Marks left in place rather than cleared: the block we were told to jump
    // to is not on the page (evicted between the search and the commit), and
    // the paint that IS there still answers to the term the bar is showing.
    if (!el) return;
    // The step case first: same question, marks already on the page, and the
    // only thing to do is move the current one. A full pass is a tree walk over
    // every rendered block, and Enter is a key somebody holds down.
    // `moveCurrentMark` returns null when the landed block has no marks yet —
    // it was hidden when the last pass ran — and that is the full pass's cue.
    const current =
      (sameFindQuery(painted.current, markQuery) && moveCurrentMark(root, el)) ||
      markFeedMatches(root, markQuery, el);
    painted.current = markQuery;
    autoPin.current = true;
    // 24px of air above the block, so a hit at the top of the viewport still
    // reads as being inside a conversation
    root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - 24;
    // ...and then the MARK, if putting the block's top on screen did not also
    // put the match on screen. A tool output can be four screens tall, and a
    // jump that lands on the top of it while the word is below the fold is the
    // bug this item was filed over, one step less bad. Measured after the first
    // write, so it is the position the user will actually see — and moved by
    // the MINIMUM that brings the mark in, so the block's ring stays on screen
    // with it wherever that is possible.
    if (current) {
      const view = root.getBoundingClientRect();
      const mark = current.getBoundingClientRect();
      if (mark.bottom > view.bottom) root.scrollTop += mark.bottom - view.bottom + 24;
      else if (mark.top < view.top) root.scrollTop += mark.top - view.top - 24;
    }
    lastTop.current = root.scrollTop;
    // `jumpTo` unpinned on purpose; say so on screen in the same commit rather
    // than waiting for the scroll event this write will fire (#442)
    syncOffTail();
    requestAnimationFrame(() => (autoPin.current = false));
  }, [jumpedTo, markQuery, syncOffTail]);
  const clearReveal = React.useCallback(() => {
    setReveal(NO_REVEAL);
    setMarkQuery(null);
  }, []);
  React.useEffect(() => {
    if (!props.cardId) return; // a card with no durable id cannot be addressed
    const surface: FeedFindSurface = { kind: 'feed', jumpTo, clear: clearReveal };
    return publishFindSurface(findSurfaceKey(props.cardId, 'feed'), surface);
  }, [props.cardId, jumpTo, clearReveal]);
  // a different session in the same card is a different conversation; its
  // blocks do not share seqs with the one we had revealed
  React.useEffect(() => {
    clearReveal();
  }, [props.sessionId, clearReveal]);

  // `revealed` OVERRIDES the verbosity filter (§5.31: find searches what the
  // view is hiding, and jumping expands it). Without this clause, jumping to a
  // hit in a thinking block while the preset is `normal` would scroll to a
  // block that is not in the list — the honest-looking version of doing
  // nothing at all.
  const visibleBlocks = blocks.filter((b) => reveal.revealed.has(b.seq) || blockVisible(b, verbosity));
  return (
    <div style={{ blockSize: '100%', display: 'flex', flexDirection: 'column', background: 'var(--card-bg)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          paddingInline: 8,
          paddingBlock: 3,
          borderBlockEnd: '1px solid var(--border)',
        }}
      >
        {/* Only while the keyboard is actually IN the conversation: the arrow
            keys are the one thing about this surface a user cannot see, and a
            permanent legend would be clutter for the 99% of the time the
            mouse is doing the work. */}
        <span
          style={{
            flex: 1,
            minInlineSize: 0,
            fontSize: 9.5,
            color: 'var(--faint)',
            fontFamily: 'var(--font-ui)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {inFeed ? t('feedView.keyHint') : ''}
        </span>
        {(['quiet', 'normal', 'firehose'] as const).map((v) => (
          <button
            key={v}
            title={t(`feedView.${v}Hint`)}
            onClick={() => pickVerbosity(v)}
            style={{
              background: verbosity === v ? 'var(--chip)' : 'transparent',
              border: '1px solid var(--border)',
              color: verbosity === v ? 'var(--text)' : 'var(--faint)',
              borderRadius: 'var(--radius-chip)',
              fontSize: 9.5,
              padding: '0 6px',
              cursor: 'pointer',
              fontFamily: 'var(--font-ui)',
            }}
          >
            {t(`feedView.${v}`)}
          </button>
        ))}
      </div>
      <div
        ref={scroller}
        // The conversation as a landmark with a name (#174) — and as the single
        // tab stop that gets a keyboard user into it. It is deliberately NOT
        // `role="log"`: an aria-live conversation would read every streamed
        // token aloud over whatever the user was doing.
        role="region"
        // ...and the name says WHICH conversation (#196). Interpolated, not
        // concatenated, so a locale is free to put the title first.
        aria-label={
          props.title
            ? t('feedView.regionLabelNamed', { title: props.title })
            : t('feedView.regionLabel')
        }
        tabIndex={0}
        data-feed-region=""
        // `:focus-visible`, matching the ring: clicking a box also focuses this
        // container, and a legend of arrow keys flickering in and out as the
        // mouse works is noise. It appears for the people it is for.
        onFocus={(e) => setInFeed(!!(e.target as HTMLElement).matches?.(':focus-visible'))}
        onBlur={() => setInFeed(false)}
        onWheel={markGesture}
        onTouchStart={markGesture}
        onTouchMove={markGesture}
        onPointerDown={markGesture}
        onKeyDown={onFeedKeyDown}
        onScroll={() => {
          const el = scroller.current;
          // a hidden or mid-relayout panel reports clientHeight 0 and scrollTop
          // 0; treating that as "the user scrolled to the top" would both unpin
          // the tail and overwrite the position we're trying to give back
          if (!el || el.clientHeight === 0) return;
          if (autoPin.current) {
            // Normally our own pin — not user intent, so ignore it. But
            // `autoPin` stays set until the next animation frame, and a
            // LAYOUT scroll landing in that same frame used to be swallowed
            // with it: the view was left stranded mid-history with output
            // below the fold and no further event to correct it (#112,
            // measured — the stranded run saw exactly one scroll, with
            // autoPin already true).
            //
            // Our pin always lands ON the tail, so a scroll arriving here
            // that is nowhere near the tail is somebody else's. Correct it —
            // but only with no recent gesture behind it, so a user scrolling
            // up while a pin is in flight is never yanked back.
            const away = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (pinned.current && away >= 40 && Date.now() - lastGesture.current > GESTURE_MS) pin();
            // our own scrolls do not change the pin, but they are the frame in
            // which a `jumpTo` unpin becomes visible (#442)
            syncOffTail();
            return;
          }
          // Nobody touched anything: this scroll came from LAYOUT (the approval
          // bar docking, the working banner, content reflowing). It must never
          // change what the user wants — and if they were following the tail,
          // put them back on it rather than leaving output below the fold.
          if (Date.now() - lastGesture.current > GESTURE_MS) {
            if (pinned.current) pin();
            syncOffTail();
            return;
          }
          // a real gesture, and a continuing one keeps the window alive so a
          // scrollbar drag or momentum scroll doesn't decay mid-movement
          markGesture();
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          lastTop.current = el.scrollTop;
          owesRestore.current = false; // the user has taken the wheel
          syncOffTail();
        }}
        style={{ flex: 1, minBlockSize: 0, overflowY: 'auto', fontSize: 12, lineHeight: 1.5, paddingBlock: 6 }}
      >
        <div ref={content}>
          {cleared && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBlock: 10,
                marginInline: 10,
                color: 'var(--muted)',
                fontSize: 10.5,
                fontFamily: 'var(--font-ui)',
              }}
            >
              <span style={{ flex: 1, borderBlockStart: '1px solid var(--border)' }} />
              {t('feedView.clearedMarker')}
              <span style={{ flex: 1, borderBlockStart: '1px solid var(--border)' }} />
            </div>
          )}
          {/* `blocks`, not `visibleBlocks`: a session with blocks that the
              current verbosity filters out has plenty of conversation, and
              telling its owner there is none would be a confident lie */}
          {blocks.length === 0 && !cleared && (
            <EmptyState
              binding={props.binding ?? 'awaiting-prompt'}
              diag={props.bindingDiag ?? null}
              transport={props.transport}
            />
          )}
          {/* the find bar's reveal set reaches the collapsible renderers from
              here — see lib/feed-reveal for why it is a context and not props */}
          <FeedRevealProvider value={reveal}>
            {visibleBlocks.map((b, i) => (
              <React.Fragment key={b.seq}>
                {/* a new prompt starts a new turn — rule it off (Dan #11) */}
                {b.kind === 'user' && i > 0 && (
                  <div style={{ borderBlockStart: '1px solid var(--border)', marginBlock: 8, marginInline: 8 }} />
                )}
                <Block b={b} />
              </React.Fragment>
            ))}
          </FeedRevealProvider>
          <div ref={bottom} />
        </div>
      </div>
      {/* The way back to the tail (#442), and it is here for two reasons: it is
          where the eye already is — the bottom of the conversation, right above
          the composer — and it is the ONE place that makes the keyboard path a
          single step. The conversation is one tab stop and the composer is the
          next; a control between them is reached with one Tab from the feed and
          one Shift+Tab from the composer. In the header strip it would have sat
          behind three verbosity chips (§5.32).
          Only while there is somewhere to go: unpinned AND overflowing. */}
      {offTail && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            paddingBlock: 3,
            borderBlockStart: '1px solid var(--border)',
            background: 'var(--panel2)',
          }}
        >
          <button
            data-feed-jump-latest=""
            onClick={jumpToLatest}
            title={t('feedView.jumpLatestHint')}
            style={{
              background: 'var(--chip)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-chip)',
              color: 'var(--text)',
              fontFamily: 'var(--font-ui)',
              fontSize: 9.5,
              padding: '1px 8px',
              cursor: 'pointer',
            }}
          >
            {t('feedView.jumpLatest')}
          </button>
        </div>
      )}
      {/* the working banner — LOUD by request (Dan, twice): full-width tinted
          bar, bold LEFT-aligned label, staggered pulse dots to its right
          (Dan round 4: text left, dots right of the text, no ellipsis) */}
      {!props.approval && props.status === 'working' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 10,
            paddingInline: 12,
            paddingBlock: 8,
            borderBlockStart: '2px solid var(--status-working)',
            background: 'color-mix(in srgb, var(--status-working) 16%, var(--panel2))',
            fontSize: 13,
            color: 'var(--text)',
            fontWeight: 700,
            letterSpacing: 0.2,
          }}
        >
          {t('feedView.workingStrip')}
          {[0, 0.25, 0.5].map((delay) => (
            <span
              key={delay}
              style={{
                inlineSize: 8,
                blockSize: 8,
                borderRadius: '50%',
                background: 'var(--status-working)',
                animation: `sb-pulse 1.1s ease-in-out ${delay}s infinite`,
              }}
            />
          ))}
        </div>
      )}
      {/* A QUESTION takes the dock instead of the approval bar (#563). Same
          place, same weight, different controls — because it is the same user
          question ("what does this session want from me?") answered with a list
          instead of a verdict. `askQuestions` is null for every other tool AND
          for an AskUserQuestion payload we could not parse, and then this falls
          through to the ordinary bar, which can still Allow and Deny it. */}
      {props.approval && props.onDecide && askQuestions && (
        <QuestionPanel
          // Remount per REQUEST: consecutive questions in one session reuse this
          // component, and a half-typed Other from the last one appearing under
          // the next one's options would be an answer the user did not give.
          key={props.approval.requestId}
          requestId={props.approval.requestId}
          questions={askQuestions}
          input={props.approval.input}
          queued={props.approvalQueued ?? 0}
          onDecide={props.onDecide}
        />
      )}
      {props.approval && props.onDecide && !askQuestions && (
        <ApprovalBar approval={props.approval} queued={props.approvalQueued ?? 0} onDecide={props.onDecide} />
      )}
      {/* Docked in the SAME place as the approval bar, deliberately: this is
          where the user's eyes already are for anything the session is waiting
          on. `terminalHandoff` returns null while a held approval is showing,
          so the two can never appear together. */}
      {handoff && <TerminalHandoffBar handoff={handoff} onJump={props.onJumpToTerminal} />}
      <Composer
        // The saved draft is seeded ONCE, on mount (#485), so a Composer whose
        // card id changed under it would carry the old card's words onto the
        // new one at the first keystroke. Nothing calls `updateParameters` with
        // a new `cardId` today — but `sessionId` DOES churn on resume, the two
        // sit next to each other, and the next reader will not know which is
        // which. `key` makes the hazard structurally impossible for one word.
        key={props.cardId}
        sessionId={props.sessionId}
        // the durable key the saved draft is filed under (#485)
        cardId={props.cardId}
        autonomy={props.autonomy}
        model={props.model}
        status={props.status}
        transport={props.transport}
        onCycleAutonomy={props.onCycleAutonomy}
      />
    </div>
  );
}

/**
 * The CLI is waiting on a decision we may not answer for it (#125, P7 §6).
 *
 * Shaped like `ApprovalBar` on purpose — same dock, same weight, same tinted
 * left-to-right band — because the two answer the same user question ("what is
 * this session waiting for?") and only differ in who gets to answer it. The
 * previous version was a 10px chip in the header strip, which was invisible
 * next to a bar the user had been trained by every prior permission to look
 * for at the bottom.
 */
function TerminalHandoffBar({
  handoff,
  onJump,
}: {
  handoff: TerminalHandoff;
  onJump?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const hue = `var(${toneToken(handoff.tone)})`;
  return (
    <div
      data-handoff={handoff.tone}
      // its whole job is to announce a state change the user did not cause
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        borderBlockStart: `2px solid ${hue}`,
        background: `color-mix(in srgb, ${hue} 10%, var(--panel2))`,
        paddingInline: 12,
        paddingBlock: 9,
        fontSize: 11.5,
        fontFamily: 'var(--font-ui)',
      }}
    >
      {/* `--text`, NOT the status hue or its `-ink` variant. tokens.css says the
          --status-* hues are tuned for dots and rings, and on nordic — the
          default theme — ink IS the hue, so ink on this hue-tinted background
          measures 3.89:1: worse than the 10px chip this replaced, which used
          --text. Colour carries the tone in the border and the tint; the words
          stay at 8:1. (The working banner below does the same thing.) */}
      <div style={{ flex: 1, minInlineSize: 0, color: 'var(--text)' }}>
        <div style={{ fontWeight: 700, marginBlockEnd: 2 }}>{t(handoff.title)}</div>
        <div style={{ lineHeight: 1.45 }}>{t(handoff.body)}</div>
      </div>
      <button
        onClick={onJump}
        style={{
          background: 'var(--btn-primary-bg)',
          color: 'var(--btn-primary-text)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-chip)',
          padding: '5px 14px',
          cursor: 'pointer',
          fontFamily: 'var(--font-ui)',
          fontSize: 11.5,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {t('handoff.jump')}
      </button>
    </div>
  );
}

/**
 * Inline approval bar (E10-04) — docked just above the composer (Dan's
 * 2026-07-22 feedback: it lives where the eyes already are, not at the top).
 */
function ApprovalBar({
  approval,
  queued,
  onDecide,
}: {
  approval: {
    requestId: string;
    tool: string;
    input: Record<string, unknown>;
    reason?: string;
  };
  queued: number;
  onDecide: (decision: 'allow' | 'deny', allowAll?: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const btn = (primary: boolean): React.CSSProperties => ({
    background: primary ? 'var(--btn-primary-bg)' : 'var(--panel)',
    color: primary ? 'var(--btn-primary-text)' : 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-chip)',
    padding: '4px 14px',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
    fontSize: 12,
  });
  const pane = (background: string): React.CSSProperties => ({
    flex: 1,
    margin: 0,
    padding: 6,
    background,
    border: '1px solid var(--border)',
    borderRadius: 4,
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    minInlineSize: 0,
  });
  return (
    <div
      style={{
        borderBlockStart: '2px solid var(--status-needs-permission)',
        background: 'color-mix(in srgb, var(--status-needs-permission) 8%, var(--panel2))',
        padding: '8px 10px',
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBlockEnd: 6 }}>
        {/* -ink, not the hue: the title sits on the bar's own 8% tint of that
            same hue, where the hue measures 2.19:1 on daylight and 4.04:1 on
            nordic. The ink lands at 5.08-8.00:1 across the four themes (#246). */}
        <span style={{ fontWeight: 700, color: 'var(--status-needs-permission-ink)' }}>
          {t('approval.title', { tool: approval.tool })}
        </span>
        {queued > 0 && (
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>{t('approval.more', { n: queued })}</span>
        )}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minInlineSize: 0,
            flex: 1,
          }}
        >
          {/* shared with the grouped prompt (P2-E9-11): the two are placements
              of ONE question (§5.16), and a user who reads the summary on one
              and a different one on the other has been shown two things and
              told they are the same */}
          {argumentSummary(approval.input)}
        </span>
      </div>
      {/* The CLI's OWN prose for why it is asking (P2-E18-07, stream transport
          only — a hook payload carries nothing like it). Renderable text we did
          not have to write, which is P7 working in our favour.
          `--text`, NOT a hue token: this background is already tinted with
          `--status-needs-permission`, and on nordic the ink IS the hue, which
          measured 3.89:1 in #125. A token validated against a flat background
          is not validated against a tinted one. */}
      {approval.reason && (
        <div
          style={{
            color: 'var(--text)',
            marginBlockEnd: 6,
            lineHeight: 1.4,
            // long reasons must not shove the buttons off a short card
            maxBlockSize: 64,
            overflow: 'auto',
          }}
        >
          {approval.reason}
        </div>
      )}
      {typeof approval.input.old_string === 'string' && typeof approval.input.new_string === 'string' && (
        <div style={{ display: 'flex', gap: 6, marginBlockEnd: 6, maxBlockSize: 120, overflow: 'auto' }}>
          <pre style={pane('var(--diff-removed-bg)')}>{approval.input.old_string.slice(0, 1500)}</pre>
          <pre style={pane('var(--diff-added-bg)')}>{approval.input.new_string.slice(0, 1500)}</pre>
        </div>
      )}
      {typeof approval.input.command === 'string' && (
        <pre
          style={{
            margin: '0 0 6px',
            padding: 6,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 10.5,
            maxBlockSize: 90,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {approval.input.command.slice(0, 1500)}
        </pre>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => onDecide('allow')} style={btn(true)}>
          {t('approval.allow')}
        </button>
        {/* NOT for a question (#563). This bar only ever sees an
            `AskUserQuestion` when its payload failed to parse and the panel
            stood down — a rare fallback, but one where "Allow all (this
            session)" reads as "answer all its questions for me", which is not
            what it does and not something anything can do. It is already inert
            for questions on both allow-all paths; hiding it means the button
            never makes a promise the app has deliberately refused to keep. */}
        {approval.tool !== ASK_USER_QUESTION_TOOL && (
          <button onClick={() => onDecide('allow', true)} style={btn(false)}>
            {t('approval.allowAll')}
          </button>
        )}
        <button onClick={() => onDecide('deny')} style={btn(false)}>
          {t('approval.deny')}
        </button>
      </div>
    </div>
  );
}

/**
 * An element's block-axis padding or border, in px — the parts of its height
 * that are not rendered text.
 *
 * Logical longhands first (this codebase writes logical properties), physical
 * as the fallback: jsdom resolves only the physical ones, and a measurement
 * that silently read zero there would size a different box in tests than in
 * the app.
 */
function blockEdge(cs: CSSStyleDeclaration, part: 'padding' | 'border'): number {
  const px = (v: string): number => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  const w = part === 'border' ? '-width' : '';
  const logical =
    px(cs.getPropertyValue(`${part}-block-start${w}`)) +
    px(cs.getPropertyValue(`${part}-block-end${w}`));
  // `> 0`, not `!== ''`: jsdom ANSWERS the logical longhands, with "0" — an
  // empty-string check would take that zero for a measurement and size a
  // different box in tests than in the app.
  if (logical > 0) return logical;
  return px(cs.getPropertyValue(`${part}-top${w}`)) + px(cs.getPropertyValue(`${part}-bottom${w}`));
}

/** the conversation never gives up its last 60px to make room for the box */
const MIN_FEED_PX = 60;

/**
 * The tallest the composer's textarea may grow to without pushing anything off
 * the panel — see `ComposerMetrics.available` for why a line cap alone is not
 * enough. Undefined when there is no layout to measure (a hidden panel), which
 * leaves the line cap in sole charge rather than guessing a small number.
 *
 * Called with the box already collapsed for measurement, so the difference
 * between the composer and the box's own ROW is its chrome (padding, the gap,
 * the options row) at its true size. The row, not the box: the send button
 * holds that row 30px tall however small the box gets, and measuring against
 * the collapsed box counted those 30px as chrome — the feed kept an extra
 * half-line it was never owed and the box stopped that much early (caught by
 * the e2e's floor assertion, 2026-08-11).
 */
function roomForBox(own: HTMLElement | null, el: HTMLElement): number | undefined {
  const panel = own?.parentElement;
  const row = el.parentElement ?? el;
  if (!own || !panel || panel.clientHeight === 0) return undefined;
  let taken = MIN_FEED_PX + (own.offsetHeight - row.offsetHeight);
  for (const sib of Array.from(panel.children)) {
    // everything docked around the conversation — the verbosity strip, the
    // working banner, an approval bar — keeps the height it asked for; only the
    // scroller (`flex: 1`) is the one that yields
    if (sib === own || sib.hasAttribute('data-feed-region')) continue;
    taken += (sib as HTMLElement).offsetHeight;
  }
  return Math.max(0, panel.clientHeight - taken);
}

/**
 * Prompt composer (P2-E10-02, §5.10): an INPUT ROUTE to the real CLI — the
 * text is written to the session's PTY exactly as if typed in the terminal
 * (multiline goes as a bracketed paste so the TUI treats it as one prompt).
 */
function Composer({
  sessionId,
  cardId,
  autonomy,
  model,
  status,
  transport,
  onCycleAutonomy,
}: {
  sessionId: string;
  /** durable key for this card's saved draft (#485) — the live id churns */
  cardId?: string;
  autonomy?: string;
  model?: string;
  status?: string;
  /** P2-E10-09: only a typed-message transport can carry a pasted image */
  transport?: 'pty' | 'stream';
  onCycleAutonomy?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  // The draft OUTLIVES this component (#485). It is seeded from the workspace
  // `ui` blob on mount and written back on every change, because the component
  // dies far more often than the user's intent does: switching to the Terminal
  // tab unmounts this panel, the stranded-popout rescue rebuilds the card, and
  // quitting ends it. `composer-draft.ts` has the whole argument.
  const [draft, setDraftState] = React.useState(() => loadDraft(cardId));
  const setDraft = React.useCallback(
    (text: string): void => {
      setDraftState(text);
      saveDraft(cardId, text);
    },
    [cardId]
  );
  const box = React.useRef<HTMLTextAreaElement | null>(null);
  /** the composer's own root — the auto-grow measures the panel through it */
  const root = React.useRef<HTMLDivElement | null>(null);

  // Pasted images (P2-E10-09, §5.10). The clipboard RULES are in
  // `lib/composer-attachments.ts`; this end only reacts to a paste event and
  // holds what came out of it.
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  /** one line of explanation for a paste that produced nothing, or null */
  const [attachNotice, setAttachNotice] = React.useState<string | null>(null);
  // A stream session takes typed messages and so can carry an image block; a
  // PTY session takes KEYSTROKES, and there is no keystroke for a bitmap. The
  // composer is otherwise deliberately transport-ignorant (`lib/composer.ts`),
  // and this is the one thing it genuinely cannot discover by trying: the
  // try-then-fall-back shape exists because both routes deliver the same
  // thing, which stops being true here. Undefined — a session whose transport
  // we have not been told — is treated as capable, because the send path
  // reports a refusal honestly and guessing "no" would break the default.
  const canAttach = transport !== 'pty';

  /**
   * Ctrl+V.
   *
   * A clipboard with NO files is not our business at all — we never call
   * `preventDefault`, never touch the draft, and the browser pastes text
   * exactly as it always did. That is the "plain text is completely
   * unaffected" clause, and it is the first branch on purpose.
   *
   * A clipboard with BOTH text and an image keeps both: the default paste runs
   * (so the words land at the caret) AND the image attaches beside it. A
   * spreadsheet range or a copied web selection gives you both halves, and
   * dropping either one silently is the bug report.
   */
  /**
   * The ONE intake, shared by paste and drop.
   *
   * The reference's paste handler and drop handler both end in a single
   * `onAddFiles(FileList)`, and so do ours: everything after "here are some
   * files" — the classification, the cap, the message — must not be able to
   * differ between the two routes, because a user who is told a `.md` is
   * unsupported when pasted and fine when dropped has found a bug rather than a
   * feature.
   *
   * `preRejected` is the one thing drop knows that paste cannot: a folder was
   * in the transfer. It is reported only when nothing else went wrong, so a
   * drop of "one folder and one 40 MB video" leads with the reason the FILE was
   * refused rather than with the folder.
   */
  /**
   * Every interpolation is passed to every message: ICU ignores an argument a
   * string does not name, and a limit quoted in prose is a limit that drifts
   * from the constant the moment either one moves.
   */
  const attachMessage = (reason: AttachmentRejection): string =>
    t(`feedView.attach.${reason}`, {
      max: MAX_ATTACHMENTS,
      limit: formatBytes(MAX_ENCODED_FILE_BYTES),
      textLimit: formatBytes(MAX_ATTACHMENT_PAYLOAD_BYTES),
    });

  const addFiles = (
    files: File[],
    origin: 'paste' | 'drop' = 'paste',
    preRejected: AttachmentRejection | null = null
  ): void => {
    // A FOLDER is reported before the transport is: "files can only be sent in
    // Direct mode — use the Terminal tab instead" is nonsense advice about a
    // folder, which cannot be attached by any session in any mode.
    if (preRejected === 'directory' && files.length === 0) {
      setAttachNotice(attachMessage('directory'));
      return;
    }
    if (!canAttach) {
      setAttachNotice(t('feedView.attach.terminalMode'));
      return;
    }
    if (files.length === 0) {
      // A transfer that yielded NOTHING still has to say something. Some drag
      // sources (Outlook, archive tools, virtual-file providers) advertise
      // `Files` and then hand over items whose `getAsFile()` is null — and
      // "nothing appeared and nothing was said" is the #163 failure. Note this
      // branch never clears an existing notice with `null`: a route that did
      // nothing has no business erasing the explanation of the last one.
      setAttachNotice(attachMessage(preRejected ?? 'unreadable'));
      return;
    }
    void (async () => {
      try {
        const outcome = await readAttachments(files, attachments.length, origin);
        // The cap is re-applied inside the functional update, not just from the
        // `attachments.length` read above: two transfers in flight at once both
        // measured the same "before", and the state is the only thing that
        // knows what actually landed. An overflow here is silent — the notice
        // was computed against a stale count — which is acceptable only because
        // reaching it needs two transfers racing into the same full draft.
        if (outcome.attachments.length > 0)
          setAttachments((prev) => [...prev, ...outcome.attachments].slice(0, MAX_ATTACHMENTS));
        const reason = outcome.rejected ?? preRejected;
        setAttachNotice(reason ? attachMessage(reason) : null);
      } catch {
        // `readAttachments` is DOCUMENTED not to throw, which is not the same
        // as being unable to: a `File`-like from an exotic drag source with no
        // `name` or `type` would throw inside the classifier. A documented
        // invariant is not an enforced one, and "our breakage never blocks a
        // session" is a hard constraint (PHILOSOPHY §3).
        setAttachNotice(attachMessage('unreadable'));
      }
    })();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = filesFrom(e.clipboardData);
    if (files.length === 0) return; // plain text — untouched, as if we did not exist
    // Nothing to insert, so suppress the default paste (which would otherwise
    // drop a file NAME into the box on some platforms). BEFORE the transport
    // check, deliberately: a Terminal-mode session cannot take the picture, but
    // the words on the same clipboard are still the user's and still belong in
    // the box.
    if (!hasPlainText(e.clipboardData)) e.preventDefault();
    addFiles(files, 'paste');
  };

  /**
   * Drag & drop (P2-E10-10).
   *
   * `dragDepth` and not a boolean: `dragenter`/`dragleave` fire for every
   * descendant the pointer crosses, so a naive boolean flickers off the moment
   * the cursor moves from the composer's padding onto the textarea inside it. A
   * counter is the standard fix and the only one that survives a nested layout.
   *
   * THE COMPOSER SWALLOWS THE DROP — `stopPropagation`, exactly as the
   * reference's handler does. That matters here in a way it does not there,
   * because `App.tsx` has a WINDOW-level drop listener that turns a dropped
   * FOLDER into a new session (E3-04). Without the stop, dropping a `.md` on
   * the prompt box would attach the file AND ask the window to open it as a
   * session. Every other surface is untouched: the window listener still sees
   * every drop that does not land on a composer.
   */
  const [dragDepth, setDragDepth] = React.useState(0);
  const dragging = dragDepth > 0;

  /** a drag carrying FILES, as opposed to a text selection or an internal drag */
  const hasFiles = (dt: DataTransfer | null): boolean =>
    Array.from(dt?.types ?? []).includes('Files');

  /**
   * THE ESCAPE HATCH for the counter.
   *
   * Every `dragenter` is supposed to be matched by a `dragleave` or a `drop`,
   * and if that ever fails to hold the overlay stays up over a composer the
   * user is trying to type into. `dragend` fires on the source when a drag
   * finishes ANY way — cancelled with Esc, dropped on another window, abandoned
   * — and a window-level `drop` catches the case where the pointer left us and
   * landed somewhere else. Both simply zero the counter, so a stuck overlay
   * cannot outlive the drag that caused it.
   */
  React.useEffect(() => {
    const clear = (): void => setDragDepth(0);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, []);

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e.dataTransfer)) return;
    // preventDefault on dragover is what MAKES this a drop target; without it
    // the browser refuses the drop and shows the "no entry" cursor
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  /**
   * NOT guarded on `hasFiles`, deliberately — unlike its enter twin.
   *
   * The counter only balances if enter and leave agree about every event, and
   * they read the same `dataTransfer.types` at two different moments in a drag.
   * A source that advertises `Files` on the way in and not on the way out would
   * increment and never decrement. `Math.max(0, …)` already floors it and only
   * one drag can be in flight, so an unconditional decrement is strictly safer
   * than a symmetric guard.
   */
  const onDragLeave = (): void => setDragDepth((d) => Math.max(0, d - 1));

  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    // BEFORE the guard: a drop is the end of a drag however it is shaped, and a
    // counter left standing here is exactly the stuck overlay above.
    setDragDepth(0);
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    // SYNCHRONOUS, before any await: a DataTransfer is neutered the instant the
    // handler returns, so the folder/file split has to happen now
    const { files, directories } = filesFromDrop(e.dataTransfer);
    addFiles(files, 'drop', directories.length > 0 ? 'directory' : null);
  };

  const removeAttachment = (id: string): void => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setAttachNotice(null);
  };

  // Slash-command autocomplete (E10-07, §5.10): typing '/' as the FIRST
  // character pops the list — CLI builtins + the project's/user's own
  // commands and skills. Selecting only INSERTS text; submission stays a
  // plain PTY write and the real CLI executes the command.
  const [caret, setCaret] = React.useState(0);
  const [commands, setCommands] = React.useState<SlashCommand[] | null>(null);
  const [selected, setSelected] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(false);
  const token = dismissed ? null : slashToken(draft, caret);
  const popup = token !== null && commands !== null ? filterCommands(commands, token) : [];
  const popupOpen = popup.length > 0;
  const syncCaret = (): void => setCaret(box.current?.selectionStart ?? 0);
  const popupWanted = token !== null;
  React.useEffect(() => {
    // fetch on every popup OPENING (not each keystroke) so a just-added
    // command file shows up without restarting anything
    if (!popupWanted) {
      setCommands(null);
      return;
    }
    let cancelled = false;
    void window.switchboard.sessions.slashCommands(sessionId).then((list) => {
      if (!cancelled) setCommands(list);
    });
    return () => {
      cancelled = true;
    };
  }, [popupWanted, sessionId]);
  React.useEffect(() => {
    setSelected(0);
  }, [token]);
  // arrow-key navigation must keep the highlighted row visible in the
  // scrollable popup (36+ builtins overflow the 200px box)
  const selectedRow = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, token]);

  // Placing the caret after an insert has to wait for React to COMMIT the new
  // draft: the textarea is controlled, so its DOM value is written during the
  // commit and a caret moved before that is simply overwritten. A layout effect
  // is exactly that moment — the same commit, after the DOM mutation.
  //
  // This used to be a requestAnimationFrame, which is a whole frame LATER and is
  // throttled hard when the window is occluded or the machine is loaded (CI).
  // A late caret write lands after the user has moved on: it collapses a
  // selection they just made and re-anchors typing into the middle of the old
  // draft. Measured while chasing #145 — delivering that stale write by hand,
  // between a select-all and the typing, left the box reading "/compact /he"
  // with an empty popup, which is exactly what CI reported. Whether CI's own
  // failure arrived by this route is NOT proven; that it can is enough.
  // A fresh OBJECT per pick, not a bare number: it makes the effect run once per
  // PICK rather than per distinct value, so an insert that happens to produce
  // the identical draft still places the caret.
  const [pendingCaret, setPendingCaret] = React.useState<{ pos: number } | null>(null);
  React.useLayoutEffect(() => {
    if (!pendingCaret) return;
    const el = box.current;
    el?.focus();
    el?.setSelectionRange(pendingCaret.pos, pendingCaret.pos);
    setCaret(pendingCaret.pos);
    setPendingCaret(null);
  }, [pendingCaret]);

  const pick = (name: string): void => {
    setDraft(insertCommand(draft, caret, name));
    setDismissed(true); // closed until the token changes again
    setPendingCaret({ pos: name.length + 2 }); // after "/name "
  };

  // Auto-grow (P2-E10-08, §5.10): the box is as tall as what the browser
  // ACTUALLY RENDERED — soft wrapping included — capped at COMPOSER_MAX_LINES
  // and scrolling inside itself past that. The arithmetic is in
  // `composer-size.ts`; this end only measures.
  //
  // Reset-then-read is the whole trick: an element never reports a scrollHeight
  // smaller than the height we last gave it, so last frame's height has to be
  // released before the new content can be read. That is also what lets the box
  // SHRINK again as text is deleted.
  //
  // Not debounced, deliberately: it is one forced layout on one small textarea
  // per keystroke — the same cost React already pays to re-render a controlled
  // input — and a debounce would leave the box visibly lagging the caret.
  const grow = React.useCallback((): void => {
    const el = box.current;
    const view = el?.ownerDocument.defaultView;
    if (!el || !view) return;
    // Past the cap the box is scrolled, and the caret is usually at the bottom
    // of it. Releasing the height makes the content fit, which clamps the
    // element's own scrollTop to 0 — so the reset goes to ZERO rather than
    // `auto` (max scroll only grows, nothing to clamp) and the offset is
    // written back anyway, for engines that clamp regardless. Without this,
    // every keystroke on line 20 scrolls the user back to line 1.
    const top = el.scrollTop;
    el.style.blockSize = '0px';
    el.style.overflowY = 'hidden'; // a scrollbar appearing mid-measure re-wraps the text
    const cs = view.getComputedStyle(el);
    const size = composerSize({
      scrollHeight: el.scrollHeight,
      lineHeight: resolveLineHeight(cs.lineHeight, cs.fontSize),
      padding: blockEdge(cs, 'padding'),
      border: blockEdge(cs, 'border'),
      borderBox: cs.getPropertyValue('box-sizing') === 'border-box',
      available: roomForBox(root.current, el),
    });
    // ceil, not the raw float: 12 × 17.4 is 208.79999999999998, and a height a
    // fraction short of the text clips the last line it was measured to show
    el.style.blockSize = `${Math.ceil(size.blockSize)}px`;
    el.style.overflowY = size.overflowY;
    el.scrollTop = top;
  }, []);
  // A LAYOUT effect: the height is written in the same commit as the new text,
  // so the box never paints a frame at the old size.
  // `attachments` is in here for the same reason `draft` is: the strip lives
  // inside the composer's own root, so attaching or removing an image changes
  // how much room `roomForBox` finds for the textarea. Without it a paste made
  // with a twelve-line draft on screen leaves the box at a height its panel no
  // longer has, which is #406's overhang arriving through a new door.
  React.useLayoutEffect(grow, [draft, attachments, grow]);
  // A NARROWER box wraps the same text into more lines, and a SHORTER panel has
  // less to spare — dragging a splitter or resizing the window re-renders
  // nothing, so without this a long draft keeps a height its panel no longer
  // has and overhangs its own options row.
  //
  // Neither trigger can loop: our writes are block-axis-only (so the box's
  // width never moves) and they redistribute space INSIDE the panel without
  // changing the panel's own height.
  React.useEffect(() => {
    const el = box.current;
    const panel = root.current?.parentElement;
    if (!el) return;
    let lastWidth = el.getBoundingClientRect().width;
    let lastRoom = panel?.clientHeight ?? 0;
    const ro = new ResizeObserver(() => {
      const width = el.getBoundingClientRect().width;
      // a collapsed panel measures 0 and would re-measure the draft as one
      // empty line; it comes back at full size, and that tick does the work
      if (width === 0) return;
      const room = panel?.clientHeight ?? 0;
      if (width === lastWidth && room === lastRoom) return;
      lastWidth = width;
      lastRoom = room;
      grow();
    });
    ro.observe(el);
    if (panel) ro.observe(panel);
    return () => ro.disconnect();
  }, [grow]);

  /** something to send: words, a picture, or both (E10-09) */
  const sendable = draft.trim().length > 0 || attachments.length > 0;

  /**
   * The prompt went — empty the box AND forget the saved copy, at once.
   *
   * Not `setDraft('')`: that would leave the deletion on `uiSetSoon`'s timer,
   * and a quit or a remount inside that window would restore a prompt the user
   * has already sent onto an empty composer. Late-to-save costs keystrokes;
   * late-to-clear looks like the app un-sending your message.
   */
  const clearComposerDraft = (): void => {
    setDraftState('');
    clearDraft(cardId);
  };

  const submit = (): void => {
    const text = draft.replace(/\r\n/g, '\n').trimEnd();
    // An attachment with nothing typed IS a prompt (§5.10's composer is an
    // input route, and "look at this" is a thing people send), so the guard is
    // on BOTH being empty rather than on the text alone.
    if (!text && attachments.length === 0) return;

    if (attachments.length === 0) {
      // The path this composer has always had, byte for byte: transport-
      // agnostic (P2-E18-08a), main answers whether it took it, and this falls
      // back to the PTY dance if not. A text prompt cannot be refused — one of
      // the two routes always accepts it — so the box clears immediately and
      // the send stays as snappy as it was.
      void submitPrompt(sessionId, text);
      clearComposerDraft();
      setDismissed(false);
      setAttachNotice(null);
      box.current?.focus();
      return;
    }

    // WITH ATTACHMENTS the send can genuinely fail (no PTY fallback carries a
    // bitmap or a document block), so the draft is cleared only once we know it
    // went.
    // The exact set being sent, captured now. Reading a dropped file takes real
    // time — a 4 MB log is not a clipboard bitmap — so a transfer can land
    // BETWEEN this submit and its acknowledgement. Clearing the strip wholesale
    // would eat that new attachment; removing only what we sent leaves it for
    // the next prompt, which is where the user put it.
    const sending = attachments;
    const sent = new Set(sending.map((a) => a.id));
    void submitPrompt(sessionId, text, toPromptAttachments(sending)).then((ok) => {
      if (!ok) {
        // Everything stays exactly where it was. Clearing a composer whose
        // contents went nowhere is the one outcome the user cannot undo, and a
        // pasted screenshot is not recoverable from the clipboard a minute
        // later.
        setAttachNotice(t('feedView.attach.notSent'));
        return;
      }
      clearComposerDraft();
      setDismissed(false);
      setAttachments((prev) => prev.filter((a) => !sent.has(a.id)));
      setAttachNotice(null);
    });
    box.current?.focus();
  };

  return (
    <div
      ref={root}
      data-composer-dropzone={dragging ? 'active' : ''}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: 8,
        borderBlockStart: '1px solid var(--border)',
        background: 'var(--panel2)',
      }}
    >
      {/* The drop hint. `pointer-events:none` is load-bearing: an overlay that
          takes the pointer would sit between the cursor and the composer and
          fire `dragleave` the instant it appeared, which flickers the state and
          then swallows the drop. Purely additive — it is absolutely positioned
          over the composer, so it costs the height clamp nothing and a session
          nobody is dragging onto is byte-for-byte the composer that shipped. */}
      {dragging && (
        <div
          data-composer-drop-hint=""
          style={{
            position: 'absolute',
            inset: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px dashed var(--accent)',
            borderRadius: 'var(--radius)',
            background: 'var(--panel)',
            opacity: 0.94,
            color: 'var(--muted)',
            fontSize: 11,
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          {t('feedView.attach.dropHint')}
        </div>
      )}
      {popupOpen && (
        <div
          style={{
            position: 'absolute',
            insetBlockEnd: '100%',
            insetInlineStart: 8,
            insetInlineEnd: 8,
            marginBlockEnd: 4,
            zIndex: 20,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: 'var(--tab-lift)',
            maxBlockSize: 200,
            overflowY: 'auto',
            padding: 3,
          }}
        >
          {popup.map((c, i) => {
            const slashName = '/' + c.name;
            return (
            <div
              key={`${c.source}:${c.name}`}
              ref={i === selected ? selectedRow : undefined}
              onMouseDown={(e) => e.preventDefault() /* keep the textarea focused */}
              onClick={() => pick(c.name)}
              onMouseEnter={() => setSelected(i)}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                padding: '3px 8px',
                borderRadius: 5,
                cursor: 'pointer',
                background: i === selected ? 'var(--chip)' : 'transparent',
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text)', flexShrink: 0 }}>
                {slashName}
              </span>
              <span
                style={{
                  fontSize: 10.5,
                  color: 'var(--muted)',
                  flex: 1,
                  minInlineSize: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {c.description ?? ''}
              </span>
              <span style={{ fontSize: 9, color: 'var(--faint)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                {t(`feedView.slashSource.${c.source}`)}
              </span>
            </div>
            );
          })}
        </div>
      )}
      {/* attachments (E10-09) sit INSIDE the composer's own root, above the
          box: that is what makes `roomForBox` count them as chrome, so the
          textarea's twelve-line cap is measured against the room actually
          left rather than fighting the strip for it */}
      <ComposerAttachments
        attachments={attachments}
        notice={attachNotice}
        onRemove={removeAttachment}
      />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
      <textarea
        ref={box}
        value={draft}
        onPaste={onPaste}
        onChange={(e) => {
          setDraft(e.target.value);
          setDismissed(false);
          setCaret(e.target.selectionStart ?? 0);
        }}
        onClick={syncCaret}
        onKeyUp={syncCaret}
        // Leaving the box is the moment waiting stops being an economy (#485):
        // clicking anywhere else in the app, or alt-tabbing away, sends the
        // draft immediately instead of letting it ride the debounce. It does
        // NOT cover the window's ✕ — that is OS chrome and fires no DOM blur —
        // so the residual hole is "type and quit within 400ms without leaving
        // the box", which is the tolerance `composer-draft.ts` argues for.
        onBlur={uiFlush}
        onKeyDown={(e) => {
          // confirming an IME candidate (CJK input) also fires Enter — never
          // submit a half-composed draft (keyCode 229 covers WebKit quirks)
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          // fetch still in flight for a wanted popup: swallow Enter/Tab so a
          // fast "/⏎" can't submit a bare slash before the list arrives
          if (popupWanted && commands === null && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault();
            return;
          }
          if (popupOpen) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => (s + (e.key === 'ArrowDown' ? 1 : popup.length - 1)) % popup.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              const chosen = popup[Math.min(selected, popup.length - 1)];
              // NOTHING LEFT TO COMPLETE -> Enter RUNS it (#163 hand-test).
              // Typing `/usage` in full and pressing Enter used to "complete"
              // it to `/usage ` and send nothing, which is indistinguishable
              // from the app ignoring you — and is why Dan found every slash
              // command dead in Direct mode. Tab still completes, so the
              // trailing space is still one keystroke away when a command
              // takes arguments.
              if (e.key === 'Enter' && token !== null && isCompleteCommand(token, chosen.name)) {
                submit();
                return;
              }
              pick(chosen.name);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDismissed(true);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t('feedView.composerPlaceholder')}
        // ONE row, always: the height is measured and written by `grow()`
        // below. `rows` counts hard newlines and cannot see soft wrapping —
        // that was the whole of #406. It stays at 1 so the very first paint,
        // before any layout effect runs, is the small box the design wants.
        rows={1}
        // `blockSize` and `overflowY` are deliberately ABSENT and written
        // imperatively by `grow()`: React only diffs the keys it is given, so
        // adding either one here would have every render fight the measurement.
        style={{
          flex: 1,
          resize: 'none',
          background: 'var(--panel)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '7px 10px',
          fontSize: COMPOSER_FONT_SIZE,
          fontFamily: 'var(--font-ui)',
          lineHeight: COMPOSER_LINE_RATIO,
          outline: 'none',
        }}
      />
      {status === 'working' && (
        <button
          onClick={() => void interruptSession(sessionId)}
          title={t('feedView.stop')}
          style={{
            // the same tinted-fill shape as the status pill (#221): the glyph
            // is TEXT on a 14% wash of its own hue, which measured 2.84:1 on
            // daylight and 3.37:1 on nordic. The ink clears 5.21:1 everywhere.
            // The border keeps the hue — an edge is not a word (#246).
            background: 'color-mix(in srgb, var(--status-crashed) 14%, var(--panel))',
            color: 'var(--status-crashed-ink)',
            border: '1px solid var(--status-crashed)',
            borderRadius: 8,
            inlineSize: 30,
            blockSize: 30,
            cursor: 'pointer',
            fontSize: 11,
            lineHeight: 1,
          }}
        >
          {t('feedView.stopIcon')}
        </button>
      )}
      <button
        onClick={submit}
        // an attached image with nothing typed is a sendable prompt (E10-09)
        disabled={!sendable}
        title={t('feedView.send')}
        style={{
          background: sendable ? 'var(--btn-primary-bg)' : 'var(--chip)',
          color: sendable ? 'var(--btn-primary-text)' : 'var(--faint)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          inlineSize: 30,
          blockSize: 30,
          cursor: sendable ? 'pointer' : 'default',
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        {t('feedView.sendIcon')}
      </button>
      </div>
      {/* options row (E10-05): the extension-style affordances under the box */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={onCycleAutonomy}
          title={t('feedView.autonomyHint')}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            // the feed's copy of the grid's autonomy chip, which #221 fixed and
            // this one was missed by (#246): 10px text in the raw crashed hue,
            // 3.35:1 on daylight's --panel and 3.89:1 on nordic's
            color: autonomy === 'full-auto' ? 'var(--status-crashed-ink)' : 'var(--muted)',
            fontSize: 10,
            fontFamily: 'var(--font-ui)',
            padding: '1px 8px',
            cursor: 'pointer',
          }}
        >
          {t(`autonomy.${autonomy ?? 'ask'}`)}
        </button>
        {model && (
          <span
            title={t('feedView.modelHint')}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              color: 'var(--faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minInlineSize: 0,
            }}
          >
            {model}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {status === 'working' && (
          <span
            title={t('status.working')}
            style={{
              inlineSize: 7,
              blockSize: 7,
              borderRadius: '50%',
              background: 'var(--status-working)',
              animation: 'sb-pulse 1.2s ease-in-out infinite',
            }}
          />
        )}
      </div>
    </div>
  );
}
