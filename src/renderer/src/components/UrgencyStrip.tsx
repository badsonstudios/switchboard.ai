// The urgency strip (P2-E9-04, DESIGN §5.8 — the i3 urgency-hint pattern).
//
// One lamp per session, colored by live status, click to focus. It lives in the
// APP SHELL — above the rail/grid/events row and below the title bar — and that
// placement is the feature, not a detail:
//
//   • the rail can be hidden (E9-01's toggle) and the grid can hide, pop out or
//     collapse a card (§5.8's presentation ladder), so neither of them can be
//     where "every session, always" is shown;
//   • E9-07's layout modes rearrange cards INSIDE the grid, so a strip that
//     sits outside the grid stays visible in every mode by construction rather
//     than by each mode remembering to draw it.
//
// The bar renders even with no sessions: "always-visible" is the contract, and
// one that disappears when the workspace empties is one the user has to learn
// the absence of.
//
// NO OFF SWITCH, deliberately (PHILOSOPHY §4 litmus 4). §5.8 specifies a
// PERSISTENT strip, and E9-07's layout modes are written against "visible
// regardless of layout mode" — a hide toggle would make that guarantee a
// preference. The escape-hatch test is satisfied differently: the strip does
// nothing on your behalf (it is a ~26px readout with no animation and no
// notification), and everything it offers is reachable without it — Ctrl+1..9,
// the rail, the Events panel and the palette all focus a session.
//
// Ordering and lit-ness are lib/urgency's; colors are the theme's; this file
// only paints.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { RailSession } from '../model/types';
import { buildLamps, litCount, nextLitExpiry, UrgencyLamp, UrgencyMarks } from '../lib/urgency';

