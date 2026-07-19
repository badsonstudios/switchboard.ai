// TranscriptWatcher (P1-E2-06): tolerant live tailer over Claude Code's JSONL
// transcripts, per the S-04/S-05 findings:
//   - transcripts appear on FIRST PROMPT, not spawn — absence is normal
//   - discovery = new-file detection VALIDATED against cwd/sessionId (the
//     adoption race is real; slug math only narrows the scan)
//   - recursive scan: subagent transcripts live nested at
//     <slug>/<session-uuid>/subagents/agent-<id>.jsonl with a .meta.json
//   - tolerant reader: malformed/unknown lines counted, never thrown
//   - transcript is TELEMETRY authority (tokens, tools, files); status
//     authority is hooks (E2-05)
import fs from 'fs';
import path from 'path';
import { Logger } from '../log/logger';

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface TranscriptSnapshot {
  sessionId: string;
  bound: boolean;
  nativeSessionId?: string;
  usage: UsageTotals;
  lines: number;
  malformed: number;
  toolsSeen: string[];
  filesTouched: string[];
  subagents: Array<{ agentId: string; agentType?: string; description?: string }>;
  lastActivityAt: string | null;
}

interface WatchedSession {
  sessionId: string;
  cwd: string;
  nativeSessionId?: string;
  boundFile: string | null;
  watchedSince: number;
  tails: Map<string, { offset: number; buf: string }>;
  snap: TranscriptSnapshot;
}

/** After this long unbound, widen discovery beyond the slug prefilter. */
const WIDEN_AFTER_MS = 10_000;

export interface TranscriptWatcherOptions {
  projectsRoot: string;
  log: Logger;
  pollMs?: number;
  /** how long to trust the slug prefilter before widening discovery */
  widenAfterMs?: number;
}

export function slugForCwd(cwd: string): string {
  return cwd.replace(/[\\/:. ]/g, '-');
}

