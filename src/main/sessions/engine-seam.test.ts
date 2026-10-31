// ENGINE SEAMS 1 AND 2 (E40 items 03 and 04, #1286 and #1287): the event path
// speaks neutral events, the control path speaks neutral controls, and Claude
// is translated and driven behind its adapter.
//
// Three parts:
//   1. the PUMP — a provider's translator and its own controls are the only
//      things that read its frames, and every way either can fail costs a
//      frame, never a session;
//   2. the CONTROLS — what a session can be asked to do is what its provider
//      DECLARED, a control it lacks is answered `unsupported` and never thrown,
//      and the declaration is what `sessions:controls` gives the composer to
//      grey out by (with a test-only provider that declares a reduced set);
//   3. the GREP — no module outside `src/main/providers/` imports a Claude
//      wire module or speaks `control_request` / `can_use_tool`, nothing
//      subscribes to raw frames at all, and (#1303) the Feed's history replay
//      reads Claude's TRANSCRIPT no more than it reads its stream. Each check
//      is exact in both directions.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { SessionManager, StatusChange } from './session-manager';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { EventCapability, MainContributions } from '../extensibility/contributions';
import type { ControlCapability, SessionControls } from './engine-controls';
import { declaredControls } from './engine-controls';
import { ENGINE_CONTROLS } from '../../shared/engine-controls';
import { claudeControls, createClaudeControls } from '../providers/claude-controls';
import { emptyLog, reducedControls, REDUCED_AI_NAME } from './fixtures/reduced-controls';
import { SessionTransport, TransportSpawnOptions } from '../transport/transport';
import { Logger, LogFields } from '../log/logger';
import { claudeEvents } from '../providers/claude-events';
import type { EngineEvent } from './engine-events';

// ---- 1. the pump ------------------------------------------------------------

