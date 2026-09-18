import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { composeIssueBody, recentBusyMinutes, MAX_HEARTBEAT_LINES } from './report-body';
import { UNKNOWN_BUILD_IDENTITY } from '../../shared/build-identity';
import { tempDir, cleanupTempDirs } from '../../test-temp-dirs';

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
