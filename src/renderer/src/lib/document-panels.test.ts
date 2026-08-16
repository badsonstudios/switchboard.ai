import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  documentKey,
  documentPanelPath,
  documentPanels,
  forgetDocumentPanel,
  planDocumentOpen,
  resetDocumentPanels,
} from './document-panels';

describe('document-panels — every file opens its own tab (#530)', () => {
  beforeEach(() => resetDocumentPanels());

  it('the first open creates a viewer', () => {
    const plan = planDocumentOpen('/p/a.md');
    expect(plan.action).toBe('create');
    expect(documentPanels()).toHaveLength(1);
    expect(documentPanelPath(plan.id)).toBe('/p/a.md');
  });

  it('a SECOND file gets its own panel — nothing is replaced', () => {
    const first = planDocumentOpen('/p/a.md');
    const second = planDocumentOpen('/p/b.md');
    expect(second.action).toBe('create');
    expect(second.id).not.toBe(first.id);
    expect(documentPanels()).toHaveLength(2);
    // the first is untouched: it still shows what it was opened on
    expect(documentPanelPath(first.id)).toBe('/p/a.md');
  });

  it('THREE files, THREE tabs — the done-when, stated as state', () => {
    // The whole owner decision in one assertion: no gesture, no pin, no
    // exception. Glancing is not a special case any more.
    const ids = ['/p/a.md', '/p/b.md', '/p/c.md'].map((p) => planDocumentOpen(p));
    expect(ids.map((p) => p.action)).toEqual(['create', 'create', 'create']);
    expect(new Set(ids.map((p) => p.id)).size).toBe(3);
    expect(documentPanels().map((e) => e.path)).toEqual(['/p/a.md', '/p/b.md', '/p/c.md']);
  });

  it('opening a file that is already open FOCUSES it rather than opening it twice', () => {
    const first = planDocumentOpen('/p/a.md');
    planDocumentOpen('/p/b.md');

    expect(planDocumentOpen('/p/a.md')).toMatchObject({ action: 'focus', id: first.id });
    expect(documentPanels()).toHaveLength(2);
  });

  it('two spellings of one path are one document', () => {
    expect(documentKey('C:\\p\\a.md')).toBe(documentKey('C:/p/a.md'));
    const first = planDocumentOpen('C:\\p\\a.md');
    expect(planDocumentOpen('C:/p/a.md')).toMatchObject({ action: 'focus', id: first.id });
  });

  describe('case, on a file system that folds it (#530)', () => {
    // Only reachable through the bridge, because only main knows the platform.
    // Stubbed rather than mocked so the DEFAULT case — no bridge at all — is
    // the one every other test in this file runs under, and is asserted below.
    const setPlatform = (platform: string | undefined): void => {
      const g = globalThis as { switchboard?: { platform?: string } };
      if (platform === undefined) delete g.switchboard;
      else g.switchboard = { ...g.switchboard, platform };
    };
    afterEach(() => setPlatform(undefined));

    it('on Windows, two casings of one path are one document — not two tabs', () => {
      // Under the peek slot this gap was invisible: the second spelling merely
      // re-pointed the slot at what was already there. With a tab per file it
      // is a duplicate tab on one document, which is the one thing the focus
      // rule promises cannot happen.
      setPlatform('win32');
      const first = planDocumentOpen('C:\\Projects\\App\\README.md');
      expect(planDocumentOpen('c:/projects/app/readme.md')).toMatchObject({
        action: 'focus',
        id: first.id,
      });
      expect(documentPanels()).toHaveLength(1);
    });

    it('on macOS too — the same volume default', () => {
      setPlatform('darwin');
      const first = planDocumentOpen('/Users/dan/Notes.md');
      expect(planDocumentOpen('/users/dan/notes.md')).toMatchObject({ action: 'focus', id: first.id });
    });

    it('on Linux they are TWO documents, because there they are two files', () => {
      setPlatform('linux');
      planDocumentOpen('/home/dan/Notes.md');
      expect(planDocumentOpen('/home/dan/notes.md').action).toBe('create');
      expect(documentPanels()).toHaveLength(2);
    });

    it('with no bridge, nothing is folded — the conservative answer', () => {
      // Splitting one document into two tabs is recoverable (close one);
      // merging two files into one tab shows the wrong file. So an unknown
      // platform takes the answer that can only ever be too cautious.
      planDocumentOpen('/p/Notes.md');
      expect(planDocumentOpen('/p/notes.md').action).toBe('create');
    });
  });

  it('attribution is recorded per panel, and a re-open does not rewrite it', () => {
    const first = planDocumentOpen('/p/a.md', 'card-1');
    expect(first.sessionId).toBe('card-1');
    // a second file from a second card is its OWN viewer, with its own lineage
    expect(planDocumentOpen('/p/b.md', 'card-2')).toMatchObject({
      action: 'create',
      sessionId: 'card-2',
    });
    // ...and asking for the first again from the palette (no session) focuses
    // it WITHOUT stripping the chip: where a document came from is a fact about
    // the document, not about the last person to ask for it.
    expect(planDocumentOpen('/p/a.md')).toMatchObject({
      action: 'focus',
      id: first.id,
      sessionId: 'card-1',
    });
    expect(documentPanels()[0]?.sessionId).toBe('card-1');
  });

  it('closing a viewer forgets it, and the file can then be opened afresh', () => {
    const a = planDocumentOpen('/p/a.md');
    const b = planDocumentOpen('/p/b.md');

    forgetDocumentPanel(a.id);
    expect(documentPanels()).toHaveLength(1);
    // the one still open is untouched by its neighbour going
    expect(documentPanelPath(b.id)).toBe('/p/b.md');
    // and the closed file is a fresh open, not a focus on a panel that is gone
    expect(planDocumentOpen('/p/a.md').action).toBe('create');
  });

  it('forgetting a panel that was never registered is a no-op', () => {
    const a = planDocumentOpen('/p/a.md');
    forgetDocumentPanel('doc-999');
    expect(documentPanels()).toHaveLength(1);
    expect(documentPanelPath(a.id)).toBe('/p/a.md');
  });

  it('panel ids are never reused within a renderer, so dockview cannot collide', () => {
    const a = planDocumentOpen('/p/a.md');
    forgetDocumentPanel(a.id);
    const b = planDocumentOpen('/p/b.md');
    expect(b.id).not.toBe(a.id);
  });
});
