// SessionManager (P1-E2-03): create/kill/restart sessions, identity registry,
// status state machine fed by hook events (ingestion point here; the live
// HookListener wires into it in P1-E2-05). Every transition is logged with
// sessionId (queryable per the E1-05 logging contract) and observable via
// subscription.
import { randomUUID } from 'crypto';
import { ContributionRegistry } from '../extensibility/registry';
import { SpawnRecipe } from '../extensibility/contributions';
import { Logger } from '../log/logger';
import { SessionEvent, SessionStatus, transition } from './state-machine';

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
  /** set by kill()/restart(): the coming exit is intentional, not a crash */
  killRequested?: boolean;
}

/** The slice of PtyService the manager needs — injectable for tests. */
export interface PtyLike {
  spawn(opts: {
    id: string;
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string | undefined>;
  }): {
    pid: number;
    onExit(l: (code: number) => void): () => void;
    kill(): void;
  };
  remove(id: string): void;
}

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
  private readonly history: StatusChange[] = [];

  constructor(
    private readonly registry: ContributionRegistry,
    private readonly ptys: PtyLike,
    private readonly log: Logger,
    private readonly stateDir: string
  ) {}

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
    const record: SessionRecord = {
      id,
      identity,
      status: 'starting',
      createdAt: new Date().toISOString(),
      exitCode: null,
    };
    let proc;
    try {
      proc = this.ptys.spawn({ id, command: recipe.command, args: recipe.args, cwd: identity.folder, env: recipe.env });
    } catch (err) {
      this.log.error('session spawn failed', { sessionId: id, folder: identity.folder, error: String(err) });
      throw err; // no orphan record: it was never added
    }
    this.sessions.set(id, record);
    record.pid = proc.pid;
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
    this.ptys.remove(id);
    this.log.info('session killed', { sessionId: id });
  }

  /** Drop a session record entirely (card closed) — kills the PTY if alive. */
  remove(id: string): void {
    const r = this.sessions.get(id);
    if (!r) return;
    r.killRequested = true;
    this.sessions.delete(id);
    this.log.info('session removed', { sessionId: id });
  }

  restart(id: string): SessionRecord {
    const r = this.mustGet(id);
    r.killRequested = true;
    this.ptys.remove(id);
    this.sessions.delete(id);
    this.log.info('session restarting', { sessionId: id });
    return this.create(r.identity, { resumeSessionId: r.nativeSessionId });
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

  setNativeSessionId(id: string, nativeId: string): void {
    const r = this.sessions.get(id);
    if (r) r.nativeSessionId = nativeId;
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
    case 'exit':
      return `exit:${ev.code}`;
    default:
      return ev.kind;
  }
}
