import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  composeBrowserIssue,
  composeIssueBody,
  recentBusyMinutes,
  MAX_HEARTBEAT_LINES,
} from './report-body';
import { REPORT_REPO } from '../../shared/diagnostics';
import { MAX_ISSUE_URL_CHARS } from '../../shared/feedback';
import { UNKNOWN_BUILD_IDENTITY } from '../../shared/build-identity';
import { tempDir, cleanupTempDirs } from '../../test-temp-dirs';
import { summarise } from '../../shared/perf';

afterEach(() => cleanupTempDirs());

const beat = (level: string, i: number): string =>
  `{"ts":"2026-09-18T0${i}:00:00Z","level":"${level}","subsystem":"cpu","msg":"cpu heartbeat","coreCount":32,"totalCores":${i}}`;

function logsWith(lines: string[]): string {
  const dir = tempDir('sb-report-');
  fs.writeFileSync(path.join(dir, 'switchboard.log'), lines.join('\n') + '\n');
  return dir;
}

function deps(over: Partial<Parameters<typeof composeIssueBody>[0]> = {}) {
  return {
    description: 'the fans spun up and everything froze',
    version: '0.8.90',
    identity: UNKNOWN_BUILD_IDENTITY,
    logsDir: tempDir('sb-report-empty-'),
    bundlePath: 'C:\\Users\\x\\switchboard-logs-v0.8.90-2026-09-18-1432.zip',
    uptimeMs: 7_200_000,
    now: () => new Date('2026-09-18T14:32:00Z'),
    ...over,
  };
}

describe('recentBusyMinutes', () => {
  it('takes only the WARN heartbeats, not the quiet ones', () => {
    const dir = logsWith([beat('info', 1), beat('warn', 2), beat('info', 3), beat('warn', 4)]);
    const got = recentBusyMinutes(dir);
    expect(got).toHaveLength(2);
    expect(got.every((l) => l.includes('"level":"warn"'))).toBe(true);
  });

  it('ignores other warnings that are not heartbeats', () => {
    const dir = logsWith([
      '{"level":"warn","subsystem":"git","msg":"something else"}',
      beat('warn', 2),
    ]);
    expect(recentBusyMinutes(dir)).toHaveLength(1);
  });

  it('keeps the MOST RECENT, because a freeze is at the end of the log', () => {
    const dir = logsWith(Array.from({ length: 30 }, (_, i) => beat('warn', i % 10)));
    const got = recentBusyMinutes(dir, 5);
    expect(got).toHaveLength(5);
    expect(got[4]).toBe(beat('warn', 29 % 10));
  });

  it('returns nothing rather than throwing when there is no log at all', () => {
    expect(recentBusyMinutes(tempDir('sb-report-none-'))).toEqual([]);
  });

  it('defaults to a readable cap', () => {
    const dir = logsWith(Array.from({ length: 50 }, () => beat('warn', 1)));
    expect(recentBusyMinutes(dir)).toHaveLength(MAX_HEARTBEAT_LINES);
  });
});

describe('composeIssueBody', () => {
  it('puts the human sentence FIRST and verbatim', () => {
    // The part a person wrote is the part a person reads. Everything we add
    // goes below it, or the report buries its own point.
    const body = composeIssueBody(deps());
    expect(body.startsWith('the fans spun up and everything froze')).toBe(true);
  });

  it('marks an empty description rather than opening with a blank line', () => {
    const body = composeIssueBody(deps({ description: '   ' }));
    expect(body.startsWith('_(no description given)_')).toBe(true);
  });

  it('carries the build and machine facts nobody remembers to include', () => {
    const body = composeIssueBody(deps());
    expect(body).toContain('version:       0.8.90');
    expect(body).toMatch(/logical cores: \d+/);
    expect(body).toContain('app uptime:    7200s');
  });

  it('says plainly that the zip is NOT attached, and where it is', () => {
    // The API cannot attach a file. Implying otherwise would be the one lie
    // this feature cannot afford.
    const body = composeIssueBody(deps());
    expect(body).toContain('not attached');
    expect(body).toContain('switchboard-logs-v0.8.90-2026-09-18-1432.zip');
    expect(body).toMatch(/Drag the file onto this issue/);
  });

  it('says so when there is no bundle, instead of naming a file that is not there', () => {
    const body = composeIssueBody(deps({ bundlePath: null }));
    expect(body).toContain('bundle could not be written');
    expect(body).not.toContain('Drag the file onto this issue');
  });

  it('distinguishes "nothing was busy" from "we did not look"', () => {
    const body = composeIssueBody(deps());
    expect(body).toContain('None recorded in the current log');
  });

  it('inlines the busy minutes when there are some', () => {
    const body = composeIssueBody(deps({ logsDir: logsWith([beat('warn', 3)]) }));
    expect(body).toContain('"msg":"cpu heartbeat"');
    expect(body).toContain('```json');
  });
});

