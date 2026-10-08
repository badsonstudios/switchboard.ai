// The sessions strip across the top (#1143).
//
// The other place the sessions can be listed: one line of controls and, under
// it, one row that holds the groups and then the loose sessions. While it is
// on, the left rail, the lamps row and the collapsed row are all gone; this
// strip is what replaces the three of them:
//
//  - the RAIL, by listing every session: a group is an entry that drops down a
//    list of its sessions as full rows (the rail's own `SessionRow`), and a
//    session outside any group is a pill;
//  - the LAMPS ROW, by carrying the one "N need you" total, by lighting the
//    entry the last jump landed on, and by running that beat itself
//    (`useUrgencyBeat`) now that the lamps are not there to;
//  - the COLLAPSED ROW, by drawing a folded-away session with a dashed edge —
//    its pill, or its row in a group's list, with the group saying how many —
//    and bringing it back on a click.
//
// PUT AWAY (Ctrl+B), IT IS SIMPLY NOT THERE, and App brings the lamps row and
// the collapsed row back while it is gone: with nothing listing the sessions,
// those two are the only "N need you" and the only way back to a collapsed
// one. So exactly one of the lamps row and this strip is ever mounted, and
// whichever it is runs the beat.
//
// The row scrolls sideways when it does not fit, and a fixed cell at each end
// says what is past that edge — in amber, with a number, when it is a session
// that needs you.
//
// RIGHT-CLICK IS THE MENU, everywhere on the strip, and there is no menu icon:
// on a session (its pill, or its row in an open list), on a group, and on an
// empty part of the strip. None of the three has an ordering item — order is
// by dragging, which lands in its own change.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { RailGroup, RailSession } from '../model/types';
import { autoGroupName, RailOrderResult } from '../lib/groups';
import { needCount } from '../lib/rail-view';
import { useHeldCounts } from '../lib/sibling-inbox';
import { edgeOverflow, EdgeState, sameEdges } from '../lib/strip-overflow';
import { isLit, UrgencyMarks } from '../lib/urgency';
import { useUrgencyBeat } from '../lib/use-urgency-beat';
import { tint } from '../lib/tint';
import { directionOf } from '../lib/writing-direction';
import { groupOverride, PolicyBook } from '../lib/presentation-policy';
import type { SessionsPlacement } from '../lib/sessions-placement';
import { RailGroupMenu, RailGroupMenuItem } from './RailGroupMenu';
import { StripRenameBox } from './StripRenameBox';
import { SessionRow } from './SessionRow';
import { LAST_CHORD, StripGroupEntry } from './StripGroupEntry';
import { StripPill } from './StripPill';

/** the list's width: the rail's default, so a row reads the same in both */
const LIST_WIDTH = 286;

/**
 * Where the list's inline-START edge goes: under the entry's own start edge,
 * in whichever direction that is, but always wholly inside the window.
 *
 * Clamped at BOTH ends. An entry half scrolled off the start of the row has a
 * negative edge, and a list hung from it would open partly off-window — with
 * the cut-off side being the one that carries the shortcut number and the
 * start of every name.
 */
export function listStart(
  box: { left: number; right: number },
  rtl: boolean,
  windowWidth: number
): number {
  const margin = 8;
  const want = rtl ? windowWidth - box.right : box.left;
  const room = Math.max(margin, windowWidth - LIST_WIDTH - margin);
  return Math.max(margin, Math.min(want, room));
}

/** A group key made safe to put in an `id` — the rail's own escape (#197): an
 *  automatic group's key is a folder path, and an IDREF cannot hold one. */
const idSafe = (key: string): string =>
  key.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);

export interface SessionsStripProps {
  /**
   * Gated INSIDE, like the banners in the shell column: App renders this
   * unconditionally and says whether it is wanted, so the shell's children stay
   * a flat list `always-visible-notices.test.ts` can read off the file.
   */
  shown: boolean;
  /** the groups the user made, in their stored order — name and colour */
  groups: readonly RailGroup[];
  /**
   * The store's ONE derivation of who is where (`getRailOrder()`), the same
   * object the rail's order and `Ctrl+1..9` come from. Handed in rather than
   * recomputed so the strip cannot come to disagree with the keyboard about
   * which session is third.
   */
  order: RailOrderResult<RailSession>;
  /** the cards with an outstanding demand (#621) — REQUIRED for the rail's reason */
  needing: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
  /** the cards that are collapsed or hidden: not on screen until asked for */
  folded: ReadonlySet<string>;
  /** card id -> when its post-jump highlight expires (store state, §5.8) */
  urgency: UrgencyMarks;
  /** a beat has passed — ask the store to put it out. Must be stable. */
  onExpire: () => void;
  /** these marks are on the screen — start their beat. Must be stable. */
  onBeatStart: (cardIds: readonly string[]) => void;
  /** the card the grid is currently showing */
  selectedId?: string | null;
  /** how many lines a task label may take in a list's rows (#877) */
  labelLines?: number;
  onCreateGroup: (name: string) => void;
  onNewSession: () => void;
  /** open a NEW session inside this group */
  onOpenInGroup: (groupId: string) => void;
  onFocus: (cardId: string) => void;
  /** end a session (the app confirms first — it forgets the record) */
  onClose: (cardId: string) => void;
  // ── what the menus do. Each is the SAME handler the rail is given, so a
  // ── gesture means one thing whichever list it was made in.
  onDiff: (s: RailSession) => void;
  onRename: (cardId: string, title: string) => void;
  onTogglePin: (cardId: string) => void;
  /** `null` takes the session out of every group */
  onMoveToGroup: (cardId: string, groupId: string | null) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  /** the colours a group may be: persisted data owned by the main process */
  palette: readonly string[];
  onRecolorGroup: (groupId: string, color: string) => void;
  /** §5.8's presentation policy, for a group's own override */
  policies: PolicyBook;
  onCycleGroupPolicy: (groupId: string) => void;
  onDeleteGroup: (groupId: string) => void;
  /** bring every one of these cards back into the workspace */
  onOpenAll: (cardIds: readonly string[]) => void;
  /** list the sessions somewhere else — the strip's own door to the setting */
  onPlace: (placement: SessionsPlacement) => void;
}

