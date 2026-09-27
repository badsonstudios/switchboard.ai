// HookListener (P1-E2-05, §5.29 floor): loopback-only HTTP server receiving
// Claude Code hook events and feeding the SessionManager state machine.
// Spike verdicts implemented:
//   §5.29: loopback bind + Host allowlist + per-session token, both always.
//   S-03:  token NOT on argv — it lives in an ACL'd file referenced by path;
//          fail-open forwarder (dead listener costs nothing).
//   S-06:  status hooks ack instantly and carry "timeout": 10 so a wedged
//          listener costs at most 10s once; Stop is the done authority.
import http from 'http';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

function findNodeOnPath(): string | null {
  const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}
import { Logger } from '../log/logger';
import { SessionManager } from '../sessions/session-manager';
// The sweep's name filter and its budget, shared with the directory sweep one
// level up rather than re-spelled here (#470): two sweeps over the SAME tree
// that disagree about which names are ours is the drift worth designing out.
import { isSessionStateDirName, DEFAULT_SWEEP_BUDGET_MS } from '../sessions/session-state';
import { SessionEvent, isPermissionNotification } from '../sessions/state-machine';
// NO `tool-taxonomy` IMPORT SINCE #952: SHELLISH / MUTATING / READ_TOOLS /
// INTERACTIVE_TOOLS and `toolCategory` were the hold policy's vocabulary. The
// module is very much alive — the renderer's block presentation shares it, which
// was the point of putting it in `shared/` — this file simply no longer classifies
// tools, because it no longer decides anything about them.

/** Hook events the listener subscribes to for status (S-06 set + PostToolUse). */
const STATUS_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'Notification',
  'SubagentStop',
  'Stop',
] as const;

export interface HookListenerOptions {
  stateDir: string;
  manager: Pick<SessionManager, 'apply' | 'setNativeSessionId'>;
  log: Logger;
  // NO HOLD OPTIONS SINCE #952. `autonomyFor`, `cwdFor`, `holdTimeoutMs`,
  // `hasLiveWindow` and `transportFor` all existed for the PreToolUse hold path
  // and went with it. `transportFor` is the one worth a sentence: it was added in
  // P2-E18-07 so a STREAM session's PreToolUse was never held — its permissions
  // ride `can_use_tool` — and once the PTY transport was deleted every session
  // was a stream session, which made the guard a tautology and the whole hold
  // path unreachable. That is why the path is gone rather than merely disabled.
  /** How long `sweepOrphanTokens` may spend, in ms. Absent = the shared
   *  default (`DEFAULT_SWEEP_BUDGET_MS`). A test seam, and the only reason it
   *  is an option at all: the sweep is private and runs inside `start()`. */
  sweepBudgetMs?: number;
  /** The sweep's clock, injected so a test can exercise a PARTIALLY spent
   *  budget — some tokens taken, then the stop — which a real clock cannot
   *  produce reliably and `sweepBudgetMs: 0` cannot reach at all. Mirrors
   *  `sweepOrphanSessionStateDirs`'s `now`. Absent = `Date.now`. */
  sweepNow?: () => number;
}

// `PermissionRequest` is NO LONGER RE-EXPORTED from here (#952). It lives in
// `shared/ipc/permissions` with its documentation, and it moved there in #312
// because it is a BOUNDARY type — main, preload and the renderer describe the
// same object over IPC — after the three hand-kept copies drifted. This file
// re-exported it only because every caller of the HOOK hold path imported it
// from here; with that path gone, `StreamPermissions` is the producer and the
// shared module is the one place to import from.

