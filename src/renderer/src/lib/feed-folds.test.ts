import { describe, it, expect } from 'vitest';
import type { FeedBlockDto } from './feed';
import { applyFolds, foldFamily, foldKind, foldRuns, isExploration, FOLD_MIN } from './feed-folds';

let next = 1;
const tool = (name: string, category: string, over: Partial<FeedBlockDto> = {}): FeedBlockDto =>
  ({
    seq: next++,
    kind: 'tool',
    sidechain: false,
    tool: { name, category, summary: `${name.toLowerCase()}-target` },
    ...over,
  }) as unknown as FeedBlockDto;
const read = (over: Partial<FeedBlockDto> = {}) => tool('Read', 'read', over);
const grep = (over: Partial<FeedBlockDto> = {}) => tool('Grep', 'read', over);
const glob = (over: Partial<FeedBlockDto> = {}) => tool('Glob', 'read', over);
const edit = () => tool('Edit', 'edit');
const bash = () => tool('Bash', 'shell');
const agent = () => tool('Agent', 'other');
const prose = (kind: 'assistant' | 'user' | 'thinking' = 'assistant'): FeedBlockDto =>
  ({ seq: next++, kind, sidechain: false, text: 'words' });

const list = (...blocks: FeedBlockDto[]): FeedBlockDto[] => blocks;
const heads = (blocks: FeedBlockDto[]): number[][] => [...foldRuns(blocks).values()].map((r) => r.seqs);

describe('isExploration (#1130)', () => {
  it('is the read-only family and nothing else', () => {
    expect(isExploration(read())).toBe(true);
    expect(isExploration(grep())).toBe(true);
    expect(isExploration(glob())).toBe(true);
    expect(isExploration(tool('LS', 'read'))).toBe(true);
    // mutating or output-bearing tools are events
    expect(isExploration(edit())).toBe(false);
    expect(isExploration(bash())).toBe(false);
    expect(isExploration(agent())).toBe(false);
    expect(isExploration(tool('WebSearch', 'other'))).toBe(false);
    expect(isExploration(prose())).toBe(false);
    // a tool block with no category (an old fixture) is not guessed at
    expect(isExploration({ seq: 1, kind: 'tool', sidechain: false, tool: { name: 'Read' } } as never)).toBe(false);
  });
});

describe('foldRuns (#1130)', () => {
  // the owner's screenshot, in miniature
  it('folds a burst of looking around into one run, and counts it', () => {
    const blocks = list(grep(), grep(), glob(), grep(), read(), grep(), read(), read());
    const runs = [...foldRuns(blocks).values()];
    expect(runs).toHaveLength(1);
    expect(runs[0].head).toBe(blocks[0].seq);
    expect(runs[0].seqs).toEqual(blocks.map((b) => b.seq));
    expect(runs[0].reads).toBe(3);
    expect(runs[0].searches).toBe(5);
    expect(runs[0].latest).toBe('Read read-target');
  });

  it(`leaves fewer than ${FOLD_MIN} alone`, () => {
    expect(heads(list(read()))).toEqual([]);
    expect(heads(list(read(), grep()))).toEqual([]);
    expect(heads(list(read(), grep(), read()))).toHaveLength(1);
  });

  // the boundary rule: prose in the middle is two folds around it, not one
  it('a sentence in the middle makes two folds, and is in neither', () => {
    const a = list(grep(), grep(), read());
    const said = prose();
    const b = list(read(), read(), glob(), grep());
    expect(heads([...a, said, ...b])).toEqual([a.map((x) => x.seq), b.map((x) => x.seq)]);
  });

  it('never folds across or into an event', () => {
    for (const event of [edit, bash, agent, () => prose('user')]) {
      const a = list(grep(), grep(), read());
      const e = event();
      const b = list(read(), read());
      const runs = heads([...a, e, ...b]);
      expect(runs).toEqual([a.map((x) => x.seq)]); // b is only two
      expect(runs.flat()).not.toContain(e.seq);
    }
  });

  // a fold must not put one speaker's work under another's caption
  it('ends where the speaker changes', () => {
    const mine = list(grep(), read(), read());
    const sub = (id: string) => ({ sidechain: true, agentId: id });
    const theirs = list(grep(sub('a1')), read(sub('a1')), read(sub('a1')));
    const others = list(grep(sub('b2')), read(sub('b2')), read(sub('b2')));
    expect(heads([...mine, ...theirs, ...others])).toEqual([
      mine.map((x) => x.seq),
      theirs.map((x) => x.seq),
      others.map((x) => x.seq),
    ]);
    // two of each is three runs of two: nothing folds
    expect(heads(list(grep(), read(), grep(sub('a1')), read(sub('a1'))))).toEqual([]);
  });

  // runs are found in what is RENDERED: on `normal` the thinking block between
  // two calls is not in the list at all, so the caller simply never passes it
  it('is about the list it is given', () => {
    const a = grep();
    const hidden = prose('thinking');
    const b = read();
    const c = read();
    expect(heads([a, hidden, b, c])).toEqual([]); // firehose: thinking is on screen
    expect(heads([a, b, c])).toEqual([[a.seq, b.seq, c.seq]]); // normal: it is not
  });
});

