// Session/PTY IPC surface (P1-E3-02): the renderer's only door into the
// session core. Hidden panes are ingest-only (S-07): PTY bytes always land in
// the main-process ring buffer; the renderer gets a live feed ONLY while a
// pane is attached, and a scrollback snapshot replay on attach.
//
// HOW THIS SEAM SAYS NO (#347, following #326's argument for `groups:*` —
// `main/workspace/group-ipc.ts` holds the full version and is worth reading
// once). It refuses by RESOLVING a value the caller can read, never by
// throwing. Most of this file was already there — `sessions:setTransport`
// answers `{ ok, reason }`, `submitPrompt` / `interrupt` / `decidePermission`
// answer `false`, `pty:attach` answers `null`, and the `setAutonomy` family
// returns quietly. `sessions:create` and `sessions:rename` were the two
// outliers, and the short version of why they changed:
//
//   * Every bridge call in the renderer is a bare `void x().then(...)`. A
//     `.catch()` policy makes today's callers safe and tomorrow's (a palette
//     command that starts a session, a §5.23 contribution, the context-menu
//     rename that `sessions:rename` is waiting for and has no caller for yet)
//     safe only if whoever writes them remembers. A result shape has nothing
//     to remember, because there is nothing to reject.
//   * A refusal is now IN THE APP LOG. It was not before: the broker does not
//     catch handler throws, so Electron printed `Error occurred in handler for
//     'sessions:create'` to the main process's stderr and the reason never
//     reached the log sink at all. A card that will not start because its
//     folder is gone was therefore unexplainable from the logs.
//   * `null` is data, so the caller can react. `SessionGrid`'s spawn effect
//     paints the "Session ended" overlay for a start that did not happen —
//     which is what it already did from its `.catch`, so the screen is
//     unchanged and only the plumbing is honest.
//   * A renderer-wide `unhandledrejection` handler would also have stopped the
//     crash, and would have made the `pageerror` assertions in
//     `e2e/groups.spec.ts` and `e2e/session.spec.ts` vacuous by swallowing
//     exactly what they watch for. Rejected for that reason (#326).
//
// What did NOT change: every validation still refuses, and the reasons are
// unchanged. `SessionManager.create` still THROWS for a provider adapter it
// does not have or a transport it cannot resolve — that is a main-process API
// with main-process callers (`hook-check`), and this handler is the place where
// a throw becomes a renderer's problem, so this is where it is turned into an
// answer. The steps AFTER a successful spawn are left as they are: by then the
// session is live, and answering `null` would strand it.
import { BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import { SessionManager, SessionRecord } from './session-manager';
import { PtyService } from '../pty/pty-service';
import { StreamPermissions } from './stream-permissions';
import { StreamCommands } from './stream-commands';
import { StreamFeed } from '../feed/stream-feed';
import { replayResumedHistory } from '../feed/history';
import { HookListener } from '../hooks/hook-listener';
import { IpcBroker } from '../ipc/broker';
import { Channel } from '../../shared/ipc/capabilities';
import type { PtyAttachment, PtyChunk } from '../../shared/ipc/pty';
import type { PermissionRequest } from '../../shared/ipc/permissions';
import type { ProviderCapabilities } from '../extensibility/contributions';
import { TranscriptWatcher } from '../transcripts/watcher';
import { searchTranscripts } from '../transcripts/search';
import type { TranscriptQuery, TranscriptSearchRequest } from '../../shared/transcripts';
import { LogFields, Logger } from '../log/logger';
import { assignAccent, detectProjectType } from './identity';
import { EventFeed } from '../events/feed';
import { planSessionStart } from './start-plan';
import { recordNativeId, resumeCandidates } from './lineage';
import { nextAutoLabel, typedLabel, visibleTaskLabel } from './auto-label';
import { PersistedSession } from '../workspace/store';
import { commandsFromCli, SlashCommand } from '../../shared/slash-commands';
import { DEFAULT_SESSION_TRANSPORT } from '../transport/transport';
import { sanitizePromptAttachments } from '../../shared/prompt-attachments';

export interface SessionIpcDeps {
  manager: SessionManager;
  ptys: PtyService;
  /** Stream-transport permission router (P2-E18-07). Absent until a stream
   *  session can exist, which keeps every PTY-only wiring path unchanged. */
  streamPermissions?: StreamPermissions;
  /** The CLI's own slash-command list, off the stream (P2-E18-09). Absent for
   *  a PTY-only wiring, in which case the curated list is all there is. */
  streamCommands?: StreamCommands;
  /** The Feed, built from a stream session's typed messages (P2-E18-10).
   *  Absent for a PTY-only wiring, where the transcript is the only source. */
  streamFeed?: StreamFeed;
  hooks: HookListener;
  transcripts: TranscriptWatcher;
  feed: EventFeed;
  log: Logger;
  getWindow: () => BrowserWindow | null;
  /** the IPC choke point — every channel, both directions (P2-E15-04) */
  broker: IpcBroker;
  /** auto-trust the folder before spawning (default on; user picks folder) */
  autoTrust: () => boolean;
  /** Fill blank task labels from the CLI's own conversation title (P2-E7-06,
   *  §5.11; default on). Off hides every auto label and drops toast text back
   *  to the session title — the screen-share switch. */
  autoLabels: () => boolean;
  setAutoLabels: (on: boolean) => void;
  /** persisted session cards (resume-on-focus across app restarts, §5.25) */
  persist: {
    list: () => PersistedSession[];
    upsert: (s: PersistedSession) => void;
    remove: (cardId: string) => void;
  };
  /** what a provider can do beyond being a process in a terminal (§5.3) —
   *  undefined for an unknown id, and for an adapter that declares nothing */
  capabilitiesOf: (providerId: string) => ProviderCapabilities | undefined;
  /** is this provider available right now? A card persisted under an adapter
   *  that is gone falls back to the default rather than becoming unstartable */
  isRegisteredProvider: (providerId: string) => boolean;
  /** the provider a BRAND-NEW card runs on; existing cards keep their own */
  defaultProviderId: () => string;
  /** git toplevel for a folder (null if not a repo) — auto-group key (E12-05) */
  repoRoot: (folder: string) => Promise<string | null>;
  /** slash-command discovery for the composer popup (E10-07, §5.17) — async:
   *  the scan must never stall the main process on a slow disk */
  slashCommands: (folder: string, providerId: string) => Promise<SlashCommand[]>;
  /** The env-level override of which transport a session asks its adapter for
   *  (P2-E18-08a). It sits BELOW the card's own setting and above the default —
   *  the full order is at the `sessions:create` call site. Returning `undefined`
   *  = no override. Kept after #149 gave the choice a real home on the card,
   *  because it is the only way to aim a WHOLE app instance at one transport —
   *  which is how the e2e suite starts a session on the Terminal now that
   *  Direct is the default (#381). */
  preferredTransport?: () => 'pty' | 'stream' | undefined;
}

/**
 * What registering the session IPC hands BACK to the bootstrap — the joins
 * only this closure knows about. Getters rather than subscriptions: a caller
 * asks at the moment it fires, which is the only moment the answer matters.
 */
export interface SessionIpcHandle {
  /** This live session's card label, or undefined when it has none to show (§5.11). */
  labelFor: (liveSessionId: string) => string | undefined;
  /** the durable card a live session belongs to, or null if unbound (P2-E14-03) */
  cardIdFor: (liveSessionId: string) => string | null;
  /**
   * The oldest permission this live session is still holding (P2-E14-04) — what
   * an OS toast has to name before it offers to allow it, and the request its
   * buttons answer.
   */
  pendingPermissionFor: (liveSessionId: string) => PermissionRequest | null;
  /**
   * Answer a held permission from the MAIN process — the toast's Allow/Deny.
   * The identical call `sessions:decidePermission` makes, so the toast is a
   * fourth button on the app's one decision path rather than a second path.
   * Returns false when nothing holds that request any more.
   */
  decidePermission: (requestId: string, decision: string, reason?: string) => boolean;
}

export function registerSessionIpc(deps: SessionIpcDeps): SessionIpcHandle {
  const { manager, ptys, hooks, transcripts, log, broker, streamPermissions, streamCommands } =
    deps;
  // per-session live-feed unsubscribers (attached panes only)
  const feeds = new Map<string, () => void>();
  // one attach = one epoch, stamped on every chunk that attach streams. Global
  // rather than per-session so an id is never reused across sessions either.
  let ptyEpoch = 0;
  // a card is the durable unit; the live session under it is ephemeral
  const cardOfLive = new Map<string, string>(); // liveSessionId -> cardId

  // when a session's native id is learned, persist it so the card can
  // --resume that conversation after an app restart
  manager.onNativeSessionId((liveId, nativeId, cause) => {
    // tighten transcript binding — corrects same-cwd mis-binds (E10 fix);
    // cause 'clear' = /clear minted a new conversation (E10-07 feedback)
    transcripts.setNativeSessionId(liveId, nativeId, cause);
    const cardId = cardOfLive.get(liveId);
    if (!cardId) return;
    const existing = deps.persist.list().find((s) => s.id === cardId);
    // NOT an overwrite (#484). The id arrives here the moment the CLI announces
    // one — before any turn has happened, and the CLI writes no transcript until
    // one does (S-07). So this line used to replace a card's pointer to a
    // conversation that IS on disk with a pointer to a file that may never be
    // written, and the next launch would then find the new id unresumable and
    // clear it. `recordNativeId` moves the old id down the chain instead, so
    // that launch has somewhere to fall back to.
    //
    // INCLUDING on `cause === 'clear'`, deliberately. A `/clear` mints a new
    // conversation, and not keeping the cleared one would be this exact bug
    // wearing a different hat: if the post-clear session then gets no turn its
    // transcript is never written, and the card would reset over the top of
    // history the user never asked to lose. The cost of keeping it is narrow
    // and recoverable — a `/clear` followed by a quit with NO prompt at all
    // comes back in the pre-clear conversation, one keystroke from being
    // cleared again. The moment a single turn happens the new transcript exists
    // and the chain is never walked past its head.
    if (existing) deps.persist.upsert({ ...existing, ...recordNativeId(existing, nativeId) });
  });

  // outbound goes through the broker too: it checks what the TARGET window
  // holds, which is a no-op for first-party and the enforcement point a
  // Phase-4 plugin needs (P2-E15-04)
  const send = (channel: Channel, payload: unknown): void => {
    deps.broker.send(deps.getWindow(), channel, payload);
  };

  /**
   * Say no: `null` to the caller, one line in the log (#347).
   *
   * The log line is the whole reason a result shape is not a silent swallow —
   * the seam still says out loud that it refused and why, in the one place that
   * knows why. Tests assert on it. Same helper, same wording and same `warn`
   * level as `groups:*`'s (`main/workspace/group-ipc.ts`), so one log filter
   * finds every refused mutation in the app.
   */
  const refuse = (channel: Channel, reason: string, fields: LogFields = {}): null => {
    log.warn(`${channel} refused: ${reason}`, fields);
    return null;
  };

  // ── the LIVE half of the `sessions:cards` join (#170) ────────────────────
  //
  // `sessions:cards` is a JOIN of two things that move for different reasons:
  // the persisted card list, and the live session (if any) underneath it. A
  // live session's own movements already push — `sessions:status` on a
  // transition, `sessions:exited` on death — and the renderer refreshes the
  // joined list from either. A card GAINING or LOSING its live session pushed
  // nothing at all, and that is the whole of #170: after Resume the card has a
  // brand-new live session, but no status has CHANGED yet, so the rail and the
  // urgency strip went on reading the pre-resume `suspended` until some
  // unrelated event happened to refresh the list. On a PTY session that first
  // status change only arrives when the user submits a prompt — minutes, or
  // never.
  //
  // So the binding is the event. Every mutation of `cardOfLive` goes through
  // these two helpers rather than touching the Map directly, which is what
  // stops a future call site from quietly reopening the same hole.
  //
  // This covers the LIVE half only, deliberately. The PERSISTED half —
  // renaming a card, its task label, closing a suspended one — pushes nothing
  // and does not need to: every one of those is renderer-initiated, and the
  // caller refreshes at its own call site. A resume was neither, which is why
  // it fell through the gap: its caller is the grid's lazy-spawn effect, which
  // has no route to the rail's refresh.
  //
  // Signal-only, like `sessions:status`: the renderer re-reads `sessions:cards`
  // (which is async — it resolves repo roots) rather than being handed a list.
  // The invariant that makes that race-free is not merely that main is
  // single-threaded — it is that there is NO `await` between this push and the
  // last mutation of the handler that sent it, so the pull cannot be served
  // until that handler has returned. `sessions:create` is synchronous
  // throughout today. An await introduced between `bindLive` and the
  // `persist.upsert` below it would reopen the window: the renderer would pull
  // a live binding whose persisted card is not written yet, and a brand-new
  // card would vanish from the list for a frame.
  //
  // Since #187 a single `sessions:create` can push this TWICE — once losing the
  // reaped session, once gaining its replacement — and `events:changed` rides
  // the same handler (the reap forgets the dead session's event). Both are true
  // statements about a state the renderer only gets to read once the handler
  // has returned, so the rule above is what keeps the extra push harmless
  // rather than a torn read.
  const cardsChanged = (): void => send('sessions:cardsChanged', undefined);
  const bindLive = (liveId: string, cardId: string): void => {
    cardOfLive.set(liveId, cardId);
    cardsChanged();
  };
  // Exactly one caller, and it should stay that way: `tearDownLive`. Unbinding
  // a session WITHOUT tearing it down orphans its hook registration, transcript
  // watch and feed subscription with nothing left that can reach them — the
  // leak #170 declined to take and #187 removed the need for.
  const unbindLive = (liveId: string): void => {
    if (cardOfLive.delete(liveId)) cardsChanged();
  };

  /**
   * A card's task label changed — tell the renderer (P2-E7-06).
   *
   * The exception to the paragraph above, and the reason it needed writing
   * down. Every other persisted-half mutation is renderer-initiated, so the
   * caller refreshes at its own call site; an AUTO label is initiated by a line
   * appearing in a file nobody asked about, and there is no call site to
   * refresh. Without this the label would be correct in the workspace file and
   * invisible until something unrelated happened to reload the card list.
   *
   * Carries the VALUE rather than signalling "go and re-read", unlike
   * `cardsChanged`. Two reasons, and both are about the two consumers: the
   * grid's card header holds its label in local state (there is nothing to
   * re-read), and `sessions:cards` resolves a git root per card, so a signal
   * would turn one field moving into a directory walk per session per turn.
   */
  const publishLabel = (cardId: string, label: string | undefined): void =>
    send('sessions:taskLabel', { cardId, label });

  /**
   * The task label to SHOW for a live session, or undefined when it has none
   * (§5.9's toast text reads this — see `index.ts`).
   *
   * Goes through `visibleTaskLabel`, so a card whose auto label is suppressed
   * is suppressed in the toast too. That is the whole point of the switch: the
   * toast is the surface that leaves the app window.
   */
  const labelFor = (liveSessionId: string): string | undefined => {
    const cardId = cardOfLive.get(liveSessionId);
    if (!cardId) return undefined;
    const card = deps.persist.list().find((s) => s.id === cardId);
    return card ? visibleTaskLabel(card, deps.autoLabels()) : undefined;
  };

  /**
   * This session's record, but ONLY while its process is still up (#187).
   *
   * `exitCode === null` is the test — the field is `number | null` and a running
   * session carries null, NOT undefined. A probe caught that the hard way:
   * `!== undefined` matched every live session and adopted none of them.
   *
   * A dead session KEEPS its record, so "the manager knows it" is a different
   * question, and answering that one instead is the mistake this pair exists to
   * stop being rewritten — it was live in `sessions:setTransport` until #187,
   * and rewriting it a third time in `sessions:create`'s adopt pass would have
   * handed a card the corpse it had just failed to reap.
   */
  const runningRecord = (liveId: string): SessionRecord | undefined => {
    const r = manager.get(liveId);
    return r?.exitCode === null ? r : undefined;
  };
  const isRunning = (liveId: string): boolean => runningRecord(liveId) !== undefined;

  /**
   * One teardown step, isolated (#219).
   *
   * The steps below are INDEPENDENT releases — different services, no shared
   * state, no ordering requirement between them. A straight-line body made them
   * dependent anyway: the first one to throw skipped every step after it. That
   * is the opposite of what each step is for, and it is not hypothetical
   * insulation — the step most expensive to skip sits in the middle of the list
   * (`streamPermissions.forgetSession`, which DENIES the approval the CLI is
   * blocked on and takes the renderer's bar down with it). A throw two lines
   * above it in `hooks.unregisterSession` would leave a card showing a
   * permission bar for a session that no longer exists, with a CLI parked on a
   * question nothing will ever answer.
   *
   * So each step gets its own try/catch, and a failure is a logged nuisance
   * rather than an abort. The alternative on the table in #219 — reordering so
   * the user-visible releases run first — was rejected: it does not make any
   * step safe, it only re-picks which steps get skipped, and it would leave the
   * SAME hole one refactor away from moving back.
   *
   * The step NAME goes in the log. The old fail-open catch at the reap site
   * (see `sessions:create`) could only say "the teardown threw"; this says which
   * release was lost, which is the whole diagnostic.
   */
  const tearDownStep = (liveId: string, name: string, run: () => void): void => {
    try {
      run();
    } catch (err) {
      log.warn('a session teardown step failed; releasing the rest anyway', {
        sessionId: liveId,
        step: name,
        error: String(err),
      });
    }
  };

  /**
   * Release everything one live session is HOLDING ON BEHALF OF THE USER: its
   * hook registration — and with it every parked `PreToolUse` HTTP response and
   * its 300s timer — plus every outstanding stream `can_use_tool`.
   *
   * Extracted out of `tearDownLive` for #271, because these two steps are the
   * only ones a session that **exits on its own** needs, and they were the only
   * ones it never got. A plain self-exit reaches no teardown at all: nothing
   * closes the card, nothing restarts it, so `tearDownLive` is never called and
   * main went on holding a question for a CLI that had already died — and went
   * on advertising it through `sessions:pendingPermissions` to any card that
   * mounted afterwards. `unregisterSession`'s own comment ("a session closed
   * mid-hold must not leave the CLI hanging (fail-open)") is exactly the
   * guarantee that path skipped.
   *
   * The rest of `tearDownLive` deliberately stays out of here. An exited session
   * KEEPS its record and its binding (#187): the reap in `sessions:create`
   * adopts or retires the corpse, the "Session ended" overlay reads it, and
   * unbinding on exit would take the card's live half away underneath both.
   * This releases what is held; it does not retire the session.
   *
   * **Idempotent, and it has to be.** The restart paths run BOTH: `tearDownLive`
   * calls this, and then `manager.remove` kills the process, whose exit reaches
   * the listener below — so on every Restart and every card close of a RUNNING
   * session this runs twice. The second pass is a no-op whenever it lands, which
   * is the only claim worth making: `remove()` sends a SIGNAL, so in production
   * the exit arrives on a later turn of the loop, not inside the teardown. (The
   * comment on `SessionManager.remove` says "synchronously"; it is describing
   * `apply()`'s ordering, and it is an overstatement about the transports — both
   * `PtyService.remove` and `StreamService.remove` end at `kill()`.) Both
   * releases underneath are sweeps over a per-session map that delete before
   * they notify, so the second pass matches nothing: no second denial down the
   * stream, no second `sessions:permissionResolved`. Pinned by a test, because
   * "no double-release" is a property of those two implementations and not of
   * this function.
   *
   * `why` is the reason recorded in the auto-denial: the router logs it and
   * offers it to the transport as the CLI's deny message. On the SELF-EXIT path
   * nobody is left to read it — a dead session's `send` is a documented no-op —
   * and that is the argument for releasing rather than holding, not a reason to
   * be vague. The two callers say different and true things so the log can tell
   * a session the user closed from one that died.
   */
  const releaseHeldPermissions = (liveId: string, why: string): void => {
    // …which parks a `PreToolUse` HTTP response per held request. Its release
    // deliberately does NOT `apply('permission-resolved')` the way `decide()`
    // does (see `HookListener.release`): a status transition here would walk a
    // `needs-permission` session to `working` a beat before its exit lands.
    tearDownStep(liveId, 'hooks.unregisterSession', () => hooks.unregisterSession(liveId));
    // an unanswered control request leaves the CLI waiting for ever
    tearDownStep(liveId, 'streamPermissions.forgetSession', () =>
      streamPermissions?.forgetSession(liveId, why)
    );
  };

  /**
   * Retire ONE live session completely: every subscription, registration and
   * watch taken out in its name, then the record, then the binding (#187).
   *
   * This is the only way a binding is allowed to end. It used to be the body of
   * `dropLiveForCard` and nothing else, which made "unbind" and "tear down" two
   * separate things a call site could get half-right — and `sessions:create`
   * did exactly that, deliberately leaving a crashed session bound rather than
   * unbinding it without the teardown (see the reap loop there).
   *
   * Every step is a no-op for an id it does not know, so reaping a session
   * whose record is already gone is safe rather than a special case.
   *
   * **It does not throw** (#219). Every step is isolated, and the whole list
   * runs whatever any one of them does — see `tearDownStep`. That is what makes
   * it safe on the three paths that call it, only ONE of which ever had a catch
   * of its own: the reap inside `sessions:create` fails open (#187), but
   * `sessions:closeCard` goes on to `persist.remove` (a throw here used to
   * resurrect the closed card on the next boot) and `sessions:dropLive` answers
   * the renderer's Restart (a throw here used to read as "restart failed" for a
   * session that had in fact been torn down). Fail-open belongs in the function
   * every one of them shares, not in one caller out of three.
   */
  const tearDownLive = (liveId: string): void => {
    // its event leaves the Events panel with it
    tearDownStep(liveId, 'feed.forget', () => deps.feed.forget(liveId));
    // `feeds` is the PTY live-feed unsubscriber from `pty:attach`, not the
    // Events feed above it — two different things one line apart
    tearDownStep(liveId, 'pty.detach', () => feeds.get(liveId)?.());
    // Map.delete cannot throw, and it is deliberately OUTSIDE the step above: a
    // subscriber that blows up on the way out still gets its handle dropped.
    feeds.delete(liveId);
    // the two held-permission releases, shared with the self-exit path (#271).
    // They sit adjacent now rather than side-by-side with `transcripts.unwatch`
    // between them; no step here depends on any other (see `tearDownStep`), so
    // the move is free — and `hooks.unregisterSession` is still the step
    // immediately before the stream denial, which is what #219's second test
    // blows up on purpose.
    releaseHeldPermissions(liveId, 'session closed');
    tearDownStep(liveId, 'transcripts.unwatch', () => transcripts.unwatch(liveId));
    // the next session under this card gets its own list from its own CLI
    tearDownStep(liveId, 'streamCommands.forgetSession', () =>
      streamCommands?.forgetSession(liveId)
    );
    // …and its own Feed blocks (P2-E18-10)
    tearDownStep(liveId, 'streamFeed.forgetSession', () => deps.streamFeed?.forgetSession(liveId));
    // marks the kill intentional BEFORE tearing the process down, mirroring
    // kill(): otherwise onExit could see killRequested=false and report a
    // spurious `crashed` for an ordinary suspend/restart (review nit).
    // The transport teardown lives INSIDE remove() as of P2-E18-02 — this used
    // to call `ptys.remove(liveId)` here, which silently tears down nothing for
    // a session hosted on any transport but the PTY.
    tearDownStep(liveId, 'manager.remove', () => manager.remove(liveId));
    tearDownStep(liveId, 'unbindLive', () => unbindLive(liveId));
  };

  manager.onStatusChange((change) => {
    send('sessions:status', change);
    deps.feed.ingest(change);
    // A turn is running, so a transcript exists or is about to (P2-E15-10).
    // This is the ONLY honest "a conversation started" signal available: the
    // watcher sees hook traffic from `SessionStart` at launch too, and a
    // session that has merely been spawned has no transcript by design — so
    // taking evidence from hook traffic alone would put every un-prompted card
    // into a failure state 45 seconds after it opened.
    if (change.to === 'working') transcripts.noteConversationStarted(change.sessionId);
  });
  // one event per session, latest state wins (Dan 2026-07-22) — push the
  // whole list on ANY change (adds, replacements, and pure removals)
  deps.feed.onEvent(() => send('events:changed', deps.feed.list()));
  // A session's death is the last honest moment to answer anything it left the
  // user holding (#271). The release comes FIRST and cannot throw — every step
  // inside it is isolated — so the `sessions:exited` push behind it is
  // unconditional, and neither half can cost the other.
  //
  // The order is not arbitrary. `permissionResolved` is what takes the approval
  // bar down and `sessions:exited` is what raises the "Session ended" overlay,
  // so releasing first means the bar is already gone when the overlay lands.
  // The reverse would paint an approval bar onto an ended card for a frame.
  //
  // 'session exited' rather than `tearDownLive`'s 'session closed': the two are
  // different events and the log is where the difference is read. On THIS path
  // nothing downstream ever sees the string — a dead session's transport
  // refuses the write — which is the point: there is nobody left to answer, so
  // the hold must go.
  //
  // NOT the whole teardown. See `releaseHeldPermissions`: an exited session
  // keeps its record, its binding and its Events entry, and the reap in
  // `sessions:create` decides what becomes of the corpse.
  //
  // Its transcript WATCH is the one thing that now hears about the death
  // directly (#200). It is not torn down either — the crashed card still reads
  // its Feed backlog and its binding state out of it — but it stops being a
  // watch: `noteSessionExited` drains what is left, finishes any hunt already
  // in progress, and then freezes, so a card left sitting on a crashed session
  // is no longer scanning `~/.claude/projects` ten times a second on behalf of
  // a process that will never write again. A one-way latch, so the reap
  // unwatching this same session later is safe in either order.
  //
  // It goes BEFORE the push, and through `tearDownStep`, for the two halves of
  // the same rule the release above obeys. Before: the drain inside it is what
  // puts the crashed turn's last words in the Feed, and `sessions:exited` is
  // what raises the overlay over them. Isolated: everything ahead of that push
  // has to be unable to cost it — and the inverse is just as bad, since a throw
  // out of `send` would leave this watch polling for the life of the process,
  // which is the entire defect #200 exists to remove.
  manager.onSessionExit((e) => {
    releaseHeldPermissions(e.sessionId, 'session exited');
    tearDownStep(e.sessionId, 'transcripts.noteSessionExited', () =>
      transcripts.noteSessionExited(e.sessionId)
    );
    send('sessions:exited', e);
  });
  transcripts.onUpdate((snap) => {
    send('sessions:usage', snap);
    // A snapshot that has ingested nothing has nothing to SAY about usage, and
    // since P2-E15-10 these fire on binding transitions too — including the
    // zeroed snapshot a /clear or a corrected mis-bind installs before the
    // replay rebuilds the totals. Persisting that would wipe a resumed card's
    // stored figures and blank the usage strip (the totals come back on the
    // next drain, but the stored ones would already be gone).
    if (snap.lines === 0) return;
    // persist usage per card so the number survives a resume/restart
    const cardId = cardOfLive.get(snap.sessionId);
    if (!cardId) return;
    const prior = deps.persist.list().find((s) => s.id === cardId);
    if (!prior) return;
    // keep the last real model if this snapshot hasn't seen a model line yet
    const next: PersistedSession = { ...prior, usage: snap.usage, model: snap.model ?? prior.model };
    // ...and the CLI's own conversation title fills a blank label (P2-E7-06).
    // ONE upsert, not two: a second `{...prior, taskLabel}` would be built from
    // the same `prior` and would put the usage totals back to what they were
    // before the line that triggered this.
    //
    // `null` on nearly every call — see `nextAutoLabel` for the four ways — and
    // that is what makes "repeat titles cost nothing" true rather than hoped
    // for: the CLI re-emits its settled title every turn, and every one of those
    // lands here.
    const label = nextAutoLabel(prior, snap.title, deps.autoLabels());
    if (label !== null) {
      next.taskLabel = label;
      next.labelSource = 'auto';
    }
    deps.persist.upsert(next);
    if (label !== null) publishLabel(cardId, label);
  });

  broker.handle('events:list', () => deps.feed.list());
  // "Done." relaxes to "Ready" once the user looks at the session (Dan #4)
  broker.handle('events:ack', (_e, sessionId: string) => {
    if (typeof sessionId === 'string') deps.feed.acknowledge(sessionId);
  });
  // the ✕ on an event item removes it outright (Dan round 4)
  broker.handle('events:dismiss', (_e, sessionId: string) => {
    if (typeof sessionId === 'string') deps.feed.forget(sessionId);
  });

  // held PreToolUse permissions (E10-03): stream requests to the renderer,
  // take decisions back. Card id rides along so the UI can find its panel.
  hooks.onPermissionRequest((r) =>
    send('sessions:permissionRequest', { ...r, cardId: cardOfLive.get(r.sessionId) })
  );
  hooks.onPermissionResolved((requestId) => send('sessions:permissionResolved', { requestId }));
  // The stream transport's identical half (P2-E18-07). Same events, same
  // shape, same bar: the user is answering the same question, and the renderer
  // must not have to know which channel carried it.
  streamPermissions?.onPermissionRequest((r) =>
    send('sessions:permissionRequest', { ...r, cardId: cardOfLive.get(r.sessionId) })
  );
  streamPermissions?.onPermissionResolved((requestId) =>
    send('sessions:permissionResolved', { requestId })
  );
  // replay for a (re)mounting renderer — a missed push must not park the CLI
  broker.handle('sessions:pendingPermissions', () =>
    [...hooks.pendingRequests(), ...(streamPermissions?.pendingRequests() ?? [])].map((r) => ({
      ...r,
      cardId: cardOfLive.get(r.sessionId),
    }))
  );
  /**
   * **The** decision path (P2-E14-04). Named and hoisted out of the channel
   * handler because it now has more than one caller: the renderer's four
   * surfaces come through `sessions:decidePermission` below, and the OS toast's
   * Allow/Deny buttons come through `SessionIpcHandle.decidePermission` — from
   * the main process, with no window in the loop at all. A toast that reached
   * the routers itself would be a second opinion about what "allow" means.
   */
  const decidePermission = (requestId: string, decision: string, reason?: string): boolean => {
    if (typeof requestId !== 'string' || (decision !== 'allow' && decision !== 'deny')) return false;
    const clean = typeof reason === 'string' ? reason.slice(0, 500) : undefined;
    // Ids are namespaced (`stream:<sessionId>:<native>`), so exactly one of
    // these can own a given request and the order is not load-bearing.
    // Falls through rather than branching on the prefix: the prefix is an
    // implementation detail of the stream router, and asking the routers who
    // owns it cannot go stale the way a string test would.
    return (
      hooks.decide(requestId, decision, clean) ||
      (streamPermissions?.decide(requestId, decision, clean) ?? false)
    );
  };
  broker.handle('sessions:decidePermission',
    (_e, requestId: string, decision: string, reason?: string) =>
      decidePermission(requestId, decision, reason)
  );
  /**
   * The oldest request this LIVE session is still holding, or null (E14-04).
   *
   * FIFO across both routers, because that is what the approval bar answers:
   * its buttons act on `cardQueue[0]`. A toast that answered the newest request
   * while the bar answered the oldest would make the two surfaces disagree
   * about which question is on screen — and the user would have no way to tell.
   */
  const pendingPermissionFor = (liveSessionId: string): PermissionRequest | null =>
    [...hooks.pendingRequests(), ...(streamPermissions?.pendingRequests() ?? [])].find(
      (r) => r.sessionId === liveSessionId
    ) ?? null;
  // Submit a prompt on the session's own transport (P2-E18-08a). Returns
  // false for a PTY session, whose composer route is a bracketed paste and a
  // delayed CR — a genuinely different operation. The renderer tries this
  // first and falls back, which is how it stays transport-ignorant until
  // P2-E18-08b gives the user the choice.
  //
  // `attachments` (P2-E10-09/10) are validated HERE and not only in the renderer: this
  // is the boundary where a base64 string becomes a line on the CLI's stdin,
  // and the media type, the count and the encoding are all main's to enforce
  // rather than to trust. A payload that fails the check is refused OUTRIGHT
  // (false), never downgraded to a text-only send — "what's wrong with this
  // screenshot?" with the screenshot quietly removed is worse than a prompt
  // that visibly did not go.
  broker.handle('sessions:submitPrompt', (_e, sessionId: string, text: string, attachments?: unknown) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') return false;
    const clean = sanitizePromptAttachments(attachments);
    if (clean === null) return false;
    return manager.submitPrompt(sessionId, text, clean);
  });
  // Interrupt the running turn (#154). Returns false for a PTY session, whose
  // interrupt is an Esc keystroke — the renderer falls back, exactly as it does
  // for submitPrompt, and so never has to know which transport it is on.
  broker.handle('sessions:interrupt', (_e, sessionId: string) => {
    if (typeof sessionId !== 'string') return false;
    return manager.interrupt(sessionId);
  });
  // "Allow all (this session)": answered at the SERVER from now on — no
  // hold, no needs-permission event, no beep (review P2 #19, Dan round 4).
  //
  // BOTH channels (#319). It told the hooks alone, which is the whole of the
  // promise for a PTY session and none of it for a Direct one: a stream
  // session's permissions ride `can_use_tool`, and `HookListener.maybeHold`
  // passes those straight through before it ever looks at its allow-all set. So
  // stream allow-all lived only in the renderer — every gated call still had to
  // reach a window, still beeped on the way, and a session with no window could
  // not run a gated tool at all.
  //
  // Unconditional in both directions rather than branching on the session's
  // transport. Both sets are keyed by the same live id, both are ignored by the
  // channel that does not carry that session's permissions, and both are
  // dropped by the same teardown — so telling both is one line cheaper than
  // asking, and cannot go stale the way a transport test would.
  broker.handle('sessions:allowAllSession', (_e, liveId: string) => {
    if (typeof liveId !== 'string') return;
    hooks.setAllowAll(liveId);
    streamPermissions?.setAllowAll(liveId);
  });

  // Feed view blocks (P2-E12-06): live stream + backlog for attach.
  //
  // TWO SOURCES, ONE CHANNEL (P2-E18-10). A PTY session's blocks are derived
  // from its JSONL transcript; a stream session's are derived from its typed
  // messages. They are the same blocks, built by the same code
  // (`main/feed/blocks.ts`), and the renderer must not be able to tell which
  // one it is looking at — so they share `sessions:feedBlock` rather than
  // getting a second channel the FeedView would have to subscribe to twice.
  //
  // Exactly one source is live per session: the watcher is told not to derive
  // (below, at `sessions:create`) for a stream session, which is what keeps
  // this from rendering every block twice.
  const isStream = (liveId: string): boolean => manager.get(liveId)?.transport === 'stream';
  transcripts.onBlock((sessionId, block) => send('sessions:feedBlock', { sessionId, block }));
  deps.streamFeed?.onBlock((sessionId, block) => send('sessions:feedBlock', { sessionId, block }));
  // a corrected mis-bind (or /clear) discarded the derived blocks — the
  // renderer must too; cause 'clear' shows the "conversation cleared" marker
  //
  // A reset is routed by source for the same reason a block is, and it is the
  // sharper of the two: the watcher goes on watching a stream session (usage,
  // the native id, drift), so it still corrects mis-binds and still sees a
  // /clear — and an ungated reset would blank a Feed the transcript never
  // built, with nothing to replay it from. A stream session's resets come off
  // its own `system:init` instead.
  transcripts.onReset((sessionId, cause) => {
    if (isStream(sessionId)) return;
    send('sessions:feedReset', { sessionId, cause });
  });
  deps.streamFeed?.onReset((sessionId, cause) => send('sessions:feedReset', { sessionId, cause }));
  broker.handle('transcripts:blocks', (_e, liveId: string) => {
    if (typeof liveId !== 'string') return [];
    return isStream(liveId) && deps.streamFeed
      ? deps.streamFeed.blocks(liveId)
      : transcripts.blocks(liveId);
  });
  // Session find (P2-E17-01, §5.31): scan the transcript FILE, in main.
  //
  // Behind `transcripts.read` and NO new capability — the file is one we
  // already watch and already stream to this window block by block.
  //
  // The scope arrives as a LIST of session ids and is resolved to files HERE,
  // by asking the watcher which transcript each id is bound to. The caller
  // therefore names sessions, never paths: a renderer cannot ask this channel
  // to read a file no card is showing, which is the same rule `fs:read` enforces
  // with a scope check and this one gets for free from the indirection.
  //
  // A STREAM session is searched too, and completely: the watcher still binds
  // its transcript (usage, the native id, drift all want it — only the FEED
  // comes from somewhere else), so the file on disk is the same complete
  // archive. It gets a JUMP too, since #458: `loaded` is routed the way
  // `transcripts:blocks` routes it, and although a stream block's `ts` is the
  // moment the message reached US rather than what the CLI wrote, the engine
  // now lines the two up on the API's own `tool_use` / `message` ids instead
  // (`search.ts` → `alignBySrcId`). Refusing remains the right answer whenever
  // those disagree — a hit that cannot be placed is listed, never guessed at.
  broker.handle('transcripts:search', async (_e, req: unknown) => {
    const r = (req ?? {}) as Partial<TranscriptSearchRequest>;
    // De-duped and capped: the scope is a list the caller builds, and the same
    // id twice is the same 7.7MB file scanned twice on the thread that pumps
    // every terminal. Neither is reachable from today's caller — which is the
    // cheapest moment to make it unreachable from tomorrow's (§5.29: validate at
    // the boundary).
    const ids = Array.isArray(r.sessionIds)
      ? [...new Set(r.sessionIds.filter((s) => typeof s === 'string'))].slice(0, 64)
      : [];
    const q = (r.query ?? {}) as Partial<TranscriptQuery>;
    const request: TranscriptSearchRequest = {
      sessionIds: ids,
      query: {
        term: typeof q.term === 'string' ? q.term : '',
        caseSensitive: q.caseSensitive === true,
        wholeWord: q.wholeWord === true,
        regex: q.regex === true,
      },
      ...(typeof r.limit === 'number' && r.limit > 0 ? { limit: Math.min(r.limit, 5000) } : {}),
    };
    const targets = ids.map((sessionId) => ({
      sessionId,
      file: transcripts.transcriptFile(sessionId),
      loaded:
        isStream(sessionId) && deps.streamFeed
          ? deps.streamFeed.blocks(sessionId)
          : transcripts.blocks(sessionId),
    }));
    return searchTranscripts(targets, request, { ...(request.limit ? { limit: request.limit } : {}) });
  });

  // Binding state on demand (P2-E15-10). Transitions ride `sessions:usage`
  // like everything else on the snapshot; this is the pull a panel needs when
  // it MOUNTS, since a session that failed to bind long ago will never push
  // again and the pane must not claim "no conversation yet".
  broker.handle('transcripts:binding', (_e, liveId: string) => {
    if (typeof liveId !== 'string') return null;
    const snap = transcripts.snapshot(liveId);
    return snap ? { binding: snap.binding, bindingDiag: snap.bindingDiag } : null;
  });

  broker.handle('sessions:isDirectory', (_e, p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

  broker.handle('sessions:pickFolder', async () => {
    const win = deps.getWindow();
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

  // Spawn (or --resume) the live session for a card. cardId is the durable
  // key; identity (accent/title/badge) and the resumable conversation are
  // reused from the persisted record so they survive restarts.
  broker.handle('sessions:create',
    (
      _e,
      opts: {
        cardId: string;
        folder: string;
        title: string;
        autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto';
        groupId?: string;
      }
    ) => {
      // Validate untrusted renderer input (§5.29). REFUSED, not thrown (#347):
      // both of these used to reject the renderer's promise, and the second one
      // is reachable without anybody doing anything wrong — a persisted card
      // whose folder was renamed, deleted, or lives on a drive that is not
      // plugged in reaches here on the first look at that card.
      if (!opts || typeof opts.cardId !== 'string' || typeof opts.folder !== 'string') {
        return refuse('sessions:create', 'cardId and folder are required');
      }
      let isDir = false;
      try {
        isDir = fs.statSync(opts.folder).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        return refuse('sessions:create', 'folder is not a directory', {
          cardId: opts.cardId,
          folder: opts.folder,
        });
      }

      const prior = deps.persist.list().find((s) => s.id === opts.cardId);

      // ── what is already bound to this card? ──────────────────────────────
      //
      // ONE BINDING PER CARD (#187), and ONE LIVE SESSION per card (P2-E15-08).
      // Two passes, because the two answers are independent and doing them in
      // one made the first depend on the order of the Map: reap every dead
      // binding, THEN adopt the survivor if there is one. A single pass that
      // returns on the first running session would walk past a corpse sitting
      // behind it and leave it bound — unreachable while the invariant holds,
      // but this is the loop that ESTABLISHES the invariant, so it does not get
      // to assume it (review, #187).
      //
      // Why a card can have a dead session bound at all: a crashed session keeps
      // its record (the overlay reads it) and used to keep its binding, because
      // the binding is what a later `dropLive` follows to tear its
      // hooks/transcript/feed down — so dropping the binding alone would have
      // leaked all of that, which is the one-word fix #170 was offered and
      // declined. Reaping does the teardown, so there is nothing left to leak —
      // and, with one binding per card, nothing for `sessions:cards`' reverse
      // lookup to have to choose between. Having to choose WAS the old rule:
      // iterate in insertion order, last write wins. Correct, but unstated and
      // unpinned, which is what #187 was filed about.
      //
      // Revealing a card over a crashed session comes through here: the panel's
      // exited state is component-local, so a remount re-arms the lazy spawn
      // without going via `restartSelf`. It now ends in exactly the state the
      // explicit restart path leaves behind — `dropLive` then `create` — rather
      // than a near-miss of it with a dead session's transcript watch still
      // polling alongside the new one's.
      //
      // Pass 1 — reap. Iterates a COPY: `tearDownLive` deletes as it goes, and
      // on the spawn path that is not a place to be relying on the exact
      // tolerances of Map iteration.
      for (const [liveId, cid] of [...cardOfLive]) {
        if (cid !== opts.cardId || isRunning(liveId)) continue;
        // FAIL OPEN (P6). A throw anywhere in the teardown chain would come out
        // of this handler, and the renderer reads a rejected `sessions:create`
        // as "spawn failed" and paints the dead-session overlay — so a bug in
        // tearing the LAST session down would become "this card can never start
        // again". Starting with a half-reaped corpse behind us is strictly
        // better than a card that cannot start. `SessionManager.remove` makes
        // the same argument for its own transport teardown.
        //
        // Since #219 the guarantee lives INSIDE `tearDownLive`, which isolates
        // every step and cannot throw — a stronger promise than this catch ever
        // made, because it also covers the steps this one used to skip. The
        // catch stays as the outer backstop: it is six lines, it is the boundary
        // the P6 argument is actually about, and without it the spawn path's
        // fail-open behaviour would rest entirely on the internal discipline of
        // a function edited somewhere else. It is not expected to fire.
        try {
          tearDownLive(liveId);
        } catch (err) {
          log.warn('reaping a dead session failed; starting the new one anyway', {
            cardId: opts.cardId,
            sessionId: liveId,
            error: String(err),
          });
        }
      }
      // Pass 2 — adopt. A card's panel used to mount exactly once per live
      // session, so create() could assume it was being asked to spawn; hiding a
      // card unmounts it and revealing it mounts it again over a session that is
      // still running, and spawning a second claude for one card would leave an
      // orphan PTY nothing can reach.
      //
      // LIVENESS, not mere existence. A dead session KEEPS its record, so
      // adopting on "the manager knows it" would hand the card a corpse and no
      // way back: the panel would show a live-looking adoption over a process
      // that has already gone. It is exactly the "has a record" mistake #187
      // fixed elsewhere, and it deserved to be made once, not three times.
      //
      // Pass 1 used to be able to leave one behind: it fails open, and before
      // #219 a teardown that threw halfway skipped its own `unbindLive`, so the
      // corpse was still bound when this loop ran. `tearDownLive` now unbinds
      // whatever else fails, which makes that state unreachable rather than
      // merely handled — so this guard is now the backstop for the invariant
      // rather than a check some live path still trips.
      for (const [liveId, cid] of cardOfLive) {
        if (cid !== opts.cardId) continue;
        const running = runningRecord(liveId);
        if (!running) continue;
        log.info('session already live for card, adopting', { sessionId: liveId, cardId: opts.cardId });
        return {
          ...running,
          cardId: opts.cardId,
          priorUsage: prior?.usage,
          priorModel: prior?.model,
          autonomy: prior?.autonomy ?? running.autonomy,
          taskLabel: prior && visibleTaskLabel(prior, deps.autoLabels()),
        };
      }
      let title = (prior?.identity.title ?? (typeof opts.title === 'string' ? opts.title : opts.folder)).slice(0, 120);
      // a second session in the same folder would read IDENTICALLY in the
      // rail/grid (Dan round 4) — suffix new cards with the first free -N.
      // Renames stay free-form; existing cards keep their titles.
      if (!prior) {
        const taken = new Set(deps.persist.list().map((s) => s.identity.title.toLowerCase()));
        if (taken.has(title.toLowerCase())) {
          let n = 2;
          while (taken.has(`${title}-${n}`.toLowerCase())) n++;
          title = `${title}-${n}`.slice(0, 120);
        }
      }
      // ASK the provider what this session start involves; do not assume Claude
      // (P2-E15-01, §5.3). Everything Claude-shaped that used to be inline —
      // the provider id, hook settings, the transcript root, resume
      // eligibility — is a declared capability now.
      const plan = planSessionStart(
        {
          capabilitiesOf: deps.capabilitiesOf,
          isRegistered: deps.isRegisteredProvider,
          defaultProviderId: deps.defaultProviderId,
          folder: opts.folder,
          prior: {
            providerId: prior?.identity.providerId,
            nativeSessionId: prior?.nativeSessionId,
            // the ancestors this card forked from, so a resume that never got a
            // turn can fall back to the conversation that is really there (#484)
            nativeSessionLineage: prior?.nativeSessionLineage,
          },
          // Only read when the chain came up empty and the provider offers to
          // look — every id every card points at, heads and ancestors alike, so
          // the search cannot hand back a conversation someone else is in. The
          // plan splits this card's own ids back out of it.
          //
          // Safe to read as one synchronous snapshot: nothing yields between the
          // plan and the `persist.upsert` below, so two orphaned cards in the
          // same folder cannot both be told about the same conversation.
          claimedNativeIds: () => deps.persist.list().flatMap((s) => resumeCandidates(s)),
          // a degraded capability is never silent — the card still starts. A
          // callback rather than reading plan.warnings: two of the decisions
          // are lazy and fire long after this line.
          onDegraded: (reason) => log.warn('session start degraded', { cardId: opts.cardId, reason }),
        },
        hooks
      );
      const identity = {
        title,
        folder: opts.folder,
        providerId: plan.providerId,
        // stable across resumes: reuse the card's assigned accent/badge
        accentColor: prior?.identity.accentColor ?? assignAccent(manager.list().map((s) => s.identity.accentColor ?? '')),
        langBadge: prior?.identity.langBadge ?? detectProjectType(opts.folder),
      };

      // an existing card keeps its autonomy across resumes; a brand-new card
      // uses whatever the titlebar chip sent (so the chip only affects NEW
      // sessions, never silently changes a running one)
      const autonomy = prior?.autonomy ?? opts.autonomy;

      // WHICH TRANSPORT THIS SPAWN ASKS FOR, most specific first:
      //
      //  1. the CARD's own stored choice (P2-E18-08b) — an explicit answer
      //     from the user, and it wins over everything, including Terminal;
      //  2. the env escape hatch, which predates the setting and can now
      //     force EITHER transport (#381);
      //  3. Direct, the default for a card that has never chosen (#381).
      //
      // Absence in the record is "never chose", not "chose Terminal": we do
      // not write the default onto the card, so a card follows whatever the
      // default is at the time it starts. That is what makes this one line
      // move every untouched card, which is the point of the issue.
      //
      // The adapter still has the final say — it answers in the recipe, and
      // one that cannot speak stream-json returns a PTY recipe we honour.
      //
      // Resolved HERE, above the trust step, because two decisions now read it
      // and they must not be able to disagree: the trust pre-write (below) and
      // the spawn itself. `sessions:cards` reports the same expression for the
      // same reason (#397).
      const spawnTransport = prior?.transport ?? deps.preferredTransport?.() ?? DEFAULT_SESSION_TRANSPORT;

      // Preparing the folder is the PROVIDER's business (§5.9 trust is Claude's
      // `~/.claude.json`); a provider that has never heard of it must not have
      // it written on its behalf.
      //
      // AND ONLY WHEN A PROMPT COULD ACTUALLY HAPPEN (#397). `ensureTrusted`
      // writes `hasTrustDialogAccepted: true` into the user's real
      // `~/.claude.json` — a permanent edit to a file that outlives the app —
      // and its entire purpose is to pre-empt the question Claude Code would
      // otherwise ask in its TUI. On the Direct transport there is no TUI and
      // no question: measured at the CLI three times now (#384 twice, and the
      // #397 probe on 2026-08-13 against claude 2.1.226), a stream-json session
      // in a never-trusted folder simply runs — no prompt, project settings
      // load, project hooks fire, and the CLI records nothing about the folder
      // itself. So on Direct the write bought nothing and cost the user the
      // only thing the trust chip governs: it accepted the folder for good,
      // before they could ever be asked, and the manual's "open it in Terminal
      // mode the first time" workflow could not be reached afterwards.
      //
      // Gated on the ASKED-FOR transport rather than the one the adapter
      // finally resolves, because the write has to land BEFORE the spawn — by
      // the time a recipe exists, the CLI is already running. The two differ
      // only for an adapter that cannot speak stream-json and downgrades to a
      // PTY (only the fake providers today, both behind the test/e2e gate);
      // such a session would prompt in its terminal and get answered by hand,
      // which is the fail-open direction.
      if (spawnTransport === 'pty' && deps.autoTrust() && plan.ensureTrusted && !plan.ensureTrusted(opts.folder)) {
        log.warn('auto-trust failed — the provider may prompt in the terminal', {
          cardId: opts.cardId,
          folder: opts.folder,
        });
      }
      const canResume = !!plan.resumeSessionId;
      // THE SPAWN ITSELF, and the last thing here that can fail (#347).
      //
      // `SessionManager.create` throws for a provider adapter it does not have,
      // a transport it cannot resolve, and a `spawn` that fails — all three
      // deliberately, and all three are correct for a main-process caller. They
      // are wrong for the renderer, which never sees the message: the broker
      // does not catch, so the reason went to Electron's stderr and the card
      // showed a bare "Session ended". `error` and not `warn`, unlike the
      // validation refusals above: those are input we declined, this is a start
      // that should have worked. `error` is what makes it look for the cause.
      let record: SessionRecord;
      try {
        record = manager.create(identity, {
          // no hook capability = nothing injected and no token registered
          settingsFor: plan.buildSettings,
          // ...and the same absence means there is nothing to give back if the
          // start throws. The pair travels together (#470).
          releaseSettingsFor: plan.releaseSettings,
          autonomy,
          resumeSessionId: plan.resumeSessionId,
          // Resolved above the trust step — see `spawnTransport` for the
          // precedence and why it is one value rather than two.
          transport: spawnTransport,
        });
      } catch (err) {
        // The manager adds no record when spawn fails ("no orphan record: it was
        // never added"), and nothing is bound until `bindLive` below, so there
        // is nothing to unwind here.
        log.error('sessions:create could not start the session', {
          cardId: opts.cardId,
          folder: opts.folder,
          provider: identity.providerId,
          error: String(err),
        });
        return null;
      }
      bindLive(record.id, opts.cardId);
      // A provider with no transcripts is never watched at all — the session is
      // a terminal and nothing more, which is what §5.3 promises degrading
      // looks like. Otherwise pass the resumed conversation id, so the watcher
      // may adopt ITS OWN pre-existing transcript (and replay history into the
      // Session view).
      if (plan.transcriptsRoot !== undefined) {
        const watching = transcripts.watch(record.id, {
          cwd: opts.folder,
          nativeSessionId: plan.resumeSessionId,
          projectsRoot: plan.transcriptsRoot,
          // A stream session's Feed comes from its typed messages (P2-E18-10),
          // so the transcript must not derive blocks for it as well — the two
          // sources would interleave and every block would appear twice. The
          // watch itself stays: usage totals, the native id for --resume, and
          // the drift detector are all still wanted, and the CLI writes the
          // JSONL in stream mode too (S-10).
          deriveFeed: record.transport !== 'stream',
          // Undefined for a provider that declares no `titles` capability, and
          // the watcher then inspects no line for one — "starts no title watch
          // at all" (P2-E7-06). Not conditional on the transport: the CLI
          // writes the same JSONL in stream mode (S-10), and unlike the Feed
          // there is no second source of titles to collide with.
          readTitle: plan.readTitle,
        });
        // the watcher refuses a root it cannot poll safely. Say so against the
        // CARD — a warning keyed by a live session id, in the transcripts log,
        // is not something anyone can connect to "the Session tab is empty".
        if (!watching) {
          log.warn('provider declares transcripts but the root was refused', {
            cardId: opts.cardId,
            root: plan.transcriptsRoot,
          });
        }
        // ...which leaves a RESUMED stream session with no source of history at
        // all, and that is #395: `--resume` restores the model's context and
        // re-sends none of it, the line above forbids the transcript from
        // deriving, and the card opens blank as if it had been wiped. Replay the
        // conversation into the Feed once, here, from the same JSONL the
        // watcher would have read.
        //
        // HERE, and not later, is the seam: nothing has yielded to the event
        // loop since the spawn, so `StreamFeed` has been offered no message for
        // this session and cannot be. Everything on disk is numbered below
        // everything the stream will say — no duplicate at the join, and no gap.
        //
        // Gated on `watching` as well: the watcher refuses a root it cannot
        // poll SAFELY (a relative path it would crawl from the process cwd —
        // §5.29's boundary check, sitting there because Phase 4 makes that
        // string third-party). Reading a transcript out of a root the host has
        // just declared unusable would make the refusal mean two different
        // things on two paths.
        if (watching && record.transport === 'stream' && plan.resumeSessionId && deps.streamFeed) {
          replayResumedHistory(deps.streamFeed, log, {
            sessionId: record.id,
            projectsRoot: plan.transcriptsRoot,
            folder: opts.folder,
            nativeSessionId: plan.resumeSessionId,
          });
        }
      }
      // SPREAD `prior` FIRST, then override only what this start actually
      // decides. This used to rebuild the record field by field, and every
      // PersistedSession field added afterwards had to be remembered here — so
      // `transport` was silently dropped on EVERY session start, including the
      // one at app launch, and the Direct-mode setting could not survive a
      // relaunch (#153 follow-up, found by Dan).
      //
      // Same defect shape as `reason` vanishing from the approval queue earlier
      // the same day: field-by-field copying makes a NEW field a decision,
      // which is good, and a FORGOTTEN field silent, which is the cost. Spread
      // then override pays that cost the other way round — a field is kept
      // unless someone means to change it, and forgetting is visible rather
      // than silent.
      deps.persist.upsert({
        ...prior,
        id: opts.cardId,
        identity,
        layoutSlot: prior?.layoutSlot ?? 0,
        // THE LINK IS NEVER DESTROYED HERE (#484).
        //
        // This line used to be `nativeSessionId: plan.resumeSessionId` —
        // "don't keep a stale id we just declined to resume". It was the wrong
        // conclusion from the right observation: a declined resume means we
        // could not resume that id THIS TIME, and the two reasons it can happen
        // are not the same. One is an id the CLI announced for a session that
        // never got a turn, so its transcript was never written; the other is a
        // `readdir` that failed for a second because something else had the
        // directory open. Writing `undefined`
        // turned either into a permanent severance — the card started fresh and
        // the only pointer to a conversation still sitting on disk was gone.
        //
        // So: resume resolved to an id (the head, an ancestor, or an adopted
        // conversation) → that id becomes the head and everything else drops
        // into the chain beneath it. Nothing resolved → the card keeps exactly
        // what it had, and the fresh session's `onNativeSessionId` will push
        // that down the chain when it announces its own id.
        ...(plan.resumeSessionId
          ? recordNativeId(prior, plan.resumeSessionId)
          : {
              nativeSessionId: prior?.nativeSessionId,
              nativeSessionLineage: prior?.nativeSessionLineage,
            }),
        suspendedAt: prior?.suspendedAt ?? '',
        autonomy,
        // an existing card keeps its membership; a new card takes the caller's
        groupId: prior?.groupId ?? (typeof opts.groupId === 'string' ? opts.groupId : undefined),
      });
      log.info('session started for card', {
        sessionId: record.id,
        cardId: opts.cardId,
        folder: opts.folder,
        resumed: canResume,
        // `stored` is the ordinary resume; `lineage` and `adopted` are
        // recoveries, and which one it was is the difference between "came back
        // in the right conversation" and "came back in a plausible one" (#484)
        resumedVia: plan.resumedVia,
      });
      // seed the card's display from the persisted record so nothing reads
      // empty while resuming
      return {
        ...record,
        cardId: opts.cardId,
        priorUsage: prior?.usage,
        priorModel: prior?.model,
        autonomy,
        taskLabel: prior && visibleTaskLabel(prior, deps.autoLabels()),
      };
    }
  );

  broker.handle('sessions:list', () => manager.list());

  // composer slash-command autocomplete (E10-07): builtins + the session
  // folder's and user's own commands/skills. Scan errors fail open in the
  // scanner; an unknown live id just returns nothing.
  //
  // In stream mode the CLI advertises its REAL list (P2-E18-09), so that
  // becomes the set and the scan becomes a description-and-provenance lookup
  // over it. The scan still runs either way: it is what knows that `/startup`
  // is a project skill called "Load project context", which `system:init` —
  // being names-only — cannot tell us.
  //
  // Three states, and the middle one is normal rather than exceptional: no
  // stream list at all (a PTY session, or a stream session that has not sent
  // its first prompt yet — the CLI emits nothing at spawn, S-11) falls back to
  // the curated list; a stream list replaces it.
  broker.handle('sessions:slashCommands', async (_e, liveId: string) => {
    if (typeof liveId !== 'string') return [];
    const rec = manager.get(liveId);
    if (!rec) {
      // An empty answer renders an empty popup, which looks exactly like a popup
      // that never opened — say which it was (#145). `warn`, not `debug`: debug
      // is off unless SWITCHBOARD_DEBUG names this subsystem, which nothing in
      // CI or a default install sets, so a debug line here would be written
      // exactly never — and this is a should-not-happen, not routine chatter.
      log.warn('slash commands requested for an unknown session', { sessionId: liveId });
      return [];
    }
    // The scan fails open internally, but a rejection here would now throw away
    // a CLI list we already hold — belt and braces, and P6 for free.
    const known = await deps
      .slashCommands(rec.identity.folder, rec.identity.providerId)
      .catch((err) => {
        log.warn('slash-command scan failed', { sessionId: liveId, error: String(err) });
        return [] as SlashCommand[];
      });
    const cli = streamCommands?.commandsFor(liveId);
    // An EMPTY advertised list falls back too, not just a missing one. The
    // store keeps the two apart because they are different facts; here they
    // deserve the same answer. The done-when is "falls back … rather than
    // showing nothing", and a popup with nothing in it is nothing in it
    // whichever fact produced it — while a real CLI always has builtins, so an
    // empty list means something went wrong upstream far more often than it
    // means this session genuinely has no commands.
    return cli?.length ? commandsFromCli(cli, known) : known;
  });

  // repo/folder auto-group keys (E12-05): same key -> same emergent group.
  // Cached per folder; a repo root beats the folder path so sibling checkouts
  // of one repo (subdirs) share a key.
  const autoKeyCache = new Map<string, string>();
  const autoKeyFor = async (folder: string): Promise<string> => {
    const norm = folder.replace(/[\\/]+$/, '').toLowerCase();
    const hit = autoKeyCache.get(norm);
    if (hit) return hit;
    let key = norm;
    try {
      const root = await deps.repoRoot(folder);
      if (root) key = root.replace(/[\\/]+$/, '').toLowerCase();
    } catch {
      /* not a repo / no git — folder path is the key */
    }
    autoKeyCache.set(norm, key);
    return key;
  };

  // joined view for the rail: every persisted card, with its live status if
  // running or 'suspended' if restored-but-not-yet-resumed (E7-05)
  //
  // KEEP THE SNAPSHOT SYNCHRONOUS. The renderer drops a `cards` response that a
  // later-issued one has already overtaken (#251, lib/latest-wins), and that
  // guard is only meaningful because "issued later" implies "read later" —
  // which holds only while `manager.list()`, `deps.persist.list()` and every
  // `rec.status` below are read in the tick the invoke arrives. The single
  // `await` is `autoKeyFor`, and it is evaluated AFTER `status` in the object
  // literal. Hoist any resolution above those reads and the renderer's ordering
  // guard silently degrades to a coin flip, with every test still green.
  broker.handle('sessions:cards', async () => {
    const live = manager.list();
    // The reverse of `cardOfLive`, and no longer a tie-break: a card holds ONE
    // binding since #187, because `sessions:create` reaps a dead session before
    // binding the one that replaces it.
    //
    // The single exception is that the reap fails open, so a corpse whose
    // teardown threw stays bound beside the live session. Last-wins still picks
    // the right one there, and that is now provable rather than lucky:
    // `bindLive` has exactly one call site, at the END of `sessions:create`, so
    // a replacement is always inserted AFTER the corpse it replaces. What was
    // wrong before #187 was not the outcome — it was that the outcome rested on
    // an emergent property of a Map nobody had written down.
    const liveByCard = new Map<string, string>(); // cardId -> liveId
    for (const [liveId, cardId] of cardOfLive) liveByCard.set(cardId, liveId);
    return Promise.all(
      deps.persist.list().map(async (card) => {
        const liveId = liveByCard.get(card.id);
        const rec = liveId ? live.find((r) => r.id === liveId) : undefined;
        return {
          cardId: card.id,
          // the rail shows (and renames) the session title; the task label is a
          // separate card-only detail, so they don't shadow each other
          title: card.identity.title,
          folder: card.identity.folder,
          accent: card.identity.accentColor,
          badge: card.identity.langBadge,
          status: rec?.status ?? 'suspended',
          liveId,
          groupId: card.groupId,
          // The transport this card's next session will be ASKED for (#397), by
          // the SAME precedence `sessions:create` applies (card > env override
          // > default). Read it off `card`, above the await below, so it comes
          // from the same synchronous snapshot as everything else here.
          //
          // Deliberately not `rec?.transport`, which is what a running session
          // happens to be on: the renderer's only consumer asks "can Claude
          // Code ever raise a trust question for this card?", and trust is
          // consulted at SPAWN time, so the transport that answers it is the
          // one the next spawn will use. When a pending transport change is
          // outstanding those two differ, and the pending one is the honest
          // answer — see `lib/trust-reach.ts`.
          //
          // ASKED FOR, not resolved: an adapter that cannot speak stream-json
          // downgrades the request to a PTY (`session-manager.ts`, and only the
          // fake providers do it today). Reading `capabilitiesOf` here would
          // make it exact; it is not worth the coupling until a real adapter
          // does it. `sessions:create` gates its trust pre-write on the same
          // asked-for value, so the chip and the write agree by construction.
          transport: card.transport ?? deps.preferredTransport?.() ?? DEFAULT_SESSION_TRANSPORT,
          autoKey: await autoKeyFor(card.identity.folder),
          // Through the switch (P2-E7-06): a suppressed auto label must not
          // reach the renderer at all, or it renders in the rail for a
          // screen-share to read.
          taskLabel: visibleTaskLabel(card, deps.autoLabels()),
        };
      })
    );
  });

  // cards with a persisted record — the renderer keeps these on boot, prunes
  // any restored panel that has no record (truly gone)
  broker.handle('sessions:knownCards', () => deps.persist.list().map((s) => ({ cardId: s.id, identity: s.identity })));

  // kill the live session under a card, keeping the persisted record. A card
  // holds at most one binding since #187, so this loop is really a lookup — it
  // stays a loop because that is the version that keeps working if the
  // invariant is ever broken, and deleting the entry the iterator is standing
  // on is well-defined.
  const dropLiveForCard = (cardId: string): void => {
    for (const [liveId, cid] of cardOfLive) if (cid === cardId) tearDownLive(liveId);
  };

  // close a card: kill its live session AND forget it (won't come back)
  broker.handle('sessions:closeCard', (_e, cardId: string) => {
    dropLiveForCard(cardId);
    deps.persist.remove(cardId);
  });

  // drop only the live session (restart): keep the record so it can respawn
  broker.handle('sessions:dropLive', (_e, cardId: string) => dropLiveForCard(cardId));

  // per-card transport (P2-E18-08b). ACCEPTED always, applied on the NEXT
  // spawn — exactly like `sessions:setAutonomy` directly below, which has the
  // identical constraint (the CLI cannot change either on a live session).
  //
  // The first version REFUSED while a session was live. That was wrong twice
  // over, and Dan hit both within minutes of it shipping: it contradicted the
  // control immediately above it in the same menu, and it told the user to
  // "stop this session first" when a LIVE session has no stop control at all —
  // `restartSelf` only drops an already-dead one. A dead end dressed as a
  // safety check.
  //
  // The concern that motivated the refusal — the card's stored answer
  // disagreeing with the running process — is real, and it is answered by
  // SAYING SO (`pending: true` -> "applies when this session restarts") rather
  // than by refusing. Autonomy has carried exactly that trade since E10-05.
  broker.handle('sessions:setTransport', (_e, cardId: string, transport: string) => {
    if (typeof cardId !== 'string') return { ok: false, reason: 'unknown-card' };
    if (transport !== 'pty' && transport !== 'stream') return { ok: false, reason: 'bad-value' };
    const prior = deps.persist.list().find((s) => s.id === cardId);
    if (!prior) return { ok: false, reason: 'unknown-card' };
    deps.persist.upsert({ ...prior, transport });
    // is a session running under this card right now? then the change is
    // PENDING, and the UI has to say that instead of implying it took effect.
    // This asked whether the manager HAD a record until #187 — and a crashed
    // session keeps its record for the overlay, so after a crash the menu told
    // the user their change was queued behind a process that no longer existed.
    // Hence one shared `isRunning`, rather than a second spelling of it here.
    let pending = false;
    for (const [liveId, cid] of cardOfLive) {
      if (cid === cardId && isRunning(liveId)) pending = true;
    }
    log.info('card transport changed', { cardId, transport, pending });
    // A card's transport is now something the SHELL renders, not just the card
    // (#397: the trust chip greys itself out while nothing will spawn on the
    // Terminal), so this write has to be announced.
    //
    // It is the exception the note above `cardsChanged` allows for. That note
    // says a renderer-initiated change to the persisted half needs no push
    // because "the caller refreshes at its own call site" — true of renaming a
    // card, whose caller is the rail. It is NOT true here: the caller is the
    // grid's ⋯ menu, which has no route to the rail's refresh. That is the same
    // gap #170 closed for the live half, and leaving it open would mean
    // switching a session to Terminal mode did not wake the chip up until some
    // unrelated event happened to refresh the list.
    cardsChanged();
    return { ok: true, pending };
  });

  // per-card autonomy (E10-05): persists to the record; the CLI can't change
  // mode mid-flight, so it applies on the NEXT spawn/resume of this card
  broker.handle('sessions:setAutonomy', (_e, cardId: string, autonomy: string) => {
    if (typeof cardId !== 'string') return;
    if (!['plan', 'ask', 'auto-edit', 'full-auto'].includes(autonomy)) return;
    const prior = deps.persist.list().find((s) => s.id === cardId);
    if (prior) deps.persist.upsert({ ...prior, autonomy: autonomy as PersistedSession['autonomy'] });
  });

  // Freeform task label for a card (E7-03), persisted across restarts — and
  // since P2-E7-06 the act that PINS it: typing makes the label the user's and
  // no later `ai-title` may touch it, clearing the field hands it back to auto.
  // `typedLabel` owns both halves of that rule.
  broker.handle('sessions:setTaskLabel', (_e, cardId: string, label: string) => {
    if (typeof cardId !== 'string' || typeof label !== 'string') return;
    const prior = deps.persist.list().find((s) => s.id === cardId);
    if (!prior) return;
    const typed = typedLabel(label);
    deps.persist.upsert({ ...prior, ...typed });
    // Echoed even though the renderer initiated it: a card's label renders in
    // the grid header AND the rail row, and only one of the two was the caller.
    publishLabel(cardId, typed.taskLabel);
  });

  // The auto-label switch (P2-E7-06, §5.11 litmus #4). It lives HERE rather
  // than beside `settings:setAutoTrust` in `index.ts` because flipping it has
  // to move what is on screen, and the label plumbing that does that is this
  // module's.
  broker.handle('settings:getAutoLabels', () => deps.autoLabels());
  broker.handle('settings:setAutoLabels', (_e, on: boolean) => {
    deps.setAutoLabels(on === true);
    const enabled = deps.autoLabels();
    // Re-publish EVERY card's label under the new setting: off takes the auto
    // ones off screen, on puts them straight back from a value we never
    // deleted. Waiting for the next `ai-title` line would work — the CLI
    // re-emits every turn — but "every turn" is minutes on an idle session, and
    // a switch you flip that appears to do nothing is a switch nobody trusts.
    //
    // Every card, not every LIVE one. A suspended card still has a panel and a
    // rail row, both showing the label it was left with, and neither has a live
    // session behind it — so walking `cardOfLive` would leave exactly the cards
    // nobody is looking at still displaying a phrase from a prompt, which is
    // the one thing this switch exists to prevent.
    for (const card of deps.persist.list()) {
      publishLabel(card.id, visibleTaskLabel(card, enabled));
    }
    return enabled;
  });

  // rename a card by cardId (works for suspended cards too) — updates the
  // persisted title and the live session if one is running
  broker.handle('sessions:renameCard', (_e, cardId: string, title: string) => {
    if (typeof cardId !== 'string' || typeof title !== 'string') return;
    // A BLANK NAME IS NOT A RENAME (#294), and this is the half of that rule
    // that survives a restart. `manager.rename` already refuses one — but only
    // for the LIVE record, so an empty title reaching here still went into the
    // persisted store, where every reader downstream had to defend against it.
    // The guard belongs on both sides of the boundary anyway: the rail's is
    // what makes the field behave, this is what makes `''` impossible.
    const clean = title.trim().slice(0, 120);
    if (!clean) return;
    const prior = deps.persist.list().find((s) => s.id === cardId);
    if (prior) deps.persist.upsert({ ...prior, identity: { ...prior.identity, title: clean } });
    for (const [liveId, cid] of cardOfLive) if (cid === cardId) manager.rename(liveId, clean);
  });

  // Rename by LIVE id. Nothing in the renderer calls this yet — the rail and the
  // palette rename by CARD id, above — which is exactly why it is the channel
  // #347 is really about: it validated nothing, so a non-string title reached
  // `title.trim()` (a TypeError) and an unknown id reached `mustGet` (a throw),
  // and the first caller written against it would have inherited both over an
  // uncaught `.then`. It answers `null` for a rename that did not happen and the
  // record for one that did (#347).
  broker.handle('sessions:rename', (_e, liveId: string, title: string) => {
    if (typeof liveId !== 'string') return refuse('sessions:rename', 'session id must be a string');
    if (typeof title !== 'string')
      return refuse('sessions:rename', 'title must be a string', { sessionId: liveId });
    // A blank title is not a refusal to warn about: `manager.rename` drops it
    // and says so, the same rule `sessions:renameCard` applies (#294).
    manager.rename(liveId, title);
    const r = manager.get(liveId);
    // persist the rename so it survives a restart
    const cardId = cardOfLive.get(liveId);
    if (cardId && r) {
      const prior = deps.persist.list().find((s) => s.id === cardId);
      if (prior) deps.persist.upsert({ ...prior, identity: { ...prior.identity, title: r.identity.title } });
    }
    // `null`, not `undefined`, for a session that is not there: "nothing
    // changed" is then one value across the whole non-throwing contract rather
    // than two that a caller has to test for separately (#347).
    return r ?? null;
  });

  // attach: replay scrollback, then stream. Returns the snapshot + this
  // attach's epoch (see src/shared/ipc/pty.ts for what the epoch is for).
  //
  // Subscribing and snapshotting MUST stay in one synchronous tick — do not
  // introduce an await between them. That is what makes the handover exact for
  // THIS epoch: every byte up to this instant is in the snapshot, every byte
  // after it arrives on `pty:data:<id>` stamped with this epoch. An await here
  // would reopen the hole #117 closed from the renderer side, and the renderer
  // relies on that split to know its buffered chunks belong AFTER the snapshot.
  broker.handle('pty:attach', (_e, id: string): PtyAttachment | null => {
    const s = ptys.get(id);
    if (!s) return null;
    feeds.get(id)?.(); // idempotent re-attach
    const epoch = ++ptyEpoch;
    const off = s.onData((d) => send(`pty:data:${id}`, { epoch, d } satisfies PtyChunk));
    feeds.set(id, off);
    // a bare decode is safe here: RingBuffer guarantees its snapshot holds no
    // partial CHARACTER at either end (#205), so there is no split for a
    // StringDecoder to hold across — and nothing it could flush that wouldn't
    // be the `U+FFFD` we are avoiding. Escape sequences are handled separately
    // — once anything has been evicted the snapshot starts at a safe RESUME
    // point (#211) instead of mid-sequence, so a replay doesn't open with
    // residue like `38;5;10m`. One documented gap: a snapshot holding no ESC
    // and no newline at all is left as it was.
    return { epoch, snapshot: s.scrollback.snapshot().toString('utf8') };
  });

  broker.on('pty:detach', (_e, id: string) => {
    feeds.get(id)?.();
    feeds.delete(id);
  });

  broker.on('pty:input', (_e, id: string, data: string) => {
    // Keystrokes are forwarded to the PTY but do NOT drive status — only the
    // CLI's own hooks do (a keystroke is not a submitted prompt).
    ptys.get(id)?.write(data);
  });

  broker.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    ptys.get(id)?.resize(cols, rows);
  });

  return {
    labelFor,
    // The live -> card binding, read-only, for the one consumer OUTSIDE the
    // renderer that needs it: the notification rules engine (P2-E14-03). A
    // rule is scoped to a CARD (it has to survive the session it was written
    // for), while a feed event carries the LIVE id — and this map is the only
    // place that join exists. Returned rather than exported as a module-level
    // map so it stays one-per-registration, like everything else in here.
    cardIdFor: (liveSessionId: string) => cardOfLive.get(liveSessionId) ?? null,
    // The other two consumers outside the renderer, both P2-E14-04's toast:
    // what is being asked, and the one function that answers it.
    pendingPermissionFor,
    decidePermission,
  };
}
