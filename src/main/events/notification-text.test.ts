// #471 — what a notification says about a session that is not asking for
// permission. Run against the real catalog and the real translator, for the
// reason `i18n.test.ts` gives.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createMainI18n } from '../i18n';
import {
  NOTIFICATION_KIND_KEYS,
  SPOKEN_TITLE_MAX,
  announcementFor,
  notificationBody,
  speakableTitle,
} from './notification-text';
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

// ── the spoken half, moved here with the code in #471 ─────────────────────
// Previously in `src/shared/sounds.test.ts`; the assertions are unchanged in
// English, which is the point — this was a mechanism change, not a copy change.
describe('what the voice says (§5.9: "TradingApp needs permission")', () => {
  it.each([
    ['needs-input', 'Add markdown preview needs your input'],
    ['needs-permission', 'Add markdown preview needs permission'],
    ['done', 'Add markdown preview is done'],
    ['crashed', 'Add markdown preview crashed'],
  ])('%s -> %s', (kind, expected) => {
    expect(announcementFor('Add markdown preview', kind, t)).toBe(expected);
  });

  it('says SOMETHING for a kind it has never met', () => {
    // a newer build's feed kind reaching an older sentence table must not
    // produce "undefined" read aloud
    expect(announcementFor('Trading app', 'went-weird', t)).toBe('Trading app went weird');
  });

  it('falls back to the title, because the title is what it is handed', () => {
    // The label/title fallback lives in `main/index.ts` (`titleFor`), which is
    // the SAME string every other channel uses. This is the pin that says so:
    // whatever arrives is what gets spoken, so turning auto labels off changes
    // the sentence without changing a line of this code.
    expect(announcementFor('switchboard.ai', 'done', t)).toBe('switchboard.ai is done');
  });

  it('never reads out a paragraph', () => {
    const long = 'refactor the whole notification stack and also the rules engine and the store';
    const said = announcementFor(long, 'done', t);
    expect(said.length).toBeLessThan(long.length);
    expect(said.endsWith(' is done')).toBe(true);
  });

  it('a nameless session is still announced', () => {
    expect(announcementFor('', 'needs-input', t)).toBe('A session needs your input');
    expect(announcementFor('   ', 'done', t)).toBe('A session is done');
  });
});

describe('trimming a label for a voice', () => {
  it('leaves a short label alone', () => {
    expect(speakableTitle('Add markdown preview', t)).toBe('Add markdown preview');
  });

  it('collapses the whitespace a pasted label brings with it', () => {
    expect(speakableTitle('  Add\n  markdown   preview  ', t)).toBe('Add markdown preview');
  });

  it('cuts at a word boundary, not mid-syllable', () => {
    const said = speakableTitle(
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet',
      t
    );
    expect(said.length).toBeLessThanOrEqual(SPOKEN_TITLE_MAX);
    expect(said.endsWith(' ')).toBe(false);
    // the cut landed between words: every word in the result is whole
    expect('alpha bravo charlie delta echo foxtrot golf hotel india juliet').toContain(said);
  });

  it('still cuts a label with no spaces in it at all', () => {
    const said = speakableTitle('x'.repeat(200), t);
    expect(said.length).toBe(SPOKEN_TITLE_MAX);
  });
});
