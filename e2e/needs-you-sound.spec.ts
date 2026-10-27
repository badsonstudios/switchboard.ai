// The needs-you cue (#1267): a session you are NOT in that asks for an
// approval or asks a question, while switchboard is the window you are using,
// plays a sound of its own — and an approval plays it once more with a minute
// left on its clock.
//
// Real app, because the chain crosses both processes: the window reports which
// card is in front, main holds the request and knows its deadline, the rules
// engine decides, and the sink plays. The unit tests own the matrix.
//
// NOTHING HERE MAKES A NOISE. `launchApp` sets `SWITCHBOARD_MUTE_AUDIO=1`: the
// sink logs and sends nothing, and the cue is proven through that log line
// exactly as `sounds.spec.ts` proves the per-session cue.
//
// `pretendForeground` is called on purpose (see its header): the rule only
// runs while switchboard is the window you are using, which since #1468 is the
// OS's answer (`src/main/foreground.ts`), not Electron's `isFocused()`. A
// Playwright run cannot honestly take the desktop foreground, so the spec
// states the precondition. `bringToFront` still activates the window, for
// the window's own report of the card in front.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  answerHeldPermissions,
  bringToFront,
  findFile,
  pretendForeground,
  launchApp,
  LaunchedApp,
  openSettingsTab,
  closeSettings,
  permissionHolder,
  poll,
  streamingQuestionHolder,
  tempProjectFolder,
} from './fixtures/app';

interface CueLine {
  sound: string;
  taken: boolean;
  cardId: string;
  kind: string;
  reason: string;
}

/** Every app-log line carrying this message, raw. */
function logLines(home: string, msg: string): string[] {
  const f = findFile(home, 'switchboard.log');
  if (!f) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.includes(`"${msg}"`));
}

function cues(home: string): CueLine[] {
  return logLines(home, 'needs-you sound fired').map((l) => JSON.parse(l) as CueLine);
}

const row = (w: Page, title: string) => w.locator('nav .rail-row').filter({ hasText: title });

async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const name = path.basename(dir);
  await expect(row(a.window, name)).toBeVisible({ timeout: 25_000 });
  return name;
}

async function twoSessions(a: LaunchedApp, first: string): Promise<string> {
  await expect(row(a.window, first)).toBeVisible({ timeout: 25_000 });
  return addSession(a);
}

async function cardIdOf(a: LaunchedApp, title: string): Promise<string> {
  const cards = await a.window.evaluate(() => window.switchboard.sessions.cards());
  return cards.find((c) => c.title === title)!.cardId;
}

/** The last card the window told main is in front (a `rules` debug line). */
function lastFrontReport(home: string): string | null {
  const lines = logLines(home, 'front card reported');
  return lines.length ? (JSON.parse(lines[lines.length - 1]) as { cardId: string }).cardId : null;
}

/** Stand on this session, in a focused window, and wait until main knows. */
async function standOn(a: LaunchedApp, title: string): Promise<void> {
  await row(a.window, title).click();
  await bringToFront(a, 'main');
  await pretendForeground(a, 'main');
  const id = await cardIdOf(a, title);
  await poll(() => (lastFrontReport(a.home) === id ? true : null), 15_000);
}

/** `standOn` waits for main's debug line instead of sleeping, so it needs it written. */
const DEBUG_RULES = { SWITCHBOARD_DEBUG: 'rules' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('the needs-you cue (#1267)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('rings for a session you are not in, and not for the one you are in', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DEBUG_RULES });
    const first = path.basename(folder);
    const second = await twoSessions(a, first);
    const firstId = await cardIdOf(a, first);
    const secondId = await cardIdOf(a, second);

    // The one you are IN asks first: its approval bar is in front of you, so
    // no cue.
    await standOn(a, second);
    await permissionHolder(a)(second);
    await expect(row(a.window, second)).toHaveAttribute('data-needs-approval', 'true', {
      timeout: 20_000,
    });

    // Then the OTHER one asks: that one rings.
    await permissionHolder(a)(first);
    const fired = await poll(() => {
      const c = cues(a.home).filter((l) => l.cardId === firstId);
      return c.length > 0 ? c : null;
    }, 20_000);
    expect(fired[0]).toMatchObject({ sound: 'needs-you', taken: true, reason: 'event' });
    // …and by now the first hold's cue, had there been one, is long in the log
    expect(cues(a.home).filter((l) => l.cardId === secondId)).toEqual([]);

    expect(await answerHeldPermissions(a)).toBe(2);
  });

  test('rings for a question too, and the Settings switch turns it off', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DEBUG_RULES });
    const first = path.basename(folder);
    const second = await twoSessions(a, first);
    const firstId = await cardIdOf(a, first);

    await standOn(a, second);
    await streamingQuestionHolder(a)(first);
    await poll(() => {
      const c = cues(a.home).filter((l) => l.cardId === firstId);
      return c.length > 0 ? c : null;
    }, 20_000);
    expect(await answerHeldPermissions(a, 'deny')).toBe(1);

    // Off, in Settings ▸ Notifications. ON is the shipped state, so the box
    // starts ticked — which is also the proof the default is on.
    const d = await openSettingsTab(a.window, 'attention');
    const box = d.locator('[data-settings-field="needs-you-sound"]');
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(box).not.toBeChecked();
    await closeSettings(a.window);

    const before = cues(a.home).length;
    await standOn(a, second);
    await permissionHolder(a)(first);
    await expect(row(a.window, first)).toHaveAttribute('data-needs-approval', 'true', {
      timeout: 20_000,
    });
    await sleep(1_500);
    expect(cues(a.home)).toHaveLength(before);
    expect(await answerHeldPermissions(a)).toBe(1);
  });

  test('an approval rings once more with a minute left; answered first, it does not', async () => {
    // The real hold is five minutes. The lead is moved (non-packaged builds
    // only) so "a minute left" arrives about four seconds after the ask.
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { ...DEBUG_RULES, SWITCHBOARD_NEEDS_YOU_LEAD_MS: '296000' },
    });
    const first = path.basename(folder);
    const second = await twoSessions(a, first);
    const firstId = await cardIdOf(a, first);
    const mine = () => cues(a.home).filter((l) => l.cardId === firstId);

    await standOn(a, second);
    await permissionHolder(a)(first);
    const both = await poll(() => {
      const c = mine();
      return c.length >= 2 ? c : null;
    }, 25_000);
    expect(both.map((l) => l.reason)).toEqual(['event', 'reminder']);
    expect(await answerHeldPermissions(a)).toBe(1);

    // Ask again and answer at once: the first cue rings, the repeat never does.
    await permissionHolder(a)(first);
    await poll(() => (mine().length >= 3 ? true : null), 20_000);
    expect(await answerHeldPermissions(a)).toBe(1);
    await sleep(7_000);
    expect(mine().map((l) => l.reason)).toEqual(['event', 'reminder', 'event']);

    // A question has no clock, so it never repeats.
    await streamingQuestionHolder(a)(first);
    await poll(() => (mine().length >= 4 ? true : null), 20_000);
    await sleep(7_000);
    expect(mine().map((l) => l.reason)).toEqual(['event', 'reminder', 'event', 'event']);
    expect(await answerHeldPermissions(a, 'deny')).toBe(1);
  });
});
