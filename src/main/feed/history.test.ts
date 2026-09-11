// Replaying a resumed conversation's history (#395).
//
// The transcript layout here is the real one: `<projectsRoot>/<slug of the
// cwd>/<native session id>.jsonl`, written by the CLI (and mirrored by the
// stream fake). What these tests pin is everything BETWEEN the disk and
// `StreamFeed.hydrate` — which file gets found, what a partial or malformed
// line does, and that every failure mode ends with a session that still starts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  HISTORY_TAIL_BYTES,
  readTranscriptHead,
  readTranscriptTail,
  readTranscriptWindow,
  replayResumedHistory,
} from './history';
import { slugForCwd } from '../transcripts/paths';
import { Logger } from '../log/logger';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';

const NATIVE = '00000000-conv-4000-8000-000000000000';

let root: string;
let folder: string;
let log: Logger;
let warned: string[];

const noopLog = (): Logger => {
  warned = [];
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((m: string) => warned.push(m)),
    error: vi.fn(),
    child: vi.fn(),
  };
};

/** Write a transcript for `id` under the layout the CLI uses. */
function writeTranscript(id: string, lines: string[]): string {
  const dir = path.join(root, slugForCwd(folder));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => l + '\n').join(''));
  return file;
}

const userLine = (text: string): string =>
  JSON.stringify({
    type: 'user',
    sessionId: NATIVE,
    cwd: folder,
    timestamp: '2026-08-10T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

beforeEach(() => {
  // real paths, real reads: this module is about the disk, and a mocked `fs`
  // would prove nothing about the one thing it does
  root = tempDir('sb-history-root-');
  folder = tempDir('sb-history-cwd-');
  log = noopLog();
});

// every directory here is per-test, so the whole pending set may go (#213)
afterEach(() => cleanupTempDirs());

describe('readTranscriptTail', () => {
  it('parses whole lines, oldest first', () => {
    const file = writeTranscript(NATIVE, [userLine('one'), userLine('two')]);
    const entries = readTranscriptTail(file);
    expect(entries).toHaveLength(2);
    expect((entries[0].message as { content: Array<{ text: string }> }).content[0].text).toBe('one');
  });

  it('skips a line that does not parse rather than giving up on the file', () => {
    const file = writeTranscript(NATIVE, [userLine('one'), '{not json', userLine('two')]);
    expect(readTranscriptTail(file)).toHaveLength(2);
  });

  it('reads the TAIL when the file is bigger than the budget, and drops the partial first line', () => {
    // three lines, a budget that can only reach into the middle of the first
    const lines = [userLine('one'), userLine('two'), userLine('three')];
    const file = writeTranscript(NATIVE, lines);
    const budget = Buffer.byteLength(lines[1] + '\n' + lines[2] + '\n') + 20;
    const entries = readTranscriptTail(file, budget);
    const texts = entries.map(
      (e) => (e.message as { content: Array<{ text: string }> }).content[0].text
    );
    // the truncated head is gone WHOLE — never as a half-parsed fragment
    expect(texts).toEqual(['two', 'three']);
  });

  it('keeps a first line the budget happens to land exactly on', () => {
    // the off-by-one that costs a whole entry: `size - maxBytes` can fall on a
    // line boundary, where there is no fragment to drop
    const lines = [userLine('one'), userLine('two'), userLine('three')];
    const file = writeTranscript(NATIVE, lines);
    const budget = Buffer.byteLength(lines[1] + '\n' + lines[2] + '\n');
    const texts = readTranscriptTail(file, budget).map(
      (e) => (e.message as { content: Array<{ text: string }> }).content[0].text
    );
    expect(texts).toEqual(['two', 'three']);
  });

  it('caps how many lines it will parse, keeping the most recent', () => {
    const file = writeTranscript(NATIVE, ['one', 'two', 'three'].map(userLine));
    const entries = readTranscriptTail(file, HISTORY_TAIL_BYTES, 2);
    const texts = entries.map(
      (e) => (e.message as { content: Array<{ text: string }> }).content[0].text
    );
    expect(texts).toEqual(['two', 'three']);
  });

  it('an empty or missing file is no history, not a throw', () => {
    const file = writeTranscript(NATIVE, []);
    expect(readTranscriptTail(file)).toEqual([]);
    expect(readTranscriptTail(path.join(root, 'nope.jsonl'))).toEqual([]);
  });
});

describe('readTranscriptWindow (#772)', () => {
  // `cut` is what lets the bus read a small window and know whether a bigger
  // one could show more. Wrong in the "false" direction, a sibling's long
  // history is reported as complete; wrong in the "true" direction, every
  // short transcript claims to have been trimmed.
  it('is not cut when the window reaches the start of the file', () => {
    const file = writeTranscript(NATIVE, [userLine('one'), userLine('two')]);
    const w = readTranscriptWindow(file);
    expect(w.cut).toBe(false);
    expect(w.entries).toHaveLength(2);
  });

  it('is cut when the window starts after byte 0 — including exactly on a line boundary', () => {
    const lines = [userLine('one'), userLine('two'), userLine('three')];
    const file = writeTranscript(NATIVE, lines);
    const midLine = Buffer.byteLength(lines[1] + '\n' + lines[2] + '\n') + 20;
    const onBoundary = Buffer.byteLength(lines[1] + '\n' + lines[2] + '\n');
    // On the boundary is the case worth pinning: no fragment was dropped, the
    // entries look whole, and "one" is still history this read did not see.
    for (const budget of [midLine, onBoundary]) {
      const w = readTranscriptWindow(file, budget);
      expect(w.cut).toBe(true);
      expect(w.entries).toHaveLength(2);
    }
  });

  it('a window exactly the size of the file is not cut', () => {
    const file = writeTranscript(NATIVE, [userLine('one'), userLine('two')]);
    expect(readTranscriptWindow(file, fs.statSync(file).size).cut).toBe(false);
  });

  it('a missing file is no history and not cut — and says it was not READ (#766)', () => {
    expect(readTranscriptWindow(path.join(root, 'nope.jsonl'))).toEqual({
      entries: [],
      cut: false,
      read: false,
    });
  });

  it('distinguishes a file that is empty from one that could not be read (#766)', () => {
    // Both are `entries: []`, and for the Feed the difference genuinely does
    // not matter. It matters for a handoff, whose whole output is a claim about
    // a session: a failed read reported as an empty conversation says "this
    // session did nothing" about a session that may have done everything.
    const empty = writeTranscript(NATIVE, []);
    expect(readTranscriptWindow(empty).read).toBe(true);
    expect(readTranscriptWindow(path.join(root, 'nope.jsonl')).read).toBe(false);
  });
});

describe('readTranscriptHead (#766)', () => {
  // The mirror of `readTranscriptWindow`, and every one of these cases is the
  // mirror of one above — deliberately, because the two failure modes are the
  // same two with the ends swapped, and the head one is the newer and therefore
  // the unproven one. `cut` here means "there is NEWER history past this
  // window", which is the opposite of what the name means on the tail read, and
  // getting that backwards is the single most likely mistake in this function.
  it('reads the OLDEST lines, where the tail read reads the newest', () => {
    const file = writeTranscript(NATIVE, [userLine('one'), userLine('two'), userLine('three')]);
    const budget = Buffer.byteLength(userLine('one') + '\n') + 10;
    const head = readTranscriptHead(file, budget);
    expect(head.entries).toHaveLength(1);
    expect(JSON.stringify(head.entries[0])).toContain('one');
    // The same budget from the other end sees the other end of the file.
    expect(JSON.stringify(readTranscriptWindow(file, budget).entries)).toContain('three');
  });

  it('drops the TRAILING fragment, not the leading one', () => {
    const lines = [userLine('one'), userLine('two')];
    const file = writeTranscript(NATIVE, lines);
    // A budget landing mid-way through the second line: that line is a fragment
    // and must not be parsed, but the first is whole and must survive.
    const head = readTranscriptHead(file, Buffer.byteLength(lines[0] + '\n') + 20);
    expect(head.entries).toHaveLength(1);
    expect(head.cut).toBe(true);
  });

  it('is not cut when the window reaches the end of the file', () => {
    const file = writeTranscript(NATIVE, [userLine('one'), userLine('two')]);
    const exact = readTranscriptHead(file, fs.statSync(file).size);
    expect(exact.cut).toBe(false);
    expect(exact.entries).toHaveLength(2);
    // And a budget larger than the file is still not cut.
    expect(readTranscriptHead(file, 10 * 1024 * 1024).cut).toBe(false);
  });

  it('a window that stops inside the first line yields nothing rather than a fragment', () => {
    const file = writeTranscript(NATIVE, [userLine('one'), userLine('two')]);
    const head = readTranscriptHead(file, 20);
    expect(head.entries).toEqual([]);
    expect(head.cut).toBe(true);
  });

  it('caps lines from the START, not the end', () => {
    const file = writeTranscript(NATIVE, [userLine('one'), userLine('two'), userLine('three')]);
    const head = readTranscriptHead(file, 10 * 1024 * 1024, 2);
    expect(head.entries).toHaveLength(2);
    expect(JSON.stringify(head.entries)).toContain('one');
    expect(JSON.stringify(head.entries)).not.toContain('three');
  });

  it('a missing file, an empty file and a zero budget are three DIFFERENT no-histories', () => {
    // All three are `entries: []` and they are not the same claim. Collapsing
    // them is how a reader ends up asserting completeness about a file it never
    // opened — which, for this reader, is what `cut: false` means.
    expect(readTranscriptHead(path.join(root, 'nope.jsonl'), 1024)).toEqual({
      entries: [],
      cut: false,
      read: false,
    });
    // Read, and genuinely empty: nothing was missed because there is nothing.
    const empty = writeTranscript(NATIVE, []);
    expect(readTranscriptHead(empty, 1024)).toEqual({ entries: [], cut: false, read: true });
    // A window of no bytes over a file with bytes in it MISSED ALL OF THEM —
    // and never opened the file, so it did not read it either.
    const file = writeTranscript(NATIVE, [userLine('one')]);
    expect(readTranscriptHead(file, 0)).toEqual({ entries: [], cut: true, read: false });
  });

  it('skips a line that does not parse rather than losing the file', () => {
    const dir = path.join(root, slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${NATIVE}.jsonl`);
    fs.writeFileSync(file, `not json\n${userLine('one')}\n[]\n${userLine('two')}\n`);
    const head = readTranscriptHead(file, 10 * 1024 * 1024);
    // `[]` is an array, which this reader rejects the way the tail read does.
    expect(head.entries).toHaveLength(2);
  });
});

describe('replayResumedHistory', () => {
  const feed = (): { calls: Array<readonly Record<string, unknown>[]>; hydrate: (s: string, e: readonly Record<string, unknown>[]) => number } => {
    const calls: Array<readonly Record<string, unknown>[]> = [];
    return {
      calls,
      hydrate: (_s, e) => {
        calls.push(e);
        return e.length;
      },
    };
  };

  const args = { sessionId: 'live-1', projectsRoot: '', folder: '', nativeSessionId: NATIVE };

  it('finds the resumed conversation under the slug of its folder and hydrates it', () => {
    writeTranscript(NATIVE, [userLine('one'), userLine('two')]);
    const f = feed();
    const n = replayResumedHistory(f, log, { ...args, projectsRoot: root, folder });
    expect(n).toBe(2);
    expect(f.calls[0]).toHaveLength(2);
  });

  it('replays nothing for a conversation that is not on disk — the card still starts', () => {
    const f = feed();
    expect(replayResumedHistory(f, log, { ...args, projectsRoot: root, folder })).toBe(0);
    expect(f.calls).toEqual([]);
  });

  it('never reads a transcript belonging to another conversation', () => {
    writeTranscript('11111111-other-4000-8000-000000000000', [userLine('not ours')]);
    const f = feed();
    expect(replayResumedHistory(f, log, { ...args, projectsRoot: root, folder })).toBe(0);
  });

  it('refuses an id that is not a conversation id — no path traversal (§5.29)', () => {
    writeTranscript(NATIVE, [userLine('one')]);
    const f = feed();
    // The id reaches us from the persisted workspace file and from hook
    // payloads, and it is interpolated into a path. Every separator shape is
    // refused at the boundary, not at the join.
    for (const id of [
      `../${slugForCwd(folder)}/${NATIVE}`,
      `..\\${slugForCwd(folder)}\\${NATIVE}`,
      path.join(root, slugForCwd(folder), NATIVE),
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      // passes the character class and is inert: it names `..jsonl`
      '..',
    ]) {
      expect(replayResumedHistory(f, log, { ...args, projectsRoot: root, folder, nativeSessionId: id })).toBe(0);
    }
    expect(f.calls).toEqual([]);
  });

  it('a hydrate that throws is survivable — P6, our breakage never blocks a session', () => {
    writeTranscript(NATIVE, [userLine('one')]);
    const exploding = {
      hydrate: (): number => {
        throw new Error('boom');
      },
    };
    expect(() => replayResumedHistory(exploding, log, { ...args, projectsRoot: root, folder })).not.toThrow();
    expect(warned.join(' ')).toContain('could not replay');
  });
});
