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
import { HistoryPane, HISTORY_PAGE, MAX_HISTORY, type ReadLog, type ReadStatus } from './HistoryPane';
import type { GitCommitDto, GitLogDto } from '../lib/git-log-dto';
import { ipcRefusal } from '../../../shared/ipc/refusal';

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

const logOf = (commits: GitCommitDto[]): GitLogDto => ({ isRepo: true, commits });

/** A reader that records every ask, so "it pages" is assertable. */
function recorder(answers: GitLogDto[] | GitLogDto) {
  const asked: Array<{ folder: string; limit: number; skip: number }> = [];
  let call = 0;
  const readLog: ReadLog = async (folder, q) => {
    asked.push({ folder, ...q });
    return Array.isArray(answers) ? (answers[Math.min(call++, answers.length - 1)] ?? logOf([])) : answers;
  };
  return { readLog, asked };
}

const noStatus: ReadStatus = async () => ({ isRepo: true, files: [] });

/** Fixed clock, so "14m" is a fact about the component and not about today. */
const NOW = (1_790_000_000 + 840) * 1000;

async function mount(
  readLog: ReadLog,
  opts: { readStatus?: ReadStatus; active?: boolean } = {}
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
          now={() => NOW}
        />
      );
    });
  };
  await render(opts.active ?? true);
  return { setActive: render };
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
      const page = Array.from({ length: MAX_HISTORY }, (_, i) =>
        commit({ id: `${i}`.padStart(40, 'a'), subject: `commit ${i}` })
      );
      const { readLog } = recorder(logOf(page));
      await mount(readLog);
      await type(one('.history-search') as HTMLInputElement, 'commit 1777');
      expect(rows()).toHaveLength(1);
      expect(one('.history-more')).toBeNull();
      expect(one('.history-ceiling')).not.toBeNull();
    });

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

  it('a commit with no message at all still draws a row', async () => {
    // `git commit --allow-empty-message` is legal. A blank row with no text is
    // indistinguishable from a rendering bug.
    const { readLog } = recorder(logOf([commit({ subject: '', message: '' })]));
    await mount(readLog);
    expect(rows()).toHaveLength(1);
    expect(one('.history-subject')?.textContent).toBe('(no message)');
  });
});
