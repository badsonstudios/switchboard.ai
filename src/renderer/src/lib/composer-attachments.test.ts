// @vitest-environment jsdom
// The clipboard rules the composer follows (P2-E10-09).
//
// jsdom because every input here is a browser type — `File`, `DataTransfer`,
// `btoa`. The functions are pure, but the things they are pure ABOUT only exist
// in a DOM, and re-implementing `File` in a node environment would be pinning a
// fake instead of the rule.
import { describe, it, expect } from 'vitest';
import {
  Attachment,
  IMAGE_MEDIA_TYPES,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BASE64_BYTES,
  MAX_IMAGE_FILE_BYTES,
  formatBytes,
  hasPlainText,
  filesFrom,
  isImageMediaType,
  pastedImageName,
  readImageAttachments,
  toBase64,
} from './composer-attachments';

/** a File of `n` bytes with the given MIME type — content is never read for meaning */
function fileOf(type: string, n: number, name = 'image.png'): File {
  return new File([new Uint8Array(n)], name, { type });
}

/** the shape `imageFilesFrom`/`hasPlainText` actually consume, without a real event */
function clipboard(files: File[], text = ''): Pick<DataTransfer, 'files' | 'getData'> {
  return {
    files: files as unknown as FileList,
    getData: (t: string) => (t === 'text/plain' ? text : ''),
  } as Pick<DataTransfer, 'files' | 'getData'>;
}

