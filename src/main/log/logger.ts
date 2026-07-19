// Logging pipeline (§5.22): JSON-lines to rotating files. Zero-dep by intent —
// the logger is load-bearing for debugging the app; it must not have its own
// dependency surface. Redaction is applied to every record, unconditionally.
//
// Line shape: {"ts","level","subsystem","sessionId"?,"msg",...fields}
// Debug lines are suppressed unless the subsystem is enabled via
// SWITCHBOARD_DEBUG="pty,hooks" (or "*").
import fs from 'fs';
import path from 'path';
import { redactValue } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  dir: string;
  maxBytes?: number; // rotate threshold per file
  maxFiles?: number; // rotated files kept
  debugSubsystems?: string; // comma list or '*'; default from env
}

export interface LogFields {
  sessionId?: string;
  [key: string]: unknown;
}

const DEFAULTS = { maxBytes: 5 * 1024 * 1024, maxFiles: 5 };

export class LogSink {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly debugSet: Set<string> | 'all' | 'none';

  constructor(opts: LoggerOptions) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
    this.maxFiles = opts.maxFiles ?? DEFAULTS.maxFiles;
    const dbg = opts.debugSubsystems ?? process.env.SWITCHBOARD_DEBUG ?? '';
    this.debugSet =
      dbg === '*' ? 'all' : dbg.trim() === '' ? 'none' : new Set(dbg.split(',').map((s) => s.trim()));
    fs.mkdirSync(this.dir, { recursive: true });
  }

  get file(): string {
    return path.join(this.dir, 'switchboard.log');
  }

  debugEnabled(subsystem: string): boolean {
    return this.debugSet === 'all' || (this.debugSet !== 'none' && this.debugSet.has(subsystem));
  }

  write(level: LogLevel, subsystem: string, msg: string, fields?: LogFields): void {
    if (level === 'debug' && !this.debugEnabled(subsystem)) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      subsystem,
      msg,
      ...(fields ? (redactValue(fields) as object) : {}),
    };
    // msg goes through value redaction too
    const line = JSON.stringify({ ...record, msg: redactValue(msg) }) + '\n';
    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.file, line);
    } catch {
      // logging must never take the app down (fail-open)
    }
  }

  private rotateIfNeeded(incoming: number): void {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return; // no file yet
    }
    if (size + incoming <= this.maxBytes) return;
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const to = `${this.file}.${i}`;
      try {
        fs.rmSync(to, { force: true });
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        /* best-effort */
      }
    }
  }
}

export interface Logger {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
  child: (fields: LogFields) => Logger;
}

export function createLogger(sink: LogSink, subsystem: string, bound: LogFields = {}): Logger {
  const emit =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void =>
      sink.write(level, subsystem, msg, { ...bound, ...fields });
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (fields) => createLogger(sink, subsystem, { ...bound, ...fields }),
  };
}
