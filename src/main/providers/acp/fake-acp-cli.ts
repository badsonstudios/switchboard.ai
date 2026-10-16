// The fake ACP agent as a PROGRAM (E40 item 06, #1289): stdin/stdout wiring
// and nothing else. All behaviour is `fake-acp-agent.ts`, unit-tested without
// spawning. Compiled as a standalone main-process entry
// (out/main/fake-acp-cli.js) and run under `electron --run-as-node`, exactly
// like `fake-stream-cli.ts`.
import { FakeAcpAgent } from './fake-acp-agent';

const agent = new FakeAcpAgent({
  write: (frame) => {
    process.stdout.write((typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n');
  },
  requireAuth: process.env.FAKE_ACP_REQUIRE_AUTH === '1',
});

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
      agent.receive(JSON.parse(line));
    } catch {
      /* not JSON: a real agent would answer -32700; the fake ignores it */
    }
  }
});
// Exit on stdin EOF, as Codex's adapter was measured to.
process.stdin.on('end', () => process.exit(0));