describe('the Responsiveness section (#927)', () => {
  const summary = () =>
    summarise({
      interactions: [
        { name: 'keystroke', ms: 41, at: 1 },
        { name: 'session-switch', ms: 140, at: 2 },
      ],
      longTasks: [{ at: 1, ms: 90 }],
      keystrokes: [
        {
          at: 1,
          ms: 41,
          blockedMs: 90,
          layoutReads: 0,
          blocks: 412,
          rendered: 120,
          draftLength: 2048,
        },
      ],
      loop: { p50: 1.2, p99: 48, maxMs: 310 },
    });

  it('travels in the BODY, because the zip cannot be attached', () => {
    // GitHub's API cannot attach a file, so the body is the only part of a
    // report that arrives by itself — and "it feels slow" is the report this
    // project most wants to receive.
    const body = composeIssueBody(deps({ perf: summary() }));
    expect(body).toContain('### Responsiveness');
    expect(body).toContain('keystroke');
    expect(body).toContain('session-switch');
  });

  it('says so when the numbers could not be collected, rather than omitting the section', () => {
    // "We failed to look" and "nothing was slow" are different facts, and a
    // silent omission reads as the second.
    const body = composeIssueBody(deps());
    expect(body).toContain('### Responsiveness');
    expect(body).toMatch(/Not collected/);
  });

  it('sits above the bundle section, so the numbers are read before the file is fetched', () => {
    const body = composeIssueBody(deps({ perf: summary() }));
    expect(body.indexOf('### Responsiveness')).toBeLessThan(body.indexOf('### Diagnostic bundle'));
  });

  it('keeps the user’s own words first, ahead of everything we added', () => {
    const body = composeIssueBody(deps({ perf: summary() }));
    expect(body.indexOf('the fans spun up')).toBeLessThan(body.indexOf('### Responsiveness'));
  });

  it('THE LOCAL-ONLY ASSERTION: the section leaks no path, prompt or session name', () => {
    // The whole body, not just the section: this is the one artefact in the app
    // that is posted to a public repository.
    const body = composeIssueBody(deps({ description: 'it froze', perf: summary() }));
    const section = body.slice(body.indexOf('### Responsiveness'), body.indexOf('### Diagnostic bundle'));
    expect(section).not.toContain(':\\'); // a Windows path
    expect(section).not.toMatch(/\/(home|Users)\//); // a POSIX path
    expect(section).not.toContain('.ts');
    expect(section).not.toContain('2048'); // the draft LENGTH is not reported either
  });
});

describe('composeBrowserIssue — the no-credential path (#1494)', () => {
  const browserDeps = (over: Partial<Parameters<typeof composeBrowserIssue>[0]> = {}) => ({
    ...deps(),
    title: 'CPU pegged',
    ...over,
  });
  const bodyOf = (url: string): string => decodeURIComponent(url.split('&body=')[1]);

  it("is GitHub's new-issue FORM for this repo, titled with the subject", () => {
    const r = composeBrowserIssue(browserDeps());
    if (!r.ok) throw new Error('expected a url');
    expect(r.url.startsWith(`https://github.com/${REPORT_REPO}/issues/new?title=`)).toBe(true);
    expect(r.url).toContain(`title=${encodeURIComponent('CPU pegged')}&body=`);
    expect(r.url).not.toContain('api.github.com');
  });

  it('puts the user’s words first, then the drag-the-zip line, then the diagnostics', () => {
    const r = composeBrowserIssue(browserDeps());
    if (!r.ok) throw new Error('expected a url');
    const body = bodyOf(r.url);
    expect(body.startsWith('the fans spun up and everything froze')).toBe(true);
    const drag = body.indexOf('drag the diagnostic zip onto this issue');
    expect(drag).toBeGreaterThan(0);
    expect(body).toContain('switchboard-logs-v0.8.90-2026-09-18-1432.zip');
    expect(body.indexOf('### Build and machine')).toBeGreaterThan(drag);
  });

  it('says so when there is no zip, instead of asking for one to be dragged on', () => {
    const r = composeBrowserIssue(browserDeps({ bundlePath: null }));
    if (!r.ok) throw new Error('expected a url');
    const body = bodyOf(r.url);
    expect(body).toContain('could not be written');
    expect(body).not.toContain('drag the diagnostic zip');
  });

  it('flattens control characters in the title', () => {
    const r = composeBrowserIssue(browserDeps({ title: 'a\nb' }));
    if (!r.ok) throw new Error('expected a url');
    expect(r.url.split('&body=')[0]).not.toContain('%0A');
  });

  it('LONG DIAGNOSTICS never push the URL over the cap, and the user’s text is whole', () => {
    // Every heartbeat slot full, each line padded: the diagnostics alone are far
    // past what a link can carry.
    const fat = (i: number): string => beat('warn', i % 10).replace('}', `,"pad":"${'x'.repeat(900)}"}`);
    const logsDir = logsWith(Array.from({ length: 40 }, (_, i) => fat(i)));
    const description = 'line one\n\n' + 'a sentence the user wrote. '.repeat(60);
    const r = composeBrowserIssue(browserDeps({ logsDir, description }));
    if (!r.ok) throw new Error('expected a url');
    expect(r.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_CHARS);
    const body = bodyOf(r.url);
    expect(body).toContain(description.trim());
    expect(body).toContain('drag the diagnostic zip onto this issue');
    expect(body).toContain('some diagnostics did not fit in a link. The full version is in the zip.');
    // the footer survives the clamp too
    expect(body).toContain('Help ▸ Report a problem');
  });

  it('trims the busy minutes BY LINE, oldest first, and keeps Responsiveness whole', () => {
    // A realistic "it feels slow" log: the twelve-line cap full of long JSON
    // heartbeats, which alone would fill a link. Character trimming from the
    // end used to cut Responsiveness every time and leave the json fence open.
    const real = (i: number): string =>
      `{"ts":"2026-10-28T1${i % 10}:00:00.000Z","level":"warn","subsystem":"cpu","msg":"cpu heartbeat","coreCount":32,"totalCores":${i},"idleMs":${i * 1000},"rssMb":812,"processes":[{"type":"Browser","pid":${1000 + i},"cpu":${i}.5},{"type":"GPU","pid":${2000 + i},"cpu":3.1},{"type":"Tab","pid":${3000 + i},"cpu":41.7,"name":"switchboard.ai"}],"lagMs":${i * 7}}`;
    const lines = Array.from({ length: 12 }, (_, i) => real(i));
    const logsDir = logsWith(lines);
    const perf = summarise({
      interactions: [{ name: 'keystroke', ms: 41, at: 1 }],
      longTasks: [{ at: 1, ms: 90 }],
      keystrokes: [],
      loop: { p50: 1.2, p99: 48, maxMs: 310 },
    });
    const r = composeBrowserIssue(browserDeps({ logsDir, perf }));
    if (!r.ok) throw new Error('expected a url');
    expect(r.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_CHARS);
    const body = bodyOf(r.url);

    expect(body).toContain('### Build and machine');
    expect(body).toContain('### Responsiveness');
    expect(body).toContain('keystroke');
    // some lines were dropped, and they were the OLDEST: the newest survives
    expect(body).not.toContain(lines[0]);
    expect(body).toContain(lines[11]);
    // every fence is closed, so the note and the footer are not swallowed
    expect((body.match(/```/g) ?? []).length % 2).toBe(0);
    const note = body.indexOf('some diagnostics did not fit in a link');
    expect(note).toBeGreaterThan(body.lastIndexOf('```'));
  });

  it('says the busy minutes were left out, not that there were none, when no line fits', () => {
    const fat = (i: number): string => beat('warn', i).replace('}', `,"pad":"${'"'.repeat(2000)}"}`);
    const r = composeBrowserIssue(browserDeps({ logsDir: logsWith([fat(1), fat(2)]) }));
    if (!r.ok) throw new Error('expected a url');
    const body = bodyOf(r.url);
    expect(body).toContain('Left out to fit in a link');
    expect(body).not.toContain('None recorded');
  });

  it('a lone surrogate in what the user typed does not throw (#1494)', () => {
    const lone = String.fromCharCode(0xd83c);
    let r: ReturnType<typeof composeBrowserIssue> | undefined;
    expect(() => {
      r = composeBrowserIssue(browserDeps({ title: `t${lone}`, description: `d${lone}x` }));
    }).not.toThrow();
    expect(r?.ok).toBe(true);
  });

  it('clips a paragraph-long title instead of calling the description too long', () => {
    const r = composeBrowserIssue(browserDeps({ title: 'x'.repeat(3000) }));
    if (!r.ok) throw new Error('expected a url');
    const title = decodeURIComponent(r.url.split('&body=')[0].split('title=')[1]);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('...')).toBe(true);
  });

  it('honours a smaller cap the same way', () => {
    const r = composeBrowserIssue(browserDeps({ maxUrlChars: 1200 }));
    if (!r.ok) throw new Error('expected a url');
    expect(r.url.length).toBeLessThanOrEqual(1200);
    expect(bodyOf(r.url)).toContain('the fans spun up and everything froze');
  });

  it('a description that alone will not fit is TOO-LONG — never cut', () => {
    const r = composeBrowserIssue(browserDeps({ description: 'word '.repeat(3000) }));
    expect(r).toEqual({ ok: false, problem: 'too-long' });
  });

  it('an empty description is marked rather than left blank', () => {
    const r = composeBrowserIssue(browserDeps({ description: '   ' }));
    if (!r.ok) throw new Error('expected a url');
    expect(bodyOf(r.url).startsWith('_(no description given)_')).toBe(true);
  });
});

describe('composeIssueBody after the split (#1494)', () => {
  it('still carries every section in the order the API path always posted', () => {
    const body = composeIssueBody(deps());
    const order = [
      'the fans spun up',
      '### Build and machine',
      '### Recent busy minutes',
      '### Responsiveness',
      '### Diagnostic bundle',
      '<sub>Filed from switchboard.ai',
    ].map((s) => body.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
