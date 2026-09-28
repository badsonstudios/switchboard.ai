#!/usr/bin/env node
/**
 * Probe #977-b — ONE question, and the whole design turns on it.
 *
 * The first probe found that `--forward-subagent-text` gates whether the
 * subagent's own reply arrives ON THE STREAM. It did not check the OTHER
 * source: does the CLI write that reply into
 * `<native-id>/subagents/agent-<id>.jsonl` **regardless of the flag**?
 *
 * It matters because the watcher ALREADY TAILS those files for every bound
 * session — the tail drain is explicitly never gated on `deriveFeed`
 * (`watcher.ts`, "the tail drain is NEVER gated … it is the latency-critical
 * path"). So if the reply is on disk without the flag, restoring #788's feature
 * costs ONE CONDITION in `deriveBlocks` and ZERO additional IO, fixes the
 * replayed half for free (`subagentFiles` reads the directory that already
 * exists), and needs no change to how we spawn the CLI at all.
 *
 * If it is NOT on disk without the flag, the flag is required either way and
 * the stream path is the honest one.
 *
 * Q: with OUR EXACT FLAGS and no `--forward-subagent-text`, does the subagent
 *    transcript on disk contain the subagent's ASSISTANT reply?
 *
 * COST: one real CLI turn. The transcript is deleted at the end; nothing is
 * left running.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(
  homedir(),
  'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
);
const PROJECTS = join(homedir(), '.claude', 'projects');
const FLAGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
];
const PROMPT =
  'Use the Task tool to launch ONE general-purpose subagent with exactly this ' +
  'instruction: "Reply with the single word PINEAPPLE and nothing else." Do not ' +
  'do it yourself. Then reply with just the word it gave you.';

const cwd = mkdtempSync(join(tmpdir(), 'sb977b-'));
writeFileSync(join(cwd, 'README.md'), 'scratch\n');

const out = await new Promise((res) => {
  const child = spawn(CLI, FLAGS, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let sessionId = null;
  let streamSaidPineapple = false;
  let done = false;
  const finish = (why) => {
    if (done) return;
    done = true;
    clearTimeout(t);
    try { child.kill(); } catch { /* gone */ }
    res({ why, sessionId, streamSaidPineapple });
  };
  const t = setTimeout(() => finish('timeout'), 180_000);
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) sessionId = m.session_id;
      // did a SIDECHAIN frame carry the word? (expected: no, without the flag)
      if (m.parent_tool_use_id != null && JSON.stringify(m).includes('PINEAPPLE')) {
        streamSaidPineapple = true;
      }
      if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
        child.stdin.write(
          JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: m.request_id,
              response: { behavior: 'allow', updatedInput: m.request.input },
            },
          }) + '\n'
        );
      }
      if (m.type === 'result') finish('result');
    }
  });
  child.on('exit', () => finish('exit'));
  setTimeout(() => {
    child.stdin.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: PROMPT }] },
      }) + '\n'
    );
  }, 500);
});

// give the CLI a moment to flush its own transcript
await new Promise((r) => setTimeout(r, 1500));

let dir = null;
for (const d of readdirSync(PROJECTS)) {
  if (existsSync(join(PROJECTS, d, `${out.sessionId}.jsonl`))) dir = join(PROJECTS, d);
}
const answer = { ...out, transcriptDir: dir };
if (dir) {
  const subs = join(dir, out.sessionId, 'subagents');
  answer.subagentFiles = existsSync(subs) ? readdirSync(subs) : [];
  const jsonl = answer.subagentFiles.filter((f) => f.endsWith('.jsonl'));
  if (jsonl.length > 0) {
    const text = readFileSync(join(subs, jsonl[0]), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    answer.subagentLineCount = lines.length;
    answer.DISK_SAID_PINEAPPLE = text.includes('PINEAPPLE');
    answer.subagentLineTypes = lines.map((l) => {
      try {
        const o = JSON.parse(l);
        return `${o.type}${o.isSidechain ? '/sidechain' : ''}${o.attributionAgent ? '/named:' + o.attributionAgent : ''}`;
      } catch {
        return 'unparseable';
      }
    });
    // the keys on the ASSISTANT line, which is where the name lives
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        if (o.type === 'assistant') {
          answer.assistantLineKeys = Object.keys(o).sort();
          answer.assistantAgentId = o.agentId;
          answer.assistantAttributionAgent = o.attributionAgent;
          break;
        }
      } catch { /* skip */ }
    }
  }
  // cleanup
  for (const p of [join(dir, `${out.sessionId}.jsonl`), join(dir, out.sessionId)]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(JSON.stringify(answer, null, 2));
