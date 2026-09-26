#!/usr/bin/env node
/**
 * Probe #948 — can a `plan`-mode session finish UNATTENDED?
 *
 * WHY THIS PROBE EXISTS. #946 shipped the built-in Code Reviewer template at
 * autonomy `plan`, and marked that default as a GUESS in three places
 * (`shared/dispatch.ts` beside `BUILT_INS`, DESIGN §5.15's as-built note, and a
 * comment on this issue). The reasoning for `plan` is good: it maps to the CLI's
 * `--permission-mode plan` (`main/providers/claude.ts`), whose write block is the
 * CLI's OWN, and §5.16's plan-mode rule says nothing in-app may Allow past it —
 * the strongest "do not touch the author's tree" available, needing no new
 * machinery.
 *
 * But exiting plan mode is an approval the CLI keeps for itself. Our own hold
 * policy already says so out loud: `hooks/hook-listener.ts` has `GATED.plan = []`
 * — "plan NEVER holds … an in-app Allow returns permissionDecision:'allow',
 * which BYPASSES the CLI's permission system, including plan mode's
 * write-block". So if the CLI asks a human to leave plan mode, a DISPATCHED
 * reviewer asks a human who by definition is not watching, and parks.
 *
 * That would make the default wrong, and the fix would be `ask` plus a
 * deny-writes story. Learning it here is far cheaper than learning it after #950
 * builds the results round-trip on top of it.
 *
 * READING IS NOT MEASURING — the standing rule. This drives the PATH CLI on the
 * transport the app actually uses (stream-json duplex, `providers/claude.ts`'s
 * exact flag list), against a real git repo with a real diff in it.
 *
 * THE QUESTIONS
 *   Q1  `--permission-mode plan`, a clean-room review prompt, NOBODY ANSWERING:
 *       does it reach `result` on its own? Does any `control_request` arrive?
 *   Q2  If one does arrive and we never answer it — does the session park (no
 *       `result` until the timeout)? This is the failure mode in one number.
 *   Q3  `--permission-mode default` (our `ask`) on the identical prompt: does it
 *       finish unattended, and does it ask for anything?
 *   Q4  plan mode where we DENY every control_request the moment it arrives:
 *       do the findings still come out, or does the session end empty?
 *   Q5  CONTROL — plan mode, prompt that explicitly orders a file write. The
 *       write must NOT happen. If it does, `plan` is not the write block #946
 *       chose it for and the whole argument changes.
 *
 * Q5 is what keeps this honest: Q1 succeeding is only good news if plan mode is
 * still doing the one job it was picked for.
 *
 * COST. Five real CLI turns against the owner's subscription, each one a small
 * review of a ten-line diff. Every transcript this run mints is deleted at the
 * end (`cleanup`), and no background/daemon session is ever started — nothing to
 * leak onto the machine.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

function resolveCli() {
  const home = homedir();
  const candidates =
    process.platform === 'win32'
      ? [join(home, 'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')]
      : [join(home, '.local/bin/claude'), '/usr/local/bin/claude'];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'claude';
}
const CLI = resolveCli();
const PROJECTS = join(homedir(), '.claude', 'projects');

/** EXACTLY the list `providers/claude.ts` pushes for `transport === 'stream'`. */
const STREAM_FLAGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
];

const minted = new Set();
function mint() {
  const id = randomUUID();
  minted.add(id);
  return id;
}

