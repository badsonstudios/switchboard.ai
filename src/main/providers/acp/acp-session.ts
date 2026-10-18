// ONE ACP SESSION'S ENGINE (E40 item 06, #1289) — the JSON-RPC client, its
// lifecycle, its controls, and the half of the translation that needs to know
// what was asked. `acp-events.ts` is the content half.
//
// IT RIDES THE EXISTING STREAM TRANSPORT. `StreamService` already spawns the
// agent through `launchSpec` (`cmd.exe /c <absolute .cmd>`, measured to work
// for Codex where `execSpec` does not, #1301), frames NDJSON, logs and skips a
// line that is not JSON, and reports a dead child to `SessionManager`, which
// ends the session exactly as it ends a dead Claude CLI. So this is not a
// transport: it is a translator and a set of controls over one, paired by
// switchboard's session id (`acp-provider.ts`).
//
// ── THE LIFECYCLE ──────────────────────────────────────────────────────────
//
//   attach      -> `initialize` (no `fs/*`, no `terminal/*`: design §4 decision 1)
//   initialized -> `session/load` when resuming AND the agent says `loadSession`,
//                  else `session/new`. Both carry `cwd` and the Session Bus in
//                  `mcpServers` (measured: Codex launched it and used its tools).
//   -32000      -> `authenticate` with the provider's named method, ONCE, then
//                  `session/new` again. A provider that names none surfaces the
//                  error. NOT MEASURED (it would open the owner's browser);
//                  written from the spec and fail-open: every failure is a
//                  visible notice and a settled turn, never a throw.
//   load fails  -> `session/new` (a fresh conversation beats no session).
//   opened      -> re-apply model, effort and mode (measured: `session/load`
//                  RESETS them to the agent's defaults), then READY: queued
//                  prompts go, one at a time.
//
// ── FAIL-OPEN (P6) ─────────────────────────────────────────────────────────
//
// A frame that is not JSON-RPC is skipped (reported once). An unknown
// `session/update` variant, an unknown notification and an unknown agent
// request are each reported once per type per session and skipped; the
// request is answered -32601 so the agent is not left waiting. A provider
// error ends the turn `failed` with the agent's words on screen. Nothing here
// throws into the pump, and no promise it hands out ever rejects.
import type { ControlVerdict } from '../../../shared/control';
import { errorText } from '../../../shared/error-text';
import type { AutonomyMode } from '../../../shared/sessions';
import type { PlanLimitWindow } from '../../../shared/usage-report';
import type { PromptAttachment } from '../../../shared/prompt-attachments';
import type { ControlSession, PermissionDecision, SessionControls } from '../../sessions/engine-controls';
import type { EngineEvent, TranslatorHooks } from '../../sessions/engine-events';
import { AcpContent } from './acp-events';
import {
  AUTH_REQUIRED,
  CANCELLED_OUTCOME,
  METHOD_NOT_FOUND,
  type AcpMcpServer,
  type AgentInfo,
  type ConfigOption,
  type ModeState,
  type ModelState,
  type PermissionOption,
  type RpcId,
  asObject,
  classify,
  errorResponse,
  initializeParams,
  notification,
  permissionOutcome,
  readConfigOptions,
  readInitialize,
  readModelState,
  readModes,
  readPermissionOptions,
  request,
  response,
} from './acp-protocol';

/** How long a control waits for the session to be open before refusing. */
export const READY_WAIT_MS = 60_000;
/** How long a control waits for the agent's reply. */
export const REPLY_WAIT_MS = 30_000;
/**
 * How long the session may take to OPEN (initialize -> session/new or load)
 * before it is failed on screen. Without it an agent that never answers would
 * leave a queued prompt's card on `working` for ever (review of #1289).
 */
export const SETUP_DEADLINE_MS = 60_000;
/** ...and while an `authenticate` is running, which may be a person signing in
 *  in a browser. */
export const AUTH_DEADLINE_MS = 5 * 60_000;
/** conversations whose model / effort a provider remembers, at most */
export const MAX_REMEMBERED = 200;

/** What one start of a session needs, captured at `buildSpawn`. */
export interface AcpStart {
  cwd: string;
  resumeSessionId?: string;
  /**
   * What the host kept for `resumeSessionId` (#1317) — the fallback when this
   * process's own memory has nothing for it, which is every reopen after an
   * app restart.
   */
  resumeSettings?: Remembered;
  autonomy?: AutonomyMode;
  mcpServers: AcpMcpServer[];
  /** the provider never saw this session's start: refuse to open (no folder) */
  lost?: boolean;
}

