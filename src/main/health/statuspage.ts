// One poll of the provider's public status page (P2-E14-07, §5.14).
//
// One function, two GETs, one plain record — the `update/checker.ts` shape, and
// for the same reason: this file reports facts, `service.ts` decides what to do
// with them, and the renderer decides what the user reads.
//
// ── what this may talk to ───────────────────────────────────────────────────
//
// The provider's Statuspage host, read-only, outbound, unauthenticated. Nothing
// is sent — no session data, no identifiers, no counts. That is the whole of
// the network surface this feature adds, and it is the reason §5.14 survives
// the local-first constraint: asking a public page whether it is having a day
// is not telemetry, because the traffic only goes one way.
//
// ── the endpoints, and the redirect ─────────────────────────────────────────
//
// Statuspage's v2 JSON API is a published convention:
//   • `/api/v2/status.json`               → `{ status: { indicator, description } }`
//   • `/api/v2/incidents/unresolved.json` → `{ incidents: [...] }`
//
// DESIGN §5.14 names `status.anthropic.com`. As of 2026-08-11 that host answers
// **302 → status.claude.com** for both paths (verified against the live page
// while building this), so `redirect: 'follow'` is not optional — without it
// every poll reads an HTML redirect body and the dot sits on "unknown" forever.
// The base stays the DESIGN one: it is the documented address, and following
// its own redirect is how a rename is supposed to be absorbed.
import {
  ServiceHealthReason,
  ServiceHealthState,
  ServiceIncident,
} from '../../shared/service-health';

/** The page DESIGN §5.14 names. Overridable — see `SERVICE_STATUS_FEED_ENV`. */
export const STATUSPAGE_BASE = 'https://status.anthropic.com';

/**
 * Dev/test only, and honoured only in an unpackaged build: point the poller at
 * a local stub, or `off` to disable it entirely. The rule is P2-E15-10's — a
 * shipped binary has no environment variable that can move a user-visible
 * endpoint. Tests NEVER reach the live page.
 */
export const SERVICE_STATUS_FEED_ENV = 'SWITCHBOARD_STATUS_FEED';

/** How long the page gets before we give up and call it a network failure. */
export const REQUEST_TIMEOUT_MS = 8_000;

/** A name or a page summary long enough to be an attack on the tooltip. */
const MAX_TEXT = 300;
/** More unresolved incidents than this is a page having a very bad day; the
 *  tooltip cannot show them all and the extras cost memory for nothing. */
const MAX_INCIDENTS = 10;
/** An ISO-8601 timestamp is 24 characters; anything past this is not one. */
const MAX_TIMESTAMP = 64;

export interface StatuspageProbe {
  state: ServiceHealthState;
  reason: ServiceHealthReason;
  description?: string;
  incidents: ServiceIncident[];
  checkedAt: string;
  /**
   * What the page's own cache headers say a copy stays fresh for, in ms, if it
   * said anything readable. `service.ts` decides what to do with it — this file
   * only reports what was on the wire.
   */
  maxAgeMs?: number;
}

export interface ProbeDeps {
  /** overridable for tests and the dev seam; defaults to the real page */
  base?: string;
  /** injected in unit tests; defaults to the runtime's own fetch */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** debug/warn only — this path never reports itself to the user */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** the app's version, for the User-Agent. Courtesy, not identity. */
  userAgent?: string;
}

/**
 * Statuspage's `indicator` → our four states.
 *
 * `maintenance` reads as degraded rather than operational: planned or not, a
 * component is down, and a green dot during a maintenance window is the dot
 * lying about the thing the user is asking it. An indicator we have never seen
 * is `unknown` — a schema that moved must not be read as "all fine".
 */
export function mapIndicator(indicator: unknown): ServiceHealthState {
  switch (indicator) {
    case 'none':
      return 'operational';
    case 'minor':
    case 'maintenance':
      return 'degraded';
    case 'major':
    case 'critical':
      return 'outage';
    default:
      return 'unknown';
  }
}

/** `cache-control: max-age=10, public, s-maxage=10` → 10_000. */
export function parseMaxAgeMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const m = /(?:^|[,\s])max-age\s*=\s*(\d+)/i.exec(header);
  if (!m) return undefined;
  const secs = Number(m[1]);
  if (!Number.isFinite(secs) || secs < 0) return undefined;
  return secs * 1000;
}

function text(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v ? v.slice(0, MAX_TEXT) : fallback;
}

function impactOf(v: unknown): ServiceIncident['impact'] {
  return v === 'none' || v === 'minor' || v === 'major' || v === 'critical' ? v : 'unknown';
}

