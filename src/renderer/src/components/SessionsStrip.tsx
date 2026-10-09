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
//  - the LAMPS ROW, by carrying the one "N need you" total and by lighting the
//    entry the last jump landed on (App times that highlight, #1164);
//  - the COLLAPSED ROW, by drawing a folded-away session with a dashed edge —
//    its pill, or its row in a group's list, with the group saying how many —
//    and bringing it back on a click.
//
// PUT AWAY (Ctrl+B), IT IS SIMPLY NOT THERE, and nothing takes its place:
// the lamps row and the collapsed row no longer exist in the app at all
// (#1164, the owner's call).
//
// The row scrolls sideways when it does not fit, and a fixed cell at each end
// says what is past that edge — in amber, with a number, when it is a session
// that needs you.
//
// RIGHT-CLICK IS THE MENU, everywhere on the strip, and there is no menu icon:
// on a session (its pill, or its row in an open list), on a group, and on an
// empty part of the strip. None of the three has an ordering item — order is
// by dragging.
//
// DRAGGING IS THE ORDER. A group you made, sideways, to move it among your
// groups; a pill, sideways, to move it among the pills; a pill onto a group
// you made, to put the session in it. A line shows where a reorder will land
// and a group lights up when a session would join it — and nothing is ever
// shown that the drop would then not do: every "may I drop here" is answered
// by the same function the drop itself calls (`dropGroup`, `planReorder`),
// which are the rail's.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { RailGroup, RailSession } from '../model/types';
import { autoGroupName, RailOrderResult } from '../lib/groups';
import { dropGroup, stepGroup } from '../lib/group-order';
import { LOOSE_BUCKET, planReorder } from '../lib/rail-order';
import { LineageMap, NO_LINEAGE } from '../lib/dispatch-lineage';
import { getDraggedCard, setDraggedCard } from '../lib/drag-context';
import { DND_TYPE, GROUP_DND_TYPE } from '../lib/rail-dnd';
import { edgeAtX, edgeAtY, insertIndex } from '../lib/strip-drag';
import { needCount } from '../lib/rail-view';
import { useHeldCounts } from '../lib/sibling-inbox';
import { edgeOverflow, EdgeState, sameEdges } from '../lib/strip-overflow';
import { isLit, UrgencyMarks } from '../lib/urgency';
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
  // ── dragging
  /** which session dispatched which (#951): a reorder keeps a child with its
   *  parent, exactly as the rail's does. Omitted reads as "nothing nested". */
  lineage?: LineageMap;
  /** the whole of one bucket's new order, after a drag */
  onReorder: (bucketKey: string, orderedIds: string[]) => void;
  /** put the group `id` just before `beforeId`, or last when that is `null` */
  onMoveGroup: (id: string, beforeId: string | null) => void;
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
  /** something is being dragged over it: nudge the row along, so a drop
   *  target that is off this edge can be reached without letting go */
  onDragNear: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { cut, need } = props.edge;
  const amber = 'var(--status-needs-input)';
  return (
    <button
      type="button"
      data-strip-edge={props.side}
      onDragOver={(e) => {
        // only for something that can be dropped on the strip: a folder from
        // Explorer crossing this cell on its way in must not move the row
        const t = e.dataTransfer.types;
        if (cut && (t.includes(DND_TYPE) || t.includes(GROUP_DND_TYPE) || getDraggedCard())) {
          props.onDragNear();
        }
      }}
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
  // ── dragging ───────────────────────────────────────────────────────────────
  //
  // WHAT is in flight is kept in a ref, because the browser will not say:
  // `dataTransfer.getData` answers '' during dragover (Chromium's protected
  // mode), so a handler that needs to know which thing is being dragged has
  // to have been told at dragstart. The rail does the same (#559).
  const dragging = React.useRef<{ kind: 'group' | 'card'; id: string } | null>(null);
  /** the entry or pill a reorder would land against, and which side */
  const [dropAt, setDropAt] = React.useState<{ id: string; edge: 'before' | 'after' } | null>(null);
  /** the group a dragged session would join */
  const [dropInto, setDropInto] = React.useState<string | null>(null);
  const endDrag = (): void => {
    dragging.current = null;
    setDropAt(null);
    setDropInto(null);
  };
  const lastNudge = React.useRef(0);
  // HOWEVER THE DRAG ENDS, IT ENDS. `dragend` is dispatched at the element the
  // drag started on, and that element may be gone by then: a pill unmounts
  // mid-drag when a second session opens in its folder, or its session closes.
  // Its `onDragEnd` then never runs, and a ref left saying "pill X is in
  // flight" would be read by the NEXT drag — a tab brought up from the
  // workspace would put X in the group it was dropped on. The window hears
  // every drag end and every drop, wherever they land. (The rail does the
  // same, for the same reason.)
  React.useEffect(() => {
    const over = (): void => {
      dragging.current = null;
      setDropAt(null);
      setDropInto(null);
    };
    window.addEventListener('dragend', over);
    window.addEventListener('drop', over);
    return () => {
      window.removeEventListener('dragend', over);
      window.removeEventListener('drop', over);
    };
  }, []);
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
  const scrollToward = (side: 'start' | 'end', share = 0.8): void => {
    const sc = scrollerRef.current;
    if (!sc) return;
    // most of a screenful, so something you just read is still in view
    const step = Math.max(120, sc.clientWidth * share);
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

  // ── what a drag would do ───────────────────────────────────────────────────
  const lineage = props.lineage ?? NO_LINEAGE;
  const groupIds = order.groups.map((g) => g.id);
  const looseIds = order.loose.map((s) => s.id);
  const rtlOf = (el: Element): boolean => directionOf(el) === 'rtl';
  const setDropAtIfNew = (id: string, edge: 'before' | 'after'): void =>
    setDropAt((was) => (was?.id === id && was.edge === edge ? was : { id, edge }));

  /** the move a dragged GROUP would make if dropped on this side of `groupId`,
   *  or `null` for a drop that would change nothing */
  const planGroupDrop = (groupId: string, edge: 'before' | 'after') => {
    const d = dragging.current;
    if (!d || d.kind !== 'group') return null;
    return dropGroup(groupIds, d.id, groupId, edge === 'after');
  };
  /** the pills' new order if the dragged PILL were dropped on this side of
   *  `pillId`, or `null`. A reorder is within the pills, full stop: a session
   *  dragged out of somewhere else answers `null` here. `planReorder` re-applies
   *  the pin sort and keeps a dispatched session with its parent, so a drop
   *  aimed past a pinned pill settles against it rather than displacing it. */
  const planPillDrop = (
    types: readonly string[],
    pillId: string,
    edge: 'before' | 'after'
  ): string[] | null => {
    // ONLY a drag that started on one of this strip's pills, and says so. A
    // tab from the workspace, a folder from Explorer, or anything else over a
    // pill is not a reorder — and the ref alone must never be believed, since
    // it describes the last drag that began here, not necessarily this one.
    if (!types.includes(DND_TYPE)) return null;
    const d = dragging.current;
    if (!d || d.kind !== 'card' || d.id === pillId || !looseIds.includes(d.id)) return null;
    return planReorder(looseIds, d.id, insertIndex(looseIds, d.id, pillId, edge), props.pinned, lineage);
  };
  /** may the session in flight join this group? Not one it is already in, and
   *  not a card main has never heard of (#687): a group that lights up and
   *  then does nothing is what wasted the owner's time the first time. */
  const canJoin = (cardId: string | null, groupId: string): boolean => {
    if (!cardId) return true; // dragged in from somewhere that did not say
    const s = order.flat.find((x) => x.id === cardId);
    return !!s && s.groupId !== groupId && s.status !== 'not-started';
  };
  /** the session being dragged: one of our pills if THIS drag carries our
   *  type, otherwise whatever the workspace says it is dragging */
  const cardInFlight = (types: readonly string[]): string | null =>
    (types.includes(DND_TYPE) && dragging.current?.kind === 'card' ? dragging.current.id : null) ??
    getDraggedCard();

  const groupDrag = (
    e: Entry
  ): React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean } => {
    const groupId = e.groupId;
    return {
      // only a group you made moves: an automatic one sits where its folder
      // puts it, after yours
      draggable: groupId !== undefined && groupIds.length > 1,
      onDragStart: (ev) => {
        if (groupId === undefined) return;
        ev.dataTransfer.setData(GROUP_DND_TYPE, groupId);
        ev.dataTransfer.effectAllowed = 'move';
        dragging.current = { kind: 'group', id: groupId };
        // its list hangs from where the entry WAS
        close(false);
      },
      onDragOver: (ev) => {
        if (ev.dataTransfer.types.includes(GROUP_DND_TYPE)) {
          if (groupId === undefined) return;
          const edge = edgeAtX(ev.currentTarget.getBoundingClientRect(), ev.clientX, rtlOf(ev.currentTarget));
          if (!planGroupDrop(groupId, edge)) {
            // nowhere to go from here: no line, and no drop cursor
            setDropAt((was) => (was?.id === e.key ? null : was));
            return;
          }
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          setDropAtIfNew(e.key, edge);
          return;
        }
        // a session (a pill, or a card's tab dragged up from the workspace)
        if (!ev.dataTransfer.types.includes(DND_TYPE) && !getDraggedCard()) return;
        // an automatic group cannot be joined: its membership is the folder's
        if (groupId === undefined || !canJoin(cardInFlight(ev.dataTransfer.types), groupId)) return;
        ev.preventDefault();
        setDropAt(null);
        setDropInto(e.key);
      },
      onDragLeave: (ev) => {
        // moving between the entry's own children fires this on the one being
        // left; only a pointer that has left the ENTRY should clear it
        if (ev.currentTarget.contains(ev.relatedTarget as Node | null)) return;
        setDropInto((was) => (was === e.key ? null : was));
        setDropAt((was) => (was?.id === e.key ? null : was));
      },
      onDrop: (ev) => {
        if (ev.dataTransfer.types.includes(GROUP_DND_TYPE)) {
          // recomputed from the live list, by the function the line was drawn
          // from, so the line and the landing cannot disagree
          const move =
            groupId === undefined
              ? null
              : planGroupDrop(
                  groupId,
                  edgeAtX(ev.currentTarget.getBoundingClientRect(), ev.clientX, rtlOf(ev.currentTarget))
                );
          endDrag();
          if (!move) return;
          ev.preventDefault();
          props.onMoveGroup(move.id, move.beforeId);
          return;
        }
        const ours = dragging.current !== null && ev.dataTransfer.types.includes(DND_TYPE);
        const cardId = ev.dataTransfer.getData(DND_TYPE) || cardInFlight(ev.dataTransfer.types);
        endDrag();
        if (!cardId || groupId === undefined || !canJoin(cardId, groupId)) return;
        ev.preventDefault(); // claim it from the workspace's own drop targets
        setDraggedCard(null);
        // the keyboard follows only a drag that began HERE: a tab brought up
        // from the workspace leaves it in the workspace, where it was
        if (ours) ran('group', e.key);
        props.onMoveToGroup(cardId, groupId);
      },
      onDragEnd: endDrag,
    };
  };

  /** a group's sessions in their list order, and the key that order is saved
   *  under — the row's own bucket, as the list on the left reads it */
  const bucketFor = (cardId: string): { key: string; ids: string[] } | null => {
    const key = order.bucketOf.get(cardId);
    const ids = key === undefined ? undefined : order.buckets.get(key);
    return key === undefined || !ids ? null : { key, ids };
  };
  /** the list's new order if the dragged ROW were dropped on this side of
   *  `rowId`, or `null`. Within one group only: a row over a row of another
   *  group's list cannot happen (one list is open at a time), and a pill
   *  dragged over a row is not a reorder of this list. Through `planReorder`,
   *  like every other reorder, so a pinned session is still not passed and a
   *  dispatched session still moves with the one that sent it. */
  const planRowDrop = (
    types: readonly string[],
    rowId: string,
    edge: 'before' | 'after'
  ): { key: string; next: string[] } | null => {
    if (!types.includes(DND_TYPE)) return null;
    const d = dragging.current;
    if (!d || d.kind !== 'card' || d.id === rowId) return null;
    const bucket = bucketFor(rowId);
    if (!bucket || !bucket.ids.includes(d.id)) return null;
    const next = planReorder(
      bucket.ids,
      d.id,
      insertIndex(bucket.ids, d.id, rowId, edge),
      props.pinned,
      lineage
    );
    return next ? { key: bucket.key, next } : null;
  };

  /**
   * A ROW IN A GROUP'S OPEN LIST CAN BE DRAGGED UP AND DOWN (#1178).
   *
   * It could not: the owner, with the sessions across the top, had to switch
   * the list to the left to reorder a group and switch back. ("I can't move a
   * session up or down in a group to relocate it. I have to move the session
   * window to the left and then move it there.") The keyboard could
   * (`Ctrl+Alt+↑/↓`); the mouse could not.
   *
   * The same drag a pill has, turned on its side: which HALF of the row the
   * pointer is in says "before" or "after", a line is drawn there, and the drop
   * writes the group's order through the same `onReorder` the list on the left
   * calls. It also carries the strip's card type, so the row can be dropped on
   * ANOTHER group's box to move it there — that part was already how a pill is
   * moved into a group, and comes for free.
   *
   * The list stays open for a drag within it: a press inside the list is not
   * "a click elsewhere", and its own scroll does not close it. ONE THING DOES
   * CLOSE IT MID-DRAG, and is left that way: holding the row over the cell at
   * an end of the strip scrolls the strip along, and a list hanging under an
   * entry that has just slid away would be pointing at nothing. The drag
   * itself goes on, and a drop on a group still lands.
   */
  const rowDrag = (
    s: RailSession
  ): Pick<React.HTMLAttributes<HTMLDivElement>, 'onDragStart' | 'onDragOver' | 'onDrop'> => ({
    onDragStart: (ev) => {
      ev.dataTransfer.setData(DND_TYPE, s.id);
      ev.dataTransfer.effectAllowed = 'move';
      dragging.current = { kind: 'card', id: s.id };
    },
    onDragOver: (ev) => {
      const edge = edgeAtY(ev.currentTarget.getBoundingClientRect(), ev.clientY);
      if (!planRowDrop(ev.dataTransfer.types, s.id, edge)) {
        setDropAt((was) => (was?.id === s.id ? null : was));
        return;
      }
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      setDropInto(null);
      setDropAtIfNew(s.id, edge);
    },
    onDrop: (ev) => {
      const dragged = dragging.current;
      const plan = planRowDrop(
        ev.dataTransfer.types,
        s.id,
        edgeAtY(ev.currentTarget.getBoundingClientRect(), ev.clientY)
      );
      endDrag();
      if (!plan || !dragged) return;
      ev.preventDefault();
      // the keyboard goes back to the session that moved, as it does after a
      // pill is dropped: the reorder MOVES the row's node, and focus that was
      // on its button would otherwise fall to the page
      ran('session', dragged.id);
      props.onReorder(plan.key, plan.next);
    },
  });

  const pillDrag = (s: RailSession): React.ButtonHTMLAttributes<HTMLButtonElement> => ({
    draggable: true,
    onDragStart: (ev) => {
      ev.dataTransfer.setData(DND_TYPE, s.id);
      ev.dataTransfer.effectAllowed = 'move';
      dragging.current = { kind: 'card', id: s.id };
    },
    onDragOver: (ev) => {
      const edge = edgeAtX(ev.currentTarget.getBoundingClientRect(), ev.clientX, rtlOf(ev.currentTarget));
      if (!planPillDrop(ev.dataTransfer.types, s.id, edge)) {
        setDropAt((was) => (was?.id === s.id ? null : was));
        return;
      }
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      setDropInto(null);
      setDropAtIfNew(s.id, edge);
    },
    onDragLeave: (ev) => {
      if (ev.currentTarget.contains(ev.relatedTarget as Node | null)) return;
      setDropAt((was) => (was?.id === s.id ? null : was));
    },
    onDrop: (ev) => {
      const dragged = dragging.current;
      const next = planPillDrop(
        ev.dataTransfer.types,
        s.id,
        edgeAtX(ev.currentTarget.getBoundingClientRect(), ev.clientX, rtlOf(ev.currentTarget))
      );
      endDrag();
      if (!next || !dragged) return;
      ev.preventDefault();
      ran('session', dragged.id);
      props.onReorder(LOOSE_BUCKET, next);
    },
    onDragEnd: endDrag,
  });

  /** something dragged is held against an end cell: move the row along a
   *  little, and not on every one of the dozens of dragovers a second */
  const nudge = (side: 'start' | 'end'): void => {
    const now = Date.now();
    if (now - lastNudge.current < 350) return;
    lastNudge.current = now;
    scrollToward(side, 0.35);
  };

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
        //
        // THE WHOLE SET IS ABSENT when it could do nothing, which is the left
        // list's rule and (#1168) now this menu's too, so the two are the same
        // menu: with no groups there is nowhere to move to, and a session that
        // never started cannot be regrouped at all (main declines the write).
        // One item that is unavailable right now dims; a set that can do
        // nothing goes.
        ...(props.groups.length > 0 && started
          ? [
              ...props.groups.map(
                (g, i): RailGroupMenuItem => ({
                  id: `move:${g.id}`,
                  label: g.name,
                  can: true,
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
                can: true,
                checked: !s.groupId,
                run: () => {
                  ran('session', s.id);
                  if (s.groupId) props.onMoveToGroup(s.id, null);
                },
              },
            ]
          : []),
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
        // dragged up and down within its group (#1178). Not while its name is
        // being typed: a draggable row would take a drag that was meant to
        // select text in the box.
        {...(renaming?.where === 'row' && renaming.id === s.id ? {} : rowDrag(s))}
        dropEdge={dropAt?.id === s.id ? dropAt.edge : undefined}
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
          title={t('rail.addSessionHint')}
          onClick={props.onNewSession}
          style={lineButton}
        >
          {t('rail.addSession')}
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
          <EdgeCell
            side="start"
            edge={edges.before}
            onScroll={() => scrollToward('start')}
            onDragNear={() => nudge('start')}
          />
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
                dragProps={groupDrag(e)}
                {...(e.groupId !== undefined
                  ? {
                      onStep: (direction: 'up' | 'down') => {
                        const move = stepGroup(groupIds, e.groupId!, direction);
                        if (!move) return;
                        ran('group', e.key);
                        props.onMoveGroup(move.id, move.beforeId);
                      },
                    }
                  : {})}
                {...(dropAt?.id === e.key ? { dropEdge: dropAt.edge } : {})}
                dropInto={dropInto === e.key}
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
                dragProps={pillDrag(s)}
                {...(dropAt?.id === s.id ? { dropEdge: dropAt.edge } : {})}
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
          <EdgeCell
            side="end"
            edge={edges.after}
            onScroll={() => scrollToward('end')}
            onDragNear={() => nudge('end')}
          />
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
          // THE 2px BETWEEN TWO ROWS IS THIS BOX, NOT A ROW (found in review),
          // and it is exactly where the insertion line is drawn. With no
          // handlers here, letting go ON the line — the most natural place
          // to let go — was a drop on nothing, and the drag was cancelled.
          // So while a line is showing, the list takes the drop for the row
          // the line belongs to.
          onDragOver={(ev) => {
            if (!dropAt || !planRowDrop(ev.dataTransfer.types, dropAt.id, dropAt.edge)) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(ev) => {
            // a drop on a ROW was the row's, and it has already ended the drag
            // (`dragging` is cleared), so this plans nothing and does nothing
            const dragged = dragging.current;
            const plan = dropAt ? planRowDrop(ev.dataTransfer.types, dropAt.id, dropAt.edge) : null;
            endDrag();
            if (!plan || !dragged) return;
            ev.preventDefault();
            ran('session', dragged.id);
            props.onReorder(plan.key, plan.next);
          }}
          // leaving the list altogether takes the line with it: a line left
          // painted while the pointer is over the workspace promises a drop
          // that will not happen there
          onDragLeave={(ev) => {
            if (ev.currentTarget.contains(ev.relatedTarget as Node | null)) return;
            setDropAt(null);
          }}
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
