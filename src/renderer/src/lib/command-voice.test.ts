// What a DISABLED command says (#942).
//
// Against the real `en.json` through the real ICU chain, for `session-voice`'s
// reason: the sentence is the entire user-visible product here, nothing new is
// written for it, and the only way to be wrong is to be read. The keys these
// resolve are the ones the palette already renders beside a dimmed entry, so a
// test that invented its own catalog would prove nothing about what a user hears.
import { describe, it, expect, beforeEach } from 'vitest';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { sayUnavailable, unavailableSaid } from './command-voice';
import { announce, resetAnnouncementsForTest, subscribeAnnouncements } from './live-region';
import { buildCommands, type CommandDeps } from './command-set';
import type { Translate } from './session-voice';

const t: Translate = (key, vars) => String(i18next.t(key, vars));

let heard: string[] = [];

beforeEach(async () => {
  await initI18nForTests();
  resetAnnouncementsForTest();
  heard = [];
  subscribeAnnouncements((text) => heard.push(text));
});

describe('the words', () => {
  it('speaks the palette’s own reason, not a second wording of it', () => {
    // §5.32 rule (a)'s "never a parallel path that can drift" applies to what is
    // said as much as to what is written — so the sentence IS the key the dimmed
    // palette entry renders, resolved through the same catalog.
    const said = unavailableSaid(t, {
      id: 'session.hide',
      disabledReasonKey: 'commands.disabled.noActiveSession',
    });
    expect(said).toBe('No session is focused');
    expect(said).toBe(t('commands.disabled.noActiveSession'));
  });

  it('says NOTHING for a command that carries no reason', () => {
    // `disabledReasonKey` is optional on `Command`, so a contributed command can
    // ship an `enabled` predicate without one. Inventing a sentence for it would
    // be guessing at somebody else's rule, and §5.32's own note is that a region
    // which lies is worse than a silent one.
    expect(unavailableSaid(t, { id: 'plugin.thing' })).toBe('');
  });

  it('leaves no placeholder unexpanded, and never reads a key out loud', () => {
    // the #207 defect, at the one layer that sees the real catalog AND the real
    // interpolator. Driven off the REGISTRY rather than a hand-written list: a
    // command shipped with a reason key that does not exist would otherwise
    // reach a screen reader as "commands.disabled.noSuchThing".
    const cmds = buildCommands(depsStub());
    const withReasons = cmds.filter((c) => c.disabledReasonKey);
    expect(withReasons.length).toBeGreaterThan(5); // the set is real, not empty
    for (const c of withReasons) {
      const said = unavailableSaid(t, c);
      expect(said, c.id).not.toBe('');
      expect(said, c.id).not.toMatch(/[{}]/);
      expect(said, c.id).not.toBe(c.disabledReasonKey);
      expect(said, c.id).not.toMatch(/^commands\./);
    }
  });
});

describe('saying it', () => {
  it('goes out through the app’s one live region', () => {
    sayUnavailable({ id: 'attention.next', disabledReasonKey: 'commands.disabled.emptyQueue' });
    expect(heard).toEqual(['Nothing is waiting on you']);
  });

  it('a command with no reason key writes nothing into the region', () => {
    // `announce('')` is already a no-op — and it has to be, because an empty
    // write would CLEAR a sentence a screen reader is still reading out
    announce('something a surface said');
    sayUnavailable({ id: 'plugin.thing' });
    expect(heard).toEqual(['something a surface said']);
  });
});

/**
 * Every `CommandDeps` member answered with a no-op.
 *
 * This file only ever reads the registry's SHAPE — the reason key hanging off
 * each command — and never runs one, so hand-writing the thirty real members
 * (as `command-set.test.ts` does, because it asserts on them) would be thirty
 * lines that have to be kept in step for nothing. A proxy cannot go stale: a
 * dep added next milestone is answered too, whether it is read at build time or
 * not. The cast is the price, and it buys nothing back — a missing dep is not a
 * compile error here. It does not need to be; `command-set.test.ts` is where
 * that is enforced.
 */
function depsStub(): CommandDeps {
  const data: Record<string, unknown> = { dispatchTemplates: [] };
  const noop = (): undefined => undefined;
  return new Proxy(data, {
    get: (target, prop) => (prop in target ? target[prop as string] : noop),
  }) as unknown as CommandDeps;
}
