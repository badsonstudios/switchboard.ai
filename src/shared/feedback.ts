// Help ▸ Feature request… — the contract (#1008).
//
// THE WHOLE FEATURE IS A PRE-FILLED FORM SOMEWHERE ELSE, and that is the design
// rather than a limitation. Nothing here posts anything: one path hands a
// `mailto:` to the user's own mail client, the other hands GitHub's *new issue*
// web form to the user's own browser, both already carrying the words they
// typed. The send button belongs to the user, in their application, after they
// have read what is in it. P8 (local-first, no telemetry) is not merely
// respected by that shape — it is what the shape is for.
//
// WHY THIS DOES NOT REUSE `diagnostics/github-issue.ts`. Report-a-problem POSTS
// through the REST API with a credential, because it has a zip to point at and
// a diagnostic body to compose and wants the issue to exist without a browser
// round trip. A feature request has no evidence to move and no reason to need a
// token — `issues/new?title=…&body=…` reaches the same repo with no credential
// at all, and it shows the user the finished ticket before it exists. Sharing
// the POST path would have made a token the price of asking for a feature.
//
// THE REPO IS PRIVATE, so the ticket path only works for someone signed in to
// GitHub with access to it — today, the owner. It ships anyway (the owner
// filing his own tickets from inside the app while dogfooding is the near-term
// use) and it fails in the only place it can: GitHub's own sign-in or 404 page,
// in the browser, with nothing in the app broken. The manual says who it is for.
import { REPORT_EMAIL_TO, REPORT_REPO } from './diagnostics';

/** Where a finished feature request is handed off to. */
export type FeedbackChannel =
  /** `mailto:` — the user's own mail client, pre-addressed and pre-filled */
  | 'email'
  /** GitHub's new-issue web form, pre-filled, in the user's own browser */
  | 'ticket';

export const FEEDBACK_CHANNELS: FeedbackChannel[] = ['email', 'ticket'];

/**
 * The subject line's prefix.
 *
 * A constant for the reason `REPORT_REPO` is one: it is configuration that
 * someone will one day want to change, and it should be findable by name.
 */
export const FEATURE_SUBJECT_PREFIX = '[switchboard feature]';

/** What the user typed, plus where they want it to go. */
export interface FeatureRequestDraft {
  /**
   * OPTIONAL, as the ticket asked. An empty one is not an error — the subject
   * falls back to the first line of `details`, because a request that says what
   * it wants in the body has already named itself and demanding the same words
   * twice is a chore, not a safeguard.
   */
  title: string;
  /** the actual ask — the one field that must not be empty */
  details: string;
  channel: FeedbackChannel;
}

/** Why a feature request could not be handed off. One sentence each on screen. */
export type FeedbackProblem =
  /** nothing was typed, so there is nothing to ask for */
  | 'empty-details'
  /**
   * the mail client or the browser could not be opened. A failure, not a shrug:
   * a successful hand-off closes the dialog, and calling this success would
   * close it over words that went nowhere — exactly the defect #896 fixed.
   */
  | 'send-failed'
  /**
   * main could not be asked at all — no `feedback` bridge namespace, or the
   * call was refused. Its own name rather than borrowing `send-failed`, because
   * nothing was attempted and saying "your browser would not open" about a
   * browser nobody reached for is a guess dressed as a diagnosis.
   */
  | 'unavailable';

/** What handing a feature request off produced. */
export interface FeedbackResult {
  ok: boolean;
  channel: FeedbackChannel;
  problem?: FeedbackProblem;
}

/**
 * What the dialog shows when the bridge could not be asked.
 *
 * A real result rather than a thrown error, for the reason the whole renderer
 * family is optional-chained: a help surface must never be able to white-screen
 * the shell (#444).
 */
export function unavailableFeedback(channel: FeedbackChannel): FeedbackResult {
  return { ok: false, channel, problem: 'unavailable' };
}

/** Empty details are the one thing we refuse before trying. */
export function isSendable(draft: Pick<FeatureRequestDraft, 'details'>): boolean {
  return draft.details.trim().length > 0;
}

