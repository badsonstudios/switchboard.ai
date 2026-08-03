// #176 — the filter in pty-noise-filter.js is allowed to delete output, so the
// half of this file that matters is the NEGATIVE half: every test named "keeps"
// proves a specific way a real error survives. If you loosen a pattern there,
// one of those goes red.
import { describe, it, expect } from 'vitest';
import { createAttachConsoleFilter } from './pty-noise-filter.js';

/** verbatim from a `npm run check:pty` run on Windows (Electron 38 / Node 24) */
const DUMP = [
  'C:\\Projects\\sb-wt-1\\node_modules\\node-pty\\lib\\conpty_console_list_agent.js:13',
  'var consoleProcessList = getConsoleProcessList(shellPid);',
  '                         ^',
  '',
  'Error: AttachConsole failed',
  '    at Object.<anonymous> (C:\\Projects\\sb-wt-1\\node_modules\\node-pty\\lib\\conpty_console_list_agent.js:13:26)',
  '    at Module._compile (node:internal/modules/cjs/loader:1879:14)',
  '    at Module._extensions..js (node:internal/modules/cjs/loader:2012:10)',
  '    at Module.load (node:internal/modules/cjs/loader:1601:32)',
  '    at Module._load (node:internal/modules/cjs/loader:1403:12)',
  '    at c._load (node:electron/js2c/node_init:2:18095)',
  '    at wrapModuleLoad (node:internal/modules/cjs/loader:262:19)',
  '    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:169:5)',
  '    at node:internal/main/run_main_module:33:47',
  '',
  'Node.js v24.18.0',
  '',
].join('\n');

/** feed `text` in one chunk; return everything the filter let through */
function run(text, { chunkSize } = {}) {
  let out = '';
  const f = createAttachConsoleFilter((s) => {
    out += s;
  });
  if (chunkSize) {
    for (let i = 0; i < text.length; i += chunkSize) f.push(text.slice(i, i + chunkSize));
  } else {
    f.push(text);
  }
  f.end();
  return { out, suppressed: f.suppressed };
}

/** the trace half of the dump — everything Node emits in its FIRST write() */
const TRACE = DUMP.split('\n').slice(0, 15);
const FOOTER = 'Node.js v24.18.0';

