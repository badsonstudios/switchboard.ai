// @vitest-environment jsdom
// The AI's icon in its status ring (E40 item 10, #1293).
//
// What the badge promises, each read off the real DOM:
//   - which AI: the catalog's icon for the provider, named in `aria-label`;
//   - what it is doing: the ring is painted by `attentionPaint`, exactly the
//     rule the status glyph it replaced used, and in the per-theme INK;
//   - the working spinner carries over where the mark spun, and stands still
//     where it never did (`spin={false}`, the tab and the header);
//   - fail-open: no list, an AI with no icon, or an icon that fails to load is
//     the neutral glyph — never a missing ring or a missing name.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { AiBadge } from './AiBadge';
import { resetAiIconChecksForTests } from './AiIcon';
import { resetAisStoreForTests, aiLook, getAisState, subscribeAis, type AisState } from '../lib/ais-store';
import type { AiListItem, AisSnapshot, CatalogEntry } from '../../../shared/ais';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const claudeEntry: CatalogEntry = {
  id: 'claude-code',
  name: 'Claude Code',
  maker: 'Anthropic',
  description: '',
  engine: 'native',
  install: { kind: 'link', url: 'https://example.invalid' },
  detectCommand: 'claude',
  runsLocalModels: false,
  icon: 'claude-code.svg',
  providerId: 'claude-code',
};

const ITEMS: AiListItem[] = [
  { kind: 'catalog', entry: claudeEntry, providerId: 'claude-code', registered: true },
  { kind: 'provider', entry: { id: 'fake-acp', name: 'Fake ACP' }, providerId: 'fake-acp', registered: true },
];

const WITH_LIST: AisState = { items: ITEMS, defaultId: 'claude-code' };

let root: Root | null = null;
let host: HTMLElement;

async function render(el: React.JSX.Element): Promise<HTMLElement> {
  await act(async () => root!.render(el));
  return host.querySelector<HTMLElement>('.ai-badge')!;
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetAiIconChecksForTests();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await initI18nForTests();
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  resetAisStoreForTests();
  delete (globalThis as { switchboard?: unknown }).switchboard;
});