// ── THE HOLD POLICY IS GONE, AND SO IS §5.16's PLAN-MODE RULE (#952) ─────────
//
// This file used to carry `GATED`, `READ_GATED_AUTONOMIES`, `PRETOOL_MATCHER`,
// `shouldHoldPermission` and the `.claude` carve-out — the policy deciding which
// tool calls a person should see at a given autonomy. All of it served the
// PreToolUse HOLD, and the hold is gone with the PTY transport.
//
// WHY A POLICY WAS NEEDED AT ALL, because this is the part that does not carry
// over and is the reason nothing replaces it. `PreToolUse` fires for EVERY tool
// call, and a hook's `permissionDecision:'allow'` BYPASSES the CLI's own
// permission system. So the hook path had to decide for itself what deserved a
// human — a table of tools per autonomy, erring toward more prompts than the CLI
// would give, because erring the other way meant silently approving something
// the CLI wanted a person for.
//
// The control channel inverts that. The CLI asks `can_use_tool` only for what it
// actually wants permission for, and our answer goes THROUGH its permission
// system rather than around it. There is no policy to hold because there is no
// question we were not asked.
//
// ⚠️ AND THAT IS WHAT RETIRES §5.16's PLAN-MODE RULE — *"plan sessions are NEVER
// held in-app"* (owner, 2026-07-23). It lived here as `GATED.plan = []`, and its
// premise was exactly the bypass above: an in-app Allow returned
// `permissionDecision:'allow'`, which skipped plan mode's write-block, so holding
// a plan session would have let a "read-only planning" session write files. The
// hazard was real and it was a fact about HOOK SEMANTICS, not a product rule. On
// the control channel a plan-mode session's requests are held in-app and that is
// safe, because an allow is answered into the CLI's own enforcement.
//
// What survives with teeth is narrower and already built, in
// `sessions/stream-permissions.ts`: a DISPATCHED session asking to leave plan
// mode is refused at once, because nobody is watching it. That is a different
// rule for a different reason, and it is the one to look for if you came here
// following §5.16.
//
// The `.claude/` carve-out is also worth knowing the fate of. It declined
// edit-family writes into a project's own `.claude/` (#127) because the CLI
// applies a safety check ABOVE the permission layer that a hook verdict does not
// satisfy — the user answered our bar and was asked again in the terminal six
// seconds later. The control channel reports that case properly, as
// `decision_reason_type: 'safetyCheck'` with a suggested remedy, which is the
// finding that forced this whole migration (DESIGN §6, 2026-08-01).

export class HookListener {
  private server: http.Server | null = null;
  private port = 0;
  private readonly tokens = new Map<string, string>(); // token -> sessionId
  private forwarderPath: string | null = null;
  // NO HOLD STATE SINCE #952. `pending`, `permListeners`, `resolvedListeners`,
  // `allowAllSessions`, `noWindowWarned`, `unroutableWarned`, `answerSurface`,
  // `reqCounter`, `windowLive()`, `setAnswerSurfaceProbe()`, `isRegistered()` and
  // `answerable()` all belonged to the PreToolUse hold. `StreamPermissions` holds
  // the surviving versions of the two gates worth naming — "is there a live
  // window" and "does a card own this session" (#699) — and its docblocks are now
  // the only place that reasoning lives.
  //
  // `allowAllSessions` is the one to know about if you are looking for it: the
  // hook listener had its own copy of "Allow all (this session)", answered at the
  // server with no hold and no beep. The surviving grant is
  // `StreamPermissions.allowAllSessions`, and it is the one that still has no
  // revoke surface — #974 owns that. Deleting this copy means there is one
  // standing-grant store to fix rather than two.

  constructor(private readonly opts: HookListenerOptions) {}

  private nodeCommand: string | null = null;

  async start(): Promise<number> {
    this.forwarderPath = writeForwarder(this.opts.stateDir);
    // Last run's token files are dead weight the moment this process starts —
    // take them now (#282). AFTER writeForwarder, which is what guarantees
    // stateDir exists on a first run.
    this.sweepOrphanTokens();
    // The forwarder needs a Node runtime. `node` on PATH is NOT guaranteed
    // (claude.exe native installs bundle their own); fall back to our own
    // Electron binary in run-as-node mode. Hooks run under a POSIX shell on
    // Windows (S-02 finding), so an env-prefix works.
    const nodeOnPath = findNodeOnPath();
    this.nodeCommand = nodeOnPath
      ? `"${nodeOnPath}"`
      : `ELECTRON_RUN_AS_NODE=1 "${process.execPath}"`;
    if (!nodeOnPath) {
      this.opts.log.warn('node not on PATH — hook forwarder will use the app binary in run-as-node mode');
    }
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    this.opts.log.info('hook listener up', { port: this.port });
    return this.port;
  }

  stop(): void {
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    // Clearing the map is enough — every token file is dead the moment this
    // returns, and the next `start()` sweeps them (#282). Deliberately NOT a
    // sweep here: quit is a path we may not finish (`scheduleForcedExit`), so
    // cleanup that only runs on a graceful shutdown is cleanup that does not
    // run.
    this.tokens.clear();
  }