function findTranscript(sessionId) {
  if (!existsSync(PROJECTS)) return null;
  for (const d of readdirSync(PROJECTS)) {
    const f = join(PROJECTS, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

/**
 * A repo with a change in it worth reviewing.
 *
 * The bug is deliberate and obvious — an off-by-one that drops the last element
 * — because the probe is measuring whether the session FINISHES, not whether the
 * model is clever. A review that finds nothing is indistinguishable from a review
 * that never ran, so the diff has to contain something a reviewer will report.
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sb948-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.invalid');
  git('config', 'user.name', 'Probe');
  writeFileSync(
    join(dir, 'total.js'),
    ['export function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i.price;', '  return sum;', '}', ''].join('\n')
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  // The change under review: an index loop that stops one short.
  writeFileSync(
    join(dir, 'total.js'),
    [
      'export function total(items) {',
      '  let sum = 0;',
      '  for (let n = 0; n < items.length - 1; n++) {',
      '    sum += items[n].price;',
      '  }',
      '  return sum;',
      '}',
      '',
    ].join('\n')
  );
  const diff = execFileSync('git', ['diff'], { cwd: dir, encoding: 'utf8' });
  return { dir, diff };
}

/**
 * Drive one stream-json session and collect everything it says.
 *
 * `answerControl` is the whole experiment: `null` means NOBODY IS WATCHING — the
 * dispatched case — and a function means we answer, which is what a human at a
 * keyboard does. The difference between Q1/Q2 and Q4 is only this argument.
 *
 * The 500 ms delay before the first write is LOAD-BEARING and not politeness:
 * #760 measured that a frame written to stdin at t=0 is silently lost.
 */
function runStream(args, cwd, prompt, { timeoutMs = 180_000, answerControl = null } = {}) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(CLI, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const frames = [];
    const controlRequests = [];
    const toolUses = [];
    let init = null;
    let result = null;
    let assistantText = '';
    let buf = '';
    let err = '';
    let done = false;

    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      res({
        why,
        init,
        result,
        assistantText,
        controlRequests,
        toolUses,
        frameTypes: [...new Set(frames.map((f) => `${f.type}${f.subtype ? ':' + f.subtype : ''}`))],
        err: err.slice(0, 2000),
        ms: Date.now() - started,
        timedOut: why === 'timeout',
      });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        frames.push(msg);
        if (msg.type === 'system' && msg.subtype === 'init') init ??= msg;
        if (msg.type === 'control_request') {
          const req = msg.request ?? {};
          controlRequests.push({
            id: msg.request_id,
            subtype: req.subtype,
            tool: req.tool_name ?? req.tool,
            atMs: Date.now() - started,
          });
          if (answerControl) {
            const answer = answerControl(msg);
            if (answer) {
              try {
                child.stdin.write(JSON.stringify(answer) + '\n');
              } catch (e) {
                err += `control write failed: ${e}`;
              }
            }
          }
        }
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const b of msg.message.content) {
            if (b?.type === 'text' && typeof b.text === 'string') assistantText += b.text;
            if (b?.type === 'tool_use') toolUses.push(b.name);
          }
        }
        if (msg.type === 'result') {
          result = msg;
          finish('result');
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      err += String(e);
      finish('spawn-error');
    });
    child.on('close', () => finish('closed'));

    setTimeout(() => {
      if (done) return;
      const frame = {
        type: 'user',
        uuid: randomUUID(),
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        parent_tool_use_id: null,
        session_id: '',
        origin: { kind: 'human' },
      };
      try {
        child.stdin.write(JSON.stringify(frame) + '\n');
      } catch (e) {
        err += `stdin write failed: ${e}`;
      }
    }, 500);
  });
}

/** The reply the app's own `StreamPermissions` sends — deny, with a reason. */
function denyResponse(msg) {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: msg.request_id,
      response: { behavior: 'deny', message: 'nobody is watching this session' },
    },
  };
}

/**
 * The prompt a dispatched clean-room Code Reviewer actually gets.
 *
 * `BUILT_INS[0].rolePrompt` verbatim, plus the artifact #947's bundle carries —
 * because a probe that asked a different question than the product asks is
 * measuring a session we will never spawn.
 */
function reviewPrompt(diff) {
  return [
    'You are reviewing a change you did not write.',
    '',
    'You have the diff, the task it was meant to accomplish, and its acceptance',
    'criteria — and deliberately nothing else: no reasoning history, no design',
    'discussion. Rebuild your understanding from the artifact alone. Where the',
    'change only makes sense if you assume something the diff does not say, that',
    'assumption is itself a finding.',
    '',
    'Report correctness problems first, then what will be expensive to live with.',
    'Do not edit files.',
    '',
    '## What it was asked to do',
    '',
    'Rewrite total() as an index loop.',
    '',
    '## The change',
    '',
    '```diff',
    diff.trim(),
    '```',
  ].join('\n');
}

function say(label, r) {
  console.log(`\n── ${label}`);
  console.log(`   why=${r.why} ms=${r.ms} timedOut=${r.timedOut}`);
  console.log(`   control_requests=${r.controlRequests.length} ${JSON.stringify(r.controlRequests)}`);
  console.log(`   tool_uses=${JSON.stringify(r.toolUses)}`);
  console.log(`   result.subtype=${r.result?.subtype ?? '(none)'} is_error=${r.result?.is_error ?? '(n/a)'}`);
  console.log(`   assistant text: ${r.assistantText.length} chars`);
  console.log(`   ${r.assistantText.replace(/\s+/g, ' ').slice(0, 400)}`);
  if (r.err.trim()) console.log(`   stderr: ${r.err.replace(/\s+/g, ' ').slice(0, 300)}`);
}

