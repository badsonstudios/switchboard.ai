// The Direct (stream-json) transport's CORE TURN LOOP, driven through the real
// app: a prompt goes in, the turn runs to completion, the Feed renders it from
// typed messages, the CLI's own slash-command list arrives, and the stop button
// stops it.
//
// SCOPE — READ THIS BEFORE ADDING A TEST HERE (#626). This file used to be the
// transport omnibus: 1,588 lines and fourteen `describe`s over six unrelated
// concerns, under a header that still claimed only "P2-E18-08a — a real stream
// session runs". It was split by concern, move-only, and the family is now:
//
//   stream.spec.ts              THIS FILE — the turn loop itself
//   stream-transport.spec.ts    which transport a card is on, switching it, and
//                               the Terminal tab's honest degradation
//   stream-resume.spec.ts       a Direct conversation surviving a relaunch
//   stream-permissions.spec.ts  gated calls on Direct, and the attention they
//                               must NOT raise
//   stream-trust.spec.ts        the folder-trust setting's reach
//   stream-approval.spec.ts     the inline approval bar on Direct (P2-E18-14)
//   stream-attention.spec.ts    attention routing on Direct (P2-E18-14)
//   stream-feed.spec.ts         tool boxes and feed rendering on Direct
//
// A new stream e2e goes in whichever of those names it. It goes HERE only if it
// is about the loop itself: prompt in, stream out, turn ends.
//
// Shared setup (`tempProjectFolder`, `teardown`) is in
// `fixtures/stream-session.ts` — five files need it now, so it is imported
// rather than copied five times.
//
// TRANSPORT SCOPE (P2-E18-18, #404): Direct, except "a PTY session keeps the
// curated list", which is the deliberate control for the Direct assertion above
// it. It carries no `[pty]` tag — a pre-existing inconsistency with the
// convention in `launchApp` (`fixtures/app.ts`), not something the split
// introduced.
//
// Uses the stream-json fake (`SWITCHBOARD_FAKE_PROVIDER=stream`), so it needs
// no `claude` login and no network — the same property the PTY fake gives the
// rest of the suite.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  expectTurnCompleted,
  expectTurnStillRunning,
  launchApp,
  LaunchedApp,
} from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

// The net for the last test's stragglers: by now every app in this file is
// gone, so a folder that was merely late to unlock goes on this pass.
test.afterAll(async () => teardown());

test.describe('a stream-json session (P2-E18-08a)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

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

    // a `done` event on the attention queue is the state machine reporting a
    // `result` message off the stream — which proves the whole chain (see
    // `turnCompleted`).
    await expectTurnCompleted(w);
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
    await expect(() => {
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
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

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
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

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
    await expectTurnCompleted(w);

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
    // the dual-capable fake, asked for the PTY. Asking is now REQUIRED: until
    // #381 a session that asked for nothing got the PTY, and this test relied on
    // that silence. Direct is the default now, so a test about the PTY has to
    // say PTY — the env is the app-wide way to say it.
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
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
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

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

// P2-E18-10 (#140) — the Feed reads the stream, not the transcript.
//
// Both of these are chosen so that the transcript CANNOT be the source: the
// fake writes no JSONL line for either turn, exactly as the real CLI does not.
// A test whose text could have come from either place would prove nothing.
test.describe('the Feed is built from typed messages (P2-E18-10)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

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
    await expectTurnStillRunning(w);
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

    // THE OUTPUT IS ON SCREEN, WITH NO CLICK — and scoped to `.feed-md`, the
    // assistant-prose renderer, so it can only pass by rendering as its own
    // visible block. A loose page-text match would also be satisfied by the
    // text sitting inside a collapsed container, which is the failure this
    // assertion exists to rule out.
    await expect(
      w.locator('.feed-md', { hasText: 'LOCAL-OUTPUT for /usage' })
    ).toBeVisible({ timeout: 30_000 });
    // …and the turn still completed, as it always did — the done-sound played
    // even when the text did not appear, which is what made the bug confusing
    await expectTurnCompleted(w);
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
