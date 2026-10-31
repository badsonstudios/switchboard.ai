// The session-history picker (P2-E20-01, §5.33) — every past conversation in a
// folder, described well enough to recognise, and one click from being open.
//
// ── WHY A MODAL AND NOT AN ANCHORED DROPDOWN ───────────────────────────────
//
// The card's ⋯ menu is a hand-rolled `position: absolute` box, which is exactly
// the class of surface #641/#642 were filed about: a menu anchored to a card
// header on a four-way split runs past the viewport and becomes unreachable by
// mouse AND by Playwright. This list is searchable and up to 300 rows, so it is
// the worst possible candidate for that treatment. `CommandPalette` is the
// shape to copy — and copying it means this ships WITH listbox semantics rather
// than adding a third surface that lacks them (#828 is the composer popup's
// missing ones).
//
// ── WHAT THE ROWS MEAN ─────────────────────────────────────────────────────
//
// The description is the CLI's own `ai-title` when the conversation has one and
// its first user prompt when it does not — measured, not assumed
// (`spike/findings/e20-836-transcript-head.md`). They read differently on
// purpose: a title is a summary someone else wrote, a prompt is the user's own
// words, so a prompt row is quoted.
//
// A `claimed` row is one a card already has open. It is shown rather than
// hidden, and it is inert: hiding it would leave the user hunting for a
// conversation that is on screen behind them, while opening it would put two
// cards in one transcript — plain `--resume` appends rather than forking.
//
// ── TWO KINDS OF HISTORY, ONE BUTTON (#1237) ───────────────────────────────
//
// Opened from a card, the window has two tabs: **Conversations** (everything
// above) and **Prompts**, the prompts you sent in the conversation that is
// open (`PromptList`, `lib/prompt-history`). The prompt list first shipped
// behind a small button of its own in the conversation's toolbar, and the
// owner could not find it. Opened without a session it has no tabs: that was
// the `+ session` picker, which #1282 removed (a new session always starts
// fresh now), and the shape stays for any caller with no session to name.
//
// The conversations panel stays MOUNTED while the other tab shows: its scan,
// its search and its highlight are where they were when you come back. The
// prompts panel is read fresh each time it is shown, and is a SNAPSHOT while
// it is up: the window is modal, so nothing is being sent behind it.
import React from 'react';
import { useModalLayer } from '../lib/modal-layer';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../shared/ipc/refusal';
import type { ConversationHistory, ConversationRow } from '../../../shared/session-history';
import { promptPortFor } from '../lib/prompt-port';
import { PromptList } from './PromptHistory';

export interface HistoryPick {
  nativeId: string;
  folder: string;
  /** what the row was called in the list — so a question about this pick can NAME it (#1127) */
  description?: string;
}

/**
 * How long "Stop it" stays unpressable after the question appears (#1127).
 *
 * ⚠️ THE QUESTION IS DRAWN WHERE THE LIST WAS, and a pick is very often a
 * DOUBLE-click (found in review). Main answers a busy pick at once, so the
 * question was on screen inside the double-click interval and the second click
 * landed on whatever had appeared under the pointer — which, as first built,
 * was the widest thing there: the button that throws the work away. A question
 * nobody had time to read is not a question.
 *
 * Longer than the longest double-click interval the OS offers by default
 * (500 ms on Windows). Cancel is live at once; only the destructive answer
 * waits.
 */
export const STOP_ARM_MS = 700;

export type HistoryTab = 'conversations' | 'prompts';
const HISTORY_TABS: readonly HistoryTab[] = ['conversations', 'prompts'];
/**
 * The tab the window opens on is the one last used, as Settings does: someone
 * who lives in the prompt list should not have to choose it every time. For
 * the life of the app, not saved: the first open after a launch is
 * Conversations, which is what the button has always meant.
 */
let lastTab: HistoryTab = 'conversations';
export function resetHistoryTabForTests(): void {
  lastTab = 'conversations';
}

/** The two answers to "stop it?" (#1127) — the same plain button, on purpose: neither is dressed as the safe one, the FOCUS is. */
const CONFIRM_BUTTON: React.CSSProperties = {
  background: 'var(--chip)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-chip)',
  color: 'var(--text)',
  fontFamily: 'var(--font-ui)',
  fontSize: 12,
  padding: '3px 10px',
  cursor: 'pointer',
};

