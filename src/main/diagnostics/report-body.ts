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
import {
  MAX_ISSUE_URL_CHARS,
  clampEncoded,
  flattenControls,
  issueFormHead,
  wellFormed,
} from '../../shared/feedback';

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

/** The issue body, as the API path POSTs it. */
export function composeIssueBody(deps: ReportBodyDeps): string {
  const out: string[] = [];

  const described = clampDescription(deps.description.trim());
  out.push(described.length > 0 ? described : '_(no description given)_');

  out.push('', '---', ...diagnosticSections(deps));

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

/** What the browser path produced: the form URL, or why there is none. */
export type BrowserIssue = { ok: true; url: string } | { ok: false; problem: 'too-long' };

export interface BrowserIssueDeps extends ReportBodyDeps {
  /** the subject the user typed — the form's title */
  title: string;
  /** defaults to Feature request's cap, `MAX_ISSUE_URL_CHARS` */
  maxUrlChars?: number;
}

/**
 * GitHub's pre-filled new-issue form, for a machine with no credential (#1494).
 *
 * The repo is public, so anyone signed in to GitHub in their browser can file
 * through the form with no token at all. The URL is built from parts, and the
 * user's are never the ones that shrink:
 *
 *   • the user's title and description — NEVER trimmed (a title past GitHub's
 *     comfortable width is clipped, as Feature request's is). If they alone do
 *     not fit, the answer is `too-long` and the dialog keeps the words, because
 *     a report cut off mid-sentence reads like a person who stopped typing.
 *   • the "drag the zip onto this issue" line, which goes FIRST after the
 *     user's words. A URL cannot carry a file, so this is the only way the
 *     evidence gets there, and it must not be the part a clamp removes.
 *   • the diagnostics, trimmed BY SECTION, not by character. Build and
 *     Responsiveness are small and bounded and go first; Responsiveness is the
 *     point of a "it feels slow" report (#927), and the long JSON heartbeat
 *     lines would otherwise fill the link and push it out. The busy minutes
 *     come last, keeping the most recent lines that fit, with their code fence
 *     always closed so the note after it reads as a note.
 *
 * Never throws: lone surrogates in the user's text are replaced first, so
 * `encodeURIComponent` has nothing to refuse.
 */
export function composeBrowserIssue(deps: BrowserIssueDeps): BrowserIssue {
  const budget = deps.maxUrlChars ?? MAX_ISSUE_URL_CHARS;
  const typedTitle = wellFormed(flattenControls(deps.title).trim());
  const title =
    typedTitle.length > MAX_BROWSER_TITLE_CHARS
      ? `${wellFormed(typedTitle.slice(0, MAX_BROWSER_TITLE_CHARS - 3))}...`
      : typedTitle;
  const head = issueFormHead(title);

  const described = wellFormed(deps.description.trim());
  const attach = deps.bundlePath
    ? [
        '> **Before you submit:** drag the diagnostic zip onto this issue to attach it.',
        `> It was written to \`${deps.bundlePath}\` and is open in your file manager.`,
      ]
    : ['> _The diagnostic zip could not be written; see the app log._'];
  const lead = [
    described.length > 0 ? described : '_(no description given)_',
    '',
    '---',
    '',
    ...attach,
  ].join('\n');
  const footer = '\n\n<sub>Filed from switchboard.ai — Help ▸ Report a problem… (browser)</sub>';

  const enc = (t: string): number => encodeURIComponent(t).length;
  const fixed = head.length + enc(lead) + enc(footer);
  if (fixed > budget) return { ok: false, problem: 'too-long' };

  const note = `\n\n_…some diagnostics did not fit in a link.${
    deps.bundlePath ? ' The full version is in the zip.' : ''
  }_`;
  const url = (diagnostics: string): string =>
    head + encodeURIComponent(lead + diagnostics + footer);

  // Every line starts with '\n' so it follows the lead's blockquote with a
  // blank line, whichever sections survive.
  const always = ['', ...buildSection(deps), ...responsivenessSection(deps)].join('\n');
  const busy = recentBusyMinutes(deps.logsDir, deps.maxHeartbeats ?? MAX_HEARTBEAT_LINES);

  // Most lines first: keep dropping the OLDEST heartbeat until the rest fit.
  for (let keep = busy.length; keep >= 0; keep--) {
    const kept = busy.slice(busy.length - keep);
    const trimmed = keep < busy.length;
    const text = '\n' + [always, ...busySection(kept, busy.length > 0)].join('\n') + (trimmed ? note : '');
    if (fixed + enc(text) <= budget) return { ok: true, url: url(text) };
  }

  // Not even Build and Responsiveness fit beside the user's words. Character
  // trimming is the last resort; the clamp keeps the result under budget.
  const text = clampEncoded('\n' + always, fixed, budget, note);
  return { ok: true, url: url(text) };
}

/** GitHub's comfortable title width, the clip `featureSubject` uses too. */
const MAX_BROWSER_TITLE_CHARS = 120;

/**
 * Everything the report adds that is not about the zip, in the order the API
 * path posts it: build and machine, the busy minutes, the responsiveness
 * numbers. Starts with an empty line, so joined after the `---` rule it leaves
 * a blank line before the first heading.
 */
function diagnosticSections(deps: ReportBodyDeps): string[] {
  const busy = recentBusyMinutes(deps.logsDir, deps.maxHeartbeats ?? MAX_HEARTBEAT_LINES);
  return [
    '',
    ...buildSection(deps),
    ...busySection(busy, busy.length > 0),
    ...responsivenessSection(deps),
  ];
}

function buildSection(deps: ReportBodyDeps): string[] {
  const at = (deps.now ?? (() => new Date()))();
  const id = deps.identity;
  return [
    '### Build and machine',
    '',
    '```',
    `version:       ${deps.version}`,
    `commit:        ${id.commit ?? 'unknown'}${id.dirty ? ' (dirty tree)' : ''}`,
    `branch:        ${id.branch ?? 'unknown'}`,
    `built:         ${id.builtAt ?? 'unknown'}`,
    `collected:     ${at.toISOString()}`,
    `app uptime:    ${Math.round(deps.uptimeMs / 1000)}s`,
    `platform:      ${process.platform} ${os.release()} (${process.arch})`,
    `logical cores: ${os.cpus().length}`,
    `electron:      ${process.versions.electron ?? 'n/a'}`,
    '```',
  ];
}

/**
 * The busy-minutes section. `hadAny` is whether the log had any at all, so a
 * browser report that had to drop every line says so instead of claiming
 * nothing was busy.
 */
function busySection(busy: string[], hadAny: boolean): string[] {
  const out = ['', '### Recent busy minutes (CPU heartbeat, warnings only)', ''];
  if (busy.length > 0) {
    out.push('```json', ...busy, '```');
  } else if (hadAny) {
    out.push('_Left out to fit in a link._');
  } else {
    // Said explicitly. "No warnings recorded" and "we failed to look" are
    // different facts, and a silent empty section reads as the first while
    // possibly being the second.
    out.push('_None recorded in the current log — either nothing was busy, or the log has rotated._');
  }
  return out;
}

function responsivenessSection(deps: ReportBodyDeps): string[] {
  // ── Responsiveness (#927) ───────────────────────────────────────────────
  //
  // ABOVE the bundle section on purpose, and kept whole on the browser path.
  // The zip cannot be attached through the API, so the body is the only part
  // of a report that travels by itself — and for the report this project most
  // wants to receive ("it feels slow"), these numbers are the whole point.
  // Making the reader fetch a file before they can say anything at all is what
  // this section exists to stop.
  //
  // Safe to inline by construction, and by a different argument from the
  // heartbeat lines: every value is a duration or a count, and every name
  // comes from the closed `PERF_INTERACTIONS` tuple. There is no field here
  // that a path, a prompt or a session title could reach — `report-body.test`
  // asserts that by walking the rendered text, not by reading it.
  const out = ['', '### Responsiveness', ''];
  if (deps.perf) {
    out.push('```', summaryAsText(deps.perf), '```');
  } else {
    // Said out loud: "we could not collect them" is a different fact from
    // "nothing was slow", and a silent omission reads as the second.
    out.push('_Not collected — the app could not read its own performance counters._');
  }
  return out;
}
