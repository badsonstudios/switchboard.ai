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
  MAX_ATTACHMENT_PAYLOAD_BYTES,
  MAX_ENCODED_FILE_BYTES,
  formatBytes,
  hasPlainText,
  filesFrom,
  isImageMediaType,
  pastedImageName,
  classifyAttachment,
  filesFromDrop,
  readAttachments,
  toBase64,
  toPromptAttachments,
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
    const { attachments, rejected } = await readAttachments([
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
    const { attachments, rejected } = await readAttachments([png]);
    expect(rejected).toBeNull();
    expect(attachments).toHaveLength(1);
    const [a] = attachments;
    expect(a.kind).toBe('image');
    if (a.kind !== 'image') throw new Error('unreachable');
    expect(a.data).toBe('AQIDBA==');
    expect(a.data.startsWith('data:')).toBe(false);
    expect(a.mediaType).toBe('image/png');
    expect(a.bytes).toBe(4);
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
    const generic = await readAttachments([fileOf('image/png', 4, 'image.png')], 0, 'paste', now);
    expect(generic.attachments[0].name).toBe('pasted-20260813-090503.png');
    const real = await readAttachments([fileOf('image/png', 4, 'diagram.png')], 0, 'paste', now);
    // ...and a DROPPED file keeps its name even when that name is `image.png`
    const dropped = await readAttachments([fileOf('image/png', 4, 'image.png')], 0, 'drop', now);
    expect(dropped.attachments[0].name).toBe('image.png');
    expect(real.attachments[0].name).toBe('diagram.png');
  });

  it('gives every attachment in one draft a distinct id', async () => {
    const { attachments } = await readAttachments([
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
    expect(MAX_ATTACHMENT_PAYLOAD_BYTES).toBe(5 * 1024 * 1024);
    expect(Math.ceil(MAX_ENCODED_FILE_BYTES / 3) * 4).toBeLessThanOrEqual(MAX_ATTACHMENT_PAYLOAD_BYTES);
  });

  it('rejects an oversized image and says which way it failed', async () => {
    const { attachments, rejected } = await readAttachments([
      fileOf('image/png', MAX_ENCODED_FILE_BYTES + 1),
    ]);
    expect(attachments).toEqual([]);
    expect(rejected).toBe('too-large');
  });

  // One oversized item does not poison the paste — the others still attach.
  it('keeps the images that DO fit', async () => {
    const ok = fileOf('image/png', 8, 'ok.png');
    const { attachments, rejected } = await readAttachments([
      fileOf('image/png', MAX_ENCODED_FILE_BYTES + 1, 'huge.png'),
      ok,
    ]);
    expect(attachments.map((a) => a.name)).toEqual(['ok.png']);
    expect(rejected).toBe('too-large');
  });

  it('caps the DRAFT, not the paste', async () => {
    const one = await readAttachments([fileOf('image/png', 4)], MAX_ATTACHMENTS);
    expect(one.attachments).toEqual([]);
    expect(one.rejected).toBe('too-many');

    const room = await readAttachments(
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
    const { attachments, rejected } = await readAttachments([broken]);
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

describe('the Attachment struct is the carrier paste AND drop share', () => {
  // Named here so a change that makes it paste-specific fails a test that says
  // why: drag & drop (#476) rides the same strip, the same removal and the same
  // send path, and the only difference is where `name` comes from.
  it('carries everything the send path needs and nothing about a clipboard', () => {
    const a: Attachment = {
      id: 'att-1',
      name: 'diagram.png',
      kind: 'image',
      mediaType: 'image/png',
      bytes: 4,
      data: 'AQIDBA==',
    };
    expect(Object.keys(a).sort()).toEqual(['bytes', 'data', 'id', 'kind', 'mediaType', 'name']);
  });

  // The union is the point: a text attachment has no `data` to hand a canvas
  // and no base64 to put in a `type:"text"` source, and the compiler is what
  // enforces that rather than a comment.
  it('a text attachment carries contents, not bytes', () => {
    const a: Attachment = {
      id: 'att-2',
      name: 'notes.md',
      kind: 'text',
      mediaType: 'text/markdown',
      bytes: 8,
      text: '# hello\n',
    };
    expect(Object.keys(a).sort()).toEqual(['bytes', 'id', 'kind', 'mediaType', 'name', 'text']);
  });
});

// P2-E10-10 — the classifier, pinned VERBATIM to the reference.
//
// `classifyAttachment` is a port of `Hbe`/`Zit` out of the 2.1.226 webview
// bundle. These tests exist so a drift from it fails here rather than as "the
// model says it cannot see my file".
describe('classifyAttachment — the reference’s own three-way split', () => {
  // if(qit.includes(e))return"image" — MIME ONLY, before anything else
  it('classifies images by MIME and never by extension', () => {
    expect(classifyAttachment('image/png', 'a.png')).toBe('image');
    expect(classifyAttachment('IMAGE/PNG', 'a.png')).toBe('image');
    // the OS still types a renamed PNG, so it is still an image
    expect(classifyAttachment('image/png', 'a.dat')).toBe('image');
    // and an untyped file called .png is NOT one
    expect(classifyAttachment('', 'a.png')).toBe('unsupported');
  });

  it('classifies a PDF', () => {
    expect(classifyAttachment('application/pdf', 'spec.pdf')).toBe('pdf');
  });

  // Zit check 1: any text/* prefix
  it('accepts any text/* media type', () => {
    expect(classifyAttachment('text/plain', 'a.txt')).toBe('text');
    expect(classifyAttachment('text/markdown', 'a.md')).toBe('text');
    expect(classifyAttachment('text/x-anything', 'weird')).toBe('text');
  });

  // Zit check 2: the Kit application/* allow-list
  it('accepts the application/* types the reference lists', () => {
    expect(classifyAttachment('application/json', 'a.json')).toBe('text');
    expect(classifyAttachment('application/x-yaml', 'a.yaml')).toBe('text');
    expect(classifyAttachment('application/toml', 'a.toml')).toBe('text');
  });

  // Zit check 3: the extension set. THE ONE THAT CARRIES THE WEIGHT — Windows
  // hands most source files over with an EMPTY type.
  it('accepts source files by extension when the OS gave no MIME type', () => {
    for (const name of ['main.rs', 'app.ts', 'x.py', 'a.go', 'q.sql', 'notes.md', 'd.diff'])
      expect(classifyAttachment('', name)).toBe('text');
  });

  // Zit check 4: whole-name matches, including the six bare names
  it('accepts extensionless files the reference names', () => {
    for (const name of ['LICENSE', 'readme', 'CHANGELOG', 'Makefile', 'Dockerfile', '.gitignore'])
      expect(classifyAttachment('', name)).toBe('text');
  });

  // SVG is in the text extension set AND is an image MIME — but not one on the
  // allow-list, so it falls through to text and is sent as source. That is the
  // reference's behaviour, and a good one: the model reads SVG better than it
  // would read a raster of it.
  it('sends an SVG as its own source rather than refusing it', () => {
    expect(classifyAttachment('image/svg+xml', 'logo.svg')).toBe('text');
  });

  it('refuses what the reference refuses', () => {
    expect(classifyAttachment('image/tiff', 'scan.tiff')).toBe('unsupported');
    expect(classifyAttachment('application/octet-stream', 'app.exe')).toBe('unsupported');
    expect(classifyAttachment('video/mp4', 'clip.mp4')).toBe('unsupported');
    expect(classifyAttachment('', 'somefolder')).toBe('unsupported');
  });
});

describe('reading a text attachment (P2-E10-10)', () => {
  it('carries the CONTENTS, not base64 of them', async () => {
    const { attachments, rejected } = await readAttachments([
      new File(['# hello\n'], 'notes.md', { type: 'text/markdown' }),
    ]);
    expect(rejected).toBeNull();
    const [a] = attachments;
    expect(a.kind).toBe('text');
    if (a.kind !== 'text') throw new Error('unreachable');
    expect(a.text).toBe('# hello\n');
    expect(a.name).toBe('notes.md');
  });

  // The divergence made testable: the reference `atob`s to latin1 and mojibakes
  // this. We decode UTF-8, so the characters survive.
  it('decodes UTF-8 rather than latin1', async () => {
    const body = 'em—dash, café, 日本語';
    const { attachments } = await readAttachments([
      new File([body], 'u.md', { type: 'text/plain' }),
    ]);
    const [a] = attachments;
    if (a.kind !== 'text') throw new Error('unreachable');
    expect(a.text).toBe(body);
  });

  // Windows editors write a BOM; a stray invisible character at the head of a
  // document block is exactly the kind of thing that costs an hour.
  it('drops a UTF-8 BOM', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    const { attachments } = await readAttachments([
      new File([bytes], 'b.md', { type: 'text/plain' }),
    ]);
    const [a] = attachments;
    if (a.kind !== 'text') throw new Error('unreachable');
    expect(a.text).toBe('hi');
  });

  it('keeps a real name rather than inventing one', async () => {
    const { attachments } = await readAttachments([new File(['x'], 'server.log', { type: '' })]);
    expect(attachments[0].name).toBe('server.log');
  });

  // A text file is not base64'd, so it gets the full payload ceiling rather
  // than the 3/4 allowance the encoded kinds get.
  it('measures a text file against the payload ceiling, not the encoded one', async () => {
    const justOver = new File(['a'.repeat(MAX_ATTACHMENT_PAYLOAD_BYTES + 1)], 'big.md', {
      type: 'text/plain',
    });
    expect((await readAttachments([justOver])).rejected).toBe('too-large');
    // between the two ceilings: refused for an image, fine for text
    const between = new File(['a'.repeat(MAX_ENCODED_FILE_BYTES + 1024)], 'mid.md', {
      type: 'text/plain',
    });
    expect((await readAttachments([between])).rejected).toBeNull();
  });

  it('refuses an empty file rather than producing a hollow attachment', async () => {
    const { attachments, rejected } = await readAttachments([
      new File([], 'empty.md', { type: 'text/plain' }),
    ]);
    expect(attachments).toEqual([]);
    expect(rejected).toBe('empty');
  });

  it('reads a PDF as base64 and titles it', async () => {
    const { attachments } = await readAttachments([
      new File([new Uint8Array([1, 2, 3, 4])], 'spec.pdf', { type: 'application/pdf' }),
    ]);
    const [a] = attachments;
    expect(a.kind).toBe('pdf');
    if (a.kind !== 'pdf') throw new Error('unreachable');
    expect(a.data).toBe('AQIDBA==');
    expect(a.name).toBe('spec.pdf');
  });
});

describe('filesFromDrop — telling a folder from a file (P2-E10-10)', () => {
  /** the shape `filesFromDrop` consumes; jsdom has no usable DataTransfer */
  function transfer(
    entries: Array<{ name: string; dir: boolean; file?: File }>
  ): Pick<DataTransfer, 'files' | 'items'> {
    const items = entries.map((e) => ({
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: e.dir, isFile: !e.dir, name: e.name }),
      getAsFile: () => e.file ?? null,
    }));
    const files = entries.filter((e) => e.file).map((e) => e.file!);
    return { files, items } as unknown as Pick<DataTransfer, 'files' | 'items'>;
  }

  it('separates folders from files', () => {
    const md = new File(['x'], 'a.md', { type: 'text/plain' });
    const out = filesFromDrop(
      transfer([
        { name: 'src', dir: true },
        { name: 'a.md', dir: false, file: md },
      ])
    );
    expect(out.files.map((f) => f.name)).toEqual(['a.md']);
    expect(out.directories).toEqual(['src']);
  });

  // A folder named like a text file is the case the reference gets WRONG: it
  // has no directory handling at all, so `readme` as a folder is classified as
  // text by name and sent as an empty document.
  it('catches a folder whose NAME looks like a text file', () => {
    const out = filesFromDrop(transfer([{ name: 'readme', dir: true }]));
    expect(out.files).toEqual([]);
    expect(out.directories).toEqual(['readme']);
  });

  // Without the entry API there is nothing to interrogate; falling back to
  // `.files` is strictly better than refusing every drop.
  it('falls back to .files when the entry API is missing', () => {
    const md = new File(['x'], 'a.md', { type: 'text/plain' });
    const out = filesFromDrop({ files: [md], items: undefined } as unknown as Pick<
      DataTransfer,
      'files' | 'items'
    >);
    expect(out.files.map((f) => f.name)).toEqual(['a.md']);
    expect(out.directories).toEqual([]);
  });

  it('survives an entry API that throws', () => {
    const items = [
      {
        kind: 'file',
        webkitGetAsEntry: () => {
          throw new Error('nope');
        },
        getAsFile: () => new File(['x'], 'a.md', { type: 'text/plain' }),
      },
    ];
    const out = filesFromDrop({ files: [], items } as unknown as Pick<
      DataTransfer,
      'files' | 'items'
    >);
    expect(out.files.map((f) => f.name)).toEqual(['a.md']);
  });
});

describe('toPromptAttachments — what actually crosses the IPC boundary', () => {
  it('drops the draft-only fields and maps name to title', () => {
    expect(
      toPromptAttachments([
        { id: 'att-1', name: 'a.md', kind: 'text', mediaType: 'text/plain', bytes: 2, text: 'hi' },
        {
          id: 'att-2',
          name: 'b.png',
          kind: 'image',
          mediaType: 'image/png',
          bytes: 4,
          data: 'AQ==',
        },
        {
          id: 'att-3',
          name: 'c.pdf',
          kind: 'pdf',
          mediaType: 'application/pdf',
          bytes: 4,
          data: 'Ag==',
        },
      ])
    ).toEqual([
      { kind: 'text', title: 'a.md', text: 'hi' },
      { kind: 'image', mediaType: 'image/png', data: 'AQ==' },
      { kind: 'pdf', title: 'c.pdf', data: 'Ag==' },
    ]);
  });
});
