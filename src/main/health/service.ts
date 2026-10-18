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
import { errorText } from '../../shared/error-text';
import {
  ServiceHealthPrefs,
  ServiceHealthStatus,
  ServiceIncident,
  UNKNOWN_HEALTH,
} from '../../shared/service-health';
import { CorroborationOptions, CorroborationTracker } from './corroboration';
import type { EngineEvent } from '../sessions/engine-events';
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

/**
 * How often a RAISED corroboration re-checks itself.
 *
 * Evidence expires on the clock, not on an event, so without a tick of its own
 * the banner would sit there until the next error or the next poll happened to
 * knock it down. Thirty seconds is a tenth of the five-minute window: fine
 * enough that "it cleared a moment ago" is true, coarse enough to be free. It
 * runs only while the rule is raised.
 */
export const CORROBORATION_SWEEP_MS = 30_000;

/** `max-age` → the interval we will actually use. */
export function pollIntervalFor(maxAgeMs: number | undefined): number {
  if (!maxAgeMs || !Number.isFinite(maxAgeMs)) return MIN_POLL_MS;
  return Math.min(Math.max(maxAgeMs, MIN_POLL_MS), MAX_POLL_MS);
}

/**
 * Which page to poll, asked of the provider whose dot this is (#1288): the
 * DEFAULT provider, the one a new session starts on. `none` when that AI
 * publishes no status page, and then nothing is fetched at all.
 */
export type StatusPageTarget =
  /** `name`: whose page it is, for the state words ("Anthropic: …", #1316) */
  | { base: string; name?: string }
  | { none: true; providerName: string };

export interface ServiceHealthDeps {
  getPrefs: () => ServiceHealthPrefs;
  /**
   * Asked on every poll, so a change of default provider is picked up without
   * a restart. A throw reads as "no page" for a provider we could not name.
   */
  statusPage: () => StatusPageTarget;
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

/**
 * The fields that decide whether the renderer needs telling again.
 *
 * `checkedAt` is IN it: the tooltip says when we last looked, and a record that
 * only pushed on a change of VERDICT would leave that line reading 09:12 at
 * five in the afternoon. It costs one push per poll, i.e. one every five
 * minutes. What the check is really for is the local half — corroboration
 * re-evaluates on every `result` message in the workspace, and `checkedAt` does
 * not move on that path, so the dedupe still does its job where it matters.
 */
function signature(s: ServiceHealthStatus): string {
  return JSON.stringify([
    s.state,
    s.reason,
    s.description ?? '',
    s.checkedAt ?? '',
    s.incidents.map((i) => `${i.id}:${i.status}:${i.impact}`),
    s.corroboration ? s.corroboration.sessions : 0,
    s.providerName ?? '',
    s.pageName ?? '',
  ]);
}

export class ServiceHealthService {
  private status: ServiceHealthStatus = { ...UNKNOWN_HEALTH };
  /**
   * Whose page the last target was (#1316), carried on every record about it
   * so the state words name it. Cleared when the default AI has no page.
   */
  private pageName: string | undefined;
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
    if (!this.pollingOn()) return this.goDark('polling-off');
    void this.refresh();
  }

  /**
   * Stop knowing, for a reason that is nobody's fault.
   *
   * ONE path to "unknown because we did not ask", so the polling-off branches in
   * `start`, `poll` and `prefsChanged` cannot drift apart — and the incident
   * memory is cleared in all three, because a list we have stopped refreshing
   * is a list that will be wrong soon.
   */
  private goDark(reason: 'polling-off' | 'offline'): void {
    this.knownIncidents = new Set();
    this.resolveTarget();
    if (reason === 'polling-off') {
      // The user said stop looking, so what we last saw stops being a claim:
      // the Events card and the tooltip's incident list are drawn from this
      // record, and an incident we will never refresh would sit there for the
      // rest of the run — outliving the fact, with nothing able to clear it.
      //
      // OFFLINE is the other way round and falls through to `applyProbe`, which
      // keeps them: we still believe what the page told us, we just cannot ask
      // again for the moment.
      this.status = {
        state: 'unknown',
        reason,
        incidents: [],
        ...this.named(),
        corroboration: this.status.corroboration,
      };
      this.pushIfChanged();
      return;
    }
    this.applyProbe({ state: 'unknown', reason, incidents: [], checkedAt: '' });
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
    this.goDark('polling-off');
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
    const run = this.poll()
      // The promise above, kept. `poll` guards the probe itself, but the log
      // calls around it are somebody else's code and every caller here is a
      // `void` — an unhandled rejection in main is an "A JavaScript error
      // occurred" modal, the exact opposite of what this feature promises.
      .catch(() => {})
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (!this.pollingOn()) return this.goDark('polling-off');
    // WHICH page (#1288). The dev seam's URL wins, so a test stub is polled
    // whatever the provider says; otherwise it is the provider's own, and a
    // provider with none is never asked anything — no request, no timer worth
    // the name, and a tooltip that says why.
    const target = this.resolveTarget();
    if ('none' in target) {
      this.noStatusPage(target.providerName);
      // Cheap — nothing leaves the machine — and it is how a change of
      // default provider to one WITH a page is noticed without a restart.
      this.schedule(MIN_POLL_MS);
      return;
    }
    const base = target.base;
    // Offline: ask nothing, say "unknown", and keep the timer running so the
    // dot comes back on its own when the network does.
    if (this.deps.isOnline && !safeOnline(this.deps)) {
      this.deps.log.debug?.('provider status: offline, skipping the poll');
      this.goDark('offline');
      this.schedule(MIN_POLL_MS);
      return;
    }

    let probe: StatuspageProbe;
    try {
      const impl = this.deps.probeImpl ?? probeStatuspage;
      probe = await impl({
        ...this.deps.probeDeps,
        base,
        now: () => new Date(this.now()),
        log: (msg, meta) => this.deps.log.debug?.(msg, meta),
      });
    } catch (err) {
      // `probeStatuspage` does not throw; a stubbed one might, and an unhandled
      // rejection in main is an error modal — the opposite of fail-open.
      this.deps.log.warn('provider status poll threw', { error: errorText(err) });
      probe = {
        state: 'unknown',
        reason: 'network',
        incidents: [],
        checkedAt: new Date(this.now()).toISOString(),
      };
    }
    // The world moved while we were on the wire. Stopping, or switching polling
    // off, must not be undone by an answer that was already in flight: without
    // this, unticking the box puts the dot back to green for up to five minutes
    // and re-arms the timer that was just killed.
    if (this.stopped || !this.pollingOn()) return;
    this.applyProbe(probe);
    this.schedule(pollIntervalFor(probe.maxAgeMs));
  }

