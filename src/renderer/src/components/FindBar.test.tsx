// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../i18n/locales/en.json';
import { FindBar } from './FindBar';
import { rendererRegistry } from '../extensibility/registry-instance';
import { registerBuiltinContributions } from '../bootstrap';
import { resetFindBarState, openFindBar, findBarState, setFindTerm } from '../lib/find-bar-state';
import { publishFindSurface, findSurfaceKey, resetFindSurfaces } from '../lib/find-surfaces';
import type { FindSurface } from '../extensibility/contributions';
import type { TranscriptSearchResult } from '../../../shared/transcripts';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

async function mount(tree: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(tree);
  });
  return host;
}

function q<T extends HTMLElement>(host: HTMLElement, testid: string): T | null {
  return host.querySelector<T>(`[data-testid="${testid}"]`);
}

function searchResult(hits: TranscriptSearchResult['hits'], over: Partial<TranscriptSearchResult> = {}): TranscriptSearchResult {
  return {
    hits,
    total: hits.length,
    truncated: false,
    groups: [{ sessionId: 's1', hits: hits.length, blocks: 50, searched: true, aligned: true }],
    elapsedMs: 2,
    longestBlockMs: 1,
    ...over,
  };
}

function hit(seq: number | undefined, snippet: string, earlier = false): TranscriptSearchResult['hits'][number] {
  return {
    sessionId: 's1',
    blockIndex: seq ?? 999,
    seq,
    earlierThanLoaded: earlier,
    kind: 'tool',
    field: 'tool.out',
    snippet,
    matchStart: 0,
    matchLength: 6,
    ts: '2026-08-13T09:41:07.113Z',
  };
}

/** Let the 200ms debounce fire and the search promise settle. */
async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

let jumpTo: ReturnType<typeof vi.fn>;
let clearFeed: ReturnType<typeof vi.fn>;
let search: ReturnType<typeof vi.fn>;

const bar = (panelId = 'feed', panelTitleKey = 'grid.viewSession'): React.JSX.Element => (
  <FindBar sessionId="s1" cardId="card-1" panelId={panelId} panelTitleKey={panelTitleKey} />
);

beforeAll(async () => {
  await initI18nForTests();
  registerBuiltinContributions(rendererRegistry);
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  resetFindBarState();
  resetFindSurfaces();
  vi.useFakeTimers();
  jumpTo = vi.fn().mockReturnValue(true);
  clearFeed = vi.fn();
  search = vi.fn().mockResolvedValue(searchResult([]));
  (window as unknown as { switchboard: unknown }).switchboard = { transcripts: { search } };
  publishFindSurface(findSurfaceKey('card-1', 'feed'), {
    kind: 'feed',
    jumpTo,
    clear: clearFeed,
  } as FindSurface);
  openFindBar('card-1');
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the find bar’s browser rhythm (P2-E17-02, §5.31)', () => {
  it('takes focus and searches what you type, once you stop typing', async () => {
    search.mockResolvedValue(searchResult([hit(4, 'ENOENT one'), hit(9, 'ENOENT two')]));
    const host = await mount(bar());
    const input = q<HTMLInputElement>(host, 'find-input')!;
    expect(document.activeElement).toBe(input);

    await act(async () => setFindTerm('ENOENT'));
    await settle();

    expect(search).toHaveBeenCalledTimes(1);
    expect(q(host, 'find-count')!.textContent).toBe(en.find.count.replace('{index}', '1').replace('{total}', '2'));
  });

  it('lands on the first match as you type, then steps with Enter and Shift+Enter, wrapping', async () => {
    search.mockResolvedValue(searchResult([hit(4, 'a'), hit(9, 'b'), hit(12, 'c')]));
    const host = await mount(bar());
    await act(async () => setFindTerm('x'));
    await settle();

    // ...and every step hands the feed the QUERY as well as the seq (#520),
    // because a surface that MARKS what it reveals cannot know the term any
    // other way. Asserted once, in full, here; the steps below check the seq.
    expect(jumpTo).toHaveBeenLastCalledWith(4, { term: 'x', caseSensitive: false, wholeWord: false });

    const input = q<HTMLInputElement>(host, 'find-input')!;
    const enter = (shift: boolean): Promise<void> =>
      act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift, bubbles: true }));
      });
    const landedOn = (): unknown => jumpTo.mock.lastCall?.[0];

    await enter(false);
    expect(landedOn()).toBe(9);
    await enter(false);
    expect(landedOn()).toBe(12);
    await enter(false); // wraps
    expect(landedOn()).toBe(4);
    await enter(true); // and back
    expect(landedOn()).toBe(12);
  });

  it('counts honestly when there is nothing there', async () => {
    const host = await mount(bar());
    await act(async () => setFindTerm('nope'));
    await settle();
    expect(q(host, 'find-count')!.textContent).toBe(en.find.noResults);
  });

  it('mounts its live region EMPTY on the first frame (#222)', async () => {
    const host = await mount(bar());
    const count = q(host, 'find-count')!;
    expect(count.getAttribute('role')).toBe('status');
    expect(count.getAttribute('aria-live')).toBe('polite');
    expect(count.textContent).toBe('');
  });

  it('Esc closes and puts focus back where it was', async () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    anchor.focus();
    expect(document.activeElement).toBe(anchor);

    const host = await mount(bar());
    const input = q<HTMLInputElement>(host, 'find-input')!;
    expect(document.activeElement).toBe(input);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(findBarState().openOn).toBeNull();
    // the restore is deferred a frame (the bar is still mounted synchronously)
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(document.activeElement).toBe(anchor);
  });

  it('clears the feed’s highlight when it closes', async () => {
    const host = await mount(bar());
    await act(async () => {
      q<HTMLElement>(host, 'find-close')!.click();
    });
    expect(clearFeed).toHaveBeenCalled();
  });
});

