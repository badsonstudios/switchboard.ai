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

// P2-E18-09 — the composer's command list comes from the CLI itself.
//
// `CLAUDE_BUILTIN_COMMANDS` is 40 hand-curated builtins that the file itself
// calls "version-volatile by nature… a maintenance chore". In Direct mode the
// CLI advertises its real set (S-10: 59 entries, including this machine's own
// `/startup` — commands no curated list could have contained).
//
// The assertion that matters is the NEGATIVE one. `curated-only` exists in the
// fake adapter's static list and NOT in its `init`, purely so this test can
// tell "the CLI's list replaced ours" from "the two were merged" — which the
// old fake could not, its fallback being a strict subset of what it advertised.
test.describe('slash commands come from the CLI in Direct mode (P2-E18-09)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the curated list is a fallback, and the first turn replaces it', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // BEFORE any turn: the curated list, and this is the normal state rather
    // than a race. The CLI emits nothing at spawn (S-11 measured `init`
    // arriving 10-20ms AFTER a send we made ourselves), so a Direct session
    // genuinely has no list until its first prompt.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('/');
    await expect(w.getByText('/curated-only', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('/fake-only', { exact: true })).toHaveCount(0);

    // send a turn, which is what makes the CLI announce itself
    await box.fill('hello stream');
    await box.press('Enter');
    await expect(w.getByText('Done.')).toBeVisible({ timeout: 30_000 });

    // AFTER: the CLI's own list. `fake-only` is a command no scan could have
    // found, and `curated-only` is gone — replaced, not merged.
    await box.click();
    await box.pressSequentially('/');
    await expect(w.getByText('/fake-only', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('/curated-only', { exact: true })).toHaveCount(0);
    // and what we DO know about a survivor survives with it: `init` carries
    // bare names, so this description can only have come from our own scan
    await expect(w.getByText('Clear conversation history')).toBeVisible();
  });

  // The second payload that carries commands, and the one we have never seen in
  // production: object-shaped, with descriptions, arriving mid-session when the
  // CLI's command set changes (a plugin installed, a command file added).
  //
  // `/fake-only` disappearing is what makes this test worth having. The fake
  // emits `init` at the START of every turn, so the list this replaces arrived
  // milliseconds earlier in the very same turn — nothing but `commands_changed`
  // being consumed can produce that outcome.
  test('commands_changed replaces the list mid-session', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!commands');
    await box.press('Enter');
    await expect(w.getByText('commands changed')).toBeVisible({ timeout: 30_000 });

    await box.click();
    await box.pressSequentially('/');
    await expect(w.getByText('/just-installed', { exact: true })).toBeVisible({ timeout: 15_000 });
    // the same turn's `init` list is gone, so this really is the later message
    await expect(w.getByText('/fake-only', { exact: true })).toHaveCount(0);
    // and this payload carries its OWN descriptions, unlike init's bare names
    await expect(w.getByText('Arrived mid-session')).toBeVisible();
  });

  test('a PTY session keeps the curated list', async () => {
    const folder = tempProjectFolder();
    // the dual-capable fake, asked for nothing — so it runs on the PTY
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('/');
    await expect(w.getByText('/curated-only', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('/fake-only', { exact: true })).toHaveCount(0);
  });
});

