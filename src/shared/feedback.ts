// Help ▸ Feature request… — the contract (#1008).
//
// THE WHOLE FEATURE IS A PRE-FILLED FORM SOMEWHERE ELSE, and that is the design
// rather than a limitation. Nothing here posts anything: it hands GitHub's *new
// issue* web form to the user's own browser, already carrying the words they
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
// THE REPO IS PUBLIC, so the form works for anyone signed in to GitHub in their
// browser — and for someone who is not, GitHub's own sign-in page is where it
// stops, with nothing in the app broken. There is no anonymous route on
// purpose (#1494): a token bundled into the app can be pulled out of the
// install, and a relay server would attract spam and break local-first.
//
// THERE USED TO BE AN EMAIL CHANNEL, and #1494 removed it. It existed because
// the repo was private and the form only worked for the owner; with the repo
// public it was a second way to reach the same person that worked worse (no
// tracker, a mail-client length cap, and an address baked into the app).
import { REPORT_REPO } from './diagnostics';

/**
 * Where a finished feature request is handed off to: GitHub's new-issue web
 * form, pre-filled, in the user's own browser.
 *
 * ONE VALUE, kept as a type rather than deleted, because it crosses the IPC
 * wire and an older renderer may still send `'email'`. `sanitizeDraft` narrows
 * anything at all to this.
 */
export type FeedbackChannel = 'ticket';

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
   * the browser could not be opened. A failure, not a shrug:
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
 * How much room a composed new-issue URL gets.
 *
 * Not arbitrary. GitHub's form URL survives a lot, but browsers, proxies and
 * GitHub itself have historically drawn the line near 8k, so the body is
 * clamped well under it. Report a problem's browser path (#1494) uses the same
 * cap.
 *
 * A clamp is the RIGHT failure here and a truncation is the wrong one: a
 * request cut off mid-sentence with nothing said about it reads, to whoever
 * receives it, like a person who stopped typing.
 */
export const MAX_ISSUE_URL_CHARS = 6000;

/** said in the body when the clamp bit, so a short request is never a mystery */
const TRUNCATION_NOTE = '\n\n[…trimmed to fit — send the rest in a reply]';

/**
 * A cut index that never lands INSIDE an astral character.
 *
 * `slice` counts UTF-16 code units, so an index can fall between the two halves
 * of a surrogate pair — and `encodeURIComponent` THROWS on a lone surrogate
 * (`URIError: URI malformed`). Emoji are not exotic in a sentence beginning "I
 * wish it could…", so without this a long request with a 🎉 in it fails, every
 * time, with an error message about the wrong thing.
 */
function safeCut(s: string, i: number): number {
  const c = s.charCodeAt(i - 1);
  // a HIGH surrogate at the end means its low half is on the other side
  return c >= 0xd800 && c <= 0xdbff ? i - 1 : i;
}

/**
 * Every C0/C1 control character replaced by a space.
 *
 * Written as a code-point walk rather than a regex on purpose — a character
 * class over this range is what `no-control-regex` exists to stop, and
 * `Array.from` iterates by CODE POINT, so a surrogate pair survives the pass
 * whole rather than being inspected as two halves.
 */
/**
 * Every LONE surrogate replaced by U+FFFD, so `encodeURIComponent` cannot
 * throw on the result.
 *
 * A code-point walk for the reason `flattenControls` is one: `Array.from`
 * yields a well-formed pair as ONE character (code point above 0xFFFF), so
 * anything it hands back in the surrogate range is a half with no partner. A
 * stray one in pasted text used to reach the user as "your browser could not
 * be opened", which is a diagnosis of the wrong thing.
 */
export function wellFormed(s: string): string {
  return Array.from(s, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp >= 0xd800 && cp <= 0xdfff ? String.fromCodePoint(0xfffd) : ch;
  }).join('');
}

export function flattenControls(s: string): string {
  return Array.from(s, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp < 0x20 || cp === 0x7f ? ' ' : ch;
  }).join('');
}

/**
 * The issue title, never empty by the time it ships.
 *
 * CONTROL CHARACTERS ARE FLATTENED. Nothing in the dialog can produce one — the
 * title is a single-line input and the fallback is one trimmed line — but the
 * argument this whole path is built on is that main composes the URL so a
 * compromised renderer cannot steer it, and a title is one line whatever it
 * carries. (It began as an RFC 6068 header-injection guard for the `mailto:`
 * channel #1494 removed; the reason to keep it outlived that channel.)
 */
export function featureSubject(draft: Pick<FeatureRequestDraft, 'title' | 'details'>): string {
  const typed = draft.title.trim();
  // The first non-empty LINE, not the first 60 characters of a blob: a request
  // whose opening line is one sentence gets that sentence as its title, which
  // is what a person would have written in the box anyway.
  const fallback = draft.details
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const chosen = wellFormed(flattenControls(typed || fallback || '')).trim();
  // 120 is GitHub's comfortable title width; a title longer than that is a body that got lost. The
  // prefix is added afterwards, so the composed line runs a little past it.
  const clipped =
    chosen.length > 120 ? `${chosen.slice(0, safeCut(chosen, 117))}...` : chosen;
  return `${FEATURE_SUBJECT_PREFIX} ${clipped}`.trim();
}

/**
 * Trim `text` so that `fixed + encodeURIComponent(text)` fits in `budget`.
 *
 * Measured on the ENCODED length, because that is what the browser and the
 * shell actually carry: a body of newlines and spaces triples on the way out,
 * so a character count taken before encoding would let a URL through at three
 * times its limit. `note` is appended when the clamp bites; Report a problem
 * passes its own, because what it trims is diagnostics, not the user's words.
 */
export function clampEncoded(
  text: string,
  fixed: number,
  budget: number,
  note: string = TRUNCATION_NOTE,
): string {
  if (fixed + encodeURIComponent(text).length <= budget) return text;
  const room = budget - fixed - encodeURIComponent(note).length;
  // Reachable from Report a problem, whose fixed part includes the user's own
  // description and can sit right at the budget. This branch must not answer
  // with something that is itself over the cap: no room means no text, which
  // is the truth.
  if (room <= 0) return '';
  // Halve-and-probe rather than a per-character loop: the body can be thousands
  // of characters and `encodeURIComponent` is not free.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodeURIComponent(text.slice(0, safeCut(text, mid))).length <= room) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, safeCut(text, lo)).trimEnd()}${note}`;
}

/** The body a request carries — the user's words, and nothing else. */
function featureBody(draft: FeatureRequestDraft): string {
  return wellFormed(draft.details.trim());
}

/**
 * GitHub's new-issue form URL for this repo, up to and including `&body=`.
 *
 * Shared with Report a problem's browser path (#1494), so one place knows the
 * form's address and how its title is encoded. The caller appends the encoded
 * body, clamped against this string's length.
 */
export function issueFormHead(title: string): string {
  return `https://github.com/${REPORT_REPO}/issues/new?title=${encodeURIComponent(title)}&body=`;
}

/**
 * GitHub's new-issue form for this repo, pre-filled.
 *
 * NOT an API call — a URL for the user's browser. Nothing exists until they
 * press GitHub's own Submit, which is the whole point (see the file header).
 */
export function featureIssueUrl(draft: FeatureRequestDraft): string {
  const head = issueFormHead(featureSubject(draft));
  const body = clampEncoded(featureBody(draft), head.length, MAX_ISSUE_URL_CHARS);
  return head + encodeURIComponent(body);
}
