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
// THE WINDOW ITSELF IS `ComposeDialog` (#1008) — scrim, click-away, focus
// capture, Escape, focus restore, and the footer where a failure's reason sits
// beside the button that caused it. It used to be spelled out here, copied from
// `SettingsDialog.tsx`; when Feature request arrived it was about to be copied
// a third time, so it moved. Every fix this dialog earned the hard way lives
// there now and is documented there: the primary button's fill, the sideways
// scroll, the always-mounted live region. What stayed here is what is actually
// about reporting a problem — the fields, the destinations, the credential
// panel, and what a send means.
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ComposeDialog,
  composeButtonStyle,
  composeFieldStyle,
  composeLabelStyle,
} from './ComposeDialog';
import { useModalDismiss } from '../lib/modal-dismiss';
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
  const fieldId = React.useId();
  const { dialogRef, close } = useModalDismiss(props.open, props.onClose);

  const [subject, setSubject] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [destination, setDestination] = React.useState<ReportDestination>('github');
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  /** set when the store REFUSED the token — an empty field would otherwise read as success */
  const [tokenRefused, setTokenRefused] = React.useState(false);
  const [result, setResult] = React.useState<ReportResult | null>(null);
  /**
   * Which send is the CURRENT one. Bumped by every send, every CLOSE and every
   * re-open, and checked when a send settles: a report still in flight when the
   * dialog went away must not reach back into it or into the fresh one —
   * closing it, printing an old error in it, or clearing `busy` under a second
   * send, which would re-arm the button and let a third press file a duplicate
   * issue.
   */
  const attempt = React.useRef(0);

  React.useEffect(() => {
    // BUMPED BEFORE THE `open` GUARD (#1019), so CLOSING invalidates an
    // in-flight send too and not only re-opening — the fix #1008 made in the
    // twin. Cancel while a report is still being filed, click into a composer,
    // and a late success used to run `close()` a second time, whose focus
    // restore yanks the caret out of wherever the user went; a late failure set
    // an error line on a dialog nobody was looking at. The report itself is
    // unaffected: it was sent, and a filed issue still opens (see `submit`).
    attempt.current += 1;
    if (!props.open) return;
    // A re-open starts clean. A half-typed token left in the box from last time
    // is a credential on screen for no reason, and a stale success line would
    // claim something was filed that was not.
    setSubject('');
    setDescription('');
    setToken('');
    setBusy(false);
    setResult(null);
    setTokenRefused(false);
  }, [props.open]);

  if (!props.open) return null;

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
          // A send from an earlier opening, or one the dialog was closed on.
          // The issue it filed is real, so it may still open; this dialog,
          // though, is no longer its business.
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

  const label = composeLabelStyle;
  const input = composeFieldStyle;

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
    <ComposeDialog
      kind="report"
      dialogRef={dialogRef}
      onDismiss={close}
      title={t('report.title')}
      intro={t('report.intro')}
      cancelLabel={t('report.cancel')}
      submitLabel={busy ? t('report.working') : t('report.submit')}
      canSubmit={filable}
      // the subject is the one required field
      submitBlockedReason={
        subject.trim().length === 0 ? t('report.problem.emptySubject') : undefined
      }
      // `?? 'unavailable'` is unreachable — `result` is only ever set on a
      // failure — and is here for the type, not a case
      message={
        result === null
          ? null
          : t(`report.problem.${PROBLEM_KEY[reportProblem(result) ?? 'unavailable']}`)
      }
      onSubmit={submit}
    >
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
                <button type="button" onClick={saveToken} style={composeButtonStyle(false)}>
                  {t('report.tokenSave')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Only for GitHub: it explains why the zip is not attached to an ISSUE,
          which is not a thing the email or zip destinations do. */}
      {destination === 'github' && <p style={{ margin: 0, ...label }}>{t('report.bundleNote')}</p>}
    </ComposeDialog>
  );
}
