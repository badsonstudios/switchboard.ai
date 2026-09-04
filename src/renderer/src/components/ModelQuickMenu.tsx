// The footer chip's quick-switch menu (#747).
//
// WHAT IT IS FOR. `ModelPickerDialog` gained commit semantics in #746 — click a
// row, then press OK — which made a deliberate change safe and made the fast
// path slower. This is the express lane the owner asked for alongside it: click
// the model name in the session footer, click a model, done. No OK, no
// confirmation, Escape and click-away just close.
//
// It is NOT a second model picker. The rows, their subtitles and the
// one-row-is-ticked arithmetic all come from `lib/model-choices.ts`, which is
// the dialog's own code moved rather than copied — `currentIndex` in particular
// carries a trap (`default` and `opus[1m]` share a `resolvedModel`) that a
// second hand-written copy would rediscover the hard way.
//
// ── FOUR THINGS THAT LOOK LIKE OMISSIONS AND ARE NOT ─────────────────────────
//
// **1. It never calls `currentModel`.** The tick is the chip's own value, handed
// in as `current`. The footer already knows which model this session is running
// — that is what #746 shipped — so asking main again would be a second answer to
// a question we hold the answer to, and the two could disagree for a frame. A
// menu that ticks something other than the chip it grew out of is a bug report.
//
// **2. Nothing here is optimistic.** The dialog anticipated the switch because
// the footer could not move until the next turn; it can now. `sessions:setModel`
// calls `streamModel.noteSet` synchronously on a successful verdict
// (`main/sessions/ipc.ts`), which pushes `sessions:model`, which is what the
// chip renders. The footer moves on its own, from main's answer, and this
// component never has to guess.
//
// **3. There is no `inFlight` ref, and that is not #746's lesson forgotten.**
// That guard exists because the DIALOG can be closed and reopened while a
// `set_model` is on the wire, which resets the UI state its first guard reads.
// This menu cannot: it unmounts per sitting (the composer renders it only while
// open, so there is no state to survive a close), and while a switch is in
// flight it refuses to close at all — see below. `busy` is therefore the whole
// guard, not half of one.
//
// **4. A SWITCH IN FLIGHT HOLDS THE MENU OPEN.** Escape, click-away and a second
// click all do nothing until the verdict lands. This is the one place the menu
// is deliberately less dismissible than the dialog, and the reason is the
// ticket's own rule: "a `set_model` refusal has no dialog to print in — surface
// the CLI's sentence somewhere honest, don't swallow it". A menu that vanished
// on Escape would have nowhere to put a refusal that arrived a moment later, and
// the session would sit on a model the user thinks they changed. The window is a
// local control round trip — measured in single-digit milliseconds — and its
// worst case is the channel's own ten-second timeout, where a menu still saying
// "switching…" is more honest than one that disappeared.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../shared/ipc/refusal';
import { readModels, type CliModel } from '../../../shared/stream-protocol';
import { currentIndex, failureText, modelLabel, rowSubtitle } from '../lib/model-choices';
import { MENU_EDGE_MARGIN, placeMenu, type MenuPlacement } from '../lib/menu-placement';
import { directionOf } from '../lib/writing-direction';

export interface ModelQuickMenuProps {
  /**
   * The LIVE session this acts on.
   *
   * The composer's own session id, not the focused card's — with popouts and
   * split grids the footer you clicked is not reliably the one the app considers
   * focused. The same discipline `ModelPickerDialog`'s `liveId` carries.
   */
  liveId: string;
  /**
   * What the CHIP says this session is running, or `null` for "not said yet".
   *
   * Passed in rather than fetched: see the header. `null` ticks nothing, which
   * is a real state and not a missing value.
   */
  current: string | null;
  /**
   * The CHIP'S BOX, in PHYSICAL client coordinates — `getBoundingClientRect()`.
   *
   * A box and not a point, unlike the rail's pointer-anchored menu, and the
   * difference is load-bearing twice over:
   *
   * • **RTL.** `placeMenu` mirrors the inline axis, so a menu anchored at the
   *   chip's physical LEFT edge lands its inline-start (right) edge there under
   *   `dir="rtl"` — displaced by the whole width of the chip. Which edge to hand
   *   it depends on the direction, and the direction is only knowable from the
   *   laid-out menu, so the choice is made in the layout effect rather than here.
   * • **Which way it opens.** A point cannot say "below the box, else above it".
   *   With the height we can pick the anchor edge that makes the fit work, so a
   *   card at the bottom of the window opens upward and one at the top opens
   *   downward — and neither covers the chip you just clicked.
   */
  anchor: { x: number; y: number; width: number; height: number };
  /** close and give the chip its focus back; the composer owns both */
  onClose: () => void;
  /**
   * A `set_model` went out / came back.
   *
   * The composer needs this because it owns the OTHER door out of the menu —
   * clicking the chip again — and that door must obey the same rule as Escape
   * and click-away: it is shut while a switch is on the wire, so the refusal
   * this menu may have to print always has somewhere to print it.
   */
  onBusyChange?: (busy: boolean) => void;
}

