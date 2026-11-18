// @vitest-environment jsdom
// A path the AI wrote, made clickable (#1611): what is found, what is drawn.
//
// Through `decorateFeedMarkdown` and `renderMarkdown`, which is the only way
// production reaches the pass, so the guard that takes the feed's namespace
// back first is part of what is claimed. Whether a click RUNS anything is
// main's, and `main/fs/ipc.test.ts` owns that table.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { decorateFeedMarkdown } from './feed-markdown';
import { renderMarkdown } from './markdown';
import {
  FEED_PATH_ATTR,
  FEED_PATH_KIND_ATTR,
  MAX_PATHS_PER_REPLY,
  pathFromText,
  resolveFeedPath,
  type FeedPathLabels,
} from './feed-paths';
import { FEED_STOP_SELECTOR } from './feed-keys';
import {
  askKinds,
  knownKind,
  linkPathsKey,
  MISSING_TTL_MS,
  rememberKind,
  resetLinkPathCacheForTests,
  subscribeLinkPaths,
  type KnownKind,
} from './link-path-cache';
import { MAX_LINK_STATS } from '../../../shared/ipc/fs';

const CODE = { copy: 'Copy', copied: 'Copied', copyCode: 'Copy code' };
const LABELS: FeedPathLabels = {
  open: (n) => `Open ${n}`,
  openInViewer: (n) => `Open ${n} in the document viewer`,
  openFolder: (n) => `Open the folder ${n}`,
  showInFolder: (n) => `Show ${n} in its folder`,
};
const FOLDER = 'C:\\work\\app';

/** what main "said": every path here is a file, or a folder if it ends in a name with no dot */
function world(entries: Record<string, KnownKind>): (abs: string) => KnownKind | undefined {
  return (abs) => entries[abs];
}

function pass(
  markdown: string,
  known: (abs: string) => KnownKind | undefined,
  opts: { folder?: string; streaming?: boolean; html?: boolean } = {}
): { host: HTMLElement; named: string[] } {
  let named: string[] = [];
  const html = opts.html ? markdown : renderMarkdown(markdown);
  const out = decorateFeedMarkdown(html, CODE, {
    streaming: opts.streaming,
    paths: { folder: opts.folder ?? FOLDER, labels: LABELS, known, named: (l) => (named = l) },
  });
  const host = document.createElement('div');
  host.innerHTML = out;
  return { host, named };
}
const links = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`[${FEED_PATH_ATTR}]`)];
const targets = (host: HTMLElement): string[] => links(host).map((l) => l.getAttribute(FEED_PATH_ATTR)!);

describe('pathFromText: what looks like a path (#1611)', () => {
  it.each([
    ['.claude/work_files/x.md', '.claude/work_files/x.md', undefined],
    ['src/a.ts:42', 'src/a.ts', 42],
    ['src/a.ts:42:7', 'src/a.ts', 42],
    ['src/a.ts#L12', 'src/a.ts', 12],
    ['C:\\work\\app\\notes.md', 'C:\\work\\app\\notes.md', undefined],
    ['C:/work/app/notes.md', 'C:/work/app/notes.md', undefined],
    ['/home/u/plan.md', '/home/u/plan.md', undefined],
    ['README.md', 'README.md', undefined],
    ['.env', '.env', undefined],
    ['.claude/work_files/', '.claude/work_files', undefined],
    ['docs/', 'docs', undefined],
    ['"C:\\My Docs\\a b.md"', 'C:\\My Docs\\a b.md', undefined],
  ])('a code span %j is the path %j (line %j)', (raw, path, line) => {
    expect(pathFromText(raw, false)).toEqual(line === undefined ? { path } : { path, line });
  });

  it.each([
    ['see', null],
    ['foo.md.', 'foo.md'],
    ['(src/a.ts),', 'src/a.ts'],
    ['"notes.md"', 'notes.md'],
    ['src/a.ts:42.', 'src/a.ts'],
    ['e.g.', null],
    ['i.e.,', null],
    ['v0.8.142', null],
    ['1.5', null],
    ['1/2', null],
    ['https://example.com/a.md', null],
    ['file:///C:/a.md', null],
    ['dan@example.com', null],
    ['~/notes.md', null],
    ['\\\\host\\share\\a.md', null],
    ['//host/share/a.md', null],
    ['/', null],
    ['C:\\', null],
    ['..', null],
    ['a*.md', null],
  ])('a word in a sentence %j is %j', (raw, path) => {
    const got = pathFromText(raw, true);
    expect(got?.path ?? null).toBe(path);
  });

  it('a code span that is a command, not a path, is not one', () => {
    expect(pathFromText('npm run build', false)).toBeNull();
    expect(pathFromText('a\nb.md', false)).toBeNull();
    expect(pathFromText('x'.repeat(2000) + '.md', false)).toBeNull();
  });

  it('resolves relative paths against the session’s folder, in its spelling', () => {
    expect(resolveFeedPath('.claude/work_files/x.md', FOLDER)).toBe('C:\\work\\app\\.claude\\work_files\\x.md');
    expect(resolveFeedPath('./docs/../README.md', FOLDER)).toBe('C:\\work\\app\\README.md');
    expect(resolveFeedPath('C:/other/a.md', FOLDER)).toBe('C:\\other\\a.md');
    expect(resolveFeedPath('docs/a.md', '/home/u/p')).toBe('/home/u/p/docs/a.md');
    expect(resolveFeedPath('/etc/x.conf', '/home/u/p')).toBe('/etc/x.conf');
  });
});

