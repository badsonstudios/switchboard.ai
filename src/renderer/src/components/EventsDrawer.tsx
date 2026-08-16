// The Events drawer (P2-E14-01, Shape B — Dan's pick at the 2026-08-13 gate).
//
// WHAT CHANGED, AND WHAT DID NOT
// ------------------------------
// The Events panel used to be a permanent 220px `<aside>` in the workspace flex
// row. Every layout mode paid for it, in every window, whether or not anything
// was waiting — and the owner's verdict (2026-08-11) was that it is too large
// for what it does. Shape B keeps the panel's CONTENT byte for byte and changes
// only its shape: `EventsPanel` is now the body of this drawer, which
// **overlays** the grid from the right edge and is **collapsed by default** to
// a slim tab. The 220px goes to the session grid in every mode, and because the
// drawer overlays rather than participates in the flex row, opening it costs no
// layout shift — the grid never reflows, so nothing you were reading moves.
//
// WHY IT OVERLAYS RATHER THAN PUSHES. A drawer that took its width back from
// the grid on open would re-lay-out every terminal in the workspace — xterm
// reflows, dockview re-measures — every time you glanced at the queue. That is
// a worse cost than the one this item was filed to remove.
//
// WHAT THE TAB HAS TO CARRY. Collapsed, this tab is the only thing left of the
// panel, so it says what the column used to say by simply existing: how many
// sessions are waiting, how badly the worst of them is (the tint), and whether
// a notice is up behind it (the marker). `lib/events-drawer.ts` derives all
// three off `lib/queue.ts`, which stays the ordering authority — the drawer
// renders the queue, it does not decide it (E9-03, §5.12).
//
// A11Y (§5.32, §5.8), and this is the same departure `FindBar` made:
//
//  • NOT A FOCUS TRAP, and it must not become one. `CommandPalette`,
//    `AboutPanel` and `UpdateDialog` are modals; this is a non-modal surface
//    over a live workspace — the sessions behind it keep running and stay
//    clickable — so trapping Tab inside it would be an actual 2.1.2 keyboard
//    trap. Escape closes and returns focus; Tab leaves, as it should. There is
//    no scrim for the same reason: nothing behind this is blocked.
//  • The tab is a DISCLOSURE BUTTON — `aria-expanded` carries open/closed and
//    `aria-controls` points at the body, so the name can stay "what this is"
//    instead of flipping between "open" and "close".
//  • Opening MOVES FOCUS into the body, because §5.8's promise is that
//    collapsing chrome never removes capability: a drawer you can open from the
//    keyboard but not then read from the keyboard would remove it. That is not
//    a steal — every route in is explicit (a click, `Mod+E`, or the palette),
//    and `Mod+E` is scope 'app', so it cannot fire out of the composer or a
//    terminal mid-keystroke.
//  • The count and the tint are never the only witness: the accessible name
//    says both in words, and incidents keep their status-bar dot and the
//    `ServiceHealthBanner` besides.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { EventsPanel, EventsPanelProps } from './EventsPanel';
import { badgeLabel, badgeState } from '../lib/events-drawer';
import type { EventDto } from '../model/types';

/**
 * How wide the body is when open.
 *
 * WIDER than the 220px column it replaces, and that is the point rather than an
 * oversight: those 220px were charged to the grid permanently, and these are
 * borrowed from it for as long as you are actually looking. Session titles and
 * task labels ellipsised constantly at 220.
 */
const DRAWER_WIDTH = 300;

/** the tab's own thickness — the ONLY chrome this surface costs while shut */
const TAB_WIDTH = 24;

/**
 * Above the grid and everything it puts over itself (the maximize scrim is 30,
 * its card 31), below every modal (the palette and About are 50, push setup 51,
 * the update dialog 60). The drawer must cover a maximized session — it is
 * reachable from there and the whole workspace is that one card — and must
 * never cover a dialog that is waiting for an answer.
 */
const Z_DRAWER = 40;

/**
 * An event kind's INK, for the count on the tab.
 *
 * Duplicated from `EventsPanel` rather than shared out of a common module, and
 * deliberately: `tokens.drift.test.ts` follows exactly ONE hop from a `color:`
 * to a map — and only within the SAME FILE — so a map imported from elsewhere
 * would take the tint out from under the guard that exists because this very
 * pair of maps was got wrong once (the panel painted every status word in the
 * raw hue, at 1.80:1 on daylight). Five token names is a cheap price for the
 * check staying live in both files, and `Record<EventDto['kind'], string>`
 * means a new kind fails to compile in both rather than being missed in one.
 *
 * `ready` is here for completeness only: reviewed work is not queued, so it can
 * never be the hottest thing waiting.
 */
