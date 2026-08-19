// #449: the diagnostic channel's destination, pinned.
//
// The issue's done-when is "a decision is recorded ... either way a test pins
// the outcome". The decision was WIRE, to the main log — so these tests are the
// record: delete the emitter and they fail, route it somewhere else and they
// fail, let a flood through unthrottled and they fail.
import { describe, it, expect } from 'vitest';
import { createDiagnosticLogger } from './diagnostics';
import type { StreamDiagnostic } from './stream-service';
import type { LogFields, Logger, LogLevel } from '../log/logger';

interface Line {
  level: LogLevel;
  msg: string;
  fields?: LogFields;
}

function recorder(): { lines: Line[]; log: Logger } {
  const lines: Line[] = [];
  const at =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      lines.push({ level, msg, fields });
    };
  const log: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => log,
  };
  return { lines, log };
}

const diag = (over: Partial<StreamDiagnostic> = {}): StreamDiagnostic => ({
  sessionId: 's1',
  kind: 'parse-failure',
  detail: 'Unexpected token }',
  ...over,
});

describe('stream diagnostics reach the log (#449)', () => {
  it('logs the session, the kind and the detail — the three things a reader needs', () => {
    const { lines, log } = recorder();
    createDiagnosticLogger(log)(diag({ sessionId: 'abc', kind: 'stderr', detail: 'boom' }));

    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].fields).toMatchObject({
      sessionId: 'abc',
      kind: 'stderr',
      detail: 'boom',
      count: 1,
    });
  });

  // `warn`, never `error`: none of these stops a session (fail-open), and an
  // `error` level that fires for the CLI clearing its throat is an `error`
  // level nobody greps for.
  it('every kind is a warning, and none is an error', () => {
    const { lines, log } = recorder();
    const note = createDiagnosticLogger(log);
    for (const kind of ['parse-failure', 'overlong-line', 'stderr', 'stdin-write-failed'] as const) {
      note(diag({ kind, sessionId: kind })); // distinct session, so none throttles another
    }
    expect(lines.map((l) => l.level)).toEqual(['warn', 'warn', 'warn', 'warn']);
  });
});

describe('the throttle (#449)', () => {
  it('logs occurrences 1, 2, 4, 8 and swallows the rest, carrying the running count', () => {
    const { lines, log } = recorder();
    const note = createDiagnosticLogger(log);
    for (let i = 0; i < 10; i++) note(diag());

    expect(lines.map((l) => l.fields?.count)).toEqual([1, 2, 4, 8]);
  });

  it('counts each session and each kind separately', () => {
    const { lines, log } = recorder();
    const note = createDiagnosticLogger(log);
    // Three of one kind on s1 — the third is suppressed…
    note(diag());
    note(diag());
    note(diag());
    // …while a different kind on the same session, and the same kind on a
    // different session, are both still on their first occurrence.
    note(diag({ kind: 'stderr' }));
    note(diag({ sessionId: 's2' }));

    expect(lines).toHaveLength(4);
    expect(lines.map((l) => [l.fields?.sessionId, l.fields?.kind, l.fields?.count])).toEqual([
      ['s1', 'parse-failure', 1],
      ['s1', 'parse-failure', 2],
      ['s1', 'stderr', 1],
      ['s2', 'parse-failure', 1],
    ]);
  });

  // The bookkeeping is a noise damper, not state anyone reads, so forgetting it
  // is cheap and unbounded growth is not. A long-lived main process must not
  // accumulate a counter per session it has ever hosted.
  it('drops its bookkeeping rather than growing without bound', () => {
    const { lines, log } = recorder();
    const note = createDiagnosticLogger(log);
    for (let i = 0; i < 600; i++) note(diag({ sessionId: `s${i}` }));
    lines.length = 0;

    // s0's counter is gone with the clear, so its next diagnostic reads as a
    // first occurrence — an extra line, which is the whole price.
    note(diag({ sessionId: 's0' }));
    expect(lines[0].fields?.count).toBe(1);
  });
});
