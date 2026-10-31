// Which parts of a message are pictures (#1240): the pure half.
//
// Apart from the store (`pictures.ts`) on purpose. The derivation
// (`providers/claude-transcript.ts`, #1303) needs to know which content items are
// pictures, and it is on the session bus's
// default read path, which may import nothing that keeps state or touches the
// system (`context-package.test.ts` walks it). This file is handed an array
// and answers a question about it.
import {
  MAX_FEED_PICTURES_PER_BLOCK,
  MAX_FEED_PICTURE_CHARS,
  isFeedPictureType,
} from '../../shared/feed-picture';

/** One picture as a message carried it. `data` is absent when it cannot be
 *  kept (not base64, not a type we draw, too long): counted, never drawn. */
export interface PictureData {
  type: string;
  data?: string;
}

/**
 * The pictures among these content items, in order, at most `max` of them.
 *
 * TOP-LEVEL ITEMS OF THE ARRAY IT IS HANDED, and nothing deeper: the caller
 * decides which array (a user message's own content for what was attached, a
 * `tool_result`'s content for what a tool returned), which is the whole of
 * what keeps "Claude looked at a file" apart from "the user attached one".
 *
 * Tolerant by construction, like everything that reads a message: a hole, a
 * wrong type or a missing source is a picture that is counted and not drawn,
 * never a throw.
 */
export function picturesIn(items: unknown, max = MAX_FEED_PICTURES_PER_BLOCK): PictureData[] {
  if (!Array.isArray(items) || max <= 0) return [];
  const out: PictureData[] = [];
  for (const item of items as Array<{ type?: unknown; source?: unknown } | null | undefined>) {
    if (item?.type !== 'image') continue;
    if (out.length >= max) break;
    const source = item.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
    const type = typeof source?.media_type === 'string' ? source.media_type : '';
    const drawable =
      source?.type === 'base64' &&
      isFeedPictureType(type) &&
      typeof source.data === 'string' &&
      source.data.length > 0 &&
      source.data.length <= MAX_FEED_PICTURE_CHARS;
    out.push(drawable ? { type, data: source.data as string } : { type });
  }
  return out;
}

/** What a picture's own first bytes say it is. */
export interface PictureHeader {
  /** the media type the bytes ARE, whatever the message called them */
  type: string;
  width: number;
  height: number;
}

/**
 * Read a picture's kind and size off its header, decoding nothing.
 *
 * THIS IS WHAT STANDS BETWEEN A MESSAGE AND A DECODER. A PNG of a few
 * kilobytes can declare a hundred thousand pixels a side, and a decoder
 * allocates for what the header declares before it finds out the rest is
 * missing. So the size is read here, from a few fixed bytes, and a picture
 * too large to decode is refused without one byte of it being decoded.
 *
 * `null` for anything that is not one of the four kinds, or is cut short:
 * what cannot be sized is not handed to a decoder at all.
 */
export function pictureHeader(b: Uint8Array): PictureHeader | null {
  const u16be = (at: number): number => (b[at] << 8) | b[at + 1];
  const u16le = (at: number): number => b[at] | (b[at + 1] << 8);
  const u32be = (at: number): number => b[at] * 0x1000000 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
  const ascii = (at: number, text: string): boolean =>
    b.length >= at + text.length && [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0));
  const sized = (type: string, width: number, height: number): PictureHeader | null =>
    width > 0 && height > 0 ? { type, width, height } : null;

  // PNG: the signature, then IHDR, whose first eight bytes are the size
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 'PNG') && ascii(12, 'IHDR')) {
    return sized('image/png', u32be(16), u32be(20));
  }
  // GIF: the logical screen, straight after the signature
  if (b.length >= 10 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) {
    return sized('image/gif', u16le(6), u16le(8));
  }
  // WebP: a RIFF container; the first chunk is one of three kinds
  if (b.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8X')) {
      return sized('image/webp', 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
    }
    if (ascii(12, 'VP8L') && b[20] === 0x2f) {
      return sized(
        'image/webp',
        1 + (b[21] | ((b[22] & 0x3f) << 8)),
        1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10))
      );
    }
    if (ascii(12, 'VP8 ')) return sized('image/webp', u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    return null;
  }
  // JPEG: walk the segments to the first start-of-frame, which carries the size
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      if (marker === 0xff) {
        at += 1; // a fill byte
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return sized('image/jpeg', u16be(at + 7), u16be(at + 5));
      // markers with no length: restart markers and the two ends
      if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
        at += 2;
        continue;
      }
      const length = u16be(at + 2);
      if (length < 2) return null;
      at += 2 + length;
    }
    return null;
  }
  return null;
}