/**
 * Everything already in `~/.claude/plans`, so cleanup can tell ours from theirs.
 *
 * ⚠️ ADDED AFTER THE FIRST RUN, because of what round 2 then explained. A
 * plan-mode `Write` does not fail — the CLI redirects it into its OWN plans
 * directory under the user's home, named after the prompt. The author's tree stays
 * clean, which is the guarantee `plan` was chosen for, but this probe had left
 * three files on the owner's machine, outside anything switchboard tracks.
 * Snapshot first and remove only the difference: one entry there predates this
 * probe by three weeks, and deleting somebody else's plan is not this script's
 * business.
 */
const PLANS = join(homedir(), '.claude', 'plans');
function planFiles() {
  try {
    return new Set(readdirSync(PLANS));
  } catch {
    return new Set();
  }
}
const plansBefore = planFiles();

function cleanup(findings) {
  const removed = [];
  for (const id of minted) {
    const f = findTranscript(id);
    if (!f) continue;
    try {
      rmSync(f, { force: true });
      removed.push(f);
    } catch (e) {
      removed.push(`${f} (FAILED: ${e.code ?? e})`);
    }
  }
  const plans = [];
  for (const name of planFiles()) {
    if (plansBefore.has(name)) continue;
    const f = join(PLANS, name);
    try {
      rmSync(f, { force: true });
      plans.push(f);
    } catch (e) {
      plans.push(`${f} (FAILED: ${e.code ?? e})`);
    }
  }
  findings.cleanup = { minted: [...minted], removed, plansRemoved: plans };
  console.log(`\n── cleanup: removed ${removed.length} transcript(s), ${plans.length} plan file(s)`);
  for (const r of [...removed, ...plans]) console.log(`   ${r}`);
}

async function main() {
  const findings = { cli: CLI, streamFlags: STREAM_FLAGS, when: new Date().toISOString() };
  const { dir, diff } = makeRepo();
  console.log(`cli    ${CLI}`);
  console.log(`repo   ${dir}`);

  const base = (mode, id) => [...STREAM_FLAGS, '--permission-mode', mode, '--session-id', id];

  // ── Q1/Q2 — plan mode, nobody answering ────────────────────────────────────
  const q1 = await runStream(base('plan', mint()), dir, reviewPrompt(diff), { answerControl: null });
  say('Q1/Q2  plan, NOBODY answering', q1);
  findings.q1_plan_unattended = {
    reachedResult: q1.result !== null,
    timedOut: q1.timedOut,
    ms: q1.ms,
    controlRequests: q1.controlRequests,
    toolUses: q1.toolUses,
    textChars: q1.assistantText.length,
  };

  // ── Q3 — `ask` (default) mode, nobody answering ────────────────────────────
  const q3 = await runStream(base('default', mint()), dir, reviewPrompt(diff), { answerControl: null });
  say('Q3     default (our `ask`), NOBODY answering', q3);
  findings.q3_ask_unattended = {
    reachedResult: q3.result !== null,
    timedOut: q3.timedOut,
    ms: q3.ms,
    controlRequests: q3.controlRequests,
    toolUses: q3.toolUses,
    textChars: q3.assistantText.length,
  };

  // ── Q4 — plan mode, every control_request DENIED at once ───────────────────
  const q4 = await runStream(base('plan', mint()), dir, reviewPrompt(diff), {
    answerControl: denyResponse,
  });
  say('Q4     plan, every control_request DENIED', q4);
  findings.q4_plan_denied = {
    reachedResult: q4.result !== null,
    timedOut: q4.timedOut,
    ms: q4.ms,
    controlRequests: q4.controlRequests,
    textChars: q4.assistantText.length,
  };

  // ── Q5 — CONTROL: does plan mode still block a write? ─────────────────────
  const canary = join(dir, 'CANARY.txt');
  const q5 = await runStream(base('plan', mint()), dir, 'Create a file named CANARY.txt in this folder containing the word OPEN. Do it now, do not ask.', {
    answerControl: null,
    timeoutMs: 120_000,
  });
  const canaryWritten = existsSync(canary);
  say('Q5     plan, ORDERED to write a file (control)', q5);
  console.log(`   CANARY.txt written? ${canaryWritten}`);
  findings.q5_plan_write_block = {
    canaryWritten,
    canaryText: canaryWritten ? readFileSync(canary, 'utf8').slice(0, 80) : null,
    reachedResult: q5.result !== null,
    controlRequests: q5.controlRequests,
    toolUses: q5.toolUses,
  };

  cleanup(findings);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows can hold a handle briefly — the temp dir is disposable either way */
  }
  console.log('\n──────── FINDINGS (json) ────────');
  console.log(JSON.stringify(findings, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