describe('applyFolds (#1130)', () => {
  const burst = (): FeedBlockDto[] => list(grep(), read(), glob(), read());

  it('a closed fold keeps only its head in the list', () => {
    const before = prose();
    const run = burst();
    const after = edit();
    const out = applyFolds([before, ...run, after], () => false);
    expect(out.rendered.map((b) => b.seq)).toEqual([before.seq, run[0].seq, after.seq]);
    expect(out.folds.get(run[0].seq)).toMatchObject({ open: false, seqs: run.map((b) => b.seq) });
  });

  it('an open fold keeps every member, in order', () => {
    const run = burst();
    const all = [prose(), ...run, edit()];
    const out = applyFolds(all, () => true);
    expect(out.rendered).toBe(all); // the same array: nothing was filtered
    expect(out.folds.get(run[0].seq)?.open).toBe(true);
  });

  it('opens and closes each run on its own', () => {
    const a = burst();
    const mid = prose();
    const b = burst();
    const out = applyFolds([...a, mid, ...b], (run) => run.head === b[0].seq);
    expect(out.rendered.map((x) => x.seq)).toEqual([a[0].seq, mid.seq, ...b.map((x) => x.seq)]);
  });

  it('hands back the list untouched when nothing folds', () => {
    const all = [prose(), read(), edit(), grep()];
    const out = applyFolds(all, () => false);
    expect(out.rendered).toBe(all);
    expect(out.folds.size).toBe(0);
  });
});

