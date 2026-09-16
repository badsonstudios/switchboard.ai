// Session history's listing layer (P2-E20-01, §5.33).
//
// What only this file can see: that a row's description comes from the right
// place and falls back in the right ORDER, that the folder is read from the
// transcript's own `cwd` rather than reversed out of a directory name that
// cannot be inverted, that `listConversations`' refusals survive the trip
// intact, and that the per-row cache is keyed on file identity rather than on
// the path (a transcript that has been written to since has a title it did not
// have before).
//
// The shapes below are the real ones, taken from
// `fixtures/session-transcript.jsonl`: a transcript opens with metadata lines
// carrying no `cwd` at all, `isMeta` user lines are plumbing rather than
// prompts, and `ai-title` arrives a dozen lines in.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { clearHistoryCache, listHistory, MAX_HISTORY_DIRS } from './history';
import { slugForCwd } from './paths';
import { tempDir } from '../../test-temp-dirs';

/** The provider's `titles` capability, as the Claude adapter implements it. */
const readTitle = (line: Record<string, unknown>): string | undefined =>
  line.type === 'ai-title' && typeof line.aiTitle === 'string' && line.aiTitle.trim()
    ? line.aiTitle.trim()
    : undefined;

let root: string;

/** Write one transcript into the directory `folder` slugs to. */
function seed(
  folder: string,
  nativeId: string,
  lines: Record<string, unknown>[],
  opts: { mtimeMs?: number; sub?: string } = {}
): string {
  const dir = path.join(root, opts.sub ?? slugForCwd(folder).toLowerCase());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${nativeId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (opts.mtimeMs !== undefined) {
    const when = new Date(opts.mtimeMs);
    fs.utimesSync(file, when, when);
  }
  return file;
}

/** The two lines every real transcript opens with before anything useful. */
const preamble = [{ type: 'queue-operation' }, { type: 'file-history-snapshot' }];

const userLine = (folder: string, text: string, over: Record<string, unknown> = {}) => ({
  type: 'user',
  isSidechain: false,
  cwd: folder,
  message: { role: 'user', content: text },
  uuid: `u-${text.slice(0, 6)}`,
  ...over,
});

const titleLine = (title: string) => ({ type: 'ai-title', aiTitle: title, sessionId: 'x' });

const deps = (over: Partial<Parameters<typeof listHistory>[1]> = {}) => ({
  projectsRoot: root,
  readTitle,
  claimed: () => [],
  ...over,
});

const ok = (a: ReturnType<typeof listHistory>) => {
  if (a.status !== 'ok') throw new Error(`expected ok, got unknown: ${a.reason}`);
  return a;
};

beforeEach(() => {
  root = tempDir('sb-history-');
  clearHistoryCache();
});

describe('listHistory — one folder', () => {
  it("describes a conversation by the CLI's own title", () => {
    seed('C:/work/app', 'conv-a', [...preamble, userLine('C:/work/app', 'hello'), titleLine('Fix the login redirect')]);
    const rows = ok(listHistory({ scope: 'folder', folder: 'C:/work/app' }, deps())).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      nativeId: 'conv-a',
      description: 'Fix the login redirect',
      descriptionFrom: 'title',
      folder: 'C:/work/app',
    });
  });

  it('falls back to the FIRST USER PROMPT when the conversation has no title', () => {
    // 8/200 of the measured sample. The CLI's own picker shows the first prompt
    // too, so this is the same answer by a different route rather than a
    // degraded one.
    seed('C:/work/app', 'conv-b', [...preamble, userLine('C:/work/app', 'why is the build slow')]);
    const rows = ok(listHistory({ scope: 'folder', folder: 'C:/work/app' }, deps())).rows;
    expect(rows[0]).toMatchObject({ description: 'why is the build slow', descriptionFrom: 'prompt' });
  });

  it('skips the plumbing that also arrives as a `user` line', () => {
    // `isMeta` lines, `<local-command-*>` carriers and tool results are all
    // `type: 'user'`. `promptText` already knows the difference — the point of
    // this case is that history ASKS it rather than taking the first user line.
    seed('C:/work/app', 'conv-c', [
      ...preamble,
      userLine('C:/work/app', 'caveat: the messages below were generated', { isMeta: true }),
      userLine('C:/work/app', 'the real question'),
    ]);
    const rows = ok(listHistory({ scope: 'folder', folder: 'C:/work/app' }, deps())).rows;
    expect(rows[0].description).toBe('the real question');
  });

  it('skips a leading slash command and describes the conversation by the real question (#846)', () => {
    // The owner's report: rows read `<command-name>/clear</command-name>…`
    // instead of prose. Measured at 5 of the 40 newest transcripts and 39 of the
    // newest 400 — method stated in `shared/command-invocation.ts`, because an
    // earlier pass quoted a figure that did not reproduce.
    seed('C:/work/app', 'conv-cmd', [
      ...preamble,
      userLine('C:/work/app', '<command-name>/clear</command-name>\n  <command-message>clear</command-message>'),
      userLine('C:/work/app', 'what did we decide about the cache'),
    ]);
    const rows = ok(listHistory({ scope: 'folder', folder: 'C:/work/app' }, deps())).rows;
    expect(rows[0]).toMatchObject({
      description: 'what did we decide about the cache',
      descriptionFrom: 'prompt',
    });
  });

  it('describes a commands-ONLY conversation by the command, never by markup (#846)', () => {
    // A row has to say something, and `/clear` beats both blank and XML. The
    // context package deliberately does NOT do this — see promptText.
    seed('C:/work/app', 'conv-only', [
      ...preamble,
      userLine('C:/work/app', '<command-name>/next-item</command-name>\n<command-args>818</command-args>'),
    ]);
    const rows = ok(listHistory({ scope: 'folder', folder: 'C:/work/app' }, deps())).rows;
    expect(rows[0]).toMatchObject({ description: '/next-item 818', descriptionFrom: 'prompt' });
    expect(rows[0].description).not.toContain('<command-name>');
  });

  it("says 'none' rather than inventing a description", () => {
    seed('C:/work/app', 'conv-d', [...preamble, { type: 'last-prompt' }]);
    const rows = ok(listHistory({ scope: 'folder', folder: 'C:/work/app' }, deps())).rows;
    expect(rows[0]).toMatchObject({ description: '', descriptionFrom: 'none' });
  });

  it('orders newest first', () => {
    seed('C:/work/app', 'old', [...preamble, titleLine('older')], { mtimeMs: 1_000_000 });
    seed('C:/work/app', 'new', [...preamble, titleLine('newer')], { mtimeMs: 9_000_000 });
    const rows = ok(listHistory({ scope: 'folder', folder: 'C:/work/app' }, deps())).rows;
    expect(rows.map((r) => r.nativeId)).toEqual(['new', 'old']);
  });

  it('marks a conversation another card already holds', () => {
    seed('C:/work/app', 'mine', [...preamble, titleLine('t')]);
    const rows = ok(
      listHistory({ scope: 'folder', folder: 'C:/work/app' }, deps({ claimed: () => ['mine'] }))
    ).rows;
    expect(rows[0].claimed).toBe(true);
  });

  it('a `claimed` lookup that THROWS costs the marking, not the listing (P6)', () => {
    seed('C:/work/app', 'x', [...preamble, titleLine('t')]);
    const rows = ok(
      listHistory(
        { scope: 'folder', folder: 'C:/work/app' },
        deps({
          claimed: () => {
            throw new Error('workspace read failed');
          },
        })
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].claimed).toBe(false);
  });

  it('a title reader that throws leaves the row described by its prompt', () => {
    seed('C:/work/app', 'x', [...preamble, userLine('C:/work/app', 'still here'), titleLine('t')]);
    const rows = ok(
      listHistory(
        { scope: 'folder', folder: 'C:/work/app' },
        deps({
          readTitle: () => {
            throw new Error('capability exploded');
          },
        })
      )
    ).rows;
    expect(rows[0]).toMatchObject({ description: 'still here', descriptionFrom: 'prompt' });
  });

  it('passes `listConversations` refusals straight through rather than showing an empty folder', () => {
    // §5.33: reported as unscannable, never silently truncated.
    const dir = path.join(root, slugForCwd('C:/work/big').toLowerCase());
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(dir, `c-${i}.jsonl`), '{}\n');
    const a = listHistory({ scope: 'folder', folder: 'C:/work/big' }, deps());
    expect(a.status).toBe('unknown');
    if (a.status === 'unknown') expect(a.reason).toContain('past the 500');
  });

  it('refuses the folder scope without a folder rather than listing the machine', () => {
    expect(listHistory({ scope: 'folder' }, deps()).status).toBe('unknown');
  });

  it('a folder with no conversations is an EMPTY list, not a failure', () => {
    fs.mkdirSync(path.join(root, slugForCwd('C:/work/empty').toLowerCase()), { recursive: true });
    expect(ok(listHistory({ scope: 'folder', folder: 'C:/work/empty' }, deps())).rows).toEqual([]);
  });

  it("uses the CALLER's folder when the transcript never says where it ran", () => {
    // The caller named the directory, so it is authoritative here — unlike the
    // all-projects scope below, which has no such claim.
    seed('C:/work/app', 'nocwd', [...preamble, { type: 'ai-title', aiTitle: 'titled' }]);
    const rows = ok(listHistory({ scope: 'folder', folder: 'C:/work/app' }, deps())).rows;
    expect(rows[0].folder).toBe('C:/work/app');
  });

  it('never lists a subagent transcript', () => {
    // They live one directory deeper (`<project>/subagents/agent-*.jsonl`), and
    // there are 68,997 of them on the owner's machine. Pinned because the day
    // this recurses is the day they all join the list.
    const slug = slugForCwd('C:/work/app').toLowerCase();
    seed('C:/work/app', 'real', [...preamble, titleLine('t')]);
    seed('C:/work/app', 'agent-1', [...preamble, titleLine('sub')], {
      sub: path.join(slug, 'subagents'),
    });
    const rows = ok(listHistory({ scope: 'folder', folder: 'C:/work/app' }, deps())).rows;
    expect(rows.map((r) => r.nativeId)).toEqual(['real']);
  });

  it('flattens and bounds a description, so one pasted stack trace is not sent to draw one line', () => {
    const huge = `first ${'x'.repeat(5_000)}\nsecond line`;
    seed('C:/work/app', 'big', [...preamble, userLine('C:/work/app', huge)]);
    const rows = ok(listHistory({ scope: 'folder', folder: 'C:/work/app' }, deps())).rows;
    expect(rows[0].description.length).toBeLessThanOrEqual(200);
    expect(rows[0].description).not.toContain('\n');
    expect(rows[0].description.endsWith('…')).toBe(true);
  });

  it('honours a limit, taking the NEWEST rather than whatever was read first', () => {
    seed('C:/work/app', 'old', [...preamble, titleLine('older')], { mtimeMs: 1_000_000 });
    seed('C:/work/app', 'new', [...preamble, titleLine('newer')], { mtimeMs: 9_000_000 });
    const a = ok(listHistory({ scope: 'folder', folder: 'C:/work/app', limit: 1 }, deps()));
    expect(a.rows.map((r) => r.nativeId)).toEqual(['new']);
    expect(a.truncated).toBe(true);
  });
});

