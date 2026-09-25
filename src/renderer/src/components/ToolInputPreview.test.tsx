// @vitest-environment jsdom
// The approval body, as a rendered contract (#953, DESIGN §5.16).
//
// The claim under test is not "these branches exist". It is that **no tool the
// default autonomy holds can reach the screen showing nothing**, which is a
// claim about the component as a whole and therefore has to be made against
// the real component rather than against a helper.
//
// The last describe is the one that matters most in a year: a tool nobody has
// taught this file about must degrade to a dump. Every named branch below will
// eventually be wrong — `NotebookEdit` already keys its path `notebook_path`
// rather than `file_path`, and `MultiEdit` has already vanished from the
// published tool schemas of claude 2.1.280 while still being named inside the
// binary — so the default is the only branch guaranteed to still be true.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { ToolInputPreview } from './ToolInputPreview';
import { MUTATING } from '../../../shared/tool-taxonomy';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

async function mount(input: Record<string, unknown>, dense = false): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ToolInputPreview input={input} dense={dense} />);
  });
  return host;
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

/**
 * One input per tool the default `ask` autonomy holds, keyed exactly as the
 * CLI keys it — checked against the `sdk-tools.d.ts` shipped with claude
 * 2.1.280 and, for `MultiEdit`, against the binary's own input map.
 */
