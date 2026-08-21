// #471 — the main process's translator.
//
// These tests run the REAL instance against the REAL catalog: no fake `t`, no
// hand-written resource bundle. A fake would prove the code called i18next and
// nothing about whether the app's own keys exist and parse, which is the half
// that actually breaks (#207).
import { describe, it, expect, vi } from 'vitest';
import { createMainI18n } from './i18n';
import type { Logger } from './log/logger';
import { englishString, languageFromUi, normalizeLanguage, type LanguageChoice } from '../shared/i18n';
import { pseudolocalize } from '../shared/i18n/pseudo';

function spyLogger(): Logger {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
  };
  return l;
}

describe('createMainI18n', () => {
  it('renders a real key from the shipped catalog, through ICU', async () => {
    const { t, ready } = await createMainI18n({ language: () => 'en' });
    expect(ready).toBe(true);
    // ICU `{tool}`, not mustache `{{tool}}` — the #207 trap, pinned on main's
    // side of it now that main has one.
    expect(t('approval.title', { tool: 'Edit' })).toBe('Allow Edit?');
    expect(t('approval.allow')).toBe('Allow');
  });

  it('asks the language thunk on EVERY call, so a mid-session switch lands', async () => {
    let lang: LanguageChoice = 'en';
    const language = vi.fn(() => lang);
    const { t } = await createMainI18n({ language });

    expect(t('approval.allow')).toBe('Allow');
    lang = 'pseudo';
    expect(t('approval.allow')).toBe(pseudolocalize('Allow'));
    lang = 'en';
    expect(t('approval.allow')).toBe('Allow');

    // The point of the design, stated as an assertion: nothing is cached, so
    // there is no window in which main and the window disagree about the
    // language. Three calls, three reads.
    expect(language).toHaveBeenCalledTimes(3);
  });

  it('an unknown language falls back to English rather than to the key', async () => {
    // Reachable in the field: `workspace.json` is a plain file a user can edit,
    // and a locale we removed in an update is still sitting in theirs.
    const { t } = await createMainI18n({
      language: () => 'kl' as unknown as LanguageChoice,
    });
    // A key that needs INTERPOLATION, deliberately: `t('approval.allow')` would
    // also read 'Allow' from the raw-English fallback, so it would pass with
    // the whole instance dead. Only a live i18next resolving through
    // `fallbackLng` can turn `{tool}` into `Edit`.
    expect(t('approval.title', { tool: 'Edit' })).toBe('Allow Edit?');
  });

  it('never throws out of t(), because it runs on an OS callback', async () => {
    const log = spyLogger();
    const { t } = await createMainI18n({
      language: () => {
        throw new Error('workspace read exploded');
      },
      log,
    });
    // An exception here would be a crash dialog in the main process (P6). The
    // English source is the answer instead, and it is said out loud.
    expect(t('approval.allow')).toBe('Allow');
    expect(log.warn).toHaveBeenCalled();
  });

  it('a key nobody wrote comes back as the key, i18next own behaviour', async () => {
    const { t } = await createMainI18n({ language: () => 'en' });
    expect(t('notification.thisDoesNotExist')).toBe('notification.thisDoesNotExist');
  });

  it('a key that lands on a NAMESPACE never renders "[object Object]"', async () => {
    const { t } = await createMainI18n({ language: () => 'en' });
    // i18next resolves `notification.kind` to the sub-OBJECT. `String()` on
    // that is the literal text "[object Object]", and it would have gone onto
    // an OS toast and to a phone. The key back is the same thing a missing key
    // gives, which is what a developer already knows how to read.
    expect(t('notification.kind')).toBe('notification.kind');
    expect(t('approval')).toBe('approval');
  });

  it('a failed init degrades to raw English instead of taking the app down', async () => {
    const log = spyLogger();
    const { t, ready } = await createMainI18n({
      language: () => 'en',
      log,
      configure: () => Promise.reject(new Error('catalog is rubble')),
    });
    // The first of the two fail-open promises in `i18n.ts`, with a witness.
    expect(ready).toBe(false);
    expect(log.error).toHaveBeenCalled();
    // Raw English, ICU arguments unexpanded — the honest symptom. `'Allow'`
    // alone would prove nothing here, so the interpolating key is the one
    // asserted: it comes back with its braces showing.
    expect(t('approval.title', { tool: 'Edit' })).toBe('Allow {tool}?');
    expect(t('approval.allow')).toBe('Allow');
  });

  it('a persistently broken language thunk warns ONCE, not once per string', async () => {
    const log = spyLogger();
    const { t } = await createMainI18n({
      language: () => {
        throw new Error('nope');
      },
      log,
    });
    for (let i = 0; i < 20; i++) t('approval.allow');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('the locale preference, read the way main reads it', () => {
  it('comes out of the workspace ui blob — the file main already owns', () => {
    expect(languageFromUi({ language: 'pseudo' })).toBe('pseudo');
    expect(languageFromUi({ language: 'en' })).toBe('en');
  });

  it('fails open on every shape a hand-edited workspace.json can be', () => {
    expect(languageFromUi(null)).toBe('en');
    expect(languageFromUi(undefined)).toBe('en');
    expect(languageFromUi('pseudo')).toBe('en'); // a string is not a blob
    expect(languageFromUi({})).toBe('en');
    expect(languageFromUi({ language: 42 })).toBe('en');
    expect(languageFromUi({ language: 'klingon' })).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
  });
});

describe('englishString — the last-ditch path when i18next never came up', () => {
  it('walks the catalog to a leaf', () => {
    expect(englishString('approval.allow')).toBe('Allow');
  });

  it('hands back the key for anything that is not a leaf string', () => {
    expect(englishString('approval')).toBe('approval');
    expect(englishString('approval.nope')).toBe('approval.nope');
    expect(englishString('nope.nope.nope')).toBe('nope.nope.nope');
  });

  it('leaves ICU arguments unexpanded, which is the honest symptom', () => {
    // Deliberate: this path only runs when the interpolator is gone, and a
    // toast reading "Allow {tool}?" says "something is broken" far better than
    // an empty notification does.
    expect(englishString('approval.title')).toBe('Allow {tool}?');
  });
});
