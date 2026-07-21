// Session/PTY IPC surface (P1-E3-02): the renderer's only door into the
// session core. Hidden panes are ingest-only (S-07): PTY bytes always land in
// the main-process ring buffer; the renderer gets a live feed ONLY while a
// pane is attached, and a scrollback snapshot replay on attach.
import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'fs';
import { SessionManager } from './session-manager';
import { PtyService } from '../pty/pty-service';
import { HookListener } from '../hooks/hook-listener';
import { TranscriptWatcher } from '../transcripts/watcher';
import { Logger } from '../log/logger';
import { assignAccent, detectProjectType } from './identity';
import { EventFeed } from '../events/feed';
import { ensureFolderTrusted } from './trust';
import { conversationExists } from '../transcripts/watcher';
import { PersistedSession } from '../workspace/store';

export interface SessionIpcDeps {
  manager: SessionManager;
  ptys: PtyService;
  hooks: HookListener;
  transcripts: TranscriptWatcher;
  feed: EventFeed;
  log: Logger;
  getWindow: () => BrowserWindow | null;
  /** auto-trust the folder before spawning (default on; user picks folder) */
  autoTrust: () => boolean;
  /** persisted session cards (resume-on-focus across app restarts, §5.25) */
  persist: {
    list: () => PersistedSession[];
    upsert: (s: PersistedSession) => void;
    remove: (cardId: string) => void;
  };
  /** ~/.claude/projects root, for checking a resumable conversation exists */
  projectsRoot: string;
}