const HELD: Record<string, Record<string, unknown>> = {
  Write: { file_path: 'C:/p/new.ts', content: 'export const a = 1;\nexport const b = 2;\n' },
  Edit: { file_path: 'C:/p/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
  MultiEdit: {
    file_path: 'C:/p/a.ts',
    edits: [{ old_string: 'one', new_string: 'uno' }],
  },
  // notebook_path, NOT file_path — the key this whole bug hid behind
  NotebookEdit: { notebook_path: 'C:/p/n.ipynb', cell_id: 'c3', new_source: 'import pandas' },
  WebFetch: { url: 'https://example.test/x', prompt: 'summarise the changelog' },
};

describe('every tool the default autonomy holds says what it would change', () => {
  // the taxonomy is the source of the list, so growing it fails this test
  // rather than silently leaving a new tool blank
  it.each(MUTATING)('%s renders something, never an empty bar', async (tool) => {
    const input = HELD[tool];
    expect(input, `no fixture for ${tool} — add one, it is gated under ask`).toBeDefined();
    const host = await mount(input);
    expect(host.textContent.trim().length, `${tool} rendered nothing`).toBeGreaterThan(0);
  });
});

describe('Write — the blind signature this fixes', () => {
  it('shows the whole new contents, not just the path', async () => {
    const host = await mount(HELD.Write);
    expect(host.querySelector('[data-preview="content"]')).not.toBeNull();
    expect(host.textContent).toContain('export const a = 1;');
    expect(host.textContent).toContain('export const b = 2;');
  });

  it('counts the lines it is about to write', async () => {
    const host = await mount({ file_path: 'x', content: 'a\nb\nc' });
    expect(host.textContent).toContain('3 lines');
  });

  it('does not count the trailing newline as a fourth line', async () => {
    // nearly every file an agent writes ends in one, so the naive
    // `split('\n').length` overstates the COMMON case — on the one caption
    // whose whole job is to say how big the thing being signed for is
    const host = await mount({ file_path: 'x', content: 'a\nb\nc\n' });
    expect(host.textContent).toContain('3 lines');
    expect(host.textContent).not.toContain('4 lines');
  });

  it('calls a one-line file one line', async () => {
    const host = await mount({ file_path: 'x', content: 'just this' });
    expect(host.textContent).toContain('1 line');
  });

  it('says so when the file it writes is empty, rather than rendering a void', async () => {
    // a zero-byte write is a real thing to be asked, and an empty pane beside
    // a path is indistinguishable from the bug
    const host = await mount({ file_path: 'x', content: '' });
    expect(host.textContent).toContain('New contents — empty');
    expect(host.querySelector('pre')).toBeNull();
  });

  it('marks a clipped file as clipped', async () => {
    // the caps are a separate question; TELLING the user a cap was hit is not,
    // because a first page that looks like a whole file is the same failure
    // one size down
    const host = await mount({ file_path: 'x', content: 'y'.repeat(4000) });
    expect(host.textContent).toContain('…');
  });
});

describe('MultiEdit — one pair per change', () => {
  it('renders the single change and counts it', async () => {
    const host = await mount(HELD.MultiEdit);
    expect(host.querySelector('[data-preview="edits"]')).not.toBeNull();
    expect(host.textContent).toContain('1 change');
    expect(host.textContent).toContain('one');
    expect(host.textContent).toContain('uno');
  });

  it('renders many changes, caps them, and says how many it hid', async () => {
    const edits = Array.from({ length: 7 }, (_, i) => ({
      old_string: `old${i}`,
      new_string: `new${i}`,
    }));
    const host = await mount({ file_path: 'C:/p/a.ts', edits });
    expect(host.textContent).toContain('7 changes');
    // the cap is a display choice; the COUNT is the honesty, so the user
    // always knows the size of what Allow would approve
    expect(host.textContent).toContain('3 more changes');
    expect(host.textContent).toContain('old0');
    expect(host.textContent).not.toContain('old6');
  });

  it('wins over the singular pair when an input carries both', async () => {
    // the CLI strips old_string/new_string off an input that has `edits`, so
    // an input carrying both is a multi-edit and must not render as one edit
    const host = await mount({
      file_path: 'a',
      old_string: 'SINGULAR',
      new_string: 'SINGULAR2',
      edits: [{ old_string: 'plural', new_string: 'plural2' }],
    });
    expect(host.querySelector('[data-preview="edits"]')).not.toBeNull();
    expect(host.textContent).not.toContain('SINGULAR');
  });

  it('keeps the readable changes when ONE entry is malformed', async () => {
    // the all-or-nothing version threw six legible changes away to print a
    // third of a JSON blob — this component's own bug, one layer down
    const host = await mount({
      file_path: 'a',
      edits: [
        { old_string: 'good', new_string: 'better' },
        { old_string: 'missing its other half' },
      ],
    });
    expect(host.querySelector('[data-preview="edits"]')).not.toBeNull();
    expect(host.textContent).toContain('better');
    // ...and it SAYS that something was there it could not render, so the
    // salvage never hides part of what Allow would approve
    expect(host.textContent).toContain('1 change switchboard could not read');
  });

  it('falls through to the dump when nothing in the array is readable', async () => {
    // with nothing to salvage the dump genuinely is the better answer
    const host = await mount({ file_path: 'a', edits: ['not an object'] });
    expect(host.querySelector('[data-preview="fallback"]')).not.toBeNull();
    expect(host.textContent).toContain('not an object');
  });

  it('bounds the whole list, not just each pair inside it', async () => {
    // four pairs at 96px each is ~400px of a band that declares flexShrink: 0
    // above a workspace that is the only thing willing to give; unbounded, it
    // pushes Allow and Deny off a short window with no scroller to reach them
    const edits = Array.from({ length: 4 }, (_, i) => ({
      old_string: `o${i}`,
      new_string: `n${i}`,
    }));
    const host = await mount({ file_path: 'a', edits }, true);
    const list = host.querySelector<HTMLElement>('[data-preview-list]')!;
    expect(list.style.overflow).toBe('auto');
    expect(list.style.maxBlockSize).not.toBe('');
    // and the captions stay OUTSIDE it, so the count of what is being
    // approved cannot be scrolled out of sight
    expect(list.querySelector('[data-preview-caption]')).toBeNull();
    expect(host.querySelectorAll('[data-preview-caption]').length).toBeGreaterThan(0);
  });
});

describe('NotebookEdit — the one that named nothing at all', () => {
  it('shows the new cell source and which cell it is', async () => {
    const host = await mount(HELD.NotebookEdit);
    expect(host.querySelector('[data-preview="new_source"]')).not.toBeNull();
    expect(host.textContent).toContain('cell c3');
    expect(host.textContent).toContain('import pandas');
  });

  it('says a cell is new when there is no id to name', async () => {
    const host = await mount({ notebook_path: 'n.ipynb', new_source: 'x = 1' });
    expect(host.textContent).toContain('a new cell');
    expect(host.textContent).toContain('x = 1');
  });
});

describe('the branches that already worked still work', () => {
  it('renders a shell command', async () => {
    const host = await mount({ command: 'npm test' });
    expect(host.querySelector('[data-preview="command"]')).not.toBeNull();
    expect(host.textContent).toContain('npm test');
  });

  it('renders an Edit as before and after', async () => {
    const host = await mount(HELD.Edit);
    const panes = host.querySelectorAll('[data-preview="edit"] pre');
    expect(panes).toHaveLength(2);
    expect(panes[0].textContent).toBe('const a = 1');
    expect(panes[1].textContent).toBe('const a = 2');
  });
});

describe('the default branch — the only one guaranteed to age well', () => {
  it('dumps a tool it has never heard of rather than rendering silence', async () => {
    // deliberately a name no taxonomy in this repo knows: the point is that
    // the NEXT tool the CLI ships is legible here before anyone edits a file
    const host = await mount({
      file_path: 'C:/p/a.ts',
      strategy: 'rewrite-in-place',
      passes: 3,
    });
    const dump = host.querySelector('[data-preview="fallback"]')!;
    expect(dump).not.toBeNull();
    expect(dump.textContent).toContain('strategy="rewrite-in-place"');
    expect(dump.textContent).toContain('passes=3');
  });

  it('does not simply echo the line the bar already printed above it', async () => {
    // both bars head the card with the path; a body repeating only that reads
    // as "there is nothing more", which is exactly the false impression this
    // component exists to stop giving
    const host = await mount({ file_path: 'C:/p/a.ts', flavour: 'x' });
    expect(host.querySelector('[data-preview="fallback"]')!.textContent).not.toContain('C:/p/a.ts');
  });

  it('renders nothing when there is genuinely nothing to say', async () => {
    // an empty input is the one case where a blank body is honest, and a box
    // of nothing above the buttons is worse than no box
    const host = await mount({});
    expect(host.textContent).toBe('');
  });

  it('puts one field per line, because this is a body and not a heading', async () => {
    const host = await mount({ a: 1, b: 2 });
    expect(host.querySelector('[data-preview="fallback"]')!.textContent).toBe('a=1\nb=2');
  });
});

describe('dense is a size, never a branch', () => {
  it('shows the same content on the grouped band as on the card', async () => {
    const card = await mount(HELD.Write, false);
    const cardText = card.textContent;
    await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = '';
    const band = await mount(HELD.Write, true);
    // §5.16 is ONE question in two places; two bodies that differ have shown
    // the user two things and told them they are the same
    expect(band.textContent).toBe(cardText);
  });
});
