// The general ACP engine against the fake ACP agent (E40 item 06, #1289).
//
// END TO END WITHOUT A CHILD PROCESS: the real `SessionManager`, the real
// provider (`createAcpProvider`), and the fake agent (`FakeAcpAgent`) behind a
// transport that does what `StreamService` does — JSON over an async hop in
// each direction, a line that is not JSON skipped. So what is proven here is
// the pairing the host does (one session's translator and controls by id, the
// loopback) as well as the engine's own rules.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { AcpSession, SETUP_DEADLINE_MS } from './acp-session';
import { cleanupTempDirs, tempDir } from '../../../test-temp-dirs';
import { SessionManager } from '../../sessions/session-manager';
import { ContributionRegistry } from '../../../shared/extensibility/registry';
import type { MainContributions, McpAttachmentHost } from '../../extensibility/contributions';
import type { SessionTransport } from '../../transport/transport';
import { LogSink, createLogger } from '../../log/logger';
import type { EngineEvent, MessageEvent } from '../../sessions/engine-events';
import { declaredControls } from '../../sessions/engine-controls';
import { claudeControls } from '../claude-controls';
import { DISPLAY_CAPS, type BlockIntent } from '../../feed/blocks';
import { BUS_SERVER_NAME } from '../../bus/bus-paths';
import { createAcpProvider } from './acp-provider';
import { FakeAcpAgent, FAKE_ACP_MODE_MAP } from './fake-acp-agent';
import { classify } from './acp-protocol';

type Obj = Record<string, unknown>;

/** `StreamService`, minus the process: an async hop each way, JSON in between. */
class FakeAgentTransport implements SessionTransport {
  /** every frame the client sent, in order */
  sent: Obj[] = [];
  agents: FakeAcpAgent[] = [];
  private exitListeners = new Set<(code: number) => void>();

  constructor(
    private readonly storeDir: string,
    private readonly requireAuth = false
  ) {}