export function UrgencyStrip(props: {
  /** every session, in rail order — the same order Ctrl+1..9 counts against */
  sessions: readonly RailSession[];
  /** card id -> epoch ms its post-jump highlight expires, or null for one that
   *  has not painted yet and so has no deadline (store state) */
  urgency: UrgencyMarks;
  /** the card the grid is showing, so the strip marks where you are */
  activeCardId: string | null;
  onFocus: (cardId: string) => void;
  /** a lamp's beat has passed — ask the store to put it out. Must be stable:
   *  it is an effect dependency. */
  onExpire: () => void;
  /** these lamps are now ON THE SCREEN — start their beat (#320). Must be
   *  stable, same reason. */
  onBeatStart: (cardIds: readonly string[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  // One render's worth of "now": reading the clock per lamp could put two of
  // them on opposite sides of the same deadline within a single paint. It does
  // make render impure, which is fine here and nowhere near fine in general —
  // this is a readout, so StrictMode's double-invoke differing by a millisecond
  // changes nothing, and the effect below deliberately re-reads the clock.
  const now = Date.now();
  const lamps = buildLamps(props.sessions, props.urgency, now);
  const needing = litCount(lamps);

  // ONE timer for the whole strip, armed at the soonest deadline: the strip has
  // no other reason to re-render when a beat runs out, and polling a clock for
  // a 1.5s highlight would keep the renderer busy forever.
  //
  // It RE-ARMS ITSELF rather than relying on the state write to re-run this
  // effect. `expireUrgency` skips the write when nothing has actually expired,
  // and setTimeout counts on a monotonic clock while the deadlines are wall
  // clock — so one NTP step backwards during a beat would fire the timer early,
  // prune nothing, publish nothing, and leave a lamp lit with no timer left to
  // put it out. Re-arming closes that: worst case it re-checks every ~20ms
  // until the wall clock catches up.
  const { urgency, onExpire, onBeatStart } = props;
  React.useEffect(() => {
    let id: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      const ms = nextLitExpiry(urgency, Date.now());
      if (ms === null) return;
      // +1ms past the deadline: isLit's boundary is strict, so firing ON it
      // would prune nothing. The 20ms floor only applies to a re-arm (a first
      // arm is a whole beat away) and keeps the skew case off a 1ms spin.
      id = setTimeout(() => {
        onExpire();
        // reads the SAME (now stale) map — that is what makes this a retry. A
        // successful prune re-runs the effect, whose cleanup kills this chain.
        arm();
      }, Math.max(ms, 20) + 1);
    };
    arm();
    return () => clearTimeout(id);
  }, [urgency, onExpire]);

  // ── the paint anchor (#320, Dan 2026-08-10) ────────────────────────────────
  //
  // A mark arrives from the jump WITHOUT a deadline (`null`); the beat starts
  // here, once the lit lamp is actually on the screen. Before this, the 1.5s
  // was measured from the keypress, so a machine busy enough to take longer
  // than that between the keydown and the paint drew no lit lamp at all — and
  // §5.8 asks for the beat so a HUMAN can see which session called them, which
  // makes "the pixels existed" the only start that means anything.
  //
  // WHY rAF, and why TWO of them. `useLayoutEffect` is commit-coupled, not
  // paint-coupled: it runs after the DOM is mutated and BEFORE the browser
  // paints, which is the same too-early moment the keypress was. (A passive
  // `useEffect` is no better as an anchor — it usually runs after paint, but
  // React is free to flush it earlier, so it is a probability, not a promise.)
  // The first rAF callback runs at the start of the next frame, still before
  // that frame's pixels; the SECOND runs a frame later, by which time the frame
  // carrying the lit lamp has been painted. So the second callback is the first
  // moment we can honestly say the user could have seen it.
  //
  // It also gets a backgrounded window right for free: rAF does not fire in a
  // window that is not rendering, so a mark made while minimised waits for the
  // window to come back rather than starting a beat nobody can see.
  //
  // A chain in flight is NEVER restarted, which is why this effect keeps its
  // state in a ref instead of in its cleanup. Cancelling and rescheduling on
  // every dependency change reads tidier and is a starvation bug: a held-down
  // jump key writes a new urgency map about every 33ms (Windows auto-repeat)
  // and two frames is 32ms, so the second rAF would be cancelled just short of
  // firing, every time, for as long as the key was down — every lamp lit and no
  // beat ever started. Letting the chain run to completion instead costs
  // nothing: when it lands, its state write re-runs this effect, and anything
  // that went pending underneath it is scheduled then.
  //
  // (This effect runs BEFORE the timer effect above on every commit — React
  // flushes all layout effects ahead of any passive one — despite reading
  // second.)
  //
  // ── and the landing has to be able to re-run this effect (#426) ────────────
  //
  // Since the pending cap, a mark can be SUPERSEDED while its chain is in the
  // air: `markLit` keeps only the newest unpainted mark, so the ids this effect
  // captured may be gone by the time the second frame arrives. `onBeatStart`
  // then writes nothing — `startBeat` has nothing to start — and without a
  // state write this effect never re-runs, so the mark that replaced them would
  // sit lit with no chain to give it a beat and no timer to end it: a lamp lit
  // forever, in exactly the popout case the cap exists for. `landings` is the
  // nudge. It is bumped ONLY when the map moved under the chain, because when
  // it did not the landing drains everything it captured and the resulting
  // state write re-runs us — bumping there too would be a rAF spin.
  const chain = React.useRef<{ outer: number; inner: number } | null>(null);
  const committed = React.useRef(urgency);
  const [landings, chainLanded] = React.useReducer((n: number) => n + 1, 0);
  React.useLayoutEffect(() => {
    committed.current = urgency;
    if (chain.current) return;
    // Every mark still waiting on a paint, including any whose card has no lamp
    // in this render: the strip HAS painted, and a mark with nothing to draw has
    // nothing to wait for. Skipping those would leave an entry no timer can ever
    // expire, because nextLitExpiry ignores the unpainted.
    const waiting: string[] = [];
    for (const [id, until] of urgency) if (until === null) waiting.push(id);
    if (waiting.length === 0) return;
    // fail-open (§4): no rAF means no paint signal at all, and a lamp lit
    // forever is a worse readout than one whose beat starts a frame early
    if (typeof requestAnimationFrame !== 'function') {
      onBeatStart(waiting);
      return;
    }
    // `waiting` is deliberately the ids as of THIS commit and not re-read when
    // the chain lands: these are the ones the frame below is about to paint. A
    // mark that arrives underneath the chain has not been through a paint yet,
    // so it gets its own chain on the re-run rather than riding this one.
    const ids = { outer: 0, inner: 0 };
    chain.current = ids;
    ids.outer = requestAnimationFrame(() => {
      ids.inner = requestAnimationFrame(() => {
        // cleared FIRST: the call below re-runs this effect, which must be free
        // to schedule the next chain for whatever went pending in the meantime
        chain.current = null;
        onBeatStart(waiting);
        // the map moved under us: some of `waiting` may no longer exist, so the
        // call above may have written nothing. Re-run rather than assume it did.
        // Map IDENTITY is a proxy for "an unpainted mark may be left without a
        // chain" and over-fires — an expiry landing inside the same two frames
        // also trips it — which is the direction to be wrong in: over-firing
        // costs one render of a readout, under-firing costs a lamp lit forever.
        if (committed.current !== urgency) chainLanded();
      });
    });
  }, [urgency, onBeatStart, landings]);

  // Unmount only — the chain above deliberately outlives a re-render, so this
  // is the one place it is right to cancel.
  React.useEffect(() => {
    return () => {
      if (!chain.current) return;
      cancelAnimationFrame(chain.current.outer);
      cancelAnimationFrame(chain.current.inner);
      chain.current = null;
    };
  }, []);

  return (
    <div
      data-testid="urgency-strip"
      // NOT role="toolbar": that promises one tab stop with arrow-key
      // navigation, and the lamps are ordinary buttons. A group keeps each lamp
      // individually reachable and honest about what it is.
      //
      // #197's sweep left this alone on purpose. The lamps were already the
      // shape the sweep exists to produce — real buttons, each with the rail's
      // own words for its state — so all they were missing was a focus ring
      // (tokens.css) and "you are here" (aria-current, below).
      role="group"
      aria-label={t('urgency.label')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingInline: 8,
        paddingBlock: 3,
        // never give up height (#274): "always visible" is this strip's whole
        // contract, and the shell column squeezes its auto-basis children first
        flexShrink: 0,
        minBlockSize: 24,
        background: 'var(--panel2)',
        borderBlockEnd: '1px solid var(--border)',
      }}
    >
      {/* the lamps scroll, the summary does not — otherwise "2 need you"
          scrolls off the right edge exactly when it starts to matter */}
      <div
        style={{
          flex: 1,
          minInlineSize: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          overflowX: 'auto',
        }}
      >
        {lamps.map((l) => (
          <Lamp
            key={l.cardId}
            lamp={l}
            active={l.cardId === props.activeCardId}
            onFocus={props.onFocus}
            t={t}
          />
        ))}
      </div>
      <span
        data-testid="urgency-count"
        data-needing={needing}
        style={{
          flex: '0 0 auto',
          fontSize: 10,
          whiteSpace: 'nowrap',
          color: needing > 0 ? 'var(--status-needs-input-ink)' : 'var(--muted)',
        }}
      >
        {needing > 0 ? t('urgency.needYou', { n: needing }) : t('urgency.calm')}
      </span>
    </div>
  );
}

function Lamp(props: {
  lamp: UrgencyLamp;
  active: boolean;
  onFocus: (cardId: string) => void;
  /** passed down rather than re-subscribed per lamp */
  t: TFunction;
}): React.JSX.Element {
  const l = props.lamp;
  // The state text is the RAIL's — one vocabulary, so a lamp's tooltip and its
  // rail row can never describe the same session differently
  const label = props.t('urgency.lampTitle', { title: l.title, state: props.t(l.labelKey) });
  return (
    <button
      type="button"
      className="urgency-lamp"
      // four independent facts, four attributes: which card, what state it is
      // in, whether a human is needed, and whether it is the one the last jump
      // landed on. Folding them together would make the CSS — and the e2e
      // assertions — guess.
      data-urgency-lamp={l.cardId}
      data-status={l.token}
      data-needs-you={l.needsYou}
      data-suspended={l.suspended}
      data-lit={l.lit}
      data-active={props.active}
      title={label}
      aria-label={label}
      // "you are here" (#197). `data-active` already carried it for the eye and
      // for the e2e assertions; aria-current is the same fact for a screen
      // reader, which otherwise hears N identically-shaped buttons.
      aria-current={props.active ? 'true' : undefined}
      onClick={() => props.onFocus(l.cardId)}
      // the two values the stylesheet cannot know statically. Everything else
      // about the lamp's look is in tokens.css, keyed off the attributes above
      // — an inline background would beat the :hover rule on specificity.
      style={
        {
          '--lamp-hue': `var(--status-${l.token})`,
          '--lamp-ink': `var(--status-${l.token}-ink)`,
        } as React.CSSProperties
      }
    >
      <span aria-hidden className="urgency-dot" />
      <span className="urgency-name">{l.title}</span>
    </button>
  );
}
