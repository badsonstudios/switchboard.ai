// The `sound` and `speak` rule actions (P2-E14-05a, §5.9) — the deciding half.
//
// `shared/sounds.ts` knows what a cue IS and what sentence to say; the renderer
// knows how to make the noise; this file knows WHICH cue this card rings, and
// what to do when the noise cannot be made. It is a drop-in on the action seam
// #421 built: no `Rule` field, no change to `ruleMatches` or `plannedActions`.
//
// ── fail-open is the whole design here, not a catch block ────────────────────
//
// §5.9's promise is that a notification channel can never cost you the event.
// Three separate things enforce it, and each covers a case the others do not:
//
//   1. Nothing in this file blocks. `sink.play` HANDS the cue to a renderer and
//      returns; it does not wait for the sound to finish, or start, or be
//      audible. An event is never held open behind an audio device.
//   2. Every call into the sink is wrapped. A sink that throws — a window torn
//      down between the check and the send — costs this action and nothing
//      else, and `RuleActionRegistry.run` would have caught it anyway; the
//      catch here exists so the FALLBACK below still runs.
//   3. A cue that could not be handed to anyone falls back to `shell.beep()`
//      (injected, so this file stays electron-free). That is the one that
//      matters to a person: with per-session sounds ON, the beep in
//      `notifier.ts` steps aside, so a silent failure here would mean an
//      attention event made no sound AT ALL. Degrading to the plain beep says
//      "something happened" even when it cannot say which session.
import type { Logger } from '../log/logger';
import { announcementFor } from '../../shared/sounds';
import type { RuleActionContext, RuleActionHandler } from './rules-engine';

/** Somewhere that can make a noise. The app's is a renderer window; a test's
 *  is an array. Both answers are synchronous and mean DISPATCHED, not HEARD —
 *  whether a speaker is plugged in is not a fact main can learn in time to do
 *  anything useful with it. */
export interface AudioSink {
  /** `false` = nobody could take this cue */
  play(soundId: string): boolean;
  /** `false` = nobody could take this sentence */
  speak(text: string): boolean;
}

export interface SoundActionsDeps {
  sink: AudioSink;
  /** the cue this card rings, read fresh per event so a change lands at once */
  soundFor: (cardId: string | null) => string;
  /** what to do when the sink took nothing — `shell.beep()` in the app */
  fallback?: () => void;
  log?: Logger;
}

type AudioChannel = 'sound' | 'speak';

export class SoundActions {
  /** channel -> was the last attempt taken? Only CHANGES are worth a warn. */
  private lastOk = new Map<AudioChannel, boolean>();

  constructor(private readonly deps: SoundActionsDeps) {}

  /** The `sound` action, ready for `registry.register`. */
  get soundHandler(): RuleActionHandler {
    return (_action, ctx) => {
      const sound = this.safe(() => this.deps.soundFor(ctx.cardId), '');
      const taken = sound ? this.safe(() => this.deps.sink.play(sound), false) : false;
      if (!taken) this.safe(() => this.deps.fallback?.(), undefined);
      // The e2e proof that a rule reached this action, and the line to grep
      // after "why did the wrong session's sound play". `sound` and `taken` are
      // separate facts for the same reason `os toast rule fired` splits
      // `shown`: one is our decision, the other is the machine's.
      this.deps.log?.info('sound rule fired', {
        sound,
        taken,
        kind: ctx.event.kind,
        cardId: ctx.cardId ?? '',
        ruleId: ctx.rule.id,
      });
      this.reportFailure('sound', taken, ctx);
    };
  }

  /** The `speak` action, ready for `registry.register`. */
  get speakHandler(): RuleActionHandler {
    return (_action, ctx) => {
      // `ctx.title` is what every other channel is already saying — the card's
      // auto task label when it has one, the session title when it does not
      // (`main/index.ts` → `titleFor`). Speaking anything else would make the
      // voice the one channel that names sessions differently.
      const text = announcementFor(ctx.title, ctx.event.kind);
      const taken = this.safe(() => this.deps.sink.speak(text), false);
      // No beep fallback: the `sound` action has usually just made one, and a
      // beep standing in for a sentence tells the user nothing the beep did not
      // already tell them.
      this.deps.log?.info('speak rule fired', {
        taken,
        kind: ctx.event.kind,
        cardId: ctx.cardId ?? '',
        ruleId: ctx.rule.id,
        // the sentence itself, because "it said the wrong thing" is the bug
        // report this feature actually gets, and the label is already in the
        // log on the toast path
        text,
      });
      this.reportFailure('speak', taken, ctx);
    };
  }

  /** Never let a dependency's throw escape an action handler. */
  private safe<T>(fn: () => T, onThrow: T): T {
    try {
      return fn();
    } catch (err) {
      this.deps.log?.warn('an audio notification threw', { error: String(err) });
      return onThrow;
    }
  }

  /**
   * One warn per CHANGE of state, not one per event.
   *
   * A closed window or a renderer that never loaded is a standing condition:
   * every attention event would write the same line, and the log a user sends
   * us about their real problem would be that line, repeated. The recovery is
   * logged too — "it started working again" is the other half of the same
   * question.
   */
  private reportFailure(channel: AudioChannel, ok: boolean, ctx: RuleActionContext): void {
    const before = this.lastOk.get(channel);
    if (before === ok) return;
    this.lastOk.set(channel, ok);
    if (ok) {
      if (before === false)
        this.deps.log?.info('audio notifications are getting through again', { channel });
      return;
    }
    this.deps.log?.warn('an audio notification had nowhere to play', {
      channel,
      kind: ctx.event.kind,
      ruleId: ctx.rule.id,
    });
  }
}
