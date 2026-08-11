// Provider service health (P2-E14-07, §5.14) — the shapes both sides read.
//
// "Is it me or is it them?" has two independent answers and this file carries
// both in ONE record, on purpose:
//
//   • what the provider's own status page says (polled, and often behind
//     reality — status pages lag);
//   • what THIS machine can see (several sessions erroring at once), which
//     leads the page by minutes and is available even when polling is off.
//
// One record because the renderer asks one question. A window with polling
// disabled still gets corroboration, and a window with no local evidence still
// gets the page — neither half is load-bearing for the other.

/** The dot, in four states. `unknown` is a first-class answer, not an error. */
export type ServiceHealthState = 'operational' | 'degraded' | 'outage' | 'unknown';

/**
 * Why the state is what it is. Every non-`ok` reason is a way of NOT knowing,
 * and the point of naming them is that none of them is a failure the user has
 * to do something about: the tooltip says "couldn't check", never "error".
 */
export type ServiceHealthReason =
  | 'ok'
  /** nothing has been asked yet — the first frame of a run */
  | 'never-checked'
  /** the OS says there is no network, so nothing was asked (§5.14, fail-open) */
  | 'offline'
  /** the user turned polling off, or the dev seam did */
  | 'polling-off'
  /** the request never landed: DNS, timeout, refused */
  | 'network'
  /** it landed and made no sense: non-2xx, unparseable, schema moved */
  | 'bad-response';

/** One unresolved incident, reduced to what a tooltip and a notice can use. */
export interface ServiceIncident {
  id: string;
  name: string;
  /** the page's own word: investigating | identified | monitoring | postmortem */
  status: string;
  impact: 'none' | 'minor' | 'major' | 'critical' | 'unknown';
  /** the incident's public page, when it gave one */
  url?: string;
  startedAt?: string;
  updatedAt?: string;
}

/**
 * The local half: N distinct sessions saw an error inside the window.
 *
 * `sessions` is a COUNT, not a list of ids — the banner says "several sessions",
 * and shipping the ids would put session identity into a surface that has no
 * use for it.
 */
export interface ServiceCorroboration {
  sessions: number;
  /** the oldest error still inside the window */
  since: string;
}

/** What main pushes on `health:status`. */
export interface ServiceHealthStatus {
  state: ServiceHealthState;
  reason: ServiceHealthReason;
  /** the page's own summary line, e.g. "All Systems Operational" */
  description?: string;
  incidents: ServiceIncident[];
  /** ISO time of the last completed poll — absent until one completes */
  checkedAt?: string;
  /** null unless the local rule is currently raised */
  corroboration: ServiceCorroboration | null;
}

export interface ServiceHealthPrefs {
  /** poll the provider's status page. Default ON; off changes nothing else. */
  poll: boolean;
}

/** The state a window starts in, before main has said anything. */
export const UNKNOWN_HEALTH: ServiceHealthStatus = {
  state: 'unknown',
  reason: 'never-checked',
  incidents: [],
  corroboration: null,
};
