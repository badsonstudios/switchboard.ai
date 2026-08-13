import { beforeEach, describe, expect, it } from 'vitest';
import {
  documentKey,
  documentPanelPath,
  documentPanels,
  documentPeekId,
  forgetDocumentPanel,
  isDocumentPinned,
  planDocumentOpen,
  resetDocumentPanels,
  setDocumentPinned,
} from './document-panels';

describe('document-panels — the peek slot and the pin contract (P2-E16-03)', () => {
  beforeEach(() => resetDocumentPanels());

  it('the first open creates a viewer, and that viewer is the peek slot', () => {
    const plan = planDocumentOpen('/p/a.md');
    expect(plan.action).toBe('create');
    expect(documentPeekId()).toBe(plan.id);
    expect(isDocumentPinned(plan.id)).toBe(false);
    expect(documentPanels()).toHaveLength(1);
  });

  it('a SECOND file replaces the peek slot rather than opening a panel', () => {
    const first = planDocumentOpen('/p/a.md');
    const second = planDocumentOpen('/p/b.md');
    expect(second).toMatchObject({ action: 'replace', id: first.id, path: '/p/b.md' });
    expect(documentPanels()).toHaveLength(1);
    expect(documentPanelPath(first.id)).toBe('/p/b.md');
  });

  it('PINNING makes the next open a new panel, and leaves the pinned one alone', () => {
    const kept = planDocumentOpen('/p/a.md');
    setDocumentPinned(kept.id, true);
    expect(isDocumentPinned(kept.id)).toBe(true);
    expect(documentPeekId()).toBeNull();

    const next = planDocumentOpen('/p/b.md');
    expect(next.action).toBe('create');
    expect(next.id).not.toBe(kept.id);
    expect(documentPanels()).toHaveLength(2);
    // the pinned one still shows what it was pinned on
    expect(documentPanelPath(kept.id)).toBe('/p/a.md');
    // ...and the new one is the slot the glance after this will reuse
    expect(documentPeekId()).toBe(next.id);
    const third = planDocumentOpen('/p/c.md');
    expect(third).toMatchObject({ action: 'replace', id: next.id });
    expect(documentPanels()).toHaveLength(2);
  });

  it('there is never more than one unpinned viewer', () => {
    const a = planDocumentOpen('/p/a.md');
    setDocumentPinned(a.id, true);
    const b = planDocumentOpen('/p/b.md');
    // unpinning the KEPT one hands it the slot; the other becomes pinned by
    // derivation, with nothing closed and nothing left permanently replaceable
    setDocumentPinned(a.id, false);
    expect(documentPeekId()).toBe(a.id);
    expect(isDocumentPinned(a.id)).toBe(false);
    expect(isDocumentPinned(b.id)).toBe(true);
    expect(documentPanels().filter((p) => !isDocumentPinned(p.id))).toHaveLength(1);

    // and the next glance really does land in the re-claimed slot
    expect(planDocumentOpen('/p/c.md')).toMatchObject({ action: 'replace', id: a.id });
  });

  it('opening a file that is already open focuses it and spends no peek slot', () => {
    const kept = planDocumentOpen('/p/a.md');
    setDocumentPinned(kept.id, true);
    const peek = planDocumentOpen('/p/b.md');

    expect(planDocumentOpen('/p/a.md')).toMatchObject({ action: 'focus', id: kept.id });
    // the peek slot still shows b.md — the focus did not re-point it
    expect(documentPanelPath(peek.id)).toBe('/p/b.md');
    expect(documentPanels()).toHaveLength(2);
  });

  it('two spellings of one path are one document', () => {
    expect(documentKey('C:\\p\\a.md')).toBe(documentKey('C:/p/a.md'));
    const first = planDocumentOpen('C:\\p\\a.md');
    expect(planDocumentOpen('C:/p/a.md')).toMatchObject({ action: 'focus', id: first.id });
  });

  it('attribution follows the CONTENT of the peek slot, not the panel', () => {
    const first = planDocumentOpen('/p/a.md', 'card-1');
    expect(first.sessionId).toBe('card-1');
    // re-pointed from another session's Changes tab
    expect(planDocumentOpen('/p/b.md', 'card-2')).toMatchObject({
      action: 'replace',
      sessionId: 'card-2',
    });
    // ...and from the palette, which has no session at all
    expect(planDocumentOpen('/p/c.md')).toMatchObject({
      action: 'replace',
      sessionId: undefined,
    });
    expect(documentPanels()[0]?.sessionId).toBeUndefined();
  });

  it('closing the peek frees the slot; closing a pinned viewer does not take it', () => {
    const kept = planDocumentOpen('/p/a.md');
    setDocumentPinned(kept.id, true);
    const peek = planDocumentOpen('/p/b.md');

    forgetDocumentPanel(kept.id);
    expect(documentPeekId()).toBe(peek.id);
    expect(documentPanels()).toHaveLength(1);

    forgetDocumentPanel(peek.id);
    expect(documentPeekId()).toBeNull();
    expect(documentPanels()).toHaveLength(0);
    // the next open starts the cycle over
    expect(planDocumentOpen('/p/c.md').action).toBe('create');
  });

  it('panel ids are never reused within a renderer, so dockview cannot collide', () => {
    const a = planDocumentOpen('/p/a.md');
    forgetDocumentPanel(a.id);
    const b = planDocumentOpen('/p/b.md');
    expect(b.id).not.toBe(a.id);
  });

  it('pin calls for a panel that is not open are ignored', () => {
    const a = planDocumentOpen('/p/a.md');
    setDocumentPinned('doc-999', false);
    expect(documentPeekId()).toBe(a.id);
    setDocumentPinned('doc-999', true);
    expect(documentPeekId()).toBe(a.id);
  });
});
