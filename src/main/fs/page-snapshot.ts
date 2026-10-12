// A picture of a web page (#1239).
//
// The owner, asked whether an HTML mock-up could be a live frame inside the
// conversation: "I like the rule for now, so maybe we just do pictures of
// mockups." The rule is that the conversation has no frames. So when a reply
// names a local `.html` file, main DRAWS the page in a window nobody sees,
// takes a picture, and the conversation shows the picture through the scheme
// it already shows every other picture through (`doc-image.ts`).
//
// THE PAGE IS SOMETHING AN AGENT WROTE, possibly from text it read somewhere
// else, so the window it is drawn in is a box:
//
//   - ITS OWN SESSION, in memory, shared with nothing: no cookie, cache or
//     storage of the app's is in reach, and nothing it stores outlives it.
//   - SCRIPTS DO NOT RUN. A picture of what the HTML and CSS draw. A script
//     in a hidden window can raise a dialog nobody can see, spin for ever, and
//     gives a mock-up of a screen nothing it needs. The cost is real and the
//     conversation says so under the picture: a page that builds itself with
//     script draws empty.
//   - NO NETWORK, three times over. The session answers `file:` ITSELF
//     (`answerPageAsset`): the page, and stylesheets, pictures and fonts that
//     sit inside the page's own folder and inside the read scope, decided on
//     the real path. Every other request is cancelled before it leaves. The
//     page's content policy says the same thing again. And the session is
//     OFFLINE with a proxy that is not there, for the two things a page can
//     ask for that are not requests and that nothing above gets to cancel:
//     looking a name up, and opening a connection early (`dns-prefetch`,
//     `preconnect`). A remote stylesheet, font or tracking pixel is simply
//     absent from the picture.
//   - It cannot navigate, open a window, download, or be granted a permission.
//
// NOTHING IS SAVED. A picture is kept in memory, and only for as long as the
// page and every file it asked for are unchanged on disk (`createPageShots`),
// so a page the agent just rewrote is drawn again and one that has gone is
// refused. There is no snapshot that can be shown as current when it is not.
//
// TWO HALVES, as `doc-image.ts` is: the deciding and the remembering have no
// electron in them and are tested as tables; `electronPageRenderer` is the
// part that needs a real window. Its wiring is tested against stand-ins, and
// what the window really does is the real-app spec's.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { errorText } from '../../shared/error-text';
import {
  DOC_IMAGE_TYPES,
  MAX_PAGE_BYTES,
  PAGE_SHOT_HEIGHT,
  PAGE_SHOT_WIDTH,
} from '../../shared/doc-image';
import type { Logger } from '../log/logger';
import { readWholeFile } from './doc-image';
import type { DocImageRefusal } from './doc-image';
import { isWithinRoot } from './read-scope';
import type { ReadScope } from './read-scope';

/**
 * What a page may pull in besides itself, by extension: styles, pictures,
 * fonts. NOT script (it would not run), and NOT another page (there are no
 * frames to put one in).
 */
