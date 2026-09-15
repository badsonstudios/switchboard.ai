// @vitest-environment jsdom
// The dollar figure on the card, and whether it is honest about where it came
// from (#787).
//
// THIS FILE EXISTS BECAUSE OF #785's LESSON: the headline i18n string there had
// no unit test, so swapping one `t()` key for another left 7,758 tests green
// while the fix silently reverted. Everything #787 does that a USER can see is
// one string and one tooltip, so both are asserted here against the REAL
// `en.json` — not against a mock catalogue, which would pass while the shipped
// text said something else.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { UsageStrip } from './UsageStrip';
import type { CliCost, Usage } from '../lib/usage';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;

const USAGE = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreate: 0 };

const cli = (over: Partial<CliCost> = {}): CliCost => ({
  totalCostUSD: 42.5,
  modelUsage: {},
  totalAPIDuration: 0,
  totalAPIDurationWithoutRetries: 0,
  totalToolDuration: 0,
  totalDuration: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  startTime: 0,
  ...over,
});

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

function render(props: { model?: string; cliCost?: CliCost; usage?: Usage }): void {
  act(() => {
    root.render(<UsageStrip usage={USAGE} {...props} />);
  });
}

/** The `<span>` holding the cost, found by its tooltip rather than by index. */
function costSpan(): HTMLElement {
  const spans = [...host.querySelectorAll('span[title]')] as HTMLElement[];
  const found = spans.find((s) => /\$/.test(s.textContent ?? ''));
  expect(found, 'no cost span rendered').toBeTruthy();
  return found!;
}

describe('UsageStrip cost figure', () => {
  it('shows our estimate with a ~ and the estimate tooltip', () => {
    render({ model: 'claude-opus-5' });
    expect(costSpan().textContent).toBe('~$30.00');
    expect(costSpan().getAttribute('title')).toBe(en.usage.costTitleEstimate);
  });

  it('shows the CLI’s own figure with NO ~ and its own tooltip', () => {
    render({ model: 'claude-opus-5', cliCost: cli() });
    expect(costSpan().textContent).toBe('$42.50');
    expect(costSpan().getAttribute('title')).toBe(en.usage.costTitleCli);
  });

  it('shows ≥ and the floor tooltip when the CLI could not price a model', () => {
    render({ model: 'claude-opus-5', cliCost: cli({ hasUnknownModelCost: true }) });
    expect(costSpan().textContent).toBe('≥$42.50');
    expect(costSpan().getAttribute('title')).toBe(en.usage.costTitleCliFloor);
  });

  it('the three tooltips are genuinely three different strings', () => {
    // Guards the swap #785 shipped: three `t()` calls pointing at two keys, or
    // at each other's, would pass every assertion above that only checks the
    // number. This is the assertion that cannot.
    const titles = new Set([
      en.usage.costTitleEstimate,
      en.usage.costTitleCli,
      en.usage.costTitleCliFloor,
    ]);
    expect(titles.size).toBe(3);
    for (const s of titles) expect(s.length).toBeGreaterThan(20);
  });

  it('never renders a raw interpolation brace', () => {
    // `usage.cost` lost its `~` in #787 and became a bare `{cost}`. A key in the
    // wrong dialect renders its braces verbatim to the user (see test-i18n.ts);
    // the number assertions above would still pass on `{cost}` if the strip
    // fell back to the key.
    render({ model: 'claude-opus-5', cliCost: cli() });
    expect(host.textContent).not.toMatch(/[{}]/);
  });

  it('renders the tokens beside the cost, so the exact signal is not lost', () => {
    render({ model: 'claude-opus-5', cliCost: cli() });
    expect(host.textContent).toContain('1.00M');
  });
});

describe('UsageStrip thinking breakdown (#789)', () => {
  const THINKING: Usage = { input: 0, output: 4200, cacheRead: 0, cacheCreate: 0, thinking: 2900 };

  /** The output `<span>`, found by its own tooltip against the real catalogue. */
  function outputSpan(): HTMLElement {
    const found = host.querySelector<HTMLElement>(`span[title="${en.usage.outputTitle}"]`);
    expect(found, 'no output span rendered').toBeTruthy();
    return found!;
  }

  it('shows the thinking figure INSIDE the output span, with the output number unchanged', () => {
    render({ usage: THINKING });
    // `4.2k`, not `7.1k`: the breakdown is a part of output and must not be
    // added to the figure it breaks down.
    expect(outputSpan().textContent).toBe('↓ 4.2k (2.9k thinking)');
  });

  it('tooltips the share as a percentage, from the real en.json', () => {
    render({ usage: THINKING });
    const inner = outputSpan().querySelector<HTMLElement>('span[title]');
    expect(inner).toBeTruthy();
    expect(inner!.getAttribute('title')).toBe(en.usage.thinkingTitle.replace('{pct}', '69'));
    expect(inner!.getAttribute('style')).toContain('var(--faint)');
  });

  it('shows nothing extra for a session with no thinking recorded', () => {
    render({ usage: { input: 0, output: 4200, cacheRead: 0, cacheCreate: 0 } });
    expect(outputSpan().textContent).toBe('↓ 4.2k');
  });

  it('shows nothing extra when a persisted record claims more thinking than output', () => {
    render({ usage: { ...THINKING, thinking: 5000 } });
    expect(outputSpan().textContent).toBe('↓ 4.2k');
  });
});
