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
import type { HistoryRepairNotice } from '../../../shared/history-repair';
import { EventDto } from '../model/types';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { RailSession } from './SessionsRail';
import { panelOrder, nextInQueue } from '../lib/queue';

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
 * one: `--muted` on the de-emphasised fill (4.7-14.2:1) for a reviewed row,
 * `--text` on `--panel2` for a live one.
 */
const KIND_HUE: Record<EventDto['kind'], string> = {
  done: 'var(--status-done)',
  ready: 'var(--faint)',
  'needs-input': 'var(--status-needs-input)',
  'needs-permission': 'var(--status-needs-permission)',
  crashed: 'var(--status-crashed)',
};
const KIND_INK: Record<EventDto['kind'], string> = {
  done: 'var(--status-done-ink)',
  ready: 'inherit',
  'needs-input': 'var(--status-needs-input-ink)',
  'needs-permission': 'var(--status-needs-permission-ink)',
  crashed: 'var(--status-crashed-ink)',
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
}

export function EventsPanel(props: EventsPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  // the panel's heading doubles as the list's label — one "Events", not two
  const eyebrowId = React.useId();
  const events = props.events;
  const ordered = panelOrder(events);
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
        !props.historyRepairs?.length && (
        <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t('events.empty')}</div>
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
                  session, when, what it is doing, and what state it is in. */}
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
                  {t(`events.kind.${e.kind}`)}
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
                  void window.switchboard.events.dismiss(e.sessionId);
                }}
                type="button"
                className="event-dismiss"
                title={t('events.dismissHint')}
                style={{
                  position: 'absolute',
                  insetBlockEnd: 6,
                  insetInlineEnd: 9,
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
          );
        })}
      </div>
    </aside>
  );
}
