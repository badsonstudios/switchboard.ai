import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  REVEAL_TTL_MS,
  requestDocumentLine,
  resetDocumentLines,
  subscribeDocumentLine,
  takeDocumentLine,
} from './document-reveal';

describe('open a document at a line (#1384)', () => {
  afterEach(() => resetDocumentLines());

  it('the viewer of that path takes the line, once', () => {
    requestDocumentLine('/repo/src/a.ts', 42, 1000);
    expect(takeDocumentLine('/repo/src/a.ts', 1001)).toBe(42);
    // consumed: a later remount of the same viewer must not jump again
    expect(takeDocumentLine('/repo/src/a.ts', 1002)).toBeNull();
  });

  it('a viewer of a different file takes nothing', () => {
    requestDocumentLine('/repo/src/a.ts', 42, 1000);
    expect(takeDocumentLine('/repo/src/b.ts', 1001)).toBeNull();
    expect(takeDocumentLine('/repo/src/a.ts', 1001)).toBe(42);
  });

  it('matches across separator spellings, the way the viewer registry does', () => {
    requestDocumentLine('C:\\repo\\src\\a.ts', 7, 1000);
    expect(takeDocumentLine('C:/repo/src/a.ts', 1001)).toBe(7);
  });

  it('expires, so an untaken request cannot ambush a viewer opened much later', () => {
    requestDocumentLine('/repo/a.ts', 9, 1000);
    expect(takeDocumentLine('/repo/a.ts', 1000 + REVEAL_TTL_MS + 1)).toBeNull();
  });

  it('a newer request for the same file replaces the older', () => {
    requestDocumentLine('/repo/a.ts', 9, 1000);
    requestDocumentLine('/repo/a.ts', 30, 1001);
    expect(takeDocumentLine('/repo/a.ts', 1002)).toBe(30);
  });

  it('ignores nonsense lines', () => {
    requestDocumentLine('/repo/a.ts', 0, 1000);
    requestDocumentLine('/repo/a.ts', Number.NaN, 1000);
    requestDocumentLine('', 5, 1000);
    expect(takeDocumentLine('/repo/a.ts', 1001)).toBeNull();
  });

  it('announces each request, so an ALREADY-open viewer can take it', () => {
    const spy = vi.fn();
    const off = subscribeDocumentLine(spy);
    requestDocumentLine('/repo/a.ts', 3);
    expect(spy).toHaveBeenCalledTimes(1);
    off();
    requestDocumentLine('/repo/a.ts', 4);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
