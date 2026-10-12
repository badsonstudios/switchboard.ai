// The scoped image handler (#1080, §5.30 + §5.29).
//
// §5.30: "Local images are served through a scoped protocol handler that
// resolves the path and refuses anything outside the document's root, symlinks
// included." This is that handler. The whole of it is: is it one of our URLs,
// is it a picture by name, may it be read, is it small enough — then the bytes.
//
// THE GUARD IS `ReadScope`, the same object `fs:read` asks. §5.30 says "the
// document's root"; the read scope is what that became — open session folders,
// files the user picked, the bundled manual — and it decides on the REAL path,
// so `../`, a symlink and a junction all land on `out-of-scope` here exactly as
// they do for a read. A second, per-document root rule would be one more rule
// that can disagree with the first.
//
// IT IS NOT AN IPC CHANNEL and does not go through the broker: an `<img>` makes
// a network-shaped request, not an invoke, so there is no caller to hold a
// capability. What stands in for the capability is that only our own
// decoration can write this scheme into the page (`document-render.ts`), and
// that everything it can name is something `fs:read` would already hand over.
//
// EVERY REFUSAL IS LOGGED, in `fs/ipc.ts`'s wording, so the one log filter
// that finds a refused read finds a refused picture too.
import { errorText } from '../../shared/error-text';
import { promises as fsp } from 'fs';
import type { Logger } from '../log/logger';
import {
  DOC_IMAGE_SCHEME,
  MAX_DOC_IMAGE_BYTES,
  MAX_PAGE_BYTES,
  docImageMime,
  docImagePath,
  isPageFile,
} from '../../shared/doc-image';
import { isFeedPictureUrl } from '../../shared/feed-picture';
import type { FileReadRefusal } from '../../shared/ipc/fs';
import path from 'path';
import { isWithinRoot } from './read-scope';
import type { ReadScope } from './read-scope';

/** Why a picture was not served. A read's reasons, plus the two of our own. */
export type DocImageRefusal = FileReadRefusal | 'not-an-image' | 'too-large';

export type DocImageAnswer =
  | { readonly ok: true; readonly body: Buffer; readonly mime: string }
  | { readonly ok: false; readonly reason: DocImageRefusal };

export interface DocImageDeps {
  scope: Pick<ReadScope, 'resolve' | 'roots'>;
  log: Logger;
  /** the cap, overridable for tests; production uses `MAX_DOC_IMAGE_BYTES` */
  cap?: number;
  /**
   * Draw a picture of the web page at this REAL path (#1239), or answer null
   * when it cannot be drawn. Absent, a page is refused like any other file
   * that is not a picture: the tests, and a build where the drawing could not
   * be set up.
   */
  page?: (realPath: string) => Promise<Buffer | null>;
  /**
   * Answer for a picture from the CONVERSATION (#1240): the scheme's `feed`
   * host, which carries a handle and never a path. Absent, every such URL is
   * refused. The read scope has no say in it and is not asked: what a handle
   * names is a picture main read out of a message, not a file.
   */
  feed?: (url: unknown) => DocImageAnswer;
}

/** Thrown-shaped errors from `fs` carry a string `code`. */
function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
}

/** A caller-supplied string, made safe to put in a log line. */
const clip = (v: unknown): string => (typeof v === 'string' ? v : String(v)).slice(0, 200);

/**
 * Does this path start with two separators — `\\host\share`, `//host/share`,
 * and the `\\?\` and `\\.\` device forms with them?
 *
 * Character codes rather than an escaped literal, for `fs/ipc.ts`'s reason.
 */
export function isNetworkPath(candidate: string): boolean {
  const BACKSLASH = String.fromCharCode(92);
  const isSep = (c: string): boolean => c === '/' || c === BACKSLASH;
  return candidate.length > 1 && isSep(candidate[0]) && isSep(candidate[1]);
}

/** What reading a whole file under a cap comes to. */
export type WholeFile =
  | { readonly ok: true; readonly body: Buffer }
  | { readonly ok: false; readonly reason: DocImageRefusal };

