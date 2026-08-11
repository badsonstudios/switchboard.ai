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
import { HISTORY_TAIL_BYTES, readTranscriptTail, replayResumedHistory } from './history';
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
  } as unknown as Logger;
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
    const n = replayResumedHistory(f, log, {
      ...args,
      projectsRoot: root,
      folder,
      nativeSessionId: `../${slugForCwd(folder)}/${NATIVE}`,
    });
    expect(n).toBe(0);
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