describe('the AI badge (#1293)', () => {
  it("draws the catalog's icon for the provider, and names AI and status", async () => {
    resetAisStoreForTests(WITH_LIST);
    const badge = await render(<AiBadge providerId="claude-code" status="idle" needsYou={false} />);
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe('Claude Code, calm');
    expect(badge.getAttribute('title')).toBe('Claude Code, calm');
    // a MASK of the catalog's file, painted in Claude's own ink (#1326): an
    // <img> of a currentColor SVG cannot inherit a colour and drew black
    expect(badge.querySelector('img')).toBeNull();
    const icon = badge.querySelector<HTMLElement>('[data-ai-icon="mask"]')!;
    expect(icon.getAttribute('data-ai-icon-src')).toMatch(/ai-icons\/claude-code\.svg$/);
    expect(icon.style.maskImage).toMatch(/^url\(".*ai-icons\/claude-code\.svg"\)$/);
    expect(icon.style.backgroundColor).toBe('var(--ai-claude-code-ink, var(--text))');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves a clear gap between the ring and the icon inside it', async () => {
    // every AI colour sits near some ramp position (Claude's coral and the
    // needs-permission orange, Codex and done, Gemini and working), so the
    // two are kept apart by space rather than by hue: the icon is smaller than
    // the ring's inside by at least a pixel each side
    resetAisStoreForTests(WITH_LIST);
    const badge = await render(<AiBadge providerId="claude-code" status="working" needsYou={false} />);
    const icon = badge.querySelector<HTMLElement>('.ai-icon')!;
    const ring = badge.querySelector<HTMLElement>('.status-ring')!;
    const ringWidth = parseFloat(ring.style.border);
    const inside = parseFloat(ring.style.inlineSize) - 2 * ringWidth;
    expect((inside - parseFloat(icon.style.inlineSize)) / 2).toBeGreaterThanOrEqual(1);
  });

  it('paints the ring by the same rule the status glyph used, in the status INK', async () => {
    resetAisStoreForTests(WITH_LIST);
    // needs-permission, counted: the needs-permission ramp
    let badge = await render(<AiBadge providerId="claude-code" status="needs-permission" needsYou />);
    expect(badge.getAttribute('data-ring')).toBe('needs-permission');
    const ring = badge.querySelector<HTMLElement>('[data-ai-ring]')!;
    expect(ring.style.border).toContain('var(--status-needs-permission-ink)');
    // counted but not itself a needs-you status (a working session with an
    // outstanding event): `attentionPaint` lights it in the `waiting` ramp
    // (`done` until #1351), and the ring follows the rule, not the raw status
    badge = await render(<AiBadge providerId="claude-code" status="working" needsYou />);
    expect(badge.getAttribute('data-ring')).toBe('waiting');
    // a finished turn nobody is counting any more is still WAITING (#1351):
    // the gold ring, not the green one
    badge = await render(<AiBadge providerId="claude-code" status="done" needsYou={false} />);
    expect(badge.getAttribute('data-ring')).toBe('waiting');
    // not counted: the status's own ramp
    badge = await render(<AiBadge providerId="claude-code" status="crashed" needsYou={false} />);
    expect(badge.getAttribute('data-ring')).toBe('crashed');
  });

  it('spins while busy where the mark always spun, and carries the look-6 bars beside it', async () => {
    resetAisStoreForTests(WITH_LIST);
    const badge = await render(<AiBadge providerId="claude-code" status="working" needsYou={false} />);
    expect(badge.getAttribute('data-ring-spin')).toBe('true');
    const ring = badge.querySelector<HTMLElement>('.status-ring')!;
    expect(ring.style.animation).toContain('sb-spin');
    expect(host.querySelector('.status-bars')).not.toBeNull();
  });

  it('stands still on the surfaces whose mark never moved (spin={false})', async () => {
    resetAisStoreForTests(WITH_LIST);
    const badge = await render(<AiBadge providerId="claude-code" status="working" needsYou={false} spin={false} />);
    expect(badge.getAttribute('data-ring-spin')).toBe('false');
    expect(badge.querySelector('.status-ring')).toBeNull();
    expect(host.querySelector('.status-bars')).toBeNull();
    // the ring is still there, in the working ink
    expect(badge.querySelector<HTMLElement>('[data-ai-ring]')!.style.border).toContain(
      'var(--status-working-ink)'
    );
  });

  it('draws the initial for an AI with no icon, as CSS and not as text', async () => {
    resetAisStoreForTests(WITH_LIST);
    const badge = await render(<AiBadge providerId="fake-acp" status="idle" needsYou={false} />);
    expect(badge.getAttribute('aria-label')).toBe('Fake ACP, calm');
    const glyph = badge.querySelector<HTMLElement>('[data-ai-icon="initial"]')!;
    expect(glyph.getAttribute('data-initial')).toBe('F');
    // a tab's or a row's textContent is the session's name; the badge adds none
    expect(host.textContent).toBe('');
  });

  it('falls back to the initial when the icon fails to load', async () => {
    resetAisStoreForTests(WITH_LIST);
    // a mask whose file fails paints nothing and fires nothing, so AiIcon
    // checks the URL through an Image() beside it: fail THAT one
    const probes: Array<{ src: string; onerror: (() => void) | null }> = [];
    const RealImage = globalThis.Image;
    globalThis.Image = class {
      src = '';
      onerror: (() => void) | null = null;
      constructor() {
        probes.push(this);
      }
    } as unknown as typeof Image;
    try {
      const badge = await render(<AiBadge providerId="claude-code" status="idle" needsYou={false} />);
      expect(badge.querySelector('[data-ai-icon="mask"]')).not.toBeNull();
      const probe = probes.find((p) => /claude-code\.svg$/.test(p.src))!;
      await act(async () => {
        probe.onerror?.();
      });
      expect(badge.querySelector('[data-ai-icon="mask"]')).toBeNull();
      expect(badge.querySelector('[data-ai-icon="initial"]')!.getAttribute('data-initial')).toBe('C');
    } finally {
      globalThis.Image = RealImage;
    }
  });

  it('keeps the ring and the words with no list at all (no bridge)', async () => {
    const badge = await render(<AiBadge providerId="codex" status="needs-input" needsYou />);
    expect(badge.getAttribute('data-ring')).toBe('needs-input');
    // the provider id is the best name there is
    expect(badge.getAttribute('aria-label')).toBe('codex, question');
  });

  it('says "AI" for a card that has no provider yet', async () => {
    const badge = await render(<AiBadge status="suspended" needsYou={false} />);
    expect(badge.getAttribute('aria-label')).toBe('AI, suspended');
  });
});

