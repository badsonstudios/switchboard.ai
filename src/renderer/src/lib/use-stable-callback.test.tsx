// @vitest-environment jsdom
// #716: one identity for the life of the component, the LATEST function behind
// it, and absence kept as absence.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useStableCallback } from './use-stable-callback';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

type Fn = (n: number) => number;
const seen: Array<Fn | undefined> = [];

function Probe({ fn }: { fn?: Fn }): null {
  seen.push(useStableCallback(fn));
  return null;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  seen.length = 0;
});

async function withRoot(steps: Array<Fn | undefined>): Promise<void> {
  const root = createRoot(document.createElement('div'));
  for (const fn of steps) {
    await act(async () => {
      root.render(<Probe fn={fn} />);
    });
  }
  act(() => root.unmount());
}

describe('useStableCallback (#716)', () => {
  it('keeps one identity while the function it is given changes, and calls the newest', async () => {
    const a = vi.fn((n: number) => n + 1);
    const b = vi.fn((n: number) => n * 10);
    await withRoot([a, b]);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]!(3)).toBe(30);
    expect(a).not.toHaveBeenCalled();
  });

  it('is undefined while there is no function — a control with nothing to call is not drawn', async () => {
    await withRoot([undefined, (n) => n, undefined]);
    expect(seen[0]).toBeUndefined();
    expect(typeof seen[1]).toBe('function');
    expect(seen[2]).toBeUndefined();
  });

  it('a handler kept from before the function was taken away does nothing, and does not throw', async () => {
    const a = vi.fn((n: number) => n);
    await withRoot([a, undefined]);
    expect(() => seen[0]!(1)).not.toThrow();
    expect(a).not.toHaveBeenCalled();
  });
});
