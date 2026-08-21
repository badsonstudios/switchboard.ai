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
import type { PermissionRequest } from '../../shared/ipc/permissions';

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
import {
  SHELLISH,
  MUTATING,
  READ_TOOLS,
  INTERACTIVE_TOOLS,
  toolCategory,
} from '../../shared/tool-taxonomy';

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
  /** session autonomy lookup for the hold policy (E10-03); absent = no holds */
  autonomyFor?: (sessionId: string) => string | undefined;
  /** session folder lookup — out-of-cwd reads are gated (E10 fix) */
  cwdFor?: (sessionId: string) => string | undefined;
  /** how long a held PreToolUse waits for a UI decision before failing OPEN
   *  to the CLI's own TUI prompt. Default 300s — human-scale (Dan hit the
   *  old 60s mid-testing); the CLI's own hook budget is ~600s (S-03). */
  holdTimeoutMs?: number;
  /** Is there a renderer that could actually answer a hold? (P2-E15-09.)
   *  Absent = assume yes, so a listener driven without a UI (hook-check,
   *  unit tests) keeps its old behaviour. */
  hasLiveWindow?: () => boolean;
  /** Which transport hosts this session (P2-E18-07). A 'stream' session's
   *  permissions ride `can_use_tool`, so PreToolUse is never held for it.
   *  Absent = PTY, which is every pre-E18 caller. */
  transportFor?: (sessionId: string) => 'pty' | 'stream' | undefined;
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

// The in-flight permission request (E10-03) now lives in
// `shared/ipc/permissions`, with its documentation, and is re-exported here
// because that is where every existing caller already imports it from. It moved
// because it is a BOUNDARY type — preload and the renderer describe the same
// object over IPC — and the three hand-kept copies had already drifted: main
// learned `reasonType`, `displayName` and `suggestions` from the stream
// transport and neither of the other two ever heard about it (#312).
export type { PermissionRequest } from '../../shared/ipc/permissions';

/**
 * Hold policy (P2-E10-03, §5.16): hold the calls a person should see at this
 * autonomy, and nothing more — otherwise we'd nag full-auto sessions the CLI
 * would have let through. Unknown autonomy fails open (no hold).
 *
 * This used to claim it held "ONLY calls the CLI itself would prompt for at
 * this autonomy". That was true when it was written and is not true now
 * (#587): at `auto-edit` the CLI's `acceptEdits` waves through in-folder
 * housekeeping commands — `mkdir`, `touch`, `mv`, `cp`, `rm`, `rmdir`, `sed`,
 * and the PowerShell `Set-Content`/`Add-Content`/`Clear-Content`/`Remove-Item`
 * family — and we hold every one of them, because SHELLISH is in the
 * `auto-edit` row. So the real policy is: **a superset of the CLI's prompts,
 * never a subset.** Erring toward more prompts is the safe direction and is
 * deliberate — `docs/manual/04-approvals-and-autonomy.md` tells the user we are
 * slightly stricter than a bare terminal. Erring the other way would mean
 * silently approving something the CLI wanted a person for, which this table
 * must never do.
 */
// Tool-name taxonomy (SHELLISH/MUTATING/READ_TOOLS) is imported from
// src/shared/tool-taxonomy.ts — shared with the renderer's block presentation
// so shell/edit classification can't drift between the hold policy and the
// Feed (review P1 #9).

const GATED: Record<string, string[]> = {
  ask: [...SHELLISH, ...MUTATING],
  // plan NEVER holds (owner decision 2026-07-23, review P0#1): an in-app
  // "Allow" returns permissionDecision:'allow', which BYPASSES the CLI's
  // permission system — including plan mode's write-block. Plan sessions
  // let the CLI's own plan enforcement run untouched.
  plan: [],
  'auto-edit': [...SHELLISH, 'WebFetch'],
  'full-auto': [],
};

/** Autonomies whose out-of-cwd reads we hold (plan/full-auto excluded — see GATED). */
const READ_GATED_AUTONOMIES = ['ask', 'auto-edit'];

