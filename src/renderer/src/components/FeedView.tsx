// Feed view v1 (P2-E12-06, §5.10): the rendered, READ-ONLY view of a session,
// built from transcript-derived blocks. Assistant prose renders as sanitized
// markdown; tool calls are one-line collapsed rows (click to expand); thinking
// is folded; sidechain (subagent) blocks indent behind a dashed border.
// Guardrail (§5.10 Non-Goals): no input surface of any kind lives here.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { blockVisible, FeedBlockDto, upsertBlock, Verbosity } from '../lib/feed';
import { emptyStateCopy } from '../lib/binding-copy';
import { terminalHandoff, TerminalHandoff, toneToken } from '../lib/terminal-handoff';
import type { BindingDiagnostics, BindingState } from '../../../shared/transcripts';
import { rendererRegistry } from '../extensibility/registry-instance';
import { renderFeedBlock } from '../extensibility/feed-render';
import { uiGet, uiSet } from '../lib/ui-state';
import { writePromptToPty } from '../lib/composer';
import { filterCommands, insertCommand, SlashCommand, slashToken } from '../../../shared/slash-commands';

export type { FeedBlockDto } from '../lib/feed';

function Block({ b }: { b: FeedBlockDto }): React.JSX.Element {
  // Resolved, not switched (§5.23): this used to be a seven-branch ternary
  // naming every renderer. A new block shape is now a contribution plus a
  // bootstrap line, and this file is not touched.
  const inner = renderFeedBlock(rendererRegistry, b);
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '4px 8px',
        ...(b.sidechain
          ? {
              marginInlineStart: 14,
              borderInlineStart: '1px dashed var(--faint)',
              opacity: 0.85,
            }
          : {}),
      }}
    >
      {/* timeline dot gutter (E10-06, extension reference) */}
      <span
        style={{
          inlineSize: 6,
          blockSize: 6,
          borderRadius: '50%',
          background: b.kind === 'user' ? 'var(--status-needs-input)' : 'var(--faint)',
          flexShrink: 0,
          marginBlockStart: 5,
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
}: {
  binding: BindingState;
  diag: BindingDiagnostics | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const copy = emptyStateCopy(binding, diag);
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
          a user staring at an error needs to know where the session still is */}
      {copy.problem && (
        <div style={{ marginBlockStart: 6 }}>{t('binding.unboundFallback')}</div>
      )}
    </div>
  );
}

export function FeedView(props: {
  sessionId: string;
  /** durable key for per-card preferences (the live id churns on resume) */
  cardId?: string;
  visible: boolean;
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
  onDecide?: (decision: 'allow' | 'deny', allowAll?: boolean) => void;
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
  // The CLI is waiting on something we are not allowed to answer for it — a
  // decision it kept (P7), or one our hook path never saw. Rendered as a BAR
  // above the composer (#125), not the 10px header chip it used to be.
  const handoff = terminalHandoff({
    status: props.status,
    // The SAME predicate the approval bar renders on, deliberately written as
    // one expression: if these two ever disagree, the user gets neither
    // surface and is stranded with no affordance at all.
    hasApproval: !!(props.approval && props.onDecide),
    // `startingLong` is cleared by an effect, so the first render that sees a
    // new status still has the old flag — without this, one frame can paint
    // the working banner and a "still starting" handoff together.
    startingLong: props.status === 'starting' && startingLong,
    recentlyDecided: !!props.recentlyDecided,
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
  const pin = React.useCallback((): void => {
    const el = scroller.current;
    if (!el) return;
    autoPin.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => (autoPin.current = false));
  }, []);
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
    const ro = new ResizeObserver(() => {
      const s = scroller.current;
      if (!s) return;
      // COLLAPSE is the real signal that a position is about to be lost, not
      // props.visible: dockview hides a background panel by collapsing an
      // ANCESTOR, so our visible prop never changes and React never learns the
      // panel went away — but the scroller's own height drops to 0 and comes
      // back, which this observer does see.
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
    });
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [pin, restore]);

  const visibleBlocks = blocks.filter((b) => blockVisible(b, verbosity));
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
        <span style={{ flex: 1 }} />
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
        onWheel={markGesture}
        onTouchStart={markGesture}
        onTouchMove={markGesture}
        onPointerDown={markGesture}
        onKeyDown={markGesture}
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
            return;
          }
          // Nobody touched anything: this scroll came from LAYOUT (the approval
          // bar docking, the working banner, content reflowing). It must never
          // change what the user wants — and if they were following the tail,
          // put them back on it rather than leaving output below the fold.
          if (Date.now() - lastGesture.current > GESTURE_MS) {
            if (pinned.current) pin();
            return;
          }
          // a real gesture, and a continuing one keeps the window alive so a
          // scrollbar drag or momentum scroll doesn't decay mid-movement
          markGesture();
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          lastTop.current = el.scrollTop;
          owesRestore.current = false; // the user has taken the wheel
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
            <EmptyState binding={props.binding ?? 'awaiting-prompt'} diag={props.bindingDiag ?? null} />
          )}
          {visibleBlocks.map((b, i) => (
            <React.Fragment key={b.seq}>
              {/* a new prompt starts a new turn — rule it off (Dan #11) */}
              {b.kind === 'user' && i > 0 && (
                <div style={{ borderBlockStart: '1px solid var(--border)', marginBlock: 8, marginInline: 8 }} />
              )}
              <Block b={b} />
            </React.Fragment>
          ))}
          <div ref={bottom} />
        </div>
      </div>
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
      {props.approval && props.onDecide && (
        <ApprovalBar approval={props.approval} queued={props.approvalQueued ?? 0} onDecide={props.onDecide} />
      )}
      {/* Docked in the SAME place as the approval bar, deliberately: this is
          where the user's eyes already are for anything the session is waiting
          on. `terminalHandoff` returns null while a held approval is showing,
          so the two can never appear together. */}
      {handoff && <TerminalHandoffBar handoff={handoff} onJump={props.onJumpToTerminal} />}
      <Composer
        sessionId={props.sessionId}
        autonomy={props.autonomy}
        model={props.model}
        status={props.status}
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
        <span style={{ fontWeight: 700, color: 'var(--status-needs-permission)' }}>
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
          {String(approval.input.file_path ?? approval.input.command ?? approval.input.url ?? '')}
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
        <button onClick={() => onDecide('allow', true)} style={btn(false)}>
          {t('approval.allowAll')}
        </button>
        <button onClick={() => onDecide('deny')} style={btn(false)}>
          {t('approval.deny')}
        </button>
      </div>
    </div>
  );
}

