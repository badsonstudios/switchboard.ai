// The sessions strip across the top (#1143).
//
// The other place the sessions can be listed: one line of controls and, under
// it, one row that holds the groups and then the loose sessions. While it is
// on, the left rail is gone. The lamps row and the collapsed row are meant to go
// too and are replaced by this strip's own entries — once it has all of them.
// Until then App keeps both, and says why where it mounts this.
//
// WHAT IS HERE SO FAR: the line above, and the GROUPS — each one an entry that
// drops down a list of its sessions as full rows, the same `SessionRow` the rail
// draws. The loose sessions (pills), the arrow cells at each end, the menus and
// the dragging each land in their own change; until the pills have, the row says
// in words how many sessions it is not showing, because a strip that silently
// leaves sessions out reads as "those sessions are gone".
import React from 'react';
import { useTranslation } from 'react-i18next';
import { RailGroup, RailSession } from '../model/types';
import { autoGroupName, RailOrderResult } from '../lib/groups';
import { needCount } from '../lib/rail-view';
import { useHeldCounts } from '../lib/sibling-inbox';
import { tint } from '../lib/tint';
import { directionOf } from '../lib/writing-direction';
import { SessionRow } from './SessionRow';
import { LAST_CHORD, StripGroupEntry } from './StripGroupEntry';

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
    if (selectedId !== selectedAtOpen.current) close(false);
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
          they do not fit. */}
      <div
        data-strip-row
        // a list that stayed open while its entry scrolled away would be
        // pointing at nothing
        onScroll={() => {
          if (open) close(false);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingInline: 8,
          paddingBlock: 4,
          minBlockSize: 53,
          overflowX: 'auto',
          borderBlockStart: '1px solid var(--border)',
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
        {nothing ? (
          <span data-strip-empty="none" style={{ color: 'var(--muted)', fontSize: 11 }}>
            {t('rail.empty')}
          </span>
        ) : (
          order.loose.length > 0 && (
            // NOT DRAWN YET, so it is said: these become pills. Leaving them out
            // without a word would read as "those sessions are gone".
            <span
              data-strip-empty="pending"
              style={{ color: 'var(--muted)', fontSize: 11, flexShrink: 0, paddingInline: 4 }}
            >
              {t('strip.loosePending', { count: order.loose.length })}
            </span>
          )
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
