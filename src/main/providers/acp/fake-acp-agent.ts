// A FAKE ACP AGENT (E40 item 06, #1289) — what `fake-stream-protocol.ts` is
// for Claude: a real program that speaks the real protocol, hermetic (no
// network, no login), so the ACP engine and the e2e suite run on any machine.
//
// THE FRAMES ARE SHAPED LIKE CODEX'S. Every shape below follows a frame
// captured from `@agentclientprotocol/codex-acp@2.2.2`
// (`spike/probes/1285/captures/*.jsonl`): the `initialize` result's layout,
// `configOptions` with categories, chunks with a `messageId`, a shell
// `tool_call` whose content is `{type:"terminal"}` and whose result is only
// `_meta.terminal_exit.exit_code`, a permission request whose `optionId`s are
// NOT its kinds and whose first id is `0`, a reject that ends the whole turn
// `cancelled` with `usage: null`, and a `session/load` that replays history
// and RESETS model, effort and mode to the defaults. A fake kinder than the
// real agent would hide exactly the cases the engine exists to handle.
//
// SCRIPTED BY THE PROMPT TEXT:
//
//   (anything)    two text chunks echoing the prompt, then `end_turn` + usage
//   !think        a thought chunk first
//   !tool         a shell tool call that finishes with exit code 0
//   !edit         an edit tool call carrying a diff
//   !ask          a tool call that asks permission; allow runs it, reject ends
//                 the turn `cancelled` (as Codex does)
//   !cancel-slow  streams a chunk every 50 ms until `session/cancel`
//   !error        the prompt fails with a JSON-RPC error
//   !unknown      an unknown update variant, an unknown extension
//                 notification, and a line that is not JSON — then a reply
//   !plan         a two-entry plan
//   !mode         replies with the mode it is in (proves a live switch)
//   !state        replies with its model, effort and mode
//   !mcp          replies with the MCP servers `session/new` handed it
//   !fs           asks the client `fs/read_text_file` and reports the answer
//
// `FAKE_ACP_REQUIRE_AUTH=1` makes `session/new` fail -32000 until
// `authenticate {methodId:"fake-login"}`. History persists to
// `<home>/.fake-acp/<sessionId>.json` after each turn (a session with no
// prompt is not persisted, as Codex's is not).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { errorText } from '../../../shared/error-text';

type Obj = Record<string, unknown>;

export interface FakeAcpOptions {
  /** one frame out — an object, or a raw line (for the not-JSON case) */
  write(frame: Obj | string): void;
  /** where conversations persist; default `<home>/.fake-acp` */
  storeDir?: string;
  requireAuth?: boolean;
  /** ms between `!cancel-slow` chunks */
  tickMs?: number;
}

const DEFAULTS = { model: 'fake-large', effort: 'medium', mode: 'default' };

const MODELS = [
  { value: 'fake-large', name: 'Fake Large', description: 'The thorough one' },
  {
    value: 'fake-small',
    name: 'Fake Small',
    description: 'Fast and affordable',
  },
];
const EFFORTS = ['low', 'medium', 'high'];
const MODES = [
  {
    id: 'default',
    name: 'Default',
    description: 'Asks before running commands',
  },
  { id: 'read-only', name: 'Read only', description: 'Reads, never writes' },
  {
    id: 'accept-edits',
    name: 'Accept edits',
    description: 'Edits without asking',
  },
  { id: 'yolo', name: 'Full access', description: 'Never asks' },
];

/** The host-autonomy map the fake provider registers with (`fake-acp.ts`). */
export const FAKE_ACP_MODE_MAP = {
  ask: 'default',
  plan: 'read-only',
  'auto-edit': 'accept-edits',
  'full-auto': 'yolo',
} as const;

interface Conversation {
  id: string;
  cwd: string;
  model: string;
  effort: string;
  mode: string;
  mcpServers: string[];
  history: Array<{ role: 'user' | 'agent'; text: string }>;
  usedTokens: number;
}