describe('a panel with no provider', () => {
  it('greys the bar and NAMES the tab, instead of silently searching the wrong surface', async () => {
    // History is the remaining case: a placeholder panel with no provider.
    const host = await mount(bar('history', 'grid.viewHistory'));
    const input = q<HTMLInputElement>(host, 'find-input')!;
    expect(input.disabled).toBe(true);
    const why = q(host, 'find-unavailable')!;
    expect(why.textContent).toBe(en.find.unavailable.noProvider.replace('{view}', en.grid.viewHistory));
  });

  it('does not search', async () => {
    await mount(bar('history', 'grid.viewHistory'));
    await act(async () => setFindTerm('anything'));
    await settle();
    expect(search).not.toHaveBeenCalled();
  });

  it('a Terminal tab with no terminal (a Direct session) says THAT, not "no provider"', async () => {
    // P2-E17-03: a stream session renders a notice instead of an xterm and
    // never publishes a surface, so the reason has to name the missing
    // terminal rather than report a confident 0 in the scrollback group.
    const host = await mount(bar('terminal', 'grid.viewTerminal'));
    expect(q<HTMLInputElement>(host, 'find-input')!.disabled).toBe(true);
    expect(q(host, 'find-unavailable')!.textContent).toBe(en.find.unavailable.noTerminal);
  });
});

describe('the §5.31 v1 boundary, rendered', () => {
  it('an evicted hit is READABLE, marked as earlier, and is NOT a control', async () => {
    search.mockResolvedValue(
      searchResult([hit(4, 'reachable'), hit(undefined, 'the string you know it printed', true)]),
    );
    const host = await mount(bar());
    await act(async () => setFindTerm('x'));
    await settle();
    await act(async () => {
      q<HTMLElement>(host, 'find-results-toggle')!.click();
    });

    const rows = Array.from(host.querySelectorAll('[data-find-hit]'));
    expect(rows).toHaveLength(2);
    expect(rows[0].tagName).toBe('BUTTON');
    // an affordance that does nothing is the same lie as searching the DOM
    expect(rows[1].tagName).not.toBe('BUTTON');
    expect(rows[1].textContent).toContain('the string you know it printed');
    expect(rows[1].textContent).toContain(en.find.earlier);
  });

  it('says when a session’s matches cannot be jumped to at all', async () => {
    search.mockResolvedValue(
      searchResult([hit(undefined, 'found')], {
        groups: [{ sessionId: 's1', hits: 1, blocks: 20, searched: true, aligned: false }],
      }),
    );
    const host = await mount(bar());
    await act(async () => setFindTerm('x'));
    await settle();
    expect(q(host, 'find-notice')!.textContent).toBe(en.find.notice.cannotJump);
  });

  it('clicking a jumpable row reveals it', async () => {
    search.mockResolvedValue(searchResult([hit(4, 'a'), hit(11, 'b')]));
    const host = await mount(bar());
    await act(async () => setFindTerm('x'));
    await settle();
    await act(async () => {
      q<HTMLElement>(host, 'find-results-toggle')!.click();
    });
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-find-hit]'));
    await act(async () => rows[1].click());
    expect(jumpTo).toHaveBeenLastCalledWith(11, { term: 'x', caseSensitive: false, wholeWord: false });
  });
});

