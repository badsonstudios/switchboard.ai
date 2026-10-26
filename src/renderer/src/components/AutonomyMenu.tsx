// The mode button's menu (#1462): pick this session's mode from a ticked list.
//
// Dan, 2026-10-26: the shield button under the prompt box CYCLED to the next
// mode on every click, and while "Allow all (this session)" was on it opened two
// inline buttons instead (Stop allowing all, Change mode (next: …)). Both were
// blind — you clicked to find out what you would get. Now a click always opens
// this list: the four modes in `AUTONOMIES` order with a ✓ on the current one,
// like the model and AI menus beside it. You pick the one you want.
//
// IT IS THE SAME MENU AS ITS NEIGHBOURS, not a new idiom: `ModelQuickMenu`'s and
// `AiSwitchMenu`'s shape (a click-away layer, a `position: fixed` box placed by
// `placeMenu` against the chip's box, a `role="menu"` of `menuitemradio` rows
// with the tick in its own column, the `.model-menu-item` row look, arrows /
// Home / End to move, Escape and Tab to close). There is no shared component to
// mount — each of those two is built around what its rows do on the wire — so
// this one is built the same way around what its rows do, which is nothing
// asynchronous: `sessions:setAutonomy` is fire-and-forget, so there is no busy
// state and no hold-open rule.
//
// ALLOW-ALL IS ONE MORE ROW, not more buttons. While it is on the list ends with
// a ticked "Allow all (this session)"; clicking it is the revoke (the card menu's
// ✕ by another door). Turning it ON stays on the approval bar. Picking a mode
// while it is on changes the mode and LEAVES allow-all on — the ticked row stays,
// so that is visible (Dan's comment on the issue; his to flip).
//
// A POPOUT IS A SECOND DOCUMENT. Nothing here is portalled: the menu renders in
// the composer's own subtree, so a popped-out card's menu is in the popout's
// document, and every measurement and focus read goes through the box's
// `ownerDocument` rather than the global `document`/`window`, which belong to the
// main window even while this code runs for a popout.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MENU_EDGE_MARGIN, placeMenu, type MenuPlacement } from '../lib/menu-placement';
import { directionOf } from '../lib/writing-direction';
import { AUTONOMIES, autonomyDescription, DEFAULT_AUTONOMY, isAutonomy, type Autonomy } from '../lib/autonomy';

export interface AutonomyMenuProps {
  /** the id the chip's `aria-controls` points at */
  id?: string;
  /** the chip's box, physical client coordinates (`getBoundingClientRect()`) */
  anchor: { x: number; y: number; width: number; height: number };
  /** the card's SETTING — what the chip sets, and so what is ticked */
  current: string | undefined;
  /** the session's AI is Claude: the rows' hover adds what Claude Code does */
  claude: boolean;
  /**
   * Why this session's AI cannot switch modes (#1287), or null when it can. The
   * menu only opens like this while allow-all is on: the mode rows are greyed
   * with the reason, and the allow-all row is still the way out.
   */
  modesUnavailable: string | null;
  /** "Allow all (this session)" is in force: show its ticked row */
  allowAll: boolean;
  /** set the card's mode; only called for a mode that is not already set */
  onPick: (mode: Autonomy) => void;
  /** take allow-all back; absent when no session is live to take it from */
  onRevokeAllowAll?: () => void;
  /** close, and give the chip its focus back; the composer owns both */
  onClose: () => void;
}

const AUTONOMY_MENU_TESTID = 'autonomy-menu';

