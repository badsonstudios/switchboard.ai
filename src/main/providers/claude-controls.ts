// Claude's CONTROLS, behind its adapter (E40 item 04, #1287).
//
// "What you can do to" a Claude session, in its own wire: every
// `control_request` this app sends, the `control_response` to a
// `can_use_tool`, and the `user` frame a prompt rides. Declared through the
// adapter's `controls` capability by BOTH the real Claude adapter and the fake
// stream adapter, so every e2e drives these exact frames.
//
// THE CODE MOVED, IT DID NOT CHANGE. Each method below is what
// `SessionManager` (interrupt, prompt, the #721 verbs, the #1115 effort pair,
// #715's context usage, the #729/#734 MCP verbs) and `StreamPermissions` (the
// `controlResponse` answer) used to build themselves, with the same builders,
// the same validation before the wire, and the same verification by effect.
// What stayed host-side is everything about the SESSION rather than the wire:
// the "is it still here" precheck, the logging, the router's policy.
//
// ONE `ControlChannel` PER SESSION, fed the session's frames by `receive`.
// It was one per manager, listening to every session's frames and matching
// on id; per session, a reply can only ever be matched against its own
// session's requests, which the old flat map had to check for.
import { randomUUID } from 'crypto';
import type {
  ControlCapability,
  ControlSession,
  PermissionDecision,
  SessionControls,
} from '../sessions/engine-controls';
import type { ControlVerdict } from '../../shared/control';
import type { EffortState } from '../../shared/effort';
import { ControlChannel, MCP_AUTHENTICATE_TIMEOUT_MS } from './claude-control-channel';
import {
  controlResponse,
  interruptRequest,
  listModelsRequest,
  mcpAuthenticateRequest,
  mcpClearAuthRequest,
  mcpReconnectRequest,
  mcpStatusRequest,
  mcpToggleRequest,
  setModelRequest,
  userMessage,
} from './claude-protocol';
import {
  appliedModel,
  effortLevelsFor,
  getSettingsRequest,
  readApplied,
  setEffortRequest,
  withLevel,
} from './claude-effort';
import { getContextUsageRequest, readContextUsage } from './claude-context-usage';

/**
 * The frame that answers a `can_use_tool`. The decision IS the payload —
 * `{behavior:'allow', updatedInput}` / `{behavior:'deny', message}` is the
 * CLI's own vocabulary, which the neutral `PermissionDecision` was named
 * after — so the bytes are the ones the router always sent.
 */
export function claudePermissionAnswer(requestId: string, decision: PermissionDecision): unknown {
  return controlResponse(requestId, decision);
}

/** One Claude session's controls. Exported for tests; the app reaches it
 *  through `claudeControls`. */