  /**
   * NO PERMISSION API SINCE #952.
   *
   * `onPermissionRequest`, `pendingRequests`, `onPermissionResolved`,
   * `releaseHeld`, `setAllowAll`, `decide` and the private `verdict` / `release`
   * pair all went with the hold. Every one of them has a counterpart on
   * `StreamPermissions`, and the call sites that used to merge the two channels
   * (`sessions/ipc.ts`'s `pendingRequests` concatenation, `main/index.ts`'s
   * two-entry release list) now have one side.
   *
   * ⚠️ `verdict(decision, reason?)` IS THE ONE TO KNOW ABOUT IF YOU ARE HERE FOR
   * DENY-WITH-FEEDBACK (#973). It composed the `permissionDecisionReason` the CLI
   * feeds straight to the MODEL, and it carried a hard-won lesson: a denial that
   * said "Denied from switchboard" read as an infrastructure fault, so Claude
   * announced that something was blocking it and routed around the denial with a
   * different tool, then a third, until it got the listing anyway (Dan,
   * 2026-07-26). The wording that fixed it — the USER decided, this is not a
   * technical fault, do not retry and do not find another route — now lives ONLY
   * on the stream path, and it is the text #973 should reuse rather than reinvent.
   */

  /**
   * Issue a per-session token, stored in a file referenced by path — never on
   * argv (S-03). mode 0600 is a no-op on Windows; the real protection there
   * is stateDir living under the user profile (same-user ACL).
   */
  registerSession(sessionId: string): { tokenPath: string } {
    const token = randomBytes(16).toString('hex');
    this.tokens.set(token, sessionId);
    const dir = path.join(this.opts.stateDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const tokenPath = path.join(dir, 'hook-token');
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    return { tokenPath };
  }

  unregisterSession(sessionId: string): void {
    for (const [tok, sid] of this.tokens) {
      if (sid === sessionId) this.tokens.delete(tok);
    }
    // The file follows the map entry (#282). It is dead the moment the token
    // leaves `this.tokens` — nothing can authenticate with it again — and this
    // is its LAST mention: a self-exited card the user never touches again gets
    // no teardown after this, so anything not cleaned here lingers for the
    // app's lifetime, one file per session ever started.
    //
    // Only OUR file. The directory around it and the `settings.json` in it
    // (`providers/claude.ts`) are somebody else's job as of #290 —
    // `SessionManager` deletes the whole directory when the live session ends,
    // which is a strictly later moment than this on every path. This delete is
    // still the one that matters for the token: it happens the instant the
    // token dies in memory, and it does not depend on the manager knowing this
    // session exists (`hooks/hook-check.ts` drives this class on its own).
    this.removeTokenFile(sessionId);
  }

  /**
   * Best-effort removal of one session's token file — fail-open (P6): our disk
   * hygiene never throws into a teardown step and never blocks a session.
   * Returns whether a file was actually there to remove.
   */
  private removeTokenFile(sessionId: string): boolean {
    try {
      fs.unlinkSync(path.join(this.opts.stateDir, sessionId, 'hook-token'));
      return true;
    } catch (err) {
      // ENOENT is the ORDINARY case, not a fault, and must stay quiet: a
      // session torn down before `buildHookSettings` ever ran — or one on a
      // provider without the hooks capability — has no file, and warning on
      // every such close would be pure noise. (It gets commoner still once
      // PR #281 lands: that makes the teardown path unregister twice on every
      // close of a running session, and the second pass finds nothing.)
      // Anything else — a file locked by a scanner, a permission change — is
      // worth one line and nothing more.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.opts.log.warn('could not remove hook token file', {
          sessionId,
          error: String(err),
        });
      }
      return false;
    }
  }

  /**
   * Drop every `hook-token` left behind by a previous run (#282).
   *
   * Safe WITHIN THIS PROCESS, and only because it runs at start: tokens live
   * in `this.tokens`, which is memory. We cannot authenticate a file we did not
   * write, so every token on disk at this moment is dead weight to us. Nothing
   * in-process can race it either — this is synchronous and runs before the
   * first `await` in `start()`, and in `src/main` a session only ever registers
   * via `buildHookSettings`, which throws until `start()` has set the port.
   *
   * What made it safe ACROSS processes is somewhere else, and on purpose:
   * `src/main/index.ts` takes `app.requestSingleInstanceLock()` as the first
   * statement of the bootstrap, so a second instance quits before it reaches
   * this class (#289). Without that, the sweep is a live grenade — `stateDir`
   * is a fixed path under `userData`, so a second instance starting would
   * delete the FIRST's live token files (the forwarder re-reads the file on
   * every hook) and the first instance's sessions would go quietly hook-blind:
   * every hook 401s, status, native-id binding and holds all stop, and the only
   * symptom is a log full of `hook request rejected`. No guard here can replace
   * the lock — an mtime cutoff in particular does not, because a concurrent
   * instance's live tokens are precisely the ones written before we booted.
   * If the lock is ever removed, this sweep has to go with it.
   *
   * Scoped to the one filename we own. The same per-session directory also
   * holds `settings.json` (`providers/claude.ts`) and stateDir's root holds the
   * generated forwarder; neither is touched, and directories are left alone.
   *
   * Still worth running after #290 gave the DIRECTORIES an owner
   * (`sessions/session-state.ts`, swept from the bootstrap a beat before this).
   * That sweep has a 24 h age floor, so a directory a crash left behind an hour
   * ago is deliberately kept — and this is what makes sure the dead token
   * inside it is not. The two are ordered, not redundant: by the time this
   * runs, everything old enough is already gone, so the walk is over a set that
   * no longer grows for the life of the install.
   *
   * A candidate must clear four checks, the same conventions and the same order
   * as the directory sweep (#470 — that sweep grew them in #290 and this one
   * was left behind, which is #354's lesson exactly: a sweep with no shape
   * filter is one mount-point surprise away from deleting the wrong thing):
   *   1. it is a directory, off the dirent, so a symlink or junction pointing
   *      somewhere interesting answers `false` rather than being followed;
   *   2. its name is a session id (`isSessionStateDirName` — the shared
   *      helper), which is what keeps `hook-forwarder.cjs` and anything a human
   *      or another tool put in this root out of it. Note the filter is on the
   *      SWEEP only, not on `removeTokenFile`: the sweep's names come off the
   *      filesystem, a targeted removal's name comes out of our own map, and
   *      filtering the latter would strand for ever any token registered under
   *      an id `randomUUID` did not mint;
   *   3. no live token of ours belongs to it — empty at the one call site,
   *      which is the point of stating it here rather than leaving it a
   *      property of the call site (#290's argument, unchanged): the guard has
   *      to travel with the sweep for a future caller that sweeps later;
   *   4. there is budget left.
   *
   * NO AGE FLOOR, deliberately, and this is the one convention that does NOT
   * cross over. An mtime cutoff would delete exactly the wrong half: the whole
   * reason this runs after the directory sweep is to take the tokens inside the
   * young directories that sweep's 24 h floor deliberately keeps. It is no
   * safety mechanism here either — see the paragraph above, where a concurrent
   * instance's LIVE tokens are precisely the ones written before we booted.
   */
  private sweepOrphanTokens(): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.opts.stateDir, { withFileTypes: true });
    } catch (err) {
      // Defence, not an expected path: `writeForwarder` just created this
      // directory, so only something outside us (permissions, EMFILE) gets
      // here. Fail-open regardless — the listener coming up outranks tidiness.
      this.opts.log.warn('could not scan state dir for orphaned hook tokens', {
        error: String(err),
      });
      return;
    }
    const keep = new Set(this.tokens.values());
    const budgetMs = this.opts.sweepBudgetMs ?? DEFAULT_SWEEP_BUDGET_MS;
    const now = this.opts.sweepNow ?? Date.now;
    const startedAt = now();
    let swept = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!isSessionStateDirName(e.name)) continue;
      if (keep.has(e.name)) continue;
      if (now() - startedAt >= budgetMs) {
        // `break`, not `continue`: unlike the directory sweep there is no
        // second reason to keep an entry, so there is nothing left to count and
        // no cheaper check further down the loop. One line, and the rest is
        // still there for the next start — a token file we do not reach is
        // dead weight, never a live credential.
        this.opts.log.info('hook token sweep hit its budget — the rest waits for the next start', {
          budgetMs,
        });
        break;
      }
      if (this.removeTokenFile(e.name)) swept++;
    }
    if (swept > 0) this.opts.log.info('swept orphaned hook tokens', { count: swept });
  }

  /**
   * The undo of `buildHookSettings`, and the name the `HookSettingsHost` slice
   * knows it by (#470).
   *
   * Same release as `unregisterSession` — a token dies the same death whether
   * its session ran for an hour or never spawned at all. It has its own name
   * because the caller that needs THIS half is `SessionManager.create`'s
   * start-failure path, which has no session to "unregister": nothing was ever
   * registered with it, and a host that is not a full listener should be able
   * to implement the build/release pair without implementing a session
   * lifecycle it has no part in.
   */
  releaseHookSettings(sessionId: string): void {
    this.unregisterSession(sessionId);
  }

  /**
   * Hook config to inject via --settings for one session (S-02 mechanism).
   * POSIX-sh-free: command is `node <forwarder> <port> <tokenPath>` — node is
   * guaranteed present (the CLI itself runs on it), paths are absolute.
   */
  buildHookSettings(sessionId: string): Record<string, unknown> {
    if (!this.forwarderPath || this.port === 0 || !this.nodeCommand) {
      throw new Error('hook listener not started');
    }
    const { tokenPath } = this.registerSession(sessionId);
    const command = `${this.nodeCommand} "${this.forwarderPath}" ${this.port} "${tokenPath}"`;
    const entry = { hooks: [{ type: 'command', timeout: 10, command }] };
    const hooks: Record<string, unknown> = {};
    for (const ev of STATUS_EVENTS) hooks[ev] = [entry];
    // NO `PreToolUse` ENTRY SINCE #952, and this is the line that makes the
    // deletion real rather than merely unreachable: the CLI is no longer asked to
    // call us before a tool runs, so there is no round trip to ignore. It used to
    // get its own entry with `PRETOOL_MATCHER`, a CLI-side timeout a beat above
    // ours (so OUR fail-open `{}` won), and a fourth argument telling the
    // forwarder to WAIT for a decision and print the hook verdict to stdout.
    //
    // A real saving, not just tidiness: every gated tool call spent an HTTP round
    // trip through this listener before it could proceed, on top of the
    // `can_use_tool` request that was already carrying the decision. Permissions
    // ride the control channel alone now.
    //
    // The forwarder still exists and still takes its first three arguments — the
    // STATUS events above are its whole job, and `Stop` is the done authority
    // (S-06). Retiring the forwarder and this HTTP server altogether is E18-15,
    // which needs `hook_callback` on the control channel first.
    return { hooks };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405);
      return void res.end();
    }
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      this.opts.log.warn('hook request rejected: bad host', { host: req.headers.host });
      res.writeHead(403);
      return void res.end();
    }
    const token = req.headers['x-switchboard-token'];
    const sessionId = typeof token === 'string' ? this.tokens.get(token) : undefined;
    if (!sessionId) {
      this.opts.log.warn('hook request rejected: invalid token');
      res.writeHead(401);
      return void res.end();
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // EVERY request acks instantly (S-06), with no branch. Until #952 this
      // called `maybeHold` first: a gated `PreToolUse` was PARKED until the UI
      // decided, an allow-all session was answered here at the server with no
      // hook event and no beep, and only everything else acked. `PreToolUse` is
      // no longer registered, so there is nothing to park and status is all that
      // arrives.
      res.end('{}');
      this.ingest(sessionId, body);
    });
  }


  private ingest(sessionId: string, body: string): void {
    let e: Record<string, unknown> = {};
    try {
      e = JSON.parse(body) as Record<string, unknown>;
    } catch {
      this.opts.log.warn('hook event unparseable', { sessionId });
      return;
    }
    const event = typeof e.hook_event_name === 'string' ? e.hook_event_name : 'unknown';
    const nativeId = typeof e.session_id === 'string' ? e.session_id : undefined;
    // /clear mints a NEW conversation id (verified vs claude 2.1.218): tag
    // the id change with its cause so the feed can say "cleared", not just
    // silently rebind (E10-07 feedback — Dan: "no response that it cleared")
    //
    // ONLY `SessionStart source:'clear'` is tagged, and the FIRST writer of a
    // new id wins its cause (`SessionManager.setNativeSessionId` returns on an
    // unchanged id before reading it). So an untagged hook carrying the new id,
    // landing first, would log a false mis-bind and leave the give-up clock
    // armed (#793). NOT OBSERVED in 40 trials on CLI 2.1.270
    // (`spike/findings/e11-793-clear-hook-order.md`), and the two modes differ:
    //
    //  - DIRECT (stream-json): ordered by construction. With no deferral passed,
    //    the CLI's clear awaits SessionStart(clear) before it returns (read from
    //    the binary), and the next message is processed only after that; the
    //    stream init also backs the tag up. 15/15 tagged-first, 69–87 ms.
    //  - TERMINAL (PTY): the TUI host is the one caller that passes
    //    `deferSessionStartHooks`, so the hook is QUEUED, and this listener is
    //    the ONLY writer — no stream init to fall back on. Still 25/25
    //    tagged-first at 164–186 ms; a prompt typed straight after `/clear`
    //    registered in 6 of 15 tries (the TUI drops the rest while clearing)
    //    and its `UserPromptSubmit` trailed the tagged hook by 84–91 ms.
    //
    // What would reopen it, Terminal mode first: a release that releases the
    // deferred hooks later; the tagged hook LOST rather than late (forwarder
    // timeout, a token-file read failure); or a background task that survives
    // `/clear` and reports under the new id before the hook lands (unmeasured).
    // Symptom: `transcript mis-bind corrected (same-cwd race)` at warn right
    // after a `/clear` with no second session in that folder — re-run
    // `spike/probes/793/`. Retires with E18-15, which deletes this writer.
    if (nativeId) {
      this.opts.manager.setNativeSessionId(
        sessionId,
        nativeId,
        event === 'SessionStart' && e.source === 'clear' ? 'clear' : undefined
      );
    }
    this.opts.log.debug('hook event', { sessionId, event });
    const ev: SessionEvent = {
      kind: 'hook',
      event,
      notificationType: typeof e.notification_type === 'string' ? e.notification_type : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
      tool: typeof e.tool_name === 'string' ? e.tool_name : undefined,
      // SessionStart carries source ('compact' fires mid-turn, review P1 #11)
      source: typeof e.source === 'string' ? e.source : undefined,
    };
    // A permission `Notification` NEVER drives status — it belongs to the control
    // channel (#313), and since #952 that is true of every session rather than
    // only the stream ones, so the transport test is gone and the guard is
    // unconditional.
    //
    // WHY IT IS STILL HERE AT ALL, given PreToolUse is no longer registered. This
    // is a different path from the hold: `state-machine`'s Notification arm
    // transitions to `needs-permission` on a regex over the CLI's DEBOUNCED nudge,
    // with no evidence that anything is held. Every real permission arrives as
    // `can_use_tool` and is mapped exactly (`stream-status.ts`), so a
    // Notification-driven `needs-permission` is at best a duplicate of a status we
    // already set — and at worst a FALSE ALARM, the debounced nudge landing after
    // the request was answered and dragging a working card back to "needs
    // permission" with nothing held and no bar to answer. The CLI still SENDS the
    // nudge; nothing about deleting a transport stops it.
    //
    // Suppressed at the PRODUCER rather than in `transition()`, deliberately: the
    // state machine is a pure function, and a permission-classified blob can only
    // reach the two `/permission/i` arms — the `needs-input` one deliberately
    // stays. Dropping the event is exactly equivalent to not transitioning on it:
    // `SessionManager.apply` does nothing with a hook event but run it through
    // `transition`, and nothing else in the payload is consumed on this path
    // (`session_id` was applied above, before this guard).
    //
    // MEASURED 2026-08-10 (#404 probe, claude 2.1.226): hooks DO fire under
    // `--permission-prompt-tool stdio`. Neither probe run produced a Notification
    // specifically (no permission prompt was drawn), but the channel is confirmed
    // live, so this guard is load-bearing rather than precautionary.
    if (isPermissionNotification(ev)) {
      this.opts.log.debug('Notification not applied: permissions ride can_use_tool', {
        sessionId,
        notificationType: ev.notificationType,
      });
      return;
    }
    this.opts.manager.apply(sessionId, ev);
  }
}

