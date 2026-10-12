// The pictures a conversation carried, held in main (#1240).
//
// Two promises are the deliverable: a handle names ONE picture for ever (so a
// stale thumbnail can be answered with nothing, never with a different
// picture), and the store is bounded however long a session runs.
import { describe, expect, it } from 'vitest';
import { MAX_FEED_PICTURE_CHARS } from '../../shared/feed-picture';
import { picturesIn, pictureHeader } from './picture-data';
import { FeedPictureStore } from './pictures';

const image = (media_type: string, data: string, type = 'base64') => ({
  type: 'image',
  source: { type, media_type, data },
});

describe('picturesIn', () => {
  it('takes the pictures of the array it is handed, in order, and nothing deeper', () => {
    const items = [
      { type: 'text', text: 'here' },
      image('image/png', 'AAAA'),
      { type: 'tool_result', tool_use_id: 't', content: [image('image/png', 'NESTED')] },
      image('image/jpeg', 'BBBB'),
    ];
    expect(picturesIn(items)).toEqual([
      { type: 'image/png', data: 'AAAA' },
      { type: 'image/jpeg', data: 'BBBB' },
    ]);
  });

  it('counts a picture it cannot keep, without its bytes', () => {
    const items = [
      image('image/tiff', 'AAAA'), // not a type that is drawn
      image('image/png', 'https://example.invalid/a.png', 'url'), // never fetched
      image('image/png', ''), // nothing there
      image('image/png', 'x'.repeat(MAX_FEED_PICTURE_CHARS + 1)), // too long
      { type: 'image' }, // no source at all
    ];
    const found = picturesIn(items);
    expect(found).toHaveLength(5);
    expect(found.every((p) => p.data === undefined)).toBe(true);
  });

  it('stops at the limit, and at zero takes none', () => {
    const many = Array.from({ length: 5 }, () => image('image/png', 'AAAA'));
    expect(picturesIn(many, 3)).toHaveLength(3);
    expect(picturesIn(many, 0)).toEqual([]);
  });

  it('is tolerant: a string, a hole, and a wrong shape are no pictures and no throw', () => {
    expect(picturesIn('plain text result')).toEqual([]);
    expect(picturesIn(undefined)).toEqual([]);
    expect(picturesIn([null, undefined, 7, { type: 'image', source: 'nope' }])).toEqual([{ type: '' }]);
  });
});