  /**
   * Which page to ask, with the dev seam applied, and — as a side effect —
   * the name the state words use for it (#1316). Cheap and offline: it only
   * asks the registry, so `goDark` calls it too, and a change of default AI
   * while polling is off still renames the record.
   */
  private resolveTarget(): StatusPageTarget {
    const override = this.overrideOff() ? undefined : this.deps.feedOverride?.trim() || undefined;
    const own = this.target();
    // The override moves WHERE we ask. The words still name the default AI's
    // page owner, or the AI itself when it has no page (a dev-only stub then
    // reads "Codex: …", which is the AI the stub stands in for).
    const target: StatusPageTarget = override
      ? { base: override, name: 'none' in own ? own.providerName || undefined : own.name }
      : own;
    this.pageName = 'none' in target ? undefined : target.name || undefined;
    return target;
  }

  /** The provider's answer, fail-open: a throw is "no page we can name". */
  private target(): StatusPageTarget {
    try {
      const t = this.deps.statusPage();
      if ('base' in t && typeof t.base === 'string' && t.base) {
        return { base: t.base, ...(typeof t.name === 'string' && t.name ? { name: t.name } : {}) };
      }
      if ('none' in t) return { none: true, providerName: t.providerName };
    } catch (err) {
      this.deps.log.warn('provider status: could not ask which page to poll', {
        error: errorText(err),
      });
    }
    return { none: true, providerName: '' };
  }

  /**
   * This AI publishes no status page (#1288). `unknown`, like every other way
   * of not knowing, with its own reason so the tooltip can say which way. The
   * local half — sessions here failing together — keeps working: it never
   * needed the page.
   */
  private noStatusPage(providerName: string): void {
    this.knownIncidents = new Set();
    this.status = {
      state: 'unknown',
      reason: 'no-status-page',
      incidents: [],
      ...(providerName ? { providerName } : {}),
      corroboration: this.status.corroboration,
    };
    this.pushIfChanged();
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
   * A neutral event from some session (#1286). Only the end of a turn says
   * anything, and only whether it failed is read. Which of an engine's frames
   * counts as a failed turn is the engine's translator's decision (Claude's:
   * `turnOutcome` in `providers/claude-events.ts`); every other event is "not
   * a verdict", which must not be confused with a good one — or every chunk
   * would count as a recovery.
   */
  noteEvent(sessionId: string, ev: EngineEvent): void {
    if (ev.type !== 'turn-end') return;
    if (ev.failed) this.tracker.noteError(sessionId, this.now());
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
    const next = v.raised ? { sessions: v.sessions } : null;
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
      }, CORROBORATION_SWEEP_MS);
      this.sweep.unref?.();
    }
    this.pushIfChanged();
  }

  // ── assembling and announcing ─────────────────────────────────────────────

  /** The page's owner, as a record field — absent when nobody named it. */
  private named(): { pageName?: string } {
    return this.pageName ? { pageName: this.pageName } : {};
  }

  private applyProbe(probe: StatuspageProbe): void {
    // Did the page actually answer? Only then do the incident list and the
    // "checked at" line mean anything.
    //
    // A blip must not RESOLVE an incident. `noteIncidentTransitions` already
    // refuses to log one resolving off a failed poll; without the same rule
    // here the surfaces the user reads would flicker anyway — the Events card
    // and the tooltip's incident list vanishing on one lost packet in the
    // middle of a real outage, and coming back on the next poll. `checkedAt`
    // is the same promise: a check that never happened must not move it.
    const answered = probe.reason === 'ok' || probe.reason === 'bad-response';
    const checkedAt = (answered && probe.checkedAt) || this.status.checkedAt;
    this.status = {
      state: probe.state,
      reason: probe.reason,
      ...(probe.description ? { description: probe.description } : {}),
      incidents: answered ? probe.incidents : this.status.incidents,
      ...(checkedAt ? { checkedAt } : {}),
      ...this.named(),
      // the local half is independent of the page and survives every poll
      corroboration: this.status.corroboration,
    };
    this.noteIncidentTransitions(this.status.incidents, probe.reason);
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
      this.deps.log.debug?.('provider status push failed', { error: errorText(err) });
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