// #1200 — runs of shell commands fold too. The owner, after #1130: "I just had
// about 12 in a row and they weren't grouped at all."
describe('runs of commands (#1200)', () => {
  const cmd = (over: Record<string, unknown> = {}): FeedBlockDto =>
    tool('Bash', 'shell', {
      tool: { name: 'Bash', category: 'shell', summary: 'npm test', ...over },
    });
  const failed = (): FeedBlockDto => cmd({ out: 'Exit code 1', failed: true });
  const runs = (blocks: FeedBlockDto[]) => [...foldRuns(blocks).values()];

  it('twelve commands in a row are ONE fold, and it says how many', () => {
    const twelve = Array.from({ length: 12 }, () => cmd({ out: 'ok' }));
    const [run, ...rest] = runs(twelve);
    expect(rest).toEqual([]);
    expect(run.kind).toBe('shell');
    expect(run.commands).toBe(12);
    expect(run.seqs).toEqual(twelve.map((b) => b.seq));
    // and it is not counted as looking around
    expect(run.searches + run.reads).toBe(0);
  });

  it('PowerShell is a command like any other: the category decides, not the name', () => {
    const mixed = [cmd(), tool('PowerShell', 'shell'), cmd()];
    expect(runs(mixed)).toHaveLength(1);
    expect(runs(mixed)[0].commands).toBe(3);
  });

  it('a FAILED command is never folded: it ends the run and stands alone', () => {
    const before = [cmd(), cmd(), cmd(), cmd(), cmd()];
    const bad = failed();
    const after = [cmd(), cmd(), cmd(), cmd(), cmd(), cmd()];
    const found = runs([...before, bad, ...after]);
    expect(found.map((r) => r.commands)).toEqual([5, 6]);
    // it is in neither
    for (const r of found) expect(r.seqs).not.toContain(bad.seq);
    expect(foldKind(bad)).toBeNull();
    // ...so with every fold SHUT it is still in the list that is drawn
    const drawn = applyFolds([...before, bad, ...after], () => false).rendered;
    expect(drawn.map((b) => b.seq)).toEqual([before[0].seq, bad.seq, after[0].seq]);
  });

  it('a failure with too few successes around it folds nothing', () => {
    expect(runs([cmd(), cmd(), failed(), cmd(), cmd()])).toEqual([]);
  });

  it('a command that fails AFTER it joined a run leaves it: the fold splits there', () => {
    // it joined when it started (no result yet); the result came back an error
    const run = [cmd(), cmd(), cmd(), cmd(), cmd(), cmd(), cmd()];
    expect(runs(run).map((r) => r.commands)).toEqual([7]);
    const late = run.map((b, i) =>
      i === 3 ? { ...b, tool: { ...b.tool!, out: 'boom', failed: true } } : b
    );
    expect(runs(late).map((r) => r.commands)).toEqual([3, 3]);
  });

  it('commands and looking around never share a fold', () => {
    const mixed = [read(), grep(), cmd(), cmd(), read(), cmd()];
    expect(runs(mixed)).toEqual([]);
    const two = [read(), grep(), glob(), cmd(), cmd(), cmd()];
    expect(runs(two).map((r) => r.kind)).toEqual(['explore', 'shell']);
  });

  it('the closed row shows what the newest command was FOR, or its first line', () => {
    const described = [cmd(), cmd(), cmd({ description: 'Run the unit tests', summary: 'npm test' })];
    expect(runs(described)[0].latest).toBe('Run the unit tests');
    const two = String.fromCharCode(10);
    const bare = [cmd(), cmd(), cmd({ summary: `git status${two}git diff` })];
    expect(runs(bare)[0].latest).toBe('git status');
  });

  it('an exploration run is unchanged: its kind, its counts, no commands', () => {
    const [run] = runs([grep(), read(), glob()]);
    expect(run).toMatchObject({ kind: 'explore', searches: 2, reads: 1, commands: 0 });
  });
});