describe('pictureHeader: a picture’s kind and size, read without decoding it', () => {
  const bytes = (...parts: Array<string | number[]>): Buffer =>
    Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
  const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const png = (w: number, h: number): Buffer =>
    bytes([0x89], 'PNG', [13, 10, 26, 10], be32(13), 'IHDR', be32(w), be32(h), [8, 2, 0, 0, 0]);

  it('reads each of the four kinds', () => {
    expect(pictureHeader(png(1200, 800))).toEqual({ type: 'image/png', width: 1200, height: 800 });
    expect(pictureHeader(bytes('GIF89a', [0x40, 0x01, 0xf0, 0x00], [0, 0, 0]))).toEqual({
      type: 'image/gif',
      width: 320,
      height: 240,
    });
    // a baseline JPEG: an APP0 segment to step over, then the frame header
    const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0], [0xff, 0xc0, 0, 17, 8, 0x02, 0x58, 0x03, 0x20], [0, 0, 0, 0]);
    expect(pictureHeader(jpeg)).toEqual({ type: 'image/jpeg', width: 800, height: 600 });
    // the three WebP chunk kinds
    const riff = (chunk: Buffer): Buffer => bytes('RIFF', [0, 0, 0, 0], 'WEBP', [...chunk]);
    expect(pictureHeader(riff(bytes('VP8X', [10, 0, 0, 0], [0, 0, 0, 0], [0x1f, 0x03, 0], [0x57, 0x02, 0], [0])))).toEqual({
      type: 'image/webp',
      width: 800,
      height: 600,
    });
    expect(
      pictureHeader(riff(bytes('VP8 ', [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], [0x20, 0x03], [0x58, 0x02], [0, 0])))
    ).toEqual({ type: 'image/webp', width: 800, height: 600 });
    // lossless: 14 bits of width-1 then 14 bits of height-1, packed
    const w = 799;
    const h = 599;
    const packed = [w & 255, ((w >> 8) & 0x3f) | ((h & 3) << 6), (h >> 2) & 255, (h >> 10) & 0x0f];
    expect(pictureHeader(riff(bytes('VP8L', [0, 0, 0, 0], [0x2f], packed, [0, 0, 0, 0, 0])))).toEqual({
      type: 'image/webp',
      width: 800,
      height: 600,
    });
  });

  it('reads the size a header DECLARES, however little file follows it', () => {
    // 27 bytes that say 60000 x 60000: what a decoder would allocate for
    expect(pictureHeader(png(60000, 60000))).toEqual({ type: 'image/png', width: 60000, height: 60000 });
  });

  it('answers null for anything else, and for a header cut short', () => {
    expect(pictureHeader(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(pictureHeader(Buffer.from('MZ' + 'x'.repeat(64), 'latin1'))).toBeNull();
    expect(pictureHeader(Buffer.alloc(0))).toBeNull();
    expect(pictureHeader(png(10, 10).subarray(0, 20))).toBeNull();
    expect(pictureHeader(png(0, 10))).toBeNull();
    expect(pictureHeader(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]))).toBeNull();
    expect(pictureHeader(bytes('RIFF', [0, 0, 0, 0], 'WAVE', 'fmt ', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe('FeedPictureStore', () => {
  const counter = (): (() => string) => {
    let n = 0;
    return () => `id-${++n}`;
  };

  it('gives every picture a handle, and answers a kept one by it', () => {
    const store = new FeedPictureStore(1000, counter());
    const owner = {};
    const ids = store.keep(owner, [{ type: 'image/png', data: 'AAAA' }, { type: 'image/tiff' }]);
    expect(ids).toEqual(['id-1', 'id-2']);
    expect(store.get('id-1')).toEqual({ type: 'image/png', data: 'AAAA' });
    // counted, never kept: its handle names nothing
    expect(store.get('id-2')).toBeUndefined();
    expect(store.get('never-minted')).toBeUndefined();
  });

  it('lets the OLDEST go when the budget is passed, and never reuses its handle', () => {
    const store = new FeedPictureStore(10, counter());
    const owner = {};
    const [first] = store.keep(owner, [{ type: 'image/png', data: 'aaaaaa' }]);
    const [second] = store.keep(owner, [{ type: 'image/png', data: 'bbbbbb' }]);
    expect(store.get(first)).toBeUndefined();
    expect(store.get(second)?.data).toBe('bbbbbb');
    expect(store.heldChars).toBe(6);
    // a third picture is a third handle: the first one's never comes back
    const [third] = store.keep(owner, [{ type: 'image/png', data: 'cc' }]);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(store.get(first)).toBeUndefined();
  });

  it('does not keep one picture bigger than the whole budget', () => {
    const store = new FeedPictureStore(4, counter());
    const [id] = store.keep({}, [{ type: 'image/png', data: 'toolong' }]);
    expect(store.get(id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('forgets one owner’s pictures and nobody else’s', () => {
    const store = new FeedPictureStore(1000, counter());
    const a = {};
    const b = {};
    const [mine] = store.keep(a, [{ type: 'image/png', data: 'AAAA' }]);
    const [theirs] = store.keep(b, [{ type: 'image/png', data: 'BBBB' }]);
    store.dropOwner(a);
    expect(store.get(mine)).toBeUndefined();
    expect(store.get(theirs)?.data).toBe('BBBB');
    expect(store.heldChars).toBe(4);
  });

  it('forgets the handles it is told to, and only those', () => {
    const store = new FeedPictureStore(1000, counter());
    const [a, b] = store.keep({}, [
      { type: 'image/png', data: 'AAAA' },
      { type: 'image/png', data: 'BBBB' },
    ]);
    store.drop([a, 'never-minted']);
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)?.data).toBe('BBBB');
    expect(store.heldChars).toBe(4);
  });

  it('mints handles nobody could guess, by default', () => {
    const store = new FeedPictureStore();
    const [id] = store.keep({}, [{ type: 'image/png', data: 'AAAA' }]);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
