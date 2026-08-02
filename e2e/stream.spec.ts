// P2-E18-08a — a real stream session runs, driven through the real app.
//
// THE criterion inherited from P2-E18-04, and this is the first point it is
// meetable: before now nothing constructed StreamService, and the composer
// submitted only over the PTY.
//
// Uses the stream-json fake (`SWITCHBOARD_FAKE_PROVIDER=stream`), so it needs
// no `claude` login and no network — the same property the PTY fake gives the
// other 98 specs.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp } from './fixtures/app';

function tempProjectFolder(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stream-e2e-'));
  fs.writeFileSync(path.join(d, 'README.md'), '# stream\n');
  return d;
}

test.describe('a stream-json session (P2-E18-08a)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  // Scoped to what E18-08a actually claims: the turn RUNS and COMPLETES.
  //
  // It deliberately does not assert on the Session view's rendered reply,
  // because the E18-04 fake writes no JSONL transcript and the Feed reads
  // transcripts until E18-10. That is a real gap in the fake — the REAL CLI
  // does write one (S-10) — and it belongs to E18-08b (#149), whose done-when
  // includes "the Feed renders a stream session's turn". Filed, not absorbed.
  test('runs a whole turn: prompt in, turn completes', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      // TWO variables now, and the split matters: the first picks the
      // dual-capable fake, the second ASKS it for stream. The fake used to
      // return a stream recipe unconditionally, which meant nothing could
      // exercise switching — and that is why #153 shipped (#153: the setting
      // could never take effect and no test could have caught it).
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;

    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('hello stream');
    await box.press('Enter');

    // "Done." in the Events panel is the state machine reporting a `result`
    // message off the stream — which proves the whole chain: composer ->
    // submitPrompt -> stdin frame -> the fake -> stdout NDJSON -> decoder ->
    // streamStatusEvent -> the state machine -> the UI.
    await expect(w.getByText('Done.')).toBeVisible({ timeout: 30_000 });
  });

  test('the .claude permission is asked ONCE and honoured', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      // TWO variables now, and the split matters: the first picks the
      // dual-capable fake, the second ASKS it for stream. The fake used to
      // return a stream recipe unconditionally, which meant nothing could
      // exercise switching — and that is why #153 shipped (#153: the setting
      // could never take effect and no test could have caught it).
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;

    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!perm .claude/scripts/coverage.sh');
    await box.press('Enter');

    // our bar, carrying the CLI's OWN prose — a hook payload has no equivalent
    await expect(w.getByText(/sensitive file/)).toBeVisible({ timeout: 30_000 });

    await w.getByRole('button', { name: /allow/i }).first().click();

    // and the file is actually written: the answer was HONOURED, which is the
    // thing the hook path cannot do for `.claude/` (measured 2026-08-01)
    const target = path.join(folder, '.claude', 'scripts', 'coverage.sh');
    await expect(async () => {
      expect(fs.existsSync(target)).toBe(true);
    }).toPass({ timeout: 20_000 });

    // and nothing asks a second time
    await expect(w.getByText(/sensitive file/)).toHaveCount(0);
  });
});

// P2-E18-08b (#149) — the criterion the fake's missing transcript blocked.
//
// The Feed reads TRANSCRIPTS until E18-10 swaps it to typed messages, and the
// real CLI writes one in stream mode (S-10). The fake now does too, so this is
// testable — and it proves the claim that made the migration incremental: the
// transcript stack survives the transport change untouched.
test.describe('the Feed renders a stream session (P2-E18-08b)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a turn appears in the Session view via the existing transcript path', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      // TWO variables now, and the split matters: the first picks the
      // dual-capable fake, the second ASKS it for stream. The fake used to
      // return a stream recipe unconditionally, which meant nothing could
      // exercise switching — and that is why #153 shipped (#153: the setting
      // could never take effect and no test could have caught it).
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;

    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('render me');
    await box.press('Enter');

    // the assistant's reply, rendered as a Session-view block — no code in the
    // feed pipeline changed for this
    await expect(w.getByText(/FAKE-REPLY: render me/)).toBeVisible({ timeout: 30_000 });
  });
});

// P2-E18-08b (#149) — the Terminal tab in a stream session.
test.describe('the Terminal tab degrades honestly (P2-E18-08b)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('says there is no terminal instead of showing an empty black pane', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      // TWO variables now, and the split matters: the first picks the
      // dual-capable fake, the second ASKS it for stream. The fake used to
      // return a stream recipe unconditionally, which meant nothing could
      // exercise switching — and that is why #153 shipped (#153: the setting
      // could never take effect and no test could have caught it).
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('button', { name: 'Terminal' }).first().click();

    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 15_000 });
    // and it says what you GAIN, not only what is missing
    await expect(w.getByText(/permission requests appear in this window/i)).toBeVisible();
  });

  test('a PTY session still gets a real terminal', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder }); // the PTY fake, the default
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('button', { name: 'Terminal' }).first().click();

    await expect(w.getByText('No terminal for this session')).toHaveCount(0);
  });
});

// P2 #153 — THE PATH A PERSON TAKES.
//
// This is the test whose absence is the actual root cause of #153. Everything
// was covered: setTransport was unit-tested for persistence and the pending
// flag, and the stream e2e drove a full session end to end. But the e2e
// launched with stream ALREADY selected by env, so nothing ever walked
// set-it → restart → use-it — and the shipped feature could not take effect at
// all, because the only route to a restart was the card's ✕, which deletes the
// card record and the stored choice with it.
//
// The parts were each verified. The product did not work.
test.describe('switching transport the way a user does (#153)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('set it in the menu, restart from the menu, and the session comes up in the new mode', async () => {
    const folder = tempProjectFolder();
    // the dual-capable fake, asked for NOTHING — so it starts on the PTY, which
    // is what a real user's session does
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // it starts on the terminal
    await w.getByRole('button', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toHaveCount(0);

    // switch it — the label names the CURRENT mode and the action separately
    await w.getByRole('button', { name: '⋯' }).first().click();
    await w.getByRole('button', { name: /switch to Direct/i }).click();

    // it is saved but NOT yet in effect, and it says so
    await expect(w.getByText(/still running on the old one/i)).toBeVisible();

    // the affordance that #153 was missing entirely
    await w.getByRole('button', { name: /Restart session now/i }).click();

    // and now it really is in the new mode
    await w.getByRole('button', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
  });

  test('the choice survives the restart it triggered', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('button', { name: '⋯' }).first().click();
    await w.getByRole('button', { name: /switch to Direct/i }).click();
    await w.getByRole('button', { name: /Restart session now/i }).click();
    await expect(w.getByText(/still running on the old one/i)).toHaveCount(0);

    // reopen the menu: it should now report Direct as the CURRENT mode
    await w.getByRole('button', { name: '⋯' }).first().click();
    await expect(w.getByRole('button', { name: /switch to Terminal/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});
