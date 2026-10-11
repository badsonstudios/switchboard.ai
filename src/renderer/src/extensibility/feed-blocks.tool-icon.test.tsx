// @vitest-environment jsdom
// The pictures are in the timeline gutter now, and NOT in the boxes (#1207).
//
// #757 drew a small picture after each tool's name, inside its box. The owner
// approved a mock that moves it: the picture replaces the grey dot in the
// gutter, and the box goes back to the name and its subject.
//
// Two halves, tested where each lives: the BOXES carry no picture (here, through
// the real registry, the way FeedView draws them), and the GUTTER mark draws the
// right thing for each kind of row (`GutterMark`, below). Which block gets which
// kind is `shared/tool-icon.test.ts`; that they are really painted, in a real
// conversation, is `e2e/tool-icons.spec.ts`.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';
import { renderFeedBlock } from './feed-render';
import { FeedBlockDto } from '../lib/feed';
import { TOOL_ICONS } from '../../../shared/tool-icon';
import { GUTTER_ICON_PX, GutterMark, ToolIcon } from '../components/ToolIcon';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();

function block(over: Partial<FeedBlockDto>): FeedBlockDto {
  return { seq: 1, kind: 'assistant', sidechain: false, ...over };
}

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  return host;
}
const draw = (b: FeedBlockDto): HTMLElement => mount(renderFeedBlock(registry, b));

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

describe('the boxes carry no picture any more (#1207)', () => {
  it.each([
    ['a plain tool row', tool('Read', { detail: '{"file_path":"a.md"}' })],
    ['an agent', tool('Task')],
    ['a tool nobody recognises', tool('SomeToolFromNextYear')],
    ['the shell block', tool('Bash', { category: 'shell', description: 'Say hi', out: 'hi' })],
    ['the edit block', tool('Edit', { filePath: 'a.ts', oldString: 'OLD', newString: 'NEW' })],
    ['the checklist', block({ kind: 'todos', todos: [{ content: 'one', status: 'completed' }] })],
    [
      'a question read back',
      tool('AskUserQuestion', {
        questions: [{ question: 'Which?', options: [{ label: 'A' }], multiSelect: false }],
      }),
    ],
  ])('%s: the name and its subject, nothing drawn', (_what, b) => {
    expect(icons(draw(b))).toHaveLength(0);
  });

  it('⚠️ the name is still the ONLY child of its own element, so find can mark it', () => {
    // `lib/feed-marks.ts` only paints a match on a text node that is its
    // parent's only child. Taking the picture out must not have disturbed that.
    for (const [b, name] of [
      [tool('Read'), 'Read'],
      [tool('Bash', { category: 'shell' }), 'Bash'],
      [tool('Edit', { filePath: 'a.ts', oldString: 'O', newString: 'N' }), 'Edit'],
    ] as const) {
      document.body.innerHTML = '';
      const host = draw(b);
      const span = Array.from(host.querySelectorAll('span')).find(
        (s) => s.children.length === 0 && s.textContent === name
      );
      expect(span, name).toBeDefined();
      expect(span!.childNodes).toHaveLength(1);
    }
  });
});

describe('the gutter mark (#1207)', () => {
  const mark = (host: HTMLElement): HTMLElement => host.firstElementChild as HTMLElement;

  it('a picture, when the row has a kind', () => {
    const host = mount(<GutterMark icon="git" dot />);
    expect(mark(host).dataset.feedGlyph).toBe('git');
    expect(icons(host).map((i) => i.dataset.toolIcon)).toEqual(['git']);
    // no dot drawn behind the picture
    expect(mark(host).style.background).toBe('');
    expect(mark(host).hasAttribute('data-feed-dot')).toBe(false);
  });

  it('the plain dot, when it has none: an unrecognised tool is never a placeholder shape', () => {
    const host = mount(<GutterMark icon={null} dot mark="tool" />);
    expect(icons(host)).toHaveLength(0);
    expect(mark(host).dataset.feedDot).toBe('tool');
    expect(mark(host).style.borderRadius).toBe('50%');
    expect(mark(host).style.background).toBe('var(--faint)');
  });

  it('a prompt keeps its circle, in its own ink', () => {
    const host = mount(<GutterMark icon={null} dot mark="user" dotColor="var(--muted)" />);
    expect(mark(host).dataset.feedDot).toBe('user');
    expect(mark(host).style.background).toBe('var(--muted)');
  });

  it('just the space, for a row that never had a dot (plain prose)', () => {
    const host = mount(<GutterMark icon={null} dot={false} />);
    expect(icons(host)).toHaveLength(0);
    expect(mark(host).hasAttribute('data-feed-dot')).toBe(false);
    expect(mark(host).style.background).toBe('');
  });

  it('⚠️ is the SAME width whatever it draws, so the boxes beside it never move', () => {
    const widths = [
      mount(<GutterMark icon="shell" dot />),
      mount(<GutterMark icon={null} dot />),
      mount(<GutterMark icon={null} dot={false} />),
    ].map((h) => [mark(h).style.inlineSize, mark(h).style.flexShrink, mark(h).style.marginBlockStart]);
    expect(widths).toEqual([
      ['6px', '0', '5px'],
      ['6px', '0', '5px'],
      ['6px', '0', '5px'],
    ]);
  });

  it('is decoration: hidden from a screen reader, and adds no text', () => {
    const host = mount(<GutterMark icon="read" dot />);
    expect(mark(host).getAttribute('aria-hidden')).toBe('true');
    expect(host.textContent).toBe('');
    expect(icons(host)[0].getAttribute('focusable')).toBe('false');
  });
});

describe('the drawings', () => {
  it('there is one for every kind, and no two are the same', () => {
    const drawings = TOOL_ICONS.map((kind) => {
      document.body.innerHTML = '';
      const host = mount(<ToolIcon kind={kind} />);
      const svg = host.querySelector('svg')!;
      expect(svg.children.length, kind).toBeGreaterThan(0);
      return svg.innerHTML;
    });
    expect(new Set(drawings).size).toBe(TOOL_ICONS.length);
  });

  it('gutter size by default, square, and no colour of its own', () => {
    const svg = mount(<ToolIcon kind="python" />).querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe(String(GUTTER_ICON_PX));
    expect(svg.getAttribute('height')).toBe(String(GUTTER_ICON_PX));
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
});
