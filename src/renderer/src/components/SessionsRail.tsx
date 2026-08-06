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
//  2. A session that needs you is loud: status-tinted row, 4px status-colored
//     bar, name at 700, and its sub-label replaced by what it is actually
//     asking for. Calm sessions stay plain. The contrast is the point.
//  3. The working ring is the ONLY animation. Blinking status dots were an
//     explicit rejection.
//
// KEYBOARD & SCREEN READER (#197, §5.26), following #174's rule:
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
import React from 'react';
import { useTranslation } from 'react-i18next';
import { RailGroup, RailSession } from '../model/types';
import { railOrder } from '../lib/groups';
import { presentStatus, needCount, clampRailWidth, RAIL_WIDTH_DEFAULT } from '../lib/rail-view';
import { uiGet, uiSet } from '../lib/ui-state';
import { getDraggedCard, setDraggedCard } from '../lib/drag-context';
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
  // the live width, so pointerup can persist what is actually on screen. A ref
  // rather than a read inside a setState updater: StrictMode invokes updaters
  // twice, and an updater that writes to disk is not a pure function.
  const widthRef = React.useRef(width);

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
    const onMove = (e: PointerEvent): void => {
      widthRef.current = clampRailWidth(e.clientX);
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
    const clear = (): void => setDropTarget(null);
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
    if (restoreFocus) menuAnchor.current?.focus();
  }, []);

  // dismiss the context menu on any click elsewhere, Escape, or a scroll
  React.useEffect(() => {
    if (!menu) return;
    const close = (): void => closeMenu(false);
    const onKey = (e: KeyboardEvent): void => {
      // Escape is the keyboard's way out, so it is also the one dismissal that
      // owes the user their place back — a menu that closes into nowhere
      // strands the keyboard at the top of the document
      if (e.key === 'Escape') closeMenu(true);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, closeMenu]);

  // A menu you can open with Shift+F10 and not walk is worse than no menu, so
  // the first item takes focus as it opens. Layout effect, not an effect: the
  // menu is `position: fixed` and focusing it after a paint would scroll-jump.
  React.useLayoutEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [menu]);

  const sessionRow = (s: RailSession): React.JSX.Element => {
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
        // the semantic (does a human have to act) and the CSS concern (does
        // this row already own its background, so hover must not repaint it)
        // are separate things — a merely SELECTED row is tinted but not needy
        data-needs-you={p.needsYou}
        data-tinted={p.needsYou || selected}
        data-session-status={p.token}
        // §5.8's pinning contract (E9-09). An attribute rather than only a
        // glyph: the protection is a fact about the row that the e2e suite has
        // to be able to read, and styling may want it later.
        data-pinned={isPinned}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_TYPE, s.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onClick={() => props.onFocus(s.id)}
        onDoubleClick={() => {
          setEditing(s.id);
          setDraft(s.title);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // Shift+F10 and the ContextMenu key fire this same event, which is
          // what gives the menu a keyboard path at all — but they carry no
          // pointer, and Chromium reports (0, 0) for it. Anchor to the row
          // instead, or the menu opens in the window's top-left corner.
          const kb = e.clientX === 0 && e.clientY === 0;
          const box = e.currentTarget.getBoundingClientRect();
          menuAnchor.current = (e.target as HTMLElement).closest<HTMLElement>('button');
          setMenu({
            session: s,
            x: kb ? box.left + 12 : e.clientX,
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
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                props.onRename(s.id, draft);
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
    const need = needCount(opts.members);
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
          overflow: 'hidden',
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
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  props.onRenameGroup(g.id, groupDraft);
                  setEditingGroup(null);
                }
                if (e.key === 'Escape') setEditingGroup(null);
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
        <div id={bodyId} hidden={isCollapsed} style={{ padding: 5 }}>
          {isCollapsed ? null : opts.members.length === 0 && opts.showEmpty ? (
            <div style={{ color: 'var(--faint)', fontSize: 10, padding: '4px 8px' }}>
              {t('rail.groupEmpty')}
            </div>
          ) : (
            opts.members.map(sessionRow)
          )}
        </div>
      </div>
    );
  };

  // one ordering function for the rail AND for Ctrl+1..9 (E9-01): persistent
  // groups and their members, then emergent auto-groups (E12-05), then loose
  // `props.pinned` and not a second sort here: §5.8's "sorts first" is one rule,
  // and the store derives the SAME call for Ctrl+1..9 and both strips (E9-09).
  const order = railOrder(props.sessions, props.groups, props.pinned);
  const grouped = new Map(order.groups.map((g) => [g.id, g.members]));
  const totalNeed = needCount(props.sessions);
  // The Ungrouped bucket only earns a header when there is something to
  // distinguish it FROM — on a fresh workspace it would be pure chrome.
  const hasOtherCards = props.groups.length > 0 || order.autoGroups.length > 0;

  return (
    <nav
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_TYPE) || getDraggedCard()) e.preventDefault();
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

      <div className="rail-scroll" style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
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
                  style={{
                    background: 'var(--rail-card)',
                    border: '1px solid var(--group-frame)',
                    borderRadius: 8,
                    boxShadow: 'var(--group-lift)',
                    padding: 5,
                  }}
                >
                  {order.loose.map(sessionRow)}
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
            insetInlineStart: menu.x,
            insetBlockStart: menu.y,
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
              the other three for a state the label already spells out. It
              restores focus: the row is still there afterwards, and it is
              exactly the row whose pin you just changed. */}
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
                () => props.onTogglePin(menu.session.id),
                true,
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
