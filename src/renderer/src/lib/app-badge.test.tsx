// @vitest-environment jsdom
// #1605: the count the window sends for its icon, and the setting that clears it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { APP_BADGE_KEY, appBadgeOf, badgeText, resetAppBadgeForTests, setAppBadge, useAttentionBadge } from './app-badge';
import { uiDelete, uiGet } from './ui-state';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

type Sent = { count: number; png?: string; label?: string };
let sent: Sent[];
let root: Root | null = null;

function Probe({ count }: { count: number }): null {
  useAttentionBadge(count, (n) => `${n} need you`);
  return null;
}

async function render(count: number): Promise<void> {
  if (!root) root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Probe count={count} />));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  sent = [];
  (window as unknown as { switchboard: unknown }).switchboard = {
    setAttentionBadge: (r: Sent) => {
      sent.push(r);
      return Promise.resolve(true);
    },
  };
  uiDelete([APP_BADGE_KEY]);
  resetAppBadgeForTests();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  delete (window as unknown as { switchboard?: unknown }).switchboard;
});

describe('the count on the app icon (#1605)', () => {
  it('is on unless turned off', () => {
    expect(appBadgeOf(undefined)).toBe(true);
    expect(appBadgeOf(false)).toBe(false);
  });

  it('says 1 to 9, then 9+', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(9)).toBe('9');
    expect(badgeText(10)).toBe('9+');
  });

  it('sends the count and its words when it changes, and 0 clears it', async () => {
    await render(2);
    await render(2); // unchanged: nothing new is sent
    await render(0);
    expect(sent.map((s) => s.count)).toEqual([2, 0]);
    expect(sent[0].label).toBe('2 need you');
    expect(sent[1]).toEqual({ count: 0 });
  });

  it('turning it off clears the icon, and on shows the count again', async () => {
    await render(3);
    await act(async () => setAppBadge(false));
    expect(uiGet(APP_BADGE_KEY, undefined)).toBe(false);
    await act(async () => setAppBadge(true));
    expect(sent.map((s) => s.count)).toEqual([3, 0, 3]);
  });
});
