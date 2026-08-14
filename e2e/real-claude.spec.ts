// The REAL-CLAUDE Playwright lane (Dan's ask, 2026-07-22): drives an actual
// logged-in claude session through the Session tab — composer prompt in,
// rendered response out. Local-only: needs a logged-in CLI, so it runs ONLY
// with SWITCHBOARD_REAL_E2E=1 (CI keeps the fake provider; the local check
// layer + this spec cover the real-CLI integration).
//
//   SWITCHBOARD_REAL_E2E=1 npx playwright test e2e/real-claude.spec.ts
//
// EVERY TEST IN THIS FILE SPENDS REAL SUBSCRIPTION TOKENS — one model turn
// each, so a whole-file run costs THREE turns. The prompts are deliberately as
// small as a prompt can be ("Reply with exactly: …", no tools, a handful of
// output tokens; measured at ~4 output tokens per turn). Keep it that way: a
// test here that needs a big turn belongs against the fake instead, and a new
// test here needs a reason the fake genuinely cannot serve.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  readWorkspaceFile,
  tempProjectFolder,
  workspaceJsonPath,
} from './fixtures/app';

test.describe('real claude end-to-end (opt-in)', () => {
  test.skip(process.env.SWITCHBOARD_REAL_E2E !== '1', 'set SWITCHBOARD_REAL_E2E=1 (needs a logged-in claude)');
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('composer prompt -> real claude -> rendered response in the Session tab', async () => {
    test.setTimeout(180_000); // a real model turn takes what it takes
    const folder = tempProjectFolder();
    // Pinned to the PTY (#381 made Direct the default): the assertion at the
    // bottom of this test reads TERMINAL text, so a Direct session would have
    // nothing to read. The Direct half of the same journey is the test below —
    // this one stays as the PTY's own coverage rather than being rewritten,
    // because both transports ship and both are somebody's daily driver.
    a = await launchApp({ seedFolder: folder, realClaude: true, env: { SWITCHBOARD_TRANSPORT: 'pty' } });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 30_000 });

    // wait for the CLI to be READY (SessionStart hook -> idle pill) before
    // prompting — keystrokes into a booting TUI go nowhere
    await expect(w.getByText('idle', { exact: true }).first()).toBeVisible({ timeout: 60_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.fill('Reply with exactly: REAL_E2E_OK and nothing else, no tools.');
    await box.press('Enter');

    // the composer wrote to the real TUI and the model answered — assert via
    // the Terminal (PTY text). KNOWN ANOMALY (2026-07-23, tracked in
    // PROGRESS): claude 2.1.218 does not write conversation .jsonl files
    // under an isolated temp home (session-env/memory appear, transcript
    // doesn't), so Session-view block assertions are deferred until that's
    // understood — real-home usage writes transcripts normally.
    await w.getByRole('tab', { name: 'Terminal' }).click();
    await expect(w.getByText(/REAL_E2E_OK/).first()).toBeVisible({ timeout: 120_000 });
  });
});

