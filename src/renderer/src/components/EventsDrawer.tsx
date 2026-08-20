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
//  • THE NOTICE DOT IS NOT A WITNESS AT ALL for anyone who cannot see it, which
//    is why this drawer keeps its own always-mounted live region. The panel's
//    three `role="status"` regions only announce while they are IN THE DOM, and
//    collapsing by default took them out of it — see `announcement` below.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { EventsPanel, EventsPanelProps } from './EventsPanel';
import { badgeLabel, badgeState } from '../lib/events-drawer';
import { srOnly } from './sr-only';
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
 *
 * ONE TIE, named so it is not a surprise later: dockview's own overlay sits at
 * 40 too (`--dv-overlay-z-index`, theme/dockview-tokens.css). The drawer wins
 * on DOM order today because it is painted after the grid. If a dockview bump
 * ever puts a drag overlay over this, raise the drawer rather than re-deriving
 * the whole ladder — everything above 40 here is a modal and must stay above.
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

export interface EventsDrawerProps extends EventsPanelProps {
  open: boolean;
  onOpen: () => void;
  /** REQUIRED here, though `EventsPanelProps` leaves it optional: the panel can
   *  be mounted in something with no way out to offer, a drawer cannot. */
  onClose: () => void;
  /** the drawer's own accelerator, already formatted — for the tab's tooltip */
  drawerBinding?: string;
}

