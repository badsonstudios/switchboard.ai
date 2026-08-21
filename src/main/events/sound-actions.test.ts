// The `sound` and `speak` actions (P2-E14-05a).
//
// The load-bearing property in this file is **fail-open** (§5.9, P6): an audio
// device that is missing, busy, or actively throwing must cost the cue and
// nothing else — never the event, never the toast queued behind it, and never
// silence where the user used to get a beep. Each of those is a separate test
// below, because each is a separate way to break it.
//
// Every handler call below is prefixed `void`. `RuleActionHandler` is declared
// `void | Promise<void>` for #424's HTTP handlers, so `no-floating-promises`
// cannot know that THESE two are concretely synchronous — which is exactly what
// "nothing on this path awaits the audio device" asserts further down. `void`
// says "the promise half of that union never arrives here"; it is not a
// swallowed await, and removing it would not change what any test observes.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { SoundActions, type AudioSink } from './sound-actions';
import { createMainI18n } from '../i18n';
import type { Translate } from '../../shared/i18n';
import type { RuleActionContext } from './rules-engine';
import type { FeedEvent } from './feed';

// The real translator, at the real catalog (#471): the spoken sentence is now
// composed from keys, so a fake `t` would let a missing key pass. English,
// because these assertions are about WHAT is said, not which language.
let t: Translate;
beforeAll(async () => {
  t = (await createMainI18n({ language: () => 'en' })).t;
});

const ev = (kind: FeedEvent['kind'] = 'needs-input'): FeedEvent => ({
  id: 1,
  sessionId: 'live-1',
  kind,
  at: '2026-08-13T10:00:00.000Z',
});

const ctx = (over: Partial<RuleActionContext> = {}): RuleActionContext => ({
  event: ev(),
  cardId: 'card-1',
  visibility: 'hidden',
  rule: { id: 'default:sound needs-input', event: 'needs-input', actions: [] },
  title: 'Add markdown preview',
  body: 'needs input',
  ...over,
});

function harness(
  over: {
    sink?: Partial<AudioSink>;
    soundFor?: (cardId: string | null) => string;
  } = {}
) {
  const played: string[] = [];
  const said: string[] = [];
  const logged: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const beeps = { count: 0 };
  const log = {
    debug: () => {},
    info: (msg: string, fields = {}) => logged.push({ level: 'info', msg, fields }),
    warn: (msg: string, fields = {}) => logged.push({ level: 'warn', msg, fields }),
    error: (msg: string, fields = {}) => logged.push({ level: 'error', msg, fields }),
    child: () => log,
  };
  const sink: AudioSink = {
    play: (id) => {
      played.push(id);
      return true;
    },
    speak: (t) => {
      said.push(t);
      return true;
    },
    ...over.sink,
  };
  const actions = new SoundActions({
    sink,
    soundFor: over.soundFor ?? ((cardId) => (cardId === 'card-2' ? 'bell' : 'chime')),
    fallback: () => {
      beeps.count++;
    },
    t,
    log,
  });
  const line = (msg: string) => logged.filter((l) => l.msg === msg);
  return { actions, played, said, logged, beeps, line };
}

describe('the sound action (done-when: two sessions ring distinguishably)', () => {
  it('plays the cue THIS card owns', () => {
    const h = harness();
    void h.actions.soundHandler({ type: 'sound' }, ctx());
    void h.actions.soundHandler({ type: 'sound' }, ctx({ cardId: 'card-2' }));
    expect(h.played).toEqual(['chime', 'bell']);
  });

  it('resolves the cue per EVENT, so changing it lands on the next one', () => {
    // the whole reason the action payload carries no cue name: a rule written
    // yesterday must ring whatever the card sounds like today
    let current = 'chime';
    const h = harness({ soundFor: () => current });
    void h.actions.soundHandler({ type: 'sound' }, ctx());
    current = 'knock';
    void h.actions.soundHandler({ type: 'sound' }, ctx());
    expect(h.played).toEqual(['chime', 'knock']);
  });

  it('writes the line the e2e reads, with the card and the cue on it', () => {
    const h = harness();
    void h.actions.soundHandler({ type: 'sound' }, ctx());
    expect(h.line('sound rule fired')[0].fields).toMatchObject({
      sound: 'chime',
      taken: true,
      cardId: 'card-1',
      kind: 'needs-input',
      ruleId: 'default:sound needs-input',
    });
  });

  it('does not beep when the cue was taken', () => {
    const h = harness();
    void h.actions.soundHandler({ type: 'sound' }, ctx());
    expect(h.beeps.count).toBe(0);
  });
});

