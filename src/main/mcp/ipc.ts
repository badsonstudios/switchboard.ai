// The MCP Manager's IPC seam (§5.17, #632 read, #714 write).
//
// Six channels. Two answer questions about a folder, three change something
// through the CLI, and one types into a session:
//
//   mcp:list            the servers, off the config files. Cheap — two file reads.
//   mcp:status          the servers the SESSION really has, over the control
//                       channel (#729). The only source that can see claude.ai
//                       connectors and plugin servers, and the only one that
//                       needs a live session.
//   mcp:health          whether the CLI is connected to them. Expensive — it
//                       connects to every server, so it is a SEPARATE call the
//                       pane makes after it has already drawn. STILL HERE, and
//                       #729's summary line saying `mcp_status` retires it is
//                       true only for a live session: a SUSPENDED card has no
//                       control channel, and this is its only status source.
//                       Deleting it would cost those cards a column they have.
//   mcp:add             `claude mcp add …`
//   mcp:remove          `claude mcp remove <name> -s <scope>`
//   mcp:resetApprovals  `claude mcp reset-project-choices` — PROJECT-WIDE
//   mcp:reconnect       type `/mcp` into a live session, on the one transport
//                       where that means anything
//
// HOW THIS SEAM SAYS NO: by resolving, never by throwing — the house shape
// `group-ipc.ts`'s header argues for at length. `mcp:list` answers an inventory
// with `unreadable` scopes named in it; `mcp:health` answers an empty map with
// `ok: false`; the three writes answer `{ ok: false, reason }`; `mcp:reconnect`
// answers an outcome. Nothing here has a failure mode that reaches the renderer
// as a rejection, which matters more in this family than in most because every
// one of them is driven from a modal the user opened deliberately: an exception
// behind a dialog is a dialog that does nothing.
//
// THE FOLDER GATE RUNS ON ALL SIX (§5.29). It mattered on the read channels
// because the folder decides which `.mcp.json` is read and where a child
// process is spawned. It matters MORE on the write channels, where the same
// folder decides which repo's checked-in `.mcp.json` gets a new server written
// into it — so an ungated `mcp:add` would be a way to plant a program that runs
// on a teammate's machine when they next clone.
import path from 'path';
import { IpcBroker } from '../ipc/broker';
import { Logger } from '../log/logger';
import { readInventory, samePath } from './config';
import { checkHealth } from './health';
import { readMcpStatus } from './status';
import { enrichRuntime, notLoaded } from './merge';
import { runMcp } from './cli';
import {
  RESET_APPROVALS_ARGS,
  buildAddArgs,
  buildRemoveArgs,
  validateAdd,
  validateRemoveName,
  validateScope,
} from '../../shared/mcp-args';
import type {
  McpAddRequest,
  McpHealthWire,
  McpInventoryWire,
  McpMutationResult,
  McpReconnectResult,
  McpScope,
  McpStatusWire,
} from '../../shared/mcp';
import type { ControlVerdict } from '../../shared/control';

/** What main needs to know about a live session to reconnect it. */
export interface McpLiveSession {
  /** the folder it is running in — checked against the gated folder so a
   *  caller cannot pair an allowed folder with somebody else's session id */
  folder: string;
  /** which transport is hosting it RIGHT NOW — the live record's field, not
   *  the card's stored preference. #445 is the scar: those two disagree while
   *  a transport change waits for a restart, and reading the wrong one here
   *  would type `/mcp` into a session that has no terminal to show it in. */
  transport: string;
}

