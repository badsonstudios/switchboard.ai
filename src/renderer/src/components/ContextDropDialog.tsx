// The drop dialog (P2-E11-10, §5.5): "Inject: last response | summary handoff |
// full excerpt…" with a size beside each.
//
// WHY A DIALOG AND NOT AN INJECTION. §5.5 asks for one by name, and the reason
// is the numbers: the three fidelities differ by an order of magnitude, and the
// largest of them lands in the TARGET's context window and spends the target's
// rate limit. A drop that injected silently would make that choice for the user
// every time, invisibly, and the only way to undo it would be to find and delete
// a few thousand tokens out of a prompt box.
//
// NOTHING IS SENT HERE, and nothing in this file could. OK parks a block in the
// target card's composer; the user presses Enter there, or dismisses it. That is
// §5.4's delivery rule, and this rides `#765`'s seam rather than opening a
// second one — see `lib/sibling-inbox.ts`.
//
// The dialog SHAPE — scrim, click-away, Escape, focus capture and restore, a
// radiogroup, Cancel/OK commit semantics — is `ModelPickerDialog`'s, which is
// `McpManagerDialog`'s, which is `QuietHoursDialog`'s. Two modals that behave
// differently is a bug report waiting to happen.
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_FIDELITY,
  type ContextFidelity,
  type ContextOffer,
  type ContextOfferOption,
} from '../../../shared/context-drop';

export interface ContextDropDialogProps {
  offer: ContextOffer;
  /** the target session's name — whose composer this lands in */
  targetName?: string;
  onCancel: () => void;
  onChoose: (option: ContextOfferOption) => void;
}

/**
 * Group a number without `toLocaleString`.
 *
 * The same rule `context-package.ts` states for the document it renders, applied
 * to the dialog that quotes its figures: `Intl` formats to the machine's locale,
 * so the identical package would read `3,100` on one of the user's computers and
 * `3.100` on another — and the dialog would then disagree with the `Estimated
 * size` line inside the very document it is describing.
 */
