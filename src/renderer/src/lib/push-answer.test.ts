// The pin for #677: `applyPushAnswer`'s refusal path, red-on-revert.
//
// #650 fixed this site and could not pin it — the promise reaches the callback
// as a parameter (invisible to `scripts/refusal-truthiness.js`) inside a
// component with no test file. The interpretation now lives in
// `lib/push-answer.ts`, and this file is the net the fix was missing: feed it
// the actual refusal brand and prove neither half of the defect comes back.
// The defect, verbatim from #650's audit: the brand has no `config` and no
// `ok`, so unlaundered it becomes `undefined` in a `PushConfig | null` state
// (the empty-working-form `PushConfig`'s doc-comment forbids) while the dialog
// reports a failed WRITE for a call that never reached the store.
import { describe, it, expect } from 'vitest';
import { interpretPushAnswer } from './push-answer';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import { DEFAULT_PUSH_PREFS } from '../../../shared/push';
import type { PushConfig, PushWriteResult } from '../../../shared/push';

const config: PushConfig = {
  prefs: { ...DEFAULT_PUSH_PREFS },
  secrets: {
    'ntfy.topic': true,
    'pushover.token': false,
    'pushover.user': false,
    'webhook.url': false,
  },
  storeAvailable: true,
};

describe('interpretPushAnswer', () => {
  it('a broker refusal becomes the unavailable config and an honest "refused"', () => {
    // The red-on-revert case. Remove `answered()` from the implementation and
    // the truthy brand sails through: `config` comes back `undefined` (the
    // first assertion throws on `.storeAvailable`) and the second half never
    // even reports, because `r.ok` is `undefined` and the notice text lies
    // about which failure happened.
    const out = interpretPushAnswer(
      'ntfy.topic',
      ipcRefusal('push:setSecret', 'capability-not-held') as unknown as PushWriteResult
    );
    // Not a working empty form: `storeAvailable: false` is what disables the
    // fields and the Save button, exactly as when there is no bridge at all.
    expect(out.config).toBeDefined();
    expect(out.config.storeAvailable).toBe(false);
    // ...and the notice says "refused", the same word the `.catch` uses, not a
    // handler problem code the store never produced.
    expect(out.write).toEqual({ key: 'ntfy.topic', problem: 'refused' });
  });

  it('a landed write passes the config through with nothing to say', () => {
    const out = interpretPushAnswer('ntfy.topic', { config, ok: true });
    expect(out.config).toBe(config);
    expect(out.write).toBeNull();
  });

  it("a write the handler declined keeps the handler's own problem word", () => {
    const out = interpretPushAnswer('webhook.url', { config, ok: false, problem: 'bad-url' });
    expect(out.config).toBe(config);
    expect(out.write).toEqual({ key: 'webhook.url', problem: 'bad-url' });
  });

  it('a declined write with no problem code still reads as refused', () => {
    // `problem` is optional on the wire; the dialog needs SOME word, and
    // "refused" is the one this family already uses for "main would not".
    const out = interpretPushAnswer('webhook.url', { config, ok: false });
    expect(out.write).toEqual({ key: 'webhook.url', problem: 'refused' });
  });
});