  spawn() {
    const listeners = new Set<(m: Obj) => void>();
    const agent = new FakeAcpAgent({
      storeDir: this.storeDir,
      requireAuth: this.requireAuth,
      tickMs: 5,
      write: (frame) =>
        setImmediate(() => {
          // the transport's NDJSON decoder: a line that is not JSON is skipped
          let parsed: unknown;
          try {
            parsed = JSON.parse(typeof frame === 'string' ? frame : JSON.stringify(frame));
          } catch {
            return;
          }
          for (const l of [...listeners]) l(parsed as Obj);
        }),
    });
    this.agents.push(agent);
    return {
      pid: 1,
      onExit: (l: (code: number) => void) => {
        this.exitListeners.add(l);
        return () => this.exitListeners.delete(l);
      },
      onMessage: (l: (m: Obj) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      send: (m: unknown) => {
        const copy = JSON.parse(JSON.stringify(m)) as Obj;
        this.sent.push(copy);
        setImmediate(() => agent.receive(copy));
      },
      kill: () => {},
    };
  }
  remove(): void {}
  exit(code: number): void {
    for (const l of [...this.exitListeners]) l(code);
  }
}

const identity = { title: 't', folder: 'C:/tmp/acp', providerId: 'test-acp' };
let dir: string;

beforeEach(() => {
  dir = tempDir('sb-acp-');
});
afterEach(() => cleanupTempDirs());

interface Rig {
  m: SessionManager;
  t: FakeAgentTransport;
  provider: ReturnType<typeof createAcpProvider>;
  events: Array<{ sessionId: string; ev: EngineEvent }>;
  logs: string;
}

function rig(
  opts: {
    requireAuth?: boolean;
    authMethodId?: string | null;
    provider?: ReturnType<typeof createAcpProvider>;
  } = {}
): Rig {
  const provider =
    opts.provider ??
    createAcpProvider({
      id: 'test-acp',
      displayName: 'Test ACP',
      command: 'agent',
      modeMap: FAKE_ACP_MODE_MAP,
      ...(opts.authMethodId === null ? {} : { authMethodId: opts.authMethodId ?? 'fake-login' }),
    });
  const registry = new ContributionRegistry<MainContributions>();
  registry.register('provider-adapter', provider);
  const t = new FakeAgentTransport(dir, opts.requireAuth);
  const sink = new LogSink({ dir });
  const m = new SessionManager(
    registry,
    {
      spawn: () => {
        throw new Error('no pty');
      },
      remove: () => {},
    },
    createLogger(sink, 'sessions'),
    dir,
    { stream: t }
  );
  const r: Rig = { m, t, provider, events: [], logs: '' };
  m.onEngineEvent((sessionId, ev) => r.events.push({ sessionId, ev }));
  return r;
}

async function until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const sentMethod = (r: Rig, method: string): Obj[] => r.t.sent.filter((f) => f.method === method);
const ofType = <T extends EngineEvent['type']>(r: Rig, type: T): Array<Extract<EngineEvent, { type: T }>> =>
  r.events.map((e) => e.ev).filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
const blocksOf = (r: Rig): BlockIntent[] =>
  ofType(r, 'message').flatMap((e: MessageEvent) => e.derive(DISPLAY_CAPS, {}));
const texts = (r: Rig, kind: string): string[] =>
  blocksOf(r)
    .filter((b): b is Extract<BlockIntent, { t: 'block' }> => b.t === 'block' && b.block.kind === kind)
    .map((b) => b.block.text ?? '');
const turnEnds = (r: Rig) => ofType(r, 'turn-end');

/** start a session and wait until it has a conversation and can take a prompt */
async function open(r: Rig, opts: Parameters<SessionManager['create']>[1] = {}): Promise<string> {
  const rec = r.m.create(identity, opts);
  await until(() => ofType(r, 'conversation').length > 0 && ofType(r, 'commands').length > 0, 'the session to open');
  return rec.id;
}

async function turn(r: Rig, id: string, text: string): Promise<void> {
  const before = turnEnds(r).length;
  expect(r.m.submitPrompt(id, text)).toBe(true);
  await until(() => turnEnds(r).length > before, `the turn "${text}" to end`);
}

describe('the handshake', () => {
  it('initialize offers no fs and no terminal, then session/new with the cwd', async () => {
    const r = rig();
    await open(r);
    const init = sentMethod(r, 'initialize')[0];
    expect(init.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    expect(sentMethod(r, 'session/new')[0].params).toEqual({
      cwd: 'C:/tmp/acp',
      mcpServers: [],
    });
    // the conversation id, the model and mode the agent is on, its commands
    expect(ofType(r, 'conversation')[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ofType(r, 'model').at(-1)).toEqual({
      type: 'model',
      id: 'fake-large',
    });
    expect(ofType(r, 'mode').at(-1)).toEqual({ type: 'mode', mode: 'ask' });
    expect(ofType(r, 'commands')[0].commands.map((c) => c.name)).toEqual(['review', 'status']);
  });

  it('carries the Session Bus as a stdio server in mcpServers', async () => {
    const r = rig();
    const host: McpAttachmentHost = {
      attachSession: (sid) => ({
        command: 'C:/app/electron.exe',
        args: ['bus.js', '--session', sid],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }),
      releaseSession: () => {},
    };
    const id = await open(r, {
      mcpConfigFor: (sid) => r.provider.capabilities!.mcp!.configFor(sid, host) ?? undefined,
    });
    const params = sentMethod(r, 'session/new')[0].params as Obj;
    expect(params.mcpServers).toEqual([
      {
        name: BUS_SERVER_NAME,
        command: 'C:/app/electron.exe',
        args: ['bus.js', '--session', id],
        env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
      },
    ]);
    await turn(r, id, '!mcp');
    expect(texts(r, 'assistant').at(-1)).toBe(`MCP: ${BUS_SERVER_NAME}`);
  });

  it('a prompt sent before the session is open is queued, then sent', async () => {
    const r = rig();
    const rec = r.m.create(identity);
    expect(r.m.submitPrompt(rec.id, 'early bird')).toBe(true);
    expect(sentMethod(r, 'session/prompt')).toHaveLength(0);
    await until(() => turnEnds(r).length > 0, 'the queued turn');
    expect(texts(r, 'assistant').at(-1)).toBe('ACP reply to: early bird');
  });

  it('runs the named auth method on "Authentication required", then opens', async () => {
    const r = rig({ requireAuth: true });
    await open(r);
    expect(sentMethod(r, 'authenticate')[0].params).toEqual({
      methodId: 'fake-login',
    });
    expect(sentMethod(r, 'session/new')).toHaveLength(2);
  });

  it('with no auth method named, says it is not signed in and refuses prompts (fail-open)', async () => {
    const r = rig({ requireAuth: true, authMethodId: null });
    const rec = r.m.create(identity);
    expect(r.m.submitPrompt(rec.id, 'hello')).toBe(true); // queued before the answer
    await until(() => turnEnds(r).length > 0, 'the owed turn end');
    expect(turnEnds(r)[0]).toMatchObject({ failed: true });
    expect(texts(r, 'assistant').join('\n')).toMatch(/Test ACP is not signed in: Authentication required/);
    expect(sentMethod(r, 'authenticate')).toHaveLength(0);
    expect(r.m.submitPrompt(rec.id, 'again')).toBe(false);
  });
});

describe('a full turn', () => {
  it('streams message chunks into one reply, then ends the turn with usage', async () => {
    const r = rig();
    const id = await open(r);
    await turn(r, id, 'hello there');
    // the user's own prompt (ACP does not echo it: the loopback does)
    expect(texts(r, 'user')).toEqual(['hello there']);
    const kinds = r.events.map((e) => e.ev.type);
    expect(kinds).toContain('chunk-open');
    expect(
      ofType(r, 'chunk')
        .map((c) => c.text)
        .join('')
    ).toBe('ACP reply to: hello there');
    expect(texts(r, 'assistant')).toEqual(['ACP reply to: hello there']);
    expect(turnEnds(r)).toEqual([{ type: 'turn-end', failed: false, label: 'acp:end_turn' }]);
    expect(ofType(r, 'usage')[0]).toEqual({
      type: 'usage',
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 100,
    });
    // and the status went working -> idle
    expect(r.m.get(id)?.status).toBe('done');
    expect(ofType(r, 'activity').length).toBeGreaterThan(0);
  });

  it('thought chunks become a thinking block before the reply', async () => {
    const r = rig();
    const id = await open(r);
    await turn(r, id, '!think');
    expect(texts(r, 'thinking')).toEqual(['Thinking about it.']);
  });

  it('a shell tool call is a tool block whose result is the exit code', async () => {
    const r = rig();
    const id = await open(r);
    await turn(r, id, '!tool');
    const blocks = blocksOf(r);
    const tool = blocks.find(
      (b): b is Extract<BlockIntent, { t: 'block' }> => b.t === 'block' && b.block.kind === 'tool'
    );
    expect(tool?.block.tool).toMatchObject({
      name: 'echo fake-tool',
      category: 'shell',
      summary: 'echo fake-tool',
    });
    const result = blocks.find((b): b is Extract<BlockIntent, { t: 'tool-result' }> => b.t === 'tool-result');
    expect(result).toMatchObject({
      toolUseId: tool?.toolUseId,
      out: 'Exit code 0',
    });
    expect(result?.failed).toBeUndefined();
    expect(texts(r, 'assistant').at(-1)).toBe('TOOL DONE');
  });

  it('an edit tool call carries its diff', async () => {
    const r = rig();
    const id = await open(r);
    await turn(r, id, '!edit');
    const tool = blocksOf(r).find(
      (b): b is Extract<BlockIntent, { t: 'block' }> => b.t === 'block' && b.block.kind === 'tool'
    );
    expect(tool?.block.tool).toMatchObject({
      category: 'edit',
      oldString: 'old line',
      newString: 'new line',
    });
  });

  it('a plan is a todos block', async () => {
    const r = rig();
    const id = await open(r);
    await turn(r, id, '!plan');
    const todos = blocksOf(r).find(
      (b): b is Extract<BlockIntent, { t: 'block' }> => b.t === 'block' && b.block.kind === 'todos'
    );
    expect(todos?.block.todos).toEqual([
      { content: 'Read the code', status: 'completed' },
      { content: 'Write the fix', status: 'in_progress' },
    ]);
  });
});

describe('permissions', () => {
  async function asked(r: Rig): Promise<{ id: string; requestId: string }> {
    const id = await open(r);
    expect(r.m.submitPrompt(id, '!ask')).toBe(true);
    await until(() => ofType(r, 'permission-request').length > 0, 'the permission request');
    const req = ofType(r, 'permission-request')[0];
    expect(r.m.get(id)?.status).toBe('needs-permission');
    return { id, requestId: req.requestId };
  }

  it('the request id 0 is honoured, and allow answers allow_once by its optionId', async () => {
    const r = rig();
    const { id, requestId } = await asked(r);
    expect(requestId).toBe('0');
    expect(ofType(r, 'permission-request')[0]).toMatchObject({
      tool: 'Run command',
      displayName: 'Run command',
      input: { command: 'Set-Content probe.txt hello' },
    });
    expect(
      r.m.answerPermission(id, requestId, {
        behavior: 'allow',
        updatedInput: {},
      })
    ).toBe(true);
    await until(() => turnEnds(r).length > 0, 'the turn');
    const answer = r.t.sent.find((f) => f.id === 0 && 'result' in f);
    // the NUMBER 0 back, not the string the event carried
    expect(answer).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    });
    expect(texts(r, 'assistant').at(-1)).toBe('ASK ALLOWED');
    expect(turnEnds(r)[0]).toMatchObject({
      failed: false,
      label: 'acp:end_turn',
    });
  });

  it('deny answers reject_once by its optionId; the cancelled turn is not an error', async () => {
    const r = rig();
    const { id, requestId } = await asked(r);
    expect(r.m.answerPermission(id, requestId, { behavior: 'deny', message: 'no' })).toBe(true);
    await until(() => turnEnds(r).length > 0, 'the turn');
    expect(r.t.sent.find((f) => f.id === 0 && 'result' in f)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'cancel' },
    });
    const result = blocksOf(r).find((b): b is Extract<BlockIntent, { t: 'tool-result' }> => b.t === 'tool-result');
    expect(result?.failed).toBe(true);
    expect(turnEnds(r)[0]).toEqual({
      type: 'turn-end',
      failed: false,
      label: 'acp:cancelled',
    });
    expect(ofType(r, 'usage')).toHaveLength(0); // usage: null on a rejected turn
  });

