// SessionManager (P1-E2-03): create/kill/restart sessions, identity registry,
// status state machine fed by hook events (ingestion point here; the live
// HookListener wires into it in P1-E2-05). Every transition is logged with
// sessionId (queryable per the E1-05 logging contract) and observable via
// subscription.
import { randomUUID } from 'crypto';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { MainContributions, SpawnRecipe } from '../extensibility/contributions';
import { Logger } from '../log/logger';
import {
  DEFAULT_TRANSPORT,
  SessionTransport,
  TransportKind,
  TransportSession,
  TransportMap,
  UnknownTransportError,
} from '../transport/transport';
import { SessionEvent, transition } from './state-machine';
import type {
  AutonomyMode,
  SessionIdentity,
  SessionRecordWire,
  StatusChange,
} from '../../shared/sessions';
import {
  removeSessionStateDir,
  sweepOrphanSessionStateDirs,
  SweepResult,
} from './session-state';
import { streamStatusEvent } from './stream-status';
import {
  interruptRequest,
  listModelsRequest,
  mcpStatusRequest,
  setModelRequest,
  userMessage,
  type PromptAttachment,
} from '../../shared/stream-protocol';
import { ControlChannel } from '../transport/control-channel';
import type { ControlVerdict } from '../../shared/control';

/**
 * Why a session's native id CHANGED. 'clear' = the CLI ran /clear and minted
 * a fresh conversation (SessionStart source:'clear'); absent = first learn or
 * an unexplained change (e.g. correcting a same-cwd mis-bind).
 */
export type NativeIdCause = 'clear';

// Defined in `shared/sessions.ts` since #590 (the rail shows it, so it crosses
// IPC); re-exported here because every main-side importer already says
// `from './session-manager'` and renaming those is churn. `StatusChange`
// followed in #618, for the same reason and by the same route — `sessions:status`
// sends it verbatim.
export type { SessionIdentity, StatusChange };

/**
 * A live session, as the manager holds it.
 *
 * The fields the renderer is TYPED to see are `SessionRecordWire`
 * (`shared/sessions.ts`), which the preload's `SessionRecordDto` also is — so
 * there is no second hand-written copy to drift (#590; #445 is what drift
 * cost). What is added below is main's own bookkeeping, deliberately left
 * undeclared to the renderer.
 *
 * Undeclared, not withheld: the handlers return this record verbatim and
 * structured clone carries the extra fields anyway (`sessions:create` even
 * re-publishes `autonomy` in its own return type). This is a contract, not a
 * privacy boundary.
 *
 * Adding a field: if the renderer needs it, it goes on `SessionRecordWire`, not
 * here. `transport-seam.test.ts` pins this record's key set against the wire
 * shape plus the named main-only keys, so either choice is explicit and a
 * forgotten one fails `tsc`.
 */
export interface SessionRecord extends SessionRecordWire {
  /** autonomy mode this session was spawned at (drives the E10-03 hold policy) */
  autonomy?: AutonomyMode;
  /** set by kill()/restart(): the coming exit is intentional, not a crash */
  killRequested?: boolean;
}

/**
 * The slice of a transport the manager needs — injectable for tests.
 *
 * @deprecated Name only. This is `SessionTransport` from `transport/transport.ts`
 * as of P2-E18-02; the PTY is no longer the only thing that satisfies it. Kept
 * as an alias because the name is load-bearing in existing call sites and
 * renaming them is churn that would obscure the one real change in this item.
 */
export type PtyLike = SessionTransport;

export interface SessionExit {
  sessionId: string;
  code: number;
  crashed: boolean;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Set<(c: StatusChange) => void>();
  private readonly exitListeners = new Set<(e: SessionExit) => void>();
  private readonly nativeIdListeners = new Set<
    (sessionId: string, nativeId: string, cause?: NativeIdCause) => void
  >();
  private readonly history: StatusChange[] = [];

  /** Every transport this host can spawn on, keyed by what a recipe may ask for. */
  private readonly transports: TransportMap;
  /**
   * The live handle per session (P2-E18-06), so a prompt can be sent after
   * spawn. Dropped in `remove()` alongside the record — a handle outliving its
   * session is a reference to a dead child nobody can reach to kill.
   */
  private readonly handles = new Map<string, TransportSession>();
  private readonly streamMessageListeners = new Set<
    (sessionId: string, msg: Record<string, unknown>) => void
  >();
  private permissionHoldSuppressor: ((sessionId: string) => boolean) | null = null;