function groupDigits(n: number): string {
  const s = String(Math.max(0, Math.floor(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

export function ContextDropDialog(props: ContextDropDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const dialog = React.useRef<HTMLDivElement | null>(null);
  /**
   * §5.5 NAMES LEVEL 2 AS THE DEFAULT, so the dialog opens on it rather than on
   * the first row. Seeded from the shared constant, not from a literal, so the
   * test that pins the default and the component that implements it cannot
   * drift apart.
   *
   * Falls back to the first offered option only if the default is somehow not
   * present — an offer is built from `CONTEXT_FIDELITIES`, so that is a
   * should-not-happen, and a dialog with nothing selected would have a dead OK.
   */
  const [chosen, setChosen] = React.useState<ContextFidelity>(() =>
    props.offer.options.some((o) => o.id === DEFAULT_FIDELITY)
      ? DEFAULT_FIDELITY
      : props.offer.options[0].id
  );
  /** where focus goes on close — a drop means the pointer was just here */
  const returnFocusTo = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    returnFocusTo.current = document.activeElement as HTMLElement | null; // before we take it
    dialog.current?.focus();
  }, []);

  const close = (): void => {
    props.onCancel();
    // …on the NEXT frame: this element still holds focus until React has
    // committed the unmount. The same shape the other overlays use.
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const selected = props.offer.options.find((o) => o.id === chosen);

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
        aria-label={t('contextDrop.title')}
        data-testid="context-drop"
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
          inlineSize: 'min(560px, 94vw)',
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
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, minInlineSize: 0 }}>
            {t('contextDrop.title')}
            <span style={{ fontWeight: 400, color: 'var(--muted)', marginInlineStart: 6 }}>
              {props.targetName
                ? t('contextDrop.fromTo', { from: props.offer.from.name, to: props.targetName })
                : t('contextDrop.from', { from: props.offer.from.name })}
            </span>
          </span>
          <button
            type="button"
            onClick={close}
            aria-label={t('contextDrop.close')}
            title={t('contextDrop.close')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: 4,
            }}
          >
            {t('contextDrop.closeIcon')}
          </button>
        </div>

        {/* COVERAGE, AT THE TOP, BEFORE THE CHOICE. The person picking a
            fidelity is owed the same caveat the receiving model gets — "the most
            recent part of it" is precisely what makes the difference between the
            three options matter, and burying it under the rows would let someone
            choose the whole handoff believing it covered the whole conversation.
            `unreadable` is its own sentence for #766's reason: every option will
            look empty, and that is a fact about the READ, not about the work. */}
        <div
          data-context-coverage={props.offer.coverage}
          style={{
            padding: '9px 14px',
            borderBlockEnd: '1px solid var(--border)',
            fontSize: 11,
            color: props.offer.coverage === 'unreadable' ? 'var(--status-crashed-ink)' : 'var(--muted)',
          }}
        >
          {t(`contextDrop.coverage.${props.offer.coverage}`)}
        </div>

        <div role="radiogroup" aria-label={t('contextDrop.title')}>
          {props.offer.options.map((o) => {
            const on = o.id === chosen;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={on}
                data-context-option={o.id}
                data-selected={on ? 'yes' : undefined}
                data-context-empty={o.empty ? 'yes' : undefined}
                // ON THE ROW, beside `data-context-empty`, rather than on the
                // span that paints it: a test or an e2e asking "what size does
                // this dialog report for the summary handoff" names the OPTION,
                // and the option is this element.
                data-context-tokens={o.tokens}
                onClick={() => setChosen(o.id)}
                style={{
                  display: 'flex',
                  inlineSize: '100%',
                  alignItems: 'baseline',
                  gap: 10,
                  textAlign: 'start',
                  padding: '10px 14px',
                  background: on ? 'var(--panel2)' : 'transparent',
                  border: 'none',
                  borderBlockEnd: '1px solid var(--border)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                {/* A real character rather than a colour, so the chosen row is
                    legible without colour vision and in a screenshot;
                    `aria-checked` carries it for a reader. Ordinary ink, not an
                    accent — the house rule `tokens.drift.test.ts` enforces is
                    that an accent is a FIELD, never the words on one. */}
                <span aria-hidden style={{ inlineSize: 14, color: 'var(--text)' }}>
                  {on ? t('contextDrop.currentMark') : ''}
                </span>
                <span style={{ flex: 1, minInlineSize: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: on ? 600 : 500 }}>
                    {t(`contextDrop.option.${o.id}`)}
                    {o.id === DEFAULT_FIDELITY && (
                      <span
                        data-context-default
                        style={{ fontWeight: 400, color: 'var(--faint)', fontSize: 10.5, marginInlineStart: 6 }}
                      >
                        {t('contextDrop.defaultMark')}
                      </span>
                    )}
                  </span>
                  <span
                    style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginBlockStart: 2 }}
                  >
                    {t(`contextDrop.hint.${o.id}`)}
                  </span>
                </span>
                {/* THE SIZE, AND WHETHER IT IS THIN. The estimate is the
                    package's own (see `ContextOfferOption.tokens`); the "nothing
                    recorded" mark is the done-when that a thin option must not
                    look full. Marked rather than hidden or disabled: the text is
                    still a true statement about the session, and removing the
                    row would make an empty option indistinguishable from one
                    that was never offered. */}
                <span
                  style={{ fontSize: 10.5, color: 'var(--faint)', flexShrink: 0, fontFamily: 'var(--font-mono)' }}
                >
                  {o.empty
                    ? t('contextDrop.emptyMark')
                    : t('contextDrop.tokens', { tokens: groupDigits(o.tokens) })}
                </span>
              </button>
            );
          })}
        </div>

        {/* The one sentence that makes the whole gesture safe to use, said where
            the decision is made rather than only in the manual. */}
        <div
          style={{
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
            fontSize: 10.5,
            color: 'var(--faint)',
          }}
        >
          {t('contextDrop.note')}
        </div>

        <div
          style={{
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, minInlineSize: 0 }} />
          <button
            type="button"
            data-context-cancel
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
            {t('contextDrop.cancel')}
          </button>
          <button
            type="button"
            data-context-ok
            disabled={!selected}
            onClick={() => selected && props.onChoose(selected)}
            style={{
              background: 'var(--chip)',
              color: selected ? 'var(--text)' : 'var(--muted)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-chip)',
              padding: '4px 14px',
              cursor: selected ? 'pointer' : 'default',
              fontFamily: 'var(--font-ui)',
              fontSize: 11.5,
              fontWeight: 600,
            }}
          >
            {t('contextDrop.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
