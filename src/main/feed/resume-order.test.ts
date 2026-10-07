// A resumed Direct session must end on its NEWEST message (#1140).
//
// The real wiring, end to end: `replayResumedHistory` hydrates the stream Feed
// from the conversation's transcripts, and the transcript watcher binds that
// same conversation and hands every subagent transcript it finds to
// `StreamFeed.absorbSidechain` (#977). Both halves are tested on their own
// elsewhere; what neither test asked is where the second half LANDS relative
// to the first — and the answer used to be "after the newest reply".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { StreamFeed } from './stream-feed';
import { firstTurnStamp, mergeHistory, readSidechains, replayResumedHistory } from './history';
import { TranscriptWatcher, slugForCwd } from '../transcripts/watcher';
import { LogSink, createLogger } from '../log/logger';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';

const NATIVE = '0cd72f42-49fe-4d33-bb8d-45006df6dd06';
const SID = 'live-1';
const cwd = 'C:/tmp/resume-order-project';

let root: string;
let logDir: string;
let watcher: TranscriptWatcher | undefined;
/** every subagent line the watcher has OFFERED the Feed, taken or not */
let offered: string[];

beforeEach(() => {
  root = tempDir('sb-ro-root-');
  logDir = tempDir('sb-ro-log-');
  offered = [];
});

