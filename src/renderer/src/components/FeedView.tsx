// Feed view v1 (P2-E12-06, Â§5.10): the rendered, READ-ONLY view of a session,
// built from transcript-derived blocks. Assistant prose renders as sanitized
// markdown; tool calls are one-line collapsed rows (click to expand); thinking
// is folded; sidechain (subagent) blocks indent behind a dashed border.
// Guardrail (Â§5.10 Non-Goals): no input surface of any kind lives here.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { blockVisible, FeedBlockDto, showsTimelineDot, upsertBlock, Verbosity } from '../lib/feed';
import { agentRunHeads, type AgentRunHead } from '../lib/feed-groups';
import { applyFolds, isExploration, type FoldRun } from '../lib/feed-folds';
import { groupBySeq } from '../lib/feed-skipping';
import { FEED_GROUP_ATTR, FEED_GROUP_OPEN_ATTR, useFeedSkipping } from '../lib/use-feed-skipping';
import { autonomyTooltip, isAutonomy } from '../lib/autonomy';
import {
  clearConversation,
  compactConversation,
  lockReasonKey,
  type SessionControlLock,
} from '../lib/session-controls';
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
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestion } from '../../../shared/ask-user-question';
import { EXIT_PLAN_MODE_TOOL } from '../../../shared/plan-mode';
import { QuestionPanel } from './QuestionPanel';
import type { BindingDiagnostics, BindingState } from '../../../shared/transcripts';
import { rendererRegistry } from '../extensibility/registry-instance';
import { resolveFeedBlock } from '../extensibility/feed-render';
import { ContributionBoundary } from '../extensibility/boundary';
import { FeedExpander, ToolBox } from '../extensibility/feed-blocks';
import { uiFlush, uiGet, uiSet } from '../lib/ui-state';
import { clearDraft, loadDraft, saveDraft } from '../lib/composer-draft';
import {
  loadStashedAttachments,
  lostAttachmentNames,
  stashAttachments,
} from '../lib/composer-attachment-draft';
import { interruptSession, resolveDraftMentions, submitPrompt } from '../lib/composer';
import { mayMention } from '../../../shared/mention-finder';
import {
  beginHandoffWait,
  cancelHandoffWait,
  endHandoffWait,
  handoffNotice,
  handoffWaitOf,
  handoffWasCancelled,
  namedOtherSessions,
  subscribeHandoffWaits,
} from '../lib/handoff-switch';
import { interceptSlash } from '../lib/slash-intercept';
import { sessionStore } from '../store/session-store';
import { ComposerAttachments } from './ComposerAttachments';
import { SiblingMessages } from './SiblingMessages';
import { ContextDropDialog } from './ContextDropDialog';
import {
  CONTEXT_DND_TYPE,
  isContextOffer,
  type ContextOffer,
  type ContextOfferOption,
} from '../../../shared/context-drop';
import {
  SIBLING_SETTLE_MS,
  beginSend,
  holdContextBlock,
  isSendInFlight,
  removeHeldMessages,
  settledMessages,
  useHeldMessages,
  useSendInFlight,
  withForwarded,
} from '../lib/sibling-inbox';
import { ModelQuickMenu } from './ModelQuickMenu';
import { EffortChip } from './EffortChip';
import { ContextMeter } from './ContextMeter';
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
  composerBounds,
  resolveLineHeight,
  type ComposerBounds,
} from '../lib/composer-size';
import { argumentSummary } from '../lib/permission-batches';
import {
  canScrollUp,
  DRAG_SLOP_PX,
  keyGesture,
  nextPin,
  TAIL_SLACK,
  wheelGesture,
  type FeedGesture,
} from '../lib/feed-pin';
import { ApprovalPreview } from './ApprovalPreview';
import { DenyFeedbackField } from './DenyFeedback';
import { targetPath } from '../../../shared/tool-paths';
import type { DecideHeld } from '../../../shared/ipc/permissions';
import {
  filterCommands,
  insertCommand,
  isCompleteCommand,
  SlashCommand,
  slashToken,
} from '../../../shared/slash-commands';
import {
  caretAfterMention,
  filterSummaries,
  insertMention,
  mentionEnterAction,
  mentionToken,
} from '../../../shared/mention-token';
import type { SessionSummary } from '../../../shared/sessions';
import { answered } from '../../../shared/ipc/refusal';
import type { TransportKind } from '../../../shared/transport';

export type { FeedBlockDto } from '../lib/feed';

/**
 * The caption that opens a subagent's run (#788).
 *
 * FOUR STRINGS, NOT ONE WITH OPTIONAL ARGUMENTS. A translator seeing
 * `"Subagent {name} {id}"` has no way to write the sentence that omits the
 * parts we did not send, and ICU renders a missing one as literal braces. The
 * unnamed pair exists because a transcript older than CLI 2.1.226 carries an id
 * we can group on and no name to print — and "Subagent · " with nothing after
 * it is worse than "Subagent".
 *
 * ⚠️ The UNNAMED case takes a discriminator too. Two anonymous runs render the
 * same caption, so they need separating for exactly the reason two identically
 * named ones do; dropping it there would leave the one case with no other cue
 * at all showing two agents one label.
 */
function agentCaption(t: (k: string, o?: Record<string, string>) => string, h: AgentRunHead): string {
  if (!h.name) {
    return h.discriminator
      ? t('feedView.subagent.unnamedDiscriminated', { id: h.discriminator })
      : t('feedView.subagent.unnamed');
  }
  return h.discriminator
    ? t('feedView.subagent.markerDiscriminated', { name: h.name, id: h.discriminator })
    : t('feedView.subagent.marker', { name: h.name });
}

/**
 * Blocks in the middle of a render-failure retry streak (#716) — see `sameBlock`.
 *
 * Keyed on the block OBJECT, so it needs no session id and cannot leak: an
 * evicted or replaced block takes its entry with it.
 */
const retrying = new WeakSet<FeedBlockDto>();

/** one object for every group, so React never sees its `style` prop change */
const GROUP_STYLE: React.CSSProperties = { display: 'flow-root' };

/** no fold has been opened by hand — one object, so the state can bail out */
const NO_FOLDS: ReadonlySet<number> = new Set();

/** marks a fold's row; in the `data-feed*` namespace the feed takes back from
 *  every reply (`decoration-guard`), like the group and block attributes */
const FEED_FOLD_ATTR = 'data-feed-fold';

/**
 * A burst of looking around, as ONE row (#1130).
 *
 * The owner's screenshot was about twenty consecutive one-line boxes — Grep,
 * Read, Glob, Grep… — for what is, to the reader, one event. This is that
 * event: what kind of calls and how many, and the newest one so a burst still
 * in progress shows where it has got to. It opens onto the calls themselves,
 * drawn below it exactly as they always were. `lib/feed-folds` decides what
 * folds and where a run ends.
 *
 * ── WHAT IT IS, STRUCTURALLY ────────────────────────────────────────────────
 *
 * A sibling of the blocks, drawn in its head block's place in the list —
 * furniture, like the two dividers, and deliberately NOT a block:
 *
 *  - no `data-feed-block` and no `data-feed-seq`. A find jump resolves a block
 *    by its seq and paints its marks inside that element; this row borrowing
 *    the head's seq would send both HERE instead of to the call.
 *  - the members are not nested in it. `use-feed-skipping` needs every block to
 *    be a direct child of its group, and watches each group's child list.
 *
 * ── AND IT IS OPERABLE THE WAY EVERY OTHER EXPANDER IS ─────────────────────
 *
 * A `FeedExpander`, so it is a stop on the conversation's arrow-key walk and
 * Enter opens it; the box around it is the same mouse convenience `ToolBox`
 * gives the tool rows.
 *
 * Memoised on primitives, for #716's reason: a streamed chunk re-renders the
 * list, and a row that has not changed must cost nothing.
 */
const FoldRow = React.memo(function FoldRow(props: {
  head: number;
  open: boolean;
  searches: number;
  reads: number;
  latest: string;
  sidechain: boolean;
  onToggle: (head: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const toggle = (): void => props.onToggle(props.head);
  const counts = [
    props.searches > 0 ? t('feedView.fold.searches', { count: props.searches }) : '',
    props.reads > 0 ? t('feedView.fold.reads', { count: props.reads }) : '',
  ]
    .filter(Boolean)
    .join(t('feedView.fold.join'));
  return (
    <div
      {...{ [FEED_FOLD_ATTR]: String(props.head) }}
      data-feed-fold-open={props.open ? '' : undefined}
      style={{
        display: 'flex',
        gap: 8,
        padding: '4px 8px',
        // the same spine a subagent's own blocks stand on — see `Block`
        ...(props.sidechain
          ? {
              marginInlineStart: 'var(--feed-sidechain-indent)',
              borderInlineStart: '1px dashed var(--faint)',
              opacity: 0.85,
            }
          : {}),
      }}
    >
      {/* the gutter every row reserves, with the tool rows' own dot */}
      <span
        aria-hidden
        style={{
          inlineSize: 6,
          blockSize: 6,
          flexShrink: 0,
          marginBlockStart: 5,
          borderRadius: '50%',
          background: 'var(--faint)',
        }}
      />
      <div style={{ flex: 1, minInlineSize: 0 }}>
        <ToolBox kind="fold" onToggle={toggle}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
            <FeedExpander
              open={props.open}
              onToggle={toggle}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'baseline',
                color: 'var(--muted)',
                padding: '1px 0',
                inlineSize: '100%',
              }}
            >
              <span style={{ color: 'var(--faint)', fontSize: 8 }}>
                {props.open ? t('feedView.fold.caretOpen') : t('feedView.fold.caretClosed')}
              </span>
              <span style={{ color: 'var(--status-working-ink)', fontWeight: 600, flexShrink: 0 }}>
                {t('feedView.fold.title')}
              </span>
              {/* The title holds; the counts shorten only once the newest call
                  beside them has given way entirely (its basis is zero). On a
                  narrow card nothing spills out of the box — which would give
                  the whole conversation a sideways scrollbar. */}
              <span
                style={{
                  flex: '0 1 auto',
                  minInlineSize: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {counts}
              </span>
              {/* the newest call, only while shut: open, it is the last row below */}
              {!props.open && props.latest !== '' && (
                <span
                  style={{
                    flex: '1 1 0%',
                    color: 'var(--faint)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minInlineSize: 0,
                  }}
                >
                  {t('feedView.fold.latest', { call: props.latest })}
                </span>
              )}
            </FeedExpander>
          </div>
        </ToolBox>
      </div>
    </div>
  );
});

/**
 * May `Block` skip this render?
 *
 * Yes when it is handed the very same block object — which is every block but
 * one, on every streamed chunk: `upsertBlock` copies the ARRAY and keeps each
 * untouched element's identity.
 *
 * Except while that block is mid-retry. #463's self-healing fires when the
 * boundary is handed NEW children, and a skipped render hands it nothing, so a
 * block that threw once would otherwise never be tried again. The boundary
 * says when a streak starts and ends (`onStreak`), and for exactly that long
 * this answers "no" and the block is offered a render on each feed update, as
 * it was before it was memoised.
 */
function sameBlock(prev: { b: FeedBlockDto }, next: { b: FeedBlockDto }): boolean {
  return prev.b === next.b && !retrying.has(next.b);
}

/**
 * ⚠️ MEMOISED, AND THE NUMBERS ARE WHY (#716, #1013).
 *
 * The owner, on the desktop: *"if I have a session going and Claude is busy,
 * typing into the prompt can be sluggish."* A streaming reply re-emits its
 * block every 50ms, each one is a `setBlocks`, and `FeedView` then rendered
 * EVERY block — up to 1,000 — to change one.
 *
 * MEASURED in the real app (`spike/probes/716/`: a conversation of real blocks,
 * one reply streaming, a key typed every 100ms, 4x CPU throttle, 12s):
 *
 *                                long tasks        frames   key->paint p95
 *     980 blocks, nothing streaming   0 /    0 ms     746        88 ms
 *     100 blocks, streaming           0 /    0 ms     752        72 ms
 *     980 blocks, streaming          86 / 7648 ms     154       152 ms
 *     980 blocks, streaming, THIS    16 /  958 ms     534       112 ms
 *
 * So the cost of a chunk scaled with the length of the conversation, and this
 * removes about seven eighths of it. What is left is in the findings note
 * (`spike/findings/716-streaming-render-cost.md`) with what was tried and did
 * not move it — memoising the composer and rendering in groups, for two.
 */
const Block = React.memo(function Block({ b }: { b: FeedBlockDto }): React.JSX.Element {
  // Resolved, not switched (Â§5.23): this used to be a seven-branch ternary
  // naming every renderer. A new block shape is now a contribution plus a
  // bootstrap line, and this file is not touched.
  //
  // The id comes back with the node because the node is rendered inside a
  // `ContributionBoundary`, and that boundary names the contribution (#594).
  const { id, node: inner } = resolveFeedBlock(rendererRegistry, b);
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
      // how a jump finds this block's element â€” see `FeedFindSurface.jumpTo`
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
              // the token, not `14`: `.agent-divider` captions this run and has
              // to sit on the same spine (#788)
              marginInlineStart: 'var(--feed-sidechain-indent)',
              borderInlineStart: '1px dashed var(--faint)',
              opacity: 0.85,
            }
          : {}),
      }}
    >
      {/* Timeline dot gutter (E10-06, extension reference). The GUTTER is
          unconditional and the DOT is not (#91): assistant prose gets the same
          6px of reserved column so the left edge stays flush with the boxed
          blocks above it, but no marker â€” see `showsTimelineDot`. */}
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
                background: b.kind === 'user' ? 'var(--muted)' : 'var(--faint)',
              }
            : {}),
        }}
      />
      {/* THE CRASH BARRIER (#594). `resolveFeedBlock` catches a renderer that
          throws while BUILDING its node; it cannot catch the node THROWING
          WHEN REACT RENDERS IT, because React is the caller. Nothing else sits
          between a feed block and the renderer root, so without this a single
          malformed transcript block â€” untrusted input from another process â€”
          blanks the whole window and takes every session's terminal with it
          (P6, fail-open). The boundary renders a gap instead, says which
          contribution failed, and retries it on the next update until it has
          failed `CONTRIBUTION_RETRY_LIMIT` times in a row (#463).

          RETRY REACHES THE FEED, and since #716 that takes one deliberate
          step. The boundary retries when it is handed new `children`, and
          `Block` is memoised — so a block that is not itself changing would
          never be offered another render. `onStreak` below is the boundary
          saying "this one is mid-retry", and `sameBlock` stops skipping it for
          exactly that long. The bound is what keeps that from spinning: a
          block that always throws costs three attempts, not one per streamed
          chunk, and once the bound is spent the block is skipped again.

          INSIDE the row, not around it: the gutter, the dot and the find
          anchors (`data-feed-block`, FEED_SEQ_ATTR) are the FEED's markup and
          cannot throw, and keeping them lets a jump still land on the block. It
          also leaves the boundary's identity tied to this row, whose key
          (`b.seq`, in the list below) is unchanged by any of this. */}
      <div style={{ flex: 1, minInlineSize: 0 }}>
        {id === null ? (
          inner
        ) : (
          <ContributionBoundary
            id={id}
            onStreak={(on) => {
              if (on) retrying.add(b);
              else retrying.delete(b);
            }}
          >
            {inner}
          </ContributionBoundary>
        )}
      </div>
    </div>
  );
}, sameBlock);

