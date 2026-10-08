// A group's right-click menu in the Sessions list (#1144).
//
// Groups had no menu before this: everything a group could do was a button on
// its header. Reordering is the first thing that does not fit there — the
// header is already a name, a count and three buttons — and the owner asked for
// it "on the menu first".
//
// A component of its own rather than a second branch of the session row's menu
// in `SessionsRail`: that one is tied to a row (its anchor, its pin and move
// errands, its submenus), and what the two share is a contract, not code. The
// contract is the same one, deliberately:
//
//   * placed against the WINDOW before anyone sees it (`placeMenu`, #641/#642)
//   * the first item takes focus as it opens; arrows walk a closed ring
//   * Escape closes and hands focus back; Tab, a click elsewhere and a window
//     resize close without
//   * an unavailable item is `aria-disabled`, not `disabled` — `focus()` on a
//     disabled button does nothing, which would break the ring at that item
import React from 'react';
import { MenuPlacement, placeMenu } from '../lib/menu-placement';
import { directionOf } from '../lib/writing-direction';

export interface RailGroupMenuItem {
  /** stable, for the key and for tests */
  id: string;
  label: string;
  /** false = shown, focusable, dimmed, and does nothing */
  can: boolean;
  run: () => void;
}

export function RailGroupMenu(props: {
  /** where the pointer was (or where the keyboard opened it), in client px */
  x: number;
  y: number;
  /** the menu's accessible name: which group this is for */
  label: string;
  items: readonly RailGroupMenuItem[];
  /** `restoreFocus` is true when the keyboard should go back where it came from */
  onClose: (restoreFocus: boolean) => void;
}): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = React.useState<MenuPlacement | null>(null);
  const { onClose } = props;

  React.useEffect(() => {
    const close = (): void => onClose(false);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose(true);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Measured at its natural size, then placed — one paint, already in the
  // window. See the session menu in `SessionsRail` for the long version.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.ownerDocument.documentElement;
    setPlace(
      placeMenu(
        { x: props.x, y: props.y },
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: root.clientWidth, height: root.clientHeight },
        { direction: directionOf(el) }
      )
    );
  }, [props.x, props.y]);

  React.useLayoutEffect(() => {
    if (!place) return;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [place]);

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="rail-group-menu"
      aria-label={props.label}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          onClose(false);
          return;
        }
        const items = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')
        );
        if (items.length === 0) return;
        const at = items.indexOf(e.currentTarget.ownerDocument.activeElement as HTMLElement);
        const go = (i: number): void => {
          e.preventDefault();
          items[(i + items.length) % items.length].focus();
        };
        if (e.key === 'ArrowDown') go(at + 1);
        else if (e.key === 'ArrowUp') go(at <= 0 ? items.length - 1 : at - 1);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(items.length - 1);
      }}
      style={{
        position: 'fixed',
        insetInlineStart: place ? place.insetInlineStart : 0,
        insetBlockStart: place ? place.insetBlockStart : 0,
        visibility: place ? undefined : 'hidden',
        maxBlockSize: place?.maxBlockSize,
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
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          data-group-menu-item={item.id}
          aria-disabled={!item.can}
          className="rail-menu-item"
          onClick={() => {
            if (!item.can) return; // aria-disabled is a claim; this is the fact
            // Focus is the CALLER's to place: a move re-orders the list, and
            // where the keyboard belongs afterwards is on the group that moved.
            onClose(false);
            item.run();
          }}
          style={{
            display: 'block',
            inlineSize: '100%',
            padding: '5px 9px',
            borderRadius: 4,
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text)',
            whiteSpace: 'nowrap',
            textAlign: 'start',
            fontSize: 11,
            fontFamily: 'var(--font-ui)',
            opacity: item.can ? 1 : 0.45,
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
