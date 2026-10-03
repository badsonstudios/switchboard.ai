#!/usr/bin/env node
/**
 * Probe #588 — does a plan-mode Direct session ask for permission at all, and
 * what does an in-app ALLOW do if it does?
 *
 * WHY THIS EXISTS. The manual's plan-mode sentence has said two opposite things.
 * Until #952: *"Plan mode never asks in-app, on purpose"* — true of the hook
 * path, which simply held nothing for a plan session. Since #952: *"Plan mode
 * now asks in-app like every other mode… plan mode's write block stands
 * WHATEVER YOU CLICK… nothing you can click in switchboard makes it not."* The
 * second was reasoned, in a comment in `stream-permissions.ts` ("an allow here
 * is answered INTO the CLI's enforcement"), and #948's probes measured only
 * DENIALS — every control request in both rounds was refused or left hanging.
 * Nobody has measured an ALLOW in plan mode. That is the claim a user acts on.
 *
 * THE QUESTIONS
 *   A  plan, prompt orders a MUTATING shell command. Every request allowed
 *      except ExitPlanMode (denied). Does a `can_use_tool` for Bash arrive — is
 *      there a bar — and does the file get written?
 *   B  plan, prompt orders a `Write` into the folder. Same answers. Does a
 *      `can_use_tool` for Write arrive, and does an Allow put a file in the tree?
 *   C  plan, the same Write prompt, EVERYTHING allowed including ExitPlanMode.
 *      This is "approve the plan". Does the file land then, and is the write
 *      itself asked about afterwards?
 *   D  CONTROL — `default` mode, the mutating shell command, everything allowed.
 *      If no file appears here either, A's clean tree proves nothing.
 *
 * Costs four real turns. No `--bg`. Transcripts, plan files and temp folders
 * are removed at the end.
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
const PLANS = join(homedir(), '.claude', 'plans');

/** EXACTLY the list `providers/claude.ts` pushes for the stream transport. */
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
function planFiles() {
  try {
    return new Set(readdirSync(PLANS));
  } catch {
    return new Set();
  }
}
const plansBefore = planFiles();

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sb588-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.invalid');
  git('config', 'user.name', 'Probe');
  writeFileSync(join(dir, 'README.md'), '# probe\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  return dir;
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
    .filter(Boolean);
}