  constructor(
    private readonly registry: ContributionRegistry<MainContributions>,
    ptys: SessionTransport,
    private readonly log: Logger,
    private readonly stateDir: string,
    /**
     * Transports beyond the PTY (P2-E18-02). Empty today — `StreamService`
     * registers here in P2-E18-03. Optional and last so every existing call
     * site is unchanged; the PTY stays positional because it is the default
     * and every caller already passes it.
     */
    extraTransports?: TransportMap
  ) {
    this.transports = { pty: ptys, ...extraTransports };
    // The outbound control channel (#721). Built HERE rather than in
    // `main/index.ts` because its port is exactly two methods this class
    // already owns — `sendToTransport` (which answers false for a PTY, and is
    // therefore the transport gate) and `onStreamMessage` (the app-wide typed
    // fan-out). Wiring it outside would mean handing both out to a third party
    // just to hand the result back.
    this.control = new ControlChannel({
      send: (id, msg) => this.sendToTransport(id, msg),
      onMessage: (l) => this.onStreamMessage(l),
    });
  }

  /**
   * Ask the CLI something over the stream-json control channel (#721).
   *
   * Exposed so `sessions/ipc.ts` can reach it and so teardown can call
   * `forgetSession`. Consumers should prefer the named verbs below.
   */
  readonly control: ControlChannel;

  /**
   * The models this session will accept (#721, #633).
   *
   * `list_models` rather than `initialize`: the same array, without the ~28 KB
   * of commands, agents and account data around it.
   *
   * NOTE WHAT THIS CANNOT TELL YOU: nothing in the payload marks the CURRENT
   * model, and `initialize` has no field for it either (both measured). The
   * running model appears only on `system:init.model`, once per TURN — so a
   * picker must treat "which one is selected" as a separate and possibly
   * unknown question rather than reading it off this list.
   */
  async listModels(id: string): Promise<ControlVerdict> {
    const gone = this.controlPrecheck(id);
    return gone ?? this.control.request(id, listModelsRequest);
  }

  /**
   * The MCP servers this session really has (#729).
   *
   * THE ONLY SOURCE. `main/mcp/config.ts` reaches three of the CLI's eight
   * runtime scopes, and account connectors and plugin-supplied servers live in
   * no file at all — 3 shown against 16 on the machine that reported #723.
   *
   * The answer SETTLES rather than arriving complete: a freshly spawned session
   * reports `pending` with no tool list for ~5 seconds before it reports
   * `connected` (measured, `spike/probes/721/probe-mcp-settle.mjs`). This method
   * is a single round trip and does not hide that — the caller asks again. See
   * `mcpStatusRequest`.
   */
  async mcpStatus(id: string): Promise<ControlVerdict> {
    const gone = this.controlPrecheck(id);
    return gone ?? this.control.request(id, mcpStatusRequest);
  }

  /**
   * `session-gone` for a session this manager no longer holds — or `null` to
   * carry on.
   *
   * WITHOUT THIS, A DEAD SESSION READS AS A TERMINAL ONE. `sendToTransport`
   * answers `false` for both a PTY and a missing handle, and the channel turns
   * a false into `not-stream` — whose documented meaning is "this session has
   * no control channel, hand the user to the CLI's own picker in their
   * terminal". A stale live id (the restart path drops the handle in `remove`
   * while a renderer may still hold the old one) would therefore tell the user
   * to go and use a terminal that has nothing to do with their problem.
   *
   * The two states are genuinely different and only this class can tell them
   * apart, which is why the check is here rather than in the channel.
   */
  private controlPrecheck(id: string): ControlVerdict | null {
    if (this.handles.has(id)) return null;
    return { ok: false, reason: 'session-gone', message: 'the session has stopped' };
  }

