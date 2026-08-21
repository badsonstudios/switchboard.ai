// P2-E18-04 done-when check: the COMPILED fake CLI really speaks stream-json
// over real pipes, driven through the real StreamService and the real adapter
// recipe. Exits 0 on PASS, 1 on FAIL.
//
// The protocol itself is unit-tested in `fake-stream-protocol.test.ts` without
// spawning, because the CI unit job does not run a build. This check covers
// what those cannot: the spawn recipe, the ELECTRON_RUN_AS_NODE delta surviving
// the S-01 scrub, NDJSON over an actual pipe, and the control-channel round
// trip end to end.
//
// IT SENDS WHAT THE APP SENDS (#667). The prompts below are built by the real
// `userMessage()` from `shared/stream-protocol`, not by a local helper. This
// file used to hand-roll its own envelope, which made it a SECOND, silent
// definition of a contract that lives in one place — and one that had already
// drifted: it never carried the `uuid` or `origin` #490 added, so the only
// check that drives the fake over real pipes was exercising a frame the app no
// longer produces. Raw-frame independence was the argument for keeping it, and
// it was weighed rather than waved off: this file's OWN scope list is the four
// items three paragraphs up, and frame construction is not one of them. The
// envelope is pinned independently and thoroughly elsewhere —
// `submit-prompt.test.ts` asserts the whole shape including the uuid and the
// origin, and `fake-stream-protocol.test.ts` keeps a hand-written `userMsg` so
// "a frame without those fields echoes without them" still has a witness that
// owes nothing to the builder. What THIS file is for is proving the real
// envelope survives real pipes, which a stand-in cannot do by construction.
// (The one property the local helper gave away for free — that the id is
// really there — is bought back by an explicit check at the first send.)
//
// Run with: npm run check:fake-stream   (after npm run build)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { asDisplayString } from '../../shared/display-string';
import { StreamService, StreamMessage } from '../transport/stream-service';
import { userMessage } from '../../shared/stream-protocol';
import { fakeStreamAdapter } from './fake-stream';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fake-stream-check-'));
const service = new StreamService();
const seen: StreamMessage[] = [];
const failures: string[] = [];