describe('listHistory — every project', () => {
  it('spans directories and reads each row’s folder from its own transcript', () => {
    seed('C:/work/app', 'a', [...preamble, userLine('C:/work/app', 'app work')], { mtimeMs: 9_000_000 });
    seed('D:/other/api', 'b', [...preamble, userLine('D:/other/api', 'api work')], { mtimeMs: 8_000_000 });
    const rows = ok(listHistory({ scope: 'all' }, deps())).rows;
    expect(rows.map((r) => r.folder)).toEqual(['C:/work/app', 'D:/other/api']);
  });

  it('DROPS a transcript that cannot say where it ran, rather than guessing from the directory name', () => {
    // `slugForCwd` maps `\ / : . ` and space all onto `-`, so a folder cannot be
    // recovered from a directory name — only compared against one. A row with no
    // folder could not be opened, so offering it would be a dead click.
    seed('C:/work/app', 'good', [...preamble, userLine('C:/work/app', 'fine')]);
    seed('C:/work/app', 'bad', [...preamble, { type: 'ai-title', aiTitle: 'no cwd here' }]);
    const rows = ok(listHistory({ scope: 'all' }, deps())).rows;
    expect(rows.map((r) => r.nativeId)).toEqual(['good']);
  });

  it('skips an over-large project and SAYS the list is short, instead of refusing everything', () => {
    // The one deliberate departure from `listConversations`' all-or-nothing
    // refusal: one unrelated 6,000-conversation project must not cost the user
    // the history of every other one.
    const big = path.join(root, 'c--work-big');
    fs.mkdirSync(big, { recursive: true });
    for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(big, `c-${i}.jsonl`), '{}\n');
    seed('C:/work/app', 'small', [...preamble, userLine('C:/work/app', 'still listed')]);
    const a = ok(listHistory({ scope: 'all' }, deps()));
    expect(a.rows.map((r) => r.nativeId)).toEqual(['small']);
    expect(a.truncated).toBe(true);
  });

  it('a root that will not read is unknown — not "you have no history"', () => {
    const a = listHistory({ scope: 'all' }, deps({ projectsRoot: path.join(root, 'nope') }));
    expect(a.status).toBe('unknown');
  });

  it(`enumerates at most ${MAX_HISTORY_DIRS} project directories, and says when it stopped`, () => {
    for (let i = 0; i < MAX_HISTORY_DIRS + 5; i++) {
      fs.mkdirSync(path.join(root, `proj-${i}`), { recursive: true });
    }
    expect(ok(listHistory({ scope: 'all' }, deps())).truncated).toBe(true);
  });
});

