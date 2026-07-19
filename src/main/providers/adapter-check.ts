// P1-E2-02 done-when check (local only — needs a logged-in claude CLI, so NOT
// in CI): a session spawns in an arbitrary chosen folder, and --resume
// restores it. Uses headless -p runs: plant a marker word in session 1,
// resume it, ask the marker back. Exits 0 on PASS.
//
// Run: npm run check:adapter
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeAdapter } from './claude';

const MARKER = `quokka-${Date.now() % 100000}`;

function runClaude(recipeArgs: string[], cwd: string, prompt: string): { text: string; sessionId: string } {
  const recipe = claudeAdapter.buildSpawn({
    cwd,
    sessionId: 'adapter-check',
    stateDir: path.join(cwd, '.switchboard-state'),
  });
  // Node >=22 refuses to exec .cmd shims without a shell (CVE-2024-27980
  // hardening) — a child_process-only quirk; node-pty spawns the same .cmd
  // directly (S-01). Route through cmd.exe here.
  const allArgs = [...recipe.args, ...recipeArgs, '-p', prompt, '--output-format', 'json'];
  const isCmdShim = process.platform === 'win32' && recipe.command.toLowerCase().endsWith('.cmd');
  const out = execFileSync(
    isCmdShim ? 'cmd.exe' : recipe.command,
    isCmdShim ? ['/c', recipe.command, ...allArgs] : allArgs,
    { cwd, encoding: 'utf8', timeout: 180000, env: cleanEnv() }
  );
  const j = JSON.parse(out) as { result?: string; session_id?: string };
  return { text: j.result ?? '', sessionId: j.session_id ?? '' };
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-adapter-check-'));
console.log(`[adapter-check] chosen folder: ${dir}`);

const first = runClaude([], dir, `Remember this word: ${MARKER}. Reply with exactly: OK`);
console.log(`[adapter-check] session ${first.sessionId} planted marker (reply: ${first.text.trim().slice(0, 40)})`);
if (!first.sessionId) {
  console.log('[adapter-check] FAIL — no session_id in CLI output');
  process.exit(1);
}

const second = runClaude(['--resume', first.sessionId], dir, 'What word did I ask you to remember? Reply with just the word.');
const ok = second.text.includes(MARKER);
console.log(`[adapter-check] resume reply: ${second.text.trim().slice(0, 60)}`);
console.log(ok ? '[adapter-check] PASS' : '[adapter-check] FAIL — marker not recalled via --resume');
process.exit(ok ? 0 : 1);