describe('a delegated provider (the Changes tab)', () => {
  it('hands off to Monaco’s own find and takes our bar away', async () => {
    const openFind = vi.fn().mockReturnValue(true);
    publishFindSurface(findSurfaceKey('card-1', 'diff'), {
      kind: 'monaco',
      ready: () => true,
      openFind,
    } as FindSurface);
    await act(async () => setFindTerm('ENOENT'));

    await mount(bar('diff', 'grid.viewDiff'));

    expect(openFind).toHaveBeenCalledWith('ENOENT');
    expect(findBarState().openOn).toBeNull();
  });

  it('greys with a reason when there is no file open to delegate over', async () => {
    // The default state of the tab: an editor exists, no model is on it.
    publishFindSurface(findSurfaceKey('card-1', 'diff'), {
      kind: 'monaco',
      ready: () => false,
      openFind: () => false,
    } as FindSurface);
    const host = await mount(bar('diff', 'grid.viewDiff'));
    expect(q(host, 'find-unavailable')!.textContent).toBe(en.find.unavailable.diffNotReady);
    expect(findBarState().openOn).toBe('card-1');
  });
});

describe('the greyed bar is still operable from the keyboard', () => {
  it('takes focus on its CLOSE button, so Esc has somewhere to be heard', async () => {
    // The input is disabled, and focusing a disabled element is a silent
    // no-op — which would leave focus outside the bar entirely and make the
    // mouse the only way out of a panel that cannot even search.
    const host = await mount(bar('terminal', 'grid.viewTerminal'));
    const close = q<HTMLElement>(host, 'find-close')!;
    expect(document.activeElement).toBe(close);

    await act(async () => {
      close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(findBarState().openOn).toBeNull();
  });
});

describe('stepping never becomes a dead affordance', () => {
  it('SAYS it cannot scroll to a hit rather than opening the list over the pane', async () => {
    // The count must not tick from "1 of 2" to "2 of 2" with the conversation
    // sitting still and nothing saying why — that is the dead affordance. But
    // the answer is a line in the bar, NOT the results list (#557): the owner's
    // words for the list arriving unasked were "this weird window that showed
    // the different points in the session".
    search.mockResolvedValue(searchResult([hit(4, 'reachable'), hit(undefined, 'evicted', true)]));
    const host = await mount(bar());
    await act(async () => setFindTerm('x'));
    await settle();
    expect(q(host, 'find-results')).toBeNull();
    expect(q(host, 'find-stuck')).toBeNull();

    const input = q<HTMLInputElement>(host, 'find-input')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(q(host, 'find-count')!.textContent).toBe(
      en.find.count.replace('{index}', '2').replace('{total}', '2'),
    );
    expect(q(host, 'find-stuck')!.textContent).toBe(en.find.hitNotJumpable);
    // the pane is still the user's — the list is one `▸` away, unopened
    expect(q(host, 'find-results')).toBeNull();
  });

  it('stops saying it the moment a step lands somewhere', async () => {
    // A note that outlived the hit it was about would read as a property of the
    // search rather than of the keystroke.
    search.mockResolvedValue(searchResult([hit(undefined, 'evicted', true), hit(4, 'reachable')]));
    const host = await mount(bar());
    await act(async () => setFindTerm('x'));
    await settle();
    expect(q(host, 'find-stuck')).not.toBeNull();

    const input = q<HTMLInputElement>(host, 'find-input')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(q(host, 'find-stuck')).toBeNull();
  });

  it('does not open the list even when NO hit can be jumped to', async () => {
    // This was the case the auto-open existed for, and it is the one the owner
    // met daily on a resumed session. The bar carries it; the list stays shut.
    search.mockResolvedValue(
      searchResult([hit(undefined, 'a')], {
        groups: [{ sessionId: 's1', hits: 1, blocks: 9, searched: true, aligned: false }],
      }),
    );
    const host = await mount(bar());
    await act(async () => setFindTerm('x'));
    await settle();
    expect(q(host, 'find-results')).toBeNull();
    expect(q(host, 'find-stuck')!.textContent).toBe(en.find.hitNotJumpable);
  });

  it('a non-jumpable hit that is NOT known to be earlier says only that much', async () => {
    // Three things produce a hit with no seq and only one of them is "earlier
    // in the session" — asserting that about the other two is the confident
    // small lie §5.31 exists to avoid.
    search.mockResolvedValue(searchResult([hit(undefined, 'unaligned', false)]));
    const host = await mount(bar());
    await act(async () => setFindTerm('x'));
    await settle();
    // The list is where a row lives, and since #557 it opens only when asked —
    // so the ▸ is part of this test now rather than something the bar did for
    // us. What the row SAYS once it is up has not changed.
    await act(async () => {
      q<HTMLElement>(host, 'find-results-toggle')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    const row = host.querySelector('[data-find-hit-readonly]')!;
    expect(row.getAttribute('title')).toBe(en.find.cannotJumpTitle);
    expect(row.textContent).not.toContain(en.find.earlier);
  });
});

describe('the a11y contract (§5.32, one surface later)', () => {
  it('is a search landmark with a name, and every control is a real button with one', async () => {
    const host = await mount(bar());
    const region = q(host, 'find-bar')!;
    expect(region.getAttribute('role')).toBe('search');
    expect(region.getAttribute('aria-label')).toBe(en.find.label);

    const names = Array.from(region.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual([
      en.find.previous,
      en.find.next,
      en.find.caseSensitive,
      en.find.wholeWord,
      en.find.toggleResults,
      en.find.close,
    ]);
    expect(Array.from(region.querySelectorAll('button')).every((b) => b.tagName === 'BUTTON')).toBe(true);
  });

  it('the option toggles report their state with aria-pressed', async () => {
    const host = await mount(bar());
    const pressed = Array.from(host.querySelectorAll('button[aria-pressed]')).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(pressed).toEqual([en.find.caseSensitive, en.find.wholeWord]);
  });

  it('the results toggle points at a list that EXISTS while it is expanded', async () => {
    search.mockResolvedValue(searchResult([hit(4, 'a')]));
    const host = await mount(bar());
    await act(async () => setFindTerm('x'));
    await settle();
    const toggle = q<HTMLElement>(host, 'find-results-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeNull();

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const id = toggle.getAttribute('aria-controls')!;
    expect(host.ownerDocument.getElementById(id)).not.toBeNull();
  });

  it('is NOT a focus trap — Tab must be able to leave a non-modal bar', async () => {
    const host = await mount(bar());
    // nothing in the bar may declare itself modal, and nothing may hold focus
    // captive: a trap in a non-modal widget is a real 2.1.2 violation
    expect(host.querySelector('[aria-modal]')).toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P2-E17-03 — one Ctrl+F, results GROUPED BY VIEW (§5.31's first decision)
// ---------------------------------------------------------------------------

/**
 * Publish a fake terminal surface holding `matches` copies of a line.
 *
 * `live` is #517's seam: `true` means the answer came from the pane ON SCREEN
 * (highlighted, jumpable), `false` that it came from an off-screen replay of
 * main's ring buffer (real counts for a tab that was never opened, nothing
 * rendered to scroll). `search` resolves rather than returns, because on the
 * second path it genuinely crosses to main.
 */
function publishTerminal(
  rows: number[],
  total = rows.length,
  live = true
): ReturnType<typeof vi.fn> {
  const reveal = vi.fn().mockReturnValue(true);
  publishFindSurface(findSurfaceKey('card-1', 'terminal'), {
    kind: 'terminal',
    search: () =>
      Promise.resolve({
        matches: rows.map((row) => ({
          row,
          col: 2,
          length: 6,
          line: `row ${row} NEEDLE`,
          offset: 6,
        })),
        total,
        truncated: total > rows.length,
        live,
      }),
    reveal,
    clear: () => {},
  } as unknown as FindSurface);
  return reveal;
}

describe('grouped results (P2-E17-03)', () => {
  it('searches EVERY registrant on the card and labels each group — including the zeros', async () => {
    search.mockResolvedValue(searchResult([hit(4, 'a'), hit(5, 'b')]));
    publishTerminal([]); // nothing in the scrollback
    const host = await mount(bar());
    await act(async () => setFindTerm('NEEDLE'));
    await settle();

    const groups = q(host, 'find-groups')!;
    // "0 in Terminal (scrollback only)" is a DIFFERENT statement from silence,
    // and only one of them is true — the terminal saw 5,000 lines, not the
    // session
    expect(groups.textContent).toContain('2 in Session');
    expect(groups.textContent).toContain(`0 in ${en.find.group.terminal}`);
    expect(en.find.group.terminal).toContain('scrollback only');
  });

  it('a term only in the TRANSCRIPT still shows its Session count from the Terminal tab', async () => {
    // The item's third done-when. The Session group does not need a mounted
    // feed to be searched — the engine reads the file in main — so switching
    // to the Terminal tab must not zero it.
    search.mockResolvedValue(searchResult([hit(4, 'a'), hit(5, 'b'), hit(6, 'c')]));
    publishTerminal([]);
    const host = await mount(bar('terminal', 'grid.viewTerminal'));
    await act(async () => setFindTerm('ONLY_IN_TRANSCRIPT'));
    await settle();

    expect(q(host, 'find-unavailable')).toBeNull();
    expect(q(host, 'find-groups')!.textContent).toContain('3 in Session');
    expect(q(host, 'find-count')!.textContent).toBe('1 of 3');
  });

  it('the count is a position INSIDE one group, never a running total across two', async () => {
    search.mockResolvedValue(searchResult([hit(4, 'a'), hit(5, 'b')]));
    publishTerminal([10, 20]);
    const host = await mount(bar());
    await act(async () => setFindTerm('NEEDLE'));
    await settle();

    expect(q(host, 'find-count')!.textContent).toBe('1 of 2'); // in Session
    await act(async () => {
      q<HTMLElement>(host, 'find-next')!.click();
    });
    expect(q(host, 'find-count')!.textContent).toBe('2 of 2');
    await act(async () => {
      q<HTMLElement>(host, 'find-next')!.click();
    });
    // …into the terminal's group, which restarts at 1 of ITS own total —
    // "3 of 4" would be one number over two depths
    expect(q(host, 'find-count')!.textContent).toBe('1 of 2');
  });

  it('starts in the panel the user is LOOKING at', async () => {
    search.mockResolvedValue(searchResult([hit(4, 'a')]));
    const revealTerminal = publishTerminal([10, 20]);
    await mount(bar('terminal', 'grid.viewTerminal'));
    await act(async () => setFindTerm('NEEDLE'));
    await settle();
    // the session group sorts first, but the terminal is what is on screen
    expect(revealTerminal).toHaveBeenCalledTimes(1);
    expect(jumpTo).not.toHaveBeenCalled();
  });

  it('heads each run of rows in the results list with its group', async () => {
    search.mockResolvedValue(searchResult([hit(4, 'a')]));
    publishTerminal([10]);
    const host = await mount(bar());
    await act(async () => setFindTerm('NEEDLE'));
    await settle();
    await act(async () => {
      q<HTMLElement>(host, 'find-results-toggle')!.click();
    });
    const heads = Array.from(host.querySelectorAll('[data-testid="find-group-header"]')).map(
      (e) => e.textContent,
    );
    expect(heads).toEqual([en.grid.viewSession, en.find.group.terminal]);
  });

  it('a group that fails costs its own group and nothing else', async () => {
    search.mockRejectedValue(new Error('main is gone'));
    publishTerminal([10, 20]);
    const host = await mount(bar());
    await act(async () => setFindTerm('NEEDLE'));
    await settle();
    expect(q(host, 'find-groups')!.textContent).toContain(`2 in ${en.find.group.terminal}`);
    expect(q(host, 'find-notice')!.textContent).toContain(en.find.notice.failed);
  });

  it('does NOT group when there is only one searchable surface', async () => {
    // a Direct session: no terminal, so no second group and no line of noise
    search.mockResolvedValue(searchResult([hit(4, 'a')]));
    const host = await mount(bar());
    await act(async () => setFindTerm('NEEDLE'));
    await settle();
    expect(q(host, 'find-groups')).toBeNull();
    expect(host.querySelector('[data-testid="find-group-header"]')).toBeNull();
    expect(q(host, 'find-count')!.textContent).toBe('1 of 1');
  });

  it('a terminal that has never been SHOWN is a group with a REAL count (#517)', async () => {
    // The inversion of #516's blocker, and the point of #517.
    //
    // The Terminal panel is `keepMounted` and mounts with the card, but S-07
    // says a hidden pane is ingest-only — the renderer's xterm is fed only
    // while its tab is showing. #516 could only search that xterm, so on a card
    // whose Terminal had never been opened it withheld the group rather than
    // print "0 in Terminal (scrollback only)" about a buffer with no lines.
    // The scrollback was in MAIN the whole time; the surface now reads it, and
    // answers `live: false` to say the count is real but nothing is on screen
    // to scroll to.
    search.mockResolvedValue(searchResult([hit(4, 'a')]));
    publishTerminal([12, 44], 2, false);
    const host = await mount(bar());
    await act(async () => setFindTerm('NEEDLE'));
    await settle();

    expect(q(host, 'find-groups')!.textContent).toContain(`2 in ${en.find.group.terminal}`);
    // and the bar says why they cannot be stepped to, rather than offering a
    // jump that would do nothing
    expect(q(host, 'find-notice')!.textContent).toContain(en.find.notice.terminalNotShown);
  });

  it('…and those hits are readable, not jumpable', async () => {
    search.mockResolvedValue(searchResult([]));
    const reveal = publishTerminal([12], 1, false);
    const host = await mount(bar());
    await act(async () => setFindTerm('NEEDLE'));
    await settle();
    await act(async () => {
      q<HTMLElement>(host, 'find-results-toggle')!.click();
    });
    const row = host.querySelector<HTMLElement>('[data-find-hit]')!;
    // a plain element with the reason on it, never a button (`renderHit`)
    expect(row.tagName).not.toBe('BUTTON');
    expect(row.getAttribute('title')).toBe(en.find.cannotJumpTitle);
    await act(async () => row.click());
    expect(reveal).not.toHaveBeenCalled();
  });

  it('says "could not search" rather than 0 when the scrollback cannot be READ', async () => {
    // `null` from the surface: the PTY is gone, or the read failed. "We could
    // not look" is not "we looked and found none" — the failure this whole
    // group is careful about, one layer further down.
    search.mockResolvedValue(searchResult([hit(4, 'a')]));
    publishFindSurface(findSurfaceKey('card-1', 'terminal'), {
      kind: 'terminal',
      search: () => Promise.resolve(null),
      reveal: () => true,
      clear: () => {},
    } as unknown as FindSurface);
    const host = await mount(bar());
    await act(async () => setFindTerm('NEEDLE'));
    await settle();
    expect(q(host, 'find-notice')!.textContent).toContain(en.find.notice.failed);
    // and the group shows an em dash where the digit goes, NOT a zero: this is
    // the line the whole item is about, and a `0` here would say "not in the
    // last 5,000 lines" about lines nobody managed to read
    expect(q(host, 'find-groups')!.textContent).not.toContain(`0 in ${en.find.group.terminal}`);
    expect(q(host, 'find-groups')!.textContent).toContain(`— in ${en.find.group.terminal}`);
  });

  it('the bar is NOT greyed on a Terminal tab that was never opened (#517)', async () => {
    // It used to be: `ready()` was false for a pane that had never attached,
    // and the reason text said "open the Terminal tab". There is no such reason
    // any more — the group is searchable from main's buffer — so the input is
    // live and the user can type.
    publishTerminal([7], 1, false);
    const host = await mount(bar('terminal', 'grid.viewTerminal'));
    expect(q(host, 'find-unavailable')).toBeNull();
    expect(q<HTMLInputElement>(host, 'find-input')!.disabled).toBe(false);
  });

  it('renders a floor as "N+" rather than presenting a ceiling as a count', async () => {
    search.mockResolvedValue(searchResult([hit(4, 'a')]));
    publishFindSurface(findSurfaceKey('card-1', 'terminal'), {
      kind: 'terminal',
      search: () =>
        Promise.resolve({
          matches: [{ row: 1, col: 0, length: 6, line: 'NEEDLE here', offset: 0 }],
          total: 1000,
          truncated: true,
          totalIsFloor: true,
          live: true,
        }),
      reveal: () => true,
      clear: () => {},
    } as unknown as FindSurface);
    const host = await mount(bar('terminal', 'grid.viewTerminal'));
    await act(async () => setFindTerm('NEEDLE'));
    await settle();
    expect(q(host, 'find-groups')!.textContent).toContain(`1000+ in ${en.find.group.terminal}`);
    expect(q(host, 'find-count')!.textContent).toBe('1 of 1 shown (1000+ found)');
  });

  it('says nothing rather than "No results" when every group FAILED', async () => {
    // "we could not look" and "it is not there" are different answers, and the
    // live region is what a screen reader hears
    search.mockRejectedValue(new Error('main is gone'));
    const host = await mount(bar());
    await act(async () => setFindTerm('NEEDLE'));
    await settle();
    expect(q(host, 'find-count')!.textContent).toBe('');
    expect(q(host, 'find-notice')!.textContent).toContain(en.find.notice.failed);
  });

  it('undoes what it painted when the searchable set EMPTIES under it', async () => {
    // switch to Changes mid-search: the terminal is `keepMounted` and would sit
    // there holding decorations with nobody left holding a reference to it
    search.mockResolvedValue(searchResult([hit(4, 'a')]));
    const clearTerminal = vi.fn();
    publishFindSurface(findSurfaceKey('card-1', 'terminal'), {
      kind: 'terminal',
      search: () =>
        Promise.resolve({ matches: [], total: 0, truncated: false, totalIsFloor: false, live: true }),
      reveal: () => true,
      clear: clearTerminal,
    } as unknown as FindSurface);
    publishFindSurface(findSurfaceKey('card-1', 'diff'), {
      kind: 'monaco',
      ready: () => true,
      openFind: () => true,
    } as FindSurface);

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(bar()));
    await act(async () => setFindTerm('NEEDLE'));
    await settle();
    // (clearing is idempotent and also runs when the bar opens, so this counts
    // the DELTA rather than asserting nothing has happened yet)
    const before = clearTerminal.mock.calls.length;
    const beforeFeed = clearFeed.mock.calls.length;

    // the same bar, now told the focused panel is Changes (a delegated
    // provider), which empties the bar-mode set
    await act(async () => root!.render(bar('diff', 'grid.viewDiff')));
    expect(clearTerminal.mock.calls.length).toBeGreaterThan(before);
    expect(clearFeed.mock.calls.length).toBeGreaterThan(beforeFeed);
  });

  it('clearing on close reaches EVERY group, not just the focused one', async () => {
    search.mockResolvedValue(searchResult([hit(4, 'a')]));
    const clearTerminal = vi.fn();
    publishFindSurface(findSurfaceKey('card-1', 'terminal'), {
      kind: 'terminal',
      search: () => Promise.resolve({ matches: [], total: 0, truncated: false, live: true }),
      reveal: () => true,
      clear: clearTerminal,
    } as unknown as FindSurface);
    const host = await mount(bar());
    await act(async () => setFindTerm('NEEDLE'));
    await settle();
    await act(async () => {
      q<HTMLElement>(host, 'find-close')!.click();
    });
    expect(clearFeed).toHaveBeenCalled();
    expect(clearTerminal).toHaveBeenCalled();
  });
});

describe('the bar over a DOCUMENT viewer (#533)', () => {
  /** A viewer's surface, keyed by its `doc-` panel id in the cardId role. */
  function publishDoc(
    view: 'rendered' | 'source' | 'none',
    over: Record<string, unknown> = {}
  ): { search: ReturnType<typeof vi.fn>; reveal: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; openFind: ReturnType<typeof vi.fn> } {
    const spies = {
      search: vi.fn().mockReturnValue({
        matches: [
          { text: 'the needle is here', offset: 4, length: 6 },
          { text: 'another needle', offset: 8, length: 6 },
        ],
        truncated: false,
      }),
      reveal: vi.fn().mockReturnValue(true),
      clear: vi.fn(),
      openFind: vi.fn().mockReturnValue(true),
    };
    publishFindSurface(findSurfaceKey('doc-9', 'document'), {
      kind: 'document',
      view: () => view,
      ...spies,
      ...over,
    } as unknown as FindSurface);
    return spies;
  }

  /** NO sessionId — a viewer is session-attributed, not session-owned. */
  const docBar = (): React.JSX.Element => (
    <FindBar cardId="doc-9" panelId="document" panelTitleKey="find.group.document" />
  );

  beforeEach(() => {
    openFindBar('doc-9');
  });

  it('searches the document and NOTHING else — no session, no terminal group', async () => {
    publishDoc('rendered');
    // a feed surface for card-1 is published by the outer beforeEach and stays
    // published; naming a different panel is what keeps it out of reach
    const host = await mount(docBar());
    await act(async () => setFindTerm('needle'));
    await settle();
    expect(q<HTMLElement>(host, 'find-count')!.textContent).toBe('1 of 2');
    // the transcript engine is never asked: with no session the Session group
    // excludes itself through the `noSession` check that was already there
    expect(search).not.toHaveBeenCalled();
    // one group, so no group line — the zeros only matter when there are two
    expect(q(host, 'find-groups')).toBeNull();
  });

  it('steps the matches through the surface, marking each one', async () => {
    const doc = publishDoc('rendered');
    const host = await mount(docBar());
    await act(async () => setFindTerm('needle'));
    await settle();
    expect(doc.reveal).toHaveBeenLastCalledWith(0);
    await act(async () => {
      q<HTMLElement>(host, 'find-next')!.click();
    });
    expect(doc.reveal).toHaveBeenLastCalledWith(1);
    expect(q<HTMLElement>(host, 'find-count')!.textContent).toBe('2 of 2');
  });

  it('closing the bar clears the marks it painted', async () => {
    const doc = publishDoc('rendered');
    const host = await mount(docBar());
    await act(async () => setFindTerm('needle'));
    await settle();
    await act(async () => {
      q<HTMLElement>(host, 'find-close')!.click();
    });
    expect(doc.clear).toHaveBeenCalled();
    expect(findBarState().openOn).toBeNull();
  });

  it('hands the SOURCE body to Monaco and gets out of the way', async () => {
    // §5.31 names Monaco's find as a thing not to reimplement, so the viewer's
    // source body is delegated exactly as the Changes tab is — decided per
    // surface (`modeFor`), because it is one panel with two bodies.
    const doc = publishDoc('source');
    await act(async () => setFindTerm('ENOENT'));
    await mount(docBar());
    expect(doc.openFind).toHaveBeenCalledWith('ENOENT');
    expect(doc.search).not.toHaveBeenCalled();
    // our bar closes: the widget owns the keyboard now
    expect(findBarState().openOn).toBeNull();
  });

  it('greys with a reason while the document is still opening', async () => {
    publishDoc('none');
    const host = await mount(docBar());
    expect(q<HTMLElement>(host, 'find-unavailable')!.textContent).toBe(
      en.find.unavailable.documentNotReady
    );
    expect(q<HTMLInputElement>(host, 'find-input')!.disabled).toBe(true);
  });
});
