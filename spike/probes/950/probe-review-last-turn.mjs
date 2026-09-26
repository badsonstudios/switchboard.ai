#!/usr/bin/env node
/**
 * Probe #950 — what does a real clean-room review leave as its LAST TURN?
 *
 * WHY THIS PROBE EXISTS. #950's own plan note, written when E13 was filed, says
 * the item must *"measure rather than design what a real clean-room review
 * session actually leaves as its last turn, since 'the result' is a transcript
 * and not a structured object"*. The issue then lists three candidate
 * extractions — the final assistant turn, a `done`-hook read of the tail, or a
 * role prompt asked to end with a delimited block — and says, in as many words:
 * **do not design the delimiter first and hope the model honours it.**
 *
 * #948 already narrowed the field. Its findings
 * (`spike/findings/e13-948-plan-unattended.md`) establish that a plan-mode
 * reviewer's write does NOT land in the author's tree — the CLI redirects it
 * into `~/.claude/plans/`, named after the prompt — so there is no artifact on
 * disk to watch for. The result is a transcript, and the only question left is
 * WHICH PART OF IT.
 *
 * ── THE ONE THING #948 MEASURED THAT COULD STILL BREAK THE OBVIOUS ANSWER ────
 *
 * #948 found that denying `ExitPlanMode` "costs the findings nothing" — both
 * denied runs reached `result` with their full review. But it measured that as a
 * TOTAL: it concatenated every assistant text frame in the run and reported the
 * character count. It never asked which TURN the findings were in.
 *
 * That distinction is the whole of this probe. The app now denies a dispatched
 * session's `ExitPlanMode` at once (`StreamPermissions.setDispatched`). If the
 * model's shape is *review → ask to exit plan mode → get refused → "Understood,
 * I'll stop here"*, then the last assistant turn is a SIGN-OFF and "inject the
 * final turn" would deliver an apology to the author instead of the review. The
 * totals #948 reported are identical either way.
 *
 * THE QUESTIONS
 *   Q1  plan mode, every control_request DENIED at once (exactly what a
 *       dispatched session gets today): what is the LAST assistant turn — the
 *       findings, or a sign-off after the refusal? Every turn is captured
 *       separately rather than concatenated.
 *   Q2  the same, a second sample. Whether the model reaches for `ExitPlanMode`
 *       is a DECISION, not a protocol rule (#948's caveat), so one sample of a
 *       non-deterministic choice is an anecdote.
 *   Q3  plan mode, nobody answering, no denial in the way: the control case. If
 *       the last turn is the findings here and a sign-off in Q1/Q2, the refusal
 *       is what moves them and the extraction has to allow for it.
 *   Q4  a BRIEFED role at `default` (our `ask`) — the Doc Writer / PR Author
 *       shape. Review is not the only thing that round-trips, and a role that
 *       produces a DOCUMENT may leave a different last turn from one that
 *       produces a report.
 *
 * AND THREE THINGS EVERY RUN RECORDS, because they decide the surface:
 *   * how the `result` frame's own `result` string compares to the last
 *     assistant turn — the CLI's own answer to "what came of this", which the
 *     app currently throws away (`feed/stream-feed.ts` treats `result` as a
 *     lifecycle signal and reads no text off it);
 *   * the SIZE of the candidate text against `SIBLING_MESSAGE_CHAR_CAP`
 *     (20,000), since the inject is an ordinary sibling message and one over the
 *     cap is REFUSED rather than cut;
 *   * whether the findings are COUNTABLE. DESIGN §5.15 writes the Feed event as
 *     *"Review of @X complete — 3 findings"*. If nothing in the output is
 *     reliably countable, the event must say something true instead of printing
 *     a number it guessed.
 *
 * COST. Four real CLI turns against the owner's subscription, each a small
 * review of a ten-line diff. Every transcript this run mints is deleted at the
 * end, as is any file the CLI drops into `~/.claude/plans/` that was not there
 * when the probe started (#948's own cleanup, kept for the same reason). No
 * background or daemon session is ever started.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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

/** `shared/sibling-message.ts` — the cap the inject would have to clear. */
const SIBLING_MESSAGE_CHAR_CAP = 20_000;

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
 * A repo with a change in it worth reviewing — #948's, deliberately unchanged.
 *
 * Two bugs rather than one, and that is the only difference: #948 was measuring
 * whether the session FINISHED, so one obvious defect was enough. This probe is
 * asking whether the output is countable, and a review with a single finding
 * cannot tell "it enumerates its findings" from "it happened to mention one
 * thing".
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sb950-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.invalid');
  git('config', 'user.name', 'Probe');
  writeFileSync(
    join(dir, 'total.js'),
    [
      'export function total(items) {',
      '  let sum = 0;',
      '  for (const i of items) sum += i.price;',
      '  return sum;',
      '}',
      '',
    ].join('\n')
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  // The change under review: an index loop that stops one short, and a
  // currency conversion that mutates its argument.
  writeFileSync(
    join(dir, 'total.js'),
    [
      'export function total(items, rate) {',
      '  let sum = 0;',
      '  for (let n = 0; n < items.length - 1; n++) {',
      '    items[n].price = items[n].price * rate;',
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
 * Drive one stream-json session and keep every assistant TURN separately.
 *
 * The one thing this does that #948's runner did not: `turns` is an array, one
 * entry per `type: 'assistant'` frame carrying text, each stamped with when it
 * arrived and what tool calls rode along with it. #948 accumulated a single
 * `assistantText` string, which is precisely the measurement that cannot answer
 * this probe's question.
 *
 * The 500 ms delay before the first write is LOAD-BEARING and not politeness:
 * #760 measured that a frame written to stdin at t=0 is silently lost.
 */
function runStream(args, cwd, prompt, { timeoutMs = 180_000, answerControl = null } = {}) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(CLI, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const controlRequests = [];
    /** one entry per assistant frame that carried text */
    const turns = [];
    /** every tool the run asked for, in order */
    const toolUses = [];
    let result = null;
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
        result,
        turns,
        toolUses,
        controlRequests,
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
          let text = '';
          const tools = [];
          for (const b of msg.message.content) {
            if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
            if (b?.type === 'tool_use') {
              tools.push(b.name);
              toolUses.push(b.name);
            }
          }
          // A frame that is PURELY a tool call carries no text and is not a
          // turn for this purpose — it is the reason the turns around it are
          // separate. Recorded in `toolUses` above either way.
          if (text.trim() !== '') turns.push({ atMs: Date.now() - started, text, tools });
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

/** The reply the app's own `StreamPermissions` sends a dispatched session. */
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

// ── The real first turn, assembled the way the app assembles it ──────────────
//
// `buildDispatchPrompt` puts the briefing FIRST and the role prompt LAST under a
// `## Your instructions` heading, for a documented reason (an unclosed fence in
// a user's role prompt must not swallow the briefing). A probe that sent them
// the other way round would be measuring a session we never spawn.

/** `clean-room.ts`'s PREAMBLE, verbatim. */
const PREAMBLE = [
  'You have been handed this work **clean-room**: the artifact and nothing else.',
  'The conversation that produced it — the reasoning, the false starts, the design',
  'discussion — has been withheld deliberately, because someone who inherits the',
  "author's framing judges the intent rather than the work.",
  '',
  'So: rebuild your understanding from what is below. Where the change only makes',
  'sense if you assume something that is not stated here, that assumption is',
  'itself worth reporting. Your own instructions arrive separately from this',
  'document.',
].join('\n');

/** `clean-room.ts`'s document shape, with this probe's artifact in it. */
function cleanRoomBundle(diff) {
  return [
    '# Clean-room handoff from @Alpha',
    '',
    PREAMBLE,
    '',
    '- **Author session:** Alpha (claude)',
    '- **Folder:** (a temporary repository)',
    '',
    '## What it was asked to do',
    '',
    'Rewrite total() as an index loop and apply the currency rate while summing.',
    '',
    '## What "done" means',
    '',
    'The totals match the old implementation for every input.',
    '',
    '## The change',
    '',
    '```diff',
    diff.trim(),
    '```',
  ].join('\n');
}

/** `BUILT_INS[0].rolePrompt` — the Code Reviewer, verbatim. */
const CODE_REVIEWER = [
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
].join('\n');

/** `BUILT_INS[2].rolePrompt` — the PR Author, verbatim. */
const PR_AUTHOR = [
  'You are writing the pull request for work another session has just finished.',
  '',
  'You have been briefed: the goal, the decisions taken, and the files touched.',
  'Lead with what changed and why, in plain English, then the detail. Say what',
  'the change deliberately does not do. Describe nothing that is not in the diff.',
].join('\n');

/** `buildDispatchPrompt`'s join, exactly. */
function dispatchPrompt(given, rolePrompt) {
  return [given, '', '## Your instructions', '', rolePrompt, ''].join('\n');
}

// ── Reading the answers ─────────────────────────────────────────────────────

/**
 * Does this turn read as a SIGN-OFF rather than as content?
 *
 * A heuristic on purpose, and reported next to the full text rather than
 * instead of it: the probe's job is to show what the turns are, and this only
 * flags the shape the extraction has to survive. Short, and about the exchange
 * rather than about the code.
 */
function looksLikeSignOff(text) {
  const t = text.trim();
  if (t.length > 600) return false;
  return /plan mode|exit(ing)? plan|permission|not allowed|denied|let me know|shall i|would you like/i.test(t);
}

/**
 * Anything countable in the findings?
 *
 * Three shapes a report might enumerate with, counted separately so the note can
 * say which — if any — is reliable enough for §5.15's "3 findings".
 */
function countable(text) {
  const numbered = (text.match(/^\s{0,3}\d+[.)]\s+\S/gm) ?? []).length;
  const bulleted = (text.match(/^\s{0,3}[-*+]\s+\S/gm) ?? []).length;
  const headings = (text.match(/^#{2,4}\s+\S/gm) ?? []).length;
  const selfCount = text.match(/\b(\d+|one|two|three|four|five|six|seven)\s+(findings?|issues?|problems?|bugs?)\b/i);
  return { numbered, bulleted, headings, selfCount: selfCount?.[0] ?? null };
}

function digest(r) {
  const last = r.turns.at(-1);
  const joined = r.turns.map((t) => t.text).join('\n\n');
  return {
    why: r.why,
    ms: r.ms,
    timedOut: r.timedOut,
    reachedResult: r.result !== null,
    resultSubtype: r.result?.subtype ?? null,
    controlRequests: r.controlRequests,
    toolUses: r.toolUses,
    turnCount: r.turns.length,
    turnChars: r.turns.map((t) => t.text.length),
    turnSignOff: r.turns.map((t) => looksLikeSignOff(t.text)),
    lastTurnChars: last?.text.length ?? 0,
    lastTurnLooksLikeSignOff: last ? looksLikeSignOff(last.text) : null,
    lastTurn: last?.text ?? null,
    allTurnsChars: joined.length,
    overSiblingCap: {
      lastTurn: (last?.text.length ?? 0) > SIBLING_MESSAGE_CHAR_CAP,
      allTurns: joined.length > SIBLING_MESSAGE_CHAR_CAP,
    },
    // The CLI's OWN answer to "what came of this". The app reads no text off
    // this frame today; whether it should is one of the things this decides.
    resultText: typeof r.result?.result === 'string' ? r.result.result : null,
    resultTextChars: typeof r.result?.result === 'string' ? r.result.result.length : 0,
    resultTextEqualsLastTurn:
      typeof r.result?.result === 'string' && last ? r.result.result.trim() === last.text.trim() : null,
    countableInLastTurn: last ? countable(last.text) : null,
    countableInAllTurns: countable(joined),
  };
}

function say(label, r) {
  const d = digest(r);
  console.log(`\n── ${label}`);
  console.log(`   why=${d.why} ms=${d.ms} result=${d.resultSubtype ?? '(none)'}`);
  console.log(`   control_requests=${d.controlRequests.length} ${JSON.stringify(d.controlRequests)}`);
  console.log(`   tools=${JSON.stringify(d.toolUses)}`);
  console.log(`   turns=${d.turnCount} chars=${JSON.stringify(d.turnChars)} signOff=${JSON.stringify(d.turnSignOff)}`);
  console.log(`   LAST TURN (${d.lastTurnChars} chars, signOff=${d.lastTurnLooksLikeSignOff}):`);
  console.log(`   ${(d.lastTurn ?? '(none)').replace(/\s+/g, ' ').slice(0, 500)}`);
  console.log(`   result.result: ${d.resultTextChars} chars, equalsLastTurn=${d.resultTextEqualsLastTurn}`);
  console.log(`   countable(last)=${JSON.stringify(d.countableInLastTurn)}`);
  if (r.err.trim()) console.log(`   stderr: ${r.err.replace(/\s+/g, ' ').slice(0, 300)}`);
  return d;
}

/**
 * Everything already in `~/.claude/plans`, so cleanup can tell ours from theirs
 * (#948's rule, and its reason: one entry there predates these probes and
 * deleting somebody else's plan is not this script's business).
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
  const review = dispatchPrompt(cleanRoomBundle(diff), CODE_REVIEWER);

  // ── Q1 — plan, every control DENIED at once: exactly today's dispatch ──────
  const q1 = await runStream(base('plan', mint()), dir, review, { answerControl: denyResponse });
  findings.q1_plan_denied = say('Q1  plan, ExitPlanMode DENIED at once (the app today)', q1);

  // ── Q2 — the same, a second sample ────────────────────────────────────────
  const q2 = await runStream(base('plan', mint()), dir, review, { answerControl: denyResponse });
  findings.q2_plan_denied_again = say('Q2  plan, DENIED — second sample', q2);

  // ── Q3 — plan, nobody answering: the control for Q1/Q2 ────────────────────
  const q3 = await runStream(base('plan', mint()), dir, review, { answerControl: null });
  findings.q3_plan_unanswered = say('Q3  plan, nobody answering (control)', q3);

  // ── Q4 — a briefed role at `default`, i.e. our `ask` ──────────────────────
  const q4 = await runStream(base('default', mint()), dir, dispatchPrompt(cleanRoomBundle(diff), PR_AUTHOR), {
    answerControl: denyResponse,
  });
  findings.q4_pr_author_ask = say('Q4  PR Author at `ask`, controls denied', q4);

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
