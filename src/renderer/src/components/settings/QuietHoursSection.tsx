// Quiet hours (P2-E14-05b, §5.9) — the one surface that sets the window.
//
// This was `QuietHoursDialog.tsx` until #885, and that file's own header said
// what would happen to it: "when the real settings screen lands, these controls
// move into it and this file goes away." It has. What moved is the CONTROL and
// every invariant it carries; the modal chrome around it — scrim, click-away,
// focus capture, Escape — is now `SettingsDialog.tsx`'s, once, for the whole
// screen, instead of three near-copies.
//
// The three invariants this section is NOT allowed to lose in the move, each
// pinned by a test that moved with it:
//
//  1. one-shot draft seeding that never eats a keystroke;
//  2. the SHARED `isUsableQuietWindow` validator, never a looser local copy;
//  3. "a control that refuses silently is the thing this is least allowed to
//     be" — every refusal puts a reason on screen.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { QuietState, isQuietTime, isUsableQuietWindow } from '../../../../shared/quiet-hours';
import { SettingItem, itemListStyle } from './controls';

export interface QuietHoursSectionProps {
  /**
   * Whether the settings modal is open. The section is only mounted while it
   * is, so this is `true` in every live render — it is a prop anyway because
   * the seeding rules below are stated in terms of an OPENING, and a test that
   * exercises "re-seeds on the next opening" has to be able to say so.
   */
  open: boolean;
  /**
   * null only for the frame before main answers. Main owns the clock the rules
   * are evaluated against, so `active` is asked rather than computed here — a
   * section that worked out its own "on right now" would be free to disagree
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

export function QuietHoursSection(props: QuietHoursSectionProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const configured = props.state?.window ?? null;
  // Drafts, so a half-typed "2" in the hours box does not write `02:00` to the
  // store and re-render the field out from under the user's next keystroke.
  const [start, setStart] = React.useState(DEFAULT_START);
  const [end, setEnd] = React.useState(DEFAULT_END);
  /** have the drafts taken main's answer for THIS opening yet? */
  const seeded = React.useRef(false);
  /** …or has the user already typed, making the answer no longer theirs to take? */
  const touched = React.useRef(false);
  /**
   * The prefix for every `id` in this section (#654). A HOOK, so it sits with
   * the others and above the `props.open` early return. `PushSection.tsx`
   * carries the argument in full: a LITERAL `id` is a name rendered content can
   * address, `id` survives the sanitizer profile, and `<label for>` binds to the
   * FIRST element in tree order with that id — so a `quiet-field-start` planted
   * EARLIER than this section would take this label away from this field.
   *
   * "EARLIER" IS A REAL CONDITION: `App.tsx` renders the settings modal before
   * `SessionGrid`, so feed and viewer content is always later and never
   * captured these ids. Prophylaxis against a reorder, not a live fix — and
   * `React.useId()` alone is not a secret either (React numbers client ids
   * from a global counter); what it removes is a STABLE, PUBLISHED name, and
   * since #673 the root's per-launch `identifierPrefix` makes the composed id
   * unguessable as well. `data-quiet-field` stays: it is the test hook, not an
   * `id`.
   */
  const fieldId = React.useId();

  React.useEffect(() => {
    if (props.open) return;
    seeded.current = false;
    touched.current = false;
  }, [props.open]);

  /**
   * Seed the drafts from main's answer — ONCE per opening, and not before the
   * answer arrives.
   *
   * Both halves of that matter, and getting either wrong is a data-loss bug
   * rather than a cosmetic one:
   *
   * - **Not on `open` alone.** `App` fetches the state when the modal opens,
   *   so `props.state` is null on the first render. Seeding then would show
   *   22:00–07:00 to someone whose window is 23:00–06:00 — and the moment they
   *   nudged one field, the write-through below would send the OTHER field's
   *   default and silently move a time they never touched.
   * - **Only once.** Every write triggers a re-read, so re-seeding on each
   *   answer would overwrite whatever the user was typing the instant their
   *   previous keystroke landed.
   * - **And never over a keystroke.** The answer is one IPC round trip away,
   *   which is not long — but it is long enough for someone who opened this
   *   screen to change one number and started typing immediately, and a form
   *   that eats the first thing you type is a form you stop trusting. Once the
   *   user has touched a field, the drafts are theirs and the answer only ever
   *   feeds the status line.
   */
  React.useEffect(() => {
    if (!props.open || seeded.current || touched.current || props.state === null) return;
    seeded.current = true;
    setStart(props.state.window?.start ?? DEFAULT_START);
    setEnd(props.state.window?.end ?? DEFAULT_END);
  }, [props.open, props.state]);

  if (!props.open) return null;

  const on = configured !== null;
  // Why the pair is unusable, if it is — `null` when it is fine. Both branches
  // put a REASON on screen: a control that refuses silently is the thing this
  // section is least allowed to be, since its whole subject is a feature you
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
      <label htmlFor={`${fieldId}f-${id}`} style={{ fontSize: 11.5, color: 'var(--muted)' }}>
        {t(`quiet.${id}`)}
      </label>
      <input
        id={`${fieldId}f-${id}`}
        data-quiet-field={id}
        type="time"
        value={value}
        onChange={(e) => {
          touched.current = true;
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
    <div data-settings-block="quiet-hours" style={itemListStyle}>
      <SettingItem item="quiet-hours" label={t('quiet.title')} blurb={t('quiet.intro')}>
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
            <input
              type="checkbox"
              data-quiet-field="enabled"
              checked={on}
              onChange={(e) => {
                touched.current = true;
                apply(e.target.checked);
              }}
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
        </div>
      </SettingItem>

      {/* ── what it does, and what it deliberately does not ─────────────── */}
      <SettingItem item="quiet-hours-effect" label={t('quiet.whatHappens')}>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('quiet.personFacing')}</span>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('quiet.machineFacing')}</span>
          {/* A feature whose whole job is to do nothing is one the user cannot
              tell is working. This line is the proof it is. */}
          <span data-quiet-status style={{ fontSize: 11, color: 'var(--faint)' }}>
            {!props.state
              ? t('quiet.status.unknown')
              : props.state.active
                ? t('quiet.status.active', { count: props.state.heldCount })
                : on
                  ? t('quiet.status.idle', { count: props.state.heldCount })
                  : t('quiet.status.off')}
          </span>
        </div>
      </SettingItem>
    </div>
  );
}
