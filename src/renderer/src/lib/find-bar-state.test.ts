import { describe, it, expect, beforeEach } from 'vitest';
import {
  closeFindBar,
  findBarState,
  findQuery,
  openFindBar,
  resetFindBarState,
  setFindListOpen,
  setFindOptions,
  setFindTerm,
  subscribeFindBar,
} from './find-bar-state';

beforeEach(() => resetFindBarState());

describe('the find bar’s state (P2-E17-02)', () => {
  it('opens on a card and closes', () => {
    openFindBar('card-1');
    expect(findBarState().openOn).toBe('card-1');
    closeFindBar();
    expect(findBarState().openOn).toBeNull();
  });

  it('ignores an open with no focused card rather than opening nowhere', () => {
    openFindBar(null);
    expect(findBarState().openOn).toBeNull();
  });

  it('KEEPS THE TERM across a close and across a card switch — the sticky promise', () => {
    // The browser rhythm: Ctrl+F, type, Esc, switch tab, Ctrl+F, and your term
    // is still there. Component state cannot do this — a tab switch unmounts
    // the panel the bar was rendered in.
    openFindBar('card-1');
    setFindTerm('ENOENT');
    closeFindBar();
    expect(findBarState().term).toBe('ENOENT');
    openFindBar('card-2');
    expect(findBarState().term).toBe('ENOENT');
  });

  it('keeps the options sticky too, and hands them over as a query', () => {
    setFindTerm('Foo');
    setFindOptions({ caseSensitive: true });
    setFindOptions({ wholeWord: true });
    expect(findQuery()).toEqual({ term: 'Foo', caseSensitive: true, wholeWord: true });
  });

  it('bumps the nonce on EVERY open, including one on the card already showing it', () => {
    // A second Ctrl+F must re-focus and select. `openOn` does not change, so
    // without the nonce nothing downstream would re-run.
    openFindBar('card-1');
    const first = findBarState().openNonce;
    openFindBar('card-1');
    expect(findBarState().openNonce).toBe(first + 1);
  });

  it('collapses the results list on close, but does not forget the term', () => {
    openFindBar('card-1');
    setFindTerm('x');
    setFindListOpen(true);
    closeFindBar();
    expect(findBarState().listOpen).toBe(false);
    expect(findBarState().term).toBe('x');
  });

  it('does not notify — or change identity — on a no-op set', () => {
    // useSyncExternalStore compares snapshots by reference; a new object for
    // an unchanged value is a render on every keystroke that changed nothing.
    openFindBar('card-1');
    let n = 0;
    subscribeFindBar(() => (n += 1));
    const before = findBarState();
    setFindTerm('');
    expect(n).toBe(0);
    expect(findBarState()).toBe(before);
  });

  it('notifies on a real change', () => {
    let n = 0;
    subscribeFindBar(() => (n += 1));
    setFindTerm('a');
    expect(n).toBe(1);
  });
});
