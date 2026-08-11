// Provider service health, assembled (P2-E14-07, §5.14).
//
// Two inputs, one record, one push channel:
//
//   • the status page, polled on a timer (`statuspage.ts`);
//   • this machine's own evidence, fed from the session stream
//     (`corroboration.ts`).
//
// Everything here is fail-open by construction. Polling off, offline, a dead
// page, a moved schema, a window that is not there — every one of them is a
// quiet `unknown` and a debug line. Nothing in this file can refuse, delay or
// change anything a session does; the whole feature is a dot, a tooltip, a
// notice and a strip.
import {
  ServiceHealthPrefs,
  ServiceHealthStatus,
  ServiceIncident,
  UNKNOWN_HEALTH,
} from '../../shared/service-health';
import { CorroborationOptions, CorroborationTracker, turnOutcome } from './corroboration';
import { probeStatuspage, ProbeDeps, StatuspageProbe } from './statuspage';

/**
 * The floor, and the default: §5.14 says "every few minutes".
 *
 * The live page currently answers `cache-control: max-age=10` — ten seconds,
 * which is a CDN's business and not a desktop app's. So the header is respected
 * in the only direction that is ours to respect: it can make us wait LONGER,
 * never sooner. A page that asks to be cached for an hour gets an hour (up to
 * the ceiling); one that asks for ten seconds still gets five minutes, because
 * polling a public page 360 times an hour from every install is not politeness,
 * it is a small denial of service.
 */
export const MIN_POLL_MS = 5 * 60_000;
/** A silly `max-age` must not turn polling off by accident. */
export const MAX_POLL_MS = 30 * 60_000;

/** `max-age` → the interval we will actually use. */
export function pollIntervalFor(maxAgeMs: number | undefined): number {
  if (!maxAgeMs || !Number.isFinite(maxAgeMs)) return MIN_POLL_MS;
  return Math.min(Math.max(maxAgeMs, MIN_POLL_MS), MAX_POLL_MS);
}

export interface ServiceHealthDeps {
  getPrefs: () => ServiceHealthPrefs;
  /** push the current record to whichever window is live */
  push: (status: ServiceHealthStatus) => void;
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /**
   * Dev/test only (`SWITCHBOARD_STATUS_FEED`): a base URL to poll instead of
   * the real page, or `off` to disable polling entirely. Honoured only in an
   * unpackaged build — main decides that, not this class.
   */
  feedOverride?: string;
  /**
   * Is there a network at all? Electron's `net.isOnline()` in the app. When it
   * says no, nothing is asked — §5.14's "no polling when offline is detected".
   */
  isOnline?: () => boolean;
  now?: () => number;
  /** injected by tests; defaults to the real probe */
  probeImpl?: (deps: ProbeDeps) => Promise<StatuspageProbe>;
  probeDeps?: Pick<ProbeDeps, 'fetchImpl' | 'userAgent'>;
  /** injected by tests to make the window and threshold small */
  corroboration?: CorroborationOptions;
}

/** The fields that decide whether the renderer needs telling again. */
function signature(s: ServiceHealthStatus): string {
  return JSON.stringify([
    s.state,
    s.reason,
    s.description ?? '',
    s.incidents.map((i) => `${i.id}:${i.status}:${i.impact}`),
    s.corroboration ? s.corroboration.sessions : 0,
  ]);
}

export class ServiceHealthService {
  private status: ServiceHealthStatus = { ...UNKNOWN_HEALTH };
  private timer: NodeJS.Timeout | null = null;
  private sweep: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private readonly tracker: CorroborationTracker;
  /** the incident ids the last push knew about — the transition witness */
  private knownIncidents = new Set<string>();

