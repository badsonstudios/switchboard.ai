// The Agent Client Protocol's WIRE, behind the adapter (E40 item 06, #1289).
//
// JSON-RPC 2.0, newline-delimited, over the agent's stdio. The contract was
// MEASURED against `@agentclientprotocol/codex-acp@2.2.2` (protocolVersion 1,
// `spike/findings/e40-codex-acp.md`, captures in `spike/probes/1285/captures/`)
// and read from the ACP schema (`@agentclientprotocol/sdk` 1.9.0's
// `schema/schema.json`). Where the two differ the SPEC is followed and Codex is
// tolerated. Nothing outside `src/main/providers/` may import this file
// (`sessions/engine-seam.test.ts`).
//
// PURE: builders and readers only. No state, no I/O.

/** The protocol version this client speaks. The only one measured. */
export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC's "the method does not exist" — what an `fs/*` or `terminal/*`
 *  request gets, since v1 declares neither capability (design §4 decision 1). */
export const METHOD_NOT_FOUND = -32601;

/** Measured: logged out, Codex's `session/new` fails with this code and
 *  "Authentication required". The spec's `auth_required` code too. */
export const AUTH_REQUIRED = -32000;

/** A JSON-RPC id. Agent-to-client ids START AT 0 (measured), so a test of
 *  `if (msg.id)` would drop the first request; correlate on `!== undefined`. */
export type RpcId = number | string;

