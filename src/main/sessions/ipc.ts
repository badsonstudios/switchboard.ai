// Session/PTY IPC surface (P1-E3-02): the renderer's only door into the
// session core. Hidden panes are ingest-only (S-07): PTY bytes always land in
// the main-process ring buffer; the renderer gets a live feed ONLY while a
// pane is attached, and a scrollback snapshot replay on attach.
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { SessionManager } from './session-manager';
import { PtyService } from '../pty/pty-service';
import { HookListener } from '../hooks/hook-listener';
import { TranscriptWatcher } from '../transcripts/watcher';
import { Logger } from '../log/logger';

export interface SessionIpcDeps {
  manager: SessionManager;
  ptys: PtyService;
  hooks: HookListener;
  transcripts: TranscriptWatcher;
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

  manager.onStatusChange((change) => send('sessions:status', change));
  transcripts.onUpdate((snap) => send('sessions:usage', snap));

  ipcMain.handle('sessions:pickFolder', async () => {
    const win = deps.getWindow();
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

  ipcMain.handle('sessions:create', (_e, opts: { folder: string; title: string }) => {
    const record = manager.create(
      { title: opts.title, folder: opts.folder, providerId: 'claude-code' },
      { settingsFor: (id) => hooks.buildHookSettings(id) }
    );
    transcripts.watch(record.id, { cwd: opts.folder });
    log.info('session created via ui', { sessionId: record.id, folder: opts.folder });
    return record;
  });

  ipcMain.handle('sessions:list', () => manager.list());

  ipcMain.handle('sessions:kill', (_e, id: string) => {
    feeds.get(id)?.();
    feeds.delete(id);
    hooks.unregisterSession(id);
    transcripts.unwatch(id);
    manager.kill(id);
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
    const s = ptys.get(id);
    if (!s) return;
    s.write(data);
    manager.apply(id, { kind: 'user-input' });
  });

  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    ptys.get(id)?.resize(cols, rows);
  });
}