describe('which clipboard items count as an image', () => {
  // The reference's own list, in its own order (webview 2.1.226:
  // `qit=["image/jpeg","image/png","image/gif","image/webp"]`). Pinned as a
  // literal because a drift here is a drift from the contract, not a nit.
  it('is the reference allow-list, verbatim', () => {
    expect([...IMAGE_MEDIA_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    for (const t of IMAGE_MEDIA_TYPES) expect(isImageMediaType(t)).toBe(true);
  });

  // their classifier lower-cases before testing; a clipboard that shouts is
  // still a clipboard
  it('matches case-insensitively, as the reference does', () => {
    expect(isImageMediaType('IMAGE/PNG')).toBe(true);
  });

  // A format the API cannot decode is not an image we can show the model —
  // attaching it would be promising a turn that comes back an error.
  it('rejects formats the model cannot be shown', () => {
    for (const t of ['image/tiff', 'image/svg+xml', 'image/bmp', 'text/plain', ''])
      expect(isImageMediaType(t)).toBe(false);
  });

  // Every file, NOT a pre-filtered list: the classifier downstream is what
  // turns an unusable one into a visible message instead of a silent no-op.
  it('hands over every file on the clipboard, in order', () => {
    const png = fileOf('image/png', 4);
    const jpg = fileOf('image/jpeg', 4, 'shot.jpg');
    const doc = fileOf('application/pdf', 4, 'a.pdf');
    expect(filesFrom(clipboard([doc, png, jpg]))).toEqual([doc, png, jpg]);
  });

  it('is fine with a clipboard that has no files at all', () => {
    expect(filesFrom(clipboard([], 'just text'))).toEqual([]);
  });

  it('says so when the only file is one the model cannot be shown', async () => {
    const { attachments, rejected } = await readImageAttachments([
      fileOf('image/tiff', 8, 'scan.tiff'),
    ]);
    expect(attachments).toEqual([]);
    expect(rejected).toBe('unsupported');
  });
});

describe('a clipboard carrying BOTH text and an image', () => {
  // The documented rule: both survive. The text pastes as it always did and the
  // image attaches beside it — a spreadsheet range gives you both halves and
  // dropping either one silently is the bug report.
  it('reports the text so the composer can let the default paste run', () => {
    expect(hasPlainText(clipboard([fileOf('image/png', 4)], 'hello'))).toBe(true);
  });

  it('reports no text for a bare bitmap — MS Paint, a screenshot tool', () => {
    expect(hasPlainText(clipboard([fileOf('image/png', 4)]))).toBe(false);
  });

  it('treats a clipboard it cannot interrogate as image-only', () => {
    const hostile = {
      files: [] as unknown as FileList,
      getData: () => {
        throw new Error('not during a paste');
      },
    } as unknown as Pick<DataTransfer, 'files' | 'getData'>;
    expect(hasPlainText(hostile)).toBe(false);
  });
});

describe('reading the bytes', () => {
  it('base64-encodes without a data: prefix — the wire block carries raw base64', async () => {
    const png = new File([new Uint8Array([1, 2, 3, 4])], 'image.png', { type: 'image/png' });
    const { attachments, rejected } = await readImageAttachments([png]);
    expect(rejected).toBeNull();
    expect(attachments).toHaveLength(1);
    expect(attachments[0].data).toBe('AQIDBA==');
    expect(attachments[0].data.startsWith('data:')).toBe(false);
    expect(attachments[0].mediaType).toBe('image/png');
    expect(attachments[0].bytes).toBe(4);
  });

  // `String.fromCharCode(...bytes)` blows the argument limit somewhere around a
  // hundred thousand bytes and every real screenshot is bigger than that, so
  // the chunking is the part that has to be true rather than the arithmetic.
  it('encodes a buffer far past the spread-argument limit', () => {
    const big = new Uint8Array(300_000).fill(65);
    const out = toBase64(big.buffer);
    expect(out).toHaveLength(Math.ceil(300_000 / 3) * 4);
    expect(atob(out)).toHaveLength(300_000);
  });

  it('gives an anonymous bitmap a name of its own', () => {
    const at = new Date(2026, 7, 13, 9, 5, 3);
    expect(pastedImageName('image/png', at)).toBe('pasted-20260813-090503.png');
    expect(pastedImageName('image/jpeg', at)).toBe('pasted-20260813-090503.jpg');
  });

  // Chromium names EVERY pasted bitmap `image.png`, so keeping that name would
  // make every chip in the strip read the same.
  it('renames Chromium’s generic paste name but keeps a real one', async () => {
    const now = (): Date => new Date(2026, 7, 13, 9, 5, 3);
    const generic = await readImageAttachments([fileOf('image/png', 4, 'image.png')], 0, now);
    expect(generic.attachments[0].name).toBe('pasted-20260813-090503.png');
    const real = await readImageAttachments([fileOf('image/png', 4, 'diagram.png')], 0, now);
    expect(real.attachments[0].name).toBe('diagram.png');
  });

  it('gives every attachment in one draft a distinct id', async () => {
    const { attachments } = await readImageAttachments([
      fileOf('image/png', 4),
      fileOf('image/png', 4),
    ]);
    expect(attachments[0].id).not.toBe(attachments[1].id);
  });
});

describe('limits — matched to what the API will actually accept', () => {
  // 5 MB of BASE64 per image is the ceiling the CLI's own upstream enforces.
  // A check against the file size would let a 4 MB PNG through as a 5.4 MB
  // block, so the encoded length is the one that decides.
  it('states the ceiling in encoded bytes, and a file size that fits under it', () => {
    expect(MAX_IMAGE_BASE64_BYTES).toBe(5 * 1024 * 1024);
    expect(Math.ceil(MAX_IMAGE_FILE_BYTES / 3) * 4).toBeLessThanOrEqual(MAX_IMAGE_BASE64_BYTES);
  });

  it('rejects an oversized image and says which way it failed', async () => {
    const { attachments, rejected } = await readImageAttachments([
      fileOf('image/png', MAX_IMAGE_FILE_BYTES + 1),
    ]);
    expect(attachments).toEqual([]);
    expect(rejected).toBe('too-large');
  });

  // One oversized item does not poison the paste — the others still attach.
  it('keeps the images that DO fit', async () => {
    const ok = fileOf('image/png', 8, 'ok.png');
    const { attachments, rejected } = await readImageAttachments([
      fileOf('image/png', MAX_IMAGE_FILE_BYTES + 1, 'huge.png'),
      ok,
    ]);
    expect(attachments.map((a) => a.name)).toEqual(['ok.png']);
    expect(rejected).toBe('too-large');
  });

  it('caps the DRAFT, not the paste', async () => {
    const one = await readImageAttachments([fileOf('image/png', 4)], MAX_ATTACHMENTS);
    expect(one.attachments).toEqual([]);
    expect(one.rejected).toBe('too-many');

    const room = await readImageAttachments(
      Array.from({ length: 3 }, () => fileOf('image/png', 4)),
      MAX_ATTACHMENTS - 1
    );
    expect(room.attachments).toHaveLength(1);
    expect(room.rejected).toBe('too-many');
  });

  it('reports an unreadable item rather than throwing at the paste handler', async () => {
    const broken = {
      type: 'image/png',
      size: 4,
      name: 'x.png',
      arrayBuffer: () => Promise.reject(new Error('gone')),
    } as unknown as File;
    const { attachments, rejected } = await readImageAttachments([broken]);
    expect(attachments).toEqual([]);
    expect(rejected).toBe('unreadable');
  });
});

describe('what the chip says', () => {
  it('formats sizes at chip scale', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('the Attachment struct is the carrier #476 will reuse', () => {
  // Named here so a change that makes it paste-specific fails a test that says
  // why: drag & drop (#476) rides the same strip, the same removal and the same
  // send path, and the only difference is where `name` comes from.
  it('carries everything the send path needs and nothing about a clipboard', () => {
    const a: Attachment = {
      id: 'att-1',
      name: 'diagram.png',
      mediaType: 'image/png',
      bytes: 4,
      data: 'AQIDBA==',
    };
    expect(Object.keys(a).sort()).toEqual(['bytes', 'data', 'id', 'mediaType', 'name']);
  });
});
