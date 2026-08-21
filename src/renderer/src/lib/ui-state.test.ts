// @vitest-environment jsdom
//
// #440 — what `loadUiState()` does with an answer that is not an answer.
//
// This module had no test at all, and it is the one call site in the #440 sweep
// where a refusal did more than take a wrong branch: `workspace:getUi` answers
// `Promise<unknown>`, the guard was `raw && typeof raw === 'object'`, and a
// refusal is an object — so the brand became the entire prefs cache, and the
// next `uiSet` pushed it BACK to main, which writes it to `workspace.json`.
// `shared/ipc/refusal.ts` names a hand-edited workspace file as the one place
// the brand could plausibly appear in real data; this was the path that would
// have put it there without anyone editing anything.
//
// Unreachable today (the first-party renderer holds every capability), so these
// are the deliverable rather than a regression net — built on the real
// `ipcRefusal()` factory, per #439.
import { describe, it, expect, beforeEach } from 'vitest';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import { loadUiState, uiAll, uiGet, uiSet } from './ui-state';

/** Install a bridge whose `workspace:getUi` answers `answer`. */
function bridgeAnswering(answer: unknown): { pushed: unknown[] } {
  const pushed: unknown[] = [];
  (window as unknown as { switchboard: unknown }).switchboard = {
    workspace: {
      getUi: () => Promise.resolve(answer),
      setUi: (blob: unknown) => pushed.push(blob),
    },
  };
  return { pushed };
}

describe('loadUiState reads the prefs blob', () => {
  beforeEach(async () => {
    // the module cache is module-level state; reset it through the front door
    bridgeAnswering({});
    await loadUiState();
    localStorage.clear();
  });

  it('loads a real blob', async () => {
    bridgeAnswering({ theme: 'midnight', language: 'en' });
    await loadUiState();
    expect(uiGet('theme', 'fallback')).toBe('midnight');
  });

  it('a REFUSAL does not become the prefs cache', async () => {
    // `?? {}` would not have caught this and neither did `typeof === 'object'`:
    // the brand is a non-null object, so both waved it through.
    bridgeAnswering(ipcRefusal('workspace:getUi', 'capability-not-held'));
    await loadUiState();
    expect(uiAll()).toEqual({});
    expect(uiGet('theme', 'fallback')).toBe('fallback');
  });

  it('...and is therefore never pushed back to main, or to workspace.json', () => {
    // The consequence that outlives the session: `push()` sends the WHOLE
    // cache, so a brand that got in on load is written to disk on the next
    // focus change, and every launch after that reads it back.
    const { pushed } = bridgeAnswering(null);
    uiSet('theme', 'midnight');
    expect(pushed).toHaveLength(1);
    expect(JSON.stringify(pushed[0])).not.toContain('ipcRefused');
  });

  it('still falls back to {} for the ordinary non-answers', async () => {
    for (const answer of [null, undefined, 'not an object', 42]) {
      bridgeAnswering(answer);
      await loadUiState();
      expect(uiAll()).toEqual({});
    }
  });
});