describe('a result that carried a picture (#1240)', () => {
  const shot = (): FeedBlockDto =>
    tool('Read', 'read', { tool: { name: 'Read', category: 'read', summary: 'shot.png', pictures: ['p1'] } });

  it('is an event: never part of a fold, whichever kind it would have been', () => {
    expect(foldKind(shot())).toBeNull();
    expect(
      foldKind(tool('Bash', 'shell', { tool: { name: 'Bash', category: 'shell', summary: 'x', pictures: ['p'] } }))
    ).toBeNull();
    // an empty list is no picture
    expect(foldKind(tool('Read', 'read', { tool: { name: 'Read', category: 'read', summary: 'a', pictures: [] } }))).toBe(
      'explore'
    );
  });

  it('breaks a run of looking around in two, and is in neither half', () => {
    const before = [read(), grep(), glob()];
    const picture = shot();
    const after = [read(), grep(), glob()];
    const runs = heads(list(...before, picture, ...after));
    expect(runs).toEqual([before.map((b) => b.seq), after.map((b) => b.seq)]);
  });
});
// #1271. The owner: "MCP plugin commands are still not grouped. I see in a
// session right now at least 20 MCP plugin calls in a row for Atlassian."
describe('three more kinds of fold (#1271)', () => {
  const runs = (blocks: FeedBlockDto[], opts = {}) => [...foldRuns(blocks, FOLD_MIN, opts).values()];
  /** a call whose result is in, unless told otherwise */
  const done = (name: string, category: string, extra: Record<string, unknown> = {}): FeedBlockDto =>
    ({
      seq: next++,
      kind: 'tool',
      sidechain: false,
      tool: { name, category, summary: '', out: 'ok', ...extra },
    }) as unknown as FeedBlockDto;
  const mcp = (server: string, toolName: string, extra: Record<string, unknown> = {}): FeedBlockDto =>
    done(`mcp__${server}__${toolName}`, 'other', { mcp: { server, tool: toolName }, ...extra });
  const search = (query: string, extra: Record<string, unknown> = {}): FeedBlockDto =>
    done('WebSearch', 'other', { web: { kind: 'search', query }, ...extra });
  const page = (host: string, extra: Record<string, unknown> = {}): FeedBlockDto =>
    done('WebFetch', 'other', { web: { kind: 'page', host }, ...extra });
  const change = (filePath: string, extra: Record<string, unknown> = {}, name = 'Edit'): FeedBlockDto =>
    done(name, 'edit', { filePath, summary: filePath, ...extra });
  const ATL = 'plugin_atlassian_atlassian';

  describe('MCP calls, per server', () => {
    it("the owner's case: twenty Atlassian calls are one row that names the server and every tool", () => {
      const calls = [
        ...Array.from({ length: 14 }, () => mcp(ATL, 'getJiraIssue')),
        ...Array.from({ length: 6 }, () => mcp(ATL, 'searchJiraIssuesUsingJql')),
      ];
      const [run, ...rest] = runs(calls);
      expect(rest).toEqual([]);
      expect(run.kind).toBe('mcp');
      expect(run.seqs).toHaveLength(20);
      expect(run.subject).toBe('Atlassian');
      // the name as the CLI spells it rides along, for the tooltip
      expect(run.path).toBe(ATL);
      expect(run.parts).toEqual([
        { name: 'searchJiraIssuesUsingJql', count: 6 },
        { name: 'getJiraIssue', count: 14 },
      ]);
      // drawn: one row where there were twenty
      expect(applyFolds(calls, () => false).rendered).toHaveLength(1);
    });

    // an MCP tool can change something, and nothing here can know which. The
    // row is the safeguard, so the one call that is not like the others leads.
    it('the RAREST tool is listed first, wherever in the run it was called', () => {
      const calls = [
        ...Array.from({ length: 9 }, () => mcp(ATL, 'getJiraIssue')),
        mcp(ATL, 'createJiraIssue'),
        ...Array.from({ length: 9 }, () => mcp(ATL, 'getJiraIssue')),
        mcp(ATL, 'addCommentToJiraIssue'),
      ];
      expect(runs(calls)[0].parts.map((p) => `${p.name}:${p.count}`)).toEqual([
        'createJiraIssue:1',
        'addCommentToJiraIssue:1',
        'getJiraIssue:18',
      ]);
    });

    it('two servers never share a fold', () => {
      const calls = [
        mcp(ATL, 'a'), mcp(ATL, 'a'), mcp(ATL, 'a'),
        mcp('github', 'b'), mcp('github', 'b'), mcp('github', 'b'),
      ];
      const found = runs(calls);
      expect(found.map((r) => r.subject)).toEqual(['Atlassian', 'Github']);
      expect(found.map((r) => r.seqs.length)).toEqual([3, 3]);
    });

    it('alternating servers are no run at all', () => {
      const calls = [mcp(ATL, 'a'), mcp('github', 'b'), mcp(ATL, 'a'), mcp('github', 'b'), mcp(ATL, 'a')];
      expect(runs(calls)).toEqual([]);
    });

    it('two servers that READ the same are still two: runs compare the real name', () => {
      const calls = [
        mcp('my_server', 'a'), mcp('my_server', 'a'),
        mcp('my-server', 'a'), mcp('my-server', 'a'),
      ];
      expect(runs(calls)).toEqual([]);
    });

    it('a failed call is its own row, and splits the run around it', () => {
      const before = Array.from({ length: 4 }, () => mcp(ATL, 'getJiraIssue'));
      const bad = mcp(ATL, 'getJiraIssue', { failed: true });
      const after = Array.from({ length: 3 }, () => mcp(ATL, 'getJiraIssue'));
      const found = runs([...before, bad, ...after]);
      expect(found.map((r) => r.seqs.length)).toEqual([4, 3]);
      expect(applyFolds([...before, bad, ...after], () => false).rendered.map((b) => b.seq)).toEqual([
        before[0].seq,
        bad.seq,
        after[0].seq,
      ]);
    });

    it('a resource read joins the fold of the server it names', () => {
      const calls = [
        mcp('notion', 'search'),
        done('ReadMcpResourceTool', 'other', { mcp: { server: 'notion', tool: 'ReadMcpResourceTool' } }),
        mcp('notion', 'search'),
      ];
      expect(runs(calls)[0].parts).toEqual([
        { name: 'ReadMcpResourceTool', count: 1 },
        { name: 'search', count: 2 },
      ]);
    });

    it('a subagent’s calls and the session’s are two runs', () => {
      const mine = [mcp(ATL, 'a'), mcp(ATL, 'a'), mcp(ATL, 'a')];
      const theirs = [mcp(ATL, 'a'), mcp(ATL, 'a'), mcp(ATL, 'a')].map((b) => ({
        ...b,
        sidechain: true,
        agentId: 'agent-1',
      }));
      expect(runs([...mine, ...theirs]).map((r) => r.seqs.length)).toEqual([3, 3]);
    });
  });

  describe('a call that is waiting, or still running, is never inside a closed row', () => {
    it('an MCP call with no result yet is not folded, and joins when it has one', () => {
      const settled = [mcp(ATL, 'a'), mcp(ATL, 'a'), mcp(ATL, 'a')];
      const waiting = mcp(ATL, 'createJiraIssue', { out: undefined });
      expect(foldKind(waiting)).toBeNull();
      // it is recognised all the same: a call opened while it runs stays open
      expect(foldFamily(waiting)).toBe('mcp');
      expect(runs([...settled, waiting])[0].seqs).toEqual(settled.map((b) => b.seq));
      const drawn = applyFolds([...settled, waiting], () => false).rendered;
      expect(drawn.map((b) => b.seq)).toEqual([settled[0].seq, waiting.seq]);

      // the result arrives: the block is re-emitted with `out`, and it joins
      const answered = { ...waiting, tool: { ...waiting.tool!, out: 'created' } } as FeedBlockDto;
      expect(runs([...settled, answered])[0].seqs).toHaveLength(4);
    });

    it('the same for an edit and for a fetch', () => {
      expect(foldKind(change('a.ts', { out: undefined }))).toBeNull();
      expect(foldKind(page('example.com', { out: undefined }))).toBeNull();
      expect(foldKind(change('a.ts'))).toBe('edit');
      expect(foldKind(page('example.com'))).toBe('web');
    });

    it('an empty result is a result', () => {
      expect(foldKind(change('a.ts', { out: '' }))).toBe('edit');
    });

    it('a waiting call in the MIDDLE splits the run until it is answered', () => {
      const a = [change('a.ts'), change('a.ts'), change('a.ts')];
      const held = change('a.ts', { out: undefined });
      const b = [change('a.ts'), change('a.ts'), change('a.ts')];
      expect(runs([...a, held, ...b]).map((r) => r.seqs.length)).toEqual([3, 3]);
    });

    // a denied call comes back as an error result: it must not fold either
    it('a denied call is a failed call: its own row, for good', () => {
      const denied = change('a.ts', { failed: true, out: 'The user denied this edit' });
      expect(foldKind(denied)).toBeNull();
    });

    // #1200's rule is unchanged: a command joins when it starts
    it('a command still joins its run the moment it starts', () => {
      expect(foldKind(bash())).toBe('shell');
    });
  });

  describe('web searches and fetches', () => {
    it('fold together, counted apart, naming what was searched for and where it went', () => {
      const calls = [
        search('dockview skipSetActive'),
        page('github.com'),
        page('dockview.dev'),
        search('dockview addGroup'),
        page('github.com'),
      ];
      const [run] = runs(calls);
      expect(run.kind).toBe('web');
      expect(run.searches).toBe(2);
      expect(run.reads).toBe(3);
      expect(run.commands).toBe(0);
      expect(run.parts).toEqual([
        { name: 'dockview skipSetActive', count: 1 },
        { name: 'github.com', count: 2 },
        { name: 'dockview.dev', count: 1 },
        { name: 'dockview addGroup', count: 1 },
      ]);
    });

    it('a failed fetch stays out', () => {
      const calls = [page('a.com'), page('b.com'), page('c.com', { failed: true }), page('d.com')];
      expect(runs(calls)).toEqual([]);
    });

    it('a call with nothing to name still counts, and adds no empty name', () => {
      const calls = [search(''), page(''), search('x')];
      const [run] = runs(calls);
      expect(run.seqs).toHaveLength(3);
      expect(run.parts).toEqual([{ name: 'x', count: 1 }]);
    });

    it('a web call and an MCP call never share a fold', () => {
      expect(runs([search('a'), search('b'), mcp(ATL, 'a'), mcp(ATL, 'a')])).toEqual([]);
    });
  });

  describe('edits to ONE file', () => {
    it('five changes to one file are one row, named for the file', () => {
      const calls = Array.from({ length: 5 }, () => change('src/renderer/src/components/FeedView.tsx'));
      const [run] = runs(calls);
      expect(run.kind).toBe('edit');
      expect(run.subject).toBe('FeedView.tsx');
      expect(run.path).toBe('src/renderer/src/components/FeedView.tsx');
      expect(run.seqs).toHaveLength(5);
      expect(run.parts).toEqual([]);
      expect(run.latest).toBe('');
    });

    it('Edit, Write, MultiEdit and NotebookEdit to one path are one run', () => {
      const calls = [
        change('a.ts', {}, 'Write'),
        change('a.ts', {}, 'Edit'),
        change('a.ts', {}, 'MultiEdit'),
      ];
      expect(runs(calls)[0].seqs).toHaveLength(3);
      // a notebook has no `filePath` (that field picks the box that draws a
      // call): main stamps the path it changes as `editPath`
      const cells = Array.from({ length: 3 }, () =>
        done('NotebookEdit', 'edit', { summary: 'nb/analysis.ipynb', editPath: 'nb/analysis.ipynb' })
      );
      expect(runs(cells)[0].subject).toBe('analysis.ipynb');
    });

    // Found in review: the path used to be read off `summary`, which main
    // cuts at 120 characters for display.
    it('two long paths that agree for their first 120 characters are two files', () => {
      const deep = `${'d'.repeat(130)}/`;
      const cell = (file: string): FeedBlockDto =>
        done('NotebookEdit', 'edit', { summary: (deep + file).slice(0, 120), editPath: deep + file });
      expect(runs([cell('a.ipynb'), cell('b.ipynb'), cell('a.ipynb')])).toEqual([]);
      const [run] = runs([cell('a.ipynb'), cell('a.ipynb'), cell('a.ipynb')]);
      expect(run.subject).toBe('a.ipynb');
      expect(run.path).toBe(`${deep}a.ipynb`);
    });

    // the owner chose "same file only" over "edited 6 files"
    it('a run ends where the file changes; each stretch folds only by itself', () => {
      const calls = [
        change('a.ts'), change('a.ts'), change('a.ts'),
        change('b.ts'), change('b.ts'),
        change('c.ts'), change('c.ts'), change('c.ts'), change('c.ts'),
      ];
      expect(runs(calls).map((r) => `${r.subject}:${r.seqs.length}`)).toEqual(['a.ts:3', 'c.ts:4']);
    });

    it('six files, one change each, is no fold', () => {
      expect(runs(['a', 'b', 'c', 'd', 'e', 'f'].map((f) => change(`${f}.ts`)))).toEqual([]);
    });

    it('the same file spelled with the slashes the other way is one file', () => {
      const back = String.fromCharCode(92);
      const calls = [change('src/lib/a.ts'), change(`src${back}lib${back}a.ts`), change('src/lib/a.ts')];
      expect(runs(calls)).toHaveLength(1);
    });

    it('case counts only where the platform says it does', () => {
      const calls = [change('C:/p/Feed.tsx'), change('c:/p/feed.tsx'), change('C:/P/FEED.TSX')];
      expect(runs(calls, { caseInsensitivePaths: true })).toHaveLength(1);
      expect(runs(calls, { caseInsensitivePaths: false })).toEqual([]);
      expect(runs(calls)).toEqual([]); // unsaid is the strict reading
    });

    it('a failed edit is the row the owner needs to see: it stays out and splits the run', () => {
      const calls = [
        change('a.ts'), change('a.ts'), change('a.ts'),
        change('a.ts', { failed: true, out: 'String to replace not found in file.' }),
        change('a.ts'), change('a.ts'),
      ];
      expect(runs(calls).map((r) => r.seqs.length)).toEqual([3]);
    });

    it('a sentence between two edits ends the run; it is not swallowed', () => {
      const calls = [change('a.ts'), change('a.ts'), prose(), change('a.ts'), change('a.ts')];
      expect(runs(calls)).toEqual([]);
    });

    it('an edit with no path at all is an event, as it always was', () => {
      const bare = done('Edit', 'edit', { summary: '' });
      expect(foldFamily(bare)).toBeNull();
    });
  });

  describe('the kinds never mix, and the two older ones are untouched', () => {
    it('a lookup between two edits to one file is the end of one run and the start of nothing', () => {
      const calls = [change('a.ts'), change('a.ts'), read(), change('a.ts'), change('a.ts')];
      expect(runs(calls)).toEqual([]);
    });

    it('LSP is looking around: it joins "Explored the code"', () => {
      const lsp = done('LSP', 'other');
      expect(isExploration(lsp)).toBe(true);
      const [run] = runs([read(), lsp, grep()]);
      expect(run.kind).toBe('explore');
      expect(run.reads).toBe(1);
      expect(run.searches).toBe(2);
    });

    it('an exploration run and a command run carry none of the new fields', () => {
      const [explore] = runs([read(), grep(), glob()]);
      expect([explore.subject, explore.path, explore.parts]).toEqual(['', '', []]);
      const [web] = runs([search('a'), search('b'), search('c')]);
      expect([web.subject, web.path]).toEqual(['', '']);
      const [shell] = runs([bash(), bash(), bash()]);
      expect([shell.subject, shell.path, shell.parts]).toEqual(['', '', []]);
    });

    it('a tool of no named kind is an event', () => {
      for (const name of ['Agent', 'Skill', 'ToolSearch', 'TaskCreate', 'AskUserQuestion']) {
        expect(foldFamily(done(name, 'other')), name).toBeNull();
      }
    });

    it('a result that carried a picture is an event, whatever the kind', () => {
      expect(foldKind(mcp('browser', 'screenshot', { pictures: ['h1'] }))).toBeNull();
    });
  });
});
