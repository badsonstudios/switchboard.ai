// Per-session sounds and spoken announcements — the pure core (P2-E14-05a,
// §5.9 + §5.11).
//
// Shared, because the two halves of this channel live in different processes
// and must not drift: MAIN decides WHICH sound a card gets and WHAT sentence to
// speak, the RENDERER turns those into actual noise (Web Audio + the Web Speech
// API — the audio device Electron gives us is Chromium's). Everything in this
// file is data and pure functions: no electron, no window, no AudioContext.
//
// ── why synthesized tones and not a folder of .wav files ─────────────────────
//
// A sound bank as DATA is a bank we can unit-test, localize the names of, and
// ship without adding binary assets, a licensing question, or a packaging step
// to electron-builder. The cost is honest: these are tones, not a sound
// designer's chimes. They are chosen to be told APART — that is the whole
// requirement (§5.11: "a per-session notification sound doubles as an audio
// identity") — by moving in different directions across different registers,
// which survives cheap laptop speakers where timbre alone does not.
//
// ── why the payload is a NAME, not a recipe ──────────────────────────────────
//
// Main sends `{ sound: 'chime' }` and the renderer looks the recipe up here. A
// recipe on the wire would let a renderer built from a different commit play
// something the main process never meant, and it would put a synthesizer
// parameter into an IPC contract, where it would then be frozen.

/**
 * The two main→renderer channels this feature adds. Named here because both
 * ends have to agree on them and neither end owns the other.
 */
export const AUDIO_PLAY_CHANNEL = 'audio:play';
export const AUDIO_SPEAK_CHANNEL = 'audio:speak';

/** What main sends on `audio:play`. */
export interface AudioPlayCue {
  sound: string;
}

/** What main sends on `audio:speak`. */
export interface AudioSpeakCue {
  text: string;
}

/** A card's cue, as `sounds:get` / `sounds:set` answer it. */
export interface CardSound {
  /** the cue that will actually ring for this card */
  id: string;
  /** did the user choose it, or is it the one the workspace position handed over? */
  pinned: boolean;
}

/** One note in a cue: a frequency, how long it sounds, and the gap after it. */
export interface SoundTone {
  /** Hz */
  hz: number;
  /** how long the note sounds, ms */
  ms: number;
  /** silence after the note before the next one, ms */
  gapMs?: number;
}

export type SoundWave = 'sine' | 'triangle' | 'square';

export interface SoundDef {
  id: string;
  wave: SoundWave;
  tones: readonly SoundTone[];
}

/**
 * The bank — eight cues, one per session in a full workspace (§5.8 sizes the
 * grid at 7–8 cards), so a workspace the app was designed for never has to
 * repeat one.
 *
 * They are ordered so that NEIGHBOURS are maximally unalike: an ascending pair
 * is followed by a single high ring, then a low double-tap, and so on. Auto
 * assignment (`soundForIndex`) walks this order, so the first sessions a user
 * opens get the most obviously different cues rather than four variations on a
 * ping.
 */
export const SOUND_BANK: readonly SoundDef[] = [
  // ascending perfect fourth — the "something finished" shape
  { id: 'chime', wave: 'sine', tones: [{ hz: 880, ms: 110, gapMs: 20 }, { hz: 1175, ms: 190 }] },
  // one long bell, high and alone
  { id: 'bell', wave: 'triangle', tones: [{ hz: 1319, ms: 320 }] },
  // two low taps, deliberately unmusical
  { id: 'knock', wave: 'sine', tones: [{ hz: 392, ms: 90, gapMs: 70 }, { hz: 392, ms: 90 }] },
  // three notes up — the most "attention" of the eight
  {
    id: 'rise',
    wave: 'sine',
    tones: [
      { hz: 523, ms: 90, gapMs: 10 },
      { hz: 659, ms: 90, gapMs: 10 },
      { hz: 784, ms: 170 },
    ],
  },
  // short, dry, mid — the least intrusive one in the bank
  { id: 'blip', wave: 'square', tones: [{ hz: 660, ms: 70 }] },
  // descending — reads as "closing", pairs with `rise` without sounding like it
  { id: 'fall', wave: 'sine', tones: [{ hz: 784, ms: 110, gapMs: 20 }, { hz: 523, ms: 200 }] },
  // very high, very short
  { id: 'ping', wave: 'triangle', tones: [{ hz: 1568, ms: 80 }] },
  // low pair, warm
  { id: 'thrum', wave: 'sine', tones: [{ hz: 262, ms: 130, gapMs: 30 }, { hz: 330, ms: 220 }] },
];