export function ModelQuickMenu(props: ModelQuickMenuProps): React.JSX.Element {
  const { t } = useTranslation();
  const { liveId, current, anchor, onClose, onBusyChange } = props;
  const menu = React.useRef<HTMLDivElement | null>(null);
  /** the row a `set_model` went out from — where the keyboard goes on a refusal */
  const picked = React.useRef<string | null>(null);
  const [models, setModels] = React.useState<CliModel[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  /** which row's `set_model` is on the wire — the whole double-send guard */
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  /**
   * Where the menu ENDED UP, once measured against the window (#641). Null for
   * exactly one un-painted commit while the natural size is taken.
   */
  const [place, setPlace] = React.useState<MenuPlacement | null>(null);

  // THE LIST, once per sitting. No epoch counter: this component is mounted by
  // the open state itself, so a sitting that ends takes the component with it
  // and a late answer resolves into an instance nobody is looking at. `alive`
  // is kept anyway for the ordinary React reason — a resolved promise writing
  // to a torn-down tree is a no-op, but an explicit one reads better than a
  // silent one.
  React.useEffect(() => {
    let alive = true;
    void window.switchboard.sessions.listModels(liveId).then((raw) => {
      if (!alive) return;
      // `answered` launders a capability REFUSAL into undefined. A refusal's
      // `.ok` is `undefined` — falsy — so reading it unlaundered fails CLOSED
      // and silently, into `reason: undefined`. That guard is load-bearing;
      // `scripts/refusal-truthiness.test.js` caught a live defect in #746 for
      // want of exactly this call.
      const v = answered(raw);
      setLoading(false);
      // A REFUSAL LEAVES THE LIST NULL, not empty: "the CLI would not tell us"
      // and "the CLI has no models" are different facts, and an empty menu with
      // no explanation reads as a broken app.
      if (!v) return setNotice(t('model.failed'));
      if (!v.ok) return setNotice(failureText(v, t));
      setModels(readModels(v.response));
    });
    return () => {
      alive = false;
    };
    // `t` is deliberately out of the deps: its identity changes when the
    // language does (react-i18next re-emits on `languageChanged`), and a re-run
    // would put a SECOND `list_models` on the wire and reset a menu the user is
    // reading. The strings close over `t` inside the callback, which is where
    // they are needed. Same reasoning, and the same footgun, as the dialog's
    // sitting effect.
  }, [liveId]);

  // WHERE IT GOES. A layout effect, not an effect: the position is a fact about
  // laid-out text, and correcting it after a paint is a visible jump.
  React.useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    // The MENU's own direction: `insetInlineStart` resolves against the box it
    // is set on, so that element is the only authority on which edge it counts
    // from. `anchor` is physical whichever way it reads (#642).
    const direction = directionOf(el);
    // `documentElement.clientWidth/Height`, not `window.inner*` — and this is
    // also what makes the menu correct in a POPOUT. A popped-out card's DOM is
    // adopted into another window's document while the JavaScript realm stays
    // the opener's, so the global `window` here is the MAIN window and would
    // place the menu against the wrong viewport entirely.
    const root = el.ownerDocument.documentElement;
    // the NATURAL size: this pass runs before `maxBlockSize` is applied
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    // WHICH EDGE OF THE CHIP `placeMenu` IS GIVEN — see the `anchor` prop.
    //
    // Inline: it wants a point that means "the menu's inline-START edge goes
    // here", and it mirrors the axis itself. Under `rtl` that edge is the
    // chip's RIGHT one.
    const x = direction === 'rtl' ? anchor.x + anchor.width : anchor.x;
    // Block: below the chip when there is room, otherwise its top edge — which
    // `placeMenu` then flips into "the menu's bottom edge lands on the chip",
    // i.e. it opens upward. Choosing the edge here rather than always passing
    // the top is what stops a menu with room below from opening straight over
    // the chip that was just clicked.
    const below = anchor.y + anchor.height;
    const roomBelow = below + size.height <= root.clientHeight - MENU_EDGE_MARGIN;
    setPlace(placeMenu({ x, y: roomBelow ? below : anchor.y }, size, {
      width: root.clientWidth,
      height: root.clientHeight,
    }, { direction }));
    // Re-measured when the CONTENT changes size: the menu is one line tall while
    // loading and five rows tall afterwards, and a placement taken at the first
    // size would leave it hanging off the bottom of the card. `busy` is in the
    // list because the inline "switching…" label widens the row.
  }, [anchor, models, notice, busy]);

  /**
   * Has the keyboard been handed to a row yet?
   *
   * A ref rather than a dependency, because this must happen EXACTLY ONCE. The
   * placement is re-taken when the list arrives (the menu is one line tall
   * while loading and five rows tall afterwards), and re-running the focus on
   * every re-measure would yank the keyboard back to the top row while the user
   * is arrowing down it.
   */
  const focused = React.useRef(false);

  // A menu you can open with the keyboard and not walk is worse than no menu.
  // Gated on the placement for the same reason the rail's is: focusing an item
  // still hanging off the window edge is the scroll-jump this is avoiding.
  React.useLayoutEffect(() => {
    if (!place || focused.current) return;
    const box = menu.current;
    if (!box) return;
    const first = box.querySelector<HTMLElement>('[role^="menuitem"]');
    // THE BOX IS THE FALLBACK, not "nothing". A list that REFUSED never grows a
    // row, so waiting for one leaves the keyboard on the chip behind a
    // full-viewport scrim — and Escape, which is handled on this box, would
    // never reach it. The menu would then be dismissable by mouse only.
    // `focused` is only latched once a ROW has it, so the handoff still happens
    // if the rows arrive a moment later.
    if (first) focused.current = true;
    (first ?? box).focus();
  }, [place, models]);

  // A `set_model` DISABLES every row, and Chromium blurs a focused element the
  // moment it becomes disabled — to `<body>`, which is outside this box, so the
  // keydown handler below stops seeing anything at all. Escape would be dead
  // for the rest of the sitting. Park the keyboard on the box while the switch
  // is out, and hand it back to the row that sent it if the CLI refuses (on
  // success the menu closes and the composer restores focus to the chip).
  //
  // jsdom does not blur on disable, so no test in this tree can observe the
  // symptom; the effect is written from the browser's behaviour, not from a
  // failing test, and that is said out loud rather than left to look untested.
  React.useLayoutEffect(() => {
    const box = menu.current;
    if (!box) return;
    if (busy) return void box.focus();
    const back = picked.current;
    if (!back) return;
    picked.current = null;
    // Found by walking, not by interpolating into a selector: a model VALUE is
    // the CLI's string, not ours, and two of the five in the captured payload
    // carry brackets (`opus[1m]`). `CSS.escape` is the other answer and the
    // rail rejected it for this same lookup — "a lot of ceremony for one" — and
    // it is not defined in every realm this tree renders in.
    Array.from(box.querySelectorAll<HTMLElement>('[data-model]'))
      .find((el) => el.dataset.model === back)
      ?.focus();
  }, [busy]);

  // A menu placed ONCE against a window that then resizes is a menu in the
  // wrong place — and under `rtl` a `position: fixed` box is anchored to the
  // right edge, so dragging the window walks it across the screen. The rail
  // dismisses for exactly this reason and so does this. `defaultView`, not the
  // global `window`: in a popout they are different windows, and the one that
  // resizes is the popout's.
  // No dep array on purpose: `close` closes over `busy`, and a listener pinned
  // to the first render would let a resize dismiss a menu with a switch on the
  // wire — the one thing the rule below forbids. Re-subscribing per render is
  // one add/remove on an element that lives for a few seconds.
  React.useEffect(() => {
    const view = menu.current?.ownerDocument.defaultView;
    if (!view) return;
    const go = (): void => close();
    view.addEventListener('resize', go);
    return () => view.removeEventListener('resize', go);
  });

  /** Closing is refused while a switch is on the wire — see the header, note 4. */
  const close = (): void => {
    if (busy) return;
    onClose();
  };

  /**
   * ONE CLICK IS THE WHOLE INTERACTION. No staging, no OK — that is the dialog's
   * job and the reason this exists.
   *
   * The row you clicked is not necessarily one you can act on: clicking the
   * model the session already runs would put a no-op `set_model` on the wire and
   * close the menu as if something had happened.
   */
  const pick = (m: CliModel, isCurrent: boolean): void => {
    // BELT TO `disabled`'s BRACES, and stated rather than assumed: what actually
    // stops a second click reaching the wire is `disabled={busy !== null}` on
    // every row, which React honours by not dispatching to a disabled form
    // control at all. This line is therefore unreachable today and cannot be
    // mutation-tested — verified, not guessed: removing it leaves the suite
    // green, and it is the disabled wiring that the in-flight test really pins.
    // It stays because the day someone drops `disabled` for a styling reason,
    // the double-send comes back silently and this is the only thing left.
    if (busy) return;
    // Clicking what it already runs is a dismissal, not a switch: the user
    // pointed at the answer they already had. Closing says "yes, that one"
    // without claiming a change we did not make.
    if (isCurrent) return onClose();
    picked.current = m.value;
    setBusy(m.value);
    // The composer's chip is the OTHER way out of this menu and it is not ours
    // to disable — telling it is what makes "no door closes while a switch is
    // on the wire" true of all three doors instead of two.
    onBusyChange?.(true);
    setNotice(null);
    void window.switchboard.sessions
      .setModel(liveId, m.value)
      .then((raw) => {
        const v = answered(raw);
        setBusy(null);
        onBusyChange?.(false);
        // A REFUSAL KEEPS THE MENU OPEN carrying the CLI's own sentence, and
        // moves nothing — the session is untouched, and the obvious next
        // actions (try another, give up) are all still in front of the user.
        if (!v) return setNotice(t('model.failed'));
        if (!v.ok) return setNotice(failureText(v, t));
        // Success just closes. Nothing is painted here: the footer chip moves
        // by itself when main's `sessions:model` push lands, and it is the
        // confirmation. See the header, note 2.
        onClose();
      })
      .catch(() => {
        // A REJECTED invoke, not a refusal verdict — the channel itself failed.
        // Without this the menu would sit on "switching…" for ever AND refuse
        // to close, which is the one state worse than losing the message.
        setBusy(null);
        onBusyChange?.(false);
        setNotice(t('model.failed'));
      });
  };

  /** the ONE row the session is RUNNING, resolved once — see `currentIndex` */
  const ticked = currentIndex(models ?? [], current);

  const item: React.CSSProperties = {
    display: 'flex',
    inlineSize: '100%',
    alignItems: 'baseline',
    gap: 8,
    textAlign: 'start',
    padding: '5px 9px',
    border: 'none',
    borderRadius: 6,
    color: 'var(--text)',
    font: 'inherit',
    fontFamily: 'var(--font-ui)',
  };

  return (
    <>
      {/* Click-away, under the menu itself. `pointerdown` rather than `click`,
          the way the rail's does it: a click that starts outside and finishes
          inside should not close, and the composer's textarea must not take
          focus back from under an open menu. */}
      <div
        data-model-menu-scrim
        onPointerDown={(e) => {
          e.preventDefault();
          close();
        }}
        style={{ position: 'fixed', inset: 0, zIndex: 49 }}
      />
      {/* THE OUTER BOX IS NOT THE MENU, and that is an accessibility fix rather
          than nesting for its own sake. `role="menu"` permits only
          menuitem/group/separator children, so the four `<p>`s this can show —
          loading, empty, "not known yet", and the CLI's refusal — sit in a role
          that readers are entitled to prune. The refusal is the whole reason
          this component refuses to close mid-switch, so it losing its
          announcement would undo that design in silence. The rows keep
          `role="menu"` on a wrapper of their own; everything else is a sibling
          of it, in a plain box. */}
      <div
        ref={menu}
        aria-label={t('model.menuLabel')}
        // The switch is out and every row is dead; a reader that lands here
        // mid-flight is told so rather than reading a menu it cannot use.
        aria-busy={busy !== null}
        data-model-menu
        data-testid="model-quick-menu"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // The menu owns its keys while it is open — the composer below it
          // would otherwise see Escape as "clear the draft" and the arrows as
          // caret moves in a textarea the user cannot see.
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
            return;
          }
          // TAB CLOSES IT (APG), the way the rail's menu does. Not preventing
          // the default: the point is that focus carries on out to whatever is
          // next, and what must not happen is this box staying up — with a
          // full-viewport scrim over everything — while the keyboard is
          // somewhere else entirely.
          if (e.key === 'Tab') {
            close();
            return;
          }
          const items = Array.from(
            e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')
          );
          if (items.length === 0) return;
          // `ownerDocument`, NOT the global `document`: in a popped-out card
          // the main document knows nothing about where focus is.
          const at = items.indexOf(e.currentTarget.ownerDocument.activeElement as HTMLElement);
          // Wrapping, because a menu this short is walked in circles and
          // stopping dead at the last row makes the keyboard feel broken.
          // `at` is -1 when focus sits on the menu box rather than a row, which
          // is reachable before the list lands: from there the two arrows mean
          // "first" and "last", not "one along from nowhere".
          const wrap = (n: number): number => (n + items.length) % items.length;
          const next =
            e.key === 'ArrowDown'
              ? at < 0
                ? 0
                : wrap(at + 1)
              : e.key === 'ArrowUp'
                ? at < 0
                  ? items.length - 1
                  : wrap(at - 1)
                : e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? items.length - 1
                    : null;
          if (next === null) return;
          e.preventDefault();
          items[next].focus();
        }}
        style={{
          position: 'fixed',
          insetInlineStart: place ? place.insetInlineStart : 0,
          insetBlockStart: place ? place.insetBlockStart : 0,
          // Not shown until it has been placed. A hidden box still lays out, so
          // the measurement above is unaffected — and if the placement ever
          // failed to land, the menu would be ABSENT rather than sitting in the
          // wrong corner, which is a loud failure instead of a quiet one.
          visibility: place ? undefined : 'hidden',
          maxBlockSize: place?.maxBlockSize,
          overflowY: 'auto',
          zIndex: 50,
          minInlineSize: 190,
          maxInlineSize: 320,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          boxShadow: 'var(--tab-lift)',
          padding: 4,
          color: 'var(--text)',
          fontFamily: 'var(--font-ui)',
          fontSize: 11.5,
          outline: 'none',
        }}
      >
        {loading ? (
          <p style={{ margin: 0, padding: '6px 9px', fontSize: 11, color: 'var(--muted)' }}>
            {t('model.loading')}
          </p>
        ) : models && models.length > 0 ? (
          <div role="menu" aria-label={t('model.menuLabel')}>
            {models.map((m, i) => {
              const on = i === ticked;
              return (
              <button
                key={m.value}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                data-model={m.value}
                data-current={on ? 'yes' : undefined}
                className="model-menu-item"
                disabled={busy !== null}
                onClick={() => pick(m, on)}
                style={{
                  ...item,
                  background: 'transparent',
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                {/* The tick keeps its column whether or not it is drawn, so the
                    labels do not shuffle sideways as the choice moves. A real
                    character rather than a colour: legible without colour
                    vision and in a screenshot, and `aria-checked` carries it
                    for a reader. Ordinary ink — the house rule the drift test
                    enforces is that an accent is a FIELD, and words on one take
                    the neutral ink. */}
                <span aria-hidden style={{ display: 'inline-block', inlineSize: 12 }}>
                  {on ? t('model.currentMark') : ''}
                </span>
                <span style={{ flex: 1, minInlineSize: 0 }}>
                  <span style={{ fontWeight: on ? 700 : 400 }}>{modelLabel(m)}</span>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 10,
                      color: 'var(--muted)',
                      marginBlockStart: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {rowSubtitle(m)}
                  </span>
                </span>
                {busy === m.value && (
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>{t('model.switching')}</span>
                )}
              </button>
              );
            })}
          </div>
        ) : (
          <p style={{ margin: 0, padding: '6px 9px', fontSize: 11, color: 'var(--muted)' }}>
            {models ? t('model.empty') : t('model.unavailable')}
          </p>
        )}

        {/* NOT KNOWN YET, said out loud, and only when there is a list for it to
            qualify. The CLI reports the running model once per TURN, so a
            session that has not replied has genuinely never said — and a menu
            with nothing ticked and no explanation looks broken rather than
            honest. The same sentence the dialog shows, for the same reason. */}
        {!loading && models && models.length > 0 && ticked < 0 && (
          <p
            data-model-menu-unknown
            style={{
              margin: 0,
              padding: '6px 9px',
              marginBlockStart: 2,
              borderBlockStart: '1px solid var(--border)',
              fontSize: 10,
              color: 'var(--faint)',
              whiteSpace: 'normal',
            }}
          >
            {t('model.menuUnknown')}
          </p>
        )}

        {/* MOUNTED EMPTY, ALWAYS. A live region that arrives already holding its
            text is announced by almost nothing — the rule #222 wrote for the
            find bar's match count, and the reason `ComposerAttachments` mounts
            its notice empty too. This one carries the CLI's refusal, which is
            the sentence the whole hold-the-menu-open design exists to deliver,
            so it must not be the one that goes unannounced. The border and
            padding come with the text, so an empty region takes no space. */}
        <p
          data-model-menu-notice
          role="status"
          style={{
            margin: 0,
            padding: notice ? '6px 9px' : 0,
            marginBlockStart: notice ? 2 : 0,
            borderBlockStart: notice ? '1px solid var(--border)' : undefined,
            fontSize: 10.5,
            whiteSpace: 'pre-wrap',
            color: 'var(--status-crashed-ink)',
          }}
        >
          {notice}
        </p>
      </div>
    </>
  );
}
