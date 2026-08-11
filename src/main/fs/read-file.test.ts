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
import { readCappedText } from './read-file';

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
