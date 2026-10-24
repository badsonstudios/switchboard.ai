// @vitest-environment jsdom
// The document viewer's reading-width preference (#1404).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_DOCUMENT_MEASURE,
  DOCUMENT_MEASURE_KEY,
  getDocumentMeasure,
  isMeasureOffered,
  parseDocumentMeasure,
  resetMeasureOfferedForTest,
  setMeasureOffered,
  setDocumentMeasure,
  subscribeDocumentMeasure,
  toggleDocumentMeasure,
} from './document-measure';
import { loadUiState } from './ui-state';

// Same harness as `document-outline.test.ts`: the workspace `ui` blob behind
// the preload bridge, never localStorage.
function stubBridge(initial: Record<string, unknown> = {}): {
  store: Record<string, unknown>;
} {
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

beforeEach(async () => {
  stubBridge();
  await loadUiState();
});

describe('parseDocumentMeasure', () => {
  it('fills the pane when nothing has ever been stored (the #1404 default)', () => {
    expect(DEFAULT_DOCUMENT_MEASURE).toBe('full');
    expect(parseDocumentMeasure(undefined)).toBe('full');
    expect(parseDocumentMeasure(null)).toBe('full');
  });

  it('reads back the two values it writes', () => {
    expect(parseDocumentMeasure('readable')).toBe('readable');
    expect(parseDocumentMeasure('full')).toBe('full');
  });

  it('only the literal "readable" caps — junk is the default', () => {
    for (const junk of [true, false, 0, 1, '', 'Readable', '78ch', {}, []]) {
      expect(parseDocumentMeasure(junk)).toBe('full');
    }
  });
});

describe('the preference itself', () => {
  it('defaults to full width', () => {
    expect(getDocumentMeasure()).toBe('full');
  });

  it('persists through the workspace blob and reads back after a reload', async () => {
    const state = stubBridge();
    await loadUiState();
    setDocumentMeasure('readable');
    expect(state.store[DOCUMENT_MEASURE_KEY]).toBe('readable');
    await loadUiState();
    expect(getDocumentMeasure()).toBe('readable');
  });

  it('toggles both ways', () => {
    expect(toggleDocumentMeasure()).toBe('readable');
    expect(getDocumentMeasure()).toBe('readable');
    expect(toggleDocumentMeasure()).toBe('full');
    expect(getDocumentMeasure()).toBe('full');
  });

  it('announces a change, and stays quiet for a no-op write', () => {
    const fn = vi.fn();
    const off = subscribeDocumentMeasure(fn);
    setDocumentMeasure('full');
    expect(fn).not.toHaveBeenCalled();
    setDocumentMeasure('readable');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    setDocumentMeasure('full');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not stop the others', () => {
    const good = vi.fn();
    const offBad = subscribeDocumentMeasure(() => {
      throw new Error('boom');
    });
    const offGood = subscribeDocumentMeasure(good);
    setDocumentMeasure('readable');
    expect(good).toHaveBeenCalledTimes(1);
    offBad();
    offGood();
  });
});

describe('who has prose to measure (#1408)', () => {
  beforeEach(() => resetMeasureOfferedForTest());

  it('is offered while any viewer says so, and not once the last one stops', () => {
    expect(isMeasureOffered()).toBe(false);
    setMeasureOffered('a', true);
    setMeasureOffered('b', true);
    expect(isMeasureOffered()).toBe(true);
    setMeasureOffered('a', false);
    expect(isMeasureOffered()).toBe(true);
    setMeasureOffered('b', false);
    expect(isMeasureOffered()).toBe(false);
  });
});
