// @vitest-environment jsdom
// #1439 — "see what it was told" on an AI-switch divider follows the feed's
// keyboard rule (§5.32, #174): the conversation is ONE Tab stop and the arrow
// keys move between the controls inside it. The button used to be a plain
// `<button>`, so it took a Tab stop of its own and the arrow walk skipped it.
//
// Through the REAL registry, like the compaction suite beside it, so the
// divider is the one the Feed actually draws. The walk is resolved exactly as
// `FeedView` resolves it: `FEED_STOP_SELECTOR` read off the DOM, then
// `feedKeyAction` against the focused index.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';
import { renderFeedBlock } from './feed-render';
import type { FeedBlockDto } from '../lib/feed';
import type { AiSwitchMark } from '../../../shared/ai-switch';
import { FEED_STOP_SELECTOR, feedKeyAction } from '../lib/feed-keys';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();

const mark = (extra: Partial<AiSwitchMark>): AiSwitchMark => ({
  kind: 'ai-switch',
  id: 'sw-1',
  from: { providerId: 'claude', name: 'Claude' },
  to: { providerId: 'codex', name: 'Codex' },
  at: '2026-10-27T10:00:00.000Z',
  briefed: false,
  ...extra,
});

const briefed = mark({ briefed: true, turnsSummarised: 4, briefingRef: 'brief-1' });

const divider = (m: AiSwitchMark, seq = 2): FeedBlockDto => ({ seq, kind: 'ai-switch', sidechain: false, aiSwitch: m });
// a compaction divider whose summary main kept: its "Show summary" is a
// FeedExpander, the control issue 1374 already put on the walk
const compaction: FeedBlockDto = {
  seq: 1,
  kind: 'compaction',
  sidechain: false,
  compaction: { trigger: 'auto', summaryId: 'h-1' },
};

function draw(blocks: FeedBlockDto[]): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<>{blocks.map((b) => <React.Fragment key={b.seq}>{renderFeedBlock(registry, b)}</React.Fragment>)}</>);
  });
  return host;
}

/** One keystroke on the walk, applied the way FeedView applies it. */
function press(host: HTMLElement, key: string): void {
  const stops = Array.from(host.querySelectorAll<HTMLElement>(FEED_STOP_SELECTOR));
  const active = document.activeElement as HTMLElement | null;
  const action = feedKeyAction(key, { count: stops.length, current: active ? stops.indexOf(active) : -1 });
  if (action?.kind === 'move') stops[action.index]?.focus();
}

const seeBriefing = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-ai-switch-see-briefing]');

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

describe('"see what it was told" and the feed keyboard rule (#1439)', () => {
  it('is a stop on the arrow-key walk, and takes no Tab stop of its own', () => {
    const host = draw([divider(briefed)]);
    const button = seeBriefing(host)!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.matches(FEED_STOP_SELECTOR)).toBe(true);
    expect(button.getAttribute('tabindex')).toBe('-1');
    // it opens a dialog; it shows nothing in place, so it claims no expansion
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.hasAttribute('aria-expanded')).toBe(false);
  });

  it('the arrow keys reach it beside Show summary, in reading order', () => {
    const host = draw([compaction, divider(briefed)]);
    const showSummary = host.querySelector<HTMLElement>('[data-compaction-divider] button')!;
    const button = seeBriefing(host)!;
    expect(Array.from(host.querySelectorAll(FEED_STOP_SELECTOR))).toEqual([showSummary, button]);
    // focus starts on nothing in the walk (the region, in the real feed)
    press(host, 'ArrowDown');
    expect(document.activeElement).toBe(showSummary);
    press(host, 'ArrowDown');
    expect(document.activeElement).toBe(button);
    press(host, 'ArrowUp');
    expect(document.activeElement).toBe(showSummary);
    press(host, 'End');
    expect(document.activeElement).toBe(button);
  });

  it('a divider with no kept briefing adds no stop', () => {
    for (const m of [mark({}), mark({ briefed: true }), mark({ resumed: true })]) {
      document.body.innerHTML = '';
      const host = draw([divider(m)]);
      expect(seeBriefing(host)).toBeNull();
      expect(host.querySelectorAll(FEED_STOP_SELECTOR)).toHaveLength(0);
    }
  });
});

// #1323, the owner's call: each AI's icon beside its name in the divider. The
// sentence is one translation; the names are found by placeholder, so the
// words and their order are the translation's, and the label still says it all.
describe("the divider shows each AI's icon beside its name (#1323)", () => {
  it('puts an icon with each name, in the sentence order, and leaves the label whole', () => {
    const host = draw([divider(mark({}))]);
    const label = host.querySelector<HTMLElement>('[data-ai-switch-label]')!;
    const ais = Array.from(label.querySelectorAll<HTMLElement>('[data-ai-switch-ai]'));
    expect(ais).toHaveLength(2);
    expect(ais[0].textContent).toContain('Claude');
    expect(ais[1].textContent).toContain('Codex');
    // an icon in each: the shared AiIcon, its image or its initial tile
    for (const a of ais) expect(a.children.length).toBeGreaterThan(0);
    // the screen-reader sentence is unchanged, with no placeholder in it
    const aria = label.getAttribute('aria-label') ?? '';
    expect(aria).toMatch(/^Claude → Codex · /);
    expect(aria.includes(String.fromCharCode(1)) || aria.includes(String.fromCharCode(2))).toBe(false);
    expect(label.textContent?.includes(String.fromCharCode(1))).toBe(false);
  });
});