// #154 — the stop button did nothing in Direct mode.
//
// It wrote Esc to the PTY unconditionally, and a stream session has no PTY, so
// the write was a silent no-op. Dan reproduced it every time: submit a prompt,
// click stop repeatedly, watch the turn run to completion anyway.
test.describe('the stop button actually stops (#154)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('stopping a Direct-mode turn interrupts it', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // `!hang` starts a turn and never finishes it, which is the only way to
    // hold a session in `working` — the one state the stop button renders in.
    // `!perm` cannot serve: it moves the session to `needs-permission`, which
    // is precisely why the first version of this test could not find the
    // button at all.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!hang');
    await box.press('Enter');
    await expect(w.getByText(/working on it/)).toBeVisible({ timeout: 30_000 });

    // by TITLE, not role-name: the button's content is the icon glyph, so its
    // accessible name is the glyph, not the word "stop"
    await w.getByTitle(/Stop Claude/i).first().click();

    // the fake reports an interrupted turn rather than running on for ever
    await expect(w.getByText('INTERRUPTED')).toBeVisible({ timeout: 30_000 });
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

  // Dan hit this within minutes of the switch working: a freshly restarted
  // Direct session showed "Claude is showing a start-up dialog … appear only in
  // the terminal" over an [Open Terminal] button — next to a Terminal tab that
  // correctly said there was no terminal. Two surfaces in one window
  // contradicting each other.
  //
  // TWO bugs behind it. The bar had no notion of transport, and every branch of
  // it routes to a terminal a stream session does not have. And the session was
  // genuinely stuck reporting `starting`, because transport-ready was deferred
  // by a tick while the renderer learns the session id from a much slower IPC
  // response — so the only status push it would ever get was filtered out for
  // an id nobody knew yet.
  test('a restarted Direct session does not offer a terminal it does not have', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('button', { name: '⋯' }).first().click();
    await w.getByRole('button', { name: /switch to Direct/i }).click();
    await w.getByRole('button', { name: /Restart session now/i }).click();

    // the Terminal tab is honest about there being no terminal...
    await w.getByRole('button', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });

    // ...and nothing else in the window contradicts it. The bar's grace period
    // is 8s, so this has to outlast it to mean anything.
    await w.waitForTimeout(10_000);
    await expect(w.getByText(/start-up dialog/i)).toHaveCount(0);
    await expect(w.getByRole('button', { name: /Open Terminal/i })).toHaveCount(0);
  });

  // The path Dan took, and the one that was still broken after the restart
  // button worked: he switched to Direct, used it successfully, closed the APP,
  // reopened — and was back on Terminal.
  //
  // Cause: the create-time card write rebuilt the persisted record field by
  // field, so `transport` was dropped on EVERY session start, including the one
  // at launch. Same defect shape as `reason` vanishing from the approval queue
  // earlier the same day. Must run against the BUILT app, like the theme
  // relaunch test, because that is where the real persistence path lives.
  test('the choice survives a relaunch of the whole app', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const first = a;
    await expect(first.window.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await first.window.getByRole('button', { name: '⋯' }).first().click();
    await first.window.getByRole('button', { name: /switch to Direct/i }).click();
    await first.window.getByRole('button', { name: /Restart session now/i }).click();
    // it really is in Direct before we quit
    await first.window.getByRole('button', { name: 'Terminal' }).first().click();
    await expect(first.window.getByText('No terminal for this session')).toBeVisible({
      timeout: 30_000,
    });
    await first.close();

    // Same profile, fresh process — and deliberately NO seedFolder. Seeding
    // again creates a SECOND card, which is what my first attempt did: two
    // sessions, and the assertion landed on the wrong one.
    a = await launchApp({ home: first.home, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    await expect(a.window.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await a.window.getByRole('button', { name: 'Terminal' }).first().click();
    await expect(a.window.getByText('No terminal for this session')).toBeVisible({
      timeout: 30_000,
    });
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

// P2-E18-10 (#140) — the Feed reads the stream, not the transcript.
//
// Both of these are chosen so that the transcript CANNOT be the source: the
// fake writes no JSONL line for either turn, exactly as the real CLI does not.
// A test whose text could have come from either place would prove nothing.
test.describe('the Feed is built from typed messages (P2-E18-10)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('assistant text appears token by token, before the message is complete', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // `!partial` emits three text deltas and then stops: no `assistant`
    // message, no `result`, no transcript line. The only way this text can be
    // on screen is partial-message rendering.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!partial');
    await box.press('Enter');

    await expect(w.getByText(/HALF-WRITTEN-SENTENCE/)).toBeVisible({ timeout: 30_000 });
    // and the turn is genuinely still running while we can read it
    await expect(w.getByText('Done.')).toHaveCount(0);
  });

  // #156, measured in `spike/findings/s-11-local-slash-commands.md`. `/usage`
  // displayed NOTHING in the Session view: the CLI emits it on the stream as an
  // ordinary assistant turn, but records it in the JSONL as
  // `system`/`local_command` with no assistant entry at all — and the Feed read
  // the JSONL. The fake reproduces both halves of that divergence.
  test('a local slash command\'s output renders (#156)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // TYPED THE WAY A USER TYPES IT, and ONE Enter. This test used to press
    // Escape first, to get the autocomplete popup out of the way — and that
    // workaround is what let the real bug ship. Dan hand-tested PR #163 and
    // found EVERY slash command dead in Direct mode: the popup claimed Enter to
    // confirm a completion, so `/usage` + Enter became `/usage ` and ran
    // nothing. A test that teaches itself the unnatural keystroke cannot catch
    // the natural one failing.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('/usage');
    // The popup really is OPEN and offering this exact command — asserted via
    // its DESCRIPTION, because `/usage` matches the textarea's own value too
    // and an ambiguous locator here would let the test pass with no popup at
    // all, i.e. without ever reaching the code #163 broke.
    await expect(w.getByText('Show subscription usage')).toBeVisible({ timeout: 15_000 });

    await box.press('Enter');

    // ONE Enter sent it: the composer is empty, not sitting on `/usage `
    await expect(box).toHaveValue('', { timeout: 15_000 });

    // the output, which the transcript-driven Feed dropped on the floor
    await expect(w.getByText(/LOCAL-OUTPUT for \/usage/)).toBeVisible({ timeout: 30_000 });
    // …and the turn still completed, as it always did — the done-sound played
    // even when the text did not appear, which is what made the bug confusing
    await expect(w.getByText('Done.')).toBeVisible({ timeout: 30_000 });
  });

  test('the user\'s own prompt still renders, off the replayed user message', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('remember this prompt');
    await box.press('Enter');

    // `exact`, because the reply quotes the prompt back and a substring match
    // would find both — which is the same trap the duplicate check below is for
    const pill = w.getByText('remember this prompt', { exact: true });
    await expect(pill).toBeVisible({ timeout: 30_000 });
    // ONE copy: the stream is the only source now, and a session whose watcher
    // still derived blocks from the transcript would show every block twice
    await expect(pill).toHaveCount(1);
    await expect(w.getByText(/FAKE-REPLY: remember this prompt/)).toHaveCount(1);
  });
});