  it('an answer to a request nobody holds is refused, not sent', async () => {
    const r = rig();
    const id = await open(r);
    expect(r.m.answerPermission(id, '42', { behavior: 'allow', updatedInput: {} })).toBe(false);
  });
});

describe('cancel', () => {
  it('Stop sends session/cancel and the turn ends cancelled', async () => {
    const r = rig();
    const id = await open(r);
    expect(r.m.submitPrompt(id, '!cancel-slow')).toBe(true);
    await until(() => ofType(r, 'chunk').length > 2, 'some ticks');
    expect(r.m.interrupt(id)).toBe(true);
    await until(() => turnEnds(r).length > 0, 'the cancelled turn');
    expect(sentMethod(r, 'session/cancel')[0]).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: ofType(r, 'conversation')[0].id },
    });
    expect(turnEnds(r)[0]).toMatchObject({
      failed: false,
      label: 'acp:cancelled',
    });
    // the partial reply is kept
    expect(texts(r, 'assistant').at(-1)).toMatch(/^tick 1 tick 2/);
  });

  it('Stop while a permission is held answers it cancelled and withdraws it', async () => {
    const r = rig();
    const id = await open(r);
    r.m.submitPrompt(id, '!ask');
    await until(() => ofType(r, 'permission-request').length > 0, 'the request');
    expect(r.m.interrupt(id)).toBe(true);
    expect(ofType(r, 'permission-withdrawn')).toEqual([{ type: 'permission-withdrawn', requestId: '0' }]);
    expect(r.t.sent.find((f) => f.id === 0 && 'result' in f)?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    await until(() => turnEnds(r).length > 0, 'the turn');
    expect(turnEnds(r)[0]).toMatchObject({
      label: 'acp:cancelled',
      failed: false,
    });
  });
});

