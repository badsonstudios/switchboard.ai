// @vitest-environment jsdom
// The small picture beside a tool's name in the conversation (#757).
//
// Rendered through the real registry, the way FeedView does, so what is pinned
// is what each kind of tool block actually draws: the right picture, AFTER the
// name, hidden from a screen reader, in no colour of its own, and never absent.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';
import { renderFeedBlock } from './feed-render';
import { FEED_EXPANDER_ATTR } from '../lib/feed-keys';
import { FeedBlockDto } from '../lib/feed';
import { TOOL_ICONS } from '../../../shared/tool-icon';
import { ToolIcon } from '../components/ToolIcon';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();

function block(over: Partial<FeedBlockDto>): FeedBlockDto {
  return { seq: 1, kind: 'assistant', sidechain: false, ...over };
}

function draw(b: FeedBlockDto): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(renderFeedBlock(registry, b));
  });
  return host;
}

const tool = (name: string, more: Record<string, unknown> = {}): FeedBlockDto =>
  block({ kind: 'tool', tool: { name, summary: 'something', ...more } });

const icons = (host: HTMLElement): SVGElement[] =>
  Array.from(host.querySelectorAll<SVGElement>('svg[data-tool-icon]'));

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

describe('each kind of tool block carries its picture (issue 757)', () => {
  it.each([
    ['Task', 'agent'],
    ['AskUserQuestion', 'question'],
    ['Read', 'read'],
    ['Grep', 'search'],
    ['WebFetch', 'web'],
    ['mcp__switchboard__list_sessions', 'mcp'],
    ['SomeToolFromNextYear', 'other'],
  ])('the plain tool row for %s shows the "%s" picture', (name, kind) => {
    const host = draw(tool(name));
    expect(icons(host).map((i) => i.dataset.toolIcon)).toEqual([kind]);
  });

  it('the shell block: one picture for Bash and for PowerShell', () => {
    for (const name of ['Bash', 'PowerShell']) {
      document.body.innerHTML = '';
      const host = draw(tool(name, { category: 'shell', description: 'Say hi', out: 'hi' }));
      expect(icons(host).map((i) => i.dataset.toolIcon)).toEqual(['shell']);
    }
  });

  it('the edit block', () => {
    const host = draw(tool('Edit', { filePath: 'a.ts', oldString: 'OLD', newString: 'NEW' }));
    expect(icons(host).map((i) => i.dataset.toolIcon)).toEqual(['edit']);
  });

  it('the checklist block, which has no tool name of its own', () => {
    const host = draw(block({ kind: 'todos', todos: [{ content: 'step one', status: 'completed' }] }));
    expect(icons(host).map((i) => i.dataset.toolIcon)).toEqual(['todos']);
  });

  it('⚠️ no tool block is ever left without one', () => {
    for (const b of [tool('Read'), tool('Bash', { category: 'shell' }), tool('Edit', { filePath: 'a' }), tool('x')]) {
      document.body.innerHTML = '';
      expect(icons(draw(b))).toHaveLength(1);
    }
  });

  it('a prose block has none: the picture means "a tool"', () => {
    expect(icons(draw(block({ kind: 'assistant', text: 'hello' })))).toHaveLength(0);
    expect(icons(draw(block({ kind: 'user', text: 'do the thing' })))).toHaveLength(0);
  });
});

describe('where it sits and what it claims', () => {
  it('AFTER the name, as the owner asked', () => {
    const host = draw(tool('Read'));
    const icon = icons(host)[0];
    const name = Array.from(host.querySelectorAll('span')).find(
      (s) => s.children.length === 0 && s.textContent === 'Read'
    )!;
    expect(name.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is hidden from a screen reader and takes no focus: the name is still the name', () => {
    const host = draw(tool('Read', { detail: '{"file_path":"a.md"}' }));
    const icon = icons(host)[0];
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('focusable')).toBe('false');
    // the picture adds NO text: what the name's element reads as is the name
    expect(icon.textContent).toBe('');
    expect(icon.parentElement!.textContent).toBe('Read');
    const expander = host.querySelector<HTMLElement>(`[${FEED_EXPANDER_ATTR}]`)!;
    expect(expander.textContent).toContain('Read');
    expect(expander.textContent).toContain('something');
  });

  it('⚠️ the name stays the ONLY child of its own element, so find-in-conversation can still mark it', () => {
    // `lib/feed-marks.ts` only paints a match on a text node that is its
    // parent's only child. With the picture as a sibling of the bare text,
    // searching for a tool name counted it and highlighted nothing.
    const blocks = [
      tool('Read'),
      tool('Bash', { category: 'shell' }),
      tool('Edit', { filePath: 'a.ts', oldString: 'O', newString: 'N' }),
      block({ kind: 'todos', todos: [{ content: 'step one', status: 'completed' }] }),
    ];
    for (const b of blocks) {
      document.body.innerHTML = '';
      const icon = icons(draw(b))[0];
      const nameSpan = icon.previousElementSibling!;
      expect(nameSpan.childNodes).toHaveLength(1);
      expect(nameSpan.firstChild!.nodeType).toBe(Node.TEXT_NODE);
      // and the two stay on one line however narrow the row gets
      expect((icon.parentElement as HTMLElement).style.whiteSpace).toBe('nowrap');
    }
  });

  it('has no colour of its own: it is drawn in the ink of the name beside it', () => {
    const host = draw(tool('Read'));
    const icon = icons(host)[0];
    expect(icon.getAttribute('stroke')).toBe('currentColor');
    expect(icon.getAttribute('fill')).toBe('none');
    expect(icon.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
});

describe('the ten pictures', () => {
  it('every kind has one, and no two are the same drawing', () => {
    const drawings = TOOL_ICONS.map((kind) => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      act(() => createRoot(host).render(<ToolIcon kind={kind} />));
      const svg = host.querySelector('svg')!;
      expect(svg.dataset.toolIcon).toBe(kind);
      expect(svg.children.length).toBeGreaterThan(0);
      return svg.innerHTML;
    });
    expect(new Set(drawings).size).toBe(TOOL_ICONS.length);
  });

  it('given a raw name instead of a kind, it classifies it the one shared way', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => createRoot(host).render(<ToolIcon name="PowerShell" />));
    expect(host.querySelector('svg')!.dataset.toolIcon).toBe('shell');
  });
});