export interface McpIpcDeps {
  broker: IpcBroker;
  log: Logger;
  /**
   * Is this a folder we are allowed to answer about?
   *
   * §5.29: the folder arrives from the renderer, and it decides which
   * `.mcp.json` gets read and written and which directory a child process is
   * spawned in. Neither may be an arbitrary caller-supplied path. The gate is
   * the same one the rest of the app uses — the folders of the sessions that
   * actually exist — so this cannot become a way to probe the disk, to run the
   * CLI somewhere it was never invited, or to write a server definition into a
   * repo the user has not opened.
   */
  isSessionFolder: (folder: string) => boolean;
  /**
   * The live session behind an id, or null. Absent in a read-only wiring (and
   * in #632's tests), which is why `mcp:reconnect` treats it as "no session"
   * rather than assuming it is there.
   */
  liveSession?: (liveId: string) => McpLiveSession | null;
  /** Write raw bytes to a live PTY. Absent when there is no PTY host. */
  typeIntoPty?: (liveId: string, data: string) => void;
  /**
   * Ask a live session for its real MCP inventory (#729).
   *
   * `SessionManager.mcpStatus`, narrowed to a function so this module stays
   * testable without a process tree — the same trade `ControlPort` makes. Its
   * absence is a read-only wiring, and `mcp:status` answers `unavailable`
   * rather than assuming a channel exists.
   */
  mcpStatus?: (liveId: string) => Promise<ControlVerdict>;
}

/**
 * The empty answer, shaped.
 *
 * A refusal still has to be an inventory, because the pane renders whatever it
 * is handed — and "no servers, nothing unreadable" is the honest thing to draw
 * for a folder we decline to look at. The REASON goes to the log, at the same
 * level `groups:*` and `sessions:*` use, so one filter finds every refused call
 * in the app.
 */
const empty = (folder: string): McpInventoryWire => ({ folder, servers: [], unreadable: [] });

/**
 * `/mcp`, and then Enter — as two writes, 75ms apart.
 *
 * NOT ONE CHUNK, and this is a finding rather than a style choice: text and a
 * carriage return written together register as a PASTE in the CLI's TUI and
 * never submit (S-03, refound live 2026-07-22). `lib/composer.ts` carries the
 * same constants for the same reason; they are duplicated here rather than
 * imported because that module is renderer-side and this is main, and a shared
 * module for two numbers would be a worse trade than the comment on both.
 */
const RECONNECT_TEXT = '/mcp';
const CR = String.fromCharCode(13);
const SUBMIT_DELAY_MS = 75;

/**
 * Every value in a request that must never come back on screen.
 *
 * DEFENSIVE ABOUT THE SHAPE, and that is not paranoia — it is a bug this
 * function exists because of. `validateAdd` checks `env` only on the stdio
 * branch and `headers` only on the remote one, so THE OTHER FIELD IS NEVER
 * VALIDATED and arrives here as any structured-clonable value the renderer
 * liked. The first version of this spread both directly, so
 * `{ transport: 'stdio', headers: 5 }` threw `TypeError: not iterable` — which
 * `broker.handle` deliberately does not catch, so the channel REJECTED, which
 * is the one thing this family promises never happens. Caught in review, one
 * field over from the `Array.isArray` guards added for exactly this.
 *
 * THE URL'S USERINFO COUNTS TOO. `https://user:token@host/mcp` is a documented
 * remote-MCP form and `validateAdd` accepts it, so a rejection quoting the URL
 * back would put the token on screen. Only the credential parts are collected,
 * not the whole address — the address is what makes the CLI's message useful.
 */
function secretsIn(request: McpAddRequest): string[] {
  const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
  const pairs = [...list(request.env), ...list(request.headers)];
  const out = pairs
    .map((p) => (p as { value?: unknown } | null)?.value)
    .filter((v): v is string => typeof v === 'string');
  if (typeof request.target === 'string') {
    try {
      const url = new URL(request.target);
      for (const part of [url.password, url.username]) if (part) out.push(part);
    } catch {
      /* not a URL — the stdio case, where the target is a command */
    }
  }
  return out;
}

