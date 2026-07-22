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
  /** last-seen model id from the transcript, for cost estimation */
  model?: string;
  lines: number;
  malformed: number;
  toolsSeen: string[];
  filesTouched: string[];
  subagents: Array<{ agentId: string; agentType?: string; description?: string }>;
  /** latest TodoWrite plan progress (OQ #13), if the session uses one */
  plan?: { total: number; completed: number; inProgress: number };
  lastActivityAt: string | null;
}

/**
 * One rendered unit of the Feed (P2-E12-06, §5.10): derived from transcript
 * lines, read-only by construction. `detail` is capped — the Feed is a view,
 * not an archive; the transcript stays the source of truth.
 */
export interface FeedBlock {
  seq: number;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'todos';
  /** user/assistant/thinking prose */
  text?: string;
  tool?: {
    name: string;
    summary: string;
    detail?: string;
    /** Bash: the tool call's own description field (block header, E10-06) */
    description?: string;
    /** Edit/Write: structured fields for the inline diff preview (E10-06) */
    filePath?: string;
    oldString?: string;
    newString?: string;
    /** tool_result output, attached when it arrives (block re-emitted) */
    out?: string;
  };
  /** TodoWrite checklist (E10-06) */
  todos?: Array<{ content: string; status: string }>;
  /** thinking: how long it lasted (set when the next block lands) */
  durationMs?: number;
  /** true when the line came from a subagent transcript */
  sidechain: boolean;
  ts?: string;
}

/** Feed blocks kept per session (view buffer, not an archive). */
const BLOCK_CAP = 1000;
const DETAIL_CAP = 4000;
const TEXT_CAP = 20_000;

interface WatchedSession {
  sessionId: string;
  cwd: string;
  nativeSessionId?: string;
  boundFile: string | null;
  watchedSince: number;
  tails: Map<string, { offset: number; buf: string }>;
  snap: TranscriptSnapshot;
  blocks: FeedBlock[];
  blockSeq: number;
  /** tool_use id -> its block, so a later tool_result can attach its OUT */
  toolBlocks: Map<string, FeedBlock>;
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

/** Flatten a tool_result content field (string or text-item array) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((x) => x?.type === 'text' && typeof x.text === 'string')
      .map((x) => x.text)
      .join('\n');
  }
  return '';
}

/**
 * Does a resumable conversation actually exist for this session id? Claude
 * only writes the transcript once a real turn happens, so `--resume <id>` on
 * a session that never got a prompt errors with "No conversation found" and
 * exits — checking the file first lets us fall back to a fresh session.
 * Slug matched case-insensitively (real paths lowercase the drive letter).
 */
export function conversationExists(projectsRoot: string, folder: string, nativeId: string): boolean {
  const wantSlug = slugForCwd(folder).toLowerCase();
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const d of dirs) {
    if (d.isDirectory() && d.name.toLowerCase() === wantSlug) {
      try {
        if (fs.statSync(path.join(projectsRoot, d.name, `${nativeId}.jsonl`)).isFile()) return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
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
  private readonly blockListeners = new Set<(sessionId: string, b: FeedBlock) => void>();
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
      blocks: [],
      blockSeq: 0,
      toolBlocks: new Map(),
    });
    this.ensurePolling();
  }

  /**
   * Late-arriving native id (from hooks) tightens binding validation — and
   * CORRECTS a same-cwd mis-bind (Dan's 2026-07-21 find: two sessions in one
   * folder cross-wired their Feeds): if we already bound a transcript whose
   * sessionId doesn't match the id the hooks just delivered, unbind and let
   * discovery re-run with the id as the authority.
   */
  setNativeSessionId(sessionId: string, nativeId: string): void {
    const w = this.sessions.get(sessionId);
    if (!w) return;
    w.nativeSessionId = nativeId;
    if (w.boundFile && w.snap.nativeSessionId && w.snap.nativeSessionId !== nativeId) {
      this.opts.log.warn('transcript mis-bind corrected (same-cwd race)', {
        sessionId,
        boundTo: w.snap.nativeSessionId,
        actual: nativeId,
      });
      this.resetBinding(w);
    }
  }

