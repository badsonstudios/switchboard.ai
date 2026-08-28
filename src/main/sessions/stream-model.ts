// Which model is this session actually running? (#721, #633)
//
// ── WHY THIS STORE HAS TO EXIST ──────────────────────────────────────────────
//
// Because the CLI will not tell you any other way. Measured against 2.1.245
// (`docs/reference-implementations.md` §1.2.2, finding 3):
//
//   * `list_models` returns 5 entries and marks NONE of them as current;
//   * `initialize`'s response has no current-model field either — its keys were
//     dumped and checked.
//
// The ONLY place the running model appears is `system:init.model`. So a picker
// that wants to show a tick beside the model you are on has exactly one source,
// and it is a message that arrives unprompted — nobody can ask for it.
//
// ── AND `system:init` IS ONCE PER *TURN*, NOT ONCE PER SESSION ───────────────
//
// S-11 measured 26 inits for 25 turns. Two consequences, and the second is the
// whole reason this file is a store rather than a lookup:
//
//   1. REPLACE on every init, never append — `stream-commands.ts` does the same
//      thing for the same reason.
//   2. **A session that has run NO turn has never emitted one**, so its model is
//      genuinely unknown, and `modelFor` answers `null` rather than guessing.
//      That is not a gap to paper over: on a fresh card the honest surface says
//      "not known yet", because "default" would be a fabrication and the user
//      might well be on something else from their settings.
//
// The optimistic write (`noteSet`) is the other half: after OUR `set_model`
// succeeds we know the answer before the next turn produces one, and a picker
// whose tick only moved on the next prompt would read as a control that did not
// work. The CLI's own next `init` overwrites it either way, so the optimistic
// value is a bridge, never an authority.
import { Logger } from '../log/logger';

export class StreamModel {
  private readonly bySession = new Map<string, string>();

  /** Optional so a test can construct one bare; the app always passes it. */
  constructor(private readonly log?: Logger) {}

  /**
   * Feed one stream message. Ignores everything that is not a `system:init`
   * carrying a usable `model`.
   *
   * A non-string or empty `model` KEEPS whatever we had rather than blanking
   * it — fail-open (P6), and a stale answer beats no answer for a field whose
   * only other value is "unknown". Logged at `debug`, not `warn`, because init
   * arrives every turn and a persistently odd payload would otherwise shout all
   * day about something nobody can act on.
   */
  offer(sessionId: string, msg: Record<string, unknown>): void {
    if (msg.type !== 'system' || msg.subtype !== 'init') return;
    const model = msg.model;
    if (typeof model !== 'string' || !model.trim()) {
      this.log?.debug('stream init model ignored', {
        sessionId,
        got: model === undefined ? 'absent' : typeof model,
      });
      return;
    }
    this.bySession.set(sessionId, model);
  }

  /**
   * Record a model WE just set, before the CLI's next init confirms it.
   *
   * Only ever called after a `set_model` the CLI answered `success` to — never
   * hopefully, and never for a refusal. `set_model` was verified BY EFFECT
   * against the real CLI (the next turn's `system:init.model` agreed), so this
   * is anticipating a value we have measured to be coming, not inventing one.
   */
  noteSet(sessionId: string, model: string): void {
    if (!model.trim()) return;
    this.bySession.set(sessionId, model);
  }

  /**
   * The model this session is running, or `null` for "it has not said yet".
   *
   * NULL IS A REAL ANSWER, not a missing one, and callers must not collapse it
   * to a default — see the header. A session that has run no turn has emitted
   * no init, and that is the common case for the surface this exists for: a
   * fresh card, where opening a model picker is exactly what someone does
   * first.
   */
  modelFor(sessionId: string): string | null {
    return this.bySession.get(sessionId) ?? null;
  }

  /** The session is gone; so is its model. */
  forgetSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
