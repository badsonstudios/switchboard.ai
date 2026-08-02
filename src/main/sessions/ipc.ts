// Session/PTY IPC surface (P1-E3-02): the renderer's only door into the
// session core. Hidden panes are ingest-only (S-07): PTY bytes always land in
// the main-process ring buffer; the renderer gets a live feed ONLY while a
// pane is attached, and a scrollback snapshot replay on attach.
import { BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import { SessionManager } from './session-manager';
import { PtyService } from '../pty/pty-service';
import { StreamPermissions } from './stream-permissions';
import { StreamCommands } from './stream-commands';
import { StreamFeed } from '../feed/stream-feed';
import { HookListener } from '../hooks/hook-listener';
import { IpcBroker } from '../ipc/broker';
import { Channel } from '../../shared/ipc/capabilities';
import type { PtyAttachment, PtyChunk } from '../../shared/ipc/pty';
import type { ProviderCapabilities } from '../extensibility/contributions';
import { TranscriptWatcher } from '../transcripts/watcher';
import { Logger } from '../log/logger';
import { assignAccent, detectProjectType } from './identity';
import { EventFeed } from '../events/feed';
import { planSessionStart } from './start-plan';
import { PersistedSession } from '../workspace/store';
import { commandsFromCli, SlashCommand } from '../../shared/slash-commands';

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
  /** Which transport a NEW session should ask its adapter for (P2-E18-08a).
   *  Absent = the adapter's default, i.e. the PTY. Replaced by the persisted
   *  per-session setting in P2-E18-08b (#149). */
  preferredTransport?: () => 'pty' | 'stream' | undefined;
}

