// Help ▸ Report a problem… (#815).
//
// The dialog collects a subject and a description and hands them to main,
// which builds the zip and files the report. What it deliberately does NOT do:
//
// - **It never shows a stored credential.** There is no channel that can read
//   one back (`main/diagnostics/report-ipc.ts`), so the GitHub token field is
//   empty on open and a saved one reads "in use". That is the same contract
//   `settings/PushSection.tsx` keeps, for the same reason.
// - **It does not promise to attach the zip.** GitHub's API cannot attach a
//   file to an issue — only its web form can — so the dialog says where the zip
//   is and that it must be dragged on. A button implying otherwise would drop
//   the evidence this feature exists to move.
//
// The dialog shape — scrim, click-away, focus capture, Escape, focus restore —
// is `SettingsDialog.tsx`'s, on purpose: two modals that behave differently
// is a bug report waiting to happen.
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  REPORT_DESTINATIONS,
  type ReportDestination,
  type ReportDraft,
  type ReportProblem,
  type ReportResult,
  type ReportStatus,
  type ReportWriteResult,
} from '../../../shared/diagnostics';

export interface ReportProblemDialogProps {
  open: boolean;
  onClose: () => void;
  /** null only for the frame before main answers */
  status: ReportStatus | null;
  onSubmit: (draft: ReportDraft) => Promise<ReportResult>;
  /** store a GitHub token; an empty string forgets it */
  onSetToken: (value: string) => Promise<ReportWriteResult>;
  /** hand the new issue's URL to the browser */
  onOpenIssue?: (url: string) => void;
}

/** `ReportProblem` -> the i18n key under `report.problem` */
const PROBLEM_KEY: Record<ReportProblem, string> = {
  'empty-subject': 'emptySubject',
  'no-token': 'noToken',
  auth: 'auth',
  refused: 'refused',
  'rate-limited': 'rateLimited',
  network: 'network',
  'bundle-failed': 'bundleFailed',
  'mail-failed': 'mailFailed',
  unavailable: 'unavailable',
};

const LABEL: Record<ReportDestination, string> = {
  github: 'toGithub',
  email: 'toEmail',
  zip: 'toZip',
};
const HINT: Record<ReportDestination, string> = {
  github: 'toGithubHint',
  email: 'toEmailHint',
  zip: 'toZipHint',
};

/**
 * What went wrong with a send, or null if nothing did.
 *
 * `ok: false` is a failure even with no `problem` attached — main's zip-only
 * path reports a zip it could not write as exactly that, and reading "no
 * problem" as success told the user "the zip is ready" about a zip that did not
 * exist.
 */
function reportProblem(r: ReportResult): ReportProblem | null {
  if (r.problem) return r.problem;
  if (r.ok) return null;
  return r.bundle.ok ? 'unavailable' : 'bundle-failed';
}

