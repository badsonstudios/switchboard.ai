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
import { SessionEvent, SessionStatus, transition } from './state-machine';
import { streamStatusEvent } from './stream-status';
import { userMessage } from '../../shared/stream-protocol';

/**
 * Why a session's native id CHANGED. 'clear' = the CLI ran /clear and minted
 * a fresh conversation (SessionStart source:'clear'); absent = first learn or
 * an unexplained change (e.g. correcting a same-cwd mis-bind).
 */
export type NativeIdCause = 'clear';

export interface SessionIdentity {
  title: string;
  folder: string;
  accentColor?: string;
  /** project-type lang badge (§5.11), e.g. "TS", "Rs" */
  langBadge?: string;
  providerId: string;
}

export interface SessionRecord {
  id: string;
  identity: SessionIdentity;
  status: SessionStatus;
  createdAt: string;
  nativeSessionId?: string;
  pid?: number;
  exitCode: number | null;
  /** autonomy mode this session was spawned at (drives the E10-03 hold policy) */
  autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto';
  /**
   * Which transport is hosting this session (P2-E18-02). Recorded at spawn and
   * never changed: a live session cannot move between transports, and kill()
   * must reach the same service that spawned it.
   */
  transport: TransportKind;
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

export interface StatusChange {
  sessionId: string;
  from: SessionStatus;
  to: SessionStatus;
  cause: string;
  at: string;
}

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

  create(
    identity: SessionIdentity,
    opts?: {
      resumeSessionId?: string;
      autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto';
      settings?: Record<string, unknown>;
      /**
       * Settings that need the session id before spawn (hook wiring: the
       * HookListener registers a token for the id and returns the injectable
       * config). Merged over `settings`.
       */
      settingsFor?: (sessionId: string) => Record<string, unknown>;
    }
  ): SessionRecord {
    const adapter = this.registry.resolve('provider-adapter', identity.providerId);
    if (!adapter) throw new Error(`no provider adapter "${identity.providerId}"`);
    const id = randomUUID();
    const settings = { ...opts?.settings, ...opts?.settingsFor?.(id) };
    const recipe: SpawnRecipe = adapter.buildSpawn({
      cwd: identity.folder,
      sessionId: id,
      stateDir: this.stateDir,
      resumeSessionId: opts?.resumeSessionId,
      autonomy: opts?.autonomy,
      settings: Object.keys(settings).length > 0 ? settings : undefined,
    });
    // Resolved BEFORE the record exists, so an adapter asking for a transport
    // we do not have leaves nothing behind — same contract as the "no provider
    // adapter" throw above.
    const kind: TransportKind = recipe.transport ?? DEFAULT_TRANSPORT;
    const transport = this.resolveTransport(kind, identity.providerId);
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
      //    Deferred a tick so the caller holds the record before any transition
      //    fires — `create()` has not returned yet, and a status listener that
      //    calls back into `get(id)` would otherwise see a half-built session.
      setImmediate(() => this.apply(id, { kind: 'transport-ready' }));
      // 2. The messages themselves drive status from here, and are fanned out
      //    to whoever else needs them (P2-E18-07's permission router).
      proc.onMessage((m) => {
        const ev = streamStatusEvent(m);
        if (ev) this.apply(id, ev);
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
    });
    this.log.info('session created', { sessionId: id, folder: identity.folder, pid: proc.pid, provider: identity.providerId });
    return { ...record };
  }

  kill(id: string): void {
    const r = this.mustGet(id);
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
    // order the IPC layer used: a transport's remove() fires onExit
    // synchronously, and apply() drops events for sessions it no longer knows.
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
    this.log.info('session removed', { sessionId: id, transport: r.transport });
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
   */
  submitPrompt(id: string, text: string): boolean {
    const handle = this.handles.get(id);
    if (!handle?.send) return false;
    handle.send(userMessage(text));
    // We know the turn began because WE started it — no round trip, unlike the
    // PTY path waiting on a UserPromptSubmit hook.
    this.apply(id, { kind: 'prompt-sent' });
    return true;
  }

  /**
   * Every typed message from every stream session (P2-E18-07).
   *
   * The manager is the only thing that holds the handles, so it is the only
   * place a fan-out can live. Consumers filter by what they care about — the
   * permission router takes `control_request`, and nothing else subscribes yet.
   */
  onStreamMessage(l: (sessionId: string, msg: Record<string, unknown>) => void): () => void {
    this.streamMessageListeners.add(l);
    return () => this.streamMessageListeners.delete(l);
  }

  /** Send a raw protocol message (control responses — P2-E18-07). */
  sendToTransport(id: string, msg: unknown): boolean {
    const handle = this.handles.get(id);
    if (!handle?.send) return false;
    handle.send(msg);
    return true;
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
    const r = this.mustGet(id);
    const clean = title.trim();
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

  private mustGet(id: string): SessionRecord {
    const r = this.sessions.get(id);
    if (!r) throw new Error(`unknown session "${id}"`);
    return r;
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