export function registerMcpIpc(deps: McpIpcDeps): void {
  const { broker, log } = deps;

  /** One gate, every channel — so they cannot drift into disagreeing about
   *  which folders are answerable. */
  const allowed = (channel: string, folder: unknown): folder is string => {
    if (typeof folder !== 'string' || !folder) {
      log.warn(`${channel} refused: folder must be a non-empty string`);
      return false;
    }
    if (!deps.isSessionFolder(folder)) {
      log.warn(`${channel} refused: not a session folder`, { folder });
      return false;
    }
    return true;
  };

  // The listing. Synchronous work behind an async channel: two `readFileSync`
  // calls on small local JSON files, which is the same trade `sessions:cards`
  // already makes. If either ever becomes slow enough to matter, the fix is a
  // watch-and-cache, not a thread.
  broker.handle('mcp:list', (_e, folder: unknown): McpInventoryWire => {
    if (!allowed('mcp:list', folder)) return empty(typeof folder === 'string' ? folder : '');
    return readInventory(folder, log);
  });

  // The health check. It SPAWNS THE CLI, which is why it is its own channel and
  // why the pane calls it after painting: a remote server behind a VPN that is
  // off does not fail fast. `checkHealth` owns the timeout and never rejects,
  // so there is nothing here to catch — but the folder gate still runs first,
  // because this is one of the paths that starts a process in a caller-named
  // directory.
  broker.handle('mcp:health', async (_e, folder: unknown): Promise<McpHealthWire> => {
    if (!allowed('mcp:health', folder)) {
      // `ok: false` for a refusal too, and deliberately: from the pane's side
      // "we declined to look" and "the check did not run" are the same fact,
      // and the difference is already in the log where it belongs.
      return { folder: typeof folder === 'string' ? folder : '', states: {}, ok: false };
    }
    const result = await checkHealth(folder);
    return { folder, states: result.states, ok: result.ok };
  });

  /**
   * The REAL inventory, over the session's control channel (#729).
   *
   * TWO GATES, NOT ONE, and the second is the one that matters. The folder gate
   * is the house rule; the session-belongs-to-the-folder check is what stops a
   * caller pairing a folder it is allowed to name with the id of any live
   * session in the app and reading ITS servers back. `mcp:reconnect` carries the
   * same check for the same reason, and this channel returns data rather than
   * typing a keystroke, so skipping it here would be the more useful hole.
   *
   * EVERY FAILURE IS A NAMED REASON, never an empty list on its own. An empty
   * `servers` means four different things — the session has none, it is a PTY
   * with no control channel, there is no live session, or the CLI did not answer
   * — and #723 exists because "no servers configured" was rendered for a case
   * that actually meant "we cannot see them".
   */
  broker.handle(
    'mcp:status',
    async (_e, folder: unknown, liveId: unknown): Promise<McpStatusWire> => {
      const id = typeof liveId === 'string' ? liveId : '';
      // A REFUSAL IS `unavailable`, NOT `no-session`, and the difference is a
      // sentence the user reads. `no-session` renders as "start this session to
      // see everything it really has" — advice about a session that is running
      // perfectly well, which is exactly the conflation the `reason` field
      // exists to prevent. `mcp:health` makes the same call by collapsing every
      // refusal into `ok: false`.
      const empty = (reason: McpStatusWire['reason']): McpStatusWire => ({
        sessionId: id,
        servers: [],
        notLoaded: [],
        reason,
      });
      if (!allowed('mcp:status', folder)) return empty('unavailable');
      if (!id) return empty('no-session');
      const session = deps.liveSession?.(id) ?? null;
      if (!session) return empty('no-session');
      if (!samePath(path.resolve(session.folder), path.resolve(folder))) {
        log.warn('mcp:status refused: session does not belong to that folder', { folder });
        return empty('unavailable');
      }
      if (!deps.mcpStatus) return empty('unavailable');
      const verdict = await deps.mcpStatus(id);
      if (!verdict.ok) {
        // `not-stream` IS ITS OWN ANSWER and not an error. It means the session
        // is on the PTY transport, which has no control channel at all — a
        // permanent property of that session, not a failure of this call, and
        // the pane says something different for it (fall back to the files)
        // than for a CLI that went quiet.
        if (verdict.reason === 'not-stream') return empty('not-stream');
        log.warn('mcp:status did not answer', { liveId: id, reason: verdict.reason });
        return empty(verdict.reason === 'session-gone' ? 'no-session' : 'unavailable');
      }
      // THE CONFIG READ HAPPENS HERE, NOT IN THE RENDERER, and that is what
      // makes the join testable. Four facts only the files know — is this row
      // removable, with which scope, what env/header keys it carries and its
      // approval state — are folded in before the wire, so the pane draws a row
      // rather than computing one. Two local file reads on a call that has
      // already paid for a process round trip.
      const configured = readInventory(folder, log).servers;
      const servers = enrichRuntime(readMcpStatus(verdict.response), configured);
      return {
        sessionId: id,
        servers,
        // ...and the servers the session has NOT loaded, which is what makes
        // the Add button mean anything: `mcp_status` is frozen at spawn, so a
        // server added a moment ago appears here and nowhere else until the
        // session reconnects. See `notLoaded`.
        notLoaded: notLoaded(servers, configured),
        reason: 'ok',
      };
    }
  );

  // ── The write half (#714) ──────────────────────────────────────────────────
  //
  // All three follow the same three steps in the same order: gate the folder,
  // validate the request, then hand a built argv to `runMcp`. Validation is
  // main's job and not the form's — the renderer's checks are a courtesy that
  // makes the error appear before the round trip, and a caller that skips them
  // must not get further than a caller that does not.

  broker.handle('mcp:add', async (_e, folder: unknown, req: unknown): Promise<McpMutationResult> => {
    if (!allowed('mcp:add', folder)) return { ok: false, reason: 'refused' };
    if (typeof req !== 'object' || req === null) {
      log.warn('mcp:add refused: request must be an object');
      return { ok: false, reason: 'refused' };
    }
    const request = req as McpAddRequest;
    const error = validateAdd(request);
    if (error) {
      // At `warn` with the FIELD and never the value: an env value is a live
      // credential, and the app log is a file the user shares when reporting a
      // bug. `at` is a key name, which is the same thing `envKeys` already
      // exposes on the read side.
      log.warn('mcp:add refused: invalid request', { field: error.field, code: error.code });
      return { ok: false, reason: 'invalid', error };
    }
    // THE SECRETS GO IN WITH THE CALL, not out of the answer afterwards. This
    // is the one channel whose request carries credentials, and `runMcp`
    // redacts them out of the CLI's words BEFORE it applies the length bound —
    // the other order let a secret straddling the 600th character survive as a
    // prefix (`cli.ts`'s `detailFrom`).
    const result = await runMcp(folder, buildAddArgs(request), { secrets: secretsIn(request) });
    if (result.ok) log.info('mcp server added', { name: request.name, scope: request.scope });
    else log.warn('mcp:add failed', { name: request.name, reason: result.reason });
    return result;
  });

  broker.handle(
    'mcp:remove',
    async (_e, folder: unknown, name: unknown, scope: unknown): Promise<McpMutationResult> => {
      if (!allowed('mcp:remove', folder)) return { ok: false, reason: 'refused' };
      // The LAX name check, on purpose: this name came off a row the pane read
      // out of a config file, not out of a form, and a manager that refuses to
      // delete what it just listed is one that can get you into a state it
      // cannot get you out of. See `validateRemoveName`.
      const nameError = validateRemoveName(name);
      if (nameError) {
        log.warn('mcp:remove refused: invalid name', { code: nameError.code });
        return { ok: false, reason: 'invalid', error: nameError };
      }
      const scopeError = validateScope(scope);
      if (scopeError) {
        log.warn('mcp:remove refused: invalid scope');
        return { ok: false, reason: 'invalid', error: scopeError };
      }
      const result = await runMcp(folder, buildRemoveArgs(name as string, scope as McpScope));
      if (result.ok) log.info('mcp server removed', { name, scope });
      else log.warn('mcp:remove failed', { name, scope, reason: result.reason });
      return result;
    }
  );

  // PROJECT-WIDE AND BLUNT, and the naming here is the honest part. There is no
  // approve verb and no per-server toggle — the full subcommand set is `add`,
  // `add-from-claude-desktop`, `add-json`, `get`, `list`, `login`, `logout`,
  // `remove`, `reset-project-choices`, `serve` (probed 2026-08-25, re-probed
  // 2026-08-26). This resets every approved AND rejected `.mcp.json` server for
  // the folder at once, so the next session asks about all of them again. The
  // alternative was writing `enabledMcpjsonServers` ourselves — config the CLI
  // owns, on a shape it can change under us — which was declined on P7.
  broker.handle('mcp:resetApprovals', async (_e, folder: unknown): Promise<McpMutationResult> => {
    if (!allowed('mcp:resetApprovals', folder)) return { ok: false, reason: 'refused' };
    const result = await runMcp(folder, RESET_APPROVALS_ARGS);
    if (result.ok) log.info('mcp project approvals reset', { folder });
    else log.warn('mcp:resetApprovals failed', { folder, reason: result.reason });
    return result;
  });

  /**
   * Reconnect — and the transport decision is MAIN'S, on purpose.
   *
   * §5.17 says reconnect "injects `/mcp` into that session's input route — we
   * type, not fake". That sentence is true on ONE transport and this is the
   * function that has to know which:
   *
   *   pty     the CLI's picker opens in a terminal the user is looking at.
   *           Type it. This is what the design meant.
   *   stream  there is no terminal. Typing `/mcp` sends the command, the CLI
   *           opens a picker nobody can see, and the session sits there — the
   *           exact dead end #632's `/mcp` intercept was built to remove.
   *           SEND NOTHING and say so.
   *
   * The renderer must not make this call. `lib/composer.ts`'s
   * `sendSessionCommand` is documented as being blind to transports — which is
   * correct for `/compact`, whose two routes deliver the same thing, and wrong
   * here, where one route delivers nothing at all. Routing reconnect through it
   * would reinstate the bug behind a different button.
   */
  broker.handle(
    'mcp:reconnect',
    (_e, folder: unknown, liveId: unknown): McpReconnectResult => {
      if (!allowed('mcp:reconnect', folder)) return { outcome: 'refused' };
      if (typeof liveId !== 'string' || !liveId) {
        log.warn('mcp:reconnect refused: liveId must be a non-empty string');
        return { outcome: 'refused' };
      }
      const session = deps.liveSession?.(liveId) ?? null;
      if (!session) return { outcome: 'no-session' };
      // THE SESSION'S FOLDER MUST BE THE FOLDER WE GATED. Without this, the
      // gate checks one thing and the action affects another: a caller could
      // pair a folder it is allowed to name with the id of any live session in
      // the app, and type into it. The gate has to cover what actually happens.
      //
      // COMPARED BY RESOLUTION, not by spelling — the same rule the gate itself
      // uses (`main/index.ts`'s `isSessionFolder`), and for the same recorded
      // reason: "a path has many true spellings and exactly one resolution",
      // learned when CI's Windows runners handed out 8.3 short names
      // (`C:\Users\RUNNER~1\…`). A spelling comparison here fails CLOSED, so it
      // was not a hole — but it would refuse a session that `mcp:list` answers
      // for happily, on the same machine, which is a bug report nobody could
      // reproduce.
      if (!samePath(path.resolve(session.folder), path.resolve(folder))) {
        log.warn('mcp:reconnect refused: session does not belong to that folder', { folder });
        return { outcome: 'refused' };
      }
      if (session.transport !== 'pty' || !deps.typeIntoPty) {
        return { outcome: 'restart-required' };
      }
      deps.typeIntoPty(liveId, RECONNECT_TEXT);
      // the Enter, separately and later — see RECONNECT_TEXT
      setTimeout(() => deps.typeIntoPty?.(liveId, CR), SUBMIT_DELAY_MS);
      log.info('mcp reconnect typed into session', { liveId });
      return { outcome: 'typed' };
    }
  );
}
