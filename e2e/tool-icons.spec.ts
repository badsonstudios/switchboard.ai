// The pictures in the timeline gutter (#757, moved there by #1207), in the
// real app.
//
// The unit tests pin which block gets which picture and that the boxes carry
// none. What only the real app can show is the part that is about PIXELS: each
// picture is really drawn, at a size you can see, centred on the column where
// the dot was; and putting a 13px picture in a 6px gutter moved nothing beside
// it, so every box still starts on the same line.
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
        // a command says what it RUNS (#1207). Never three commands in a row:
        // a run of those folds into one "Ran N commands" box
        { id: 't5b', name: 'Bash', input: { command: 'git status', description: 'See what changed' }, result: 'clean' },
        { id: 't5c', name: 'Write', input: { file_path: 'src/new.ts', content: 'x' }, result: 'ok' },
        { id: 't6', name: 'WebFetch', input: { url: 'https://example.com' }, result: 'ok' },
        { id: 't6b', name: 'Bash', input: { command: 'python tools/x.py', description: 'Run the script' }, result: 'ok' },
        { id: 't7', name: 'mcp__switchboard__list_sessions', input: {}, result: '[]' },
        { id: 't6c', name: 'Bash', input: { command: 'ls -la', description: 'List the folder' }, result: 'a' },
        { id: 't8', name: 'ToolFromNextYear', input: {}, result: 'ok' },
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

test.describe('the pictures in the timeline gutter (#1207)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('every tool block wears its picture in the gutter; the boxes carry none and none of them moved', async () => {
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
      Array.from(document.querySelectorAll<HTMLElement>('[data-feed-block]')).map((row) => {
        const cell = row.firstElementChild as HTMLElement;
        const svg = cell.querySelector<SVGElement>('svg[data-tool-icon]');
        const c = cell.getBoundingClientRect();
        const g = svg?.getBoundingClientRect();
        const box = row.querySelector<HTMLElement>('[data-feed-box]');
        return {
          block: row.dataset.feedBlock,
          glyph: cell.dataset.feedGlyph ?? null,
          dot: cell.dataset.feedDot ?? null,
          cellWidth: Math.round(c.width),
          cellCentre: c.left + c.width / 2,
          cellMiddle: c.top + c.height / 2,
          glyphWidth: g ? Math.round(g.width) : null,
          glyphHeight: g ? Math.round(g.height) : null,
          glyphCentre: g ? g.left + g.width / 2 : null,
          glyphMiddle: g ? g.top + g.height / 2 : null,
          stroke: svg ? getComputedStyle(svg).stroke : null,
          boxLeft: box ? box.getBoundingClientRect().left : null,
          // no picture inside any box
          inBox: box ? box.querySelectorAll('svg[data-tool-icon]').length : 0,
        };
      })
    );
    const tools = seen.filter((s) => s.block === 'tool');

    // ONE OF EVERY KIND THE TURN USED, in the order it used them: the command
    // rows say what they ran, and the one nobody recognises has the plain dot
    expect(tools.map((s) => s.glyph ?? `dot:${s.dot}`)).toEqual([
      'agent',
      'read',
      'node',
      'search',
      'edit',
      'git',
      'write',
      'web',
      'python',
      'mcp',
      'shell',
      'dot:tool',
      'web',
    ]);

    for (const s of tools) {
      const where = JSON.stringify(s);
      // THE BOXES CARRY NONE
      expect(s.inBox, where).toBe(0);
      // the gutter cell is as wide as it always was, picture or dot
      expect(s.cellWidth, where).toBe(6);
      if (s.glyph === null) continue;
      // big enough to be told apart, small enough to stay a mark, and square
      expect(s.glyphWidth, where).toBe(13);
      expect(s.glyphHeight, where).toBe(13);
      // CENTRED on the point the dot was drawn at
      expect(Math.abs(s.glyphCentre! - s.cellCentre), where).toBeLessThan(1);
      expect(Math.abs(s.glyphMiddle! - s.cellMiddle), where).toBeLessThan(1);
    }

    // ⚠️ NOTHING MOVED: every box starts on the same line, whether its row has
    // a picture or the plain dot
    const lefts = tools.map((s) => Math.round(s.boxLeft! * 2) / 2);
    expect(new Set(lefts).size, JSON.stringify(lefts)).toBe(1);

    // SHAPE, NOT COLOUR: every picture is one ink, the gutter's own
    const inks = new Set(tools.filter((s) => s.glyph).map((s) => s.stroke));
    expect(inks.size, JSON.stringify([...inks])).toBe(1);

    // the PROMPT keeps its circle ("the prompt is fine with a circle")
    const prompt = seen.find((s) => s.block === 'user')!;
    expect(prompt.glyph).toBeNull();
    expect(prompt.dot).toBe('user');
    // ...and the pictures stand on the prompt's own column
    expect(Math.abs(tools[0].glyphCentre! - prompt.cellCentre)).toBeLessThan(1);

    // kept for a person to look at: a test cannot say whether they read well
    if (process.env.SWITCHBOARD_KEEP_SHOT) {
      await w.screenshot({ path: process.env.SWITCHBOARD_KEEP_SHOT });
    }
  });
});