class MessageTransport implements SessionTransport {
  listeners = new Map<string, (m: Record<string, unknown>) => void>();
  sent: unknown[] = [];
  spawn(opts: TransportSpawnOptions) {
    return {
      pid: 1,
      onExit: () => () => {},
      onMessage: (l: (m: Record<string, unknown>) => void) => {
        this.listeners.set(opts.id, l);
        return () => {};
      },
      send: (m: unknown) => void this.sent.push(m),
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

function managerWith(
  events: EventCapability | undefined,
  controls?: ControlCapability,
  displayName = 'P'
): SessionManager {
  const r = new ContributionRegistry<MainContributions>();
  r.register('provider-adapter', {
    manifest: { id: 'p', displayName, version: '0', capabilities: ['sessions.spawn'] },
    ...(events || controls ? { capabilities: { events, controls } } : {}),
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
    const controls = reducedControls();
    const mgr = managerWith(undefined, controls);
    const got: EngineEvent[] = [];
    mgr.onEngineEvent((_id, ev) => got.push(ev));
    const rec = mgr.create(identity);

    stream.emit(rec.id, assistant);
    stream.emit(rec.id, { type: 'system', subtype: 'init', session_id: 'conv-1' });
    stream.emit(rec.id, { type: 'result', subtype: 'success' });

    expect(got).toEqual([]);
    expect(mgr.get(rec.id)!.status).toBe('idle'); // spawn readiness only
    expect(mgr.get(rec.id)!.nativeSessionId).toBeUndefined();
    // the provider's OWN controls still hear the frames (their replies)
    expect(controls.log.frames).toHaveLength(3);
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

  it("a frame reaches the provider's controls BEFORE its events reach the listeners", () => {
    const order: string[] = [];
    const recording: ControlCapability = {
      createControls: () => ({ receive: (m) => order.push(`raw:${String(m.type)}`) }),
    };
    const mgr = managerWith(claudeEvents, recording);
    mgr.onEngineEvent((_id, ev) => order.push(`event:${ev.type}`));
    const rec = mgr.create(identity);
    stream.emit(rec.id, assistant);
    expect(order).toEqual(['raw:assistant', 'event:activity', 'event:message']);
  });

  it("controls that THROW on a frame cost that frame's reply only — the events still flow", () => {
    const throwing: ControlCapability = {
      createControls: () => ({
        receive: () => {
          throw new Error('bad controls');
        },
      }),
    };
    const mgr = managerWith(claudeEvents, throwing);
    const got: string[] = [];
    mgr.onEngineEvent((_id, ev) => got.push(ev.type));
    const rec = mgr.create(identity);
    stream.emit(rec.id, assistant);
    expect(got).toEqual(['activity', 'message']);
    expect(mgr.get(rec.id)!.status).toBe('working');
    expect(lines.some((l) => l.level === 'error' && /controls threw on a frame/.test(l.msg))).toBe(true);
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

// ---- 2. the controls --------------------------------------------------------

describe('controls go through the PROVIDER, and only what it declared', () => {
  const hasAll = [...ENGINE_CONTROLS];

  it('Claude declares every control the host knows (so nothing greys out for it)', () => {
    const controls = createClaudeControls({ id: 's', send: () => true });
    expect(declaredControls(controls)).toEqual(hasAll);
    // …and the plumbing every engine needs
    expect(typeof controls.prompt).toBe('function');
    expect(typeof controls.receive).toBe('function');
  });

  it('a session reports its AI and the controls it has', () => {
    const mgr = managerWith(claudeEvents, claudeControls, 'Claude Code');
    const rec = mgr.create(identity);
    expect(mgr.controlsOf(rec.id)).toEqual({ ai: 'Claude Code', has: hasAll });
    expect(mgr.controlsOf('no-such-session')).toBeNull();
  });

  describe('a provider that declares a REDUCED set', () => {
    it('reports exactly the reduced set, under its own name', () => {
      const mgr = managerWith(claudeEvents, reducedControls(), REDUCED_AI_NAME);
      const rec = mgr.create(identity);
      expect(mgr.controlsOf(rec.id)).toEqual({ ai: REDUCED_AI_NAME, has: ['approvals', 'interrupt'] });
    });

    it('every control it lacks answers `unsupported`, naming the AI — never a throw', async () => {
      const mgr = managerWith(claudeEvents, reducedControls(), REDUCED_AI_NAME);
      const rec = mgr.create(identity);
      const unsupported = {
        ok: false,
        reason: 'unsupported',
        message: `Not available with ${REDUCED_AI_NAME}.`,
      };
      await expect(mgr.listModels(rec.id)).resolves.toEqual(unsupported);
      await expect(mgr.setModel(rec.id, 'm')).resolves.toEqual(unsupported);
      await expect(mgr.effort(rec.id)).resolves.toEqual(unsupported);
      await expect(mgr.setEffort(rec.id, 'high')).resolves.toEqual(unsupported);
      await expect(mgr.contextUsage(rec.id)).resolves.toEqual(unsupported);
      await expect(mgr.mcpStatus(rec.id)).resolves.toEqual(unsupported);
      await expect(mgr.mcpToggle(rec.id, 'x', true)).resolves.toEqual(unsupported);
      await expect(mgr.mcpReconnect(rec.id, 'x')).resolves.toEqual(unsupported);
      await expect(mgr.mcpAuthenticate(rec.id, 'x')).resolves.toEqual(unsupported);
      await expect(mgr.mcpClearAuth(rec.id, 'x')).resolves.toEqual(unsupported);
      // a session that is gone still says so first
      await expect(mgr.listModels('gone')).resolves.toMatchObject({ reason: 'session-gone' });
    });

    it('the controls it HAS are reached in neutral words', () => {
      const controls = reducedControls();
      const mgr = managerWith(claudeEvents, controls, REDUCED_AI_NAME);
      const rec = mgr.create(identity);
      expect(mgr.interrupt(rec.id)).toBe(true);
      expect(controls.log.interrupts).toEqual([rec.id]);
      expect(mgr.answerPermission(rec.id, 'r-0', { behavior: 'deny', message: 'no' })).toBe(true);
      expect(controls.log.answers).toEqual([
        { sessionId: rec.id, requestId: 'r-0', decision: { behavior: 'deny', message: 'no' } },
      ]);
      mgr.forgetControls(rec.id);
      expect(controls.log.forgotten).toEqual([rec.id]);
    });

    it('with no prompt control, a prompt does not go — and the session is not marked working', () => {
      const mgr = managerWith(claudeEvents, reducedControls(), REDUCED_AI_NAME);
      const rec = mgr.create(identity);
      expect(mgr.submitPrompt(rec.id, 'hello')).toBe(false);
      expect(mgr.get(rec.id)!.status).toBe('idle');
      expect(lines.some((l) => l.level === 'warn' && /takes no prompt/.test(l.msg))).toBe(true);
    });
  });

  it('a provider with NO controls can be read and not driven: nothing throws', async () => {
    const mgr = managerWith(claudeEvents, undefined, 'Bare');
    const rec = mgr.create(identity);
    expect(mgr.controlsOf(rec.id)).toEqual({ ai: 'Bare', has: [] });
    expect(mgr.interrupt(rec.id)).toBe(false);
    expect(mgr.submitPrompt(rec.id, 'hi')).toBe(false);
    expect(mgr.answerPermission(rec.id, 'r', { behavior: 'deny', message: 'x' })).toBe(false);
    await expect(mgr.listModels(rec.id)).resolves.toMatchObject({ ok: false, reason: 'unsupported' });
    expect(() => mgr.forgetControls(rec.id)).not.toThrow();
    expect(lines.filter((l) => l.level === 'warn' && /declares no controls/.test(l.msg))).toHaveLength(1);
  });

  it('controls that cannot be CREATED leave the session running, with none', () => {
    const mgr = managerWith(claudeEvents, {
      createControls: () => {
        throw new Error('no');
      },
    });
    const rec = mgr.create(identity);
    stream.emit(rec.id, assistant);
    expect(mgr.get(rec.id)!.status).toBe('working');
    expect(mgr.controlsOf(rec.id)).toEqual({ ai: 'P', has: [] });
    expect(lines.some((l) => l.level === 'error' && /controls could not be created/.test(l.msg))).toBe(true);
  });

  it('a control that throws, or rejects, is answered as a refusal and logged (P6)', async () => {
    const broken: ControlCapability = {
      createControls: (): SessionControls => ({
        models: {
          list: () => {
            throw new Error('sync boom');
          },
          set: () => Promise.reject(new Error('async boom')),
        },
        interrupt: {
          interrupt: () => {
            throw new Error('boom');
          },
        },
        approvals: {
          answer: () => {
            throw new Error('boom');
          },
        },
        prompt: () => {
          throw new Error('boom');
        },
      }),
    };
    const mgr = managerWith(claudeEvents, broken);
    const rec = mgr.create(identity);
    await expect(mgr.listModels(rec.id)).resolves.toMatchObject({ ok: false, reason: 'refused' });
    await expect(mgr.setModel(rec.id, 'x')).resolves.toMatchObject({ ok: false, reason: 'refused' });
    expect(mgr.interrupt(rec.id)).toBe(false);
    expect(mgr.answerPermission(rec.id, 'r', { behavior: 'deny', message: 'x' })).toBe(false);
    expect(mgr.submitPrompt(rec.id, 'hi')).toBe(false);
    expect(lines.filter((l) => l.level === 'error' && /control threw|controls threw/.test(l.msg)).length).toBeGreaterThanOrEqual(5);
    // …and the session is still there, still readable
    stream.emit(rec.id, assistant);
    expect(mgr.get(rec.id)!.status).toBe('working');
  });

  it('removing a session settles what its controls had in flight', () => {
    const controls = reducedControls(emptyLog());
    const mgr = managerWith(claudeEvents, controls);
    const rec = mgr.create(identity);
    mgr.remove(rec.id);
    expect(controls.log.forgotten).toEqual([rec.id]);
    expect(mgr.controlsOf(rec.id)).toBeNull();
  });
});

// ---- 3. the grep ------------------------------------------------------------

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
 * itself away. The TRANSCRIPT's own words are `CLAUDE_TRANSCRIPT`, below: since
 * #1303 the Feed's replay reads none of them either.
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
 * The pump: it still holds the raw frame (`m`) — it hands it to the provider's
 * translator and the provider's own controls — but it must read nothing of
 * the frame on its own account.
 */
const READS_NO_WIRE = ['src/main/sessions/session-manager.ts'];

/**
 * THE EVENT PATH. These take neutral events and must read no provider's frames.
 * `engine-events.ts` is the model itself.
 */
const EVENT_PATH = [
  'src/main/feed/stream-feed.ts',
  // …and the Feed's own vocabulary, which every engine derives INTO (#1303:
  // Claude's derivation moved out of it, to `providers/claude-transcript.ts`)
  'src/main/feed/blocks.ts',
  'src/main/feed/buffer.ts',
  'src/main/sessions/stream-status.ts',
  'src/main/sessions/state-machine.ts',
  'src/main/sessions/engine-events.ts',
  'src/main/health/service.ts',
  'src/main/health/corroboration.ts',
  // …and, since #1287, the control path: neutral events in, neutral controls out
  'src/main/sessions/stream-permissions.ts',
  'src/main/sessions/stream-commands.ts',
  'src/main/sessions/stream-model.ts',
  'src/main/sessions/stream-mode.ts',
  'src/main/sessions/engine-controls.ts',
  'src/shared/engine-controls.ts',
  'src/shared/models.ts',
  'src/shared/effort.ts',
  'src/shared/context-usage.ts',
  'src/shared/control.ts',
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
    it(`${f} reads no Claude wire or transcript field and imports no provider or protocol module`, () => {
      const src = read(f);
      expect(wireHits(src)).toEqual([]);
      expect(transcriptHits(src)).toEqual([]);
      const bad = importSpecifiers(src).filter((s) => /stream-protocol|(^|\/)providers\//.test(s));
      expect(bad).toEqual([]);
    });
  }

  for (const f of READS_NO_WIRE) {
    it(`${f} hands raw frames to the provider's translator and controls but reads no Claude wire field itself`, () => {
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
 * Claude's TRANSCRIPT vocabulary (#1303): the fields of a JSONL line the Feed's
 * replay used to read for itself — `isSidechain` and `timestamp` in
 * `hydrate` / `absorbSidechain`, the summary and drop flags through the
 * derivation it called. Since #1303 a provider's reader turns a line into a
 * neutral `ReplayEntry` (`at`, `origin`, `compactionSummary`, `derive`), and
 * nothing on the event path may spell any of these in code.
 */
const CLAUDE_TRANSCRIPT = [
  'timestamp',
  'isSidechain',
  'isCompactSummary',
  'is_compact_summary',
  'isVisibleInTranscriptOnly',
  'is_visible_in_transcript_only',
  'isSynthetic',
  'isMeta',
  'is_meta',
];

function transcriptHits(src: string): string[] {
  const code = stripComments(src);
  return CLAUDE_TRANSCRIPT.filter((w) => new RegExp(`(?<![A-Za-z0-9_])${w}(?![A-Za-z0-9_])`).test(code));
}

/**
 * Claude's history READER — the derivation of one transcript line, and the
 * `ReplayEntry` reader built on it (#1303).
 */
const CLAUDE_TRANSCRIPT_MODULE = /(^|\/)(providers\/)?claude-transcript$/;

/**
 * The host modules that read Claude's JSONL through that derivation and are
 * NOT the Feed's replay: the watcher's own Feed for a transcript-driven
 * session, session find, and the bus's rendered transcript. They read a
 * Claude transcript by definition — the files the `transcripts` capability
 * locates — and DESIGN §5.3 keeps the tailing host-side. Exact, so a new
 * reader is a decision rather than a drift.
 */
const READS_CLAUDE_TRANSCRIPTS = [
  'src/main/sessions/transcript-blocks.ts',
  'src/main/transcripts/search.ts',
  'src/main/transcripts/watcher.ts',
];

describe('the grep: the Feed replays history through the PROVIDER (#1303)', () => {
  it('the detector itself can fail', () => {
    expect(transcriptHits("const at = typeof e.timestamp === 'string' ? 1 : 0;")).toEqual(['timestamp']);
    expect(transcriptHits('const o = { sidechain: e.isSidechain === true };')).toEqual(['isSidechain']);
    expect(transcriptHits('// reads `isSidechain` and `timestamp`\nconst ok = 1;')).toEqual([]);
    expect(transcriptHits('const timestamps = 1;')).toEqual([]);
    expect(importSpecifiers("import { deriveIntents } from '../providers/claude-transcript';").some((s) => CLAUDE_TRANSCRIPT_MODULE.test(s))).toBe(true);
    expect(importSpecifiers("import { deriveIntents } from './claude-transcript';").some((s) => CLAUDE_TRANSCRIPT_MODULE.test(s))).toBe(true);
  });

  it('hydrate and absorbSidechain take ReplayEntries, not transcript lines', () => {
    const code = stripComments(read('src/main/feed/stream-feed.ts'));
    expect(code).toMatch(/\bhydrate\(\s*sessionId: string,\s*entries: readonly ReplayEntry\[\],/);
    expect(code).toMatch(/\babsorbSidechain\(sessionId: string, entry: ReplayEntry\)/);
    // …and the replay's caller hands them over as its provider read them
    expect(stripComments(read('src/main/feed/history.ts'))).toMatch(/args\.readEntry\(e, merged\.origins\.get\(e\)\)/);
  });

  it("the derivation is no longer the Feed's: feed/ neither defines nor imports it", () => {
    expect(stripComments(read('src/main/feed/blocks.ts'))).not.toMatch(/\bfunction deriveIntents\b/);
    const feedImporters = productionSources().filter(
      (f) => f.startsWith('src/main/feed/') && importSpecifiers(read(f)).some((s) => CLAUDE_TRANSCRIPT_MODULE.test(s))
    );
    expect(feedImporters).toEqual([]);
  });

  it("outside src/main/providers/, exactly the named host readers import Claude's history reader", () => {
    const importers = productionSources().filter(
      (f) => !f.startsWith('src/main/providers/') && importSpecifiers(read(f)).some((s) => CLAUDE_TRANSCRIPT_MODULE.test(s))
    );
    expect(importers).toEqual(READS_CLAUDE_TRANSCRIPTS);
  });

  it('both Claude adapters declare the reader on their transcripts capability', () => {
    for (const f of ['src/main/providers/claude.ts', 'src/main/providers/fake-stream.ts']) {
      expect(stripComments(read(f))).toMatch(/\btranscripts: \{ projectsRoot: claudeProjectsRoot, readEntry: readClaudeTranscriptEntry \}/);
    }
  });
});

/**
 * Claude's WIRE MODULES — its translator, its controls and everything they
 * build frames with. Only `src/main/providers/` may import any of them (#1287:
 * this list was an allowlist of eight control-path importers of
 * `shared/stream-protocol`, and is now empty — the module itself moved inside
 * the provider as `claude-protocol.ts`).
 */
const CLAUDE_WIRE_MODULES =
  /(^|\/)(providers\/)?claude-(events|controls|control-channel|protocol|effort|context-usage|modes)$|(^|\/)stream-protocol$/;

/**
 * Claude's CONTROL vocabulary. No production module outside
 * `src/main/providers/` may speak it in code.
 *
 * ONE DOCUMENTED EXCEPTION: `src/main/bus/mcp-attach-check.ts`, the
 * `check:mcp-attach` harness. It is not app code — it is a local-only script
 * (`check-scripts.test.ts`'s LOCAL_ONLY map) that spawns the REAL `claude` and
 * asks it `mcp_status` itself, precisely so the bus is checked against the
 * CLI rather than against our own controls. Routing it through the provider
 * would make it test the thing it exists to check.
 */
const CONTROL_WIRE = ['control_request', 'control_response', 'control_cancel_request', 'can_use_tool'];
const SPEAKS_CONTROL_WIRE_ON_PURPOSE = ['src/main/bus/mcp-attach-check.ts'];

function controlWireHits(src: string): string[] {
  const code = stripComments(src);
  return CONTROL_WIRE.filter((w) => new RegExp(`(?<![A-Za-z0-9_])${w}(?![A-Za-z0-9_])`).test(code));
}

describe('the grep: the control path speaks no provider wire (#1287)', () => {
  it('the detector itself can fail', () => {
    expect(controlWireHits("if (m.type === 'control_request') return;")).toEqual(['control_request']);
    expect(controlWireHits("// a `can_use_tool` request\nconst ok = 1;")).toEqual([]);
    expect(importSpecifiers("import { a } from '../providers/claude-protocol';").some((s) => CLAUDE_WIRE_MODULES.test(s))).toBe(true);
    expect(importSpecifiers("import { a } from './claude-effort';").some((s) => CLAUDE_WIRE_MODULES.test(s))).toBe(true);
    expect(importSpecifiers("import { a } from '../../shared/stream-protocol';").some((s) => CLAUDE_WIRE_MODULES.test(s))).toBe(true);
    expect(importSpecifiers("import { a } from '../../shared/models';").some((s) => CLAUDE_WIRE_MODULES.test(s))).toBe(false);
  });

  it('no module outside src/main/providers/ imports a Claude wire module', () => {
    const importers = productionSources().filter(
      (f) => !f.startsWith('src/main/providers/') && importSpecifiers(read(f)).some((s) => CLAUDE_WIRE_MODULES.test(s))
    );
    expect(importers).toEqual([]);
  });

  it('the old shared wire module is gone (it moved inside the provider)', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/shared/stream-protocol.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/main/transport/control-channel.ts'))).toBe(false);
  });

  it('no module outside src/main/providers/ speaks control_request or can_use_tool', () => {
    const speakers = productionSources().filter(
      (f) => !f.startsWith('src/main/providers/') && controlWireHits(read(f)).length > 0
    );
    expect(speakers).toEqual(SPEAKS_CONTROL_WIRE_ON_PURPOSE);
  });

  it('nothing subscribes to raw frames: the manager has no raw fan-out at all', () => {
    const subscribers = productionSources().filter((f) => stripComments(read(f)).includes('.onStreamMessage('));
    expect(subscribers).toEqual([]);
    expect(stripComments(read('src/main/sessions/session-manager.ts'))).not.toMatch(/\bonStreamMessage\b/);
  });

  it('the router and the command, model and mode stores hear NEUTRAL events', () => {
    const code = stripComments(read('src/main/index.ts'));
    for (const store of ['streamPermissions', 'streamCommands', 'streamModel', 'streamMode']) {
      expect(code).toMatch(new RegExp(`manager\\.onEngineEvent\\(\\(sessionId, ev\\) => ${store}\\.ingest\\(sessionId, ev\\)\\)`));
    }
    // …and the router answers through the provider, not the transport
    expect(code).toMatch(/manager\.answerPermission\(sessionId, requestId, decision\)/);
    expect(code).not.toMatch(/manager\.sendToTransport\(/);
  });
});

/**
 * The ACP engine's WIRE MODULES (E40 item 06, #1289) — the same discipline as
 * Claude's. Only `src/main/providers/` may import them; `bootstrap.ts` imports
 * the fake ACP ADAPTER (`acp/fake-acp`), which is the registration and not the
 * wire, so it is not on this list.
 */
const ACP_WIRE_MODULES = /(^|\/)(acp\/)?(acp-protocol|acp-events|acp-session|fake-acp-agent)$/;
/** ACP's wire vocabulary, in code. */
const ACP_WIRE = [
  'session/request_permission',
  'session/prompt',
  'session/update',
  'session/set_config_option',
  'sessionUpdate',
  'agent_message_chunk',
  'tool_call_update',
];

function acpWireHits(src: string): string[] {
  const code = stripComments(src);
  return ACP_WIRE.filter((w) => code.includes(w));
}

describe('the grep: nothing outside the providers speaks ACP (#1289)', () => {
  it('the detector itself can fail', () => {
    expect(acpWireHits("if (u.sessionUpdate === 'agent_message_chunk') return;")).toEqual(['sessionUpdate', 'agent_message_chunk']);
    expect(acpWireHits('// a `session/update` notification\nconst ok = 1;')).toEqual([]);
    expect(importSpecifiers("import { a } from '../providers/acp/acp-protocol';").some((s) => ACP_WIRE_MODULES.test(s))).toBe(true);
    expect(importSpecifiers("import { a } from './providers/acp/fake-acp';").some((s) => ACP_WIRE_MODULES.test(s))).toBe(false);
  });

  it('no module outside src/main/providers/ imports an ACP wire module', () => {
    const importers = productionSources().filter(
      (f) => !f.startsWith('src/main/providers/') && importSpecifiers(read(f)).some((s) => ACP_WIRE_MODULES.test(s))
    );
    expect(importers).toEqual([]);
  });

  it('no module outside src/main/providers/ speaks ACP in code', () => {
    const speakers = productionSources().filter((f) => !f.startsWith('src/main/providers/') && acpWireHits(read(f)).length > 0);
    expect(speakers).toEqual([]);
  });
});

describe('the grep: the Feed and health', () => {
  it('the Feed and health hear NEUTRAL events', () => {
    const code = stripComments(read('src/main/index.ts'));
    expect(code).toMatch(/manager\.onEngineEvent\(\(sessionId, ev\) => streamFeed\.ingest\(sessionId, ev\)\)/);
    expect(code).toMatch(/manager\.onEngineEvent\(\(sessionId, ev\) => health\.noteEvent\(sessionId, ev\)\)/);
  });

  it('both Claude adapters declare the translator and the controls', () => {
    for (const f of ['src/main/providers/claude.ts', 'src/main/providers/fake-stream.ts']) {
      expect(stripComments(read(f))).toMatch(/\bevents: claudeEvents\b/);
      expect(stripComments(read(f))).toMatch(/\bcontrols: claudeControls\b/);
    }
  });
});