export function isRpcId(v: unknown): v is RpcId {
  return (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string';
}

/** What one inbound line is, as JSON-RPC sees it. */
export type Inbound =
  | { kind: 'response'; id: RpcId; result: Record<string, unknown> }
  | { kind: 'error'; id: RpcId; code: number; message: string }
  | {
      kind: 'request';
      id: RpcId;
      method: string;
      params: Record<string, unknown>;
    }
  | { kind: 'notification'; method: string; params: Record<string, unknown> }
  | { kind: 'malformed' };

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Classify one decoded line. Lenient on `"jsonrpc"` — the spec requires it,
 * Codex sends it, and `codex app-server` (a different protocol) was measured
 * omitting it, so requiring it would reject frames for a reason no user can
 * act on. A frame that is none of the four shapes is `malformed`: logged and
 * skipped by the caller, never fatal (P6).
 */
export function classify(frame: unknown): Inbound {
  const m = obj(frame);
  if (!m) return { kind: 'malformed' };
  const method = typeof m.method === 'string' ? m.method : undefined;
  const hasId = isRpcId(m.id);
  if (method !== undefined) {
    const params = obj(m.params) ?? {};
    return hasId ? { kind: 'request', id: m.id as RpcId, method, params } : { kind: 'notification', method, params };
  }
  if (!hasId) return { kind: 'malformed' };
  const err = obj(m.error);
  if (err) {
    return {
      kind: 'error',
      id: m.id as RpcId,
      code: typeof err.code === 'number' ? err.code : 0,
      message: typeof err.message === 'string' && err.message ? err.message : 'the agent reported an error',
    };
  }
  if ('result' in m) return { kind: 'response', id: m.id as RpcId, result: obj(m.result) ?? {} };
  return { kind: 'malformed' };
}

export function request(id: RpcId, method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

export function notification(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', method, params };
}

export function response(id: RpcId, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

export function errorResponse(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * `initialize`'s params. v1 offers NO `fs/*` and NO `terminal/*` (design §4
 * decision 1, host-don't-reimplement): the agent uses its own file and shell
 * access. Spelled out rather than omitted, as the probe sent them, so an agent
 * that reads a missing field as "yes" cannot.
 */
export function initializeParams(clientVersion: string): Record<string, unknown> {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: {
      name: 'switchboard',
      title: 'switchboard.ai',
      version: clientVersion,
    },
  };
}

/** One stdio MCP server, in `session/new`'s shape (measured: Codex launched
 *  it with this env and used its tools). `env` is a LIST of `{name, value}`. */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export function stdioMcpServer(
  name: string,
  launch: { command: string; args: string[]; env: Record<string, string> }
): AcpMcpServer {
  return {
    name,
    command: launch.command,
    args: [...launch.args],
    env: Object.entries(launch.env).map(([k, value]) => ({ name: k, value })),
  };
}

/** `{mcpServers: [...]}` back out of what the `mcp` capability shaped, or `[]`. */
export function readMcpServers(config: Record<string, unknown> | undefined): AcpMcpServer[] {
  const list = config?.mcpServers;
  if (!Array.isArray(list)) return [];
  return list.filter((s): s is AcpMcpServer => {
    const o = obj(s);
    return !!o && typeof o.name === 'string' && typeof o.command === 'string' && Array.isArray(o.args);
  });
}

/** What `initialize` told us about the agent. */
export interface AgentInfo {
  protocolVersion: number | undefined;
  loadSession: boolean;
  image: boolean;
  authMethods: string[];
  /**
   * Each sign-in method's own label, by id (#1316) — the agent's `name` for
   * it ("ChatGPT", "API Key"; measured from Codex in #1285). Only the methods
   * that gave one; the id stays what is sent back.
   */
  authMethodNames: Record<string, string>;
  name?: string;
  version?: string;
}

function methodNames(methods: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of methods) {
    const o = obj(m);
    if (o && typeof o.id === 'string' && o.id && typeof o.name === 'string' && o.name.trim()) {
      out[o.id] = o.name.trim();
    }
  }
  return out;
}

export function readInitialize(result: Record<string, unknown>): AgentInfo {
  const caps = obj(result.agentCapabilities) ?? {};
  const prompt = obj(caps.promptCapabilities) ?? {};
  const info = obj(result.agentInfo) ?? {};
  const methods = Array.isArray(result.authMethods) ? result.authMethods : [];
  return {
    protocolVersion: typeof result.protocolVersion === 'number' ? result.protocolVersion : undefined,
    loadSession: caps.loadSession === true,
    image: prompt.image === true,
    authMethods: methods.map((m) => obj(m)?.id).filter((id): id is string => typeof id === 'string' && id !== ''),
    authMethodNames: methodNames(methods),
    ...(typeof info.name === 'string' ? { name: info.name } : {}),
    ...(typeof info.version === 'string' ? { version: info.version } : {}),
  };
}

/** One choice of a `select` config option. */
export interface ConfigChoice {
  value: string;
  name?: string;
  description?: string;
}

/** A session config option (spec `SessionConfigOption`, `type: "select"`). */
export interface ConfigOption {
  id: string;
  name?: string;
  category?: string;
  currentValue: string;
  choices: ConfigChoice[];
}

function readChoice(v: unknown): ConfigChoice | null {
  const o = obj(v);
  if (!o || typeof o.value !== 'string' || !o.value) return null;
  return {
    value: o.value,
    ...(typeof o.name === 'string' ? { name: o.name } : {}),
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
  };
}

/**
 * `configOptions` off `session/new`, `session/load`, a `set_config_option`
 * reply or a `config_option_update`. Only `select` options are read (the
 * spec's other type, a boolean, has no control here). GROUPED options are
 * flattened: the group is presentation, the value is what gets set. An entry
 * that cannot be read is dropped, not fatal. `null` when the field is absent.
 */
export function readConfigOptions(v: unknown): ConfigOption[] | null {
  if (!Array.isArray(v)) return null;
  const out: ConfigOption[] = [];
  for (const entry of v) {
    const o = obj(entry);
    if (!o || typeof o.id !== 'string' || !o.id) continue;
    if (o.type !== undefined && o.type !== 'select') continue;
    if (typeof o.currentValue !== 'string') continue;
    const choices: ConfigChoice[] = [];
    for (const item of Array.isArray(o.options) ? o.options : []) {
      const g = obj(item);
      if (g && Array.isArray(g.options)) {
        for (const inner of g.options) {
          const c = readChoice(inner);
          if (c) choices.push(c);
        }
      } else {
        const c = readChoice(item);
        if (c) choices.push(c);
      }
    }
    out.push({
      id: o.id,
      currentValue: o.currentValue,
      choices,
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
      ...(typeof o.category === 'string' ? { category: o.category } : {}),
    });
  }
  return out;
}

/** The spec `modes` state (`currentModeId` + `availableModes`). */
export interface ModeState {
  currentModeId: string;
  available: string[];
}

export function readModes(v: unknown): ModeState | null {
  const o = obj(v);
  if (!o || typeof o.currentModeId !== 'string') return null;
  const available = (Array.isArray(o.availableModes) ? o.availableModes : [])
    .map((m) => obj(m)?.id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
  return { currentModeId: o.currentModeId, available };
}

/** The UNSTABLE `models` state (`currentModelId` + `availableModels`). */
export interface ModelState {
  currentModelId: string;
  available: ConfigChoice[];
}

export function readModelState(v: unknown): ModelState | null {
  const o = obj(v);
  if (!o || typeof o.currentModelId !== 'string') return null;
  const available: ConfigChoice[] = [];
  for (const m of Array.isArray(o.availableModels) ? o.availableModels : []) {
    const e = obj(m);
    if (!e || typeof e.modelId !== 'string' || !e.modelId) continue;
    available.push({
      value: e.modelId,
      ...(typeof e.name === 'string' ? { name: e.name } : {}),
      ...(typeof e.description === 'string' ? { description: e.description } : {}),
    });
  }
  return { currentModelId: o.currentModelId, available };
}

/** A permission option (spec `PermissionOption`). */
export interface PermissionOption {
  optionId: string;
  kind: string;
  name?: string;
}

export function readPermissionOptions(v: unknown): PermissionOption[] {
  const out: PermissionOption[] = [];
  for (const entry of Array.isArray(v) ? v : []) {
    const o = obj(entry);
    if (!o || typeof o.optionId !== 'string' || typeof o.kind !== 'string') continue;
    out.push({
      optionId: o.optionId,
      kind: o.kind,
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
    });
  }
  return out;
}

/**
 * The outcome that answers a `session/request_permission`, chosen BY KIND and
 * named BY `optionId` (measured: Codex's ids are not its kinds —
 * `accept_execpolicy_amendment`, `cancel`).
 *
 * - allow -> `allow_once`. Never `allow_always`: that is a standing rule the
 *   person did not choose; the host has its own allow-all, answered in main.
 *   No `allow_once` offered -> `null` (the caller fails the answer rather than
 *   granting more than was asked).
 * - deny -> `reject_once`, else `reject_always` (Codex offers no
 *   `reject_always`; the spec allows it; refusing harder is the safe side),
 *   else the spec's `cancelled` outcome.
 */
export function permissionOutcome(
  options: PermissionOption[],
  behavior: 'allow' | 'deny'
): Record<string, unknown> | null {
  const byKind = (kind: string): PermissionOption | undefined => options.find((o) => o.kind === kind);
  if (behavior === 'allow') {
    const pick = byKind('allow_once');
    return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : null;
  }
  const pick = byKind('reject_once') ?? byKind('reject_always');
  return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
}

/** The spec's "the turn was cancelled before anyone answered" outcome. */
export const CANCELLED_OUTCOME: Record<string, unknown> = {
  outcome: { outcome: 'cancelled' },
};

export { obj as asObject };