// #384 — the DEFAULT transport, against the real CLI.
//
// Since #381 a brand-new session comes up in Direct, so the path above is no
// longer the one a new user is on: every real-CLI assertion in this file was
// about a transport most sessions will never use. The whole stream stack was
// exercised only by the fake (`SWITCHBOARD_FAKE_PROVIDER=stream`), which
// answers the protocol it was written from — a fake cannot tell us the real
// CLI still accepts the flag list in `providers/claude.ts`, still emits
// `stream_event` deltas for a plain text turn, or still ends the turn with a
// `result`. This test is the only thing in the suite that can.
//
// It asserts through the SESSION VIEW, which the PTY test above cannot: the
// Feed is built from typed stream messages (P2-E18-10), not from the JSONL
// transcript, so the temp-home transcript anomaly that blocks the test above
// does not apply on this transport.
test.describe('real claude on the DEFAULT transport (#384, opt-in)', () => {
  test.skip(process.env.SWITCHBOARD_REAL_E2E !== '1', 'set SWITCHBOARD_REAL_E2E=1 (needs a logged-in claude)');
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close, so a throw here cannot double-close
    await launched?.cleanup();
  });

  test('a default session streams a real reply into the card', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    // NO `SWITCHBOARD_TRANSPORT` — the absence is the point. The fixture
    // scrubs an inherited one (#381), so whatever this session comes up on is
    // the shipped default.
    a = await launchApp({ seedFolder: folder, realClaude: true });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 30_000 });

    // It really IS Direct. Without this the whole test would pass just as well
    // against a PTY session that happened to render its reply, and the default
    // could silently revert with nothing here to notice.
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();

    // NO readiness wait, unlike the PTY test above, and that is a real
    // difference rather than an omission: a Direct prompt is a line on stdin,
    // which the OS buffers until the CLI reads it. Measured against
    // claude 2.1.226 while writing this (scratch probe, #384): a frame written
    // 5s BEFORE the CLI emitted its `init` was still answered normally. The
    // PTY's "keystrokes into a booting TUI go nowhere" problem does not exist
    // on this transport, and a test that waited anyway would hide that.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('Reply with exactly: REAL_DIRECT_OK and nothing else. No tools.');
    await box.press('Enter');

    // THE REPLY, in the card. Scoped to the ASSISTANT block: the prompt
    // contains the token too and renders as its own `user` block, so an
    // unscoped match would be satisfied by the echo of our own text and would
    // pass with no model reply at all.
    await expect(
      w.locator('[data-feed-block="assistant"]', { hasText: 'REAL_DIRECT_OK' })
    ).toBeVisible({ timeout: 120_000 });
    // and it came from the CLI, not the fake. The fake QUOTES THE PROMPT BACK,
    // so the assertion above is satisfied by `FAKE-REPLY: Reply with exactly:
    // REAL_DIRECT_OK …` — this is the line that says which provider answered.
    // (`launchApp` scrubs `SWITCHBOARD_FAKE_PROVIDER` for a real launch since
    // #384; this asserts the outcome rather than trusting the scrub.)
    await expect(w.getByText(/FAKE-REPLY/)).toHaveCount(0);

    // ...and the turn COMPLETED. "Done." is the Events panel reporting a
    // `result` message off the stream, i.e. the CLI closed the turn rather
    // than the text merely arriving — the lifecycle half of what the PTY test
    // gets from its idle pill.
    await expect(w.getByText('Done.').first()).toBeVisible({ timeout: 60_000 });

    // #404: a Direct card persists its `--resume` identity. This pins the
    // OUTCOME, not the writer — against the real CLI both writers are live
    // (hooks fire under stream-json, measured 2026-08-10, AND `system:init`
    // carries the id); the writer-specific proof is the fake-stream relaunch
    // e2e, where SessionStart never fires. The day the real CLI stops
    // supplying the id either way, this is the red run. Save is debounced —
    // poll, don't race.
    await expect(() => {
      const card = readWorkspaceFile(a!.home).sessions?.[0];
      expect(card?.nativeSessionId).toMatch(/^[0-9a-f][0-9a-f-]{30,}$/i);
    }).toPass({ timeout: 15_000 });
  });

  // #384's second half: "ask trust" (auto-trust OFF) meeting Direct.
  //
  // The worry, raised by #381's worker: Claude Code draws its trust question in
  // its own TUI, a Direct session has no TUI, so an untrusted folder might sit
  // there for ever waiting for an answer nothing can give.
  //
  // MEASURED, and the worry does not survive contact (claude 2.1.226,
  // 2026-08-10, both at the bare CLI and here): in `--input-format stream-json`
  // mode the CLI does not ask AT ALL. There is no trust prompt on this
  // transport — not on the stream, not anywhere — and the turn runs normally in
  // a folder that appears in no `projects` key of `~/.claude.json`. So there is
  // nothing for us to guard: no hang to break out of, and no question to
  // forward. What there IS is a promise the CLI quietly does not keep, which is
  // why this is a TEST and not a paragraph: "ask trust" is inert in Direct mode,
  // and the day that changes, this is what says so.
  //
  // The setting is pre-seeded into the workspace file rather than clicked,
  // because the seeded session is created during boot — by the time the
  // titlebar chip is on screen the folder has already been trusted, and there
  // is no second untrusted folder to point a card at from in here.
  test('an untrusted folder with ask-trust on still runs — the CLI never asks', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    // Made here rather than by `launchApp`, because the workspace file has to
    // exist BEFORE the first launch reads it. `cleanup()` registers and removes
    // it, exactly as it does for a home the fixture made itself.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
    const wsPath = workspaceJsonPath(home);
    fs.mkdirSync(path.dirname(wsPath), { recursive: true });
    fs.writeFileSync(wsPath, JSON.stringify({ version: 1, sessions: [], groups: [], autoTrust: false }));

    a = await launchApp({ home, seedFolder: folder, realClaude: true });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 30_000 });

    // the setting really is off — the chip is the one surface that states it,
    // and a mis-seeded file would otherwise leave this an ordinary Direct test
    await expect(w.getByText('🔒 ask trust')).toBeVisible({ timeout: 15_000 });

    // ...and the folder really is untrusted. THIS MOMENT is the one that
    // proves it: `sessions:create` calls `ensureTrusted` before it spawns
    // anything, so a visible card means that call has already been made or
    // skipped. An acceptance absent here is an acceptance that was never
    // written, not one that has yet to be.
    //
    // What this line pins against the REAL CLI is that the CLI does not accept
    // the folder on its own — the app is not writing here either way. Since the
    // #397 follow-up the app would not write with auto-trust ON either (the
    // pre-write is gated on the Terminal transport); that half is pinned at the
    // ipc seam in `src/main/sessions/ipc.test.ts`, where it costs no tokens.
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(cfg.projects?.[folder.replace(/\\/g, '/')]?.hasTrustDialogAccepted ?? false).toBe(false);

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('Reply with exactly: REAL_TRUST_OK and nothing else. No tools.');
    await box.press('Enter');

    // it answers. Not "it eventually errors", not "it shows a prompt we
    // forward" — the untrusted folder is simply used.
    await expect(
      w.locator('[data-feed-block="assistant"]', { hasText: 'REAL_TRUST_OK' })
    ).toBeVisible({ timeout: 120_000 });
    await expect(w.getByText(/FAKE-REPLY/)).toHaveCount(0); // see the test above
    await expect(w.getByText('Done.').first()).toBeVisible({ timeout: 60_000 });
  });
});
