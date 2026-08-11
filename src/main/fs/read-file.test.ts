// The capped read (P2-E16-01, §5.30).
//
// The done-when this file owns: "an over-cap file returns truncated-with-a-flag
// rather than hanging the bridge". Every file here is made under a tracked temp
// directory; nothing is read from or written to anywhere else.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { tempDir } from '../../test-temp-dirs';
import { MAX_FILE_READ_BYTES } from '../../shared/ipc/fs';
import { readCappedText, sniffEncoding, decodeText, SNIFF_BYTES } from './read-file';

const DIR = tempDir('sb-fsread-');
const write = (name: string, body: string | Buffer): string => {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, body);
  return p;
};

describe('readCappedText', () => {
  it('reads a small file whole', async () => {
    const r = await readCappedText(write('small.md', '# hello\n\nworld\n'));
    expect(r).toEqual({
      ok: true,
      path: path.join(DIR, 'small.md'),
      text: '# hello\n\nworld\n',
      size: 15,
      truncated: false,
      encoding: 'utf-8',
      bytes: 15,
    });
  });

  it('reads an empty file as empty, not as a failure', async () => {
    const r = await readCappedText(write('empty.md', ''));
    expect(r).toEqual({
      ok: true,
      path: path.join(DIR, 'empty.md'),
      text: '',
      size: 0,
      truncated: false,
      encoding: 'utf-8',
      bytes: 0,
    });
  });

  it('keeps UTF-8 intact', async () => {
    const body = '# ✅ done — “quoted” … 日本語\n';
    const r = await readCappedText(write('utf8.md', body));
    expect(r.ok && r.text).toBe(body);
  });

  it('truncates an over-cap file and SAYS so, with the real size attached', async () => {
    // The flag alone would leave the viewer unable to say how much it is not
    // showing; `size` is the file on disk, `text.length` is what came back.
    const p = write('big.log', 'x'.repeat(1000));
    const r = await readCappedText(p, 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(1000);
    expect(r.text).toHaveLength(100);
  });

  it('a file exactly AT the cap is not truncated', async () => {
    const r = await readCappedText(write('exact.log', 'y'.repeat(100)), 100);
    expect(r.ok && r.truncated).toBe(false);
    expect(r.ok && r.text).toHaveLength(100);
  });

  it('one byte over the cap IS truncated', async () => {
    const r = await readCappedText(write('over.log', 'y'.repeat(101)), 100);
    expect(r.ok && r.truncated).toBe(true);
  });

  it('never reads more than the cap, however big the file is', async () => {
    // 8 MiB with a 1 KiB cap: if the implementation read the file and sliced
    // afterwards, this would still pass — but the same code on a multi-GB log
    // is an out-of-memory crash of the whole app, which is why the read is
    // sized to the cap rather than to the file.
    const p = write('huge.log', Buffer.alloc(8 * 1024 * 1024, 0x61));
    const r = await readCappedText(p, 1024);
    expect(r.ok && r.text.length).toBe(1024);
    expect(r.ok && r.size).toBe(8 * 1024 * 1024);
    expect(r.ok && r.truncated).toBe(true);
  });

  it('a cap landing mid-character degrades that ONE glyph, not the read', async () => {
    // '✅' is three bytes; cutting at 2 leaves a partial sequence. The answer is
    // a replacement character and 2 MB of good text, not a throw.
    const r = await readCappedText(write('multi.md', '✅✅'), 2);
    expect(r.ok).toBe(true);
    expect(r.ok && r.text).toBe('�');
  });

  it('says not-found for a file that is not there', async () => {
    expect(await readCappedText(path.join(DIR, 'nope.md'))).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('says not-a-file for a directory', async () => {
    // POSIX refuses at `open` with EISDIR; Windows opens it happily and the
    // stat is what catches it. Both paths answer the same thing.
    const sub = path.join(DIR, 'subdir');
    fs.mkdirSync(sub, { recursive: true });
    expect(await readCappedText(sub)).toEqual({ ok: false, reason: 'not-a-file' });
  });

  it('the shipped cap is the shared constant, so the renderer can name it', async () => {
    const r = await readCappedText(write('tiny.md', 'x'));
    expect(r.ok && r.truncated).toBe(false);
    expect(MAX_FILE_READ_BYTES).toBe(2 * 1024 * 1024);
  });

  it('a zero cap answers empty-and-truncated rather than doing something strange', async () => {
    const r = await readCappedText(write('zerocap.md', 'content'), 0);
    expect(r).toMatchObject({ ok: true, text: '', size: 7, truncated: true });
  });
});

// ─── P2-E16-02: what encoding is this, and is it text at all? ──────────────

/** Write raw bytes, which is the only way to test a decoder. */
function writeBytes(name: string, bytes: number[] | Buffer): string {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, Buffer.from(bytes as number[]));
  return p;
}

describe('sniffEncoding', () => {
  it('reads a BOM as the statement it is', () => {
    expect(sniffEncoding(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]))).toEqual({
      encoding: 'utf-8',
      bomBytes: 3,
      binary: false,
    });
    expect(sniffEncoding(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toEqual({
      encoding: 'utf-16le',
      bomBytes: 2,
      binary: false,
    });
    expect(sniffEncoding(Uint8Array.from([0xfe, 0xff, 0x00, 0x41]))).toEqual({
      encoding: 'utf-16be',
      bomBytes: 2,
      binary: false,
    });
  });

  it('calls a NUL byte binary — and that is what BOM-less UTF-16 gets', () => {
    // The deliberate half of the carry-forward: without a BOM there is no way
    // to tell UTF-16LE from an arbitrary blob, and a wrong guess renders
    // mojibake as if it were the document.
    expect(sniffEncoding(Uint8Array.from([0x41, 0x00, 0x42, 0x00])).binary).toBe(true);
    expect(sniffEncoding(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00])).binary).toBe(true);
  });

  it('an empty file and plain ASCII are text', () => {
    expect(sniffEncoding(new Uint8Array(0))).toMatchObject({ encoding: 'utf-8', binary: false });
    expect(sniffEncoding(Uint8Array.from([0x23, 0x20, 0x68, 0x69]))).toMatchObject({
      encoding: 'utf-8',
      binary: false,
    });
  });

  it('only looks at the first page, so a NUL past it does not condemn the file', () => {
    const buf = new Uint8Array(SNIFF_BYTES + 8);
    buf.fill(0x41);
    buf[SNIFF_BYTES + 4] = 0;
    expect(sniffEncoding(buf).binary).toBe(false);
  });
});

