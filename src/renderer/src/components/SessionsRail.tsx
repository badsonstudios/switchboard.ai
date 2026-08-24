// The sessions rail (design_handoff_sessions_rail, §5.8/§5.11/§5.13).
//
// The left panel: every live session, organized into user-made groups. Two
// questions have to be answerable at a glance — which group is a session in,
// and which sessions need me right now — and the whole visual budget is spent
// on those two.
//
// Three deliberate rules from the approved design, none of which should be
// softened without going back to it:
//
//  1. Sessions have NO icon. Earlier rounds tried folder icons, language
//     glyphs, monograms, provider marks and identicons; all read as noise. The
//     colored left edge bar IS the identity mark, so every session name starts
//     at one flush left margin and the NAME becomes the thing you scan.
//     Groups DO get a folder icon — the group glyph and the session rows must
//     read as different kinds of thing.
//     This is the rule #337 was filed against, and the rule WON: `IdentityChip`
//     (a dot + a badge in front of the name) is exactly the composition the
//     handoff forbids here, so the chip's docstring stopped claiming the rail
//     as a consumer instead of the rail growing a chip. Do not "finish" the
//     adoption — see IdentityChip.tsx's header for the quoted paragraph.
//  2. A session that needs you is loud: status-tinted row, 4px status-colored
//     bar, name at 700, and its sub-label replaced by what it is actually
//     asking for. Calm sessions stay plain. The contrast is the point.
//  3. The working ring is the ONLY animation. Blinking status dots were an
//     explicit rejection.
//
// KEYBOARD & SCREEN READER (#197, §5.32), following #174's rule:
//
// A rail row CONTAINS controls — the ✕, and (on a group header) the recolor
// dot and three action buttons. So neither `role="option"` nor a `<button>`
// wrapper is available for the row itself: both take presentational children,
// which is the same ARIA lie #174 was filed over. What every row gets instead
// is a REAL button on the thing it is (`rail-row-open` over the name block,
// `rail-head-toggle` over the group's NAME — the chevron beside it stays an
// 8px decoration, and `aria-expanded` is the fact it was drawing), with the row div kept
// as a plain, role-less mouse convenience that duplicates it. Enter and Space
// then come from the platform, and the focus ring in tokens.css makes the
// keyboard path visible.
//
// The right-click menu is part of that path, not an extra: `contextmenu` is
// what the ContextMenu key and Shift+F10 fire, so a focusable row can already
// summon it — which is exactly why the menu below is operable (roving arrows,
// Escape, focus restored to the row) rather than a wall of divs a keyboard
// could open and then be stuck inside.
//
// #559 adds the second interaction of that shape, and answers it the same way:
// a session can now be dragged UP AND DOWN inside its own group, so the same
// menu grew `Move up` / `Move down`. They are COMMANDS and not radios because
// the choice is a step, not a destination out of a known set — and they are
// `aria-disabled` rather than absent at the ends of a group, so the arrow walk
// never finds a hole where an item used to be. The order they write lives in
// the workspace store (lib/rail-order), which also holds the decision about
// what happens when an arrangement meets a pin: the pin wins.
//
// It is also where the sweep's ONE remaining gap was closed (#253). Moving a
// session between groups was drag-only — an interaction with no keyboard
// equivalent at all, which is WCAG 2.1.1 for the whole feature and not a
// labelling detail. The fix is a `Move to group` radio set in that same menu:
// one choice out of a known set, walked by the arrows already here, committing
// through the SAME `onMoveToGroup` prop the drop handler calls. See the section
// near the bottom of this file for why it is radios and not a submenu.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { RailGroup, RailSession } from '../model/types';
import { railOrder } from '../lib/groups';
import { canStep, LOOSE_BUCKET, ManualOrder, planReorder } from '../lib/rail-order';
import {
  presentStatus,
  needCount,
  clampRailWidth,
  railWidthAtPointer,
  RAIL_WIDTH_DEFAULT,
} from '../lib/rail-view';
import { uiGet, uiSet } from '../lib/ui-state';
import { getDraggedCard, setDraggedCard } from '../lib/drag-context';
import { MenuPlacement, placeMenu } from '../lib/menu-placement';
import { directionOf } from '../lib/writing-direction';
import {
  cardOverride,
  groupOverride,
  POLICY_ORDER,
  PolicyBook,
  PresentationPolicy,
  resolvePolicy,
} from '../lib/presentation-policy';
import {
  FOCUS_POLICY_ORDER,
  FocusBook,
  FocusPolicy,
  focusOverride,
  resolveFocusPolicy,
} from '../lib/focus-policy';
import { srOnly } from './sr-only';

export type { RailSession, RailGroup } from '../model/types';

const DND_TYPE = 'application/x-switchboard-card';

/** Tint helper: the group and accent colors are runtime DATA (user-picked from
 *  the stored palette), so they can't be tokens — color-mix keeps the alpha
 *  compositing in CSS instead of hand-rolling rgba in TS (§5.20). */
const tint = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/**
 * A group key made safe to put in an `id` (#197). An auto-group's key is a
 * FOLDER PATH — `auto:C:\Projects\x` — and an IDREF list is space-separated, so
 * a raw key would break `aria-controls` on exactly the cards that have one.
 * The escape is reversible (every non-token character becomes `_<hex>_`), so
 * two different groups can never be handed the same id.
 */
const bodyKey = (key: string): string =>
  key.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);

/** A context-menu row. Shared because the commands and the policy radios are
 *  the same row in two roles, and they used to drift a property at a time. */
const menuItemStyle: React.CSSProperties = {
  display: 'block',
  inlineSize: '100%',
  padding: '5px 9px',
  borderRadius: 4,
  border: 'none',
  // background deliberately NOT set here: `.rail-menu-item` owns it, so the
  // hover and focus fills in tokens.css are not outranked by an inline value
  cursor: 'pointer',
  color: 'var(--text)',
  whiteSpace: 'nowrap',
  textAlign: 'start',
  fontSize: 11,
  fontFamily: 'var(--font-ui)',
};

/** The eyebrow over a group of menu rows. Shared for the same reason the row
 *  style is: there are two of these sections now (#253) and a heading that
 *  drifts a property from its neighbour reads as an accident. */
