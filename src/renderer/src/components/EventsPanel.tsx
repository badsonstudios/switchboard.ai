// Events panel (P1-E4-01 → renamed from "Feed" per Dan 2026-07-22, §5.12):
// what needs attention right now — ONE item per session, its latest state.
// Items are pushed wholesale from the main process (adds, replacements, and
// removals when a permission is answered or a session closes).
//
// E9-03: the panel no longer subscribes to events itself and no longer decides
// their order. App owns the subscription and lib/queue owns the ordering, so
// what you read top-to-bottom here is exactly what Ctrl+Space will walk —
// "the feed is the log, the queue is the to-do list" (§5.12).
//
// P2-E14-01 (Shape B): this is no longer a 220px column in the workspace row —
// it is the BODY of `EventsDrawer`, which overlays the grid and is collapsed by
// default. Nothing about the content changed: the same queue-ordered rows, the
// same notice tenants, the same dismiss and open gestures. What changed is
// that it now fills its container instead of claiming a fixed width from the
// session grid, and the drawer above it owns the edge, the shadow and the
// open/close. App still owns the subscription and the cursor — the drawer is a
// shape, not a new home for state.
//
// P2-E14-02 (Events v2): the rows can now ANSWER as well as point. A row whose
// session is holding a permission carries Allow · Allow all · Deny, and one
// holding a question carries an expandable list of what it asked. The row is
// still one session's latest state; the held requests come from the store's
// whole-fleet ledger (see `lib/events-v2`), not from the event. Above the rows,
// the three filters §5.12 names: All · Needed · By session.
import type { HistoryRepairNotice } from '../../../shared/history-repair';
import type { Digest } from '../lib/digest';
import type { PermissionRequestDto } from '../../../shared/ipc/permissions';
import type { AskQuestion } from '../../../shared/ask-user-question';
import type { DispatchResultDto } from '../../../shared/dispatch-result';
import { EventDto } from '../model/types';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { RailSession } from './SessionsRail';
import { nextInQueue } from '../lib/queue';
import {
  EVENTS_FILTERS,
  EventsFilter,
  heldFor,
  HeldForSession,
  rowArgument,
  visibleEvents,
} from '../lib/events-v2';
import { argumentDetail } from '../lib/permission-batches';
import { answered } from '../../../shared/ipc/refusal';

export type { EventDto } from '../model/types';

/** Space the status line leaves for the out-of-flow Dismiss button (#197).
 *  Sized to the widest thing that button can hold, which is a translated word
 *  rather than "Dismiss" (~61px) — generous on purpose, because the failure
 *  mode is text running underneath a control. */
const DISMISS_GUTTER = 64;

/**
 * An event kind's colour, TWICE — because a ring and a word are not the same
 * job (#246, the rule #221 established).
 *
 * `--status-<x>` is tuned to be seen as a dot, a ring or a tint; only
 * `--status-<x>-ink` is tuned against what is behind a WORD. One map served
 * both here, so the row's status line was painted in the raw hue: 1.80:1 for
 * needs-input on daylight's `--panel2`, 2.34-3.10:1 for the rest, and
 * 3.41-4.49:1 on nordic. The ring keeps the hue (an edge is held to 3:1, and
 * it clears that); the word takes the ink and lands at 5.25-12.36:1.
 *
 * `ready` still has no ramp position — it is the only kind that is not a
 * status, so it takes a NEUTRAL rather than being quietly promoted into the
 * ramp. Which neutral changed in #268. It was `--faint`, which is deliberately
 * a hairline hint rather than text: 2.50:1 on nordic and 2.68:1 on daylight,
 * and 2.15:1 once the row's old `opacity: 0.82` was folded in — on the ONLY
 * row that ever shows this word, because `reviewed` IS `kind === 'ready'`. A
 * state nobody can read is not a quiet state.
 *
 * It is `inherit` now, and that is the point rather than a shrug: the word
 * takes the ROW's ink, which `tokens.css` declares and `tokens.drift.test.ts`
 * measures against the fill the row actually paints. A named token here would
 * be a second value to keep in step with that pair by hand — and the last time
 * this map held its own opinion about a colour it held it for months at 1.80:1
 * (#246). Whichever way `reviewed` is defined the inherited value is a measured
 * one — `--muted` on the de-emphasised fill (4.7-14.2:1), or `--text` on
 * `--panel2` if a `ready` row could ever be a live one. Today it cannot:
 * `reviewed` IS `kind === 'ready'`, and `lib/queue.ts` gives `ready` a negative
 * priority so it is never the head either. `KIND_HUE.ready` is dead for the
 * same reason — the outline it would feed only paints on the queue's head —
 * and both are kept so the maps stay total over the kind union.
 */
const KIND_HUE: Record<EventDto['kind'], string> = {
  done: 'var(--status-done)',
  ready: 'var(--faint)',
  'needs-input': 'var(--status-needs-input)',
  'needs-permission': 'var(--status-needs-permission)',
  crashed: 'var(--status-crashed)',
  // A finished dispatch IS a finished session, one card over — so it takes the
  // `done` pair rather than a sixth hue of its own. The measured contrast above
  // is what makes reuse the safe answer: a new colour here would be a new pair
  // to measure on two themes, for a row that means the same thing as the one it
  // would be sitting next to (P2-E13-05).
  'dispatch-result': 'var(--status-done)',
};
const KIND_INK: Record<EventDto['kind'], string> = {
  done: 'var(--status-done-ink)',
  ready: 'inherit',
  'needs-input': 'var(--status-needs-input-ink)',
  'needs-permission': 'var(--status-needs-permission-ink)',
  crashed: 'var(--status-crashed-ink)',
  'dispatch-result': 'var(--status-done-ink)',
};

/**
 * Exported so `EventsDrawer` can take exactly these and add its own open/close
 * to them. One prop contract for the content, wherever it is mounted — and the
 * drawer cannot quietly drop one on the way through.
 */
