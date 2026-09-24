// @vitest-environment jsdom
// #704 — a turn the harness injected, rendered as a row instead of a prompt.
//
// Through the REAL registry, like the attachments and a11y suites beside it,
// because the defect this guards is a whole-pipeline one: the block could carry
// a perfect `notice` payload and still reach the screen as raw XML if the
// contribution were not registered, or if the user pill claimed it first. The
// derivation half is pinned in `main/feed/blocks.test.ts`.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';
import { renderFeedBlock, resolveFeedBlock } from './feed-render';
import { FeedBlockDto } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();

const RAW = `<task-notification>
<task-id>bvhh1kfa7</task-id>
<summary>Monitor event: "CI matrix result for PR #36"</summary>
<event>ubuntu-latest: pass</event>
If this event is something the user would act on now, send a PushNotification.
</task-notification>`;

const NOTICE: FeedBlockDto = {
  seq: 1,
  kind: 'notice',
  sidechain: false,
  notice: {
    source: 'task-notification',
    summary: 'Monitor event: "CI matrix result for PR #36"',
    status: 'event',
    raw: RAW,
    taskId: 'bvhh1kfa7',
  },
};

function draw(b: FeedBlockDto): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(renderFeedBlock(registry, b));
  });
  return host;
}

const expander = (host: HTMLElement): HTMLElement =>
  host.querySelector<HTMLElement>('[data-feed-expander]') as HTMLElement;

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

describe('a background-task notification is a row, not a prompt', () => {
  // THE BUG, stated as an assertion. `feed-block-user` sorts after this one and
  // matches `kind === 'user'`; if the notice ever went back to being a user
  // block, or this contribution were dropped, the pill would claim it again.
  it('is claimed by the notice renderer, not the user pill', () => {
    expect(resolveFeedBlock(registry, NOTICE).id).toBe('feed-block-notice');
  });

  it('shows the summary and the kind of thing it is, collapsed', () => {
    const host = draw(NOTICE);
    const text = expander(host).textContent ?? '';
    expect(text).toContain('Background task');
    expect(text).toContain('Monitor event: "CI matrix result for PR #36"');
    // The raw XML is nowhere on screen until it is asked for — the whole ask.
    expect(host.textContent).not.toContain('<task-notification>');
  });

  // The harness's instruction is addressed to the MODEL. In the row it would
  // read as the app telling its user to go and do something.
  it('keeps the instruction to the model out of the collapsed row', () => {
    expect(draw(NOTICE).textContent).not.toContain('PushNotification');
  });

  it('expands to the whole payload, instruction and ids included', () => {
    const host = draw(NOTICE);
    const button = expander(host);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      button.click();
    });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const pre = host.querySelector('pre');
    expect(pre?.textContent).toBe(RAW);
    expect(pre?.textContent).toContain('send a PushNotification');
    // the expander names the region it controls, and that region exists
    expect(button.getAttribute('aria-controls')).toBe(pre?.id);
  });

  it('marks a failure so it can be told from an ordinary ending', () => {
    const host = draw({
      ...NOTICE,
      notice: { ...NOTICE.notice!, status: 'failed', summary: 'Background command failed' },
    });
    const chip = host.querySelector<HTMLElement>('[data-notice-status]');
    expect(chip?.getAttribute('data-notice-status')).toBe('failed');
    expect(chip?.textContent).toBe('failed');
    expect(chip?.style.color).toBe('var(--status-crashed-ink)');
  });

  // The CLI's task enums carry `stopped`, `killed` and `paused` as well as the
  // two in the fixture. A killed task is not a failure, but it is not the quiet
  // "it finished" the faint ink promises either — and the row is the only place
  // that is ever said.
  it('colours `killed` like a failure and `completed` like an ending', () => {
    const colourOf = (status: string): string => {
      const host = draw({ ...NOTICE, notice: { ...NOTICE.notice!, status } });
      return host.querySelector<HTMLElement>('[data-notice-status]')?.style.color ?? '';
    };
    expect(colourOf('killed')).toBe('var(--status-crashed-ink)');
    expect(colourOf('completed')).toBe('var(--faint)');
    expect(colourOf('paused')).toBe('var(--faint)');
  });

  // A status the CLI grows tomorrow is still the truest thing we have to show.
  // Blanking the chip because there was no translation for it would lose the
  // one field that says whether the thing worked.
  it('shows an unknown status verbatim rather than dropping it', () => {
    const host = draw({
      ...NOTICE,
      notice: { ...NOTICE.notice!, status: 'abducted' },
    });
    expect(host.querySelector<HTMLElement>('[data-notice-status]')?.textContent).toBe('abducted');
  });

  it('renders a notice with no status at all', () => {
    // Built rather than destructured-minus-`status`: an absent key and an
    // `undefined` one are different objects, and absent is the shape the
    // derivation produces.
    const { source, summary, raw, taskId } = NOTICE.notice!;
    const host = draw({ ...NOTICE, notice: { source, summary, raw, taskId } });
    expect(host.querySelector('[data-notice-status]')).toBeNull();
    expect(host.textContent).toContain('Monitor event');
  });
});