function runStream(args, cwd, prompt, { timeoutMs = 150_000, answer }) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(CLI, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const controlRequests = [];
    const toolUses = [];
    const toolResults = [];
    const modes = [];
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
      res({ why, result, assistantText, controlRequests, toolUses, toolResults, modes, err: err.slice(0, 800), ms: Date.now() - started });
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
        // The mode the CLI says it is in, whenever it says so — `init` carries
        // it, and a change of mode is announced as a `status` system message.
        if (msg.type === 'system' && typeof msg.permissionMode === 'string') {
          modes.push({ subtype: msg.subtype, mode: msg.permissionMode, atMs: Date.now() - started });
        }
        if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
          const req = msg.request;
          const verdict = answer(req.tool_name);
          controlRequests.push({
            tool: req.tool_name,
            input: JSON.stringify(req.input ?? {}).slice(0, 160),
            reason: req.decision_reason,
            reasonType: req.decision_reason_type,
            answered: verdict,
            atMs: Date.now() - started,
          });
          const response =
            verdict === 'allow'
              ? { behavior: 'allow', updatedInput: req.input ?? {} }
              : { behavior: 'deny', message: 'The user denied this request.' };
          try {
            child.stdin.write(
              JSON.stringify({
                type: 'control_response',
                response: { subtype: 'success', request_id: msg.request_id, response },
              }) + '\n'
            );
          } catch (e) {
            err += `control write failed: ${e}`;
          }
        }
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const b of msg.message.content) {
            if (b?.type === 'text' && typeof b.text === 'string') assistantText += b.text;
            if (b?.type === 'tool_use') {
              toolUses.push({ name: b.name, input: JSON.stringify(b.input ?? {}).slice(0, 140) });
            }
          }
        }
        if (msg.type === 'user' && msg.message?.content && Array.isArray(msg.message.content)) {
          for (const b of msg.message.content) {
            if (b?.type !== 'tool_result') continue;
            const text =
              typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content)
                  ? b.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ')
                  : '';
            toolResults.push({ isError: b.is_error === true, text: text.replace(/\s+/g, ' ').slice(0, 260) });
          }
        }
        if (msg.type === 'result') {
          result = { subtype: msg.subtype, isError: msg.is_error };
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

const allowAllButExit = (tool) => (tool === 'ExitPlanMode' ? 'deny' : 'allow');
const allowAll = () => 'allow';

const BASH_PROMPT =
  'Use the Bash tool to run exactly this command, right now, and nothing else: ' +
  '`echo canary > canary-bash.txt`. Do not write a plan first and do not explain. ' +
  'Then tell me in one line whether the file was created.';
const WRITE_PROMPT =
  'Use the Write tool to create a file called canary-write.txt in this folder ' +
  'containing the single word canary. Do it right now; do not just describe it. ' +
  'Then tell me in one line whether the file was created.';

function say(label, r, files) {
  console.log(`\n── ${label}`);
  console.log(`   why=${r.why} ms=${r.ms} result=${JSON.stringify(r.result)}`);
  console.log(`   modes=${JSON.stringify(r.modes)}`);
  for (const c of r.controlRequests) console.log(`   can_use_tool ${JSON.stringify(c)}`);
  if (r.controlRequests.length === 0) console.log('   can_use_tool: NONE');
  for (const t of r.toolUses) console.log(`   tool_use ${t.name} ${t.input}`);
  for (const tr of r.toolResults) console.log(`   tool_result isError=${tr.isError}: ${tr.text}`);
  console.log(`   CHANGES IN THE TREE: ${JSON.stringify(files)}`);
  console.log(`   said: ${r.assistantText.replace(/\s+/g, ' ').slice(-240)}`);
}

async function trial(label, mode, prompt, answer) {
  const dir = makeRepo();
  const r = await runStream(
    [...STREAM_FLAGS, '--permission-mode', mode, '--session-id', mint()],
    dir,
    prompt,
    { answer }
  );
  const files = newFiles(dir);
  say(label, r, files);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
  return {
    label,
    mode,
    reachedResult: r.result !== null,
    ms: r.ms,
    modes: r.modes,
    controlRequests: r.controlRequests,
    toolUses: r.toolUses,
    toolResults: r.toolResults,
    treeChanges: files,
  };
}

function cleanup() {
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
  console.log(`\n── cleanup: removed ${removed.length} transcript(s), ${plans.length} plan file(s)`);
  return { removed, plansRemoved: plans };
}

async function main() {
  const only = (process.env.ONLY ?? 'ABCD').toUpperCase();
  const version = execFileSync(CLI, ['--version'], { encoding: 'utf8' }).trim();
  const findings = { cli: CLI, version, when: new Date().toISOString(), trials: [] };
  if (only.includes('A')) {
    findings.trials.push(await trial('A  plan, mutating Bash, allow all but ExitPlanMode', 'plan', BASH_PROMPT, allowAllButExit));
  }
  if (only.includes('B')) {
    findings.trials.push(await trial('B  plan, Write into the folder, allow all but ExitPlanMode', 'plan', WRITE_PROMPT, allowAllButExit));
  }
  if (only.includes('C')) {
    findings.trials.push(await trial('C  plan, Write into the folder, allow EVERYTHING', 'plan', WRITE_PROMPT, allowAll));
  }
  if (only.includes('D')) {
    findings.trials.push(await trial('D  CONTROL default mode, mutating Bash, allow everything', 'default', BASH_PROMPT, allowAll));
  }
  findings.cleanup = cleanup();
  console.log('\n──────── FINDINGS (json) ────────');
  console.log(JSON.stringify(findings, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
