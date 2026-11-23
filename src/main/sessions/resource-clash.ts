// Port and dev-database clashes between live sessions (#1507, DESIGN §5.7's
// worktree isolation caveat).
//
// Worktrees separate FOLDERS, not resources. Two sessions in two worktrees of
// one project still share the machine's ports and whatever local database
// their `.env` names, and making a worktree copies `.env` into it (#1506), so
// the second worktree starts out pointing at exactly the same port and the same
// database as the first. This module notices, and says so: ONE quiet Feed line
// on the session whose action made the clash, suggesting the fix in words.
//
// WHAT IT NEVER DOES (P6, P7): block anything, stop a process, or edit a file.
// It reads the session's own tool output (already in the Feed) and a handful of
// small dotenv files. A read or parse that fails means no warning, never an
// error the session can see.
//
// THE SIGNALS, deliberately few:
//   - a shell result saying the port is already in use (EADDRINUSE and
//     friends): reported only when ANOTHER live session claims that port; a
//     port held by something outside the app is not ours to report;
//   - a server started (a `PORT=` / `--port` command, or "listening on :N"
//     output) on a port another live session already started a server on;
//   - the same `PORT` or the same LOCAL database URL in the dotenv files of two
//     live sessions in DIFFERENT folders. Sessions sharing one folder chose to
//     (the busy-folder prompt asks), and share its `.env` by definition.
import fs from 'fs';
import path from 'path';
import { pathKey } from '../../shared/projects';
import { errorText } from '../../shared/error-text';
import type { ClashMark, FeedBlock } from '../feed/blocks';
import type { Logger } from '../log/logger';

/** Dotenv files read per folder, in the order a dev server usually layers them. */
export const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'] as const;
/** Larger than any real dotenv file; a bigger one is not read at all. */
export const MAX_ENV_BYTES = 64 * 1024;
/** Text scanned per tool block (command plus output); the rest is ignored. */
const MAX_SCAN = 16 * 1024;

/** Tools whose results are shell output worth reading for a port. */
const SHELL_OUTPUT_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput', 'TaskOutput']);

const validPort = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 65535;

function addPort(into: Set<number>, raw: string | undefined): void {
  if (raw === undefined) return;
  const n = Number(raw);
  if (validPort(n)) into.add(n);
}

/**
 * Ports a shell COMMAND says it will serve on: `PORT=3000 npm run dev`,
 * `vite --port 5173`, `--port=8080`. Not `-p`, which means a dozen other things
 * (`mkdir -p`, `ssh -p`), and not a URL, which is usually a request to a port
 * rather than a claim on it.
 */
