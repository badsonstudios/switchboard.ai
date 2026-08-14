// The `fs:read` channel (P2-E16-01, §5.30 + §5.23 + §5.29).
//
// The whole channel is: check the scope, read the cap, log anything refused.
// It is its own family rather than another `sessions:*` method because the
// capability is its own — `fs.read`, not `fs.probe`, and not `sessions.read`.
// §5.30: "The existing `fs.probe` reveals only a path's existence and type;
// reading arbitrary file CONTENTS is strictly more power and must not ride in
// on it."
//
// EVERY REFUSAL IS LOGGED, in the wording `main/sessions/ipc.ts` established
// (`<channel> refused: <reason>`), so one log filter finds every refused call
// in the app. That matters more here than for a mutation: a refused read is
// either a link pointing somewhere it should not, or a scope that is wrong —
// and both are things you only find out about if they are written down.
import { BrowserWindow, dialog, shell, IpcMainInvokeEvent } from 'electron';
import { IpcBroker } from '../ipc/broker';
import type { Logger } from '../log/logger';
import { MAX_FILE_READ_BYTES, FileReadResult, FileWatchResult } from '../../shared/ipc/fs';
import { readCappedText } from './read-file';
import { ReadScope } from './read-scope';
import { FileWatchDeps, FileWatchService } from './file-watch';

/**
 * Schemes a link inside a rendered document may be opened with (§5.30).
 *
 * An ALLOW-list, and a short one: "`http`/`https`/`mailto` links open in the OS
 * browser via `shell.openExternal` against a scheme allowlist; every other
 * scheme is refused." A deny-list would be the wrong shape here — the input is
 * a string from a file we did not write, and the set of schemes an OS has a
 * handler for is open-ended and includes several that are "run this" in a
 * trench coat.
 */
export const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