/**
 * Read all of a regular file, refusing one over `cap` before a byte is read.
 *
 * From the OPEN HANDLE, for `read-file.ts`'s reason: one lookup, described and
 * read, with no gap for the file to become something else.
 */
export async function readWholeFile(real: string, cap: number): Promise<WholeFile> {
  let handle;
  try {
    handle = await fsp.open(real, 'r');
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') return { ok: false, reason: 'not-found' };
    if (code === 'EISDIR') return { ok: false, reason: 'not-a-file' };
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
    // Refused BEFORE a byte is read — the cap exists so that a huge file costs
    // a log line rather than a buffer.
    if (stat.size > cap) return { ok: false, reason: 'too-large' };
    const body = Buffer.allocUnsafe(stat.size);
    let filled = 0;
    while (filled < body.length) {
      const { bytesRead } = await handle.read(body, filled, body.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { ok: true, body: body.subarray(0, filled) };
  } catch (err) {
    return { ok: false, reason: errorCode(err) === 'EISDIR' ? 'not-a-file' : 'unreadable' };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Decide and read. No electron in it, so the table can be tested as one.
 *
 * THE EXTENSION IS CHECKED TWICE — on the path asked for, before anything is
 * touched, and again on the RESOLVED one. The second is the one that matters:
 * `shot.png` can be a symlink to `notes.txt` inside the same folder, and what
 * gets served is what it resolves to.
 *
 * A WEB PAGE IS ANSWERED WITH A PICTURE OF IT (#1239), when `deps.page` can
 * draw one. Everything above holds for it unchanged: the same scope, the same
 * two checks of the name (a page that resolves to anything but a page is
 * refused, and so is a picture that resolves to a page), the same refusal of a
 * network path. What comes back is a PNG main made, never the page's bytes,
 * so the `<img>` that asked can no more run the page than it can run an SVG.
 */
export async function answerDocImage(url: unknown, deps: DocImageDeps): Promise<DocImageAnswer> {
  const refuse = (reason: DocImageRefusal, asked: unknown): DocImageAnswer => {
    deps.log.warn(`${DOC_IMAGE_SCHEME} refused: ${reason}`, { path: clip(asked) });
    return { ok: false, reason };
  };

  const asked = docImagePath(url);
  if (asked === null) return refuse('invalid-path', url);
  const page = isPageFile(asked);
  if (!page && !docImageMime(asked)) return refuse('not-an-image', asked);
  // BEFORE anything touches the filesystem. `resolve` decides on the REAL
  // path, and finding the real path of `\\host\share\x.png` means asking that
  // host — on Windows an outbound SMB connection, with a login handshake, to a
  // machine the document chose. So a network path is only looked at when its
  // SPELLING already sits under a granted root (a session opened on a share);
  // everything else is refused as a string, having contacted nobody.
  if (isNetworkPath(asked)) {
    const lexical = path.resolve(asked);
    if (!deps.scope.roots().some((root) => isWithinRoot(root, lexical))) {
      return refuse('out-of-scope', asked);
    }
  }

  const decision = deps.scope.resolve(asked);
  if (!decision.ok) return refuse(decision.reason, asked);
  if (page) return answerPage(decision.path, deps, refuse);
  const mime = docImageMime(decision.path);
  if (!mime) return refuse('not-an-image', decision.path);

  const file = await readWholeFile(decision.path, deps.cap ?? MAX_DOC_IMAGE_BYTES);
  if (!file.ok) return refuse(file.reason, decision.path);
  return { ok: true, body: file.body, mime };
}

/**
 * The page half of `answerDocImage`: `real` is in scope, and was ASKED for as
 * a page.
 *
 * Described before it is drawn, so that a directory called `x.html`, a file
 * that has gone, and a 2 GB file with a page's name are each a refusal with
 * its own reason and none of them opens a window. The drawing reads the file
 * again for itself; a file swapped in between is drawn as what it now is,
 * under the same rules.
 */
async function answerPage(
  real: string,
  deps: DocImageDeps,
  refuse: (reason: DocImageRefusal, asked: unknown) => DocImageAnswer
): Promise<DocImageAnswer> {
  if (!deps.page || !isPageFile(real)) return refuse('not-an-image', real);
  // no alternate data stream (`page.html:payload`): a colon after the drive's own
  if (real.slice(2).includes(':')) return refuse('not-an-image', real);
  try {
    const stat = await fsp.stat(real);
    if (!stat.isFile()) return refuse('not-a-file', real);
    if (stat.size > MAX_PAGE_BYTES) return refuse('too-large', real);
  } catch (err) {
    return refuse(errorCode(err) === 'ENOENT' ? 'not-found' : 'unreadable', real);
  }
  const png = await deps.page(real);
  if (!png || png.length === 0) return refuse('unreadable', real);
  return { ok: true, body: png, mime: 'image/png' };
}

/** The HTTP status a refusal reads as — only ever seen in devtools and tests. */
export function docImageStatus(reason: DocImageRefusal): number {
  switch (reason) {
    case 'invalid-path':
      return 400;
    case 'out-of-scope':
      return 403;
    case 'not-an-image':
      return 415;
    case 'too-large':
      return 413;
    default:
      return 404;
  }
}

/** How many pictures main reads at once. */
export const MAX_DOC_IMAGES_IN_FLIGHT = 4;

/** The one method of electron's `protocol` this needs, so tests need no app. */
export interface ProtocolLike {
  handle(scheme: string, handler: (request: { url: string }) => Promise<Response>): void;
}

/**
 * Answer the scheme on a session.
 *
 * `nosniff` because the `content-type` is decided by the file's NAME: a text
 * file called `x.png` must fail to decode as a PNG, not be sniffed into
 * whatever it really is. `no-store` because the viewer re-renders when the
 * document changes on disk, and a picture the agent just rewrote has to be the
 * one that comes back.
 *
 * The handler NEVER REJECTS — a rejected protocol handler is a failed request
 * with an unhandled rejection in main behind it, and the renderer's answer to
 * a failed picture (the chip) is the same either way.
 *
 * A FEW AT A TIME. A document can name fifty pictures and Chromium asks for
 * them together; each is a buffer of up to the cap in main, which is the
 * process every session's plumbing runs through. The rest wait their turn.
 *
 * A PAGE DOES NOT TAKE ONE OF THOSE TURNS (#1239). Pages are drawn one at a
 * time in a queue of their own, and each can take seconds: four of them
 * waiting there would otherwise hold every turn, and no ordinary picture
 * anywhere in the app would load until they were through.
 */
export function registerDocImageProtocol(protocol: ProtocolLike, deps: DocImageDeps): void {
  let running = 0;
  const waiting: Array<() => void> = [];
  const turn = async (): Promise<void> => {
    if (running >= MAX_DOC_IMAGES_IN_FLIGHT) await new Promise<void>((go) => waiting.push(go));
    else running += 1;
  };
  const done = (): void => {
    // hand the slot straight to the next in line, or give it back
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };

  protocol.handle(DOC_IMAGE_SCHEME, async (request) => {
    let answer: DocImageAnswer;
    // DECIDED BY THE HOST, before anything reads the URL as a path (#1240): a
    // conversation's picture is named by handle, and must never fall through
    // to the code that resolves paths.
    const feed = isFeedPictureUrl(request.url);
    const queued = !feed && !isPageFile(docImagePath(request.url) ?? '');
    if (queued) await turn();
    try {
      if (feed) answer = deps.feed ? deps.feed(request.url) : { ok: false, reason: 'not-found' };
      else answer = await answerDocImage(request.url, deps);
    } catch (err) {
      deps.log.warn(`${DOC_IMAGE_SCHEME} failed`, { error: errorText(err) });
      answer = { ok: false, reason: 'unreadable' };
    } finally {
      if (queued) done();
    }
    if (!answer.ok) return new Response(null, { status: docImageStatus(answer.reason) });
    // The buffer itself, not a copy of it — it is ours alone and nothing else
    // holds it, and a second 20 MiB per picture is the cost the cap is for.
    return new Response(answer.body as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-type': answer.mime,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
  });
}
