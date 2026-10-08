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
// that needs you. The menus and the dragging each land in their own change.
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
import { SessionRow } from './SessionRow';
import { LAST_CHORD, StripGroupEntry } from './StripGroupEntry';
import { StripPill } from './StripPill';

/** see the row's `editing` prop below for why these are not wired yet */
const noRename = (): void => {};
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
  onClose: (cardId: string) => void;
}

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
        // NO RENAME FROM HERE YET. The row's own door to it is a double-click,
        // and in this list the first click of a double-click is "go to this
        // session", which closes the list before the second click lands. The
        // menu's Rename is the door that works here, and it arrives with the
        // menus; until then the row is told it is never being edited.
        editing={false}
        draft=""
        onDraftChange={noRename}
        onFocus={() => {
          // Going to a session is what the list was opened for, so it closes:
          // left open it would sit over the very card you just asked for.
          props.onFocus(s.id);
          close(false);
        }}
        onClose={() => props.onClose(s.id)}
        onRename={noRename}
        onStartRename={noRename}
        onEndRename={noRename}
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
          {order.loose.map((s) => (
            <StripPill
              key={s.id}
              session={s}
              needsYou={props.needing.has(s.id)}
              selected={s.id === props.selectedId}
              pinned={props.pinned.has(s.id)}
              waiting={waiting.get(s.id) ?? 0}
              // THE ORDER'S OWN ANSWER, as in the rail: `depthOf` holds a
              // session only if the order really put it straight after the one
              // that dispatched it, so the mark never points at a pill that is
              // not the one before it
              nested={order.depthOf.has(s.id)}
              folded={props.folded.has(s.id)}
              flash={flashing(s.id)}
              onFocus={() => props.onFocus(s.id)}
            />
          ))}
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
      {open && openEntry && (
        <div
          ref={listRef}
          id={listIdOf(openEntry.key)}
          data-strip-list={openEntry.key}
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