/** Is this a link a document may hand to the user's browser? */
export function isAllowedDocumentLink(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    return (ALLOWED_LINK_SCHEMES as readonly string[]).includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The bits of electron these handlers touch, injectable so tests need no app. */
export interface FsShell {
  openExternal(url: string): Promise<void>;
  openPath(p: string): Promise<string>;
  showItemInFolder(p: string): void;
  pickFile(win: BrowserWindow | null): Promise<string | null>;
}

/** The real one. */
export const electronFsShell: FsShell = {
  openExternal: (url) => shell.openExternal(url),
  openPath: (p) => shell.openPath(p),
  showItemInFolder: (p) => shell.showItemInFolder(p),
  pickFile: async (win) => {
    const opts = { properties: ['openFile' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  },
};

export interface FsIpcDeps {
  broker: IpcBroker;
  log: Logger;
  scope: ReadScope;
  /** the cap, overridable for tests; production uses `MAX_FILE_READ_BYTES` */
  cap?: number;
  /** the window a modal dialog belongs to; null while there isn't one */
  getWindow?: () => BrowserWindow | null;
  /** electron's shell + dialog, swapped out in tests */
  shell?: FsShell;
  /** timing + injection knobs for the live-re-render watch (P2-E16-04) */
  watch?: Pick<
    FileWatchDeps,
    'debounceMs' | 'maxWaitMs' | 'pollMs' | 'watchFactory' | 'probe'
  >;
}

/** What the caller keeps hold of after registration (P2-E16-04). */
export interface FsIpcHandle {
  /** release every open file watch — quit, and the teardown assertion */
  stop(): void;
  /** what is being watched right now, for tests and diagnostics */
  watchStats(): { files: number; viewers: number; watched: string[] };
}

export function registerFsIpc(deps: FsIpcDeps): FsIpcHandle {
  const cap = deps.cap ?? MAX_FILE_READ_BYTES;

  deps.broker.handle('fs:read', async (_e, target: unknown): Promise<FileReadResult> => {
    const decision = deps.scope.resolve(target);
    if (!decision.ok) {
      deps.log.warn(`fs:read refused: ${decision.reason}`, {
        // The path the CALLER asked for, not the resolved one — when the answer
        // is "out of scope" the interesting string is the one that was
        // requested. Stringified because an untyped caller can send anything,
        // and a log line is not the place to find that out.
        path: typeof target === 'string' ? target : String(target),
      });
      return decision;
    }
    const result = await readCappedText(decision.path, cap);
    if (!result.ok) {
      deps.log.warn(`fs:read refused: ${result.reason}`, { path: decision.path });
      return result;
    }
    if (result.truncated) {
      // Not a refusal — the caller got bytes. Worth a line anyway: "the file
      // looked wrong in the viewer" and "the file is 900 MB" are the same
      // report from the user's side.
      deps.log.info('fs:read truncated at the cap', {
        path: decision.path,
        size: result.size,
        cap,
      });
    }
    return result;
  });

  // --- P2-E16-02: the viewer's three doors out of the app ------------------
  const sh = deps.shell ?? electronFsShell;

  /**
   * `Open file…` — the ONE thing that widens the read scope, and it widens it
   * by asking the user.
   *
   * The grant is recorded BEFORE the path is handed back, so the `fs:read` that
   * follows cannot lose the race with it. `addPicked` resolves and stores the
   * real path; a file that vanished between the dialog and here is simply not
   * granted, and the read that follows answers `out-of-scope` — which is the
   * honest answer, because by then it is.
   */
  deps.broker.handle('fs:pickFile', async (): Promise<string | null> => {
    const picked = await sh.pickFile(deps.getWindow?.() ?? null);
    if (!picked) return null;
    deps.scope.addPicked(picked);
    return picked;
  });

  /** A link out of a rendered document. Scheme-checked, and refused loudly. */
  deps.broker.handle('fs:openExternal', (_e, url: unknown): boolean => {
    if (!isAllowedDocumentLink(url)) {
      deps.log.warn('fs:openExternal refused: scheme', { url: String(url).slice(0, 200) });
      return false;
    }
    // `openExternal` REJECTS when the OS has no handler for the scheme, and an
    // unhandled rejection in main is an "A JavaScript error occurred" modal —
    // the opposite of fail-open, from a click whose worst case should be
    // "nothing happened". Same guard as `update:openExternal`.
    void sh
      .openExternal(url as string)
      .catch((err: unknown) => deps.log.warn('fs:openExternal failed', { error: String(err) }));
    return true;
  });

  /**
   * The §5.30 escape hatch, in two flavours: open the file in whatever the OS
   * has registered for it, or show it in the file manager.
   *
   * BOTH RE-CHECK THE READ SCOPE, which is the point. `shell.openPath` on a
   * `.exe` is execution, so "the renderer sent a path" is not a good enough
   * reason to run one; going through `ReadScope.resolve` means these buttons
   * can only ever be aimed at a file the caller could already have read, and
   * the resolved path — not the caller's spelling — is what is handed to the
   * OS.
   */
  const scoped = (
    channel: 'fs:openPath' | 'fs:reveal',
    act: (real: string) => void
  ): void => {
    deps.broker.handle(channel, (_e, target: unknown): boolean => {
      const decision = deps.scope.resolve(target);
      if (!decision.ok) {
        deps.log.warn(`${channel} refused: ${decision.reason}`, {
          path: typeof target === 'string' ? target : String(target),
        });
        return false;
      }
      act(decision.path);
      return true;
    });
  };
  scoped('fs:openPath', (real) => {
    void sh.openPath(real).then((err) => {
      // `openPath` RESOLVES with an error string rather than rejecting — an
      // empty string is success. A file type with no registered handler is the
      // common case, and it must read as "nothing happened", not as a crash.
      if (err) deps.log.warn('fs:openPath could not open the file', { path: real, error: err });
    });
  });
  scoped('fs:reveal', (real) => sh.showItemInFolder(real));

  // --- P2-E16-04: following the open file ----------------------------------
  //
  // Pushed to `getWindow()`, like every other outbound channel in the app, and
  // that is correct for a POPPED-OUT viewer too: dockview's popout is a window
  // whose DOM was adopted from the opener, and the panel's JavaScript — this
  // bridge, these listeners — still runs in the main window's context. There is
  // no second renderer to route to. `callerId` is carried anyway so the service
  // can drop a dead window's watches without knowing what a window is.
  const watches = new FileWatchService({
    log: deps.log,
    scope: deps.scope,
    push: (_callerId, notice) => deps.broker.send(deps.getWindow?.() ?? null, 'fs:changed', notice),
    ...deps.watch,
  });

  // Callers we have already hooked, so one window's `destroyed` listener is not
  // stacked once per `fs:watch` call — a viewer per glance would otherwise add
  // one every time a file is opened.
  const hooked = new Set<number>();
  const callerOf = (e: unknown): number => {
    const sender = (e as IpcMainInvokeEvent | undefined)?.sender;
    const id = sender?.id ?? 0;
    if (sender && typeof sender.once === 'function' && !hooked.has(id)) {
      hooked.add(id);
      sender.once('destroyed', () => {
        hooked.delete(id);
        watches.releaseCaller(id);
      });
    }
    return id;
  };

  /**
   * Follow a file, on behalf of one viewer.
   *
   * The TOKEN is the renderer's, not ours: a viewer mints one when it mounts and
   * hands the same string back to `fs:unwatch`. Main never has to know what a
   * panel is, and two panels reading the same file are two tokens rather than
   * one shared subscription that the first one to close would cancel.
   */
  deps.broker.handle('fs:watch', (e, req: unknown): FileWatchResult => {
    const { token, path: target } = (req ?? {}) as { token?: unknown; path?: unknown };
    return watches.watch(callerOf(e), token, target);
  });

  /**
   * Stop following. Answers nothing useful on purpose — the renderer calls this
   * from an effect's cleanup, where there is nobody left to read a reply, and
   * unwatching a token that was never registered is an ordinary outcome of a
   * viewer that unmounted before its watch call landed.
   */
  deps.broker.handle('fs:unwatch', (e, req: unknown): boolean => {
    const { token } = (req ?? {}) as { token?: unknown };
    watches.unwatch(callerOf(e), token);
    return true;
  });

  return {
    stop: () => watches.stop(),
    watchStats: () => watches.stats(),
  };
}
