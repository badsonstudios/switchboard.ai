// ENGINE SEAM 1 (E40 item 03, #1286): the event path speaks neutral events,
// and Claude is translated behind its adapter.
//
// Two halves:
//   1. the PUMP — a provider's translator is the only thing that reads its
//      frames, and every way it can fail costs a frame, never a session;
//   2. the GREP — the done-when's "a test fails if a module outside
//      `src/main/providers/` imports the Claude stream protocol for these
//      paths". Each check is exact in both directions, so it fails the day a
//      Claude reading creeps back onto the event path AND the day an
//      allowlisted control-path reader (#1287) moves without this file being
//      told.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { SessionManager, StatusChange } from './session-manager';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { EventCapability, MainContributions } from '../extensibility/contributions';
import { SessionTransport, TransportSpawnOptions } from '../transport/transport';
import { Logger, LogFields } from '../log/logger';
import { claudeEvents } from '../providers/claude-events';
import type { EngineEvent } from './engine-events';

// ---- 1. the pump ------------------------------------------------------------

class MessageTransport implements SessionTransport {
  listeners = new Map<string, (m: Record<string, unknown>) => void>();
  spawn(opts: TransportSpawnOptions) {
    return {
      pid: 1,
      onExit: () => () => {},
      onMessage: (l: (m: Record<string, unknown>) => void) => {
        this.listeners.set(opts.id, l);
        return () => {};
      },
      kill: () => {},
    };
  }
  remove(): void {}
  emit(id: string, m: Record<string, unknown>): void {
    this.listeners.get(id)?.(m);
  }
}

type Line = { level: string; msg: string; fields?: LogFields };
function recordingLogger(lines: Line[]): Logger {
  const at =
    (level: string) =>
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
  return log;
}

const identity = { title: 't', folder: 'C:/tmp/x', providerId: 'p' };
let dir: string;
let stream: MessageTransport;
let lines: Line[];
let changes: StatusChange[];

beforeEach(() => {
  dir = tempDir('sb-seam-');
  stream = new MessageTransport();
  lines = [];
  changes = [];
});
afterEach(() => cleanupTempDirs());

function managerWith(events: EventCapability | undefined): SessionManager {
  const r = new ContributionRegistry<MainContributions>();
  r.register('provider-adapter', {
    manifest: { id: 'p', displayName: 'P', version: '0', capabilities: ['sessions.spawn'] },
    ...(events ? { capabilities: { events } } : {}),
    buildSpawn: () => ({ command: 'cli', args: [], env: {}, transport: 'stream' }),
  });
  const mgr = new SessionManager(r, new MessageTransport(), recordingLogger(lines), dir, { stream });
  mgr.onStatusChange((c) => changes.push(c));
  return mgr;
}

const assistant = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  parent_tool_use_id: null,
};

