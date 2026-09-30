// The shared "compose → choose a channel → send" window (#1008).
//
// WHAT THIS IS AND IS NOT. It is the CHROME two dialogs were about to have two
// copies of: the scrim, the click-away, the focus capture, Escape, the header,
// the intro line, and the footer — a live region for the one sentence that says
// why a send failed, a Cancel, and a primary Send. It is not the form. What
// goes in the middle, what a send DOES, and whether logs ride along stay with
// the dialog that owns them, which is the difference #1008 named between Report
// a problem and Feature request: "two entry points differing in template and
// whether logs ride along".
//
// EVERY BUG #896 FOUND IS INHERITED HERE RATHER THAN REDISCOVERED, and that is
// the reason this file exists at all:
//
//   • **The Send button is `--btn-primary-*`, not `--accent`.** `--accent` is
//     defined only INSIDE a session card — each card sets its own identity hue
//     — so at the root, where these dialogs render, it is undefined: the fill
//     fell away and left a transparent button with near-black text, which the
//     owner read as disabled. Written as two whole style objects rather than one
//     with ternaries in the colour declarations, which is not cosmetic: the
//     theme drift check reads a ternary on a colour as an offender, and it is
//     right to.
//   • **A send that WORKED closes the dialog.** Only a failure keeps it, so the
//     user can switch channel or try again with their words intact. That
//     decision belongs to the owner — this file just makes sure the reason for
//     a failure is rendered BESIDE the button that was pressed, in a live
//     region that is always mounted, rather than at the foot of a scrolling
//     form where a short window hides it.
//   • **Fields are `box-sizing: border-box`.** At 100% width without it, every
//     field is 18px wider than the dialog and the whole form scrolls sideways.
import React from 'react';

export interface ComposeDialogProps {
  /**
   * The prefix for this dialog's `data-` hooks: `data-<kind>-dialog`,
   * `-submit`, `-cancel`, `-result`. A prop rather than a fixed name because
   * the unit tests and the e2e suite already select on the report dialog's
   * hooks, and a shared chrome that renamed them would be a refactor that broke
   * the tests proving the refactor was safe.
   */
  kind: string;
  /** already translated — this component owns no strings */
  title: string;
  intro: string;
  cancelLabel: string;
  submitLabel: string;
  /** the form itself */
  children: React.ReactNode;
  /** put this on nothing else: the hook that owns focus restoration supplies it */
  dialogRef: React.RefObject<HTMLDivElement | null>;
  /** Escape, the scrim, and Cancel all land here */
  onDismiss: () => void;
  onSubmit: () => void;
  canSubmit: boolean;
  /** why the button is dead, as its tooltip; omit when it is not */
  submitBlockedReason?: string | undefined;
  /** the one sentence that says why a send failed; null when none did */
  message: string | null;
}

/** the small grey caption above a field */
export const composeLabelStyle = { fontSize: 11.5, color: 'var(--muted)' } as const;

/** every text field in these dialogs — see the border-box note in the header */
export const composeFieldStyle = {
  background: 'var(--panel2)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '5px 8px',
  fontFamily: 'var(--font-ui)',
  fontSize: 12,
  inlineSize: '100%',
  boxSizing: 'border-box',
} as const;

const buttonBase: React.CSSProperties = {
  flexShrink: 0,
  whiteSpace: 'nowrap',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '5px 12px',
  fontSize: 12,
  fontFamily: 'var(--font-ui)',
};

const secondaryButton: React.CSSProperties = {
  ...buttonBase,
  background: 'var(--panel2)',
  color: 'var(--text)',
  cursor: 'pointer',
};

const primaryButton: React.CSSProperties = {
  ...buttonBase,
  background: 'var(--btn-primary-bg)',
  color: 'var(--btn-primary-text)',
};

/**
 * A button in one of these dialogs.
 *
 * `enabled` only ever touches `cursor` and `opacity` — never a colour — so the
 * whole-object rule in the header survives a caller that wants a dead button.
 */
export function composeButtonStyle(primary: boolean, enabled = true): React.CSSProperties {
  if (!primary) return secondaryButton;
  return { ...primaryButton, cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.5 };
}

export function ComposeDialog(props: ComposeDialogProps): React.JSX.Element {
  return (
    <div
      onMouseDown={props.onDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '8vh',
      }}
    >
      <div
        ref={props.dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        {...{ [`data-${props.kind}-dialog`]: '' }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // STOPPED HERE. These dialogs render at the root, over a grid whose
          // keys mean something to a session; a stray chord reaching through an
          // open modal would act on a card the user cannot currently see.
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            props.onDismiss();
          }
        }}
        style={{
          inlineSize: 'min(560px, 94vw)',
          maxBlockSize: '84vh',
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
          {props.title}
        </div>
        <p style={{ margin: 0, padding: '10px 14px 0', fontSize: 11.5, color: 'var(--muted)' }}>
          {props.intro}
        </p>

        <section style={{ display: 'grid', gap: 10, padding: '12px 14px' }}>
          {props.children}
        </section>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
            // pinned to the bottom of the dialog's scroller, so the buttons AND
            // the line that answers them are on screen however long the form is
            position: 'sticky',
            insetBlockEnd: 0,
            background: 'var(--panel)',
          }}
        >
          {/* ALWAYS MOUNTED, only its text changing: many screen readers skip a
              live region that arrives with its words already in it. It takes
              the slack in the row and wraps; the buttons never shrink, so a
              long reason cannot fold "Send" in two. */}
          <p
            role="status"
            aria-live="polite"
            style={{
              margin: 0,
              marginInlineEnd: 'auto',
              flex: '1 1 auto',
              minInlineSize: 0,
              fontSize: 12,
            }}
          >
            {props.message !== null && (
              <span {...{ [`data-${props.kind}-result`]: '' }}>{props.message}</span>
            )}
          </p>
          <button
            type="button"
            {...{ [`data-${props.kind}-cancel`]: '' }}
            onClick={props.onDismiss}
            style={composeButtonStyle(false)}
          >
            {props.cancelLabel}
          </button>
          <button
            type="button"
            {...{ [`data-${props.kind}-submit`]: '' }}
            onClick={props.onSubmit}
            disabled={!props.canSubmit}
            // a dead button says why
            {...(props.submitBlockedReason ? { title: props.submitBlockedReason } : {})}
            style={composeButtonStyle(true, props.canSubmit)}
          >
            {props.submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