/** PreToolUse matcher — REQUIRED for tool hooks (S-03's proven shape used
 *  one; without it the entry never fires and the CLI's own TUI prompt runs
 *  instead — Dan's 2026-07-21 find). Union of everything the policy might
 *  hold, PLUS the interactive tools — those are never held, but the hook is
 *  the only immediate signal that the CLI has stopped and is waiting for a
 *  human (#92); without the entry we never hear about them at all. */
const PRETOOL_MATCHER = [...SHELLISH, ...MUTATING, ...READ_TOOLS, ...INTERACTIVE_TOOLS].join('|');

/** The primary filesystem target of a tool call, if any. Serves both the
 *  out-of-cwd read branch and the `.claude` carve-out below. */
function toolPath(input: Record<string, unknown> | undefined): string | undefined {
  const p = input?.file_path ?? input?.path ?? input?.notebook_path;
  return typeof p === 'string' ? p : undefined;
}

/** Does `base` contain `target`? Judged via path.relative — string-prefixing
 *  broke on drive-root folders, where resolve() keeps the trailing separator
 *  and `base + sep` matches nothing (review P1 #10, reproduced).
 *
 *  LEXICAL, deliberately: no `realpath`. This runs on the hook hot path, and
 *  the target frequently does not exist yet (it is about to be created). The
 *  cost is that a junction or symlink inside the base escapes containment —
 *  see `isInsideClaudeDir`, where that assumption is load-bearing. */
