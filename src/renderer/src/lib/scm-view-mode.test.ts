// @vitest-environment jsdom
// Flat list or folder tree (E24 Git v2 item 8) — the PREFERENCE.
//
// The tree's own rules are in `scm-tree.test.ts`; this is only about where the
// choice lives, and it exists for one reason: there are N mounted sidebars at
// once, so a preference in React state would be N preferences that disagree.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  DEFAULT_SCM_VIEW_MODE,
  SCM_VIEW_MODE_KEY,
  getScmViewMode,
  parseScmViewMode,
  setScmViewMode,
  subscribeScmViewMode,
} from './scm-view-mode';
import { loadUiState } from './ui-state';

/** The workspace `ui` blob behind the preload bridge — the same harness
 *  `diff-layout.test.ts` uses, never localStorage (P2-E15-06). */
function stubBridge(initial: Record<string, unknown> = {}): { store: Record<string, unknown> } {
  const state = { store: { ...initial } };
  (window as unknown as { switchboard: unknown }).switchboard = {
    workspace: {
      getUi: async () => state.store,
      setUi: (v: Record<string, unknown>) => {
        state.store = { ...v };
      },
    },
  };
  return state;
}

describe('the source-control view mode (E24 Git v2 item 8)', () => {
  beforeEach(async () => {
    stubBridge();
    await loadUiState();
  });

  afterEach(() => {
    delete (window as unknown as { switchboard?: unknown }).switchboard;
  });

  describe('parseScmViewMode — a blob outlives the code that wrote it', () => {
    it('reads the two real values', () => {
      expect(parseScmViewMode('tree')).toBe('tree');
      expect(parseScmViewMode('flat')).toBe('flat');
    });

    it('⚠️ ANYTHING ELSE IS THE DEFAULT, not a throw', () => {
      // A stale or hand-edited value must never cost the user their Changes tab.
      for (const junk of [undefined, null, '', 'TREE', 0, 1, {}, [], true, 'outline']) {
        expect(parseScmViewMode(junk)).toBe(DEFAULT_SCM_VIEW_MODE);
      }
    });
  });

  it('defaults to the FLAT list, which is a deliberate disagreement with the mockup', () => {
    // Screen 2 draws the tree button lit. The tab's job is answering "what did
    // the agent just change?", and a flat list answers it in one glance where a
    // tree makes you expand to find out. The tree is there for the big change
    // set, and the ask is remembered.
    expect(getScmViewMode()).toBe('flat');
  });

  it('persists into the ui blob, under its own key', async () => {
    const state = stubBridge();
    await loadUiState();
    setScmViewMode('tree');
    expect(state.store[SCM_VIEW_MODE_KEY]).toBe('tree');
    expect(getScmViewMode()).toBe('tree');
  });

  it('⚠️ A WORKSPACE THAT WAS TOLD ONCE STAYS TOLD', async () => {
    stubBridge({ [SCM_VIEW_MODE_KEY]: 'tree' });
    await loadUiState();
    expect(getScmViewMode()).toBe('tree');
  });

  it('notifies every mounted sidebar, and stops when one unsubscribes', () => {
    let seen = 0;
    const off = subscribeScmViewMode(() => void seen++);
    setScmViewMode('tree');
    expect(seen).toBe(1);
    off();
    setScmViewMode('flat');
    expect(seen).toBe(1);
  });

  it('⚠️ A NO-OP WRITE ANNOUNCES NOTHING — N sidebars must not re-render for nothing', () => {
    let seen = 0;
    subscribeScmViewMode(() => void seen++);
    setScmViewMode('tree');
    setScmViewMode('tree');
    expect(seen).toBe(1);
  });

  it('a subscriber that THROWS costs its own update, not everyone’s', () => {
    let reached = 0;
    subscribeScmViewMode(() => {
      throw new Error('a bad subscriber');
    });
    subscribeScmViewMode(() => void reached++);
    expect(() => setScmViewMode('tree')).not.toThrow();
    expect(reached).toBe(1);
  });
});