export interface EventsPanelProps {
  sessions: readonly RailSession[];
  /** the feed's current items — App owns the subscription (E9-03) */
  events: readonly EventDto[];
  /**
   * The subset the attention QUEUE may see — the same list minus the sessions
   * whose focus policy is `none` (E9-10). Only the next-up highlight reads it:
   * the list itself still shows every event, because §5.12's line is that the
   * feed is the log and the queue is the to-do list.
   *
   * REQUIRED, not defaulted to `events`. A mount that forgot it would silently
   * highlight a row `Ctrl+Space` will skip — the panel and the hotkey disagreeing
   * is the exact failure E9-03 moved this subscription up to App to prevent.
   */
  queueEvents: readonly EventDto[];
  /** event ids the walk has already taken you to (App owns the cursor) */
  visited: ReadonlySet<number>;
  onFocus: (sessionId: string) => void;
  /** the user opened this event by hand — mark it visited in the walk (E9-03).
   *  Required, not optional: a second call site that forgot it would silently
   *  send the hotkey back to the row the user just opened. */
  onVisit: (eventId: number) => void;
  /** label for the jump hotkey, e.g. 'Ctrl+Space' — derived from the registry */
  queueBinding: string;
  /** a saved display is back — offer a one-click layout restore (E8-06) */
  reconnectOffer?: boolean;
  onRestoreLayout?: () => void;
  onDismissOffer?: () => void;
  /**
   * The update feature's one non-modal surface (E19-04), in two flavours:
   *
   *   • `installed` — "You're now on vX", the post-update handshake. It goes
   *     HERE rather than in a dialog because the news is worth a glance and not
   *     worth a click, and this panel is already where "something happened"
   *     lives.
   *   • `available` — the release is still on offer. Shown once the dialog is
   *     out of the way without being answered (Escape, click-away, or a
   *     cancelled download), which is the item's "the persistent update
   *     available affordance remains". **Ignore and Skip do not produce it** —
   *     those are answers, and re-asking in the corner would make them lies.
   */
  updateNotice?: { kind: 'installed' | 'available'; version: string } | null;
  /** the `available` notice's button: reopen the dialog */
  onUpdateNow?: () => void;
  onDismissUpdateNotice?: () => void;
  /**
   * Open provider incidents (P2-E14-07, §5.14) — the app's answer to "is it me
   * or is it them?", in the panel where "something happened" already lives.
   *
   * §5.14 asks for incident start/resolve to reach the event surface. It rides
   * the NOTICE slot rather than the list because `events/feed.ts` is one item
   * per SESSION by construction (§5.12) and a provider incident belongs to no
   * session — the same road the update notice and the reconnect offer take.
   * Undismissable, unlike those two: it is not an offer, and it leaves on its
   * own when the incident does.
   */
  incidents?: readonly { id: string; name: string; status: string }[];
  /**
   * How to dismiss the surface this content is mounted in — rendered as a ✕ in
   * the header row beside the eyebrow (#556).
   *
   * IT LIVES HERE RATHER THAN IN THE DRAWER because the eyebrow IS the header:
   * a close button in a strip of its own above this would be a second row of
   * chrome saying nothing, and one absolutely positioned over this row would
   * fight the panel's own scrollbar. The panel still knows nothing about
   * drawers — it is handed a callback and a place to put it.
   *
   * OPTIONAL, so the content stays mountable in something that has no way out
   * to offer. `EventsDrawer` always passes its own `onClose`, which is why the
   * drawer's version of this prop is required.
   */
  onClose?: () => void;
  /**
   * What the app changed about a card's conversation history without being
   * asked (#539) — a conversation the repair sweep ADOPTED for an orphaned
   * card, or one a card CEDED because two cards pointed at it.
   *
   * The fourth tenant of this slot (the #425 coordination note), and it belongs
   * here for the same reason the incidents do: `events/feed.ts` is one item per
   * SESSION and this is not the session's state — it is a thing the app did to
   * the card while nobody was watching. Dismissible, unlike an incident,
   * because it is finished news rather than a live condition; there is nothing
   * left for it to stop being true about.
   */
  historyRepairs?: readonly HistoryRepairNotice[];
  /** the notice's one control: I have read this. */
  onDismissHistoryRepair?: (id: string) => void;
  /**
   * The missed-events digest (P2-E14-05c) — what quiet hours held while nobody
   * was told, already ordered and summarised by `lib/digest.ts`.
   *
   * The FIFTH tenant of this slot, and the only one that is a deliberate
   * REPLAY: an incident is live, an update is waiting, a repair just happened,
   * but this is last night. It sits above the live rows for exactly that reason
   * — it is the thing you did not see, and the rows below are the things you
   * still can.
   *
   * Absent (or empty) when nothing was held, which is the ordinary case and the
   * one the calm check cares about: a night where the window silenced nothing
   * renders nothing at all.
   */
  digest?: Digest | null;
  /** review it: clears by the ids the digest drew, never "everything". */
  onClearDigest?: (ids: readonly string[]) => void;
  /**
   * Every request main is holding, fleet-wide: the store's ledger (P2-E9-11),
   * which is what a row's inline buttons answer from (P2-E14-02).
   *
   * REQUIRED, for `queueEvents`' reason: a mount that forgot it would render a
   * needs-permission row with no buttons, and nothing would say why.
   */
  held: readonly PermissionRequestDto[];
  /** answer ONE held request, on the same channel the card's bar uses */
  onDecidePermission: (requestId: string, decision: 'allow' | 'deny') => void;
  /**
   * The card bar's "Allow all (this session)", from a row: write the standing
   * grant for this LIVE session, then allow what it is already holding.
   */
  onAllowAllSession: (liveSessionId: string, heldRequestIds: readonly string[]) => void;
  /** which of §5.12's three views is showing. App owns it, because the drawer
   *  unmounts this panel when it shuts and the choice has to survive that. */
  filter: EventsFilter;
  onFilterChange: (filter: EventsFilter) => void;
  /** the rail's order, as card ids — what "By session" sorts by */
  railOrder: readonly string[];
}

