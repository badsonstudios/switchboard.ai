// A session on an AI that is NOT Claude, in the same Session view (E40 item 06,
// #1289): the general ACP engine driving the fake ACP agent
// (`src/main/providers/acp/fake-acp-agent.ts`), hermetic — no login, no
// network.
//
// `SWITCHBOARD_FAKE_PROVIDER=acp` registers the fake ACP adapter FIRST, so the
// seeded card's provider (the default, the first registered) is `fake-acp`,
// with the Claude fake beside it. Nothing else about the launch differs from
// every other stream spec.
//
// What is asserted is what the design record's epic exit needs from this item:
// the conversation, a tool block, the approval bar answering allow AND deny,
// Stop, a mode chip that is live (not greyed) and really switches the agent's
// mode, and the declaration — no live MCP for this AI, which the MCP Manager
// reads (its wording is #1288's).
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

test.afterAll(async () => teardown());

async function send(w: Page, text: string): Promise<void> {
  const box = w.getByPlaceholder(/Prompt this session/);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

test.describe('a session on the fake ACP agent (#1289)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('renders in the same Session view: conversation, tool block, approvals, Stop, a live mode chip', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'acp' },
    });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({
      timeout: 25_000,
    });

    // 1. The conversation: our prompt (ACP does not echo it; the engine does)
    //    and the agent's streamed reply.
    await send(w, 'hello acp');
    await expect(w.getByText('ACP reply to: hello acp')).toBeVisible({
      timeout: 30_000,
    });
    await expect(w.locator('[data-feed-block="user"]', { hasText: 'hello acp' })).toBeVisible();

    // 2. The declaration, as the composer reads it: this AI has a live mode
    //    switch and Stop, and NO live MCP controls.
    const controls = await w.evaluate(async () => {
      const sb = (
        window as unknown as {
          switchboard: {
            sessions: {
              list: () => Promise<Array<{ id: string }>>;
              controls: (id: string) => Promise<{ ai: string; has: string[] } | null>;
            };
          };
        }
      ).switchboard;
      const [live] = await sb.sessions.list();
      return live ? sb.sessions.controls(live.id) : null;
    });
    expect(controls?.ai).toBe('Fake ACP');
    expect(controls?.has).toEqual(expect.arrayContaining(['approvals', 'interrupt', 'modes', 'models']));
    expect(controls?.has).not.toContain('mcp');

    // 3. A tool block, its result the exit code.
    await send(w, '!tool');
    await expect(w.getByText('TOOL DONE')).toBeVisible({ timeout: 30_000 });
    await expect(w.locator('[data-feed-block="tool"]', { hasText: 'echo fake-tool' }).first()).toBeVisible();

    // 4. The approval bar, answered ALLOW…
    await send(w, '!ask');
    const bar = w.locator('[data-approval-bar]');
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect(bar).toContainText('Run command');
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(w.getByText('ASK ALLOWED')).toBeVisible({ timeout: 30_000 });
    await expect(bar).toHaveCount(0);

    // …and DENY. A reject ends the agent's turn `cancelled` (measured on
    // Codex), so there is no reply; the session is simply ready again.
    await send(w, '!ask');
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await w.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(bar).toHaveCount(0, { timeout: 30_000 });
    await send(w, 'after the deny');
    await expect(w.getByText('ACP reply to: after the deny')).toBeVisible({
      timeout: 30_000,
    });

    // 5. Stop. `!cancel-slow` streams until cancelled; the title is matched on
    //    its second half because the first still names Claude (#1288's labels).
    await send(w, '!cancel-slow');
    await expect(w.getByText(/tick 3/)).toBeVisible({ timeout: 30_000 });
    await w
      .getByTitle(/interrupts the current turn/i)
      .first()
      .click();
    await expect(w.getByTitle(/interrupts the current turn/i)).toHaveCount(0, {
      timeout: 30_000,
    });

    // 6. The mode chip is LIVE (not greyed) and switches the agent NOW: ask ->
    //    plan, which the fake calls `read-only`.
    const chip = w.getByTestId('composer-autonomy');
    await expect(chip).toBeEnabled();
    await expect(chip).not.toHaveAttribute('data-unavailable', /.+/);
    await expect(chip).toContainText('ask');
    await chip.click();
    await expect(chip).toContainText('plan');
    // ONE prompt, no retry: the chip's IPC reaches main before the prompt's,
    // and main writes the mode switch to the agent before the prompt, which
    // the agent answers in order. A retry loop would hide a switch that only
    // sometimes arrived.
    await send(w, '!mode');
    await expect(w.getByText(/^MODE: /)).toHaveText('MODE: read-only', { timeout: 30_000 });
  });
});
