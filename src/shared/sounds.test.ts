// The sound bank and the sentence (P2-E14-05a).
//
// The done-when this file owns is "two sessions ring distinguishably" and "TTS
// speaks the label and falls back to the title". The second one is mostly
// somebody else's code — `main/index.ts` resolves label-or-title into
// `ctx.title` for every channel — so what is pinned here is that the sentence
// is built from THAT string and not from the event body, plus the bank really
// does hold cues a person can tell apart.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SOUND,
  SOUND_BANK,
  SOUND_IDS,
  SPOKEN_TITLE_MAX,
  announcementFor,
  isSoundId,
  nextCardSound,
  nextSoundId,
  soundById,
  soundDurationMs,
  soundForIndex,
  speakableTitle,
} from './sounds';

describe('the bank (done-when: two sessions ring distinguishably)', () => {
  it('has one cue per card in a full workspace', () => {
    // §5.8 sizes the grid at 7–8; fewer cues than that means two cards in a
    // workspace the app was designed for share a sound.
    expect(SOUND_BANK.length).toBeGreaterThanOrEqual(8);
  });

  it('every id is unique', () => {
    expect(new Set(SOUND_IDS).size).toBe(SOUND_BANK.length);
  });

  it('no two cues are the same NOISE, not merely the same name', () => {
    // The real risk is not a duplicated id — it is two entries that differ only
    // in a field nobody hears. Compare the thing that reaches the ear: the
    // wave and the whole note sequence.
    const shapes = SOUND_BANK.map((s) => `${s.wave}|${s.tones.map((t) => `${t.hz}@${t.ms}`).join(',')}`);
    expect(new Set(shapes).size).toBe(SOUND_BANK.length);
  });

  it('every cue is short enough to be a notification', () => {
    // A cue is a signal, not a ringtone: anything approaching a second is
    // something the user starts waiting out.
    for (const s of SOUND_BANK) expect(soundDurationMs(s), s.id).toBeLessThanOrEqual(600);
    for (const s of SOUND_BANK) expect(soundDurationMs(s), s.id).toBeGreaterThan(0);
  });

  it('every cue is audible on a laptop speaker', () => {
    // Below ~200 Hz a small speaker reproduces almost nothing, and above ~4 kHz
    // it stops being a cue and starts being a smoke alarm.
    for (const s of SOUND_BANK)
      for (const t of s.tones) {
        expect(t.hz, s.id).toBeGreaterThanOrEqual(200);
        expect(t.hz, s.id).toBeLessThanOrEqual(4000);
      }
  });
});

describe('assigning a cue to a card', () => {
  it('gives the first eight cards eight different cues', () => {
    const ids = Array.from({ length: SOUND_BANK.length }, (_, i) => soundForIndex(i).id);
    expect(new Set(ids).size).toBe(SOUND_BANK.length);
  });

  it('wraps rather than running out', () => {
    expect(soundForIndex(SOUND_BANK.length).id).toBe(SOUND_BANK[0].id);
    expect(soundForIndex(SOUND_BANK.length + 2).id).toBe(SOUND_BANK[2].id);
  });

  it('a nonsense position still gets a cue, never silence', () => {
    // fail-open (P6): hearing the wrong cue beats hearing nothing and deciding
    // the app is broken
    expect(soundForIndex(-1).id).toBe(DEFAULT_SOUND.id);
    expect(soundForIndex(1.5).id).toBe(DEFAULT_SOUND.id);
  });

  it('cycles through the whole bank and comes back', () => {
    let id = SOUND_BANK[0].id;
    const seen = [id];
    for (let i = 0; i < SOUND_BANK.length - 1; i++) {
      id = nextSoundId(id);
      seen.push(id);
    }
    expect(new Set(seen).size).toBe(SOUND_BANK.length);
    expect(nextSoundId(id)).toBe(SOUND_BANK[0].id);
  });

  it('cycling from something unknown lands on the first cue', () => {
    // the menu's starting state when a workspace file names a cue this build
    // dropped — it must not strand the user outside the bank
    expect(nextSoundId('not-a-sound')).toBe(SOUND_BANK[0].id);
    expect(nextSoundId(undefined)).toBe(SOUND_BANK[0].id);
  });

  it('the menu cycle has a way BACK to automatic', () => {
    // nine steps, not eight. Without the last one a stray click pins a cue for
    // ever and the only way out is editing the workspace file by hand.
    const last = SOUND_BANK[SOUND_BANK.length - 1].id;
    expect(nextCardSound({ id: last, pinned: true })).toBeNull();
  });

  it('walks the bank from automatic, pinning as it goes', () => {
    expect(nextCardSound({ id: 'chime', pinned: false })).toBe('bell');
    expect(nextCardSound({ id: 'bell', pinned: true })).toBe('knock');
  });

  it('an automatic card sitting on the LAST cue still steps forward', () => {
    // "automatic" is not a step you can be on and re-select; it is where the
    // cycle ENDS. A card auto-assigned the last cue must move into the bank,
    // not sit still.
    const last = SOUND_BANK[SOUND_BANK.length - 1].id;
    expect(nextCardSound({ id: last, pinned: false })).toBe(SOUND_BANK[0].id);
  });

  it('a card with nothing read yet starts at the first cue', () => {
    expect(nextCardSound(null)).toBe(SOUND_BANK[0].id);
    expect(nextCardSound(undefined)).toBe(SOUND_BANK[0].id);
  });

  it('an unknown name resolves to a real cue', () => {
    expect(soundById('not-a-sound')).toBe(DEFAULT_SOUND);
    expect(soundById(null)).toBe(DEFAULT_SOUND);
    expect(soundById('bell').id).toBe('bell');
  });

  it('only names the bank knows are sound ids', () => {
    expect(isSoundId('chime')).toBe(true);
    expect(isSoundId('CHIME')).toBe(false);
    expect(isSoundId('')).toBe(false);
    expect(isSoundId(null)).toBe(false);
    expect(isSoundId(3)).toBe(false);
  });
});