export const PAGE_ASSET_TYPES: Readonly<Record<string, string>> = {
  ...DOC_IMAGE_TYPES,
  css: 'text/css; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/**
 * The page's content policy. The session's own answers are the boundary; this
 * is the same boundary stated to the page, so that a mistake in one is not a
 * hole. `file:` here can only ever mean `answerPageAsset`, which is the one
 * thing that answers that scheme in this session.
 */
export const PAGE_SHOT_CSP = [
  "default-src 'none'",
  'img-src file: data:',
  "style-src file: 'unsafe-inline'",
  'font-src file: data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** How long a page gets, from the first byte asked for to the picture, in ms. */
export const PAGE_SHOT_TIMEOUT_MS = 5000;

/** How many pictures of pages are kept. Each is a PNG of a 1280 x 800 window. */
export const MAX_PAGE_SHOTS = 12;

/**
 * How many different files one page may ask for. A mock-up asks for a handful.
 * A page that names thousands would have main describe every one of them
 * again each time its picture is asked for, so past this they are refused.
 */
export const MAX_PAGE_FILES = 200;

/** What a file looks like from outside: size and modified time, or null when it is not there. */
export type FileStamp = string | null;

export function statStamp(file: string): FileStamp {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/** The page being drawn: its real path, and the folder its files may come from. */
export interface PageBeingDrawn {
  readonly page: string;
  readonly dir: string;
  /**
   * Every in-folder path the page asked for, served or not, with what the
   * file looked like AT THAT MOMENT (see `createPageShots`): before it was
   * read, so one rewritten while the window was open reads as changed.
   */
  readonly asked: Map<string, FileStamp>;
}

export type PageAssetAnswer =
  | { readonly ok: true; readonly body: Buffer; readonly mime: string; readonly isPage: boolean }
  | { readonly ok: false; readonly reason: DocImageRefusal };

export interface PageAssetDeps {
  scope: Pick<ReadScope, 'resolve'>;
  log: Logger;
  /** the cap, overridable for tests; production uses `MAX_PAGE_BYTES` */
  cap?: number;
  /** overridable for tests; production uses `statStamp` */
  stamp?: (file: string) => FileStamp;
}

const clip = (v: unknown): string => (typeof v === 'string' ? v : String(v)).slice(0, 200);

function assetMime(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(PAGE_ASSET_TYPES, ext) ? PAGE_ASSET_TYPES[ext] : undefined;
}

/**
 * Decide and read one `file:` request made by the page being drawn.
 *
 * THE ORDER IS THE POINT. The spelling is checked against the page's folder
 * BEFORE the filesystem is asked anything, so `file://host/share/x.css` and
 * `file:///C:/Users/me/.ssh/id_rsa` are refused as strings, having touched
 * nothing and contacted nobody. Then the real path is found by the read scope
 * (a symlink out of the folder lands on `out-of-scope` there, or fails the
 * folder check here), and the type is checked on the REAL name as well as the
 * asked one, for `doc-image.ts`'s reason.
 */
export async function answerPageAsset(
  url: unknown,
  drawing: PageBeingDrawn,
  deps: PageAssetDeps
): Promise<PageAssetAnswer> {
  const refuse = (reason: DocImageRefusal, asked: unknown): PageAssetAnswer => {
    deps.log.warn(`page picture: a file the page asked for was refused: ${reason}`, { path: clip(asked) });
    return { ok: false, reason };
  };

  let asked: string;
  try {
    asked = fileURLToPath(typeof url === 'string' ? url : '');
  } catch {
    return refuse('invalid-path', url);
  }
  const lexical = path.resolve(asked);
  if (!isWithinRoot(drawing.dir, lexical)) return refuse('out-of-scope', asked);
  if (!drawing.asked.has(lexical)) {
    if (drawing.asked.size >= MAX_PAGE_FILES) return refuse('too-large', asked);
    // remembered whether or not it is served: a stylesheet that is missing now
    // and written a minute later changes what the page looks like
    drawing.asked.set(lexical, (deps.stamp ?? statStamp)(lexical));
  }

  const decision = deps.scope.resolve(lexical);
  if (!decision.ok) return refuse(decision.reason, asked);
  const real = decision.path;
  if (!isWithinRoot(drawing.dir, real)) return refuse('out-of-scope', real);
  if (real.slice(2).includes(':')) return refuse('not-an-image', real);

  const isPage = real === drawing.page;
  const mime = isPage ? 'text/html; charset=utf-8' : assetMime(real);
  if (!mime || (!isPage && !assetMime(lexical))) return refuse('not-an-image', real);

  const file = await readWholeFile(real, deps.cap ?? MAX_PAGE_BYTES);
  if (!file.ok) return refuse(file.reason, real);
  return { ok: true, body: file.body, mime, isPage };
}

/**
 * What drawing a page comes to: the picture, and every file the page asked
 * for with what each looked like when it was asked for.
 */
export interface PageShot {
  readonly png: Buffer;
  readonly files: ReadonlyArray<readonly [string, FileStamp]>;
}

/** Draws the page at a real path. Rejects, or resolves with an empty PNG, when it cannot. */
export type PageRenderer = (page: string) => Promise<PageShot>;

export interface PageShotsDeps {
  render: PageRenderer;
  log: Logger;
  /** overridable for tests; production uses `statStamp` */
  stamp?: (file: string) => FileStamp;
  /** how many pictures to keep; production uses `MAX_PAGE_SHOTS` */
  max?: number;
}

/**
 * Pictures of pages, drawn one at a time and remembered while they are true.
 *
 * ONE AT A TIME, because each is a window: a reply naming several pages, or a
 * conversation scrolled back into view, must not open one per picture at once.
 *
 * REMEMBERED, because the conversation asks again every time a reply is drawn
 * (main serves pictures `no-store`, and a long conversation unmounts what is
 * off screen), and a window per scroll is not a cost a picture is worth. A
 * page that could NOT be drawn is remembered the same way, as nothing: it
 * would otherwise open a window, and wait out its time limit, on every scroll.
 *
 * WHILE TRUE: a picture is kept with the size and modified time of the page
 * AND of every file the page asked for, including the ones that were not
 * there. All of them are looked at again before it is handed out, so an edit
 * to the stylesheet next to the page is seen, which a key on the page alone
 * would miss. Each was noted BEFORE it was read, so a file rewritten while
 * the window was open reads as changed on the next ask.
 *
 * NEVER REJECTS: a page that cannot be drawn is null, which the handler turns
 * into a refusal and the conversation into the chip.
 */
export function createPageShots(deps: PageShotsDeps): (page: string) => Promise<Buffer | null> {
  const stamp = deps.stamp ?? statStamp;
  const max = deps.max ?? MAX_PAGE_SHOTS;
  type Kept = { png: Buffer | null; stamps: ReadonlyArray<readonly [string, FileStamp]> };
  const kept = new Map<string, Kept>();
  const drawing = new Map<string, Promise<Buffer | null>>();
  let line: Promise<unknown> = Promise.resolve();

  const stillTrue = (page: string): Kept | undefined => {
    const hit = kept.get(page);
    if (!hit) return undefined;
    if (!hit.stamps.every(([file, was]) => stamp(file) === was)) {
      kept.delete(page);
      return undefined;
    }
    // most recently used last, so the first key is the one to drop
    kept.delete(page);
    kept.set(page, hit);
    return hit;
  };

  const keep = (page: string, entry: Kept): void => {
    kept.set(page, entry);
    while (kept.size > max) {
      const oldest = kept.keys().next().value;
      if (oldest === undefined) break;
      kept.delete(oldest);
    }
  };

  const draw = async (page: string): Promise<Buffer | null> => {
    // asked again once it is this page's turn: the one in front may have
    // drawn it
    const hit = stillTrue(page);
    if (hit) return hit.png;
    const before = stamp(page);
    try {
      const shot = await deps.render(page);
      const png = shot.png.length > 0 ? shot.png : null;
      keep(page, { png, stamps: [[page, before], ...shot.files.filter(([file]) => file !== page)] });
      return png;
    } catch (err) {
      deps.log.warn('page picture: the page could not be drawn', { path: clip(page), error: errorText(err) });
      // what it asked for before it failed is not known, so only the page
      // itself can bring it back: rewrite the page and it is tried again
      keep(page, { png: null, stamps: [[page, before]] });
      return null;
    }
  };

  return (page: string): Promise<Buffer | null> => {
    const hit = stillTrue(page);
    if (hit) return Promise.resolve(hit.png);
    const already = drawing.get(page);
    if (already) return already;
    const mine = line.then(() => draw(page));
    line = mine;
    drawing.set(page, mine);
    void mine.finally(() => {
      if (drawing.get(page) === mine) drawing.delete(page);
    });
    return mine;
  };
}

// --- the electron half -------------------------------------------------------

/** The parts of electron's `Session` this needs. */
export interface ShotSessionLike {
  protocol: { handle(scheme: string, handler: (request: { url: string }) => Promise<Response>): void };
  webRequest: {
    onBeforeRequest(
      listener: (details: { url: string }, callback: (response: { cancel?: boolean }) => void) => void
    ): void;
  };
  setPermissionRequestHandler(handler: (wc: unknown, permission: string, callback: (ok: boolean) => void) => void): void;
  setPermissionCheckHandler(handler: () => boolean): void;
  on(event: 'will-download', listener: (event: { preventDefault(): void }) => void): unknown;
  setProxy(config: { proxyRules: string; proxyBypassRules: string }): Promise<void>;
  enableNetworkEmulation(options: { offline: boolean }): void;
}

export interface ShotImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number }): ShotImageLike;
  toPNG(): Buffer;
}