  /**
   * Switch this session's model, mid-session, with no restart (#721, #633).
   *
   * Verified BY EFFECT rather than by its acknowledgement: after `set_model`,
   * the next turn's `system:init.model`, the assistant message's
   * `message.model` and `result.modelUsage` all three reported the new model.
   *
   * An empty or non-string `model` is refused before the wire — see
   * `setModelRequest`, and the measurement that forced it.
   */
  async setModel(id: string, model: unknown): Promise<ControlVerdict> {
    const gone = this.controlPrecheck(id);
    if (gone) return gone;
    const verdict = await this.control.request(id, (requestId) =>
      setModelRequest(requestId, model)
    );
    if (verdict.ok) this.log.info('model changed', { sessionId: id });
    return verdict;
  }

  /**
   * Resolve the transport a recipe asked for, or throw.
   *
   * Never falls back to the PTY — see `UnknownTransportError` for why a silent
   * fallback is the expensive failure mode here.
   */
  private resolveTransport(kind: TransportKind, providerId: string): SessionTransport {
    const t = this.transports[kind];
    if (!t) {
      throw new UnknownTransportError(
        kind,
        providerId,
        Object.keys(this.transports).filter((k) => this.transports[k as TransportKind])
      );
    }
    return t;
  }

  /**
   * Give back everything a start took out for an id that will never be a
   * session (#290 for the directory, #470 for the token).
   *
   * "No orphan record" was only ever true of the MAP. On disk the state
   * directory is already there — `settingsFor` writes the token into it and
   * `buildSpawn` writes `settings.json` — and in memory the hook token is
   * already in `HookListener`'s map. No exit and no `remove()` will ever run
   * for this id, so this is the single moment either can be taken back:
   * without it a failed start is a permanent in-memory leak plus a directory
   * the startup sweep does not reach for 24 h.
   *
   * Both halves are best-effort and neither may throw: this runs on the way to
   * re-throwing the REAL error, and a cleanup that threw would replace it with
   * a housekeeping failure that tells the caller nothing about why the session
   * did not start (P6, fail-open).
   */
  private abandonStart(id: string, releaseSettingsFor?: (sessionId: string) => void): void {
    removeSessionStateDir(this.stateDir, id, this.log);
    try {
      releaseSettingsFor?.(id);
    } catch (err) {
      this.log.warn('could not release session settings after a failed start', {
        sessionId: id,
        error: String(err),
      });
    }
  }