describe('the pump translates through the PROVIDER, and only through it', () => {
  it('a provider with no translator is NOT read as Claude: no events, no streamed status, one warning', () => {
    const mgr = managerWith(undefined);
    const got: EngineEvent[] = [];
    const raw: unknown[] = [];
    mgr.onEngineEvent((_id, ev) => got.push(ev));
    mgr.onStreamMessage((_id, m) => raw.push(m));
    const rec = mgr.create(identity);

    stream.emit(rec.id, assistant);
    stream.emit(rec.id, { type: 'system', subtype: 'init', session_id: 'conv-1' });
    stream.emit(rec.id, { type: 'result', subtype: 'success' });

    expect(got).toEqual([]);
    expect(mgr.get(rec.id)!.status).toBe('idle'); // spawn readiness only
    expect(mgr.get(rec.id)!.nativeSessionId).toBeUndefined();
    // the control path still hears the frames — that half is #1287's
    expect(raw).toHaveLength(3);
    expect(lines.filter((l) => l.level === 'warn' && /no event translator/.test(l.msg))).toHaveLength(1);
  });

  it('Claude frames drive status, native id and the event fan-out — with the same log causes', () => {
    const mgr = managerWith(claudeEvents);
    const got: string[] = [];
    mgr.onEngineEvent((_id, ev) => got.push(ev.type));
    const rec = mgr.create(identity);

    stream.emit(rec.id, { type: 'system', subtype: 'init', session_id: 'conv-1' });
    stream.emit(rec.id, assistant);
    stream.emit(rec.id, { type: 'result', subtype: 'success' });

    expect(mgr.get(rec.id)!.nativeSessionId).toBe('conv-1');
    expect(got).toEqual(['conversation', 'activity', 'message', 'turn-end']);
    expect(changes.map((c) => c.cause)).toEqual(['transport-ready', 'stream:assistant', 'stream:result:success']);
  });

  it('raw frames reach the control path BEFORE their events reach the event path', () => {
    const mgr = managerWith(claudeEvents);
    const order: string[] = [];
    mgr.onEngineEvent((_id, ev) => order.push(`event:${ev.type}`));
    mgr.onStreamMessage((_id, m) => order.push(`raw:${String(m.type)}`));
    const rec = mgr.create(identity);
    stream.emit(rec.id, assistant);
    expect(order).toEqual(['raw:assistant', 'event:activity', 'event:message']);
  });

  it('a translator that THROWS costs that frame only — the next one is read', () => {
    let calls = 0;
    const flaky: EventCapability = {
      createTranslator: (hooks) => {
        const real = claudeEvents.createTranslator(hooks);
        return (frame) => {
          calls++;
          if (calls === 1) throw new Error('boom');
          return real(frame);
        };
      },
    };
    const mgr = managerWith(flaky);
    const rec = mgr.create(identity);
    stream.emit(rec.id, assistant); // thrown
    expect(mgr.get(rec.id)!.status).toBe('idle');
    stream.emit(rec.id, assistant); // read
    expect(mgr.get(rec.id)!.status).toBe('working');
    expect(lines.some((l) => l.level === 'error' && /translator threw/.test(l.msg))).toBe(true);
  });

  it('a translator that cannot be CREATED leaves the session running, untranslated', () => {
    const mgr = managerWith({
      createTranslator: () => {
        throw new Error('no');
      },
    });
    const rec = mgr.create(identity);
    stream.emit(rec.id, assistant);
    expect(mgr.get(rec.id)!.status).toBe('idle');
    expect(lines.some((l) => l.level === 'error' && /could not be created/.test(l.msg))).toBe(true);
  });

  it('an unknown frame is logged once per type and skipped', () => {
    const mgr = managerWith(claudeEvents);
    const rec = mgr.create(identity);
    stream.emit(rec.id, { type: 'brand_new_frame' });
    stream.emit(rec.id, { type: 'brand_new_frame' });
    const said = lines.filter((l) => /not understood/.test(l.msg));
    expect(said).toHaveLength(1);
    expect(said[0].fields).toMatchObject({ sessionId: rec.id, frameType: 'brand_new_frame' });
  });

  it('one broken event listener does not starve the next', () => {
    const mgr = managerWith(claudeEvents);
    const got: string[] = [];
    mgr.onEngineEvent(() => {
      throw new Error('bad subscriber');
    });
    mgr.onEngineEvent((_id, ev) => got.push(ev.type));
    const rec = mgr.create(identity);
    stream.emit(rec.id, assistant);
    expect(got).toEqual(['activity', 'message']);
  });
});

// ---- 2. the grep ------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../../..');
const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join('/');

/** Production sources: no tests, no test fixtures. */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'fixtures' || e.name === 'node_modules') continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        out.push(rel(p));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return out.sort();
}

const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), 'utf8');

/**
 * Code with its comments removed and its strings KEPT — the wire is read
 * through string literals and property names, and the event-path modules'
 * comments still (rightly) describe Claude's frames.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
}

/** What `import … from '<spec>'` / `import('<spec>')` / `export … from` name. */
function importSpecifiers(src: string): string[] {
  const code = stripComments(src);
  const specs: string[] = [];
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)) {
    specs.push(m[1] ?? m[2] ?? m[3]);
  }
  return specs;
}