describe('AttachConsole noise filter (#176)', () => {
  it('drops the real dump and counts it', () => {
    expect(run(DUMP)).toEqual({ out: '', suppressed: 1 });
  });

  it('drops all twelve dumps a 12-pty check:pty run produces', () => {
    const r = run(DUMP.repeat(12));
    expect(r.suppressed).toBe(12);
    expect(r.out).toBe('');
  });

  it('drops the dump wherever it appears in the stream', () => {
    const r = run(`before\n${DUMP}between\n${DUMP}after\n`);
    expect(r.out).toBe('before\nbetween\nafter\n');
    expect(r.suppressed).toBe(2);
  });

  it('is insensitive to how the stream is chunked', () => {
    const text = `noise\n${DUMP}more noise\n`;
    for (const chunkSize of [1, 3, 7, 64, 4096]) {
      expect(run(text, { chunkSize })).toEqual({ out: 'noise\nmore noise\n', suppressed: 1 });
    }
  });

  it('tolerates CRLF and preserves the bytes it passes through', () => {
    const crlf = DUMP.split('\n').join('\r\n');
    expect(run(`a\r\n${crlf}b\r\n`)).toEqual({ out: 'a\r\nb\r\n', suppressed: 1 });
  });

  it('passes ordinary stderr through byte for byte', () => {
    const text = 'Error: something real\n    at foo (bar.js:1:1)\nnpm ERR! code 1\n';
    expect(run(text)).toEqual({ out: text, suppressed: 0 });
  });

  it('does not add a newline the child never wrote', () => {
    expect(run('no trailing newline')).toEqual({ out: 'no trailing newline', suppressed: 0 });
  });

  // --- the part that matters: nothing else is ever swallowed ---------------

  it('keeps a dump from the same file with a DIFFERENT error', () => {
    // node-pty's native module can also throw "FreeConsole failed" from the
    // very same line; that one is not known-benign, so it must be printed.
    const other = DUMP.replace('Error: AttachConsole failed', 'Error: FreeConsole failed');
    expect(run(other)).toEqual({ out: other, suppressed: 0 });
  });

  // node-pty forks the agent NON-silent, so the dump shares the child's stderr
  // pipe: a line the check itself wrote really can land at any index inside a
  // block. Every slot is therefore its own test.
  it.each([
    ['the source slot (index 1)', 1],
    ['the caret slot (index 2)', 2],
    ['the message slot (index 4)', 4],
    ['the first frame slot (index 5)', 5],
  ])('keeps the WHOLE block when a foreign line lands in %s', (_label, index) => {
    // nothing is proven yet at these positions, so the entire candidate goes out
    const lines = DUMP.split('\n');
    lines.splice(index, 0, 'FATAL: heap out of memory');
    const spliced = lines.join('\n');
    expect(run(spliced)).toEqual({ out: spliced, suppressed: 0 });
  });

  it.each([
    ['the middle of the stack (index 8)', 8],
    ['just before the footer (index 15)', 15],
  ])('keeps the foreign line itself when it lands in %s', (_label, index) => {
    // past the error line + a real frame the dump IS proven, so it is dropped —
    // but the intruder is put back through the normal path and still prints
    const lines = DUMP.split('\n');
    lines.splice(index, 0, 'FATAL: heap out of memory');
    const r = run(lines.join('\n'));
    expect(r.out).toContain('FATAL: heap out of memory');
    expect(r.out).not.toContain('conpty_console_list_agent.js:13\n');
    expect(r.suppressed).toBe(1);
  });

  it('keeps a check failure concatenated onto the front of the header line', () => {
    // a partial write on the shared pipe splices the check's own line into the
    // agent's first one; the header is anchored so this cannot open a block
    const spliced = `CHECK FAILED: 3 ptys leaked ${DUMP}`;
    expect(run(spliced)).toEqual({ out: spliced, suppressed: 0 });
  });

  it('keeps a prose line that merely looks like a stack frame', () => {
    // `    at least 3 sessions never exited` is not a V8 frame: no :line:col
    const lines = DUMP.split('\n');
    lines.splice(5, 0, '    at least 3 sessions never exited');
    const spliced = lines.join('\n');
    expect(run(spliced)).toEqual({ out: spliced, suppressed: 0 });
  });

  it('keeps the error line when it carries any prefix', () => {
    const prefixed = DUMP.replace(
      'Error: AttachConsole failed',
      '[pty] Error: AttachConsole failed'
    );
    expect(run(prefixed)).toEqual({ out: prefixed, suppressed: 0 });
  });

  it('keeps two dumps that interleave line by line on the shared pipe', () => {
    // the documented fail-safe: neither matches, so both print raw
    const a = DUMP.split('\n');
    const b = DUMP.split('\n');
    const woven = a.flatMap((l, i) => [l, b[i]]).join('\n');
    expect(run(woven)).toEqual({ out: woven, suppressed: 0 });
  });

  it('keeps the block when the caret line is missing', () => {
    const lines = DUMP.split('\n');
    lines.splice(2, 1);
    const broken = lines.join('\n');
    expect(run(broken)).toEqual({ out: broken, suppressed: 0 });
  });

  it('keeps a block truncated BEFORE it is proven', () => {
    // header/source/caret/blank/Error and then the process died: no frame, no
    // proof, so it prints — a crash mid-dump must not vanish
    const cut = DUMP.split('\n').slice(0, 5).join('\n');
    expect(run(cut)).toEqual({ out: cut, suppressed: 0 });
  });

  // --- the detached footer, which is what a loaded 12-pty run actually does --

  it('drops a proven block whose footer never arrived', () => {
    const unterminated = DUMP.slice(0, DUMP.indexOf('Node.js v'));
    expect(run(unterminated)).toEqual({ out: '', suppressed: 1 });
  });

  it('drops both dumps when two traces run together and the footers follow', () => {
    // observed verbatim on a loaded Windows box: Node writes the trace and the
    // `Node.js v…` line in SEPARATE write() calls, so twelve agents sharing one
    // pipe produce A1-15, B1-15, footerA, footerB
    const braided = [...TRACE, ...TRACE, FOOTER, FOOTER].join('\n') + '\n';
    expect(run(braided)).toEqual({ out: '', suppressed: 2 });
  });

  it('handles the full twelve-agent braid', () => {
    const twelve = Array.from({ length: 12 }, () => TRACE).flat();
    const footers = Array.from({ length: 12 }, () => FOOTER);
    expect(run([...twelve, ...footers].join('\n') + '\n')).toEqual({ out: '', suppressed: 12 });
  });

  it('keeps a bare Node.js footer that is not owed to a dropped dump', () => {
    expect(run(`${FOOTER}\n`)).toEqual({ out: `${FOOTER}\n`, suppressed: 0 });
  });

  it('swallows only as many orphan footers as it owes', () => {
    // one dump dropped => one footer owed; the second one is somebody else's
    const text = [...TRACE, FOOTER, FOOTER].join('\n') + '\n';
    expect(run(text)).toEqual({ out: `${FOOTER}\n`, suppressed: 1 });
  });

  it('stops expecting orphan footers once anything unrelated is printed', () => {
    // otherwise the counter never expires and a legitimate `Node.js v…` printed
    // later in the same run gets eaten
    const text = [...TRACE, 'check finished', 'Node.js v22.0.0'].join('\n') + '\n';
    expect(run(text)).toEqual({ out: 'check finished\nNode.js v22.0.0\n', suppressed: 1 });
  });

  it('a stray blank line does not close the orphan-footer window', () => {
    // observed on a real run: one blank slipped between the braided traces and
    // their batched footers, and a footer leaked. A blank is not real output.
    const text = [...TRACE, '', FOOTER].join('\n') + '\n';
    expect(run(text)).toEqual({ out: '\n', suppressed: 1 });
  });

  it('does not eat the footer of a GENUINE crash that follows a dropped dump', () => {
    const realCrash = ['/repo/check.js:9', 'boom();', '^', '', 'Error: real', '    at x (a.js:1:1)', '', FOOTER];
    const text = [...TRACE, ...realCrash].join('\n') + '\n';
    const r = run(text);
    expect(r.suppressed).toBe(1);
    expect(r.out).toBe(realCrash.join('\n') + '\n');
  });

  it('absorbs exactly ONE blank line after the trace, never a stream of them', () => {
    const text = [...TRACE, '', '', 'still here'].join('\n') + '\n';
    // TRACE already ends in the blank that closes write #1; the extra ones are
    // somebody else's and survive
    expect(run(text)).toEqual({ out: '\n\nstill here\n', suppressed: 1 });
  });

  it('does not eat a frame-shaped line that arrives after the trace is closed', () => {
    const text = [...TRACE, '    at cleanup (scripts/check-pty.js:42:9)', 'done'].join('\n') + '\n';
    expect(run(text)).toEqual({
      out: '    at cleanup (scripts/check-pty.js:42:9)\ndone\n',
      suppressed: 1,
    });
  });

  it.each([
    // MAX_BLOCK_LINES is 40; a real dump is 16 lines + 9 frames of headroom
    ['at the 40-line limit, still suppressed', 24, 1],
    ['one line past the limit, kept', 25, 0],
  ])('pins the block-length limit: %s', (_label, extraFrames, expected) => {
    const lines = DUMP.split('\n');
    const padded = [
      ...lines.slice(0, 14),
      ...Array.from({ length: extraFrames }, (_, i) => `    at frame${i} (x.js:1:1)`),
      ...lines.slice(14),
    ].join('\n');
    const r = run(padded);
    expect(r.suppressed).toBe(expected);
    expect(r.out).toBe(expected === 1 ? '' : padded);
  });

  it('keeps everything when the header appears without any dump after it', () => {
    const text = 'node_modules/node-pty/lib/conpty_console_list_agent.js:13\n';
    expect(run(text)).toEqual({ out: text, suppressed: 0 });
  });

  it('flushes an UNPROVEN open block AND a trailing partial line, in order', () => {
    // the one place the two flush paths in end() interact
    const cut = `${DUMP.split('\n').slice(0, 4).join('\n')}\nhalf a li`;
    expect(run(cut)).toEqual({ out: cut, suppressed: 0 });
  });

  it('drops a PROVEN open block but still flushes the trailing partial line', () => {
    expect(run(`${TRACE.join('\n')}\nhalf a li`)).toEqual({ out: 'half a li', suppressed: 1 });
  });

  it('releases a partial line that grows past the buffer cap', () => {
    const huge = 'x'.repeat(1024 * 1024 + 10);
    const r = run(huge);
    expect(r.out).toBe(huge); // released early, but every byte, exactly once
    expect(r.suppressed).toBe(0);
  });

  it('still reports a real error that follows a suppressed dump', () => {
    const r = run(`${DUMP}Error: the thing that actually broke\n`);
    expect(r.out).toBe('Error: the thing that actually broke\n');
    expect(r.suppressed).toBe(1);
  });
});
