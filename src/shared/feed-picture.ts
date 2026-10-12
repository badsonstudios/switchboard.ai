// A picture that arrived INSIDE the conversation (#1240): one a tool returned
// (a `Read` of a `.png`, a screenshot from an MCP tool) or one the user
// attached to a prompt.
//
// Shared for `doc-image.ts`'s reason: both ends have to agree on the URL shape
// and on the box a thumbnail is drawn in, and neither may drift.
//
// THE SAME SCHEME AS A PICTURE BY PATH, A DIFFERENT HOST. The content policy
// allows `<img>` exactly one scheme of ours and refuses `data:` and `blob:` on
// purpose; a second scheme would be a second thing `img-src` gained. What this
// host can name is narrower than the first: not a path at all, only a HANDLE
// main minted for a picture it read out of a message, so the page can ask for
// nothing main did not already offer it.
import { DOC_IMAGE_SCHEME } from './doc-image';

/** The host that says "a picture from the conversation", not one by path. */
export const FEED_PICTURE_HOST = 'feed';

/**
 * The media types a message's picture may have, and the extension a copy of it
 * is given when it is opened at full size. The API's own four, and the whole
 * list: anything else in a message is counted and never drawn.
 */
export const FEED_PICTURE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Is this one of the media types above? */
export function isFeedPictureType(type: unknown): type is string {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(FEED_PICTURE_TYPES, type);
}

/**
 * The box every thumbnail is drawn in, in px.
 *
 * ONE SIZE, known before the picture is: the room is reserved by the first
 * render, so a thumbnail that arrives late moves nothing. The picture is
 * fitted inside it whole, never cropped.
 */
export const FEED_THUMB_WIDTH = 144;
export const FEED_THUMB_HEIGHT = 108;

/** How many of one message's pictures get a thumbnail. The rest are counted. */
export const MAX_FEED_PICTURES_PER_BLOCK = 12;

/**
 * The longest base64 text main will keep for one picture: about 6 MB of
 * picture, past what the API accepts for one. A longer one is still counted,
 * and its thumbnail is the placeholder.
 */
export const MAX_FEED_PICTURE_CHARS = 8 * 1024 * 1024;

/** What a handle looks like: the UUID main minted, and nothing else. */
const HANDLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Is this string shaped like a handle? Says nothing about whether it is live. */
export function isFeedPictureHandle(id: unknown): id is string {
  return typeof id === 'string' && HANDLE.test(id);
}

/** The URL an `<img>` uses for the thumbnail of the picture with this handle. */
export function feedPictureUrl(id: string): string {
  return `${DOC_IMAGE_SCHEME}://${FEED_PICTURE_HOST}/?id=${encodeURIComponent(id)}`;
}

/** Is this URL addressed to the conversation's pictures at all? */
export function isFeedPictureUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${DOC_IMAGE_SCHEME}:` && parsed.hostname === FEED_PICTURE_HOST;
  } catch {
    return false;
  }
}

/** The handle a `feedPictureUrl` carries, or null when it carries none. */
export function feedPictureHandle(url: unknown): string | null {
  if (!isFeedPictureUrl(url)) return null;
  const id = new URL(url as string).searchParams.get('id');
  return isFeedPictureHandle(id) ? id : null;
}