/** The `incidents` array, read tolerantly. Anything unreadable is skipped. */
export function readIncidents(body: unknown): ServiceIncident[] {
  const list = (body as { incidents?: unknown })?.incidents;
  if (!Array.isArray(list)) return [];
  const out: ServiceIncident[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const i = raw as Record<string, unknown>;
    // An incident with no id is one we cannot tell apart from the next one, and
    // "is this the same incident as last poll" is the whole of the transition
    // logic. Skipped rather than given a synthetic id.
    const id = text(i.id);
    if (!id) continue;
    out.push({
      id,
      name: text(i.name, id),
      status: text(i.status, 'unknown'),
      impact: impactOf(i.impact),
      ...(typeof i.shortlink === 'string' && i.shortlink ? { url: i.shortlink.slice(0, MAX_TEXT) } : {}),
      ...(typeof i.created_at === 'string'
        ? { startedAt: i.created_at.slice(0, MAX_TIMESTAMP) }
        : {}),
      ...(typeof i.updated_at === 'string'
        ? { updatedAt: i.updated_at.slice(0, MAX_TIMESTAMP) }
        : {}),
    });
    if (out.length >= MAX_INCIDENTS) break;
  }
  return out;
}

/**
 * Ask the page how it is. **Never throws, never rejects.**
 *
 * Every failure — a dead socket, a 500, an HTML body where JSON was promised, a
 * schema that moved under us — lands on `unknown` with a reason and one debug
 * line. There is no branch in this file that produces something the user has to
 * dismiss (§5.14's "never an error that nags").
 */
export async function probeStatuspage(deps: ProbeDeps = {}): Promise<StatuspageProbe> {
  const now = deps.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const base = (deps.base ?? STATUSPAGE_BASE).replace(/\/+$/, '');
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const unknown = (reason: ServiceHealthReason): StatuspageProbe => ({
    state: 'unknown',
    reason,
    incidents: [],
    checkedAt,
  });

  if (typeof doFetch !== 'function') return unknown('network');

  // Two headers, and that is the entire outbound payload: what we will accept,
  // and who is asking. The User-Agent is the app name and its version — the
  // courtesy a public JSON API is owed, and nothing that identifies a person, a
  // machine or a session. No cookies (none are sent: `fetch` defaults to
  // `credentials: 'same-origin'` and this is cross-origin), no query string, no
  // body, no second request that could correlate one poll with another.
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': `switchboard.ai/${deps.userAgent ?? 'dev'}`,
  };

  // AbortController rather than a bare race: a poll that has given up must also
  // stop the socket, or a stalled page leaks one connection every few minutes.
  // The deadline covers the BODY as well as the headers — `clearTimeout` sits
  // in the `finally` for exactly that reason (the lesson `update/checker.ts`
  // wrote down: a 200 that then stalls its body would otherwise hang forever).
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    const get = async (path: string): Promise<{ body: unknown; res: Response } | null> => {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, { headers, signal: abort.signal, redirect: 'follow' });
      } catch (err) {
        deps.log?.('provider status: could not reach the status page', { error: String(err), path });
        return null;
      }
      if (!res.ok) {
        deps.log?.('provider status: the status page refused', { status: res.status, path });
        return null;
      }
      try {
        return { body: await res.json(), res };
      } catch (err) {
        // An aborted body read lands here too, which is right: a page that
        // stopped mid-answer told us nothing usable.
        deps.log?.('provider status: unreadable answer', { error: String(err), path });
        return null;
      }
    };

    const status = await get('/api/v2/status.json');
    if (!status) return unknown('network');

    const indicator = (status.body as { status?: { indicator?: unknown; description?: unknown } })
      ?.status;
    if (!indicator || typeof indicator !== 'object') {
      deps.log?.('provider status: the answer had no status block');
      return unknown('bad-response');
    }
    const state = mapIndicator(indicator.indicator);
    if (state === 'unknown') {
      deps.log?.('provider status: unrecognised indicator', { indicator: String(indicator.indicator) });
    }

    // The second GET is ADDITIVE: an incident list we could not read leaves the
    // dot on the colour the first answer earned. The page's own summary is the
    // load-bearing half, and losing the detail must not lose the verdict.
    const unresolved = await get('/api/v2/incidents/unresolved.json');
    const incidents = unresolved ? readIncidents(unresolved.body) : [];

    return {
      state,
      reason: state === 'unknown' ? 'bad-response' : 'ok',
      description: text(indicator.description) || undefined,
      incidents,
      checkedAt,
      maxAgeMs: parseMaxAgeMs(status.res.headers.get('cache-control')),
    };
  } finally {
    clearTimeout(timer);
  }
}
