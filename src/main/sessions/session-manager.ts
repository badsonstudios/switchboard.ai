// SessionManager (P1-E2-03): create/kill/restart sessions, identity registry,
// status state machine fed by hook events (ingestion point here; the live
// HookListener wires into it in P1-E2-05). Every transition is logged with
// sessionId (queryable per the E1-05 logging contract) and observable via
// subscription.
import { errorText } from '../../shared/error-text';
import { randomUUID } from 'crypto';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { EventCapability, MainContributions, SpawnRecipe } from '../extensibility/contributions';
import type {
  ControlCapability,
  PermissionDecision,
  SessionControls,
} from './engine-controls';
import { declaredControls } from './engine-controls';
import type { EngineControl, SessionControlsWire } from '../../shared/engine-controls';
import type { PromptAttachment } from '../../shared/prompt-attachments';
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
import type { EngineEvent, EngineTranslator, PermissionRequestEvent } from './engine-events';
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
  /**
   * Each live session's CONTROLS, from its provider (E40 item 04, #1287), and
   * the provider's display name for the "Not available with <AI>" reason.
   * Built at spawn beside the translator; dropped in `remove()` with the
   * handle. A session whose provider declares none has no entry, and every
   * control answers `unsupported`.
   */
  private readonly sessionControls = new Map<string, { controls: SessionControls; ai: string }>();
  private readonly engineEventListeners = new Set<(sessionId: string, ev: EngineEvent) => void>();
  private permissionHoldSuppressor:
    | ((sessionId: string, ev: PermissionRequestEvent) => boolean)
    | null = null;
  private heldRequestProbe: ((sessionId: string) => boolean) | null = null;
  /**
   * Whether each session's MAIN turn is running (#1340) — see
   * `TransitionContext.turn` and `trackTurn`. Absent = no turn has run yet.
   * A Map beside the record rather than a field on it: the record is what
   * `get()`/`list()` hand out, and this is bookkeeping. Dropped in `remove()`.
   */
  private readonly turns = new Map<string, 'open' | 'closed'>();

  constructor(
    private readonly registry: ContributionRegistry<MainContributions>,
    /**
     * The default transport, positional because every caller passes one.
     *
     * It was `ptys: SessionTransport` and keyed `pty` until #952 deleted the PTY
     * transport. It is now the STREAM service, and the parameter stayed
     * positional rather than folding into the map below for one reason: the seam
     * is what §5.3 promises a second provider, and a `SessionManager` that takes
     * its only transport as an optional map entry would read as though having one
     * at all were negotiable.
     */
    transport: SessionTransport,
    private readonly log: Logger,
    private readonly stateDir: string,
    /**
     * Transports beyond the default (P2-E18-02). Empty again, and for a better
     * reason than the first time: E18 ended with ONE transport rather than two,
     * so this is the seam §5.3's adapter contract needs for a second provider,
     * not a staging area for a migration in progress.
     */
    extraTransports?: TransportMap
  ) {
    this.transports = { stream: transport, ...extraTransports };
  }


  /**
   * The models this session will accept (#721, #633) — the provider's
   * `models` control (#1287; Claude: `list_models`). The answer is
   * `{ models: [...] }` in `shared/models.ts`'s shape.
   *
   * NOTE WHAT THIS CANNOT TELL YOU: nothing in Claude's answer marks the
   * CURRENT model (measured). The running model is a `model` event, once per
   * TURN — so a picker must treat "which one is selected" as a separate and
   * possibly unknown question rather than reading it off this list.
   */
  async listModels(id: string): Promise<ControlVerdict> {
    return this.ask(id, 'models', (c) => c.models?.list());
  }

  /**
   * The MCP servers this session really has (#729) — the provider's `mcp`
   * control. For Claude, THE ONLY SOURCE: the config files reach three of the
   * CLI's eight runtime scopes, and account connectors and plugin-supplied
   * servers live in no file at all.
   *
   * The answer SETTLES rather than arriving complete: a freshly spawned Claude
   * session reports `pending` with no tool list for ~5 seconds before it
   * reports `connected` (measured). This is a single round trip and does not
   * hide that — the caller asks again.
   */
  async mcpStatus(id: string): Promise<ControlVerdict> {
    return this.ask(id, 'mcp', (c) => c.mcp?.status());
  }

  /**
   * Turn one MCP server on or off (#729 PR 2).
   *
   * ⚠️ The arguments are untrusted and the CONTROL validates them before the
   * wire — for Claude that is not defensive habit: `mcp_toggle` with no
   * `enabled` answers `success` and **disables the server** (measured; see
   * `mcpToggleRequest`). IT PERSISTS to `~/.claude.json`, so this is not a
   * session-scoped switch and callers must not describe it as one.
   */
  async mcpToggle(id: string, serverName: unknown, enabled: unknown): Promise<ControlVerdict> {
    const verdict = await this.ask(id, 'mcp', (c) => c.mcp?.toggle(serverName, enabled));
    if (verdict.ok) this.log.info('mcp server toggled', { sessionId: id, enabled });
    return verdict;
  }

  /**
   * Re-resolve one MCP server for this session (#729 PR 2). For Claude it does
   * two jobs: it reconnects a server that dropped, AND it pulls in one the
   * session never loaded (`mcp_status` is frozen at spawn).
   */
  async mcpReconnect(id: string, serverName: unknown): Promise<ControlVerdict> {
    const verdict = await this.ask(id, 'mcp', (c) => c.mcp?.reconnect(serverName));
    if (verdict.ok) this.log.info('mcp server reconnected', { sessionId: id });
    return verdict;
  }

  /**
   * Start the OAuth flow for one MCP server (#734).
   *
   * ⚠️ **`ok: true` HERE DOES NOT MEAN "SIGNED IN".** Only Claude's refusals
   * are measured, so this reports the verdict and nothing more; the sentence
   * the user reads is deliberately non-committal (`mcp.signInStarted`).
   * REMOTE-ONLY, by the CLI's own rule: a stdio server is refused by TYPE, and
   * the refusal is passed through.
   */
  async mcpAuthenticate(id: string, serverName: unknown): Promise<ControlVerdict> {
    const verdict = await this.ask(id, 'mcp', (c) => c.mcp?.authenticate(serverName));
    // NO SERVER NAME IN THIS LINE beyond the session id — an OAuth flow is the
    // one place a name and a timestamp together start to describe an account,
    // and the app log is a file users attach to bug reports. Nothing is logged
    // on failure: the CLI's own sentence travels in the verdict, which is what
    // the pane renders.
    if (verdict.ok) this.log.info('mcp sign-in requested', { sessionId: id });
    return verdict;
  }

  /**
   * Forget the stored credentials for one MCP server (#734) — the escape hatch
   * for a sign-in whose success path cannot be exercised on the dev machine.
   */
  async mcpClearAuth(id: string, serverName: unknown): Promise<ControlVerdict> {
    const verdict = await this.ask(id, 'mcp', (c) => c.mcp?.clearAuth(serverName));
    if (verdict.ok) this.log.info('mcp sign-out requested', { sessionId: id });
    return verdict;
  }

  /**
   * `session-gone` for a session this manager no longer holds — or `null` to
   * carry on.
   *
   * WITHOUT THIS, A DEAD SESSION READS AS ONE WITH NO CHANNEL. `sendToTransport`
   * answers `false` for both a handle with no `send` and a missing handle, and
   * a provider's channel turns a false into `not-stream`. A stale live id (the
   * restart path drops the handle in `remove` while a renderer may still hold
   * the old one) would therefore get the wrong explanation for its problem.
   *
   * The two states are genuinely different and only this class can tell them
   * apart, which is why the check is here rather than in any provider.
   */
  private controlPrecheck(id: string): ControlVerdict | null {
    if (this.handles.has(id)) return null;
    return { ok: false, reason: 'session-gone', message: 'the session has stopped' };
  }

  /**
   * Run one control verb on a live session (#1287): the precheck above, then
   * the provider's control — or `unsupported` when its AI has no such control,
   * and `refused` when the control throws or answers nothing. Never rejects:
   * a caller that had to wrap every call in try/catch would grow a swallowed
   * catch eventually, and the surface needs the reason (the #721 rule).
   */
  private async ask(
    id: string,
    name: EngineControl,
    run: (c: SessionControls) => Promise<ControlVerdict> | undefined
  ): Promise<ControlVerdict> {
    const gone = this.controlPrecheck(id);
    if (gone) return gone;
    const entry = this.sessionControls.get(id);
    let pending: Promise<ControlVerdict> | undefined;
    try {
      pending = entry ? run(entry.controls) : undefined;
    } catch (err) {
      this.log.error('provider control threw', { sessionId: id, control: name, error: errorText(err) });
      return { ok: false, reason: 'refused', message: 'the session could not do that' };
    }
    if (!pending) {
      return {
        ok: false,
        reason: 'unsupported',
        message: `Not available with ${entry?.ai ?? this.aiNameOf(id)}.`,
      };
    }
    try {
      return await pending;
    } catch (err) {
      this.log.error('provider control threw', { sessionId: id, control: name, error: errorText(err) });
      return { ok: false, reason: 'refused', message: 'the session could not do that' };
    }
  }

  /** The display name of the AI a session runs, for a reason sentence. */
  private aiNameOf(id: string): string {
    const providerId = this.sessions.get(id)?.identity.providerId ?? '';
    return this.registry.resolve('provider-adapter', providerId)?.manifest.displayName ?? (providerId || 'this AI');
  }

  /**
   * Switch this session's model, mid-session, with no restart (#721, #633).
   *
   * Claude's is verified BY EFFECT rather than by its acknowledgement: after
   * `set_model`, the next turn's `system:init.model`, the assistant message's
   * `message.model` and `result.modelUsage` all three reported the new model.
   * An empty or non-string `model` is refused before the wire.
   */
  async setModel(id: string, model: unknown): Promise<ControlVerdict> {
    const verdict = await this.ask(id, 'models', (c) => c.models?.set(model));
    if (verdict.ok) this.log.info('model changed', { sessionId: id });
    return verdict;
  }

  /**
   * How hard this session's model is thinking, and the levels it could be set
   * to (#1115) — the provider's `effort` control. `{ effort, levels, model }`;
   * a model with no effort levels answers `effort: null`, and the honest
   * surface is then no chip.
   */
  async effort(id: string): Promise<ControlVerdict> {
    return this.ask(id, 'effort', (c) => c.effort?.get());
  }

  /**
   * How full this session's context window is, by the engine's own count
   * (#715). ONLY THE NUMBERS LEAVE the provider; an answer with no usable fill
   * is `refused`, not a success carrying zero.
   */
  async contextUsage(id: string): Promise<ControlVerdict> {
    return this.ask(id, 'contextUsage', (c) => c.contextUsage?.get());
  }

  /**
   * Set how hard this session's model thinks, mid-session (#1115).
   *
   * ⚠️ VERIFIED BY EFFECT, EVERY TIME, inside Claude's control: its
   * acknowledgement is worth nothing (a level the CLI has never heard of
   * answers `success`), so the level is read back, and a set that did not
   * take is `refused` with what the session is actually on.
   */
  async setEffort(id: string, level: unknown): Promise<ControlVerdict> {
    const verdict = await this.ask(id, 'effort', (c) => c.effort?.set(level));
    if (verdict.ok) this.log.info('effort changed', { sessionId: id, effort: verdict.response.effort });
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
  private abandonStart(
    id: string,
    releaseSettingsFor?: (sessionId: string) => void,
    releaseMcpFor?: (sessionId: string) => void
  ): void {
    removeSessionStateDir(this.stateDir, id, this.log);
    try {
      releaseSettingsFor?.(id);
    } catch (err) {
      this.log.warn('could not release session settings after a failed start', {
        sessionId: id,
        error: errorText(err),
      });
    }
    // …and the bus endpoint `mcpConfigFor` opened as a side effect (#763
    // review). Isolated from the release above rather than sharing its try: both
    // give back state for an id that will never exist, and a throw in the first
    // must not be why the second never runs — the same argument `tearDownStep`
    // makes in sessions/ipc.ts.
    try {
      releaseMcpFor?.(id);
    } catch (err) {
      this.log.warn('could not release the session bus after a failed start', {
        sessionId: id,
        error: errorText(err),
      });
    }
  }

  create(
    identity: SessionIdentity,
    opts?: {
      resumeSessionId?: string;
      /** kept settings for `resumeSessionId` (#1317), passed through to the adapter */
      resumeSettings?: { model?: string; effort?: string };
      /**
       * Fork `resumeSessionId` rather than continuing it (§5.5 Level 3,
       * P2-E11-12). Passed straight through to the adapter, which decides
       * whether its CLI can express it — the manager has no opinion.
       */
      forkSession?: boolean;
      /** The id the forked session must take. A UUID; the adapter refuses
       *  anything else rather than spawning an unpinned fork. */
      forkSessionId?: string;
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
      /**
       * MCP config that needs the session id before spawn (P2-E11-03) — the
       * Session Bus, whose endpoint is named after the id.
       *
       * SYNCHRONOUS, like `settingsFor`, and that is a constraint the bus was
       * built around rather than one it happens to satisfy: `create` is
       * synchronous end to end and must stay that way, so the bus derives its
       * endpoint paths instead of waiting to discover them. See
       * `BusHost.attachSession`.
       *
       * ⚠️ IT HAS A SIDE EFFECT: it OPENS the session's bus endpoint. That is
       * why `releaseMcpFor` exists — see it.
       */
      mcpConfigFor?: (sessionId: string) => Record<string, unknown> | undefined;
      /**
       * Undo of `mcpConfigFor`, on every path where `create` throws after it
       * ran. The same pairing `settingsFor`/`releaseSettingsFor` has, and for
       * the same reason (#470) — found in review of #763, where an earlier
       * version of this comment claimed no pair was needed.
       *
       * IT WAS WRONG, and the leak was real: `mcpConfigFor` opens a LISTENING
       * endpoint and mints a token as a side effect. Every throw below it —
       * no CLI on PATH, an unresolvable transport, a failed `spawn` — reaches
       * `abandonStart`, which knew only about the state directory and the hook
       * token. No record is created, so `tearDownLive` never runs for that id,
       * so nothing ever called `unregisterSession`. Each failed start left a
       * live socket and a live token in memory for the life of the app, plus an
       * orphaned token file written AFTER `abandonStart` had already deleted
       * the directory. A user with no `claude` on PATH clicking Start five
       * times leaked five of them.
       */
      releaseMcpFor?: (sessionId: string) => void;
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
        ...(opts?.resumeSessionId && opts.resumeSettings ? { resumeSettings: opts.resumeSettings } : {}),
        // §5.5 Level 3. Both undefined on every ordinary start, so the recipe an
        // adapter builds is unchanged for every session that is not a fork.
        forkSession: opts?.forkSession,
        forkSessionId: opts?.forkSessionId,
        autonomy: opts?.autonomy,
        settings: Object.keys(settings).length > 0 ? settings : undefined,
        // Undefined when there is no bus, no `mcp` capability, or the adapter
        // declined — and the adapter then passes no `--mcp-config` at all, so
        // the recipe is byte-identical to the pre-E11 one.
        mcpConfig: opts?.mcpConfigFor?.(id),
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
      this.abandonStart(id, opts?.releaseSettingsFor, opts?.releaseMcpFor);
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
      this.log.error('session spawn failed', { sessionId: id, folder: identity.folder, transport: kind, error: errorText(err) });
      this.abandonStart(id, opts?.releaseSettingsFor, opts?.releaseMcpFor);
      throw err; // no orphan record: it was never added
    }
    this.sessions.set(id, record);
    this.handles.set(id, proc);
    record.pid = proc.pid;
    // The provider's CONTROLS (E40 item 04, #1287), beside its translator:
    // what the host can do to this session, and which of those it has. Built
    // AFTER the handle is in the map, because the session they write to is
    // `sendToTransport`, which reads it.
    // The frame pump, named so a provider's `loopback` can reach it (E40 item
    // 06, #1289): a frame of the provider's own making goes through exactly the
    // path an engine frame does. Undefined for a byte-only handle and after the
    // session is gone, when a loopback is a no-op.
    let pump: ((m: Record<string, unknown>) => void) | undefined;
    const controls = this.controlsFor(id, adapter.capabilities?.controls, !!proc.onMessage, (frame) => {
      if (this.handles.has(id)) pump?.(frame);
    });
    if (controls) this.sessionControls.set(id, { controls, ai: adapter.manifest.displayName });

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
      //
      // The `/clear` latch (#753) lives out here rather than on the record: it
      // is per-session by construction, needs no teardown, and — the reason
      // that matters — a field on `SessionRecord` would be copied into every
      // `{ ...record }` the renderer receives, publishing a 20 ms-lived
      // internal to the IPC surface.
      let clearPending = false;
      // The provider's translator (E40 item 03, #1286): its frames in, neutral
      // events out. Everything below and every engine-event listener reads
      // ONLY those; the raw frame goes on to the provider's OWN controls
      // (#1287), which correlate their replies, and to nothing else.
      const translate = this.translatorFor(id, adapter.capabilities?.events);
      pump = (m) => {
        const events = this.translateFrame(id, translate, m);
        for (const ev of events) {
          // `conversation_reset` — the CLI saying, in as many words, that it
          // threw the conversation away. #753 is #748's defect in the second
          // consumer: the comparison below infers a clear from an id CHANGING and
          // cannot fire until it has an id to change FROM. The frame needs no
          // prior id, so it arms the tag on the FIRST clear. Everything measured
          // about this frame — the +16 ms/+36 ms ordering, the
          // `new_conversation_id` decoy, what else emits it — is written up once
          // in `stream-feed.ts`'s `onConversationReset` header and is not
          // repeated here. Same ruling, different bookkeeping: that consumer
          // keeps a `discarded` id because a repeat frame must not wipe twice;
          // setting a boolean twice needs no such guard.
          //
          // WHEN THE BLIND SPOT IS ACTUALLY REACHED — narrower today than the
          // ticket reads, and the difference is worth knowing. While the hook
          // listener lives, `SessionStart` fires at CLI LAUNCH and reaches
          // `setNativeSessionId` about a second after every card spawns
          // (`transcripts/watcher.test.ts`, "HOOK TRAFFIC ALONE is not
          // evidence"). So `prior` is normally already defined by the time a
          // human types `/clear`, even on a resumed card, and the backstop would
          // have tagged it. What is NOT covered either way is the race the ticket
          // names: whichever writer lands the new id first wins the cause, and
          // the hook writer tags only `SessionStart source:'clear'`. This makes
          // the stream pump a second CORRECT writer instead of a contradicting
          // one — but it cannot retract a tag the hook writer already landed
          // untagged, because by then the id has moved and the watcher's branch
          // is gated on it moving. That residue is #793.
          //
          // E18-15 is when this stops being belt-and-braces: it deletes the hook
          // listener, nothing seeds `prior` until the first TURN's init (measured,
          // #748 probe 2), and the frame becomes the only thing that can tag a
          // first clear at all.
          //
          // LATCHED, NOT ACTED ON, because the cause has to travel with an id and
          // this frame carries none worth having — `session_id` names the
          // conversation being DISCARDED and `new_conversation_id` is the decoy.
          // So the flag waits ~20 ms for the init that carries the real one.
          //
          // NO EXPIRY. The clear's OWN init spends it ~20 ms later, so the
          // unbounded case is not "a clear with no follow-up prompt" — it is a
          // clear whose init never arrives at all. Even then the tag stays right:
          // whenever an init does come it IS the conversation this reset minted.
          //
          // A FALSE 'clear' IS ALL BUT INERT, which is what makes trusting this
          // frame safe rather than merely measured. The CLI's zod description
          // (still verbatim in the PATH binary 2.1.261, re-read for this item)
          // names three emitters — "/clear, plan-mode exit, and fresh-session
          // flows" — and #748 measured plan-mode exit emitting ZERO frames and
          // not rotating `session_id`. We do not have to rely on that: the cause
          // does nothing unless the id ALSO changed (`setNativeSessionId` returns
          // early on an unchanged id; the watcher's branch is behind
          // `w.snap.nativeSessionId !== nativeId`). And a reset WITH a rotation is
          // a new conversation whatever minted it. Not literally free: the
          // residual cost is `conversationStarted = false` in `resetBinding`,
          // i.e. one suppressed binding-failure diagnostic on a session that did
          // rotate its id. Fail-open, which is the direction P6 asks for.
          if (ev.type === 'conversation-reset') clearPending = true;
          // The stream carries the resume identity itself: `system:init` arrives
          // once per turn with the conversation's `session_id` (E18-05's
          // done-when, closed without this half — #404). Learned HERE so stream
          // mode never depends on the hook listener E18-15 deletes. Hooks DO
          // fire under `--input-format stream-json` (measured 2026-08-10,
          // claude 2.1.226), so today this is a second, idempotent writer of
          // the same id; the day the hooks fall silent it is the only one.
          //
          // The id comparison is KEPT as the BACKSTOP rather than replaced, the
          // same call `stream-feed.ts` makes: a CLI build that stops emitting
          // `conversation_reset` — an older one, a future one — degrades to the
          // behaviour we had, wrong only for the FIRST clear, instead of to no
          // tag at all. (The hook writer is STRICTER still — it tags only
          // `SessionStart source:'clear'` — and the first writer to land wins
          // the cause; the hook writer retires with E18-15. Whether an untagged
          // hook can win that race after a `/clear` was MEASURED for #793 on CLI
          // 2.1.270: in Direct mode (this path) the CLI awaits the tagged hook,
          // and it landed first 15/15; Terminal mode defers it and it still
          // landed first 25/25 — see the note at the tag site in
          // `hook-listener.ts`.)
          //
          // A resume is not a clear: `create()` never seeds the record's id and
          // no reset frame precedes a resumed spawn (#748 probe 5 measured zero),
          // so a resumed session's first init lands untagged, exactly like the
          // hook path's. The translator never emits an EMPTY id (Claude's rejects
          // the empty string, as every consumer always did) — learning '' would
          // falsely tag the first REAL id as a 'clear'. An init it drops does not
          // spend the latch either: it taught us nothing, so it cannot have been
          // the clear's init.
          if (ev.type === 'conversation') {
            const prior = record.nativeSessionId;
            const cleared = clearPending || (prior !== undefined && prior !== ev.id);
            // ONE-SHOT. Measured UNOBSERVABLE through this seam — deleting this
            // line leaves the whole suite green — because a stale latch only ever
            // agrees with the backstop. The argument needs one unstated fact to
            // hold: NOTHING EVER UN-SETS `record.nativeSessionId` (this method is
            // its only writer). Given that, a spent latch implies `prior !==
            // undefined` for ever after, so any later init is either the same id,
            // which `setNativeSessionId` drops before it looks at the cause, or a
            // changed one, which the backstop tags anyway. Kept because the latch
            // is a one-shot and a reader should not have to prove all that to
            // know it; narrowing the backstop later would make this load-bearing
            // with no test to notice. WHERE it is spent is a different matter and
            // is pinned: inside the guard, so an init that taught us nothing
            // cannot swallow the tag.
            clearPending = false;
            this.setNativeSessionId(id, ev.id, cleared ? 'clear' : undefined);
          }
          const status = streamStatusEvent(ev);
          // The EVENT, for the suppressor: whether a standing grant covers THIS
          // request is a question about the request itself (#974), and the
          // `permission-request` event carries the request (#1287).
          if (status && !this.holdSuppressed(id, status, ev)) this.apply(id, status);
        }
        // The raw frame to the provider's own controls (#1287) — the ONLY raw
        // reader left, and it is the provider's: the replies to what its
        // controls asked. Then the neutral events to everyone else, in the
        // order the stores, the Feed and health subscribed — the order they
        // heard the frames in before the seam.
        this.receiveFrame(id, m);
        for (const ev of events) {
          for (const l of this.engineEventListeners) {
            try {
              l(id, ev);
            } catch (err) {
              // …and one broken event subscriber must not starve the others
              this.log.error('engine event listener threw', { sessionId: id, error: errorText(err) });
            }
          }
        }
      };
      proc.onMessage(pump);
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
          this.log.error('exit listener threw', { sessionId: id, error: errorText(err) });
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
    this.turns.delete(id);
    this.handles.delete(id);
    // …and its controls (#1287): anything still waiting on a reply hears
    // `session-gone` now, and nothing can write to the handle just dropped.
    this.forgetControls(id);
    this.sessionControls.delete(id);
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
    // The turn's FRAME is the provider's (#1287): Claude's `user` message.
    const prompt = this.sessionControls.get(id)?.controls.prompt;
    if (!prompt) {
      this.log.warn('provider takes no prompt: nothing sent', { sessionId: id });
      return false;
    }
    let sent = false;
    try {
      sent = prompt(text, attachments);
    } catch (err) {
      this.log.error('provider prompt control threw: nothing sent', { sessionId: id, error: errorText(err) });
    }
    if (!sent) return false;
    // We know the turn began because WE started it — no round trip, unlike the
    // PTY path waiting on a UserPromptSubmit hook.
    this.apply(id, { kind: 'prompt-sent' });
    return true;
  }

  /**
   * Every NEUTRAL event from every stream session (E40 item 03, #1286) — what
   * happened, in no provider's words (`engine-events.ts`). The Feed, service
   * health, the permission router and the command, model and mode stores all
   * subscribe here (#1287).
   *
   * ⚠️ THERE IS NO RAW-FRAME FAN-OUT ANY MORE. `onStreamMessage` was deleted
   * by #1287: a provider's frames reach its translator and its own controls
   * and nothing else, so no host module can read a provider's wire.
   *
   * Subscribe once per consumer: each listener is wrapped in its own
   * try/catch, so sharing one is sharing a blast radius.
   */
  onEngineEvent(l: (sessionId: string, ev: EngineEvent) => void): () => void {
    this.engineEventListeners.add(l);
    return () => this.engineEventListeners.delete(l);
  }

  /**
   * This session's translator, from its provider's `events` capability — or
   * none. NO FALLBACK to Claude's: a provider that cannot translate gets no
   * Feed and no streamed status, said once in the log, rather than having its
   * frames read as if they were Claude's (the bypass #1286 retires).
   */
  private translatorFor(
    id: string,
    events: EventCapability | undefined
  ): EngineTranslator | undefined {
    if (!events) {
      this.log.warn('provider declares no event translator: no Feed or streamed status', {
        sessionId: id,
      });
      return undefined;
    }
    try {
      return events.createTranslator(
        {
          onUnknown: (frameType) =>
            this.log.info('stream frame type not understood: skipped', { sessionId: id, frameType }),
          onSkipped: (what, fields) => this.log.debug(what, { sessionId: id, ...fields }),
        },
        { id }
      );
    } catch (err) {
      this.log.error('event translator could not be created', { sessionId: id, error: errorText(err) });
      return undefined;
    }
  }

  /** One frame's events. A translator that throws costs this frame, never the
   *  session or any other one (P6). */
  private translateFrame(
    id: string,
    translate: EngineTranslator | undefined,
    m: Record<string, unknown>
  ): EngineEvent[] {
    if (!translate) return [];
    try {
      return translate(m);
    } catch (err) {
      this.log.error('event translator threw: frame skipped', { sessionId: id, error: errorText(err) });
      return [];
    }
  }

  /**
   * This session's controls, from its provider's `controls` capability — or
   * none. No fallback to Claude's, for `translatorFor`'s reason: a provider
   * that declares no controls gets a session that can be read and not driven,
   * said once in the log.
   */
  private controlsFor(
    id: string,
    cap: ControlCapability | undefined,
    typed: boolean,
    loopback: (frame: Record<string, unknown>) => void
  ): SessionControls | undefined {
    if (!cap) {
      // Said only for a handle that carries typed messages, as the translator's
      // warning is: a byte-only handle could not be driven by any controls.
      if (typed) this.log.warn('provider declares no controls: the session cannot be driven', { sessionId: id });
      return undefined;
    }
    try {
      return cap.createControls({ id, send: (frame) => this.sendToTransport(id, frame), loopback });
    } catch (err) {
      this.log.error('session controls could not be created', { sessionId: id, error: errorText(err) });
      return undefined;
    }
  }

  /** One frame to this session's own controls. A throw costs the frame's
   *  reply, never the pump (P6). */
  private receiveFrame(id: string, m: Record<string, unknown>): void {
    const receive = this.sessionControls.get(id)?.controls.receive;
    if (!receive) return;
    try {
      receive(m);
    } catch (err) {
      this.log.error('session controls threw on a frame', { sessionId: id, error: errorText(err) });
    }
  }

  /**
   * Ask the engine to interrupt the running turn (#154) — the provider's
   * `interrupt` control since #1287 (Claude: a `control_request` of subtype
   * `interrupt`).
   *
   * Returns false when the session has no typed-message transport, or its AI
   * has no interrupt (the Stop control is greyed out for it). The caller falls
   * back, which keeps the renderer transport-ignorant in the same way
   * `submitPrompt` does.
   */
  interrupt(id: string): boolean {
    const handle = this.handles.get(id);
    if (!handle?.send) return false;
    const control = this.sessionControls.get(id)?.controls.interrupt;
    if (!control) {
      this.log.info('interrupt unavailable: the provider declares none', { sessionId: id });
      return false;
    }
    let sent = false;
    try {
      sent = control.interrupt();
    } catch (err) {
      this.log.error('provider interrupt control threw', { sessionId: id, error: errorText(err) });
      return false;
    }
    if (sent) this.log.info('interrupt requested', { sessionId: id });
    return sent;
  }

  /**
   * Switch this live session's mode NOW, when its AI has a live switch (E40
   * item 06, #1289: ACP `session/set_mode`). Claude's `modes` declares no
   * `set` — its mode is `--permission-mode`, applied at the next start — so
   * for a Claude session this answers `unsupported` and does nothing, which is
   * exactly what the mode chip did before. Never throws.
   */
  async setMode(id: string, mode: AutonomyMode): Promise<ControlVerdict> {
    const verdict = await this.ask(id, 'modes', (c) => c.modes?.set?.(mode));
    if (verdict.ok) this.log.info('mode switched live', { sessionId: id, mode });
    else if (verdict.reason !== 'unsupported') {
      this.log.info('live mode switch refused', { sessionId: id, mode, reason: verdict.reason });
    }
    return verdict;
  }

  /**
   * Answer a permission request on this session (P2-E18-07; through the
   * provider's `approvals` control since #1287). `requestId` is the ENGINE'S
   * id, as the `permission-request` event carried it. False when it could not
   * be written: the session is gone, its AI has no approvals, or the control
   * threw — the router's fail-open paths read false exactly as they always
   * read a failed write.
   */
  answerPermission(id: string, requestId: string, decision: PermissionDecision): boolean {
    const control = this.sessionControls.get(id)?.controls.approvals;
    if (!control) {
      // A provider that RAISES requests but declares no way to answer them is
      // a provider bug; the router reads false as an undeliverable answer and
      // fails open as it always has. Said, so the bug has a symptom.
      this.log.warn('permission answer dropped: the provider declares no approvals', { sessionId: id, requestId });
      return false;
    }
    try {
      return control.answer(requestId, decision) === true;
    } catch (err) {
      this.log.error('provider approvals control threw', { sessionId: id, error: errorText(err) });
      return false;
    }
  }

  /**
   * Which controls this live session's AI has, and its name (#1287) — what
   * `sessions:controls` answers the composer, which greys the rest out with
   * "Not available with <AI>". `null` for a session this manager does not
   * hold. A held session whose provider declares no controls has an empty
   * list, with the name read off its adapter.
   */
  controlsOf(id: string): SessionControlsWire | null {
    const r = this.sessions.get(id);
    if (!r) return null;
    const entry = this.sessionControls.get(id);
    if (entry) return { ai: entry.ai, has: declaredControls(entry.controls) };
    const adapter = this.registry.resolve('provider-adapter', r.identity.providerId);
    return { ai: adapter?.manifest.displayName ?? r.identity.providerId, has: [] };
  }

  /**
   * Give up on everything this session's controls have in flight (#700's
   * `forgetSession` pattern; it was `control.forgetSession`). The teardown and
   * the exit path call it so a consumer awaiting a reply from a session the
   * user just closed hears `session-gone` now, not at the timeout. Idempotent;
   * never throws.
   */
  forgetControls(id: string): void {
    const forget = this.sessionControls.get(id)?.controls.forget;
    if (!forget) return;
    try {
      forget();
    } catch (err) {
      this.log.error('session controls threw on forget', { sessionId: id, error: errorText(err) });
    }
  }

  /** Send a raw protocol message — the transport under a provider's controls
   *  (#1287); nothing in the host composes one. */
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
   * no beep — `StreamPermissions.setAllowAll`'s docblock has said so since P2 — and
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
  /**
   * ⚠️ TAKES THE REQUEST SINCE #974 — the raw message until #1287, the
   * neutral `permission-request` event (which carries it) since — and the
   * widening is the point. It was
   * `(sessionId) => boolean`, which was enough while the only standing grant was
   * allow-all — a property of the SESSION. A per-file grant is a property of the
   * REQUEST, so the id alone cannot answer it, and without the message a granted
   * call would still flash `needs-permission`, raise an Events row and beep one
   * message before the router answered it in the same tick.
   */
  setPermissionHoldSuppressor(
    fn: (sessionId: string, ev: PermissionRequestEvent) => boolean
  ): void {
    this.permissionHoldSuppressor = fn;
  }

  /** Should this event be dropped rather than applied? Only ever true for a
   *  `permission-held` the router is about to answer at the server — an
   *  allow-all session, or a per-file grant covering this very call (#974) —
   *  and never when the predicate throws: "I can't tell" must fall back to the
   *  honest status, not to silence (a suppressed hold nobody answers is a card
   *  stuck on `working` while the CLI waits). */
  private holdSuppressed(id: string, ev: SessionEvent, cause: EngineEvent): boolean {
    if (ev.kind !== 'permission-held' || !this.permissionHoldSuppressor) return false;
    if (cause.type !== 'permission-request') return false;
    let suppress = false;
    try {
      suppress = this.permissionHoldSuppressor(id, cause) === true;
    } catch (err) {
      this.log.error('permission-hold suppressor threw', { sessionId: id, error: errorText(err) });
      return false;
    }
    if (suppress) {
      this.log.debug('permission-held suppressed: the router will answer it', { sessionId: id });
    }
    return suppress;
  }

  /**
   * Teach the state machine whether a request is still held (#1258).
   *
   * `transition` is a pure function of a status and an event, and the bug
   * this closes is exactly what that cannot see: an approval is held, the CLI
   * keeps streaming, and the next frame answers `working` over a session that
   * is still waiting on a person. Whether something is held is known to the
   * permission router and to nobody else.
   *
   * A setter and a predicate, for the reasons `setPermissionHoldSuppressor`
   * gives one function up: the two collaborators are cyclic, and this asks
   * one question and must not be able to answer any others.
   */
  setHeldRequestProbe(fn: (sessionId: string) => boolean): void {
    this.heldRequestProbe = fn;
  }

  /** Is a request still held for this session? False when nobody can say,
   *  and false when the probe throws: "I can't tell" must fall back to the
   *  behaviour every release before this one had, not to a card that can
   *  never leave `needs-permission`. */
  private requestHeld(id: string): boolean {
    if (!this.heldRequestProbe) return false;
    try {
      return this.heldRequestProbe(id) === true;
    } catch (err) {
      this.log.error('held-request probe threw', { sessionId: id, error: errorText(err) });
      return false;
    }
  }

  /**
   * Is the session's MAIN turn running? (#1340) The one thing a withdrawn
   * request needs to know that its status cannot say: a background subagent's
   * output walks a finished card to `working` with no turn running at all.
   *
   * Opened by our own prompt or by the main conversation's output (a resumed
   * turn we did not send); closed by a turn end or the session's exit. A
   * subagent's output (`sidechain`) leaves it alone — no turn end is owed for
   * it.
   *
   * ⚠️ ONE ASSUMPTION IS UNMEASURED: that a prompt sent while a request is held
   * is owed a `result`. #1268 measured that the CLI QUEUES such a prompt and
   * runs it once the held request is ANSWERED; what an INTERRUPT does to the
   * queue was not measured (its ack carries `still_queued`). If it drops the
   * prompt, that card would sit at `working` — the pre-#1340 behaviour, not a
   * new one.
   *
   * Hooks are not read: the only reader is a withdrawal, which only an
   * engine's control channel can send, and every such session reports its
   * turns as `prompt-sent` / `turn-end`.
   */
  private trackTurn(id: string, ev: SessionEvent): void {
    if (ev.kind === 'prompt-sent') this.turns.set(id, 'open');
    else if (ev.kind === 'exit') this.turns.set(id, 'closed');
    else if (ev.kind === 'stream') {
      if (ev.signal === 'turn-end') this.turns.set(id, 'closed');
      else if (!ev.sidechain) this.turns.set(id, 'open');
    }
  }

  /** Hook/permission/user events feed the state machine here. */
  apply(id: string, ev: SessionEvent): void {
    const r = this.sessions.get(id);
    if (!r) return; // late events for removed sessions are dropped, not fatal
    // asked only of a session that is waiting: this runs for every delta of
    // every stream, and the answer cannot matter to any other status
    const waiting = r.status === 'needs-permission' || r.status === 'needs-input';
    const result = transition(r.status, ev, {
      held: waiting && this.requestHeld(id),
      turn: this.turns.get(id) ?? 'none',
    });
    // Whether or not the status moved: a prompt sent while a request pins the
    // card still opens a turn (#1340).
    this.trackTurn(id, ev);
    // ...and not logged per frame: a held request sits under a stream of them
    if (result.note && result.note !== 'request-still-held') {
      this.log.debug('session event note', { sessionId: id, note: result.note });
    }
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
        this.log.error('status listener threw', { sessionId: id, error: errorText(err) });
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
        this.log.error('native-id listener threw', { sessionId: id, error: errorText(err) });
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
      // `label` is the frame the engine sent (`assistant`, `result:success`),
      // so this reads exactly as it did before the seam (#1286).
      return `stream:${ev.label}`;
    case 'exit':
      return `exit:${ev.code}`;
    default:
      return ev.kind;
  }
}