/**
 * How much room the composed URL gets.
 *
 * These are not arbitrary. A `mailto:` on Windows goes through `ShellExecute`,
 * whose command line caps out around 2048 characters, and several mail clients
 * truncate below that — silently, which is the bad kind. GitHub's own form URL
 * survives far more, but browsers and proxies have historically drawn the line
 * near 8k, so the body is clamped well under it.
 *
 * A clamp is the RIGHT failure here and a truncation is the wrong one: a
 * request cut off mid-sentence with nothing said about it reads, to whoever
 * receives it, like a person who stopped typing.
 */
export const MAX_MAILTO_CHARS = 1900;
export const MAX_ISSUE_URL_CHARS = 6000;

/** said in the body when the clamp bit, so a short request is never a mystery */
const TRUNCATION_NOTE = '\n\n[…trimmed to fit — send the rest in a reply]';

/** The mail subject / issue title, never empty by the time it ships. */
export function featureSubject(draft: Pick<FeatureRequestDraft, 'title' | 'details'>): string {
  const typed = draft.title.trim();
  // The first non-empty LINE, not the first 60 characters of a blob: a request
  // whose opening line is one sentence gets that sentence as its title, which
  // is what a person would have written in the box anyway.
  const fallback = draft.details
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const chosen = typed || fallback || '';
  // 120 is GitHub's comfortable title width and about where a mail client stops
  // showing a subject; a title longer than that is a body that got lost.
  const clipped = chosen.length > 120 ? `${chosen.slice(0, 117)}...` : chosen;
  return `${FEATURE_SUBJECT_PREFIX} ${clipped}`.trim();
}

/**
 * Trim `text` so that `fixed + encodeURIComponent(text)` fits in `budget`.
 *
 * Measured on the ENCODED length, because that is what the browser and the
 * shell actually carry: a body of newlines and spaces triples on the way out,
 * so a character count taken before encoding would let a URL through at three
 * times its limit.
 */
function clampEncoded(text: string, fixed: number, budget: number): string {
  if (fixed + encodeURIComponent(text).length <= budget) return text;
  const note = TRUNCATION_NOTE;
  const room = budget - fixed - encodeURIComponent(note).length;
  if (room <= 0) return note.trim();
  // Halve-and-probe rather than a per-character loop: the body can be thousands
  // of characters and `encodeURIComponent` is not free.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodeURIComponent(text.slice(0, mid)).length <= room) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}${note}`;
}

/** The body both channels carry — the user's words, and nothing else. */
function featureBody(draft: FeatureRequestDraft): string {
  return draft.details.trim();
}

/**
 * `mailto:` for the owner, pre-addressed and pre-filled.
 *
 * The #815 pattern exactly (`diagnostics/report-ipc.ts`'s `mailtoFor`), down to
 * the address list, which is imported rather than re-typed: two copies of an
 * address is one copy that goes stale.
 */
export function featureMailto(draft: FeatureRequestDraft): string {
  const subject = featureSubject(draft);
  const head = `mailto:${REPORT_EMAIL_TO.join(',')}?subject=${encodeURIComponent(subject)}&body=`;
  const body = clampEncoded(featureBody(draft), head.length, MAX_MAILTO_CHARS);
  return head + encodeURIComponent(body);
}

/**
 * GitHub's new-issue form for this repo, pre-filled.
 *
 * NOT an API call — a URL for the user's browser. Nothing exists until they
 * press GitHub's own Submit, which is the whole point (see the file header).
 */
export function featureIssueUrl(draft: FeatureRequestDraft): string {
  const subject = featureSubject(draft);
  const head =
    `https://github.com/${REPORT_REPO}/issues/new` +
    `?title=${encodeURIComponent(subject)}&body=`;
  const body = clampEncoded(featureBody(draft), head.length, MAX_ISSUE_URL_CHARS);
  return head + encodeURIComponent(body);
}

/** The URL a channel hands to the OS. One place, so the two cannot drift. */
export function featureUrlFor(draft: FeatureRequestDraft): string {
  return draft.channel === 'email' ? featureMailto(draft) : featureIssueUrl(draft);
}
