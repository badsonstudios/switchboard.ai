// Quiet hours (P2-E14-05b, §5.9) — the one surface that sets the window.
//
// **Why a modal and not a chip.** The title bar already carries eleven chips;
// a twelfth would be a settings screen assembled one control at a time by
// whoever shipped last, which is how a title bar becomes a toolbar nobody can
// read. Quiet hours are also the wrong shape for a chip: a chip is a toggle you
// flip while working, and this is two times you type once and then forget for a
// year. So it lives where the other set-it-once surface lives — a palette
// command and a button in the About panel, exactly like `PushSetupDialog`. When
// the real settings screen lands (#528 may relocate it), these controls move
// into it and this file goes away.
//
// The dialog shape — scrim, click-away, focus capture, Escape — is
// `PushSetupDialog.tsx`'s, which is `AboutPanel.tsx`'s: two modals that behave
// differently is a bug report waiting to happen.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { QuietState, isQuietTime, isUsableQuietWindow } from '../../../shared/quiet-hours';

export interface QuietHoursDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * null only for the frame before main answers. Main owns the clock the rules
   * are evaluated against, so `active` is asked rather than computed here — a
   * dialog that worked out its own "on right now" would be free to disagree
   * with the engine about whether it is 07:00 yet.
   */
  state: QuietState | null;
  /** both ends together, or null to switch quiet hours off entirely */
  onSet: (window: { start: string; end: string } | null) => void;
}

/**
 * `"22:00"` — what an `<input type="time">` emits and the store accepts.
 *
 * The SAME predicate main validates with (`events/rules.ts`), imported rather
 * than re-written: a looser copy here would accept `99:99`, write it, and have
 * main drop it — leaving the field reverting with nothing on screen to say why.
 */
const isTime = isQuietTime;

const DEFAULT_START = '22:00';
const DEFAULT_END = '07:00';

export function QuietHoursDialog(props: QuietHoursDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const configured = props.state?.window ?? null;
  // Drafts, so a half-typed "2" in the hours box does not write `02:00` to the
  // store and re-render the field out from under the user's next keystroke.
  const [start, setStart] = React.useState(DEFAULT_START);
  const [end, setEnd] = React.useState(DEFAULT_END);
  /** have the drafts taken main's answer for THIS opening yet? */
  const seeded = React.useRef(false);

  React.useEffect(() => {
    if (!props.open) {
      seeded.current = false;
      return;
    }
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, [props.open]);

  /**
   * Seed the drafts from main's answer — ONCE per opening, and not before the
   * answer arrives.
   *
   * Both halves of that matter, and getting either wrong is a data-loss bug
   * rather than a cosmetic one:
   *
   * - **Not on `open` alone.** `App` fetches the state when the dialog opens,
   *   so `props.state` is null on the first render. Seeding then would show
   *   22:00–07:00 to someone whose window is 23:00–06:00 — and the moment they
   *   nudged one field, the write-through below would send the OTHER field's
   *   default and silently move a time they never touched.
   * - **Only once.** Every write triggers a re-read, so re-seeding on each
   *   answer would overwrite whatever the user was typing the instant their
   *   previous keystroke landed.
   */
  React.useEffect(() => {
    if (!props.open || seeded.current || props.state === null) return;
    seeded.current = true;
    setStart(props.state.window?.start ?? DEFAULT_START);
    setEnd(props.state.window?.end ?? DEFAULT_END);
  }, [props.open, props.state]);

  if (!props.open) return null;

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const on = configured !== null;
  // Why the pair is unusable, if it is — `null` when it is fine. Both branches
  // put a REASON on screen: a control that refuses silently is the thing this
  // dialog is least allowed to be, since its whole subject is a feature you
  // cannot see working. (An `<input type="time">` can be cleared to `''`, which
  // is how `missing` happens.)
  const problem: 'same' | 'missing' | null =
    !isTime(start) || !isTime(end) ? 'missing' : start === end ? 'same' : null;
  const usable = problem === null;

  const apply = (nextOn: boolean): void => {
    if (!nextOn) return props.onSet(null);
    if (usable) props.onSet({ start, end });
  };

  const timeField = (
    id: 'start' | 'end',
    value: string,
    set: (v: string) => void
  ): React.JSX.Element => (
    <div style={{ display: 'grid', gap: 4 }}>
      <label htmlFor={`quiet-field-${id}`} style={{ fontSize: 11.5, color: 'var(--muted)' }}>
        {t(`quiet.${id}`)}
      </label>
      <input
        id={`quiet-field-${id}`}
        data-quiet-field={id}
        type="time"
        value={value}
        onChange={(e) => {
          set(e.target.value);
          // Write through on every valid edit rather than behind a Save button:
          // there are two fields, both always valid or obviously not, and the
          // status line below reports what main actually stored — so there is
          // nothing a Save button would add except a state to forget to press.
          // The SAME gate main's sanitizer applies, so a write that reaches it
          // is never one it will silently drop.
          const next = id === 'start' ? { start: e.target.value, end } : { start, end: e.target.value };
          if (on && isUsableQuietWindow(next.start, next.end)) props.onSet(next);
        }}
        style={{
          background: 'var(--panel2)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '4px 8px',
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
        }}
      />
    </div>
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
        aria-label={t('quiet.title')}
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
          {t('quiet.title')}
        </div>
        <p style={{ margin: 0, padding: '10px 14px 0', fontSize: 11.5, color: 'var(--muted)' }}>
          {t('quiet.intro')}
        </p>

        <section style={{ display: 'grid', gap: 10, padding: '12px 14px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
            <input
              type="checkbox"
              data-quiet-field="enabled"
              checked={on}
              onChange={(e) => apply(e.target.checked)}
            />
            {t('quiet.enable')}
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            {timeField('start', start, setStart)}
            {timeField('end', end, setEnd)}
          </div>
          {problem && (
            <span
              data-quiet-problem={problem}
              style={{ fontSize: 11, color: 'var(--status-needs-input-ink)' }}
            >
              {t(`quiet.problem.${problem}`)}
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>{t('quiet.overnightHint')}</span>
        </section>

        {/* ── what it does, and what it deliberately does not ─────────────── */}
        <section
          style={{
            display: 'grid',
            gap: 6,
            padding: '12px 14px',
            borderBlockStart: '1px solid var(--border)',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 12, fontWeight: 600 }}>{t('quiet.whatHappens')}</h2>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('quiet.personFacing')}</span>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('quiet.machineFacing')}</span>
        </section>

        {/* A feature whose whole job is to do nothing is one the user cannot
            tell is working. These two lines are the proof it is. */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
          }}
        >
          <span data-quiet-status style={{ fontSize: 11, color: 'var(--faint)' }}>
            {!props.state
              ? t('quiet.status.unknown')
              : props.state.active
                ? t('quiet.status.active', { count: props.state.heldCount })
                : on
                  ? t('quiet.status.idle', { count: props.state.heldCount })
                  : t('quiet.status.off')}
          </span>
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
            {t('quiet.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
