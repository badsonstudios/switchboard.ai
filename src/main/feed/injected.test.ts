// Recognising a turn the harness wrote (#704).
//
// The two payload shapes below are the two that appear in this repo's real
// transcript fixture, trimmed only of the Windows path separators (a `\U` in a
// TS template literal is an escape, and a fixture that has to be read through
// one is a fixture nobody will re-check).
import { describe, it, expect } from 'vitest';
import { classifyInjected, describeInjectedTurn } from './injected';

/** A background command that ended — the `<status>` shape. */
const ENDED = `<task-notification>
<task-id>b4wmupqp4</task-id>
<tool-use-id>toolu_016mYAE7mxvKweL2xEhPC7Bw</tool-use-id>
<output-file>C:/Users/dheinz/AppData/Local/Temp/claude/tasks/b4wmupqp4.output</output-file>
<status>failed</status>
<summary>Background command "Re-run remaining S-03 headless scenarios" failed with exit code 1</summary>
</task-notification>`;

/** A Monitor that fired — the `<event>` shape, with the model's instruction. */
const EVENT = `<task-notification>
<task-id>bvhh1kfa7</task-id>
<summary>Monitor event: "CI matrix result for PR #36 (node-pty commit)"</summary>
<event>macos-latest: pass
ubuntu-latest: pass
windows-latest: pass</event>
If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one.
</task-notification>`;

const TN = { origin: { kind: 'task-notification' } };
const HUMAN = { origin: { kind: 'human' } };

describe('classifyInjected — origin first, text shape second', () => {
  it('the CLI says so: an injected origin decides it, whatever the text is', () => {
    expect(classifyInjected(TN, ENDED)).toBe('task-notification');
    // The origin is the classification; it does not need the tag to agree.
    expect(classifyInjected(TN, 'plain words with no wrapper at all')).toBe('task-notification');
  });

  it('no origin: the text shape decides, anchored at the start', () => {
    expect(classifyInjected({}, ENDED)).toBe('task-notification');
    expect(classifyInjected({}, `   \n${EVENT}`)).toBe('task-notification');
    expect(classifyInjected({}, 'do the next item')).toBeNull();
  });

  // THE CASE THE ISSUE ASKED FOR, and one step past it. A prompt that merely
  // mentions the tag is obviously still a prompt — but #704 itself was FILED by
  // pasting one of these payloads into a bug report, and a report that opens
  // with the payload would be swallowed by a `startsWith` test on its own.
  it('a person quoting the tag keeps their prompt', () => {
    expect(classifyInjected(HUMAN, `look at this: ${ENDED}`)).toBeNull();
    // ...including when they open with it, because the CLI said `human`.
    expect(classifyInjected(HUMAN, ENDED)).toBeNull();
    // ...and mid-text with no origin at all, on the anchor alone.
    expect(classifyInjected({}, `why does this render as a prompt?\n${ENDED}`)).toBeNull();
  });

  // ⚠️ THE CASE REVIEW FOUND, AND THE FIXTURE COULD NEVER HAVE. The CLI's own
  // schema gives the `task-notification` arm an optional `subkind`, and two of
  // its three values are not background tasks at all: `scheduled-trigger` is a
  // routine's fired prompt — the session's actual instruction — and
  // `peer-send-message` is another of the user's sessions talking, which is
  // §5.4's subject matter. Either one collapsed into a "Background task" row
  // would be a confident mislabel. All 9 lines in the real fixture carry no
  // subkind, so only the schema could say this.
  it('a qualified task-notification is NOT taken at face value', () => {
    for (const subkind of ['scheduled-trigger', 'peer-send-message', 'projects-relay']) {
      // the text has no wrapper, so it falls through to being a prompt
      expect(classifyInjected({ origin: { kind: 'task-notification', subkind } }, 'do the thing')).toBeNull();
      // ...but one still WEARING the wrapper is still recognised, on the text
      expect(classifyInjected({ origin: { kind: 'task-notification', subkind } }, ENDED)).toBe(
        'task-notification'
      );
    }
  });

  // An origin we have never met is not evidence either way, so it must fall
  // through to the text test rather than being read as "not injected". Without
  // that, a wrapper the CLI starts stamping with a new origin would render as
  // raw XML again — the bug, one release later.
  it('an unknown origin falls back to the text, not to a prompt', () => {
    expect(classifyInjected({ origin: { kind: 'wormhole' } }, ENDED)).toBe('task-notification');
    expect(classifyInjected({ origin: { kind: 'wormhole' } }, 'hello')).toBeNull();
  });

  // `human` is the ONLY veto, and `unclassified` is why that matters: the
  // schema calls it "Injected turn whose ingress classification found no
  // provenance … never presumed human". Reading it as a person — which an
  // "every known origin that is not injected is the human" list did — is the
  // exact opposite of what the CLI means by it.
  it('does not treat `unclassified` as a person', () => {
    expect(classifyInjected({ origin: { kind: 'unclassified' } }, ENDED)).toBe('task-notification');
  });

  it('a malformed origin is no origin', () => {
    for (const origin of [null, 'human', 42, [], {}, { kind: '' }, { kind: 7 }]) {
      expect(classifyInjected({ origin }, ENDED)).toBe('task-notification');
      expect(classifyInjected({ origin }, 'hello')).toBeNull();
    }
  });

  // The CLI's own guidance to the model says these arrive "normally inside a
  // `<system-reminder>`". Our fixture has none wrapped, so this is robustness —
  // and it is the TEXT path only, because a wrapped payload still has its
  // origin.
  it('sees through the reminder wrapper the CLI says is normal', () => {
    expect(classifyInjected({}, `<system-reminder>\n${ENDED}\n</system-reminder>`)).toBe(
      'task-notification'
    );
    // ...and the wrapper alone is not a notification. It carries most of the
    // harness's other chatter too, and swallowing all of it would be a much
    // bigger claim than this module is making.
    expect(classifyInjected({}, '<system-reminder>your memory has updated</system-reminder>')).toBeNull();
  });

  // The other origins the CLI stamps. `auto-continuation` and friends are
  // plainly not the person either — they are deliberately NOT injected yet,
  // because no transcript on this machine shows what their bodies look like.
  it('a known-but-unhandled origin is left as a prompt for now', () => {
    expect(classifyInjected({ origin: { kind: 'auto-continuation' } }, 'carry on')).toBeNull();
    expect(classifyInjected({ origin: { kind: 'peer' } }, 'from next door')).toBeNull();
    expect(classifyInjected({ origin: { kind: 'observer' } }, 'what I saw')).toBeNull();
  });
});

