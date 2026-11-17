// #1612 probe runner: one haiku turn with exec-form hooks; UserPromptSubmit
// and Stop sync, PostToolUse and SessionStart async. Prints the hook log.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const log = path.join(here, 'hooks.log');
fs.rmSync(log, { force: true });
const hook = path.join(here, 'hook.cjs');
const entry = (extra) => [{ hooks: [{ type: 'command', command: process.execPath, args: [hook, log, 'a b "c" $HOME'], timeout: 10, ...extra }] }];
const settings = {
  hooks: {
    SessionStart: entry({ async: true }),
    UserPromptSubmit: entry({}),
    PostToolUse: entry({ async: true }),
    Stop: entry({}),
  },
};
const settingsFile = path.join(here, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify(settings));
const r = spawnSync(
  'claude',
  ['-p', 'Run the Bash tool with the command: echo probe. Then reply with the single word ok.', '--model', 'haiku', '--settings', settingsFile, '--allowedTools', 'Bash(echo probe)'],
  { encoding: 'utf8', shell: true, cwd: here, timeout: 180000 }
);
console.log('exit', r.status, (r.stdout || '').trim().slice(0, 200), (r.stderr || '').trim().slice(0, 300));
// async hooks may land after the process exits; give them a moment
await new Promise((res) => setTimeout(res, 3000));
console.log(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'NO HOOK LOG');
