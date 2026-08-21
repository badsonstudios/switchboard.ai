// Making the noise (P2-E14-05a) — the renderer half.
//
// No real AudioContext and no real voice anywhere in this file, and not only
// because jsdom has neither: a unit suite that actually played eight cues would
// be a suite nobody runs twice. The fakes here record what WOULD have been
// scheduled, which is the part that can be wrong.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  AudioContextLike,
  CUE_GAIN,
  GainLike,
  OscillatorLike,
  browserSpeech,
  createAnnouncer,
  installAnnouncer,
  setAudioMuted,
  scheduleCue,
  setSharedAnnouncer,
  sharedAnnouncer,
} from './announcer';
import { SOUND_BANK, soundById } from '../../../shared/sounds';

interface Note {
  wave: string;
  hz: number;
  startAt: number;
  stopAt: number;
  /** the gain this note was routed through, and where that gain went */
  gain: { target: unknown } | null;
}

function fakeContext(state = 'running'): AudioContextLike & { notes: Note[]; resumed: number } {
  const notes: Note[] = [];
  const gains: Array<GainLike & { target: unknown }> = [];
  const ctx = {
    notes,
    resumed: 0,
    currentTime: 0,
    destination: { id: 'speakers' },
    state,
    createGain(): GainLike {
      // the wrapper IS the node identity — `osc.connect(gain)` is handed this
      // object, so the test has to be able to find it by reference
      const node: GainLike & { target: unknown } = {
        target: null,
        gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
        connect: (n: unknown) => {
          node.target = n;
        },
      };
      gains.push(node);
      return node;
    },
    createOscillator(): OscillatorLike {
      const note: Note = { wave: '', hz: 0, startAt: 0, stopAt: 0, gain: null };
      notes.push(note);
      return {
        set type(v: string) {
          note.wave = v;
        },
        get type() {
          return note.wave;
        },
        frequency: {
          setValueAtTime: (hz: number) => {
            note.hz = hz;
          },
        },
        connect: (n: unknown) => {
          note.gain = gains.find((g) => g === n) ?? null;
        },
        start: (at: number) => {
          note.startAt = at;
        },
        stop: (at: number) => {
          note.stopAt = at;
        },
      };
    },
    resume() {
      ctx.resumed++;
    },
  };
  return ctx;
}

describe('scheduling a cue', () => {
  it('schedules one oscillator per note, at the bank frequencies', () => {
    const ctx = fakeContext();
    const rise = soundById('rise');
    scheduleCue(ctx, rise);
    expect(ctx.notes.map((n) => n.hz)).toEqual(rise.tones.map((t) => t.hz));
    expect(ctx.notes.every((n) => n.wave === rise.wave)).toBe(true);
  });

  it('plays the notes in order, never on top of each other', () => {
    const ctx = fakeContext();
    scheduleCue(ctx, soundById('rise'));
    for (let i = 1; i < ctx.notes.length; i++)
      expect(ctx.notes[i].startAt).toBeGreaterThan(ctx.notes[i - 1].startAt);
  });

  it('every note is stopped, so nothing is left ringing', () => {
    const ctx = fakeContext();
    scheduleCue(ctx, soundById('chime'));
    for (const n of ctx.notes) expect(n.stopAt).toBeGreaterThan(n.startAt);
  });

  it('routes each note through a gain, never straight at the speakers', () => {
    // an oscillator connected directly to `destination` starts and stops at
    // full scale, which is the click this envelope exists to avoid
    const ctx = fakeContext();
    scheduleCue(ctx, soundById('bell'));
    for (const n of ctx.notes) expect(n.gain?.target).toEqual({ id: 'speakers' });
  });

  it('reports how long the cue lasts', () => {
    const ctx = fakeContext();
    expect(scheduleCue(ctx, soundById('chime'))).toBeGreaterThan(0);
  });

  it('stays quiet enough to be a notification', () => {
    // a sine at full scale through laptop speakers is a fright, not a signal
    expect(CUE_GAIN).toBeLessThan(0.35);
    expect(CUE_GAIN).toBeGreaterThan(0);
  });

  it('every cue in the bank schedules without throwing', () => {
    for (const def of SOUND_BANK) {
      const ctx = fakeContext();
      expect(() => scheduleCue(ctx, def), def.id).not.toThrow();
      expect(ctx.notes.length, def.id).toBe(def.tones.length);
    }
  });
});