const BADGE_INK: Record<EventDto['kind'], string> = {
  done: 'var(--status-done-ink)',
  ready: 'var(--faint)',
  'needs-input': 'var(--status-needs-input-ink)',
  'needs-permission': 'var(--status-needs-permission-ink)',
  crashed: 'var(--status-crashed-ink)',
};

/** and the HUE, for the edge — an edge is held to 3:1 and the hue clears it */
const BADGE_HUE: Record<EventDto['kind'], string> = {
  done: 'var(--status-done)',
  ready: 'var(--faint)',
  'needs-input': 'var(--status-needs-input)',
  'needs-permission': 'var(--status-needs-permission)',
  crashed: 'var(--status-crashed)',
};

export interface EventsDrawerProps extends EventsPanelProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** the drawer's own accelerator, already formatted — for the tab's tooltip */
  drawerBinding?: string;
}

export function EventsDrawer(props: EventsDrawerProps): React.JSX.Element {
  const { t } = useTranslation();
  const { open, onOpen, onClose, drawerBinding, ...panel } = props;
  const bodyId = React.useId();
  const body = React.useRef<HTMLDivElement | null>(null);
  const tab = React.useRef<HTMLButtonElement | null>(null);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);

  // The badge reads the QUEUE's view of the feed, not the panel's: the panel
  // lists reviewed work too (the feed is the log), and a tab that counted it
  // would advertise errands Ctrl+Space refuses to take you on.
  const badge = badgeState(panel.queueEvents, panel);
  const name = badgeLabel(badge)
    .map((l) => t(l.key, l.params))
    .join(' · ');
  const tint = badge.hottest ? BADGE_HUE[badge.hottest] : 'var(--border)';

  // ── focus, on the way in and on the way out ─────────────────────────────
  //
  // BOTH HALVES LIVE HERE, keyed off `open`, and that is deliberate rather than
  // tidy: there are FOUR ways this drawer shuts (the tab, Escape, `Mod+E` a
  // second time, and the palette entry), and only two of them go through a
  // handler this component owns. Hanging the restore off the two it does own
  // would leave the other two unmounting a focused body and dropping the
  // keyboard on `<body>` — a dead end you can only leave by Tabbing from the
  // top of the document, which is exactly the capability §5.8 promises
  // collapsing chrome never costs. A state transition is the one thing all four
  // routes have in common.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open) {
      const doc = body.current?.ownerDocument;
      const active = doc?.activeElement as HTMLElement | null;
      // Anchored to whatever had focus when the drawer opened, so the way out
      // can put it back — the palette's route matters most, because there the
      // anchor is the card you were working in rather than the tab.
      //
      // THREE things are not anchors, and each `null` matters:
      //  • `<body>` — the browser's stand-in for "nothing has focus", which is
      //    the state a fresh window is in. Anchoring to it would make the way
      //    out hand focus back to the floor, which is the exact dead end this
      //    effect exists to prevent (and reads as a hand-back in a debugger).
      //  • our own tab — the fallback below already lands there.
      //  • anything inside the body — it is about to be unmounted.
      // The `null` in the else is load-bearing too: opened from the tab after a
      // palette open, a stale anchor would send you back to a card you left
      // three gestures ago rather than to the tab you just pressed.
      returnFocusTo.current =
        active && active !== doc?.body && active !== tab.current && !body.current?.contains(active)
          ? active
          : null;
      body.current?.focus();
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return; // shut, and was already shut — nothing to hand back
    wasOpen.current = false;
    const el = returnFocusTo.current;
    // rAF because the body is still mounted on the frame the close was decided
    // (the palette's lesson).
    requestAnimationFrame(() => {
      const doc = tab.current?.ownerDocument;
      if (!doc) return;
      // ONLY RECLAIM FOCUS OUR UNMOUNT STRANDED. If something else already has
      // it, the user put it there — clicking a terminal to close the drawer by
      // going elsewhere must not be answered by yanking the caret back to a tab
      // they were done with. `<body>` (or nothing) is the signature of focus
      // falling on the floor, and is the only case worth catching.
      if (doc.activeElement && doc.activeElement !== doc.body) return;
      // `isConnected` because the anchor may have been a card that has since
      // been closed — focusing a detached node is a silent no-op that strands
      // focus on `<body>` all over again.
      if (el?.isConnected) el.focus?.();
      else tab.current?.focus();
    });
  }, [open]);


  return (
    <>
      {/* THE TAB. Always rendered, open or shut — it is the one control, and it
          slides in to sit against the body's edge rather than being replaced by
          a second "close" button, so `aria-expanded` describes one thing the
          whole time. Vertically centred on the workspace, which is the one
          place on that edge no strip or bar can ever reach. */}
      <button
        ref={tab}
        type="button"
        data-testid="events-tab"
        data-count={badge.count}
        data-hottest={badge.hottest ?? undefined}
        data-notice={badge.notices > 0 ? 'true' : undefined}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        aria-label={name}
        title={drawerBinding ? `${name} (${drawerBinding})` : name}
        onClick={() => (open ? onClose() : onOpen())}
        style={{
          position: 'absolute',
          insetInlineEnd: open ? DRAWER_WIDTH : 0,
          insetBlockStart: '50%',
          transform: 'translateY(-50%)',
          zIndex: Z_DRAWER,
          inlineSize: TAB_WIDTH,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 5,
          paddingBlock: 12,
          paddingInline: 0,
          background: 'var(--panel)',
          border: `1px solid ${tint}`,
          borderInlineEnd: open ? '1px solid var(--border)' : 'none',
          borderStartStartRadius: 'var(--radius-chip)',
          borderEndStartRadius: 'var(--radius-chip)',
          color: 'var(--muted)',
          cursor: 'pointer',
          fontFamily: 'var(--font-ui)',
        }}
      >
        {/* the count, in the hottest waiting kind's INK — a word takes the ink,
            never the hue (the rule #221 established and #246 wrote down) */}
        {badge.count > 0 && (
          <span
            aria-hidden="true"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 600,
              color: badge.hottest ? BADGE_INK[badge.hottest] : 'var(--muted)',
            }}
          >
            {badge.count}
          </span>
        )}
        {/* the word, turned on its side. `aria-hidden` on both children: the
            button's own label is the whole sentence, and a screen reader
            reading "3" and "Events" separately says less than it does. */}
        <span
          aria-hidden="true"
          style={{
            writingMode: 'vertical-rl',
            textOrientation: 'mixed',
            fontSize: 9,
            letterSpacing: 1.3,
            fontWeight: 600,
            textTransform: 'uppercase',
          }}
        >
          {t('events.eyebrow')}
        </span>
        {/* THE SECONDARY MARKER: a notice is up behind a shut drawer. A dot and
            nothing else on purpose — it is a "there is something here", not a
            second count competing with the first. It is never the only witness:
            the name above says it in words, and #425's incidents keep their
            status-bar dot and the ServiceHealthBanner as well. */}
        {badge.notices > 0 && (
          <span
            aria-hidden="true"
            data-testid="events-tab-notice"
            style={{
              inlineSize: 5,
              blockSize: 5,
              borderRadius: '50%',
              background: 'var(--status-working)',
            }}
          />
        )}
      </button>

      {open && (
        <div
          id={bodyId}
          ref={body}
          data-testid="events-drawer"
          tabIndex={-1}
          // The one key this surface claims. Not a global binding: it fires
          // only while focus is actually inside the drawer, so it can never
          // take Escape away from a dialog or a terminal. It only ASKS to be
          // shut — the focus hand-back is the effect's job, because three other
          // routes shut this thing without ever reaching here.
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onClose();
          }}
          style={{
            position: 'absolute',
            insetInlineEnd: 0,
            insetBlockStart: 0,
            insetBlockEnd: 0,
            inlineSize: DRAWER_WIDTH,
            zIndex: Z_DRAWER,
            display: 'flex',
            background: 'var(--panel)',
            borderInlineStart: '1px solid var(--border)',
            // it is OVER the grid, not beside it — the shadow is what says so.
            // The app's one shadow token rather than a value of its own, so
            // a re-skin retunes this with everything else (and so no raw
            // colour is written here at all).
            boxShadow: 'var(--window-shadow)',
            outline: 'none', // focusable for key handling, not as a control
          }}
        >
          <EventsPanel {...panel} />
        </div>
      )}
    </>
  );
}