export interface ShotWindowLike {
  loadURL(url: string): Promise<void>;
  destroy(): void;
  isDestroyed(): boolean;
  webContents: {
    setWindowOpenHandler(handler: () => { action: 'deny' }): void;
    on(event: 'will-navigate', listener: (event: { preventDefault(): void }) => void): unknown;
    setAudioMuted(muted: boolean): void;
    capturePage(): Promise<ShotImageLike>;
  };
}

export interface ElectronPageRendererDeps {
  /** electron's `session.fromPartition` */
  fromPartition: (partition: string) => unknown;
  /** `(options) => new BrowserWindow(options)` */
  createWindow: (options: Record<string, unknown>) => unknown;
  scope: Pick<ReadScope, 'resolve'>;
  log: Logger;
  /** the whole time limit, overridable for tests; production uses `PAGE_SHOT_TIMEOUT_MS` */
  timeoutMs?: number;
}

/** No `persist:` prefix: an in-memory session, gone when the app is. */
export const PAGE_SHOT_PARTITION = 'sb-page-shot';

/** A beat after the load event for the first paint to land, in ms. */
const PAGE_SHOT_SETTLE_MS = 150;

/**
 * A proxy that is not there, for EVERYTHING, this machine included: without
 * `<-loopback>` Chromium talks to `localhost` directly, and a page has no
 * more business with a service on this machine than with one on the web.
 * Port 1 is not something anything listens on; a connection to it is refused
 * by this machine without leaving it.
 */