export function ReportProblemDialog(props: ReportProblemDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const fieldId = React.useId();

  const [subject, setSubject] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [destination, setDestination] = React.useState<ReportDestination>('github');
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  /** set when the store REFUSED the token — an empty field would otherwise read as success */
  const [tokenRefused, setTokenRefused] = React.useState(false);
  const [result, setResult] = React.useState<ReportResult | null>(null);
  /**
   * Which send is the CURRENT one. Bumped by every send and every re-open, and
   * checked when a send settles: a report still in flight when the dialog was
   * closed and re-opened must not reach into the fresh one — closing it,
   * printing an old error in it, or clearing `busy` under a second send, which
   * would re-arm the button and let a third press file a duplicate issue.
   */
  const attempt = React.useRef(0);

  React.useEffect(() => {
    if (!props.open) return;
    attempt.current += 1;
    // A re-open starts clean. A half-typed token left in the box from last time
    // is a credential on screen for no reason, and a stale success line would
    // claim something was filed that was not.
    setSubject('');
    setDescription('');
    setToken('');
    setBusy(false);
    setResult(null);
    setTokenRefused(false);
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, [props.open]);

  if (!props.open) return null;

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const canFile = props.status?.canFileIssue === true;
  const filable = subject.trim().length > 0 && !busy;

  const submit = (): void => {
    if (!filable) return;
    const mine = ++attempt.current;
    setBusy(true);
    setResult(null);
    void props
      .onSubmit({ subject, description, destination })
      // `.catch` here rather than trusting the caller never to reject — the
      // same stance `saveToken` takes below
      .catch((): ReportResult => ({
        ok: false,
        destination,
        url: null,
        number: null,
        bundle: { ok: false, path: null, bytes: 0, skipped: [] },
        problem: 'unavailable',
      }))
      .then((r) => {
        if (attempt.current !== mine) {
          // A send from an earlier opening. The issue it filed is real, so it
          // may still open; this dialog, though, is no longer its business.
          if (reportProblem(r) === null && r.url) props.onOpenIssue?.(r.url);
          return;
        }
        // A SEND THAT WORKED CLOSES THE DIALOG. Leaving it open with a success
        // line at the foot of a scrolling form read, to the owner, as a button
        // that did nothing. Every successful destination already shows its own
        // proof outside this window — the zip's folder is revealed, the mail app
        // opens — and a filed issue is opened in the browser here, which is the
        // one confirmation nobody can miss. Only a FAILURE keeps the dialog, so
        // the user can switch destination or try again with their words intact.
        if (reportProblem(r) === null) {
          // close FIRST: a browser hand-off that throws must not strand the
          // dialog open over a report that was, in fact, sent
          close();
          if (r.url) props.onOpenIssue?.(r.url);
          return;
        }
        setResult(r);
      })
      .finally(() => {
        if (attempt.current === mine) setBusy(false);
      });
  };

  const saveToken = (): void => {
    // The field is cleared ONLY on a write that happened. Clearing regardless
    // would show an empty box — which reads as "saved" — for a machine that
    // refused to keep it.
    //
    // `.catch` is here rather than left to the caller: a component that depends
    // on its parent never rejecting is a component that breaks when someone
    // rewires it.
    void props
      .onSetToken(token)
      .then((r) => {
        setTokenRefused(!r.ok);
        if (r.ok) setToken('');
      })
      .catch(() => setTokenRefused(true));
  };

  const label = { fontSize: 11.5, color: 'var(--muted)' } as const;
  const input = {
    background: 'var(--panel2)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '5px 8px',
    fontFamily: 'var(--font-ui)',
    fontSize: 12,
    inlineSize: '100%',
    // padding and border INSIDE the 100%, or every field is 18px wider than the
    // dialog and the whole form scrolls sideways
    boxSizing: 'border-box',
  } as const;
  // THE APP'S PRIMARY BUTTON, not a session accent. This used `--accent`, which
  // only exists INSIDE a session card (each card sets its own identity hue);
  // this dialog renders at the root, where it is undefined — so the fill fell
  // away and left a transparent button with near-black `--accent-ink-on-fill`
  // text, which the owner read as disabled. `--btn-primary-*` is theme-level,
  // defined everywhere, and what every other Send button uses.
  //
  // Written as two whole objects rather than one with ternaries in the colour
  // declarations, which is not cosmetic: the theme drift test reads a ternary
  // on a colour as an offender, and it is right to. That is exactly how a hue
  // ends up on words by accident.
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
    cursor: filable ? 'pointer' : 'default',
    opacity: filable ? 1 : 0.5,
  };
  const button = (primary: boolean): React.CSSProperties =>
    primary ? primaryButton : secondaryButton;

  /** the one line that says whether a GitHub issue can be filed at all */
  const tokenLine = (): string => {
    // "We have not asked yet" is not "we asked and there is nothing" — and it
    // is certainly not "this machine cannot keep secrets". Saying so keeps the
    // panel from rendering as an empty bordered box while the answer is in
    // flight, or when the bridge could not be reached at all.
    if (props.status === null) return t('report.statusUnknown');
    if (props.status.tokenStored) return t('report.tokenStored');
    if (props.status.canFileIssue) return t('report.tokenFromCli');
    if (!props.status.storeAvailable) return t('report.tokenUnavailable');
    return t('report.tokenNone');
  };

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
        paddingBlockStart: '8vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('report.title')}
        tabIndex={-1}
        data-report-dialog
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
          {t('report.title')}
        </div>
        <p style={{ margin: 0, padding: '10px 14px 0', fontSize: 11.5, color: 'var(--muted)' }}>
          {t('report.intro')}
        </p>

        <section style={{ display: 'grid', gap: 10, padding: '12px 14px' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <label htmlFor={`${fieldId}f-subject`} style={label}>
              {t('report.subject')}
            </label>
            <input
              id={`${fieldId}f-subject`}
              data-report-field="subject"
              value={subject}
              placeholder={t('report.subjectPlaceholder')}
              onChange={(e) => setSubject(e.target.value)}
              style={input}
            />
          </div>

          <div style={{ display: 'grid', gap: 4 }}>
            <label htmlFor={`${fieldId}f-description`} style={label}>
              {t('report.description')}
            </label>
            <textarea
              id={`${fieldId}f-description`}
              data-report-field="description"
              value={description}
              rows={6}
              placeholder={t('report.descriptionPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
              style={{ ...input, resize: 'vertical', fontFamily: 'var(--font-ui)' }}
            />
          </div>

          <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 6 }}>
            <legend style={{ ...label, padding: 0 }}>{t('report.destination')}</legend>
            {REPORT_DESTINATIONS.map((d) => (
              <label
                key={d}
                style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 6, fontSize: 12 }}
              >
                <input
                  type="radio"
                  name={`${fieldId}dest`}
                  data-report-destination={d}
                  checked={destination === d}
                  onChange={() => setDestination(d)}
                />
                <span>
                  {t(`report.${LABEL[d]}`)}
                  <span style={{ display: 'block', ...label }}>{t(`report.${HINT[d]}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {destination === 'github' && (
            <div
              data-report-token
              style={{
                display: 'grid',
                gap: 6,
                padding: '8px 10px',
                background: 'var(--panel2)',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}
            >
              <span style={label}>{tokenLine()}</span>
              {tokenRefused && (
                <span data-report-token-refused style={label}>
                  {t('report.tokenNotStored')}
                </span>
              )}
              {!canFile && props.status?.storeAvailable === true && (
                <>
                  <span style={label}>{t('report.tokenIntro')}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      aria-label={t('report.tokenLabel')}
                      data-report-field="token"
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      style={input}
                    />
                    <button type="button" onClick={saveToken} style={button(false)}>
                      {t('report.tokenSave')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Only for GitHub: it explains why the zip is not attached to an
              ISSUE, which is not a thing the email or zip destinations do. */}
          {destination === 'github' && (
            <p style={{ margin: 0, ...label }}>{t('report.bundleNote')}</p>
          )}

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
          {/* WHY A SEND FAILED, beside the button that was pressed. It used to
              sit at the foot of the form, below a six-line description box —
              off screen in a short window, so a failed send looked like a dead
              button. Only failures reach here: a success closes the dialog.
              ANNOUNCED: it is the answer to a button the user just pressed, and
              without a live region a screen-reader user hears nothing. The
              region is ALWAYS mounted and only its text changes — many screen
              readers skip a live region that arrives with its words already in
              it. It takes the slack in the row and wraps; the buttons never
              shrink, so a long reason cannot fold "Send report" in two. */}
          <p
            role="status"
            aria-live="polite"
            style={{ margin: 0, marginInlineEnd: 'auto', flex: '1 1 auto', minInlineSize: 0, fontSize: 12 }}
          >
            {result !== null && (
              <span data-report-result>
                {/* `?? 'unavailable'` is unreachable — `result` is only ever
                    set on a failure — and is here for the type, not a case */}
                {t(`report.problem.${PROBLEM_KEY[reportProblem(result) ?? 'unavailable']}`)}
              </span>
            )}
          </p>
          <button type="button" data-report-cancel onClick={close} style={button(false)}>
            {t('report.cancel')}
          </button>
          <button
            type="button"
            data-report-submit
            onClick={submit}
            disabled={!filable}
            // a dead button says why — the subject is the one required field
            title={subject.trim().length === 0 ? t('report.problem.emptySubject') : undefined}
            style={button(true)}
          >
            {busy ? t('report.working') : t('report.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