const menuSectionStyle: React.CSSProperties = {
  marginBlockStart: 4,
  paddingBlock: '4px 2px',
  paddingInline: 9,
  borderBlockStart: '1px solid var(--border)',
  color: 'var(--faint)',
  fontSize: 9.5,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

/* The rail's live region is invisible rather than absent (#253). The
   declarations moved to `./sr-only` when P2-E14-01 became the third copy, which
   is what #367 said would happen. */

/**
 * One per-session OVERRIDE choice in the rail's context menu: a labelled radio
 * set of named values, with "follow the default" as its first and always-present
 * member.
 *
 * Shared by E9-06's presentation policy and E9-10's focus-stealing policy —
 * they are the same widget asking about two different settings, and writing the
 * second one out again is how the two would have drifted an aria attribute at a
 * time. Named values rather than one cycling row, because a menu closes when
 * you click it: a cycle would cost a right-click per step, and the point of an
 * override is to SAY what you want, not to walk past it.
 *
 * "Follow the default" is `undefined`, never the value the default happens to
 * hold today — otherwise leaving an override would silently pin the session to
 * whatever the global said at that moment.
 */
function OverrideGroup<T extends string>(props: {
  /** the group's heading, and its accessible name */
  label: string;
  values: readonly T[];
  /** this session's own override, or undefined for "follow the default" */
  own: T | undefined;
  /** the e2e handle, e.g. `data-policy-item`; the value is the mode or 'default' */
  itemAttr: string;
  itemStyle: React.CSSProperties;
  labelOf: (value: T) => string;
  /** already composed, because what "the default" resolves to differs per
   *  setting (the presentation policy has a group level in between) */
  defaultLabel: string;
  onPick: (value: T | undefined) => void;
}): React.JSX.Element {
  return (
    <div role="group" aria-label={props.label}>
      <div
        aria-hidden
        style={{
          marginBlockStart: 4,
          paddingBlock: '4px 2px',
          paddingInline: 9,
          borderBlockStart: '1px solid var(--border)',
          color: 'var(--faint)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        {props.label}
      </div>
      {[undefined, ...props.values].map((value) => {
        const chosen = props.own === value;
        return (
          <button
            key={value ?? 'default'}
            type="button"
            role="menuitemradio"
            aria-checked={chosen}
            {...{ [props.itemAttr]: value ?? 'default' }}
            className="rail-menu-item"
            onClick={() => props.onPick(value)}
            style={{ ...props.itemStyle, fontWeight: chosen ? 700 : 400 }}
          >
            {/* the tick keeps its column whether or not it is drawn, so the
                labels do not shuffle sideways as the choice moves */}
            <span aria-hidden style={{ display: 'inline-block', inlineSize: 12 }}>
              {chosen ? '✓' : ''}
            </span>
            {value ? props.labelOf(value) : props.defaultLabel}
          </button>
        );
      })}
    </div>
  );
}

export function SessionsRail(props: {
  sessions: readonly RailSession[];
  groups: readonly RailGroup[];
  /**
   * The cards with an outstanding demand — what the group summaries and the
   * footer count (#621). The store's `getNeedingCards()`, so the rail, the
   * urgency strip and the Events window are three views of one derivation.
   *
   * REQUIRED, and deliberately not defaulted to "every needy status": a mount
   * that forgot it would silently go back to counting statuses, which is the
   * bug — the counters would ignore dismissal again and nothing would fail.
   */
  needing: ReadonlySet<string>;
  onRename: (id: string, title: string) => void;
  onFocus: (id: string) => void;
  onDiff: (s: RailSession) => void;
  /** end a session from the row ✕ / context menu (confirms — it forgets the record) */
  onClose: (id: string) => void;
  /** the card the grid is currently showing, for the selected-row tint */
  selectedId?: string | null;
  /** palette for the recolor cycle — persisted data owned by the main process */
  palette: string[];
  onCreateGroup: (name: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRecolorGroup: (id: string, color: string) => void;
  onDeleteGroup: (id: string) => void;
  /** open a NEW session inside this group (E12-03) */
  onOpenInGroup: (id: string) => void;
  /** move a session between groups / to ungrouped (E12-04, rail DnD) */
  onMoveToGroup: (cardId: string, groupId: string | null) => void;
  /**
   * §5.8's presentation policy and its overrides (E9-06).
   *
   * The rail is where the per-SESSION and per-GROUP overrides belong, because it
   * is the only surface that lists both — the override sits next to the thing it
   * overrides, while the global default is a titlebar chip.
   */
  policies: PolicyBook;
  /** `undefined` clears the override and follows the default again */
  onSetSessionPolicy: (cardId: string, policy: PresentationPolicy | undefined) => void;
  onCycleGroupPolicy: (groupId: string) => void;
  /**
   * §5.8's focus-stealing policy and its per-session overrides (E9-10).
   *
   * Here for the reason the presentation override is: the override belongs
   * beside the row it governs. There is no group level — §5.8 specifies "a
   * global setting with per-session override" for this one, and no more.
   */
  focusPolicies: FocusBook;
  /** `undefined` clears the override and follows the default again */
  onSetSessionFocusPolicy: (cardId: string, policy: FocusPolicy | undefined) => void;
  /**
   * §5.8's pinning contract (E9-09) — the pinned CARD ids.
   *
   * The rail is where pinning belongs for the reason the policy overrides are
   * here: it is the surface the guarantee is ABOUT ("sorts first in the rail"),
   * so the control and its effect are one place apart.
   */
  pinned: ReadonlySet<string>;
  /** pin or unpin one session — one gesture, both ways (§5.8) */
  onTogglePin: (cardId: string) => void;
  /**
   * The order the user arranged each group into by hand (#559).
   *
   * A prop and not a store read for the reason `pinned` is one: the rail is a
   * pure function of what it is handed, so a test can arrange a workspace
   * without a store and the popped-out copies of this component cannot drift
   * from the main window's.
   */
  manualOrder: ManualOrder;
  /** the whole of one group's new order, after a drag or a Move up/down */
  onReorder: (bucketKey: string, orderedIds: string[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [editingGroup, setEditingGroup] = React.useState<string | null>(null);
  const [groupDraft, setGroupDraft] = React.useState('');
  // right-click menu: the design's clean row has no room for a diff link, so
  // the affordance moves here (README lists the context menu as implied but
  // not mocked). Anchored in viewport coords — it renders position:fixed.
  const [menu, setMenu] = React.useState<{ session: RailSession; x: number; y: number } | null>(
    null
  );
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  // Where the menu ENDED UP, once it has been measured against the window
  // (#641). `menu.x/y` stays the request; this is the answer, and it is null
  // for exactly one un-painted commit while the natural size is measured.
  const [menuPlace, setMenuPlace] = React.useState<MenuPlacement | null>(null);
  // where focus goes when the menu closes: the control that opened it. A ref
  // rather than menu state, so closing can restore focus WITHOUT doing it from
  // inside a setState updater — StrictMode invokes updaters twice, and an
  // updater that moves focus is not a pure function (same call the rail already
  // makes for the resize width).
  const menuAnchor = React.useRef<HTMLElement | null>(null);
  // collapsed group ids — persisted UI state (E12-08; localStorage resets
  // per launch in packaged builds because the loopback origin's port churns)
  const [collapsed, setCollapsed] = React.useState<Set<string>>(
    () => new Set(uiGet<string[]>('railCollapsed', []))
  );
  const [width, setWidth] = React.useState<number>(() =>
    clampRailWidth(uiGet<number>('railWidth', RAIL_WIDTH_DEFAULT))
  );
  const [dragging, setDragging] = React.useState(false);
  // the group card a drag is currently hovering — highlighted so "this is
  // where it lands" is answerable before you let go
  const [dropTarget, setDropTarget] = React.useState<string | null>(null);
  // #559: which row a rail drag started on. A REF and not state — nothing
  // re-renders because of it, and a dragover handler has to read what is true
  // now. `getDraggedCard()` is the dockview half of the same question and is
  // consulted beside it, exactly as the group card's handlers do.
  const dragCard = React.useRef<string | null>(null);
  // #559: where the insertion line is drawn — the row it is against and which
  // side. Anchored to a ROW rather than to an index so the line survives the
  // list changing under a slow drag; the index is recomputed from the live
  // bucket at both dragover and drop, from one function, so the line and the
  // landing can never disagree.
  const [dropAt, setDropAt] = React.useState<{
    bucket: string;
    rowId: string;
    edge: 'before' | 'after';
  } | null>(null);
  // the live width, so pointerup can persist what is actually on screen. A ref
  // rather than a read inside a setState updater: StrictMode invokes updaters
  // twice, and an updater that writes to disk is not a pure function.
  const widthRef = React.useRef(width);
  // The rail's own element, so the effects below query WITHIN it and from ITS
  // document. #197's blocker was a `document.activeElement` read that answered
  // for the wrong window; a container ref makes that class of bug unavailable.
  const navRef = React.useRef<HTMLElement | null>(null);
  // The scroll container itself (#295) — the one box `keepClearOfPins` may move.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  /**
   * #295, decision 4: a row may not be focused UNDERNEATH a stuck pinned block.
   *
   * Focusing an element inside a scroll container scrolls it into view, and the
   * browser's idea of "in view" is the SCROLLPORT — which is exactly where a
   * `position: sticky` block is parked. So Tab (and `scrollIntoView` from the
   * palette, and a click that lands mid-scroll) would walk the keyboard into
   * rows hidden behind the pins: focused, operable, invisible. That is WCAG
   * 2.4.11's "focus not obscured" and it is created by the sticky block, so it
   * is fixed here rather than left for the next reader to discover.
   *
   * It does it with `scroll-padding-block-start`, the property that exists for
   * precisely this ("the top N pixels of my scrollport are furniture") - set on
   * the CONTAINER, from the measured height of the block belonging to the
   * focused row's own bucket, and then one explicit `scrollIntoView`.
   *
   * Both halves earn their place. The arithmetic version this replaced
   * (`scrollTop -= overhang`) fixes the position but tells the ENGINE nothing,
   * and Blink runs its own scroll-into-view pass AFTER `focusin` - so on a short
   * rail, where the row is taller than the gap below the block, the browser
   * would put it straight back under. With the padding set, that later pass
   * agrees with us instead of fighting; the explicit call is what makes it a
   * no-op rather than a correction the user watches happen. And the padding is
   * read at the one moment it matters, so no ResizeObserver has to keep a stale
   * copy of a height in sync.
   *
   * It measures the ROW, not the focused button: the button is inset by the
   * row's 8px padding and the status edge bar sits outside it, so aligning the
   * button leaves the top of the row still behind the block.
   *
   * Two guards keep it inert where it should be: a target inside the block is
   * already visible, and no block means nothing to clear - the padding goes back
   * to 0 in that case, so a bucket without pins never inherits another one's
   * offset. jsdom has no layout, so every rect is zero and this is a no-op
   * there, which is why the e2e case is the test that means anything.
   */
  const keepClearOfPins = (e: React.FocusEvent<HTMLDivElement>): void => {
    const scroll = scrollRef.current;
    const target = e.target as HTMLElement;
    if (!scroll || typeof target.closest !== 'function') return;
    const block = target
      .closest('[data-rail-body]')
      ?.querySelector<HTMLElement>('[data-pinned-block]');
    if (block?.contains(target)) return;
    // The block's OVERHANG below the top of the scrollport, not the block's own
    // height: `.rail-scroll` has 10px of padding and Chromium insets a sticky
    // box by its scroll container's padding, so a stuck block's bottom edge is
    // `port.top + padding + height`. Passing the bare height left every focused
    // row exactly one padding behind the block - close enough to look right and
    // wrong enough to fail, which is how the e2e found it. Measuring the gap
    // that actually exists needs no arithmetic about padding at all.
    scroll.style.scrollPaddingBlockStart = block
      ? `${Math.max(0, Math.ceil(block.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top))}px`
      : '0px';
    if (!block) return;
    (target.closest<HTMLElement>('.rail-row') ?? target).scrollIntoView({ block: 'nearest' });
  };
  // #253: what the last keyboard-driven move should say, once it has actually
  // happened. Empty until then — the region itself is always in the DOM.
  const [moveSaid, setMoveSaid] = React.useState('');
  // A move the MENU started, held until the store agrees it landed. It cannot
  // be finished synchronously: `onMoveToGroup` is a round trip through IPC, and
  // the row is re-parented into a different group card when the answer comes
  // back — so the button this menu was opened from is a detached node by then,
  // and focusing it would strand the keyboard on <body>.
  const pendingMove = React.useRef<{
    cardId: string;
    to: string | null;
    /** the destination card's key, for when the row itself can't take focus */
    destKey: string;
    said: string;
  } | null>(null);
  /**
   * A PIN the menu started, held for the same reason `pendingMove` is (#295).
   *
   * Pinning used to be safe to restore focus from synchronously — the sort only
   * reordered siblings under one parent, so the button the menu was opened from
   * survived it. #295 changed that: a bucket's pinned rows now live in their own
   * sticky block, and a child that changes PARENT ELEMENT cannot reuse its
   * fiber, so React unmounts and remounts the row. `menuAnchor.current` is a
   * detached node by the time the store answers, and focusing it strands the
   * keyboard on <body> — which is exactly what the menu item's comment promises
   * does not happen.
   *
   * `undefined` here means "no pin in flight"; the boolean is the state we are
   * waiting for the store to agree with, so a pin somebody else took first
   * settles the errand rather than leaving it open.
   */
  const pendingPin = React.useRef<{ cardId: string; want: boolean } | null>(null);

  const toggleCollapsed = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      uiSet('railCollapsed', [...next]);
      return next;
    });
  };

  // one window-level listener per drag, so the pointer can leave the 4px edge
  // (and the rail) without the resize sticking to it
  React.useEffect(() => {
    if (!dragging) return;
    // Read ONCE per drag, not per move: both are style/layout reads, and doing
    // them inside a handler that also writes a width is how you thrash. Neither
    // can change mid-gesture without a resize, which ends this drag anyway.
    const nav = navRef.current;
    const direction = nav ? directionOf(nav) : 'ltr';
    const viewportWidth = nav?.ownerDocument.documentElement.clientWidth ?? 0;
    const onMove = (e: PointerEvent): void => {
      widthRef.current = railWidthAtPointer(e.clientX, viewportWidth, direction);
      setWidth(widthRef.current);
    };
    const onUp = (): void => {
      setDragging(false);
      uiSet('railWidth', widthRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging]);

  // an abandoned drag (Escape, or a drop outside any window) fires dragend but
  // no dragleave on the card, which would otherwise leave it lit up forever
  React.useEffect(() => {
    const clear = (): void => {
      setDropTarget(null);
      setDropAt(null);
      dragCard.current = null;
    };
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, []);

  /** close the menu, and hand focus back to whatever opened it (#197) */
  const closeMenu = React.useCallback((restoreFocus: boolean): void => {
    setMenu(null);
    setMenuPlace(null);
    if (restoreFocus) menuAnchor.current?.focus();
  }, []);

  // dismiss the context menu on any click elsewhere, Escape, or a window resize
  React.useEffect(() => {
    if (!menu) return;
    const close = (): void => closeMenu(false);
    const onKey = (e: KeyboardEvent): void => {
      // Escape is the keyboard's way out, so it is also the one dismissal that
      // owes the user their place back — a menu that closes into nowhere
      // strands the keyboard at the top of the document
      if (e.key === 'Escape') closeMenu(true);
    };
    // A resize invalidates the placement outright, and the menu is measured
    // once, when it opens (#642). Under `dir="rtl"` it is anchored to the RIGHT
    // edge, so a drag of the window's corner would physically walk the open
    // menu across the screen, away from the row it belongs to. Dismissing is
    // both cheaper than re-placing and the more honest answer: the menu was
    // opened at a pointer that is no longer where it was pointing.
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, closeMenu]);

  // Fit the menu to the WINDOW before anyone sees it (#641). `contextmenu`
  // hands over a point, not a placement: it cannot know how tall the menu is,
  // and a `position: fixed` box that runs past the bottom edge has nothing to
  // scroll — its last items are unreachable to a mouse and to a test alike.
  // #559's `Order in this group` section is what made that real here (the menu
  // grew ~72px and the bottom radio landed off the windows-latest runner's
  // 655px viewport), but the menu was one taller section away from this at any
  // window size, so the fix belongs to the placement and not to that section.
  //
  // A layout effect and not a render-time guess because the height is a fact
  // about laid-out text: measured here, the resulting setState re-renders
  // synchronously, and the browser paints once — at the corrected position.
  React.useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    // The MENU's own direction, not the row's: `insetInlineStart` resolves
    // against the box it is set on, so that element is the only authority on
    // which edge it counts from. `clientX` is physical whichever way the menu
    // reads, so `placeMenu` is told the direction and hands back an
    // inline-start offset (#642).
    const direction = directionOf(el);
    // `documentElement.clientWidth/Height`, not `window.inner*`: the former is
    // the containing block a `position: fixed` box is actually laid out in —
    // the latter includes any root scrollbar, which Chromium puts on the LEFT
    // under rtl, i.e. on the very edge the inline answer is measured from.
    const root = el.ownerDocument.documentElement;
    setMenuPlace(
      placeMenu(
        { x: menu.x, y: menu.y },
        // the NATURAL size: this pass runs before `maxBlockSize` is applied,
        // so the box has not been clamped by a previous answer
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: root.clientWidth, height: root.clientHeight },
        { direction }
      )
    );
  }, [menu]);

  // A menu you can open with Shift+F10 and not walk is worse than no menu, so
  // the first item takes focus as it opens. Layout effect, not an effect: the
  // menu is `position: fixed` and focusing it after a paint would scroll-jump.
  // Gated on the placement for the same reason: focusing an item that is still
  // hanging off the window edge is exactly the scroll-jump this is avoiding.
  React.useLayoutEffect(() => {
    if (!menu || !menuPlace) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [menu, menuPlace]);

  /**
   * Finish a keyboard move once the store says it happened (#253) — announce
   * it, and put the keyboard back on the row in its new home.
   *
   * Both halves have to wait for the props, not for the click:
   *
   * - the WORDS would otherwise be a claim about a round trip that hadn't
   *   returned yet, and a live region that lies is worse than a silent one;
   * - the FOCUS would land on the row where it used to be, and be thrown to
   *   <body> a moment later when React re-parents it into the new card.
   *
   * Values are compared, not events counted: the condition is "the session is
   * where I asked it to go", which is also true if something else moved it
   * there first — in which case there is nothing left to do anyway.
   */
  React.useEffect(() => {
    const p = pendingMove.current;
    const nav = navRef.current;
    if (!p || !nav) return;
    const s = props.sessions.find((x) => x.id === p.cardId);
    // the row is gone (the session ended mid-move): drop the whole errand
    if (!s) {
      pendingMove.current = null;
      return;
    }
    if ((s.groupId ?? null) !== p.to) return; // hasn't landed yet
    pendingMove.current = null;
    setMoveSaid(p.said);

    // Don't yank focus from wherever the user has since gone under their own
    // steam — a restore is owed only to the keyboard that started this.
    const doc = nav.ownerDocument;
    const active = doc.activeElement as HTMLElement | null;
    if (active && active !== doc.body && !nav.contains(active)) return;

    // Attribute selectors, not string interpolation: a card id is not ours to
    // assume is CSS-safe, and `CSS.escape` is a lot of ceremony for one lookup.
    const at = (attr: string, value: string): HTMLElement | null =>
      Array.from(nav.querySelectorAll<HTMLElement>(`[${attr}]`)).find(
        (el) => el.getAttribute(attr) === value
      ) ?? null;
    const row = at('data-rail-open', p.cardId);
    // A collapsed destination hides the row, and focus() on a display:none
    // element does nothing at all — so land on the group it went into instead.
    // Better than expanding the group behind the user's back: `aria-expanded`
    // on the header they arrive at already says the rest of the story.
    const target = row && !row.closest('[hidden]') ? row : at('data-rail-group-toggle', p.destKey);
    target?.focus();
  }, [props.sessions]);

  /** The pin half of the same errand (#295) — see `pendingPin`. Values, not
   *  events: "the pin is where I asked it to be" is the condition, and it is
   *  equally true if something else got there first. */
  React.useEffect(() => {
    const p = pendingPin.current;
    const nav = navRef.current;
    if (!p || !nav) return;
    if (props.pinned.has(p.cardId) !== p.want) return; // hasn't landed yet
    pendingPin.current = null;
    // the same courtesy the move makes: never yank focus back from wherever
    // the user has since gone under their own steam
    const doc = nav.ownerDocument;
    const active = doc.activeElement as HTMLElement | null;
    if (active && active !== doc.body && !nav.contains(active)) return;
    const row =
      Array.from(nav.querySelectorAll<HTMLElement>('[data-rail-open]')).find(
        (el) => el.getAttribute('data-rail-open') === p.cardId
      ) ?? null;
    if (row && !row.closest('[hidden]')) row.focus();
  }, [props.pinned]);

  // one ordering function for the rail AND for Ctrl+1..9 (E9-01): persistent
  // groups and their members, then emergent auto-groups (E12-05), then loose
  // `props.pinned` and not a second sort here: §5.8's "sorts first" is one rule,
  // and the store derives the SAME call for Ctrl+1..9 and both strips (E9-09).
  // `props.manualOrder` joins it for #559 and lands BETWEEN membership and the
  // pin sort — lib/rail-order says why that is the layering.
  const order = railOrder(props.sessions, props.groups, props.pinned, props.manualOrder);
  const grouped = new Map(order.groups.map((g) => [g.id, g.members]));

  /**
   * Where a drop against `rowId` would put the dragged session — an insertion
   * index into the bucket WITHOUT it, which is what `planReorder` takes.
   *
   * One function for the dragover hit test and for the drop, so an insertion
   * line can never point somewhere the release does not land.
   */
  const insertIndex = (
    bucketIds: readonly string[],
    draggedId: string,
    rowId: string,
    edge: 'before' | 'after'
  ): number => {
    const rest = bucketIds.filter((id) => id !== draggedId);
    const j = rest.indexOf(rowId);
    if (j < 0) return rest.length;
    return edge === 'before' ? j : j + 1;
  };

  /**
   * The order this drag would leave `bucket` in, or `null` for a drop that
   * would change nothing. `planReorder` re-applies §5.8's pin sort, so a drop
   * aimed past a pinned session settles against it rather than displacing it —
   * and answers `null` when that leaves the row where it started. `null` is
   * what stops the insertion line being drawn, so the rail never offers a
   * gesture it is about to ignore.
   *
   * A REORDER IS WITHIN ONE BUCKET, full stop. A row belonging to another
   * group answers `null` here and the dragover bubbles to the group card, whose
   * membership drop is unchanged from E12-04 — so dragging across groups still
   * means exactly what it meant yesterday (join, at the end), and the two
   * gestures never have to arbitrate.
   */
  const planRowDrop = (
    bucket: string,
    rowId: string,
    edge: 'before' | 'after'
  ): string[] | null => {
    const dragged = dragCard.current ?? getDraggedCard();
    if (!dragged) return null;
    // a row dropped on ITSELF has no position to be relative to. Guarded here
    // and not left to the arithmetic: with the row removed from the list there
    // is no index to find, and "not found" reads as "the end" — so the one
    // gesture that means nothing would have sent the session to the bottom.
    if (dragged === rowId) return null;
    if (order.bucketOf.get(dragged) !== bucket) return null;
    const ids = order.buckets.get(bucket) ?? [];
    return planReorder(ids, dragged, insertIndex(ids, dragged, rowId, edge), props.pinned);
  };

  /** which half of the row the pointer is in — above the middle means "land
   *  before this one", below it means "after" */
  const edgeAt = (el: HTMLElement, clientY: number): 'before' | 'after' => {
    const box = el.getBoundingClientRect();
    return clientY < box.top + box.height / 2 ? 'before' : 'after';
  };

  /** what to call this bucket in a sentence a screen reader will read */
  const bucketName = (bucket: string): string => {
    const g = props.groups.find((x) => x.id === bucket);
    if (g) return g.name;
    if (bucket.startsWith('auto:'))
      // the same trim the auto-group's own header does, so the words in the
      // announcement are the words on the card
      return bucket.slice(5).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? bucket;
    return t('rail.ungrouped');
  };

  /** Move one row a step, from the keyboard (§5.32) — the SAME write the drop
   *  makes, and the same rule deciding whether it may happen at all. */
  const stepRow = (s: RailSession, delta: -1 | 1): boolean => {
    const bucket = order.bucketOf.get(s.id);
    if (!bucket) return false;
    const ids = order.buckets.get(bucket) ?? [];
    const at = ids.indexOf(s.id);
    const next = planReorder(ids, s.id, at + delta, props.pinned);
    if (!next) return false;
    props.onReorder(bucket, next);
    setMoveSaid(
      t('rail.reordered', {
        title: s.title,
        position: next.indexOf(s.id) + 1,
        count: next.length,
        group: bucketName(bucket),
      })
    );
    return true;
  };

  const sessionRow = (s: RailSession, bucket: string): React.JSX.Element => {
    const p = presentStatus(s.status);
    const hue = `var(--status-${p.token})`;
    const ink = `var(--status-${p.token}-ink)`;
    const accent = s.accent ?? 'var(--faint)';
    const selected = s.id === props.selectedId;
    const isPinned = props.pinned.has(s.id);
    // a needy session outranks selection: the attention tint is the signal the
    // whole panel exists to carry
    const rowTint = p.needsYou ? tint(hue, 10) : selected ? tint(accent, 10) : 'transparent';

    return (
      <div
        key={s.id}
        className="rail-row"
        // `data-needs-you` is the SEMANTIC one — does a human have to act —
        // and is read by the specs. Its old companion `data-tinted` went with
        // the dead hover rule it existed for (#253): its only reader was
        // `.rail-row[data-tinted='true']:hover`, the exception that kept a
        // needy row's tint from being repainted. No hover rule, nothing to
        // except it from.
        data-needs-you={p.needsYou}
        data-session-status={p.token}
        // §5.8's pinning contract (E9-09). An attribute rather than only a
        // glyph: the protection is a fact about the row that the e2e suite has
        // to be able to read, and styling may want it later.
        data-pinned={isPinned}
        // #559: the row a drop would land against, and which side of it. Read
        // by the e2e — an insertion line is a 2px bar and nothing else on the
        // page can be asked whether it is in the right place.
        data-drop-edge={dropAt?.rowId === s.id ? dropAt.edge : undefined}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_TYPE, s.id);
          e.dataTransfer.effectAllowed = 'move';
          // #559: `dataTransfer.getData` answers '' during dragover in
          // Chromium's protected mode, so a hit test that needs to know WHICH
          // card is in flight has to have been told. The group card's
          // membership drop reads the payload at drop time and is unaffected.
          dragCard.current = s.id;
        }}
        onDragOver={(e) => {
          const edge = edgeAt(e.currentTarget, e.clientY);
          // no reorder to offer — let it bubble to the group card, whose
          // membership drop is what a cross-group drag has always meant
          if (!planRowDrop(bucket, s.id, edge)) return;
          e.preventDefault();
          e.stopPropagation();
          setDropAt({ bucket, rowId: s.id, edge });
        }}
        onDrop={(e) => {
          const edge = edgeAt(e.currentTarget, e.clientY);
          const next = planRowDrop(bucket, s.id, edge);
          setDropAt(null);
          dragCard.current = null;
          if (!next) return; // never claimed it; the card below is welcome to it
          e.preventDefault();
          e.stopPropagation();
          setDropTarget(null);
          props.onReorder(bucket, next);
        }}
        onClick={() => props.onFocus(s.id)}
        onDoubleClick={() => {
          setEditing(s.id);
          setDraft(s.title);
        }}
        onContextMenu={(e) => {
          // The RENAME BOX is inside this row, and a text box owes its user the
          // edit menu before it owes anyone a session menu (#526). Chromium
          // stops emitting the browser-process `context-menu` event the moment
          // the page calls `preventDefault`, so without this early return the
          // one place in the app you cannot Cut/Copy/Paste with the mouse is a
          // field whose entire purpose is editing text.
          if ((e.target as HTMLElement).closest?.('input, textarea, [contenteditable="true"]'))
            return;
          e.preventDefault();
          // Shift+F10 and the ContextMenu key fire this same event, which is
          // what gives the menu a keyboard path at all — but they carry no
          // pointer, and Chromium reports (0, 0) for it. Anchor to the row
          // instead, or the menu opens in the window's top-left corner.
          const kb = e.clientX === 0 && e.clientY === 0;
          const box = e.currentTarget.getBoundingClientRect();
          // the ROW's inline-start edge, a little way in — the same offset the
          // pointer would have landed at, mirrored so the keyboard's menu opens
          // over the grid in both directions rather than off the far side of
          // the rail. The row is the right element to ask here for the same
          // reason the menu is the right one to ask at placement time: this is
          // a fact about where the ROW's edges are (#642).
          const kbX = directionOf(e.currentTarget) === 'rtl' ? box.right - 12 : box.left + 12;
          menuAnchor.current = (e.target as HTMLElement).closest<HTMLElement>('button');
          // the previous answer describes a menu that is about to be replaced
          setMenuPlace(null);
          setMenu({
            session: s,
            x: kb ? kbX : e.clientX,
            y: kb ? box.bottom : e.clientY,
          });
        }}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '8px 8px 8px 13px',
          borderRadius: 7,
          marginBlockEnd: 2,
          background: rowTint,
        }}
      >
        {dropAt?.rowId === s.id && (
          // The insertion line. `--status-working-ink` is the app's one
          // per-theme-tuned accent (tokens.css) — the same one the focus ring
          // uses, because this is the same kind of statement: here is where the
          // thing you are doing will land.
          <span
            aria-hidden
            data-drop-line={dropAt.edge}
            style={{
              position: 'absolute',
              insetInline: 0,
              [dropAt.edge === 'before' ? 'insetBlockStart' : 'insetBlockEnd']: -2,
              blockSize: 2,
              borderRadius: 1,
              background: 'var(--status-working-ink)',
            }}
          />
        )}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            insetInlineStart: 0,
            insetBlockStart: 3,
            insetBlockEnd: 3,
            // thickens to 4px when it needs you — legible from the far edge of
            // the screen without reading a word
            inlineSize: p.needsYou ? 4 : 2.5,
            borderRadius: '0 2px 2px 0',
            background: p.needsYou ? hue : selected ? accent : tint(accent, 45),
          }}
        />
        {editing === s.id ? (
          <input
            autoFocus
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setEditing(null)}
            /* A BLANK NAME IS NOT A RENAME (#294).
               An empty commit used to put `''` in the store as a legal title,
               and every display site (card header, tab, close confirm) grew its
               own "empty counts as absent" rule to compensate. Worse, the rail
               row itself renders the raw title, so the session went nameless in
               the one place you would go to fix it.
               Two guards, deliberately: main's `sessions:renameCard` is what
               makes `''` impossible, and this is what makes the FIELD behave —
               in the idiom it already has for an edit that goes nowhere. Escape
               and blur both end the edit and leave the name that was there, and
               so does this; a rejection the user cannot dismiss is a trap. The
               name is trimmed on the way through for the same reason the task
               label is — surrounding whitespace is never what was meant, and it
               is what makes "blank" a rule you can state. */
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const name = draft.trim();
                if (name) props.onRename(s.id, name);
                setEditing(null);
              }
              if (e.key === 'Escape') setEditing(null);
            }}
            style={{
              inlineSize: '100%',
              background: 'var(--panel2)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 11.5,
              fontFamily: 'var(--font-ui)',
            }}
          />
        ) : (
          <>
            {/* The row's real control (#197). It carries the whole name block
                rather than just the title so the focus ring outlines what a
                sighted user reads as "the row", and so the sub-label — which is
                the ASK when the session needs you — is part of the accessible
                name instead of loose text beside it. */}
            <button
              type="button"
              className="rail-row-open"
              data-rail-open={s.id}
              // The state in words, because the only other place it appears is
              // the status glyph, which is decorative to a screen reader. The
              // detail is the row's OWN second line, and an `aria-label`
              // replaces the contents outright — so it has to be folded in here
              // or a task label would be readable to the eye and to nobody
              // else. (Not when the session needs you: the second line IS the
              // ask then, and the state already says it.)
              aria-label={t(isPinned ? 'rail.rowLabelPinned' : 'rail.rowLabel', {
                title: s.title,
                state:
                  !p.needsYou && s.taskLabel
                    ? t('rail.rowDetail', { detail: s.taskLabel, state: t(p.labelKey) })
                    : t(p.labelKey),
              })}
              // "this is the session the grid is showing" — a fact about the
              // rail's own list, which is what aria-current is for
              aria-current={selected ? 'true' : undefined}
              onClick={(e) => {
                // the row div below already focuses on click; without this the
                // mouse would run it twice
                e.stopPropagation();
                props.onFocus(s.id);
              }}
              style={{
                flex: 1,
                minInlineSize: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 2,
                background: 'transparent',
                border: 'none',
                padding: 0,
                margin: 0,
                textAlign: 'start',
                font: 'inherit',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: p.needsYou ? 700 : 600,
                  color: 'var(--text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.title}
              </span>
              <span
                style={{
                  // the ask is prose in the status color; a calm sub-label is
                  // quiet mono, so the two never compete
                  fontFamily: p.needsYou ? 'var(--font-ui)' : 'var(--font-mono)',
                  fontWeight: p.needsYou ? 600 : 400,
                  fontSize: 9.5,
                  color: p.needsYou ? ink : 'var(--muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {p.needsYou ? t(p.labelKey) : (s.taskLabel ?? t(p.labelKey))}
              </span>
            </button>
            {/* §5.8's pin (E9-09), on the row itself. AFTER the name block and
                not before it: a marker in front of the title would indent the
                pinned row's name away from every other row's, so the one row
                you pinned is the one that no longer lines up. Decoration to a
                screen reader — the fact is folded into the row button's own
                accessible name above, where it is read as part of "this
                session" rather than as a loose glyph beside it. */}
            {isPinned && (
              <span
                aria-hidden
                title={t('rail.pinnedHint')}
                style={{ fontSize: 9, lineHeight: 1, flexShrink: 0, color: 'var(--muted)' }}
              >
                {t('rail.pinIcon')}
              </span>
            )}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 4,
                flexShrink: 0,
                alignSelf: 'stretch',
              }}
            >
              <button
                className="rail-x"
                title={t('rail.closeSession')}
                aria-label={t('rail.closeSession')}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(s.id);
                }}
                style={{ fontSize: 10 }}
              >
                {t('rail.closeSessionIcon')}
              </button>
              {/* The glyph and the ring are DECORATION: `aria-label` on a
                  role-less span is ignored by every screen reader anyway, and
                  the state it was trying to announce is now in the row button's
                  own name. `title` stays — that one is for the mouse. */}
              {p.spinner ? (
                <span
                  aria-hidden
                  title={t(p.labelKey)}
                  style={{
                    inlineSize: 12,
                    blockSize: 12,
                    borderRadius: '50%',
                    flexShrink: 0,
                    border: `1.6px solid ${tint(hue, 22)}`,
                    borderBlockStartColor: hue,
                    animation: 'sb-spin 1.1s linear infinite',
                  }}
                />
              ) : (
                <span
                  aria-hidden
                  title={t(p.labelKey)}
                  style={{
                    inlineSize: 16,
                    blockSize: 16,
                    borderRadius: 4,
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'var(--font-ui)',
                    fontWeight: 700,
                    fontSize: 10,
                    color: ink,
                    background: tint(hue, 14),
                  }}
                >
                  {p.glyphKey ? t(p.glyphKey) : ''}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  /**
   * §5.8's pinning contract, the OVERFLOW clause (#295, deferred from #78):
   *
   *   "a pinned session sorts first in the rail, NEVER SCROLLS OUT OF VIEW
   *    UNDER OVERFLOW, and is exempt from EVERY bulk operation"
   *
   * #78/#287 shipped the sort and the exemptions and said plainly that this
   * clause was the unfinished one (`lib/pinning.ts`, "WHAT IS NOT IMPLEMENTED").
   * This is it: a bucket's pinned rows are lifted into ONE `position: sticky`
   * block, so scrolling slides the unpinned rows underneath them instead of
   * carrying them away.
   *
   * ── THE FOUR DECISIONS, and they are all vetoable by taste ───────────────
   *
   * 1. STICKY ROWS, NOT A PINNED SHELF. The other structural option was a
   *    "Pinned" section hoisted above the scroll region. `lib/groups`' own
   *    `railOrder` already rejected hoisting once, in writing, and the reasons
   *    still hold: it empties the count on the header the user deliberately
   *    filed the session under, it fights the stored group order, and rail
   *    order IS what Ctrl+1..9 counts against. Sticky moves NO session — the
   *    rows render in the same order, in the same bucket, from the same list.
   *
   * 2. STACKING: ONE BLOCK PER BUCKET, not one sticky row each. Two pins in one
   *    group park as a pair in their own order; they can never overlap each
   *    other, and no per-row offset has to be measured. That is affordable
   *    because `sortPinnedFirst` (through `railOrder`, and again through
   *    `planReorder`) makes a bucket's pins a contiguous PREFIX - proved in
   *    `lib/groups.test` and `lib/pinning.test`, not re-proved here. The prefix
   *    is taken with `slice` rather than `filter` so this code READS as leaning
   *    on that invariant instead of quietly re-deriving it; for every input the
   *    component can be handed the two are the same list.
   *
   * 3. THE GROUP HEADER IS NOT STICKY, so a stuck pin outlives its group's NAME.
   *    (They never overlap, note: the block's containing block is the body,
   *    which starts below the header, so the header has already scrolled off by
   *    the time the block sticks. The `zIndex` is for the frame in between.) A
   *    sticky header would need the pins offset by its measured height, and then
   *    two groups' worth of sticky furniture would compete for the top of a
   *    286px rail. The pin glyph is on the row, so a stuck row is still legible
   *    as "the one you pinned"; losing the group name while its header is off
   *    screen is the honest cost of not moving the session.
   *
   * 4. KEYBOARD: A ROW MAY NOT BE FOCUSED UNDERNEATH THE BLOCK. See
   *    `keepClearOfPins` below — the browser scrolls a focused row to the top
   *    edge of the scrollport, which is exactly where the stuck block is, so
   *    Tab would otherwise walk into rows nobody can see.
   *
   * ── THE LIMIT, stated rather than glossed ────────────────────────────────
   *
   * A sticky box cannot leave its containing block. With NO groups — the
   * default and commonest shape — the loose list IS the whole scroll content,
   * so a pinned session is visible at every scroll position, full stop. Inside
   * a GROUP card the guarantee is "while that card is on screen": scroll past
   * the whole group and its pins go with it. Getting past that means taking the
   * pin out of its group, which is decision 1 in reverse. Flagged on the PR.
   */
  const bucketRows = (
    members: readonly RailSession[],
    bucket: string,
    /** the opaque surface the block paints, so rows slide UNDER it, not through */
    surface: string
  ): React.JSX.Element[] => {
    const cut = members.findIndex((m) => !props.pinned.has(m.id));
    const pins = cut === -1 ? members : members.slice(0, cut);
    const rest = cut === -1 ? [] : members.slice(cut);
    const out = rest.map((m) => sessionRow(m, bucket));
    if (pins.length === 0) return out;
    out.unshift(
      <div
        key="__pinned"
        data-pinned-block={bucket}
        style={{
          position: 'sticky',
          insetBlockStart: 0,
          // a positioned box already paints over the un-positioned header; the
          // z-index says so on purpose rather than by luck
          zIndex: 1,
          background: surface,
        }}
      >
        {pins.map((m) => sessionRow(m, bucket))}
      </div>
    );
    return out;
  };

  /**
   * A group card. Three kinds share this shape, and telling them apart at a
   * glance is the point (Dan 2026-07-26 round 3: two of his four cards refused
   * drops and it "took a while to figure out" they were automatic):
   *
   *  - `group`      — yours. A colored DOT, because a group you named is a
   *                   label you applied, not a place on disk. Droppable,
   *                   renameable, recolorable (click the dot), deletable.
   *  - `auto`       — emergent, one per repo/folder (E12-05). A solid FOLDER
   *                   in the auto color, its own surface, and the word "auto",
   *                   because it literally IS a folder and its membership is
   *                   computed. **Refuses drops** — see onDragOver.
   *  - `ungrouped`  — the trailing bucket. No icon; it is an absence, not a
   *                   thing. Droppable, since dropping here means "ungroup".
   */
  const groupCard = (opts: {
    key: string;
    name: string;
    color: string;
    members: RailSession[];
    group?: RailGroup;
    kind: 'group' | 'auto' | 'ungrouped';
    title?: string;
    showEmpty?: boolean;
  }): React.JSX.Element => {
    const isCollapsed = collapsed.has(opts.key);
    const need = needCount(opts.members, props.needing);
    const g = opts.group;
    const isAuto = opts.kind === 'auto';
    // Membership in an auto-group is DERIVED from the session's folder, so
    // there is nothing a drop could change. Advertising it as a target and
    // then doing nothing is what wasted Dan's time.
    const droppable = !isAuto;
    // only a real group's color is user data needing the per-theme darkening;
    // the other two already use theme tokens
    const ink = opts.kind === 'group' ? 'rail-group-ink' : undefined;
    const isDropTarget = dropTarget === opts.key;
    // the disclosure's target (#197). `aria-controls` has to point at an
    // element that EXISTS, so the body below is always rendered and merely
    // `hidden` when collapsed — a dangling reference is worse than none.
    const bodyId = `rail-body-${bodyKey(opts.key)}`;
    return (
      <div
        key={opts.key}
        data-group-card={opts.key}
        data-group-kind={opts.kind}
        // THE WHOLE CARD is the drop target, not just the header (Dan: "I have
        // to drag it to the little folder icon when really I should just be
        // able to drag it right into the group window anywhere"). The header
        // needs no handler of its own — a drop there bubbles to here.
        onDragOver={(e) => {
          // accept rail-row drags (our type) AND dockview tab drags
          // (published via drag-context — Dan's E12-04 eyeball find)
          if (!e.dataTransfer.types.includes(DND_TYPE) && !getDraggedCard()) return;
          // Reaching the CARD means no row claimed this position, so #559's
          // insertion line is stale — the pointer has left the rows for the
          // header or the padding, where a release means "join this group" and
          // not "land here". Two promises on screen at once is one too many.
          setDropAt(null);
          if (!droppable) {
            // Swallow it WITHOUT preventDefault: the browser only fires `drop`
            // where dragover was prevented, so this gives a real no-drop
            // cursor. stopPropagation matters just as much — the nav behind us
            // accepts drags (that is the ungroup target), and letting this
            // bubble would make a release over an auto-group silently ungroup
            // the session instead of refusing.
            e.stopPropagation();
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          setDropTarget(opts.key);
        }}
        onDragLeave={(e) => {
          // dragging between the card's own children fires dragleave on the
          // one being left — only a pointer that has actually left the CARD
          // should clear the highlight
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
        }}
        onDrop={(e) => {
          e.stopPropagation(); // don't bubble to the nav's ungroup drop
          e.preventDefault(); // claim it from dockview's own drop targets
          const cardId = e.dataTransfer.getData(DND_TYPE) || getDraggedCard();
          setDraggedCard(null);
          setDropTarget(null);
          if (!cardId) return;
          // dropping on Ungrouped/auto means exactly that: no membership
          const to = g?.id ?? null;
          // a drop back into the group it already belongs to is a no-op, not a
          // round trip through IPC and a grid reshuffle
          const from = props.sessions.find((s) => s.id === cardId)?.groupId ?? null;
          if (from !== to) props.onMoveToGroup(cardId, to);
        }}
        style={{
          // an auto-group gets its own surface, not just its own icon — a card
          // you cannot drop into should not look like one you can
          background: isAuto ? 'var(--auto-surface)' : 'var(--rail-card)',
          // the same edge the grid's session groups get — one container
          // treatment across the app
          border: '1px solid var(--group-frame)',
          borderRadius: 8,
          marginBlockEnd: 9,
          // NO `overflow: hidden` here, and that is load-bearing (#295):
          // `overflow` other than `visible` makes this box a scroll container,
          // and a `position: sticky` descendant is measured against its NEAREST
          // scroll container — so the clip that used to round the header's
          // corners would have pinned the pinned rows to a box that never
          // scrolls, i.e. to nothing. The header rounds its own two corners
          // instead (`.rail-head` below); no other child reaches an edge.
          boxShadow: isDropTarget
            ? `0 0 0 2px ${opts.color}, var(--group-lift)`
            : 'var(--group-lift)',
        }}
      >
        <div
          className="rail-head"
          onClick={() => toggleCollapsed(opts.key)}
          title={opts.title ?? (isCollapsed ? t('rail.expand') : t('rail.collapse'))}
          style={
            {
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '8px 9px 8px 10px',
              background: isAuto ? 'var(--auto-head)' : tint(opts.color, 7),
              // what the card's `overflow: hidden` used to do for it (#295).
              // 7px, not 8: the radius of the INSIDE of a 1px border.
              borderStartStartRadius: 7,
              borderStartEndRadius: 7,
              // ...and when the group is COLLAPSED the body is display:none, so
              // this strip is the card's bottom edge too and owes it the other
              // two. Without them a collapsed card wears two square nubs over
              // its own rounded corners.
              borderEndStartRadius: isCollapsed ? 7 : 0,
              borderEndEndRadius: isCollapsed ? 7 : 0,
              borderBlockEnd: '1px solid var(--rail-divider)',
              // --g feeds .rail-group-ink, which darkens the color per theme so
              // the name clears AA on the white card (see tokens.css)
              '--g': opts.color,
            } as React.CSSProperties
          }
        >
          <span
            aria-hidden
            style={{
              fontSize: 8,
              color: 'var(--faint)',
              inlineSize: 8,
              flexShrink: 0,
              display: 'inline-block',
              transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              transition: 'transform 0.12s',
            }}
          >
            {t('rail.chevron')}
          </span>
          {opts.kind === 'group' && (
            // A group you made is a LABEL you applied, so it gets a dot, not a
            // folder — the folder is reserved for the cards that really are a
            // folder on disk. The dot is also the recolor target, so it is a
            // real button (#197) and not a span that only a mouse can reach.
            <button
              type="button"
              className="rail-dot"
              onClick={(e) => {
                // stopped FIRST, before the guard: a dot with nothing to cycle
                // must be inert, not a second way to collapse the group —
                // which is what a bubbled Enter on this button would be
                e.stopPropagation();
                if (!g || props.palette.length === 0) return;
                const i = props.palette.indexOf(g.color);
                props.onRecolorGroup(g.id, props.palette[(i + 1) % props.palette.length]);
              }}
              title={t('rail.recolorGroup')}
              aria-label={t('rail.recolorGroup')}
              style={{
                inlineSize: 9,
                blockSize: 9,
                padding: 0,
                border: 'none',
                borderRadius: '50%',
                background: opts.color,
                flexShrink: 0,
                cursor: 'pointer',
              }}
            />
          )}
          {isAuto && (
            // solid, in the auto color, at the same size a group's dot occupies
            // — "this one is a directory, and I made it, not you"
            <span
              style={{
                color: 'var(--auto-ink)',
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden>
                <path d="M1.9 4.1c0-.6.5-1.1 1.1-1.1h2.7c.35 0 .68.17.88.46l.7 1.04h6c.6 0 1.1.5 1.1 1.1v6c0 .6-.5 1.1-1.1 1.1H3c-.6 0-1.1-.5-1.1-1.1V4.1Z" />
              </svg>
            </span>
          )}
          {g && editingGroup === g.id ? (
            <input
              autoFocus
              value={groupDraft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setGroupDraft(e.target.value)}
              onBlur={() => setEditingGroup(null)}
              /* A BLANK NAME IS NOT A RENAME (#311) — the same rule the session
                 field 380 lines above got in #294, in the same idiom, because
                 two sibling fields in one file drifting apart is how a user
                 learns the app is unpredictable.
                 The asymmetry with #294 is worth stating so nobody "fixes" it
                 twice: main's `groups:update` ALREADY refuses a blank and trims
                 (`cleanName`, group-ipc.ts), so unlike `sessions:renameCard`
                 there was never a path to a persisted `''`. What the unguarded
                 draft actually did was hand main a name it THREW on, and App's
                 `void bridge.groups.update(...).then(...)` has no catch — so an
                 erased group name produced an unhandled rejection and a field
                 that closed with no explanation. (#326 took the throw away too:
                 `groups:*` now answers `null` for a change it refuses. Both
                 halves stay — this one keeps the pointless round trip from
                 happening at all, and keeps the field's behaviour identical to
                 the session field above it.) This makes the FIELD
                 behave, in the idiom it already has for an edit that goes
                 nowhere: Escape and blur both end the edit and leave the name
                 that was there, and so does this. A rejection the user cannot
                 dismiss is a trap. Trimming here for the same reason main does
                 — surrounding whitespace is never what was meant, and it is
                 what makes "blank" one rule instead of two. */
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const name = groupDraft.trim();
                  if (name) props.onRenameGroup(g.id, name);
                  setEditingGroup(null);
                }
                if (e.key === 'Escape') setEditingGroup(null);
              }}
              style={{
                inlineSize: '100%',
                // #295. This field is one flex item among eight (chevron, dot,
                // count chip, AUTO badge, the calm/need line, three buttons —
                // every one of them `flexShrink: 0`), and a flex item's
                // automatic minimum size is its own intrinsic width until this
                // is set (CSS Sizing 3 5.2). At ~150px against ~70px of room it
                // has always overflowed the header; the card's
                // `overflow: hidden` was hiding it, and that clip had to go so
                // the pinned block could stick. Same pair `cheadName` carries
                // for the same reason - and it matters more here, because
                // `.rail-scroll` sets only `overflow-y`, which makes the x axis
                // `auto`: an overflowing header is a horizontal scrollbar on
                // the whole rail.
                minInlineSize: 0,
                background: 'var(--panel2)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: 11.5,
                fontFamily: 'var(--font-ui)',
              }}
            />
          ) : (
            // The header's real control (#197): the NAME, not the chevron. The
            // chevron is 8px and stays decoration — its rotation is the same
            // fact `aria-expanded` carries, and a focus ring around it would be
            // a ring around nothing. Putting the disclosure on the name gives
            // the button its accessible name for free and moves no pixels.
            <button
              type="button"
              className={ink ? `rail-head-toggle ${ink}` : 'rail-head-toggle'}
              data-rail-group-toggle={opts.key}
              aria-expanded={!isCollapsed}
              aria-controls={bodyId}
              onClick={(e) => {
                // the header div toggles too (the whole strip is a mouse
                // target); without this a click here would toggle twice
                e.stopPropagation();
                toggleCollapsed(opts.key);
              }}
              onDoubleClick={(e) => {
                if (!g) return;
                e.stopPropagation();
                setEditingGroup(g.id);
                setGroupDraft(g.name);
              }}
              title={g ? t('rail.renameGroup') : undefined}
              style={{
                minInlineSize: 0,
                fontSize: 11.5,
                fontWeight: 600,
                fontFamily: 'var(--font-ui)',
                color: ink ? undefined : opts.color,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                background: 'transparent',
                border: 'none',
                padding: 0,
                margin: 0,
                textAlign: 'start',
                cursor: 'pointer',
              }}
            >
              {opts.name}
            </button>
          )}
          {opts.members.length > 0 && (
            <span
              className={ink}
              style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                fontSize: 9,
                color: ink ? undefined : opts.color,
                background: tint(opts.color, 12),
                borderRadius: 4,
                padding: '1px 5px',
                flexShrink: 0,
              }}
            >
              {opts.members.length}
            </span>
          )}
          {isAuto && (
            // the word, so nothing is left to infer from styling alone
            <span
              title={t('rail.autoGroupHint')}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 8.5,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: 'var(--auto-ink)',
                border: '1px solid var(--auto-ink)',
                borderRadius: 3,
                padding: '0 3px',
                flexShrink: 0,
              }}
            >
              {t('rail.autoBadge')}
            </span>
          )}
          <span
            style={{
              fontFamily: 'var(--font-ui)',
              fontWeight: 600,
              fontSize: 9,
              whiteSpace: 'nowrap',
              marginInlineStart: 'auto',
              color: need ? 'var(--status-needs-input-ink)' : 'var(--muted)',
            }}
          >
            {need ? t('rail.needSummary', { count: need }) : t('rail.calm')}
          </span>
          {g && (
            <span
              style={{
                display: 'flex',
                gap: 2,
                flexShrink: 0,
                alignItems: 'center',
                marginInlineStart: 4,
              }}
            >
              {/* §5.8's per-GROUP presentation override (E9-06). A cycle here,
                  unlike the session menu: the button stays put, so one click
                  per step is the cheapest gesture there is, and the tooltip
                  always names the state it is currently in. */}
              <button
                className="rail-x"
                data-group-policy={g.id}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onCycleGroupPolicy(g.id);
                }}
                title={t('ladder.policyGroup', {
                  policy: (() => {
                    const own = groupOverride(props.policies, g.id);
                    return own ? t(`policy.${own}`) : t('policy.groupDefault');
                  })(),
                })}
                style={{
                  fontSize: 10,
                  // an override is a state worth seeing without hovering
                  opacity: groupOverride(props.policies, g.id) ? 1 : 0.55,
                }}
              >
                {t('ladder.policyGroupIcon')}
              </button>
              <button
                className="rail-x"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onOpenInGroup(g.id);
                }}
                title={t('rail.openInGroup')}
                style={{ fontSize: 10 }}
              >
                {t('rail.openInGroupIcon')}
              </button>
              <button
                className="rail-x"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDeleteGroup(g.id);
                }}
                title={t('rail.deleteGroup')}
                style={{ fontSize: 10 }}
              >
                {t('rail.deleteGroupIcon')}
              </button>
            </span>
          )}
        </div>
        {/* Always in the DOM so the header's `aria-controls` always resolves;
            `hidden` (display:none) when collapsed, so nothing is rendered,
            measured or focusable — the members themselves are still skipped. */}
        <div id={bodyId} data-rail-body hidden={isCollapsed} style={{ padding: 5 }}>
          {isCollapsed ? null : opts.members.length === 0 && opts.showEmpty ? (
            <div style={{ color: 'var(--faint)', fontSize: 10, padding: '4px 8px' }}>
              {t('rail.groupEmpty')}
            </div>
          ) : (
            bucketRows(opts.members, opts.key, isAuto ? 'var(--auto-surface)' : 'var(--rail-card)')
          )}
        </div>
      </div>
    );
  };

  const totalNeed = needCount(props.sessions, props.needing);
  // The Ungrouped bucket only earns a header when there is something to
  // distinguish it FROM — on a fresh workspace it would be pure chrome.
  const hasOtherCards = props.groups.length > 0 || order.autoGroups.length > 0;

  return (
    <nav
      ref={navRef}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DND_TYPE) && !getDraggedCard()) return;
        e.preventDefault();
        // the same staleness the group card clears, for the headerless case:
        // with no groups at all the loose rows sit straight in the rail, so
        // this is the only handler between a row and the background
        setDropAt(null);
      }}
      onDrop={(e) => {
        // a drop on the rail background (not a group header) ungroups
        e.preventDefault();
        const cardId = e.dataTransfer.getData(DND_TYPE) || getDraggedCard();
        setDraggedCard(null);
        if (cardId) props.onMoveToGroup(cardId, null);
      }}
      style={{
        position: 'relative',
        inlineSize: width,
        // the design's 286px is the rail's TOTAL footprint, border included —
        // otherwise a dragged width and the width on screen differ by 1px
        boxSizing: 'border-box',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minBlockSize: 0,
        background: 'var(--rail-canvas)',
        borderInlineEnd: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '11px 13px 9px',
          flexShrink: 0,
          background: 'var(--rail-card)',
          borderBlockEnd: '1px solid var(--border)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 9,
            letterSpacing: 1.4,
            textTransform: 'uppercase',
            color: 'var(--faint)',
          }}
        >
          {t('rail.eyebrow', { count: props.sessions.length })}
        </span>
        <button
          className="rail-add-group"
          onClick={() => props.onCreateGroup(t('rail.newGroup'))}
          title={t('rail.addGroupHint')}
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 10.5,
            color: 'var(--muted)',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 5,
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {t('rail.addGroup')}
        </button>
      </div>

      <div
        className="rail-scroll"
        ref={scrollRef}
        onFocus={keepClearOfPins}
        style={{ flex: 1, overflowY: 'auto', padding: 10 }}
      >
        {props.groups.map((g) =>
          groupCard({
            key: g.id,
            name: g.name,
            color: g.color,
            members: grouped.get(g.id) ?? [],
            group: g,
            kind: 'group',
            showEmpty: true,
          })
        )}
        {order.autoGroups.map((ag) =>
          groupCard({
            key: `auto:${ag.key}`,
            // the folder's own name is what makes an emergent group legible
            name: ag.key.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ag.key,
            color: 'var(--auto-ink)',
            members: ag.members,
            kind: 'auto',
            title: t('rail.autoGroupHint'),
          })
        )}
        {order.loose.length > 0 &&
          (hasOtherCards
            ? groupCard({
                key: 'ungrouped',
                name: t('rail.ungrouped'),
                color: 'var(--muted)',
                members: order.loose,
                kind: 'ungrouped',
              })
            : // no groups at all: the sessions ARE the list, so skip the header
              (
                <div
                  key="ungrouped"
                  data-rail-body
                  style={{
                    background: 'var(--rail-card)',
                    border: '1px solid var(--group-frame)',
                    borderRadius: 8,
                    boxShadow: 'var(--group-lift)',
                    padding: 5,
                  }}
                >
                  {/* the headerless shape, and the one where #295's guarantee
                      is unconditional: this box IS the scroll content, so a
                      sticky pin inside it is on screen at every scroll
                      position, not only while some card is */}
                  {bucketRows(order.loose, LOOSE_BUCKET, 'var(--rail-card)')}
                </div>
              ))}
        {props.groups.length === 0 && props.sessions.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t('rail.empty')}</div>
        )}
      </div>

      <div
        style={{
          flexShrink: 0,
          borderBlockStart: '1px solid var(--border)',
          background: 'var(--rail-card)',
          padding: '8px 13px',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--muted)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>{t('rail.footerSessions', { count: props.sessions.length })}</span>
        {totalNeed > 0 && (
          <span style={{ color: 'var(--status-needs-input-ink)' }}>
            {t('rail.footerNeed', { count: totalNeed })}
          </span>
        )}
      </div>

      {/* A move made from the keyboard is otherwise SILENT: the row simply
          appears under a different card, which is a fact carried entirely by
          the screen. Rendered unconditionally and empty, so the region exists
          before its words do — one that is inserted already holding its text is
          announced by almost nothing (#222, #168; the same trick, same reason).
          Polite by definition, which is right: the user asked for this. */}
      <div role="status" style={srOnly}>
        {moveSaid}
      </div>

      <div
        className="rail-resize"
        data-dragging={dragging}
        title={t('rail.resize')}
        onPointerDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        style={{
          position: 'absolute',
          insetInlineEnd: 0,
          insetBlockStart: 0,
          insetBlockEnd: 0,
          inlineSize: 4,
          zIndex: 2,
        }}
      />

      {menu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('rail.menuLabel', { title: menu.session.title })}
          onPointerDown={(e) => e.stopPropagation()}
          // The menu owns the arrows while it is open (#197). Every item is a
          // real button, so Enter and Space are the platform's; all this adds is
          // the walk between them, which is the one thing a menu has to have and
          // that nothing else can supply.
          onKeyDown={(e) => {
            // Tab out of an open menu closes it (APG). Not prevented — focus
            // carries on to whatever is next; what must not happen is the menu
            // staying up with the keyboard somewhere else entirely.
            if (e.key === 'Tab') {
              closeMenu(false);
              return;
            }
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')
            );
            if (items.length === 0) return;
            const at = items.indexOf(e.currentTarget.ownerDocument.activeElement as HTMLElement);
            const go = (i: number): void => {
              e.preventDefault();
              // wrap: a context menu is a closed ring, and a Down that does
              // nothing on the last item reads as a stuck key
              items[(i + items.length) % items.length].focus();
            };
            if (e.key === 'ArrowDown') go(at + 1);
            else if (e.key === 'ArrowUp') go(at <= 0 ? items.length - 1 : at - 1);
            else if (e.key === 'Home') go(0);
            else if (e.key === 'End') go(items.length - 1);
          }}
          style={{
            position: 'fixed',
            // Before the measuring pass above has answered, the menu is parked
            // in the corner rather than at the pointer, and NOT because the
            // corner is a sensible place for it: this render exists only to be
            // measured (the layout effect's setState re-renders synchronously,
            // so the browser paints once, already placed). At `0` the box has
            // the whole window to lay out in and reports its NATURAL size,
            // where an inset taken from the pointer squeezes it against the far
            // edge and measures something narrower and taller than the menu the
            // user will see. It is also the only value that needs no direction:
            // `menu.x` is physical and this property is logical (#642).
            insetInlineStart: menuPlace ? menuPlace.insetInlineStart : 0,
            insetBlockStart: menuPlace ? menuPlace.insetBlockStart : 0,
            // ...and not shown until it has been. A hidden box still lays out,
            // so the measurement is unaffected, and the argument above stops
            // being an argument: if the placement ever failed to land, the menu
            // would be absent rather than sitting in the wrong corner — which
            // is a loud failure instead of a quiet one.
            visibility: menuPlace ? undefined : 'hidden',
            // only ever reached by a menu taller than the whole window; with a
            // scroll container of its own, `scrollIntoView` can finally do
            // something for the items past the fold
            maxBlockSize: menuPlace?.maxBlockSize,
            overflowY: 'auto',
            zIndex: 50,
            minInlineSize: 150,
            background: 'var(--rail-card)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: 'var(--window-shadow)',
            padding: 4,
            fontSize: 11,
          }}
        >
          {/* [label, what it does, does it owe focus back?]. Only Rename and
              Close move focus themselves — Rename autofocuses its field, and
              Close is about to remove the row. "Open changes" just switches the
              card's view, so without the restore a keyboard user who picked it
              would be left standing at the top of the document.

              §5.8's PIN (E9-09) is one of these rather than a checkbox item,
              and sits between Rename and Close: its LABEL says which way it
              will go, which is the same rule the palette follows ("an entry has
              to say what it will DO"), and it is what VS Code's own pinned-tab
              menu does. A `menuitemcheckbox` with a tick column would be the
              only item in this list carrying one, indenting its label away from
              the other three for a state the label already spells out.

              It restores focus to the row whose pin you just changed — but NOT
              synchronously, and #295 is why: the row is re-parented into (or out
              of) the sticky pinned block, which unmounts and remounts it, so the
              node this menu was opened from is detached by then. The errand is
              handed to `pendingPin` and finished by the effect that watches
              `props.pinned`, exactly as a cross-group move is. */}
          {(
            [
              ['rail.menuDiff', () => props.onDiff(menu.session), true],
              [
                'rail.menuRename',
                () => {
                  setEditing(menu.session.id);
                  setDraft(menu.session.title);
                },
                false,
              ],
              [
                props.pinned.has(menu.session.id) ? 'rail.menuUnpin' : 'rail.menuPin',
                () => {
                  pendingPin.current = {
                    cardId: menu.session.id,
                    want: !props.pinned.has(menu.session.id),
                  };
                  props.onTogglePin(menu.session.id);
                },
                false,
              ],
              ['rail.menuClose', () => props.onClose(menu.session.id), false],
            ] as const
          ).map(([key, run, restoreFocus]) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              className="rail-menu-item"
              onClick={() => {
                closeMenu(restoreFocus);
                run();
              }}
              style={menuItemStyle}
            >
              {t(key)}
            </button>
          ))}
          {/* #559 — the OTHER drag-only interaction, answered the same way.
              Dragging a row up or down inside its group had no keyboard path at
              all, which is 2.1.1 for the whole gesture (§5.32's fifth rule).

              COMMANDS, not radios: a step is not a destination out of a known
              set, so there is nothing for a tick to point at. They call the
              same `onReorder` the drop calls and reach the same rule for
              whether the move is allowed, so the two paths cannot drift.

              `aria-disabled` and not `disabled` at the ends of a group: this
              menu's arrow walk collects `[role^="menuitem"]` and focuses them,
              and `focus()` on a disabled button does nothing at all — the walk
              would stop dead on the row nobody can leave. Present, focusable,
              announced as unavailable, is what APG asks for and what keeps the
              ring whole.

              Absent entirely for a group of one, which is the same rule that
              hides the Move-to-group set when there are no groups: an offer
              that cannot do anything wastes more time than a missing one. */}
          {(order.buckets.get(order.bucketOf.get(menu.session.id) ?? '')?.length ?? 0) > 1 && (
            <div role="group" aria-label={t('rail.menuOrder')}>
              <div aria-hidden style={menuSectionStyle}>
                {t('rail.menuOrder')}
              </div>
              {([
                ['rail.menuMoveUp', -1],
                ['rail.menuMoveDown', 1],
              ] as const).map(([key, delta]) => {
                const bucket = order.bucketOf.get(menu.session.id);
                const ids = bucket ? (order.buckets.get(bucket) ?? []) : [];
                // the SAME question the move itself asks, through the same
                // function — an item can never be offered and then decline
                const can = !!bucket && canStep(ids, menu.session.id, delta, props.pinned);
                return (
                  <button
                    key={key}
                    type="button"
                    role="menuitem"
                    aria-disabled={!can}
                    data-order-item={delta < 0 ? 'up' : 'down'}
                    className="rail-menu-item"
                    onClick={() => {
                      if (!can) return; // aria-disabled is a claim; this is the fact
                      // Focus is restored NOW and not after the change lands,
                      // which is the one place this differs from #253's move:
                      // a reorder keeps the same keyed row, so React MOVES the
                      // node rather than re-parenting it into another card, and
                      // the button the menu was opened from is still mounted.
                      closeMenu(true);
                      stepRow(menu.session, delta);
                    }}
                    style={{ ...menuItemStyle, opacity: can ? 1 : 0.45 }}
                  >
                    {/* the same 12px gutter the ticked sets keep, so the labels
                        in this menu all start at one margin */}
                    <span aria-hidden style={{ display: 'inline-block', inlineSize: 12 }} />
                    {t(key)}
                  </button>
                );
              })}
            </div>
          )}
          {/* #253 — the keyboard's way to do what only a drag could do.
              A session's group was reachable by dragging its row onto a group
              card and no other way, so the whole interaction failed WCAG 2.1.1
              — the one gap #197's sweep left, because it needed an interaction,
              not a label.

              RADIOS, not a "Move to group ▸" submenu: membership is exactly one
              choice out of a known set, which is what `menuitemradio` means and
              what the presentation set below already looks like. It also costs
              no new keyboard mode — the arrow walk on the menu selects
              `[role^="menuitem"]`, so these join the ring for free, where a
              submenu would have meant a second focus context to get right, and
              a menu you can open but not leave is the trap this sweep exists
              to avoid.

              This is NOT a parallel mechanism: it calls `onMoveToGroup`, the
              same prop the drop handler calls, and repeats the drop's guard
              that a move to where you already are is a no-op rather than a
              round trip through IPC and a grid reshuffle.

              AUTO-GROUPS are deliberately absent. Their membership is computed
              from the session's folder, so an entry for one would be a command
              that does nothing — and refusing to advertise that is exactly why
              the drop handler declines them. A session sitting in an auto-group
              shows as "Ungrouped" here, which is the truth this list is about:
              it is in no group you made. */}
          {props.groups.length > 0 && (
            <div role="group" aria-label={t('rail.menuMove')}>
              <div aria-hidden style={menuSectionStyle}>
                {t('rail.menuMove')}
              </div>
              {[
                ...props.groups.map((g) => [g.id, g.name] as const),
                // the trailing bucket, last for the same reason it is last in
                // the rail itself: it is an absence, not a thing
                [null, t('rail.ungrouped')] as const,
              ].map(([gid, label]) => {
                // read membership LIVE, exactly as the drop handler does: the
                // menu's session is a snapshot from when it opened, and a card
                // dragged in another window while it stands open would leave
                // the tick pointing at a group the session has already left
                const from = props.sessions.find((s) => s.id === menu.session.id)?.groupId ?? null;
                const here = from === gid;
                return (
                  <button
                    key={gid ?? 'ungrouped'}
                    type="button"
                    role="menuitemradio"
                    aria-checked={here}
                    data-move-item={gid ?? 'ungrouped'}
                    className="rail-menu-item"
                    onClick={() => {
                      if (here) {
                        // already there: close, and give the row its focus back
                        closeMenu(true);
                        return;
                      }
                      pendingMove.current = {
                        cardId: menu.session.id,
                        to: gid,
                        destKey: gid ?? 'ungrouped',
                        said: gid
                          ? t('rail.movedTo', { title: menu.session.title, group: label })
                          : t('rail.movedOut', { title: menu.session.title }),
                      };
                      // Restore focus NOW as well as when it lands: this puts
                      // the keyboard on the row it is about to move rather than
                      // on <body> for the length of the round trip — and if the
                      // move never lands, that is still where it should be.
                      closeMenu(true);
                      props.onMoveToGroup(menu.session.id, gid);
                    }}
                    style={{ ...menuItemStyle, fontWeight: here ? 700 : 400 }}
                  >
                    {/* the tick keeps its column whether or not it is drawn */}
                    <span aria-hidden style={{ display: 'inline-block', inlineSize: 12 }}>
                      {here ? '✓' : ''}
                    </span>
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {/* §5.8's per-SESSION presentation override (E9-06). Named values
              rather than one cycling row: a menu closes when you click it, so a
              cycle would cost a right-click per step — and the point of an
              override is to say what you want, not to walk past it.
              A labelled group, so the radio set reads as one choice to a screen
              reader rather than four loose items after three commands. */}
          <OverrideGroup
            label={t('ladder.policyMenu')}
            values={POLICY_ORDER}
            own={cardOverride(props.policies, menu.session.id)}
            itemAttr="data-policy-item"
            itemStyle={menuItemStyle}
            labelOf={(policy) => t(`policy.${policy}`)}
            defaultLabel={t('ladder.policyDefault', {
              // what following the default MEANS for this session right now —
              // which may be its group's override, not the global
              policy: t(
                `policy.${resolvePolicy({ ...props.policies, cards: {} }, menu.session.id, menu.session.groupId)}`
              ),
            })}
            onPick={(policy) => {
              // this one DOES restore focus: the choice is a property of the
              // row, and the row is still there afterwards
              closeMenu(true);
              props.onSetSessionPolicy(menu.session.id, policy);
            }}
          />
          {/* §5.8's per-SESSION FOCUS-STEALING override (E9-10) — the same
              widget, one question later: that group says what happens when YOU
              submit, this one says what happens when the SESSION calls. They
              are neighbours because "this session is allowed to interrupt me"
              and "this session gets out of my way" are the two halves of how
              loud one session is, and nobody should have to look in two places
              for them. */}
          <OverrideGroup
            label={t('ladder.focusMenu')}
            values={FOCUS_POLICY_ORDER}
            own={focusOverride(props.focusPolicies, menu.session.id)}
            itemAttr="data-focus-item"
            itemStyle={menuItemStyle}
            labelOf={(policy) => t(`focusPolicy.${policy}`)}
            defaultLabel={t('ladder.focusDefault', {
              policy: t(
                `focusPolicy.${resolveFocusPolicy({ ...props.focusPolicies, cards: {} }, menu.session.id)}`
              ),
            })}
            onPick={(policy) => {
              closeMenu(true);
              props.onSetSessionFocusPolicy(menu.session.id, policy);
            }}
          />
        </div>
      )}
    </nav>
  );
}
