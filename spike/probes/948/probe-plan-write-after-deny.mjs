#!/usr/bin/env node
/**
 * Probe #948 round 2 — does plan mode still block the write AFTER the exit was
 * denied?
 *
 * WHY THERE IS A ROUND 2. Round 1 (`probe-plan-unattended.mjs`) answered the
 * question it was written for — a plan-mode reviewer finishes unattended, and an
 * UNANSWERED `ExitPlanMode` parks the CLI with no timeout of its own (Q5: 120 s,
 * no `result`). But Q4 left a hole big enough to matter, and it is the hole that
 * decides whether `plan` is still the right default:
 *
 *   Q4 denied the `ExitPlanMode` request, the session CARRIED ON and produced its
 *   findings — and its `tool_use` list contained **`Write`**, with the assistant
 *   saying *"Writing the findings to the plan file now."*
 *
 * Round 1 never looked at the filesystem for Q4. It looked only for Q5's canary,
 * in a run that never reached `result`. So "plan mode blocks writes" is currently
 * measured only for a session whose exit request was left HANGING — not for one
 * whose exit was refused and which then kept working. Those are different states
 * and the second is the one the app will actually produce, because
 * `StreamPermissions` denies a held request at its 300 s deadline (`failOpen`).
 *
 * If a write lands after a denied exit, `plan` is not the "do not touch the
 * author's tree" guarantee #946 chose it for, and the whole autonomy argument in
 * `shared/dispatch.ts` has to be rewritten rather than confirmed.
 *
 * THE QUESTIONS
 *   R1  plan mode, exit DENIED, and the prompt explicitly tells it to write its
 *       findings to a file in the folder. Does any file appear?
 *   R2  CONTROL — the identical prompt at `--permission-mode acceptEdits`, where
 *       a write is supposed to be allowed. If nothing appears HERE either, R1's
 *       clean tree proves nothing: it would mean the model never really tried.
 *
 * R2 is what keeps this honest, the same role Q6 played in #801 and Q5 in round 1.
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

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sb948r2-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.invalid');
  git('config', 'user.name', 'Probe');
  writeFileSync(join(dir, 'total.js'), 'export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price;\n  return sum;\n}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  writeFileSync(join(dir, 'total.js'), 'export function total(items) {\n  let sum = 0;\n  for (let n = 0; n < items.length - 1; n++) {\n    sum += items[n].price;\n  }\n  return sum;\n}\n');
  const diff = execFileSync('git', ['diff'], { cwd: dir, encoding: 'utf8' });
  return { dir, diff };
}

/** Everything in the folder that git does not already know about. */
function newFiles(dir) {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(2).trim());
}

function runStream(args, cwd, prompt, { timeoutMs = 180_000, answerControl = null } = {}) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(CLI, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const controlRequests = [];
    const toolUses = [];
    const toolResults = [];
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
      res({ why, result, assistantText, controlRequests, toolUses, toolResults, err: err.slice(0, 1500), ms: Date.now() - started, timedOut: why === 'timeout' });
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
          controlRequests.push({ id: msg.request_id, tool: req.tool_name ?? req.tool, atMs: Date.now() - started });
          if (answerControl) {
            const a = answerControl(msg);
            if (a) {
              try {
                child.stdin.write(JSON.stringify(a) + '\n');
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
        // WHAT THE TOOL ACTUALLY DID, which is the half round 1 never looked at.
        // A `Write` in the tool_use list says the model TRIED; only the result
        // says whether the CLI let it.
        if (msg.type === 'user' && msg.message?.content) {
          for (const b of msg.message.content) {
            if (b?.type !== 'tool_result') continue;
            const text = typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ')
                : '';
            toolResults.push({ isError: b.is_error === true, text: text.replace(/\s+/g, ' ').slice(0, 220) });
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

/** Exactly what `StreamPermissions.failOpen` sends at its 300 s deadline. */
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

function prompt(diff) {
  return [
    'You are reviewing a change you did not write. Do not edit the source files.',
    '',
    'Write your findings to a new file called FINDINGS.md in this folder, then',
    'summarise them for me. Create the file — do not just show me its contents.',
    '',
    '```diff',
    diff.trim(),
    '```',
  ].join('\n');
}

function say(label, r, files) {
  console.log(`\n── ${label}`);
  console.log(`   why=${r.why} ms=${r.ms} timedOut=${r.timedOut}`);
  console.log(`   control_requests=${JSON.stringify(r.controlRequests)}`);
  console.log(`   tool_uses=${JSON.stringify(r.toolUses)}`);
  console.log(`   NEW FILES IN THE TREE: ${JSON.stringify(files)}`);
  for (const tr of r.toolResults) console.log(`   tool_result isError=${tr.isError}: ${tr.text}`);
}

/**
 * Everything already in `~/.claude/plans`, so cleanup can tell ours from theirs.
 *
 * ⚠️ THIS EXISTS BECAUSE OF WHAT R1 FOUND. A plan-mode `Write` does not fail — the
 * CLI redirects it into its OWN plans directory under the user's home, naming the
 * file after the prompt. The author's tree stays clean, which is the guarantee
 * `plan` was chosen for, but the probe was quietly leaving files on the owner's
 * machine outside anything switchboard tracks. Snapshot first, remove only the
 * difference: a `plans/` entry from 2026-09-04 was sitting there before this probe
 * ever ran, and deleting somebody else's plan is not this script's business.
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
  for (const p of plans) console.log(`   ${p}`);
}

async function main() {
  const findings = { cli: CLI, when: new Date().toISOString() };

  // ── R1 — plan, exit denied, TOLD to write ────────────────────────────────
  const a = makeRepo();
  const r1 = await runStream(
    [...STREAM_FLAGS, '--permission-mode', 'plan', '--session-id', mint()],
    a.dir,
    prompt(a.diff),
    { answerControl: denyResponse }
  );
  const r1Files = newFiles(a.dir);
  say('R1  plan, ExitPlanMode DENIED, ordered to write FINDINGS.md', r1, r1Files);
  findings.r1_plan_denied_then_write = {
    newFiles: r1Files,
    wroteAnything: r1Files.length > 0,
    reachedResult: r1.result !== null,
    controlRequests: r1.controlRequests,
    toolUses: r1.toolUses,
    toolResults: r1.toolResults,
  };

  // ── R2 — CONTROL: acceptEdits, same prompt, nothing denied ───────────────
  const b = makeRepo();
  const r2 = await runStream(
    [...STREAM_FLAGS, '--permission-mode', 'acceptEdits', '--session-id', mint()],
    b.dir,
    prompt(b.diff),
    { answerControl: null }
  );
  const r2Files = newFiles(b.dir);
  say('R2  acceptEdits CONTROL, same prompt', r2, r2Files);
  findings.r2_acceptedits_control = {
    newFiles: r2Files,
    wroteAnything: r2Files.length > 0,
    reachedResult: r2.result !== null,
    controlRequests: r2.controlRequests,
    toolUses: r2.toolUses,
  };

  cleanup(findings);
  for (const d of [a.dir, b.dir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* disposable */
    }
  }
  console.log('\n──────── FINDINGS (json) ────────');
  console.log(JSON.stringify(findings, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