describe('decorateFeedPaths: only what main said is there is drawn (#1611)', () => {
  const X = 'C:\\work\\app\\.claude\\work_files\\x.md';
  const A = 'C:\\work\\app\\src\\a.ts';
  const DOCS = 'C:\\work\\app\\docs';

  it('a code span naming a file that exists is a link, relative to the folder', () => {
    const { host } = pass('Saved to `.claude/work_files/x.md` for you.', world({ [X]: 'file' }));
    const [link] = links(host);
    expect(link.getAttribute(FEED_PATH_ATTR)).toBe(X);
    expect(link.getAttribute(FEED_PATH_KIND_ATTR)).toBe('file');
    expect(link.getAttribute('role')).toBe('link');
    expect(link.getAttribute('title')).toBe('Open x.md in the document viewer');
    // the code span is still there, inside the link
    expect(link.querySelector('code')?.textContent).toBe('.claude/work_files/x.md');
    // ONE tab stop for the whole conversation: the arrow keys reach it
    expect(link.getAttribute('tabindex')).toBe('-1');
    expect(link.matches(FEED_STOP_SELECTOR)).toBe(true);
  });

  it('a path in prose, with trailing punctuation and a :line suffix', () => {
    const { host } = pass('Look at src/a.ts:42. Then docs.', world({ [A]: 'file' }));
    const [link] = links(host);
    expect(link.getAttribute(FEED_PATH_ATTR)).toBe(A);
    // the words the reply wrote, `:42` and all, but not the full stop
    expect(link.textContent).toBe('src/a.ts:42');
    expect(host.textContent?.trim()).toBe('Look at src/a.ts:42. Then docs.');
    expect(link.getAttribute('title')).toBe('Open a.ts');
  });

  it('absolute paths, in both spellings', () => {
    const { host } = pass(
      'See `C:\\work\\app\\src\\a.ts` and C:/work/app/docs and `/home/u/plan.md`.',
      world({ [A]: 'file', [DOCS]: 'dir' })
    );
    expect(targets(host)).toEqual([A, DOCS]);
    expect(links(host)[1].getAttribute('title')).toBe('Open the folder docs');
  });

  it('a markdown link with a local href is ours, not the browser’s', () => {
    const { host } = pass('Read [the plan](.claude/work_files/x.md).', world({ [X]: 'file' }));
    const a = host.querySelector('a')!;
    expect(a.getAttribute(FEED_PATH_ATTR)).toBe(X);
    expect(a.matches(FEED_STOP_SELECTOR)).toBe(true);
  });

  it('a program is drawn as a link that SAYS it will only be shown in its folder', () => {
    const EXE = 'C:\\work\\app\\tools\\setup.exe';
    const { host } = pass('Run `tools/setup.exe` yourself.', world({ [EXE]: 'file' }));
    expect(links(host)[0].getAttribute('title')).toBe('Show setup.exe in its folder');
  });

  it('⚠️ only paths main has ANSWERED as there are drawn: unknown and missing are words', () => {
    const { host, named } = pass(
      'Here: `.claude/work_files/x.md`, `src/a.ts` and `gone.md`.',
      world({ [X]: 'file', [A]: 'missing' })
    );
    expect(targets(host)).toEqual([X]);
    // …but every one of them is reported, so the caller can ask main about the new ones
    expect(named).toEqual([X, A, 'C:\\work\\app\\gone.md']);
  });

  it('⚠️ not inside a fenced code block', () => {
    const { host, named } = pass('```\ncat .claude/work_files/x.md\n```\n\n```md\n.claude/work_files/x.md\n```', world({ [X]: 'file' }));
    expect(links(host)).toEqual([]);
    expect(named).toEqual([]);
  });

  it('nothing at all while the reply is still arriving', () => {
    let named: string[] | null = null;
    const out = decorateFeedMarkdown(renderMarkdown('`.claude/work_files/x.md`'), CODE, {
      streaming: true,
      paths: { folder: FOLDER, labels: LABELS, known: world({ [X]: 'file' }), named: (l) => (named = l) },
    });
    expect(out).not.toContain(FEED_PATH_ATTR);
    expect(named).toBeNull();
  });

  it('⚠️ a forged attribute is taken back before the pass writes its own', () => {
    // a reply that arrives with the answer already filled in is giving orders
    const forged =
      '<p><span data-feed-path="C:\\Windows\\System32\\calc.exe" data-feed-path-kind="file" class="feed-path" role="link">click me</span></p>';
    const { host } = pass(forged, world({}), { html: true });
    expect(links(host)).toEqual([]);
    expect(host.querySelector('.feed-path')).toBeNull();
  });

  it('caps how many paths one reply may ask about', () => {
    const many = Array.from({ length: MAX_PATHS_PER_REPLY + 20 }, (_, i) => `\`f${i}.md\``).join(' ');
    const { named } = pass(many, world({}));
    expect(named).toHaveLength(MAX_PATHS_PER_REPLY);
  });

  it('a page the picture pass already answers is left to it (#1235)', () => {
    const PAGE = 'C:\\work\\app\\page.html';
    const out = decorateFeedMarkdown(renderMarkdown('[the page](page.html)'), CODE, {
      images: {
        labels: {
          copy: 'Copy', image: 'Image', openInBrowser: 'Open in browser', mediaOmitted: 'x',
          openPicture: (n) => n, openPage: 'Open in browser', notShown: 'x',
          openPageNamed: (n) => n, pagePicture: (n) => n, pageNote: 'x',
        },
        folder: FOLDER,
      },
      paths: { folder: FOLDER, labels: LABELS, known: world({ [PAGE]: 'file' }) },
    });
    const host = document.createElement('div');
    host.innerHTML = out;
    expect(host.querySelector('a')!.hasAttribute(FEED_PATH_ATTR)).toBe(false);
    expect(host.querySelector('a')!.hasAttribute('data-feed-open-path')).toBe(true);
  });
});

