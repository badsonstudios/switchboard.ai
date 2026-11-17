// A path the AI wrote, clicked, in the real app (#1611).
//
// Dan: "When you, in your session, print out a path ... I want to be able to
// click on that path: if it's a Markdown file, open it". The agent names his
// working files relative to the session's folder and in code type, so that is
// what this sends: `.claude/work_files/x.md`, in backticks.
//
// What only the real app can show: that main's existence check (through the
// read scope, against the session's real folder) answers, that the reply
// re-decorates when it does, and that the click lands in the document viewer.
// What a click on a program does is `main/fs/ipc.test.ts`'s table: an e2e
// cannot watch Explorer open.
//
// The fake provider answers `FAKE-REPLY: <your prompt>`, and a reply is
// rendered as markdown, so a prompt with a code span produces a reply with one.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const composer = (w: Page) => w.getByPlaceholder(/^Message .+…$/);

test.describe('a path the AI wrote is clickable (#1611)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a reply naming .claude/work_files/x.md: click it, and the document viewer opens it', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    fs.mkdirSync(path.join(folder, '.claude', 'work_files'), { recursive: true });
    fs.writeFileSync(path.join(folder, '.claude', 'work_files', 'x.md'), '# The plan from the reply\n\nStep one.\n');
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await composer(w).click();
    await composer(w).fill('PATHS it is in `.claude/work_files/x.md` and not in `.claude/work_files/gone.md`.');
    await composer(w).press('Enter');
    const reply = w.locator('[data-feed-block="assistant"]').filter({ hasText: 'FAKE-REPLY: PATHS' });
    await expect(reply).toBeVisible({ timeout: 60_000 });

    // the file that is there becomes a link once main has said so; the one
    // that is not stays words
    const link = reply.locator('[data-feed-path]');
    await expect(link).toHaveCount(1, { timeout: 30_000 });
    await expect(link).toHaveText('.claude/work_files/x.md');
    await expect(link).toHaveAttribute('data-feed-path-kind', 'file');
    await expect(link).toHaveAttribute('title', 'Open x.md in the document viewer');
    // the conversation stays one tab stop
    await expect(link).toHaveAttribute('tabindex', '-1');

    await link.click();
    const viewer = w.locator('[data-testid="document-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 30_000 });
    await expect(w.locator('[data-testid="doc-name"]')).toHaveText('x.md');
    await expect(w.locator('[data-testid="doc-rendered"] h1')).toHaveText('The plan from the reply', {
      timeout: 30_000,
    });
  });
});