export function registerSessionIpc(deps: SessionIpcDeps): void {
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
    if (existing) deps.persist.upsert({ ...existing, nativeSessionId: nativeId });
  });

  // outbound goes through the broker too: it checks what the TARGET window
  // holds, which is a no-op for first-party and the enforcement point a
  // Phase-4 plugin needs (P2-E15-04)
  const send = (channel: Channel, payload: unknown): void => {
    deps.broker.send(deps.getWindow(), channel, payload);
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
  manager.onSessionExit((e) => send('sessions:exited', e));
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
    // keep the last real model if this snapshot hasn't seen a model line yet
    if (prior) deps.persist.upsert({ ...prior, usage: snap.usage, model: snap.model ?? prior.model });
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
  broker.handle('sessions:decidePermission',
    (_e, requestId: string, decision: string, reason?: string) => {
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
    }
  );
  // Submit a prompt on the session's own transport (P2-E18-08a). Returns
  // false for a PTY session, whose composer route is a bracketed paste and a
  // delayed CR — a genuinely different operation. The renderer tries this
  // first and falls back, which is how it stays transport-ignorant until
  // P2-E18-08b gives the user the choice.
  broker.handle('sessions:submitPrompt', (_e, sessionId: string, text: string) => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') return false;
    return manager.submitPrompt(sessionId, text);
  });
  // Interrupt the running turn (#154). Returns false for a PTY session, whose
  // interrupt is an Esc keystroke — the renderer falls back, exactly as it does
  // for submitPrompt, and so never has to know which transport it is on.
  broker.handle('sessions:interrupt', (_e, sessionId: string) => {
    if (typeof sessionId !== 'string') return false;
    return manager.interrupt(sessionId);
  });
  // "Allow all (this session)": answered at the SERVER from now on — no
  // hold, no needs-permission event, no beep (review P2 #19, Dan round 4)
  broker.handle('sessions:allowAllSession', (_e, liveId: string) => {
    if (typeof liveId === 'string') hooks.setAllowAll(liveId);
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
      // validate untrusted renderer input (§5.29)
      if (!opts || typeof opts.cardId !== 'string' || typeof opts.folder !== 'string') {
        throw new Error('cardId and folder required');
      }
      let isDir = false;
      try {
        isDir = fs.statSync(opts.folder).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new Error('folder is not a directory');

      const prior = deps.persist.list().find((s) => s.id === opts.cardId);

      // ONE live session per card, always (P2-E15-08). A card's panel used to
      // mount exactly once per live session, so create() could assume it was
      // being asked to spawn; hiding a card unmounts it and revealing it mounts
      // it again over a session that is still running. Spawning a second claude
      // for one card would leave an orphan PTY nothing can reach.
      // `exitCode === null` is the liveness test — the field is `number | null`
      // and a running session carries null, NOT undefined (a probe caught that
      // the hard way: `!== undefined` matched every live session and adopted
      // none of them). A crashed session keeps its record so the card can show
      // the overlay, and must never be adopted.
      // a crashed session leaves its mapping behind; drop those on the way past
      // so "the live session for this card" never depends on Map ordering
      for (const [liveId, cid] of [...cardOfLive]) {
        if (cid !== opts.cardId) continue;
        const running = manager.get(liveId);
        if (!running || running.exitCode !== null) {
          if (!running) cardOfLive.delete(liveId);
          continue;
        }
        log.info('session already live for card, adopting', { sessionId: liveId, cardId: opts.cardId });
        return {
          ...running,
          cardId: opts.cardId,
          priorUsage: prior?.usage,
          priorModel: prior?.model,
          autonomy: prior?.autonomy ?? running.autonomy,
          taskLabel: prior?.taskLabel,
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
          prior: { providerId: prior?.identity.providerId, nativeSessionId: prior?.nativeSessionId },
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

      // Preparing the folder is the PROVIDER's business (§5.9 trust is Claude's
      // `~/.claude.json`); a provider that has never heard of it must not have
      // it written on its behalf.
      if (deps.autoTrust() && plan.ensureTrusted && !plan.ensureTrusted(opts.folder)) {
        log.warn('auto-trust failed — the provider may prompt in the terminal', {
          cardId: opts.cardId,
          folder: opts.folder,
        });
      }
      const canResume = !!plan.resumeSessionId;
      const record = manager.create(identity, {
        // no hook capability = nothing injected and no token registered
        settingsFor: plan.buildSettings,
        autonomy,
        resumeSessionId: plan.resumeSessionId,
        // Which transport to ASK for. The CARD's own choice wins (P2-E18-08b);
        // the env default is the escape hatch that predates the setting. The
        // adapter still has the final say — it answers in the recipe, and one
        // that cannot speak stream-json returns a PTY recipe we honour.
        transport: prior?.transport ?? deps.preferredTransport?.(),
      });
      cardOfLive.set(record.id, opts.cardId);
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
        // don't keep a stale id we just declined to resume — the fresh
        // session's onNativeSessionId will fill in the new one
        nativeSessionId: plan.resumeSessionId,
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
      });
      // seed the card's display from the persisted record so nothing reads
      // empty while resuming
      return {
        ...record,
        cardId: opts.cardId,
        priorUsage: prior?.usage,
        priorModel: prior?.model,
        autonomy,
        taskLabel: prior?.taskLabel,
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
  broker.handle('sessions:cards', async () => {
    const live = manager.list();
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
          autoKey: await autoKeyFor(card.identity.folder),
          taskLabel: card.taskLabel,
        };
      })
    );
  });

  // cards with a persisted record — the renderer keeps these on boot, prunes
  // any restored panel that has no record (truly gone)
  broker.handle('sessions:knownCards', () => deps.persist.list().map((s) => ({ cardId: s.id, identity: s.identity })));

  // kill the live session(s) under a card, keeping the persisted record
  const dropLiveForCard = (cardId: string): void => {
    for (const [liveId, cid] of cardOfLive) {
      if (cid !== cardId) continue;
      deps.feed.forget(liveId); // its event leaves the Events panel with it
      feeds.get(liveId)?.();
      feeds.delete(liveId);
      hooks.unregisterSession(liveId);
      transcripts.unwatch(liveId);
      // marks the kill intentional BEFORE tearing the process down, mirroring
      // kill()/restart(): otherwise onExit could see killRequested=false and
      // report a spurious `crashed` for an ordinary suspend/restart (review nit).
      // The transport teardown lives INSIDE remove() as of P2-E18-02 — this
      // used to call `ptys.remove(liveId)` here, which silently tears down
      // nothing for a session hosted on any transport but the PTY.
      // an unanswered control request leaves the CLI waiting for ever
      streamPermissions?.forgetSession(liveId, 'session closed');
      // the next session under this card gets its own list from its own CLI
      streamCommands?.forgetSession(liveId);
      // …and its own Feed blocks (P2-E18-10)
      deps.streamFeed?.forgetSession(liveId);
      manager.remove(liveId);
      cardOfLive.delete(liveId);
    }
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
    // PENDING, and the UI has to say that instead of implying it took effect
    let pending = false;
    for (const [liveId, cid] of cardOfLive) {
      if (cid === cardId && manager.get(liveId)) pending = true;
    }
    log.info('card transport changed', { cardId, transport, pending });
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

  // freeform task label for a card (E7-03), persisted across restarts
  broker.handle('sessions:setTaskLabel', (_e, cardId: string, label: string) => {
    if (typeof cardId !== 'string' || typeof label !== 'string') return;
    const prior = deps.persist.list().find((s) => s.id === cardId);
    if (prior) deps.persist.upsert({ ...prior, taskLabel: label.slice(0, 120) });
  });

  // rename a card by cardId (works for suspended cards too) — updates the
  // persisted title and the live session if one is running
  broker.handle('sessions:renameCard', (_e, cardId: string, title: string) => {
    if (typeof cardId !== 'string' || typeof title !== 'string') return;
    const clean = title.slice(0, 120);
    const prior = deps.persist.list().find((s) => s.id === cardId);
    if (prior) deps.persist.upsert({ ...prior, identity: { ...prior.identity, title: clean } });
    for (const [liveId, cid] of cardOfLive) if (cid === cardId) manager.rename(liveId, clean);
  });

  broker.handle('sessions:rename', (_e, liveId: string, title: string) => {
    manager.rename(liveId, title);
    const r = manager.get(liveId);
    // persist the rename so it survives a restart
    const cardId = cardOfLive.get(liveId);
    if (cardId && r) {
      const prior = deps.persist.list().find((s) => s.id === cardId);
      if (prior) deps.persist.upsert({ ...prior, identity: { ...prior.identity, title: r.identity.title } });
    }
    return r;
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
}