function contains(base: string, target: string): boolean {
  const fold = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const rel = path.relative(fold(base), fold(target));
  return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/** Is `p` outside the session's folder? (The CLI prompts for outside reads.)
 *  Relative tool paths resolve against the SESSION folder, not the app's own
 *  cwd. */
export function isOutsideCwd(p: string, cwd: string): boolean {
  return !contains(path.resolve(cwd), path.resolve(cwd, p));
}

/**
 * Is `p` inside the session folder's own `.claude/` directory?
 *
 * The two resolve bases are asymmetric on purpose — the TARGET resolves
 * against `cwd`, the BASE against `cwd/.claude` — because a relative tool path
 * like `.claude/hooks.json` is relative to the session folder. This looks like
 * it could be written as `!isOutsideCwd(p, join(cwd, '.claude'))`; it cannot,
 * because that resolves the target to `.claude/.claude/hooks.json`.
 *
 * Note "the session folder's own `.claude`" is the GLOBAL config when a session
 * runs in the home directory — global settings, global CLAUDE.md, global hooks
 * that fire in every session. Still correct (the CLI guards it identically,
 * and it is that session's own `.claude`), but it is the highest-consequence
 * instance of the carve-out below, so it is pinned by a test.
 */
export function isInsideClaudeDir(p: string, cwd: string): boolean {
  return contains(path.resolve(cwd, '.claude'), path.resolve(cwd, p));
}

export function shouldHoldPermission(
  autonomy: string | undefined,
  tool: string | undefined,
  input?: Record<string, unknown>,
  cwd?: string
): boolean {
  if (!autonomy || !tool) return false;
  // A decision the CLI KEEPS — never ask a question whose answer we cannot
  // honour (#127, P7 third line). Claude Code guards writes into a project's
  // own `.claude/` above the permission layer: it accepts our
  // `permissionDecision:"allow"` for the ordinary check and then applies its
  // safety check anyway, so the user answered OUR bar and was asked again in
  // the terminal six seconds later (measured 2026-08-01). Holding it presents a
  // decision we do not own and teaches the user our approvals are advisory;
  // passing hands it to the layer that actually owns it, which the #125 handoff
  // bar then explains. Checked FIRST so it beats the GATED table.
  //
  // THE LOAD-BEARING ASSUMPTION is not "the CLI will keep guarding this" — it
  // is that the CLI's guard uses the SAME containment rule we do. Both are
  // lexical; neither resolves links. A junction at `<cwd>/.claude/link`
  // pointing elsewhere skips our bar, and whether the CLI still catches it
  // depends on whether it resolves links. Not worth a sync `realpath` on this
  // path (it throws for a target about to be created), but that is the thing
  // that would actually break.
  //
  // Note this branch is UNREACHABLE in the configuration S-09 documented,
  // where no PreToolUse reached us for the `.claude` write at all — #127's log
  // and S-09 describe two different configurations, and only #127's reaches
  // here. Where it is unreachable, the carve-out cannot be what exposes
  // anything.
  // `toolCategory === 'edit'`, NOT all of MUTATING: MUTATING also holds
  // WebFetch, which is pathless today but one schema change away from growing
  // a `path` field and silently un-holding a network tool. The CLI's guard is
  // scoped to its own edit tools — its prompt says "allow Claude to edit its
  // own settings".
  if (cwd && toolCategory(tool) === 'edit') {
    const target = toolPath(input);
    if (target && isInsideClaudeDir(target, cwd)) return false;
  }
  if ((GATED[autonomy] ?? []).includes(tool)) return true;
  // read tools only prompt when they leave the workspace — mirror that
  if (READ_GATED_AUTONOMIES.includes(autonomy) && READ_TOOLS.includes(tool) && cwd) {
    const target = toolPath(input);
    if (target && isOutsideCwd(target, cwd)) return true;
  }
  return false;
}

export class HookListener {
  private server: http.Server | null = null;
  private port = 0;
  private readonly tokens = new Map<string, string>(); // token -> sessionId
  private forwarderPath: string | null = null;
  // held PreToolUse responses awaiting a UI decision (E10-03). The request
  // rides along so a reloading/racing renderer can REPLAY what's pending
  // (review P0#3 — a missed push must not park the CLI for the full hold).
  private readonly pending = new Map<
    string,
    { res: http.ServerResponse; timer: NodeJS.Timeout; sessionId: string; request: PermissionRequest }
  >();
  private readonly permListeners = new Set<(r: PermissionRequest) => void>();
  private readonly resolvedListeners = new Set<(requestId: string) => void>();
  // LIVE sessions where the user chose "Allow all (this session)". Checked
  // BEFORE parking (review P2 #19 / Dan round 4): an allow-all session must
  // not hold, beep, or round-trip the renderer for every gated call — the
  // verdict is answered right here. Keyed by live id so a respawn prompts
  // again (P0 #2 semantics); cleared on unregister.
  private readonly allowAllSessions = new Set<string>();
  // sessions already warned about having no window to ask (P2-E15-09) — the
  // condition repeats per gated call, the warning shouldn't. Membership means
  // "warned about the outage we are IN", not "warned once, ever": `maybeHold`
  // re-arms it the moment a live window is seen again (#334).
  private readonly noWindowWarned = new Set<string>();
  private reqCounter = 0;

  /** Is there a renderer that could answer a hold? A provider that THROWS
   *  counts as "no" — "I can't tell" must never resolve to "park the CLI".
   *  Absent provider = assume yes (hook-check, unit tests). */
  private windowLive(): boolean {
    try {
      return this.opts.hasLiveWindow?.() !== false;
    } catch (err) {
      this.opts.log.warn('window liveness check threw — treating as no window', {
        error: String(err),
      });
      return false;
    }
  }

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
    for (const id of [...this.pending.keys()]) this.release(id); // fail open
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

  /** Live permission requests (held PreToolUse calls) — E10-03/E10-04. */
  onPermissionRequest(cb: (r: PermissionRequest) => void): () => void {
    this.permListeners.add(cb);
    return () => this.permListeners.delete(cb);
  }

  /** Everything currently held — for renderer (re)subscribe replay (P0#3). */
  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => ({ ...p.request }));
  }

  /** A held request ended (decision OR timeout/teardown) — dismiss UI. */
  onPermissionResolved(cb: (requestId: string) => void): () => void {
    this.resolvedListeners.add(cb);
    return () => this.resolvedListeners.delete(cb);
  }

  private notifyResolved(requestId: string): void {
    for (const l of this.resolvedListeners) {
      try {
        l(requestId);
      } catch {
        /* listener's problem */
      }
    }
  }

  /** Fail every parked request open at once (P2-E15-09). The hasLiveWindow
   *  gate only helps calls that arrive AFTER the window dies; anything already
   *  held when the user closes the window would otherwise sit out the full
   *  300s with nothing able to answer it. */
  releaseHeld(reason: string): void {
    const ids = [...this.pending.keys()];
    if (ids.length === 0) return;
    this.opts.log.warn('releasing held permissions — failing open to the TUI', {
      reason,
      count: ids.length,
    });
    for (const id of ids) this.release(id);
  }

  /** Mark a LIVE session as allow-all: gated calls answer 'allow' at the
   *  server, with no hold, no needs-permission event, and no beep. */
  setAllowAll(sessionId: string): void {
    this.allowAllSessions.add(sessionId);
    this.opts.log.info('allow-all enabled for session', { sessionId });
  }

  /**
   * `permissionDecisionReason` is not a log line — the CLI feeds it straight to
   * the MODEL, and the model acts on how it reads.
   *
   * Dan, 2026-07-26: a denial used to say "Denied from switchboard", which
   * reads exactly like an infrastructure gate. Claude concluded a hook or
   * sandbox was blocking it, announced "PowerShell is getting blocked by
   * something called switchboard", and routed around the denial with a
   * different tool — then a third — until it got the listing anyway. A denial
   * that the agent treats as an obstacle to solve is worse than no denial at
   * all: the user pressed Deny and got the thing they refused.
   *
   * So the reason has to say three things: the USER decided this, it is not a
   * technical fault, and working around it is not on the table.
   */
  private verdict(decision: 'allow' | 'deny', reason?: string): string {
    const denied =
      'The user reviewed this request in switchboard and DENIED it. This is a ' +
      'deliberate decision by the human operator — not a sandbox restriction, a ' +
      'misconfiguration, or a transient error. Do NOT retry this call, and do NOT ' +
      'attempt the same goal through another tool or a different route. Stop what ' +
      'you were doing and ask the user how they would like to proceed.';
    const allowed = 'The user reviewed this request in switchboard and allowed it.';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason ?? (decision === 'deny' ? denied : allowed),
      },
    });
  }

  /** Answer a held request. Returns false if it already resolved/timed out. */
  decide(requestId: string, decision: 'allow' | 'deny', reason?: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    try {
      p.res.end(this.verdict(decision, reason));
    } catch {
      /* connection gone — the CLI's own prompt takes over (fail-open) */
    }
    this.opts.manager.apply(p.sessionId, { kind: 'permission-resolved' });
    this.opts.log.info('permission decided', { requestId, decision, sessionId: p.sessionId });
    this.notifyResolved(requestId);
    return true;
  }

  /** Release a held request with no opinion — the CLI's own TUI prompt runs. */
  private release(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    try {
      p.res.end('{}');
    } catch {
      /* already gone */
    }
    this.notifyResolved(requestId);
  }

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
    this.allowAllSessions.delete(sessionId); // "this session" ends here
    this.noWindowWarned.delete(sessionId); // a respawn warns again if still blind
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
    // a session closed mid-hold must not leave the CLI hanging (fail-open)
    for (const [id, p] of this.pending) if (p.sessionId === sessionId) this.release(id);
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
    // PreToolUse gets its own entry: the forwarder waits (4th arg) for a held
    // decision and prints the hook JSON verdict to stdout; the CLI-side
    // timeout is a beat above ours so OUR timeout (fail-open '{}') wins.
    const holdMs = this.opts.holdTimeoutMs ?? 300_000;
    hooks['PreToolUse'] = [
      {
        matcher: PRETOOL_MATCHER,
        hooks: [
          {
            type: 'command',
            timeout: Math.ceil(holdMs / 1000) + 10,
            command: `${command} ${holdMs + 5_000}`,
          },
        ],
      },
    ];
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
      // PreToolUse for a gated tool HOLDS (E10-03): the response is parked
      // until the UI decides; allow-all sessions are ANSWERED at the server
      // (no hold, no event, no beep — P2 #19); everything else acks
      // instantly (S-06).
      const r = this.maybeHold(sessionId, body, res);
      if (r === 'pass') res.end('{}');
      this.ingest(sessionId, body);
      if (r === 'held') this.opts.manager.apply(sessionId, { kind: 'permission-held' });
    });
  }

  /** Park a gated PreToolUse response ('held'), answer it server-side for an
   *  allow-all session ('answered'), or leave it alone ('pass'). */
  private maybeHold(
    sessionId: string,
    body: string,
    res: http.ServerResponse
  ): 'held' | 'answered' | 'pass' {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return 'pass';
    }
    if (e.hook_event_name !== 'PreToolUse') return 'pass';
    // Defensive only. This was the ORIGINAL "nobody to ask" guard and it never
    // fires in the app — ipc.ts subscribes once at setup and never unsubscribes,
    // and hook-check subscribes before any session spawns. Nothing but a unit
    // test reaches it. Window liveness (below) is the check that actually does
    // the work (P2-E15-09 / AR-P1-7).
    if (this.permListeners.size === 0) return 'pass'; // nobody to ask — fail open
    // A STREAM session's permissions belong to the control channel, not here
    // (P2-E18-07). Hooks are independent of the transport, so a stream session
    // can still fire PreToolUse — and holding it would ask the user the same
    // question TWICE, once from each channel, which is a worse version of the
    // very bug this epic exists to fix. The `can_use_tool` request is the one
    // that carries the reason and that the `.claude/` guard actually honours,
    // so it wins and this passes.
    //
    // MEASURED 2026-08-10 (#404 probe, claude 2.1.226, the exact Direct flag
    // list): the real CLI DOES fire PreToolUse (and SessionStart / Stop /
    // UserPromptSubmit / PostToolUse) under `--input-format stream-json` with
    // `--permission-prompt-tool stdio`. So this guard is live, not
    // precautionary — without it every Direct tool call would be held twice.
    if (this.opts.transportFor?.(sessionId) === 'stream') {
      this.opts.log.debug('PreToolUse passed: stream session, permissions ride can_use_tool', {
        sessionId,
      });
      return 'pass';
    }
    const tool = typeof e.tool_name === 'string' ? e.tool_name : undefined;
    const input =
      e.tool_input && typeof e.tool_input === 'object'
        ? (e.tool_input as Record<string, unknown>)
        : undefined;
    if (
      !shouldHoldPermission(
        this.opts.autonomyFor?.(sessionId),
        tool,
        input,
        this.opts.cwdFor?.(sessionId)
      )
    )
      return 'pass';
    if (this.allowAllSessions.has(sessionId)) {
      try {
        res.end(this.verdict('allow', 'Allow-all (this session) from switchboard'));
      } catch {
        /* connection gone — CLI falls back to its own prompt */
      }
      this.opts.log.debug('gated call auto-allowed (allow-all session)', { sessionId, tool });
      return 'answered';
    }
    // Nobody to ask — the window is closed, destroyed, or its renderer crashed
    // while sessions kept running. Holding here would park the CLI for the full
    // 300s per gated call with no UI able to answer (AR-P1-7). Fail open: no
    // opinion, so the CLI's own TUI prompt takes over.
    //
    // Deliberately checked AFTER the policy (so an ungated call never logs) and
    // AFTER allow-all (that verdict is answered at the server and never needed a
    // renderer). A RELOADING renderer is still live — its window is neither
    // destroyed nor crashed — so the pendingPermissions replay path is untouched.
    if (!this.windowLive()) {
      // Loud the first time per session, quiet after: a closed window with a
      // busy session produces one of these per gated call, and a log that
      // repeats one line forever is a log nobody reads.
      const first = !this.noWindowWarned.has(sessionId);
      this.noWindowWarned.add(sessionId);
      const where = { sessionId, tool };
      if (first) this.opts.log.warn('no live window to ask — failing open to the TUI', where);
      else this.opts.log.debug('no live window to ask — failing open to the TUI', where);
      return 'pass';
    }
    // A window is back. Re-arm the warning so the NEXT outage is loud again
    // (#334). The flag means "already warned about the outage we are IN", not
    // "warned once, ever" — without this, a window that closes, returns and
    // closes again logs the second outage at `debug` and the operator sees
    // nothing. `unregisterSession` clears it too, but only when the session
    // itself ends; a session outlives many windows.
    this.noWindowWarned.delete(sessionId);

    const requestId = `perm-${++this.reqCounter}`;
    const timer = setTimeout(() => {
      // no decision in time: no opinion — the CLI's own TUI prompt takes over
      this.opts.log.warn('permission hold timed out — failing open to the TUI', {
        requestId,
        sessionId,
      });
      this.release(requestId);
    }, this.opts.holdTimeoutMs ?? 300_000);
    timer.unref?.();
    const request: PermissionRequest = {
      requestId,
      sessionId,
      tool: tool ?? '',
      input:
        e.tool_input && typeof e.tool_input === 'object'
          ? (e.tool_input as Record<string, unknown>)
          : {},
    };
    this.pending.set(requestId, { res, timer, sessionId, request });
    this.opts.log.info('permission held', { requestId, sessionId, tool });
    for (const l of this.permListeners) {
      try {
        l(request);
      } catch (err) {
        this.opts.log.error('permission listener threw', { error: String(err) });
      }
    }
    return 'held';
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
    // A STREAM session's permissions belong to the control channel, not here
    // (#313) — the same ruling as the hold guard in `maybeHold`, applied to the
    // other half of the same problem.
    //
    // P2-E18-07 stopped a stream session's PreToolUse being HELD, so there is
    // no second approval bar. It said nothing about the STATUS, and
    // `Notification` is the path that reaches it: `state-machine`'s Notification
    // arm transitions to `needs-permission` on a regex over the CLI's DEBOUNCED
    // nudge, with no evidence that anything is held and no way to know it is on
    // a transport that has a better signal. On stream, every real permission
    // arrives as `can_use_tool` and is mapped exactly (`stream-status.ts`), so a
    // Notification-driven `needs-permission` is at best a duplicate of a status
    // we already set — and at worst a FALSE ALARM, the debounced nudge landing
    // after the request was answered and dragging a working card back to
    // "needs permission" with nothing held and no bar to answer.
    //
    // Suppressed at the PRODUCER rather than in `transition()`, deliberately:
    // the state machine is a pure function that has never had to know about
    // transports, and teaching it would mean threading `transport` through
    // every `SessionEvent` producer to serve one arm. This listener already
    // knows (`transportFor` has been plumbed since P2-E18-07).
    //
    // DROPPING the event is exactly equivalent to not transitioning on it:
    // `SessionManager.apply` does nothing with a hook event but run it through
    // `transition`, and a permission-classified blob can only reach the two
    // `/permission/i` arms — the `needs-input` one already stays. Nothing else
    // in the payload is consumed on this path (`session_id` was applied above,
    // before this guard).
    //
    // MEASURED 2026-08-10 (#404 probe, claude 2.1.226): hooks DO fire under
    // `--permission-prompt-tool stdio` — see `maybeHold`. Neither probe run
    // produced a Notification specifically (no permission prompt was drawn),
    // but the channel is confirmed live, so this guard is load-bearing.
    if (isPermissionNotification(ev) && this.opts.transportFor?.(sessionId) === 'stream') {
      this.opts.log.debug('Notification not applied: stream session, permissions ride can_use_tool', {
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