export const SOUND_IDS: readonly string[] = SOUND_BANK.map((s) => s.id);

/** The cue that plays when a card has no sound of its own and no place in a
 *  workspace to take one from (a card the store cannot find). */
export const DEFAULT_SOUND = SOUND_BANK[0];

/** Look a cue up by name; unknown names fall back rather than going silent. */
export function soundById(id: string | null | undefined): SoundDef {
  return SOUND_BANK.find((s) => s.id === id) ?? DEFAULT_SOUND;
}

export function isSoundId(id: unknown): id is string {
  return typeof id === 'string' && SOUND_IDS.includes(id);
}

/**
 * The cue auto-assigned to the card sitting at `index` in the workspace.
 *
 * Auto-assigned from a distinguishable bank, user-overridable — the same deal
 * §5.11 gives the accent colour, and the reason "two sessions ring
 * distinguishably" is true before anybody configures anything.
 *
 * By POSITION and not by a hash of the card id, because a hash collides: with
 * eight cues and four sessions the odds of two sessions sharing one are better
 * than one in three, and "distinguishable" would then be a coin flip. The cost
 * is that deleting a card can shift the cue of the cards after it; pinning one
 * (`sound` on the card) is the fix, and the manual says so.
 */
export function soundForIndex(index: number): SoundDef {
  if (!Number.isInteger(index) || index < 0) return DEFAULT_SOUND;
  return SOUND_BANK[index % SOUND_BANK.length];
}

/** The next cue in the bank — what the card menu's cycling entry lands on. */
export function nextSoundId(id: string | null | undefined): string {
  const i = SOUND_BANK.findIndex((s) => s.id === id);
  return SOUND_BANK[(i + 1) % SOUND_BANK.length].id;
}

/**
 * How long the whole cue lasts, ms. Used by the renderer to schedule it and by
 * the tests to prove a cue stays inside the "a notification is not a song"
 * budget.
 */
export function soundDurationMs(def: SoundDef): number {
  return def.tones.reduce((ms, t) => ms + t.ms + (t.gapMs ?? 0), 0);
}

/**
 * The sentence the app speaks (§5.9: "TradingApp needs permission").
 *
 * `title` is whatever the rules engine already resolved for every other
 * channel — the card's auto task label when there is one, the session title
 * when there is not (`main/index.ts` → `titleFor`). That chain is why the
 * fallback in this item's spec needs no code here: turning auto labels off
 * changes what `title` IS, and this function speaks whatever it is handed.
 *
 * The event's own body is deliberately NOT spoken. For `needs-permission` that
 * body is a tool-call summary ("Bash: rm -rf …"), which is the right thing to
 * READ on a toast you can look at and the wrong thing to have read ALOUD at you
 * across a room — a sentence you cannot skim, cannot pause, and cannot re-read.
 */
export function announcementFor(title: string, kind: string): string {
  const who = speakableTitle(title);
  switch (kind) {
    case 'needs-input':
      return `${who} needs your input`;
    case 'needs-permission':
      return `${who} needs permission`;
    case 'done':
      return `${who} is done`;
    case 'crashed':
      return `${who} crashed`;
    default:
      return `${who} ${kind.replace(/-/g, ' ')}`.trim();
  }
}

/** How much of a label a voice is allowed to read out. */
export const SPOKEN_TITLE_MAX = 60;

/**
 * A label, trimmed to something a voice can say in a breath.
 *
 * Auto task labels come from the CLI's own conversation title and are usually
 * short, but nothing GUARANTEES that — a user-typed label is free text, and a
 * paragraph of it would be read out in full, over the top of the next event,
 * with no way to stop it. Cut at a word boundary where there is one so the
 * result is still a phrase rather than a syllable.
 */
export function speakableTitle(title: string): string {
  const clean = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'A session';
  if (clean.length <= SPOKEN_TITLE_MAX) return clean;
  const cut = clean.slice(0, SPOKEN_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > SPOKEN_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trim();
}