/** which of the strip's three menus is open, and where it was asked for */
type StripMenu = { x: number; y: number } & (
  | { kind: 'session'; id: string; from: 'pill' | 'row' }
  | { kind: 'group'; key: string }
  | { kind: 'strip' }
);

/**
 * Where a menu opens: at the pointer, or — for Shift+F10 and the ContextMenu
 * key, which fire the same event with no pointer and report (0, 0) — just
 * inside the inline-start edge of the thing it is for, under it. The rail's
 * rule (#526, #642), for the rail's reason: otherwise the keyboard's menu opens
 * in the window's top-left corner.
 */
function menuPoint(e: React.MouseEvent<HTMLElement>): { x: number; y: number } {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const box = e.currentTarget.getBoundingClientRect();
  const rtl = directionOf(e.currentTarget) === 'rtl';
  return { x: rtl ? box.right - 12 : box.left + 12, y: box.bottom };
}

/** a text box owes its user the EDIT menu before it owes anyone ours (#526) */
const inTextBox = (e: React.MouseEvent<HTMLElement>): boolean =>
  (e.target as HTMLElement).closest?.('input, textarea, [contenteditable="true"]') != null;

export function SessionsStrip(props: SessionsStripProps): React.JSX.Element | null {
  if (!props.shown) return null;
  return <Strip {...props} />;
}

const NO_EDGE: EdgeState = { cut: false, need: 0 };
const NO_EDGES = { before: NO_EDGE, after: NO_EDGE };

/**
 * The fixed cell at one end of the row: what is past that edge.
 *
 * Amber with a number when a session that needs you is off that way; quiet
 * when sessions are cut off but none is waiting; inert when nothing is. A
 * click scrolls that way. It is a sibling of the scrolling row, never laid
 * over it, so it cannot sit on top of a pill.
 */