describe('fail-open', () => {
  it('a prompt the agent fails ends the turn failed, with the agent’s words on screen', async () => {
    const r = rig();
    const id = await open(r);
    await turn(r, id, '!error');
    expect(turnEnds(r)[0]).toMatchObject({ failed: true, label: 'acp:error' });
    expect(texts(r, 'assistant').at(-1)).toBe('Test ACP reported an error: fake agent failure (scripted by !error)');
    // and the session carries on
    await turn(r, id, 'still here?');
    expect(texts(r, 'assistant').at(-1)).toBe('ACP reply to: still here?');
  });

  it('an unknown update variant, an extension notification and a non-JSON line are skipped; reported once each', async () => {
    const r = rig();
    const reported: string[] = [];
    const id = await open(r);
    // reach the translator's onUnknown through the manager's log
    const engine = r.provider.sessionFor(id)!;
    engine.setHooks({ onUnknown: (k) => reported.push(k) });
    await turn(r, id, '!unknown');
    await turn(r, id, '!unknown');
    expect(texts(r, 'assistant').filter((t) => t === 'UNKNOWN SURVIVED')).toHaveLength(2);
    expect(reported.sort()).toEqual(['notification:_fake/extension', 'session/update:fake_future_variant']);
  });

  it('a frame that is not JSON-RPC is skipped, once reported', () => {
    const p = createAcpProvider({ id: 'x', displayName: 'X', command: 'x' });
    const reported: string[] = [];
    const translate = p.capabilities!.events!.createTranslator({ onUnknown: (k) => reported.push(k) }, { id: 's' });
    expect(translate({ hello: 'world' })).toEqual([]);
    expect(translate({ also: 'not' })).toEqual([]);
    expect(reported).toEqual(['malformed frame']);
    expect(classify({ jsonrpc: '2.0', id: 0, result: {} })).toEqual({
      kind: 'response',
      id: 0,
      result: {},
    });
  });

  it('fs/* is refused -32601: v1 offers the agent no file access', async () => {
    const r = rig();
    const id = await open(r);
    await turn(r, id, '!fs');
    expect(r.t.sent.find((f) => f.id === 0 && 'error' in f)).toMatchObject({
      error: { code: -32601 },
    });
    expect(texts(r, 'assistant').at(-1)).toBe('FS REFUSED -32601');
  });

  it('a dead agent ends the session as a dead CLI does, and controls answer session-gone', async () => {
    const r = rig();
    const id = await open(r);
    r.t.exit(1);
    expect(r.m.get(id)?.status).toBe('crashed');
    r.m.remove(id);
    await expect(r.m.listModels(id)).resolves.toMatchObject({
      ok: false,
      reason: 'session-gone',
    });
  });
});