export function EventsPanel(props: EventsPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  // the panel's heading doubles as the list's label — one "Events", not two
  const eyebrowId = React.useId();
  const events = props.events;
  // Where the hotkey will actually take you next — the same function the
  // hotkey itself calls, fed the same cursor. Anything cheaper (say, always
  // the head of the queue) would be a lie from the second press onward.
  const head = nextInQueue(props.queueEvents, props.visited).next?.id ?? null;

  // events carry the LIVE session id; the rail rows know both ids (Dan #9 —
  // the panel was showing raw live-id fragments instead of session names)
  const byId = new Map<string, RailSession>();
  for (const s of props.sessions) {
    byId.set(s.id, s);
    if (s.liveId) byId.set(s.liveId, s);
  }
  /**
   * "Open it" on a dispatch-result row — focus the session that WROTE the report
   * (P2-E13-05), which is the one session that row is about and the only one of
   * its two ids the rest of the row never names.
   *
   * Through `byId` for the same reason the row's own open does: `onFocus` wants a
   * card where there is one, and an event carries a live id.
   */
  const dispatchOpen = (reviewer: string, eventId: number) => (): void => {
    props.onFocus(byId.get(reviewer)?.id ?? reviewer);
    props.onVisit?.(eventId);
  };
  const railPos = new Map(props.railOrder.map((id, i) => [id, i]));
  const holdingIds = new Set(props.held.map((r) => r.sessionId));
  const ordered = visibleEvents(
    events,
    props.filter,
    (sid) => {
      const s = byId.get(sid);
      return s ? railPos.get(s.id) : undefined;
    },
    (sid) => holdingIds.has(sid)
  );
  // "Nothing needs you" is only true of the WHOLE list. Under Needed with only
  // reviewed rows left, the honest line is that this filter is empty.
  const filteredEmpty = events.length > 0 && ordered.length === 0;

  return (
    <aside
      // Named, because it is a complementary landmark a keyboard user now
      // ARRIVES at rather than one that was simply always on screen (§5.32).
      // The eyebrow below still labels the LIST — one "Events" for the region
      // and one for the set of rows inside it, which is what a screen reader's
      // landmark menu and its list summary each want.
      aria-label={t('events.eyebrow')}
      style={{
        // fills the drawer instead of claiming a column from the grid: the
        // 220px this used to reserve in every layout mode is the whole point
        // of P2-E14-01. The drawer owns the width, the edge and the shadow.
        inlineSize: '100%',
        blockSize: '100%',
        background: 'var(--panel)',
        paddingInline: 7,
        // the TOP 8px lives on the sticky header instead (#556) — a negative
        // margin would have pulled the rest of the panel up under it, because
        // in normal flow a negative block-start margin moves the following
        // siblings too. The header carries the padding it wants to keep when
        // it is pinned; nothing else changes.
        paddingBlockStart: 0,
        paddingBlockEnd: 8,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
      }}
    >
      {/* THE HEADER ROW. Role-less on purpose (§5.32 rule 2): it holds a
          control, and a container role would make that control presentational.
          The eyebrow keeps `eyebrowId` — the id labels the LIST below, and a
          label that swept in the ✕ would name the list "Events ✕".

          STICKY, because this row now holds the WAY OUT (#556). The `<aside>`
          around it is the scroll container, so before this the header simply
          scrolled away — which is fine for an eyebrow and not fine for a close
          button whose entire reason for existing is being findable. A control
          that vanishes once there are enough events to scroll is the same bug
          the item was filed about, one screenful later.

          It OWNS the padding on all four sides rather than sitting inside the
          aside's: `marginInline: -7` widens it back out over the aside's inline
          padding so its background spans edge to edge and rows cannot show
          through beside it when it is pinned, and the aside gives up its
          `paddingBlockStart` to the `paddingBlock` here. A negative
          `marginBlockStart` was the obvious way to do the block half and is
          wrong — it moves every following sibling up by the same 8px, which
          measured as an 8px overlap of this row over the hotkey hint.

          `zIndex` because the rows below are `position: relative` (each one
          hangs a Dismiss off itself), and a positioned sibling at the same
          level would otherwise paint over this. */}
      <div
        style={{
          position: 'sticky',
          insetBlockStart: 0,
          zIndex: 1,
          background: 'var(--panel)',
          marginInline: -7,
          paddingBlock: 8,
          paddingInline: 7,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <div
          id={eyebrowId}
          style={{
            flex: 1,
            minInlineSize: 0,
            fontSize: 9,
            letterSpacing: 1.3,
            fontWeight: 600,
            color: 'var(--faint)',
            textTransform: 'uppercase',
          }}
        >
          {t('events.eyebrow')}
        </div>
        {/* THE WAY OUT, VISIBLE (#556). Every route out already existed — the
            edge tab, Escape, the accelerator, the palette — and the owner still
            hunted for one, because an edge tab reads as a way IN and nothing
            on the open drawer said it was also the way back. So this is
            discoverability rather than mechanism: it calls the very `onClose`
            the tab and Escape call, which App answers by flipping the same
            `open` flag `Mod+E` and the palette flip. That is what makes "closed
            by button" and "closed by Escape" the same state by construction,
            rather than by a second code path kept in step by hand.

            FIRST FOCUSABLE THING IN THE DRAWER, which is deliberate: opening
            moves focus to the body, so the very first Tab lands here and the
            keyboard user meets the way out before the list — the same order
            the eye reads it in.

            A real `<button>` with a worded name, not a bare glyph: `✕` is
            decoration, and a screen reader that reads it announces nothing
            useful (§5.32 rule 1). */}
        {props.onClose && (
          <button
            type="button"
            className="events-close"
            data-testid="events-close"
            onClick={props.onClose}
            aria-label={t('events.drawer.close')}
            // the tooltip teaches the keyboard route the way the tab's does
            title={t('events.drawer.closeHint')}
            style={{
              flex: '0 0 auto',
              background: 'var(--chip)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-chip)',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: 10,
              lineHeight: 1.2,
              padding: '1px 6px',
              fontFamily: 'var(--font-ui)',
            }}
          >
            {t('events.drawer.closeIcon')}
          </button>
        )}
      </div>
      {/* §5.12's three views (P2-E14-02). Toggle buttons rather than tabs: the
          list below is the same list either way, re-ordered or narrowed, not a
          different panel per choice. `aria-pressed` is what tells a screen
          reader which one is on. */}
      <div
        role="group"
        aria-label={t('events.filter.label')}
        data-testid="events-filters"
        style={{ display: 'flex', gap: 4, marginBlockEnd: 6 }}
      >
        {EVENTS_FILTERS.map((f) => {
          const on = props.filter === f;
          return (
            <button
              key={f}
              type="button"
              className="events-btn"
              data-events-filter={f}
              aria-pressed={on}
              onClick={() => props.onFilterChange(f)}
              style={{
                background: on ? 'var(--chip)' : 'transparent',
                color: on ? 'var(--text)' : 'var(--muted)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-chip)',
                padding: '1px 8px',
                cursor: 'pointer',
                fontSize: 10,
                fontWeight: on ? 600 : 400,
                fontFamily: 'var(--font-ui)',
              }}
            >
              {t(`events.filter.${f}`)}
            </button>
          );
        })}
      </div>
      {head !== null && props.queueBinding && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--muted)',
            marginBlockEnd: 6,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {t('events.queueHint', { binding: props.queueBinding })}
        </div>
      )}
      {!!props.incidents?.length && (
        <div
          data-events-notice="incident"
          style={{
            background: 'var(--panel2)',
            border: '1px solid var(--status-crashed)',
            borderRadius: 'var(--radius-chip)',
            padding: '7px 9px',
            marginBlockEnd: 6,
            fontSize: 11,
          }}
        >
          <div
            // The panel's one announcement idiom (#314): status + polite. An
            // incident is news about the world, and it arrives long after mount.
            //
            // Inserted WITH its text, unlike the corroboration strip, which
            // holds its words back a commit so an already-existing region
            // receives them (#222's lesson). Deliberate, not an oversight: this
            // card is one of three notices sharing this slot and the panel's
            // idiom is the one a reader of this file will expect — and the
            // strip is the surface that has to be heard, because it is the one
            // that arrives while you are busy blaming your own prompt.
            role="status"
            aria-live="polite"
            style={{ color: 'var(--text)' }}
          >
            {props.incidents.map((i) => (
              <div key={i.id} style={{ marginBlockEnd: 2 }}>
                {t('health.eventsIncident', { name: i.name, status: i.status })}
              </div>
            ))}
          </div>
        </div>
      )}
      {props.updateNotice && (
        // Same shell as the reconnect offer below — one notice shape in this
        // panel, so a second kind of "here is a thing you might do" does not
        // teach the eye a second pattern. Bordered in `--faint` rather than a
        // status hue: an update is news, not attention.
        <div
          data-events-notice={props.updateNotice.kind}
          style={{
            background: 'var(--panel2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            padding: '7px 9px',
            marginBlockEnd: 6,
            fontSize: 11,
          }}
        >
          <div
            // Both arrive AFTER mount — one from a handshake round-trip, one
            // when a dialog closes — so a screen reader would otherwise never
            // hear either. `status` rather than `alert`: this is news, and news
            // waits for a pause. (#314 gave the reconnect offer below the same
            // pair, so this panel now has ONE announcement idiom.)
            role="status"
            aria-live="polite"
            style={{ color: 'var(--text)', marginBlockEnd: 6 }}
          >
            {props.updateNotice.kind === 'installed'
              ? t('events.updateInstalled', { version: props.updateNotice.version })
              : t('events.updateAvailable', { version: props.updateNotice.version })}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {props.updateNotice.kind === 'available' && (
              <button
                className="events-btn"
                onClick={props.onUpdateNow}
                style={{
                  background: 'var(--btn-primary-bg)',
                  color: 'var(--btn-primary-text)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-chip)',
                  padding: '2px 10px',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontFamily: 'var(--font-ui)',
                }}
              >
                {t('events.updateNow')}
              </button>
            )}
            <button
              className="events-btn"
              onClick={props.onDismissUpdateNotice}
              style={{
                background: 'transparent',
                color: 'var(--muted)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-chip)',
                padding: '2px 10px',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'var(--font-ui)',
              }}
            >
              {props.updateNotice.kind === 'installed' ? t('events.gotIt') : t('events.notNow')}
            </button>
          </div>
        </div>
      )}
      {!!props.historyRepairs?.length && (
        <div
          data-events-notice="history-repair"
          style={{
            background: 'var(--panel2)',
            // `--border`-weight like the update notice rather than a status hue:
            // this is news about something already finished, not attention.
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            padding: '7px 9px',
            marginBlockEnd: 6,
            fontSize: 11,
          }}
        >
          <div
            // The panel's one announcement idiom (#314), and this notice needs
            // it more than most: the ceded half is decided during the workspace
            // load, so it is ALREADY TRUE when the window mounts and there is no
            // later event to notice it by.
            role="status"
            aria-live="polite"
            style={{ color: 'var(--text)' }}
          >
            {props.historyRepairs.map((r) => (
              <div
                key={r.id}
                data-history-repair={r.kind}
                style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBlockEnd: 4 }}
              >
                <span style={{ flex: 1, minInlineSize: 0 }}>
                  {r.kind === 'adopted'
                    ? t('events.historyAdopted', { card: r.cardTitle })
                    : t('events.historyCeded', { card: r.cardTitle, kept: r.keptByTitle ?? '' })}
                </span>
                <button
                  className="events-btn"
                  onClick={() => props.onDismissHistoryRepair?.(r.id)}
                  // Named per ROW, because a slot with three of these would
                  // otherwise be three buttons all called "Got it" (§5.32).
                  aria-label={t('events.historyDismiss', { card: r.cardTitle })}
                  style={{
                    background: 'transparent',
                    color: 'var(--muted)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-chip)',
                    padding: '2px 10px',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontFamily: 'var(--font-ui)',
                    flexShrink: 0,
                  }}
                >
                  {t('events.gotIt')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {!!props.digest?.total && (
        <div
          data-events-notice="digest"
          data-digest-total={props.digest.total}
          style={{
            background: 'var(--panel2)',
            // `--border` weight, like the update and history-repair notices:
            // this is news about a night that is over, not a thing waiting on
            // the user. A status hue here would make last night compete with the
            // live rows underneath it, which is the wall of stale toasts this
            // replaces.
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            padding: '7px 9px',
            marginBlockEnd: 6,
            fontSize: 11,
          }}
        >
          <div
            // #314's pair, and this tenant needs it most of all: the digest is
            // ALREADY TRUE when the window mounts — it is about events that
            // happened before this renderer existed — so there is no later
            // event for a screen reader to notice it by. `polite`, because a
            // summary of last night can wait for the end of a sentence.
            role="status"
            aria-live="polite"
            style={{ color: 'var(--text)' }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBlockEnd: 4 }}>
              <span style={{ flex: 1, minInlineSize: 0, fontWeight: 600 }}>
                {t('events.digest.heading', { count: props.digest.total })}
              </span>
              <button
                className="events-btn"
                onClick={() => props.onClearDigest?.(props.digest?.ids ?? [])}
                // Named with the count, not just "Clear": this button destroys
                // the only record of a night nobody watched, and a control that
                // says how much it is about to take is the difference between a
                // review and an accident (§5.32).
                aria-label={t('events.digest.clearLabel', { count: props.digest.total })}
                style={{
                  background: 'transparent',
                  color: 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-chip)',
                  padding: '2px 10px',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontFamily: 'var(--font-ui)',
                  flexShrink: 0,
                }}
              >
                {t('events.digest.clear')}
              </button>
            </div>
            {props.digest.sessions > 1 && (
              <div style={{ color: 'var(--muted)', marginBlockEnd: 4 }}>
                {t('events.digest.sessions', { count: props.digest.sessions })}
              </div>
            )}
            {props.digest.rows.map((r) => (
              <div
                key={r.id}
                data-digest-row={r.kind}
                style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBlockEnd: 2 }}
              >
                <span style={{ flex: 1, minInlineSize: 0 }}>
                  {/* The title is #482's CAPTURE, never a live lookup: the card
                      may have been renamed, closed or re-labelled since 03:00,
                      and a digest that re-derived its text would report last
                      night's event under this morning's name. */}
                  {t('events.digest.row', { title: r.title, kind: t(`events.kind.${r.kind}`) })}
                </span>
                <span style={{ color: 'var(--muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                  {/* The DATE as well, for anything not from today. The cap is
                      200 records and a long weekend is what that is for, so a
                      bare "03:14" on a list spanning midnight names no night at
                      all — in a feature whose entire subject is which night. */}
                  {r.earlierDay
                    ? `${new Date(r.at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })} ${new Date(r.at).toLocaleTimeString()}`
                    : new Date(r.at).toLocaleTimeString()}
                </span>
              </div>
            ))}
            {props.digest.overflow > 0 && (
              <div style={{ color: 'var(--muted)', marginBlockStart: 2 }}>
                {t('events.digest.more', { count: props.digest.overflow })}
              </div>
            )}
          </div>
        </div>
      )}
      {props.reconnectOffer && (
        <div
          style={{
            background: 'var(--panel2)',
            border: '1px solid var(--status-working)',
            borderRadius: 'var(--radius-chip)',
            padding: '7px 9px',
            marginBlockEnd: 6,
            fontSize: 11,
          }}
        >
          <div
            // #314: same pair as the update notice above, for the same reason —
            // a monitor coming back is noticed by the app, not by the user, so
            // the offer appears long after mount with nothing to draw a screen
            // reader's attention to it. `polite`, because a display returning is
            // news you can finish your sentence over.
            role="status"
            aria-live="polite"
            style={{ color: 'var(--text)', marginBlockEnd: 6 }}
          >
            {t('events.reconnectOffer')}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="events-btn"
              onClick={props.onRestoreLayout}
              style={{
                background: 'var(--btn-primary-bg)',
                color: 'var(--btn-primary-text)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-chip)',
                padding: '2px 10px',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'var(--font-ui)',
              }}
            >
              {t('events.restore')}
            </button>
            <button
              className="events-btn"
              onClick={props.onDismissOffer}
              style={{
                background: 'transparent',
                color: 'var(--muted)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-chip)',
                padding: '2px 10px',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'var(--font-ui)',
              }}
            >
              {t('events.notNow')}
            </button>
          </div>
        </div>
      )}
      {events.length === 0 &&
        !props.reconnectOffer &&
        !props.updateNotice &&
        !props.incidents?.length &&
        !props.historyRepairs?.length &&
        !props.digest?.total && (
        <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t('events.empty')}</div>
      )}
      {filteredEmpty && (
        <div data-testid="events-filter-empty" style={{ color: 'var(--muted)', fontSize: 11 }}>
          {t('events.filter.empty')}
        </div>
      )}
      {/* A real list, so the rows read as a set and their count is announced
          (#197). Only the rows are inside it — the eyebrow, the hotkey hint and
          the reconnect offer are not list items and would inflate that count. */}
      <div role="list" aria-labelledby={eyebrowId}>
        {ordered.map((e) => {
          const s = byId.get(e.sessionId);
          const isNext = e.id === head;
          const reviewed = e.kind === 'ready';
          const open = (): void => {
            props.onFocus(s?.id ?? e.sessionId);
            // clicking IS visiting: the hotkey must not send you straight back to
            // the row you just opened by hand (§5.8 — a click anywhere is a
            // reveal trigger). Pressing Enter on the row's button is the same act.
            props.onVisit?.(e.id);
            void window.switchboard.events.ack(e.sessionId); // Done. -> Ready
          };
          return (
            <div
              key={e.id}
              role="listitem"
              className="event-row"
              data-event-kind={e.kind}
              data-next={isNext ? 'true' : undefined}
              // the de-emphasis lives in tokens.css, keyed on this attribute
              // (#268) — the fill AND the ink it writes are a measured pair,
              // and an inline `opacity` was neither
              data-reviewed={reviewed ? 'true' : undefined}
              title={reviewed ? t('events.reviewed') : undefined}
              onClick={open}
              style={{
                position: 'relative',
                borderRadius: 'var(--radius-chip)',
                padding: '6px 9px 6px 12px',
                marginBlockEnd: 4,
                cursor: 'pointer',
                fontSize: 11,
                // outline, not border: a ring that shifts the row's box would
                // make the whole list jump every time the head changes
                outline: isNext ? `1px solid ${KIND_HUE[e.kind]}` : undefined,
                outlineOffset: -1,
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  insetInlineStart: 0,
                  insetBlockStart: 0,
                  insetBlockEnd: 0,
                  inlineSize: 3,
                  background: s?.accent ?? 'var(--faint)',
                  borderRadius: 2,
                }}
              />
              {/* The row's real control (#197). Same call as #174's tool boxes:
                  the row CONTAINS a button (Dismiss), so the row itself cannot BE
                  one — a `button` takes presentational children, which would hide
                  the dismiss from a screen reader. So the readable body is the
                  button, the row div stays a role-less mouse convenience that
                  duplicates it, and its accessible name is the whole event: which
                  session, when, what it is doing, and what state it is in.

                  P2-E14-02 wraps it and Dismiss in a positioned box of their
                  own, so Dismiss keeps its corner of the SUMMARY when a row
                  grows answer buttons underneath it: anchored to the row, it
                  would ride down onto them. */}
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="event-open"
                  data-event-open={e.id}
                  onClick={(ev) => {
                    ev.stopPropagation(); // the row below would otherwise re-run it
                    open();
                  }}
                  style={{
                    display: 'block',
                    inlineSize: '100%',
                    textAlign: 'start',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    margin: 0,
                    font: 'inherit',
                    fontSize: 11,
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <span
                      style={{
                        fontWeight: 600,
                        // the ROW's colour, so the reviewed step down the neutral
                        // ladder is one declaration in tokens.css rather than a
                        // ternary here (#268)
                        color: 'inherit',
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {s?.title ?? t('events.unknownSession')}
                    </span>
                    <span style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                      {new Date(e.at).toLocaleTimeString()}
                    </span>
                  </span>
                  {/* always rendered so every item is the SAME height (Dan round 4) */}
                  <span
                    style={{
                      display: 'block',
                      // The task label — the text #268 was actually filed over
                      // (4.55:1 on nordic at full strength, 3.61:1 once the old
                      // group opacity was folded in). It stays an explicit token
                      // rather than inheriting, because on a LIVE row it is the
                      // step below the title and inheriting would flatten that.
                      // The consequence to know: it is covered by the drift test
                      // only because `.event-row[data-reviewed='true']` happens
                      // to name this same token, so retuning that rule's `color`
                      // means retuning this with it.
                      color: 'var(--muted)',
                      fontSize: 10,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s?.taskLabel ?? ' '}
                  </span>
                  {/* the status line reserves the corner Dismiss sits in, so a long
                      status can never run underneath it */}
                  <span
                    style={{
                      display: 'block',
                      color: KIND_INK[e.kind],
                      marginBlockStart: 1,
                      // width AND height: Dismiss is out of flow now, so this
                      // line is the only thing holding the row tall enough for
                      // it. Without the min height its button rides up into the
                      // task label above, which has no gutter of its own.
                      paddingInlineEnd: DISMISS_GUTTER,
                      minBlockSize: 16,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {/* A dispatch-result's row is on the AUTHOR's card, so the
                        one word every other kind prints ("Done.") would be a
                        statement about the wrong session. It names the role and
                        the session that wore it instead. */}
                    {e.kind === 'dispatch-result' && e.dispatch
                      ? t(dispatchRowKey(e.dispatch), {
                          role: e.dispatch.templateName,
                          session: e.dispatch.reviewerName,
                        })
                      : t(`events.kind.${e.kind}`)}
                    {isNext && (
                      <span
                        title={t('events.nextUpHint')}
                        style={{
                          marginInlineStart: 6,
                          fontSize: 9,
                          letterSpacing: 0.6,
                          textTransform: 'uppercase',
                          color: 'var(--faint)',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        {t('events.nextUp')}
                      </span>
                    )}
                  </span>
                </button>
                {/* Dismiss keeps the bottom-right corner it has always had — out of
                    the click path of the row you are trying to OPEN (Dan
                    2026-07-26) — but it is a SIBLING of the open button now:
                    nested inside, it would have been unreachable by keyboard. */}
                <button
                  onClick={(ev) => {
                    ev.stopPropagation(); // dismiss, don't focus
                    // BY ID as well as by session (P2-E13-05): a session can own
                    // a status row AND a dispatch-result row, and dismissing one
                    // must not take the other.
                    void window.switchboard.events.dismiss(e.sessionId, e.id);
                  }}
                  type="button"
                  className="event-dismiss"
                  title={t('events.dismissHint')}
                  style={{
                    position: 'absolute',
                    // 0/0 rather than the row's 6/9: this box sits INSIDE the
                    // row's padding now, so the old offsets are already applied
                    insetBlockEnd: 0,
                    insetInlineEnd: 0,
                    background: 'var(--chip)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-chip)',
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    fontSize: 9.5,
                    lineHeight: 1.4,
                    padding: '0 7px',
                    fontFamily: 'var(--font-ui)',
                  }}
                >
                  {t('events.dismiss')}
                </button>
              </div>
              {e.kind === 'dispatch-result' && e.dispatch ? (
                <DispatchActions
                  result={e.dispatch}
                  // The rail's own list, which is keyed by live session id — the
                  // renderer already knows which sessions exist, so the DTO does
                  // not carry a liveness flag that would be stale the moment it
                  // crossed.
                  reviewerLive={byId.has(e.dispatch.reviewer)}
                  onOpenReviewer={dispatchOpen(e.dispatch.reviewer, e.id)}
                  t={t}
                />
              ) : (
                <HeldActions
                  held={heldFor(props.held, e.sessionId)}
                  who={s?.title ?? t('events.unknownSession')}
                  liveSessionId={e.sessionId}
                  onDecide={props.onDecidePermission}
                  onAllowAll={props.onAllowAllSession}
                  onAnswer={open}
                  t={t}
                />
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/**
 * What a row can do about the request its session is blocked on (P2-E14-02).
 *
 * Renders nothing when the session is holding nothing, so every other row is
 * exactly the row it was.
 *
 * Every click in here STOPS at this box. The row around it is a mouse
 * convenience that opens (focuses) the card, and the done-when is that a
 * permission is answered "with the card never focused". A click that landed
 * between two buttons would otherwise do the one thing this surface promises
 * not to.
 *
 * The buttons DO NOT pop anything locally. Main's `permissionResolved` clears
 * the ledger, the card's bar and the grouped card in one push, and the row
 * leaves when its session's status moves on (§5.12's resolved-means-gone). The
 * grouped card makes the same choice and gives the reason at length in App's
 * `decideHeld`.
 */
function HeldActions(props: {
  held: HeldForSession;
  /** the session's name, for button names a screen reader can tell apart */
  who: string;
  liveSessionId: string;
  onDecide: (requestId: string, decision: 'allow' | 'deny') => void;
  onAllowAll: (liveSessionId: string, heldRequestIds: readonly string[]) => void;
  /** questions are answered on the card: open it */
  onAnswer: () => void;
  t: TFunction;
}): React.JSX.Element | null {
  const { held, t, who } = props;
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();
  const perm = held.permission;
  const shownId = perm?.requestId ?? null;
  // THE DOUBLE-CLICK GUARD. Nothing pops locally (see above), so when the
  // answer lands the row swaps in the NEXT held request under the same
  // pointer, and a second click, or a double-click, would answer a request
  // nobody read. So a click disarms the buttons, and they re-arm only a beat
  // AFTER a different request is showing. The ceiling is the fail-open: if the
  // answer never lands (the channel died), the buttons come back rather than
  // staying dead on a question that is still open.
  const [disarmed, setDisarmed] = React.useState(false);
  React.useEffect(() => {
    if (!disarmed) return;
    const ceiling = setTimeout(() => setDisarmed(false), REARM_CEILING_MS);
    return () => clearTimeout(ceiling);
  }, [disarmed]);
  const answeredId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!disarmed || shownId === answeredId.current) return;
    const rearm = setTimeout(() => setDisarmed(false), REARM_MS);
    return () => clearTimeout(rearm);
  }, [disarmed, shownId]);
  if (!perm && held.questions.length === 0) return null;
  const more = held.permissionIds.length - 1;
  const tool = perm ? (perm.displayName ?? perm.tool) : '';
  const answer = (act: () => void): void => {
    if (disarmed) return;
    answeredId.current = shownId;
    setDisarmed(true);
    act();
  };
  return (
    <div
      data-event-held={props.liveSessionId}
      onClick={(ev) => ev.stopPropagation()}
      // An EMPTY title, on purpose: it stops the row's own tooltip ("Already
      // seen" on a reviewed row) from showing over these buttons, which are
      // not already seen at all.
      title=""
      style={{ marginBlockStart: 5, cursor: 'default' }}
    >
      {perm && (
        <>
          <div
            data-event-permission={perm.requestId}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginBlockEnd: 4,
            }}
            // the full argument on hover — the line is cut to fit 300px (from the
            // front, for a path: see `rowArgument`)
            title={`${perm.tool} ${argumentDetail(perm.input)}`}
          >
            <span style={{ fontWeight: 600, marginInlineEnd: 5 }}>{tool}</span>
            <span style={{ color: 'var(--muted)' }}>{rowArgument(perm.input)}</span>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="events-btn"
              data-event-allow={perm.requestId}
              aria-label={t('events.held.allowOne', { tool, session: who })}
              disabled={disarmed}
              onClick={() => answer(() => props.onDecide(perm.requestId, 'allow'))}
              style={actionBtn(true)}
            >
              {t('events.held.allow')}
            </button>
            <button
              type="button"
              className="events-btn"
              data-event-allow-all={props.liveSessionId}
              aria-label={t('events.held.allowAllOne', { session: who })}
              title={t('events.held.allowAllHint')}
              disabled={disarmed}
              onClick={() => answer(() => props.onAllowAll(props.liveSessionId, held.permissionIds))}
              style={actionBtn(false)}
            >
              {t('events.held.allowAll')}
            </button>
            <button
              type="button"
              className="events-btn"
              data-event-deny={perm.requestId}
              aria-label={t('events.held.denyOne', { tool, session: who })}
              disabled={disarmed}
              onClick={() => answer(() => props.onDecide(perm.requestId, 'deny'))}
              style={actionBtn(false)}
            >
              {t('events.held.deny')}
            </button>
            {more > 0 && (
              <span style={{ fontSize: 10, color: 'var(--muted)' }}>
                {t('events.held.more', { count: more })}
              </span>
            )}
          </div>
        </>
      )}
      {held.questions.length > 0 && (
        <div style={{ marginBlockStart: perm ? 5 : 0 }}>
          <button
            type="button"
            className="events-btn"
            data-event-questions={props.liveSessionId}
            aria-label={t('events.held.questionsIn', { count: held.questions.length, session: who })}
            aria-expanded={expanded}
            // only while the list exists: an id that points at nothing is a
            // reference a checker rightly flags
            aria-controls={expanded ? listId : undefined}
            onClick={() => setExpanded((v) => !v)}
            style={{
              ...actionBtn(false),
              display: 'inline-flex',
              gap: 4,
            }}
          >
            <span aria-hidden>{expanded ? t('events.held.collapseIcon') : t('events.held.expandIcon')}</span>
            {t('events.held.questions', { count: held.questions.length })}
          </button>
          {expanded && (
            <QuestionList
              id={listId}
              questions={held.questions}
              who={who}
              onAnswer={props.onAnswer}
              t={t}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Which sentence a dispatch-result row prints (P2-E13-05).
 *
 * One per outcome, plus the split `delivered` needs: §5.4's whole point is that
 * an injected block WAITS for a keypress unless the author's card accepts
 * siblings automatically, and "handed to your message box" and "handed over and
 * already running" are different things to have just done.
 *
 * ⚠️ READ OFF THE ROW, NOT OFF THE CLICK. The confirmation used to live in
 * `DispatchActions`' own state, and it never survived: main re-raises the row to
 * mark it delivered, which mints a new event id, which changes the React `key`,
 * which remounts the component with fresh state. A confirmation that vanishes at
 * the moment it is earned is worse than none, and it also could not be seen from
 * a second Events surface. Cost one red e2e to learn.
 */
function dispatchRowKey(d: DispatchResultDto): string {
  if (d.outcome !== 'delivered') return `events.dispatch.${d.outcome}`;
  return d.submitted ? 'events.dispatch.deliveredAuto' : 'events.dispatch.delivered';
}

/**
 * What a row can do about a finished dispatch (P2-E13-05, §5.15's round-trip).
 *
 * §5.15 asks for *one-click "inject findings into author session"*, and this is
 * that click. The row it hangs under is the AUTHOR's, so "inject" means "into
 * this card" — there is no target to choose, which is what makes one button
 * enough.
 *
 * ⚠️ IT DOES NOT SHOW THE FINDINGS. The headline is one line the reviewer wrote,
 * and it is one line because the report never crosses to the renderer at all
 * (`shared/dispatch-result.ts` has the two reasons). Reading the review means
 * opening the session that wrote it, which is the second button.
 *
 * Every click STOPS here, for `HeldActions`' reason: the row around it focuses
 * the author, and a click that landed between two buttons would do the one thing
 * the user did not ask for.
 */
function DispatchActions(props: {
  result: DispatchResultDto;
  /** the reviewer is still a session the app knows — see the Open button */
  reviewerLive: boolean;
  onOpenReviewer: () => void;
  t: TFunction;
}): React.JSX.Element {
  const { result, t } = props;
  /**
   * `idle` → the button is offered; `sending` → it is disarmed; then the outcome.
   *
   * A REFUSAL RETURNS TO `idle`-with-a-reason rather than to a dead button.
   * `delivery.ts` refuses for things that pass — a composer that is momentarily
   * full, a window that did not confirm in time — and main deliberately does not
   * spend the held report on a refusal, so the one thing the row must not do is
   * take the button away after the first click landed badly.
   *
   * ⚠️ AND THIS STATE IS A CONVENIENCE, NOT THE GUARD. It disarms one component;
   * main reserves the report for the duration of the send and drops the ROW once
   * it has landed, which is what makes a second Events surface — a popped-out
   * window showing the same list — safe. See `DispatchResults.inject`.
   */
  const [state, setState] = React.useState<
    { at: 'idle'; reason?: string; detail?: string } | { at: 'sending' }
  >({ at: 'idle' });
  const inject = (): void => {
    if (state.at !== 'idle') return;
    setState({ at: 'sending' });
    void window.switchboard.dispatch
      .inject(result.reviewer)
      .then((raw) => {
        // LAUNDERED AT THE BOUNDARY (#346/#440/#650). A refused call resolves an
        // `IpcRefusal`, which read as `raw.ok` is `undefined` — falsy, so the row
        // would print an empty refusal and look like a bug in main. `answered`
        // turns it into the absence this site already has a sentence for.
        const r = answered(raw);
        if (!r) return setState({ at: 'idle', reason: t('events.dispatch.noAnswer') });
        // NOTHING TO SET ON SUCCESS. Main re-raises the row `delivered`, which
        // remounts this component under a new event id — see `dispatchRowKey`.
        // The row is the confirmation, on every surface rather than this one.
        if (r.ok) return;
        // A KEY, NOT A SENTENCE (#950 review). Main's refusals are catalogue keys
        // precisely so this line does not print English written for an agent;
        // `detail` is the one thing main knows and we do not, and it rides the
        // tooltip rather than the row.
        setState({ at: 'idle', reason: t(`events.dispatch.refused.${r.reasonKey}`), detail: r.detail });
      })
      // The channel itself failing is the one case main cannot phrase for us —
      // and `String(err)` is a stack, not a sentence, so the user gets ours.
      .catch((err: unknown) => {
        setState({ at: 'idle', reason: t('events.dispatch.refused.channel'), detail: String(err) });
      });
  };
  return (
    <div
      data-event-dispatch={result.reviewer}
      onClick={(ev) => ev.stopPropagation()}
      title=""
      style={{ marginBlockStart: 5, cursor: 'default' }}
    >
      {result.headline && (
        <div
          data-testid="event-dispatch-headline"
          // TWO LINES, not one. Everything else on this row is a single
          // ellipsised line because it is a label; this is the reviewer's own
          // sentence, and half of "This change is not correct and should not be
          // merged as written" is worse than none of it. The full text is on the
          // reviewer's card, which the button below opens.
          style={{
            fontSize: 10.5,
            color: 'var(--text)',
            marginBlockEnd: 4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {result.headline}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        {result.chars > 0 && (
          <button
            type="button"
            className="events-btn"
            data-event-inject={result.reviewer}
            aria-label={t('events.dispatch.injectFrom', { session: result.reviewerName })}
            title={t('events.dispatch.injectHint')}
            disabled={state.at === 'sending'}
            onClick={inject}
            style={actionBtn(true)}
          >
            {t('events.dispatch.inject')}
          </button>
        )}
        {/* OFFERED ONLY WHILE THERE IS SOMETHING TO OPEN. The report deliberately
            outlives the session that wrote it — closing a finished reviewer's
            card is a documented, ordinary thing to do — so this button's target
            can be gone while the row is not, and a button that focuses a dead id
            does nothing visible at all (#950 review). */}
        {props.reviewerLive ? (
          <button
            type="button"
            className="events-btn"
            data-event-open-reviewer={result.reviewer}
            aria-label={t('events.dispatch.openReviewerNamed', { session: result.reviewerName })}
            onClick={props.onOpenReviewer}
            style={actionBtn(false)}
          >
            {t('events.dispatch.openReviewer')}
          </button>
        ) : (
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>{t('events.dispatch.reviewerGone')}</span>
        )}
        {result.truncated && (
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>{t('events.dispatch.truncated')}</span>
        )}
      </div>
      {state.at === 'idle' && state.reason && (
        <div
          data-testid="event-dispatch-refused"
          role="status"
          // `detail` is main's own sentence — worth having, written for an agent,
          // so it hovers rather than speaks.
          title={state.detail}
          style={{ fontSize: 10, color: 'var(--status-crashed-ink)', marginBlockStart: 4 }}
        >
          {state.reason}
        </div>
      )}
    </div>
  );
}

/**
 * The questions-queue placeholder (§5.12): what the session asked, to come back
 * to. Read-only on purpose. Answering needs the card's own panel, because a
 * blind "allow" on a question discards it (see `lib/events-v2`'s `heldFor`).
 */
function QuestionList(props: {
  id: string;
  questions: readonly AskQuestion[];
  who: string;
  onAnswer: () => void;
  t: TFunction;
}): React.JSX.Element {
  const { t } = props;
  return (
    <div id={props.id} data-testid="event-question-list" style={{ marginBlockStart: 4 }}>
      <ol style={{ margin: 0, paddingInlineStart: 16, fontSize: 10.5, color: 'var(--text)' }}>
        {props.questions.map((q, i) => (
          <li key={i} style={{ marginBlockEnd: 4 }}>
            {q.header && (
              <span style={{ fontWeight: 600, marginInlineEnd: 4 }}>
                {t('events.held.questionHeader', { header: q.header })}
              </span>
            )}
            {q.question}
            {q.options.length > 0 && (
              <div style={{ color: 'var(--muted)', fontSize: 10 }}>
                {q.options.map((o) => o.label).join(t('events.held.optionSeparator'))}
              </div>
            )}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="events-btn"
        data-event-answer
        aria-label={t('events.held.answerIn', { session: props.who })}
        onClick={props.onAnswer}
        style={actionBtn(true)}
      >
        {t('events.held.answer')}
      </button>
    </div>
  );
}

/** how long after a NEW request shows before its buttons take a click */
const REARM_MS = 400;
/** the longest a click can leave the buttons disarmed if no answer lands */
const REARM_CEILING_MS = 5_000;

// The grouped card's secondary fill (`BatchApprovalBar`'s `btn`), so an
// approval button looks the same on every surface that offers one.
const actionBtn = (primary: boolean): React.CSSProperties => ({
  background: primary ? 'var(--btn-primary-bg)' : 'var(--panel)',
  color: primary ? 'var(--btn-primary-text)' : 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-chip)',
  padding: '1px 8px',
  cursor: 'pointer',
  fontSize: 10.5,
  fontFamily: 'var(--font-ui)',
});
// (a disarmed button keeps Chromium's own disabled look: no token to add)