describe('the AIs cache (lib/ais-store)', () => {
  function stubBridge(over: Partial<{ list: () => Promise<unknown>; default: () => Promise<unknown> }> = {}) {
    let push: ((snap: AisSnapshot) => void) | null = null;
    (globalThis as { switchboard?: unknown }).switchboard = {
      ais: {
        list: over.list ?? (() => Promise.resolve(ITEMS)),
        default: over.default ?? (() => Promise.resolve({ id: 'fake-acp', fellBack: false })),
        onChanged: (cb: (snap: AisSnapshot) => void) => {
          push = cb;
          return () => {};
        },
      },
    };
    return (snap: AisSnapshot) => push?.(snap);
  }

  it('reads the list and the default on first subscribe', async () => {
    stubBridge();
    const off = subscribeAis(() => {});
    await act(async () => {});
    expect(getAisState().items).toHaveLength(2);
    expect(getAisState().defaultId).toBe('fake-acp');
    off();
  });

  it('a push wins over a slower first answer', async () => {
    let answer!: (v: unknown) => void;
    const push = stubBridge({ list: () => new Promise((r) => (answer = r)) });
    const off = subscribeAis(() => {});
    push({ items: ITEMS.slice(0, 1), default: { id: 'claude-code', fellBack: false }, detecting: false });
    await act(async () => {}); // the list call goes out a microtask later
    answer(ITEMS);
    await act(async () => {});
    expect(getAisState().items).toHaveLength(1);
    expect(getAisState().defaultId).toBe('claude-code');
    off();
  });

  it('fails open: a rejected list leaves "no list", not an error', async () => {
    stubBridge({ list: () => Promise.reject(new Error('refused')) });
    const off = subscribeAis(() => {});
    await act(async () => {});
    expect(getAisState().items).toBeNull();
    off();
  });

  it('finds a catalog AI by its own id when no provider hosts it', () => {
    const state: AisState = {
      items: [{ kind: 'catalog', entry: { ...claudeEntry, id: 'gemini', name: 'Gemini CLI', providerId: undefined, icon: 'gemini.svg' }, registered: false }],
      defaultId: null,
    };
    expect(aiLook(state, 'gemini', 'AI').name).toBe('Gemini CLI');
  });

  it('prefers that catalog AI to a provider-only row of the same id (#1326)', () => {
    const gemini = { ...claudeEntry, id: 'gemini', name: 'Gemini CLI', providerId: undefined, icon: 'gemini.svg' };
    const state: AisState = {
      items: [
        { kind: 'catalog', entry: gemini, registered: false },
        { kind: 'provider', entry: { id: 'gemini', name: 'gemini (fake)' }, providerId: 'gemini', registered: true },
        { kind: 'provider', entry: { id: 'fake-acp', name: 'Fake ACP' }, providerId: 'fake-acp', registered: true },
      ],
      defaultId: null,
    };
    const look = aiLook(state, 'gemini', 'AI');
    expect(look.name).toBe('Gemini CLI');
    expect(look.iconUrl).toMatch(/ai-icons\/gemini\.svg$/);
    expect(look.ink).toBe('var(--ai-gemini-ink, var(--text))');
    // a provider the catalog has no entry for is still found by its id, uncoloured
    expect(aiLook(state, 'fake-acp', 'AI')).toMatchObject({ name: 'Fake ACP', ink: 'var(--text)' });
  });
});
