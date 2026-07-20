import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LogSink, createLogger } from './logger';
import { redactValue, REDACTED } from './redact';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-log-'));
});

function lines(sink: LogSink): Array<Record<string, unknown>> {
  return fs
    .readFileSync(sink.file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

describe('redaction (the done-when)', () => {
  it('redacts a token passed through log args', () => {
    const sink = new LogSink({ dir });
    const log = createLogger(sink, 'hooks');
    log.info('listener ready', { token: 'super-secret-value', port: 4711 });
    log.info('spawn', { cmd: 'claude --token sk-ant-abc12345678901234567890' });
    const [a, b] = lines(sink);
    expect(a.token).toBe(REDACTED);
    expect(a.port).toBe(4711);
    expect(JSON.stringify(b)).not.toContain('sk-ant-');
  });

  it('redacts by key smell and value shape, deep', () => {
    const v = redactValue({
      nested: { apiKey: 'x', note: 'Bearer abcdef123456789' },
      hex: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    }) as Record<string, Record<string, unknown>> & { hex: string };
    expect(v.nested.apiKey).toBe(REDACTED);
    expect(v.nested.note).toContain(REDACTED);
    expect(v.hex).toBe(REDACTED);
  });
});

describe('json-lines + subsystem/sessionId fields', () => {
  it('one session lifecycle reconstructs with a single filter', () => {
    const sink = new LogSink({ dir });
    const sessions = createLogger(sink, 'sessions');
    const pty = createLogger(sink, 'pty');
    const s1 = sessions.child({ sessionId: 's-111' });
    const noise = sessions.child({ sessionId: 's-999' });

    s1.info('created');
    noise.info('created');
    createLogger(sink, 'ui').info('window focused');
    pty.info('spawned', { sessionId: 's-111', pid: 42 });
    s1.info('status', { to: 'working' });
    s1.info('status', { to: 'done' });
    noise.info('killed');

    const l = lines(sink).filter((r) => r.sessionId === 's-111');
    expect(l.map((r) => r.msg)).toEqual(['created', 'spawned', 'status', 'status']);
    expect(l.map((r) => r.subsystem)).toEqual(['sessions', 'pty', 'sessions', 'sessions']);
  });
});

describe('debug toggles', () => {
  it('suppresses debug unless subsystem enabled', () => {
    const sink = new LogSink({ dir, debugSubsystems: 'pty' });
    createLogger(sink, 'pty').debug('visible');
    createLogger(sink, 'hooks').debug('hidden');
    createLogger(sink, 'hooks').info('info always');
    const msgs = lines(sink).map((r) => r.msg);
    expect(msgs).toEqual(['visible', 'info always']);
  });

  it('star enables all', () => {
    const sink = new LogSink({ dir, debugSubsystems: '*' });
    createLogger(sink, 'anything').debug('x');
    expect(lines(sink)).toHaveLength(1);
  });
});

describe('rotation', () => {
  it('rotates at maxBytes and keeps maxFiles', () => {
    const sink = new LogSink({ dir, maxBytes: 500, maxFiles: 3 });
    const log = createLogger(sink, 'rot');
    for (let i = 0; i < 60; i++) log.info(`line ${i} ${'x'.repeat(40)}`);
    const files = fs.readdirSync(dir).sort();
    expect(files).toContain('switchboard.log');
    expect(files.length).toBeLessThanOrEqual(3 + 1); // live + rotated
    expect(fs.statSync(sink.file).size).toBeLessThanOrEqual(600);
  });
});
