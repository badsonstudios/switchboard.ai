// The rule behind the greyed-out trust chip (#397).
//
// What it is really pinning is a CLI fact: `--input-format stream-json` draws
// no trust prompt (#384, measured twice, pinned by e2e/real-claude.spec.ts). If
// that ever changes, this rule is wrong rather than broken — so the test names
// the fact, not just the booleans.
import { describe, it, expect } from 'vitest';
import { trustSettingReaches, TRUST_INERT_REASON_KEY } from './trust-reach';
import { DEFAULT_SESSION_TRANSPORT } from '../../../shared/transport';
import en from '../../../shared/i18n/locales/en.json';

describe('trustSettingReaches', () => {
  it('is false for an all-Direct workspace — nothing there is ever asked', () => {
    expect(trustSettingReaches([{ transport: 'stream' }, { transport: 'stream' }])).toBe(false);
  });

  it('is true as soon as one card will spawn on the Terminal', () => {
    expect(trustSettingReaches([{ transport: 'stream' }, { transport: 'pty' }])).toBe(true);
  });

  it('is true for an all-Terminal workspace — the setting is fully functional', () => {
    expect(trustSettingReaches([{ transport: 'pty' }])).toBe(true);
  });

  it('is false for an empty workspace', () => {
    // Not a special case in the code, and deliberately not one here either: no
    // cards means no session that could be asked, which is the same answer.
    expect(trustSettingReaches([])).toBe(false);
  });

  it('reads a missing transport as the DEFAULT, never as Terminal', () => {
    // main computes this field; if it ever stops, silence must fail towards
    // "inert" rather than lighting a control that cannot do anything.
    //
    // Asserted against the CONSTANT rather than against `false`, because the
    // default is Direct today: a literal expectation here would also pass for
    // an implementation that dropped the `?? DEFAULT_SESSION_TRANSPORT`
    // fallback entirely, and would then silently start testing the opposite
    // claim the day the default moved.
    const answer = DEFAULT_SESSION_TRANSPORT === 'pty';
    expect(trustSettingReaches([{}, { transport: undefined }])).toBe(answer);
  });

  describe('the pending-restart case', () => {
    // `sessions:cards` reports the CHOSEN transport, so a card mid-switch
    // arrives here already carrying its next-spawn answer. These two tests are
    // the decision, written down: the chip follows the choice, not the process.

    it('a Direct session switched to Terminal (restart pending) enables the chip', () => {
      // Running: stream. Chosen: pty. The user is on their way to a Terminal
      // session precisely so they can be asked — the setting has to be
      // reachable BEFORE the restart, because the restart is what reads it.
      expect(trustSettingReaches([{ transport: 'pty' }])).toBe(true);
    });

    it('a Terminal session switched to Direct (restart pending) disables the chip', () => {
      // Running: pty. Chosen: stream. The next spawn cannot be asked, so the
      // chip stops claiming it can — early, and by the same rule.
      expect(trustSettingReaches([{ transport: 'stream' }])).toBe(false);
    });
  });

  it('the inert reason is a real key with a real sentence behind it', () => {
    // An unresolved i18n key renders as the key itself, which would put
    // "titlebar.trustInert" in a tooltip and tell the user nothing.
    const [ns, leaf] = TRUST_INERT_REASON_KEY.split('.');
    const text = (en as unknown as Record<string, Record<string, string>>)[ns][leaf];
    expect(text).toBeTypeOf('string');
    expect(text.length).toBeGreaterThan(20);
  });
});