export function AutonomyMenu(props: AutonomyMenuProps): React.JSX.Element {
  const { t } = useTranslation();
  const { anchor, claude, modesUnavailable, allowAll, onPick, onRevokeAllowAll, onClose } = props;
  const current: Autonomy = isAutonomy(props.current) ? props.current : DEFAULT_AUTONOMY;
  const menu = React.useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = React.useState<MenuPlacement | null>(null);

  // WHERE IT GOES — ModelQuickMenu's measurement, for its reasons: the natural
  // size, the menu's own direction, and the viewport of the box's OWN document
  // (a popout's, when the card is popped out).
  React.useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const direction = directionOf(el);
    const root = el.ownerDocument.documentElement;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const x = direction === 'rtl' ? anchor.x + anchor.width : anchor.x;
    const below = anchor.y + anchor.height;
    const roomBelow = below + size.height <= root.clientHeight - MENU_EDGE_MARGIN;
    setPlace(
      placeMenu(
        { x, y: roomBelow ? below : anchor.y },
        size,
        { width: root.clientWidth, height: root.clientHeight },
        { direction }
      )
    );
  }, [anchor, allowAll, modesUnavailable]);

  // The keyboard goes to the ticked row once the menu is placed — or, when the
  // mode rows are greyed, to the first row that can be used. Once: a re-measure
  // must not yank it back while the user is arrowing.
  const focused = React.useRef(false);
  React.useLayoutEffect(() => {
    if (!place || focused.current) return;
    const box = menu.current;
    if (!box) return;
    const first =
      box.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not(:disabled)') ??
      box.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)');
    focused.current = true;
    (first ?? box).focus();
  }, [place]);

  // A menu placed once against a window that then resizes is in the wrong
  // place; the popout's window is the one that resizes, hence `defaultView`.
  React.useEffect(() => {
    const view = menu.current?.ownerDocument.defaultView;
    if (!view) return;
    const go = (): void => onClose();
    view.addEventListener('resize', go);
    return () => view.removeEventListener('resize', go);
  }, [onClose]);

  const pick = (m: Autonomy): void => {
    // the one already set: a dismissal, not a change
    if (m !== current) onPick(m);
    onClose();
  };

  const item: React.CSSProperties = {
    display: 'flex',
    inlineSize: '100%',
    alignItems: 'baseline',
    gap: 8,
    textAlign: 'start',
    padding: '5px 9px',
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--text)',
    font: 'inherit',
    fontFamily: 'var(--font-ui)',
    cursor: 'pointer',
  };
  /** the tick's own column, drawn or not, so the labels never shuffle sideways */
  const tick = (on: boolean): React.JSX.Element => (
    <span aria-hidden style={{ display: 'inline-block', inlineSize: 12, flexShrink: 0 }}>
      {on ? t('autonomy.menu.currentMark') : ''}
    </span>
  );

  return (
    <>
      <div
        data-autonomy-menu-scrim
        onPointerDown={(e) => {
          e.preventDefault();
          onClose();
        }}
        style={{ position: 'fixed', inset: 0, zIndex: 49 }}
      />
      <div
        ref={menu}
        data-testid={AUTONOMY_MENU_TESTID}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // The menu owns its keys while open: the composer below would read
          // Escape as "clear the draft" and the arrows as caret moves.
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
            return;
          }
          if (e.key === 'Tab') {
            onClose();
            return;
          }
          const items = Array.from(
            e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')
          );
          if (items.length === 0) return;
          const at = items.indexOf(e.currentTarget.ownerDocument.activeElement as HTMLElement);
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
        <div id={props.id} role="menu" aria-label={t('autonomy.menu.label')}>
          {/* the four are one exclusive set; the allow-all row is not one of them */}
          <div role="group">
            {AUTONOMIES.map((m) => {
              const on = m === current;
              return (
                <button
                  key={m}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  data-autonomy-row={m}
                  data-current={on ? 'yes' : undefined}
                  className="model-menu-item"
                  disabled={modesUnavailable !== null}
                  // what the mode DOES, as the chip's own hover says it; on a
                  // greyed row, why it cannot be picked instead
                  title={modesUnavailable ?? autonomyDescription(t, m, claude)}
                  onClick={() => pick(m)}
                  style={modesUnavailable !== null ? { ...item, color: 'var(--muted)', cursor: 'default' } : item}
                >
                  {tick(on)}
                  <span style={{ fontWeight: on ? 700 : 400 }}>{t(`autonomy.menu.name.${m}`)}</span>
                </button>
              );
            })}
          </div>
          {allowAll && (
            <>
              <div role="separator" style={{ borderBlockStart: '1px solid var(--border)', marginBlock: 4 }} />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked
                data-testid="autonomy-menu-allow-all"
                className="model-menu-item"
                disabled={!onRevokeAllowAll}
                title={t('autonomy.menu.allowAllHint')}
                onClick={() => onRevokeAllowAll?.()}
                style={onRevokeAllowAll ? item : { ...item, color: 'var(--muted)', cursor: 'default' }}
              >
                {tick(true)}
                <span>{t('autonomy.menu.allowAll')}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
