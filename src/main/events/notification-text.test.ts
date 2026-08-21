// #471 — what a notification says about a session that is not asking for
// permission. Run against the real catalog and the real translator, for the
// reason `i18n.test.ts` gives.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createMainI18n } from '../i18n';
import { NOTIFICATION_KIND_KEYS, notificationBody } from './notification-text';
import type { LanguageChoice, Translate } from '../../shared/i18n';
import { pseudolocalize } from '../../shared/i18n/pseudo';

let lang: LanguageChoice = 'en';
let t: Translate;
beforeAll(async () => {
  t = (await createMainI18n({ language: () => lang })).t;
});
beforeEach(() => {
  lang = 'en';
});

describe('notificationBody', () => {
  it('says in English exactly what it said before #471', () => {
    // The migration is a MECHANISM change, not a copy change. Anything here
    // that differs from the old `kind.replace(/-/g, ' ')` is a regression a
    // reader of the release notes would have to be told about.
    expect(notificationBody('done', t)).toBe('done');
    expect(notificationBody('ready', t)).toBe('ready');
    expect(notificationBody('needs-input', t)).toBe('needs input');
    expect(notificationBody('needs-permission', t)).toBe('needs permission');
    expect(notificationBody('crashed', t)).toBe('crashed');
  });

  it('follows the language', () => {
    lang = 'pseudo';
    expect(notificationBody('needs-input', t)).toBe(pseudolocalize('needs input'));
  });

  it('a kind this build has no key for degrades to readable English, not to a key', () => {
    // A `FeedEvent` can be replayed out of a persisted workspace file written
    // by a different version. "went weird" is wrong-ish; `notification.kind.
    // went-weird` on a user's phone is worse.
    expect(notificationBody('went-weird', t)).toBe('went weird');
    expect(notificationBody('', t)).toBe('');
  });

  it('every key it can reach really exists in the catalog', () => {
    // The Record<FeedKind, …> makes a NEW kind a compile error; this makes a
    // TYPO a test failure. i18next returns the key when it cannot resolve one,
    // so a wrong key is invisible without an assertion like this.
    for (const key of Object.values(NOTIFICATION_KIND_KEYS)) {
      expect(t(key)).not.toBe(key);
    }
  });
});