  create(
    identity: SessionIdentity,
    opts?: {
      resumeSessionId?: string;
      autonomy?: AutonomyMode;
      settings?: Record<string, unknown>;
      /** Which transport to ASK the adapter for (P2-E18-08a). The adapter
       *  answers in the recipe; a provider that cannot speak it returns a PTY
       *  recipe and we honour that rather than forcing it. */
      transport?: TransportKind;
      /**
       * Settings that need the session id before spawn (hook wiring: the
       * HookListener registers a token for the id and returns the injectable
       * config). Merged over `settings`.
       */
      settingsFor?: (sessionId: string) => Record<string, unknown>;
      /**
       * Undo of `settingsFor` (#470). `settingsFor` REGISTERS state against the
       * id before there is a process — a hook token in `HookListener`'s map —
       * and this is the only way `create` can give it back, because the map is
       * not ours to reach. Supplied by whoever supplied `settingsFor` — the
       * pair always travels together — and called on every path where `create`
       * throws from the moment `settingsFor` is ENTERED, `settingsFor` itself
       * included: `registerSession` puts the token in the map before it writes
       * the file, so a throw in between is exactly the case that needs it.
       * Never called once there is a record. Idempotent, and fail-open.
       */
      releaseSettingsFor?: (sessionId: string) => void;
    }
  ): SessionRecord {
    const adapter = this.registry.resolve('provider-adapter', identity.providerId);
    if (!adapter) throw new Error(`no provider adapter "${identity.providerId}"`);
    const id = randomUUID();
    // FROM HERE the id owns state — a hook token the moment `settingsFor` runs,
    // a directory with a `settings.json` in it the moment `buildSpawn` does —
    // and there will never be an exit or a `remove()` for it if this throws.
    // Every throw below therefore goes through `abandonStart`, which is the one
    // moment either can be taken back.
    let recipe: SpawnRecipe;
    let kind: TransportKind;
    let transport: SessionTransport;
    try {
      const settings = { ...opts?.settings, ...opts?.settingsFor?.(id) };
      recipe = adapter.buildSpawn({
        cwd: identity.folder,
        sessionId: id,
        stateDir: this.stateDir,
        resumeSessionId: opts?.resumeSessionId,
        autonomy: opts?.autonomy,
        settings: Object.keys(settings).length > 0 ? settings : undefined,
        transport: opts?.transport,
      });
      // Resolved BEFORE the record exists, so an adapter asking for a transport
      // we do not have leaves no RECORD behind — same contract as the "no
      // provider adapter" throw above. It used to say "nothing behind", which
      // stopped being true when #290 gave the id a directory: by this line
      // `buildSpawn` has already written `settings.json` into it and
      // `settingsFor` has already registered a token, so this throw strands
      // exactly what the failed spawn a few lines below strands (#470).
      kind = recipe.transport ?? DEFAULT_TRANSPORT;
      transport = this.resolveTransport(kind, identity.providerId);
    } catch (err) {
      this.abandonStart(id, opts?.releaseSettingsFor);
      throw err;
    }
    const record: SessionRecord = {
      id,
      identity,
      status: 'starting',
      createdAt: new Date().toISOString(),
      exitCode: null,
      autonomy: opts?.autonomy,
      transport: kind,
    };
    let proc;
    try {
      proc = transport.spawn({ id, command: recipe.command, args: recipe.args, cwd: identity.folder, env: recipe.env });
    } catch (err) {
      this.log.error('session spawn failed', { sessionId: id, folder: identity.folder, transport: kind, error: String(err) });
      this.abandonStart(id, opts?.releaseSettingsFor);
      throw err; // no orphan record: it was never added
    }
    this.sessions.set(id, record);
    this.handles.set(id, proc);
    record.pid = proc.pid;

    // Stream mode's lifecycle wiring (P2-E18-05). Two things happen here that
    // have no PTY equivalent, and both rest on the same measurement: the CLI
    // emits NOTHING between spawn and our first prompt (S-11's log).
    if (proc.onMessage) {
      // 1. Readiness is the spawn, because nothing else will ever announce it.
      //
      //    Applied SYNCHRONOUSLY, before the record is returned. It used to be
      //    deferred by `setImmediate` so `create()` would return first — and
      //    that quietly broke the renderer (#153 follow-up): the renderer
      //    learns a session's id from the IPC RESPONSE, which is far slower
      //    than a tick, so the `starting -> idle` push fired before it knew the
      //    session existed and was filtered out. `cardOfLive` is not populated
      //    until `create()` returns either, so the push had no cardId to route
      //    by. The card then sat on `starting` for ever and grew a "Claude is
      //    showing a start-up dialog" bar at 8s.
      //
      //    PTY sessions never showed this: their first status change comes from
      //    a hook seconds later, by which time everyone is subscribed. Stream
      //    readiness is IMMEDIATE, and immediate is exactly what a
      //    subscribe-then-push design cannot deliver.
      //
      //    Doing it here is safe: the record is in the map and `pid` is set, so
      //    a listener that calls `get(id)` sees a complete session. And the
      //    returned copy now carries the true status, which is what the
      //    renderer actually reads.
      this.apply(id, { kind: 'transport-ready' });
      // 2. The messages themselves drive status from here, and are fanned out
      //    to whoever else needs them (P2-E18-07's permission router).
      proc.onMessage((m) => {
        // The stream carries the resume identity itself: `system:init` arrives
        // once per turn with the conversation's `session_id` (E18-05's
        // done-when, closed without this half — #404). Learned HERE so stream
        // mode never depends on the hook listener E18-15 deletes. Hooks DO
        // fire under `--input-format stream-json` (measured 2026-08-10,
        // claude 2.1.226), so today this is a second, idempotent writer of
        // the same id; the day the hooks fall silent it is the only one.
        // An id CHANGE mid-session means the CLI minted a new conversation —
        // the same ruling `stream-feed.ts` applies to reset the Feed — and
        // the watcher needs it tagged 'clear' to rebind with the cleared
        // marker. (The hook writer is STRICTER — it tags only
        // `SessionStart source:'clear'` — and the first writer to land wins
        // the cause; the two only diverge for a non-clear id change no CLI
        // has been seen to make, and the hook writer retires with E18-15.)
        // A resume is not a change: the record's id starts undefined
        // (create() never seeds it), so a resumed session's first init lands
        // untagged, exactly like the hook path's. `&& m.session_id` also
        // rejects the empty string, as both sibling consumers do — learning
        // '' would falsely tag the first REAL id as a 'clear'.
        if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string' && m.session_id) {
          const prior = record.nativeSessionId;
          this.setNativeSessionId(
            id,
            m.session_id,
            prior !== undefined && prior !== m.session_id ? 'clear' : undefined
          );
        }
        const ev = streamStatusEvent(m);
        if (ev && !this.holdSuppressed(id, ev)) this.apply(id, ev);
        for (const l of this.streamMessageListeners) {
          try {
            l(id, m);
          } catch (err) {
            // a broken subscriber must never take the pump down (P6)
            this.log.error('stream message listener threw', { sessionId: id, error: String(err) });
          }
        }
      });
    }
    proc.onExit((code) => {
      record.exitCode = code;
      // intentional kills are wind-downs, not crashes (ConPTY termination
      // reports nonzero codes)
      const crashed = !record.killRequested && code !== 0;
      this.apply(id, { kind: 'exit', code: record.killRequested ? 0 : code });
      for (const l of this.exitListeners) {
        try {
          l({ sessionId: id, code, crashed });
        } catch (err) {
          this.log.error('exit listener threw', { sessionId: id, error: String(err) });
        }
      }
      // The CLI is gone, so its `settings.json` and the directory holding it
      // are dead weight (#290). This is the SELF-EXIT half of the lifecycle:
      // a session that ends on its own and is never touched again reaches no
      // card-level teardown at all, so anything not taken here would live for
      // the rest of the install. The record and the binding deliberately stay
      // (#187) — the corpse is still on screen; only its disk state goes.
      //
      // LAST, after the listeners: this is housekeeping and it must not sit
      // between a process dying and the UI being told. Its own failure is a
      // logged nuisance and cannot reach a subscriber either way.
      removeSessionStateDir(this.stateDir, id, this.log);
    });
    this.log.info('session created', { sessionId: id, folder: identity.folder, pid: proc.pid, provider: identity.providerId });
    return { ...record };
  }

  kill(id: string): void {
    const r = this.sessions.get(id);
    if (!r) {
      this.noSuchSession('kill', id);
      return;
    }
    r.killRequested = true;
    // routed to the transport that SPAWNED it, not the default — a stream
    // session killed through the PTY service would simply not die
    this.resolveTransport(r.transport, r.identity.providerId).remove(id);
    this.log.info('session killed', { sessionId: id, transport: r.transport });
  }

  /**
   * Drop a session record entirely (card closed) AND tear its process down.
   *
   * The teardown moved in here in P2-E18-02. It used to live in
   * `sessions/ipc.ts`, which called `ptys.remove(id)` directly — fine while the
   * PTY was the only transport, and a process leak the moment it is not: a
   * stream session removed from the PTY service is a no-op on a service that
   * never had it, and nobody would notice until the child count grew. The
   * manager is the only thing that knows which transport spawned a session, so
   * it is the only thing that can tear one down correctly.
   */
  remove(id: string): void {
    const r = this.sessions.get(id);
    if (!r) return;
    r.killRequested = true;
    // The record is deleted BEFORE the teardown, deliberately, preserving the
    // order the IPC layer used: the exit lands on the transport's onExit, and
    // apply() drops events for sessions it no longer knows. (NOT synchronously,
    // as this comment used to claim — both transports' remove() end at kill(),
    // a signal, so the exit arrives on a later turn of the loop, and for an
    // already-dead process it arrived before this call. The ordering argument
    // below holds in every one of those cases, which is why it survived the
    // correction in #271.)
    // Reverse these two and closing a card pushes a starting->exited transition
    // into history and notifies every status listener about a session the user
    // just closed. (The exit LISTENERS fire either way — they live in the
    // onExit closure and never consult the map. Pinned by a test, because the
    // first version of that test asserted the wrong one of the two.)
    this.sessions.delete(id);
    this.handles.delete(id);
    try {
      // not resolveTransport(): a teardown that THROWS leaves the card
      // half-closed, and fail-open (P6) outranks loudness on this path
      this.transports[r.transport]?.remove(id);
    } catch {
      /* already gone */
    }
    // …and its state directory goes with it (#290), AFTER the teardown above
    // has asked the transport to kill: the file we are deleting is the one the
    // CLI was launched with, so the kill goes out first on the one path where
    // the process may still be alive for a beat. It is idempotent with the
    // delete in `onExit` — whichever lands second finds nothing and says
    // nothing — and both are needed: this one covers a card closed on a corpse
    // (whose exit fired long ago) and a transport that never reports one.
    removeSessionStateDir(this.stateDir, id, this.log);
    this.log.info('session removed', { sessionId: id, transport: r.transport });
  }

  /**
   * Drop the state directories of sessions from PREVIOUS runs (#290).
   *
   * Bootstrap-only, and the caller's placement is what makes it safe — see
   * `sweepOrphanSessionStateDirs`, which holds the full argument. It lives on
   * the manager because the manager is what owns `stateDir`: `create()` hands
   * it to `buildSpawn`, which is what makes these directories in the first
   * place.
   *
   * Two things still leak a directory past the deletes above — an app quit
   * with sessions running (the kills go out, the exits do not come back) and a
   * crash or force-quit — so this is not belt-and-braces for a closed hole; it
   * is the only owner either of them has.
   */
  sweepOrphanStateDirs(opts?: { minAgeMs?: number; budgetMs?: number }): SweepResult {
    return sweepOrphanSessionStateDirs(this.stateDir, {
      log: this.log,
      ...opts,
      // AFTER the spread, deliberately. Empty at the bootstrap call site, and
      // passed anyway: "a live session's directory is not a candidate" should
      // be true because the sweep was TOLD, not because of where today's only
      // caller happens to sit — and a caller must not be able to switch it off
      // by handing in a `keep` of its own. `opts`' type does not offer one;
      // this makes that a property of the code rather than of the types.
      keep: new Set(this.sessions.keys()),
    });
  }

  // `restart()` USED TO LIVE HERE. Deleted in P2-E15-01: it was a second
  // session-start path with none of the provider's say in it — no hook
  // settings, and `resumeSessionId` passed straight through with no
  // `canResume` check, which is exactly the stale-id spawn crash the resume
  // capability exists to prevent. Nothing outside its own test called it (the
  // UI restarts via `sessions:dropLive` then `sessions:create`, which goes
  // through `planSessionStart`), so it was dead code encoding a wrong
  // assumption — the worst kind to leave next to the thing it contradicts.

  /**
   * Submit a prompt on the session's own transport (P2-E18-06).
   *
   * Returns false when this session's transport does not take typed messages —
   * i.e. the PTY, which needs `renderer/lib/composer.ts`'s bracketed paste and
   * delayed CR instead. The caller then falls back to that route; the renderer
   * gains that branch in P2-E18-08, when it first learns which transport a
   * session is on.
   *
   * The text goes through UNTOUCHED. Newlines, backticks and a leading `/` are
   * just characters: `JSON.stringify` escapes the newline so it can never be
   * read as a frame boundary — the property the PTY path had to fake.
   *
   * `images` (P2-E10-09) ride the same frame as inline base64 blocks, which is
   * what the VS Code extension does — no temp file, no `@path`, no flag. They
   * are ONLY deliverable here: a PTY takes keystrokes, so a session on that
   * transport returns false for the whole submission rather than quietly
   * sending the text and dropping the picture the user attached to it.
   */
  submitPrompt(id: string, text: string, attachments: readonly PromptAttachment[] = []): boolean {
    const handle = this.handles.get(id);
    if (!handle?.send) return false;
    handle.send(userMessage(text, attachments));
    // We know the turn began because WE started it — no round trip, unlike the
    // PTY path waiting on a UserPromptSubmit hook.
    this.apply(id, { kind: 'prompt-sent' });
    return true;
  }

  /**
   * Every typed message from every stream session (P2-E18-07).
   *
   * The manager is the only thing that holds the handles, so it is the only
   * place a fan-out can live. Consumers filter by what they care about: the
   * permission router takes `control_request` (P2-E18-07), the slash-command
   * store takes `system:init` and `system:commands_changed` (P2-E18-09).
   *
   * Subscribe once per consumer. Each listener is wrapped in its own try/catch
   * at the call site, so sharing one is sharing a blast radius.
   */
  onStreamMessage(l: (sessionId: string, msg: Record<string, unknown>) => void): () => void {
    this.streamMessageListeners.add(l);
    return () => this.streamMessageListeners.delete(l);
  }

  /**
   * Ask the CLI to interrupt the running turn (#154).
   *
   * Returns false when this session has no typed-message transport — the PTY,
   * whose interrupt is an Esc keystroke and a genuinely different operation.
   * The caller falls back, which keeps the renderer transport-ignorant in the
   * same way `submitPrompt` does.
   */
  interrupt(id: string): boolean {
    const handle = this.handles.get(id);
    if (!handle?.send) return false;
    handle.send(interruptRequest(randomUUID()));
    this.log.info('interrupt requested', { sessionId: id });
    return true;
  }

  /** Send a raw protocol message (control responses — P2-E18-07). */
  sendToTransport(id: string, msg: unknown): boolean {
    const handle = this.handles.get(id);
    if (!handle?.send) return false;
    handle.send(msg);
    return true;
  }

  /**
   * Teach the stream pump which sessions answer their own gated calls (#319).
   *
   * "Allow all (this session)" promises no hold, no needs-permission event and
   * no beep — `HookListener.setAllowAll`'s docblock has said so since P2 — and
   * Direct mode broke every part of it. `streamStatusEvent` maps a
   * `can_use_tool` to `permission-held`, which lands here, and `apply` fans it
   * out to `onStatusChange` → `feed.ingest` → ATTENTION → the Notifier's
   * `shell.beep()` and taskbar flash, plus an Events row. Per gated call. For a
   * session the user explicitly told us to stop asking about.
   *
   * IT HAS TO BE HERE, and that is the whole design decision. The obvious home
   * is `StreamPermissions.offer` — where the allow-all verdict is actually
   * given — but the status is applied on the line ABOVE the fan-out that
   * reaches it, so by the time the router sees the message the beep has already
   * happened. The only place that can suppress a hold is the place that applies
   * it.
   *
   * A predicate rather than the router itself, matching `StreamPermissions`'
   * own `ApplyStatus`: this asks one question and must not be able to answer
   * any others. A setter rather than a constructor argument because the two
   * collaborators are cyclic — the router is built with `manager.apply` — and a
   * setter is the honest shape of that, not a workaround for it.
   *
   * SUPPRESSES `permission-held` AND NOTHING ELSE. Every other stream event
   * from an allow-all session is exactly as meaningful as before.
   */
  setPermissionHoldSuppressor(fn: (sessionId: string) => boolean): void {
    this.permissionHoldSuppressor = fn;
  }

  /** Should this event be dropped rather than applied? Only ever true for a
   *  `permission-held` from an allow-all session — and never when the
   *  predicate throws: "I can't tell" must fall back to the honest status, not
   *  to silence (a suppressed hold nobody answers is a card stuck on
   *  `working` while the CLI waits). */
  private holdSuppressed(id: string, ev: SessionEvent): boolean {
    if (ev.kind !== 'permission-held' || !this.permissionHoldSuppressor) return false;
    let suppress = false;
    try {
      suppress = this.permissionHoldSuppressor(id) === true;
    } catch (err) {
      this.log.error('permission-hold suppressor threw', { sessionId: id, error: String(err) });
      return false;
    }
    if (suppress) {
      this.log.debug('permission-held suppressed: allow-all session', { sessionId: id });
    }
    return suppress;
  }

  /** Hook/permission/user events feed the state machine here. */
  apply(id: string, ev: SessionEvent): void {
    const r = this.sessions.get(id);
    if (!r) return; // late events for removed sessions are dropped, not fatal
    const result = transition(r.status, ev);
    if (result.note) this.log.debug('session event note', { sessionId: id, note: result.note });
    if (!result.changed) return;
    const change: StatusChange = {
      sessionId: id,
      from: r.status,
      to: result.status,
      cause: describeCause(ev),
      at: new Date().toISOString(),
    };
    r.status = result.status;
    this.history.push(change);
    if (this.history.length > 1000) this.history.splice(0, this.history.length - 1000);
    this.log.info('session status', { sessionId: id, from: change.from, to: change.to, cause: change.cause });
    for (const l of this.listeners) {
      try {
        l(change);
      } catch (err) {
        // a broken subscriber must never take the session core down (P6)
        this.log.error('status listener threw', { sessionId: id, error: String(err) });
      }
    }
  }

  setNativeSessionId(id: string, nativeId: string, cause?: NativeIdCause): void {
    const r = this.sessions.get(id);
    if (!r || r.nativeSessionId === nativeId) return;
    r.nativeSessionId = nativeId;
    for (const l of this.nativeIdListeners) {
      try {
        l(id, nativeId, cause);
      } catch (err) {
        this.log.error('native-id listener threw', { sessionId: id, error: String(err) });
      }
    }
  }

  /**
   * Fires when a session's provider-native id (for --resume) is learned OR
   * replaced. `cause` is set when the caller knows WHY the id changed —
   * 'clear' = the CLI executed /clear and minted a fresh conversation
   * (E10-07 feedback: the renderer shows a "conversation cleared" marker).
   */
  onNativeSessionId(
    l: (sessionId: string, nativeId: string, cause?: NativeIdCause) => void
  ): () => void {
    this.nativeIdListeners.add(l);
    return () => this.nativeIdListeners.delete(l);
  }

  rename(id: string, title: string): void {
    const r = this.sessions.get(id);
    if (!r) {
      this.noSuchSession('rename', id);
      return;
    }
    // A BLANK TITLE IS NOT A RENAME (#294) — and neither is one that is not a
    // string. `sessions:rename` refuses a non-string title before it gets here
    // (#347); this is the same guard on the other side of the boundary, so a
    // main-process caller cannot turn `title.trim()` into a TypeError either.
    const clean = typeof title === 'string' ? title.trim() : '';
    if (!clean) return;
    r.identity = { ...r.identity, title: clean };
    this.log.info('session renamed', { sessionId: id, title: clean });
  }

  get(id: string): SessionRecord | undefined {
    const r = this.sessions.get(id);
    return r ? { ...r } : undefined;
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()].map((r) => ({ ...r }));
  }

  /** Queryable transition history (the done-when observability). */
  transitions(sessionId?: string): StatusChange[] {
    return sessionId ? this.history.filter((h) => h.sessionId === sessionId) : [...this.history];
  }

  onStatusChange(l: (c: StatusChange) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onSessionExit(l: (e: SessionExit) => void): () => void {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }

  /**
   * An id this manager does not know: logged and dropped, never thrown (#347).
   *
   * `kill` and `rename` used to go through a `mustGet` that threw
   * `unknown session "<id>"`. Every other method in this class has always
   * tolerated an unknown id — `apply` ("late events for removed sessions are
   * dropped, not fatal"), `remove`, `setNativeSessionId`, `submitPrompt`,
   * `interrupt`, `get` — so the throw was the outlier inside the class, and it
   * was the one that could reach the renderer: `sessions:rename` handed
   * `mustGet` whatever id it was given, over a bridge call nobody catches.
   *
   * Dropping it is also the honest answer. Both callers ask for a side effect on
   * a session that is gone; there is no side effect left to have, and the two
   * ways to get here are races rather than defects — a session that exited or was
   * closed while a rename was in flight, and `hook-check` killing a session whose
   * process already died. `warn` rather than `debug` because neither is routine.
   */
  private noSuchSession(op: string, id: string): void {
    this.log.warn(`${op} for an unknown session — ignored`, { sessionId: id });
  }
}

function describeCause(ev: SessionEvent): string {
  switch (ev.kind) {
    case 'hook':
      return `hook:${ev.event}`;
    case 'stream':
      // NOT `hook:` — someone reading a transition log to find where a status
      // came from must be able to tell the two transports apart.
      return `stream:${ev.event}${ev.subtype ? ':' + ev.subtype : ''}`;
    case 'exit':
      return `exit:${ev.code}`;
    default:
      return ev.kind;
  }
}
