// Where a cue goes (P2-E14-05a).
//
// Small file, three promises worth pinning: exactly ONE window is asked, a
// window that cannot take it says so (which is what makes the beep fallback
// fire), and MUTED is not the same thing as broken — it is the seam that lets
// the e2e suite prove the whole chain on the machine its owner is working at,
// without a sound coming out of the speakers.
import { describe, it, expect } from 'vitest';
import { createRendererAudioSink } from './audio-sink';
import { AUDIO_PLAY_CHANNEL, AUDIO_SPEAK_CHANNEL } from '../../shared/sounds';

interface Sent {
  win: string;
  channel: string;
  payload: unknown;
}

function win(name: string, destroyed = false) {
  return { name, isDestroyed: () => destroyed };
}

function harness(
  windows: Array<{ name: string; isDestroyed: () => boolean }>,
  muted = false
): { sink: ReturnType<typeof createRendererAudioSink>; sent: Sent[] } {
  const sent: Sent[] = [];
  const sink = createRendererAudioSink<{ name: string; isDestroyed: () => boolean }>({
    windows: () => windows,
    send: (w, channel, payload) => sent.push({ win: w.name, channel, payload }),
    muted,
  });
  return { sink, sent };
}

describe('picking a speaker', () => {
  it('sends the cue to the first live window, on the agreed channel', () => {
    const h = harness([win('main')]);
    expect(h.sink.play('bell')).toBe(true);
    expect(h.sent).toEqual([
      { win: 'main', channel: AUDIO_PLAY_CHANNEL, payload: { sound: 'bell' } },
    ]);
  });

  it('speaks on its own channel with the sentence main built', () => {
    const h = harness([win('main')]);
    expect(h.sink.speak('Trading app needs permission')).toBe(true);
    expect(h.sent[0]).toEqual({
      win: 'main',
      channel: AUDIO_SPEAK_CHANNEL,
      payload: { text: 'Trading app needs permission' },
    });
  });

  it('asks ONE window, never all of them', () => {
    // broadcasting would play the same cue once per open window — a popped-out
    // card (E8) would double every sound the moment it was torn off
    const h = harness([win('main'), win('second'), win('third')]);
    h.sink.play('chime');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].win).toBe('main');
  });

  it('skips a destroyed window for the next live one', () => {
    const h = harness([win('main', true), win('second')]);
    expect(h.sink.play('chime')).toBe(true);
    expect(h.sent[0].win).toBe('second');
  });

  it('skips a window that THROWS when asked whether it is alive', () => {
    const angry = {
      name: 'angry',
      isDestroyed: () => {
        throw new Error('Object has been destroyed');
      },
    };
    const h = harness([angry, win('second')]);
    expect(h.sink.play('chime')).toBe(true);
    expect(h.sent[0].win).toBe('second');
  });

  it('re-reads the window list per cue, so a relaunched window is found', () => {
    const list = [win('main', true)];
    const sent: Sent[] = [];
    const sink = createRendererAudioSink<{ name: string; isDestroyed: () => boolean }>({
      windows: () => list,
      send: (w, channel, payload) => sent.push({ win: w.name, channel, payload }),
    });
    expect(sink.play('chime')).toBe(false);
    list[0] = win('main');
    expect(sink.play('chime')).toBe(true);
  });
});

describe('nobody to play it (the case the beep fallback exists for)', () => {
  it('answers false with no windows at all', () => {
    const h = harness([]);
    expect(h.sink.play('chime')).toBe(false);
    expect(h.sink.speak('anything')).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('answers false when every window is destroyed', () => {
    const h = harness([win('main', true), win('second', true)]);
    expect(h.sink.play('chime')).toBe(false);
  });

  it('tolerates a list with holes in it', () => {
    const sent: Sent[] = [];
    const sink = createRendererAudioSink<{ name: string; isDestroyed: () => boolean }>({
      windows: () => [null, undefined, win('main')],
      send: (w, channel, payload) => sent.push({ win: w.name, channel, payload }),
    });
    expect(sink.play('chime')).toBe(true);
    expect(sent[0].win).toBe('main');
  });
});

describe('muted (the e2e seam)', () => {
  it('sends nothing but reports TAKEN', () => {
    // `false` would send `SoundActions` to `shell.beep()`, which is the one
    // noise a mute switch has to prevent
    const h = harness([win('main')], true);
    expect(h.sink.play('chime')).toBe(true);
    expect(h.sink.speak('hello')).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it('stays quiet even with no window, so a muted run never beeps either', () => {
    const h = harness([], true);
    expect(h.sink.play('chime')).toBe(true);
    expect(h.sent).toEqual([]);
  });
});