  constructor(private readonly deps: ServiceHealthDeps) {
    this.tracker = new CorroborationTracker(deps.corroboration);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** `off` from the dev seam is a switch, not a feed. */
  private overrideOff(): boolean {
    return this.deps.feedOverride?.trim() === 'off';
  }

  private pollingOn(): boolean {
    if (this.overrideOff()) return false;
    try {
      return this.deps.getPrefs().poll !== false;
    } catch {
      // a store that cannot answer is not a reason to stop working
      return true;
    }
  }

  /** The record as it stands. The renderer's first read on mount. */
  current(): ServiceHealthStatus {
    return { ...this.status, incidents: [...this.status.incidents] };
  }

  /**
   * Start polling. Safe to call twice; does nothing when polling is off, and
   * the first poll runs immediately so a window that mounts into an incident
   * is not five minutes behind.
   */
  start(): void {
    if (this.stopped || this.timer) return;
    if (!this.pollingOn()) {
      this.applyProbe({
        state: 'unknown',
        reason: 'polling-off',
        incidents: [],
        checkedAt: new Date(this.now()).toISOString(),
      });
      return;
    }
    void this.refresh();
  }

  /**
   * The polling preference changed under us — start or stop accordingly.
   *
   * Turning polling OFF does not touch the local half: corroboration makes no
   * network call and is the half that leads the page, so the switch that means
   * "stop talking to the internet" must not also blind the app to its own
   * sessions. That is why the record keeps its `corroboration` here.
   */
  prefsChanged(): void {
    if (this.stopped) return;
    if (this.pollingOn()) {
      void this.refresh();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.knownIncidents = new Set();
    this.applyProbe({
      state: 'unknown',
      reason: 'polling-off',
      incidents: [],
      checkedAt: new Date(this.now()).toISOString(),
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.sweep) clearTimeout(this.sweep);
    this.timer = null;
    this.sweep = null;
  }

  /**
   * One poll, now. Never rejects.
   *
   * Coalesced: a manual refresh landing on top of a scheduled one joins it
   * rather than opening a second socket.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.poll().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (!this.pollingOn()) {
      this.applyProbe({
        state: 'unknown',
        reason: 'polling-off',
        incidents: [],
        checkedAt: new Date(this.now()).toISOString(),
      });
      return;
    }
    // Offline: ask nothing, say "unknown", and keep the timer running so the
    // dot comes back on its own when the network does.
    if (this.deps.isOnline && !safeOnline(this.deps)) {
      this.deps.log.debug?.('provider status: offline, skipping the poll');
      this.applyProbe({
        state: 'unknown',
        reason: 'offline',
        incidents: [],
        checkedAt: new Date(this.now()).toISOString(),
      });
      this.schedule(MIN_POLL_MS);
      return;
    }

    const base = this.overrideOff() ? undefined : this.deps.feedOverride?.trim() || undefined;
    let probe: StatuspageProbe;
    try {
      const impl = this.deps.probeImpl ?? probeStatuspage;
      probe = await impl({
        ...this.deps.probeDeps,
        ...(base ? { base } : {}),
        now: () => new Date(this.now()),
        log: (msg, meta) => this.deps.log.debug?.(msg, meta),
      });
    } catch (err) {
      // `probeStatuspage` does not throw; a stubbed one might, and an unhandled
      // rejection in main is an error modal — the opposite of fail-open.
      this.deps.log.warn('provider status poll threw', { error: String(err) });
      probe = {
        state: 'unknown',
        reason: 'network',
        incidents: [],
        checkedAt: new Date(this.now()).toISOString(),
      };
    }
    this.applyProbe(probe);
    this.schedule(pollIntervalFor(probe.maxAgeMs));
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, ms);
    // never hold the process open for a status dot
    this.timer.unref?.();
  }

  // ── the local half ────────────────────────────────────────────────────────

  /**
   * A stream message from some session. Only a `result` says anything, and
   * only its error-ness is read — see `turnOutcome`.
   */
  noteStreamMessage(sessionId: string, msg: unknown): void {
    const outcome = turnOutcome(msg);
    if (outcome === null) return;
    if (outcome) this.tracker.noteError(sessionId, this.now());
    else this.tracker.noteRecovery(sessionId);
    this.evaluateLocal();
  }

  /** A session is gone — its evidence goes with it. */
  forgetSession(sessionId: string): void {
    this.tracker.forget(sessionId);
    this.evaluateLocal();
  }

  private evaluateLocal(): void {
    const v = this.tracker.evaluate(this.now());
    const next = v.raised ? { sessions: v.sessions, since: v.since! } : null;
    const was = this.status.corroboration;
    this.status = { ...this.status, corroboration: next };
    if (next && !was) {
      this.deps.log.info('several sessions errored in a short window', {
        sessions: next.sessions,
      });
    } else if (!next && was) {
      this.deps.log.info('the sessions that were erroring have recovered');
    }
    // Raised evidence expires on its own; without this the banner would sit
    // there until the next error or the next poll happened to knock it down.
    if (next && !this.sweep && !this.stopped) {
      this.sweep = setTimeout(() => {
        this.sweep = null;
        this.evaluateLocal();
      }, 30_000);
      this.sweep.unref?.();
    }
    this.pushIfChanged();
  }

  // ── assembling and announcing ─────────────────────────────────────────────

  private applyProbe(probe: StatuspageProbe): void {
    this.status = {
      state: probe.state,
      reason: probe.reason,
      ...(probe.description ? { description: probe.description } : {}),
      incidents: probe.incidents,
      ...(probe.reason === 'polling-off' ? {} : { checkedAt: probe.checkedAt }),
      // the local half is independent of the page and survives every poll
      corroboration: this.status.corroboration,
    };
    this.noteIncidentTransitions(probe.incidents, probe.reason);
    this.pushIfChanged();
  }

  /**
   * Incidents that appeared or went away since the last poll.
   *
   * Logged in main and — because the record itself is what the renderer draws —
   * carried to the Events surface by the push below. §5.14 asks for "incident
   * start/resolve emits Feed events"; the feed is one-item-per-session by
   * construction (§5.12, `events/feed.ts`), and a provider incident belongs to
   * no session. So it rides the same road the update notice and the reconnect
   * offer already ride: a notice in the Events panel, pushed on its own channel.
   * See the item's hand-off for why that beat inventing a sessionless FeedEvent.
   */
  private noteIncidentTransitions(incidents: ServiceIncident[], reason: string): void {
    // A failed poll knows nothing: "unknown" must not be read as "resolved", or
    // a flaky network would announce an incident resolving every few minutes.
    if (reason !== 'ok') return;
    const now = new Set(incidents.map((i) => i.id));
    for (const i of incidents) {
      if (!this.knownIncidents.has(i.id)) {
        this.deps.log.info('provider incident opened', { id: i.id, name: i.name, impact: i.impact });
      }
    }
    for (const id of this.knownIncidents) {
      if (!now.has(id)) this.deps.log.info('provider incident resolved', { id });
    }
    this.knownIncidents = now;
  }

  private lastPushed = '';
  private pushIfChanged(): void {
    const sig = signature(this.status);
    if (sig === this.lastPushed) return;
    this.lastPushed = sig;
    try {
      this.deps.push(this.current());
    } catch (err) {
      // no window, a destroyed one, a crashed renderer — none of them is this
      // feature's problem to solve
      this.deps.log.debug?.('provider status push failed', { error: String(err) });
    }
  }
}

function safeOnline(deps: ServiceHealthDeps): boolean {
  try {
    return deps.isOnline!() !== false;
  } catch {
    // an online check that throws is not evidence of being offline
    return true;
  }
}
