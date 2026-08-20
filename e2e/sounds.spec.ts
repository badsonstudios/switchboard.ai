// P2-E14-05a — the audio channels, end to end, in a real window.
//
// The unit tests own the matrix (which cue, which sentence, what happens when
// the device is gone). What only a real app can show is that the chain is
// actually joined: a chip in the title bar writes a pref, a hook event from the
// CLI reaches the engine, the engine resolves the live session back to the CARD
// the workspace assigned a cue to, and TWO cards come out ringing differently.
//
// NOTHING HERE MAKES A NOISE. `launchApp` sets `SWITCHBOARD_MUTE_AUDIO=1` on
// every launch: the sink logs and sends nothing, so every fact below is real
// and only the last inch — Chromium's speaker — is skipped. Reading the app LOG
// for main-process facts is the house pattern (`rules.spec.ts`, `approval.spec`).
import { test, expect, Page, Locator } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  blurApp,
  launchApp,
  LaunchedApp,
  findFile,
  hookPoster,
  poll,
  tempProjectFolder,
} from './fixtures/app';

interface CueLine {
  sound: string;
  taken: boolean;
  cardId: string;
  kind: string;
  ruleId: string;
}

interface SpeakLine {
  text: string;
  taken: boolean;
  cardId: string;
  kind: string;
}

function lines<T>(home: string, msg: string): T[] {
  const f = findFile(home, 'switchboard.log');
  if (!f) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.includes(`"${msg}"`))
    .map((l) => JSON.parse(l) as T);
}

const cues = (home: string): CueLine[] => lines<CueLine>(home, 'sound rule fired');
const spoken = (home: string): SpeakLine[] => lines<SpeakLine>(home, 'speak rule fired');

const card = (w: Page, title: string): Locator =>
  w.locator('[data-testid="card-header"]').filter({ hasText: title });

const soundEntry = (scope: Locator): Locator => scope.locator('[data-testid="card-sound"]');

test.describe('per-session sounds and announcements (P2-E14-05a)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('two sessions ring distinguishably, and a chosen cue sticks', async () => {
    const folders = [tempProjectFolder(), tempProjectFolder()];
    const names = folders.map((f) => path.basename(f));
    a = await launchApp({ seedFolder: folders[0] });
    const w = a.window;
    await expect(w.getByText(names[0]).first()).toBeVisible({ timeout: 25_000 });

    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folders[1]);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(names[1]).first()).toBeVisible({ timeout: 25_000 });

    // Opt in. Off by default is the shipped state (E14: every channel is its
    // own opt-in), so this click is also the proof that the chip is the switch.
    await w.locator('[data-testid="session-sounds"]').click();

    const post = await hookPoster(a, 2);
    await post(names[0], { hook_event_name: 'Stop' });
    await post(names[1], { hook_event_name: 'Stop' });

    const fired = await poll(() => {
      const c = cues(a.home);
      return c.length >= 2 ? c : null;
    }, 20_000);

    // The headline done-when: two cards, two different cues, each on its own
    // card — not two lines that happen to exist.
    const byCard = new Map(fired.map((c) => [c.cardId, c.sound]));
    expect(byCard.size).toBe(2);
    expect(new Set(byCard.values()).size).toBe(2);

    const cards = await w.evaluate(() => window.switchboard.sessions.cards());
    const idOf = (title: string): string => cards.find((c) => c.title === title)!.cardId;
    expect(byCard.has(idOf(names[0]))).toBe(true);
    expect(byCard.has(idOf(names[1]))).toBe(true);

    // Now PIN one. Two sessions land as tabs in one dockview group and only the
    // active panel is mounted, so the first card's header has to be selected
    // before it exists in the DOM (the lesson `rules.spec.ts` records).
    await w.getByRole('tab', { name: new RegExp(names[0]) }).click();
    await card(w, names[0]).getByTitle('Session menu').click();
    const entry = soundEntry(card(w, names[0]));
    await expect(entry).toBeVisible({ timeout: 10_000 });
    const before = byCard.get(idOf(names[0]))!;
    await entry.click();
    await w.keyboard.press('Escape');

    // A DIFFERENT kind on purpose: the feed holds one attention entry per
    // session, so a second `Stop` for a session already sitting at `done` is
    // not a new event and would never reach a rule.
    await post(names[0], { hook_event_name: 'UserPromptSubmit' }); // back to working
    await post(names[0], {
      hook_event_name: 'Notification',
      message: 'Claude needs input to continue',
    });
    const after = await poll(() => {
      const mine = cues(a.home).filter((c) => c.cardId === idOf(names[0]));
      return mine.length >= 2 ? mine : null;
    }, 20_000);
    // the cue the user picked, not the one the workspace handed out
    expect(after.at(-1)!.sound).not.toBe(before);
  });

  test('the voice names the session, and falls back to its title', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });

    await w.locator('[data-testid="speak-announcements"]').click();

    // The voice only speaks while the user is not looking at us — the same
    // WHEN_AWAY condition the toast carries, for a different reason (reading
    // out what someone is looking at is slow noise). Asserted, not assumed: a
    // `blur()` that did nothing would leave this test passing for the wrong
    // reason. `blurApp` re-issues it until it takes and throws if it never
    // does — a dropped blur is what #538 was.
    await blurApp(a);

    const post = await hookPoster(a);
    await post(name, { hook_event_name: 'Stop' });

    // FALLBACK first: with no task label to show, the sentence names the
    // session by its title — which is exactly what an auto label switched off
    // leaves behind (`visibleTaskLabel`, unit-covered).
    const first = await poll(() => {
      const s = spoken(a.home);
      return s.length > 0 ? s : null;
    }, 20_000);
    expect(first[0].text).toBe(`${name} is done`);

    // …and with a label, the label — the answer to "what is waiting", which is
    // the whole reason the voice prefers it (§5.11, P2-E7-06).
    const cards = await w.evaluate(() => window.switchboard.sessions.cards());
    const cardId = cards.find((c) => c.title === name)!.cardId;
    await w.evaluate(
      (id) => window.switchboard.sessions.setTaskLabel(id, 'Add markdown preview'),
      cardId
    );
    // A different kind, for the reason recorded in the test above.
    await post(name, { hook_event_name: 'UserPromptSubmit' }); // back to working
    await post(name, {
      hook_event_name: 'Notification',
      message: 'Claude needs input to continue',
    });
    const withLabel = await poll(() => {
      const s = spoken(a.home);
      return s.length > 1 ? s : null;
    }, 20_000);
    expect(withLabel.at(-1)!.text).toBe('Add markdown preview needs your input');
  });
});
