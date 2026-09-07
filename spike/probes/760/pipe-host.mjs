// Stand-in for Electron main: the thing at the other end of the bus child's
// pipe.
//
// This exists because a stdio MCP server's stdin/stdout belong to the CLI that
// spawned it, so the server cannot answer `list_sessions` without a second
// channel back to the host. AR-P1-6 decided the AGENT↔BUS transport and is
// silent on this one; the owner decided it on 2026-09-07: a named pipe / unix
// domain socket, no port and no HTTP, so the "there is no door to guard"
// property that made stdio worth choosing survives.
//
// NOT PRODUCTION CODE. #762 owns the real one, including the part this
// deliberately omits: the token. S-03's rule is that it lives in an ACL'd file
// referenced by path and NEVER on argv, because argv is world-readable on every
// platform we ship. Nothing below authenticates anybody.
import net from 'node:net';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Start the host end.
 *
 * `answer(request)` returns whatever should go back. Default: echo, plus a
 * fixed fake session list so a probe can see structured data survive the trip
 * rather than just a string.
 */
export function startHost(pipePath, answer) {
  // A stale unix socket file blocks the bind; Windows named pipes need no
  // cleanup (the kernel drops them when the last handle closes).
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(pipePath);
    } catch {
      /* not there — fine */
    }
  }
  const seen = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        seen.push(req);
        const reply = answer
          ? answer(req)
          : {
              echo: req.text ?? null,
              askedBy: req.session ?? null,
              hostPid: process.pid,
              sessions: [
                { name: 'TradingApp', folder: 'C:/Projects/TradingApp', status: 'working' },
                { name: 'PropaneMon', folder: 'C:/Projects/PropaneMon', status: 'idle' },
              ],
            };
        sock.write(JSON.stringify(reply) + '\n');
      }
    });
    sock.on('error', () => {
      /* a child that dies mid-write is not the host's problem */
    });
  });
  return new Promise((resolve) => {
    server.listen(pipePath, () => resolve({ server, seen, close: () => server.close() }));
  });
}

// Standalone mode, for driving the server by hand:
//   node pipe-host.mjs \\.\pipe\sb760-manual
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const p = process.argv[2];
  if (!p) {
    console.error('usage: node pipe-host.mjs <pipe-path>');
    process.exit(1);
  }
  startHost(p).then(() => console.log('host listening on', p));
}