export function portsFromCommand(command: string): number[] {
  const text = command.slice(0, MAX_SCAN);
  const out = new Set<number>();
  for (const m of text.matchAll(/(?:^|[\s;&|"'(])(?:\$env:)?PORT\s*=\s*["']?(\d{1,5})\b/g)) addPort(out, m[1]);
  for (const m of text.matchAll(/--port(?:\s+|=)["']?(\d{1,5})\b/g)) addPort(out, m[1]);
  return [...out];
}

/**
 * Ports tool OUTPUT says a server is now listening on. The common dev servers'
 * own wording: Node's "listening on port 3000", Express-style "listening on
 * http://localhost:3000", Vite's "Local: http://localhost:5173/", Next's
 * "started server on 0.0.0.0:3000", and "running at http://127.0.0.1:8000".
 */
export function listeningPorts(output: string): number[] {
  const text = output.slice(0, MAX_SCAN);
  const out = new Set<number>();
  const host = String.raw`(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|::)`;
  const patterns = [
    /listening (?:on|at) port:?\s*(\d{1,5})\b/gi,
    new RegExp(String.raw`listening (?:on|at):?\s*${host}:(\d{1,5})\b`, 'gi'),
    new RegExp(String.raw`(?:started server|ready) on:?\s*${host}:(\d{1,5})\b`, 'gi'),
    new RegExp(String.raw`(?:running|serving|available) (?:on|at):?\s*${host}:(\d{1,5})\b`, 'gi'),
    new RegExp(String.raw`\bLocal:\s+${host}:(\d{1,5})\b`, 'g'),
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) addPort(out, m[1]);
  return [...out];
}

/**
 * Ports tool output says were ALREADY TAKEN: Node's `EADDRINUSE: address
 * already in use :::3000`, the generic "address already in use ...:3000", and
 * Vite's "Port 5173 is in use, trying another one...".
 */
export function portsInUse(output: string): number[] {
  const text = output.slice(0, MAX_SCAN);
  const out = new Set<number>();
  // the LAST `:N` on the line: an earlier one can be a timestamp
  for (const m of text.matchAll(/(?:EADDRINUSE|address already in use)[^\n]*:(\d{1,5})\b/gi)) addPort(out, m[1]);
  for (const m of text.matchAll(/\bport\s+(\d{1,5})\s+is\s+(?:already\s+)?in use\b/gi)) addPort(out, m[1]);
  return [...out];
}

/** Read a dotenv file's KEY=value pairs. Quotes stripped; `export ` allowed. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out.set(m[1], value);
  }
  return out;
}

/** Keys that name a database server's port: shared by design, not a clash. */
const DB_PORT_KEY = /(?:^|_)(?:DB|DATABASE|PG|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MONGO|MONGODB|REDIS|SMTP|MAIL)(?:_|PORT$)/;
const isServePortKey = (key: string): boolean =>
  (key === 'PORT' || key.endsWith('_PORT')) && !DB_PORT_KEY.test(key);

const DB_URL_KEYS = new Set(['DATABASE_URL', 'DB_URL', 'POSTGRES_URL', 'MYSQL_URL', 'MONGO_URL', 'MONGO_URI', 'MONGODB_URI', 'MONGODB_URL']);
const isDbUrlKey = (key: string): boolean => DB_URL_KEYS.has(key) || key.endsWith('_DATABASE_URL');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'host.docker.internal']);
const DEFAULT_DB_PORT: Record<string, string> = {
  postgres: '5432',
  mysql: '3306',
  mongodb: '27017',
  sqlserver: '1433',
};

/** A database a URL names, in a form two folders can be compared on. */
export interface LocalDatabase {
  /** what two folders are compared on: scheme, host, port, database */
  key: string;
  /** what the user is shown: "app_dev on localhost:5432", or the file */
  label: string;
}

/**
 * The LOCAL database a URL points at, or null. Credentials and query strings
 * never leave this function. A remote host is null (a shared remote database
 * is usually on purpose), and so is a URL with no database name, a variable
 * reference, or a relative sqlite file (each worktree has its own).
 */
export function localDatabase(raw: string): LocalDatabase | null {
  const value = raw.trim();
  if (!value || value.includes('${') || value.length > 2048) return null;
  const file = /^(?:file:|sqlite:\/\/)(.*)$/i.exec(value);
  if (file) {
    const p = file[1].replace(/\?.*$/, '');
    // `sqlite:////abs` and `file:/abs`: absolute on either platform's rules
    const abs = p.startsWith('//') ? p.slice(1) : p;
    if (!(path.posix.isAbsolute(abs) || path.win32.isAbsolute(abs))) return null;
    return { key: `file:${pathKey(abs)}`, label: abs };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '').replace(/\+.*$/, '').toLowerCase();
  const family =
    scheme === 'postgresql' || scheme === 'postgres'
      ? 'postgres'
      : scheme === 'mongodb' || scheme === 'mongodb+srv'
        ? 'mongodb'
        : scheme === 'mysql' || scheme === 'mariadb'
          ? 'mysql'
          : scheme === 'sqlserver' || scheme === 'mssql'
            ? 'sqlserver'
            : null;
  if (!family) return null;
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return null;
  const name = decodeURIComponentSafe(url.pathname.replace(/^\/+/, '').split('/')[0] ?? '');
  if (!name) return null;
  const port = url.port || DEFAULT_DB_PORT[family] || '';
  const canonicalHost = host === '0.0.0.0' || host === '::1' || host === '[::1]' ? '127.0.0.1' : host === 'localhost' ? '127.0.0.1' : host;
  const shownHost = host === '[::1]' ? '::1' : host;
  return {
    key: `${family}://${canonicalHost}:${port}/${name}`,
    label: `${name} on ${shownHost}${port ? `:${port}` : ''}`,
  };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** One thing a session's config says it uses. */
export interface ConfigClaim {
  resource: 'port' | 'database';
  /** the comparison key; see `claimKey` */
  key: string;
  /** what the user is shown: a port number, or a database label */
  value: string;
  /** the dotenv file it came from, by name */
  file: string;
  /** the setting's name, e.g. `PORT` or `DATABASE_URL` */
  setting: string;
}

const portKey = (n: number): string => `port:${n}`;

/**
 * What a folder's dotenv files claim. Later files win over earlier ones for
 * the same setting, as the common loaders layer them.
 */
export function claimsFromEnv(files: ReadonlyArray<{ file: string; text: string }>): ConfigClaim[] {
  const bySetting = new Map<string, ConfigClaim>();
  for (const { file, text } of files) {
    for (const [setting, value] of parseDotenv(text)) {
      if (isServePortKey(setting)) {
        const n = Number(value);
        if (/^\d{1,5}$/.test(value) && validPort(n)) {
          bySetting.set(setting, { resource: 'port', key: portKey(n), value: String(n), file, setting });
        }
      } else if (isDbUrlKey(setting)) {
        const db = localDatabase(value);
        if (db) bySetting.set(setting, { resource: 'database', key: `db:${db.key}`, value: db.label, file, setting });
      }
    }
  }
  return [...bySetting.values()];
}

/**
 * Read a folder's dotenv files, bounded: a missing file is skipped, a file
 * over `MAX_ENV_BYTES` is skipped, and nothing else is read. Never throws.
 */
export async function readEnvFiles(folder: string): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  for (const file of ENV_FILES) {
    try {
      const full = path.join(folder, file);
      const st = await fs.promises.stat(full);
      if (!st.isFile() || st.size > MAX_ENV_BYTES) continue;
      out.push({ file, text: await fs.promises.readFile(full, 'utf8') });
    } catch {
      /* missing or unreadable: nothing to compare (P6) */
    }
  }
  return out;
}

/** What `ResourceClashes` asks of its host. */
export interface ResourceClashDeps {
  /** a live session's name and the folder its agent works in, or null if gone */
  describe(sessionId: string): { name: string; folder: string } | null;
  /** draw the warning line in a session's Feed */
  place(sessionId: string, mark: ClashMark): void;
  /**
   * Which repository a folder belongs to (its git common dir), or undefined
   * when it is in none. When given, SETTINGS are compared only between folders
   * of one repository: `PORT=3000` is in half the Node projects on a machine,
   * and two unrelated repos are rarely run against each other. Worktrees of one
   * project, the case this exists for, share a common dir. Absent: compared
   * regardless.
   */
  repoKey?: (folder: string) => Promise<string | undefined>;
  log?: Pick<Logger, 'info' | 'warn'>;
  /** the dotenv reader; a test hands in its own */
  readEnv?: (folder: string) => Promise<Array<{ file: string; text: string }>>;
  /** the clock, for a test of `RUN_CLAIM_MS` */
  now?: () => number;
}

/**
 * How long "this session started a server on port N" is believed (#1507
 * review). Nothing says when a server stops, so a claim that never expired
 * would name a session whose `PORT=3000 npm test` finished an hour ago.
 */
export const RUN_CLAIM_MS = 30 * 60_000;

interface RunClaim {
  at: number;
  /** the Feed block that made it: a block's own result does not count against it */
  seq: number;
}

interface Held {
  /** run claims: ports this session started a server on, by key */
  ran: Map<string, RunClaim>;
  /** config claims, by key */
  config: Map<string, ConfigClaim>;
  /** the folder the config claims were read from */
  configFolder?: string;
  /** that folder's repository, when the host can tell */
  repo?: string;
  /** bumped per read, so a slow read for an old folder cannot land late */
  readSeq: number;
}

/**
 * The command a shell tool block ran. From `detail` (the call's input as JSON,
 * whole up to its cap) when it parses, else `summary` (cut for display, so a
 * long command may end mid-number there).
 */
function commandOf(tool: NonNullable<FeedBlock['tool']>): string {
  if (tool.detail) {
    try {
      const input = JSON.parse(tool.detail) as { command?: unknown } | null;
      if (typeof input?.command === 'string') return input.command;
    } catch {
      /* cut JSON: fall back to the summary */
    }
  }
  return tool.summary;
}

/**
 * A command that LOOKS AT text rather than running something (#1507 review):
 * `cat server.ts` printing `listen(3000)` logs, `grep "listening on"`, or
 * `echo PORT=3001 >> .env` (the very fix the warning suggests). Its output and
 * its `PORT=` say nothing about a server.
 */
const LOOKS_AT_TEXT =
  /(?:^|[\s;&|(])(?:echo|printf|cat|type|more|less|head|tail|tee|grep|egrep|rg|sed|awk|git|diff|Get-Content|Select-String|Write-Output|Write-Host|Add-Content|Set-Content)(?=\s|$)/i;

/**
 * Who uses what, for the LIVE sessions only, and which clashes were already
 * reported. Keyed by live session id: a session that ends is forgotten, and so
 * is every clash it was part of.
 */
export class ResourceClashes {
  private readonly held = new Map<string, Held>();
  /** `a|b|key` with a < b: reported once per pair per resource */
  private readonly reported = new Set<string>();

  constructor(private readonly deps: ResourceClashDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private ensure(sessionId: string): Held {
    let h = this.held.get(sessionId);
    if (!h) {
      h = { ran: new Map(), config: new Map(), readSeq: 0 };
      this.held.set(sessionId, h);
    }
    return h;
  }

  /** A run claim still believed, other than one the given block made. */
  private running(h: Held, key: string, exceptSeq?: number): boolean {
    const c = h.ran.get(key);
    if (!c) return false;
    if (this.now() - c.at > RUN_CLAIM_MS) {
      h.ran.delete(key);
      return false;
    }
    return c.seq !== exceptSeq;
  }

  /**
   * A Feed block went by (live only: a replayed history is pushed silently and
   * never reaches here). Reads a shell call's command and its result. The same
   * block arrives again when its result lands; that is idempotent.
   */
  noteBlock(sessionId: string, block: FeedBlock): void {
    try {
      const tool = block.tool;
      if (block.kind !== 'tool' || !tool || !SHELL_OUTPUT_TOOLS.has(tool.name)) return;
      // `BashOutput` / `TaskOutput` read a background command's output: always
      // worth reading. A shell call only when it runs something.
      const command = tool.category === 'shell' ? commandOf(tool) : '';
      if (command && LOOKS_AT_TEXT.test(command.slice(0, MAX_SCAN))) return;
      const out = tool.out ?? '';
      for (const port of portsInUse(out)) this.inUse(sessionId, port, block.seq);
      const started = new Set([...portsFromCommand(command), ...listeningPorts(out)]);
      for (const port of started) this.ran(sessionId, port, block.seq);
    } catch (err) {
      this.deps.log?.warn('resource clash check skipped a block', { sessionId, error: errorText(err) });
    }
  }

  /** The folder this session's settings were last read from, if any. */
  folderOf(sessionId: string): string | undefined {
    return this.held.get(sessionId)?.configFolder;
  }

  /**
   * The session is (now) working in this folder: read its dotenv files and
   * compare. Async and bounded; a read that finishes after the session ended,
   * or after a newer read began, changes nothing.
   */
  async noteFolder(sessionId: string, folder: string): Promise<void> {
    const h = this.ensure(sessionId);
    const seq = ++h.readSeq;
    let claims: ConfigClaim[];
    let repo: string | undefined;
    try {
      claims = claimsFromEnv(await (this.deps.readEnv ?? readEnvFiles)(folder));
      if (claims.length > 0 && this.deps.repoKey) repo = await this.deps.repoKey(folder);
    } catch (err) {
      this.deps.log?.warn('resource clash check could not read the folder settings', { sessionId, error: errorText(err) });
      return;
    }
    if (this.held.get(sessionId) !== h || h.readSeq !== seq) return;
    h.config = new Map(claims.map((c) => [c.key, c]));
    h.configFolder = folder;
    h.repo = repo;
    for (const claim of claims) {
      for (const [other, oh] of this.held) {
        if (other === sessionId || !this.settingsComparable(h, oh)) continue;
        if (!oh.config.has(claim.key)) continue;
        this.report(sessionId, other, claim.key, {
          resource: claim.resource,
          cause: 'config',
          value: claim.value,
          setting: claim.setting,
          file: claim.file,
        });
      }
    }
  }

  /**
   * May two sessions' SETTINGS be compared? Only from different folders (two
   * sessions in one folder chose to share it, `.env` and all), and, when the
   * host can tell repositories apart, only within one repository.
   */
  private settingsComparable(a: Held, b: Held): boolean {
    if (!a.configFolder || !b.configFolder) return false;
    if (pathKey(a.configFolder) === pathKey(b.configFolder)) return false;
    if (!this.deps.repoKey) return true;
    return a.repo !== undefined && a.repo === b.repo;
  }

  /** The session ended: what it held is free, and its clashes can be said again. */
  forget(sessionId: string): void {
    this.held.delete(sessionId);
    for (const k of [...this.reported]) {
      const [a, b] = k.split('|');
      if (a === sessionId || b === sessionId) this.reported.delete(k);
    }
  }

  private ran(sessionId: string, port: number, seq: number): void {
    const key = portKey(port);
    const mine = this.ensure(sessionId);
    if (!mine.ran.has(key) || mine.ran.get(key)?.seq !== seq) mine.ran.set(key, { at: this.now(), seq });
    for (const [other, oh] of this.held) {
      if (other === sessionId || !this.running(oh, key)) continue;
      this.report(sessionId, other, key, { resource: 'port', cause: 'started', value: String(port) });
    }
  }

  private inUse(sessionId: string, port: number, seq: number): void {
    const key = portKey(port);
    const mine = this.ensure(sessionId);
    // This session started something on that port in an EARLIER call: it is
    // most likely in its own way, and another folder's setting is no news.
    // (The call that got the error claims the port itself; that one is not it.)
    const selfInTheWay = this.running(mine, key, seq);
    for (const [other, oh] of this.held) {
      if (other === sessionId) continue;
      const otherRuns = this.running(oh, key);
      const cfg = otherRuns || selfInTheWay || !this.settingsComparable(mine, oh) ? undefined : oh.config.get(key);
      if (!otherRuns && !cfg) continue;
      this.report(sessionId, other, key, {
        resource: 'port',
        cause: 'in-use',
        value: String(port),
        ...(cfg ? { setting: cfg.setting, file: cfg.file } : {}),
      });
    }
  }

  private report(sessionId: string, other: string, key: string, mark: Omit<ClashMark, 'other' | 'otherFolder'>): void {
    const pair = sessionId < other ? `${sessionId}|${other}|${key}` : `${other}|${sessionId}|${key}`;
    if (this.reported.has(pair)) return;
    const who = this.deps.describe(other);
    if (!who) return;
    this.reported.add(pair);
    const full: ClashMark = { ...mark, other: who.name, otherFolder: who.folder };
    try {
      this.deps.place(sessionId, full);
    } catch (err) {
      this.deps.log?.warn('resource clash line could not be drawn', { sessionId, error: errorText(err) });
      return;
    }
    this.deps.log?.info('resource clash between sessions', {
      sessionId,
      other,
      resource: mark.resource,
      cause: mark.cause,
    });
  }
}