  /** Drop a wrong binding and start discovery over, clean. */
  private resetBinding(w: WatchedSession): void {
    w.boundFile = null;
    w.tails.clear();
    w.blocks = [];
    w.blockSeq = 0;
    w.toolBlocks.clear();
    w.snap = {
      sessionId: w.sessionId,
      bound: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      lines: 0,
      malformed: 0,
      toolsSeen: [],
      filesTouched: [],
      subagents: [],
      lastActivityAt: null,
    };
  }

  /** This pre-existing file is the session's OWN resumed conversation. */
  private isOwnResumedFile(w: WatchedSession, full: string): boolean {
    return !!w.nativeSessionId && path.basename(full) === `${w.nativeSessionId}.jsonl`;
  }

  /** Another watched session shares this cwd — binding is ambiguous. */
  private hasCwdSibling(w: WatchedSession): boolean {
    for (const other of this.sessions.values()) {
      if (other !== w && sameFolder(other.cwd, w.cwd)) return true;
    }
    return false;
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

  /** Live Feed blocks as they are derived (P2-E12-06). */
  onBlock(l: (sessionId: string, b: FeedBlock) => void): () => void {
    this.blockListeners.add(l);
    return () => this.blockListeners.delete(l);
  }

  /** Backlog of derived blocks for a session (attach/replay). */
  blocks(sessionId: string): FeedBlock[] {
    return [...(this.sessions.get(sessionId)?.blocks ?? [])];
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
          if (w.tails.has(full)) continue;
          // pre-existing files are never adopted — EXCEPT our own resumed
          // conversation (<nativeId>.jsonl existed before this launch by
          // definition; Dan's 2026-07-22 find: resumed cards had an empty
          // Session view forever). Replaying it from 0 also gives the Feed
          // the conversation history back.
          if (this.known.has(full) && !this.isOwnResumedFile(w, full)) continue;
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
    // Same-cwd sessions make cwd-only claims AMBIGUOUS (two sessions in one
    // folder must not steal each other's transcript): wait for the hooks to
    // deliver our native id, then bind on the id match above.
    if (!w.nativeSessionId && this.hasCwdSibling(w)) return false;
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

  private emitBlock(w: WatchedSession, b: Omit<FeedBlock, 'seq' | 'sidechain'>, sidechain: boolean): FeedBlock {
    // a thinking block's duration becomes known when the NEXT block lands
    const prev = w.blocks[w.blocks.length - 1];
    if (prev?.kind === 'thinking' && !prev.durationMs && prev.ts && b.ts) {
      const ms = Date.parse(b.ts) - Date.parse(prev.ts);
      if (Number.isFinite(ms) && ms > 0) {
        prev.durationMs = ms;
        this.reemit(w, prev);
      }
    }
    const block: FeedBlock = { ...b, seq: ++w.blockSeq, sidechain };
    w.blocks.push(block);
    if (w.blocks.length > BLOCK_CAP) w.blocks.splice(0, w.blocks.length - BLOCK_CAP);
    this.reemit(w, block);
    return block;
  }

  /** Send a block (new OR updated — same seq) to the listeners. */
  private reemit(w: WatchedSession, block: FeedBlock): void {
    for (const l of this.blockListeners) {
      try {
        l(w.sessionId, block);
      } catch (err) {
        this.opts.log.error('block listener threw', { sessionId: w.sessionId, error: String(err) });
      }
    }
  }

  /** Derive Feed blocks (E12-06) from one transcript line. Tolerant: unknown
   *  shapes produce nothing, never a throw. */
  private deriveBlocks(w: WatchedSession, full: string, e: Record<string, unknown>): void {
    const sidechain = full !== w.boundFile || e.isSidechain === true;
    const ts = typeof e.timestamp === 'string' ? e.timestamp : undefined;
    const message = e.message as { content?: unknown; role?: string } | undefined;
    if (!message) return;
    if (e.type === 'user') {
      // a real prompt is a string (or text items); tool_result items attach
      // their output to the originating tool block (E10-06 OUT sections)
      if (typeof message.content === 'string' && message.content.trim()) {
        this.emitBlock(w, { kind: 'user', text: message.content.slice(0, TEXT_CAP), ts }, sidechain);
      } else if (Array.isArray(message.content)) {
        for (const c of message.content as Array<{
          type?: string;
          text?: string;
          tool_use_id?: string;
          content?: unknown;
        }>) {
          if (c?.type === 'text' && c.text?.trim()) {
            this.emitBlock(w, { kind: 'user', text: c.text.slice(0, TEXT_CAP), ts }, sidechain);
          } else if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') {
            const target = w.toolBlocks.get(c.tool_use_id);
            if (target?.tool && !target.tool.out) {
              target.tool.out = toolResultText(c.content).slice(0, DETAIL_CAP);
              w.toolBlocks.delete(c.tool_use_id);
              this.reemit(w, target);
            }
          }
        }
      }
      return;
    }
    if (e.type !== 'assistant' || !Array.isArray(message.content)) return;
    for (const c of message.content as Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>) {
      if (c?.type === 'text' && c.text?.trim()) {
        this.emitBlock(w, { kind: 'assistant', text: c.text.slice(0, TEXT_CAP), ts }, sidechain);
      } else if (c?.type === 'thinking' && c.thinking?.trim()) {
        this.emitBlock(w, { kind: 'thinking', text: c.thinking.slice(0, TEXT_CAP), ts }, sidechain);
      } else if (c?.type === 'tool_use' && typeof c.name === 'string') {
        const input = c.input ?? {};
        // TodoWrite renders as a checklist block, not a raw tool row (E10-06)
        if (c.name === 'TodoWrite' && Array.isArray(input.todos)) {
          const todos = (input.todos as Array<{ content?: unknown; status?: unknown }>)
            .slice(0, 30)
            .map((td) => ({ content: String(td?.content ?? ''), status: String(td?.status ?? '') }));
          this.emitBlock(w, { kind: 'todos', todos, ts }, sidechain);
          continue;
        }
        const primary =
          input.file_path ?? input.path ?? input.notebook_path ?? input.command ?? input.description ?? input.pattern;
        const summary = typeof primary === 'string' ? primary.slice(0, 120) : '';
        let detail: string | undefined;
        try {
          detail = JSON.stringify(input, null, 2)?.slice(0, DETAIL_CAP);
        } catch {
          detail = undefined;
        }
        const tool: NonNullable<FeedBlock['tool']> = { name: c.name, summary, detail };
        // structured fields for the rich blocks (E10-06)
        if (typeof input.description === 'string') tool.description = input.description.slice(0, 120);
        if (typeof input.file_path === 'string') tool.filePath = input.file_path;
        if (typeof input.old_string === 'string') tool.oldString = input.old_string.slice(0, 1500);
        if (typeof input.new_string === 'string') tool.newString = input.new_string.slice(0, 1500);
        if (c.name === 'Write' && typeof input.content === 'string') {
          tool.newString = input.content.slice(0, 1500);
        }
        const block = this.emitBlock(w, { kind: 'tool', tool, ts }, sidechain);
        const useId = (c as { id?: unknown }).id;
        if (typeof useId === 'string') {
          w.toolBlocks.set(useId, block);
          // bounded: forget the oldest mappings past 200 in-flight calls
          if (w.toolBlocks.size > 200) {
            const first = w.toolBlocks.keys().next().value;
            if (first !== undefined) w.toolBlocks.delete(first);
          }
        }
      }
    }
  }

  private absorb(w: WatchedSession, full: string, e: Record<string, unknown>): void {
    if (full === w.boundFile && typeof e.sessionId === 'string' && !w.snap.nativeSessionId) {
      w.snap.nativeSessionId = e.sessionId;
    }
    this.deriveBlocks(w, full, e);
    const message = e.message as
      | { usage?: Record<string, number>; content?: unknown; model?: string }
      | undefined;
    if (typeof message?.model === 'string') w.snap.model = message.model;
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
        if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) {
          const todos = c.input.todos as Array<{ status?: string }>;
          w.snap.plan = {
            total: todos.length,
            completed: todos.filter((td) => td.status === 'completed').length,
            inProgress: todos.filter((td) => td.status === 'in_progress').length,
          };
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