describe('models, effort, mode, context', () => {
  it('lists and switches the model through configOptions; the reply is the truth', async () => {
    const r = rig();
    const id = await open(r);
    await expect(r.m.listModels(id)).resolves.toEqual({
      ok: true,
      response: {
        models: [
          {
            value: 'fake-large',
            displayName: 'Fake Large',
            description: 'The thorough one',
          },
          {
            value: 'fake-small',
            displayName: 'Fake Small',
            description: 'Fast and affordable',
          },
        ],
      },
    });
    await expect(r.m.setModel(id, 'fake-small')).resolves.toMatchObject({
      ok: true,
    });
    expect(sentMethod(r, 'session/set_config_option').at(-1)?.params).toMatchObject({
      configId: 'model',
      value: 'fake-small',
    });
    expect(ofType(r, 'model').at(-1)).toEqual({
      type: 'model',
      id: 'fake-small',
    });
    await expect(r.m.setModel(id, 'no-such-model')).resolves.toMatchObject({
      ok: false,
      reason: 'refused',
    });
    await expect(r.m.setModel(id, '')).resolves.toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('reads and sets effort', async () => {
    const r = rig();
    const id = await open(r);
    await expect(r.m.effort(id)).resolves.toEqual({
      ok: true,
      response: {
        effort: 'medium',
        levels: ['low', 'medium', 'high'],
        model: 'fake-large',
      },
    });
    await expect(r.m.setEffort(id, 'high')).resolves.toEqual({
      ok: true,
      response: { effort: 'high' },
    });
    await expect(r.m.effort(id)).resolves.toMatchObject({
      response: { effort: 'high' },
    });
  });

  it('switches the mode LIVE, and the agent is really in it', async () => {
    const r = rig();
    const id = await open(r);
    await expect(r.m.setMode(id, 'plan')).resolves.toMatchObject({ ok: true });
    expect(ofType(r, 'mode').at(-1)).toEqual({ type: 'mode', mode: 'plan' });
    await turn(r, id, '!mode');
    expect(texts(r, 'assistant').at(-1)).toBe('MODE: read-only');
  });

  it('the context meter reads the last usage_update', async () => {
    const r = rig();
    const id = await open(r);
    await expect(r.m.contextUsage(id)).resolves.toMatchObject({
      ok: false,
      reason: 'refused',
    });
    await turn(r, id, 'hi');
    await expect(r.m.contextUsage(id)).resolves.toEqual({
      ok: true,
      response: {
        percentage: 1,
        totalTokens: 1200,
        maxTokens: 100000,
        autoCompactAt: null,
      },
    });
  });
});

describe('session/load', () => {
  it('replays the history and RE-APPLIES model, effort and mode (load resets them)', async () => {
    const r = rig();
    const first = await open(r);
    await r.m.setModel(first, 'fake-small');
    await r.m.setEffort(first, 'high');
    await turn(r, first, 'remember me');
    const conversation = ofType(r, 'conversation')[0].id;
    r.m.remove(first);

    // the SAME provider (its memory), a new agent process
    const r2 = rig({ provider: r.provider });
    const second = r2.m.create(identity, {
      resumeSessionId: conversation,
      autonomy: 'plan',
    }).id;
    await until(() => ofType(r2, 'conversation').length > 0, 'the load');
    expect(sentMethod(r2, 'session/load')[0].params).toMatchObject({
      sessionId: conversation,
      cwd: 'C:/tmp/acp',
    });
    expect(sentMethod(r2, 'session/new')).toHaveLength(0);
    // the replay: the old prompt and the old reply, as history (no activity)
    expect(texts(r2, 'user')).toEqual(['remember me']);
    expect(texts(r2, 'assistant')).toEqual(['ACP reply to: remember me']);
    expect(ofType(r2, 'activity')).toHaveLength(0);
    await turn(r2, second, '!state');
    const sets = sentMethod(r2, 'session/set_config_option').map((f) => (f.params as Obj).configId);
    expect(sets.sort()).toEqual(['mode', 'model', 'reasoning_effort']);
    expect(texts(r2, 'assistant').at(-1)).toBe('STATE: model=fake-small effort=high mode=read-only');
    expect(ofType(r2, 'conversation').map((c) => c.id)).toEqual([conversation]);
  });

  it('a conversation the agent cannot load falls back to a new one', async () => {
    const r = rig();
    r.m.create(identity, {
      resumeSessionId: '00000000-0000-4000-8000-000000000000',
    });
    await until(() => ofType(r, 'conversation').length > 0, 'the fallback');
    expect(sentMethod(r, 'session/load')).toHaveLength(1);
    expect(sentMethod(r, 'session/new')).toHaveLength(1);
    expect(ofType(r, 'conversation')[0].id).not.toBe('00000000-0000-4000-8000-000000000000');
    // and it is SAID: the card's history did not silently vanish
    expect(texts(r, 'assistant').join('\n')).toMatch(/could not reopen the previous conversation .*this is a new one/);
  });
});

describe('the declaration', () => {
  it('an ACP session has approvals, interrupt, models, effort, context, modes (live) and commands — and no MCP', async () => {
    const r = rig();
    const id = await open(r);
    expect(r.m.controlsOf(id)).toEqual({
      ai: 'Test ACP',
      has: ['approvals', 'interrupt', 'models', 'effort', 'contextUsage', 'modes', 'slashCommands'],
    });
    const acp = r.provider.capabilities!.controls!.createControls({
      id: 'other',
      send: () => true,
    });
    expect(acp.modes && 'set' in acp.modes).toBe(true);
    expect(acp.mcp).toBeUndefined();
    // …and the other way round: Claude has MCP, and no live mode switch
    const claude = claudeControls.createControls({ id: 'c', send: () => true });
    expect(declaredControls(claude)).toContain('mcp');
    expect(claude.modes && 'set' in claude.modes).toBe(false);
    await expect(r.m.setMode(id, 'ask')).resolves.toMatchObject({ ok: true });
  });

  it('without a mode map, modes are declared with no live switch and nothing is ever sent', async () => {
    const p = createAcpProvider({
      id: 'test-acp',
      displayName: 'Test ACP',
      command: 'agent',
    });
    const r = rig({ provider: p });
    const id = await open(r);
    await expect(r.m.setMode(id, 'plan')).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(ofType(r, 'mode')).toHaveLength(0);
  });
});

describe('review of #1289: nothing is left stuck or silent', () => {
  it('an agent that never answers is failed on screen at the setup deadline, and the queued turn is settled', () => {
    vi.useFakeTimers();
    try {
      const looped: EngineEvent[] = [];
      const s = new AcpSession(
        's',
        { cwd: 'C:/tmp/acp', mcpServers: [] },
        { displayName: 'Mute', clientVersion: '0' },
        new Map()
      );
      const controls = s.controls();
      s.attach({ id: 's', send: () => true, loopback: (f) => looped.push(...s.translate(f)) });
      expect(controls.prompt?.('anyone there?', [])).toBe(true); // queued: the card is now working
      vi.advanceTimersByTime(SETUP_DEADLINE_MS + 1);
      expect(looped).toContainEqual({ type: 'turn-end', failed: true, label: 'acp:session-failed' });
      const said = looped
        .filter((e): e is MessageEvent => e.type === 'message')
        .flatMap((e) => e.derive(DISPLAY_CAPS, {}))
        .map((b) => (b.t === 'block' ? b.block.text : ''));
      expect(said).toContain('Mute did not open a session in time');
      expect(controls.prompt?.('again', [])).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a session whose start the provider never saw refuses to open rather than guess a folder', async () => {
    const p = createAcpProvider({ id: 'x', displayName: 'X', command: 'x' });
    const sent: unknown[] = [];
    const looped: EngineEvent[] = [];
    const translate = p.capabilities!.events!.createTranslator({}, { id: 'orphan' });
    const controls = p.capabilities!.controls!.createControls({
      id: 'orphan',
      send: (f) => sent.push(f) > 0,
      loopback: (f) => looped.push(...translate(f)),
    });
    expect(sent).toEqual([]); // not even `initialize`
    expect(controls.prompt?.('hi', [])).toBe(false);
    await expect(controls.models!.list()).resolves.toMatchObject({ ok: false, reason: 'refused' });
  });

  it('a prompt typed while the agent is replying is drawn AFTER that reply', async () => {
    const r = rig();
    const id = await open(r);
    expect(r.m.submitPrompt(id, '!ask')).toBe(true);
    await until(() => ofType(r, 'permission-request').length > 0, 'the request');
    expect(r.m.submitPrompt(id, 'next one')).toBe(true); // queued behind the running turn
    expect(texts(r, 'user')).toEqual(['!ask']); // not drawn yet
    r.m.answerPermission(id, ofType(r, 'permission-request')[0].requestId, { behavior: 'allow', updatedInput: {} });
    await until(() => turnEnds(r).length > 1, 'both turns');
    const order = blocksOf(r)
      .filter((b): b is Extract<BlockIntent, { t: 'block' }> => b.t === 'block')
      .map((b) => `${b.block.kind}:${b.block.text ?? ''}`);
    expect(order.indexOf('user:next one')).toBeGreaterThan(order.indexOf('assistant:ASK ALLOWED'));
    expect(texts(r, 'assistant').at(-1)).toBe('ACP reply to: next one');
  });
});
