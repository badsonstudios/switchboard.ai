// @vitest-environment jsdom
// The status bar's workspace total, and whether it is honest about the
// sessions it could not price (#1288). Asserted against the REAL `en.json`,
// for #785's reason (see `UsageStrip.test.tsx`).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';
import type { StatusBarContext } from './contributions';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const base: StatusBarContext = { count: 1, theme: 'nordic', themeNameKey: 'theme.nordic' };

function render(over: Partial<StatusBarContext>): HTMLElement {
  const item = createRendererRegistry()
    .list('status-bar-item')
    .find((i) => i.manifest.id === 'status-usage')!;
  act(() => {
    root.render(<>{item.render({ ...base, ...over })}</>);
  });
  return host.firstElementChild as HTMLElement;
}

describe('the status-bar usage total', () => {
  it('every session priced: exactly the wording it always had, and no tooltip', () => {
    const el = render({ totalOutputTokens: 12_300, totalCostUsd: 1.5, unpricedSessions: 0 });
    expect(el.textContent).toBe('↓12k · ~$1.50 est');
    expect(el.hasAttribute('title')).toBe(false);
  });

  it('some sessions unpriced: says the total is a floor, and counts what is missing', () => {
    const el = render({ totalOutputTokens: 12_300, totalCostUsd: 1.5, unpricedSessions: 2 });
    expect(el.textContent).toBe('↓12k · ≥$1.50 est');
    expect(el.getAttribute('title')).toContain('2 sessions use a model with no known price');
  });

  it('nothing priced: "no price", never a $0.00 that reads as free', () => {
    const el = render({ totalOutputTokens: 942, totalCostUsd: 0, unpricedSessions: 1 });
    expect(el.textContent).toBe('↓942 · no price');
    expect(el.textContent).not.toMatch(/\$/);
    expect(el.getAttribute('title')).toContain('1 session uses a model with no known price');
  });

  it('lists a plan-limit window an AI reported, in the tooltip', () => {
    const el = render({
      totalOutputTokens: 942,
      totalCostUsd: 0,
      unpricedSessions: 1,
      planLimits: [{ id: 'primary', label: '5h limit', usedPercent: 3 }],
    });
    expect(el.getAttribute('title')).toContain('5h limit: 3% used');
  });

  it('never renders a raw interpolation brace', () => {
    for (const over of [
      { unpricedSessions: 0 },
      { unpricedSessions: 1 },
      { unpricedSessions: 1, totalCostUsd: 0 },
    ]) {
      const el = render({ totalOutputTokens: 100, totalCostUsd: 2, ...over });
      expect(el.textContent).not.toMatch(/[{}]/);
      expect(el.getAttribute('title') ?? '').not.toMatch(/[{}]/);
    }
  });
});