describe('fail-open (§5.9: an audio failure never costs the event)', () => {
  it('a sink that takes nothing falls back to the beep', () => {
    // With per-session cues ON the notifier stops beeping, so this is the only
    // thing between "the window went away" and an attention event that makes
    // no sound at all.
    const h = harness({ sink: { play: () => false } });
    void h.actions.soundHandler({ type: 'sound' }, ctx());
    expect(h.beeps.count).toBe(1);
    expect(h.line('sound rule fired')[0].fields.taken).toBe(false);
  });

  it('a sink that THROWS does not throw out of the handler, and still beeps', () => {
    const h = harness({
      sink: {
        play: () => {
          throw new Error('audio device on fire');
        },
      },
    });
    expect(() => h.actions.soundHandler({ type: 'sound' }, ctx())).not.toThrow();
    expect(h.beeps.count).toBe(1);
    expect(h.line('an audio notification threw')).toHaveLength(1);
  });

  it('a cue RESOLVER that throws costs the cue and nothing else', () => {
    const h = harness({
      soundFor: () => {
        throw new Error('store is gone');
      },
    });
    expect(() => h.actions.soundHandler({ type: 'sound' }, ctx())).not.toThrow();
    expect(h.played).toEqual([]);
    expect(h.beeps.count).toBe(1);
  });

  it('a speak sink that throws does not throw out of the handler', () => {
    const h = harness({
      sink: {
        speak: () => {
          throw new Error('no voices installed');
        },
      },
    });
    expect(() => h.actions.speakHandler({ type: 'speak' }, ctx())).not.toThrow();
    // NOT a beep: a beep standing in for a sentence says nothing the sound
    // action has not already said
    expect(h.beeps.count).toBe(0);
  });

  it('a fallback that itself throws is still not the event\'s problem', () => {
    const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
    const actions = new SoundActions({
      sink: { play: () => false, speak: () => false },
      soundFor: () => 'chime',
      t,
      fallback: () => {
        throw new Error('shell.beep exploded');
      },
      log,
    });
    expect(() => actions.soundHandler({ type: 'sound' }, ctx())).not.toThrow();
  });

  it('runs with no logger and no fallback at all', () => {
    const actions = new SoundActions({
      sink: { play: () => false, speak: () => false },
      soundFor: () => 'chime',
      t,
    });
    expect(() => actions.soundHandler({ type: 'sound' }, ctx())).not.toThrow();
    expect(() => actions.speakHandler({ type: 'speak' }, ctx())).not.toThrow();
  });

  it('nothing on this path awaits the audio device', () => {
    // The handlers are synchronous by construction — the registry dispatches
    // rather than awaiting, and a handler that returned a promise tied to a
    // sound finishing would put the event path behind a speaker.
    const h = harness();
    expect(h.actions.soundHandler({ type: 'sound' }, ctx())).toBeUndefined();
    expect(h.actions.speakHandler({ type: 'speak' }, ctx())).toBeUndefined();
  });
});

describe('the speak action', () => {
  it('says the title and what happened, not the event body', () => {
    // `body` for a permission is a tool-call summary. Right to read on a toast,
    // wrong to have read aloud at you from another room.
    const h = harness();
    void h.actions.speakHandler(
      { type: 'speak' },
      ctx({ event: ev('needs-permission'), body: 'Bash: rm -rf /tmp/build' })
    );
    expect(h.said).toEqual(['Add markdown preview needs permission']);
  });

  it('speaks whatever title the engine resolved — that IS the label fallback', () => {
    const h = harness();
    void h.actions.speakHandler({ type: 'speak' }, ctx({ title: 'switchboard.ai' }));
    expect(h.said).toEqual(['switchboard.ai needs your input']);
  });

  it('puts the sentence in the log, because "it said the wrong thing" is the bug report', () => {
    const h = harness();
    void h.actions.speakHandler({ type: 'speak' }, ctx());
    expect(h.line('speak rule fired')[0].fields).toMatchObject({
      text: 'Add markdown preview needs your input',
      taken: true,
      cardId: 'card-1',
    });
  });
});

