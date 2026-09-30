// The feature-request contract (#1008).
//
// WHAT IS PINNED HERE IS THE COMPOSED STRING AND NOTHING ELSE — no mail client
// is opened, no browser is launched and no ticket is filed. That is a rule of
// the item, not a convenience: the repo these URLs name is real, and a test
// that "just tried it" would leave junk on somebody's tracker.
import { describe, it, expect } from 'vitest';
import {
  FEATURE_SUBJECT_PREFIX,
  MAX_ISSUE_URL_CHARS,
  MAX_MAILTO_CHARS,
  featureIssueUrl,
  featureMailto,
  featureSubject,
  featureUrlFor,
  isSendable,
  unavailableFeedback,
  type FeatureRequestDraft,
} from './feedback';
import { REPORT_EMAIL_TO, REPORT_REPO } from './diagnostics';

const draft = (over: Partial<FeatureRequestDraft> = {}): FeatureRequestDraft => ({
  title: 'Tabs that remember their scroll',
  details: 'When I come back to a tab I want it where I left it.',
  channel: 'email',
  ...over,
});

describe('the subject line', () => {
  it('carries the agreed prefix and the typed title', () => {
    expect(featureSubject(draft())).toBe(
      `${FEATURE_SUBJECT_PREFIX} Tabs that remember their scroll`
    );
  });

  it('falls back to the first line of the details when no title was typed', () => {
    // The title is OPTIONAL by design. A request that already says what it
    // wants in the body has named itself, and demanding the same words twice
    // is a chore rather than a safeguard.
    const s = featureSubject(draft({ title: '', details: 'Let me pin a session.\nIt drifts.' }));
    expect(s).toBe(`${FEATURE_SUBJECT_PREFIX} Let me pin a session.`);
  });

  it('skips leading blank lines rather than titling a request with nothing', () => {
    const s = featureSubject(draft({ title: '   ', details: '\n\n  Group colours, please.\n' }));
    expect(s).toBe(`${FEATURE_SUBJECT_PREFIX} Group colours, please.`);
  });

  it('clips a title that is really a paragraph', () => {
    const s = featureSubject(draft({ title: 'x'.repeat(400) }));
    expect(s.length).toBeLessThanOrEqual(FEATURE_SUBJECT_PREFIX.length + 121);
    expect(s.endsWith('...')).toBe(true);
  });

  it('is the prefix alone when there is nothing at all to name', () => {
    // Not reachable from the dialog — it refuses an empty body — but main
    // sanitizes whatever crosses the wire, so this must not throw or produce a
    // subject with a dangling separator.
    expect(featureSubject({ title: '', details: '' })).toBe(FEATURE_SUBJECT_PREFIX);
  });
});

describe('the email channel', () => {
  it('is pre-addressed to the owner and pre-filled with the request', () => {
    const url = featureMailto(draft());
    expect(url.startsWith(`mailto:${REPORT_EMAIL_TO.join(',')}?`)).toBe(true);
    expect(url).toContain(`subject=${encodeURIComponent(featureSubject(draft()))}`);
    expect(url).toContain(encodeURIComponent('where I left it'));
  });

  it('uses the SHARED address list, never a second copy of it', () => {
    // #815 made the addresses a named constant precisely so a second surface
    // would not grow its own. This is that assertion.
    for (const to of REPORT_EMAIL_TO) expect(featureMailto(draft())).toContain(to);
  });

  it('stays inside the length a Windows shell and a mail client will carry', () => {
    // Over the cap the body is TRUNCATED SILENTLY by the client, which is the
    // bad kind of short: the recipient reads it as someone who stopped typing.
    const url = featureMailto(draft({ details: 'a b c '.repeat(2000) }));
    expect(url.length).toBeLessThanOrEqual(MAX_MAILTO_CHARS);
    expect(decodeURIComponent(url.split('&body=')[1])).toContain('trimmed to fit');
  });

  it('measures the budget on the ENCODED body, not the typed one', () => {
    // Newlines and spaces triple on the way out (`%0A`, `%20`), so a character
    // count taken before encoding lets a URL through at three times its cap.
    const url = featureMailto(draft({ details: '\n'.repeat(1500) }));
    expect(url.length).toBeLessThanOrEqual(MAX_MAILTO_CHARS);
  });
});

describe('the ticket channel', () => {
  it('opens GitHub’s new-issue FORM — it does not create anything', () => {
    const url = featureIssueUrl(draft({ channel: 'ticket' }));
    expect(url.startsWith(`https://github.com/${REPORT_REPO}/issues/new?`)).toBe(true);
    // the API endpoint would be `api.github.com/repos/…/issues`, and a POST.
    // This is a page a human looks at before pressing GitHub's own button.
    expect(url).not.toContain('api.github.com');
  });

  it('pre-fills the title and the body', () => {
    const url = featureIssueUrl(draft({ channel: 'ticket' }));
    expect(url).toContain(`title=${encodeURIComponent(featureSubject(draft()))}`);
    expect(url).toContain(encodeURIComponent('When I come back to a tab'));
  });

  it('stays inside a length browsers and proxies will carry', () => {
    const url = featureIssueUrl(draft({ channel: 'ticket', details: 'word '.repeat(5000) }));
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_CHARS);
  });
});

describe('featureUrlFor', () => {
  it('routes each channel to its own composer, and only its own', () => {
    expect(featureUrlFor(draft({ channel: 'email' })).startsWith('mailto:')).toBe(true);
    expect(featureUrlFor(draft({ channel: 'ticket' })).startsWith('https://github.com/')).toBe(
      true
    );
  });
});

describe('the guards', () => {
  it('refuses a request with nothing in the box, whitespace included', () => {
    expect(isSendable({ details: '' })).toBe(false);
    expect(isSendable({ details: '   \n\t ' })).toBe(false);
    expect(isSendable({ details: 'x' })).toBe(true);
  });

  it('an unreachable bridge is a RESULT, not a thrown error', () => {
    expect(unavailableFeedback('ticket')).toEqual({
      ok: false,
      channel: 'ticket',
      problem: 'unavailable',
    });
  });
});
