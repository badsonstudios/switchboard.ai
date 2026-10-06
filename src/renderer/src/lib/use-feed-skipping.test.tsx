// @vitest-environment jsdom
// The hook that writes the feed's skip styling, against a DOM (#716).
//
// `feed-skipping.test.ts` pins the rules about numbers and
// `e2e/feed-skipping.spec.ts` pins the layout. Neither reaches the part in
// between that #716 added: WHEN a group's height is thrown away. Those paths
// are driven by things the e2e's fake cannot produce on demand — a block
// arriving in a group that is already skipped, a group closing between two
// frames, one conversation replacing another under the same keys — and each of
// them fails the same quiet way, with a group left standing on a height that
// was true of something else.
//
// jsdom has a real `MutationObserver` and no layout, so the `ResizeObserver`
// here is a fake the test delivers reports through. That is the honest split:
// what is asserted is what the hook DOES with a report, never what a size is.
import React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEED_GROUP_ATTR, FEED_GROUP_OPEN_ATTR, useFeedSkipping } from './use-feed-skipping';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** every live fake observer, so a test can deliver a report to whoever is watching */
let observers: FakeResizeObserver[] = [];

class FakeResizeObserver {
  readonly targets = new Set<Element>();
  /** how many times each element was subscribed — a re-subscription is the claim */
  readonly subscriptions = new Map<Element, number>();
  constructor(private readonly cb: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
    this.subscriptions.set(el, (this.subscriptions.get(el) ?? 0) + 1);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
  deliver(el: Element, width: number, height: number): void {
    if (!this.targets.has(el)) return;
    const entry = {
      target: el,
      contentBoxSize: [{ inlineSize: width, blockSize: height }],
      contentRect: { width, height },
    } as unknown as ResizeObserverEntry;
    this.cb([entry], this);
  }
}

/** report a size for an element to every observer watching it */
function report(el: Element, height: number, width = 900): void {
  for (const o of observers) o.deliver(el, width, height);
}

function subscriptions(el: Element): number {
  return observers.reduce((n, o) => n + (o.subscriptions.get(el) ?? 0), 0);
}

interface Conversation {
  /** group key -> the seqs in it */
  groups: Array<[number, number[]]>;
  conversation?: number;
}

function Feed({ groups, conversation = 0 }: Conversation): React.JSX.Element {
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const content = React.useRef<HTMLDivElement | null>(null);
  useFeedSkipping(scroller, content, conversation);
  return (
    <div ref={scroller}>
      <div ref={content}>
        {groups.map(([key, seqs], i) => (
          <div
            key={key}
            {...{ [FEED_GROUP_ATTR]: String(key) }}
            {...(i === groups.length - 1 ? { [FEED_GROUP_OPEN_ATTR]: '' } : {})}
          >
            {seqs.map((seq) => (
              <div key={seq} data-feed-block="assistant" data-feed-seq={String(seq)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

let root: Root;
let host: HTMLElement;

async function render(c: Conversation): Promise<void> {
  await act(async () => {
    root.render(<Feed {...c} />);
  });
  // the MutationObserver's callback is a microtask after the commit
  await act(async () => {
    await Promise.resolve();
  });
}

const group = (key: number): HTMLElement => host.querySelector<HTMLElement>(`[${FEED_GROUP_ATTR}="${key}"]`)!;
const block = (seq: number): HTMLElement => host.querySelector<HTMLElement>(`[data-feed-seq="${seq}"]`)!;
const skipped = (el: HTMLElement): boolean => el.style.contentVisibility === 'auto';

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  observers = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('useFeedSkipping — groups (#716)', () => {
  it('skips a closed group on its own measured height, and a block on its own', async () => {
    await render({ groups: [[0, [1, 2]], [1, [40]]] });
    report(block(1), 30);
    report(group(0), 64);
    expect(block(1).style.containIntrinsicSize).toBe('auto 30.00px');
    expect(skipped(group(0))).toBe(true);
    expect(group(0).style.containIntrinsicSize).toBe('auto 64.00px');
  });

  it('measures the OPEN group and never skips it', async () => {
    // blocks land in it continuously, and a skipped subtree reports no growth
    await render({ groups: [[0, [1]], [1, [40]]] });
    report(group(1), 120);
    expect(skipped(group(1))).toBe(false);
    expect(group(1).style.containIntrinsicSize).toBe('');
  });

  it('re-measures a group that has just CLOSED rather than trusting its last report', async () => {
    // Two blocks inside one frame: the first lands in the open group, the
    // second opens the next one. The only height on record for the first group
    // is from before either arrived.
    //
    // The group's own blocks are the SAME in both renders here, on purpose: a
    // changed child list would be caught by the other path, and this case
    // would pass with the one it is named for deleted.
    await render({ groups: [[0, [1, 2]]] });
    report(group(0), 30);
    const before = subscriptions(group(0));

    await render({ groups: [[0, [1, 2]], [1, [40]]] });
    // not stood on the stale 30 — unskipped, and asked for a fresh report
    expect(skipped(group(0))).toBe(false);
    expect(subscriptions(group(0))).toBe(before + 1);

    report(group(0), 60);
    expect(skipped(group(0))).toBe(true);
    expect(group(0).style.containIntrinsicSize).toBe('auto 60.00px');
  });

  it('forgets a skipped group`s height when its blocks change, and skips it again once measured', async () => {
    await render({ groups: [[0, [1, 2, 3]], [1, [40]]] });
    report(group(0), 90);
    expect(skipped(group(0))).toBe(true);
    const before = subscriptions(group(0));

    // the verbosity filter hides one, or the cap evicts one
    await render({ groups: [[0, [2, 3]], [1, [40]]] });
    expect(skipped(group(0))).toBe(false);
    expect(group(0).style.containIntrinsicSize).toBe('');
    // RE-SUBSCRIBED: without a fresh first report, a group whose new height
    // equalled its old one would never be heard from again
    expect(subscriptions(group(0))).toBe(before + 1);

    report(group(0), 60);
    expect(group(0).style.containIntrinsicSize).toBe('auto 60.00px');
  });

  it('skips it again even when the new height is the SAME as the old one', async () => {
    await render({ groups: [[0, [1, 2]], [1, [40]]] });
    report(group(0), 60);
    await render({ groups: [[0, [2, 3]], [1, [40]]] });
    expect(skipped(group(0))).toBe(false);
    report(group(0), 60);
    expect(skipped(group(0))).toBe(true);
  });

  it('leaves the other groups alone when one changes', async () => {
    await render({ groups: [[0, [1]], [1, [40, 41]], [2, [80]]] });
    report(group(0), 30);
    report(group(1), 60);
    await render({ groups: [[0, [1]], [1, [41]], [2, [80]]] });
    expect(skipped(group(0))).toBe(true);
    expect(skipped(group(1))).toBe(false);
  });

  it('un-skips a group that becomes the open one again', async () => {
    await render({ groups: [[0, [1]], [1, [40]]] });
    report(group(0), 30);
    expect(skipped(group(0))).toBe(true);
    await render({ groups: [[0, [1]]] });
    expect(skipped(group(0))).toBe(false);
  });

  it('believes nothing from a panel with no layout', async () => {
    // dockview detaches a background panel, and a detached element reports 0x0
    await render({ groups: [[0, [1]], [1, [40]]] });
    report(group(0), 0, 0);
    expect(skipped(group(0))).toBe(false);
  });

  it('throws every height away when the conversation is REPLACED under the same keys', async () => {
    // A different session in the same card counts from the same first seq, so
    // React keeps these very elements and nothing about them says they changed.
    await render({ groups: [[0, [1, 2]], [1, [40]]], conversation: 0 });
    report(block(1), 30);
    report(group(0), 64);
    const g = group(0);
    const b = block(1);

    await render({ groups: [[0, [1, 2]], [1, [40]]], conversation: 1 });
    // the premise: the same elements, which is why nothing else would notice
    expect(group(0)).toBe(g);
    expect(block(1)).toBe(b);
    expect(skipped(g)).toBe(false);
    expect(b.style.contentVisibility).toBe('');
    expect(b.style.containIntrinsicSize).toBe('');

    // ...and what it is measured at next is what it stands on
    report(g, 200);
    expect(g.style.containIntrinsicSize).toBe('auto 200.00px');
  });

  it('leaves no styling behind when the feed goes away', async () => {
    await render({ groups: [[0, [1]], [1, [40]]] });
    report(block(1), 30);
    report(group(0), 30);
    const g = group(0);
    const b = block(1);
    await act(async () => root.render(<div />));
    expect(g.style.contentVisibility).toBe('');
    expect(b.style.contentVisibility).toBe('');
  });
});