/** The parts of the provider's configuration a session reads. */
export interface AcpSessionConfig {
  displayName: string;
  /** host autonomy -> this agent's mode id. Absent: no live mode switch. */
  modeMap?: Partial<Record<AutonomyMode, string>>;
  /** which `authMethods` id to try on "Authentication required". Absent: none. */
  authMethodId?: string;
  /** reported to the agent as `clientInfo.version` */
  clientVersion: string;
  /**
   * The account's plan-limit windows, read beside the agent (Codex: one
   * `codex app-server` call, #1290). Called at ready and after every turn;
   * expected to cache. Absent: no limits are ever reported.
   */
  limits?: () => Promise<PlanLimitWindow[] | undefined>;
}

/** What a provider remembers of a conversation across its sessions (in memory). */
export interface Remembered {
  model?: string;
  effort?: string;
}

type Purpose = 'init' | 'auth' | 'new' | 'load' | 'prompt' | 'set-config' | 'set-mode' | 'set-model';

interface Outstanding {
  purpose: Purpose;
  /** for a `set-*`: the category ('model' | 'thought_level' | 'mode') and the value asked for */
  category?: string;
  value?: string;
  /** sent by `reapply` after an open, not by a control */
  reapply?: boolean;
  settle?: (v: { ok: true; result: Record<string, unknown> } | { ok: false; message: string }) => void;
}

type Phase = 'starting' | 'opening' | 'configuring' | 'ready' | 'failed' | 'gone';

/** A frame this session minted for its own loopback (`ControlSession.loopback`). */
interface Minted {
  events: EngineEvent[];
}

const THOUGHT_LEVEL = 'thought_level';

