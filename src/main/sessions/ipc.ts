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

export interface SessionIpcDeps {
  manager: SessionManager;
  ptys: PtyService;
  hooks: HookListener;
  transcripts: TranscriptWatcher;
  feed: EventFeed;
  log: Logger;
  getWindow: () => BrowserWindow | null;
}

export function registerSessionIpc(deps: SessionIpcDeps): void {
  const { manager, ptys, hooks, transcripts, log } = deps;
  // per-session live-feed unsubscribers (attached panes only)
  const feeds = new Map<string, () => void>();

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
  transcripts.onUpdate((snap) => send('sessions:usage', snap));

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

  ipcMain.handle(
    'sessions:create',
    (_e, opts: { folder: string; title: string; autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto' }) => {
    // validate untrusted renderer input (§5.29): folder must be a real dir,
    // title bounded; unknown autonomy falls through to the CLI 'ask' default
    if (!opts || typeof opts.folder !== 'string') throw new Error('folder required');
    let isDir = false;
    try {
      isDir = fs.statSync(opts.folder).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new Error('folder is not a directory');
    const title = (typeof opts.title === 'string' ? opts.title : opts.folder).slice(0, 120);
    const record = manager.create(
      {
        title,
        folder: opts.folder,
        providerId: 'claude-code',
        accentColor: assignAccent(
          manager.list().map((s) => s.identity.accentColor ?? '')
        ),
        langBadge: detectProjectType(opts.folder),
      },
      { settingsFor: (id) => hooks.buildHookSettings(id), autonomy: opts.autonomy }
    );
    transcripts.watch(record.id, { cwd: opts.folder });
    log.info('session created via ui', { sessionId: record.id, folder: opts.folder });
    return record;
  });

  ipcMain.handle('sessions:list', () => manager.list());

  ipcMain.handle('sessions:rename', (_e, id: string, title: string) => {
    manager.rename(id, title);
    return manager.get(id);
  });

  ipcMain.handle('sessions:kill', (_e, id: string) => {
    feeds.get(id)?.();
    feeds.delete(id);
    hooks.unregisterSession(id);
    transcripts.unwatch(id);
    // kill the live PTY (if any), then drop the record. Both are idempotent
    // and must never reject — closing a card is fail-open.
    try {
      ptys.remove(id);
    } catch {
      /* already gone */
    }
    manager.remove(id);
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