export function SessionHistoryDialog(props: {
  open: boolean;
  /** the folder the picker opens scoped to */
  folder: string;
  /**
   * The session whose prompts the second tab lists (#1237). Given by a card;
   * absent (no session yet), and then there are no tabs at all. An id
   * with no conversation view behind it still gets the tab, and the tab says
   * why it is empty.
   */
  promptSession?: string;
  onClose: () => void;
  onPick: (pick: HistoryPick) => void;
  /**
   * Why the last pick did not happen (#1090). A pick made from a card opens
   * the conversation IN that card, which main can refuse — and the dialog is
   * still open when it does, so this is where the reason is said.
   */
  notice?: string;
  /**
   * A pick main will only make if the user says so (#1127): the card's session
   * is in the middle of something, and opening the conversation here stops it.
   *
   * ASKED HERE, in the dialog the pick was made in, for the reason `notice` is
   * said here — and it REPLACES the dead end `notice` used to be for this case
   * ("wait for it to finish, then pick again").
   *
   * CANCEL IS THE DEFAULT, and that is the whole safety of it: it takes the
   * focus when the question appears, so the Enter that made the pick — or one
   * pressed a moment later out of habit — lands on "no". Throwing away a turn
   * in flight takes a deliberate move to the other button.
   */
  confirm?: {
    /** a short name for the question — what a screen reader calls it */
    title: string;
    /** what is at stake, naming the conversation */
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
  };
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = React.useState('');
  const [scope, setScope] = React.useState<'folder' | 'all'>('folder');
  const [answer, setAnswer] = React.useState<ConversationHistory | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState(0);
  const input = React.useRef<HTMLInputElement | null>(null);
  const selectedRow = React.useRef<HTMLDivElement | null>(null);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const hasTabs = props.promptSession !== undefined;
  /**
   * The tab to open on: the one last used, EXCEPT that a session with nothing
   * to list never opens on Prompts. A card showing its terminal has no
   * conversation view, and the history button there would greet the user with
   * an apology instead of the list they came for. `lastTab` is not touched:
   * the next card that does have prompts still opens on them.
   */
  const openingTab = (): HistoryTab =>
    hasTabs && promptPortFor(props.promptSession) ? lastTab : 'conversations';
  const [tab, setTab] = React.useState<HistoryTab>(openingTab);
  const dialogEl = React.useRef<HTMLDivElement | null>(null);
  // only the top modal is modal (#1020, `lib/modal-layer`)
  // (`dialogEl`: opened from a card, this travels with a popped-out one, and joins THAT window's stack)
  const { top, lift } = useModalLayer(props.open, dialogEl);
  const promptInput = React.useRef<HTMLInputElement | null>(null);
  const tabButtons = React.useRef<Record<HistoryTab, HTMLButtonElement | null>>({
    conversations: null,
    prompts: null,
  });
  /** the next tab change was made with the arrow keys: the keyboard stays ON the tabs */
  const focusTabNext = React.useRef(false);
  // #654: ids here are IDREFs for `aria-controls` / `aria-activedescendant`, and
  // a stable published name can be captured by earlier content carrying the same
  // `id`. `useId` (plus the root's per-launch prefix) makes them unguessable;
  // tests select on `data-history-row` instead, which content cannot emit.
  const listId = React.useId();
  // `t` in a ref, so the fetch effect below does not depend on it. `t`'s
  // identity changes when the language changes or i18n re-initialises, and a
  // dependency on it would re-run a scan of every project on the machine to
  // restate a fallback sentence.
  const tr = React.useRef(t);
  tr.current = t;

  // Re-fetched on OPEN and on every scope change, never filtered from a stale
  // answer: a conversation that has been written to since the picker last ran
  // has a new position in the newest-first order, and possibly a title it did
  // not have before.
  React.useEffect(() => {
    if (!props.open) return;
    let live = true;
    setLoading(true);
    // Cleared HERE rather than on close, and that is the difference between a
    // component that happens to work and one that does. Resetting on close left
    // the list empty with nothing to refill it: this effect's deps had not
    // changed, so it did not re-run, and a dialog the parent keeps MOUNTED
    // (rather than unmounting, which is the only reason it worked) came back
    // permanently blank. Freshness belongs to whatever opens it.
    setAnswer(null);
    setSelected(0);
    void window.switchboard.transcripts
      .history({ scope, folder: props.folder })
      .then((a) => {
        if (!live) return;
        // #440: a refused channel resolves a TRUTHY brand, so reading `a`
        // directly would show the refusal object as if it were a listing.
        setAnswer(answered(a) ?? { status: 'unknown', reason: t('sessionHistory.openFailed') });
        setSelected(0);
      })
      .catch(() => {
        if (live) setAnswer({ status: 'unknown', reason: t('sessionHistory.openFailed') });
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      // The scope can change while a scan is in flight, and the slower answer
      // must not paint over the newer one.
      live = false;
    };
  }, [props.open, props.folder, scope, t]);

  // a LAYOUT effect: focused in the commit that shows it (#1171, `lib/modal-dismiss.ts`)
  React.useLayoutEffect(() => {
    if (!props.open) return;
    // THE DIALOG'S OWN DOCUMENT: in a popped-out card the global `document` is
    // the main window's, and what has the keyboard THERE is not what opened this
    const doc = dialogEl.current?.ownerDocument ?? document;
    returnFocusTo.current = doc.activeElement as HTMLElement | null;
    setTab(openingTab());
    // on OPEN only: `openingTab` reads the props of the render that opened it
  }, [props.open]);
  // ...and the keyboard goes to the box of whichever tab is showing, on open
  // and on every change of tab. Chosen with the arrow keys, it stays on the
  // tabs instead, so a second arrow press moves on rather than typing.
  React.useLayoutEffect(() => {
    if (!props.open) return;
    if (focusTabNext.current) {
      focusTabNext.current = false;
      tabButtons.current[tab]?.focus();
      return;
    }
    const box = (tab === 'prompts' ? promptInput : input).current;
    // ⚠️ THE KEYBOARD MUST END UP INSIDE THE WINDOW, whatever the tab holds.
    // Escape is handled on this subtree, so focus left outside it (or on a box
    // that was just hidden) is a window no key can close. The Prompts tab of a
    // session with nothing to list has a DISABLED box, and focusing a disabled
    // box does nothing: its tab takes the keyboard instead.
    if (box && !box.disabled) box.focus();
    else tabButtons.current[tab]?.focus();
  }, [props.open, tab]);

  // THE SEARCH IS FORGOTTEN WHEN THE DIALOG CLOSES, AND NOT BEFORE (#1099). It
  // used to be cleared in `pick()`, on the way out — but a pick made from a card
  // can be REFUSED, and then the dialog is still open, saying why, over a list
  // that had just jumped back to everything in the folder with the search the
  // user typed gone. Whether a pick closes the dialog is the parent's answer,
  // so this waits for the parent to give it.
  React.useEffect(() => {
    if (props.open) return;
    setQuery('');
    setScope('folder');
  }, [props.open]);

  // A FRESH LIST STARTS AT ITS TOP, IN THE SAME RENDER THAT SHOWS IT (#1320).
  // The highlight goes back to the first row whenever the list it indexes
  // changes — a query typed, the scope switched, a new answer — and it is reset
  // by whatever made the change, alongside it, never by an effect afterwards.
  // An effect is one render late: the render that first shows the shorter list
  // still carries the old index, and an Enter pressed in that gap (type and hit
  // Enter quickly on a loaded machine) read `rows[staleIndex]` — past the end
  // of the list, so the pick was silently dropped, or a different row than the
  // top match. The pointer had put it there: hovering a row sets the index.
  const search = (q: string): void => {
    setQuery(q);
    setSelected(0);
  };
  // Block-bodied on purpose: an expression body returns Chromium's promise,
  // React reads it as a cleanup function and the tree dies (pinned in
  // `e2e/palette.spec.ts` for the palette, and the same trap lives here).
  React.useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const rows: ConversationRow[] = React.useMemo(() => {
    if (!answer || answer.status !== 'ok') return [];
    const q = query.trim().toLowerCase();
    if (!q) return answer.rows;
    // Filtering is over the ANSWER, not the disk — typing does not re-scan.
    return answer.rows.filter(
      (r) =>
        r.description.toLowerCase().includes(q) ||
        r.folder.toLowerCase().includes(q) ||
        r.nativeId.toLowerCase().includes(q)
    );
  }, [answer, query]);

  // The question takes the focus when it appears, and it goes to CANCEL — see
  // `confirm`. Back to the search box when it is answered "no", so the picker
  // is where it was; a "yes" closes the dialog or replaces this with a notice.
  const cancelStop = React.useRef<HTMLButtonElement | null>(null);
  const asking = props.confirm !== undefined;
  const wasAsking = React.useRef(false);
  React.useEffect(() => {
    if (asking) cancelStop.current?.focus();
    else if (wasAsking.current) input.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  // "Stop it" is not pressable until the question has been up long enough to
  // have been seen — see `STOP_ARM_MS`.
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    setArmed(false);
    if (!asking) return;
    const id = window.setTimeout(() => setArmed(true), STOP_ARM_MS);
    return () => window.clearTimeout(id);
  }, [asking]);
  // (above the early return below: hooks run on every render, open or not)

  if (!props.open) return null;

  const close = (): void => {
    setQuery('');
    setScope('folder');
    props.onClose();
    const el = returnFocusTo.current;
    // the frame of the window the opener is IN: the main window's may be
    // minimised behind a pop-out, and a minimised window paints no frames
    const view = el?.ownerDocument?.defaultView ?? window;
    view.requestAnimationFrame(() => el?.focus?.());
  };

  const choose = (next: HistoryTab, byArrowKey: boolean): void => {
    // a question about a pick is up: it holds the window until answered
    if (asking) return;
    lastTab = next;
    if (next === tab) {
      // nothing changes, so the effect that moves the keyboard will not run
      if (!byArrowKey) {
        const box = (tab === 'prompts' ? promptInput : input).current;
        if (box && !box.disabled) box.focus();
      }
      return;
    }
    focusTabNext.current = byArrowKey;
    setTab(next);
  };

  // THE PROMPTS TAB ACTS ON THE CONVERSATION BEHIND THE WINDOW, so both of its
  // actions shut the window WITHOUT handing the keyboard back to the history
  // button (`close()` does that): the conversation, or the prompt box, takes it.
  const port = promptPortFor(props.promptSession);
  const jumpToPrompt = (seq: number): void => {
    // a prompt no longer loaded cannot be gone to: the list stays
    if (!port?.jump(seq)) return;
    props.onClose();
  };
  const usePromptAgain = (text: string): void => {
    props.onClose();
    port?.recall(text);
  };

  const pick = (row: ConversationRow | undefined): void => {
    // A claimed row is inert rather than absent — see the header.
    if (!row || row.claimed) return;
    // Nothing is reset here: see the effect on `props.open` above.
    props.onPick({ nativeId: row.nativeId, folder: row.folder, description: row.description });
  };

  const move = (delta: number): void => {
    if (rows.length === 0) return;
    setSelected((prev) => (prev + delta + rows.length) % rows.length);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // This dialog owns its keys while open, including the command registry's
    // accelerators — the palette makes the same claim for the same reason.
    e.stopPropagation();
    // WHILE A QUESTION IS UP (#1127) THE LIST'S KEYS STAND DOWN. Enter here
    // means "pick the highlighted row", and with the question showing that
    // would make the same pick again from under it — or, worse, read as an
    // answer. The two buttons take Enter and Space natively; Escape says no to
    // the question rather than closing the whole picker.
    if (props.confirm) {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.confirm.onCancel();
      }
      return;
    }
    // THE LIST'S KEYS BELONG TO THE CONVERSATIONS LIST (#1237). On the prompts
    // tab, or with the keyboard on the tabs themselves, the arrows and Enter
    // are the focused control's own; only Escape is the window's.
    const onTabs = (e.target as Element | null)?.closest?.('[role="tab"]');
    if (tab === 'prompts' || onTabs) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // A HELD Enter is one pick, not a stream of them (#1127, review). With a
      // question that Enter also answers "no", key-repeat would otherwise pick,
      // cancel, pick, cancel for as long as the key was down.
      if (e.repeat) return;
      pick(rows[selected]);
    }
  };

  const unknown = answer && answer.status === 'unknown' ? answer.reason : null;
  const emptyText = scope === 'all' ? t('sessionHistory.emptyAll') : t('sessionHistory.empty');

  return (
    <div
      onMouseDown={close}
      style={{
        position: 'fixed',
        inset: 0,
        // above whatever modal was already open (#1020): paint order follows the stack
        zIndex: 50 + lift,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '12vh',
      }}
    >
      <div
        ref={dialogEl}
        role="dialog"
        // while its own question is up, the QUESTION is the modal thing (below)
        aria-modal={top && !props.confirm ? 'true' : undefined}
        inert={!top}
        aria-label={hasTabs ? t('sessionHistory.windowTitle') : t('sessionHistory.title')}
        data-history-dialog
        onMouseDown={(e) => {
          e.stopPropagation();
          // Clicking the dialog's padding must not blur the input: the key
          // handling hangs off this subtree, so focus on <body> would make
          // Escape and the arrows dead. The palette and the composer agree.
          // (either tab's box: the prompts tab has its own, #1237)
          if (e.target !== input.current && e.target !== promptInput.current) e.preventDefault();
        }}
        onKeyDown={onKeyDown}
        style={{
          inlineSize: 'min(720px, 92vw)',
          maxBlockSize: '64vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          overflow: 'hidden',
          fontFamily: 'var(--font-ui)',
          // WITH TABS, ONE HEIGHT. A window that fits its list would change
          // size every time you looked at the other tab (#1199's lesson).
          ...(hasTabs ? { blockSize: 'min(64vh, 560px)' } : null),
        }}
      >
        {hasTabs && (
          <div
            role="tablist"
            data-history-tabs
            style={{
              display: 'flex',
              gap: 2,
              paddingInline: 8,
              borderBlockEnd: '1px solid var(--border)',
              flexShrink: 0,
            }}
          >
            {HISTORY_TABS.map((id) => (
              <button
                key={id}
                ref={(el) => {
                  tabButtons.current[id] = el;
                }}
                type="button"
                role="tab"
                id={`${listId}tab-${id}`}
                aria-selected={tab === id}
                // the prompts panel exists only while it shows; never point at nothing
                aria-controls={id === 'conversations' || tab === 'prompts' ? `${listId}panel-${id}` : undefined}
                // one stop for the Tab key; the arrows move along them
                tabIndex={tab === id ? 0 : -1}
                disabled={asking}
                data-history-tab={id}
                className="settings-tab"
                onClick={() => choose(id, false)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                  e.preventDefault();
                  // two tabs: either arrow is "the other one"
                  choose(id === 'conversations' ? 'prompts' : 'conversations', true);
                }}
              >
                {t(`sessionHistory.tab.${id}`)}
              </button>
            ))}
          </div>
        )}
        <div
          role={hasTabs ? 'tabpanel' : undefined}
          id={`${listId}panel-conversations`}
          aria-labelledby={hasTabs ? `${listId}tab-conversations` : undefined}
          data-history-panel="conversations"
          style={
            tab === 'conversations'
              ? {
                  display: 'flex',
                  flexDirection: 'column',
                  minBlockSize: 0,
                  overflow: 'hidden',
                  ...(hasTabs ? { flex: 1 } : null),
                }
              : { display: 'none' }
          }
        >
        <div style={{ display: 'flex', alignItems: 'center', borderBlockEnd: '1px solid var(--border)' }}>
          <input
            ref={input}
            value={query}
            // Out of reach while a question is up (#1127): its keys are standing
            // down, and a search box that takes typing but ignores Enter and the
            // arrows is a control that silently does nothing.
            disabled={asking}
            onChange={(e) => search(e.target.value)}
            placeholder={t('sessionHistory.placeholder')}
            aria-label={t('sessionHistory.placeholder')}
            role="combobox"
            aria-expanded
            aria-controls={`${listId}rows`}
            aria-activedescendant={rows[selected] ? `${listId}row-${rows[selected].nativeId}` : undefined}
            data-history-search
            style={{
              flex: 1,
              minInlineSize: 0,
              background: 'var(--panel2)',
              color: 'var(--text)',
              border: 'none',
              padding: '11px 14px',
              fontSize: 14,
              fontFamily: 'var(--font-ui)',
              outline: 'none',
            }}
          />
          {/* The scope toggle is the CLI picker's `ctrl+a`, given a surface.
              Folder-scoped by default, which is the CLI's own default and the
              reason the common case stays short (§5.33). */}
          <button
            data-history-scope={scope}
            aria-pressed={scope === 'all'}
            onClick={() => {
              setScope((s) => (s === 'all' ? 'folder' : 'all'));
              setSelected(0);
            }}
            disabled={asking}
            title={t('sessionHistory.scopeAllHint')}
            style={{
              background: scope === 'all' ? 'var(--chip)' : 'transparent',
              color: scope === 'all' ? 'var(--text)' : 'var(--muted)',
              border: '1px solid var(--control-edge)',
              borderRadius: 'var(--radius-chip)',
              padding: '3px 10px',
              marginInline: 10,
              cursor: 'pointer',
              fontSize: 11,
              fontFamily: 'var(--font-ui)',
              whiteSpace: 'nowrap',
            }}
          >
            {scope === 'all' ? t('sessionHistory.scopeAll') : t('sessionHistory.scopeFolder')}
          </button>
        </div>

        {/* A pick that needs a yes first (#1127). `alertdialog`: it interrupts,
            it asks, and it holds the focus until answered — the search box and
            the scope switch are disabled and THE LIST IS TAKEN AWAY while it is
            up (below), so there is nothing else in the picker to reach, and no
            row for a stray second click to pick instead. Named by a short
            title and DESCRIBED by the sentence, so a screen reader announces a
            question and then what is at stake rather than one long name. */}
        {props.confirm && (
          <div
            data-history-confirm
            role="alertdialog"
            aria-modal={top ? 'true' : undefined}
            aria-label={props.confirm.title}
            aria-describedby={`${listId}confirm`}
            style={{
              padding: '14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              fontSize: 12,
            }}
          >
            <span id={`${listId}confirm`} style={{ color: 'var(--status-crashed-ink)' }}>
              {props.confirm.message}
            </span>
            <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                ref={cancelStop}
                type="button"
                data-history-confirm-cancel
                onClick={props.confirm.onCancel}
                style={CONFIRM_BUTTON}
              >
                {props.confirm.cancelLabel}
              </button>
              <button
                type="button"
                data-history-confirm-ok
                // not until it has been up long enough to be read — `STOP_ARM_MS`
                disabled={!armed}
                onClick={props.confirm.onConfirm}
                style={armed ? CONFIRM_BUTTON : { ...CONFIRM_BUTTON, color: 'var(--faint)', cursor: 'default' }}
              >
                {props.confirm.confirmLabel}
              </button>
            </span>
          </div>
        )}
        {/* A pick main refused (#1090). Above the list and `role="alert"`, so
            it is seen and heard without the list moving under the pointer. */}
        {props.notice && (
          <div
            data-history-notice
            role="alert"
            style={{
              padding: '8px 14px',
              color: 'var(--status-crashed-ink)',
              fontSize: 12,
              borderBlockEnd: '1px solid var(--border)',
            }}
          >
            {props.notice}
          </div>
        )}
        {/* Not shown while a question is up (#1127) — kept MOUNTED, so the
            search, the highlight and the scroll position are exactly where they
            were when the answer is "no". */}
        <div
          data-history-rows
          id={`${listId}rows`}
          role="listbox"
          aria-label={t('sessionHistory.title')}
          style={asking ? { display: 'none' } : { overflowY: 'auto' }}
        >
          {loading && (
            <div data-history-loading style={{ padding: 14, color: 'var(--muted)', fontSize: 12 }}>
              {t('sessionHistory.loading')}
            </div>
          )}
          {/* An unreadable directory, or one past the 500 this will scan, is
              said OUT LOUD rather than rendered as an empty list — §5.33: a
              list that quietly omits what you wanted is worse than one that
              admits its limit. */}
          {!loading && unknown && (
            <div data-history-unknown style={{ padding: 14, color: 'var(--status-crashed-ink)', fontSize: 12 }}>
              {t('sessionHistory.unscannable', { reason: unknown })}
            </div>
          )}
          {!loading && !unknown && rows.length === 0 && (
            <div data-history-empty style={{ padding: 14, color: 'var(--muted)', fontSize: 12 }}>
              {query.trim() ? t('sessionHistory.noMatch', { query: query.trim() }) : emptyText}
            </div>
          )}
          {!loading &&
            rows.map((row, i) => (
              <div
                key={row.nativeId}
                id={`${listId}row-${row.nativeId}`}
                data-history-row={row.nativeId}
                role="option"
                aria-selected={i === selected}
                aria-disabled={row.claimed}
                ref={i === selected ? selectedRow : undefined}
                onMouseMove={() => setSelected(i)}
                onClick={() => pick(row)}
                title={row.claimed ? t('sessionHistory.claimedHint') : row.folder}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  padding: '8px 14px',
                  cursor: row.claimed ? 'default' : 'pointer',
                  background: i === selected ? 'var(--chip)' : 'transparent',
                  color: row.claimed ? 'var(--faint)' : 'var(--text)',
                  fontSize: 12.5,
                }}
              >
                <span style={{ flex: 1, minInlineSize: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.descriptionFrom === 'none' ? (
                    <span style={{ color: 'var(--muted)' }}>{t('sessionHistory.noDescription')}</span>
                  ) : (
                    // A first prompt is the user's own words, so it is quoted; a
                    // title is the CLI's summary of them and is not.
                    <span data-history-from={row.descriptionFrom}>
                      {row.descriptionFrom === 'prompt' ? `“${row.description}”` : row.description}
                    </span>
                  )}
                  {/* The folder earns its place only once the list spans more
                      than one (§5.33) — in folder scope every row would carry
                      the same path. */}
                  {scope === 'all' && (
                    <span data-history-folder style={{ marginInlineStart: 8, fontSize: 10.5, color: 'var(--muted)' }}>
                      {row.folder}
                    </span>
                  )}
                </span>
                {row.claimed && (
                  <span style={{ fontSize: 10, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {t('sessionHistory.claimed')}
                  </span>
                )}
                <span
                  title={t('sessionHistory.lastActive', { when: new Date(row.lastActiveMs).toLocaleString() })}
                  style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}
                >
                  {whenText(row.lastActiveMs, i18n.language)}
                </span>
              </div>
            ))}
          {/* Not a refusal: we looked, and this is the newest slice of what is
              there. Said so the user knows the list has an end rather than
              wondering why an old conversation is missing. */}
          {!loading && answer?.status === 'ok' && answer.truncated && (
            <div data-history-truncated style={{ padding: '8px 14px', color: 'var(--muted)', fontSize: 11 }}>
              {t('sessionHistory.truncated', { count: answer.rows.length })}
            </div>
          )}
        </div>

        </div>
        {hasTabs && tab === 'prompts' && (
          <div
            role="tabpanel"
            id={`${listId}panel-prompts`}
            aria-labelledby={`${listId}tab-prompts`}
            data-history-panel="prompts"
            style={{ display: 'flex', flexDirection: 'column', minBlockSize: 0, flex: 1 }}
          >
            <PromptList
              prompts={port?.prompts() ?? []}
              truncated={port?.truncated() ?? false}
              unavailable={!port}
              inputRef={promptInput}
              onJump={jumpToPrompt}
              onRecall={usePromptAgain}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * When a conversation was last active, at the precision that helps.
 *
 * Today's conversations are told apart by their TIME and older ones by their
 * DATE — a bare date on six conversations from this afternoon distinguishes
 * none of them, and a time on one from March is noise. No relative-time helper
 * exists in this tree yet; the exact timestamp is on the row's `title`.
 */
function whenText(ms: number, locale: string | undefined): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString(locale || undefined, { timeStyle: 'short' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(locale || undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