describe('a standing failure is logged once, not once per event', () => {
  it('warns on the way down and again on the way back up, and never between', () => {
    let ok = false;
    const h = harness({ sink: { play: () => ok } });
    for (let i = 0; i < 5; i++) void h.actions.soundHandler({ type: 'sound' }, ctx());
    expect(h.line('an audio notification had nowhere to play')).toHaveLength(1);
    ok = true;
    for (let i = 0; i < 3; i++) void h.actions.soundHandler({ type: 'sound' }, ctx());
    expect(h.line('an audio notification had nowhere to play')).toHaveLength(1);
    expect(h.line('audio notifications are getting through again')).toHaveLength(1);
    // and the per-event line is still there for every one of the eight
    expect(h.line('sound rule fired')).toHaveLength(8);
  });

  it('a first success is not announced as a recovery', () => {
    const h = harness();
    void h.actions.soundHandler({ type: 'sound' }, ctx());
    expect(h.line('audio notifications are getting through again')).toHaveLength(0);
  });

  it('the two channels count separately', () => {
    const h = harness({ sink: { speak: () => false } });
    void h.actions.soundHandler({ type: 'sound' }, ctx());
    void h.actions.speakHandler({ type: 'speak' }, ctx());
    const warns = h.line('an audio notification had nowhere to play');
    expect(warns).toHaveLength(1);
    expect(warns[0].fields.channel).toBe('speak');
  });
});

// The hole a fire-and-forget send leaves, and the thing that closes it. Main
// stands the notifier's beep down while cues are on, so a window that TAKES a
// cue and cannot play it — no audio device, an AudioContext the platform
// refused — would otherwise be silence that every log line called success.
describe('the window took it and could not play it', () => {
  it('beeps, every time, because that is the half a person hears', () => {
    const h = harness();
    h.actions.unplayable('sound');
    h.actions.unplayable('sound');
    h.actions.unplayable('sound');
    expect(h.beeps.count).toBe(3);
  });

  it('warns ONCE per channel — "no audio device" does not come and go', () => {
    const h = harness();
    for (let i = 0; i < 4; i++) h.actions.unplayable('sound');
    expect(h.line('a window took an audio notification and could not play it')).toHaveLength(1);
  });

  it('does not beep for a sentence nobody could say', () => {
    // the cue has usually just beeped; a second one adds no information
    const h = harness();
    h.actions.unplayable('speak');
    expect(h.beeps.count).toBe(0);
    expect(h.line('a window took an audio notification and could not play it')[0].fields).toEqual({
      channel: 'speak',
    });
  });

  it('counts the two channels separately', () => {
    const h = harness();
    h.actions.unplayable('sound');
    h.actions.unplayable('speak');
    expect(h.line('a window took an audio notification and could not play it')).toHaveLength(2);
  });

  it('a fallback that throws is still not anyone else problem', () => {
    const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
    const actions = new SoundActions({
      sink: { play: () => true, speak: () => true },
      soundFor: () => 'chime',
      t,
      fallback: () => {
        throw new Error('shell.beep exploded');
      },
      log,
    });
    expect(() => actions.unplayable('sound')).not.toThrow();
  });
});

describe('the registry contract it is registered under', () => {
  it('the handlers are plain RuleActionHandlers — no extra argument, no return', () => {
    const h = harness();
    const handler = h.actions.soundHandler;
    expect(typeof handler).toBe('function');
    expect(handler.length).toBe(2);
    const spy = vi.fn(handler);
    void spy({ type: 'sound' }, ctx());
    expect(spy).toHaveReturnedWith(undefined);
  });
});
