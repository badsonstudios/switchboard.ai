// Making the noise (P2-E14-05a, §5.9) — the renderer half.
//
// Main decides WHICH cue and WHAT sentence (`main/events/sound-actions.ts`);
// this file is the speaker. It lives in the renderer because that is where
// Chromium's audio device and voice are — see `main/events/audio-sink.ts` for
// why that beat spawning `powershell` / `afplay` / `paplay` per event.
//
// ── everything here is optional at runtime ───────────────────────────────────
//
// Web Audio, `speechSynthesis`, and the bridge namespace are each read
// defensively and each may simply be absent: a renderer unit harness installs
// only the namespaces it needs, a Linux box without speech-dispatcher has no
// voices, and a locked-down audio stack can refuse an AudioContext outright.
// None of those may throw — a notification nicety must never be able to
// white-screen the shell (P6; #444 taught this the hard way, see SessionGrid's
// `rulesApi` guard). Every failure here ends as `false` and, at most, a
// console line.
import { SoundDef, soundById, soundDurationMs } from '../../../shared/sounds';

/** The slice of Web Audio a cue needs. Structural so a test can fake it. */
export interface OscillatorLike {
  type: string;
  frequency: { setValueAtTime(value: number, at: number): void };
  connect(node: unknown): void;
  start(at: number): void;
  stop(at: number): void;
}

export interface GainLike {
  gain: {
    setValueAtTime(value: number, at: number): void;
    linearRampToValueAtTime(value: number, at: number): void;
  };
  connect(node: unknown): void;
}

export interface AudioContextLike {
  currentTime: number;
  destination: unknown;
  state: string;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  resume(): unknown;
}

/**
 * Peak gain for a cue. Low on purpose: this is a notification, it plays while
 * someone is working, and a sine at full scale through laptop speakers is a
 * fright rather than a signal.
 */
export const CUE_GAIN = 0.16;

/** Attack/release, seconds. Without them a square-edged tone clicks. */
const ATTACK_S = 0.008;
const RELEASE_S = 0.03;

/**
 * Schedule one cue. Returns how long it will take, ms.
 *
 * Each note gets its own oscillator and gain: an envelope per note is what
 * makes a two-note cue read as two notes rather than one warbling one, and
 * oscillators are single-use by spec anyway.
 */
export function scheduleCue(ctx: AudioContextLike, def: SoundDef): number {
  let at = ctx.currentTime;
  for (const tone of def.tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = def.wave;
    osc.frequency.setValueAtTime(tone.hz, at);
    const seconds = tone.ms / 1000;
    // 0 is not a legal target for an exponential ramp and an abrupt cut clicks,
    // so the envelope is linear and ends just above silence.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(CUE_GAIN, at + Math.min(ATTACK_S, seconds / 2));
    gain.gain.linearRampToValueAtTime(0, at + seconds);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + seconds + RELEASE_S);
    at += seconds + (tone.gapMs ?? 0) / 1000;
  }
  return soundDurationMs(def);
}

export interface AnnouncerDeps {
  /** make (or hand back) an audio context; `null` = this machine has no audio */
  audio?: () => AudioContextLike | null;
  /** say it out loud; `false` = nothing could */
  speak?: (text: string) => boolean;
  onError?: (what: string, err: unknown) => void;
}

export interface Announcer {
  play(soundId: string): boolean;
  say(text: string): boolean;
}

