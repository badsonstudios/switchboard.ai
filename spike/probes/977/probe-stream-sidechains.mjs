#!/usr/bin/env node
/**
 * Probe #977 — what actually marks a SUBAGENT run on the stream?
 *
 * WHY. The issue says "build sidechain blocks from `parent_tool_use_id` — it is
 * on every stream message and needs no probe to read." Reading the PATH CLI
 * first (the standing rule) turned up a flag that changes that premise:
 *
 *   --forward-subagent-text
 *     "Forward subagent text and thinking blocks as assistant/user messages with
 *      parent_tool_use_id set (only works with --print and
 *      --output-format=stream-json)"
 *
 * `providers/claude.ts` does not pass it. The SDK embedded in the VS Code
 * extension has a matching `forwardSubagentText` option AND carries it in the
 * `initialize` control request's config — so there may be two ways to turn it
 * on. If the flag is what gates the traffic, then "nothing feeds the renderer"
 * has a different cause than the issue states, and the fix starts at the spawn.
 *
 * READING IS NOT MEASURING. This drives the PATH CLI on the app's own flag list.
 *
 * QUESTIONS
 *   Q1 Baseline — our exact flags. A prompt that forces a Task subagent. Does
 *      ANY frame arrive with `parent_tool_use_id != null`?
 *   Q2 Same, plus `--forward-subagent-text`. What arrives, and what is on it?
 *   Q3 Is the subagent's `parent_tool_use_id` the `Task` tool_use's own `id`,
 *      and does that tool_use input carry a name (`subagent_type`)?
 *   Q4 Does a STREAM session write `<native-id>/subagents/agent-*.jsonl` on
 *      disk? #788's renderer was fed from those files; if they exist for a
 *      stream session too, that is a second candidate source.
 *
 * COST. Two real CLI turns against the owner's subscription, each one a trivial
 * delegated task. Every transcript minted here is deleted at the end. No
 * background or daemon session is started — nothing to leak on the machine.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
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

/** EXACTLY the list `providers/claude.ts` pushes today. */
const STREAM_FLAGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
];

const PROMPT =
  'Use the Task tool to launch ONE general-purpose subagent. Give it exactly this ' +
  'instruction: "Reply with the single word BANANA and nothing else." Do not do it ' +
  'yourself and do not use any other tool. When the subagent answers, reply with ' +
  'just the word it gave you.';

function findTranscriptDir(sessionId) {
  if (!existsSync(PROJECTS)) return null;
  for (const d of readdirSync(PROJECTS)) {
    if (existsSync(join(PROJECTS, d, `${sessionId}.jsonl`))) return join(PROJECTS, d);
  }
  return null;
}

/**
 * Drive one stream-json session and keep every frame.
 *
 * Auto-ALLOW on `can_use_tool`, because the point is to watch a subagent run,
 * not to watch it be refused. The 500 ms delay before the first write is
 * load-bearing, not politeness: #760 measured a frame written at t=0 being lost.
 */
function run(extraFlags, cwd, { timeoutMs = 180_000 } = {}) {
  return new Promise((res) => {
    const args = [...STREAM_FLAGS, ...extraFlags];
    const child = spawn(CLI, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const frames = [];
    let buf = '';
    let err = '';
    let sessionId = null;
    let done = false;

    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      res({ why, args, frames, sessionId, err: err.slice(0, 3000) });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        frames.push(m);
        if (m.type === 'system' && m.subtype === 'init' && m.session_id) sessionId = m.session_id;
        // answer every permission request with allow, at the server
        if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
          child.stdin.write(JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: m.request_id,
              response: { behavior: 'allow', updatedInput: m.request.input },
            },
          }) + '\n');
        }
        if (m.type === 'result') finish('result');
      }
    });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { err += String(e); finish('spawn-error'); });
    child.on('exit', () => finish('exit'));

    setTimeout(() => {
      child.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: PROMPT }] },
      }) + '\n');
    }, 500);
  });
}

