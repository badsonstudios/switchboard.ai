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
import { FakeStreamProtocol, FAKE_SESSION_ID } from './fake-stream-protocol';
import { slugForCwd } from '../transcripts/paths';
import { claudeProjectsRoot } from './claude';

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
  },
  (m) => process.stdout.write(JSON.stringify(m) + '\n')
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