export function registerSessionIpc(deps: SessionIpcDeps): void {
  const { manager, ptys, hooks, transcripts, log } = deps;
  // per-session live-feed unsubscribers (attached panes only)
  const feeds = new Map<string, () => void>();
  // a card is the durable unit; the live session under it is ephemeral
  const cardOfLive = new Map<string, string>(); // liveSessionId -> cardId

  // when a session's native id is learned, persist it so the card can
  // --resume that conversation after an app restart
  manager.onNativeSessionId((liveId, nativeId) => {
    const cardId = cardOfLive.get(liveId);
    if (!cardId) return;
    const existing = deps.persist.list().find((s) => s.id === cardId);
    if (existing) deps.persist.upsert({ ...existing, nativeSessionId: nativeId });
  });

  const send = (channel: string, payload: unknown): void => {
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  manager.onStatusChange((change) => {
    send('sessions:status', change);
    const fe = deps.feed.ingest(change);
    if (fe) send('feed:event', fe);
  });
  manager.onSessionExit((e) => send('sessions:exited', e));
  transcripts.onUpdate((snap) => {
    send('sessions:usage', snap);
    // persist usage per card so the number survives a resume/restart
    const cardId = cardOfLive.get(snap.sessionId);
    if (!cardId) return;
    const prior = deps.persist.list().find((s) => s.id === cardId);
    // keep the last real model if this snapshot hasn't seen a model line yet
    if (prior) deps.persist.upsert({ ...prior, usage: snap.usage, model: snap.model ?? prior.model });
  });

  ipcMain.handle('feed:list', () => deps.feed.list());

  ipcMain.handle('sessions:isDirectory', (_e, p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

  ipcMain.handle('sessions:pickFolder', async () => {
    const win = deps.getWindow();
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

  // Spawn (or --resume) the live session for a card. cardId is the durable
  // key; identity (accent/title/badge) and the resumable conversation are
  // reused from the persisted record so they survive restarts.
  ipcMain.handle(
    'sessions:create',
    (
      _e,
      opts: {
        cardId: string;
        folder: string;
        title: string;
        autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto';
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
      const title = (prior?.identity.title ?? (typeof opts.title === 'string' ? opts.title : opts.folder)).slice(0, 120);
      const identity = {
        title,
        folder: opts.folder,
        providerId: 'claude-code',
        // stable across resumes: reuse the card's assigned accent/badge
        accentColor: prior?.identity.accentColor ?? assignAccent(manager.list().map((s) => s.identity.accentColor ?? '')),
        langBadge: prior?.identity.langBadge ?? detectProjectType(opts.folder),
      };

      // an existing card keeps its autonomy across resumes; a brand-new card
      // uses whatever the titlebar chip sent (so the chip only affects NEW
      // sessions, never silently changes a running one)
      const autonomy = prior?.autonomy ?? opts.autonomy;

      if (deps.autoTrust()) ensureFolderTrusted(opts.folder, log);
      // only --resume when a real conversation exists for that id; otherwise a
      // stale/empty id would make claude exit ("No conversation found") and
      // crash the card, so fall back to a fresh session
      const canResume =
        !!prior?.nativeSessionId &&
        conversationExists(deps.projectsRoot, opts.folder, prior.nativeSessionId);
      const record = manager.create(identity, {
        settingsFor: (id) => hooks.buildHookSettings(id),
        autonomy,
        resumeSessionId: canResume ? prior?.nativeSessionId : undefined,
      });
      cardOfLive.set(record.id, opts.cardId);
      transcripts.watch(record.id, { cwd: opts.folder });
      deps.persist.upsert({
        id: opts.cardId,
        identity,
        layoutSlot: prior?.layoutSlot ?? 0,
        // don't keep a stale id we just declined to resume — the fresh
        // session's onNativeSessionId will fill in the new one
        nativeSessionId: canResume ? prior?.nativeSessionId : undefined,
        suspendedAt: prior?.suspendedAt ?? '',
        usage: prior?.usage,
        model: prior?.model,
        autonomy,
        taskLabel: prior?.taskLabel,
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

  ipcMain.handle('sessions:list', () => manager.list());

  // joined view for the rail: every persisted card, with its live status if
  // running or 'suspended' if restored-but-not-yet-resumed (E7-05)
  ipcMain.handle('sessions:cards', () => {
    const live = manager.list();
    const liveByCard = new Map<string, string>(); // cardId -> liveId
    for (const [liveId, cardId] of cardOfLive) liveByCard.set(cardId, liveId);
    return deps.persist.list().map((card) => {
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
      };
    });
  });

  // cards with a persisted record — the renderer keeps these on boot, prunes
  // any restored panel that has no record (truly gone)
  ipcMain.handle('sessions:knownCards', () => deps.persist.list().map((s) => ({ cardId: s.id, identity: s.identity })));

  // kill the live session(s) under a card, keeping the persisted record
  const dropLiveForCard = (cardId: string): void => {
    for (const [liveId, cid] of cardOfLive) {
      if (cid !== cardId) continue;
      feeds.get(liveId)?.();
      feeds.delete(liveId);
      hooks.unregisterSession(liveId);
      transcripts.unwatch(liveId);
      try {
        ptys.remove(liveId);
      } catch {
        /* already gone */
      }
      manager.remove(liveId);
      cardOfLive.delete(liveId);
    }
  };

  // close a card: kill its live session AND forget it (won't come back)
  ipcMain.handle('sessions:closeCard', (_e, cardId: string) => {
    dropLiveForCard(cardId);
    deps.persist.remove(cardId);
  });

  // drop only the live session (restart): keep the record so it can respawn
  ipcMain.handle('sessions:dropLive', (_e, cardId: string) => dropLiveForCard(cardId));

  // freeform task label for a card (E7-03), persisted across restarts
  ipcMain.handle('sessions:setTaskLabel', (_e, cardId: string, label: string) => {
    if (typeof cardId !== 'string' || typeof label !== 'string') return;
    const prior = deps.persist.list().find((s) => s.id === cardId);
    if (prior) deps.persist.upsert({ ...prior, taskLabel: label.slice(0, 120) });
  });

  // rename a card by cardId (works for suspended cards too) — updates the
  // persisted title and the live session if one is running
  ipcMain.handle('sessions:renameCard', (_e, cardId: string, title: string) => {
    if (typeof cardId !== 'string' || typeof title !== 'string') return;
    const clean = title.slice(0, 120);
    const prior = deps.persist.list().find((s) => s.id === cardId);
    if (prior) deps.persist.upsert({ ...prior, identity: { ...prior.identity, title: clean } });
    for (const [liveId, cid] of cardOfLive) if (cid === cardId) manager.rename(liveId, clean);
  });

  ipcMain.handle('sessions:rename', (_e, liveId: string, title: string) => {
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

  // attach: replay scrollback, then stream. Returns the snapshot (utf8).
  ipcMain.handle('pty:attach', (_e, id: string) => {
    const s = ptys.get(id);
    if (!s) return null;
    feeds.get(id)?.(); // idempotent re-attach
    const off = s.onData((d) => send(`pty:data:${id}`, d));
    feeds.set(id, off);
    return s.scrollback.snapshot().toString('utf8');
  });

  ipcMain.on('pty:detach', (_e, id: string) => {
    feeds.get(id)?.();
    feeds.delete(id);
  });

  ipcMain.on('pty:input', (_e, id: string, data: string) => {
    // Keystrokes are forwarded to the PTY but do NOT drive status — only the
    // CLI's own hooks do (a keystroke is not a submitted prompt).
    ptys.get(id)?.write(data);
  });

  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    ptys.get(id)?.resize(cols, rows);
  });
}