/** Path equality that tolerates case + separator differences on win32. */
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export class TranscriptWatcher {
  private readonly sessions = new Map<string, WatchedSession>();
  private readonly known = new Set<string>(); // files existing before any watch
  private readonly listeners = new Set<(s: TranscriptSnapshot) => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: TranscriptWatcherOptions) {
    for (const f of this.scan()) this.known.add(f);
  }

  watch(sessionId: string, session: { cwd: string; nativeSessionId?: string }): void {
    this.sessions.set(sessionId, {
      sessionId,
      cwd: session.cwd,
      nativeSessionId: session.nativeSessionId,
      boundFile: null,
      watchedSince: Date.now(),
      tails: new Map(),
      snap: {
        sessionId,
        bound: false,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        lines: 0,
        malformed: 0,
        toolsSeen: [],
        filesTouched: [],
        subagents: [],
        lastActivityAt: null,
      },
    });
    this.ensurePolling();
  }

  /** Late-arriving native id (from hooks) tightens binding validation. */
  setNativeSessionId(sessionId: string, nativeId: string): void {
    const w = this.sessions.get(sessionId);
    if (w) w.nativeSessionId = nativeId;
  }

  unwatch(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.sessions.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot(sessionId: string): TranscriptSnapshot | undefined {
    const w = this.sessions.get(sessionId);
    return w ? { ...w.snap, toolsSeen: [...w.snap.toolsSeen], filesTouched: [...w.snap.filesTouched], subagents: [...w.snap.subagents] } : undefined;
  }

  onUpdate(l: (s: TranscriptSnapshot) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- internals -------------------------------------------------------------

  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? 100);
    this.timer.unref?.();
  }

  private scan(root = this.opts.projectsRoot, depth = 0, acc: string[] = []): string[] {
    if (depth > 4) return acc;
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return acc;
    }
    for (const name of names) {
      const full = path.join(root, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) this.scan(full, depth + 1, acc);
      else if (name.endsWith('.jsonl')) acc.push(full);
    }
    return acc;
  }

  private poll(): void {
    for (const w of this.sessions.values()) {
      // discovery: scan narrowly (this session's slug dirs, case-insensitive)
      // until bound; widen to the full root if binding hasn't happened after a
      // grace period (slug math is a PREFILTER, never the authority — the
      // spike's own rule; Claude lowercases drive letters, and future slug
      // rule changes must degrade to a slower scan, not silent unbound)
      if (!w.boundFile) {
        const widen = Date.now() - w.watchedSince > (this.opts.widenAfterMs ?? WIDEN_AFTER_MS);
        for (const full of this.discoveryCandidates(w, widen)) {
          if (this.known.has(full) || w.tails.has(full)) continue;
          if (this.claim(w, full)) w.tails.set(full, { offset: 0, buf: '' });
        }
      } else {
        // bound: only look for new subagent files under our session dir
        for (const full of this.subagentFiles(w)) {
          if (!w.tails.has(full)) w.tails.set(full, { offset: 0, buf: '' });
        }
      }
      for (const [full, tail] of w.tails) this.drain(w, full, tail);
    }
  }

  private discoveryCandidates(w: WatchedSession, widen: boolean): string[] {
    if (widen) return this.scan();
    const want = slugForCwd(w.cwd).toLowerCase();
    const acc: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.opts.projectsRoot, { withFileTypes: true });
    } catch {
      return acc;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name.toLowerCase() === want) {
        this.scan(path.join(this.opts.projectsRoot, e.name), 1, acc);
      }
    }
    return acc;
  }

  private subagentFiles(w: WatchedSession): string[] {
    if (!w.boundFile) return [];
    const dir = path.join(path.dirname(w.boundFile), path.basename(w.boundFile, '.jsonl'), 'subagents');
    const acc: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return acc;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(path.join(dir, e.name));
    }
    return acc;
  }

  /** Bind only files that verifiably belong to this session (the race fix). */
  private claim(w: WatchedSession, full: string): boolean {
    if (full.includes(`${path.sep}subagents${path.sep}`)) return false; // handled post-bind
    if (w.boundFile) return false; // one main transcript per session
    // AUTHORITY: the first parseable line's cwd must match (case-insensitive
    // on win32); sessionId must match the native id when we know it
    const head = this.readHead(full);
    if (!head) return false;
    if (typeof head.cwd === 'string' && !sameFolder(head.cwd, w.cwd)) return false;
    if (w.nativeSessionId && head.sessionId !== w.nativeSessionId) return false;
    w.boundFile = full;
    w.snap.bound = true;
    w.snap.nativeSessionId = typeof head.sessionId === 'string' ? head.sessionId : undefined;
    this.opts.log.info('transcript bound', { sessionId: w.sessionId, file: path.basename(full) });
    return true;
  }

  private readHead(full: string): { cwd?: unknown; sessionId?: unknown } | null {
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const firstLine = buf.toString('utf8', 0, n).split('\n')[0];
      return JSON.parse(firstLine) as { cwd?: unknown; sessionId?: unknown };
    } catch {
      return null;
    }
  }

  private drain(w: WatchedSession, full: string, tail: { offset: number; buf: string }): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      return;
    }
    if (st.size <= tail.offset) return;
    let chunk: Buffer;
    try {
      const fd = fs.openSync(full, 'r');
      chunk = Buffer.alloc(st.size - tail.offset);
      fs.readSync(fd, chunk, 0, chunk.length, tail.offset);
      fs.closeSync(fd);
    } catch {
      return;
    }
    tail.offset = st.size;
    tail.buf += chunk.toString('utf8');
    let nl: number;
    let touched = false;
    while ((nl = tail.buf.indexOf('\n')) >= 0) {
      const line = tail.buf.slice(0, nl);
      tail.buf = tail.buf.slice(nl + 1);
      if (!line.trim()) continue;
      w.snap.lines++;
      touched = true;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        w.snap.malformed++;
        continue;
      }
      this.absorb(w, full, e);
    }
    if (touched) {
      w.snap.lastActivityAt = new Date().toISOString();
      for (const l of this.listeners) {
        try {
          l(this.snapshot(w.sessionId)!);
        } catch (err) {
          this.opts.log.error('transcript listener threw', { sessionId: w.sessionId, error: String(err) });
        }
      }
    }
  }

  private absorb(w: WatchedSession, full: string, e: Record<string, unknown>): void {
    if (full === w.boundFile && typeof e.sessionId === 'string' && !w.snap.nativeSessionId) {
      w.snap.nativeSessionId = e.sessionId;
    }
    const message = e.message as { usage?: Record<string, number>; content?: unknown } | undefined;
    const usage = message?.usage;
    if (usage) {
      w.snap.usage.input += usage.input_tokens ?? 0;
      w.snap.usage.output += usage.output_tokens ?? 0;
      w.snap.usage.cacheRead += usage.cache_read_input_tokens ?? 0;
      w.snap.usage.cacheCreate += usage.cache_creation_input_tokens ?? 0;
    }
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const c of content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
      if (c?.type === 'tool_use') {
        if (c.name && !w.snap.toolsSeen.includes(c.name)) w.snap.toolsSeen.push(c.name);
        const fp = c.input?.file_path ?? c.input?.path ?? c.input?.notebook_path;
        if (typeof fp === 'string' && !w.snap.filesTouched.includes(fp)) {
          w.snap.filesTouched.push(fp);
        }
        if ((c.name === 'Agent' || c.name === 'Task') && full === w.boundFile) {
          this.pickupSubagentMeta(w);
        }
      }
    }
  }

  /** Read meta sidecars for any agent files under our session dir (S-05). */
  private pickupSubagentMeta(w: WatchedSession): void {
    if (!w.boundFile) return;
    const dir = path.join(path.dirname(w.boundFile), path.basename(w.boundFile, '.jsonl'), 'subagents');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const agentId = name.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
      if (w.snap.subagents.some((s) => s.agentId === agentId)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as {
          agentType?: string;
          description?: string;
        };
        w.snap.subagents.push({ agentId, agentType: meta.agentType, description: meta.description });
      } catch {
        w.snap.subagents.push({ agentId });
      }
    }
  }
}