function EdgeCell(props: {
  side: 'start' | 'end';
  edge: EdgeState;
  onScroll: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { cut, need } = props.edge;
  const amber = 'var(--status-needs-input)';
  return (
    <button
      type="button"
      data-strip-edge={props.side}
      data-strip-edge-need={need}
      aria-disabled={cut ? undefined : true}
      aria-label={
        need > 0
          ? t('strip.edgeNeed', { count: need })
          : cut
            ? t('strip.edgeMore')
            : t('strip.edgeNone')
      }
      onClick={() => {
        if (cut) props.onScroll();
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        flexShrink: 0,
        inlineSize: 30,
        marginBlock: 4,
        marginInline: 4,
        padding: 0,
        borderRadius: 6,
        border: `1px solid ${need > 0 ? tint(amber, 55) : 'var(--border)'}`,
        background: need > 0 ? tint(amber, 18) : 'transparent',
        color: need > 0 ? 'var(--status-needs-input-ink)' : cut ? 'var(--muted)' : 'var(--faint)',
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1.1,
        cursor: cut ? 'pointer' : 'default',
      }}
    >
      <span aria-hidden>{t(props.side === 'start' ? 'strip.edgeStartIcon' : 'strip.edgeEndIcon')}</span>
      {need > 0 && <span aria-hidden>{need}</span>}
    </button>
  );
}

/** one entry on the strip, whichever kind of group it is */
interface Entry {
  key: string;
  kind: 'group' | 'auto';
  name: string;
  color: string;
  members: RailSession[];
  /** a made group's id — what a new session is opened into */
  groupId?: string;
}

function Strip(props: SessionsStripProps): React.JSX.Element {
  const { t } = useTranslation();
  const { order } = props;
  const stripRef = React.useRef<HTMLDivElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  // what is past each end of the row, by INLINE direction: `before` is the
  // start edge, wherever that is
  const [edges, setEdges] = React.useState(NO_EDGES);
  const [menu, setMenu] = React.useState<StripMenu | null>(null);
  // The keyboard goes back to what was acted on. A menu item usually changes
  // the very thing it was opened from — a pin re-sorts the pills, a move turns
  // a pill into a row, a rename swaps a box for a pill — so the element that
  // had focus is gone by the time the action lands, and focus would fall to
  // <body>. This holds WHO should have it, and the effect below hands it
  // over once they are on screen again. It expires, so a session that never
  // comes back cannot grab the keyboard minutes later.
  const refocus = React.useRef<{ kind: 'session' | 'group' | 'strip'; id: string; at: number } | null>(
    null
  );
  // What is being renamed, and where its box is: a pill and a group entry
  // are REPLACED by a box (`StripRenameBox`); a row in a list edits in place,
  // with its draft held here for the reason `SessionRow`'s field gives.
  const [renaming, setRenaming] = React.useState<{
    where: 'pill' | 'row' | 'group';
    id: string;
  } | null>(null);
  const [draft, setDraft] = React.useState('');

  // The lamps row is not on screen in this placement, so the beat is ours.
  useUrgencyBeat(props.urgency, props.onExpire, props.onBeatStart);
  // One render's worth of "now", for the reason the lamps row gives: reading
  // the clock per entry could put two of them on opposite sides of the same
  // deadline within a single paint.
  const now = Date.now();
  const flashing = (id: string): boolean => isLit(props.urgency, id, now);
  // #654: an id is generated, never published — a literal one is a name that
  // rendered content could take away from the element it was meant for
  const uid = React.useId();
  const listIdOf = (key: string): string => `${uid}list-${idSafe(key)}`;
  // Which group's list is open, and where it was put. The place is measured
  // once, when it opens: the list is `position: fixed` so the row's sideways
  // scroll cannot clip it, which also means nothing moves it afterwards — so
  // anything that would leave it pointing at the wrong spot closes it instead.
  const [open, setOpen] = React.useState<{ key: string; top: number; start: number } | null>(null);

  const waiting = useHeldCounts(order.flat.map((s) => s.id));
  const ordinalOf = React.useMemo(
    () => new Map(order.flat.map((s, i) => [s.id, i + 1])),
    [order.flat]
  );

  // Groups first — yours in the order you put them, then the automatic ones —
  // exactly the rail's order, which is the order `Ctrl+1..9` counts in.
  //
  // The ORDER decides which groups there are and who is in them; `props.groups`
  // is only asked what each one is called and what colour it is. Walking the
  // names instead would let a group the order knows and the names do not drop
  // its sessions off the strip while the total above still counted them.
  const named = new Map(props.groups.map((g) => [g.id, g]));
  const entries: Entry[] = [
    ...order.groups.map(
      (g): Entry => ({
        key: g.id,
        kind: 'group',
        name: named.get(g.id)?.name ?? '',
        color: named.get(g.id)?.color ?? 'var(--muted)',
        members: g.members,
        groupId: g.id,
      })
    ),
    ...order.autoGroups.map(
      (ag): Entry => ({
        key: `auto:${ag.key}`,
        kind: 'auto',
        name: autoGroupName(ag.key),
        color: 'var(--auto-ink)',
        members: ag.members,
      })
    ),
  ];
  const openEntry = open ? entries.find((e) => e.key === open.key) : undefined;

  // the open key again, for handlers that must read it without being rebuilt
  const openKeyRef = React.useRef<string | null>(null);
  openKeyRef.current = open?.key ?? null;

  /** the open group's own button — the thing Escape hands the keyboard back to */
  const openerOf = (key: string): HTMLElement | undefined =>
    // found by comparing, not by building a selector: an automatic group's
    // key is a folder path, full of characters a selector would choke on
    Array.from(
      stripRef.current?.querySelectorAll<HTMLElement>('[data-strip-group-open]') ?? []
    ).find((el) => el.dataset.stripGroupOpen === key);

  const close = React.useCallback((restoreFocus: boolean): void => {
    const was = openKeyRef.current;
    setOpen(null);
    // a row being renamed goes with its list; a pill or a group does not
    setRenaming((r) => (r?.where === 'row' ? null : r));
    // outside the state updater, which must stay pure
    if (was !== null && restoreFocus) openerOf(was)?.focus();
  }, []);

  // A group that was deleted, or emptied into nothing, while its list was open.
  const openKey = open?.key;
  const openStillThere = openEntry !== undefined;
  React.useEffect(() => {
    if (openKey !== undefined && !openStillThere) close(false);
  }, [openKey, openStillThere, close]);

  // You went somewhere — by `Ctrl+N`, the palette, a lamp, anything. The list
  // was a way of choosing where to go; left open it would sit over the card
  // you just arrived at.
  const selectedId = props.selectedId;
  const selectedAtOpen = React.useRef(selectedId);
  React.useEffect(() => {
    if (openKey === undefined) {
      selectedAtOpen.current = selectedId;
      return;
    }
    if (selectedId === selectedAtOpen.current) return;
    // …unless the place you went is IN this list and you got there by the
    // jump that lights things up: then the list is showing you where you
    // landed, and its row is the thing that is lit.
    const landedHere =
      selectedId != null &&
      props.urgency.has(selectedId) &&
      (openEntry?.members.some((m) => m.id === selectedId) ?? false);
    if (landedHere) {
      selectedAtOpen.current = selectedId;
      return;
    }
    close(false);
    // `openEntry` and the marks are read as of the selection change, on purpose
  }, [openKey, selectedId, close]);

  // Outside clicks, Escape, and anything that moves the entry out from under
  // the list. `mousedown` rather than `click`, so the list is gone before the
  // thing that was clicked acts — the idiom the rail's context menu uses.
  React.useEffect(() => {
    if (openKey === undefined) return;
    /** is this node part of the open list, or of the entry it hangs from */
    const ours = (at: Node | null): boolean => {
      if (listRef.current?.contains(at)) return true;
      // a menu opened from a row belongs to the list: choosing Rename in it
      // must not close the list the row being renamed is in
      if ((at as HTMLElement | null)?.closest?.('[data-testid="strip-menu"]')) return true;
      const cell = (at as HTMLElement | null)?.closest?.<HTMLElement>('[data-strip-group]');
      return cell?.dataset.stripGroup === openKey;
    };
    const onDown = (e: MouseEvent): void => {
      // the entry's own buttons toggle; closing here first would reopen it
      if (!ours(e.target as Node | null)) close(false);
    };
    // ESCAPE IS NOT GRABBED. This listens on the document because the list is
    // not an ancestor of its entry, but it acts only on an Escape that is OURS
    // — pressed in the list or on the entry — and only that one is stopped.
    // Anything else on screen (a dialog opened by a chord while the list was
    // up, the palette) gets its own Escape untouched; taking it would close
    // this list and leave that dialog one that will not close. An Escape with
    // focus stranded on <body> is nobody's, so it may as well put the list
    // away, without being stopped. EventsDrawer does the same.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const at = e.target as Node | null;
      // a rename box and a menu each own their Escape: that ends the edit or
      // the menu, not the list under them
      if ((at as HTMLElement | null)?.closest?.('input, textarea, [role="menu"]')) return;
      if (ours(at)) {
        e.stopPropagation();
        close(true);
      } else if (at === document.body) {
        close(false);
      }
    };
    const onMove = (): void => close(false);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
    };
  }, [openKey, close]);

  // Opened: put the keyboard in the list, on its first row. Without this a
  // keyboard user opens a list and is still standing on the entry, with the
  // rows somewhere after every other control on the page.
  React.useEffect(() => {
    if (openKey === undefined) return;
    listRef.current?.querySelector<HTMLElement>('[data-rail-open]')?.focus();
  }, [openKey]);

  const toggle = (key: string, anchor: HTMLElement): void => {
    if (open?.key === key) {
      close(false);
      return;
    }
    const box = anchor.getBoundingClientRect();
    setOpen({
      key,
      top: box.bottom + 3,
      start: listStart(box, directionOf(anchor) === 'rtl', window.innerWidth),
    });
  };

  const lineButton: React.CSSProperties = {
    background: 'transparent',
    color: 'var(--muted)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-chip)',
    padding: '1px 8px',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
    fontSize: 10.5,
    whiteSpace: 'nowrap',
  };

  // ── what is past each end ──────────────────────────────────────────────────
  //
  // Measured, because it cannot be derived: it depends on how wide the window
  // is, how long each name is and how far the row has been scrolled. Each entry
  // carries `data-strip-item-need` — how many waiting sessions it stands for — so
  // the measurement reads the same number the entry is showing.
  const measure = React.useCallback((): void => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const view = sc.getBoundingClientRect();
    const items = Array.from(sc.querySelectorAll<HTMLElement>('[data-strip-item-need]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { from: r.left, to: r.right, need: Number(el.dataset.stripItemNeed) || 0 };
    });
    const physical = edgeOverflow(items, view.left, view.right);
    // the arithmetic is in pixels, left to right; "start" is the right-hand
    // end when the page reads the other way
    const next =
      directionOf(sc) === 'rtl'
        ? { before: physical.after, after: physical.before }
        : physical;
    setEdges((was) => (sameEdges(was, next) ? was : next));
  }, []);
  // Re-measured when something that MOVES A BOX changed — who is where and
  // what they are called (`order`), who is lit, folded, pinned or has messages
  // waiting, and the cells themselves appearing — none of which is a resize
  // or a scroll. Not on every render: this reads layout, and App re-renders
  // this component for reasons that have nothing to do with the row.
  // `setEdges` keeps the old object when nothing changed, so this settles.
  React.useLayoutEffect(() => {
    measure();
  }, [measure, order, props.needing, props.folded, props.pinned, waiting, edges]);
  React.useEffect(() => {
    window.addEventListener('resize', measure);
    // fail-open: no ResizeObserver costs the re-measure when a banner above
    // changes the layout, and the next render or scroll catches that up
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (ro && scrollerRef.current) ro.observe(scrollerRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [measure]);
  const overflowing = edges.before.cut || edges.after.cut;
  const scrollToward = (side: 'start' | 'end'): void => {
    const sc = scrollerRef.current;
    if (!sc) return;
    // most of a screenful, so something you just read is still in view
    const step = Math.max(120, sc.clientWidth * 0.8);
    const towardRight = (side === 'end') !== (directionOf(sc) === 'rtl');
    sc.scrollBy?.({ left: towardRight ? step : -step, behavior: 'smooth' });
  };

  // ── the jump lands somewhere you can see ───────────────────────────────────
  //
  // A jump lights the entry it landed on; if that entry is scrolled out of
  // the row, the light is on something off screen. So a NEW mark also brings
  // its entry into view: the pill, or the group that holds the session.
  const seenMarks = React.useRef<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    const sc = scrollerRef.current;
    const fresh = [...props.urgency.keys()].filter((id) => !seenMarks.current.has(id));
    seenMarks.current = new Set(props.urgency.keys());
    if (!sc || fresh.length === 0) return;
    const id = fresh[fresh.length - 1];
    const holder = entries.find((e) => e.members.some((m) => m.id === id));
    const el = holder
      ? Array.from(sc.querySelectorAll<HTMLElement>('[data-strip-group]')).find(
          (n) => n.dataset.stripGroup === holder.key
        )
      : Array.from(sc.querySelectorAll<HTMLElement>('[data-strip-pill]')).find(
          (n) => n.dataset.stripPill === id
        );
    if (!el) return;
    // by hand, on this one scroller: `scrollIntoView` also scrolls every
    // scrollable ancestor, and the only thing that should move is the row
    const view = sc.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (box.left < view.left) sc.scrollLeft -= view.left - box.left + 8;
    else if (box.right > view.right) sc.scrollLeft += box.right - view.right + 8;
    // `entries` is rebuilt every render and deliberately not a dependency:
    // this runs when a mark ARRIVES, and reads whatever the row holds then
  }, [props.urgency]);

  /** the control that stands for a session or a group, wherever it is now */
  const controlOf = (kind: 'session' | 'group' | 'strip', id: string): HTMLElement | undefined => {
    const within = stripRef.current;
    if (kind === 'strip') return within?.querySelector<HTMLElement>('[data-strip-add-group]') ?? undefined;
    if (kind === 'group') return openerOf(id);
    const find = (sel: string, attr: string): HTMLElement | undefined =>
      Array.from(within?.querySelectorAll<HTMLElement>(sel) ?? []).find(
        (el) => el.getAttribute(attr) === id
      );
    return find('[data-strip-pill]', 'data-strip-pill') ?? find('[data-rail-open]', 'data-rail-open');
  };
  const focusTarget = (m: StripMenu): void => {
    if (m.kind === 'session') controlOf('session', m.id)?.focus();
    else if (m.kind === 'group') controlOf('group', m.key)?.focus();
    else controlOf('strip', '')?.focus();
  };
  /** ask for the keyboard back on this once it is (back) on screen */
  const ran = (kind: 'session' | 'group' | 'strip', id: string): void => {
    refocus.current = { kind, id, at: Date.now() };
  };
  React.useEffect(() => {
    const want = refocus.current;
    if (!want) return;
    if (Date.now() - want.at > 2000) {
      refocus.current = null;
      return;
    }
    // never out of a text box: a rename that just opened is where it belongs
    if ((document.activeElement as HTMLElement | null)?.closest?.('input, textarea')) return;
    const el = controlOf(want.kind, want.id);
    if (!el) return;
    refocus.current = null;
    el.focus();
  });

  // ── nothing may outlive what it was about ──────────────────────────────────
  //
  // A rename box and a menu are both ABOUT one thing on the strip, and that
  // thing can leave without anyone touching it: a second session opening in
  // the same folder turns a pill into a row of an automatic group; a session
  // closes; a list closes under its row. Left set, the state would come back
  // to life when the thing does — a rename box reappearing with focus in the
  // middle of whatever you were typing, or a menu redrawn at old coordinates.
  // So each is dropped the moment its target is not where it was.
  const renamingStillThere =
    renaming === null ||
    (renaming.where === 'pill' && order.loose.some((s) => s.id === renaming.id)) ||
    (renaming.where === 'row' && (openEntry?.members.some((m) => m.id === renaming.id) ?? false)) ||
    (renaming.where === 'group' && entries.some((e) => e.key === renaming.id && e.groupId !== undefined));
  React.useEffect(() => {
    if (!renamingStillThere) setRenaming(null);
  }, [renamingStillThere]);

  // ── the three menus ────────────────────────────────────────────────────────
  //
  // Built when one is open, from what the strip holds NOW: a session that was
  // closed, or a group that was deleted, while its menu was up yields no items
  // and the menu is simply not drawn.
  const menuItems = ((): { label: string; items: RailGroupMenuItem[] } | null => {
    if (!menu) return null;
    if (menu.kind === 'session') {
      const s = order.flat.find((x) => x.id === menu.id);
      if (!s) return null;
      // #687: a card main has never heard of cannot be renamed or regrouped —
      // both are writes main declines for a card it has no record of. Dimmed
      // here for the reason the rail dims them: an item must never be offered
      // and then do nothing.
      const started = s.status !== 'not-started';
      const isPinned = props.pinned.has(s.id);
      const items: RailGroupMenuItem[] = [
        {
          id: 'diff',
          label: t('rail.menuDiff'),
          can: true,
          run: () => {
            ran('session', s.id);
            props.onDiff(s);
          },
        },
        {
          id: 'rename',
          label: t('rail.menuRename'),
          can: started,
          run: () => {
            // a row can only be edited in a list that is still open: it may
            // have closed under this menu (a jump, a scroll) with no click
            if (menu.from === 'row' && !openEntry?.members.some((m) => m.id === s.id)) return;
            setDraft(s.title);
            setRenaming({ where: menu.from, id: s.id });
          },
        },
        {
          id: 'pin',
          label: t(isPinned ? 'rail.menuUnpin' : 'rail.menuPin'),
          can: true,
          run: () => {
            ran('session', s.id);
            props.onTogglePin(s.id);
          },
        },
        {
          id: 'close',
          label: t('rail.menuClose'),
          can: true,
          run: () => {
            // if you answer "no" to the question, you are back where you were
            ran('session', s.id);
            props.onClose(s.id);
          },
        },
        // MOVE TO GROUP: one choice out of a known set — each of your groups,
        // and none. The current one is checked, and choosing it does nothing.
        ...props.groups.map(
          (g, i): RailGroupMenuItem => ({
            id: `move:${g.id}`,
            label: g.name,
            can: started,
            checked: s.groupId === g.id,
            ...(i === 0 ? { heading: t('rail.menuMove') } : {}),
            run: () => {
              ran('session', s.id);
              if (s.groupId !== g.id) props.onMoveToGroup(s.id, g.id);
            },
          })
        ),
        {
          id: 'move:none',
          label: t('strip.menuNoGroup'),
          can: started,
          checked: !s.groupId,
          ...(props.groups.length === 0 ? { heading: t('rail.menuMove') } : {}),
          run: () => {
            ran('session', s.id);
            if (s.groupId) props.onMoveToGroup(s.id, null);
          },
        },
      ];
      return { label: t('rail.menuLabel', { title: s.title }), items };
    }
    if (menu.kind === 'group') {
      const e = entries.find((x) => x.key === menu.key);
      if (!e) return null;
      const openAll: RailGroupMenuItem = {
        id: 'open-all',
        label: t('strip.menuOpenAll'),
        // ONLY the ones that are folded away, and dimmed when none is: a
        // session that is on screen, or behind a tab you can see, is not
        // something to "open", and pulling a tabbed one out of its stack
        // would be rearranging the workspace under the name of un-folding it
        can: e.members.some((m) => props.folded.has(m.id)),
        run: () => {
          ran('group', e.key);
          props.onOpenAll(e.members.filter((m) => props.folded.has(m.id)).map((m) => m.id));
        },
      };
      const groupId = e.groupId;
      // AN AUTOMATIC GROUP is a folder the app noticed, not a thing you made:
      // it has no name to change, no colour, nothing to delete, and a session
      // cannot be opened "into" it. Opening what it holds is all there is.
      if (groupId === undefined) return { label: t('rail.groupMenuLabel', { name: e.name }), items: [openAll] };
      const own = groupOverride(props.policies, groupId);
      const items: RailGroupMenuItem[] = [
        {
          id: 'new',
          label: t('rail.openInGroup'),
          can: true,
          run: () => {
            close(false);
            props.onOpenInGroup(groupId);
          },
        },
        openAll,
        {
          id: 'rename',
          label: t('strip.menuRenameGroup'),
          can: true,
          divider: true,
          run: () => {
            // its list hangs from the entry the box is about to replace
            close(false);
            setRenaming({ where: 'group', id: e.key });
          },
        },
        {
          id: 'recolor',
          label: t('strip.menuRecolor'),
          can: props.palette.length > 0,
          run: () => {
            ran('group', e.key);
            const i = props.palette.indexOf(e.color);
            props.onRecolorGroup(groupId, props.palette[(i + 1) % props.palette.length]);
          },
        },
        {
          id: 'policy',
          label: t('strip.menuGroupPolicy', {
            policy: own ? t(`policy.${own}`) : t('policy.groupDefault'),
          }),
          can: true,
          run: () => {
            ran('group', e.key);
            props.onCycleGroupPolicy(groupId);
          },
        },
        {
          id: 'delete',
          label: t('rail.deleteGroup'),
          can: true,
          divider: true,
          run: () => {
            close(false);
            props.onDeleteGroup(groupId);
          },
        },
      ];
      return { label: t('rail.groupMenuLabel', { name: e.name }), items };
    }
    return {
      label: t('strip.menuLabel'),
      items: [
        {
          id: 'place:left',
          label: t('strip.menuPlaceLeft'),
          can: true,
          checked: false,
          run: () => props.onPlace('left'),
        },
        { id: 'place:top', label: t('strip.menuPlaceTop'), can: true, checked: true, run: () => {} },
        {
          id: 'new-group',
          label: t('strip.menuNewGroup'),
          can: true,
          divider: true,
          run: () => props.onCreateGroup(t('rail.newGroup')),
        },
        { id: 'new-session', label: t('strip.menuNewSession'), can: true, run: props.onNewSession },
      ],
    };
  })();

  const menuHasNothing = menu !== null && menuItems === null;
  React.useEffect(() => {
    if (menuHasNothing) setMenu(null);
  }, [menuHasNothing]);

  const total = needCount(order.flat, props.needing);
  const nothing = entries.length === 0 && order.loose.length === 0;

  const row = (s: RailSession): React.JSX.Element => {
    const n = ordinalOf.get(s.id);
    return (
      <SessionRow
        key={s.id}
        session={s}
        needsYou={props.needing.has(s.id)}
        selected={s.id === props.selectedId}
        pinned={props.pinned.has(s.id)}
        waiting={waiting.get(s.id) ?? 0}
        depth={order.depthOf.get(s.id)}
        labelLines={props.labelLines}
        ordinal={n !== undefined && n <= LAST_CHORD ? n : undefined}
        flash={flashing(s.id)}
        folded={props.folded.has(s.id)}
        // RENAME IS THE MENU'S HERE, never a double-click: in this list the
        // first click of a double-click is "go to this session", which closes
        // the list before the second click lands. So `onStartRename` (the
        // row's double-click) does nothing, and the menu sets `renaming`.
        editing={renaming?.where === 'row' && renaming.id === s.id}
        draft={draft}
        onDraftChange={setDraft}
        onContextMenu={(e) => {
          if (inTextBox(e)) return;
          e.preventDefault();
          e.stopPropagation();
          setMenu({ kind: 'session', id: s.id, from: 'row', ...menuPoint(e) });
        }}
        onFocus={() => {
          // Going to a session is what the list was opened for, so it closes:
          // left open it would sit over the very card you just asked for.
          props.onFocus(s.id);
          close(false);
        }}
        onClose={() => props.onClose(s.id)}
        onRename={(name) => props.onRename(s.id, name)}
        onStartRename={() => {}}
        onEndRename={() => {
          ran('session', s.id);
          setRenaming(null);
        }}
      />
    );
  };

  /**
   * A list's rows, with the pinned ones held in view.
   *
   * The rail's rule (#295), kept: pins sort first (the order already did that)
   * and never scroll out of sight, so they are lifted into one sticky block and
   * the rest slide under it. In a list short enough not to scroll this is
   * invisible, which is most of them.
   */
  const rows = (list: readonly RailSession[]): React.JSX.Element[] => {
    const cut = list.findIndex((m) => !props.pinned.has(m.id));
    const pins = cut === -1 ? list : list.slice(0, cut);
    const rest = cut === -1 ? [] : list.slice(cut);
    const out = rest.map(row);
    if (pins.length === 0) return out;
    out.unshift(
      <div
        key="__pinned"
        data-pinned-block
        style={{ position: 'sticky', insetBlockStart: 0, zIndex: 1, background: 'var(--rail-card)' }}
      >
        {pins.map(row)}
      </div>
    );
    return out;
  };

  return (
    <div
      ref={stripRef}
      data-testid="sessions-strip"
      onContextMenu={(e) => {
        // the line above the row, and anything else that is not an entry: the
        // strip's own menu. Entries, pills, rows and the row's empty part have
        // already taken theirs and stopped it; a menu and a text box are left
        // to themselves.
        if (inTextBox(e) || (e.target as HTMLElement).closest?.('[role="menu"]')) return;
        e.preventDefault();
        setMenu({ kind: 'strip', ...menuPoint(e) });
      }}
      role="group"
      aria-label={t('strip.label')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        // never give up height (#274): this is the only list of sessions on
        // screen while it is on, and the shell column squeezes its auto-basis
        // children first
        flexShrink: 0,
        background: 'var(--panel2)',
        borderBlockEnd: '1px solid var(--border)',
      }}
    >
      {/* THE LINE ABOVE. In this order and nothing else: "+ group",
          "+ session", then the ONE total. It does not scroll — the row below
          does, and "7 need you" sliding off the edge is exactly when it starts
          to matter. */}
      <div
        data-strip-line
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingInline: 8,
          paddingBlock: 3,
          minBlockSize: 23,
        }}
      >
        <button
          type="button"
          data-strip-add-group
          title={t('rail.addGroupHint')}
          onClick={() => props.onCreateGroup(t('rail.newGroup'))}
          style={lineButton}
        >
          {t('rail.addGroup')}
        </button>
        <button
          type="button"
          data-strip-add-session
          title={t('strip.addSessionHint')}
          onClick={props.onNewSession}
          style={lineButton}
        >
          {t('strip.addSession')}
        </button>
        {total > 0 && (
          <span
            data-strip-need
            style={{
              borderRadius: 'var(--radius-chip)',
              padding: '1px 8px',
              fontFamily: 'var(--font-ui)',
              fontSize: 10.5,
              fontWeight: 700,
              whiteSpace: 'nowrap',
              color: 'var(--status-needs-input-ink)',
              background: tint('var(--status-needs-input)', 18),
              border: `1px solid ${tint('var(--status-needs-input)', 45)}`,
            }}
          >
            {t('urgency.needYou', { n: total })}
          </span>
        )}
      </div>
      {/* THE ROW: groups first, then the loose sessions, scrolling sideways when
          they do not fit, with a fixed cell at each end for what is past it. */}
      <div
        data-strip-row
        style={{
          display: 'flex',
          alignItems: 'stretch',
          minBlockSize: 53,
          borderBlockStart: '1px solid var(--border)',
        }}
      >
        {overflowing && (
          <EdgeCell side="start" edge={edges.before} onScroll={() => scrollToward('start')} />
        )}
        <div
          ref={scrollerRef}
          data-strip-scroller
          onContextMenu={(e) => {
            // an EMPTY part of the row: the entries and pills take their own
            // right-click and stop it before it gets here
            if (inTextBox(e)) return;
            e.preventDefault();
            setMenu({ kind: 'strip', ...menuPoint(e) });
          }}
          onScroll={() => {
            // a list that stayed open while its entry scrolled away would be
            // pointing at nothing
            if (open) close(false);
            measure();
          }}
          onWheel={(e) => {
            // a plain mouse wheel only has an up-and-down: here that means
            // along the row, which is the only way this row goes
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
            // wheel-down is "further along the row", which is leftward when
            // the page reads right to left
            const along = directionOf(e.currentTarget) === 'rtl' ? -e.deltaY : e.deltaY;
            e.currentTarget.scrollLeft += along;
          }}
          style={{
            flex: 1,
            minInlineSize: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingInline: 8,
            paddingBlock: 4,
            overflowX: 'auto',
            // the cells at each end are the scrollbar: they say what is there
            // to scroll to, which a bar under the row cannot
            scrollbarWidth: 'none',
          }}
        >
          {entries.map((e) => {
            const groupId = e.groupId;
            if (renaming?.where === 'group' && renaming.id === e.key && groupId !== undefined) {
              return (
                <StripRenameBox
                  key={e.key}
                  target={e.key}
                  label={t('strip.renameGroupLabel', { name: e.name })}
                  initial={e.name}
                  onRename={(name) => props.onRenameGroup(groupId, name)}
                  onEnd={() => {
                    ran('group', e.key);
                    setRenaming(null);
                  }}
                />
              );
            }
            return (
              <StripGroupEntry
                key={e.key}
                groupKey={e.key}
                kind={e.kind}
                name={e.name}
                color={e.color}
                members={e.members}
                needing={props.needing}
                waiting={waiting}
                ordinalOf={ordinalOf}
                open={open?.key === e.key}
                flash={e.members.some((m) => flashing(m.id))}
              folded={props.folded}
                listId={listIdOf(e.key)}
                onToggle={(anchor) => toggle(e.key, anchor)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  setMenu({ kind: 'group', key: e.key, ...menuPoint(ev) });
                }}
                {...(groupId !== undefined
                  ? {
                      onOpenInGroup: () => {
                        // a list left open would sit over the new session's card
                        close(false);
                        props.onOpenInGroup(groupId);
                      },
                    }
                  : {})}
              />
            );
          })}
          {entries.length > 0 && order.loose.length > 0 && (
            // groups | loose sessions: two kinds of thing, one hairline apart
            <span
              aria-hidden
              style={{
                alignSelf: 'stretch',
                inlineSize: 1,
                flexShrink: 0,
                marginInline: 3,
                background: 'var(--border)',
              }}
            />
          )}
          {order.loose.map((s) =>
            renaming?.where === 'pill' && renaming.id === s.id ? (
              <StripRenameBox
                key={s.id}
                target={s.id}
                label={t('strip.renameSessionLabel', { name: s.title })}
                initial={s.title}
                onRename={(name) => props.onRename(s.id, name)}
                onEnd={() => {
                  ran('session', s.id);
                  setRenaming(null);
                }}
              />
            ) : (
              <StripPill
                key={s.id}
                session={s}
                needsYou={props.needing.has(s.id)}
                selected={s.id === props.selectedId}
                pinned={props.pinned.has(s.id)}
                waiting={waiting.get(s.id) ?? 0}
                // THE ORDER'S OWN ANSWER, as in the rail: `depthOf` holds a
                // session only if the order really put it straight after the
                // one that dispatched it, so the mark never points at a pill
                // that is not the one before it
                nested={order.depthOf.has(s.id)}
                folded={props.folded.has(s.id)}
                flash={flashing(s.id)}
                onFocus={() => props.onFocus(s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({ kind: 'session', id: s.id, from: 'pill', ...menuPoint(e) });
                }}
              />
            )
          )}
          {nothing && (
            <span data-strip-empty="none" style={{ color: 'var(--muted)', fontSize: 11 }}>
              {t('rail.empty')}
            </span>
          )}
        </div>
        {overflowing && (
          <EdgeCell side="end" edge={edges.after} onScroll={() => scrollToward('end')} />
        )}
      </div>
      {menu && menuItems && (
        <RailGroupMenu
          testId="strip-menu"
          x={menu.x}
          y={menu.y}
          label={menuItems.label}
          items={menuItems.items}
          onClose={(restoreFocus) => {
            const was = menu;
            setMenu(null);
            // Escape hands the keyboard back to what the menu was opened on.
            // (A click elsewhere does not: the click chose where focus goes.
            // An item that ran asks for it back itself — see `ran` below.)
            if (restoreFocus) focusTarget(was);
          }}
        />
      )}
      {open && openEntry && (
        <div
          ref={listRef}
          id={listIdOf(openEntry.key)}
          data-strip-list={openEntry.key}
          onContextMenu={(e) => {
            // its rows take their own right-click. The list's heading and
            // padding are not "an empty part of the strip", so they must not
            // open the strip's menu over the list; they open nothing.
            if (inTextBox(e)) return;
            e.preventDefault();
            e.stopPropagation();
          }}
          role="group"
          aria-label={t('strip.listLabel', { name: openEntry.name })}
          style={{
            position: 'fixed',
            insetBlockStart: open.top,
            insetInlineStart: open.start,
            inlineSize: LIST_WIDTH,
            maxBlockSize: '60vh',
            overflowY: 'auto',
            zIndex: 50,
            background: 'var(--rail-card)',
            border: `1px solid ${openEntry.color}`,
            borderRadius: 8,
            boxShadow: 'var(--tab-lift)',
            padding: 5,
          }}
        >
          {/* The list says whose it is. It hangs under its entry, but with
              several groups on the strip and the entry possibly half off the
              edge, "which group is this" should not need looking up. */}
          <div
            aria-hidden
            data-strip-list-head
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px 6px',
              fontSize: 11,
              fontWeight: 600,
              color: openEntry.kind === 'auto' ? 'var(--auto-ink)' : 'var(--text)',
            }}
          >
            <span style={{ flex: 1, minInlineSize: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {openEntry.name}
            </span>
            <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
              {t('rail.footerSessions', { count: openEntry.members.length })}
            </span>
          </div>
          {openEntry.members.length === 0 ? (
            <div
              data-strip-list-empty
              style={{ color: 'var(--muted)', fontSize: 11, padding: '6px 8px' }}
            >
              {t('rail.empty')}
            </div>
          ) : (
            rows(openEntry.members)
          )}
        </div>
      )}
    </div>
  );
}
