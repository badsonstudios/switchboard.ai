// #484 — "the file is not there" and "I could not look" are different answers.
//
// They used to be the same one (`null`), and the session IPC read it as proof
// the conversation was gone and erased the card's only pointer to it. Both still
// DECLINE a resume; only one of them is allowed to be permanent, and that
// decision cannot be made by a caller that was never told which it got.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_LISTED_CONVERSATIONS,
  conversationFile,
  listConversations,
  locateConversation,
  slugForCwd,
} from './paths';

let root: string;
let folder: string;
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-paths-'));
  folder = 'C:/tmp/sb-paths-project';
  dir = path.join(root, slugForCwd(folder).toLowerCase());
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const seed = (id: string, body = '{}\n'): string => {
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
};

describe('locateConversation', () => {
  it('finds the transcript under the case-insensitive slug', () => {
    const file = seed('conv-a');
    expect(locateConversation(root, folder, 'conv-a')).toEqual({ status: 'found', file });
  });

  it('says ABSENT for a conversation that is really not there', () => {
    seed('conv-a');
    expect(locateConversation(root, folder, 'conv-b')).toEqual({ status: 'absent' });
  });

  it('says ABSENT for an id that could never be a conversation', () => {
    // we did not fail to look, we declined to — and that answer never changes,
    // so it must not be reported as uncertainty
    expect(locateConversation(root, folder, '../../etc/passwd')).toEqual({ status: 'absent' });
    expect(locateConversation(root, folder, '')).toEqual({ status: 'absent' });
  });

  it('says UNKNOWN when the root will not list — the transient case (#484)', () => {
    // One antivirus scan, one indexer oplock, one network drive between
    // reconnects. Before this, the caller heard "not there" and wrote that down
    // for ever.
    seed('conv-a');
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    const got = locateConversation(root, folder, 'conv-a');
    expect(got.status).toBe('unknown');
    expect(got.status === 'unknown' && got.reason).toMatch(/EBUSY/);
  });

  it('says UNKNOWN when the FILE will not stat for a reason other than absence', () => {
    seed('conv-a');
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    expect(locateConversation(root, folder, 'conv-a').status).toBe('unknown');
  });

  it('a MISSING root is UNKNOWN, not absence', () => {
    // A root that is not there is evidence we are looking in the wrong place —
    // a HOME the app read differently this launch, a profile still mounting —
    // not evidence that every card in the workspace lost its conversation. One
    // failed readdir must not be able to condemn the whole workspace at once.
    expect(locateConversation(path.join(root, 'nope'), folder, 'conv-a').status).toBe('unknown');
  });

  it('a root that lists but holds no folder for this project is ABSENT', () => {
    // we looked, the layout is intact, the CLI has simply never written a
    // conversation for this cwd
    expect(locateConversation(root, 'C:/tmp/some-other-project', 'conv-a')).toEqual({
      status: 'absent',
    });
  });

  it('conversationFile still flattens to path-or-null for its existing callers', () => {
    const file = seed('conv-a');
    expect(conversationFile(root, folder, 'conv-a')).toBe(file);
    expect(conversationFile(root, folder, 'conv-b')).toBeNull();
    expect(conversationFile(path.join(root, 'nope'), folder, 'conv-a')).toBeNull();
  });
});

describe('listConversations (the repair sweep\u2019s evidence)', () => {
  it('lists this folder\u2019s conversations newest first', () => {
    const a = seed('conv-a');
    const b = seed('conv-b');
    fs.utimesSync(a, new Date(1_000_000), new Date(1_000_000));
    fs.utimesSync(b, new Date(2_000_000), new Date(2_000_000));
    const got = listConversations(root, folder);
    expect(got.status).toBe('ok');
    expect(got.status === 'ok' && got.conversations.map((c) => c.nativeId)).toEqual([
      'conv-b',
      'conv-a',
    ]);
  });

  it('ignores everything that is not a conversation transcript', () => {
    seed('conv-a');
    fs.writeFileSync(path.join(dir, 'notes.md'), 'x');
    fs.mkdirSync(path.join(dir, 'subdir'));
    // an EMPTY transcript is not a conversation either — it is what the CLI
    // leaves when it touched the file and wrote nothing, and reattaching a card
    // to it would look exactly like the wipe this issue is about
    fs.writeFileSync(path.join(dir, 'conv-empty.jsonl'), '');
    const got = listConversations(root, folder);
    expect(got.status === 'ok' && got.conversations.map((c) => c.nativeId)).toEqual(['conv-a']);
  });

  it('a folder the CLI has never written to lists nothing, successfully', () => {
    expect(listConversations(root, 'C:/tmp/never-used')).toEqual({
      status: 'ok',
      conversations: [],
    });
  });

  it('a file that VANISHED mid-listing is dropped; any other stat failure fails the listing', () => {
    // the split the comment promises, and the half nothing pinned: a deleted
    // conversation is a true listing minus one entry, while a file we could not
    // READ leaves "the newest unclaimed one" meaning nothing
    seed('conv-a');
    seed('conv-b');
    const real = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation((p, ...rest) => {
      if (String(p).includes('conv-b')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
    });
    const dropped = listConversations(root, folder);
    expect(dropped.status === 'ok' && dropped.conversations.map((c) => c.nativeId)).toEqual([
      'conv-a',
    ]);

    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    expect(listConversations(root, folder).status).toBe('unknown');
  });

  it('declines a directory too big to scan, rather than truncating it', () => {
    // this runs synchronously on the main process during session start, and a
    // folder of thousands is also the folder where "the newest one" is least
    // likely to be the card's. `unknown` means "do not guess", which is right
    // for both reasons.
    for (let i = 0; i <= MAX_LISTED_CONVERSATIONS; i++) seed(`conv-${i}`);
    const got = listConversations(root, folder);
    expect(got.status).toBe('unknown');
    expect(got.status === 'unknown' && got.reason).toMatch(/past the/);
  });

  it('a directory it could not read is UNKNOWN, never an empty list', () => {
    // the conflation that matters most here: "there is nothing to reattach to"
    // is a decision the sweep acts on, and a file lock must not be able to
    // produce it
    seed('conv-a');
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });
    expect(listConversations(root, folder).status).toBe('unknown');
  });
});