afterEach(() => {
  try {
    watcher?.stop();
  } catch {
    /* teardown must never turn into a failure of its own */
  }
  watcher = undefined;
  cleanupTempDirs();
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until the watcher has offered `n` subagent lines.
 *
 * NOT a fixed sleep (review): the assertions after it are about what the Feed
 * did with lines the watcher handed over, and on a loaded machine a sleep can
 * end before the watcher has bound anything — at which point "the backlog is
 * not at the bottom" passes with the fix deleted.
 */
async function offeredAtLeast(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (offered.length < n) {
    if (Date.now() > deadline) throw new Error(`the watcher offered ${offered.length} of ${n}`);
    await sleep(20);
  }
}

/** A moment the evening BEFORE this test runs, whenever that is. */
const at = (minute: number): string =>
  new Date(Date.UTC(2026, 9, 6, 19, minute, 0)).toISOString();

const line = (over: Record<string, unknown>): string =>
  JSON.stringify({ sessionId: NATIVE, cwd, ...over }) + '\n';

const said = (text: string, minute: number, over: Record<string, unknown> = {}): string =>
  line({
    type: 'assistant',
    timestamp: at(minute),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...over,
  });

const asked = (text: string, minute: number): string =>
  line({ type: 'user', timestamp: at(minute), message: { role: 'user', content: text } });

/** The conversation as it sat on disk when the app quit: an early turn that
 *  ran a subagent, then a later turn on something else entirely. */
function writeConversation(): void {
  const dir = path.join(root, slugForCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${NATIVE}.jsonl`),
    asked('research the old thing', 1) +
      said('OLD: the research is back', 5) +
      asked('now write the application', 30) +
      said('LATEST: the application is drafted', 31)
  );
  const subs = path.join(dir, NATIVE, 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  fs.writeFileSync(
    path.join(subs, 'agent-aaaaaa11.jsonl'),
    said('SUBAGENT: digging through the old thing', 2, {
      isSidechain: true,
      agentId: 'aaaaaa11',
      attributionAgent: 'digger',
    }) +
      said('SUBAGENT: found it', 4, {
        isSidechain: true,
        agentId: 'aaaaaa11',
        attributionAgent: 'digger',
      })
  );
}

const textsOf = (feed: StreamFeed): string[] =>
  feed
    .blocks(SID)
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((b) => (b as unknown as { text?: string }).text ?? '');

function resume(feed: StreamFeed): number {
  const log = createLogger(new LogSink({ dir: logDir }), 'transcripts');
  // `sessions:create`, in the order it runs: watch, then replay, with nothing
  // yielding to the event loop in between.
  watcher = new TranscriptWatcher({
    projectsRoot: root,
    log,
    pollMs: 25,
    sidechainSink: (sessionId, entry, origin) => {
      const c = (entry.message as { content?: Array<{ text?: string }> } | undefined)?.content;
      offered.push(c?.[0]?.text ?? '');
      return feed.absorbSidechain(sessionId, entry, origin);
    },
  });
  watcher.watch(SID, { cwd, nativeSessionId: NATIVE, deriveFeed: 'sidechains' });
  return replayResumedHistory(feed, log, {
    sessionId: SID,
    projectsRoot: root,
    folder: cwd,
    nativeSessionId: NATIVE,
  });
}

describe('a resumed Direct session and its subagent transcripts (#1140)', () => {
  // THE REPORT. Red before the fix with `SUBAGENT: found it` as the last block:
  // the watcher appended every subagent file after the replayed conversation.
  it('ends on the newest message, with the subagent where it ran', async () => {
    writeConversation();
    const feed = new StreamFeed();
    expect(resume(feed)).toBe(6);
    // The watcher DID bind, find the subagent file and offer both its lines —
    // which is the moment they used to land under the newest reply.
    await offeredAtLeast(2);
    expect(offered).toEqual(['SUBAGENT: digging through the old thing', 'SUBAGENT: found it']);

    expect(textsOf(feed)).toEqual([
      'research the old thing',
      'SUBAGENT: digging through the old thing',
      'SUBAGENT: found it',
      'OLD: the research is back',
      'now write the application',
      'LATEST: the application is drafted',
    ]);
    // …and the replayed subagent blocks are captioned like live ones
    const sub = feed.blocks(SID).filter((b) => b.sidechain);
    expect(sub.map((b) => [b.agentId, b.agentName])).toEqual([
      ['aaaaaa11', 'digger'],
      ['aaaaaa11', 'digger'],
    ]);
  });

  // The other direction: the check that drops backlog must not drop a subagent
  // that runs AFTER the resume, which is the whole of #977 on a resumed card.
  it('still shows a subagent that runs after the resume', async () => {
    writeConversation();
    const feed = new StreamFeed();
    resume(feed);
    await offeredAtLeast(2);
    const subs = path.join(root, slugForCwd(cwd), NATIVE, 'subagents');
    fs.writeFileSync(
      path.join(subs, 'agent-bbbbbb22.jsonl'),
      line({
        type: 'assistant',
        timestamp: new Date(Date.now() + 1000).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'SUBAGENT: new work' }] },
        isSidechain: true,
        agentId: 'bbbbbb22',
      })
    );
    await offeredAtLeast(3);
    const texts = textsOf(feed);
    expect(texts[texts.length - 1]).toBe('SUBAGENT: new work');
    expect(texts).toHaveLength(7);
  });

  it('a session that was never resumed takes every subagent line, old stamps included', () => {
    const feed = new StreamFeed();
    feed.offer(SID, {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'the session speaks' }] },
    });
    const old = JSON.parse(said('SUBAGENT: old stamp', 2)) as Record<string, unknown>;
    expect(feed.absorbSidechain(SID, old, { sidechain: true, agentId: 'aaaaaa11' })).toBe(true);
    expect(textsOf(feed)).toEqual(['the session speaks', 'SUBAGENT: old stamp']);
  });
});

describe('the backlog cutoff on its own (#1140)', () => {
  const T = Date.UTC(2026, 9, 7, 12, 0, 0);
  const subLine = (text: string, timestamp?: string): Record<string, unknown> => ({
    type: 'assistant',
    ...(timestamp === undefined ? {} : { timestamp }),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  const origin = { sidechain: true, agentId: 'aaaaaa11' };
  const main = { type: 'assistant', message: { content: [{ type: 'text', text: 'replayed' }] } };

  it('drops a line stamped AT the replay, keeps one a millisecond later', () => {
    const feed = new StreamFeed();
    feed.hydrate(SID, [main], { sidechainBacklogBefore: T });
    // taken — TRUE — and not shown
    expect(feed.absorbSidechain(SID, subLine('before', new Date(T - 1).toISOString()), origin)).toBe(true);
    expect(feed.absorbSidechain(SID, subLine('at', new Date(T).toISOString()), origin)).toBe(true);
    expect(feed.absorbSidechain(SID, subLine('after', new Date(T + 1).toISOString()), origin)).toBe(true);
    expect(textsOf(feed)).toEqual(['replayed', 'after']);
  });

  it('lets a line with no readable timestamp through, as it always was', () => {
    const feed = new StreamFeed();
    feed.hydrate(SID, [main], { sidechainBacklogBefore: T });
    feed.absorbSidechain(SID, subLine('no stamp'), origin);
    feed.absorbSidechain(SID, subLine('garbage stamp', 'yesterday-ish'), origin);
    expect(textsOf(feed)).toEqual(['replayed', 'no stamp', 'garbage stamp']);
  });

  it('a replay WITHOUT a cutoff (the old call shape) drops nothing', () => {
    const feed = new StreamFeed();
    feed.hydrate(SID, [main]);
    feed.absorbSidechain(SID, subLine('old', new Date(T - 1).toISOString()), origin);
    expect(textsOf(feed)).toEqual(['replayed', 'old']);
  });

  // A refused replay replayed nothing, so it has no backlog to speak for.
  it('a REFUSED replay sets no cutoff', () => {
    const feed = new StreamFeed();
    feed.offer(SID, { type: 'assistant', message: { content: [{ type: 'text', text: 'live' }] } });
    expect(feed.hydrate(SID, [main], { sidechainBacklogBefore: T })).toBe(0);
    feed.absorbSidechain(SID, subLine('old', new Date(T - 1).toISOString()), origin);
    expect(textsOf(feed)).toEqual(['live', 'old']);
  });

  it('survives a cleared conversation: the old backlog stays out, new work comes in', () => {
    const feed = new StreamFeed();
    feed.hydrate(SID, [main], { sidechainBacklogBefore: T });
    feed.offer(SID, { type: 'conversation_reset', session_id: NATIVE });
    feed.absorbSidechain(SID, subLine('old', new Date(T - 1).toISOString()), origin);
    feed.absorbSidechain(SID, subLine('new', new Date(T + 1).toISOString()), origin);
    expect(textsOf(feed)).toEqual(['new']);
  });

  // Two files interleaved must not cross their tool results over.
  it('pairs each tool result with its own call across interleaved files', () => {
    const feed = new StreamFeed();
    const call = (id: string, minute: number): Record<string, unknown> => ({
      type: 'assistant',
      timestamp: at(minute),
      message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: id } }] },
    });
    const result = (id: string, text: string, minute: number): Record<string, unknown> => ({
      type: 'user',
      timestamp: at(minute),
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    });
    const subCall = call('sub-1', 2);
    const subResult = result('sub-1', 'SUB RESULT', 4);
    const merged = mergeHistory(
      [call('main-1', 1), result('main-1', 'MAIN RESULT', 5)],
      [[subCall, subResult].map((entry) => ({ entry, origin }))]
    );
    feed.hydrate(SID, merged.entries, { origins: merged.origins });
    const blocks = feed.blocks(SID).sort((a, b) => a.seq - b.seq);
    expect(blocks.map((b) => [b.sidechain, JSON.stringify(b).includes('MAIN RESULT')])).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(JSON.stringify(blocks[1])).toContain('SUB RESULT');
  });
});

describe('mergeHistory (#1140)', () => {
  const e = (name: string, minute?: number): Record<string, unknown> =>
    minute === undefined ? { name } : { name, timestamp: at(minute) };
  const names = (entries: Record<string, unknown>[]): unknown[] => entries.map((x) => x.name);
  const sub = (entry: Record<string, unknown>) => ({ entry, origin: { sidechain: true } });

  it('returns the main conversation untouched when there are no subagents', () => {
    const main = [e('a', 3), e('b', 1)];
    const merged = mergeHistory(main, []);
    expect(merged.entries).toEqual(main);
    expect(merged.origins.size).toBe(0);
  });

  it('interleaves by time and remembers which entries were a subagent', () => {
    const s1 = sub(e('s1', 2));
    const merged = mergeHistory([e('m1', 1), e('m2', 5)], [[s1, sub(e('s2', 4))]]);
    expect(names(merged.entries)).toEqual(['m1', 's1', 's2', 'm2']);
    expect(merged.origins.get(s1.entry)).toEqual({ sidechain: true });
    expect(merged.origins.size).toBe(2);
  });

  it('puts the main conversation first on a tie', () => {
    const merged = mergeHistory([e('dispatch', 1), e('result', 3)], [[sub(e('s', 1))]]);
    expect(names(merged.entries)).toEqual(['dispatch', 's', 'result']);
  });

  // A file's own order is the one thing no timestamp may change.
  it('never reorders a file, whatever its stamps say', () => {
    const merged = mergeHistory(
      [e('m1', 5), e('m2', 1), e('m3'), e('m4', 9)],
      [[sub(e('s1', 7)), sub(e('s2', 2)), sub(e('s3'))]]
    );
    const out = names(merged.entries);
    expect(out.filter((n) => String(n).startsWith('m'))).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(out.filter((n) => String(n).startsWith('s'))).toEqual(['s1', 's2', 's3']);
    expect(out[out.length - 1]).toBe('m4');
  });

  it('keeps two subagent files apart from each other by time', () => {
    const merged = mergeHistory(
      [e('m1', 1), e('m2', 9)],
      [[sub(e('a1', 2)), sub(e('a2', 6))], [sub(e('b1', 4))]]
    );
    expect(names(merged.entries)).toEqual(['m1', 'a1', 'b1', 'a2', 'm2']);
  });

  it('leaves out subagent lines older than a CUT main window, and only then', () => {
    const files = [[sub(e('old', 1)), sub(e('new', 6))]];
    const main = [e('m1', 5), e('m2', 9)];
    const edge = Date.parse(at(5));
    expect(names(mergeHistory(main, files, edge).entries)).toEqual(['m1', 'new', 'm2']);
    expect(names(mergeHistory(main, files).entries)).toEqual(['old', 'm1', 'new', 'm2']);
  });

  // A subagent file's stampless OPENING lines belong to its run, not to the
  // top of the conversation.
  it('opens a run with its own unstamped first lines', () => {
    const merged = mergeHistory(
      [e('m1', 1), e('m2', 9)],
      [[sub(e('s0')), sub(e('s1', 4)), sub(e('s2', 5))]]
    );
    expect(names(merged.entries)).toEqual(['m1', 's0', 's1', 's2', 'm2']);
  });
});

describe('firstTurnStamp (#1140)', () => {
  // Attachments and hook summaries are stamped behind the lines around them;
  // the window's edge must not be read off one.
  it('reads the first user or assistant line, not a lagging attachment', () => {
    expect(
      firstTurnStamp([
        { type: 'attachment', timestamp: at(1) },
        { type: 'system', timestamp: at(2) },
        { type: 'user' },
        { type: 'assistant', timestamp: at(30) },
      ])
    ).toBe(Date.parse(at(30)));
    expect(firstTurnStamp([{ type: 'attachment', timestamp: at(1) }])).toBeUndefined();
  });
});

describe('readSidechains (#1140)', () => {
  it('is empty for a conversation with no subagents directory', () => {
    expect(readSidechains(path.join(root, 'nope', `${NATIVE}.jsonl`)).files).toEqual([]);
  });

  it('stamps each line with the agent its FILE names, newest file first', () => {
    writeConversation();
    const dir = path.join(root, slugForCwd(cwd));
    const subs = path.join(dir, NATIVE, 'subagents');
    const newer = path.join(subs, 'agent-cccccc33.jsonl');
    fs.writeFileSync(newer, said('SUBAGENT: the newer file', 20, { isSidechain: true }));
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(newer, later, later);
    const main = path.join(dir, `${NATIVE}.jsonl`);

    const all = readSidechains(main);
    expect(all.files.map((f) => f.map((x) => x.origin.agentId))).toEqual([
      ['cccccc33'],
      ['aaaaaa11', 'aaaaaa11'],
    ]);
    expect(all).toMatchObject({ olderFiles: 0, shortFiles: 0, unreadBytes: 0 });
  });

  it('says what it left unread when the budget or the file cap runs out', () => {
    writeConversation();
    const dir = path.join(root, slugForCwd(cwd));
    const subs = path.join(dir, NATIVE, 'subagents');
    const older = path.join(subs, 'agent-aaaaaa11.jsonl');
    const newer = path.join(subs, 'agent-cccccc33.jsonl');
    fs.writeFileSync(newer, said('SUBAGENT: the newer file', 20, { isSidechain: true }));
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(newer, later, later);
    const main = path.join(dir, `${NATIVE}.jsonl`);
    const olderSize = fs.statSync(older).size;

    // a budget the newer file uses up leaves the older one unopened…
    const tight = readSidechains(main, { maxBytes: fs.statSync(newer).size });
    expect(tight.files).toHaveLength(1);
    expect(tight).toMatchObject({ shortFiles: 1, unreadBytes: olderSize });
    // …and so does the file cap
    const capped = readSidechains(main, { maxFiles: 1 });
    expect(capped.files).toHaveLength(1);
    expect(capped).toMatchObject({ shortFiles: 1, unreadBytes: olderSize });
  });

  // The boot-path saving: a file last written before the replayed window
  // begins is never opened.
  it('does not open a file older than the window', () => {
    writeConversation();
    const dir = path.join(root, slugForCwd(cwd));
    const old = path.join(dir, NATIVE, 'subagents', 'agent-aaaaaa11.jsonl');
    const then = new Date(Date.UTC(2026, 9, 6, 19, 4, 0));
    fs.utimesSync(old, then, then);
    const got = readSidechains(path.join(dir, `${NATIVE}.jsonl`), {
      notBefore: Date.parse(at(30)),
    });
    expect(got).toEqual({ files: [], olderFiles: 1, shortFiles: 0, unreadBytes: 0 });
  });
});
