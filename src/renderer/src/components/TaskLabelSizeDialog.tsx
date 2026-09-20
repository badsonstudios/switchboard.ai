// Task label size (#877) — the one surface that sets how many lines a label
// may use.
//
// **Why a dialog and not a chip.** The same argument `QuietHoursDialog.tsx`
// makes in full, and it applies harder here: the title bar already overflowed
// once over this very feature (#879), which is why the label toggle is a
// three-state chip rather than two. This is also the wrong shape for a chip —
// a chip is a toggle you flip while working, and this is a preference you set
// when you decide how you like your rail and then forget. So it lives where the
// other set-it-once surfaces live: a palette command plus a button in the About
// panel. When the real settings screen lands (#885) these controls move into it
// and this file goes away.
//
// The dialog shape — scrim, click-away, focus capture, Escape — is
// `QuietHoursDialog.tsx`'s, which is `PushSetupDialog.tsx`'s: two modals that
// behave differently is a bug report waiting to happen.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { TASK_LABEL_SIZES, type TaskLabelSize } from '../../../shared/task-label-size';

export interface TaskLabelSizeDialogProps {
  open: boolean;
  onClose: () => void;
  /** what is stored right now — the renderer's copy, already sanitised */
  size: TaskLabelSize;
  onSet: (size: TaskLabelSize) => void;
}

export function TaskLabelSizeDialog(props: TaskLabelSizeDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const dialog = React.useRef<HTMLDivElement | null>(null);
  /**
   * The prefix for every `id` here (#654) — a HOOK, so it sits above the
   * `props.open` early return. `QuietHoursDialog.tsx` carries the full
   * argument: `<label for>` binds to the FIRST element in tree order with that
   * id, so a literal, published id is a name rendered content could take away
   * from this field. The `data-` attributes stay as the test hooks.
   */
  const fieldId = React.useId();

  React.useEffect(() => {
    if (!props.open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, [props.open]);

  if (!props.open) return null;

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  // No drafts and no Save button, unlike quiet hours: there is one control, its
  // values are a closed set, and the effect is visible on the rail BEHIND the
  // dialog the instant it is picked. A Save button here would only add a state
  // to forget to press.
  const option = (size: TaskLabelSize): React.JSX.Element => (
    <label
      key={size}
      htmlFor={`${fieldId}s-${size}`}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: '2px 8px',
        alignItems: 'start',
        cursor: 'pointer',
      }}
    >
      <input
        id={`${fieldId}s-${size}`}
        data-task-label-size={size}
        type="radio"
        name={`${fieldId}size`}
        checked={props.size === size}
        onChange={() => props.onSet(size)}
        style={{ marginBlockStart: 2 }}
      />
      <span style={{ fontSize: 11.5 }}>{t(`taskLabelSize.${size}`)}</span>
      <span />
      <span style={{ fontSize: 11, color: 'var(--faint)' }}>{t(`taskLabelSize.${size}Note`)}</span>
    </label>
  );

  return (
    <div
      onMouseDown={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51,
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
        aria-modal="true"
        aria-label={t('taskLabelSize.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        style={{
          inlineSize: 'min(460px, 94vw)',
          maxBlockSize: '80vh',
          overflowY: 'auto',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
          outline: 'none',
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
          {t('taskLabelSize.title')}
        </div>
        <p style={{ margin: 0, padding: '10px 14px 0', fontSize: 11.5, color: 'var(--muted)' }}>
          {t('taskLabelSize.blurb')}
        </p>

        <section
          role="radiogroup"
          aria-label={t('taskLabelSize.title')}
          style={{ display: 'grid', gap: 12, padding: '12px 14px' }}
        >
          {TASK_LABEL_SIZES.map(option)}
        </section>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
          }}
        >
          <button
            onClick={close}
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
            {t('taskLabelSize.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
