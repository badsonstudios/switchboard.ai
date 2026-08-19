// @vitest-environment jsdom
// #517 — the off-screen replay of MAIN's ring buffer, driven for real.
//
// Like `terminal-find.test.ts`, this builds an ACTUAL `Terminal` and an ACTUAL
// `SearchAddon` rather than mocking either: the whole claim of this module is
// that a hidden pane's search gives the same answer the visible one would, and
// a mocked terminal could not tell you whether that is true. The only stand-in
// is the IPC read, which is the seam the pane owns.
//
// THE PROBE THAT SHAPED THE MODULE, pinned at the bottom: a terminal that was
// never `open()`ed cannot be searched at all — `SearchAddon.findNext` reaches
// the selection service, which does not exist until then. That is why the host
// is a real off-screen element and not "no element".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { TerminalShadow } from './terminal-shadow';
import type { PtySnapshot } from '../../../shared/ipc/pty';

/**
 * jsdom has no `matchMedia`, and xterm's `CoreBrowserService` calls it while
 * measuring device pixel ratio — `term.open()` throws without this. Same shim,
 * and the same reason, as `terminal-find.test.ts`.
 */
function shimMatchMedia(): void {
  (window as unknown as Record<string, unknown>).matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
}

const snap = (text: string, cols = 80, rows = 24): PtySnapshot => ({ snapshot: text, cols, rows });

let shadow: TerminalShadow | null = null;

beforeEach(() => {
  shimMatchMedia();
  document.body.innerHTML = '';
});

afterEach(() => {
  shadow?.dispose();
  shadow = null;
});

