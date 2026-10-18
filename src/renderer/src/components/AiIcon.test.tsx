// @vitest-environment jsdom
// One AI's icon, in that AI's colour (#1326).
//
// What the icon promises, read off the real DOM:
//   - the shape is the catalog's file, as a MASK, and the colour is the look's
//     ink (an <img> of a currentColor SVG cannot take a colour: it drew black);
//   - an AI with no ink is drawn in --text, never in nothing;
//   - fail-open: a file that does not load is the initial tile, and a NEW file
//     for the same AI gets a fresh try.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { AiIcon, resetAiIconChecksForTests } from './AiIcon';
import type { AiLook } from '../lib/ais-store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const probes: Array<{ src: string; crossOrigin: string | null; onerror: (() => void) | null }> = [];
const RealImage = globalThis.Image;

async function render(look: AiLook, size = 12): Promise<HTMLElement> {
  await act(async () => root!.render(<AiIcon look={look} size={size} />));
  return host.querySelector<HTMLElement>('.ai-icon')!;
}

/** fail the check AiIcon made for this URL, as a 404 would */
async function failLoad(url: string): Promise<void> {
  const probe = probes.filter((p) => p.src === url).pop();
  expect(probe, `AiIcon checked ${url}`).toBeDefined();
  await act(async () => {
    probe!.onerror?.();
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  probes.length = 0;
  resetAiIconChecksForTests();
  globalThis.Image = class {
    src = '';
    crossOrigin: string | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      probes.push(this);
    }
  } as unknown as typeof Image;
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  globalThis.Image = RealImage;
});

const CLAUDE: AiLook = {
  name: 'Claude Code',
  iconUrl: 'http://app.test/ai-icons/claude-code.svg',
  initial: 'C',
  ink: 'var(--ai-claude-code-ink, var(--text))',
};

describe('AiIcon (#1326)', () => {
  it("is a mask of the AI's file, painted in its ink", async () => {
    const icon = await render(CLAUDE);
    expect(icon.tagName).toBe('SPAN');
    expect(icon.getAttribute('data-ai-icon')).toBe('mask');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.style.maskImage).toBe('url("http://app.test/ai-icons/claude-code.svg")');
    expect(icon.style.backgroundColor).toBe('var(--ai-claude-code-ink, var(--text))');
    expect(icon.style.inlineSize).toBe('12px');
    // a tab's textContent is its session's name: the icon adds nothing to it
    expect(host.textContent).toBe('');
  });

  it('checks the file once, the way the mask fetches it (CORS), however many icons draw it', async () => {
    await act(async () =>
      root!.render(
        <>
          <AiIcon look={CLAUDE} size={12} />
          <AiIcon look={CLAUDE} size={16} />
        </>
      )
    );
    expect(host.querySelectorAll('[data-ai-icon="mask"]')).toHaveLength(2);
    const asked = probes.filter((p) => p.src === CLAUDE.iconUrl);
    expect(asked).toHaveLength(1);
    expect(asked[0].crossOrigin).toBe('anonymous');
  });

  it('is drawn in --text when the look has no ink', async () => {
    const icon = await render({ name: 'X', iconUrl: 'http://app.test/ai-icons/x.svg', initial: 'X' });
    expect(icon.style.backgroundColor).toBe('var(--text)');
  });

  it('is the initial tile when there is no file', async () => {
    const icon = await render({ name: 'Fake ACP', initial: 'F' });
    expect(icon.getAttribute('data-ai-icon')).toBe('initial');
    expect(icon.getAttribute('data-initial')).toBe('F');
    expect(probes).toHaveLength(0);
  });

  it('falls back to the initial when the file does not load, and tries a new file again', async () => {
    await render(CLAUDE);
    await failLoad(CLAUDE.iconUrl!);
    expect(host.querySelector('[data-ai-icon="initial"]')!.getAttribute('data-initial')).toBe('C');
    // the list names a different file for this AI: a fresh try, not a memory
    const next = { ...CLAUDE, iconUrl: 'http://app.test/ai-icons/claude-code-2.svg' };
    const icon = await render(next);
    expect(icon.getAttribute('data-ai-icon')).toBe('mask');
    expect(probes.some((p) => p.src === next.iconUrl)).toBe(true);
  });

  it('keeps drawing when there is no Image() to check with', async () => {
    globalThis.Image = class {
      constructor() {
        throw new Error('no images here');
      }
    } as unknown as typeof Image;
    const icon = await render(CLAUDE);
    expect(icon.getAttribute('data-ai-icon')).toBe('mask');
  });
});