function summarise(label, out) {
  const sidechain = out.frames.filter((f) => f.parent_tool_use_id != null);
  const taskCalls = [];
  for (const f of out.frames) {
    const content = f.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent')) {
        taskCalls.push({ id: b.id, name: b.name, inputKeys: Object.keys(b.input ?? {}), input: b.input });
      }
    }
  }
  const text = (f) => {
    const c = f.message?.content;
    if (typeof c === 'string') return c.slice(0, 120);
    if (!Array.isArray(c)) return '';
    return c.map((b) => b.text ?? b.thinking ?? `<${b.type}>`).join(' ').slice(0, 120);
  };
  return {
    label,
    why: out.why,
    sessionId: out.sessionId,
    frameTypes: [...new Set(out.frames.map((f) => `${f.type}${f.subtype ? ':' + f.subtype : ''}`))],
    totalFrames: out.frames.length,
    sidechainFrames: sidechain.length,
    sidechainParentIds: [...new Set(sidechain.map((f) => f.parent_tool_use_id))],
    sidechainSample: sidechain.slice(0, 6).map((f) => ({
      type: f.type,
      subtype: f.subtype,
      parent_tool_use_id: f.parent_tool_use_id,
      // every top-level key, so a name field we did not think to look for shows up
      keys: Object.keys(f),
      messageKeys: f.message ? Object.keys(f.message) : null,
      text: text(f),
    })),
    taskCalls,
    // Q3: does the subagent's parent id equal the Task tool_use id?
    parentMatchesTaskId: taskCalls.length > 0 &&
      sidechain.some((f) => taskCalls.some((t) => t.id === f.parent_tool_use_id)),
    stderr: out.err ? out.err.slice(0, 400) : '',
  };
}

function onDisk(sessionId) {
  const dir = sessionId ? findTranscriptDir(sessionId) : null;
  if (!dir) return { transcriptDir: null };
  const subs = join(dir, sessionId, 'subagents');
  const answer = {
    transcriptDir: dir,
    subagentsDir: subs,
    subagentsDirExists: existsSync(subs),
    subagentFiles: existsSync(subs) ? readdirSync(subs) : [],
  };
  // does the MAIN file carry isSidechain at all? (#788 measured zero in 3,214)
  const main = join(dir, `${sessionId}.jsonl`);
  if (existsSync(main)) {
    const lines = readFileSync(main, 'utf8').split('\n').filter(Boolean);
    answer.mainLines = lines.length;
    answer.mainIsSidechainCount = lines.filter((l) => l.includes('"isSidechain":true')).length;
    const keys = new Set();
    for (const l of lines) {
      try { for (const k of Object.keys(JSON.parse(l))) keys.add(k); } catch { /* skip */ }
    }
    answer.mainLineKeys = [...keys].sort();
  }
  if (answer.subagentFiles.length > 0) {
    const f = join(subs, answer.subagentFiles[0]);
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
    answer.firstSubagentLineKeys = lines[0] ? Object.keys(JSON.parse(lines[0])).sort() : [];
    answer.firstSubagentLine = lines[0]?.slice(0, 600) ?? null;
  }
  return answer;
}

function cleanup(sessionId) {
  if (!sessionId) return;
  const dir = findTranscriptDir(sessionId);
  if (!dir) return;
  for (const p of [join(dir, `${sessionId}.jsonl`), join(dir, sessionId)]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'sb977-'));
writeFileSync(join(cwd, 'README.md'), 'probe scratch\n');
const results = [];
const minted = [];
try {
  for (const [label, extra] of [
    ['Q1 baseline — our flags exactly', []],
    ['Q2 plus --forward-subagent-text', ['--forward-subagent-text']],
  ]) {
    process.stderr.write(`\n=== ${label} ===\n`);
    const out = await run(extra, cwd);
    if (out.sessionId) minted.push(out.sessionId);
    const s = summarise(label, out);
    s.onDisk = onDisk(out.sessionId);
    results.push(s);
  }
} finally {
  for (const id of minted) cleanup(id);
  try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(JSON.stringify({ cli: CLI, results }, null, 2));
void randomUUID;
void statSync;