describe('the announcer', () => {
  it('plays a named cue', () => {
    const ctx = fakeContext();
    const a = createAnnouncer({ audio: () => ctx });
    expect(a.play('bell')).toBe(true);
    expect(ctx.notes).toHaveLength(soundById('bell').tones.length);
  });

  it('resumes a suspended context — Chromium suspends one made without a click', () => {
    const ctx = fakeContext('suspended');
    createAnnouncer({ audio: () => ctx }).play('bell');
    expect(ctx.resumed).toBe(1);
  });

  it('does not resume a context that is already running', () => {
    const ctx = fakeContext();
    createAnnouncer({ audio: () => ctx }).play('bell');
    expect(ctx.resumed).toBe(0);
  });

  it('plays SOMETHING for a cue name it does not know', () => {
    // a workspace file naming a cue this build dropped is not a reason to be
    // silent (P6)
    const ctx = fakeContext();
    expect(createAnnouncer({ audio: () => ctx }).play('airhorn')).toBe(true);
    expect(ctx.notes.length).toBeGreaterThan(0);
  });

  it('answers false, and does not throw, with no audio on the machine', () => {
    const a = createAnnouncer({ audio: () => null });
    expect(a.play('bell')).toBe(false);
  });

  it('answers false, and does not throw, when the context constructor blows up', () => {
    const onError = vi.fn();
    const a = createAnnouncer({
      audio: () => {
        throw new Error('AudioContext blocked by policy');
      },
      onError,
    });
    expect(a.play('bell')).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it('says a sentence', () => {
    const said: string[] = [];
    const a = createAnnouncer({
      speak: (t) => {
        said.push(t);
        return true;
      },
    });
    expect(a.say('Trading app needs permission')).toBe(true);
    expect(said).toEqual(['Trading app needs permission']);
  });

  it('says nothing when there is nothing to say', () => {
    const speak = vi.fn(() => true);
    expect(createAnnouncer({ speak }).say('')).toBe(false);
    expect(speak).not.toHaveBeenCalled();
  });

  it('a voice that throws costs the sentence and nothing else', () => {
    const a = createAnnouncer({
      speak: () => {
        throw new Error('no voices installed');
      },
    });
    expect(a.say('hello')).toBe(false);
  });
});

describe('the real voice refuses a backlog', () => {
  // `browserSpeech` is the only non-trivial logic here that the injected fakes
  // above never touch, and the claim it carries is load-bearing: without the
  // `pending` check, eight events while the user is at lunch queue up and are
  // read out, in order, to an empty room, minutes after they were true.
  const install = (synth: Partial<SpeechSynthesis>): { spoken: string[] } => {
    const spoken: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g.speechSynthesis = { pending: false, speaking: false, ...synth };
    g.SpeechSynthesisUtterance = class {
      constructor(public text: string) {
        spoken.push(text);
      }
    };
    return { spoken };
  };
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.speechSynthesis;
    delete g.SpeechSynthesisUtterance;
  });

  it('speaks when nothing is waiting', () => {
    const speak = vi.fn();
    const { spoken } = install({ speak });
    expect(browserSpeech()('Trading app is done')).toBe(true);
    expect(spoken).toEqual(['Trading app is done']);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('refuses while something is already WAITING behind the current one', () => {
    const speak = vi.fn();
    install({ speak, pending: true });
    expect(browserSpeech()('Trading app is done')).toBe(false);
    expect(speak).not.toHaveBeenCalled();
  });

  it('answers false on a machine with no voice at all', () => {
    // Linux without speech-dispatcher. `false` is what sends main its beep.
    expect(browserSpeech()('anything')).toBe(false);
  });
});

describe('subscribing to main', () => {
  it('plays and speaks what main pushes', () => {
    const played: string[] = [];
    const said: string[] = [];
    let onPlay: ((c: { sound: string }) => void) | null = null;
    let onSpeak: ((c: { text: string }) => void) | null = null;
    const off = installAnnouncer(
      {
        onPlay: (cb) => {
          onPlay = cb;
          return () => {};
        },
        onSpeak: (cb) => {
          onSpeak = cb;
          return () => {};
        },
      },
      {
        play: (id) => (played.push(id), true),
        say: (t) => (said.push(t), true),
      }
    );
    onPlay!({ sound: 'knock' });
    onSpeak!({ text: 'Trading app is done' });
    expect(played).toEqual(['knock']);
    expect(said).toEqual(['Trading app is done']);
    expect(() => off()).not.toThrow();
  });

  it('unsubscribes both channels', () => {
    const offs = { play: 0, speak: 0 };
    const off = installAnnouncer(
      {
        onPlay: () => () => offs.play++,
        onSpeak: () => () => offs.speak++,
      },
      { play: () => true, say: () => true }
    );
    off();
    expect(offs).toEqual({ play: 1, speak: 1 });
  });

  it('tells main when it could NOT play — the other half of fail-open', () => {
    // Main sent this fire-and-forget and has already stood its own beep down.
    // Without this report the event is silent while every log line says
    // "taken", which is the exact outcome §5.9 promises cannot happen.
    const failed: string[] = [];
    let onPlay: ((c: { sound: string }) => void) | null = null;
    let onSpeak: ((c: { text: string }) => void) | null = null;
    installAnnouncer(
      {
        onPlay: (cb) => {
          onPlay = cb;
          return () => {};
        },
        onSpeak: (cb) => {
          onSpeak = cb;
          return () => {};
        },
        failed: (c) => {
          failed.push(c);
          return Promise.resolve();
        },
      },
      { play: () => false, say: () => false }
    );
    onPlay!({ sound: 'knock' });
    onSpeak!({ text: 'anything' });
    expect(failed).toEqual(['sound', 'speak']);
  });

  it('says nothing to main when it DID play', () => {
    const failed: string[] = [];
    let onPlay: ((c: { sound: string }) => void) | null = null;
    installAnnouncer(
      {
        onPlay: (cb) => {
          onPlay = cb;
          return () => {};
        },
        failed: (c) => {
          failed.push(c);
          return Promise.resolve();
        },
      },
      { play: () => true, say: () => true }
    );
    onPlay!({ sound: 'knock' });
    expect(failed).toEqual([]);
  });

  it('a report that rejects is not the event handler’s problem', () => {
    let onPlay: ((c: { sound: string }) => void) | null = null;
    installAnnouncer(
      {
        onPlay: (cb) => {
          onPlay = cb;
          return () => {};
        },
        failed: () => Promise.reject(new Error('main is gone')),
      },
      { play: () => false, say: () => false }
    );
    expect(() => onPlay!({ sound: 'knock' })).not.toThrow();
  });

  it('an older preload with no `failed` still plays, it just cannot report', () => {
    let onPlay: ((c: { sound: string }) => void) | null = null;
    const played: string[] = [];
    installAnnouncer(
      {
        onPlay: (cb) => {
          onPlay = cb;
          return () => {};
        },
      },
      { play: (id) => (played.push(id), false), say: () => false }
    );
    expect(() => onPlay!({ sound: 'knock' })).not.toThrow();
    expect(played).toEqual(['knock']);
  });

  it('does nothing at all without a sounds namespace', () => {
    // a renderer unit harness installs only the namespaces it needs, and #444
    // proved a notification nicety that throws out of a mount effect can white
    // -screen a card
    expect(() => installAnnouncer(undefined, { play: () => true, say: () => true })()).not.toThrow();
    expect(() => installAnnouncer({}, { play: () => true, say: () => true })()).not.toThrow();
  });

  it('a bridge that throws on subscribe leaves the app silent, not broken', () => {
    expect(() =>
      installAnnouncer(
        {
          onPlay: () => {
            throw new Error('preload is older than this build');
          },
        },
        { play: () => true, say: () => true }
      )
    ).not.toThrow();
  });

  it('an unsubscribe that throws is swallowed too', () => {
    const off = installAnnouncer(
      {
        onPlay: () => () => {
          throw new Error('already gone');
        },
      },
      { play: () => true, say: () => true }
    );
    expect(() => off()).not.toThrow();
  });
});

describe('muted (what keeps the e2e suite quiet)', () => {
  afterEach(() => setAudioMuted(false));

  it('schedules nothing and says nothing, but answers as though it did', () => {
    // `false` would be read as "this machine has no audio" and, on the sound
    // path, send main to its beep — the one noise a mute has to prevent
    const ctx = fakeContext();
    const speak = vi.fn(() => true);
    const a = createAnnouncer({ audio: () => ctx, speak });
    setAudioMuted(true);
    expect(a.play('bell')).toBe(true);
    expect(a.say('hello')).toBe(true);
    expect(ctx.notes).toEqual([]);
    expect(speak).not.toHaveBeenCalled();
  });

  it('covers an announcer built BEFORE the flag was set', () => {
    // a card can reach the shared announcer before App's boot effect runs;
    // module-level state is what makes that ordering not matter
    const ctx = fakeContext();
    const a = createAnnouncer({ audio: () => ctx });
    setAudioMuted(true);
    a.play('bell');
    expect(ctx.notes).toEqual([]);
  });

  it('unmutes again', () => {
    const ctx = fakeContext();
    const a = createAnnouncer({ audio: () => ctx });
    setAudioMuted(true);
    a.play('bell');
    setAudioMuted(false);
    a.play('bell');
    expect(ctx.notes.length).toBeGreaterThan(0);
  });
});

describe('the shared announcer', () => {
  it('is one instance, because an AudioContext is a limited resource', () => {
    setSharedAnnouncer(null);
    expect(sharedAnnouncer()).toBe(sharedAnnouncer());
    setSharedAnnouncer(null);
  });

  it('can be swapped out and restored', () => {
    const fake = { play: () => true, say: () => true };
    setSharedAnnouncer(fake);
    expect(sharedAnnouncer()).toBe(fake);
    setSharedAnnouncer(null);
    expect(sharedAnnouncer()).not.toBe(fake);
    setSharedAnnouncer(null);
  });
});
