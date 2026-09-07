// The subject of the #760 experiment: a hand-rolled stdio MCP server.
//
// WHY HAND-ROLLED, AND WHY THAT IS THE POINT
// ------------------------------------------
// #762 has to decide whether the bus takes `@modelcontextprotocol/sdk` as a
// dependency (this repo runs lean — 13 runtime deps) or speaks JSON-RPC itself.
// We need a WORKING server to answer Q1 at all, so building it by hand costs
// nothing extra and turns an argument into a measurement: if the real CLI is
// satisfied by what is below, that is the answer; if the handshake turns out to
// be fiddly, that is also the answer. Either way #762 decides on evidence.
//
// TWO TOOLS, DELIBERATELY
// -----------------------
// `sb_probe_local` answers in-process. `sb_probe_echo` answers ONLY by asking
// the host over the pipe. A single tool would conflate "the CLI never launched
// the server" with "the pipe is broken" into one indistinguishable failure —
// and the 721 README's own hard-won lesson is that a probe which cannot come
// back negative in a legible way is worse than no probe.
//
// NOT PRODUCTION CODE. No auth on the pipe (that is #762's job), no input
// validation worth the name, one connection per call.
import fs from 'node:fs';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};

const sessionId = arg('--session', '(absent)');
const pipePath = arg('--pipe', null);
const logPath = process.env.SB_PROBE_LOG || null;

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  // stderr AND a file: the CLI may or may not surface a server's stderr, and a
  // finding that depends on which is a finding about our luck.
  process.stderr.write(line);
  if (logPath) {
    try {
      fs.appendFileSync(logPath, line);
    } catch {
      /* the log is a bonus, never the mechanism */
    }
  }
}

// Q5 and Q4, captured the moment we start: the stdio transport was chosen
// BECAUSE identity can ride argv/env at spawn (§5.4). If the CLI does not pass
// these through verbatim, that premise is wrong and #762 needs a different
// answer for how a bus process knows which session it belongs to.
log('ARGV', JSON.stringify(process.argv));
log('EXECPATH', process.execPath);
log('SESSION_FROM_ARGV', JSON.stringify(sessionId));
log('ENV.SB_PROBE_SESSION', JSON.stringify(process.env.SB_PROBE_SESSION ?? null));
log('ENV.SB_PROBE_LOG', JSON.stringify(process.env.SB_PROBE_LOG ?? null));
log('ENV.ELECTRON_RUN_AS_NODE', JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null));
log('CWD', process.cwd());

/** Ask the host process a question over the pipe. Rejects rather than hangs. */
function askHost(payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (!pipePath) return reject(new Error('no --pipe given'));
    const sock = net.connect({ path: pipePath });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`host did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, i)));
      } catch (err) {
        reject(err);
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'));
  });
}

const TOOLS = [
  {
    name: 'sb_probe_local',
    description:
      'Answers from inside the MCP server process with no host involvement. Proves the CLI launched the server and can call it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sb_probe_echo',
    description:
      'Echoes text back by asking the switchboard host process over its pipe. Proves the whole round trip.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const text = (s) => ({ content: [{ type: 'text', text: s }] });

async function handle(msg) {
  const { id, method, params } = msg;
  log('<-', method, id === undefined ? '(notification)' : `id=${id}`);

  switch (method) {
    case 'initialize':
      // ECHO the client's proposed version rather than asserting one of our
      // own. What the CLI proposes is a fact we want to record, and guessing a
      // version is exactly the kind of contract-invention the standing rule
      // forbids. The findings note quotes whatever turns up here.
      log('CLIENT_PROTOCOL_VERSION', JSON.stringify(params?.protocolVersion ?? null));
      log('CLIENT_INFO', JSON.stringify(params?.clientInfo ?? null));
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sbbus-probe', version: '0.0.0-760' },
      });

    case 'notifications/initialized':
    case 'initialized':
      return; // notification — no id, no reply

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      if (name === 'sb_probe_local') {
        return ok(
          id,
          text(`local ok · session=${sessionId} · pid=${process.pid} · exec=${process.execPath}`)
        );
      }
      if (name === 'sb_probe_echo') {
        try {
          const reply = await askHost({ q: 'echo', session: sessionId, text: params?.arguments?.text ?? '' });
          return ok(id, text(`host said: ${JSON.stringify(reply)}`));
        } catch (err) {
          // An error the AGENT can read. #762's done-when says a dead host must
          // fail cleanly and never hang, and this is the shape of that.
          return ok(id, { ...text(`host unreachable: ${String(err)}`), isError: true });
        }
      }
      return fail(id, -32602, `unknown tool: ${name}`);
    }

    default:
      // Notifications carry no id and MUST NOT be answered, even to say no.
      if (id === undefined) return;
      return fail(id, -32601, `method not found: ${method}`);
  }
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('UNPARSEABLE', line.slice(0, 200));
      continue;
    }
    handle(msg).catch((err) => log('HANDLER_THREW', String(err)));
  }
});
process.stdin.on('end', () => {
  log('STDIN_END — exiting');
  process.exit(0);
});
log('READY pipe=' + JSON.stringify(pipePath));
