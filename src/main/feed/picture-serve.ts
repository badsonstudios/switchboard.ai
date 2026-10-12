// Answering for a picture from the conversation (#1240): the thumbnail an
// `<img>` asks for by handle, and the full picture the user opens.
//
// The store (`pictures.ts`) holds what a handle names. This is the two ways it
// leaves main, and neither hands the page a byte it can address as data:
//
//   - THE THUMBNAIL, through the picture scheme's `feed` host. Drawn small
//     here, so a 4000-pixel screenshot is never decoded into the conversation
//     at full size. The thumbnail of a handle is the same for ever, so it is
//     drawn once and remembered.
//   - THE FULL PICTURE, by `feed:openPicture`: written to a file in a folder
//     of the app's own and handed to whatever the system uses for pictures.
//     The page cannot show it large itself (no `data:`, no `blob:`), and the
//     conversation has no frames.
//
// No electron in this file: the drawing, the shell and the folder arrive as
// arguments, so the whole table is testable as one.
import fs from 'fs';
import path from 'path';
import { errorText } from '../../shared/error-text';
import {
  FEED_PICTURE_TYPES,
  feedPictureHandle,
  isFeedPictureHandle,
  isFeedPictureType,
} from '../../shared/feed-picture';
import type { DocImageAnswer } from '../fs/doc-image';
import type { Logger } from '../log/logger';
import { pictureHeader } from './picture-data';
import type { FeedPictureStore, KeptPicture } from './pictures';

/** A thumbnail's bytes and what they are. */
export interface Thumbnail {
  body: Buffer;
  mime: string;
}

/**
 * Draw a picture small. `null` when it cannot be decoded here at all (main
 * decodes PNG and JPEG; a GIF or a WebP it does not).
 */
export type DrawThumbnail = (bytes: Buffer, type: string) => Thumbnail | null;

/**
 * The largest picture served AS IT IS, when it could not be drawn small. A
 * GIF or a WebP past this is the placeholder: serving it would decode the
 * whole of it into the conversation, which is what the thumbnail is for.
 */
export const MAX_RAW_FEED_PICTURE_BYTES = 1024 * 1024;

/**
 * The most pixels a picture may DECLARE and still be decoded: 24 million, a
 * 6000 x 4000 photograph. A decoder allocates four bytes for each before it
 * has read the rest of the file, in the process every session runs through,
 * so this is checked against the header and nothing larger is decoded at all.
 */
export const MAX_FEED_PICTURE_PIXELS = 24_000_000;

/**
 * A kept picture's bytes, if they are what the message said they were and
 * small enough to decode. Otherwise why not.
 *
 * THE BYTES DECIDE, NOT THE LABEL: a message can call anything `image/png`.
 * What is drawn, served or written out is only ever something whose own
 * header says it is the picture it was declared to be.
 */
function checked(picture: KeptPicture): { ok: true; raw: Buffer } | { ok: false; reason: 'not-an-image' | 'too-large' } {
  const raw = Buffer.from(picture.data, 'base64');
  const header = pictureHeader(raw);
  if (!header || header.type !== picture.type) return { ok: false, reason: 'not-an-image' };
  if (header.width * header.height > MAX_FEED_PICTURE_PIXELS) return { ok: false, reason: 'too-large' };
  return { ok: true, raw };
}

/** How much thumbnail main remembers, in bytes. They are small; this is hundreds. */
export const FEED_THUMB_CACHE_BYTES = 16 * 1024 * 1024;

export interface FeedPictureAnswerDeps {
  store: Pick<FeedPictureStore, 'get'>;
  draw: DrawThumbnail;
  log: Logger;
}

/**
 * The answerer for the `feed` host: a URL in, a thumbnail or a refusal out.
 *
 * NEVER THROWS, and every refusal is one of the picture handler's own reasons,
 * so the page's answer is the same as for any picture that will not load: the
 * placeholder. A handle that is well-formed and names nothing is `not-found`,
 * and it is not logged: it is the ordinary fate of an old picture, not a fault.
 *
 * ⚠️ THE DRAWING RUNS ON MAIN'S OWN THREAD. It is bounded (the pixel budget
 * above, checked before anything is decoded) and each picture is drawn once,
 * but a conversation that opens on a dozen large screenshots draws a dozen in
 * a row. Moving it off the thread is the next step if that is ever felt.
 */