describe('the cache: asked off the render, in batches (#1611)', () => {
  let t = 0;
  beforeEach(() => {
    t = 1_000;
    vi.useRealTimers();
  });

  it('asks main once for what it has not heard of, and tells the subscribers', async () => {
    const stat = vi.fn(async (paths: readonly string[]) => paths.map((p) => (p.endsWith('.md') ? 'file' : null)));
    resetLinkPathCacheForTests({ bridge: stat, now: () => t });
    const told = vi.fn();
    subscribeLinkPaths(told);
    askKinds(['C:\\a.md', 'C:\\b.txt']);
    askKinds(['C:\\a.md']); // already queued: not asked twice
    expect(knownKind('C:\\a.md')).toBeUndefined();
    await vi.waitFor(() => expect(told).toHaveBeenCalled());
    expect(stat).toHaveBeenCalledTimes(1);
    expect(knownKind('C:\\a.md')).toBe('file');
    expect(knownKind('C:\\b.txt')).toBe('missing');
    expect(linkPathsKey(['C:\\a.md', 'C:\\b.txt'])).toBe('fC:\\a.md\n');
    // answered: asking again goes nowhere
    askKinds(['C:\\a.md', 'C:\\b.txt']);
    await new Promise((r) => setTimeout(r, 5));
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('batches at MAX_LINK_STATS a call', async () => {
    const stat = vi.fn(async (paths: readonly string[]) => paths.map(() => 'file'));
    resetLinkPathCacheForTests({ bridge: stat, now: () => t });
    askKinds(Array.from({ length: MAX_LINK_STATS * 2 + 1 }, (_, i) => `C:\\f${i}.md`));
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(3));
    expect(stat.mock.calls.map((c) => c[0].length)).toEqual([MAX_LINK_STATS, MAX_LINK_STATS, 1]);
  });

  it('"missing" goes stale, so a file written later becomes a link', async () => {
    const stat = vi.fn(async (paths: readonly string[]) => paths.map(() => null));
    resetLinkPathCacheForTests({ bridge: stat, now: () => t });
    rememberKind('C:\\later.md', 'missing');
    expect(knownKind('C:\\later.md')).toBe('missing');
    t += MISSING_TTL_MS + 1;
    expect(knownKind('C:\\later.md')).toBeUndefined();
  });

  it('a failed or absent bridge draws nothing, and never throws', async () => {
    resetLinkPathCacheForTests({ bridge: null, now: () => t });
    askKinds(['C:\\a.md']);
    await vi.waitFor(() => expect(knownKind('C:\\a.md')).toBe('missing'));
    resetLinkPathCacheForTests({ bridge: () => Promise.reject(new Error('no')), now: () => t });
    askKinds(['C:\\b.md']);
    await vi.waitFor(() => expect(knownKind('C:\\b.md')).toBe('missing'));
  });
});