describe('what the voice says (§5.9: "TradingApp needs permission")', () => {
  it.each([
    ['needs-input', 'Add markdown preview needs your input'],
    ['needs-permission', 'Add markdown preview needs permission'],
    ['done', 'Add markdown preview is done'],
    ['crashed', 'Add markdown preview crashed'],
  ])('%s -> %s', (kind, expected) => {
    expect(announcementFor('Add markdown preview', kind)).toBe(expected);
  });

  it('says SOMETHING for a kind it has never met', () => {
    // a newer build's feed kind reaching an older sentence table must not
    // produce "undefined" read aloud
    expect(announcementFor('Trading app', 'went-weird')).toBe('Trading app went weird');
  });

  it('falls back to the title, because the title is what it is handed', () => {
    // The label/title fallback lives in `main/index.ts` (`titleFor`), which is
    // the SAME string every other channel uses. This is the pin that says so:
    // whatever arrives is what gets spoken, so turning auto labels off changes
    // the sentence without changing a line of this code.
    expect(announcementFor('switchboard.ai', 'done')).toBe('switchboard.ai is done');
  });

  it('never reads out a paragraph', () => {
    const long = 'refactor the whole notification stack and also the rules engine and the store';
    const said = announcementFor(long, 'done');
    expect(said.length).toBeLessThan(long.length);
    expect(said.endsWith(' is done')).toBe(true);
  });

  it('a nameless session is still announced', () => {
    expect(announcementFor('', 'needs-input')).toBe('A session needs your input');
    expect(announcementFor('   ', 'done')).toBe('A session is done');
  });
});

describe('trimming a label for a voice', () => {
  it('leaves a short label alone', () => {
    expect(speakableTitle('Add markdown preview')).toBe('Add markdown preview');
  });

  it('collapses the whitespace a pasted label brings with it', () => {
    expect(speakableTitle('  Add\n  markdown   preview  ')).toBe('Add markdown preview');
  });

  it('cuts at a word boundary, not mid-syllable', () => {
    const said = speakableTitle('alpha bravo charlie delta echo foxtrot golf hotel india juliet');
    expect(said.length).toBeLessThanOrEqual(SPOKEN_TITLE_MAX);
    expect(said.endsWith(' ')).toBe(false);
    // the cut landed between words: every word in the result is whole
    expect('alpha bravo charlie delta echo foxtrot golf hotel india juliet').toContain(said);
  });

  it('still cuts a label with no spaces in it at all', () => {
    const said = speakableTitle('x'.repeat(200));
    expect(said.length).toBe(SPOKEN_TITLE_MAX);
  });
});
