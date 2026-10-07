// The open-diff registry (E24 Git v2 item 5).
//
// Pure, so it runs in vitest's NODE environment with no DOM and no dockview —
// which is the point of splitting the DECISION (focus / create) from the dockview
// half that acts on it. `document-panels.test.ts` is the sibling this mirrors.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DIFF_PANEL_PREFIX,
  WORKING_TREE_LEFT,
  WORKING_TREE_RIGHT,
  closableDiffs,
  diffKey,
  diffPanelTarget,
  diffPanels,
  forgetDiffPanel,
  isDiffPanelId,
  planDiffOpen,
  resetDiffPanels,
  type DiffTarget,
} from './diff-panels';
import { canOpenDiffs, openDiff, setDiffOpener } from './diff-open';

const working = (folder: string, path?: string): DiffTarget => ({
  folder,
  path,
  left: WORKING_TREE_LEFT,
  right: WORKING_TREE_RIGHT,
});

describe('the diff panel prefix', () => {
  it('⚠️ is NOT `diff-`, because `diff-` is already taken', () => {
    // `SessionGrid`'s existing `openDiff` verb relocates a session's whole
    // Changes tab into the document area as `diff-<cardId>` (#504), and it
    // predates this item. Three things read that prefix and all three would have
    // been confused — see `DIFF_PANEL_PREFIX` for the list. The design record
    // says `diff-<n>`; the design was written without knowing.
    expect(DIFF_PANEL_PREFIX).toBe('gitdiff-');
    // The specific consequence worth pinning: an open Changes tab must not read
    // as one of ours, or a bulk close takes the wrong surface.
    expect(isDiffPanelId('diff-card-7')).toBe(false);
    expect(isDiffPanelId('doc-3')).toBe(false);
    expect(isDiffPanelId('session-abc')).toBe(false);
    expect(isDiffPanelId('gitdiff-1')).toBe(true);
  });

  it('⚠️ does not match `/^(session|diff)-/`, which is what lets it share the document area', () => {
    // `documentHomeGroup` excludes any group holding a panel that matches that
    // pattern, because such a group is a session's own. A prefix that matched
    // would have barred these panels from the very area they open into.
    expect(/^(session|diff)-/.test(`${DIFF_PANEL_PREFIX}1`)).toBe(false);
  });
});

describe('diffKey', () => {
  it('⚠️ the SAME FILE at two comparisons is TWO keys', () => {
    // The whole reason this is not `documentKey`. Drop `left..right` and asking
    // for a file at a commit focuses the working-tree diff of the same file,
    // showing the reader something they did not ask for.
    const a = diffKey(working('/p', 'src/a.ts'));
    const b = diffKey({ folder: '/p', path: 'src/a.ts', left: 'abc^', right: 'abc' });
    expect(a).not.toBe(b);
  });

  it('⚠️ an ABSENT path and an EMPTY one are different keys', () => {
    // Absent is the all-changes panel (shape 2); empty is a caller bug. Folding
    // them together would make a mistake quietly collide with a real panel.
    expect(diffKey(working('/p'))).not.toBe(diffKey(working('/p', '')));
  });

  it('two folders are two keys, so two checkouts of one repo do not share a panel', () => {
    expect(diffKey(working('/a', 'x.ts'))).not.toBe(diffKey(working('/b', 'x.ts')));
  });

  it('⚠️ `attributionCardId` is NOT in the key', () => {
    // Attribution says where a diff was opened FROM. Two cards asking about the
    // same comparison are asking one question.
    const a = diffKey({ ...working('/p', 'x.ts'), attributionCardId: 'card-1' });
    const b = diffKey({ ...working('/p', 'x.ts'), attributionCardId: 'card-2' });
    expect(a).toBe(b);
  });

  it('folds path separators, so `/` and `\\` are one comparison', () => {
    expect(diffKey(working('/p', 'src/a.ts'))).toBe(diffKey(working('/p', 'src\\a.ts')));
  });

  it('⚠️ a folder whose NAME contains the separator cannot collide with a path', () => {
    // The field separator is NUL — the one byte a path cannot contain. Without
    // it, `{folder: '/p/src', path: 'a.ts'}` and `{folder: '/p', path:
    // 'src/a.ts'}` would be the same string and therefore one panel, which is
    // two different comparisons sharing a tab.
    expect(diffKey(working('/p/src', 'a.ts'))).not.toBe(diffKey(working('/p', 'src/a.ts')));
  });
});

