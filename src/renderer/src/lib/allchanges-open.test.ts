// The all-changes seam (E24 Git v2 item 9).
//
// The fourth member of a family with one shape, so this file is short on purpose:
// what is worth testing is the two things that differ from its siblings — that it
// is keyed by CARD rather than by a comparison, and that with nothing listening it
// reports false so the toolbar draws no ⧉ at all.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  canOpenAllChanges,
  openAllChanges,
  resetAllChangesOpener,
  setAllChangesOpener,
} from './allchanges-open';
import { ALL_CHANGES_PREFIX, allChangesPanelId, isAllChangesPanelId, isDiffPanelId, isGitPanelId } from './diff-panels';

describe('the all-changes seam', () => {
  beforeEach(() => resetAllChangesOpener());

  it('opens the panel for a card (the done-when)', () => {
    const asked: Array<[string, string, string]> = [];
    setAllChangesOpener((cardId, folder, title) => asked.push([cardId, folder, title]));
    expect(openAllChanges('card-1', '/proj', 'All changes')).toBe(true);
    expect(asked).toEqual([['card-1', '/proj', 'All changes']]);
  });

  it('⚠️ REPORTS FALSE WITH NO OPENER, so the toolbar draws no ⧉ at all', () => {
    // The owner's rule about a control that does nothing, applied to a toolbar
    // button instead of a row.
    expect(canOpenAllChanges()).toBe(false);
    expect(openAllChanges('card-1', '/proj', 'All changes')).toBe(false);
  });

  it('⚠️ AN OPENER THAT THROWS DOES NOT TAKE THE SURFACE THAT ASKED WITH IT', () => {
    setAllChangesOpener(() => {
      throw new Error('the grid exploded');
    });
    expect(openAllChanges('card-1', '/proj', 'All changes')).toBe(false);
  });

  it('refuses the shapes that cannot mean anything', () => {
    setAllChangesOpener(() => undefined);
    expect(openAllChanges(undefined, '/proj', 'x')).toBe(false);
    expect(openAllChanges('card-1', '', 'x')).toBe(false);
  });
});

describe('the all-changes panel id', () => {
  it('⚠️ IS DERIVED FROM THE CARD, which is why this family needs no registry', () => {
    // One "everything that changed" per card, so `getPanel` is the whole lookup
    // and there is no second copy of the truth to go stale. A `gitdiff-` panel is
    // per COMPARISON and a card can want several, which is why THAT family has a
    // map.
    expect(allChangesPanelId('card-1')).toBe(`${ALL_CHANGES_PREFIX}card-1`);
    expect(allChangesPanelId('card-1')).toBe(allChangesPanelId('card-1'));
    expect(allChangesPanelId('card-2')).not.toBe(allChangesPanelId('card-1'));
  });

  it('⚠️ IS NEVER MISTAKEN FOR ONE OF THE OTHER THREE FAMILIES', () => {
    // The collision item 5 paid for: `diff-` was already taken by #504's
    // relocated Changes tab, and the design record had to be amended. Four
    // prefixes share this id space now — `diff-`, `doc-`, `gitdiff-`,
    // `allchanges-` — so each one is asserted against the others.
    const mine = allChangesPanelId('card-1');
    expect(isAllChangesPanelId(mine)).toBe(true);
    expect(isDiffPanelId(mine)).toBe(false);
    for (const other of ['diff-card-1', 'doc-1', 'gitdiff-1', 'session-card-1']) {
      expect(isAllChangesPanelId(other)).toBe(false);
    }
  });

  it('`isGitPanelId` claims BOTH git families and nothing else', () => {
    // What the dock-area rules ask: "may a session card land as a tab on top of
    // this?" — and the answer is no for either kind of git panel.
    expect(isGitPanelId('gitdiff-1')).toBe(true);
    expect(isGitPanelId(allChangesPanelId('card-1'))).toBe(true);
    expect(isGitPanelId('doc-1')).toBe(false);
    expect(isGitPanelId('session-card-1')).toBe(false);
    // ⚠️ AND NOT #504's relocated Changes tab, which is a session's own tab moved
    // rather than a derived git panel — the distinction that cost item 5 a prefix.
    expect(isGitPanelId('diff-card-1')).toBe(false);
  });
});
