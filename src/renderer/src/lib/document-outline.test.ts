// @vitest-environment jsdom
// The document viewer's outline preference (#1010).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_DOCUMENT_OUTLINE,
  DOCUMENT_OUTLINE_KEY,
  getDocumentOutline,
  parseDocumentOutline,
  setDocumentOutline,
  subscribeDocumentOutline,
  toggleDocumentOutline,
} from './document-outline';
import { loadUiState } from './ui-state';

// The preference lives in the workspace `ui` blob behind the preload bridge
// (P2-E15-06), never localStorage — the packaged renderer's origin changes port
// every launch. Same harness `diff-layout.test.ts` uses.
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

beforeEach(async () => {
  stubBridge();
  await loadUiState();
});

describe('parseDocumentOutline — a blob outlives the code that wrote it', () => {
  it('shows the outline when nothing has ever been stored', () => {
    expect(DEFAULT_DOCUMENT_OUTLINE).toBe(true);
    expect(parseDocumentOutline(undefined)).toBe(true);
    expect(parseDocumentOutline(null)).toBe(true);
  });

  it('reads back the two values it writes', () => {
    expect(parseDocumentOutline(false)).toBe(false);
    expect(parseDocumentOutline(true)).toBe(true);
  });

  it('only a literal false hides it — nothing is coerced', () => {
    // `Boolean('hidden')` is `true`, and a cast would make a future rename to
    // strings silently mean the opposite of itself. Junk is the DEFAULT.
    for (const junk of [0, '', 'false', 'hidden', {}, [], 42, 'off']) {
      expect(parseDocumentOutline(junk)).toBe(true);
    }
  });
});

describe('the preference itself', () => {
  it('defaults to shown, which is what the viewer has always done', () => {
    expect(getDocumentOutline()).toBe(true);
  });

  it('remembers a workspace that was told to hide it', async () => {
    stubBridge({ [DOCUMENT_OUTLINE_KEY]: false });
    await loadUiState();
    expect(getDocumentOutline()).toBe(false);
  });

  it('persists through the workspace blob, not through memory', async () => {
    const state = stubBridge();
    await loadUiState();
    setDocumentOutline(false);
    expect(state.store[DOCUMENT_OUTLINE_KEY]).toBe(false);
    // ...and a relaunch reads it back — which is the acceptance criterion this
    // module exists to satisfy, and the one a per-panel key could not.
    await loadUiState();
    expect(getDocumentOutline()).toBe(false);
  });

  it('toggles both ways', () => {
    expect(toggleDocumentOutline()).toBe(false);
    expect(getDocumentOutline()).toBe(false);
    expect(toggleDocumentOutline()).toBe(true);
    expect(getDocumentOutline()).toBe(true);
  });
});

describe('subscribers — every open viewer follows the same value', () => {
  it('announces a change to everyone listening', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeDocumentOutline(a);
    subscribeDocumentOutline(b);
    setDocumentOutline(false);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    setDocumentOutline(true);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('says nothing for a write that changed nothing', () => {
    const fn = vi.fn();
    subscribeDocumentOutline(fn);
    setDocumentOutline(true); // already true
    expect(fn).not.toHaveBeenCalled();
  });

  it('a throwing subscriber costs its own update, not everyone else’s', () => {
    const boom = vi.fn(() => {
      throw new Error('no');
    });
    const fine = vi.fn();
    subscribeDocumentOutline(boom);
    subscribeDocumentOutline(fine);
    expect(() => setDocumentOutline(false)).not.toThrow();
    expect(fine).toHaveBeenCalledTimes(1);
  });

  it('a subscriber that unsubscribes itself mid-walk does not break the walk', () => {
    const later = vi.fn();
    const off = subscribeDocumentOutline(() => off());
    subscribeDocumentOutline(later);
    expect(() => setDocumentOutline(false)).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe('fail-open: a refusing workspace costs the memory, never the gesture', () => {
  it('still flips in this session when the bridge throws', async () => {
    (window as unknown as { switchboard: unknown }).switchboard = {
      workspace: {
        getUi: async () => ({}),
        setUi: () => {
          throw new Error('refused');
        },
      },
    };
    await loadUiState();
    expect(() => setDocumentOutline(false)).not.toThrow();
    expect(getDocumentOutline()).toBe(false);
  });
});
