// @vitest-environment jsdom
// "Hand this session's context to…" (#851) — the picker that lets a keyboard
// start §5.5's hand-off.
//
// What only a rendered picker can answer: that every target is a real button
// (§5.32 rule 1), that focus lands on the first one so Enter works at once,
// that the arrows move between them, and that Escape, Cancel and the scrim all
// pick nothing.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { ContextHandoffPicker, type HandoffTarget } from './ContextHandoffPicker';
import { initI18nForTests } from '../i18n/test-i18n';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;
let cancelled: number;
let chosen: string[];

const TARGETS: HandoffTarget[] = [
  { id: 'card-b', title: 'beta', folder: 'C:/work/beta' },
  { id: 'card-c', title: 'gamma' },
];

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  cancelled = 0;
  chosen = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

let fallback: HTMLElement | null = null;

async function mount(targets: HandoffTarget[] = TARGETS): Promise<void> {
  await act(async () => {
    root.render(
      <ContextHandoffPicker
        fromName="alpha"
        targets={targets}
        onCancel={() => {
          cancelled++;
        }}
        onChoose={(id) => chosen.push(id)}
        fallbackFocus={() => fallback}
      />
    );
  });
}

const dialog = (): HTMLElement => host.querySelector('[data-testid="context-handoff-picker"]')!;
const target = (id: string): HTMLElement => host.querySelector(`[data-handoff-target="${id}"]`)!;
const key = async (k: string): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? dialog()).dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
    );
  });
};

describe('the picker', () => {
  it('is a labelled dialog naming the session whose context it hands over', async () => {
    await mount();
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect(dialog().getAttribute('aria-label')).toContain('alpha');
  });

  it('offers each target as a real button, in the order given, with its folder', async () => {
    await mount();
    const buttons = [...host.querySelectorAll('[data-handoff-target]')];
    expect(buttons.map((b) => b.getAttribute('data-handoff-target'))).toEqual(['card-b', 'card-c']);
    expect(buttons.every((b) => b.tagName === 'BUTTON')).toBe(true);
    expect(target('card-b').textContent).toContain('C:/work/beta');
  });

  it('puts focus on the first target, so Enter picks straight away', async () => {
    await mount();
    expect(document.activeElement).toBe(target('card-b'));
  });

  it('the arrows move between targets, wrapping', async () => {
    await mount();
    await key('ArrowDown');
    expect(document.activeElement).toBe(target('card-c'));
    await key('ArrowDown');
    expect(document.activeElement).toBe(target('card-b'));
    await key('ArrowUp');
    expect(document.activeElement).toBe(target('card-c'));
  });

  it('choosing a target says which — and nothing else', async () => {
    await mount();
    await act(async () => {
      target('card-c').click();
    });
    expect(chosen).toEqual(['card-c']);
    expect(cancelled).toBe(0);
  });

  it('Escape picks nothing', async () => {
    await mount();
    await key('Escape');
    expect(cancelled).toBe(1);
    expect(chosen).toEqual([]);
  });

  it('Cancel and a click on the scrim pick nothing', async () => {
    await mount();
    await act(async () => {
      (host.querySelector('[data-handoff-cancel]') as HTMLElement).click();
    });
    await act(async () => {
      dialog().parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(cancelled).toBe(2);
    expect(chosen).toEqual([]);
  });

  it('Escape gives focus BACK to what had it', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    await mount();
    await key('Escape');
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('…or to the card’s chip when that is gone — the palette’s input unmounts', async () => {
    const opener = document.createElement('input');
    document.body.appendChild(opener);
    opener.focus();
    fallback = document.createElement('button');
    document.body.appendChild(fallback);
    await mount();
    opener.remove(); // the palette closed when its command ran
    await key('Escape');
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(document.activeElement).toBe(fallback);
    fallback.remove();
    fallback = null;
  });

  it('says so when there is no one to hand it to, and focuses the dialog itself', async () => {
    await mount([]);
    expect(host.querySelector('[data-handoff-target]')).toBeNull();
    expect(dialog().textContent).toContain('no other session');
    expect(document.activeElement).toBe(dialog());
  });
});
