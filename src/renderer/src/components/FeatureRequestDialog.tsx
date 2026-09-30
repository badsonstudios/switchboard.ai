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
// NOTHING LEAVES THIS MACHINE FROM HERE. Both channels open a pre-filled form
// in an application the user already owns — their mail client, or their browser
// on GitHub's new-issue page — and wait for them to press Send in it. There is
// no background submission and no telemetry, which is a hard constraint of the
// item (P8) rather than a preference, and this shape is how it is kept: there
// is no code path in this feature that could post anything.
//
// THE TICKET CHANNEL ONLY WORKS FOR SOMEONE WITH ACCESS TO A PRIVATE REPO —
// today, the owner. It ships anyway, because filing his own tickets from inside
// the app while dogfooding is what it is for in the near term, and it fails in
// the only place it can: GitHub's own sign-in or 404 page, in the browser, with
// nothing in the app broken. The manual says who it is for.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ComposeDialog, composeFieldStyle, composeLabelStyle } from './ComposeDialog';
import { useModalDismiss } from '../lib/modal-dismiss';
import {
  FEEDBACK_CHANNELS,
  isSendable,
  type FeatureRequestDraft,
  type FeedbackChannel,
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

const LABEL: Record<FeedbackChannel, string> = { email: 'toEmail', ticket: 'toTicket' };
const HINT: Record<FeedbackChannel, string> = { email: 'toEmailHint', ticket: 'toTicketHint' };

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
  const [channel, setChannel] = React.useState<FeedbackChannel>('email');
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
    if (!props.open) return;
    attempt.current += 1;
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
      .onSubmit({ title, details, channel })
      // `.catch` here rather than trusting the caller never to reject: a
      // component that depends on its parent not rejecting breaks when someone
      // rewires it.
      .catch((): FeedbackResult => ({ ok: false, channel, problem: 'unavailable' }))
      .then((r) => {
        // no longer this dialog's business — the mail app or browser it opened
        // is already on screen, and that is the whole of its confirmation
        if (attempt.current !== mine) return;
        // A HAND-OFF THAT WORKED CLOSES THE DIALOG (#896). The proof is outside
        // this window — a mail client with the address filled in, or a GitHub
        // form with the words in it — so leaving the dialog standing in front
        // of it reads as a button that did nothing. Only a FAILURE keeps it,
        // with the words intact, so the other channel is one click away.
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

      <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 6 }}>
        <legend style={{ ...label, padding: 0 }}>{t('feature.channel')}</legend>
        {FEEDBACK_CHANNELS.map((c) => (
          <label
            key={c}
            style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 6, fontSize: 12 }}
          >
            <input
              type="radio"
              name={`${fieldId}channel`}
              data-feature-channel={c}
              checked={channel === c}
              onChange={() => setChannel(c)}
            />
            <span>
              {t(`feature.${LABEL[c]}`)}
              <span style={{ display: 'block', ...label }}>{t(`feature.${HINT[c]}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* Said on screen rather than left to the manual: the repo is private, so
          this is the one control in the app that can look broken to a user who
          did nothing wrong. Only for the channel it is true of. */}
      {channel === 'ticket' && <p style={{ margin: 0, ...label }}>{t('feature.ticketNote')}</p>}

      {/* The promise this whole feature rests on, where the user can read it
          before pressing the button — not only in the manual. */}
      <p style={{ margin: 0, ...label }}>{t('feature.privacyNote')}</p>
    </ComposeDialog>
  );
}
