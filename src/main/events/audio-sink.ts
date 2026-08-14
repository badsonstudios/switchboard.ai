// Where a cue actually goes (P2-E14-05a): a renderer window.
//
// ── why the renderer and not a child process ─────────────────────────────────
//
// Electron's main process has no audio device and no voice; Chromium has both,
// and the renderer is where Chromium is. The alternative was a per-event child
// process — `powershell -c (New-Object Media.SoundPlayer …)` on Windows,
// `afplay` on macOS, `paplay` on Linux — which means three code paths, a
// process spawn (tens to hundreds of milliseconds) on the notification path,
// bundled .wav files, and a different set of failure modes per platform. Web
// Audio and the Web Speech API are one code path on all three, cost nothing on
// the event path, and are the platform-native route Electron actually hands us.
//
// The cost, stated plainly: **no window, no sound.** That is why
// `SoundActions` takes a fallback beep — see its header.
//
// ── which window ─────────────────────────────────────────────────────────────
//
// Exactly ONE, the first that is alive. Broadcasting would play the same cue
// once per open window, and a popped-out card (E8) would double every sound the
// moment it was torn off. A minimized window is a perfectly good speaker —
// Chromium keeps running — so "alive" here means not destroyed, not visible.
import { AUDIO_PLAY_CHANNEL, AUDIO_SPEAK_CHANNEL } from '../../shared/sounds';
import type { Logger } from '../log/logger';
import type { AudioSink } from './sound-actions';

/** The only thing this module needs to know about a window. */
export interface AudioWindow {
  isDestroyed(): boolean;
}

export interface RendererAudioSinkDeps<W extends AudioWindow> {
  /** candidate windows, most-preferred first; read fresh per cue */
  windows: () => readonly (W | null | undefined)[];
  send: (win: W, channel: string, payload: unknown) => void;
  /**
   * Make no noise, but behave as though the cue was taken (P2-E14-05a).
   *
   * For the e2e suite, which runs on the machine its owner is working at: a
   * test that really plays eight cues and speaks four sentences is a test
   * nobody can run twice. Muted still LOGS, so the specs assert the whole chain
   * — right rule, right card, right cue — and only the last inch is silent.
   *
   * `taken: true` on purpose: `false` would send `SoundActions` to its
   * `shell.beep()` fallback, which is the one noise a mute switch has to
   * prevent.
   */
  muted?: boolean;
  log?: Logger;
}

export function createRendererAudioSink<W extends AudioWindow>(
  deps: RendererAudioSinkDeps<W>
): AudioSink {
  const target = (): W | null => {
    for (const w of deps.windows()) {
      try {
        if (w && !w.isDestroyed()) return w;
      } catch {
        // a window that throws when asked whether it is dead is dead
      }
    }
    return null;
  };
  const dispatch = (channel: string, payload: unknown): boolean => {
    if (deps.muted) {
      deps.log?.debug('audio muted; not sending to a window', { channel });
      return true;
    }
    const win = target();
    if (!win) return false;
    deps.send(win, channel, payload);
    return true;
  };
  return {
    play: (sound) => dispatch(AUDIO_PLAY_CHANNEL, { sound }),
    speak: (text) => dispatch(AUDIO_SPEAK_CHANNEL, { text }),
  };
}