describe('the description cache', () => {
  it('is keyed on file identity, so a conversation written to since is re-read', () => {
    const folder = 'C:/work/app';
    const file = seed(folder, 'conv', [...preamble, userLine(folder, 'first ask')], {
      mtimeMs: 1_000_000,
    });
    expect(ok(listHistory({ scope: 'folder', folder }, deps())).rows[0].description).toBe('first ask');

    // The title the CLI wrote later — a real transcript gains one minutes in.
    fs.writeFileSync(
      file,
      [...preamble, userLine(folder, 'first ask'), titleLine('Now it has a title')]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n'
    );
    const rows = ok(listHistory({ scope: 'folder', folder }, deps())).rows;
    expect(rows[0]).toMatchObject({ description: 'Now it has a title', descriptionFrom: 'title' });
  });

  it('does not re-read a transcript that has not changed', () => {
    const folder = 'C:/work/app';
    seed(folder, 'conv', [...preamble, userLine(folder, 'unchanged')], { mtimeMs: 1_000_000 });
    listHistory({ scope: 'folder', folder }, deps());
    const opened = vi.spyOn(fs, 'openSync');
    expect(ok(listHistory({ scope: 'folder', folder }, deps())).rows[0].description).toBe('unchanged');
    expect(opened).not.toHaveBeenCalled();
    opened.mockRestore();
  });
});