/**
 * Claude's stream-json vocabulary, as the event path used to read it. A hit is
 * the word ANYWHERE in code — a string literal, a property access, a
 * destructured name — but never in a comment, where these modules still
 * (rightly) describe the frames they used to read.
 *
 * WHAT THIS CANNOT SEE: Claude's generic words (`'assistant'`, `'user'`,
 * `'result'`, `'system'`, `'init'`, `subtype`). They are also neutral
 * vocabulary — `assistant` is a Feed block kind — so listing them would only
 * produce noise. The distinctive words below are how a frame reader gives
 * itself away. And the Feed's TRANSCRIPT replay (`hydrate` / `absorbSidechain`)
 * reads two transcript-entry fields, `isSidechain` and `timestamp`: that is
 * the `transcripts` capability's format, not the stream's, and is outside
 * this seam (DESIGN §5.3).
 */
const CLAUDE_WIRE = [
  'input_json_delta',
  'signature_delta',
  'message_delta',
  'compact_metadata',
  'pre_tokens',
  'post_tokens',
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'rate_limit_event',
  'keep_alive',
  'transcript_mirror',
  'active_goal',
  'stream_event',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'content_block',
  'message_start',
  'message_stop',
  'text_delta',
  'thinking_delta',
  'control_request',
  'can_use_tool',
  'conversation_reset',
  'new_conversation_id',
  'parent_tool_use_id',
  'session_id',
  'is_error',
  'local_command_run',
  'local_command_source',
  'compact_boundary',
  '<synthetic>',
];

