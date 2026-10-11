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
  sessionNameAmong,
  speakableName,
  speakableTitle,
  spokenWho,
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

// #1206 — the voice says the SESSION'S NAME. The owner, hand-testing: "If I'm
// in Switchboard AI, it needs to say 'Switchboard AI, and then what's going
// on.' If I'm in BrainHarbor, 'BrainHarbor session, and what's going on.'"
describe('a session name, made sayable (#1206)', () => {
  it.each([
    // the owner's own two
    ['Switchboard.ai', 'Switchboard AI'],
    ['BrainHarbor', 'BrainHarbor'],
    // a short tail after a dot is spelled, a long one is a word
    ['node.js', 'node JS'],
    ['notes.markdown', 'notes markdown'],
    ['a.b.c', 'a B C'],
    // three letters with a vowel are usually a WORD, and stay one
    ['my.app', 'my app'],
    ['api.dev', 'api dev'],
    ['john.doe', 'john doe'],
    // three with none are an ending, and are spelled
    ['readme.txt', 'readme TXT'],
    ['site.css', 'site CSS'],
    // a digit before the dot does not defeat it
    ['web3.js', 'web3 JS'],
    // a dot between DIGITS is a number, and is left to be said as one
    ['v0.8.119', 'v0.8.119'],
    ['api 2.0', 'api 2.0'],
    // joiners between words become spaces
    ['my-app_two', 'my app two'],
    ['front/end', 'front end'],
    // punctuation that is not between words is left alone
    ['Switchboard.ai - for tickets', 'Switchboard AI - for tickets'],
    ['-leading', '-leading'],
    ['  spaced   out  ', 'spaced out'],
    ['', ''],
  ])('%j is said as %j', (name, said) => {
    expect(speakableName(name)).toBe(said);
  });
});

describe('who the voice names (#1206)', () => {
  it('the session, not the task', () => {
    expect(
      spokenWho({ name: 'Switchboard.ai', label: 'Fix the tail-pin gesture window' }, t)
    ).toBe('Switchboard AI');
  });

  it('and the whole sentence leads with it', () => {
    const who = spokenWho({ name: 'Switchboard.ai', label: 'Fix the tail-pin gesture' }, t);
    expect(announcementFor(who, 'needs-permission', t)).toBe('Switchboard AI needs permission');
    expect(announcementFor(spokenWho({ name: 'BrainHarbor', label: 'x' }, t), 'done', t)).toBe(
      'BrainHarbor is done'
    );
  });

  it('two sessions with ONE name: the task label follows, because the name alone does not say which', () => {
    expect(
      spokenWho({ name: 'Switchboard.ai', shared: true, label: 'Review the release notes' }, t)
    ).toBe('Switchboard AI, Review the release notes');
  });

  it('...but not when there is no label to add, or it only repeats the name', () => {
    expect(spokenWho({ name: 'BrainHarbor', shared: true, label: 'BrainHarbor' }, t)).toBe(
      'BrainHarbor'
    );
    expect(spokenWho({ name: 'BrainHarbor', shared: true, label: '' }, t)).toBe('BrainHarbor');
  });

  it('no name known: what the voice said before, the label', () => {
    expect(spokenWho({ name: null, label: 'Add markdown preview' }, t)).toBe('Add markdown preview');
    expect(spokenWho({ label: '' }, t)).toBe('A session');
  });

  it('a name with nothing a voice can say is no name: the label is used', () => {
    expect(spokenWho({ name: '...', label: 'Add markdown preview' }, t)).toBe('Add markdown preview');
    expect(spokenWho({ name: '---', label: '' }, t)).toBe('A session');
  });

  it('when a label has to follow, a LONG name gives way so the label survives', () => {
    const said = spokenWho(
      { name: 'an extremely long session name that goes on and on', shared: true, label: 'Tidy' },
      t
    );
    expect(said.endsWith(', Tidy')).toBe(true);
    expect(said.length).toBeLessThanOrEqual(SPOKEN_TITLE_MAX);
  });

  it('a very long name is still cut to a breath', () => {
    const said = spokenWho({ name: 'word '.repeat(60), label: 'x' }, t);
    expect(said.length).toBeLessThanOrEqual(SPOKEN_TITLE_MAX);
  });
});

describe('which name, and whether another session sounds the same (#1206)', () => {
  const open = [
    { id: 'l1', title: 'Switchboard.ai' },
    { id: 'l2', title: 'BrainHarbor' },
    { id: 'l3', title: 'my-app' },
    { id: 'l4', title: 'my_app' },
    { id: 'l5', title: 'brainharbor' },
  ];

  it('is the session the event belongs to, by its own name', () => {
    expect(sessionNameAmong(open, 'l1')).toEqual({ name: 'Switchboard.ai', shared: false });
  });

  it('shared is judged BY EAR: names that are said the same are the same', () => {
    // different on screen, the same two words aloud
    expect(sessionNameAmong(open, 'l3')).toEqual({ name: 'my-app', shared: true });
    expect(sessionNameAmong(open, 'l4')).toEqual({ name: 'my_app', shared: true });
    // ...and a voice has no capital letters
    expect(sessionNameAmong(open, 'l2')?.shared).toBe(true);
  });

  it('a session nobody has a record of has no name to give', () => {
    expect(sessionNameAmong(open, 'nope')).toBeNull();
    expect(sessionNameAmong([{ id: 'x', title: '' }], 'x')).toBeNull();
  });
});