interface Active {
  requestId: unknown;
  conversation: Conversation;
  cancelled: boolean;
  timer?: ReturnType<typeof setInterval>;
  /** the permission request we are waiting on, and what to do with the answer */
  waiting?: { id: number; onAnswer: (outcome: Obj) => void };
  /** an `fs/*` request we are waiting on */
  fsWaiting?: { id: number; onAnswer: (frame: Obj) => void };
}

export class FakeAcpAgent {
  private readonly conversations = new Map<string, Conversation>();
  private readonly active = new Map<string, Active>();
  private authed = false;
  /** agent -> client request ids START AT 0, as Codex's do */
  private nextOutId = 0;
  private readonly storeDir: string;

  constructor(private readonly opts: FakeAcpOptions) {
    this.storeDir = opts.storeDir ?? path.join(os.homedir(), '.fake-acp');
  }

  /** One frame in from the client. Never throws. */
  receive(frame: unknown): void {
    try {
      this.dispatch(frame as Obj);
    } catch (err) {
      const f = frame as Obj;
      if (f && f.id !== undefined && typeof f.method === 'string') this.error(f.id, -32603, errorText(err));
    }
  }

  private dispatch(f: Obj): void {
    if (!f || typeof f !== 'object') return;
    const method = typeof f.method === 'string' ? f.method : undefined;
    const params = (f.params && typeof f.params === 'object' ? f.params : {}) as Obj;
    if (method === undefined) return this.onReply(f);
    switch (method) {
      case 'initialize':
        return this.result(f.id, {
          protocolVersion: 1,
          agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '0.0.0' },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { embeddedContext: false, image: true },
            mcpCapabilities: { acp: false, http: false, sse: false },
          },
          authMethods: [
            {
              id: 'fake-login',
              name: 'Fake login',
              description: 'A sign-in that always works',
            },
          ],
        });
      case 'authenticate':
        if (params.methodId !== 'fake-login') return this.error(f.id, -32602, 'unknown auth method');
        this.authed = true;
        return this.result(f.id, {});
      case 'session/new':
        return this.newSession(f.id, params);
      case 'session/load':
        return this.loadSession(f.id, params);
      case 'session/prompt':
        return this.prompt(f.id, params);
      case 'session/cancel':
        return this.cancel(params);
      case 'session/set_config_option':
        return this.setConfig(f.id, params);
      case 'session/set_mode': {
        const c = this.conversations.get(String(params.sessionId));
        if (!c) return this.error(f.id, -32002, 'no such session');
        if (!MODES.some((m) => m.id === params.modeId)) return this.error(f.id, -32602, 'unknown mode');
        c.mode = String(params.modeId);
        return this.result(f.id, {});
      }
      case 'session/set_model': {
        const c = this.conversations.get(String(params.sessionId));
        if (!c) return this.error(f.id, -32002, 'no such session');
        c.model = String(params.modelId);
        return this.result(f.id, {});
      }
      default:
        if (f.id !== undefined) this.error(f.id, -32601, `${method} is not a method of the fake`);
    }
  }

  // ── sessions ──────────────────────────────────────────────────────────

  private newSession(id: unknown, p: Obj): void {
    if (this.opts.requireAuth && !this.authed) return this.error(id, -32000, 'Authentication required');
    const c: Conversation = {
      id: randomUUID(),
      cwd: typeof p.cwd === 'string' ? p.cwd : '',
      ...DEFAULTS,
      mcpServers: serverNames(p.mcpServers),
      history: [],
      usedTokens: 0,
    };
    this.conversations.set(c.id, c);
    this.result(id, { sessionId: c.id, ...this.settings(c) });
    this.commands(c);
  }

  private loadSession(id: unknown, p: Obj): void {
    const sid = typeof p.sessionId === 'string' ? p.sessionId : '';
    let c = this.conversations.get(sid);
    if (!c) {
      const stored = this.read(sid);
      if (!stored) return this.error(id, -32002, `Resource not found: ${sid}`);
      c = stored;
      this.conversations.set(sid, c);
    }
    // MEASURED ON CODEX: a load resets the settings to the defaults.
    Object.assign(c, DEFAULTS);
    c.mcpServers = serverNames(p.mcpServers);
    for (const h of c.history) {
      this.update(c.id, {
        sessionUpdate: h.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: h.text },
      });
    }
    this.result(id, this.settings(c));
    this.commands(c);
  }

  private settings(c: Conversation): Obj {
    return {
      modes: { currentModeId: c.mode, availableModes: MODES },
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: c.mode,
          options: MODES.map((m) => ({
            value: m.id,
            name: m.name,
            description: m.description,
          })),
        },
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: c.model,
          options: MODELS,
        },
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          type: 'select',
          currentValue: c.effort,
          options: EFFORTS.map((e) => ({ value: e, name: e })),
        },
      ],
    };
  }

  private setConfig(id: unknown, p: Obj): void {
    const c = this.conversations.get(String(p.sessionId));
    if (!c) return this.error(id, -32002, 'no such session');
    const value = typeof p.value === 'string' ? p.value : '';
    switch (p.configId) {
      case 'model':
        if (!MODELS.some((m) => m.value === value)) return this.error(id, -32602, `unknown model ${value}`);
        c.model = value;
        break;
      case 'reasoning_effort':
        if (!EFFORTS.includes(value)) return this.error(id, -32602, `unknown effort ${value}`);
        c.effort = value;
        break;
      case 'mode':
        if (!MODES.some((m) => m.id === value)) return this.error(id, -32602, `unknown mode ${value}`);
        c.mode = value;
        break;
      default:
        return this.error(id, -32602, `unknown config option ${String(p.configId)}`);
    }
    // MEASURED ON CODEX: the reply is the whole new state; no notification follows.
    this.result(id, { configOptions: this.settings(c).configOptions });
  }

  private commands(c: Conversation): void {
    this.update(c.id, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'review', description: 'Review the current changes' },
        { name: 'status', description: 'Show the session status' },
      ],
    });
  }

  // ── a turn ────────────────────────────────────────────────────────────

  private prompt(id: unknown, p: Obj): void {
    const c = this.conversations.get(String(p.sessionId));
    if (!c) return this.error(id, -32002, 'no such session');
    const text = (Array.isArray(p.prompt) ? p.prompt : [])
      .map((b) => (b && typeof b === 'object' && (b as Obj).type === 'text' ? String((b as Obj).text) : ''))
      .filter(Boolean)
      .join('\n');
    c.history.push({ role: 'user', text });
    const a: Active = { requestId: id, conversation: c, cancelled: false };
    this.active.set(c.id, a);
    const say = (words: string): void => this.say(c, words);
    const finish = (stopReason = 'end_turn'): void => this.finish(a, stopReason);

    if (text.includes('!error')) {
      this.active.delete(c.id);
      return this.error(id, -32603, 'fake agent failure (scripted by !error)');
    }
    if (text.includes('!think')) {
      this.update(c.id, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking about it.' },
      });
    }
    if (text.includes('!unknown')) {
      this.update(c.id, {
        sessionUpdate: 'fake_future_variant',
        payload: { anything: true },
      });
      this.opts.write({
        jsonrpc: '2.0',
        method: '_fake/extension',
        params: { hello: 1 },
      });
      this.opts.write('this line is not JSON');
      say('UNKNOWN SURVIVED');
      return finish();
    }
    if (text.includes('!cancel-slow')) {
      let n = 0;
      a.timer = setInterval(() => {
        n++;
        if (a.cancelled || n > 1200) {
          clearInterval(a.timer);
          return finish(a.cancelled ? 'cancelled' : 'end_turn');
        }
        this.update(c.id, {
          sessionUpdate: 'agent_message_chunk',
          messageId: `m-${c.id}-slow`,
          content: { type: 'text', text: `tick ${n} ` },
        });
      }, this.opts.tickMs ?? 50);
      return;
    }
    if (text.includes('!tool')) {
      const toolCallId = `exec-${randomUUID()}`;
      this.update(c.id, {
        sessionUpdate: 'tool_call',
        toolCallId,
        kind: 'execute',
        title: 'echo fake-tool',
        status: 'in_progress',
        rawInput: { command: 'echo fake-tool', cwd: c.cwd },
        content: [{ type: 'terminal', terminalId: toolCallId }],
      });
      this.update(c.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        _meta: { terminal_exit: { exit_code: 0 } },
      });
      say('TOOL DONE');
      return finish();
    }
    if (text.includes('!edit')) {
      const toolCallId = `edit-${randomUUID()}`;
      this.update(c.id, {
        sessionUpdate: 'tool_call',
        toolCallId,
        kind: 'edit',
        title: 'Edit notes.txt',
        status: 'in_progress',
        locations: [{ path: path.join(c.cwd, 'notes.txt') }],
        content: [
          {
            type: 'diff',
            path: path.join(c.cwd, 'notes.txt'),
            oldText: 'old line',
            newText: 'new line',
          },
        ],
      });
      this.update(c.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
      });
      say('EDIT DONE');
      return finish();
    }
    if (text.includes('!ask')) return this.ask(a);
    if (text.includes('!plan')) {
      this.update(c.id, {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read the code', priority: 'high', status: 'completed' },
          {
            content: 'Write the fix',
            priority: 'medium',
            status: 'in_progress',
          },
        ],
      });
      say('PLAN SENT');
      return finish();
    }
    if (text.includes('!mode')) {
      say(`MODE: ${c.mode}`);
      return finish();
    }
    if (text.includes('!state')) {
      say(`STATE: model=${c.model} effort=${c.effort} mode=${c.mode}`);
      return finish();
    }
    if (text.includes('!mcp')) {
      say(`MCP: ${c.mcpServers.join(',') || '(none)'}`);
      return finish();
    }
    if (text.includes('!fs')) {
      const outId = this.nextOutId++;
      a.fsWaiting = {
        id: outId,
        onAnswer: (reply) => {
          const err = reply.error as Obj | undefined;
          say(err ? `FS REFUSED ${String(err.code)}` : 'FS ANSWERED');
          finish();
        },
      };
      this.opts.write({
        jsonrpc: '2.0',
        id: outId,
        method: 'fs/read_text_file',
        params: { sessionId: c.id, path: path.join(c.cwd, 'x.txt') },
      });
      return;
    }
    say(`ACP reply to: ${text}`);
    finish();
  }

  private ask(a: Active): void {
    const c = a.conversation;
    const toolCallId = `exec-${randomUUID()}`;
    const rawInput = { command: 'Set-Content probe.txt hello', cwd: c.cwd };
    this.update(c.id, {
      sessionUpdate: 'tool_call',
      toolCallId,
      kind: 'execute',
      title: 'Run command',
      status: 'pending',
      rawInput,
    });
    const outId = this.nextOutId++;
    a.waiting = {
      id: outId,
      onAnswer: (outcome) => {
        const picked = outcome.outcome === 'selected' ? outcome.optionId : undefined;
        if (picked === 'allow_once' || picked === 'accept_always') {
          this.update(c.id, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            _meta: { terminal_exit: { exit_code: 0 } },
          });
          this.say(c, 'ASK ALLOWED');
          return this.finish(a, 'end_turn');
        }
        // MEASURED ON CODEX: a reject ends the WHOLE turn, cancelled, no text.
        this.update(c.id, {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
          _meta: { terminal_exit: { exit_code: null } },
        });
        this.finish(a, 'cancelled');
      },
    };
    this.opts.write({
      jsonrpc: '2.0',
      id: outId,
      method: 'session/request_permission',
      params: {
        sessionId: c.id,
        toolCall: {
          toolCallId,
          title: 'Run command',
          rawInput,
          kind: 'execute',
          status: 'pending',
        },
        // ids are NOT the kinds, and there is no reject_always — both measured
        options: [
          { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' },
          {
            optionId: 'accept_always',
            name: "Yes, and don't ask again",
            kind: 'allow_always',
          },
          {
            optionId: 'cancel',
            name: 'No, and tell the fake what to do differently',
            kind: 'reject_once',
          },
        ],
      },
    });
  }

  private cancel(p: Obj): void {
    const a = this.active.get(String(p.sessionId));
    if (!a) return;
    a.cancelled = true;
    if (a.waiting) {
      // the client answers the permission `cancelled`; the turn ends then
      return;
    }
    if (!a.timer) this.finish(a, 'cancelled');
  }

  private onReply(f: Obj): void {
    for (const a of this.active.values()) {
      if (a.waiting && f.id === a.waiting.id) {
        const w = a.waiting;
        a.waiting = undefined;
        const result = (f.result && typeof f.result === 'object' ? f.result : {}) as Obj;
        const outcome = (result.outcome && typeof result.outcome === 'object' ? result.outcome : {}) as Obj;
        return w.onAnswer(a.cancelled ? { outcome: 'cancelled' } : outcome);
      }
      if (a.fsWaiting && f.id === a.fsWaiting.id) {
        const w = a.fsWaiting;
        a.fsWaiting = undefined;
        return w.onAnswer(f);
      }
    }
  }

  private say(c: Conversation, words: string): void {
    const messageId = `m-${randomUUID()}`;
    const half = Math.ceil(words.length / 2);
    for (const piece of [words.slice(0, half), words.slice(half)]) {
      if (piece)
        this.update(c.id, {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'text', text: piece },
        });
    }
    c.history.push({ role: 'agent', text: words });
  }

  private finish(a: Active, stopReason: string): void {
    if (this.active.get(a.conversation.id) !== a) return;
    this.active.delete(a.conversation.id);
    if (a.timer) clearInterval(a.timer);
    const c = a.conversation;
    const counted = stopReason !== 'cancelled';
    if (counted) {
      c.usedTokens += 1200;
      this.update(c.id, {
        sessionUpdate: 'usage_update',
        used: c.usedTokens,
        size: 100_000,
      });
    }
    this.persist(c);
    // MEASURED ON CODEX: a cancelled (or rejected) turn reports `usage: null`.
    this.result(a.requestId, {
      stopReason,
      usage: counted
        ? {
            totalTokens: 1200,
            inputTokens: 1000,
            cachedReadTokens: 100,
            cachedWriteTokens: 0,
            outputTokens: 100,
            thoughtTokens: 0,
          }
        : null,
    });
  }

  // ── persistence ───────────────────────────────────────────────────────

  private file(id: string): string | null {
    return /^[0-9a-f-]{36}$/i.test(id) ? path.join(this.storeDir, `${id}.json`) : null;
  }

  private persist(c: Conversation): void {
    const f = this.file(c.id);
    if (!f) return;
    try {
      fs.mkdirSync(this.storeDir, { recursive: true });
      fs.writeFileSync(f, JSON.stringify(c));
    } catch {
      /* a fake that cannot save still answers */
    }
  }

  private read(id: string): Conversation | null {
    const f = this.file(id);
    if (!f) return null;
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')) as Conversation;
    } catch {
      return null;
    }
  }

  // ── framing ───────────────────────────────────────────────────────────

  private update(sessionId: string, update: Obj): void {
    this.opts.write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });
  }

  private result(id: unknown, result: Obj): void {
    this.opts.write({ jsonrpc: '2.0', id, result });
  }

  private error(id: unknown, code: number, message: string): void {
    this.opts.write({ jsonrpc: '2.0', id, error: { code, message } });
  }
}

function serverNames(v: unknown): string[] {
  return (Array.isArray(v) ? v : [])
    .map((s) => (s && typeof s === 'object' ? (s as Obj).name : undefined))
    .filter((n): n is string => typeof n === 'string');
}
