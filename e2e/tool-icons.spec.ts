// The small picture beside each tool name in the conversation (#757), in the
// real app.
//
// The unit tests pin which tool gets which picture. What only the real app can
// show is that the pictures are really DRAWN in a real conversation: each has a
// size you can see, sits on the same line as its name and to the right of it,
// and is painted in the ink of that name (so none of them can be the yellow
// that means "a session needs you").
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const PROMPT = 'show me one of every kind of tool';

/** one turn that calls one tool of each kind, never two searches in a row (a
 *  run of those folds into a single "Explored the code" box) */
function script(): Record<string, unknown> {
  return {
    [PROMPT]: {
      say: 'One of each.',
      tools: [
        { id: 't1', name: 'Task', input: { description: 'Review the change', prompt: 'review' }, result: 'ok' },
        { id: 't2', name: 'Read', input: { file_path: 'src/a.ts' }, result: 'x' },
        { id: 't3', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, result: 'ok' },
        { id: 't4', name: 'Grep', input: { pattern: 'todo' }, result: 'a.ts:1' },
        { id: 't5', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, result: 'ok' },
        { id: 't6', name: 'WebFetch', input: { url: 'https://example.com' }, result: 'ok' },
        { id: 't7', name: 'mcp__switchboard__list_sessions', input: {}, result: '[]' },
        { id: 't8', name: 'ToolFromNextYear', input: {}, result: 'ok' },
        // a row squeezed by a very long summary: the picture must stay on the
        // name's line and not drop under it
        {
          id: 't9',
          name: 'WebSearch',
          input: { query: 'a very long search query '.repeat(30) },
          result: 'ok',
        },
      ],
      then: 'Done.',
    },
  };
}

test.describe('tool icons in the conversation (#757)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('every tool block draws its picture beside its name, in that name’s ink', async () => {
    const folder = tempProjectFolder();
    const scriptFile = path.join(folder, 'fake-script.json');
    fs.writeFileSync(scriptFile, JSON.stringify(script()), 'utf8');
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_FAKE_SCRIPT: scriptFile },
    });
    const w = a.window;
    const box = w.getByPlaceholder(/Prompt this session/);
    await expect(box).toBeVisible({ timeout: 25_000 });
    await box.click();
    await box.fill(PROMPT);
    await box.press('Enter');
    await expect(w.getByText('Done.').first()).toBeVisible({ timeout: 20_000 });

    const seen = await w.evaluate(() =>
      Array.from(document.querySelectorAll<SVGElement>('svg[data-tool-icon]')).map((svg) => {
        const r = svg.getBoundingClientRect();
        // the name is the span just before the picture; both sit inside one
        // element that carries the name's ink
        const nameEl = svg.previousElementSibling as HTMLElement | null;
        const n = nameEl?.getBoundingClientRect();
        return {
          kind: svg.dataset.toolIcon,
          width: Math.round(r.width),
          height: Math.round(r.height),
          rightOfName: n ? r.left >= n.right - 1 : null,
          sameLine: n ? Math.abs(r.top + r.height / 2 - (n.top + n.height / 2)) < 7 : null,
          stroke: getComputedStyle(svg).stroke,
          nameInk: nameEl ? getComputedStyle(nameEl).color : null,
        };
      })
    );

    // one of every kind the turn used
    expect(seen.map((s) => s.kind).sort()).toEqual(
      ['agent', 'edit', 'mcp', 'other', 'read', 'search', 'shell', 'web', 'web'].sort()
    );
    for (const s of seen) {
      const where = JSON.stringify(s);
      // big enough to be told apart, small enough to stay a mark
      expect(s.width, where).toBeGreaterThanOrEqual(10);
      expect(s.width, where).toBeLessThanOrEqual(16);
      expect(s.height, where).toBe(s.width);
      expect(s.rightOfName, where).toBe(true);
      expect(s.sameLine, where).toBe(true);
      // SHAPE, NOT COLOUR: painted in the ink of the name beside it
      expect(s.stroke, where).toBe(s.nameInk);
    }

    // kept for a person to look at: a test cannot say whether they read well
    if (process.env.SWITCHBOARD_KEEP_SHOT) {
      await w.screenshot({ path: process.env.SWITCHBOARD_KEEP_SHOT });
    }
  });
});
