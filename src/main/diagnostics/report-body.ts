// Compose the text a filed issue actually carries (#815).
//
// The user's description goes FIRST and untouched — it is the part a human
// wrote and the part a human will read. Everything we add goes below it, under
// a heading, so the report never buries its own point.
//
// WHAT IS INLINED, AND WHY IT IS THIS AND NOT THE LOG. The API cannot attach
// the zip (see `github-issue.ts`), so the useful facts have to travel as text.
// But pasting arbitrary log lines into an issue would paste FOLDER PATHS AND
// COMMAND LINES — `docs/manual/11-troubleshooting.md` says as much about what
// logs contain. So exactly two things are inlined:
//
//   • the build/machine facts, which are what every bug report needs and
//     nobody remembers to include;
//   • the `cpu heartbeat` lines #719 writes, filtered to the WARN ones.
//
// The heartbeat lines are safe to inline by construction: they carry process
// types, pids, core counts and timings. THE FIELD TO WATCH IS `name` — it comes
// from `app.getAppMetrics()`, and Electron fills it from the window/frame
// title. Both of ours are static today, so nothing user-identifying escapes;
// the day anyone sets `document.title` to a session or project name, project
// names start travelling into issue bodies silently. Named here rather than
// left as "no paths", because `name` is the one that could change under us.
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { BuildIdentity } from '../../shared/build-identity';
import { summaryAsText, type PerfSummary } from '../../shared/perf';

/** how many warn-level heartbeats to carry; enough to show a shape, not a wall */
export const MAX_HEARTBEAT_LINES = 12;

/**
 * GitHub rejects an issue body over 65,536 characters with a 422 — which would
 * reach the user as a flat "GitHub refused the report".
 *
 * The thing most likely to blow it is the most likely thing anyone does in a
 * box labelled "what happened": paste a log into it. Truncating with a visible
 * marker beats a refusal the user cannot act on.
 */
export const MAX_DESCRIPTION_CHARS = 60_000;

const clampDescription = (s: string): string =>
  s.length <= MAX_DESCRIPTION_CHARS
    ? s
    : `${s.slice(0, MAX_DESCRIPTION_CHARS)}\n\n_…truncated: ${s.length - MAX_DESCRIPTION_CHARS} more characters were not sent._`;

export interface ReportBodyDeps {
  /** what the user typed. Posted verbatim. */
  description: string;
  version: string;
  identity: BuildIdentity;
  logsDir: string;
  /** where the zip landed, so the reader knows one exists and where */
  bundlePath: string | null;
  uptimeMs: number;
  now?: () => Date;
  maxHeartbeats?: number;
  /**
   * E21's responsiveness numbers, off the draft (#927). Absent when the bridge
   * could not supply them, which prints a sentence rather than nothing.
   */
  perf?: PerfSummary;
}

/**
 * The busiest minutes #719's heartbeat recorded, most recent last.
 *
 * Reads the live log whole rather than seeking: it is bounded at 5 MB by the
 * sink, and this runs once, when a human pressed a button. Fail-open — no log,
 * an unreadable log, or a log with no warnings all produce an empty list and a
 * sentence saying so, never an exception into the report path.
 */
export function recentBusyMinutes(logsDir: string, max = MAX_HEARTBEAT_LINES): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(logsDir, 'switchboard.log'), 'utf8');
  } catch {
    return [];
  }
  const hits = raw
    .split('\n')
    .filter((l) => l.includes('"msg":"cpu heartbeat"') && l.includes('"level":"warn"'));
  return hits.slice(-max);
}

/** The issue body. */
export function composeIssueBody(deps: ReportBodyDeps): string {
  const at = (deps.now ?? (() => new Date()))();
  const id = deps.identity;
  const out: string[] = [];

  const described = clampDescription(deps.description.trim());
  out.push(described.length > 0 ? described : '_(no description given)_');

  out.push('', '---', '', '### Build and machine', '', '```');
  out.push(`version:       ${deps.version}`);
  out.push(`commit:        ${id.commit ?? 'unknown'}${id.dirty ? ' (dirty tree)' : ''}`);
  out.push(`branch:        ${id.branch ?? 'unknown'}`);
  out.push(`built:         ${id.builtAt ?? 'unknown'}`);
  out.push(`collected:     ${at.toISOString()}`);
  out.push(`app uptime:    ${Math.round(deps.uptimeMs / 1000)}s`);
  out.push(`platform:      ${process.platform} ${os.release()} (${process.arch})`);
  out.push(`logical cores: ${os.cpus().length}`);
  out.push(`electron:      ${process.versions.electron ?? 'n/a'}`);
  out.push('```');

  const busy = recentBusyMinutes(deps.logsDir, deps.maxHeartbeats ?? MAX_HEARTBEAT_LINES);
  out.push('', '### Recent busy minutes (CPU heartbeat, warnings only)', '');
  if (busy.length === 0) {
    // Said explicitly. "No warnings recorded" and "we failed to look" are
    // different facts, and a silent empty section reads as the first while
    // possibly being the second.
    out.push('_None recorded in the current log — either nothing was busy, or the log has rotated._');
  } else {
    out.push('```json');
    out.push(...busy);
    out.push('```');
  }

  // ── Responsiveness (#927) ───────────────────────────────────────────────
  //
  // ABOVE the bundle section on purpose. The zip cannot be attached through the
  // API, so the body is the only part of a report that travels by itself — and
  // for the report this project most wants to receive ("it feels slow"), these
  // numbers are the whole point. Making the reader fetch a file before they can
  // say anything at all is what this section exists to stop.
  //
  // Safe to inline by construction, and by a different argument from the
  // heartbeat lines above: every value is a duration or a count, and every name
  // comes from the closed `PERF_INTERACTIONS` tuple. There is no field here
  // that a path, a prompt or a session title could reach — `report-body.test`
  // asserts that by walking the rendered text, not by reading it.
  out.push('', '### Responsiveness', '');
  if (deps.perf) {
    out.push('```');
    out.push(summaryAsText(deps.perf));
    out.push('```');
  } else {
    // Said out loud: "we could not collect them" is a different fact from
    // "nothing was slow", and a silent omission reads as the second.
    out.push('_Not collected — the app could not read its own performance counters._');
  }

  out.push('', '### Diagnostic bundle', '');
  if (deps.bundlePath) {
    // The honest sentence. GitHub's API cannot attach a file, so the zip is on
    // the reporter's disk and someone has to drag it on. Saying where it is
    // beats implying it came along.
    out.push(`A zip of the logs, \`workspace.json\` and build info was written to:`);
    out.push('', `\`${deps.bundlePath}\``, '');
    out.push('It is **not attached** — GitHub only accepts attachments through the web form.');
    out.push('Drag the file onto this issue to attach it.');
  } else {
    out.push('_The bundle could not be written; see the app log._');
  }

  out.push('', '<sub>Filed from switchboard.ai — Help ▸ Report a problem…</sub>');
  return out.join('\n');
}
