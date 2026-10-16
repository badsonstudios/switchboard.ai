// The CLI's own slash-command list, off the stream (P2-E18-09). Read from
// neutral `commands` events since E40 item 04 (#1287): the two payloads below
// are parsed by Claude's translator (`providers/claude-events.ts`), not here.
//
// `CLAUDE_BUILTIN_COMMANDS` in `main/providers/claude.ts` is 40 hand-curated
// builtins that the file itself calls "version-volatile by nature… a
// maintenance chore". In stream mode the CLI simply tells us — S-10 probe C got
// 59 entries including this machine's own `/startup` and `/check-code`, which
// no curated list could have contained.
//
// TWO PAYLOADS CARRY IT, AND THEY DISAGREE ON FIDELITY. Both shapes are
// measured, not assumed:
//
//   system:init.slash_commands       -> array of plain NAMES (S-10 probe C)
//   system:commands_changed.commands -> array of OBJECTS with `description`,
//                                       `argumentHint`, `aliases`
//
// The object shape is read out of the shipped VS Code extension, which does
// `if (e.type==="system" && e.subtype==="commands_changed" && Array.isArray(e.commands))
//  this.latestCommands = e.commands` and then renders `.name` / `.description` /
// `.argumentHint` off each entry. Its richer list comes from the `initialize`
// control-request RESPONSE (`supportedCommands(){let{commands:e}=await
// this.initialization; return this.latestCommands ?? e}`) — we do not send an
// `initialize`, so `init` is names-only FOR US BY CONSTRUCTION, not by accident.
// Descriptions are filled back in by `commandsFromCli` from the `.claude/` scan.
//
// ---------------------------------------------------------------------------
// `system:init` IS EMITTED ONCE PER TURN, NOT ONCE PER SESSION.
//
// S-11 measured 26 inits for 25 turns, each arriving ~10-20ms AFTER a send we
// made ourselves. This store therefore REPLACES on every init. An appending
// consumer — and appending is the obvious way to write this — grows the list
// without bound over a working day. The plan file names this as one of two
// facts every item in the epic must respect; the test file pins it.
//
// A second consequence, inherent and worth knowing before it looks like a bug:
// the CLI emits NOTHING at spawn, so a brand-new stream session has no list at
// all until its first prompt. `commandsFor` returns null there and the caller
// falls back to the curated list.
// ---------------------------------------------------------------------------
import { Logger } from '../log/logger';
import { CliCommand } from '../../shared/slash-commands';
import type { EngineEvent } from './engine-events';

export class StreamCommands {
  private readonly bySession = new Map<string, CliCommand[]>();

  /** Optional so a test can construct one bare; the app always passes it. */
  constructor(private readonly log?: Logger) {}

  /**
   * Feed one engine event (#1287 — this read `system:init` /
   * `commands_changed` itself until then; the translator does now, with the
   * same parsing). Ignores everything that is not a `commands` list.
   *
   * REPLACES, never appends: an engine re-sends its whole list (Claude: on
   * every turn's init). A frame whose list was not a list never becomes an
   * event at all, so whatever we had stands — fail-open (P6), and a stale list
   * is strictly better than no list. (That skip is logged at debug where it is
   * decided, by the translator's `onSkipped`; the pump writes the line.)
   */
  ingest(sessionId: string, ev: EngineEvent): void {
    if (ev.type !== 'commands') return;
    // Logged because the symptom otherwise has none: the popup keeps working,
    // showing a list that quietly lost entries. `debug`, not `warn` — the list
    // arrives every turn.
    if (ev.dropped > 0) {
      this.log?.debug('stream command list had unusable entries', {
        sessionId,
        kept: ev.commands.length,
        offered: ev.commands.length + ev.dropped,
      });
    }
    this.bySession.set(sessionId, ev.commands.map((c) => ({ ...c })));
  }

  /**
   * What the CLI has told us, or `null` for "it has not told us yet".
   *
   * Null and empty are deliberately different, and the store does not collapse
   * them: null means nothing has arrived, empty means a list arrived and was
   * empty. What to SHOW in each case is a policy the caller owns — it is the
   * only layer that knows there is a curated list to fall back to.
   */
  commandsFor(sessionId: string): CliCommand[] | null {
    const list = this.bySession.get(sessionId);
    return list ? list.map((c) => ({ ...c })) : null;
  }

  /**
   * The session is gone; so is its list. Called wherever a live session is
   * dropped — closing the card, and restarting it, which is the one that
   * actually churns ids.
   */
  forgetSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