describe('TerminalShadow replays main’s ring buffer and searches it', () => {
  it('finds a term that the renderer’s own xterm never saw', async () => {
    // The done-when, at the unit: nothing here was ever rendered into a pane.
    const read = vi.fn().mockResolvedValue(snap('one NEEDLE\r\ntwo\r\nthree NEEDLE\r\n'));
    shadow = new TerminalShadow({ read });
    const out = await shadow.search({ term: 'NEEDLE' });
    expect(out?.total).toBe(2);
    expect(out?.matches.map((m) => m.line.trim())).toEqual(['one NEEDLE', 'three NEEDLE']);
  });

  it('answers null — never an empty result — when there is no PTY to read', async () => {
    // "We could not look" and "we looked and found none" are different answers,
    // and #516's blocker was exactly the second told in place of the first.
    shadow = new TerminalShadow({ read: vi.fn().mockResolvedValue(null) });
    expect(await shadow.search({ term: 'NEEDLE' })).toBeNull();
  });

  it('…and when the read THROWS, rather than taking find down with it', async () => {
    shadow = new TerminalShadow({ read: vi.fn().mockRejectedValue(new Error('main is gone')) });
    expect(await shadow.search({ term: 'NEEDLE' })).toBeNull();
  });

  it('does NOT interpret the bytes — an escape sequence is not text', async () => {
    // The hard constraint: main's ring buffer is our copy of what the CLI
    // printed; searching it is honest, interpreting it is not. A string scan
    // over the raw bytes would match the `m` of `[32m` and would report the
    // colour codes as part of the line. Handing them to a real terminal gives
    // the line the user saw.
    const read = vi.fn().mockResolvedValue(snap('\u001b[32mERROR\u001b[0m here\r\n'));
    shadow = new TerminalShadow({ read });
    const out = await shadow.search({ term: 'ERROR' });
    expect(out?.total).toBe(1);
    expect(out?.matches[0].line.trim()).toBe('ERROR here');
    // and the sequence itself is not searchable, because it is not text
    expect((await shadow.search({ term: '[32m' }))?.total).toBe(0);
  });

  it('honours a carriage-return overwrite the way the terminal did', async () => {
    // A progress meter rewrites one row. What the user saw is the LAST state,
    // and that is what the replay holds — a byte scan would find all four.
    const read = vi.fn().mockResolvedValue(snap('MARK 1\rMARK 2\rMARK 3\rDONE  \r\n'));
    shadow = new TerminalShadow({ read });
    expect((await shadow.search({ term: 'MARK' }))?.total).toBe(0);
    expect((await shadow.search({ term: 'DONE' }))?.total).toBe(1);
  });

  it('replays at the PTY’s width, so lines wrap where the CLI wrapped them', async () => {
    // 40 columns and a 60-character line: the terminal folds it, and the fold
    // is what the visible pane would show too. Rendering at xterm's default 80
    // would put the whole line on one row and answer a different question.
    const line = `${'x'.repeat(38)}SPLITME${'y'.repeat(15)}\r\n`;
    shadow = new TerminalShadow({ read: vi.fn().mockResolvedValue(snap(line, 40, 10)) });
    const out = await shadow.search({ term: 'x'.repeat(38) });
    expect(out?.total).toBe(1);
    // the row it landed on is 40 wide, not 80 — the geometry travelled with the
    // bytes rather than being guessed
    expect(out?.matches[0].line.length).toBeLessThanOrEqual(40);
  });

  it('reuses a load inside the freshness window, then reads again', async () => {
    // The find bar re-searches on a 200 ms debounce; refetching up to 2 MB per
    // keystroke would be absurd. The cost of the window is stated out loud in
    // the module: an answer can be up to a second stale.
    let clock = 1_000;
    const read = vi.fn().mockResolvedValue(snap('NEEDLE\r\n'));
    shadow = new TerminalShadow({ read, freshMs: 1_000, now: () => clock });

    await shadow.search({ term: 'NEEDLE' });
    await shadow.search({ term: 'NEEDLE' });
    await shadow.search({ term: 'NEED' });
    expect(read).toHaveBeenCalledTimes(1);

    clock += 1_001;
    await shadow.search({ term: 'NEEDLE' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('picks up output that arrived while the tab was hidden', async () => {
    // The freshness that #516 could not have: the renderer's xterm is frozen
    // the moment its tab stops showing, and main's buffer is not.
    let clock = 0;
    let text = 'first\r\n';
    shadow = new TerminalShadow({
      read: () => Promise.resolve(snap(text)),
      freshMs: 10,
      now: () => clock,
    });
    expect((await shadow.search({ term: 'LATER' }))?.total).toBe(0);
    text = 'first\r\nLATER\r\n';
    clock += 100;
    expect((await shadow.search({ term: 'LATER' }))?.total).toBe(1);
  });

  it('shares ONE refresh between concurrent searches', async () => {
    // Two debounced searches must not interleave `reset()`-then-`write()`
    // pairs: the buffer that came out would be neither snapshot.
    const read = vi.fn().mockResolvedValue(snap('NEEDLE NEEDLE\r\n'));
    shadow = new TerminalShadow({ read, freshMs: 0 });
    const [a, b] = await Promise.all([
      shadow.search({ term: 'NEEDLE' }),
      shadow.search({ term: 'NEEDLE' }),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(a?.total).toBe(2);
    expect(b?.total).toBe(2);
  });

  it('builds nothing until it is asked, and takes its host away again', async () => {
    const read = vi.fn().mockResolvedValue(snap('NEEDLE\r\n'));
    shadow = new TerminalShadow({ read });
    expect(shadow.built).toBe(false);
    expect(read).not.toHaveBeenCalled();

    await shadow.search({ term: 'NEEDLE' });
    expect(shadow.built).toBe(true);
    const host = document.body.querySelector('[aria-hidden="true"]');
    expect(host).not.toBeNull();
    // out of the tab order and out of the a11y tree: this is scratch space,
    // not a second terminal the user can land in
    expect((host as HTMLElement).inert).toBe(true);

    shadow.dispose();
    expect(document.body.querySelector('[aria-hidden="true"]')).toBeNull();
    // and a disposed shadow has not looked either — `null`, not zero
    expect(await shadow.search({ term: 'NEEDLE' })).toBeNull();
    shadow.dispose(); // idempotent
  });

  it('gives the SAME answer as the visible pane would (no second search engine)', async () => {
    // The claim that makes this honest rather than clever: the matcher is the
    // addon, on both paths. Drive a terminal the way `TerminalPane` does and
    // compare it with the shadow over the same bytes.
    const text = 'alpha NEEDLE\r\nbeta\r\nneedle lower\r\ngamma NEEDLE tail\r\n';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    const addon = new SearchAddon();
    term.loadAddon(addon);
    term.open(host);
    await new Promise<void>((r) => term.write(text, r));

    const { searchTerminal } = await import('./terminal-find');
    const live = searchTerminal(term, addon, { term: 'NEEDLE' });
    shadow = new TerminalShadow({ read: vi.fn().mockResolvedValue(snap(text)) });
    const replayed = await shadow.search({ term: 'NEEDLE' });

    expect(replayed?.total).toBe(live.total);
    expect(replayed?.matches.map((m) => [m.row, m.col])).toEqual(
      live.matches.map((m) => [m.row, m.col])
    );
    term.dispose();
  });
});

describe('the probe that shaped this module (pinned, 2026-08-19)', () => {
  it('a terminal that was never open()ed cannot be searched at all', async () => {
    // This is why the shadow has a real off-screen host instead of no host:
    // `SearchAddon.findNext` calls `Terminal.select()`, which goes through the
    // SELECTION SERVICE — a browser service that only exists after `open()`.
    // The day xterm makes that work headless, this test is what says so, and
    // the host can go.
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const addon = new SearchAddon();
    term.loadAddon(addon);
    await new Promise<void>((r) => term.write('hello NEEDLE\r\n', r));
    // the bytes DID land — it is only the search that cannot run
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toContain('NEEDLE');
    expect(() => addon.findNext('NEEDLE', { regex: false, incremental: false })).toThrow();
    term.dispose();
  });
});
