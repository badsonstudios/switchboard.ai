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

/**
 * The default voice.
 *
 * A backlog is refused rather than queued. `speechSynthesis` will happily line
 * up every utterance it is given and read them all out in order, so eight
 * events while the user is at lunch would become eight sentences read to an
 * empty room, minutes apart from the things they describe. One in flight plus
 * one waiting is the most that can still be current by the time it is said.
 */
export function browserSpeech(): (text: string) => boolean {
  return (text: string): boolean => {
    const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    const Utterance = (
      globalThis as { SpeechSynthesisUtterance?: new (t: string) => SpeechSynthesisUtterance }
    ).SpeechSynthesisUtterance;
    if (!synth || !Utterance) return false;
    if (synth.pending) return false;
    synth.speak(new Utterance(text));
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