describe('describeInjectedTurn — what the row says', () => {
  const read = (payload: string, cap = 200) =>
    describeInjectedTurn('task-notification', payload, cap);

  it('reads the ended shape: summary, status, ids', () => {
    expect(read(ENDED)).toEqual({
      source: 'task-notification',
      summary: 'Background command "Re-run remaining S-03 headless scenarios" failed with exit code 1',
      status: 'failed',
      taskId: 'b4wmupqp4',
      outputFile: 'C:/Users/dheinz/AppData/Local/Temp/claude/tasks/b4wmupqp4.output',
    });
  });

  // An `<event>` payload has no status WORD — its `<event>` body is three lines
  // of CI results. The chip gets `event`; the three lines stay in the payload,
  // because a paragraph in a badge is not a badge.
  it('reads the event shape, and does not put the event body in the chip', () => {
    const d = read(EVENT);
    expect(d.summary).toBe('Monitor event: "CI matrix result for PR #36 (node-pty commit)"');
    expect(d.status).toBe('event');
    expect(d.taskId).toBe('bvhh1kfa7');
    expect(d.outputFile).toBeUndefined();
  });

  // Fail-open, and the shape of it. An unreadable body costs the SUMMARY, never
  // the block — see the function's own note on why falling back to "render it
  // as a prompt" would be reintroducing the defect.
  it('falls back to the first useful line when there is no <summary>', () => {
    const d = read('<task-notification>\n\nsomething happened\n</task-notification>');
    expect(d.summary).toBe('something happened');
    expect(d.status).toBeUndefined();
  });

  it('never offers a wrapper tag itself as the summary', () => {
    expect(read('<task-notification>\n</task-notification>').summary).toBe('');
    // the reminder's tags are envelope too
    expect(read('<system-reminder>\n<task-notification>\nreal words\n</task-notification>').summary).toBe(
      'real words'
    );
  });

  it('absent, never undefined-valued — the house rule for optional fields', () => {
    const d = read('<task-notification>\nhi\n</task-notification>');
    expect(Object.keys(d).sort()).toEqual(['source', 'summary']);
  });

  it('caps every field it reads', () => {
    const d = read(ENDED, 6);
    expect(d.summary).toBe('Backgr');
    expect(d.taskId).toBe('b4wmup');
  });

  // `IDENTITY_ONLY_CAPS` promises "no text built at all", and the search engine
  // derives EVERY line of a transcript. Every field would be sliced to '', so
  // the five regex scans that build them are pure waste on that path.
  it('builds nothing at all under an identity-only cap', () => {
    expect(read(ENDED, 0)).toEqual({ source: 'task-notification', summary: '' });
  });

  // A `<status>` that means nothing to us is still the truest thing we have.
  it('passes a status it has never seen through rather than dropping it', () => {
    const d = read('<task-notification>\n<status>abducted</status>\n<summary>s</summary>\n</task-notification>');
    expect(d.status).toBe('abducted');
  });
});