function check(label: string, ok: boolean): void {
  if (!ok) failures.push(label);
  console.log(`[fake-stream-check] ${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

const tag = (m: StreamMessage): string => {
  const sub = asDisplayString(m.subtype);
  // '?' rather than '' for the type: this line is read by a human debugging a
  // failed check, and a tag that says nothing arrived is worse than one that
  // says something unprintable did.
  return `${asDisplayString(m.type, '?')}${sub ? ':' + sub : ''}`;
};

function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (pred()) return res();
      if (Date.now() - t0 > ms) return rej(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/**
 * The turn's reply text, from the first `assistant` message that CARRIES text.
 *
 * A turn emits one `assistant` message PER CONTENT BLOCK, not one per turn, and
 * P2-E18-10 (#163) put a `thinking` block in front of the text one. So the
 * first `assistant` message is now the thinking block, whose content has
 * `.thinking` and no `.text` — and `find(m => m.type === 'assistant')` started
 * reading `undefined` (#164). Search for the text block instead of quietly
 * relying on there being only one, exactly as `fake-stream-protocol.test.ts`
 * does; that unit test's helper stayed correct through the same change.
 *
 * Returns undefined when nothing carried text, so the check FAILS rather than
 * throwing past the remaining assertions.
 */
function assistantText(): string | undefined {
  for (const m of seen) {
    if (m.type !== 'assistant') continue;
    const content = (m.message as { content?: Array<{ type?: string; text?: string }> } | undefined)
      ?.content;
    const text = content?.find((c) => c.type === 'text')?.text;
    if (typeof text === 'string') return text;
  }
  return undefined;
}

/**
 * The prompt echo, if one arrived. `--replay-user-messages` hands our own turn
 * back; #666 made the fake mark it, and the assertions below read it from here.
 */
function userEcho(): Record<string, unknown> | undefined {
  return seen.find((m) => m.type === 'user');
}

async function main(): Promise<number> {
  // the REAL recipe, not a hand-built one — this is what the session manager
  // would hand the transport.
  //
  // `transport: 'stream'` is REQUIRED, not decorative. Since #153 the fake
  // honours the requested transport instead of always returning a stream
  // recipe, so omitting it asks for the adapter's default — the PTY recipe,
  // i.e. `cmd.exe` on Windows and `sh` elsewhere. This check spawns over pipes,
  // so that used to hand a bare shell a pipe full of NDJSON: cmd.exe echoed its
  // banner into the parser and the run died 15 s later on "timed out waiting
  // for the first result" (#164).
  const recipe = fakeStreamAdapter.buildSpawn({
    cwd: work,
    sessionId: 'check',
    stateDir: work,
    transport: 'stream',
  });
  check('adapter declares the stream transport', recipe.transport === 'stream');

  // Fail FAST on a non-stream recipe. Spawning it anyway is what turned #164's
  // one-line cause into a timeout and a wall of shell noise — the very first
  // line of that run already said `FAIL adapter declares the stream transport`
  // and 40 lines of banner buried it. A wrong recipe must fail as a wrong
  // recipe, the same rule `fakeStreamCliPath()` follows for a wrong path.
  if (recipe.transport !== 'stream') {
    console.log(
      `[fake-stream-check] FAIL: adapter returned a ${recipe.transport ?? 'pty'} recipe ` +
        `(command: ${recipe.command}); refusing to drive stream-json over it`
    );
    fs.rmSync(work, { recursive: true, force: true });
    return 1;
  }

  const s = service.spawn({
    id: 'check',
    command: recipe.command,
    args: recipe.args,
    cwd: work,
    env: {
      ...recipe.env,
      // A HOME OF ITS OWN, so this check leaves nothing in the developer's real
      // `~/.claude`. The child resolves two paths from `os.homedir()` — the
      // JSONL transcript it writes per turn, and (since #603) the counter
      // directory it claims its conversation id from — and until this line both
      // landed in the real one, which is why `~/.claude/projects` on this
      // machine holds a `…sb-fake-stream-check-XXXX` folder for every run this
      // check has ever done. The e2e suite has always launched the app under a
      // temp home for the same reason; this is the same isolation for the
      // one place that drives the fake without Playwright.
      //
      // THE BACKLOG IS CLEANED UP BY HAND, DELIBERATELY (#616). The line above
      // stops the leak, and that was re-confirmed by measurement for #616: a
      // full build plus the whole e2e suite added not one new folder, and the
      // newest of the 19 already there dates from just before this isolation
      // landed. Those 19 remain, one 1.6 KB `00000000-fake-…jsonl` apiece and
      // about 30 KB in total. No automated sweep will remove them, and that is
      // a decision rather than an omission: this repo already
      // sweeps its own litter (`scripts/sweep-temp-orphans.js`, #354) and that
      // sweeper is confined to `os.tmpdir()` on purpose, because a directory
      // the OS hands out for disposable data is the only place a delete loop
      // can be wrong and cost nothing. `~/.claude/projects` is the opposite of
      // that: it is the user's real conversation history, the exact tree #484
      // and #539 were filed over after two of the owner's cards were found
      // pointing at transcripts they had lost. Automation there buys a few
      // reclaimed kilobytes and risks a real transcript on any glob that ever
      // widens by a character.
      //
      // So, when the clutter is worth a minute — LOOK FIRST, then delete:
      //
      //   ls -la ~/.claude/projects/*sb-fake-stream-check-*/
      //   rm -rf  ~/.claude/projects/*sb-fake-stream-check-*/
      //
      // The listing IS the safety check, which is why it is a separate command:
      // run it and every line should be a `00000000-fake-4000-8000-…jsonl`.
      // That id is unmistakable by construction — `fake-stream-ids.ts` put the
      // word `fake` where a uuid's version nibble goes precisely so an id that
      // reached a real projects directory is obvious to a human — and a folder
      // matching the glob could only be a real project if someone kept one
      // inside `%TEMP%\sb-fake-stream-check-XXXXXX`.
      //
      // The neighbouring `…sb-adapter-check-XXXX` folders are NOT this litter
      // and are not covered by the glob above. They come from `adapter-check.ts`
      // and hold REAL transcripts with real uuids from real, token-spending CLI
      // turns. Judge those two folders separately, by hand — and note that the
      // isolation on this line is probably NOT transferable to them: that check
      // drives the real `claude`, which resolves its credentials from the real
      // home too, so redirecting `HOME` would likely log it out rather than
      // tidy up after it. That last point is reasoning, not measurement — it is
      // written as the caveat on a fix nobody has tried, not as a finding.
      HOME: work,
      USERPROFILE: work,
    },
    onDiagnostic: (d) => console.log(`[fake-stream-check] diag ${d.kind}: ${d.detail}`),
  });
  s.onMessage((m) => seen.push(m));

  // ---- turn 1: a plain prompt ------------------------------------------------
  const sent = userMessage('hello');
  s.send(sent);
  await waitFor(() => seen.some((m) => m.type === 'result'), 15_000, 'the first result');

  check('system:init arrived', seen.some((m) => tag(m) === 'system:init'));
  check('token deltas arrived', seen.filter((m) => m.type === 'stream_event').length > 0);
  check('assistant text is the echo', assistantText() === 'FAKE-REPLY: hello');
  check('result:success arrived', seen.some((m) => tag(m) === 'result:success'));
  check('framing is intact', s.health.parseFailures === 0);

  // THE ENVELOPE SURVIVES THE PIPE (#490 + #666). The unit tests prove the fake
  // builds the echo correctly in-process; only this check proves the fields
  // survive `JSON.stringify` -> a real pipe -> the NDJSON decoder in both
  // directions. `uuid` is the CLI's at-most-once key, so a wire that silently
  // dropped it would cost us the only replay protection on offer without
  // failing anything else.
  const echo = userEcho();
  check('the prompt is echoed back (--replay-user-messages)', echo !== undefined);
  // BOTH HALVES, IN THIS ORDER. `echo.uuid === sent.uuid` alone is the one new
  // assertion that can pass vacuously — a builder that stopped minting an id
  // makes it `undefined === undefined` — and that is exactly the hole importing
  // the builder opened. S-09's lesson, in one extra line: assert the input
  // arrived before reading a verdict out of the output.
  check('we sent a uuid at all', typeof sent.uuid === 'string' && sent.uuid.length > 0);
  check('the echo carries the uuid we sent', echo?.uuid === sent.uuid);
  const echoOrigin = echo?.origin as { kind?: unknown } | undefined;
  check('the echo carries our origin', echoOrigin?.kind === 'human');
  // The flag a host keys duplicate-suppression on. Unconditional in the real
  // replay builder, so unconditional here.
  check('the echo is marked isReplay', echo?.isReplay === true);

  // ---- turn 2: the permission round trip -------------------------------------
  seen.length = 0;
  const target = path.join(work, '.claude', 'scripts', 'coverage.sh');
  s.send(userMessage('!perm .claude/scripts/coverage.sh'));
  await waitFor(() => seen.some((m) => m.type === 'control_request'), 15_000, 'a control_request');

  const req = seen.find((m) => m.type === 'control_request') as {
    request_id: string;
    request: Record<string, unknown>;
  };
  check('control_request is can_use_tool', req.request.subtype === 'can_use_tool');
  check('it carries decision_reason_type', req.request.decision_reason_type === 'safetyCheck');
  check('it carries permission_suggestions', Array.isArray(req.request.permission_suggestions));
  check('the turn has NOT completed yet', !seen.some((m) => m.type === 'result'));

  // answer it exactly as P2-E18-07 will
  s.send({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: req.request_id,
      response: { behavior: 'allow', updatedInput: req.request.input },
    },
  });
  await waitFor(() => seen.some((m) => m.type === 'result'), 15_000, 'the turn to finish');

  check('the file was actually written', fs.existsSync(target));
  check('the whole exchange parsed cleanly', s.health.parseFailures === 0);

  // ---- the S-11 surprise, reproduced ----------------------------------------
  check(
    'system:init is emitted ONCE PER TURN (S-11)',
    seen.filter((m) => tag(m) === 'system:init').length === 1
  );

  // ---- exit ------------------------------------------------------------------
  let exited = false;
  s.onExit(() => (exited = true));
  s.send(userMessage('!exit 0'));
  await waitFor(() => exited, 10_000, 'the child to exit');
  check('the child exits on command', exited);

  service.killAll();
  fs.rmSync(work, { recursive: true, force: true });

  const ok = failures.length === 0;
  console.log(ok ? '[fake-stream-check] PASS' : `[fake-stream-check] FAIL: ${failures.join(', ')}`);
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[fake-stream-check] ERROR', err);
    service.killAll();
    process.exit(1);
  }
);
