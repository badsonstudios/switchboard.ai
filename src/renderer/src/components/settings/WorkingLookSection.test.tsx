// @vitest-environment jsdom
// Settings ▸ Appearance ▸ "How a working session looks" (#718), and what a row,
// a pill and the status mark have to carry for a look to find them.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../../i18n/test-i18n';
import { WorkingLookSection } from './WorkingLookSection';
import { StatusMark } from '../StatusMark';
import { WORKING_LOOKS, type WorkingLook } from '../../lib/working-look';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
let picked: WorkingLook[] = [];

async function mount(look: WorkingLook = 'fill'): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<WorkingLookSection look={look} onSet={(l) => picked.push(l)} />);
  });
}

const radios = (): HTMLInputElement[] =>
  Array.from(host.querySelectorAll<HTMLInputElement>('[data-working-look-choice]'));

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  picked = [];
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the setting (issue 718)', () => {
  it('offers the six, numbered the way the owner saw them', async () => {
    await mount();
    expect(radios().map((r) => r.dataset.workingLookChoice)).toEqual([...WORKING_LOOKS]);
    const names = radios().map(
      (r) => document.getElementById(r.getAttribute('aria-labelledby')!)!.textContent
    );
    expect(names[0]).toBe('1. Breathing glow');
    expect(names[2]).toBe('3. Brighter, with a bigger spinner');
    expect(names[5]).toBe('6. Dancing bars');
  });

  it('ticks the one in force, and only that one', async () => {
    await mount('shimmer');
    expect(radios().filter((r) => r.checked).map((r) => r.dataset.workingLookChoice)).toEqual([
      'shimmer',
    ]);
  });

  it('a click asks for that look', async () => {
    await mount('fill');
    await act(async () => radios()[1].click());
    expect(picked).toEqual(['marquee']);
  });

  it('is one named group, and each choice has a description', async () => {
    await mount();
    const group = host.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-label')).toBe('How a working session looks');
    for (const r of radios()) {
      const note = document.getElementById(r.getAttribute('aria-describedby')!);
      expect(note?.textContent).toBeTruthy();
    }
  });

  it('⭐ each sample is a working pill inside ITS OWN look, so the real rules paint it', async () => {
    await mount();
    for (const look of WORKING_LOOKS) {
      const sample = host.querySelector<HTMLElement>(
        `[data-working-look="${look}"] [data-strip-pill][data-session-status="working"]`
      );
      expect(sample, look).not.toBeNull();
      // everything a look restyles is there to be found
      expect(sample!.style.getPropertyValue('--work-accent')).toBeTruthy();
      expect(sample!.querySelector('[data-accent-bar]')).not.toBeNull();
      expect(sample!.querySelector('.status-ring')).not.toBeNull();
      expect(sample!.querySelectorAll('.status-bars i')).toHaveLength(4);
      // and it is never mistaken for a session that needs you
      expect(sample!.dataset.needsYou).toBe('false');
    }
  });

  it('the samples are decoration: the words carry it', async () => {
    await mount();
    for (const wrap of Array.from(host.querySelectorAll('[data-working-look]'))) {
      expect(wrap.getAttribute('aria-hidden')).not.toBeNull();
    }
  });
});

describe('the status mark, which two of the looks restyle', () => {
  async function mark(status: string): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<StatusMark status={status} needsYou={false} />);
    });
    return host;
  }

  it('a working session has the ring AND the four bars, for the stylesheet to choose between', async () => {
    const h = await mark('working');
    expect(h.querySelector('.status-ring')).not.toBeNull();
    expect(h.querySelectorAll('.status-bars i')).toHaveLength(4);
    // both are decoration: the row's accessible name says "working"
    expect(h.querySelector('.status-ring')!.getAttribute('aria-hidden')).not.toBeNull();
    expect(h.querySelector('.status-bars')!.getAttribute('aria-hidden')).not.toBeNull();
  });

  it('a session that is not working has neither', async () => {
    const h = await mark('idle');
    expect(h.querySelector('.status-ring')).toBeNull();
    expect(h.querySelector('.status-bars')).toBeNull();
  });
});
