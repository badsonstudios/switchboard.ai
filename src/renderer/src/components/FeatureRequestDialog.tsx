// Help ▸ Feature request… (#1008) — Report a problem's twin, minus the evidence.
//
// The window is `ComposeDialog`, the same one `ReportProblemDialog` uses, so
// every fix that dialog earned the hard way (#896: a primary button that drew
// transparent and read as disabled, a send that left the window open and looked
// like a dead button, fields that scrolled the form sideways) arrives here
// already made rather than waiting to be rediscovered. What differs is exactly
// what #1008 said should differ: the template, and whether logs ride along.
// None do. There is nothing to collect — a feature request is a sentence
// somebody thought of while using the app, and zipping their log files to carry
// it would be evidence for a case nobody is making.
//
// NOTHING LEAVES THIS MACHINE FROM HERE. It opens a pre-filled form in an
// application the user already owns — their browser, on GitHub's new-issue
// page — and waits for them to press Submit in it. There is no background
// submission and no telemetry, which is a hard constraint of the item (P8)
// rather than a preference, and this shape is how it is kept: there is no code
// path in this feature that could post anything.
//
// NO CHANNEL PICKER (#1494). There were two — email and the ticket form — and
// email was removed once the repo went public. A picker with one choice in it
// is a question with no answer, so the choice is gone, not just the option.
// What the form needs (a GitHub account signed in in the browser) is said on
// screen, because it is the one way this control can look broken to someone
// who did nothing wrong.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ComposeDialog, composeFieldStyle, composeLabelStyle } from './ComposeDialog';
import { useModalDismiss } from '../lib/modal-dismiss';
import {
  isSendable,
  type FeatureRequestDraft,
  type FeedbackProblem,
  type FeedbackResult,
} from '../../../shared/feedback';

export interface FeatureRequestDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (draft: FeatureRequestDraft) => Promise<FeedbackResult>;
}

/** `FeedbackProblem` -> the i18n key under `feature.problem` */
const PROBLEM_KEY: Record<FeedbackProblem, string> = {
  'empty-details': 'emptyDetails',
  'send-failed': 'sendFailed',
  unavailable: 'unavailable',
};

/**
 * What went wrong, or null if nothing did.
 *
 * `ok: false` with no problem attached is still a failure — the lesson
 * `ReportProblemDialog` learned when a zip that could not be written was
 * reported as "ready".
 */
function feedbackProblem(r: FeedbackResult): FeedbackProblem | null {
  if (r.problem) return r.problem;
  return r.ok ? null : 'unavailable';
}

export function FeatureRequestDialog(props: FeatureRequestDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const fieldId = React.useId();
  const { dialogRef, close } = useModalDismiss(props.open, props.onClose);

  const [title, setTitle] = React.useState('');
  const [details, setDetails] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<FeedbackResult | null>(null);
  /**
   * Which send is the CURRENT one — `ReportProblemDialog`'s guard, kept for its
   * reason. A hand-off still settling when the dialog was closed and re-opened
   * must not close the fresh one, print an old error in it, or clear `busy`
   * under a second send and re-arm the button.
   */
  const attempt = React.useRef(0);

  React.useEffect(() => {
    // BUMPED BEFORE THE `open` GUARD, so CLOSING invalidates an in-flight send
    // too and not only re-opening. Cancel while one is settling, click into a
    // composer, and a late success would otherwise run `close()` a second time
    // — whose focus restore yanks the caret out of wherever the user went — or
    // set a failure line on a dialog nobody is looking at. (The report dialog
    // had the same gap and got the same fix in #1019.)
    attempt.current += 1;
    if (!props.open) return;
    // A re-open starts clean: a stale failure line would report a send that is
    // no longer on screen, and last time's words are not this time's request.
    setTitle('');
    setDetails('');
    setBusy(false);
    setResult(null);
  }, [props.open]);

  if (!props.open) return null;

  const sendable = isSendable({ details }) && !busy;

  const submit = (): void => {
    if (!sendable) return;
    const mine = ++attempt.current;
    setBusy(true);
    setResult(null);
    void props
      .onSubmit({ title, details, channel: 'ticket' })
      // `.catch` here rather than trusting the caller never to reject: a
      // component that depends on its parent not rejecting breaks when someone
      // rewires it.
      .catch((): FeedbackResult => ({ ok: false, channel: 'ticket', problem: 'unavailable' }))
      .then((r) => {
        // no longer this dialog's business — the browser it opened is already
        // on screen, and that is the whole of its confirmation
        if (attempt.current !== mine) return;
        // A HAND-OFF THAT WORKED CLOSES THE DIALOG (#896). The proof is outside
        // this window — a GitHub form with the words in it — so leaving the
        // dialog standing in front of it reads as a button that did nothing.
        // Only a FAILURE keeps it, with the words intact, so nothing typed is
        // lost to a browser that would not open.
        if (feedbackProblem(r) === null) {
          close();
          return;
        }
        setResult(r);
      })
      .finally(() => {
        if (attempt.current === mine) setBusy(false);
      });
  };

  const label = composeLabelStyle;
  const input = composeFieldStyle;

  return (
    <ComposeDialog
      kind="feature"
      dialogRef={dialogRef}
      onDismiss={close}
      title={t('feature.title')}
      intro={t('feature.intro')}
      cancelLabel={t('feature.cancel')}
      submitLabel={busy ? t('feature.working') : t('feature.submit')}
      canSubmit={sendable}
      // the details are the one required field — the title is optional, and a
      // request with nothing in the box is not a request
      submitBlockedReason={
        details.trim().length === 0 ? t('feature.problem.emptyDetails') : undefined
      }
      message={
        result === null
          ? null
          : t(`feature.problem.${PROBLEM_KEY[feedbackProblem(result) ?? 'unavailable']}`)
      }
      onSubmit={submit}
    >
      <div style={{ display: 'grid', gap: 4 }}>
        <label htmlFor={`${fieldId}f-title`} style={label}>
          {t('feature.titleField')}
        </label>
        <input
          id={`${fieldId}f-title`}
          data-feature-field="title"
          value={title}
          placeholder={t('feature.titlePlaceholder')}
          onChange={(e) => setTitle(e.target.value)}
          style={input}
        />
      </div>

      <div style={{ display: 'grid', gap: 4 }}>
        <label htmlFor={`${fieldId}f-details`} style={label}>
          {t('feature.details')}
        </label>
        <textarea
          id={`${fieldId}f-details`}
          data-feature-field="details"
          value={details}
          rows={8}
          placeholder={t('feature.detailsPlaceholder')}
          onChange={(e) => setDetails(e.target.value)}
          style={{ ...input, resize: 'vertical', fontFamily: 'var(--font-ui)' }}
        />
      </div>

      {/* Said on screen rather than left to the manual: a browser that is not
          signed in to GitHub lands on a sign-in page, which is the one way this
          control can look broken to a user who did nothing wrong. */}
      <p data-feature-ticket-note style={{ margin: 0, ...label }}>
        {t('feature.ticketNote')}
      </p>

      {/* The promise this whole feature rests on, where the user can read it
          before pressing the button — not only in the manual. */}
      <p style={{ margin: 0, ...label }}>{t('feature.privacyNote')}</p>
    </ComposeDialog>
  );
}