export function EventsDrawer(props: EventsDrawerProps): React.JSX.Element {
  const { t } = useTranslation();
  // `onClose` comes OUT of `panel` here and goes back in explicitly at the
  // bottom — the panel renders it as the header's ✕ (#556).
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
  // THE EDGE TAKES THE INK, NOT THE HUE, and that is a correction rather than a
  // preference. The `--status-*` hues are one set of values for every theme
  // (`tokens.css`), so on the light themes `--status-done` measures 2.5:1 and
  // `--status-needs-input` about 1.9:1 against `--panel` — under 1.4.11's 3:1
  // for a non-text object that carries meaning. The `-ink` variants are the
  // ones tuned per theme, and `tokens.drift.test.ts` now pins all five of them
  // against `--panel` so this cannot rot back. The rule this seems to bend
  // (#221/#246: a word takes the ink, an edge takes the hue) is about a hue
  // being too loud for text; it never licensed an edge nobody can see.
  const tint = badge.hottest ? BADGE_INK[badge.hottest] : 'var(--border)';

  // ── the notice announcer, and why collapsing needed one ──────────────────
  //
  // All three notice tenants carry `role="status" aria-live="polite"` inside
  // `EventsPanel`, and #314 put them there for a stated reason: both the update
  // notice and the reconnect offer arrive AFTER mount — one off a handshake
  // round-trip, one when a dialog closes — so a screen reader would otherwise
  // never hear either.
  //
  // Collapsing the panel by default silently repealed that. A live region that
  // is NOT IN THE DOM when its news arrives announces nothing, and the tab's
  // `aria-label` growing "· 1 notice" is not a substitute: a button's changing
  // accessible name is not a live region and no assistive tech speaks it unless
  // that button already holds focus. Incidents keep the status-bar dot and the
  // ServiceHealthBanner besides; the other two had no second witness anywhere
  // in the renderer. That is capability removed by collapsing chrome, which is
  // the one thing §5.8 says this reshape may not do.
  //
  // So the drawer keeps a region of its own that is ALWAYS MOUNTED, open or
  // shut. Mounted empty on the first commit and filled later (the FindBar's
  // lesson — text that arrives with the region is not news), and silent while
  // the drawer is OPEN, where the panel's own three regions are on screen doing
  // this properly and would otherwise be talked over.
  const announcement =
    !open && badge.notices > 0
      ? t(drawerBinding ? 'events.drawer.announce' : 'events.drawer.announceNoBinding', {
          count: badge.notices,
          binding: drawerBinding,
        })
      : '';

  // ── focus, on the way in and on the way out ─────────────────────────────
  //
  // BOTH HALVES LIVE HERE, keyed off `open`, and that is deliberate rather than
  // tidy: there are FIVE ways this drawer shuts (the tab, the header's ✕,
  // Escape, `Mod+E` a second time, and the palette entry), and only three of
  // them go through a handler this component owns. Hanging the restore off those
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
    // (the palette's lesson). Cancelled on cleanup so a drawer unmounted inside
    // that frame — a window closing on a shut-and-teardown — cannot come back
    // to move focus in a document that is on its way out.
    const frame = requestAnimationFrame(() => {
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
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // ── Escape, including after the drawer eats its own focus ────────────────
  //
  // On the DOCUMENT, not on the body div, and the target guard below is what
  // keeps that from being a global grab: an Escape aimed at a dialog, a
  // terminal or the composer has that thing as its target and is left alone
  // here, exactly as a handler bound to the body div would leave it alone.
  //
  // What the document buys is the ONE case a bound handler cannot see. Every
  // interesting control in this drawer removes itself when you use it —
  // dismissing a row, taking or refusing an update, answering the reconnect
  // offer — and a focused element that unmounts drops the caret on `<body>`
  // without firing anything we could listen for. From there the body div never
  // receives another key, so Escape would be dead in precisely the state a
  // user reaches by doing the drawer's own work. `document.body` as the target
  // is the signature of that, and nothing else wants Escape while it is true.
  React.useEffect(() => {
    const doc = body.current?.ownerDocument;
    if (!open || !doc) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const target = e.target as Node | null;
      const inside = !!target && !!body.current?.contains(target);
      const stranded = !target || target === doc.body;
      if (!inside && !stranded) return;
      // STOP IT ONLY WHEN IT WAS REALLY OURS. From inside the drawer this is a
      // handled key and nothing above should see it. In the stranded case the
      // key came from nowhere in particular, and swallowing it would make this
      // an invisible tripwire for whoever binds Escape at the app level next —
      // they would find it dead whenever the drawer happened to be open.
      if (inside) e.stopPropagation();
      onClose();
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
  }, [open, onClose]);


  return (
    <>
      {/* Always mounted, open or shut — see `announcement` above. */}
      <div
        role="status"
        aria-live="polite"
        data-testid="events-announcer"
        style={srOnly}
      >
        {announcement}
      </div>

      {/* THE TAB. Always rendered, open or shut — it slides in to sit against
          the body's edge rather than being swapped for something else, so
          `aria-expanded` describes one thing the whole time and its name can
          stay "what this is" instead of flipping between "open" and "close".
          Vertically centred on the workspace, which is the one place on that
          edge no strip or bar can ever reach.

          IT IS NO LONGER THE ONLY CONTROL (#556): the open drawer carries a ✕
          in its header too. That is a second ROUTE, not a second mechanism —
          both call `onClose` — and the tab keeps `aria-expanded` because it is
          still the only thing on screen while the drawer is shut. The owner
          hunted for a way out of the open drawer and found only this tab, which
          reads as a way in; a disclosure control that is off to the side and
          turned on its edge is not where anyone looks for "close". */}
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
          // no global border-box reset in this project (EventsPanel had to add
          // its own for the same reason) — without this the 1px border makes
          // the tab 26px while `insetInlineEnd: DRAWER_WIDTH` assumes 300
          boxSizing: 'border-box',
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
              // the INK, for the reason the edge gives above — and this one
              // matters more, because a 5px dot is the only thing on screen
              // saying a notice is behind a shut drawer
              background: 'var(--status-working-ink)',
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
          // NAMED, because opening MOVES FOCUS HERE. A bare `<div tabIndex=-1>`
          // announces essentially nothing, so a keyboard user who pressed
          // `Mod+E` would get silence and then have to Tab around to find out
          // what they had opened. The `<aside>` inside is a named landmark, but
          // that names the CHILD — the focused element needs its own name.
          //
          // `group` rather than `region`: `region` is a landmark, and a landmark
          // wrapped around the panel's `complementary` one would put two
          // same-named entries in a screen reader's landmark menu for a single
          // surface. `group` names the thing without claiming to be a second
          // place in the document.
          role="group"
          aria-label={t('events.eyebrow')}
          // Escape is handled in the effect above rather than here, for the
          // reason written there: this element stops receiving keys the moment
          // one of its own controls unmounts under the caret.
          style={{
            position: 'absolute',
            insetInlineEnd: 0,
            insetBlockStart: 0,
            insetBlockEnd: 0,
            inlineSize: DRAWER_WIDTH,
            boxSizing: 'border-box', // see the tab's note
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
          {/* `onClose` is destructured out of `panel` above, so it is handed
              down EXPLICITLY here — the drawer's own close, rendered as the ✕
              in the panel's header row (#556). The button asks App the same
              thing the tab and Escape ask, and App answers all five routes by
              flipping the one `open` flag, so no two of them can land in
              different states. */}
          <EventsPanel {...panel} onClose={onClose} />
        </div>
      )}
    </>
  );
}