export class AcpSession {
  private control: ControlSession | undefined;
  private hooks: TranslatorHooks | undefined;
  private phase: Phase = 'starting';
  private nextId = 1;
  private readonly outstanding = new Map<RpcId, Outstanding>();
  private agent: AgentInfo | undefined;
  private acpSessionId: string | undefined;
  private config: ConfigOption[] | null = null;
  private modes: ModeState | null = null;
  private models: ModelState | null = null;
  private usage: { used: number; size: number } | undefined;
  private authTried = false;
  /** the prompt in flight, by its request id */
  private turn: RpcId | undefined;
  private readonly queue: Array<{
    text: string;
    attachments: readonly PromptAttachment[];
  }> = [];
  /** held `session/request_permission`s, by the id the event carried */
  private readonly permissions = new Map<string, { rawId: RpcId; options: PermissionOption[] }>();
  private readonly content = new AcpContent();
  private readonly reported = new Set<string>();
  /** frames already handled — the translator and `receive` both see each one */
  private readonly handled = new WeakSet<object>();
  private readonly minted = new WeakMap<object, Minted>();
  /**
   * The host mode the card last asked for (its start autonomy, then each live
   * `set`). Read back by `modeEvent` when two host modes share one agent mode
   * (#1290: Codex's ask and auto-edit are both `workspace-write`), so the chip
   * keeps the user's choice instead of jumping to the first match.
   */
  private hostMode: AutonomyMode | undefined;
  private readonly readyWaiters = new Set<(ok: boolean) => void>();
  private setupError: string | undefined;
  private setupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: string,
    private readonly start: AcpStart,
    private readonly cfg: AcpSessionConfig,
    private readonly memory: Map<string, Remembered>
  ) {
    this.hostMode = start.autonomy;
  }

  // ── wiring ──────────────────────────────────────────────────────────────

  /** The controls arrived: the handshake starts. Idempotent. */
  attach(control: ControlSession): void {
    if (this.control) return;
    this.control = control;
    if (this.start.lost) {
      // The provider never saw this session's `buildSpawn`, so it does not
      // know the folder. Opening one anyway would point the agent at the app's
      // own working directory, which is worse than not opening (review of #1289).
      this.loopback(this.fail('could not start: the session lost its folder before it opened'));
      return;
    }
    this.deadline(SETUP_DEADLINE_MS);
    this.ask('init', 'initialize', initializeParams(this.cfg.clientVersion));
  }

  /** (Re)arm the setup deadline. Cleared when the session is ready or ends. */
  private deadline(ms: number): void {
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.setupTimer = setTimeout(() => {
      this.setupTimer = undefined;
      if (this.phase === 'starting' || this.phase === 'opening') {
        this.loopback(this.fail('did not open a session in time'));
      }
    }, ms);
    this.setupTimer.unref?.();
  }

  setHooks(hooks: TranslatorHooks): void {
    this.hooks = hooks;
  }

  /**
   * The translator: one frame in, its events out. Runs BEFORE `receive` on
   * every frame (the pump's order), so the state change happens here and
   * `receive` skips a frame already handled — the engine still drives itself
   * when a provider's translator could not be built.
   */
  translate(frame: Record<string, unknown>): EngineEvent[] {
    const mine = this.minted.get(frame);
    if (mine) return mine.events;
    if (this.handled.has(frame)) return [];
    this.handled.add(frame);
    try {
      return this.onFrame(frame);
    } catch (err) {
      this.note('acp frame handling threw: frame skipped', {
        error: errorText(err),
      });
      return [];
    }
  }

  receive(frame: Record<string, unknown>): void {
    if (this.minted.has(frame) || this.handled.has(frame)) return;
    this.handled.add(frame);
    try {
      this.onFrame(frame);
    } catch (err) {
      this.note('acp frame handling threw: frame skipped', {
        error: errorText(err),
      });
    }
  }

  /** The session is going: settle everything now. Idempotent. */
  forget(): void {
    if (this.phase === 'gone') return;
    this.phase = 'gone';
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.setupTimer = undefined;
    for (const o of this.outstanding.values()) o.settle?.({ ok: false, message: 'the session has stopped' });
    this.outstanding.clear();
    this.queue.length = 0;
    this.permissions.clear();
    for (const w of this.readyWaiters) w(false);
    this.readyWaiters.clear();
  }

  // ── the controls ────────────────────────────────────────────────────────

  controls(): SessionControls {
    const controls: SessionControls = {
      approvals: {
        answer: (requestId, decision) => this.answer(requestId, decision),
      },
      interrupt: { interrupt: () => this.interrupt() },
      models: {
        list: () => this.listModels(),
        set: (model) => this.setModel(model),
      },
      effort: {
        get: () => this.getEffort(),
        set: (level) => this.setEffort(level),
      },
      contextUsage: { get: () => Promise.resolve(this.contextUsage()) },
      // A LIVE switch (`session/set_mode` / a `mode` config option), unlike
      // Claude's. Only declared when the provider says how the host's modes
      // map onto its agent's: guessing that "plan" means some agent's
      // "read-only" is exactly the kind of guess the standing rule forbids.
      modes: this.cfg.modeMap ? { set: (mode) => this.setMode(mode) } : {},
      slashCommands: {},
      prompt: (text, attachments) => this.prompt(text, attachments),
      receive: (frame) => this.receive(frame),
      forget: () => this.forget(),
    };
    return controls;
  }

  private prompt(text: string, attachments: readonly PromptAttachment[]): boolean {
    if (this.phase === 'failed' || this.phase === 'gone' || !this.control) return false;
    // Attachments this agent cannot take refuse the whole prompt, as the PTY
    // did: sending the words and quietly dropping the picture is worse.
    if (attachments.some((a) => a.kind === 'pdf' || (a.kind === 'image' && this.agent && !this.agent.image))) {
      this.note('acp prompt refused: an attachment this agent cannot take', {});
      return false;
    }
    if (this.phase !== 'ready' || this.turn !== undefined) {
      this.queue.push({ text, attachments });
      return true;
    }
    this.sendPrompt(text, attachments);
    return true;
  }

  private sendPrompt(text: string, attachments: readonly PromptAttachment[]): void {
    // ACP does not echo the prompt (Claude does), so the Feed hears it from us
    // HERE, when the agent takes it, so a prompt typed mid-reply is drawn after
    // that reply rather than in the middle of it (review of #1289).
    const events = this.content.userPrompt(text);
    const blocks: Array<Record<string, unknown>> = [];
    let dropped = 0;
    for (const a of attachments) {
      if (a.kind === 'image') {
        // `prompt()` checked this, unless `initialize` had not answered yet
        if (this.agent && !this.agent.image) dropped++;
        else blocks.push({ type: 'image', mimeType: a.mediaType, data: a.data });
      } else if (a.kind === 'text') blocks.push({ type: 'text', text: `${a.title}:\n${a.text}` });
    }
    if (dropped > 0) {
      events.push(...this.content.notice(`${this.cfg.displayName} cannot take pictures; ${dropped} was not sent.`));
    }
    this.loopback(events);
    if (text) blocks.push({ type: 'text', text });
    this.turn = this.ask('prompt', 'session/prompt', {
      sessionId: this.acpSessionId,
      prompt: blocks,
    });
  }

  private interrupt(): boolean {
    if (!this.control || !this.acpSessionId) return false;
    const queued = this.queue.length > 0;
    this.queue.length = 0;
    if (this.turn === undefined) {
      // Nothing running, but a queued prompt already moved the card to
      // `working`: it is owed the turn end it will now never get.
      if (queued) this.loopback([{ type: 'turn-end', failed: false, label: 'acp:cancelled' }]);
      return true;
    }
    this.control.send(notification('session/cancel', { sessionId: this.acpSessionId }));
    // The spec: after a cancel the client MUST answer every pending
    // permission request `cancelled`. And the bar must go.
    this.loopback(this.settlePermissions(true));
    return true;
  }

  private answer(requestId: string, decision: PermissionDecision): boolean {
    const held = this.permissions.get(requestId);
    if (!held || !this.control) return false;
    const outcome = permissionOutcome(held.options, decision.behavior);
    if (!outcome) {
      this.note('acp permission answer dropped: no allow_once option offered', {
        requestId,
      });
      this.loopback(
        this.content.notice(
          `${this.cfg.displayName} offered no way to allow this just once; answer it with Deny, or allow it in ${this.cfg.displayName} itself.`
        )
      );
      return false;
    }
    this.permissions.delete(requestId);
    return this.control.send(response(held.rawId, outcome));
  }

  private async listModels(): Promise<ControlVerdict> {
    if (!(await this.whenReady())) return this.notOpen();
    const opt = this.option('model');
    const models = opt
      ? opt.choices.map((c) => ({
          value: c.value,
          displayName: c.name ?? c.value,
          ...(c.description ? { description: c.description } : {}),
        }))
      : this.models?.available.map((c) => ({
          value: c.value,
          displayName: c.name ?? c.value,
          ...(c.description ? { description: c.description } : {}),
        }));
    if (!models)
      return {
        ok: false,
        reason: 'refused',
        message: `${this.cfg.displayName} did not say which models it has`,
      };
    return { ok: true, response: { models } };
  }

  private async setModel(model: unknown): Promise<ControlVerdict> {
    const want = typeof model === 'string' ? model.trim() : '';
    if (!want) return { ok: false, reason: 'invalid', message: 'no model named' };
    return this.setSetting('model', want, { model: want });
  }

  private async getEffort(): Promise<ControlVerdict> {
    if (!(await this.whenReady())) return this.notOpen();
    const opt = this.option(THOUGHT_LEVEL);
    const model = this.currentModel();
    if (!opt)
      return {
        ok: true,
        response: { effort: null, levels: [], ...(model ? { model } : {}) },
      };
    return {
      ok: true,
      response: {
        effort: opt.currentValue,
        levels: opt.choices.map((c) => c.value),
        ...(model ? { model } : {}),
      },
    };
  }

  private async setEffort(level: unknown): Promise<ControlVerdict> {
    const want = typeof level === 'string' ? level.trim() : '';
    if (!want) return { ok: false, reason: 'invalid', message: 'no level named' };
    return this.setSetting(THOUGHT_LEVEL, want, { effort: want });
  }

  private async setMode(mode: AutonomyMode): Promise<ControlVerdict> {
    const want = this.cfg.modeMap?.[mode];
    if (!want)
      return {
        ok: false,
        reason: 'refused',
        message: `${this.cfg.displayName} has no mode for "${mode}"`,
      };
    // After the session is open (so the open's own readback still compares
    // against the mode the card started at), and before the send: the reply's
    // readback (`modeEvent`) runs as the reply arrives, ahead of this promise
    // settling. Put back if the set fails.
    if (!(await this.whenReady())) return this.notOpen();
    const prior = this.hostMode;
    this.hostMode = mode;
    const verdict = await this.setSetting('mode', want, { mode });
    if (!verdict.ok && this.hostMode === mode) this.hostMode = prior;
    return verdict;
  }

  /** The shared body of every `set`: wait for the session, send, VERIFY. */
  private async setSetting(category: string, value: string, ok: Record<string, unknown>): Promise<ControlVerdict> {
    if (!(await this.whenReady())) return this.notOpen();
    const sent = this.setRequest(category, value, 'set');
    if (!sent) {
      return {
        ok: false,
        reason: 'refused',
        message: `${this.cfg.displayName} cannot change its ${category === THOUGHT_LEVEL ? 'effort' : category}`,
      };
    }
    const reply = await sent;
    if (!reply.ok) return { ok: false, reason: 'refused', message: reply.message };
    // A config option's reply IS the new state (measured: no notification
    // follows). Verified by effect: a value that did not take is refused.
    const now =
      this.option(category)?.currentValue ??
      (category === 'mode'
        ? this.modes?.currentModeId
        : category === 'model'
          ? this.models?.currentModelId
          : undefined);
    if (now !== undefined && now !== value) {
      return {
        ok: false,
        reason: 'refused',
        message: `${this.cfg.displayName} did not take "${value}"; it is still on "${now}"`,
      };
    }
    this.rememberSetting(category, value);
    return { ok: true, response: ok };
  }

  private contextUsage(): ControlVerdict {
    const u = this.usage;
    if (!u || u.size <= 0) {
      return {
        ok: false,
        reason: 'refused',
        message: `${this.cfg.displayName} has not said how full its context is`,
      };
    }
    return {
      ok: true,
      response: {
        percentage: Math.min(100, Math.max(0, Math.round((u.used / u.size) * 100))),
        totalTokens: u.used,
        maxTokens: u.size,
        autoCompactAt: null,
      },
    };
  }

  // ── the frame handler ───────────────────────────────────────────────────

  private onFrame(frame: Record<string, unknown>): EngineEvent[] {
    if (this.phase === 'gone') return [];
    const c = classify(frame);
    switch (c.kind) {
      case 'malformed':
        this.report('malformed frame');
        return [];
      case 'notification':
        if (c.method === 'session/update') return this.onUpdate(c.params);
        // `_auth/status_update` (measured, Codex) and every other extension
        // notification: understood to be optional, skipped.
        this.report(`notification:${c.method}`);
        return [];
      case 'request':
        if (c.method === 'session/request_permission') return this.onPermission(c.id, c.params);
        // `fs/*` and `terminal/*` were never offered (design §4 decision 1);
        // anything else is unknown. Answered, so the agent is not left waiting.
        this.report(`request:${c.method}`);
        this.control?.send(errorResponse(c.id, METHOD_NOT_FOUND, `${c.method} is not supported by this client`));
        return [];
      case 'response':
      case 'error': {
        const o = this.outstanding.get(c.id);
        if (!o) {
          this.report('response to nothing we asked');
          return [];
        }
        this.outstanding.delete(c.id);
        if (c.kind === 'response') {
          o.settle?.({ ok: true, result: c.result });
          return this.onResult(c.id, o, c.result);
        }
        o.settle?.({ ok: false, message: c.message });
        return this.onError(c.id, o, c.code, c.message);
      }
    }
  }

  private onUpdate(params: Record<string, unknown>): EngineEvent[] {
    if (this.acpSessionId && typeof params.sessionId === 'string' && params.sessionId !== this.acpSessionId) {
      this.report('update for another session');
      return [];
    }
    const u = asObject(params.update);
    if (!u) {
      this.report('session/update with no update');
      return [];
    }
    const variant = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : '(none)';
    // The parts the SESSION reads, before the content translation.
    const extra: EngineEvent[] = [];
    if (variant === 'usage_update' && typeof u.used === 'number' && typeof u.size === 'number') {
      this.usage = { used: u.used, size: u.size };
    } else if (variant === 'current_mode_update' && typeof u.currentModeId === 'string') {
      if (this.modes) this.modes = { ...this.modes, currentModeId: u.currentModeId };
      extra.push(...this.modeEvent(u.currentModeId));
    } else if (variant === 'config_option_update') {
      const opts = readConfigOptions(u.configOptions);
      if (opts) {
        this.config = opts;
        extra.push(...this.settingEvents());
      }
    }
    const events = this.content.update(u);
    if (events === null) {
      this.report(`session/update:${variant}`);
      return extra;
    }
    // Activity only for a LIVE turn: a `session/load` replay is history.
    const live =
      this.turn !== undefined && events.length > 0
        ? [{ type: 'activity', label: `acp:${variant}` } as EngineEvent]
        : [];
    return [...live, ...extra, ...events];
  }

  private onPermission(rawId: RpcId, params: Record<string, unknown>): EngineEvent[] {
    const requestId = String(rawId);
    const call = asObject(params.toolCall) ?? {};
    this.permissions.set(requestId, {
      rawId,
      options: readPermissionOptions(params.options),
    });
    const title = typeof call.title === 'string' && call.title ? call.title : undefined;
    const tool = title ?? (typeof call.kind === 'string' && call.kind ? call.kind : 'unknown');
    const input = asObject(call.rawInput) ?? {};
    return [
      ...this.content.flush(),
      {
        type: 'permission-request',
        requestId,
        tool,
        input,
        ...(title ? { displayName: title } : {}),
      },
    ];
  }

  private onResult(id: RpcId, o: Outstanding, result: Record<string, unknown>): EngineEvent[] {
    switch (o.purpose) {
      case 'init': {
        this.agent = readInitialize(result);
        if (this.agent.protocolVersion !== undefined && this.agent.protocolVersion !== 1) {
          this.note('acp agent answered a protocol version this client does not speak; carrying on', {
            version: String(this.agent.protocolVersion),
          });
        }
        return this.open();
      }
      case 'auth':
        this.ask('new', 'session/new', {
          cwd: this.start.cwd,
          mcpServers: this.start.mcpServers,
        });
        return [];
      case 'new':
      case 'load': {
        const sid = o.purpose === 'new' ? result.sessionId : this.start.resumeSessionId;
        if (typeof sid !== 'string' || !sid) return this.fail('the agent opened a session with no id');
        this.acpSessionId = sid;
        this.config = readConfigOptions(result.configOptions) ?? this.config;
        this.modes = readModes(result.modes) ?? this.modes;
        this.models = readModelState(result.models) ?? this.models;
        const events: EngineEvent[] = [
          ...this.content.flush(),
          { type: 'conversation', id: sid },
          ...this.settingEvents(),
        ];
        this.reapply(o.purpose === 'load');
        return events;
      }
      case 'prompt':
        return this.endTurn(id, result);
      case 'set-config': {
        const opts = readConfigOptions(result.configOptions);
        if (opts) this.config = opts;
        return this.settingEvents();
      }
      case 'set-mode':
        if (o.value && this.modes) this.modes = { ...this.modes, currentModeId: o.value };
        return o.value ? this.modeEvent(o.value) : [];
      case 'set-model':
        if (o.value && this.models) this.models = { ...this.models, currentModelId: o.value };
        return o.value ? [{ type: 'model', id: o.value }] : [];
    }
  }

  private onError(id: RpcId, o: Outstanding, code: number, message: string): EngineEvent[] {
    switch (o.purpose) {
      case 'init':
        return this.fail(`could not start: ${message}`);
      case 'new':
        if (code === AUTH_REQUIRED && this.cfg.authMethodId && !this.authTried) {
          this.authTried = true;
          this.deadline(AUTH_DEADLINE_MS);
          this.ask('auth', 'authenticate', { methodId: this.cfg.authMethodId });
          return [];
        }
        return this.fail(
          code === AUTH_REQUIRED ? `is not signed in: ${message}` : `could not open a session: ${message}`
        );
      case 'auth':
        return this.fail(`could not sign in: ${message}`);
      case 'load':
        // The conversation is not there (a session that never got a prompt is
        // not persisted, measured) or would not load. A fresh one beats none.
        this.note('acp session/load failed; starting a new conversation', {
          error: message,
        });
        this.ask('new', 'session/new', {
          cwd: this.start.cwd,
          mcpServers: this.start.mcpServers,
        });
        // Said on screen: the card is about to move to a NEW conversation, and a
        // history that silently vanished reads as data loss (review of #1289).
        return this.content.notice(
          `${this.cfg.displayName} could not reopen the previous conversation (${message}); this is a new one.`
        );
      case 'prompt': {
        const events = [...this.content.notice(`${this.cfg.displayName} reported an error: ${message}`)];
        events.push(...this.endTurn(id, null));
        return events;
      }
      default:
        // a `set-*`: a control's own promise carries the refusal
        if (o.reapply)
          this.note('acp could not re-apply a setting after opening', {
            error: message,
          });
        return [];
    }
  }

  // ── lifecycle steps ─────────────────────────────────────────────────────

  private open(): EngineEvent[] {
    this.phase = 'opening';
    if (this.start.resumeSessionId && this.agent?.loadSession) {
      this.ask('load', 'session/load', {
        sessionId: this.start.resumeSessionId,
        cwd: this.start.cwd,
        mcpServers: this.start.mcpServers,
      });
      return [];
    }
    this.ask('new', 'session/new', {
      cwd: this.start.cwd,
      mcpServers: this.start.mcpServers,
    });
    return this.start.resumeSessionId
      ? this.content.notice(`${this.cfg.displayName} cannot reopen a previous conversation; this is a new one.`)
      : [];
  }

  /**
   * Put model, effort and mode back (measured: `session/load` resets all three
   * to the agent's defaults), then go READY once every reply is in.
   *
   * Mode comes from the card's autonomy, through the provider's map. Model and
   * effort come from what this provider remembers of the conversation — its
   * in-memory map first, then what the HOST kept for it across a restart
   * (`AcpStart.resumeSettings`, #1317). Neither: the agent's defaults stand.
   */
  private reapply(loaded: boolean): void {
    this.phase = 'configuring';
    const pending: Array<Promise<unknown>> = [];
    const id = loaded ? this.acpSessionId : undefined;
    const kept = id && id === this.start.resumeSessionId ? this.start.resumeSettings : undefined;
    const inMemory = id ? this.memory.get(id) : undefined;
    const remembered = inMemory ?? kept;
    // What was KEPT goes into this process's memory field by field, and only
    // once the agent has it (applied, or already current) — so a later set
    // adds to it rather than replacing it (the event carries the whole entry),
    // and a kept id the agent now refuses (a retired model) is not sent back
    // to be kept again (review of #1317).
    const seed = (category: string, value: string): void => {
      if (!id || inMemory || category === 'mode') return;
      const entry = this.memory.get(id) ?? {};
      if (category === 'model') entry.model = value;
      else if (category === THOUGHT_LEVEL) entry.effort = value;
      this.memory.set(id, entry);
    };
    const wantMode = this.start.autonomy ? this.cfg.modeMap?.[this.start.autonomy] : undefined;
    const wants: Array<[string, string | undefined]> = [
      ['model', remembered?.model],
      [THOUGHT_LEVEL, remembered?.effort],
      ['mode', wantMode],
    ];
    for (const [category, value] of wants) {
      if (!value) continue;
      if (this.currentOf(category) === value) {
        seed(category, value);
        continue;
      }
      const sent = this.setRequest(category, value, 'reapply');
      if (sent)
        pending.push(
          sent.then((r) => {
            // verified by effect, as a control's set is: a reply that did not
            // change the value is not "the agent has it"
            if (r.ok && this.currentOf(category) === value) seed(category, value);
          })
        );
    }
    void Promise.all(pending).then(() => this.ready());
  }

  private ready(): void {
    if (this.phase !== 'configuring') return;
    this.phase = 'ready';
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.setupTimer = undefined;
    for (const w of this.readyWaiters) w(true);
    this.readyWaiters.clear();
    // the windows before the first turn, so a fresh card shows where it stands
    this.readLimits();
    this.drain();
  }

  /**
   * Ask the provider's plan-limits reader (`AcpSessionConfig.limits`) and put
   * what it answers through the pump as a TOKEN-FREE `usage` event — the
   * ledger adds nothing and replaces the windows (#1290). Fail-open: a reader
   * that rejects, throws or answers nothing sends nothing; a session that has
   * gone meanwhile sends nothing either.
   */
  private readLimits(): void {
    const reader = this.cfg.limits;
    if (!reader) return;
    let pending: Promise<PlanLimitWindow[] | undefined>;
    try {
      pending = reader();
    } catch {
      return;
    }
    void Promise.resolve(pending)
      .then((limits) => {
        if (!limits || limits.length === 0 || this.phase === 'gone') return;
        this.loopback([{ type: 'usage', limits }]);
      })
      .catch(() => {});
  }

  private drain(): void {
    if (this.phase !== 'ready' || this.turn !== undefined) return;
    const next = this.queue.shift();
    if (next) this.sendPrompt(next.text, next.attachments);
  }

  private endTurn(id: RpcId, result: Record<string, unknown> | null): EngineEvent[] {
    if (this.turn === id) this.turn = undefined;
    const events: EngineEvent[] = [...this.content.flush(), ...this.settlePermissions(false)];
    const stop = typeof result?.stopReason === 'string' ? result.stopReason : 'error';
    // `cancelled` (a Stop, or a reject — measured: a reject ends the whole
    // turn) is a finished turn, not a failed one.
    events.push({
      type: 'turn-end',
      failed: result === null,
      label: `acp:${stop}`,
    });
    const usage = asObject(result?.usage);
    if (usage) {
      const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const ev: EngineEvent = { type: 'usage' };
      const input = n(usage.inputTokens);
      const output = n(usage.outputTokens);
      const cached = n(usage.cachedReadTokens);
      const written = n(usage.cachedWriteTokens);
      const thought = n(usage.thoughtTokens);
      if (input !== undefined) ev.inputTokens = input;
      if (output !== undefined) ev.outputTokens = output;
      if (cached !== undefined) ev.cacheReadTokens = cached;
      if (written !== undefined) ev.cacheWriteTokens = written;
      // inside output, never added to it (the ledger caps it at output)
      if (thought !== undefined) ev.thinkingTokens = thought;
      const model = this.currentModel();
      if (model) ev.model = model;
      events.push(ev);
    }
    // Plan limits, when the provider reads them: after every turn (cached by
    // the reader, so a burst costs one read). A cancelled turn too — its
    // tokens are unknown, but the account's windows still moved.
    this.readLimits();
    // the next queued prompt goes after this turn's events are out
    queueMicrotask(() => this.drain());
    return events;
  }

  /**
   * The session cannot be opened: say so on screen, settle anything waiting,
   * and refuse prompts from here on. A queued prompt already moved the card to
   * `working`, so a turn end is owed for it.
   */
  private fail(why: string): EngineEvent[] {
    this.phase = 'failed';
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.setupTimer = undefined;
    this.setupError = why;
    for (const w of this.readyWaiters) w(false);
    this.readyWaiters.clear();
    const owed = this.queue.length > 0 || this.turn !== undefined;
    this.queue.length = 0;
    this.turn = undefined;
    const events = this.content.notice(`${this.cfg.displayName} ${why}`);
    if (owed)
      events.push({
        type: 'turn-end',
        failed: true,
        label: 'acp:session-failed',
      });
    return events;
  }

  /** Withdraw every held permission request; on a cancel, answer each `cancelled`. */
  private settlePermissions(answerCancelled: boolean): EngineEvent[] {
    const out: EngineEvent[] = [];
    for (const [requestId, held] of this.permissions) {
      if (answerCancelled) this.control?.send(response(held.rawId, CANCELLED_OUTCOME));
      out.push({ type: 'permission-withdrawn', requestId });
    }
    this.permissions.clear();
    return out;
  }

  // ── settings ────────────────────────────────────────────────────────────

  private option(category: string): ConfigOption | undefined {
    return this.config?.find((o) => o.category === category);
  }

  private currentModel(): string | undefined {
    return this.option('model')?.currentValue ?? this.models?.currentModelId;
  }

  private currentOf(category: string): string | undefined {
    if (category === 'model') return this.currentModel();
    if (category === 'mode') return this.option('mode')?.currentValue ?? this.modes?.currentModeId;
    return this.option(category)?.currentValue;
  }

  /**
   * Send the request that sets one setting, preferring a config option
   * (measured: Codex echoes the whole new state) and falling back to the
   * spec's `set_mode` / the unstable `set_model`. `null` when the agent has no
   * way to set it.
   */
  private setRequest(
    category: string,
    value: string,
    as: 'set' | 'reapply'
  ): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; message: string }> | null {
    const opt = this.option(category);
    const sessionId = this.acpSessionId;
    if (opt) {
      return this.askFor(
        'set-config',
        'session/set_config_option',
        { sessionId, configId: opt.id, value },
        category,
        value,
        as
      );
    }
    if (category === 'mode' && this.modes) {
      return this.askFor('set-mode', 'session/set_mode', { sessionId, modeId: value }, category, value, as);
    }
    if (category === 'model' && this.models) {
      return this.askFor('set-model', 'session/set_model', { sessionId, modelId: value }, category, value, as);
    }
    return null;
  }

  private rememberSetting(category: string, value: string): void {
    if (!this.acpSessionId || category === 'mode') return;
    const entry = this.memory.get(this.acpSessionId) ?? {};
    if (category === 'model') entry.model = value;
    else if (category === THOUGHT_LEVEL) entry.effort = value;
    // re-inserted so the Map's order is least-recently-set first, then capped
    this.memory.delete(this.acpSessionId);
    this.memory.set(this.acpSessionId, entry);
    for (const oldest of this.memory.keys()) {
      if (this.memory.size <= MAX_REMEMBERED) break;
      this.memory.delete(oldest);
    }
    // ...and the host is asked to keep it with the conversation, which is what
    // survives a restart (#1317). The whole entry, so the host's copy is never
    // half of what this one holds.
    this.loopback([
      {
        type: 'settings',
        conversation: this.acpSessionId,
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.effort ? { effort: entry.effort } : {}),
      },
    ]);
  }

  /** `model` and `mode` events for the current settings. */
  private settingEvents(): EngineEvent[] {
    const out: EngineEvent[] = [];
    const model = this.currentModel();
    if (model) out.push({ type: 'model', id: model });
    const mode = this.currentOf('mode');
    if (mode) out.push(...this.modeEvent(mode));
    return out;
  }

  /** An agent mode id in the host's words, or nothing (a stale chip beats a wrong one). */
  private modeEvent(agentMode: string): EngineEvent[] {
    const map = this.cfg.modeMap;
    if (!map) return [];
    // the card's own choice first, when it means this agent mode
    const asked = this.hostMode;
    const host =
      asked && map[asked] === agentMode
        ? asked
        : (Object.keys(map) as AutonomyMode[]).find((k) => map[k] === agentMode);
    return host ? [{ type: 'mode', mode: host }] : [];
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  /** Send one request. `undefined` when it could not be written (the transport
   *  has gone): nothing is left outstanding for a reply that cannot come. */
  private ask(purpose: Purpose, method: string, params: Record<string, unknown>): RpcId | undefined {
    const id = this.nextId++;
    this.outstanding.set(id, { purpose });
    if (this.control?.send(request(id, method, params))) return id;
    this.outstanding.delete(id);
    return undefined;
  }

  private askFor(
    purpose: Purpose,
    method: string,
    params: Record<string, unknown>,
    category: string,
    value: string,
    as: 'set' | 'reapply'
  ): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; message: string }> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.outstanding.delete(id))
          resolve({
            ok: false,
            message: `${this.cfg.displayName} did not answer`,
          });
      }, REPLY_WAIT_MS);
      timer.unref?.();
      this.outstanding.set(id, {
        purpose,
        category,
        value,
        reapply: as === 'reapply',
        settle: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
      if (!this.control?.send(request(id, method, params))) {
        clearTimeout(timer);
        this.outstanding.delete(id);
        resolve({ ok: false, message: 'the session has stopped' });
      }
    });
  }

  private whenReady(): Promise<boolean> {
    if (this.phase === 'ready') return Promise.resolve(true);
    if (this.phase === 'failed' || this.phase === 'gone') return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters.delete(done);
        resolve(false);
      }, READY_WAIT_MS);
      timer.unref?.();
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        resolve(ok);
      };
      this.readyWaiters.add(done);
    });
  }

  private notOpen(): ControlVerdict {
    if (this.phase === 'gone')
      return {
        ok: false,
        reason: 'session-gone',
        message: 'the session has stopped',
      };
    return {
      ok: false,
      reason: this.phase === 'failed' ? 'refused' : 'timed-out',
      message: this.setupError ?? `${this.cfg.displayName} has not opened the session yet`,
    };
  }

  private loopback(events: EngineEvent[]): void {
    if (events.length === 0) return;
    const frame: Record<string, unknown> = {};
    this.minted.set(frame, { events });
    this.control?.loopback?.(frame);
  }

  /** Once per kind per session, at info (`onUnknown`). */
  private report(kind: string): void {
    if (this.reported.has(kind)) return;
    this.reported.add(kind);
    this.hooks?.onUnknown?.(kind);
  }

  private note(what: string, fields: Record<string, string>): void {
    this.hooks?.onSkipped?.(what, fields);
  }
}
