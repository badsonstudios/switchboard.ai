// The handoff on a switch (E40 item 12, #1295): the AI a card switches to for
// the first time is BRIEFED — handed the mechanical §5.5 summary of the
// conversation it did not see, as its opening prompt — and the Feed says so,
// with "see what it was told" opening the exact bytes it was sent.
//
// `SWITCHBOARD_FAKE_PROVIDER=both`: the Claude fake (the default, so the seeded
// card starts on it) and the fake ACP agent beside it. The fake ACP agent
// answers every prompt with `ACP reply to: <the prompt>`, so its FIRST reply
// starting with the briefing's heading is the observable that the briefing
// went in as that AI's opening context.
//
// What only this can see: the real hook wiring in `main/index.ts`, the
// briefing read off the fake's real JSONL, the file kept under userData, the
// divider updated live, the viewer, and all of it across a relaunch.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, readWorkspaceFile, workspaceJsonPath } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

test.afterAll(async () => teardown());

async function send(w: Page, text: string): Promise<void> {
  const box = w.getByPlaceholder(/^Message .+…$/);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

async function switchTo(w: Page, key: string): Promise<void> {
  await w.locator('[data-testid="composer-ai"]').click();
  const menu = w.locator('[data-testid="ai-switch-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator(`[data-ai-row="${key}"]`).click();
}

const card = (a: LaunchedApp) => {
  try {
    return readWorkspaceFile(a.home).sessions?.[0];
  } catch {
    return undefined;
  }
};

/** The kept briefing, read straight off the disk — what the viewer must show. */
const keptBriefing = (a: LaunchedApp, ref: string): string =>
  fs.readFileSync(path.join(path.dirname(workspaceJsonPath(a.home)), 'briefings', ...ref.split('/')) + '.md', 'utf8');

/** Open "see what it was told", read the text, close it with Escape. */
async function whatItWasTold(w: Page): Promise<string> {
  const link = w.locator('[data-ai-switch-divider][data-to="fake-acp"] [data-ai-switch-see-briefing]');
  await link.click();
  const dialog = w.locator('[data-testid="briefing-dialog"]');
  await expect(dialog).toBeVisible();
  const pre = dialog.locator('[data-briefing-text]');
  await expect(pre).toBeVisible({ timeout: 10_000 });
  const text = (await pre.textContent()) ?? '';
  await w.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(link).toBeFocused();
  return text;
}

test.describe('the handoff on a switch (#1295)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await teardown(launched);
  });

  test('Claude → Fake ACP is briefed, the divider says so live, and the exact text survives a relaunch; switching back is a resume', async () => {
    test.setTimeout(240_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'both' } });
    const first = a;
    const w = first.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    const chip = w.locator('[data-testid="composer-ai"]');
    await expect(chip).toHaveAttribute('data-provider', 'claude-code', { timeout: 25_000 });

    // ── two Claude turns ────────────────────────────────────────────────────
    await send(w, 'paint the fence green');
    await expect(w.getByText('FAKE-REPLY: paint the fence green', { exact: true })).toBeVisible({ timeout: 30_000 });
    await send(w, 'and the gate blue');
    await expect(w.getByText('FAKE-REPLY: and the gate blue', { exact: true })).toBeVisible({ timeout: 30_000 });

    // the menu says what a switch hands over
    await chip.click();
    await expect(w.locator('[data-testid="ai-switch-menu"]')).toContainText(
      'Switching hands this card to another AI with a summary of this conversation. Coming back resumes where that AI left off.'
    );
    await w.keyboard.press('Escape');

    // ── the switch: briefed, and the divider says so in THIS run ────────────
    await switchTo(w, 'fake-acp');
    await expect(chip).toHaveAttribute('data-provider', 'fake-acp', { timeout: 25_000 });
    const divider = w.locator('[data-ai-switch-divider][data-to="fake-acp"]');
    await expect(divider).toContainText('→ Fake ACP', { timeout: 25_000 });
    await expect(divider).toContainText('handed a summary of 2 turns', { timeout: 25_000 });
    await expect(divider.locator('[data-ai-switch-see-briefing]')).toHaveText('see what it was told');
    // the other AI's turns are not drawn — one faint line says where they are
    await expect(divider.locator('[data-ai-switch-earlier]')).toContainText('2 earlier turns with');
    await expect(divider.locator('[data-ai-switch-earlier]')).toContainText('switch back to see them');

    // the fake ACP's first reply is to the briefing: it went in as its opening prompt
    await expect(w.getByText(/ACP reply to: # Briefed continuation from .+ to Fake ACP/).first()).toBeVisible({
      timeout: 30_000,
    });
    // …and it is on screen as that AI's first message, once (the manual says so)
    await expect(w.locator('[data-feed-block="user"]').filter({ hasText: 'Briefed continuation' })).toHaveCount(1);

    // ── see what it was told: the exact bytes, as kept ──────────────────────
    const told = await whatItWasTold(w);
    expect(told.startsWith('# Briefed continuation from ')).toBe(true);
    expect(told).toContain('## Goal\n\npaint the fence green\n');
    expect(told).toContain('- and the gate blue');
    expect(told).toContain('This is a briefed continuation, not a resume');
    expect(told).toContain('read `CLAUDE.md`; you read `AGENTS.md`');
    expect(told).toContain('MCP servers, permissions and hooks set up for');
    // the mark on disk (the save is debounced) — and the file it names IS the text shown
    await expect(() => {
      const mark = card(first)?.aiSwitches?.[0];
      expect(mark).toMatchObject({ briefed: true, turnsSummarised: 2 });
      expect(told).toBe(keptBriefing(first, mark!.briefingRef!));
    }).toPass({ timeout: 15_000 });

    // and the AI keeps working on it
    await send(w, 'hello acp');
    await expect(w.getByText('ACP reply to: hello acp', { exact: true })).toBeVisible({ timeout: 30_000 });
    await first.close();

    // ── a relaunch, on the ACP AI: the divider and the same bytes ───────────
    a = await launchApp({ home: first.home, env: { SWITCHBOARD_FAKE_PROVIDER: 'both' } });
    const second = a;
    const w2 = second.window;
    await expect(w2.locator('[data-testid="composer-ai"]')).toHaveAttribute('data-provider', 'fake-acp', {
      timeout: 25_000,
    });
    const kept = w2.locator('[data-ai-switch-divider][data-to="fake-acp"]');
    await expect(kept).toContainText('handed a summary of 2 turns', { timeout: 25_000 });
    expect(await whatItWasTold(w2)).toBe(told);

    // ── switching BACK is a resume, and briefs nothing ──────────────────────
    await switchTo(w2, 'claude-code');
    await expect(w2.locator('[data-testid="composer-ai"]')).toHaveAttribute('data-provider', 'claude-code', {
      timeout: 25_000,
    });
    const back = w2.locator('[data-ai-switch-divider][data-from="fake-acp"]');
    await expect(back).toContainText('picked up where it left off', { timeout: 25_000 });
    await expect(back.locator('[data-ai-switch-see-briefing]')).toHaveCount(0);
    await expect(w2.getByText('FAKE-REPLY: paint the fence green', { exact: true })).toBeVisible({ timeout: 25_000 });
    await expect(() => {
      const marks = card(second)?.aiSwitches ?? [];
      expect(marks).toHaveLength(2);
      expect(marks[1]).toMatchObject({ resumed: true, briefed: false });
      // one briefing on disk: the first switch's
      const dir = path.join(path.dirname(workspaceJsonPath(second.home)), 'briefings');
      expect(fs.readdirSync(dir).flatMap((c) => fs.readdirSync(path.join(dir, c)))).toHaveLength(1);
    }).toPass({ timeout: 15_000 });
    // no Claude turn is a reply to a briefing
    await expect(w2.getByText(/Briefed continuation from .+ to Claude/)).toHaveCount(0);
  });
});
