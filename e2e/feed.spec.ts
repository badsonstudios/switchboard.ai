// P2-E12-06: Feed view v1 — read-only rendered blocks from the transcript.
// The fake provider writes no transcript, so the test plays Claude's part:
// it writes JSONL into the isolated HOME and the watcher tails it live.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, showTerminal, tempProjectFolder } from './fixtures/app';

function slugForCwd(cwd: string): string {
  return cwd.replace(/[\\/:. ]/g, '-');
}

test.describe('Feed view (E12-06)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('renders assistant text and a collapsed tool row from live transcript lines', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.getByText(title).first()).toBeVisible();

    // Feed is the DEFAULT view (E12-07) — the empty state shows with no click
    await expect(w.getByText('No conversation yet')).toBeVisible();

    // simulate the CLI writing its transcript in the isolated HOME
    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'native-e2e', cwd: folder, timestamp: new Date().toISOString(), ...o }) + '\n';
    fs.writeFileSync(
      path.join(dir, 'native-e2e.jsonl'),
      line({ type: 'user', message: { role: 'user', content: 'summarize this repo' } }) +
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Hello from the **feed**' },
              { type: 'tool_use', name: 'Read', input: { file_path: 'C:/tmp/x.md' } },
            ],
          },
        })
    );

    await expect(w.getByText('summarize this repo')).toBeVisible();
    await expect(w.getByText('Hello from the')).toBeVisible();
    await expect(w.locator('.feed-md strong', { hasText: 'feed' })).toBeVisible(); // markdown rendered
    await expect(w.getByText('Read', { exact: true })).toBeVisible(); // collapsed tool row
    // expanding the tool row reveals the input detail
    await w.getByText('Read', { exact: true }).click();
    await expect(w.getByText(/file_path/)).toBeVisible();

    // rich blocks v2 (E10-06): Edit diff panes + Bash IN/OUT + todos checklist
    fs.appendFileSync(
      path.join(dir, 'native-e2e.jsonl'),
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'echo RICH_OUT', description: 'Check output' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'C:/tmp/y.ts', old_string: 'OLD_LINE', new_string: 'NEW_LINE' } },
            { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'first step', status: 'completed' }] } },
          ],
        },
      }) +
        line({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'RICH_OUT' }] },
        })
    );
    await expect(w.getByText('Check output')).toBeVisible(); // Bash header description
    await expect(w.getByText('NEW_LINE')).toBeVisible(); // Edit new pane (open by default)
    await expect(w.getByText('+1 / -1 lines')).toBeVisible(); // edit stats subtitle
    await expect(w.getByText('Update Todos')).toBeVisible();
    await expect(w.getByText('first step')).toBeVisible();
    // OUT section expands to the tool result
    await w.getByText('▸ OUT').click();
    await expect(w.getByText('RICH_OUT', { exact: true }).last()).toBeVisible();

    // verbosity presets switch live (E12-07): quiet hides tool rows
    await w.getByRole('button', { name: 'quiet' }).click();
    await expect(w.getByText('Read', { exact: true })).toHaveCount(0);
    await expect(w.getByText('Hello from the')).toBeVisible(); // prose stays
    await w.getByRole('button', { name: 'normal' }).click();
    await expect(w.getByText('Read', { exact: true })).toBeVisible();
  });

  test('a long history opens scrolled to the BOTTOM (Dan 2026-07-23)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'native-scroll', cwd: folder, timestamp: new Date().toISOString(), ...o }) + '\n';
    let body = '';
    for (let i = 1; i <= 60; i++) {
      body += line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `SCROLL_BLOCK_${i}` }] },
      });
    }
    fs.writeFileSync(path.join(dir, 'native-scroll.jsonl'), body);

    // the tail is on screen, the head is not — we're pinned to the bottom
    await expect(w.getByText('SCROLL_BLOCK_60')).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('SCROLL_BLOCK_60')).toBeInViewport();
    await expect(w.getByText('SCROLL_BLOCK_1', { exact: true })).not.toBeInViewport();
  });

  test('switching away and back keeps your reading position (Dan 2026-07-26)', async () => {
    // Dockview HIDES a background panel and the browser resets a hidden
    // element's scrollTop to 0, so returning to a session you had scrolled up
    // in dumped you at the very top — the tail-pin only knew how to reach the
    // bottom. Dan hit it by clicking a finished session's Events row.
    const folder = tempProjectFolder();
    const other = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'native-keep', cwd: folder, timestamp: new Date().toISOString(), ...o }) + '\n';
    let body = '';
    for (let i = 1; i <= 60; i++) {
      body += line({ type: 'assistant', message: { content: [{ type: 'text', text: `KEEP_BLOCK_${i}` }] } });
    }
    fs.writeFileSync(path.join(dir, 'native-keep.jsonl'), body);
    await expect(w.getByText('KEEP_BLOCK_60')).toBeVisible({ timeout: 15_000 });

    const feed = () =>
      w.evaluate(() => {
        const el = [...document.querySelectorAll('div')].find(
          (d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY === 'auto'
        );
        return el ? Math.round(el.scrollTop) : -1;
      });

    // Read something partway up, with a REAL wheel gesture — that is what the
    // scroll handler exists to notice, and it keeps the test honest about the
    // path a user actually takes.
    await w.getByText('KEEP_BLOCK_30').hover();
    await w.mouse.wheel(0, -700);
    await w.waitForTimeout(400); // let the scroll event land and unpin the tail
    const target = await feed();
    expect(target).toBeGreaterThan(0);

    // switch to another session, then come back
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
    }, other);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(path.basename(other)).first()).toBeVisible({ timeout: 25_000 });
    await w.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+1`);

    await expect.poll(feed, { timeout: 10_000 }).toBe(target);

    // and a block arriving while you're reading must not yank you anywhere
    fs.appendFileSync(
      path.join(dir, 'native-keep.jsonl'),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'KEEP_BLOCK_61' }] } })
    );
    await expect(w.getByText('KEEP_BLOCK_61')).toBeAttached({ timeout: 15_000 });
    expect(await feed()).toBe(target);
  });

  test('a scroll nobody asked for cannot unpin the tail (Dan 2026-07-26)', async () => {
    // The approval bar docks BELOW the feed, so it shrinks the viewport and
    // pushes content under the fold. `pinned` used to be re-derived from that
    // raw measurement, which reads identically to "the user scrolled up" — one
    // such sample left the feed stuck short of the bottom with output cut off.
    // Only a real gesture may move the pin now, so a layout-induced scroll
    // must be corrected back to the tail.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'native-nudge', cwd: folder, timestamp: new Date().toISOString(), ...o }) + '\n';
    let body = '';
    for (let i = 1; i <= 60; i++) {
      body += line({ type: 'assistant', message: { content: [{ type: 'text', text: `NUDGE_BLOCK_${i}` }] } });
    }
    fs.writeFileSync(path.join(dir, 'native-nudge.jsonl'), body);
    await expect(w.getByText('NUDGE_BLOCK_60')).toBeInViewport({ timeout: 15_000 });

    const feed = () =>
      w.evaluate(() => {
        const el = [...document.querySelectorAll('div')].find(
          (d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY === 'auto'
        );
        return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : -1;
      });
    await expect.poll(feed, { timeout: 5_000 }).toBeLessThan(2); // at the tail

    // a scroll with NO gesture behind it — exactly what a layout change causes
    await w.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find(
        (d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY === 'auto'
      )!;
      el.scrollTop = 200;
    });

    // it must come back, and stay back as new output lands
    await expect.poll(feed, { timeout: 5_000 }).toBeLessThan(2);
    fs.appendFileSync(
      path.join(dir, 'native-nudge.jsonl'),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'NUDGE_BLOCK_61' }] } })
    );
    await expect(w.getByText('NUDGE_BLOCK_61')).toBeInViewport({ timeout: 15_000 });
  });

  test('switching away and back keeps you GLUED to the tail if that is where you were', async () => {
    // the other half of the same rule: a tail-pinned session must come back
    // pinned, not at the offset it happened to hold
    const folder = tempProjectFolder();
    const other = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'native-tail', cwd: folder, timestamp: new Date().toISOString(), ...o }) + '\n';
    let body = '';
    for (let i = 1; i <= 60; i++) {
      body += line({ type: 'assistant', message: { content: [{ type: 'text', text: `TAIL_BLOCK_${i}` }] } });
    }
    fs.writeFileSync(path.join(dir, 'native-tail.jsonl'), body);
    await expect(w.getByText('TAIL_BLOCK_60')).toBeInViewport({ timeout: 15_000 });

    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
    }, other);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(path.basename(other)).first()).toBeVisible({ timeout: 25_000 });
    await w.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+1`);

    await expect(w.getByText('TAIL_BLOCK_60')).toBeInViewport({ timeout: 10_000 });
  });

  test('composer autonomy chip cycles and survives a relaunch (E10-05)', async () => {
    const folder = tempProjectFolder();
    const title = folder.split(/[\\/]/).pop()!;
    // assign to the shared handle IMMEDIATELY: an assertion failing before
    // close() must leave afterEach something to kill, or the Electron/PTY
    // tree leaks and poisons CI teardown (review P1-test #16)
    a = await launchApp({ seedFolder: folder });
    const first = a;
    const w = first.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    const chip = w.getByTitle('Autonomy for this session (applies on next resume)');
    await expect(chip).toContainText('ask');
    await chip.click(); // -> plan
    await expect(chip).toContainText('plan');

    await w.waitForTimeout(900); // debounced store save
    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await expect(
      a.window.getByTitle('Autonomy for this session (applies on next resume)')
    ).toContainText('plan', { timeout: 20_000 });
  });

  // #156, and the case that shipped with a UNIT test and no e2e — which is
  // exactly the gap Dan's PR #163 re-test walked into. The transcript half of
  // the local-slash-command fix was never proved through the renderer, so
  // nothing in the suite could say whether the OUTPUT was on screen or merely
  // in a data structure.
  //
  // The three entries below are copied from a REAL transcript
  // (`~/.claude/projects/…`, read 2026-08-02), not invented: a `<local-command-caveat>`
  // meta line, the `<command-name>` invocation, and the output as
  // `system`/`subtype:"local_command"` wrapped in `<local-command-stdout>`.
  // THERE IS NO `assistant` ENTRY — that absence is the whole bug.
  test('a local slash command shows its OUTPUT, not just a collapsed echo (#156)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });
    await expect(w.getByText('No conversation yet')).toBeVisible();

    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>): string =>
      JSON.stringify({
        sessionId: 'native-e2e',
        cwd: folder,
        timestamp: new Date().toISOString(),
        ...o,
      }) + '\n';
    fs.writeFileSync(
      path.join(dir, 'native-e2e.jsonl'),
      line({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' },
      }) +
        line({
          type: 'user',
          message: {
            role: 'user',
            content:
              '<command-name>/usage</command-name>\n            <command-message>usage</command-message>\n            <command-args></command-args>',
          },
        }) +
        line({
          type: 'system',
          subtype: 'local_command',
          level: 'info',
          isMeta: false,
          isSidechain: false,
          content: '<local-command-stdout>Current session: 12% used · resets Aug 2</local-command-stdout>',
        })
    );

    // THE OUTPUT IS ON SCREEN, WITH NO CLICK. Scoped to `.feed-md` — the
    // assistant-prose renderer — so it can only pass by rendering as its own
    // visible block. Matching loose page text would also have been satisfied by
    // the text sitting inside the collapsed invocation pill, which is precisely
    // the failure this test exists to distinguish.
    const output = w.locator('.feed-md', { hasText: 'Current session: 12% used' });
    await expect(output).toBeVisible({ timeout: 20_000 });

    // …and the invocation still collapses to its command name, which is the
    // existing treatment for a command echo (a skill invocation dumps its whole
    // body here). The output is a SEPARATE block after it — no new UI, and
    // nothing the user has to expand.
    await expect(w.getByText('click to expand')).toBeVisible();
    await expect(w.getByText('command-message')).toHaveCount(0); // boilerplate stays collapsed
  });

  // #91, Dan's live feedback 2026-07-26. Two presentation rules that only the
  // real window can settle: a tool block is a BOX whose whole body expands it,
  // and a plain answer carries no timeline dot while keeping its left edge.
  test('tool blocks are clickable boxes and prose has no dot (#91)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>): string =>
      JSON.stringify({ sessionId: 'native-box', cwd: folder, timestamp: new Date().toISOString(), ...o }) + '\n';
    fs.writeFileSync(
      path.join(dir, 'native-box.jsonl'),
      line({ type: 'user', message: { role: 'user', content: 'BOX_PROMPT' } }) +
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'BOX_PROSE answer' },
              // two lines on purpose: a COLLAPSED section still shows its first
              // line, so only a second one can tell open from shut
              { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'echo BOX_CMD\nBOX_CMD_LINE2', description: 'Box check' } },
              { type: 'tool_use', name: 'Edit', input: { file_path: 'C:/tmp/box.ts', old_string: 'BOX_OLD', new_string: 'BOX_NEW' } },
              { type: 'tool_use', name: 'Read', input: { file_path: 'C:/tmp/box.md' } },
            ],
          },
        }) +
        line({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'BOX_OUTPUT\nBOX_OUT_LINE2' }] },
        })
    );

    // 1. every tool block is its own bordered container
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible({ timeout: 20_000 });
    await expect(w.locator('[data-feed-box="edit"]')).toBeVisible();
    await expect(w.locator('[data-feed-box="tool"]')).toBeVisible(); // the Read row

    // 2. the ANSWER has no dot; the prompt and the tool calls still do
    await expect(w.locator('[data-feed-block="assistant"] [data-feed-dot]')).toHaveCount(0);
    await expect(w.locator('[data-feed-block="user"] [data-feed-dot]').first()).toBeAttached();
    await expect(w.locator('[data-feed-block="tool"] [data-feed-dot]').first()).toBeAttached();

    // …and dropping the dot must not drop the GUTTER: prose starts on the same
    // column as the boxes, or the conversation zig-zags down the page
    const prose = await w.locator('.feed-md', { hasText: 'BOX_PROSE' }).boundingBox();
    const box = await w.locator('[data-feed-box="edit"]').boundingBox();
    expect(Math.abs(prose!.x - box!.x)).toBeLessThanOrEqual(1);

    // 3. the BOX BODY expands, not just the header. The Edit block's stats
    //    subtitle is box body by construction — it is neither the header line
    //    nor an inner expander — so a click there proves the whole container is
    //    the target.
    await expect(w.getByText('BOX_NEW')).toBeVisible(); // Edit opens expanded
    await w.getByText('+1 / -1 lines').click();
    await expect(w.getByText('BOX_NEW')).toHaveCount(0);
    await w.getByText('+1 / -1 lines').click();
    await expect(w.getByText('BOX_NEW')).toBeVisible();

    //    …and the Bash box opens from its PADDING, where there is nothing but
    //    the container itself — Dan's ask in his own words: click the box and
    //    see what the command was.
    await expect(w.getByText('▸ IN')).toBeVisible();
    await expect(w.getByText('▸ OUT')).toBeVisible();
    await w.locator('[data-feed-box="bash"]').click({ position: { x: 3, y: 2 } });
    await expect(w.getByText('▾ IN')).toBeVisible();
    await expect(w.getByText('▾ OUT')).toBeVisible();
    await expect(w.getByText('BOX_CMD_LINE2')).toBeVisible(); // the WHOLE command
    await expect(w.getByText('BOX_OUT_LINE2')).toBeVisible();

    // 4. an expander INSIDE the box owns its own click (it must not also flip
    //    the box, or every fine-grained control would fight its container)
    await w.locator('[data-feed-box="bash"]').click({ position: { x: 3, y: 2 } }); // close both
    await expect(w.getByText('▸ IN')).toBeVisible();
    await w.getByText('▸ IN').click();
    await expect(w.getByText('▾ IN')).toBeVisible();
    await expect(w.getByText('▸ OUT')).toBeVisible(); // OUT stayed shut

    // 5. the container reads as a container in BOTH shipped themes — an edge
    //    the same colour as its fill is not a box
    const edges = (): Promise<{ border: string; fill: string }> =>
      w.locator('[data-feed-box="edit"]').evaluate((el) => {
        const s = getComputedStyle(el);
        return { border: s.borderTopColor, fill: s.backgroundColor };
      });
    // pinned explicitly: the app boots on `system`, which follows the OS, so
    // "whatever it started as" is not one of the two themes we mean to check
    await w.getByRole('button', { name: 'nordic', exact: true }).click();
    await expect(w.locator('html')).toHaveAttribute('data-theme-id', 'nordic');
    const dark = await edges();
    expect(dark.border).not.toBe(dark.fill);

    await w.getByRole('button', { name: 'daylight', exact: true }).click();
    await expect(w.locator('html')).toHaveAttribute('data-theme-id', 'daylight');
    await expect.poll(async () => (await edges()).fill).not.toBe(dark.fill);
    const light = await edges();
    expect(light.border).not.toBe(light.fill);
  });

  test('the composer drives the real CLI over the PTY (E10-02)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    // type a prompt in the Session tab's composer and hit Enter — the fake
    // provider is a real shell, so the command actually executes
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.fill('echo COMPOSER_OK_42');
    await box.press('Enter');
    await expect(box).toHaveValue(''); // cleared on submit

    // proof it reached the CLI: the (hidden) Terminal shows the output
    await showTerminal(w);
    await expect(w.getByText(/COMPOSER_OK_42/).first()).toBeVisible({ timeout: 15_000 });
  });
});