export function createFeedPictureAnswer(deps: FeedPictureAnswerDeps): (url: unknown) => DocImageAnswer {
  const drawn = new Map<string, Thumbnail>();
  const refusedBefore = new Map<string, 'not-an-image' | 'too-large' | 'unreadable'>();
  let bytes = 0;
  const remember = (id: string, thumb: Thumbnail): void => {
    drawn.set(id, thumb);
    bytes += thumb.body.length;
    for (const [old, t] of drawn) {
      if (bytes <= FEED_THUMB_CACHE_BYTES) break;
      drawn.delete(old);
      bytes -= t.body.length;
    }
  };

  return (url) => {
    const id = feedPictureHandle(url);
    if (id === null) {
      deps.log.warn('feed picture refused: invalid-path', { url: String(url).slice(0, 200) });
      return { ok: false, reason: 'invalid-path' };
    }
    // THE STORE IS ASKED FIRST, even for a thumbnail already drawn. A picture
    // main has let go must stop being offered: its thumbnail is a button, and
    // a button that opens nothing is worse than a box that says so.
    const picture = deps.store.get(id);
    if (!picture) {
      const stale = drawn.get(id);
      if (stale) {
        drawn.delete(id);
        bytes -= stale.body.length;
      }
      return { ok: false, reason: 'not-found' };
    }
    const had = drawn.get(id);
    if (had) return { ok: true, ...had };
    const refused = refusedBefore.get(id);
    if (refused) return { ok: false, reason: refused };
    const refuse = (reason: 'not-an-image' | 'too-large' | 'unreadable'): DocImageAnswer => {
      // remembered, so a picture that cannot be drawn is not decoded from
      // base64 again every time the conversation is remounted
      refusedBefore.set(id, reason);
      if (refusedBefore.size > 512) refusedBefore.delete(refusedBefore.keys().next().value as string);
      deps.log.warn(`feed picture refused: ${reason}`, { type: picture.type });
      return { ok: false, reason };
    };
    let thumb: Thumbnail | null = null;
    try {
      const bytesOf = checked(picture);
      if (!bytesOf.ok) return refuse(bytesOf.reason);
      thumb = deps.draw(bytesOf.raw, picture.type);
      if (!thumb) {
        if (bytesOf.raw.length > MAX_RAW_FEED_PICTURE_BYTES) return refuse('too-large');
        thumb = { body: bytesOf.raw, mime: picture.type };
      }
    } catch (err) {
      deps.log.warn('feed picture could not be drawn', { error: errorText(err) });
      return refuse('unreadable');
    }
    remember(id, thumb);
    return { ok: true, ...thumb };
  };
}

export interface OpenFeedPictureDeps {
  store: Pick<FeedPictureStore, 'get'>;
  /** the folder the copies are written to; ours alone */
  dir: string;
  /** electron's `shell.openPath`: resolves to '' or to an error message */
  openPath: (file: string) => Promise<string>;
  log: Logger;
}

/**
 * Open the picture this handle names in the system's own viewer.
 *
 * THE FILE'S NAME IS OURS FROM END TO END: the handle (checked to be a UUID
 * and nothing else, so it cannot name a folder) and an extension chosen from
 * the picture's media type out of a list of four. Nothing a message said
 * reaches the path, and what `shell.openPath` is handed can only ever be a
 * file this function has just written, with a picture's extension.
 *
 * Answers whether it was opened. A handle that names nothing is false.
 */
export async function openFeedPicture(id: unknown, deps: OpenFeedPictureDeps): Promise<boolean> {
  if (!isFeedPictureHandle(id)) {
    deps.log.warn('feed:openPicture refused: invalid handle');
    return false;
  }
  const picture = deps.store.get(id);
  if (!picture || !isFeedPictureType(picture.type)) return false;
  // the same check the thumbnail gets: only bytes that ARE the declared kind
  // of picture are ever written under a picture's extension
  const bytesOf = checked(picture);
  if (!bytesOf.ok) {
    deps.log.warn(`feed:openPicture refused: ${bytesOf.reason}`);
    return false;
  }
  const file = path.join(deps.dir, `${id}.${FEED_PICTURE_TYPES[picture.type]}`);
  try {
    // ours alone: on a shared machine nobody else reads a screenshot's copy
    await fs.promises.mkdir(deps.dir, { recursive: true, mode: 0o700 });
    // A SECOND OPEN OF THE SAME PICTURE WRITES NOTHING. The handle names these
    // bytes for ever, and a viewer that still has the file open would refuse
    // the write (Windows), turning a second click into nothing at all.
    const there = await fs.promises.stat(file).then(
      (st) => st.isFile() && st.size === bytesOf.raw.length,
      () => false
    );
    if (!there) await fs.promises.writeFile(file, bytesOf.raw, { mode: 0o600 });
    const err = await deps.openPath(file);
    if (err) {
      deps.log.warn('feed:openPicture could not open the picture', { error: err });
      return false;
    }
    return true;
  } catch (err) {
    deps.log.warn('feed:openPicture failed', { error: errorText(err) });
    return false;
  }
}

/**
 * Empty the folder the copies are written to. At start-up and at quit: a copy
 * exists so a viewer can read it, and outlives the app only by accident.
 *
 * ONLY FILES THIS MODULE COULD HAVE WRITTEN are removed: a handle and one of
 * the four extensions. Anything else in there is somebody else's and stays.
 */
export function emptyFeedPictureDir(dir: string): number {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const extensions = new Set(Object.values(FEED_PICTURE_TYPES));
  for (const name of names) {
    const dot = name.lastIndexOf('.');
    if (dot < 0 || !isFeedPictureHandle(name.slice(0, dot)) || !extensions.has(name.slice(dot + 1))) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch {
      // a viewer may still have it open; the next start takes it
    }
  }
  return removed;
}