function wireHits(src: string): string[] {
  const code = stripComments(src);
  return CLAUDE_WIRE.filter((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\<>]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`).test(code);
  });
}

/**
 * The pump: it still holds the raw frame (`m`) — the control path needs it —
 * so it cannot join the import check (it imports `stream-protocol` for
 * #1287), but it must read nothing of the frame on its own account.
 */
const READS_NO_WIRE = ['src/main/sessions/session-manager.ts'];

/**
 * THE EVENT PATH. These take neutral events and must read no provider's frames.
 * `engine-events.ts` is the model itself.
 */
const EVENT_PATH = [
  'src/main/feed/stream-feed.ts',
  'src/main/sessions/stream-status.ts',
  'src/main/sessions/state-machine.ts',
  'src/main/sessions/engine-events.ts',
  'src/main/health/service.ts',
  'src/main/health/corroboration.ts',
];

const TRANSLATOR = /(^|\/)providers\/claude-events$|^\.\/claude-events$/;

describe('the grep: nothing on the event path reads Claude', () => {
  it('the detector itself can fail (planted violations are caught, comments are not)', () => {
    expect(wireHits("if (m.type === 'stream_event') return;")).toEqual(['stream_event']);
    expect(wireHits('if (msg.parent_tool_use_id != null) return;')).toEqual(['parent_tool_use_id']);
    expect(wireHits('const x = { session_id: id };')).toEqual(['session_id']);
    expect(wireHits('const { session_id } = m;')).toEqual(['session_id']);
    expect(wireHits("// a `stream_event` frame\n/* control_request */ const ok = 1;")).toEqual([]);
    // a longer identifier that merely CONTAINS a word is not a hit
    expect(wireHits('const my_session_identity = 1;')).toEqual([]);
    expect(importSpecifiers("import { a } from '../../shared/stream-protocol';")).toEqual([
      '../../shared/stream-protocol',
    ]);
  });

  for (const f of EVENT_PATH) {
    it(`${f} reads no Claude wire field and imports no provider or protocol module`, () => {
      const src = read(f);
      expect(wireHits(src)).toEqual([]);
      const bad = importSpecifiers(src).filter((s) => /stream-protocol|(^|\/)providers\//.test(s));
      expect(bad).toEqual([]);
    });
  }

  for (const f of READS_NO_WIRE) {
    it(`${f} holds raw frames for the control path but reads no Claude wire field itself`, () => {
      expect(wireHits(read(f))).toEqual([]);
    });
  }

  it('the Feed takes events, not frames', () => {
    const code = stripComments(read('src/main/feed/stream-feed.ts'));
    expect(code).toMatch(/\bingest\(sessionId: string, ev: EngineEvent\)/);
    expect(code).not.toMatch(/\boffer\(/);
  });

  it('only src/main/providers/ imports the Claude translator', () => {
    const importers = productionSources().filter((f) => importSpecifiers(read(f)).some((s) => TRANSLATOR.test(s)));
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((f) => !f.startsWith('src/main/providers/'))).toEqual([]);
  });
});

/**
 * WHO STILL IMPORTS `shared/stream-protocol` — Claude's OUTBOUND contract
 * (prompt frames and control verbs). Every one of these is on the CONTROL
 * path, which E40 item 04 moves behind the adapter. Exact: a new importer
 * fails, and so does one that stopped importing without being struck off.
 */
const STREAM_PROTOCOL_IMPORTERS: Record<string, string> = {
  // #1287: sends the prompt frame, interrupt, and every control verb
  'src/main/sessions/session-manager.ts': '#1287',
  // #1287: answers `can_use_tool` (controlResponse)
  'src/main/sessions/stream-permissions.ts': '#1287',
  // #1287: correlates `control_response` to the request that asked
  'src/main/transport/control-channel.ts': '#1287',
  // #1287: the effort control's verbs (type-only reuse of the request envelope)
  'src/shared/effort.ts': '#1287',
  // #1287: the context-usage control's verb
  'src/shared/context-usage.ts': '#1287',
  // #1287: the model pickers read `list_models` (CliModel / readModels)
  'src/renderer/src/components/ModelPickerDialog.tsx': '#1287',
  'src/renderer/src/components/ModelQuickMenu.tsx': '#1287',
  'src/renderer/src/lib/model-choices.ts': '#1287',
};

/**
 * WHO STILL SUBSCRIBES TO RAW FRAMES. The control-path stores, each reading
 * Claude's frames itself until #1287 gives them neutral controls.
 */
const RAW_FRAME_SUBSCRIBERS = [
  'streamPermissions', // #1287: can_use_tool requests and their answers
  'streamCommands', // #1287: the CLI's slash-command list (system:init)
  'streamModel', // #1287: the running model (system:init.model)
  'streamMode', // #1287: the permission mode (system:status)
];

describe('the grep: the control path, named until #1287 moves it', () => {
  it('stream-protocol is imported only by providers/ and the named control-path modules', () => {
    const importers = productionSources().filter(
      (f) =>
        f !== 'src/shared/stream-protocol.ts' &&
        !f.startsWith('src/main/providers/') &&
        importSpecifiers(read(f)).some((s) => /(^|\/)stream-protocol$/.test(s))
    );
    expect(importers).toEqual(Object.keys(STREAM_PROTOCOL_IMPORTERS).sort());
  });

  it('raw frames reach only the named control-path stores, and the Feed and health are not among them', () => {
    const subscribers: string[] = [];
    const calls = new Map<string, number>();
    for (const f of productionSources()) {
      const code = stripComments(read(f));
      const n = code.split('.onStreamMessage(').length - 1;
      if (n === 0) continue;
      calls.set(f, n);
      for (const m of code.matchAll(/\.onStreamMessage\(\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*(\w+)\./g)) {
        subscribers.push(m[1]);
      }
    }
    // index.ts wires the stores and nothing else — EVERY call there must be
    // one of them, so a subscriber written in a shape the pattern does not
    // parse (`onStreamMessage(handler)`, a block body) still fails the count.
    // The manager's one call is its own control channel.
    expect([...calls.entries()]).toEqual([
      ['src/main/index.ts', RAW_FRAME_SUBSCRIBERS.length],
      ['src/main/sessions/session-manager.ts', 1],
    ]);
    expect(subscribers.sort()).toEqual([...RAW_FRAME_SUBSCRIBERS].sort());
  });

  it('the Feed and health hear NEUTRAL events', () => {
    const code = stripComments(read('src/main/index.ts'));
    expect(code).toMatch(/manager\.onEngineEvent\(\(sessionId, ev\) => streamFeed\.ingest\(sessionId, ev\)\)/);
    expect(code).toMatch(/manager\.onEngineEvent\(\(sessionId, ev\) => health\.noteEvent\(sessionId, ev\)\)/);
  });

  it('both Claude adapters declare the translator', () => {
    for (const f of ['src/main/providers/claude.ts', 'src/main/providers/fake-stream.ts']) {
      expect(stripComments(read(f))).toMatch(/\bevents: claudeEvents\b/);
    }
  });
});
