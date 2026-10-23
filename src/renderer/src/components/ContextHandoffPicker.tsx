// "Hand this session's context to…" — the keyboard's way to START §5.5's
// hand-off (#851). The chip opens it on click, Enter or Space; the palette
// command opens the same one.
//
// IT ONLY PICKS. Choosing a session does exactly what dropping the chip on that
// session's prompt box does — it asks THAT composer to show `ContextDropDialog`
// — and nothing else; see `lib/context-handoff.ts`. So the fidelity choice, the
// sizes, the "nothing is sent" rule and every refusal stay the drop's own.
//
// PLAIN BUTTONS, NOT A LISTBOX. §5.32's third rule: composite roles only where
// they are true, and "plain buttons were shipped instead of a `listbox` that
// would have had to lie about its children". The arrow keys move between them
// as a convenience; Tab works too, because they are buttons.
//
// The dialog shape — scrim, click-away, Escape, focus capture and restore — is
// `ContextDropDialog`'s, which is the house shape (`ModelPickerDialog`,
// `McpManagerDialog`, `SettingsDialog`). It is rendered inside the source card,
// so `useModalLayer` is handed its own element: in a popped-out card it joins
// THAT window's stack, and `document` there is the popout's.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useModalLayer } from '../lib/modal-layer';

export interface HandoffTarget {
  /** card id */
  id: string;
  title: string;
  /** shown muted beside the name — two checkouts of one repo share a name */
  folder?: string;
}

export interface ContextHandoffPickerProps {
  /** the source session's name, for the heading */
  fromName: string;
  targets: readonly HandoffTarget[];
  onCancel: () => void;
  onChoose: (targetCardId: string) => void;
  /**
   * Where focus goes on cancel when the element that had it is gone — the
   * palette's route: the palette's input was focused when this opened, and it
   * has unmounted by the time anyone presses Escape. The card passes its chip.
   */
  fallbackFocus?: () => HTMLElement | null;
}

export function ContextHandoffPicker(props: ContextHandoffPickerProps): React.JSX.Element {
  const { t } = useTranslation();
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const { top, lift } = useModalLayer(true, dialog);
  /** where focus goes on cancel — the chip, or whatever the palette left */
  const returnFocusTo = React.useRef<HTMLElement | null>(null);

  // a LAYOUT effect: focused in the commit that shows it (#1171). The first
  // session gets focus, so Enter straight away picks the top of the rail —
  // the dialog itself only when there is nothing to pick.
  React.useLayoutEffect(() => {
    const doc = dialog.current?.ownerDocument ?? document;
    returnFocusTo.current = doc.activeElement as HTMLElement | null;
    const first = dialog.current?.querySelector<HTMLElement>('[data-handoff-target]');
    (first ?? dialog.current)?.focus();
  }, []);

  const cancel = (): void => {
    props.onCancel();
    const el = returnFocusTo.current;
    const fallback = props.fallbackFocus;
    // the opener's OWN window's frame clock: a popout's main window may be
    // minimised, and a throttled frame there would delay this one
    const raf = el?.ownerDocument.defaultView?.requestAnimationFrame ?? requestAnimationFrame;
    raf(() => {
      // `isConnected`, not `instanceof`: in a popped-out card this element
      // belongs to another window, where `instanceof HTMLElement` is false
      if (el?.isConnected && el !== el.ownerDocument.body) el.focus?.();
      else fallback?.()?.focus();
    });
  };

  /** Up/Down between the session buttons, wrapping — Tab still works */
  const moveFocus = (delta: number): void => {
    const root = dialog.current;
    if (!root) return;
    const buttons = Array.from(root.querySelectorAll<HTMLElement>('[data-handoff-target]'));
    if (buttons.length === 0) return;
    const at = buttons.indexOf(root.ownerDocument.activeElement as HTMLElement);
    const next = at < 0 ? 0 : (at + delta + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  return (
    <div
      onMouseDown={cancel}
      // rendered inside the card header, whose double-click maximizes the card
      // and whose tooltip says so — neither belongs over this dialog
      onDoubleClick={(e) => e.stopPropagation()}
      title=""
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51 + lift,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '10vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal={top ? 'true' : undefined}
        inert={!top}
        aria-label={t('contextHandoff.title', { from: props.fromName })}
        data-testid="context-handoff-picker"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // the picker owns its keys: the registry's chords must not fire under it
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveFocus(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveFocus(-1);
          }
        }}
        style={{
          inlineSize: 'min(440px, 94vw)',
          maxBlockSize: '70vh',
          overflowY: 'auto',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
          outline: 'none',
          textAlign: 'start',
        }}
      >
        <div
          style={{
            padding: '11px 14px',
            borderBlockEnd: '1px solid var(--border)',
            background: 'var(--panel2)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {t('contextHandoff.title', { from: props.fromName })}
        </div>
        <div
          style={{ padding: '8px 14px', fontSize: 11, color: 'var(--muted)', borderBlockEnd: '1px solid var(--border)' }}
        >
          {props.targets.length > 0 ? t('contextHandoff.hint') : t('contextHandoff.none')}
        </div>
        {props.targets.map((s) => (
          <button
            key={s.id}
            type="button"
            data-handoff-target={s.id}
            title={s.folder ?? s.title}
            onClick={() => props.onChoose(s.id)}
            style={{
              display: 'flex',
              inlineSize: '100%',
              alignItems: 'baseline',
              gap: 8,
              textAlign: 'start',
              padding: '9px 14px',
              background: 'transparent',
              border: 'none',
              borderBlockEnd: '1px solid var(--border)',
              color: 'var(--text)',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 12.5,
            }}
          >
            <span style={{ flexShrink: 0, fontWeight: 500 }}>{s.title}</span>
            {s.folder && (
              <span
                style={{
                  flex: 1,
                  minInlineSize: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 10.5,
                  color: 'var(--muted)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {s.folder}
              </span>
            )}
          </button>
        ))}
        <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            data-handoff-cancel
            onClick={cancel}
            style={{
              background: 'var(--chip)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-chip)',
              padding: '4px 12px',
              cursor: 'pointer',
              fontFamily: 'var(--font-ui)',
              fontSize: 11.5,
            }}
          >
            {t('contextHandoff.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
