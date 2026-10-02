// @vitest-environment jsdom
// The History tab as the user meets it (E24 Git v2 item 2).
//
// `lib/git-log-dto.test.ts` owns the RULES — which state wins, what matches a
// search, how a timestamp reads. This file owns what only a mounted component
// can answer:
//
//   1. THE TAB DOES NOT KNOW WHERE IT LIVES. Mounted here with a folder, an
//      `active` flag and two injected readers: no card, no panel, no dockview.
//      `panels.tsx` is a three-line host, and keeping that true is a condition of
//      the item (design §6 leaves "does the graph get its own dock panel?" open).
//   2. Every one of the five states draws something, and none of them draws
//      "no commits" for a repository we failed to read.
//   3. The incoming/outgoing rows carry COUNTS AND NO BUTTONS — the owner's rule
//      that a row with a `＋` that does nothing is worse than a row with no `＋`.
//   4. Paging asks for more and does not lose what it had.
//   5. A superseded answer is dropped rather than written over a fresher one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import {
  HistoryPane,
  HISTORY_PAGE,
  MAX_HISTORY,
  type ReadCommitFiles,
  type ReadLog,
  type ReadStatus,
} from './HistoryPane';
import type { GitCommitDto, GitLogDto } from '../lib/git-log-dto';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import {
  requestFileHistory,
  resetFileHistory,
  setFileHistoryOpener,
} from '../lib/file-history';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const FOLDER = '/proj';
let root: Root | null = null;

function commit(over: Partial<GitCommitDto> = {}): GitCommitDto {
  const id = (over.id ?? 'a'.repeat(40)).padEnd(40, '0').slice(0, 40);
  return {
    parentIds: ['b'.repeat(40)],
    subject: 'a subject',
    message: 'a subject\n\nand a body',
    author: 'danheinz',
    authorEmail: 'dan@example.com',
    timestamp: 1_790_000_000,
    committedTimestamp: 1_790_000_000,
    stats: { files: 2, insertions: 10, deletions: 3 },
    references: [],
    ...over,
    // After the spread, both of them: a caller that overrides `id` with a short
    // string gets the padded 40-hex form AND a `displayId` that matches it, which
    // is what the row actually draws.
    id,
    displayId: over.displayId ?? id.slice(0, 8),
  };
}

const logOf = (commits: GitCommitDto[], extra: Partial<GitLogDto> = {}): GitLogDto => ({
  isRepo: true,
  commits,
  ...extra,
});

/** A reader that records every ask, so "it pages" is assertable. */
function recorder(answers: GitLogDto[] | GitLogDto) {
  const asked: Array<{ folder: string; limit: number; skip: number; path?: string; follow?: boolean }> =
    [];
  let call = 0;
  const readLog: ReadLog = async (folder, q) => {
    asked.push({ folder, ...q });
    return Array.isArray(answers) ? (answers[Math.min(call++, answers.length - 1)] ?? logOf([])) : answers;
  };
  return { readLog, asked };
}

const noStatus: ReadStatus = async () => ({ isRepo: true, files: [] });
const noCommitFiles: ReadCommitFiles = async () => ({ files: [] });

/** Fixed clock, so "14m" is a fact about the component and not about today. */
const NOW = (1_790_000_000 + 840) * 1000;

async function mount(
  readLog: ReadLog,
  opts: { readStatus?: ReadStatus; active?: boolean; readCommitFiles?: ReadCommitFiles } = {}
): Promise<{ setActive: (a: boolean) => Promise<void> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const render = async (a: boolean): Promise<void> => {
    await act(async () => {
      root!.render(
        <HistoryPane
          folder={FOLDER}
          active={a}
          readLog={readLog}
          readStatus={opts.readStatus ?? noStatus}
          readCommitFiles={opts.readCommitFiles ?? noCommitFiles}
          now={() => NOW}
        />
      );
    });
  };
  await render(opts.active ?? true);
  return { setActive: render };
}

const all = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)];
/** Mounted WITH a card id, which is what a pin is keyed on. */
async function mountPinned(readLog: ReadLog): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <HistoryPane
        folder={FOLDER}
        active
        cardId="card-1"
        readLog={readLog}
        readStatus={noStatus}
        readCommitFiles={noCommitFiles}
        now={() => NOW}
      />
    );
  });
}

const rows = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>('.history-row')];
const subjects = (): string[] =>
  [...document.body.querySelectorAll<HTMLElement>('.history-subject')].map((e) => e.textContent ?? '');
const one = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel);
const text = (): string => document.body.textContent ?? '';

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Type into a CONTROLLED input.
 *
 * ⚠️ **`el.value = x` IS NOT ENOUGH AND THE FIRST VERSION OF THIS DID THAT.**
 * React tracks the last value it wrote on the DOM node, so a plain assignment
 * makes the node's value and React's record agree and the synthetic `change`
 * never fires — the test typed, nothing filtered, and the failure looked like a
 * broken filter rather than a broken helper. Going through the prototype's
 * setter is what React's own test utilities do, and it is what makes the event
 * reach `onChange`.
 */
