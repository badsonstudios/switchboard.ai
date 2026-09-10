// A burst of bus requests against ONE endpoint, from a separate process (#772).
//
// Separate on purpose: the question `probe-cost` asks in part C is how long the
// HOST's event loop stalls, and a client sharing that loop would put its own
// work in the measurement. This speaks the channel's wire format directly —
// `{v, token, op, args}` then a newline, one request per connection — rather
// than importing `pipe-client.ts`, so nothing here has a deadline of its own:
// every latency printed is how long the host really took.
//
// Usage: node fire.mjs <pipePath> <tokenPath> <op> <ref> <n>
// Prints ONE line of JSON: [{ ms, ok, reason? }, ...] in request order.
import fs from 'node:fs';
import net from 'node:net';

const [pipePath, tokenPath, op, ref, nArg] = process.argv.slice(2);
const n = Number(nArg);
const token = fs.readFileSync(tokenPath, 'utf8').trim();

function one() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const sock = net.connect({ path: pipePath });
    let buf = '';
    const done = (result) => {
      sock.destroy();
      resolve({ ms: Math.round(performance.now() - t0), ...result });
    };
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(JSON.stringify({ v: 1, token, op, args: { session: ref } }) + '\n');
    });
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        done(reply.ok ? { ok: true } : { ok: false, reason: String(reply.reason) });
      } catch {
        done({ ok: false, reason: 'unreadable reply' });
      }
    });
    sock.on('error', (err) => done({ ok: false, reason: `socket error: ${err.code ?? err}` }));
    sock.on('close', () => done({ ok: false, reason: 'closed without answering' }));
  });
}

// All N dialled in the same tick — the shape a burst of parallel subagents, or
// a looping client, actually produces.
const results = await Promise.all(Array.from({ length: n }, one));
process.stdout.write(JSON.stringify(results) + '\n');