/**
 * What an empty Session view says (P2-E15-10, Â§5.26). It used to say one thing
 * â€” "No activity yet" â€” whether the session had never been prompted, was still
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
  /** which transport hosts the session (#447) â€” the fail-open line must not
   *  send a Direct user to a Terminal tab that has no terminal in it */
  transport?: TransportKind;
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
          // the raw hue measures ~3.2:1 on daylight â€” below the 4.5:1 the
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
          WHICH sentence that is depends on the transport â€” see `binding-copy` */}
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
   * Absent â€” or empty, which a workspace written before #294 can still hold â€”
   * falls back to the bare name. An honest generic beats a landmark called
   * "undefined", and beats announcing a title that is not there.
   */
  title?: string;
  visible: boolean;
  /** bumped when dockview reattached this panel's DOM (#555) â€” see
   *  `PanelContext.dockEpoch`, and the effect that reads it below */
  dockEpoch?: number;
  /** current session status â€” drives the working banner and the handoff bar */
  status?: string;
  /** Whether this session's Clear/Compact buttons work, and why not (#903).
   *  Computed by the CARD and never re-derived here: `status` alone cannot tell
   *  a cleanly-exited session from an idle one. Required for the reason
   *  `PanelContext` gives — `null` is already a state, so optional would add a
   *  silent fourth one. */
  controlsLock: SessionControlLock;
  /** transcript binding state (P2-E15-10) â€” decides what an EMPTY feed says */
  binding?: BindingState;
  bindingDiag?: BindingDiagnostics | null;
  /** composer options row data (E10-05) */
  autonomy?: string;
  /**
   * The mode the session SAYS it is in right now, when the CLI has announced
   * one (#1072) — it leaves plan mode by itself when a plan is approved.
   * `autonomy` above is the card's SETTING, which applies at the next start;
   * the two legitimately differ, and the chip has to say so.
   */
  liveAutonomy?: string;
  model?: string;
  onCycleAutonomy?: () => void;
  /** held permission (E10-04) â€” the bar renders just above the composer */
  approval?: {
    requestId: string;
    tool: string;
    input: Record<string, unknown>;
    /** stream transport only (P2-E18-07) */
    reason?: string;
  } | null;
  /** more holds waiting behind this one (review P0#4) */
  approvalQueued?: number;
  /**
   * Which skin the app is wearing, for the approval body's Monaco diff (#972).
   *
   * ⚠️ #261's LESSON, PRE-EMPTED AGAIN: this prop is dead unless the render site
   * in `extensibility/panels.tsx` threads `ctx.colorScheme` through, and the
   * failure would be silent — `ApprovalPreview` treats absent as "no diff" and
   * falls back to the plain panes, so the card would keep working and the whole
   * item would simply not be on screen. Optional because a unit test mounts this
   * with no theme around it and the panes are the right answer there.
   */
  colorScheme?: 'light' | 'dark';
  /** a held request of this session's is on Â§5.8's grouped prompt instead
   *  (P2-E9-11) â€” the question IS answerable, just not from here */
  approvalBatched?: boolean;
  /** which transport hosts this session â€” the handoff bar must not point at a
   *  terminal that does not exist (P2 #153 follow-up) */
  transport?: TransportKind;
  /**
   * `updatedInput` is the `AskUserQuestion` answer (#563) and rides the same
   * decision path everything else uses â€” a question is answered by allowing the
   * tool call with the answers written into its input, which is the CLI's own
   * design and not a side channel we invented.
   */
  /** the shared signature — see `DecideHeld`, which exists because this one
   *  has now quietly lost an argument twice */
  onDecide?: DecideHeld;
  /** grant every later call on one file, and answer this one (#974) */
  onAllowFile?: (filePath: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [blocks, setBlocks] = React.useState<FeedBlockDto[]>([]);
  /** counts the times `blocks` was REPLACED outright, for `useFeedSkipping` */
  const [conversation, setConversation] = React.useState(0);
  /**
   * The folds the user has opened (#1130), as the seqs of their MEMBERS.
   *
   * Every member, not just the head: a run grows at its tail while Claude is
   * still looking and loses its head when the oldest block is evicted at the
   * cap, and a fold opened by hand must stay open through both. "Any member of
   * this run is in the set" is true across either change.
   */
  const [openFolds, setOpenFolds] = React.useState<ReadonlySet<number>>(NO_FOLDS);
  // /clear executes SILENTLY (empty local-command stdout, no assistant reply
  // â€” verified vs claude 2.1.218), so without an explicit marker a cleared
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
  // ⚠️ THE `startingLong` SIGNAL WENT WITH THE HANDOFF BAR (#952), and its
  // reason is worth recording because the hazard was real.
  //
  // A session stuck in 'starting' usually meant the CLI was showing a startup TUI
  // dialog only a terminal could render — 2.1.x's resume-from-summary picker, in
  // the case Dan hit: invisible from the Session tab, and his composer Enter
  // blindly CONFIRMED it. Hooks were not up yet, so 'starting' outliving a normal
  // boot (8s) was the only signal available, and the bar used it to say so.
  //
  // It cannot happen on this transport. S-10 measured that stream mode draws no
  // startup dialog at all, which was the whole premise of that branch — and the
  // startup path now reports readiness from `system:init` rather than inferring
  // it from a timer.
  // Is the held request the CLI's own CHOOSER rather than a permission (#563)?
  //
  // Memoised on the request ID, not on the input object, and the memo is
  // load-bearing rather than an optimisation: `parseAskUserQuestion` returns a
  // FRESH ARRAY every call, and the panel re-seeds its selections whenever that
  // array's identity changes â€” so parsing inline would wipe a half-answered
  // panel on every unrelated re-render of this component.
  //
  // Keying on the id is sound because a held request is immutable: the id is
  // `stream:<sessionId>:<native>`, unique per request, and its input never
  // changes between arriving and being answered. (`approvalInput` is
  // deliberately not in the deps; eslint's exhaustive-deps plugin isn't
  // installed in this repo, so there is nothing to silence â€” see App.tsx:473.)
  const approvalId = props.approval?.requestId;
  const approvalTool = props.approval?.tool;
  const approvalInput = props.approval?.input;
  const askQuestions = React.useMemo(
    () =>
      approvalTool === ASK_USER_QUESTION_TOOL ? parseAskUserQuestion(approvalInput ?? {}) : null,
    [approvalId, approvalTool]
  );
  // ── NO TERMINAL-HANDOFF BAR SINCE #952 ─────────────────────────────────────
  //
  // It said the CLI was waiting on something switchboard was not allowed to
  // answer — a decision the CLI KEPT (P7) — and routed the user to the terminal,
  // as a full-width bar above the composer (#125, after a 10px header chip that
  // nobody ever saw).
  //
  // EVERY branch of it routed to the Terminal, so it had already returned null
  // for stream sessions since #153's follow-up: on a transport with no terminal
  // the bar was not merely unhelpful, it was FALSE and its button was dead. Dan
  // hit that within minutes of the transport becoming switchable — a freshly
  // restarted Direct session showing "Claude is showing a start-up dialog …
  // appear only in the terminal" over an [Open Terminal] button, next to a
  // Terminal tab that correctly said there was no terminal. Two surfaces in one
  // window contradicting each other.
  //
  // ⚠️ THE QUESTION IT ANSWERED IS STILL OPEN, and deleting the bar does not
  // close it: what should be said when the CLI keeps a decision for itself?
  // Today it cannot — there is no TUI to keep one in, and the three states this
  // bar drew (a CLI-kept permission prompt, the idle "waiting for your answer"
  // nag, a start-up dialog) either cannot arise or arrive answerably over
  // `can_use_tool`. §5.10 and P7's third line still require an honest answer if
  // that changes, and **E18-11** owns it. Until then, silence beats sending
  // someone to a place that does not exist.

  React.useEffect(() => {
    let cancelled = false;
    void window.switchboard.transcripts.blocks(props.sessionId).then((b) => {
      // `answered` BEFORE the cast (#650). `transcripts:blocks` is declared
      // `Promise<unknown[]>`, so this cast is the only thing between the wire
      // and the block list the feed renders - and a refusal cast into
      // `FeedBlockDto[]` reaches `blocks.map` on the very next render and takes
      // the whole feed down. An empty feed is the fail-open: the session keeps
      // running and the live `onBlock` stream still fills it from here on.
      if (cancelled) return;
      setBlocks((answered(b) ?? []) as FeedBlockDto[]);
      // a REPLACEMENT, not an addition — see `useFeedSkipping`'s `conversation`
      setConversation((n) => n + 1);
    });
    const off = window.switchboard.transcripts.onBlock((p) => {
      if (p.sessionId !== props.sessionId) return;
      // upsert: the watcher re-emits a block when its OUT / duration lands
      setBlocks((prev) => upsertBlock(prev, p.block as FeedBlockDto));
    });
    // a corrected mis-bind, a /clear, or a conversation that moved (#790)
    // restarts the stream from seq 1 â€” drop the stolen blocks or the shorter
    // correct transcript leaves the old tail
    const offReset = window.switchboard.transcripts.onReset((p) => {
      if (p.sessionId !== props.sessionId) return;
      setBlocks([]);
      // seqs start again from 1: a remembered seq would open a stranger's fold
      setOpenFolds(NO_FOLDS);
      setConversation((n) => n + 1);
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
  // when the card becomes visible again â€” unless the user scrolled up.
  // Direct scrollTop after a layout frame; scrollIntoView proved flaky for
  // restored sessions with big replayed histories (Dan 2026-07-23: opening
  // a restored card landed at the TOP).
  const autoPin = React.useRef(false); // our own scrolls must not unpin
  const content = React.useRef<HTMLDivElement | null>(null);
  // Where the user was reading. Dockview HIDES a background panel, and a hidden
  // element's scrollTop is reset to 0 by the browser â€” so coming back to a
  // session you had scrolled up in used to dump you at the very top, with
  // nothing to put you back (the tail-pin only ever knew how to reach the
  // BOTTOM). Dan, 2026-07-26: clicking an Events row scrolled the session to
  // the top. Probed: read at 7014 â†’ switch away â†’ return at 0, and it stayed
  // there because an unpinned view was never restored.
  const lastTop = React.useRef(0);
  /**
   * Where the scroller physically IS, as of the last event or our own last write.
   *
   * ⚠️ NOT `lastTop`, AND THE SPLIT IS THE POINT (#967, found in review). The two
   * were briefly the same ref and they are two different facts:
   *
   *   * `lastTop` is the user's READING POSITION — the thing #555 and #562 restore
   *     them to. It may only ever be written from something the user did.
   *   * this is a bookkeeping value, written by every scroll event and by every
   *     scroller write we make, and read for one purpose: `scrollTop - knownTop`,
   *     which is how the pin rule tells a moved viewport from moved content.
   *
   * Sharing one ref meant a layout scroll, a clamp during a re-show, or our own pin
   * could overwrite the reading position with somewhere the user never chose — and
   * the #555 backstop below keys off `lastTop.current > 0`, so a clamp to 0 would
   * have disabled the recovery permanently.
   */
  const knownTop = React.useRef(0);
  // set while a re-shown panel still owes the user their position back
  const owesRestore = React.useRef(false);
  // the scroller had zero height last time we looked â€” i.e. it was hidden
  const wasCollapsed = React.useRef(false);
  // When the user last actually TOUCHED the scroller. `pinned` used to be
  // derived from a raw measurement, which cannot tell "the user scrolled up"
  // apart from "something above the fold got taller". Dan, 2026-07-26: after
  // allowing a permission the feed sat short of the bottom with output cut
  // off. Probed â€” the approval bar docks BELOW the scroller, so it shrinks the
  // viewport by ~95px, and any scroll event sampled in that window reads as
  // "95px from the bottom â†’ they must have scrolled up" and unpins the tail
  // for good. Real Claude output reflows constantly (markdown, code, tool
  // results), so it only takes one unlucky sample. Only a real gesture may
  // change the pin now.
  const lastGesture = React.useRef(0);
  const GESTURE_MS = 500;
  /**
   * WHAT that touch was (#1111) — `lib/feed-pin.ts` decides what each kind can do.
   *
   * The clock alone was the bug: a click opened the same window a wheel did, and
   * at the 1,000-block cap `scrollTop` goes DOWN on every arriving block (the
   * oldest is evicted and scroll anchoring compensates), so "something was
   * touched, and the number went down" was true after every click in a long
   * session. Reproduced, 23 unpins in 44 clicks — the probe is `spike/probes/1111/`.
   */
  const lastGestureKind = React.useRef<FeedGesture | null>(null);
  /** where the button went down, so a click can be told from a drag */
  const pressAt = React.useRef<{ x: number; y: number } | null>(null);
  /**
   * `kind` omitted means "the same gesture, still going" — the scroll handler's
   * way of keeping a scrollbar drag or a momentum scroll alive without claiming
   * to know it became something else.
   */
  const markGesture = React.useCallback((kind?: FeedGesture) => {
    lastGesture.current = Date.now();
    if (kind !== undefined) lastGestureKind.current = kind;
  }, []);
  /**
   * Say so, every time the conversation stops following (#1111).
   *
   * One line per unpin, with what caused it and the numbers the rule saw. The
   * main window's console is already copied into the app log, so the next
   * "it stopped scrolling" report arrives with its own explanation — rounds one
   * and two of this bug were both argued from the code because there was nothing
   * to read. Not behind a switch: this fires when somebody scrolls away, not per
   * block, so there is nothing to make cheap.
   */
  const noteUnpin = React.useCallback((cause: string, delta: number, away: number): void => {
    console.info(
      `[feed-pin] stopped following: cause=${cause} delta=${Math.round(delta)} ` +
        `away=${Math.round(away)} blocks=${blocksRef.current.length}`
    );
  }, []);
  /**
   * The way back (#442).
   *
   * `pinned` is a ref, so React cannot see it and nothing on screen ever said
   * whether the view was following the conversation or had been left behind.
   * MEASURED at the CI runner's geometry (1010x657 window, 288px feed, a
   * 2,313px conversation): entering the #174 keyboard walk unpins the tail â€”
   * `onFeedKeyDown` marks a gesture and the focus scroll is then read as the
   * user's own, which is the rule working as designed â€” and after that the
   * ONLY ways back are a scroll gesture that lands within 40px of the bottom
   * (mouse wheel, or End/PageDown with focus on the region itself). Inside the
   * walk there is no key that returns to the tail at all: `End` moves to the
   * last EXPANDER, which in a conversation whose tail is prose is nowhere near
   * the last block (measured: scrollTop stayed 0 of 2,201).
   *
   * None of that is wrong â€” unpinning on a jump is deliberate, and `jumpTo`
   * does it explicitly â€” but it left a state with no visible exit. This mirror
   * of the ref is what lets one appear.
   */
  const [offTail, setOffTail] = React.useState(false);
  const syncOffTail = React.useCallback((): void => {
    const el = scroller.current;
    if (!el) return;
    // Only when there is somewhere to go back TO. A conversation that fits its
    // pane IS at its tail, so a chip there would be a control that does
    // nothing â€” and 40px is the same slack the pin rule itself uses, so the
    // two can never disagree about whether the feed overflows.
    setOffTail(!pinned.current && el.scrollHeight > el.clientHeight + TAIL_SLACK);
  }, []);
  const pin = React.useCallback((): void => {
    const el = scroller.current;
    if (!el) return;
    autoPin.current = true;
    el.scrollTop = el.scrollHeight;
    // ⚠️ RECORD WHERE WE PUT IT (#967) — in `knownTop`, never in `lastTop`. The pin
    // rule compares `scrollTop` against this, so a pin that did not write it would
    // make its own landing look like a user scroll; writing the READING position
    // here instead would tell a later restore that the user had chosen the bottom.
    // Read BACK rather than assumed: the browser clamps to
    // `scrollHeight - clientHeight`.
    knownTop.current = el.scrollTop;
    requestAnimationFrame(() => (autoPin.current = false));
  }, []);
  /**
   * What the chip does: take the wheel back. Deliberately NOT `markGesture()` â€”
   * a gesture window opened here would let the next layout scroll re-derive the
   * pin from raw distance, which is the very trap that strands the view.
   */
  const jumpToLatest = React.useCallback((): void => {
    pinned.current = true;
    // whatever took them away is over (#1111): a wheel-up half a second ago must
    // not be believed about the first block evicted after they came back
    lastGestureKind.current = null;
    owesRestore.current = false;
    // `pin()` records where it actually landed (#967), so there is nothing to
    // guess at here any more — this used to set `lastTop` to `scrollHeight`, which
    // is not even a position the scroller can hold.
    pin();
    setOffTail(false);
    // The control REMOVES ITSELF on success, so something has to catch the
    // focus it was holding â€” otherwise a keyboard user lands on `<body>` and
    // their next Tab starts from the top of the window (Â§5.32). The
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
    // `knownTop` only (#967). Writing `lastTop` back here would RATCHET the saved
    // position toward zero: this runs from the ResizeObserver, i.e. mid-relayout,
    // exactly when `scrollHeight` can be transiently short — the write clamps, and
    // saving the clamped value as the user's intent would move it a little closer to
    // the top on every re-show that caught a short layout.
    knownTop.current = el.scrollTop;
    requestAnimationFrame(() => (autoPin.current = false));
    owesRestore.current = false;
  }, []);
  React.useEffect(() => {
    if (!props.visible || !pinned.current) return;
    // ⚠️ RE-CHECKED INSIDE THE FRAME (#967, found in review). The guard above runs at
    // EFFECT time and `pinned` is a ref, so flipping it in `onScroll` neither re-runs
    // this effect nor cancels the frame: the last block of a burst queues a pin, the
    // user wheels up inside that frame, and the pin fires anyway and yanks them back.
    // That was already true before this item; what made it worth fixing now is that
    // `pin` writes `knownTop`, so the yank would also have made the NEXT event look
    // like the user moving — a one-frame race turning into a lost reading position.
    const id = requestAnimationFrame(() => {
      if (pinned.current) pin();
    });
    return () => cancelAnimationFrame(id);
  }, [blocks, props.visible, pin]);
  // becoming visible again is when the position was lost â€” claim the debt and
  // pay it as soon as there's layout to pay it with
  React.useEffect(() => {
    if (!props.visible) return;
    owesRestore.current = true;
    const id = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(id);
  }, [props.visible, restore]);
  /**
   * Put the view back where this session belongs, from whatever just happened
   * to it â€” the ONE rule, so the resize path and the dock-move path below
   * cannot drift into two different answers about the same scroller (#555).
   */
  const reconcile = React.useCallback((): void => {
    const s = scroller.current;
    if (!s) return;
    // COLLAPSE is the real signal that a position is about to be lost, not
    // props.visible: dockview hides a background panel by collapsing an
    // ANCESTOR, so our visible prop never changes and React never learns the
    // panel went away â€” but the scroller's own height drops to 0 and comes
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
    // scrollTop nor reports a zero-height frame â€” it simply reappears at full
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
  /**
   * Let the conversation skip the blocks nobody is looking at (#740).
   *
   * The reason a keystroke in a long session is expensive is that any layout
   * invalidation in this panel re-lays-out EVERY block, and the fix is the only
   * one that measured: skip the off-screen ones, standing each on its own
   * measured height rather than the global guess that reverted the first
   * attempt. 400 blocks, 4x CPU throttle: the keystroke's layout bill goes
   * 28.5ms -> 7.3ms against a 1.7ms floor, the frame goes 43.3ms -> 16.6ms —
   * i.e. back inside one frame — and `scrollHeight` stays EXACT, which is what
   * the restore contract above rides on. `lib/feed-skipping.ts` carries the
   * measurements; every copy of them in the tree quotes the same run.
   *
   * ⚠️ THIS CALL MUST STAY ABOVE THE `ResizeObserver` EFFECT BELOW, AND THE
   * REASON IS NOT TIDINESS (found in review).
   *
   * Both are passive effects, so the order of the two hook calls fixes the
   * order the two ResizeObservers are CREATED in — and the spec runs a
   * document's observers in creation order. That ordering is what makes the
   * dangerous case safe: a panel re-shown at a new width delivers to this
   * hook's observer FIRST, which drops every stale height and strips the skip
   * styling, and only then to `reconcile`'s, so `restore()` reads a
   * `scrollHeight` built on a real layout.
   *
   * Move this below `reconcile` and `restore()` reads a `scrollHeight` still
   * standing on heights measured at the OLD width, writes a `scrollTop` the
   * browser clamps, and then clears `owesRestore` so nothing ever retries it.
   * That is #555 and Dan's 2026-07-26 bug, reproduced exactly.
   */
  useFeedSkipping(scroller, content, conversation);
  // Self-healing pin (Dan round 5: cards you SWITCH to sat at the top after
  // app start): a one-shot pin can land while the panel has no layout yet â€”
  // dockview shows background panels a frame later, restore relayouts, and
  // markdown reflows â€” so scrollHeight was 0 and the write was a no-op with
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
   * React never re-renders â€” the same elements come back â€” and NOTHING here
   * hears about it: no scroll event fires, and the panel returns at exactly the
   * size it left, so the resize observer above never delivers and takes its own
   * detach backstop with it.
   *
   * MEASURED, two docked groups and a click on a card's own rail row: scrollTop
   * 1491 -> 0, a `MutationObserver` on the document saw DETACHED/REATTACHED,
   * an `IntersectionObserver` on this element fired once at startup and never
   * again, and the resize observer never fired at all. `pinned` stayed true, so
   * `offTail` stayed false and #442's way back never appeared either â€” the
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

  // Keyboard path into the conversation (#174, Â§5.32 "keyboard-complete").
  //
  // The scroller is ONE tab stop â€” a labelled region â€” and the arrow keys move
  // between the operable controls inside it: the expanders (`FeedExpander`) and,
  // since #477, the copy buttons on code. `FEED_STOP_SELECTOR` is that list, and
  // it lives in `feed-keys.ts` next to the keys so a renderer adding a control
  // has one place to look. The list is read off the DOM at keystroke time rather
  // than kept in state: the DOM already holds every stop in exactly the order
  // the eye reads them, and blocks stream in and out constantly, so any registry
  // we kept would be a second copy to get wrong.
  const [inFeed, setInFeed] = React.useState(false);
  const onFeedKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    const root = scroller.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>(FEED_STOP_SELECTOR));
    const active = root.ownerDocument.activeElement as HTMLElement | null;
    const action = feedKeyAction(e.key, {
      count: els.length,
      current: active ? els.indexOf(active) : -1,
    });
    // AFTER the walk has had its say (#1111): Shift, Ctrl+C and a letter cannot
    // scroll anything, and only a key that can may be believed about an upward
    // movement that follows it.
    markGesture(keyGesture(e.key, e.shiftKey, action !== null));
    if (!action) return; // not ours: the button or the scroller gets it
    e.preventDefault();
    if (action.kind === 'exit') root.focus();
    else els[action.index]?.focus();
  }, [markGesture]);

  // â”€â”€ Session find (P2-E17-02, Â§5.31) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  //
  // What the feed owes the find bar: take me to block `seq`, expanding
  // whatever the view was hiding. The SEARCH itself is main's (E17-01) and the
  // bar's; this is only the "and show me" half.
  const [reveal, setReveal] = React.useState<FeedReveal>(NO_REVEAL);
  // What the marks are painted from (#520). NOT in `FeedReveal`, which is a
  // context every block renderer reads: the term changes on every keystroke and
  // putting it there would re-render the whole conversation to repaint marks
  // the DOM pass writes anyway. Held as state rather than a ref because the
  // layout effect below has to re-run when it changes â€” a new term over the
  // same landed block is the common case while typing.
  const [markQuery, setMarkQuery] = React.useState<FindQuery | null>(null);
  // read by `jumpTo`, which is called from the bar OUTSIDE React's commit and
  // must therefore not close over a render's `blocks`
  const blocksRef = React.useRef(blocks);
  blocksRef.current = blocks;
  const jumpTo = React.useCallback(
    (seq: number, query?: FindQuery): boolean => {
      // The block is not in the view buffer â€” evicted, or not drained yet.
      // Refusing is the point: the caller renders the hit as snippet-only
      // rather than scrolling somewhere arbitrary and calling it the match.
      if (!blocksRef.current.some((b) => b.seq === seq)) return false;
      // same question, same object: React bails out of an identical state, so
      // stepping between hits of ONE search does not re-run the marking pass
      // for the term half â€” only for the block it moved to
      setMarkQuery((prev) => (sameFindQuery(prev, query ?? null) ? prev : (query ?? null)));
      setReveal((prev) => {
        const next = new Set(prev.revealed);
        next.add(seq);
        return { revealed: next, current: seq };
      });
      // The tail-pin would fight us: an unattributed scroll more than 40px
      // from the bottom is read as "layout moved it" and yanked back (see
      // onScroll). Both halves are needed â€” the gesture claims the scroll as
      // the user's, and unpinning stops the next streamed block dragging them
      // away from the hit they just asked for.
      markGesture('jump');
      if (pinned.current) noteUnpin('jump', 0, 0);
      pinned.current = false;
      // (A fold standing over the block opens for the same reveal — see
      // where `applyFolds` is called.)
      // The SCROLL is not done here â€” see the layout effect below.
      return true;
    },
    [markGesture, noteUnpin],
  );
  /** the folds as last rendered, for `toggleFold` — a callback that must stay
   *  the same function across renders, or every `FoldRow` re-renders with it */
  const foldsRef = React.useRef<ReadonlyMap<number, FoldRun & { open: boolean }>>(new Map());
  /**
   * Open or shut one fold (#1130).
   *
   * OPENING UNPINS, deliberately. A fold at the bottom of a conversation that
   * is following its tail would otherwise unfold twenty rows and be carried up
   * out of the window by the very pin that was keeping the newest message in
   * view — the row you clicked gone, and its last few calls where it was. You
   * asked to read this list, so the view stays on it; "Jump to latest" is the
   * way back, exactly as it is after a find jump.
   *
   * ⚠️ AND IT RECORDS WHERE YOU ARE READING (found in review). Unpinning is a
   * promise that `restore()` will put the view back at `lastTop` when this card
   * is shown again — and `lastTop` is otherwise written only by a scroll event
   * or a find jump. Opening a fold grows the content BELOW the row, so
   * `scrollTop` does not move and no scroll event ever fires: a session
   * followed from its tail and never scrolled has `lastTop` 0, and switching
   * away and back would have landed at the top of the conversation (#555).
   *
   * The other half — following again once the fold is shut and the view is
   * back on the tail — is the layout effect below, because it is a question
   * about the content's height AFTER the change has been committed.
   */
  const toggleFold = React.useCallback(
    (head: number): void => {
      const run = foldsRef.current.get(head);
      if (!run) return;
      const opening = !run.open;
      setOpenFolds((prev) => {
        // forget seqs the buffer has evicted, so the set cannot outgrow the feed
        const live = new Set(blocksRef.current.map((b) => b.seq));
        const next = new Set([...prev].filter((seq) => live.has(seq)));
        for (const seq of run.seqs) {
          if (opening) next.add(seq);
          else next.delete(seq);
        }
        return next;
      });
      if (opening && pinned.current) {
        noteUnpin('fold', 0, 0);
        pinned.current = false;
        const el = scroller.current;
        if (el) {
          lastTop.current = el.scrollTop;
          knownTop.current = el.scrollTop;
        }
      }
    },
    [noteUnpin],
  );
  /**
   * After a fold has opened or shut: are we back on the tail? (found in review)
   *
   * `nextPin`'s "landing within the slack follows again" rule runs on a SCROLL
   * event, and a fold changes the content's height without one: shut a fold you
   * opened at the tail and `scrollTop` is the maximum both before and after, so
   * the view sat on the newest message with following switched off — new blocks
   * not followed, and "Jump to latest" offered to someone looking at the
   * latest. So the same question is asked here, once, after the commit.
   *
   * It also takes back an unpin that changed nothing: opening a fold in a
   * conversation too short to scroll leaves nowhere to be but the tail.
   */
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!pinned.current && el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_SLACK) {
      pinned.current = true;
    }
    syncOffTail();
  }, [openFolds, syncOffTail]);
  /**
   * A call the user is reading or standing on must not be folded away under
   * them (found in review).
   *
   * Two calls are two ordinary rows; the third turns all three into one closed
   * row. If you had opened the second to read its detail, or the keyboard was
   * on its expander, that used to unmount it: the detail gone, and focus
   * dropped out of the conversation onto the page. Touching an exploration
   * call puts it in `openFolds`, so the run it later joins forms OPEN — the
   * rows stay exactly where they are and the fold's row appears above them.
   */
  const keepUnfolded = React.useCallback((target: EventTarget | null): void => {
    const el = (target as Element | null)?.closest?.(`[${FEED_SEQ_ATTR}]`);
    if (!el) return;
    const seq = Number(el.getAttribute(FEED_SEQ_ATTR));
    const block = blocksRef.current.find((b) => b.seq === seq);
    if (!block || !isExploration(block)) return;
    setOpenFolds((prev) => (prev.has(seq) ? prev : new Set(prev).add(seq)));
  }, []);
  /**
   * Take the view to the revealed block, after React has committed it.
   *
   * A layout effect rather than a frame scheduled inside `jumpTo`, and the
   * difference is not cosmetic: a verbosity-hidden block does not EXIST in the
   * DOM until the reveal commits, and an expanded one is taller than the one
   * we would have measured. `jumpTo` is called from two places with different
   * scheduling â€” a keypress (React flushes synchronously) and the continuation
   * of an awaited search (normal priority, which React may split across
   * frames) â€” so a one-frame guess is right in one of them and a silent no-op
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
    // `moveCurrentMark` returns null when the landed block has no marks yet â€”
    // it was hidden when the last pass ran â€” and that is the full pass's cue.
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
    // write, so it is the position the user will actually see â€” and moved by
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
    // …and the same goes for the folds opened by hand (#1130)
    setOpenFolds(NO_FOLDS);
  }, [props.sessionId, clearReveal]);

  // `revealed` OVERRIDES the verbosity filter (Â§5.31: find searches what the
  // view is hiding, and jumping expands it). Without this clause, jumping to a
  // hit in a thinking block while the preset is `normal` would scroll to a
  // block that is not in the list â€” the honest-looking version of doing
  // nothing at all.
  const visibleBlocks = blocks.filter((b) => reveal.revealed.has(b.seq) || blockVisible(b, verbosity));
  // BOTH lists, deliberately — see `agentRunHeads`. Run boundaries come from
  // what is rendered; an agent's NAME and whether that name clashes come from
  // the whole conversation, or a caption would change as blocks scrolled by.
  //
  // Derived per render rather than stored, because `upsertBlock` inserts by seq
  // and evicts at the cap, so a stored grouping would describe a list that no
  // longer exists. Not memoised: a `useMemo` keyed on `visibleBlocks` would
  // recompute every render anyway — that array is rebuilt above — and still pay
  // for the dependency compare. Hoisting the filter and this into ONE memo
  // would be a real saving; it is deliberately not done here because the
  // feed's re-render cost is #740's, and one pass over a list already being
  // walked is not the part worth changing blind.
  // THE FOLDS (#1130), applied AFTER the verbosity filter and BEFORE the
  // grouping. After, because a run is what the reader sees as consecutive.
  // Before, because a closed fold's members are left out of the list outright,
  // and the groups — which are what the engine skips — must be built from what
  // is really going to be in them.
  //
  // A fold is open when the user opened it, or when find is standing on one of
  // its members: `jumpTo` reveals a seq and then looks for that block's
  // element, so a fold that stayed shut would turn a jump into nothing at all.
  // The same rule, for the same reason, that lets `revealed` override the
  // verbosity filter two lines up.
  const layout = applyFolds(visibleBlocks, (run) =>
    run.seqs.some((seq) => openFolds.has(seq) || reveal.revealed.has(seq))
  );
  foldsRef.current = layout.folds;
  const agentHeads = agentRunHeads(layout.rendered, blocks);
  const groups = groupBySeq(layout.rendered);
  /** the conversation's first block never gets a turn rule above it */
  const firstVisible = visibleBlocks[0];
  return (
    // `data-perf-*`: how big this conversation is, and how much of it is on
    // screen, published for E21's detailed capture (#923). The whole premise of
    // #716/#740 is that typing cost scales with these two numbers, so a
    // keystroke sample without them cannot be ranked against another.
    //
    // ATTRIBUTES rather than a hook, a context or a registry, and the reason is
    // the owner's rule that "off means genuinely absent". React writes an
    // attribute only when its value changes, so when the capture switch is off
    // this costs zero JavaScript — whereas any of the other three would be code
    // running in the render path whether or not anyone was measuring. The
    // recorder reads them with `closest()` and this component never learns it
    // exists. Nothing but counts: no id, no title, no path.
    <div
      data-perf-blocks={blocks.length}
      data-perf-rendered={layout.rendered.length}
      style={{ blockSize: '100%', display: 'flex', flexDirection: 'column', background: 'var(--card-bg)' }}
    >
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
        // The conversation as a landmark with a name (#174) â€” and as the single
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
        // WHICH gesture, not merely that there was one (#1111) — a wheel toward
        // the tail and a click cannot scroll the conversation upward, and are
        // not believed about an upward movement that follows them.
        onWheel={(e) => {
          // A wheel with no vertical part (a sideways swipe's drift) and
          // Ctrl+wheel (zoom) scroll nothing here — and recording one would
          // ERASE a wheel-up still in flight, yanking its owner back (review).
          if (e.deltaY === 0 || e.ctrlKey) return;
          markGesture(wheelGesture(e.deltaY));
        }}
        onTouchStart={() => markGesture('touch')}
        onTouchMove={() => markGesture('touch')}
        onPointerDown={(e) => {
          const el = e.currentTarget;
          pressAt.current = { x: e.clientX, y: e.clientY };
          // ⚠️ THE RELEASE ENDS IT, wherever it happens (review). Without this a
          // `drag` or a `scrollbar` outlived its own button: dragging the thumb
          // back to the bottom left the gesture armed, and the next evicted
          // block unpinned the conversation the user had just come home to. On
          // the document, because a drag is released wherever the pointer is.
          const doc = el.ownerDocument;
          const release = (): void => {
            doc.removeEventListener('pointerup', release, true);
            doc.removeEventListener('pointercancel', release, true);
            pressAt.current = null;
            const kind = lastGestureKind.current;
            if (kind === 'drag' || kind === 'scrollbar') lastGestureKind.current = 'press';
          };
          doc.addEventListener('pointerup', release, true);
          doc.addEventListener('pointercancel', release, true);
          if (e.button === 1) return markGesture('middle-button');
          // On the scrollbar: the press landed on the scroller itself, outside
          // the box its content is laid out in. `e.target` FIRST — a click on
          // content then measures nothing, where the rect would force a layout
          // of a thousand blocks mid-stream. `clientLeft` rather than an assumed
          // side, because a right-to-left locale draws the bar on the left; the
          // 1px is the rounding between a fractional rect and an integer width.
          // (An overlay scrollbar would never satisfy this. There is none: the
          // app ships on Windows and Linux, and the feed styles no scrollbar.)
          let onBar = false;
          if (e.target === el) {
            const x = e.clientX - el.getBoundingClientRect().left - el.clientLeft;
            onBar = x < 0 || x >= el.clientWidth - 1;
          }
          markGesture(onBar ? 'scrollbar' : 'press');
        }}
        onPointerMove={(e) => {
          // Only ever promotes a press that began HERE and is STILL HELD:
          // hovering costs one comparison, a released click stays a click, and a
          // drag that started somewhere else and merely crosses the conversation
          // is not ours (`pressAt` is cleared on release).
          const from = pressAt.current;
          const kind = lastGestureKind.current;
          if (e.buttons === 0) {
            // the belt to `release` above: a scrollbar press need not deliver a
            // `pointerup` to the page, but a move with nothing held says the same
            if (kind === 'drag' || kind === 'scrollbar') lastGestureKind.current = 'press';
            pressAt.current = null;
            return;
          }
          if (!from) return;
          if (kind === 'drag') return markGesture('drag');
          if (kind !== 'press') return;
          if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_SLOP_PX) markGesture('drag');
        }}
        onPointerLeave={(e) => {
          // A fast flick upward to select can leave before a single move is
          // delivered inside — moves are coalesced per frame — and a held press
          // that has LEFT is a drag by any measure (review).
          if (e.buttons !== 0 && pressAt.current && lastGestureKind.current === 'press') {
            markGesture('drag');
          }
        }}
        onKeyDown={onFeedKeyDown}
        onScroll={() => {
          const el = scroller.current;
          // a hidden or mid-relayout panel reports clientHeight 0 and scrollTop
          // 0; treating that as "the user scrolled to the top" would both unpin
          // the tail and overwrite the position we're trying to give back
          if (!el || el.clientHeight === 0) return;
          // ⚠️ THE DECISION IS IN `lib/feed-pin.ts` (#967), and it is there because it
          // was forty lines of branching inside this attribute and this is the sixth
          // bug in it (#112, #442, #555, #562, #740, #967) — not one of them reachable
          // from a unit test while it lived here. What stays in the component is the
          // three things only the component can do: read the DOM, move the scroller,
          // and remember where it put it.
          const was = pinned.current;
          const delta = el.scrollTop - knownTop.current;
          const away = el.scrollHeight - el.scrollTop - el.clientHeight;
          const decision = nextPin({
            pinned: was,
            auto: autoPin.current,
            // THE question (#967): did the VIEWPORT move, or did the content move
            // under it? A user scroll changes `scrollTop`; blocks arriving below the
            // fold change `scrollHeight` and leave `scrollTop` exactly where we left
            // it. Sustained streaming is the second thing, continuously — and the old
            // rule, which only knew how long ago something had been touched, read it
            // as the first whenever the user had clicked anything in the conversation
            // within the last half second.
            delta,
            away,
            gestureRecent: Date.now() - lastGesture.current <= GESTURE_MS,
            canScrollUp: canScrollUp(lastGestureKind.current),
          });
          pinned.current = decision.pinned;
          if (was && !decision.pinned) noteUnpin(lastGestureKind.current ?? 'none', delta, away);
          // Bookkeeping, unconditionally: the scroller IS where it now says it is, and
          // the next event's `delta` is measured from here. (`pin()` below overwrites
          // it with where it actually landed.)
          knownTop.current = el.scrollTop;
          if (decision.repin) pin();
          if (decision.userDriven) {
            // a continuing gesture keeps the window alive, so a scrollbar drag or a
            // momentum scroll does not decay mid-movement
            markGesture();
            // HOME, and on the way DOWN: the gesture that brought them here is
            // over, and must not be believed about the next evicted block
            // (review — a touch or a walk that ended on the tail stayed armed).
            // `delta > 0` is load-bearing: the first frames of a wheel-UP are
            // also inside the slack, and disarming there would repin somebody who
            // is leaving. A held scrollbar is left alone; its release disarms it.
            if (decision.pinned && delta > 0 && lastGestureKind.current !== 'scrollbar') {
              lastGestureKind.current = null;
            }
            // THE READING POSITION, and the only place it is written from an event.
            // A layout scroll or a clamp must never be saved as somewhere the user
            // chose to be — see `knownTop`'s docblock.
            lastTop.current = el.scrollTop;
            owesRestore.current = false; // the user has taken the wheel
          }
          syncOffTail();
        }}
        style={{ flex: 1, minBlockSize: 0, overflowY: 'auto', fontSize: 12, lineHeight: 1.5, paddingBlock: 6 }}
      >
        <div
          ref={content}
          // capture, so it is recorded whatever the row itself does with the
          // event — see `keepUnfolded`
          onClickCapture={(e) => keepUnfolded(e.target)}
          onFocusCapture={(e) => keepUnfolded(e.target)}
        >
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
              here â€” see lib/feed-reveal for why it is a context and not props */}
          <FeedRevealProvider value={reveal}>
            {/* IN GROUPS, and the groups are what the engine skips (#716, #1013 —
                the numbers are at `FEED_GROUP_SIZE`). A thousand blocks each
                skipped on its own still cost a streaming reply about a third of
                the window at 4x; twenty-five skipped groups cost nothing that
                could be measured.

                `flow-root` ALWAYS, not only once a group is skipped. A skipped
                group is a formatting context of its own, so a divider's margin
                at its edge stays inside it; the open group has to measure the
                same way or the height it is stood on when it closes would be
                short by exactly that margin.

                The wrapper is ours and it is inert: no role, no tab stop, and
                its attributes are in the namespace the feed takes back from
                every reply. Everything that finds a block — the find jump, the
                keyboard walk, the marks — asks the region for descendants in
                document order, which a wrapper does not change. */}
            {groups.map((g, gi) => (
              <div
                key={g.key}
                {...{ [FEED_GROUP_ATTR]: String(g.key) }}
                {...(gi === groups.length - 1 ? { [FEED_GROUP_OPEN_ATTR]: '' } : {})}
                style={GROUP_STYLE}
              >
                {g.blocks.map((b) => {
                  const fold = layout.folds.get(b.seq);
                  return (
                  <React.Fragment key={b.seq}>
                    {/* WHICH subagent is speaking (#788).

                        The two captions can no longer collide: the turn divider
                        below now skips sidechain blocks. That was a defect this
                        item surfaced rather than caused — a subagent's `user` line
                        is the TASK PROMPT the parent handed it, not a new turn in
                        the human's conversation, and it has been ruling off
                        "NEW PROMPT" above other people's prompts since #640. It
                        read as a stray divider before; beneath an agent caption it
                        would read as the app disagreeing with itself.

                        NOT `aria-hidden`, and that is the deliberate difference
                        from `.turn-divider`. That one is hidden because the prompt
                        under it is already announced as the user's own words, so
                        saying "new prompt" first is reading the furniture out loud.
                        An agent's NAME is announced nowhere else at all: hide it
                        and a screen reader gives three interleaved agents as one
                        voice, which is this item's own bug for a different reader. */}
                    {(() => {
                      const head = agentHeads.get(b.seq);
                      return head ? <div className="agent-divider">{agentCaption(t, head)}</div> : null;
                    })()}
                    {/* A new prompt starts a new turn â€” rule it off (Dan #11), and
                        since #640 rule it off so the eye LANDS on it: scanning a
                        long session, the turn boundaries have to be findable
                        without reading. Everything it looks like is `.turn-divider`
                        in tokens.css, deliberately â€” the ink it writes on the
                        feed's surface is a contrast promise in four themes, and the
                        drift test can only measure a promise the stylesheet holds.
                        `aria-hidden`: this is a landmark for the EYE. The prompt
                        under it is already announced as the user's own words, and a
                        screen reader stopping to say "new prompt" before each one
                        would be reading the furniture out loud. */}
                    {b.kind === 'user' && b !== firstVisible && !b.sidechain && (
                      <div className="turn-divider" aria-hidden>
                        {t('feedView.turnMarker')}
                      </div>
                    )}
                    {/* A burst of looking around, as one row (#1130) — AFTER
                        the two captions, so a fold that opens a subagent's run
                        or follows a prompt still sits under its heading. While
                        the fold is shut this is all its head draws; the head's
                        own block, like the rest of the run, appears when it is
                        opened. */}
                    {fold && (
                      <FoldRow
                        head={fold.head}
                        open={fold.open}
                        searches={fold.searches}
                        reads={fold.reads}
                        latest={fold.latest}
                        sidechain={b.sidechain}
                        onToggle={toggleFold}
                      />
                    )}
                    {(!fold || fold.open) && <Block b={b} />}
                  </React.Fragment>
                  );
                })}
              </div>
            ))}
          </FeedRevealProvider>
          <div ref={bottom} />
        </div>
      </div>
      {/* The way back to the tail (#442), and it is here for two reasons: it is
          where the eye already is â€” the bottom of the conversation, right above
          the composer â€” and it is the ONE place that makes the keyboard path a
          single step. The conversation is one tab stop and the composer is the
          next; a control between them is reached with one Tab from the feed and
          one Shift+Tab from the composer. In the header strip it would have sat
          behind three verbosity chips (Â§5.32).
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
      {/* the working banner â€” LOUD by request (Dan, twice): full-width tinted
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
          place, same weight, different controls â€” because it is the same user
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
        <ApprovalBar
          approval={props.approval}
          queued={props.approvalQueued ?? 0}
          onDecide={props.onDecide}
          onAllowFile={props.onAllowFile}
          colorScheme={props.colorScheme}
        />
      )}
      <Composer
        // The saved draft is seeded ONCE, on mount (#485), so a Composer whose
        // card id changed under it would carry the old card's words onto the
        // new one at the first keystroke. Nothing calls `updateParameters` with
        // a new `cardId` today â€” but `sessionId` DOES churn on resume, the two
        // sit next to each other, and the next reader will not know which is
        // which. `key` makes the hazard structurally impossible for one word.
        key={props.cardId}
        sessionId={props.sessionId}
        // the durable key the saved draft is filed under (#485)
        cardId={props.cardId}
        autonomy={props.autonomy}
        liveAutonomy={props.liveAutonomy}
        model={props.model}
        status={props.status}
        controlsLock={props.controlsLock}
        transport={props.transport}
        onCycleAutonomy={props.onCycleAutonomy}
        // Everything ELSE docked in this column, as one value (#716 review).
        // The composer's height cap is what the panel can spare, which is its
        // own height less the feed's floor less every sibling docked around the
        // conversation â€” and those siblings arrive WHILE YOU ARE TYPING: an
        // approval bar, a question panel, the working banner, the jump-to-latest
        // strip. None of them changes the composer's width or the panel's own
        // height, so neither the ResizeObserver nor any other trigger notices.
        //
        // Until #716 this was free: the cap was recomputed on every keystroke,
        // so the next character healed it. It is not free any more, and that is
        // the one thing the fix genuinely took away â€” so the signal is passed
        // in explicitly rather than re-derived. A string, not an object: it is
        // an effect dependency, and a fresh object would re-measure every render.
        //
        // ⚠️ IT CARRIES THE REQUEST ID BECAUSE IT TRACKS ELEMENT IDENTITY, not
        // merely which KINDS of bar are docked (#981 review). `QuestionPanel`
        // is keyed on `requestId` and therefore REMOUNTS between consecutive
        // questions â€” a new DOM node of a new height, while a `q|q` stamp sat
        // still. The composer now observes these siblings directly, so a stamp
        // that missed the swap would leave it observing a detached node and
        // holding a cap for a column that no longer exists.
        dockedChrome={`${offTail}|${props.approval ? (askQuestions ? 'q' : 'a') : ''}|${props.approval?.requestId ?? ''}|${props.status ?? ''}`}
      />
    </div>
  );
}


/**
 * Inline approval bar (E10-04) â€” docked just above the composer (Dan's
 * 2026-07-22 feedback: it lives where the eyes already are, not at the top).
 */
function ApprovalBar({
  approval,
  queued,
  onDecide,
  onAllowFile,
  colorScheme,
}: {
  approval: {
    requestId: string;
    tool: string;
    input: Record<string, unknown>;
    reason?: string;
  };
  queued: number;
  onDecide: DecideHeld;
  /**
   * Grant every later call on ONE file, and answer this one (#974).
   *
   * A NAMED PROP RATHER THAN A FIFTH POSITIONAL ARGUMENT ON `onDecide`, and
   * that is a direct consequence of #973's review: `onDecide` had quietly lost
   * `updatedInput` and then `reason` at a seam that typechecked either way, and
   * the lesson was that this signature grows badly. Granting a file is also not
   * a KIND of decision — it is a standing preference the bar happens to be a
   * place to set, which is exactly what `sessionStore.setAllowAll` already is
   * beside its own decision.
   *
   * Absent means the host cannot grant (tests, any future embedder), and the
   * button is not drawn rather than drawn dead.
   */
  onAllowFile?: (filePath: string) => void;
  /** absent means the plain panes — see `ApprovalPreview` */
  colorScheme?: 'light' | 'dark';
}): React.JSX.Element {
  const { t } = useTranslation();
  // Which file this call would touch, or null for one that touches none — the
  // SHARED rule (`shared/tool-paths`), so the button cannot offer a path main
  // would not match a later call against.
  const filePath = targetPath(approval.input);
  /** Claude Code asking for its PLAN to be approved, not for a tool (#1071) */
  const isPlan = approval.tool === EXIT_PLAN_MODE_TOOL;
  // WHICH REQUEST the objection field is open for, not merely whether it is
  // open (#973). Consecutive holds in one session reuse this component — the
  // props change and nothing remounts — so a boolean would leave the field open
  // over the NEXT question with the previous one's half-typed text in it, which
  // is an answer the user did not give about a request they have not read. This
  // is the same hazard `QuestionPanel`'s `key={requestId}` exists for, solved
  // where the state lives so it closes SYNCHRONOUSLY: an effect would leave one
  // frame showing the old field under the new heading.
  const [feedbackFor, setFeedbackFor] = React.useState<string | null>(null);
  const feedbackOpen = feedbackFor === approval.requestId;
  // `aria-expanded` needs an `aria-controls` to be worth anything, and several
  // cards render this bar at once, so the id cannot be a literal.
  const feedbackId = React.useId();
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
  return (
    <div
      /* NAMED so a test can say "in the BAR" (#972). The permission's file path is
         also rendered by the Events panel (`events-v2.ts` → `argumentDetail`), so an
         unscoped text assertion can match there while the bar is still showing the
         PREVIOUS request — which is exactly how `stream-approval.spec.ts`'s queue
         test went red on CI and green everywhere else. */
      data-approval-bar={approval.tool}
      style={{
        borderBlockStart: '2px solid var(--status-needs-permission)',
        background: 'color-mix(in srgb, var(--status-needs-permission) 8%, var(--panel2))',
        padding: '8px 10px',
        fontSize: 11,
        /* ⚠️ A FLEX COLUMN THAT CAN SHRINK, AND `minBlockSize: 0` IS THE LOAD-BEARING
           LINE (#972). The bar already defaulted to `flex: 0 1 auto` — shrinkable — but
           a flex item will not go below its content's min-content height without
           this, so a tall body pushed the bar past the bottom of the column and took
           Allow and Deny off the screen with it. MEASURED on Windows CI at a short
           window: `toBeInViewport` on Allow reported a viewport ratio of ZERO, and
           the same overflow is the best explanation for a click that landed on the
           button and never produced a decision.
           The `reason` div below has carried its own version of this guard since
           P2-E18-07 ("long reasons must not shove the buttons off a short card").
           This is that rule applied to the part that is now much taller than a
           reason. */
        display: 'flex',
        flexDirection: 'column',
        minBlockSize: 0,
        /* `gap` AND NOT THE CHILDREN'S MARGINS, because a flex container does not
           collapse them. Margins that had been collapsing in the old block layout
           started stacking the moment this became a flex column, and the bar grew by
           ~40px — enough to squeeze the conversation to 12px and fail #716 on every
           platform. Caught locally this time, which is the only reason it is a
           footnote rather than another CI round trip. */
        gap: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'baseline',
          flexShrink: 0,
        }}
      >
        {/* -ink, not the hue: the title sits on the bar's own 8% tint of that
            same hue, where the hue measures 2.19:1 on daylight and 4.04:1 on
            nordic. The ink lands at 5.08-8.00:1 across the four themes (#246). */}
        <span style={{ fontWeight: 700, color: 'var(--status-needs-permission-ink)' }}>
          {/* "ExitPlanMode" is Claude Code's internal name for a question that
              means "approve this plan?" (#1071) — and a title is not the place
              to teach someone the CLI's vocabulary. */}
          {isPlan ? t('approval.planTitle') : t('approval.title', { tool: approval.tool })}
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
              of ONE question (Â§5.16), and a user who reads the summary on one
              and a different one on the other has been shown two things and
              told they are the same */}
          {/* nothing for a plan (#1071): its one argument IS the body below, and
              the summary of it was the escaped one-liner this item removes */}
          {isPlan ? '' : argumentSummary(approval.input)}
        </span>
      </div>
      {/* The CLI's OWN prose for why it is asking (P2-E18-07, stream transport
          only â€” a hook payload carries nothing like it). Renderable text we did
          not have to write, which is P7 working in our favour.
          `--text`, NOT a hue token: this background is already tinted with
          `--status-needs-permission`, and on nordic the ink IS the hue, which
          measured 3.89:1 in #125. A token validated against a flat background
          is not validated against a tinted one. */}
      {approval.reason && (
        <div
          style={{
            color: 'var(--text)',
            lineHeight: 1.4,
            // long reasons must not shove the buttons off a short card
            maxBlockSize: 64,
            overflow: 'auto',
            flexShrink: 0,
          }}
        >
          {approval.reason}
        </div>
      )}
      {/* What the call would DO, shared with the grouped band (#953). These
          were two inline branches, `old_string`/`new_string` and `command`, so
          the tools the default autonomy gates most often — Write, MultiEdit,
          NotebookEdit — rendered the heading and then nothing, and Allow on
          them was a signature on an unread page. Shared rather than copied for
          the reason the summary line above is shared: §5.16 is ONE question,
          and two placements that answer "what am I agreeing to" differently
          have shown the user two things and called them the same. */}
      <ApprovalPreview input={approval.input} tool={approval.tool} colorScheme={colorScheme} />
      {/* ABOVE the button row and BELOW the body, which is the only place it can
          go. The bar is a flex column whose body is the shrinkable part; the field
          shrinks too (see `DenyFeedbackField`), so opening it takes room from the
          diff and never from Allow and Deny. Putting it under the buttons would
          move them mid-gesture — the #972 failure, where a click that landed on
          Allow produced no decision at all. */}
      {feedbackOpen && (
        <DenyFeedbackField
          id={feedbackId}
          onSend={(reason) => {
            // CLOSED HERE, not left to the request swapping under it (review).
            // The swap is what normally closes it and that path is tested — but
            // a decision can land on nothing (`decidePermission` answers false
            // for a request main no longer holds, and no `permissionResolved` is
            // coming), and then the field would still be open, still populated,
            // and Send still armed over whatever appeared next.
            setFeedbackFor(null);
            onDecide('deny', false, undefined, reason);
          }}
          onCancel={() => setFeedbackFor(null)}
        />
      )}
      {/* `flexShrink: 0`: whatever else gives, the ANSWER does not. §5.16 is about a
          held request being answerable, and a button below the fold is not.

          `flexWrap` SINCE #974, when the row reached five. Without it a narrow
          card overflows horizontally and the buttons past the edge are simply
          unreachable — there is no scrollbar on a flex row and nothing tells the
          user what they are missing. Wrapping makes the row taller instead,
          which costs the diff some height and keeps every answer clickable;
          that is the same trade the whole bar already makes. */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
        <button onClick={() => onDecide('allow')} style={btn(true)}>
          {t('approval.allow')}
        </button>
        {/* §5.16's MIDDLE RUNG (#974), in §5.16's own order: between "this one"
            and "everything". Only for a call that names a file — a `Bash`
            command has nothing to scope a grant to, and `targetPath` is the one
            list main matches against, so the button cannot offer a path the
            router would not recognise. */}
        {onAllowFile && filePath !== null && approval.tool !== ASK_USER_QUESTION_TOOL && (
          <button
            data-approval-allow-file=""
            title={t('approval.allowFileHint', { path: filePath })}
            onClick={() => onAllowFile(filePath)}
            style={btn(false)}
          >
            {t('approval.allowFile')}
          </button>
        )}
        {/* NOT for a question (#563). This bar only ever sees an
            `AskUserQuestion` when its payload failed to parse and the panel
            stood down â€” a rare fallback, but one where "Allow all (this
            session)" reads as "answer all its questions for me", which is not
            what it does and not something anything can do. It is already inert
            for questions on both allow-all paths; hiding it means the button
            never makes a promise the app has deliberately refused to keep. */}
        {/* NOR FOR A PLAN (#1071). The button means here what it means
            everywhere — nothing more is asked until the session next starts —
            so on this bar one press approved the plan AND every change after
            it. Plan mode's promise is "changes nothing until you approve it",
            and the plan is the one request where that promise is the point.
            After Allow the session is an ask session, and the button is on
            its very next bar for anyone who wants it. */}
        {approval.tool !== ASK_USER_QUESTION_TOOL && !isPlan && (
          <button onClick={() => onDecide('allow', true)} style={btn(false)}>
            {t('approval.allowAll')}
          </button>
        )}
        <button onClick={() => onDecide('deny')} style={btn(false)}>
          {t('approval.deny')}
        </button>
        {/* Deny and Deny-with-feedback are SEPARATE buttons, not one button that
            opens a field. A bare Deny is one click today and stays one click;
            routing it through a field would tax the answer this app most wants a
            user to feel free to give. §5.16 lists them side by side for the same
            reason. */}
        <button
          data-approval-deny-feedback=""
          aria-expanded={feedbackOpen}
          aria-controls={feedbackOpen ? feedbackId : undefined}
          title={t('approval.denyFeedbackHint')}
          onClick={() => setFeedbackFor(feedbackOpen ? null : approval.requestId)}
          style={btn(false)}
        >
          {t('approval.denyFeedback')}
        </button>
      </div>
    </div>
  );
}

/**
 * An element's block-axis padding or border, in px â€” the parts of its height
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
  // `> 0`, not `!== ''`: jsdom ANSWERS the logical longhands, with "0" â€” an
  // empty-string check would take that zero for a measurement and size a
  // different box in tests than in the app.
  if (logical > 0) return logical;
  return px(cs.getPropertyValue(`${part}-top${w}`)) + px(cs.getPropertyValue(`${part}-bottom${w}`));
}

/**
 * The conversation keeps its last 60px rather than give it to the box.
 *
 * ⚠️ A FLOOR, NOT A GUARANTEE, and #981 is why that distinction is written down
 * here instead of left to a reader. It binds the OFFER `roomForBox` makes: the
 * box is never told it may have room this floor is standing on. It cannot bind
 * the outcome, because one line of composer beats both limits
 * (`composerBounds`) — so in a panel too short for the floor plus its docked
 * chrome plus one line, the conversation still yields and the box keeps the
 * line. That is deliberate fail-open: a composer too small to show the
 * character being typed is not a composer, and `approval-diff.spec.ts` asserts
 * the same trade one door along (the diff gives way, Allow stays reachable).
 */
const MIN_FEED_PX = 60;

/**
 * The tinted fill a destructive control wears: the crashed hue at 14% over the
 * panel, carrying its own ink and border (#221's shape, #246's edge rule). One
 * constant because the stop button and Clear's confirm must not drift apart --
 * they are the same warning in two places.
 */
const CRASHED_WASH = 'color-mix(in srgb, var(--status-crashed) 14%, var(--panel))';

/**
 * The accessible name for a session control (#903): the full action name, plus
 * the reason when it is locked.
 *
 * The reason is folded into the NAME rather than left in the tooltip, which is
 * where the card's menu leaves it -- a tooltip is a mouse affordance, so a
 * keyboard or screen-reader user meets a dead button and no explanation at all.
 */
function controlName(
  t: (k: string, o?: Record<string, string>) => string,
  nameKey: string,
  lock: SessionControlLock
): string {
  const reason = lockReasonKey(lock);
  return reason ? t('feedView.controlLocked', { name: t(nameKey), reason: t(reason) }) : t(nameKey);
}

/**
 * The options row's chip treatment, worn by all four controls (#1009).
 *
 * THE LOOK IS IN `tokens.css` under `.composer-chip`, and that is the point.
 * This used to be a style FUNCTION, which meant the model chip could — and did
 * — decline to call it and hardcode `var(--faint)`, the disabled ink, while
 * enabled. One class cannot be opted out of by a component that never mentions
 * it, and a `:hover` state cannot be expressed inline at all: an inline
 * background beats any rule on specificity.
 *
 * The `locked` parameter is gone with it. Every call site passed exactly what
 * it also passed to `disabled`, so `.composer-chip:disabled` says it once, in
 * the one place that cannot fall out of step with the attribute — which is
 * precisely how the model chip's busy state would otherwise have stopped
 * deadening the moment its enabled ink stopped being the dim one.
 *
 * NOT to be confused with a CONTEXT chip, which is the other thing this file
 * calls a chip and is a dragged payload rather than a control.
 */
const CHIP_CLASS = 'composer-chip';

/**
 * The tallest the composer's textarea may grow to without pushing anything off
 * the panel â€” see `ComposerMetrics.available` for why a line cap alone is not
 * enough. Undefined when there is no layout to measure (a hidden panel), which
 * leaves the line cap in sole charge rather than guessing a small number.
 *
 * The chrome is `own.offsetHeight - row.offsetHeight` â€” the composer minus the
 * box's own ROW, i.e. padding, the gap and the options row. The row, not the
 * box: the send button holds that row 30px tall however small the box gets, and
 * measuring against the box counted those 30px as chrome â€” the feed kept an
 * extra half-line it was never owed and the box stopped that much early (caught
 * by the e2e's floor assertion, 2026-08-11).
 *
 * That subtraction is why the CHROME term no longer needs the box collapsed,
 * which it did until #716. The row is `max(box, buttons)`, so a taller box adds
 * the same pixels to `own` and to `row` and cancels â€” the answer is the chrome
 * either way.
 *
 * ⚠️ THE SIBLING TERM IS A DIFFERENT STORY, AND #716 MISSED IT (#981). A docked
 * bar does NOT keep the height it asked for: the approval bar is `flex: 0 1
 * auto` with `minBlockSize: 0` on purpose (#972, so Allow stays reachable), so
 * it is SQUEEZED by whatever the composer is currently taking and springs back
 * when the composer lets go. Measured on Windows, one Bash permission docked in
 * a 298px panel: the same bar reports **50px** while the box is tall, **122px**
 * once the box has shrunk. Reading it in the first state and writing a cap the
 * box then honours is a one-way ratchet — the box takes the offer, the bar
 * takes the difference back, and the conversation pays for both. That is the
 * ~49px of #981, and it is why the floor was missed rather than merely tight.
 *
 * So the siblings are measured WITH THE BOX COLLAPSED — the one state in which
 * the column cannot be overflowing on the box's account, which is what makes
 * "what can this panel spare" answerable without already knowing the answer.
 * Measured at 0px and at 40px, the same bar reports 122 both times.
 * `scrollHeight` was measured as the cheaper, non-mutating alternative and
 * rejected on the numbers — the same bar reports 100 squeezed and 120 settled,
 * so it is not the natural height either.
 *
 * ⚠️ ONE READ STILL DEPENDS ON A WRITE, and it is named rather than denied
 * (review): the collapse lands on `min-block-size` once the box has bounds,
 * because `min` beats `max` in CSS — so the siblings are read against a box one
 * line tall, and `remeasure` is what wrote that line. It cannot oscillate,
 * because the minimum is a constant function of line-height and font size and
 * nothing here can move either. A future change that made the FLOOR depend on
 * the room would break that, and would break the no-2-cycle argument at
 * `remeasure`'s dedupe with it.
 *
 * COST, because #716 was a performance item: a write→read pair forces a
 * synchronous layout UNCONDITIONALLY, where a lone `offsetHeight` read forces
 * one only when layout is already dirty — so this is more than the function did
 * before, and the claim worth making is not that it is free. It is that it
 * cannot reach the keystroke path: the cap is exactly the height at which the
 * column stops overflowing, so at the cap `dockedHeight()` is stable and the
 * observer's guard early-returns on every keystroke tick. (That invariant, not
 * "bounds cannot change from typing", is the load-bearing one — a sibling with
 * `flex-grow`, or a smaller `MIN_FEED_PX`, would break it.)
 *
 * ⚠️ WHAT THIS BUYS OVER THE OBSERVER ALONE IS ONE COMMIT, AND THE E2E CANNOT
 * SEE IT. #981 shipped two changes, and each one alone is enough for the
 * SETTLED outcome: with the docked siblings observed, a squeezed-bar
 * measurement is followed by the bar springing back, which fires the observer
 * and measures again, converging on the same answer. Measured — the floor
 * assertion in `feed.spec.ts` passes with this collapse removed. What it does
 * not survive is the FIRST PAINT: without the collapse the same-commit
 * measurement is wrong, the bar docks over a box still holding its old cap, and
 * the conversation is squeezed for the frame before the observer corrects it.
 * That is the one-frame overhang the `confirmClear` note on the layout effect
 * below already refuses to accept, for the same reason and in the same column.
 *
 * IT DOES NOT MOVE THE CONVERSATION, and that was a review hypothesis settled
 * on the binary rather than argued: the feed is the only `flex: 1` child, so
 * the collapse transiently GROWS it and a scroller whose `clientHeight` grows
 * has its `scrollTop` clamped down. Measured (`spike/probes/981`), a feed
 * pinned to the tail at 1883 with 223px of box to give up: clamped to 1692 with
 * the box collapsed, back at 1883 the moment it is restored, and **no `scroll`
 * event dispatched at all** — because the restore is in the same synchronous
 * block, so the net change is zero and nothing is delivered in between. That
 * matters beyond tidiness: a scroll event inside `feed-pin`'s gesture window
 * reads as a deliberate scroll away from the tail and silently unpins.
 */
function roomForBox(own: HTMLElement | null, el: HTMLElement): number | undefined {
  const panel = own?.parentElement;
  const row = el.parentElement ?? el;
  if (!own || !panel || panel.clientHeight === 0) return undefined;
  // The `finally` is the whole safety argument and it belongs to THIS function,
  // not to its callers: collapse and restore are one synchronous block, so no
  // paint, no scroll dispatch and no observation can land between them whoever
  // calls this and from where. Nothing is restored to a REMEMBERED value except
  // the one property written -- `held` is `''` for a box that had no inline cap
  // yet, which puts it back under the stylesheet rather than under a number.
  const held = el.style.maxBlockSize;
  el.style.maxBlockSize = '0px';
  try {
    let taken = MIN_FEED_PX + (own.offsetHeight - row.offsetHeight);
    for (const sib of Array.from(panel.children)) {
      // everything docked around the conversation â€” the verbosity strip, the
      // working banner, an approval bar â€” gets the room it wants; only the
      // scroller (`flex: 1`) is the one that yields
      if (sib === own || sib.hasAttribute('data-feed-region')) continue;
      taken += (sib as HTMLElement).offsetHeight;
    }
    return Math.max(0, panel.clientHeight - taken);
  } finally {
    el.style.maxBlockSize = held;
  }
}

/**
 * Visually hidden, still announced — the same shape `ComposerAttachments` uses
 * for its paste notice. Not `display: none`, which removes the node from the
 * accessibility tree and takes the live region with it.
 */
const COMPLETION_ANNOUNCE_STYLE: React.CSSProperties = {
  position: 'absolute',
  inlineSize: 1,
  blockSize: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
};

/** Visually hidden, still read out — the handoff switch's hint and its status (#1126). */
const HANDOFF_SILENT: React.CSSProperties = {
  position: 'absolute',
  inlineSize: 1,
  blockSize: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
};

/**
 * Prompt composer (P2-E10-02, Â§5.10): an INPUT ROUTE to the real CLI â€” the
 * text is written to the session's PTY exactly as if typed in the terminal
 * (multiline goes as a bracketed paste so the TUI treats it as one prompt).
 */
function Composer({
  sessionId,
  cardId,
  autonomy,
  liveAutonomy,
  model,
  status,
  controlsLock,
  transport,
  onCycleAutonomy,
  dockedChrome,
}: {
  sessionId: string;
  /** durable key for this card's saved draft (#485) â€” the live id churns */
  cardId?: string;
  autonomy?: string;
  /**
   * The mode the session SAYS it is in right now, when the CLI has announced
   * one (#1072) — it leaves plan mode by itself when a plan is approved.
   * `autonomy` above is the card's SETTING, which applies at the next start;
   * the two legitimately differ, and the chip has to say so.
   */
  liveAutonomy?: string;
  model?: string;
  status?: string;
  /** #903: null means the Clear/Compact buttons work; otherwise it says why
   *  they do not. The CARD's answer, never re-derived from `status`. */
  controlsLock: SessionControlLock;
  /** P2-E10-09: only a typed-message transport can carry a pasted image */
  transport?: TransportKind;
  onCycleAutonomy?: () => void;
  /**
   * An opaque stamp of what else is docked in this panel (#716 review).
   *
   * Only its IDENTITY matters: when it changes, something around the
   * conversation appeared or went away, and the room this box may grow into
   * changed with it. See the call site for why nothing else can detect that.
   *
   * It stamps the docked ELEMENTS, not the kinds of bar (#981): a bar that is
   * replaced by another of the same kind is a new node, and this value is what
   * re-subscribes the observer to it.
   */
  dockedChrome?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  // The mode the session has MOVED to, when that is not what the chip sets
  // (#1072): approve a plan and the CLI leaves plan mode by itself. Null in
  // every other case, so the chip reads exactly as it always has.
  const movedTo =
    liveAutonomy && isAutonomy(liveAutonomy) && liveAutonomy !== (autonomy ?? 'ask')
      ? liveAutonomy
      : null;
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
  /** the composer's own root â€” the auto-grow measures the panel through it */
  const root = React.useRef<HTMLDivElement | null>(null);
  /** the options row, whose height stopped being invariant when it learned to
   *  wrap (#903) -- see the ResizeObserver below */
  const optionsRow = React.useRef<HTMLDivElement | null>(null);

  // Clear's confirmation, in the row itself (#903). It is never skipped and
  // never remembered: a fresh Composer asks again.
  const [confirmClear, setConfirmClear] = React.useState(false);
  const clearBtn = React.useRef<HTMLButtonElement | null>(null);
  const cancelBtn = React.useRef<HTMLButtonElement | null>(null);
  /** a confirmation has been opened at least once, so the close owes a focus */
  const returnFocus = React.useRef(false);
  /**
   * A `/compact` is on the wire (#903 review).
   *
   * TWO of them, and the ref is not redundant: the state is what greys the
   * button, but React has not re-rendered by the time a second click in the
   * same tick runs its handler, so `disabled` cannot be the guard. The ref
   * refuses synchronously; the state says so on screen.
   */
  const compactInFlight = React.useRef(false);
  const [compactBusy, setCompactBusy] = React.useState(false);
  /**
   * FOCUS FOLLOWS THE QUESTION, IN BOTH DIRECTIONS, and this is the part the
   * first cut of #903 got wrong.
   *
   * Opening the confirmation UNMOUNTS the button that was focused, which drops
   * focus on `document.body`. Three things break at once: the keyboard user who
   * pressed Enter on Clear has to tab back from the top of the document to
   * answer their own question; the Escape handler on the group is a React
   * synthetic listener and so is unreachable from outside the subtree; and a
   * screen reader is told nothing at all, because nothing moved and there is no
   * live region -- so the next control they find, named "Clear conversation",
   * is the one that WIPES.
   *
   * So focus goes to CANCEL, not to the confirm: a destructive question puts
   * the caret on the safe answer, and landing inside the labelled group is what
   * makes the whole sentence ("Clear this conversation? The session's context
   * starts over.") get announced. On close it goes back to the button that
   * asked. Both are refs, so both resolve in whichever document drew the card
   * -- a popped-out window included (#573).
   */
  React.useEffect(() => {
    if (confirmClear) {
      returnFocus.current = true;
      cancelBtn.current?.focus();
      return;
    }
    if (!returnFocus.current) return;
    returnFocus.current = false;
    clearBtn.current?.focus();
  }, [confirmClear]);
  // A session that dies mid-question takes the question with it: leaving it
  // open would put a live "Clear" in front of a session that cannot be cleared,
  // and re-open it if the card ever came back. The focus return above would
  // land on a button that is now disabled, which is a silent no-op -- so it
  // goes to the prompt box instead, the one thing here that is never locked.
  React.useEffect(() => {
    if (controlsLock === null || !confirmClear) return;
    returnFocus.current = false;
    box.current?.focus();
    setConfirmClear(false);
  }, [controlsLock, confirmClear]);

  // Pasted images (P2-E10-09, Â§5.10). The clipboard RULES are in
  // `lib/composer-attachments.ts`; this end only reacts to a paste event and
  // holds what came out of it.
  //
  // The chips OUTLIVE this component too (#546), by the same argument the text
  // above rests on â€” an image-only prompt is a whole prompt, and losing it to a
  // view-tab switch is losing the lot. They are seeded from a module-level
  // stash rather than from the workspace blob, because their payload must not
  // reach disk; `composer-attachment-draft.ts` has the decision and its why.
  const [attachments, setAttachments] = React.useState<Attachment[]>(() =>
    loadStashedAttachments(cardId)
  );
  /** one line of explanation for a paste that produced nothing, or null */
  const [attachNotice, setAttachNotice] = React.useState<string | null>(null);

  // "Ask it to write the handoff" (#1126). A draft that names ANOTHER session
  // sends a brief on it, built by the app from that session's record. This
  // switch asks the session to write one itself instead — a turn of its usage
  // and a wait here, which is why it is a switch, off by default, and not what
  // a mention does. The owner chose the shape (2026-10-07): in the prompt box,
  // where the mention is typed; and a busy session is never interrupted.
  //
  // WHO THE DRAFT NAMES needs the session list, which the `@` popup only holds
  // while it is open. `mentionable` is that list KEPT for as long as the draft
  // could hold a mention (`mayMention` — an `@` at a word boundary): the popup
  // fills it every time it fetches its own, and it is fetched separately only
  // for a draft that got its `@` without the popup ever opening (a paste, a
  // restored draft). The effect is below, beside the popup's. A draft with no
  // such `@` fetches nothing.
  const [mentionable, setMentionable] = React.useState<SessionSummary[] | null>(null);
  const [askHandoff, setAskHandoff] = React.useState(false);
  // A send that is out, waiting on other sessions to write. In a MODULE store
  // keyed by card, beside the one-send-at-a-time guard it rides with — see
  // `HandoffWait` for what went wrong while it was a `useState` here.
  const handoffKey = cardId ?? sessionId;
  const handoffWait = React.useSyncExternalStore(subscribeHandoffWaits, () => handoffWaitOf(handoffKey));
  const couldMention = !draft.startsWith('/') && mayMention(draft);
  const namedSessions = React.useMemo(
    () => (mentionable ? namedOtherSessions(draft, mentionable, sessionId) : []),
    [draft, mentionable, sessionId]
  );
  const namesSomeone = namedSessions.length > 0;
  const handoffHintId = React.useId();
  // The switch is about THIS draft's mentions. Take the last one out and it is
  // off again — otherwise it would be found already on, out of sight, the next
  // time a name was typed.
  React.useEffect(() => {
    if (!namesSomeone) setAskHandoff(false);
  }, [namesSomeone]);
  const stopHandoffWait = React.useCallback((): void => {
    const wait = cancelHandoffWait(handoffKey);
    if (!wait) return;
    // Under the id the SEND was made with, not the one this card has now: a
    // restarted card has a new live id, and main keyed the wait on the old one.
    // Main answers the waiting call at once and the send's own callback then
    // declines to send.
    void window.switchboard.sessions.cancelHandoff(wait.sessionId).catch(() => {});
    // the button is about to unmount; the draft it left alone is where to be
    box.current?.focus();
  }, [handoffKey]);

  // Messages other sessions sent this card (P2-E11-05, §5.4) — HELD, never
  // sent, until the user presses Enter below. A module-level store keyed by
  // card, like the draft, so they outlive this component; subscribing is also
  // what tells the sender this card's composer is on screen.
  const held = useHeldMessages(cardId);
  // WHEN THIS COMPOSER FIRST SHOWED each one — the clock `SIBLING_SETTLE_MS`
  // runs on (#765 review, round 2). Stamped in an effect, i.e. after the block
  // has been painted, and forgotten when the message leaves. A remount starts
  // the clock again, which is right: a block the user has not seen in this
  // view has not been reviewed in it.
  const seenAt = React.useRef(new Map<string, number>());
  const [settleTick, setSettleTick] = React.useState(0);
  React.useEffect(() => {
    const now = Date.now();
    const ids = new Set(held.map((m) => m.id));
    for (const id of [...seenAt.current.keys()]) if (!ids.has(id)) seenAt.current.delete(id);
    let youngest = -1;
    for (const m of held) {
      const t = seenAt.current.get(m.id) ?? now;
      seenAt.current.set(m.id, t);
      if (now - t < SIBLING_SETTLE_MS) youngest = Math.max(youngest, t);
    }
    if (youngest < 0) return;
    // Re-render once the youngest settles, so Send stops being a dead button.
    const timer = setTimeout(() => setSettleTick((n) => n + 1), youngest + SIBLING_SETTLE_MS - now + 1);
    return () => clearTimeout(timer);
  }, [held, settleTick]);

  // ── The model chip's quick-switch menu (#747) ──────────────────────────────
  //
  // WHERE the menu was asked for, or null for "shut" — the chip's own box, in
  // physical client coordinates, taken at click time rather than kept in a ref
  // a layout change could stale. `ModelQuickMenu` decides which EDGE of it to
  // grow from, because that answer depends on the writing direction and on the
  // room below, neither of which is knowable here.
  const [modelMenuAt, setModelMenuAt] = React.useState<DOMRect | null>(null);
  const modelChip = React.useRef<HTMLButtonElement | null>(null);
  /**
   * A `set_model` from the menu is on the wire.
   *
   * Held HERE and not only in the menu, because the chip is the third door out
   * of it — Escape and click-away are the menu's own and it shuts both while a
   * switch is outstanding, but clicking the chip again unmounts the menu from
   * out here. Without this the keyboard route (the click disables every row,
   * Chromium blurs to `<body>`, Tab reaches the chip, Enter) would tear the menu
   * down mid-switch and the CLI's refusal would land in a torn-down tree — the
   * one failure the menu's hold-open rule exists to prevent.
   *
   * BOTH a ref and state, and the pair is #746's `held` arrangement inverted.
   *
   * The STATE is how the chip's `disabled` learns about it: a control that is
   * dead must also LOOK dead, which is the exact lie `held` fixed on the
   * dialog's OK button.
   *
   * The REF is the authority for the guard, and the difference is **not
   * observable today** — said plainly because a mutation of it stays green.
   * `closeModelMenu` is called from the menu's own `set_model` callback, a
   * closure built one render before the switch started, so a state read there
   * sees `false` and the close works. That is an invariant about closure age
   * rather than about what the code says, and it is the kind that survives
   * until someone memoises a callback. The ref says what is meant.
   */
  /** bumped when Compact or Clear has been sent from this row: the two things
   *  that EMPTY the context, so the meter asks again rather than waiting for a
   *  turn to notice (#715) */
  const [contextRefresh, setContextRefresh] = React.useState(0);
  const modelBusyRef = React.useRef(false);
  const [modelBusy, setModelBusy] = React.useState(false);
  const noteModelBusy = (busy: boolean): void => {
    modelBusyRef.current = busy;
    setModelBusy(busy);
  };
  /**
   * Can we actually switch this session's model?
   *
   * `set_model` rides the CONTROL CHANNEL, which is stream-only — so a
   * Terminal-mode session cannot be switched by us even though it can SHOW a
   * model: the chip renders `model ?? usage?.model` (#746), and that fallback is
   * the transcript's, which a PTY session fills perfectly well. Offering a menu
   * whose every row is a known refusal would be a worse lie than not offering
   * one, so in Terminal mode the chip stays the plain text it has always been
   * and its tooltip says where the switcher actually lives.
   *
   * An empty `sessionId` fails this too: a card whose session has ended keeps
   * rendering its footer, and there is nothing to send a `set_model` to.
   */
  const canSwitchModel = transport === 'stream' && sessionId !== '';
  const closeModelMenu = (): void => {
    // The REF, not the state — see `modelBusyRef`. Belt to the chip's
    // `disabled` braces, which is what actually stops the click getting here;
    // verified rather than assumed, by removing this line and watching the
    // suite stay green.
    if (modelBusyRef.current) return;
    setModelMenuAt(null);
    // …on the NEXT frame: the menu still holds focus until React has committed
    // the unmount, and focusing before that hands it straight back.
    //
    // The chip's OWN window's rAF, not the global one. A popped-out card's DOM
    // is adopted into another window while this code keeps running in the
    // opener's realm, so the global `requestAnimationFrame` belongs to the MAIN
    // window — which Chromium throttles hard while it is occluded behind the
    // popout the user is actually looking at (the hazard this file already
    // documents for the scroll restore). The chip would simply never get focus
    // back.
    const view = modelChip.current?.ownerDocument.defaultView;
    const back = modelChip.current;
    if (view) view.requestAnimationFrame(() => back?.focus());
  };

  // A session that ENDS or RESTARTS under an open menu takes the menu with it.
  //
  // Two different failures, one guard. If the session ends, `canSwitchModel`
  // goes false: the chip reverts to plain text while the menu stays up, aimed
  // at a session id that is now empty. If the session RESTARTS, `sessionId`
  // changes under a menu that would otherwise keep its mount — and the whole
  // reason this component needs no epoch counter is that a sitting ends with
  // its component. Clearing here, plus the `key` on the mount below, keeps that
  // premise true instead of merely stated.
  // Cleared for EITHER change, not only for `canSwitchModel` going false: an
  // open menu belongs to the session it was opened on, and a resumed card gets
  // a brand-new live id with the old menu still floating over it. On mount both
  // are already null, so this costs nothing on the common path.
  React.useEffect(() => {
    setModelMenuAt(null);
    noteModelBusy(false);
    // `noteModelBusy` is re-created every render and is deliberately not a
    // dependency: this must run when the SESSION changes, not whenever the
    // composer re-renders, and it only ever writes.
  }, [canSwitchModel, sessionId]);

  // The one case where the composer has something to say before the user has
  // done anything: a previous run's chips are recorded but their bytes are not
  // here, because they were never written to disk. Saying so is the whole point
  // â€” the failure #546 names is that an image-only prompt vanished SILENTLY.
  //
  // IN AN EFFECT, NOT IN THE `useState` INITIALIZER, and that is an
  // accessibility requirement rather than a preference: the notice lives in an
  // `aria-live` region that `ComposerAttachments` deliberately mounts EMPTY,
  // because a live region that arrives already holding its text is announced by
  // almost nothing (#222's rule, for `FindBar`'s match count). Seeding the
  // state would put the text in on the first frame and silence it.
  //
  // Guarded by a ref rather than by its deps: this must run once per composer,
  // and StrictMode runs every effect twice on the same instance.
  const announcedLoss = React.useRef(false);
  React.useEffect(() => {
    if (announcedLoss.current) return;
    announcedLoss.current = true;
    const lost = lostAttachmentNames(cardId);
    if (lost.length > 0)
      setAttachNotice(t('feedView.attach.notRestored', { names: lost.join(', ') }));
  }, [cardId, t]);

  // The strip, written back on every change. DECLARED AFTER the effect above
  // and therefore run after it, which matters: this is also what CLEARS the
  // recorded names when the strip is empty, so reading them has to happen
  // first. That clear is what stops the notice being repeated on every later
  // remount.
  React.useEffect(() => {
    stashAttachments(cardId, attachments);
  }, [cardId, attachments]);
  // ── NO `canAttach` CONSTANT ANY MORE (#952) ──────────────────────────────
  //
  // It was `transport !== 'pty'`: a stream session takes typed messages and can
  // carry an image block, while a PTY session took KEYSTROKES, and there is no
  // keystroke for a bitmap. The composer is otherwise deliberately
  // transport-ignorant (`lib/composer.ts`), and attachment capability was the one
  // thing it could not discover by TRYING — the try-then-fall-back shape worked
  // because both routes delivered the same thing, which stopped being true here.
  //
  // Every session takes typed messages now, so the value is always true and both
  // it and the branch it guarded are gone. THE QUESTION IS NOT: §5.3's adapter
  // contract admits a provider whose CLI cannot take an image, and when one
  // arrives this is where the check goes back — with a message that names the
  // PROVIDER, since "use Direct mode" will not be the answer.

  /**
   * Ctrl+V.
   *
   * A clipboard with NO files is not our business at all â€” we never call
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
   * files" â€” the classification, the cap, the message â€” must not be able to
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
    // A FOLDER is reported first, and that ORDER is the surviving half of a rule
    // worth keeping: a folder cannot be attached by any session in any mode, so a
    // capability message about it would be nonsense advice.
    //
    // The capability check that followed went with the transport (#952). It read
    // `if (!canAttach) setAttachNotice(t('feedView.attach.terminalMode'))` and said
    // "files can only be sent in Direct mode" — unreachable now that `canAttach`
    // is a constant, and false if it ever fired. `canAttach` keeps its name
    // because §5.3's adapter contract admits a provider whose CLI cannot take an
    // image; when one arrives, the branch comes back here and needs a message
    // that names the PROVIDER rather than a transport.
    if (preRejected === 'directory' && files.length === 0) {
      setAttachNotice(attachMessage('directory'));
      return;
    }
    if (files.length === 0) {
      // A transfer that yielded NOTHING still has to say something. Some drag
      // sources (Outlook, archive tools, virtual-file providers) advertise
      // `Files` and then hand over items whose `getAsFile()` is null â€” and
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
        // knows what actually landed. An overflow here is silent â€” the notice
        // was computed against a stale count â€” which is acceptable only because
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
        // session" is a hard constraint (PHILOSOPHY Â§3).
        setAttachNotice(attachMessage('unreadable'));
      }
    })();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = filesFrom(e.clipboardData);
    if (files.length === 0) return; // plain text â€” untouched, as if we did not exist
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
   * THE COMPOSER SWALLOWS THE DROP â€” `stopPropagation`, exactly as the
   * reference's handler does. That matters here in a way it does not there,
   * because `App.tsx` has a WINDOW-level drop listener that turns a dropped
   * FOLDER into a new session (E3-04). Without the stop, dropping a `.md` on
   * the prompt box would attach the file AND ask the window to open it as a
   * session. Every other surface is untouched: the window listener still sees
   * every drop that does not land on a composer.
   */
  const [dragDepth, setDragDepth] = React.useState(0);
  const dragging = dragDepth > 0;
  /**
   * The in-flight drag is carrying a CONTEXT CHIP, not files (#799 review).
   *
   * Without it the overlay reads "Drop files to attach them to your prompt"
   * over the exact target the manual tells the user to aim a chip at. Set on
   * `dragenter` — which fires per element crossed, so it is refreshed for every
   * new drag — and cleared by the same window-level escape hatch that zeroes
   * the counter, so it cannot outlive the drag that set it.
   */
  const [dragContext, setDragContext] = React.useState(false);

  /** a drag carrying FILES, as opposed to a text selection or an internal drag */
  const hasFiles = (dt: DataTransfer | null): boolean =>
    Array.from(dt?.types ?? []).includes('Files');

  /** …and one carrying another session's CONTEXT CHIP (P2-E11-10, §5.5). */
  const hasContext = (dt: DataTransfer | null): boolean =>
    Array.from(dt?.types ?? []).includes(CONTEXT_DND_TYPE);

  /**
   * The offer behind a chip that has landed here — §5.5's drop dialog is open
   * on it while this is set. `null` is "no drop in progress".
   */
  const [offer, setOffer] = React.useState<ContextOffer | null>(null);

  /** an offer request is on the wire right now — see `onContextDrop` */
  const contextCallOut = React.useRef(false);

  /**
   * A context chip landed on this composer (P2-E11-10, §5.5).
   *
   * IT NEVER INJECTS BLIND. It asks main what that session is offering and puts
   * the answer in front of the user, because the three fidelities differ by an
   * order of magnitude and the largest of them is spent out of THIS session's
   * context window — a choice that belongs to the person, every time.
   */
  const onContextDrop = (fromId: string): void => {
    setAttachNotice(null);
    if (!fromId) return;
    // ONE CHIP AT A TIME (#799 review). Two dropped before the first offer
    // resolves would resolve last-wins, silently discarding the first — and a
    // package build is a real round trip, so the window is not theoretical.
    if (contextCallOut.current) return;
    // A SELF-DROP IS NOT A TRANSFER. A session handed a summary of itself gets
    // a few thousand tokens of what it already knows. Refused OUT LOUD rather
    // than ignored: a gesture that does nothing and says nothing is
    // indistinguishable from the app failing to notice it (#163's lesson), and
    // it is the same call `@Name` makes when it resolves to its own session.
    if (fromId === sessionId) {
      setAttachNotice(t('feedView.context.selfDrop'));
      return;
    }
    const call = window.switchboard.sessions.contextOffer?.(fromId);
    // No bridge method at all — a partial `window.switchboard` in a unit
    // harness, or a host that wired no package builder. Same user-visible
    // outcome as any other failure, and said rather than swallowed.
    //
    // `=== undefined` rather than `!call`: a truthiness test on a value that
    // may be a Promise is `no-misused-promises`, and rightly — a pending
    // promise is always truthy, so the shape invites reading "did it work"
    // off a value that only says "a call was made".
    if (call === undefined) {
      setAttachNotice(t('feedView.context.failed'));
      return;
    }
    contextCallOut.current = true;
    void call.then(
      (raw) => {
        contextCallOut.current = false;
        // `answered` BEFORE anything reads it (#650): a broker refusal is a
        // truthy object, and `isContextOffer` is not one of the launderers the
        // scanner recognises. Both a refusal and a malformed answer land as "no
        // offer", which is what the user is told.
        const got = answered(raw);
        if (!isContextOffer(got)) {
          setAttachNotice(t('feedView.context.failed'));
          return;
        }
        setOffer(got);
      },
      () => {
        // Released on BOTH arms: a guard that can stay latched would refuse
        // every later drop for the life of the card, which is worse than the
        // discarded offer it exists to prevent.
        contextCallOut.current = false;
        setAttachNotice(t('feedView.context.failed'));
      }
    );
  };

  /**
   * OK in the dialog: park the chosen text in THIS card's composer.
   *
   * Nothing is submitted, here or anywhere on this path — the block waits for
   * the user's Enter exactly as a sibling's message does (§5.4), which is the
   * seam #765 built and this item rides rather than opening a second one.
   */
  const onContextChoose = (from: ContextOffer['from'], option: ContextOfferOption): void => {
    const result = holdContextBlock(cardId, from, option.text);
    setOffer(null);
    // REFUSED OR QUEUED, NEVER SILENT — §5.5's rule. And REFUSED WITH THE REAL
    // REASON (#799 review): these used to collapse into "this session is
    // already holding as much as it can", which is a specific, actionable claim
    // and is false for two of the three — telling someone their box is full
    // when it is empty hands them an action that cannot help.
    setAttachNotice(
      result === 'held'
        ? t('feedView.context.held', { name: from.name })
        : t(`feedView.context.${result === 'full' ? 'full' : result === 'empty' ? 'emptyOption' : 'noCard'}`)
    );
    // The whole point of the gesture is "now press Enter here", so it ends with
    // the caret where that happens. Without this the OK button is removed from
    // under the focus and it lands on `<body>` — every other send path in this
    // file ends the same way.
    box.current?.focus();
  };

  /**
   * THE ESCAPE HATCH for the counter.
   *
   * Every `dragenter` is supposed to be matched by a `dragleave` or a `drop`,
   * and if that ever fails to hold the overlay stays up over a composer the
   * user is trying to type into. `dragend` fires on the source when a drag
   * finishes ANY way â€” cancelled with Esc, dropped on another window, abandoned
   * â€” and a window-level `drop` catches the case where the pointer left us and
   * landed somewhere else. Both simply zero the counter, so a stuck overlay
   * cannot outlive the drag that caused it.
   */
  React.useEffect(() => {
    const clear = (): void => {
      setDragDepth(0);
      setDragContext(false);
    };
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, []);

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e.dataTransfer) && !hasContext(e.dataTransfer)) return;
    e.preventDefault();
    setDragContext(hasContext(e.dataTransfer));
    setDragDepth((d) => d + 1);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e.dataTransfer) && !hasContext(e.dataTransfer)) return;
    // preventDefault on dragover is what MAKES this a drop target; without it
    // the browser refuses the drop and shows the "no entry" cursor
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  /**
   * NOT guarded on `hasFiles`, deliberately â€” unlike its enter twin.
   *
   * The counter only balances if enter and leave agree about every event, and
   * they read the same `dataTransfer.types` at two different moments in a drag.
   * A source that advertises `Files` on the way in and not on the way out would
   * increment and never decrement. `Math.max(0, â€¦)` already floors it and only
   * one drag can be in flight, so an unconditional decrement is strictly safer
   * than a symmetric guard.
   */
  const onDragLeave = (): void => setDragDepth((d) => Math.max(0, d - 1));

  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    // BEFORE the guard: a drop is the end of a drag however it is shaped, and a
    // counter left standing here is exactly the stuck overlay above.
    setDragDepth(0);
    // A CONTEXT CHIP, CHECKED BEFORE THE FILE GUARD (P2-E11-10). The id is read
    // SYNCHRONOUSLY for the same reason the folder/file split below is: a
    // `DataTransfer` is neutered the instant this handler returns, so the one
    // fact the whole gesture depends on has to come out now, even though
    // everything done with it happens after an await.
    if (hasContext(e.dataTransfer)) {
      const fromId = e.dataTransfer.getData(CONTEXT_DND_TYPE);
      e.preventDefault();
      // Swallowed like a file drop, and for the same reason: `App.tsx` has a
      // window-level listener that turns a drop into a new session.
      e.stopPropagation();
      onContextDrop(fromId);
      return;
    }
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

  // Slash-command autocomplete (E10-07, Â§5.10): typing '/' as the FIRST
  // character pops the list â€” CLI builtins + the project's/user's own
  // commands and skills. Selecting only INSERTS text; submission stays a
  // plain PTY write and the real CLI executes the command.
  //
  // `@session` autocomplete (P2-E11-07) is the SAME popup, not a second one:
  // one list of rows, one `selected`, one `dismissed`, one keydown block. What
  // differs is only the token rule (a mention is mid-sentence, a slash command
  // is line-initial — see `shared/mention-token.ts`) and where the rows come
  // from (`summariesFrom`, the bus's own list, over `sessions:summaries`).
  const [caret, setCaret] = React.useState(0);
  const [commands, setCommands] = React.useState<SlashCommand[] | null>(null);
  const [summaries, setSummaries] = React.useState<SessionSummary[] | null>(null);
  const [selected, setSelected] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(false);
  /** The `@` Escape was pressed on — that mention stays closed until a different `@` (review, #797). */
  const [mentionDismissedAt, setMentionDismissedAt] = React.useState<number | null>(null);
  /**
   * The user MOVED the highlight (arrows or pointer) since this completion
   * opened. On a mention, Enter completes a substring match only when they did
   * — see `mentionEnterAction`. Reset whenever the completion changes.
   */
  const [navigated, setNavigated] = React.useState(false);

  /**
   * A send is out and has not come back yet (#774) — ONE AT A TIME FROM THIS CARD.
   *
   * Only the attachments path can be in this state for any length of time: a
   * text prompt cannot be refused, so that branch clears the box in the same
   * tick and there is no window to press Enter into. With attachments the box
   * is deliberately NOT cleared until main says it went (a refused send must
   * not silently eat a pasted screenshot), and reading a dropped 4 MB file is
   * real time — so the second Enter lands on a composer still showing
   * everything the first one sent, and sends it all again.
   *
   * That was true before P2-E11-05 and cost a duplicate prompt. It is worse
   * now: the held sibling messages are removed only in the same resolved
   * branch, so the second Enter forwards them A SECOND TIME, each under a
   * header saying the user reviewed and sent it.
   *
   * TWO PIECES BECAUSE THEY ANSWER DIFFERENT QUESTIONS, and neither can do the
   * other's job:
   *  - `isSendInFlight` is the GUARD, and it is deliberately NOT component
   *    state or a ref. It is keyed by card in `lib/sibling-inbox.ts`, because
   *    this composer unmounts on a view-tab switch while the attachments and
   *    the held messages both survive it — a local flag came back fresh on
   *    remount and let the same payload go twice (#774 review).
   *  - `sendPending` only GREYS the Send button, because this file's rule is
   *    that a lit Send button doing nothing is a small lie. It is a
   *    SUBSCRIPTION to the same flag rather than local state, for the same
   *    remount reason: the release lands in a closure belonging to the
   *    component that started the send, which by then may not be this one.
   */
  const sendPending = useSendInFlight(cardId);
  const slash = dismissed ? null : slashToken(draft, caret);
  // Precedence is written down, not assumed: `/(@x` is a real draft in which
  // BOTH tokens hold (`(` is a mention boundary inside a slash token), and the
  // slash popup keeps it.
  const rawMention = slash !== null ? null : mentionToken(draft, caret);
  // Escape on a mention closes it FOR THAT @WORD (review, #797): typing more of
  // the same word keeps it closed, and a new `@` elsewhere opens again. The
  // slash popup's `dismissed` boolean is untouched.
  const mention = rawMention !== null && rawMention.at !== mentionDismissedAt ? rawMention : null;
  // `token` stays the SLASH token: the command fetch and the #163 Enter rule
  // below key on it, unchanged.
  const token = slash;
  /** One popup row, whichever list it came from — so there is one row renderer. */
  type CompletionRow = {
    kind: 'slash' | 'mention';
    key: string;
    label: string;
    detail: string;
    badge: string;
    /** a session's colour; `?? 'var(--faint)'` is the same backstop every row that paints a session uses */
    accent?: string;
    /** what gets inserted: the command name, or the session's display name */
    name: string;
  };
  const popup: CompletionRow[] =
    slash !== null
      ? commands === null
        ? []
        : filterCommands(commands, slash).map((c) => ({
            kind: 'slash' as const,
            key: `${c.source}:${c.name}`,
            label: '/' + c.name,
            detail: c.description ?? '',
            badge: t(`feedView.slashSource.${c.source}`),
            name: c.name,
          }))
      : mention !== null && summaries !== null
        ? filterSummaries(summaries, mention.query, sessionId).map((s) => ({
            kind: 'mention' as const,
            key: `session:${s.id}`,
            label: '@' + s.name,
            detail: s.folder,
            badge: s.exited ? t('feedView.mentionExited') : '',
            accent: s.accentColor ?? 'var(--faint)',
            name: s.name,
          }))
        : [];
  const popupOpen = popup.length > 0;
  const syncCaret = (): void => setCaret(box.current?.selectionStart ?? 0);
  const popupWanted = slash !== null;
  const mentionWanted = mention !== null;
  /** Which completion is live, as one comparable key: the selection resets when it changes. */
  const completionKey = slash !== null ? `/${slash}` : mention !== null ? `@${mention.at}:${mention.query}` : '';
  React.useEffect(() => {
    // fetch on every popup OPENING (not each keystroke) so a just-added
    // command file shows up without restarting anything
    if (!popupWanted) {
      setCommands(null);
      return;
    }
    let cancelled = false;
    void window.switchboard.sessions.slashCommands(sessionId).then((list) => {
      // #650: the brand in `commands` is `.filter`ed by the popup on the next
      // keystroke. `[]` and not `null`: both draw an empty popup, but they are
      // different facts â€” `null` is "not fetched yet" (what the branch above
      // sets when the popup closes) and `[]` is "asked, and there are none".
      // A refused read did finish asking, so `[]` is the honest one.
      if (!cancelled) setCommands(answered(list) ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [popupWanted, sessionId]);
  React.useEffect(() => {
    // The session list, fetched on every @-popup OPENING exactly as the command
    // list above is: a session opened a moment ago is offered without a restart.
    // `[]` for a refused read, `null` only for "not fetched" — the same two
    // facts the command fetch keeps apart (#650).
    if (!mentionWanted) {
      setSummaries(null);
      return;
    }
    let cancelled = false;
    void window.switchboard.sessions
      .summaries()
      .then((list) => {
        if (cancelled) return;
        const got = answered(list) ?? [];
        setSummaries(got);
        // ...and the handoff switch reads the same list (#1126), kept after the
        // popup closes — ONE fetch per opening still, not one each.
        setMentionable(got);
      })
      // A REJECTED invoke is an answer too (review, #797): left at `null`, the
      // in-flight guard below would swallow Enter and Tab for as long as the
      // caret sits in an `@word`. Nothing to offer, so nothing is offered.
      .catch(() => {
        if (!cancelled) setSummaries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mentionWanted]);
  // The handoff switch's own copy of the list (#1126), for the one case the
  // popup above does not cover: a draft that could hold a mention while the
  // popup is CLOSED and never supplied one — pasted text, a draft restored on
  // mount. `haveMentionable` is read, not depended on: this must not re-run
  // because its own answer arrived.
  const haveMentionable = React.useRef(false);
  haveMentionable.current = mentionable !== null;
  React.useEffect(() => {
    if (!couldMention) {
      setMentionable(null);
      return;
    }
    if (mentionWanted || haveMentionable.current) return;
    let cancelled = false;
    void window.switchboard.sessions
      .summaries()
      .then((list) => {
        if (!cancelled) setMentionable(answered(list) ?? []);
      })
      // no list, no switch: the send itself still resolves in main, as it always has
      .catch(() => {
        if (!cancelled) setMentionable([]);
      });
    return () => {
      cancelled = true;
    };
  }, [couldMention, mentionWanted]);
  React.useEffect(() => {
    setSelected(0);
    setNavigated(false);
  }, [completionKey]);
  // A dismissal is FOR ONE `@`: forget it once that `@` is gone, or a different
  // one is being typed — otherwise deleting and retyping it would stay closed.
  const rawMentionAt = rawMention?.at ?? null;
  React.useEffect(() => {
    if (mentionDismissedAt !== null && rawMentionAt !== mentionDismissedAt) setMentionDismissedAt(null);
  }, [rawMentionAt, mentionDismissedAt]);
  // arrow-key navigation must keep the highlighted row visible in the
  // scrollable popup (36+ builtins overflow the 200px box)
  const selectedRow = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, completionKey]);
  /**
   * The id namespace for the completion popup (#828), and it is `useId` for the
   * reason `CommandPalette.tsx` spells out at length (#654).
   *
   * `aria-activedescendant` and `aria-controls` are IDREFs, and an IDREF
   * resolves to the **first** element in tree order carrying that id. `id`
   * survives the sanitizer profile (`markdown.tsx`), and this composer sits
   * BELOW the feed's rendered transcript in document order — so a reply
   * containing `<div id="completion-opt-0">rm -rf</div>` would capture the
   * relation and tell a screen-reader user the highlighted completion is
   * whatever the transcript said, while Enter still inserts the real one.
   * That is the #509 harm — a lie the sighted reader cannot see — reached
   * through a name. `FeedView.forgery.test.tsx` holds the proof.
   *
   * Since #673 the root's per-launch `identifierPrefix` (`lib/root-identity.ts`)
   * makes the composed id unguessable rather than merely unpublished.
   */
  const completionId = React.useId();
  /**
   * THE highlighted row — one value, used by all five things that need it.
   *
   * There were four independent readings of `selected` before this item
   * (the `aria-` relation, `aria-selected`, the scroll ref, the background, and
   * Enter's pick) and only two of them clamped. For one commit after a
   * keystroke NARROWS the list — the render happens before the effect that
   * resets `selected` to 0 — the unclamped readings point past the end, so the
   * relation would name row 0 while no row was marked or highlighted. A screen
   * reader and the screen disagreeing is precisely the bug class this item
   * exists to close (review). One value, one invariant.
   *
   * `-1` when there is no popup, so `i === activeIndex` is false for every row
   * without a second condition at each site.
   */
  const activeIndex = popupOpen ? Math.min(selected, popup.length - 1) : -1;
  /**
   * The option id, built from the INDEX.
   *
   * Not a security property — `CommandPalette` composes a content-derived
   * suffix (`${paletteId}row-${row.id}`) and is just as safe, because the
   * unguessability comes entirely from the `useId` namespace above. The index
   * is simply the stabler choice: it survives a row key changing shape, and
   * there is nothing to sanitise.
   */
  const activeOptionId = activeIndex >= 0 ? `${completionId}opt-${activeIndex}` : undefined;

  // Placing the caret after an insert has to wait for React to COMMIT the new
  // draft: the textarea is controlled, so its DOM value is written during the
  // commit and a caret moved before that is simply overwritten. A layout effect
  // is exactly that moment â€” the same commit, after the DOM mutation.
  //
  // This used to be a requestAnimationFrame, which is a whole frame LATER and is
  // throttled hard when the window is occluded or the machine is loaded (CI).
  // A late caret write lands after the user has moved on: it collapses a
  // selection they just made and re-anchors typing into the middle of the old
  // draft. Measured while chasing #145 â€” delivering that stale write by hand,
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

  const pick = (row: CompletionRow): void => {
    if (row.kind === 'mention' && mention !== null) {
      // Replaces only the `@partial` — a mention is mid-sentence, so the text
      // before the `@` and after the caret both survive.
      setDraft(insertMention(draft, mention, caret, row.name));
      setDismissed(true); // closed until the token changes again
      setPendingCaret({ pos: caretAfterMention(mention, row.name) }); // after "@name "
      return;
    }
    setDraft(insertCommand(draft, caret, row.name));
    setDismissed(true); // closed until the token changes again
    setPendingCaret({ pos: row.name.length + 2 }); // after "/name "
  };

  // Auto-grow (P2-E10-08, Â§5.10): the box is as tall as what the browser
  // ACTUALLY RENDERED â€” soft wrapping included â€” capped at COMPOSER_MAX_LINES
  // and scrolling inside itself past that.
  //
  // THE GROWING IS CSS's (`field-sizing: content`, `.composer-box` in
  // tokens.css). It used to be a layout effect keyed on `draft` that released
  // the height, read `scrollHeight` back, wrote a fitted height and restored
  // `scrollTop` â€” on every keystroke. A writeâ†’read pair forces a SYNCHRONOUS
  // layout and a forced layout is DOCUMENT-wide, so the cost of typing one
  // character was the size of the conversation scrolled above the box: measured
  // at 0.27ms on an empty feed and 36.5ms at 400 turns. That is #716, and the
  // reason it was severe on a laptop and mild on the dev desktop is simply that
  // the same layout costs more on a slower machine.
  //
  // What is left here is where the box must STOP â€” which typing cannot change.
  // So it is measured when the panel resizes and when the attachment strip
  // changes height, and NEVER from `draft`. That is the whole fix: the
  // keystroke path now touches no layout at all.
  const [bounds, setBounds] = React.useState<ComposerBounds | null>(null);
  const remeasure = React.useCallback((): void => {
    const el = box.current;
    const view = el?.ownerDocument.defaultView;
    if (!el || !view) return;
    const cs = view.getComputedStyle(el);
    const next = composerBounds({
      lineHeight: resolveLineHeight(cs.lineHeight, cs.fontSize),
      padding: blockEdge(cs, 'padding'),
      border: blockEdge(cs, 'border'),
      borderBox: cs.getPropertyValue('box-sizing') === 'border-box',
      available: roomForBox(root.current, el),
    });
    // Returning `prev` when nothing moved keeps an unchanged measurement from
    // re-rendering. It is NOT what stops the writeâ†’observeâ†’measure cycle â€”
    // that is the observer's own early-return below, which swallows a tick
    // where only the box's HEIGHT moved, and height is all our write can move.
    // Worth being exact about, because the dedupe catches fixed points and not
    // 2-cycles: if the bounds could ever alternate Aâ†’Bâ†’A, `prev === next` would
    // be false every time and this would spin.
    //
    // THIS USED TO SAY "nothing `remeasure` reads depends on what it writes",
    // and that was FALSE (#981): a docked bar's height is a function of the
    // box's height, so the reading did depend on the writing and the box
    // ratcheted the conversation under its floor. What is true after the fix is
    // weaker and enough â€” the sibling measurement is taken against the box's
    // MINIMUM (see `roomForBox`), and the minimum is a constant function of
    // line-height and font size. A cycle needs a read that changes with the
    // value written; a constant cannot supply one.
    setBounds((prev) =>
      prev && prev.minBlockSize === next.minBlockSize && prev.maxBlockSize === next.maxBlockSize
        ? prev
        : next
    );
  }, []);
  // A LAYOUT effect, so the bounds are in place in the same commit that first
  // paints the box â€” and re-run when the strip changes, for the reason
  // `attachments` was in the old measurement's deps: the strip lives inside the
  // composer's own root, so attaching or removing an image changes how much
  // room `roomForBox` finds. Without it a paste made with a twelve-line draft
  // on screen leaves the box at a height its panel no longer has, which is
  // #406's overhang arriving through a new door. `attachNotice` is a line of
  // text in that same strip and moves it the same way.
  //
  // `dockedChrome` is the same argument one level UP â€” an approval bar or the
  // working banner docking mid-prompt changes the room just as surely, and
  // nothing else can see it happen. The old code got that for free by
  // re-measuring on every keystroke; this is the explicit replacement.
  //
  // `draft` is deliberately NOT a dependency. That is the fix, not an omission.
  //
  // `confirmClear` is the same argument again, and it is here as well as in the
  // ResizeObserver below on purpose: the observer is asynchronous, so measuring
  // in the same commit is what stops a one-frame overhang the moment the
  // confirmation swaps in and takes the row onto a second line (#903).
  React.useLayoutEffect(remeasure, [
    attachments,
    attachNotice,
    // the handoff switch (#1126) is one more line in the same strip
    namesSomeone,
    handoffWait,
    namedSessions.length,
    dockedChrome,
    confirmClear,
    remeasure,
  ]);
  // A SHORTER panel has less to spare â€” dragging a splitter or resizing the
  // window re-renders nothing, so without this a long draft keeps a cap its
  // panel no longer has and overhangs its own options row.
  //
  // The box's own width is still watched even though rewrapping is now CSS's
  // problem: a width change is the cheapest signal that the panel's chrome has
  // been re-laid-out, and the guard below means an unchanged panel costs
  // nothing. Neither trigger can loop â€” see the dedupe in `remeasure`.
  //
  // THE OPTIONS ROW IS WATCHED TOO, and that is new with #903. Until this item
  // that row was `nowrap` and therefore a fixed height, so it could be treated
  // as invariant chrome. It wraps now -- and a wrap changes neither the box's
  // width nor the panel's height, so neither of the two signals above sees it.
  // The concrete miss: a narrow card with a full draft, click Clear, the
  // confirmation is wider than the two chips it replaced, the row takes a
  // second line, and the box keeps a cap its panel no longer has. That is
  // #406's overhang through a third door, and the model chip changing to a
  // longer name would open it just as well.
  //
  // AND THE DOCKED BARS THEMSELVES ARE WATCHED, which is new with #981.
  // `dockedChrome` says WHICH of them are there, so it fires when one appears
  // or goes away -- and a bar that changes height while it stays put moves
  // exactly the same pixels. Click Deny and the objection field opens inside
  // the approval bar; a second permission arrives behind the first and the bar
  // gains its "1 more waiting" line. Neither changes the box's width, the
  // panel's height, the options row or `dockedChrome`, so before this the box
  // kept a cap the column no longer had and the conversation paid the
  // difference -- #981's own failure, arriving a second way.
  React.useEffect(() => {
    const el = box.current;
    const panel = root.current?.parentElement;
    if (!el) return;
    const rowHeight = (): number => optionsRow.current?.offsetHeight ?? 0;
    /** everything docked around the conversation, as one number -- `roomForBox`'s
     *  sibling term, read here only to tell "it moved" from "it did not".
     *
     *  Indexed rather than `Array.from`, and that is not style: in a real
     *  browser this runs on every keystroke (the box's own height changes, the
     *  observer fires, and this is what decides to do nothing), so it is on the
     *  path #716 cleared. The reads are post-layout and N is about three, but
     *  an allocation per keystroke is the shape that item was about. */
    const dockedHeight = (): number => {
      const own = root.current;
      if (!panel || !own) return 0;
      let sum = 0;
      for (let i = 0; i < panel.children.length; i += 1) {
        const sib = panel.children[i];
        if (sib === own || sib.hasAttribute('data-feed-region')) continue;
        sum += (sib as HTMLElement).offsetHeight;
      }
      return sum;
    };
    let lastWidth = el.getBoundingClientRect().width;
    let lastRoom = panel?.clientHeight ?? 0;
    let lastOptions = rowHeight();
    let lastDocked = dockedHeight();
    const ro = new ResizeObserver(() => {
      const width = el.getBoundingClientRect().width;
      // a collapsed panel measures 0 and would cap the box at nothing; it comes
      // back at full size, and that tick does the work
      if (width === 0) return;
      const room = panel?.clientHeight ?? 0;
      const options = rowHeight();
      const docked = dockedHeight();
      if (
        width === lastWidth &&
        room === lastRoom &&
        options === lastOptions &&
        docked === lastDocked
      )
        return;
      lastWidth = width;
      lastRoom = room;
      lastOptions = options;
      lastDocked = docked;
      remeasure();
    });
    ro.observe(el);
    if (panel) ro.observe(panel);
    if (optionsRow.current) ro.observe(optionsRow.current);
    // ⚠️ THE SUBSCRIPTION FOLLOWS `dockedChrome`, which is why it is a dependency
    // of this effect and not only of the layout effect above: these are the
    // ELEMENTS that come and go, so a bar that docks after this ran would
    // otherwise never be observed at all.
    //
    // The observer cannot chase its own tail here even though `remeasure` now
    // WRITES style synchronously inside this callback -- it collapses the box
    // to measure, and that transiently moves these very siblings. The collapse
    // and the restore are one synchronous block (`roomForBox`), so no
    // observation can be gathered between them and the next callback reads the
    // restored heights, which are the ones already cached. What it does see is
    // the real spring-back after a new cap lands -- and that re-measure
    // produces the same bounds, so `remeasure`'s dedupe ends it there.
    if (panel) {
      const own = root.current;
      for (const sib of Array.from(panel.children)) {
        if (sib === own || sib.hasAttribute('data-feed-region')) continue;
        ro.observe(sib);
      }
    }
    return () => ro.disconnect();
  }, [remeasure, dockedChrome]);

  /** something to send: words, a picture, a sibling's message, or any mix (E10-09, E11-05) */
  // Only SETTLED messages make the box sendable — an Enter would not send the
  // others, and a lit Send button that does nothing is its own small lie.
  // …and not while a send is already out (#774): during that window an Enter
  // is refused, so a lit button would be offering something that does nothing.
  const sendable =
    !sendPending &&
    (draft.trim().length > 0 ||
      attachments.length > 0 ||
      settledMessages(held, seenAt.current).length > 0);

  /**
   * The prompt went â€” empty the box AND forget the saved copy, at once.
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

  /**
   * The prompt went — empty the box, UNLESS the user has typed more since
   * (review should-fix, #798).
   *
   * Until #798 a text-only send cleared the box in the same tick as the
   * keypress, so there was no window to type into. A draft with an `@` now waits
   * on an IPC round trip that reads a transcript in main, and the textarea stays
   * editable throughout — only Send is greyed and Enter is swallowed by the
   * one-send guard. So `clearComposerDraft()` on the way back could wipe
   * characters the user typed after pressing Enter, and `clearDraft` would take
   * the persisted copy with them: unrecoverable, and the kind of loss §5.10 is
   * careful about.
   *
   * Compared with the FUNCTIONAL setter rather than the `draft` this closure
   * captured, which is a render old by the time this runs.
   */
  const clearSentDraft = (sent: string): void => {
    let left = '';
    setDraftState((current) => {
      // WHAT WAS SENT IS THE TRIMMED, NEWLINE-NORMALISED DRAFT (see `submit`),
      // so the box legitimately holds trailing whitespace that did go: picking a
      // slash command inserts `/clear ` WITH its trailing space, and CI caught
      // this — `slash-commands.spec.ts` found a lone `" "` left in the box after
      // a send that had cleared it since E10-07.
      //
      // So: a remainder of nothing but whitespace is nothing. Only real
      // characters — typed after Enter, while the lookup was out — are kept.
      const normalised = current.replace(/\r\n/g, '\n');
      const rest = normalised.startsWith(sent) ? normalised.slice(sent.length) : null;
      left = rest === null ? current : rest.trim() === '' ? '' : rest;
      return left;
    });
    // `clearDraft` is immediate where `saveDraft` is debounced (see
    // `composer-draft.ts`), so the two branches are not symmetrical and must not
    // be collapsed: forget the sent prompt at once, but PERSIST what is left.
    if (left === '') clearDraft(cardId);
    else saveDraft(cardId, left);
  };

  const submit = (): void => {
    const text = draft.replace(/\r\n/g, '\n').trimEnd();
    // `/mcp` IS OURS TO ANSWER (Â§5.17, #632). Its CLI form opens an interactive
    // picker in the TUI, and a Direct-mode session has no terminal for that
    // picker to appear in â€” so sending it is a dead end that eats the command
    // and leaves the session sitting there. Open the manager instead.
    //
    // FIRST, because the guards below are both wrong for it: the empty-text
    // guard does not apply (`/mcp` is not empty) and the attachment branch
    // would have already sent it. The draft is cleared because the command WAS
    // handled â€” leaving it in the box invites a second press, and the user's
    // line did not fail.
    //
    // `/model` is the second one (#721), now that there is a control channel to
    // ask the CLI what it has. `lib/slash-intercept`'s `ROUTES` is the list, and
    // it is deliberately strict â€” bare commands only, because swallowing a
    // command addressed to the CLI is worse than the dead end it replaces.
    //
    // UNCONDITIONAL SINCE #952, and the P7 reasoning is why that is a change
    // worth reading rather than a simplification.
    //
    // The intercept used to run ONLY on a transport with no terminal. A `pty`
    // session HAD one, so the CLI's own picker worked there, and that picker can
    // do things this pane deliberately cannot, including approving a project
    // server, which has no CLI verb at all. Intercepting everywhere would have
    // taken an interaction the CLI kept for itself in the one mode where it was
    // reachable, which is the half of P7 the §6 amendment did NOT relax.
    //
    // There is now no mode where it is reachable. The picker needs a terminal and
    // there is no terminal, so intercepting takes nothing away: the alternative is
    // not "the CLI's own picker" but "a command that opens a picker nobody can
    // see", which is the dead end #632 built this intercept to remove.
    //
    // THE GAP IT LEAVES IS REAL AND IS NOW PERMANENT rather than mode-specific:
    // approving a project server has no CLI verb and no route inside the app.
    // That belongs in the manual, not in a conditional.
    const intercept = interceptSlash(text);
    if (intercept.kind === 'open-mcp') {
      sessionStore.notifyMcpOpenRequested();
      clearComposerDraft();
      box.current?.focus();
      return;
    }
    // `/model` (#721). Carries the LIVE ID, unlike `/mcp` â€” the picker acts on
    // the session the command was typed in, and with popouts and split grids
    // that is not reliably the focused card.
    if (intercept.kind === 'open-model') {
      // RETURNS EITHER WAY. Falling through on a missing id would send `/model`
      // to the CLI â€” straight back into the dead end this replaces â€” so the
      // failure direction is "nothing happens", not "the old bug happens".
      // Unreachable today: `sessionId` is a required non-empty prop.
      if (sessionId) sessionStore.notifyModelOpenRequested(sessionId);
      clearComposerDraft();
      box.current?.focus();
      return;
    }

    // An attachment with nothing typed IS a prompt (Â§5.10's composer is an
    // input route, and "look at this" is a thing people send), so the guard is
    // on BOTH being empty rather than on the text alone.
    //
    // …and so is a sibling's message (P2-E11-05). THIS ENTER IS THE KEYPRESS
    // §5.4 REQUIRES: the messages waiting above the box go with it, each
    // wrapped in the header that tells the receiving agent who wrote it and
    // that the user sent it on, followed by whatever the user typed. Captured
    // now, like `sending` below — a message that arrives between this press and
    // the send is not one the user saw, so it stays for the next Enter.
    //
    // Two exclusions, both #765 review, both so the header's "the user
    // reviewed it" stays true:
    //  - a message that arrived less than `SIBLING_SETTLE_MS` ago stays held —
    //    an Enter already on its way for the user's OWN prompt did not review it;
    //  - a SLASH COMMAND goes alone. Folded in after a forwarded message it
    //    would stop being a command at all (the prompt no longer starts with
    //    `/`), and the messages would ride a keypress that was not about them.
    // ONE SEND AT A TIME (#774) — see `isSendInFlight`. Below the `/mcp` and
    // `/model` intercepts, which send nothing and are not what can duplicate,
    // and ABOVE `forwarding`, which is the line that decides what a second
    // press would re-send. Deliberately covers the no-attachment branch too:
    // if the user clears the strip while a send is out, that branch is reached
    // with the same held messages still on the card, and they would go twice.
    if (isSendInFlight(cardId)) return;
    const forwarding = text.startsWith('/') ? [] : settledMessages(held, seenAt.current);
    if (!text && attachments.length === 0 && forwarding.length === 0) return;
    const forwardedIds = forwarding.map((m) => m.id);

    // `@Name` MENTIONS (P2-E11-08, §5.2 Tier 2). A draft that may mention
    // another session is resolved in MAIN before it goes — the same query core
    // and wording the bus tools use — and comes back as the prompt to send
    // (that session's recent output ahead of the prose) or as the reasons it
    // must not go. So this send awaits, like the attachment path below, behind
    // the same one-send-at-a-time guard; a draft with no `@` at a word boundary
    // never reaches here and keeps the instant path.
    //
    // ONLY THE USER'S OWN TEXT is resolved. A forwarded sibling message that
    // says `@Other` is another agent's words — resolving it would let one
    // session pull a third session's output into this one without the user
    // asking. And a SLASH COMMAND is left alone: rewriting its arguments could
    // change what the command does.
    //
    // Refused (an ambiguous name): nothing is sent or cleared, and `resolve`'s
    // reason — every candidate and its folder — is shown under the box. Lookup
    // FAILED (main unreachable, the call refused): fail open, send as typed,
    // and say that the context did not go.
    if (!text.startsWith('/') && mayMention(text)) {
      const done = beginSend(cardId);
      // WITH A HANDOFF (#1126) this await is long — each named session is asked
      // to write, and the send waits for them. The one-send-at-a-time guard is
      // held for all of it, which is right: a second Enter must not send the
      // same draft without the handoff the first one is waiting on.
      const selfWritten = askHandoff && namesSomeone;
      const wait = selfWritten ? beginHandoffWait(handoffKey, sessionId, namedSessions) : undefined;
      const settled = (): void => {
        done();
        if (wait) endHandoffWait(handoffKey, wait);
      };
      void resolveDraftMentions(sessionId, text, { selfWritten }).then((r) => {
        settled();
        // CANCEL MEANS NOT SENT. The user asked for a handoff and then stopped
        // waiting for it; sending without it would be doing the thing they
        // had switched away from. The draft is untouched — and the switch is
        // left ON, so Enter again asks again (and joins the handoff that
        // session is by now part-way through writing).
        if (handoffWasCancelled(wait, r.kind === 'send' ? r.handoffs : undefined)) {
          setAttachNotice(t('feedView.handoff.cancelled'));
          return;
        }
        if (r.kind === 'refused') {
          setAttachNotice(t('feedView.mention.refused', { reasons: r.refusals.join(' ') }));
          return;
        }
        // The switch is NOT turned off here. It goes off when the draft that
        // named somebody is cleared — which happens only once the prompt has
        // actually gone — so a send main then declines leaves it as it was.
        dispatch(
          withForwarded(forwarding, r.prompt),
          r.kind === 'unresolved'
            ? t('feedView.mention.lookupFailed')
            : r.kind === 'send'
              ? handoffNotice(t, r.handoffs)
              : null
        );
      }, settled);
      box.current?.focus();
      return;
    }
    dispatch(withForwarded(forwarding, text), null);

    /** Send the draft's final form. `notice` is what stays under the box once it went. */
    function dispatch(prompt: string, notice: string | null): void {
      if (attachments.length === 0) {
        // ⚠️ THE DRAFT IS CLEARED ONLY ONCE THE PROMPT HAS GONE (#952).
        //
        // This used to clear IMMEDIATELY, under a comment that said "a text
        // prompt cannot be refused — one of the two routes always accepts it".
        // That was true while `submitPrompt` fell back to typing into a PTY, and
        // it is the exact premise the transport deletion removed: main declining,
        // or the IPC rejecting, now means the words went NOWHERE.
        //
        // Clearing a composer whose contents went nowhere is the one outcome the
        // user cannot undo, which is the same argument the attachments path below
        // has always made — the two now agree rather than differing on a
        // transport detail.
        //
        // A SECOND CALLBACK, NOT `.finally`, for the reason spelled out below:
        // `void p.then(f).finally(g)` leaves a rejection unhandled.
        const done = beginSend(cardId);
        void submitPrompt(sessionId, prompt).then((ok) => {
          done();
          if (!ok) {
            setAttachNotice(t('feedView.attach.notSent'));
            return;
          }
          clearSentDraft(text);
          removeHeldMessages(cardId, forwardedIds);
          setDismissed(false);
          setAttachNotice(notice);
        }, done);
        box.current?.focus();
        return;
      }

      // WITH ATTACHMENTS the send can genuinely fail (no PTY fallback carries a
      // bitmap or a document block), so the draft is cleared only once we know it
      // went.
      // The exact set being sent, captured now. Reading a dropped file takes real
      // time â€” a 4 MB log is not a clipboard bitmap â€” so a transfer can land
      // BETWEEN this submit and its acknowledgement. Clearing the strip wholesale
      // would eat that new attachment; removing only what we sent leaves it for
      // the next prompt, which is where the user put it.
      const sending = attachments;
      const sent = new Set(sending.map((a) => a.id));
      const done = beginSend(cardId);
      // A SECOND CALLBACK, NOT `.finally` (and not `.catch`): the box has to
      // reopen even if `submitPrompt` REJECTS, and `void p.then(f).finally(g)`
      // still leaves that rejection unhandled — an unhandled rejection in a
      // renderer is a console error today and whatever the window's handler
      // decides tomorrow. `submitPrompt` resolves `false` rather than throwing,
      // so this arm should be dead; a guard that can wedge the composer shut for
      // the rest of the session is not one to leave resting on "should".
      void submitPrompt(sessionId, prompt, toPromptAttachments(sending)).then((ok) => {
        done();
        if (!ok) {
          // Everything stays exactly where it was. Clearing a composer whose
          // contents went nowhere is the one outcome the user cannot undo, and a
          // pasted screenshot is not recoverable from the clipboard a minute
          // later.
          setAttachNotice(t('feedView.attach.notSent'));
          return;
        }
        clearSentDraft(text);
        // Only once it WENT, like the draft: a refused send keeps the sibling's
        // messages on screen with everything else the user was about to send.
        removeHeldMessages(cardId, forwardedIds);
        setDismissed(false);
        setAttachments((prev) => prev.filter((a) => !sent.has(a.id)));
        setAttachNotice(notice);
      }, done);
      box.current?.focus();
    }
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
          then swallows the drop. Purely additive â€” it is absolutely positioned
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
          {t(dragContext ? 'feedView.context.dropHint' : 'feedView.attach.dropHint')}
        </div>
      )}
      {/* "A list just opened", said out loud (#828).

          This is the job `role="combobox"` + `aria-expanded` was supposed to do
          and could not — see the textarea's note. A polite live region says it
          instead, which needs no role on the input, breaks no ARIA-in-HTML
          rule, and is the idiom `ComposerAttachments` and `FindBar` already
          use here.

          MOUNTED EMPTY on the first frame, the rule #222 set for `FindBar`'s
          count: a live region that arrives already holding its text is
          announced by almost nothing. So this element always exists and only
          its content changes — and it is visually hidden always, because the
          count is already on screen as the list itself. It says the COUNT and
          not the highlighted row: the row is carried by
          `aria-activedescendant`, and saying it twice would talk over every
          arrow key. */}
      <div
        role="status"
        aria-live="polite"
        data-completion-announce=""
        style={COMPLETION_ANNOUNCE_STYLE}
      >
        {popupOpen
          ? t(
              popup[0]?.kind === 'mention'
                ? 'feedView.completion.sessionListOpen'
                : 'feedView.completion.commandListOpen',
              { count: popup.length }
            )
          : ''}
      </div>
      {popupOpen && (
        <div
          // `data-completion-list` is the TEST HOOK, and it is a `data-*` for
          // the same reason the palette's are (#654): content cannot emit one
          // at all (`ALLOW_DATA_ATTR: false`), so a hook is not a second
          // guessable name the way an id would be.
          data-completion-list={popup[0]?.kind}
          id={`${completionId}list`}
          role="listbox"
          // Named by WHICH list it is. "Suggestions" for both would put two
          // indistinguishable listboxes in the same document the moment two
          // cards are on screen — the #196 failure, one level down.
          aria-label={t(
            popup[0]?.kind === 'mention'
              ? 'feedView.completion.sessionListLabel'
              : 'feedView.completion.commandListLabel'
          )}
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
          {popup.map((row, i) => {
            return (
            <div
              key={row.key}
              // which list the row came from — a stable hook for tests and e2e,
              // so neither has to find a row by its styling
              data-completion-row={row.kind}
              id={`${completionId}opt-${i}`}
              role="option"
              // The highlight was `background: var(--chip)` and NOTHING ELSE
              // until #828 — visual only, so arrowing down the list was silent.
              // This is the half that makes the move audible; the id above is
              // the half that makes it findable.
              //
              // Written as `false` on the other rows rather than omitted.
              // ARIA 1.2's default for `aria-selected` on an option IS false,
              // so omitting it would be legal — but AT support for the default
              // is patchier than for the attribute, and `CommandPalette` writes
              // it explicitly for the same reason.
              aria-selected={i === activeIndex}
              ref={i === activeIndex ? selectedRow : undefined}
              onMouseDown={(e) => e.preventDefault() /* keep the textarea focused */}
              onClick={() => pick(row)}
              onMouseEnter={() => {
                setSelected(i);
                setNavigated(true); // pointing at a row is choosing it, as the arrows are
              }}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                padding: '3px 8px',
                borderRadius: 5,
                cursor: 'pointer',
                background: i === activeIndex ? 'var(--chip)' : 'transparent',
              }}
            >
              {row.accent !== undefined && (
                // The session's colour (#797) — the same swatch every row that
                // paints a session shows, so `@TradingApp` reads as the card it is.
                <span
                  aria-hidden="true"
                  style={{
                    inlineSize: 7,
                    blockSize: 7,
                    borderRadius: '50%',
                    background: row.accent,
                    flexShrink: 0,
                    alignSelf: 'center',
                  }}
                />
              )}
              <span
                data-completion-label=""
                style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text)', flexShrink: 0 }}
              >
                {row.label}
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
                {row.detail}
              </span>
              <span style={{ fontSize: 9, color: 'var(--faint)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                {row.badge}
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
      {/* Sibling messages (P2-E11-05) — inside the root for the same reason,
          and above the attachments because they arrived first in the reading
          order of what Enter will send: the forwarded text leads the prompt. */}
      <SiblingMessages messages={held} onDismiss={(id) => removeHeldMessages(cardId, [id])} />
      {/* §5.5's drop dialog (P2-E11-10). Mounted only while a chip has landed,
          so Cancel — and Escape, and a click on the scrim — leave both composers
          exactly as they were, because nothing was ever written. */}
      {offer && (
        <ContextDropDialog
          offer={offer}
          onCancel={() => setOffer(null)}
          onChoose={(option) => onContextChoose(offer.from, option)}
        />
      )}
      <ComposerAttachments
        attachments={attachments}
        notice={attachNotice}
        onRemove={removeAttachment}
      />
      {/* "Ask it to write the handoff" (#1126) — only while the draft names
          another session, and replaced by the wait (with its Cancel) while a
          send is out. A real checkbox in a real label: it is a setting for
          this one send, the control that says so natively, and a click on the
          words works.

          THE ANNOUNCEMENT IS A SEPARATE, ALWAYS-MOUNTED REGION (review). A
          `role="status"` that is mounted already holding its text is very often
          not announced at all — the same reason `ComposerAttachments` mounts
          its notice region empty — and one that wraps the Cancel button reads
          the button out as part of the message. So the words a screen reader
          hears live in a hidden region that is always there and merely changes,
          and the line a sighted user reads is marked as the same thing said
          twice. */}
      <span role="status" data-handoff-status="" style={HANDOFF_SILENT}>
        {handoffWait
          ? handoffWait.names.length === 1
            ? t('feedView.handoff.waitingOne', { name: handoffWait.names[0] })
            : t('feedView.handoff.waitingMany')
          : ''}
      </span>
      {handoffWait ? (
        <div
          data-handoff-wait=""
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'var(--muted)' }}
        >
          <span aria-hidden style={{ minInlineSize: 0 }}>
            {handoffWait.names.length === 1
              ? t('feedView.handoff.waitingOne', { name: handoffWait.names[0] })
              : t('feedView.handoff.waitingMany')}
          </span>
          <button
            type="button"
            className={CHIP_CLASS}
            data-handoff-cancel=""
            title={t('feedView.handoff.cancelHint')}
            onClick={stopHandoffWait}
          >
            {t('feedView.handoff.cancel')}
          </button>
        </div>
      ) : namesSomeone ? (
        <>
        <label
          data-handoff-switch=""
          title={t('feedView.handoff.askHint')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 10,
            color: 'var(--muted)',
            cursor: 'pointer',
            inlineSize: 'fit-content',
            maxInlineSize: '100%',
          }}
        >
          <input
            type="checkbox"
            checked={askHandoff}
            onChange={(e) => setAskHandoff(e.currentTarget.checked)}
            // what it costs, for somebody who cannot hover for the tooltip
            aria-describedby={handoffHintId}
            style={{ margin: 0 }}
          />
          <span style={{ minInlineSize: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {namedSessions.length === 1
              ? t('feedView.handoff.askOne', { name: namedSessions[0] })
              : t('feedView.handoff.askMany')}
          </span>
        </label>
        {/* OUTSIDE the label, or it would be part of the checkbox's NAME: a
            screen reader would announce the whole paragraph as what the box is
            called, every time, instead of offering it as its description. */}
        <span id={handoffHintId} style={HANDOFF_SILENT}>
          {t('feedView.handoff.askHint')}
        </span>
        </>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
      <textarea
        ref={box}
        value={draft}
        // The SAME string as the placeholder, on purpose. The accessible name
        // fell through to `placeholder` before this item, which works but is a
        // browser courtesy rather than an authored name — and naming it
        // anything shorter would DEMOTE "Enter to send, Shift+Enter for a new
        // line" from the name to a description, which is a thing many users
        // have switched off. Same words, said deliberately (review, #828).
        aria-label={t('feedView.composerPlaceholder')}
        // ── the completion relations (#828) ────────────────────────────────
        //
        // NO `role="combobox"`, and this is the decision in this item.
        //
        // The first cut put `role="combobox"` + `aria-expanded` on the textarea
        // while the popup was open, because `aria-expanded` is not valid on a
        // textbox. Review killed it on two counts, both right: **ARIA in HTML
        // permits no `role` on `<textarea>` at all** (its implicit role is
        // `textbox`; axe-core's `aria-allowed-role` flags exactly this), and
        // **ARIA says roles SHOULD NOT change over time** — AT caches the role
        // at focus time and routinely drops a mutation on the focused node. So
        // the announcement the role was added FOR was the thing least likely to
        // happen.
        //
        // The honest shape, and it turns out to be simpler: ARIA 1.2's
        // `textbox` role SUPPORTS `aria-activedescendant` and
        // `aria-autocomplete` natively, and `aria-controls` is global. Three of
        // the four relations were always valid here. Only `aria-expanded`
        // needed a role it could not have — so the "a list just opened"
        // announcement moves to a polite live region below, which is the idiom
        // `ComposerAttachments` and `FindBar` already use and which works
        // regardless of role and regardless of AT.
        {...(popupOpen
          ? {
              'aria-controls': `${completionId}list`,
              'aria-activedescendant': activeOptionId,
              // The list is a set of suggestions, not the only permitted
              // values — the box takes free text and always did.
              'aria-autocomplete': 'list' as const,
            }
          : {})}
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
        // NOT cover the window's âœ• â€” that is OS chrome and fires no DOM blur â€”
        // so the residual hole is "type and quit within 400ms without leaving
        // the box", which is the tolerance `composer-draft.ts` argues for.
        onBlur={uiFlush}
        onKeyDown={(e) => {
          // confirming an IME candidate (CJK input) also fires Enter â€” never
          // submit a half-composed draft (keyCode 229 covers WebKit quirks)
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          // fetch still in flight for a wanted popup: swallow Enter/Tab so a
          // fast "/âŽ" can't submit a bare slash before the list arrives
          // ...and the same for the `@` list (#797): a fast "@Tra⏎" must not
          // send before the session list it would have completed from arrives.
          if (
            ((popupWanted && commands === null) || (mentionWanted && summaries === null)) &&
            (e.key === 'Enter' || e.key === 'Tab')
          ) {
            e.preventDefault();
            return;
          }
          if (popupOpen) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => (s + (e.key === 'ArrowDown' ? 1 : popup.length - 1)) % popup.length);
              setNavigated(true); // a deliberate choice — see `mentionEnterAction`
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              const chosen = popup[Math.min(selected, popup.length - 1)];
              // NOTHING LEFT TO COMPLETE -> Enter RUNS it (#163 hand-test).
              // Typing `/usage` in full and pressing Enter used to "complete"
              // it to `/usage ` and send nothing, which is indistinguishable
              // from the app ignoring you â€” and is why Dan found every slash
              // command dead in Direct mode. Tab still completes, so the
              // trailing space is still one keystroke away when a command
              // takes arguments.
              // On a MENTION row Enter has one more case than on a command
              // (#797, `mentionEnterAction`): typed in full → send, as #163;
              // a prefix, or a row the user moved to → complete; a bare
              // substring match → send the literal, so `ping @app` never becomes
              // a name nobody picked. Tab always completes, on either kind.
              const sends =
                e.key === 'Enter' &&
                (chosen.kind === 'mention'
                  ? mention !== null && mentionEnterAction(mention.query, chosen.name, navigated) === 'send'
                  : token !== null && isCompleteCommand(token, chosen.name));
              if (sends) {
                submit();
                return;
              }
              pick(chosen);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              // A mention closes for THAT `@` only — more of the same word stays
              // closed, a new `@` opens again (review, #797). The slash popup
              // keeps its own rule: closed until the draft next changes.
              if (mention !== null) setMentionDismissedAt(mention.at);
              else setDismissed(true);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t('feedView.composerPlaceholder')}
        // `field-sizing: content` and the unconditional `overflow-y` live in
        // the stylesheet rather than in the style prop below (#716). Not because
        // React would refuse to emit them â€” it assigns straight onto
        // `CSSStyleDeclaration`, so the inline route would work â€” but because
        // this is a fixed property of what a composer IS, and putting it in the
        // per-render style object would re-declare it on every keystroke and
        // split the reasoning across two files.
        className="composer-box"
        // ONE row, always. `rows` counts hard newlines and cannot see soft
        // wrapping â€” that was the whole of #406 â€” and under `field-sizing` it
        // does not size the box at all. It stays at 1 as the honest starting
        // value for the very first paint.
        rows={1}
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
          // Where CSS's growing stops. Absent until the first measurement, so
          // the first paint is `rows={1}` and never a guessed pixel count.
          // `maxBlockSize` stays absent when no limit is knowable (no
          // resolvable line-height AND no measurable panel) â€” an unbounded box
          // is recoverable, a wrongly-short one hides what you typed.
          minBlockSize: bounds ? `${bounds.minBlockSize}px` : undefined,
          maxBlockSize:
            bounds && Number.isFinite(bounds.maxBlockSize)
              ? `${bounds.maxBlockSize}px`
              : undefined,
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
            // The border keeps the hue â€” an edge is not a word (#246).
            background: CRASHED_WASH,
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
      <div
        ref={optionsRow}
        data-testid="composer-options"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          // IT WRAPS (#903). The row gained two more controls and a card can be
          // narrow; the alternative was collapsing them to icons at some
          // measured width, which needs a ResizeObserver in the composer and a
          // second visual language for two controls. Wrapping cannot overflow
          // by construction, which is the only guarantee worth having here --
          // #885 was a flex row whose headroom looked fine on Windows and was
          // 38px short on Linux CI, where text renders about 5% wider.
          flexWrap: 'wrap',
          rowGap: 4,
        }}
      >
        {/* This session's autonomy (E10-05). The tooltip is the shared one
            (#534) â€” it says what the MODE does, then what THIS control does
            with it, which is the question a chip that applies on next resume
            has to answer. `data-testid` so the e2e that cycles it is not
            pinned to the copy. */}
        <button
          onClick={onCycleAutonomy}
          data-testid="composer-autonomy"
          // What the session is in NOW comes first when it is not what the chip
          // sets (#1072) — otherwise the tooltip describes a mode the session
          // has already left.
          title={
            movedTo
              ? `${t('autonomy.scope.moved', { now: t(`autonomy.${movedTo}`) })}\n\n${autonomyTooltip(t, autonomy, 'session')}`
              : autonomyTooltip(t, autonomy, 'session')
          }
          data-live-mode={movedTo ?? undefined}
          className={CHIP_CLASS}
          // THE ROW'S ONE INLINE INK, and only for the one mode that is a
          // warning: the feed's copy of the grid's autonomy chip, which #221
          // fixed and this one was missed by (#246). Now measured on the chip's
          // own fill rather than on the panel behind it — 4.73:1 on nordic,
          // 5.65:1 on daylight, asserted in tokens.drift.test.ts. Every other
          // state leaves `color` unset so the class owns it, which is what
          // `FeedView.session-controls.test.tsx` pins.
          style={
            autonomy === 'full-auto' ? { color: 'var(--status-crashed-ink)' } : undefined
          }
        >
          {movedTo
            ? t('autonomy.nowThenNext', {
                now: t(`autonomy.${movedTo}`),
                next: t(`autonomy.${autonomy ?? 'ask'}`),
              })
            : t(`autonomy.${autonomy ?? 'ask'}`)}
        </button>
        {/* WHICH MODEL, and — since #747 — the switcher for it.

            Three shapes, and which one you get is a fact about the session
            rather than a style choice:

            • switchable, model known → a BUTTON that opens the quick menu. It
              takes the autonomy chip's treatment (border, padding, pointer)
              because it is now the same kind of thing sitting right next to it,
              and a control that looks like a label does not get clicked.
            • switchable, model NOT known → the same button reading "model?".
              A CLI that does not answer which model a session is on (an older
              one; #1174 asks a newer one when the card appears) only says once
              it has replied,
              and a fresh card is exactly when you want to choose before
              spending a turn on the wrong one — so the affordance is there
              before the answer is.
            • not switchable → the plain span it always was. See
              `canSwitchModel`. */}
        {canSwitchModel ? (
          <button
            ref={modelChip}
            type="button"
            data-testid="composer-model"
            title={model ? t('feedView.modelHint') : t('feedView.modelHintUnknown')}
            aria-haspopup="menu"
            aria-expanded={modelMenuAt !== null}
            // Dead, and visibly so, while the menu has a switch on the wire —
            // see `modelBusy`. This is the door the menu cannot shut for itself.
            disabled={modelBusy}
            onClick={(e) => {
              // A second click on the chip CLOSES, the way every menu button
              // does — without this the menu would reopen at the same place and
              // read as a dead click.
              if (modelMenuAt) return closeModelMenu();
              setModelMenuAt(e.currentTarget.getBoundingClientRect());
            }}
            className={CHIP_CLASS}
            // WHAT IS LEFT INLINE, and why each of the two survived #1009:
            //
            // • `--font-mono`, KEPT ON PURPOSE. The other three chips say
            //   words; this one says an IDENTIFIER (`claude-sonnet-4-5`), and
            //   mono is the face this app already gives identifiers — the
            //   completion rows, the code fence's language tag. The SIZE went
            //   the other way: it was 9.5px against the row's 10px, which was
            //   never a decision, and half a pixel of extra smallness on the
            //   chip that was also wearing the dimmest ink is how a control
            //   ends up reading as a caption. One row, one size.
            // • the ellipsis trio, because a model id is the only label here
            //   long enough to need truncating in a narrow card.
            //
            // `cursor` is NOT here any more: it tracked `modelBusy`, which is
            // the same thing `disabled` says, and `.composer-chip:disabled`
            // now says it once — along with the `--faint` ink this chip used
            // to wear at ALL times.
            style={{
              fontFamily: 'var(--font-mono)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minInlineSize: 0,
            }}
          >
            {model ?? t('feedView.modelUnknown')}
          </button>
        ) : (
          model && (
            <span
              data-testid="composer-model"
              // WHY it is not clickable, and only claimed when it is true.
              //
              // There were two sentences here until #952. The other one told the
              // user to type `/model` in the session's Terminal tab, and it was
              // conditional precisely because it named a tab that only existed in
              // Terminal mode — saying it to an ENDED Direct session would have
              // pointed at a tab it never had. No session has one now, so the
              // plain statement of fact is the only true thing to say.
              title={t('feedView.modelHintInactive')}
              // DELIBERATELY NOT `.composer-chip`, and it keeps `--faint`. It
              // is not a control — dressing an inert label in a button's fill
              // and edge is #747's mistake pointed the other way. It takes the
              // row's 10px so the row has one type size, and nothing else.
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--faint)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minInlineSize: 0,
              }}
            >
              {model}
            </span>
          )
        )}
        {/* HOW HARD THE MODEL THINKS (#1115), right of the model chip, which is
            where the owner asked for it. Behind `canSwitchModel` for the
            model chip's own reason: it talks to a live session over the
            control channel, and a session that has ended (or has none) has
            nobody to ask. It draws nothing for a model with no effort
            levels. `key={sessionId}`: a resumed card is a new session, and
            what the old one was on is not what this one is on. */}
        {canSwitchModel && (
          <EffortChip
            key={`effort-${sessionId}`}
            liveId={sessionId}
            cardId={cardId}
            model={model ?? null}
            working={status === 'working'}
          />
        )}
        {/* `canSwitchModel` again, and it is not redundant with the chip above:
            the session can END while the menu is open, at which point the chip
            reverts to plain text and this would otherwise be left floating over
            a card, aimed at a session id that no longer resolves.
            `key={sessionId}` is the other half — a resumed card gets a new live
            id, and this component's "no epoch guard needed" argument rests on a
            sitting ending with its component. */}
        {canSwitchModel && modelMenuAt && (
          <ModelQuickMenu
            key={`model-menu-${sessionId}`}
            liveId={sessionId}
            // WHAT THE CHIP SAYS, not a second question to main. The menu grew
            // out of this text and must never tick something else; `undefined`
            // (nothing known yet) is `null` here, which ticks nothing.
            current={model ?? null}
            anchor={modelMenuAt}
            onClose={closeModelMenu}
            onBusyChange={noteModelBusy}
          />
        )}
        {/* Clear and Compact (#903). The SAME two actions the card's menu
            offers, through the same module -- what gets sent is still `/clear`
            and `/compact` typed into the real CLI, and the menu entries stay.

            COMPACT SITS FIRST, and Clear last, on purpose: Clear is the
            destructive one, and this order keeps it away from the model chip,
            which is the control on this row people actually click. The
            confirmation is the real guard; the order is just not making it
            work harder than it has to.

            The confirmation is an IN-ROW SWAP rather than a popover, which is
            also how it satisfies a popped-out card: there is no positioned
            layer, so there is no owning-document question to get wrong (#573),
            and the focus return below lands in whichever window drew it. */}
        <span
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && confirmClear) {
              e.stopPropagation();
              setConfirmClear(false);
            }
          }}
        >
          {confirmClear && controlsLock === null ? (
            <span
              role="group"
              // The WHOLE sentence, for anyone who cannot read the row: the
              // visible question is short because the row is, but "the
              // session's context starts over" is the part that decides it.
              // Focus lands inside this group when it opens, which is what
              // gets the sentence announced.
              aria-label={t('grid.menuClearConfirm')}
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <span
                title={t('grid.menuClearConfirm')}
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-ui)',
                  color: 'var(--text)',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('feedView.clearConfirmShort')}
              </span>
              <button
                data-testid="composer-clear-go"
                onClick={() => {
                  setConfirmClear(false);
                  void clearConversation(sessionId).finally(() => setContextRefresh((n) => n + 1));
                }}
                title={t('grid.menuClearHint')}
                // DELIBERATELY NOT `grid.menuClear`. Naming this the same as
                // the button that OPENED the question is how a screen-reader
                // user tabs onto "Clear conversation" a second time, hears the
                // identical words, and wipes the session believing nothing has
                // happened yet. The answer has to be audibly an answer.
                aria-label={t('feedView.clearConfirmGo')}
                className={CHIP_CLASS}
                // The chip's METRICS from the class, its COLOUR from here: the
                // destructive confirm wears the crashed hue as INK on its own
                // wash, the tinted-fill shape #221 settled on -- the border
                // keeps the hue, and an edge is not a word (#246). `data-tone`
                // is what takes it out of the shared :hover rule, which would
                // otherwise repaint the ink and the border of the one button
                // whose colour is the warning (see tokens.css).
                data-tone="danger"
                style={{
                  background: CRASHED_WASH,
                  color: 'var(--status-crashed-ink)',
                  border: '1px solid var(--status-crashed)',
                }}
              >
                {t('grid.menuClearGo')}
              </button>
              <button
                ref={cancelBtn}
                data-testid="composer-clear-cancel"
                aria-label={t('feedView.clearConfirmCancel')}
                onClick={() => setConfirmClear(false)}
                className={CHIP_CLASS}
              >
                {t('grid.menuClearCancel')}
              </button>
            </span>
          ) : (
            <>
              {/* THE TOOLTIP LIVES ON THE WRAPPER, not on the button, and only
                  because of the one state that matters: Chromium does not
                  hit-test a `disabled` control, so a `title` on a greyed-out
                  button never appears -- which is exactly when a mouse user
                  needs to be told why. The accessible name carries the reason
                  too, for everyone not using a mouse. */}
              <span title={t(lockReasonKey(controlsLock) ?? 'grid.menuCompactHint')}>
                <button
                  data-testid="composer-compact"
                  // Dead while a `/compact` is on the wire. Unlike Clear this
                  // leaves no marker in the conversation, so a double-click
                  // would type the command twice with nothing on screen to say
                  // so -- the same reason the model chip next door has a busy
                  // state.
                  disabled={controlsLock !== null || compactBusy}
                  aria-label={controlName(t, 'grid.menuCompact', controlsLock)}
                  onClick={() => {
                    if (compactInFlight.current) return;
                    compactInFlight.current = true;
                    setCompactBusy(true);
                    void compactConversation(sessionId).finally(() => {
                      compactInFlight.current = false;
                      setCompactBusy(false);
                      setContextRefresh((n) => n + 1);
                    });
                  }}
                  className={CHIP_CLASS}
                >
                  {t('feedView.compact')}
                </button>
              </span>
              <span title={t(lockReasonKey(controlsLock) ?? 'grid.menuClearHint')}>
                <button
                  ref={clearBtn}
                  data-testid="composer-clear"
                  disabled={controlsLock !== null}
                  aria-label={controlName(t, 'grid.menuClear', controlsLock)}
                  onClick={() => setConfirmClear(true)}
                  className={CHIP_CLASS}
                >
                  {t('feedView.clear')}
                </button>
              </span>
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        {/* HOW FULL THE CONTEXT WINDOW IS (#715), bottom right, where the
            owner asked for it: beside Compact and Clear, which are what you
            reach for when it fills. Behind `canSwitchModel` for the effort
            chip's reason: it asks a live session over the control channel.
            It draws nothing until the session has answered.

            THE KEY IS NOT THE BARE `sessionId`, and that is not style. The
            effort chip and the model menu, siblings in this row, were both
            keyed by it; a third child with the same key made React lose track
            of the menu, which then stayed on screen for good after a switch
            (caught by e2e/effort-chip.spec.ts). All three now carry their
            own prefix: two siblings sharing a key was a stranded node waiting
            for the right re-render (review). Still per session: a resumed
            card starts from nothing. */}
        {canSwitchModel && (
          <ContextMeter
            key={`context-${sessionId}`}
            liveId={sessionId}
            model={model ?? null}
            working={status === 'working'}
            refresh={contextRefresh}
          />
        )}
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
