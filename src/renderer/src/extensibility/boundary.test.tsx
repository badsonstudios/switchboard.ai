// @vitest-environment jsdom
// The reset policy on `ContributionBoundary` (#463).
//
// The boundary used to LATCH: one throw and that surface was dead until the
// app restarted, for every consumer of the seam. Fail-open says our breakage
// never blocks a session, and a transient render error permanently killing a
// status-bar item, a panel or a document viewer is the mild version of exactly
// that. The policy is bounded automatic retry, and BOTH halves need a test
// standing on them, because each one alone is a bug:
//
//   - no retry at all is the latch this issue is about;
//   - retry with no bound is the classic error-boundary trap — a contribution
//     that always throws throws once per parent render, forever, on a feed that
//     re-renders per streamed chunk.
//
// So the cases below prove the two directions together: a once-throwing
// contribution comes back, and an always-throwing one is offered exactly
// `CONTRIBUTION_RETRY_LIMIT` renders no matter how many times its parent
// re-renders after that.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContributionBoundary, CONTRIBUTION_RETRY_LIMIT } from './boundary';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

/** Every render attempt the contribution was actually offered. */
let attempts = 0;

/** What a surviving render puts on the page (a bare literal is a lint error). */
const ALIVE = 'alive';

function Contribution({ throws }: { throws: boolean }): React.JSX.Element {
  attempts += 1;
  if (throws) throw new Error('contribution exploded');
  return <span>{ALIVE}</span>;
}

/** Our own log lines, separated from React's own error noise. */
function boundaryLogs(): string[] {
  const spy = console.error as unknown as ReturnType<typeof vi.fn>;
  return spy.mock.calls
    .map((c: unknown[]) => (typeof c[0] === 'string' ? c[0] : ''))
    .filter((m: string) => m.startsWith('[contributions]'));
}

let host: HTMLElement;
let root: Root;

/** Re-render the boundary the way a parent does: a NEW children element. */
function draw(throws: boolean, id = 'probe'): void {
  act(() => {
    root.render(
      <ContributionBoundary id={id}>
        <Contribution throws={throws} />
      </ContributionBoundary>
    );
  });
}

beforeEach(() => {
  attempts = 0;
  // React shouts about every caught error; the run's output is not the subject
  // and the spy is how the boundary's OWN lines are counted.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('a contribution that threw once', () => {
  it('comes back on the next render, without the app restarting', () => {
    draw(true);
    expect(host.textContent).toBe('');

    draw(false);

    expect(host.textContent).toBe(ALIVE);
  });

  it('gets a fresh budget once a render survives, so a second hiccup is not fatal', () => {
    // A lifetime budget would kill a long-lived status-bar item that hiccups
    // three times over a day — the latch again, just slower.
    for (let i = 0; i < CONTRIBUTION_RETRY_LIMIT * 3; i++) {
      draw(true);
      expect(host.textContent).toBe('');
      draw(false);
      expect(host.textContent).toBe(ALIVE);
    }
  });
});

describe('a contribution that always throws', () => {
  // COUNTING NOTE: `attempts` runs ahead of the number of failures the boundary
  // caught, because React re-invokes a throwing render in dev to recover the
  // component stack for its own console message. That doubling is React's, not
  // the policy's — so the bound is asserted as "more parent renders cost NO
  // further attempts", which is the spin question itself, plus the count of
  // failures the boundary actually caught (one log line each).
  it('costs nothing further once the bound is spent, however often its parent re-renders', () => {
    for (let i = 0; i < CONTRIBUTION_RETRY_LIMIT; i++) draw(true);
    const spent = attempts;
    expect(spent).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) draw(true);

    expect(attempts).toBe(spent);
    expect(boundaryLogs()).toHaveLength(CONTRIBUTION_RETRY_LIMIT);
    expect(host.textContent).toBe('');
  });

  it('stays latched even when it would now succeed — the bound is the point', () => {
    for (let i = 0; i < 20; i++) draw(true);
    const spent = attempts;

    draw(false);

    // Nothing was offered, so nothing recovered: past the bound the surface is
    // a gap until it is REBUILT (close and reopen the tab, or restart), which
    // is the recovery it always had.
    expect(attempts).toBe(spent);
    expect(host.textContent).toBe('');
  });

  it('says once, by name, that it has given up — and names itself every time', () => {
    for (let i = 0; i < 20; i++) draw(true);

    const logs = boundaryLogs();
    expect(logs.every((m) => m.includes('"probe"'))).toBe(true);
    expect(logs.filter((m) => m.includes('giving up'))).toHaveLength(1);
    // the give-up line is the LAST one: the earlier ones promise a retry
    expect(logs[logs.length - 1]).toContain('giving up');
  });
});

describe('the fallback', () => {
  it('renders nothing rather than an error placeholder', () => {
    draw(true);
    expect(host.innerHTML).toBe('');
  });

  it('starts a different contribution in the same slot on a clean slate', () => {
    for (let i = 0; i < 20; i++) draw(true);
    expect(boundaryLogs()).toHaveLength(CONTRIBUTION_RETRY_LIMIT);

    // a latched boundary that is handed a DIFFERENT contribution id is no
    // longer the same contribution's streak
    draw(false, 'someone-else');

    expect(host.textContent).toBe(ALIVE);
  });
});
