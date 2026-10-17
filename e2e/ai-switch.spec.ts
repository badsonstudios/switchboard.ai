// The AI switch (E40 item 11, #1294): a card moves Claude → another AI →
// Claude, and the way back RESUMES the original Claude conversation.
//
// `SWITCHBOARD_FAKE_PROVIDER=both` registers the Claude fake FIRST (the
// default, so the seeded card starts on it) and the fake ACP agent beside it:
// two AIs, both hermetic.
//
// THE OBSERVABLE FOR "THE SAME CONVERSATION". The Claude fake mints a new id
// per fresh spawn (#603) and, when it is spawned with `--resume <id>`, leads
// its first reply with `RESUMED-FROM:<id>` (#404's marker). So the second
// Claude turn reading `RESUMED-FROM:<the id the FIRST turn announced>` is the
// resume of the original conversation — a fresh one could not print it — and
// the first turn's prompt being on screen again is its history coming back.
//
// What only this can see: the real chip and menu, the real channel, the real
// lazy re-arm, the divider in the Feed, and both across a relaunch.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, pollAsync, readWorkspaceFile, sessionStatuses } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

test.afterAll(async () => teardown());

async function send(w: Page, text: string): Promise<void> {
  const box = w.getByPlaceholder(/Prompt this session/);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

/** Open the AI chip's menu and pick the AI whose row key is `key`. */
async function switchTo(w: Page, key: string): Promise<void> {
  await w.locator('[data-testid="composer-ai"]').click();
  const menu = w.locator('[data-testid="ai-switch-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator(`[data-ai-row="${key}"]`).click();
}

/** The card on disk — undefined until the debounced first save has landed. */
const card = (a: LaunchedApp) => {
  try {
    return readWorkspaceFile(a.home).sessions?.[0];
  } catch {
    return undefined;
  }
};

test.describe('the AI switch (#1294)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('Claude → Fake ACP → Claude: a divider each way, and the second Claude turn continues the ORIGINAL conversation', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'both' } });
    const first = a;
    const w = first.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // ── a Claude turn, and the conversation id it announced ─────────────────
    const chip = w.locator('[data-testid="composer-ai"]');
    await expect(chip).toHaveAttribute('data-provider', 'claude-code', { timeout: 25_000 });
    await send(w, 'the first claude turn');
    await expect(w.getByText('FAKE-REPLY: the first claude turn')).toBeVisible({ timeout: 30_000 });
    const claudeId = await pollAsync(() => Promise.resolve(card(first)?.nativeSessionId ?? null), 'the Claude id on disk');

    // ── the menu says what it is, then the switch ───────────────────────────
    await chip.click();
    const menu = w.locator('[data-testid="ai-switch-menu"]');
    await expect(menu).toContainText(
      'Switching hands this card to another AI with a summary of this conversation. Coming back resumes where that AI left off.'
    );
    await expect(menu.locator('[data-ai-row="claude-code"]')).toHaveAttribute('aria-checked', 'true');
    await menu.locator('[data-ai-row="fake-acp"]').click();
    await expect(menu).toHaveCount(0);

    // on the other AI, opening with the divider, with an empty conversation
    await expect(chip).toHaveAttribute('data-provider', 'fake-acp', { timeout: 25_000 });
    const toAcp = w.locator('[data-ai-switch-divider][data-to="fake-acp"]');
    await expect(toAcp).toBeVisible({ timeout: 25_000 });
    await expect(toAcp).toContainText('→ Fake ACP');
    // Claude's turn is not drawn here. EXACT since #1295: the briefing (and the
    // fake ACP's echo of it) now QUOTES that reply, inside a larger block — so
    // only a block that IS the reply counts as the Claude turn being on screen.
    await expect(w.getByText('FAKE-REPLY: the first claude turn', { exact: true })).toHaveCount(0);
    await send(w, 'hello acp');
    await expect(w.getByText('ACP reply to: hello acp')).toBeVisible({ timeout: 30_000 });
    // the Claude conversation is parked on the card, not dropped
    await expect(() => {
      const c = card(first);
      expect(c?.identity?.providerId).toBe('fake-acp');
      expect(c?.conversations?.['claude-code']?.nativeSessionId).toBe(claudeId);
    }).toPass({ timeout: 15_000 });

    // ── and back ────────────────────────────────────────────────────────────
    await switchTo(w, 'claude-code');
    await expect(chip).toHaveAttribute('data-provider', 'claude-code', { timeout: 25_000 });
    // its own history is back, the arrival divider under it
    await expect(w.getByText('FAKE-REPLY: the first claude turn')).toBeVisible({ timeout: 25_000 });
    const back = w.locator('[data-ai-switch-divider][data-from="fake-acp"]');
    await expect(back).toBeVisible();
    await expect(w.getByText('ACP reply to: hello acp')).toHaveCount(0);
    await send(w, 'the second claude turn');
    // THE ASSERTION: a resume of the ORIGINAL conversation, not a fresh one
    await expect(w.getByText(`RESUMED-FROM:${claudeId}`)).toBeVisible({ timeout: 30_000 });
    await expect(w.getByText('FAKE-REPLY: the second claude turn')).toBeVisible({ timeout: 30_000 });
    await expect(() => {
      const c = card(first);
      expect(c?.identity?.providerId).toBe('claude-code');
      expect(c?.nativeSessionId).toBe(claudeId);
      expect(c?.conversations?.['fake-acp']?.nativeSessionId).toBeTruthy();
      expect(c?.aiSwitches?.map((m) => `${m.from?.providerId}>${m.to?.providerId}`)).toEqual([
        'claude-code>fake-acp',
        'fake-acp>claude-code',
      ]);
    }).toPass({ timeout: 15_000 });
    await first.close();

    // ── a relaunch keeps it all ─────────────────────────────────────────────
    a = await launchApp({ home: first.home, env: { SWITCHBOARD_FAKE_PROVIDER: 'both' } });
    const w2 = a.window;
    await expect(w2.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await expect(w2.locator('[data-testid="composer-ai"]')).toHaveAttribute('data-provider', 'claude-code', {
      timeout: 25_000,
    });
    const kept = w2.locator('[data-ai-switch-divider][data-from="fake-acp"]');
    await expect(kept).toBeVisible({ timeout: 25_000 });
    // WHERE the switch happened: after the first turn, before the second
    const order = await w2.evaluate(() => {
      const all = Array.from(document.querySelectorAll('[data-ai-switch-divider], [data-feed-block="user"]'));
      return all.map((el) => (el.hasAttribute('data-ai-switch-divider') ? 'DIVIDER' : (el.textContent ?? '').trim()));
    });
    const at = order.indexOf('DIVIDER');
    expect(order.slice(0, at).some((t) => t.includes('the first claude turn'))).toBe(true);
    expect(order.slice(at + 1).some((t) => t.includes('the second claude turn'))).toBe(true);
  });

  test('a switch while a turn is running ASKS first — Cancel keeps the turn running', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'both' } });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await expect(w.locator('[data-testid="composer-ai"]')).toHaveAttribute('data-provider', 'claude-code', {
      timeout: 25_000,
    });

    // a turn that never ends
    await send(w, '!hang');
    await pollAsync(
      async () => ((await sessionStatuses(a!)).get(title) === 'working' ? true : null),
      'the session to be working'
    );

    await switchTo(w, 'fake-acp');
    const ask = w.locator('[data-ai-switch-confirm]');
    await expect(ask).toBeVisible({ timeout: 15_000 });
    await expect(ask).toContainText('Switching stops the current turn. Switch anyway?');
    // the next Enter lands on "no"
    await expect(w.locator('[data-ai-switch-confirm-cancel]')).toBeFocused();
    await expect(w.locator('[data-ai-switch-confirm-ok]')).toBeDisabled();
    await w.keyboard.press('Enter');
    await expect(ask).toHaveCount(0);
    await w.keyboard.press('Escape');
    await expect(w.locator('[data-testid="ai-switch-menu"]')).toHaveCount(0);
    // nothing moved: still Claude, still working
    expect((await sessionStatuses(a)).get(title)).toBe('working');
    await expect(w.locator('[data-testid="composer-ai"]')).toHaveAttribute('data-provider', 'claude-code');

    // …and the yes does switch
    await switchTo(w, 'fake-acp');
    await expect(ask).toBeVisible({ timeout: 15_000 });
    await expect(w.locator('[data-ai-switch-confirm-ok]')).toBeEnabled({ timeout: 5_000 });
    await w.locator('[data-ai-switch-confirm-ok]').click();
    await expect(w.locator('[data-testid="composer-ai"]')).toHaveAttribute('data-provider', 'fake-acp', {
      timeout: 25_000,
    });
  });
});