/** The default audio context factory: one lazily-made context, reused. */
export function browserAudio(): () => AudioContextLike | null {
  let ctx: AudioContextLike | null = null;
  return () => {
    if (ctx) return ctx;
    const Ctor = (globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  };
}

// ── which voice (#1390) ──────────────────────────────────────────────────────
//
// Settings ▸ Notifications lets the user pick one of the OS's own voices. The
// choice is stored by main (`NotificationPrefs.speakVoice`, the voice's
// `voiceURI`) and handed to this module at boot and on every change, so the
// cue main pushes and the dialog's Preview go through the SAME lookup below.
//
// THE FAIL-OPEN LADDER. A stored voice can stop existing at any time — it was
// uninstalled, the workspace moved to another machine, the OS renamed it. The
// answer is never an error and never a skipped announcement:
//
//   1. the chosen voice, matched on `voiceURI`, then on `name`;
//   2. not there → the OS default (an utterance with no voice set), logged at
//      info ONCE per stored value, so a missing voice is findable in the log
//      without a line per event;
//   3. no speech at all on this machine → `false`, which is what already sends
//      main its plain beep (Linux without speech-dispatcher).
//
// `getVoices()` answers an EMPTY list in Chromium until the voices have loaded
// (`voiceschanged`), and on some machines it stays empty for good. Both read
// as rung 2 — the default voice still speaks — and `listVoices` primes the
// load at boot so the first real announcement is not the one that finds out.

/** The slice of a `SpeechSynthesisVoice` the picker and the lookup need. */
export interface VoiceLike {
  name: string;
  voiceURI: string;
  lang?: string;
  default?: boolean;
  localService?: boolean;
}

/** The chosen voice's `voiceURI`, or `null` for the OS default. Module-level
 *  for the reason `muted` is: it must hold whatever order things mount in. */
let voicePref: string | null = null;
/** the stored value whose fallback has already been logged */
let loggedFallbackFor: string | null = null;

export function setVoicePreference(value: string | null | undefined): void {
  const next = typeof value === 'string' && value.length > 0 ? value : null;
  if (next !== voicePref) loggedFallbackFor = null;
  voicePref = next;
}

export function voicePreference(): string | null {
  return voicePref;
}

/**
 * Rung 1 of the ladder, as a pure function: the voice whose `voiceURI` is
 * `pref`, else the one whose `name` is, else `null` (= use the default).
 */
export function chooseVoice<V extends VoiceLike>(voices: readonly V[], pref: string | null): V | null {
  if (!pref) return null;
  return voices.find((v) => v.voiceURI === pref) ?? voices.find((v) => v.name === pref) ?? null;
}

type SynthLike = Pick<SpeechSynthesis, 'pending' | 'speak'> & {
  getVoices?: () => SpeechSynthesisVoice[];
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
};

function synthesis(): SynthLike | undefined {
  return (globalThis as { speechSynthesis?: SynthLike }).speechSynthesis;
}

/** The OS's voices, as far as Chromium has loaded them. Never throws; an
 *  empty list is an ordinary answer (see above). Calling it also starts the
 *  load, which is why App calls it once at boot. */
export function listVoices(): VoiceLike[] {
  try {
    const list = synthesis()?.getVoices?.();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Call `cb` whenever the voice list changes (it arrives late in Chromium).
 *  Returns the unsubscribe; a no-op where the event does not exist. */
export function onVoicesChanged(cb: () => void): () => void {
  const synth = synthesis();
  try {
    synth?.addEventListener?.('voiceschanged', cb);
  } catch {
    return () => {};
  }
  return () => {
    try {
      synth?.removeEventListener?.('voiceschanged', cb);
    } catch {
      /* best-effort */
    }
  };
}

/**
 * The default voice.
 *
 * A backlog is refused rather than queued. `speechSynthesis` will happily line
 * up every utterance it is given and read them all out in order, so eight
 * events while the user is at lunch would become eight sentences read to an
 * empty room, minutes apart from the things they describe. One in flight plus
 * one waiting is the most that can still be current by the time it is said.
 *
 * `log` is where rung 2 of the ladder is reported; the renderer's console is
 * copied into the app log at info by main (`main/index.ts`, `console-message`).
 */
export function browserSpeech(
  log: (message: string) => void = (m) => console.info(m)
): (text: string) => boolean {
  return (text: string): boolean => {
    const synth = synthesis();
    const Utterance = (
      globalThis as { SpeechSynthesisUtterance?: new (t: string) => SpeechSynthesisUtterance }
    ).SpeechSynthesisUtterance;
    if (!synth || !Utterance) return false;
    if (synth.pending) return false;
    const utterance = new Utterance(text);
    const pref = voicePref;
    if (pref) {
      const voices = listVoices();
      const voice = chooseVoice(voices, pref);
      let used = false;
      if (voice) {
        try {
          utterance.voice = voice as SpeechSynthesisVoice;
          used = true;
        } catch {
          /* a voice the engine will not take is a missing voice: rung 2 */
        }
      }
      if (!used && loggedFallbackFor !== pref) {
        loggedFallbackFor = pref;
        log(
          `[announcer] the chosen voice "${pref}" is not available ` +
            `(${voices.length} voice(s) on this machine); speaking in the system default`
        );
      }
    }
    synth.speak(utterance);
    return true;
  };
}

/**
 * Make no noise, but answer as though we did (P2-E14-05a) — the renderer half
 * of `SWITCHBOARD_MUTE_AUDIO`, set from the bridge at boot.
 *
 * Main's own mute covers the cues main pushes. It cannot cover the two the
 * renderer plays by itself: the card menu's preview and the "hear what you just
 * turned on" sample. Those never leave this process, so without this the e2e
 * suite would chime and TALK on the machine its owner is working at while every
 * main-process log line said "muted".
 *
 * Module-level rather than a constructor argument so it holds whatever order
 * things mount in — a card that reached for the shared announcer before App's
 * boot effect ran would otherwise get an unmuted one.
 */
let muted = false;

export function setAudioMuted(value: boolean): void {
  muted = value;
}

export function createAnnouncer(deps: AnnouncerDeps = {}): Announcer {
  const audio = deps.audio ?? browserAudio();
  const speak = deps.speak ?? browserSpeech();
  const fail = (what: string, err: unknown): false => {
    deps.onError?.(what, err);
    return false;
  };
  return {
    play(soundId) {
      if (muted) return true;
      try {
        const ctx = audio();
        if (!ctx) return false;
        // Chromium suspends a context created without a user gesture. By the
        // time a session raises an attention event the user has almost always
        // clicked something, but "almost always" is not a thing to leave a
        // silent failure on — `resume()` is a no-op on a running context.
        if (ctx.state === 'suspended') void ctx.resume();
        scheduleCue(ctx, soundById(soundId));
        return true;
      } catch (err) {
        return fail('play', err);
      }
    },
    say(text) {
      if (muted) return true;
      try {
        return !!text && speak(text);
      } catch (err) {
        return fail('speak', err);
      }
    },
  };
}

/**
 * The window's one announcer.
 *
 * A singleton because an AudioContext is a real, limited resource — Chromium
 * caps them per document — and because the title bar's "hear what you just
 * turned on" preview and the cue main pushes have to come out of the same
 * device or one of them will be the one that is silent.
 */
let shared: Announcer | null = null;

export function sharedAnnouncer(): Announcer {
  return (shared ??= createAnnouncer());
}

/** Swap it out (tests). Passing `null` restores the real one on next use. */
export function setSharedAnnouncer(a: Announcer | null): void {
  shared = a;
}

/** The bridge slice this needs — read as optional, like every other namespace. */
interface SoundBridge {
  onPlay?: (cb: (c: { sound: string }) => void) => () => void;
  onSpeak?: (cb: (c: { text: string }) => void) => () => void;
  /** tell main we could not play it, so it can beep instead */
  failed?: (channel: 'sound' | 'speak') => Promise<unknown>;
}

/**
 * Subscribe to main's cues for the lifetime of the window. Returns the
 * unsubscribe, and is safe to call when the bridge has no `sounds` namespace at
 * all (an older preload, or a unit harness) — it simply does nothing.
 */
export function installAnnouncer(bridge: SoundBridge | undefined, announcer: Announcer): () => void {
  const offs: Array<() => void> = [];
  // Report a cue we could not play. Main sent it fire-and-forget and has
  // already stood its own beep down, so if this answer never goes back the
  // event is silent — see `AUDIO_FAILED_CHANNEL`. Best-effort in both
  // directions: a bridge without `failed` (an older preload) just means the
  // old behaviour, never a throw out of an event handler.
  const report = (channel: 'sound' | 'speak', played: boolean): void => {
    if (played) return;
    try {
      void bridge?.failed?.(channel)?.catch(() => {});
    } catch {
      /* the report is a courtesy; failing to send it must cost nothing */
    }
  };
  try {
    if (bridge?.onPlay) offs.push(bridge.onPlay((c) => report('sound', announcer.play(c?.sound))));
    if (bridge?.onSpeak) offs.push(bridge.onSpeak((c) => report('speak', announcer.say(c?.text))));
  } catch {
    /* a bridge that throws on subscribe leaves the app silent, not broken */
  }
  return () => {
    for (const off of offs)
      try {
        off();
      } catch {
        /* unsubscribing is best-effort too */
      }
  };
}