/**
 * Prompt composer (P2-E10-02, §5.10): an INPUT ROUTE to the real CLI — the
 * text is written to the session's PTY exactly as if typed in the terminal
 * (multiline goes as a bracketed paste so the TUI treats it as one prompt).
 */
function Composer({
  sessionId,
  autonomy,
  model,
  status,
  onCycleAutonomy,
}: {
  sessionId: string;
  autonomy?: string;
  model?: string;
  status?: string;
  onCycleAutonomy?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = React.useState('');
  const box = React.useRef<HTMLTextAreaElement | null>(null);

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

  const pick = (name: string): void => {
    const next = insertCommand(draft, caret, name);
    setDraft(next);
    setDismissed(true); // closed until the token changes again
    const el = box.current;
    const pos = name.length + 2; // after "/name "
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const submit = (): void => {
    const text = draft.replace(/\r\n/g, '\n').trimEnd();
    if (!text) return;
    writePromptToPty(sessionId, text);
    setDraft('');
    setDismissed(false);
    box.current?.focus();
  };

  return (
    <div
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
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
      <textarea
        ref={box}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setDismissed(false);
          setCaret(e.target.selectionStart ?? 0);
        }}
        onClick={syncCaret}
        onKeyUp={syncCaret}
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
              pick(popup[Math.min(selected, popup.length - 1)].name);
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
        rows={Math.min(6, Math.max(1, draft.split('\n').length))}
        style={{
          flex: 1,
          resize: 'none',
          background: 'var(--panel)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '7px 10px',
          fontSize: 12,
          fontFamily: 'var(--font-ui)',
          lineHeight: 1.45,
          outline: 'none',
        }}
      />
      {status === 'working' && (
        <button
          onClick={() => window.switchboard.pty.input(sessionId, String.fromCharCode(27))}
          title={t('feedView.stop')}
          style={{
            background: 'color-mix(in srgb, var(--status-crashed) 14%, var(--panel))',
            color: 'var(--status-crashed)',
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
        disabled={!draft.trim()}
        title={t('feedView.send')}
        style={{
          background: draft.trim() ? 'var(--btn-primary-bg)' : 'var(--chip)',
          color: draft.trim() ? 'var(--btn-primary-text)' : 'var(--faint)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          inlineSize: 30,
          blockSize: 30,
          cursor: draft.trim() ? 'pointer' : 'default',
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
            color: autonomy === 'full-auto' ? 'var(--status-crashed)' : 'var(--muted)',
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
