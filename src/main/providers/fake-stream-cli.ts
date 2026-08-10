// A stand-in for `claude` that speaks stream-json (P2-E18-04) — the plumbing.
//
// THE PRECONDITION for testing stream mode. `providers/fake.ts` gives the e2e
// suite a real PTY hosting the OS shell — hermetic, no login, no network — and
// all 98 e2e tests plus the entire CI-safe property rest on it. Stream mode had
// no equivalent, so nothing about it could be tested without a subscription.
//
// All behaviour lives in `fake-stream-protocol.ts`, where it is unit-tested
// without spawning. This file is stdin/stdout wiring and nothing else, and is
// proven end-to-end by `npm run check:fake-stream`.
//
// Compiled as a standalone main-process entry (out/main/fake-stream-cli.js) and
// run under `electron --run-as-node`, exactly like the four done-when checks.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { FakeStreamProtocol, FAKE_SESSION_ID } from './fake-stream-protocol';
import { slugForCwd } from '../transcripts/paths';
import { claudeProjectsRoot } from './claude';

/**
 * Run one hook the way the real CLI runs it (#313).
 *
 * The settings file we were spawned with is the SAME file the real CLI reads —
 * `HookListener.buildHookSettings` wrote it, and its `command` is
 * `node <forwarder> <port> <tokenPath>`. So running that command with the hook
 * JSON on stdin is not a simulation of the hook channel: it IS the hook
 * channel, port, token, forwarder and all. Anything less would be a fake of a
 * fake, and the one thing #313 turns on is what the listener does with a real
 * POST from a real stream session.
 *
 * Synchronous, so the protocol can promise that a `!notify` has been delivered
 * and INGESTED before the next stream message goes out (the listener ends the
 * response before `ingest`, but in the same tick, so the forwarder cannot exit
 * first). Fail-open throughout: a fake that cannot fire a hook is still a
 * usable fake for everything else, and it must not take the session down.
 */
function fireHook(payload: Record<string, unknown>): void {
  const event = String(payload.hook_event_name ?? '');
  try {
    const i = process.argv.indexOf('--settings');
    if (i < 0 || !process.argv[i + 1]) return;
    const settings = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: unknown }> }>>;
    };
    const command = settings.hooks?.[event]?.[0]?.hooks?.[0]?.command;
    if (typeof command !== 'string' || !command) return;
    // `VAR=value prog …` prefixes are lifted into the environment rather than
    // handed to the shell. The REAL CLI runs hooks under a POSIX shell even on
    // Windows (the S-02 finding `HookListener.start` writes down), and that is
    // what lets it emit `ELECTRON_RUN_AS_NODE=1 "<app>"` as its fallback when
    // node is not on PATH. `spawnSync(shell: true)` here gets cmd.exe, which
    // would read that as a program called `ELECTRON_RUN_AS_NODE=1`. Splitting
    // it off is the difference between the fallback working and the fake going
    // silently deaf on a machine without node.
    const env = { ...process.env };
    let line = command;
    for (let m = /^(\w+)=(\S*)\s+/.exec(line); m; m = /^(\w+)=(\S*)\s+/.exec(line)) {
      env[m[1]] = m[2];
      line = line.slice(m[0].length);
    }
    // `shell: true` because what remains is still a command LINE — quoted
    // absolute paths and positional arguments — exactly as the CLI runs it.
    spawnSync(line, { shell: true, env, input: JSON.stringify(payload), timeout: 10_000 });
  } catch {
    /* fail open — see the docblock */
  }
}

// `--resume <id>` arrives exactly as the real adapter sends it (#404); the
// protocol turns it into the observable RESUMED-FROM marker
const resumeIdx = process.argv.indexOf('--resume');

const proto = new FakeStreamProtocol(
  {
    cwd: () => process.cwd(),
    writeFile: (p, content) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    stderr: (line) => process.stderr.write(line + '\n'),
    exit: (code) => process.exit(code),
    resolve: (cwd, target) => (path.isAbsolute(target) ? target : path.join(cwd, target)),
    // The real CLI writes a JSONL transcript in stream mode too (S-10), which
    // is why the transcript stack survives the migration. Reproduce it, or the
    // Session view has nothing to render and the Feed can never be tested
    // against this fake.
    appendTranscript: (line) => {
      try {
        const dir = path.join(claudeProjectsRoot(), slugForCwd(process.cwd()));
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `${FAKE_SESSION_ID}.jsonl`), JSON.stringify(line) + '\n');
      } catch {
        // fail open: a fake that cannot write its transcript is still a usable
        // fake for everything else
      }
    },
    fireHook,
  },
  (m) => process.stdout.write(JSON.stringify(m) + '\n'),
  { resumedFrom: resumeIdx >= 0 ? process.argv[resumeIdx + 1] : undefined }
);

// Same framing as the real CLI, and the same reason for a decoder rather than a
// split-per-chunk: a message can arrive in pieces.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      proto.handle(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // the real CLI does not crash on our garbage either
    }
  }
});

// Stay alive between turns — the real CLI in duplex mode is a conversation, not
// a batch invocation (S-10 probe A).
process.stdin.resume();