describe('decodeText', () => {
  it('decodes both UTF-16 byte orders to the same string', () => {
    const le = Buffer.from('héllo — ✅', 'utf16le');
    const be = Buffer.from(le);
    for (let i = 0; i < be.length; i += 2) {
      const a = be[i];
      be[i] = be[i + 1];
      be[i + 1] = a;
    }
    expect(decodeText(le, 'utf-16le')).toBe('héllo — ✅');
    expect(decodeText(be, 'utf-16be')).toBe('héllo — ✅');
  });

  it('drops half a code unit rather than throwing', () => {
    const le = Buffer.from('abc', 'utf16le');
    expect(decodeText(le.subarray(0, 5), 'utf-16le')).toBe('ab');
  });
});

describe('readCappedText — encodings and binaries (P2-E16-02)', () => {
  it('reports the BYTES it decoded, which the viewer needs to say "the first X of Y"', async () => {
    // NOT `text.length`: a UTF-16 file decodes to roughly half as many
    // characters as it had bytes, so measuring the decoded string renderer-side
    // would understate what was read by a factor of two.
    const r = await readCappedText(write('bytes.log', 'y'.repeat(1000)), 100);
    expect(r).toMatchObject({ ok: true, bytes: 100, size: 1000, truncated: true });
  });

  it('a UTF-16LE file with a BOM reads as text, not as mojibake', async () => {
    const body = '# hello\n\nworld — ✅\n';
    const file = writeBytes('utf16le.md', Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(body, 'utf16le'),
    ]));
    const r = await readCappedText(file);
    expect(r).toMatchObject({ ok: true, text: body, encoding: 'utf-16le' });
  });

  it('a UTF-16BE file with a BOM reads as text too', async () => {
    const body = 'hi ✅';
    const le = Buffer.from(body, 'utf16le');
    const be = Buffer.from(le);
    for (let i = 0; i < be.length; i += 2) {
      const a = be[i];
      be[i] = be[i + 1];
      be[i + 1] = a;
    }
    const file = writeBytes('utf16be.md', Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    expect(await readCappedText(file)).toMatchObject({
      ok: true,
      text: body,
      encoding: 'utf-16be',
    });
  });

  it('strips a UTF-8 BOM instead of putting U+FEFF in front of the heading', async () => {
    const file = writeBytes('bom.md', Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# hello\n', 'utf8'),
    ]));
    expect(await readCappedText(file)).toMatchObject({ ok: true, text: '# hello\n' });
  });

  it('a binary file answers binary with its size, and NO bytes cross', async () => {
    // A PNG header, then a NUL. The viewer shows a card built from the name and
    // the size; the garbage never leaves main.
    const file = writeBytes('logo.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x99]);
    expect(await readCappedText(file)).toEqual({
      ok: true,
      path: file,
      text: '',
      size: 10,
      truncated: false,
      binary: true,
    });
  });

  it('the bytes decide, not the extension — a .txt full of NULs is binary', async () => {
    const file = writeBytes('lying.txt', [0x68, 0x69, 0x00, 0x00]);
    expect(await readCappedText(file)).toMatchObject({ binary: true, text: '' });
  });
});