describe('planDiffOpen', () => {
  beforeEach(() => resetDiffPanels());

  it('mints a panel for a comparison nothing is showing (the done-when)', () => {
    const plan = planDiffOpen(working('/p', 'a.ts'));
    expect(plan.action).toBe('create');
    expect(plan.id).toBe(`${DIFF_PANEL_PREFIX}1`);
    expect(diffPanels()).toHaveLength(1);
  });

  it('⚠️ FOCUSES rather than opening a second copy of one comparison', () => {
    const first = planDiffOpen(working('/p', 'a.ts'));
    const again = planDiffOpen(working('/p', 'a.ts'));
    expect(again).toMatchObject({ action: 'focus', id: first.id, target: { path: 'a.ts' } });
    expect(diffPanels()).toHaveLength(1);
  });

  it('focuses across a separator spelling, because that is one comparison', () => {
    const first = planDiffOpen(working('/p', 'src/a.ts'));
    expect(planDiffOpen(working('/p', 'src\\a.ts'))).toMatchObject({ action: 'focus', id: first.id });
  });

  it('⚠️ does NOT overwrite the recorded `attributionCardId` on a focus', () => {
    // Attribution is where it came from, and that does not change because
    // somebody asked again from somewhere else — `planDocumentOpen`'s rule.
    planDiffOpen({ ...working('/p', 'a.ts'), attributionCardId: 'card-1' });
    const again = planDiffOpen({ ...working('/p', 'a.ts'), attributionCardId: 'card-2' });
    expect(again.target.attributionCardId).toBe('card-1');
  });

  it('opens a second panel for the same file at a different comparison', () => {
    const live = planDiffOpen(working('/p', 'a.ts'));
    const atCommit = planDiffOpen({ folder: '/p', path: 'a.ts', left: 'abc^', right: 'abc' });
    expect(atCommit.action).toBe('create');
    expect(atCommit.id).not.toBe(live.id);
    expect(diffPanels()).toHaveLength(2);
  });

  it('a forgotten panel can be opened again, and gets a FRESH id', () => {
    // Ids are never reused: dockview keys its own state on them, and a recycled
    // id is how a new panel inherits a dead one's group and size.
    const first = planDiffOpen(working('/p', 'a.ts'));
    forgetDiffPanel(first.id);
    expect(diffPanels()).toHaveLength(0);
    const second = planDiffOpen(working('/p', 'a.ts'));
    expect(second.action).toBe('create');
    expect(second.id).not.toBe(first.id);
  });

  it('remembers what each panel is a diff OF', () => {
    const plan = planDiffOpen(working('/p', 'a.ts'));
    expect(diffPanelTarget(plan.id)).toMatchObject({ folder: '/p', path: 'a.ts' });
    expect(diffPanelTarget('gitdiff-nope')).toBeUndefined();
  });
});

describe('closableDiffs', () => {
  it('⚠️ SPARES a popped-out diff, and that matters more here than for a document', () => {
    // A popped-out diff is the thing this whole item exists to make possible —
    // reading a diff while watching the conversation that produced it. A bulk
    // close that took it would undo the feature from inside.
    expect(
      closableDiffs([
        { id: 'gitdiff-1', poppedOut: false },
        { id: 'gitdiff-2', poppedOut: true },
      ])
    ).toEqual(['gitdiff-1']);
  });

  it('takes nothing that is not one of ours — including an open Changes tab', () => {
    expect(
      closableDiffs([
        { id: 'session-a', poppedOut: false },
        { id: 'doc-1', poppedOut: false },
        { id: 'diff-card-7', poppedOut: false },
      ])
    ).toEqual([]);
  });
});

describe('openDiff — the module seam', () => {
  afterEach(() => setDiffOpener(null));

  it('reports false with nothing listening, rather than throwing', () => {
    // A click before the grid is ready must not throw, and the Changes tab reads
    // the `false` to draw no ⧉ at all — the owner's rule about a control that
    // does nothing.
    setDiffOpener(null);
    expect(canOpenDiffs()).toBe(false);
    expect(openDiff(working('/p', 'a.ts'))).toBe(false);
  });

  it('hands the whole target through, because the COMPARISON is the identity', () => {
    const seen: DiffTarget[] = [];
    setDiffOpener((t) => seen.push(t));
    expect(canOpenDiffs()).toBe(true);
    expect(openDiff(working('/p', 'a.ts'))).toBe(true);
    expect(seen).toEqual([working('/p', 'a.ts')]);
  });

  it('⚠️ refuses a target with no FOLDER', () => {
    // There is nothing to read either side from, and `diffKey` would fold an
    // empty folder into a key that collides with every other empty-folder
    // request — so one bad call would make every later one focus the wrong panel.
    let called = 0;
    setDiffOpener(() => void called++);
    expect(openDiff(working('', 'a.ts'))).toBe(false);
    expect(openDiff({ ...working('/p', 'a.ts'), folder: undefined as unknown as string })).toBe(false);
    expect(called).toBe(0);
  });

  it('⚠️ an opener that THROWS does not take the surface that asked with it', () => {
    setDiffOpener(() => {
      throw new Error('the grid exploded');
    });
    expect(openDiff(working('/p', 'a.ts'))).toBe(false);
  });
});