const NO_PROXY = { proxyRules: 'http://127.0.0.1:1', proxyBypassRules: '<-loopback>' };

function refusalStatus(reason: DocImageRefusal): number {
  if (reason === 'out-of-scope') return 403;
  if (reason === 'invalid-path') return 400;
  return 404;
}

/** May this request leave the boxed session's hands? Only ours to answer, or inline bytes. */
export function isPageShotRequestAllowed(url: string): boolean {
  return /^(file|data):/i.test(url);
}

/**
 * The renderer `createPageShots` is given in the app: a hidden window in the
 * boxed session described at the top of this file.
 *
 * `drawing` is ONE variable because pages are drawn one at a time; a request
 * that arrives when nothing is being drawn is refused.
 */
export function electronPageRenderer(deps: ElectronPageRendererDeps): PageRenderer {
  let boxed: Promise<ShotSessionLike> | undefined;
  let drawing: PageBeingDrawn | undefined;

  const box = async (): Promise<ShotSessionLike> => {
    const made = deps.fromPartition(PAGE_SHOT_PARTITION) as ShotSessionLike;
    made.protocol.handle('file', async (request) => {
      if (!drawing) return new Response(null, { status: 404 });
      let answer: PageAssetAnswer;
      try {
        answer = await answerPageAsset(request.url, drawing, deps);
      } catch (err) {
        deps.log.warn('page picture: a file request failed', { error: errorText(err) });
        answer = { ok: false, reason: 'unreadable' };
      }
      if (!answer.ok) return new Response(null, { status: refusalStatus(answer.reason) });
      return new Response(answer.body as unknown as BodyInit, {
        status: 200,
        headers: {
          'content-type': answer.mime,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
          // on EVERY answer, not only the page: should the window ever come to
          // show one of the page's files as a document, it is under the same policy
          'content-security-policy': PAGE_SHOT_CSP,
        },
      });
    });
    // everything that is not ours to answer is cancelled before it leaves
    made.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isPageShotRequestAllowed(details.url) });
    });
    made.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    made.setPermissionCheckHandler(() => false);
    made.on('will-download', (event) => event.preventDefault());
    // BEFORE any page is loaded in it, which is why this is awaited
    made.enableNetworkEmulation({ offline: true });
    await made.setProxy(NO_PROXY);
    return made;
  };
  const session = (): Promise<ShotSessionLike> => {
    // a session that could not be boxed is not kept: the next page tries again
    boxed ??= box().catch((err: unknown) => {
      boxed = undefined;
      throw err;
    });
    return boxed;
  };

  return async (page: string): Promise<PageShot> => {
    const boxedSession = await session();
    const mine: PageBeingDrawn = { page, dir: path.dirname(page), asked: new Map() };
    const win = deps.createWindow({
      show: false,
      // nowhere near anything that looks for a window by where it is
      x: -32000,
      y: -32000,
      width: PAGE_SHOT_WIDTH,
      height: PAGE_SHOT_HEIGHT,
      useContentSize: true,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      // a page with no background of its own is drawn on white, as a browser would
      backgroundColor: '#ffffff',
      webPreferences: {
        session: boxedSession,
        offscreen: true,
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webgl: false,
        plugins: false,
      },
    }) as ShotWindowLike;
    drawing = mine;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const take = async (): Promise<PageShot> => {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      // the only navigation is the one made here; a `<meta refresh>` is not one
      win.webContents.on('will-navigate', (event) => event.preventDefault());
      win.webContents.setAudioMuted(true);
      await win.loadURL(pathToFileURL(page).href);
      await new Promise<void>((resolve) => setTimeout(resolve, PAGE_SHOT_SETTLE_MS));
      let image = await win.webContents.capturePage();
      if (image.isEmpty()) return { png: Buffer.alloc(0), files: [...mine.asked] };
      // a display scaled to 200% hands back twice the pixels; the conversation
      // was told the size, and it is this one
      const size = image.getSize();
      if (size.width !== PAGE_SHOT_WIDTH || size.height !== PAGE_SHOT_HEIGHT) {
        image = image.resize({ width: PAGE_SHOT_WIDTH, height: PAGE_SHOT_HEIGHT });
      }
      return { png: image.toPNG(), files: [...mine.asked] };
    };
    try {
      // ONE limit over all of it. A load that never ends and a capture that
      // never answers are the same thing to everyone waiting behind this page:
      // the window is closed and the next one gets its turn.
      const taking = take();
      // (a capture that fails after the limit has nobody left to tell)
      taking.catch(() => undefined);
      return await Promise.race([
        taking,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('the page took too long to draw')),
            deps.timeoutMs ?? PAGE_SHOT_TIMEOUT_MS
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (drawing === mine) drawing = undefined;
      if (!win.isDestroyed()) win.destroy();
    }
  };
}