async function type(el: HTMLInputElement | null, value: string): Promise<void> {
  await act(async () => {
    if (!el) return;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    // Wrapped rather than called off the descriptor directly: an unbound method
    // reference is a lint error, and the wrapper is also where the `this` this
    // setter needs is made explicit.
    const setValue = (v: string): void => descriptor?.set?.call(el, v);
    setValue(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the History tab', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    await initI18nForTests();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
  });

  it('draws the commits it was given, newest first, with hash and stats', async () => {
    const { readLog, asked } = recorder(
      logOf([
        commit({ id: 'a1', subject: 'the newest thing' }),
        commit({ id: 'b2', subject: 'the older thing' }),
      ])
    );
    await mount(readLog);
    expect(subjects()).toEqual(['the newest thing', 'the older thing']);
    // Every request declares the folder, so main can refuse one outside its scope.
    expect(asked.every((a) => a.folder === FOLDER)).toBe(true);
    expect(asked[0].limit).toBe(HISTORY_PAGE);
    expect(one('.history-hash')?.textContent).toBe('a1000000');
    expect(one('.history-stats')?.textContent).toContain('+10');
    expect(one('.history-stats')?.textContent).toContain('−3');
    expect(one('.history-when')?.textContent).toBe('14m');
  });

  it('⚠️ `null` stats draw NOTHING, not a zero anybody could believe', async () => {
    // An empty commit really has no numbers. "git said nothing" and "git said
    // zero" are different, and inventing the second is the class of wrong answer
    // this whole surface is a correction for.
    const { readLog } = recorder(logOf([commit({ subject: 'empty commit', stats: null })]));
    await mount(readLog);
    expect(rows()).toHaveLength(1);
    expect(one('.history-stats')).toBeNull();
  });

  it('names the checked-out branch, read off the commits', async () => {
    const { readLog } = recorder(
      logOf([
        commit({
          references: [{ kind: 'branch', name: 'feature/x', full: 'refs/heads/feature/x', isHead: true }],
        }),
      ])
    );
    await mount(readLog);
    expect(one('.history-branch')?.textContent).toContain('feature/x');
    expect(one('.history-detached')).toBeNull();
  });

  it('⚠️ says DETACHED HEAD out loud, because it is a state people lose work in', async () => {
    const { readLog } = recorder(
      logOf([commit({ references: [{ kind: 'head', name: 'HEAD', full: 'HEAD', isHead: true }] })])
    );
    await mount(readLog);
    expect(one('.history-branch')).toBeNull();
    expect(one('.history-detached')).not.toBeNull();
  });

  it('draws a tag and a branch of the SAME NAME as different chips', async () => {
    // The reason `--decorate=full` is in main's command. Short decoration gives
    // `release` and `release` with nothing between them, and drawing them alike
    // would be wrong only in the repository that has the collision.
    const { readLog } = recorder(
      logOf([
        commit({
          references: [
            { kind: 'branch', name: 'release', full: 'refs/heads/release' },
            { kind: 'tag', name: 'release', full: 'refs/tags/release' },
          ],
        }),
      ])
    );
    await mount(readLog);
    expect(one('.history-ref-branch')).not.toBeNull();
    expect(one('.history-ref-tag')).not.toBeNull();
    // Distinguished in the TEXT and not only in the colour, so this survives a
    // colour-blind reader and the high-contrast theme.
    expect(one('.history-ref-tag')?.textContent).not.toBe(one('.history-ref-branch')?.textContent);
  });

  it('marks a merge, so a two-parent commit is not silently just another row', async () => {
    const { readLog } = recorder(
      logOf([commit({ parentIds: ['b'.repeat(40), 'c'.repeat(40)] }), commit({ id: 'd4' })])
    );
    await mount(readLog);
    expect(document.body.querySelectorAll('.history-merge')).toHaveLength(1);
  });

  describe('the five states, and the order they are checked in', () => {
    it('says it is reading before the first answer lands', async () => {
      // A reader that never resolves: the loading state is what is on screen for
      // the whole of a slow read, and it must not be the empty state.
      await mount(() => new Promise<never>(() => {}));
      expect(rows()).toHaveLength(0);
      expect(text()).toContain('Reading the history');
      expect(text()).not.toContain('No commits yet');
    });

    it('⚠️ an UNREADABLE history quotes git and never says "no commits"', async () => {
      const { readLog } = recorder({ isRepo: true, unreadable: 'the repository is damaged', commits: [] });
      await mount(readLog);
      expect(one('.history-unreadable')?.textContent).toContain('the repository is damaged');
      expect(text()).not.toContain('No commits yet');
    });

    it('⚠️ an unreadable answer that ALSO claims unborn still reads as unreadable', async () => {
      // The sharp case. A corrupt branch ref produces both-looking evidence, and
      // main works hard to tell them apart; this is the renderer not undoing it.
      const { readLog } = recorder({
        isRepo: true,
        unborn: true,
        unreadable: 'that ref is damaged',
        commits: [],
      });
      await mount(readLog);
      expect(one('.history-unreadable')).not.toBeNull();
      expect(one('.history-unborn')).toBeNull();
    });

    it('an unborn repository is told it has no commits YET', async () => {
      const { readLog } = recorder({ isRepo: true, unborn: true, commits: [] });
      await mount(readLog);
      expect(one('.history-unborn')).not.toBeNull();
      expect(one('.history-unreadable')).toBeNull();
    });

    it('a folder that is not a repository says that, and nothing about commits', async () => {
      const { readLog } = recorder({ isRepo: false, commits: [] });
      await mount(readLog);
      expect(text()).toContain('Not a git repository');
    });

    it('a refusal on the wire teaches the pane NOTHING — it does not become empty', async () => {
      // `answered()` before the cast. Fail-open here is to keep what we had,
      // which on first mount is the loading state: an honest "we do not know",
      // not a claim that the project has no history.
      // The REAL refusal, built by the real builder. A hand-written
      // `{ ok: false, … }` is not one — `isIpcRefusal` checks a brand symbol and
      // nothing else — so the first version of this test cast a plain object to
      // `GitLogDto`, got `isRepo: undefined`, and asserted against the not-repo
      // branch while believing it was testing the refusal branch.
      const refusal: ReadLog = async () => ipcRefusal('git:log', 'capability-not-held');
      await mount(refusal);
      expect(text()).toContain('Reading the history');
      expect(text()).not.toContain('No commits yet');
    });
  });

  describe('incoming and outgoing', () => {
    it('⚠️ draw COUNTS AND NO BUTTONS — the verbs belong to the item that works', async () => {
      // The owner's rule, applied to a row rather than to a `＋`: *a row with a
      // button that does nothing is worse than a row with no button.* Pull and
      // Push are item 15. These two numbers are `GitStatus.ahead` and `.behind`,
      // which that interface has always carried and which, per the design record
      // §1.2, NO consumer had ever read.
      const { readLog } = recorder(logOf([commit()]));
      await mount(readLog, {
        readStatus: async () => ({ isRepo: true, ahead: 3, behind: 1, files: [] }),
      });
      const incoming = one('.history-incoming');
      const outgoing = one('.history-outgoing');
      expect(incoming?.textContent).toContain('1 commit to pull');
      expect(outgoing?.textContent).toContain('3 commits to push');
      expect(incoming?.querySelector('button')).toBeNull();
      expect(outgoing?.querySelector('button')).toBeNull();
    });

    it('a branch level with its upstream draws neither row', async () => {
      const { readLog } = recorder(logOf([commit()]));
      await mount(readLog, {
        readStatus: async () => ({ isRepo: true, ahead: 0, behind: 0, files: [] }),
      });
      expect(one('.history-incoming')).toBeNull();
      expect(one('.history-outgoing')).toBeNull();
    });

    it('⚠️ a branch with NO UPSTREAM draws neither row either, and that is not the same fact', async () => {
      // git omits the counts entirely when nothing is tracked. Both cases draw
      // nothing; the DTO keeps them apart (`hasUpstream`) so a later surface that
      // offers to set an upstream can tell.
      const { readLog } = recorder(logOf([commit()]));
      await mount(readLog, { readStatus: async () => ({ isRepo: true, files: [] }) });
      expect(one('.history-incoming')).toBeNull();
      expect(one('.history-outgoing')).toBeNull();
    });
  });

  describe('searching', () => {
    it('filters the rows and says how many of how many', async () => {
      const { readLog } = recorder(
        logOf([
          commit({ id: 'a1', subject: 'fix the composer' }),
          commit({ id: 'b2', subject: 'docs: the manual' }),
        ])
      );
      await mount(readLog);
      await type(one('.history-search') as HTMLInputElement, 'composer');
      expect(subjects()).toEqual(['fix the composer']);
      // The count follows the filter. A header saying "2 commits" over one
      // visible row is the kind of small untruth that teaches a user not to
      // trust the bigger numbers.
      expect(text()).toContain('1 of 2');
    });

    it('a query that matches nothing says so, and does not look like an empty repo', async () => {
      const { readLog } = recorder(logOf([commit({ subject: 'fix the composer' })]));
      await mount(readLog);
      await type(one('.history-search') as HTMLInputElement, 'aardvark');
      expect(rows()).toHaveLength(0);
      expect(text()).toContain('aardvark');
      expect(text()).not.toContain('No commits yet');
    });

    it('⚠️ filters what is LOADED and does not re-ask git', async () => {
      // A search that refetched would make every keystroke a `git log` — at the
      // measured ~13ms per commit, a page of fifty is 650ms per letter.
      const { readLog, asked } = recorder(logOf([commit({ subject: 'one' }), commit({ id: 'b2', subject: 'two' })]));
      await mount(readLog);
      const before = asked.length;
      await type(one('.history-search') as HTMLInputElement, 'two');
      expect(asked.length).toBe(before);
    });
  });

  describe('paging', () => {
    it('offers more when a full page came back, and asks for a bigger limit', async () => {
      const page = Array.from({ length: HISTORY_PAGE }, (_, i) =>
        commit({ id: `${i}`.padStart(40, 'a'), subject: `commit ${i}` })
      );
      const { readLog, asked } = recorder([logOf(page), logOf([...page, commit({ id: 'f'.repeat(40), subject: 'older' })])]);
      await mount(readLog);
      expect(one('.history-more')).not.toBeNull();
      await click(one('.history-more'));
      // ONE query for a bigger window, not a second query to be stitched on:
      // re-asking with a larger `--max-count` cannot produce a gap or a
      // duplicate, and stitching two pages can.
      expect(asked[asked.length - 1].limit).toBe(HISTORY_PAGE * 2);
      expect(subjects()).toContain('older');
    });

    it('does NOT offer more when a short page came back', async () => {
      const { readLog } = recorder(logOf([commit(), commit({ id: 'b2' })]));
      await mount(readLog);
      expect(one('.history-more')).toBeNull();
    });

    it('⚠️ a page that FAILS keeps the commits on screen AND keeps the button', async () => {
      // THE BLOCKER REVIEW FOUND. `wanted` used to advance on the click, so a
      // bigger read that came back unreadable left `wanted: 100` against
      // `commits.length: 50` — `mayHaveMore` went false, the button vanished, the
      // list was replaced by the error, and fifty commits were presented as the
      // whole history. Reachable on a real repository, not only in theory: the
      // growing window walks into the 15s budget at around a thousand commits
      // because `--shortstat` costs ~13ms each.
      const page = Array.from({ length: HISTORY_PAGE }, (_, i) =>
        commit({ id: `${i}`.padStart(40, 'a'), subject: `commit ${i}` })
      );
      const { readLog } = recorder([
        logOf(page),
        { isRepo: true, unreadable: 'git did not finish reading the history within 15s', commits: [] },
      ]);
      await mount(readLog);
      expect(rows()).toHaveLength(HISTORY_PAGE);
      await click(one('.history-more'));
      // The fifty are still there…
      expect(rows()).toHaveLength(HISTORY_PAGE);
      // …the pane did NOT flip into the unreadable state…
      expect(one('.history-unreadable')).toBeNull();
      // …the reason is said, beside the button rather than in place of the list…
      expect(one('.history-more-failed')?.textContent).toContain('did not finish');
      // …and the button is still there to try again.
      expect(one('.history-more')).not.toBeNull();
    });

    it('a page that is REFUSED on the wire behaves the same way', async () => {
      const page = Array.from({ length: HISTORY_PAGE }, (_, i) =>
        commit({ id: `${i}`.padStart(40, 'a'), subject: `commit ${i}` })
      );
      let call = 0;
      const readLog: ReadLog = async () =>
        call++ === 0 ? logOf(page) : ipcRefusal('git:log', 'capability-not-held');
      await mount(readLog);
      await click(one('.history-more'));
      expect(rows()).toHaveLength(HISTORY_PAGE);
      expect(one('.history-more-failed')).not.toBeNull();
      expect(one('.history-more')).not.toBeNull();
    });

    it('⚠️ a REJECTED read does not latch the button on "Reading more…"', async () => {
      // No `.catch` meant an unhandled rejection AND `loadingMore` stuck true for
      // ever: the button permanently disabled, reading "Reading more…".
      const page = Array.from({ length: HISTORY_PAGE }, (_, i) =>
        commit({ id: `${i}`.padStart(40, 'a'), subject: `commit ${i}` })
      );
      let call = 0;
      const readLog: ReadLog = async () => {
        if (call++ === 0) return logOf(page);
        throw new Error('the bridge is gone');
      };
      await mount(readLog);
      await click(one('.history-more'));
      const more = one('.history-more') as HTMLButtonElement | null;
      expect(more).not.toBeNull();
      expect(more?.disabled).toBe(false);
      expect(one('.history-more-failed')).not.toBeNull();
    });

    it('⚠️ the CEILING says so rather than the button going quiet', async () => {
      // Without this, the last click returned the same rows and the button
      // vanished with no explanation — which reads as a broken button.
      //
      // ⚠️ **FILTERED DOWN TO ONE VISIBLE ROW, AND THAT IS NOT COSMETIC.** Rendering
      // all two thousand rows in jsdom exhausted the heap once the lane gutter
      // landed — which is how the real bug behind it was found: the gutter drew one
      // `<line>` per LANE rather than per visible column, and this fixture's two
      // thousand sibling commits occupy two thousand lanes. The filter keeps the
      // test about the ceiling, and it pins a second true thing: **the ceiling
      // notice is a fact about the PAGE, so a filter does not hide it.**
      // ⚠️ **A CHAIN, NOT TWO THOUSAND SIBLINGS, AND CI IS WHAT TAUGHT ME THAT.**
      // The first fixture gave every commit the same parent — so the lane
      // allocator opened two thousand LANES, which is O(n·k) with k = n, measured
      // at 1,788 ms locally and over the 5 s test timeout on the runner. It is
      // also not a history: two thousand concurrent branch tips does not happen.
      // A chain is what a real page of two thousand commits looks like (one lane),
      // and it runs in a tenth of the time. `git-lanes.test.ts` still covers the
      // wide case, at a size that is a test rather than a stress.
      const page = Array.from({ length: MAX_HISTORY }, (_, i) =>
        commit({
          id: `${i}`.padStart(40, 'a'),
          parentIds: [`${i + 1}`.padStart(40, 'a')],
          subject: `commit ${i}`,
        })
      );
      const { readLog } = recorder(logOf(page));
      await mount(readLog);
      await type(one('.history-search') as HTMLInputElement, 'commit 1777');
      expect(rows()).toHaveLength(1);
      expect(one('.history-more')).toBeNull();
      expect(one('.history-ceiling')).not.toBeNull();
      // ⚠️ **AN EXPLICIT TIMEOUT, BECAUSE THIS TEST REALLY DOES TWO THOUSAND
      // COMMITS OF WORK.** Measured at ~1.1 s locally after the fixture became a
      // chain, which is comfortably under vitest's 5 s default here and was NOT
      // under it on a loaded CI runner — the same lesson `git-service.test.ts`
      // records as #512 ("7,123 ms for a test that runs in well under a second
      // locally"). Raising the ceiling for the one test that needs it, rather
      // than shrinking the claim.
    }, 30_000);

    it('⚠️ does NOT re-run `git status` for every page', async () => {
      // `git:status` carries the whole #776 config guard — a config read, a
      // submodule enumeration, several extra git processes — for two numbers that
      // cannot have changed between one page of the same history and the next.
      const page = Array.from({ length: HISTORY_PAGE }, (_, i) =>
        commit({ id: `${i}`.padStart(40, 'a'), subject: `commit ${i}` })
      );
      const { readLog } = recorder([logOf(page), logOf(page)]);
      let statusCalls = 0;
      await mount(readLog, {
        readStatus: async () => {
          statusCalls++;
          return { isRepo: true, files: [] };
        },
      });
      expect(statusCalls).toBe(1);
      await click(one('.history-more'));
      expect(statusCalls).toBe(1);
    });
  });

  it('⚠️ drops a SUPERSEDED answer rather than writing it over a fresher one', async () => {
    // Reachable by switching away and back while a page is in flight. A stale
    // page landing after a fresh one shows older history with nothing to say so —
    // the same guard `FileTree` carries, and for the same reason.
    const resolvers: Array<(v: GitLogDto) => void> = [];
    const readLog: ReadLog = () => new Promise<GitLogDto>((r) => resolvers.push(r));
    const { setActive } = await mount(readLog, { active: false });
    // Round 1 is in flight from mount. Coming into view starts round 2.
    await setActive(true);
    expect(resolvers.length).toBe(2);
    // Round 2 answers first, then the stale round 1 arrives.
    await act(async () => {
      resolvers[1](logOf([commit({ id: 'f1', subject: 'the fresh answer' })]));
    });
    await act(async () => {
      resolvers[0](logOf([commit({ id: 's1', subject: 'the stale answer' })]));
    });
    expect(subjects()).toEqual(['the fresh answer']);
  });

  it('re-asks when the tab comes back into view, because nothing watches the repo', async () => {
    const { readLog, asked } = recorder([logOf([commit({ subject: 'before' })]), logOf([commit({ id: 'c3', subject: 'after' })])]);
    const { setActive } = await mount(readLog, { active: true });
    expect(subjects()).toEqual(['before']);
    await setActive(false);
    const before = asked.length;
    await setActive(true);
    expect(asked.length).toBeGreaterThan(before);
    expect(subjects()).toEqual(['after']);
  });

  describe('expanding a commit (E24 Git v2 item 4)', () => {
    const files = {
      files: [
        { path: 'src/a.ts', letter: 'M', insertions: 12, deletions: 3 },
        { path: 'd/new.ts', letter: 'R', from: 'd/old.ts', insertions: 0, deletions: 0 },
        { path: 'logo.png', letter: 'M', insertions: 0, deletions: 0, binary: true },
      ],
    };

    it('shows what the commit changed, with letters and numbers (the done-when)', async () => {
      const { readLog } = recorder(logOf([commit({ id: 'a1', subject: 'the commit' })]));
      await mount(readLog, { readCommitFiles: async () => files });
      expect(one('.history-files')).toBeNull();
      await click(one('.history-row'));
      expect(all('.history-file').map((f) => f.dataset.path)).toEqual([
        'src/a.ts',
        'd/new.ts',
        'logo.png',
      ]);
      expect(one('.history-file-stat')?.textContent).toContain('+12');
    });

    it('⚠️ the row is a TOGGLE, and says so', async () => {
      // Clicking the open row closes it. The alternative — open, then re-fetch —
      // makes one gesture do different things depending on state it does not show.
      const { readLog } = recorder(logOf([commit()]));
      await mount(readLog, { readCommitFiles: async () => files });
      const row = one('.history-row');
      expect(row?.getAttribute('aria-expanded')).toBe('false');
      await click(row);
      expect(one('.history-row')?.getAttribute('aria-expanded')).toBe('true');
      await click(one('.history-row'));
      expect(one('.history-files')).toBeNull();
    });

    it('⚠️ ONE AT A TIME — opening another closes the first', async () => {
      // A list whose rows all expand is a list whose rows move under the pointer
      // as each answer lands. The file list is a detail view; the `gitdiff-` panel
      // is what two comparisons side by side are for.
      const { readLog } = recorder(
        logOf([commit({ id: 'a1', subject: 'first' }), commit({ id: 'b2', subject: 'second' })])
      );
      await mount(readLog, { readCommitFiles: async () => files });
      await click(rows()[0]);
      expect(all('.history-files')).toHaveLength(1);
      await click(rows()[1]);
      expect(all('.history-files')).toHaveLength(1);
    });

    it('⚠️ a BINARY file says binary, and a zero-and-zero row says NOTHING', async () => {
      // A pure mode change or a rename with no content change has no lines either
      // way; `+0 −0` on it would be a number about nothing.
      const { readLog } = recorder(logOf([commit()]));
      await mount(readLog, { readCommitFiles: async () => files });
      await click(one('.history-row'));
      const stats = all('.history-file-stat').map((s) => s.textContent?.trim() ?? '');
      expect(stats[1]).toBe('');
      expect(stats[2]).toContain('binary');
    });

    it('a RENAME says where it came from', async () => {
      const { readLog } = recorder(logOf([commit()]));
      await mount(readLog, { readCommitFiles: async () => files });
      await click(one('.history-row'));
      const renamed = all('.history-file').find((f) => f.dataset.path === 'd/new.ts');
      expect(renamed?.getAttribute('title')).toContain('d/old.ts');
    });

    it('⚠️ a commit we could NOT read says so, rather than drawing an empty list', async () => {
      const { readLog } = recorder(logOf([commit()]));
      await mount(readLog, {
        readCommitFiles: async () => ({ files: [], unreadable: 'that object is corrupt' }),
      });
      await click(one('.history-row'));
      expect(one('.history-files-unreadable')?.textContent).toContain('that object is corrupt');
      expect(all('.history-file')).toHaveLength(0);
    });

    it('an EMPTY commit says it changed no files', async () => {
      const { readLog } = recorder(logOf([commit({ stats: null })]));
      await mount(readLog, { readCommitFiles: async () => ({ files: [] }) });
      await click(one('.history-row'));
      expect(text()).toContain('changed no files');
    });

    it('⚠️ a REFUSAL on the wire is reported, not read as "no files"', async () => {
      const { readLog } = recorder(logOf([commit()]));
      await mount(readLog, {
        readCommitFiles: async () => ipcRefusal('git:commitFiles', 'capability-not-held'),
      });
      await click(one('.history-row'));
      expect(one('.history-files-unreadable')).not.toBeNull();
    });

    it('⚠️ asks git with the OWN parents of the commit — what the empty-tree fallback needs', async () => {
      const asked: Array<{ id: string; parentIds: string[] }> = [];
      const { readLog } = recorder(
        // A HEX id, because `isCommitRef` in main refuses anything else before it
        // reaches argv — so a fixture with a non-hex id would be testing a request
        // the real channel would reject.
        logOf([commit({ id: 'abcdef12', parentIds: [] })])
      );
      await mount(readLog, {
        readCommitFiles: async (_f, c) => {
          asked.push(c);
          return { files: [] };
        },
      });
      await click(one('.history-row'));
      // A ROOT commit — no parents — which is the case that shows an empty diff
      // for every file if the base is not substituted. Main does the substituting;
      // what this pins is that the renderer passes the fact along rather than
      // inventing a parent.
      expect(asked[0].parentIds).toEqual([]);
      expect(asked[0].id).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe('pinned to one file (E24 Git v2 item 10)', () => {
    beforeEach(() => resetFileHistory());

    it('⚠️ asks git with `path` AND `follow`, which is the whole of the item', async () => {
      // `--follow` without the path is meaningless and `path` without `--follow`
      // ENDS a file's history at a rename: the commits before the `git mv` simply
      // are not there, which reads as "this file is new" about a file somebody has
      // been editing for a year.
      setFileHistoryOpener(() => undefined);
      requestFileHistory('card-1', FOLDER, 'src/a.ts');
      const { readLog, asked } = recorder(logOf([commit()]));
      await mountPinned(readLog);
      expect(asked[0]).toMatchObject({ path: 'src/a.ts', follow: true });
    });

    it('⚠️ SAYS it is filtered, and the chip’s ✕ is the way back', async () => {
      // A filtered history that did not say so would read as a repository with
      // three commits in it — the confident wrong answer this epic corrects, in a
      // new shape.
      setFileHistoryOpener(() => undefined);
      requestFileHistory('card-1', FOLDER, 'src/a.ts');
      // TWO answers, because ✕ really does refetch: the filtered page, then the
      // whole history. A single fixed answer would have the stub keep saying
      // `filteredBy` after the unpin, and the assertion below would be about the
      // test rather than about the pane.
      const { readLog } = recorder([
        logOf([commit()], { filteredBy: 'src/a.ts' }),
        logOf([commit(), commit({ id: 'b2' })]),
      ]);
      await mountPinned(readLog);
      expect(one('.history-pinned')).not.toBeNull();
      expect(one('.history-pinned')?.getAttribute('title')).toContain('src/a.ts');
      await click(one('.history-unpin'));
      expect(one('.history-pinned')).toBeNull();
    });

    it('⚠️ THE SENTENCE IS ANNOUNCED, not left in a hover-only `title`', async () => {
      // The chip's visible content is a bidi-isolated path truncated from the
      // front, inside `direction: rtl` — so without this NO WORDS anywhere said
      // the list was a subset. A `title` on a non-focusable span reaches a mouse
      // and nothing else, which is the lesson `CommitRow` in this same file
      // already records.
      setFileHistoryOpener(() => undefined);
      requestFileHistory('card-1', FOLDER, 'src/a.ts');
      const { readLog } = recorder(logOf([commit()], { filteredBy: 'src/a.ts' }));
      await mountPinned(readLog);
      const chip = one('.history-pinned');
      expect(chip?.getAttribute('role')).toBe('status');
      expect(chip?.getAttribute('aria-label')).toContain('Showing only the commits');
      expect(chip?.getAttribute('aria-label')).toContain('src/a.ts');
    });

    it('⚠️⚠️ THE CHIP IS DRAWN FROM THE ANSWER, SO IT CANNOT CLAIM A FILTER THAT DID NOT HAPPEN', async () => {
      // ⚠️ **THE BUG THIS PINS, AND IT IS THE WORST SHAPE IN THE ITEM.** The chip
      // keyed off the REQUEST, so when main refused the path the pane showed the
      // WHOLE repository's history under a chip naming one file. Not a missing
      // answer — a confident wrong one, which is exactly what this epic exists to
      // stop. A pin is held here and the answer says it was refused.
      setFileHistoryOpener(() => undefined);
      requestFileHistory('card-1', FOLDER, ':notes.md');
      const { readLog } = recorder([
        logOf([commit(), commit({ id: 'b2' })], { pathRefused: true }),
        logOf([commit(), commit({ id: 'b2' })]),
      ]);
      await mountPinned(readLog);
      expect(one('.history-pinned')).toBeNull();
      expect(one('.history-pin-refused')?.textContent).toContain("won't filter by that filename");
      // …and the way out is still there, because the pin itself still stands.
      await click(one('.history-unpin'));
      expect(one('.history-pin-refused')).toBeNull();
    });

    it('⚠️ AND A PIN WHOSE PAGE HAS NOT LANDED YET DRAWS NO CHIP EITHER', async () => {
      // The second way the request and the answer disagree: the moment between
      // pinning and the page that honours it. The list on screen is NOT one
      // file's history yet, so saying it is would be wrong for that frame.
      setFileHistoryOpener(() => undefined);
      requestFileHistory('card-1', FOLDER, 'src/a.ts');
      const { readLog } = recorder(logOf([commit()]));
      await mountPinned(readLog);
      expect(one('.history-pinned')).toBeNull();
    });

    it('⚠️ AN EMPTY PINNED ANSWER IS ABOUT THE FILE, NOT ABOUT THE PROJECT', async () => {
      // The most likely thing to press ⏱ on: the Changes tab lists UNTRACKED
      // files, and git has no history for a file it has never seen. "Nothing to
      // show" over a thousand-commit repository is ambiguous about whose answer
      // it is — and the toolbar said "no commits" beside it.
      setFileHistoryOpener(() => undefined);
      requestFileHistory('card-1', FOLDER, 'src/brand-new.ts');
      const { readLog } = recorder(logOf([], { filteredBy: 'src/brand-new.ts' }));
      await mountPinned(readLog);
      expect(one('.history-empty')?.textContent).toContain('src/brand-new.ts');
      expect(one('.history-empty')?.textContent).toContain('never seen');
      expect(document.body.textContent).toContain('no commits touched this file');
      expect(document.body.textContent).not.toContain('Nothing to show');
    });

    it('asks for the WHOLE history when nothing is pinned', async () => {
      const { readLog, asked } = recorder(logOf([commit()]));
      await mountPinned(readLog);
      expect(asked[0].path).toBeUndefined();
      expect(one('.history-pinned')).toBeNull();
    });

    it('⚠️ a pin for a DIFFERENT folder is ignored', async () => {
      // A resumed session can change a card's folder, and a stale pin would filter
      // the new repository by a path that means nothing in it.
      setFileHistoryOpener(() => undefined);
      requestFileHistory('card-1', '/somewhere-else', 'src/a.ts');
      const { readLog, asked } = recorder(logOf([commit()]));
      await mountPinned(readLog);
      expect(asked[0].path).toBeUndefined();
      expect(one('.history-pinned')).toBeNull();
    });
  });

  it('a commit with no message at all still draws a row', async () => {
    // `git commit --allow-empty-message` is legal. A blank row with no text is
    // indistinguishable from a rendering bug.
    const { readLog } = recorder(logOf([commit({ subject: '', message: '' })]));
    await mount(readLog);
    expect(rows()).toHaveLength(1);
    expect(one('.history-subject')?.textContent).toBe('(no message)');
  });
  describe('a branch from the graph (E24 Git v2 item 15)', () => {
    // ⚠️ **THE DESIGN RECORD ASKS FOR THIS *FROM THE GRAPH*** — *"create branch
    // from the graph"* — so the gesture is on the row that has the commit, rather
    // than a dialog somewhere else that would make the user paste a sha. What
    // only a mounted row can answer is that the ⑂ does not also toggle the row
    // open, and that the SHA it sends is the one it is beside.
    let made: Array<{ name: string; from?: string }>;
    let answer: { ok: boolean; reason?: string; applied: number };
    let asked: string[];
    let reply: string | null;

    function syncBridge(): void {
      (window as unknown as { switchboard: unknown }).switchboard = {
        git: {
          fetch: async () => answer,
          pull: async () => answer,
          push: async () => answer,
          checkout: async () => answer,
          createBranch: async (_f: string, name: string, from?: string) => {
            made.push({ name, from });
            return answer;
          },
        },
      };
    }

    async function mountGraph(readLog: ReadLog): Promise<void> {
      const host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(
          <HistoryPane
            folder={FOLDER}
            active
            readLog={readLog}
            readStatus={async () => ({ isRepo: true, files: [] })}
            now={() => NOW}
            onPrompt={(m) => {
              asked.push(m);
              return reply;
            }}
          />
        );
      });
    }

    beforeEach(() => {
      made = [];
      asked = [];
      reply = 'feature/from-the-graph';
      answer = { ok: true, applied: 1 };
      syncBridge();
    });

    afterEach(() => {
      delete (window as unknown as { switchboard?: unknown }).switchboard;
    });

    it('⑂ on a row makes a branch AT THAT COMMIT (the done-when)', async () => {
      const { readLog } = recorder(
        logOf([commit({ id: 'aaaa1111', displayId: 'aaaa1111' }), commit({ id: 'bbbb2222', displayId: 'bbbb2222' })])
      );
      await mountGraph(readLog);
      const rows = document.body.querySelectorAll('.history-row');
      await click(rows[1].querySelector('[data-testid="history-branch-here"]'));
      // ⚠️ **TWO DIFFERENT IDS, AND THAT IS THE POINT OF THE ROW HAVING BOTH.**
      // The PROMPT names the short one, because that is what the user is looking
      // at — while git is given the FULL forty-character sha, because a short one
      // is ambiguous in a big repository and git would have to guess.
      expect(asked[0]).toContain('bbbb2222');
      expect(made).toEqual([
        { name: 'feature/from-the-graph', from: 'bbbb222200000000000000000000000000000000' },
      ]);
      expect(made[0].from).toHaveLength(40);
    });

    it('⚠️ AND DOES NOT ALSO EXPAND THE ROW', async () => {
      // The row is a toggle that opens the commit's files (item 4). Branching from
      // it must not do both — a click that does two things is a click somebody
      // will regret.
      const { readLog } = recorder(logOf([commit({ id: 'aaaa1111' })]));
      await mountGraph(readLog);
      await click(one('[data-testid="history-branch-here"]'));
      expect(one('.history-files')).toBeNull();
    });

    it('⚠️ SAYING NOTHING, OR CANCELLING, MAKES NO BRANCH', async () => {
      const { readLog } = recorder(logOf([commit({ id: 'aaaa1111' })]));
      await mountGraph(readLog);
      reply = null; // cancelled
      await click(one('[data-testid="history-branch-here"]'));
      expect(made).toEqual([]);
      reply = '   '; // whitespace only
      await click(one('[data-testid="history-branch-here"]'));
      expect(made).toEqual([]);
    });

    it('trims the name, so a stray space cannot become part of it', async () => {
      const { readLog } = recorder(logOf([commit({ id: 'aaaa1111' })]));
      await mountGraph(readLog);
      reply = '  tidy-name  ';
      await click(one('[data-testid="history-branch-here"]'));
      expect(made[0].name).toBe('tidy-name');
    });

    it('⚠️ A REFUSAL IS SHOWN, in git’s own words', async () => {
      // The common ones are "a branch named 'x' already exists" and a name git
      // will not take — both things the user has to read to fix.
      answer = { ok: false, reason: "fatal: a branch named 'side' already exists", applied: 0 };
      const { readLog } = recorder(logOf([commit({ id: 'aaaa1111' })]));
      await mountGraph(readLog);
      await click(one('[data-testid="history-branch-here"]'));
      expect(one('.history-branch-error')?.textContent).toContain('already exists');
      expect(one('.history-branch-error')?.getAttribute('role')).toBe('status');
    });

    it('⚠️ WITH NO SYNC CHANNELS THERE IS NO ⑂ AT ALL', async () => {
      (window as unknown as { switchboard: unknown }).switchboard = { git: {} };
      const { readLog } = recorder(logOf([commit({ id: 'aaaa1111' })]));
      await mountGraph(readLog);
      expect(one('[data-testid="history-branch-here"]')).toBeNull();
      // …and the row is otherwise exactly as it was
      expect(one('.history-row')).not.toBeNull();
    });
  });

});