/**
 * The forwarder the hook command runs: read stdin, POST to the listener with
 * the token read from tokenPath, exit 0 no matter what (fail-open — our
 * breakage never blocks a session). Generated into stateDir so the path is
 * real at runtime regardless of packaging (asar).
 */
function writeForwarder(stateDir: string): string {
  const file = path.join(stateDir, 'hook-forwarder.cjs');
  const src = `// generated by switchboard (P1-E2-05) — do not edit
const fs = require('fs');
const http = require('http');
const [, , port, tokenPath] = process.argv;
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
let token = '';
try { token = fs.readFileSync(tokenPath, 'utf8').trim(); } catch {}
const waitMs = Number(process.argv[4]) || 3000; // held PreToolUse waits longer
const req = http.request(
  { host: '127.0.0.1', port: Number(port), path: '/hook', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
    timeout: waitMs },
  (res) => {
    // the response body IS the hook verdict (held PreToolUse) — relay it to
    // stdout so the CLI applies the permissionDecision; '{}' is a no-op
    let out = '';
    res.on('data', (d) => (out += d));
    res.on('end', () => { if (out) process.stdout.write(out); process.exit(0); });
  }
);
req.on('timeout', () => { req.destroy(); process.exit(0); });
req.on('error', () => process.exit(0));
req.end(stdin);
`;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, src);
  return file;
}