export function createClaudeControls(session: ControlSession): SessionControls {
  const listeners = new Set<(sessionId: string, msg: Record<string, unknown>) => void>();
  const channel = new ControlChannel({
    send: (_sessionId, msg) => session.send(msg),
    onMessage: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  });
  const ask = channel.request.bind(channel, session.id);

  return {
    approvals: {
      answer: (requestId, decision) => session.send(claudePermissionAnswer(requestId, decision)),
    },

    // #154. Shape read out of the SDK in the VS Code extension bundle:
    // `{subtype:'interrupt'}`, fire-and-forget. A UUID, because it correlates
    // nothing and never needed to be readable (see `ControlChannel.seq`).
    interrupt: { interrupt: () => session.send(interruptRequest(randomUUID())) },

    models: {
      // `list_models` rather than `initialize`: the same array, without the
      // ~28 KB of commands, agents and account data around it. Its answer is
      // already the neutral `{models:[{value, displayName?, …}]}` shape, so it
      // passes through untouched — `shared/models.ts`.
      list: () => ask(listModelsRequest),
      // An empty or non-string `model` is refused before the wire — see
      // `setModelRequest`, and the measured silent no-op that forced it.
      set: (model) => ask((requestId) => setModelRequest(requestId, model)),
    },

    effort: {
      // Two questions, because neither answers both: `get_settings` says what
      // is APPLIED (the level, and the model), `list_models` says which levels
      // that model takes. A model with no effort levels answers `effort: null`,
      // and so does a CLI whose `get_settings` has no `applied` block.
      async get(): Promise<ControlVerdict> {
        const settings = await ask(getSettingsRequest);
        if (!settings.ok) return settings;
        const applied = readApplied(settings.response);
        // `model` rides along (#1174): this is the one `get_settings` a card
        // makes when it appears, and the same answer says which model the
        // session is on. The IPC layer seeds the model store from it.
        const model = appliedModel(settings.response);
        if (!applied || applied.effort === null) {
          const none: EffortState = { effort: null, levels: [] };
          return { ok: true, response: { ...none, model } };
        }
        const models = await ask(listModelsRequest);
        if (!models.ok) return models;
        // the level in force is always offered, whatever the list says
        const levels = withLevel(effortLevelsFor(models.response, applied.model), applied.effort);
        const state: EffortState = { effort: applied.effort, levels };
        return { ok: true, response: { ...state, model } };
      },
      // ⚠️ VERIFIED BY EFFECT, EVERY TIME: `apply_flag_settings` answers
      // `success` to a level the CLI has never heard of and changes nothing
      // (measured). So the level is READ BACK, and a set that did not take is
      // `refused` with what the session is actually on.
      async set(level: unknown): Promise<ControlVerdict> {
        const sent = await ask((requestId) => setEffortRequest(requestId, level));
        if (!sent.ok) return sent;
        const settings = await ask(getSettingsRequest);
        if (!settings.ok) return settings;
        const applied = readApplied(settings.response);
        const want = typeof level === 'string' ? level.trim() : '';
        if (!applied || applied.effort !== want) {
          return {
            ok: false,
            reason: 'refused',
            message: applied?.effort
              ? `the session did not take "${want}"; it is still on "${applied.effort}"`
              : `the session did not take "${want}"`,
          };
        }
        return { ok: true, response: { effort: want } };
      },
    },

    contextUsage: {
      // ONLY THE NUMBERS LEAVE: the answer lists every memory file by path and
      // every tool by name. An answer with no usable fill is `refused`, not a
      // success carrying zero.
      async get(): Promise<ControlVerdict> {
        const answer = await ask(getContextUsageRequest);
        if (!answer.ok) return answer;
        const usage = readContextUsage(answer.response);
        if (!usage) {
          return { ok: false, reason: 'refused', message: 'the session did not say how full its context is' };
        }
        return { ok: true, response: { ...usage } };
      },
    },

    // The mode is `--permission-mode`, applied at the next start from the
    // card's setting (`claude.ts`); the CLI announces where it really is, and
    // the translator turns that into `mode` events. No live switch to offer.
    modes: {},

    // `/clear`, `/compact` and the rest are typed into the real CLI as prompt
    // text; the list arrives on `system:init` (the translator's `commands`).
    slashCommands: {},

    mcp: {
      // #729: the ONLY source of the session's real MCP inventory. The answer
      // SETTLES (`pending` for ~5 s on a cold session); the caller asks again.
      status: () => ask(mcpStatusRequest),
      // ⚠️ `enabled` is checked for a STRICT boolean before the wire: an
      // absent one DISABLES the server and answers success (measured).
      toggle: (serverName, enabled) =>
        ask((requestId) => mcpToggleRequest(requestId, serverName, enabled)),
      reconnect: (serverName) => ask((requestId) => mcpReconnectRequest(requestId, serverName)),
      // ⚠️ `ok: true` does not mean "signed in": it carries the `authUrl` the
      // HOST must open (#1420, `mcp/sign-in.ts`).
      // THE ONE VERB WITH ITS OWN TIMEOUT (#1425): its answer waits on the
      // server's authorisation side, and a late one is dropped, not opened.
      authenticate: (serverName) =>
        ask((requestId) => mcpAuthenticateRequest(requestId, serverName), {
          timeoutMs: MCP_AUTHENTICATE_TIMEOUT_MS,
        }),
      clearAuth: (serverName) => ask((requestId) => mcpClearAuthRequest(requestId, serverName)),
    },

    // The `user` frame (P2-E18-06): attachments first, the text last, a fresh
    // `uuid` per delivery and `origin: human`. See `userMessage`.
    prompt: (text, attachments) => session.send(userMessage(text, attachments)),

    receive(frame) {
      for (const l of listeners) l(session.id, frame);
    },

    forget: () => channel.forgetSession(session.id),
  };
}

/** The `controls` capability both Claude adapters declare. */
export const claudeControls: ControlCapability = {
  createControls: createClaudeControls,
};
